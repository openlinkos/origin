import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { isLinesSourceId, KNOWN_SOURCE_IDS } from '@openlinkos/origin-adapters';
import {
  type Database,
  dbPath,
  defaultStoreName,
  hasRecalled,
  initStoreName,
  isRelay,
  OriginError,
  openDatabase,
  originHome,
  planRecall,
  promptTitle,
  type RecallInput,
  type RecallPlan,
  recallScope,
  recallText,
  recordRecall,
} from '@openlinkos/origin-core';
import { type HookIO, runByAnother } from './hook-caller.js';
import { setUpFrames } from './hub/bucket.js';
import { storeAdapters } from './sources.js';

/**
 * `origin recall`: what Origin hands an agent unasked (see docs/architecture.md#recall). An agent's
 * hooks run it at the start of each session and with each prompt; it then records what it hands
 * over and prints it in the form the agent's hooks read. Without `--hook`, it shows what it would
 * hand over and records nothing. Loaded on its own (see bin.ts): it must start fast.
 */

/** Agents whose hooks `origin recall --hook` answers. */
export const HOOK_AGENTS = ['claude-code', 'codex', 'zcode', 'cursor'] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

const USAGE = `Usage:
  origin recall [--cwd <dir>] [--project <name>] [--prompt <text>] [--agent <id>]  Show what an agent would be handed; records nothing
  origin recall --hook <agent>                                                       Run as the agent's hook, reading its event on standard input
Hooks: ${HOOK_AGENTS.join(', ')}`;

/** How long a hook waits for the store's write lock before handing nothing over. */
const HOOK_BUSY_MS = 3_000;

/**
 * What recall reads of a hook's event, whichever agent sent it (see docs/sources.md for each
 * agent's hooks). Claude Code, Codex, and ZCode send Claude Code's fields; Cursor its own.
 */
export interface HookCall {
  /** The event, by Claude Code's name for it; null for an event recall does not answer. */
  event: 'SessionStart' | 'UserPromptSubmit' | null;
  /** The event's name as the agent sent it, which its answer repeats. */
  eventName: string;
  /** The session's id, as the agent's archived session has it. */
  sessionId: string | null;
  cwd: string | null;
  prompt: string | null;
  /** SessionStart: startup, resume, clear, or compact. */
  source: string | null;
}

const nonEmpty = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/**
 * The sessions ZCode runs for a sub-agent (`sess_subagent_agent_…`) and for each step of a workflow
 * (`sess_dwf-<run>-<actor>`): their ids say so, as they do in its database and the archive. Like a
 * Claude Code sub-agent's, they are no conversation with the user, and get no recall.
 */
const ZCODE_CHILD = /^sess_(?:subagent_|dwf-)/;

/**
 * A workspace root as Cursor names it, the path of its file URI: `/c:/code/acme` on Windows is
 * `c:/code/acme`.
 */
function uriPath(p: string): string {
  return /^\/[A-Za-z]:(?:[\\/]|$)/.test(p) ? p.slice(1) : p;
}

/**
 * Read a hook's event as `agent` sends it; null for input that is not an event, and for a session
 * that is no conversation with the user (a ZCode sub-agent or workflow step, a Cursor sub-agent).
 */
export function hookCall(agent: HookAgent, event: unknown): HookCall | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  if (agent === 'cursor') {
    // A sub-agent's conversation names the agent that started it.
    if (nonEmpty(e.parent_agent_id)) return null;
    const name = nonEmpty(e.hook_event_name) ?? '';
    const roots = Array.isArray(e.workspace_roots) ? e.workspace_roots.map(nonEmpty) : [];
    const root = roots.find((r) => r !== null);
    return {
      event: name === 'beforeSubmitPrompt' ? 'UserPromptSubmit' : null,
      eventName: name,
      // `conversation_id` is the conversation's id in Cursor's database and transcripts.
      sessionId: nonEmpty(e.conversation_id) ?? nonEmpty(e.session_id),
      cwd: nonEmpty(e.cwd) ?? (root ? uriPath(root) : null),
      prompt: typeof e.prompt === 'string' ? e.prompt : null,
      source: null,
    };
  }
  // ZCode sends Claude Code's fields, and its own camelCase ones beside them.
  const name =
    nonEmpty(e.hook_event_name) ?? (agent === 'zcode' ? nonEmpty(e.hookEventName) : null) ?? '';
  const sessionId = nonEmpty(e.session_id) ?? (agent === 'zcode' ? nonEmpty(e.sessionId) : null);
  if (agent === 'zcode' && sessionId && ZCODE_CHILD.test(sessionId)) return null;
  return {
    event: name === 'SessionStart' || name === 'UserPromptSubmit' ? name : null,
    eventName: name,
    sessionId,
    cwd: nonEmpty(e.cwd),
    prompt: typeof e.prompt === 'string' ? e.prompt : null,
    source: nonEmpty(e.source),
  };
}

/**
 * The recall a hook event asks for, or null when it asks for none: a session that resumes already
 * had its brief (it is in its transcript). Cursor does not hand an agent reliably what a hook gives
 * it when a session starts, so a conversation's first prompt brings its brief, with the prompt's
 * matches.
 */
export function hookInput(db: Database, agent: HookAgent, event: unknown): RecallInput | null {
  const call = hookCall(agent, event);
  if (!call?.cwd || !call.event) return null;
  const sessionId = call.sessionId?.toLowerCase() ?? null;
  const scope = { source: agent, sessionId, ...recallScope(call.cwd, { db }) };
  if (call.event === 'SessionStart') {
    if (call.source === 'resume' && sessionId && hasRecalled(db, agent, sessionId)) return null;
    return { occasion: 'start', ...scope };
  }
  // Only what the user typed: not what an agent hands in as a prompt, such as a background task's
  // notice wrapped in tags, which the archive does not take for a prompt either (see promptTitle).
  if (!call.prompt || !promptTitle(call.prompt)) return null;
  if (agent === 'cursor' && sessionId && !hasRecalled(db, agent, sessionId)) {
    return { occasion: 'start', prompt: call.prompt, ...scope };
  }
  return { occasion: 'prompt', prompt: call.prompt, ...scope };
}

/**
 * What a hook prints for the agent to read: the text as `additionalContext` for the event it
 * answers (Claude Code, Codex, and ZCode), or as Cursor's `additional_context`.
 */
export function hookOutput(agent: HookAgent, eventName: string, text: string): string {
  if (agent === 'cursor') return JSON.stringify({ additional_context: text });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  });
}

function openStore(home: string): Database {
  const db = openDatabase(dbPath(home), {
    adapters: storeAdapters(home),
    log: (m) => console.error(m),
  });
  setUpFrames(db, home, { command: 'other', env: process.env });
  return db;
}

const STDIN: HookIO = { stdin: () => fs.readFileSync(0, 'utf8') };

/**
 * Answer a hook: plan, record, print. A hook must never get in the agent's way, so any failure
 * prints nothing on standard output, says why on standard error, and exits 0. A hook another agent
 * runs (see hook-caller.ts), and an event that asks for nothing, do not even open the store.
 */
async function runHook(agent: HookAgent, io: HookIO): Promise<number> {
  let db: Database | null = null;
  try {
    const event = JSON.parse(io.stdin()) as unknown;
    if (runByAnother(agent, event, io.env)) return 0;
    const call = hookCall(agent, event);
    if (!call?.cwd || !call.event) return 0;
    db = openStore(originHome());
    // A relay keeps no entries; the hub's are not recalled from here yet.
    if (isRelay(db)) return 0;
    const input = hookInput(db, agent, event);
    if (!input) return 0;
    db.exec(`PRAGMA busy_timeout = ${HOOK_BUSY_MS};`);
    initStoreName(db, process.env.ORIGIN_DEVICE || defaultStoreName());
    const plan = planRecall(db, input);
    const id = recordRecall(db, plan);
    const text = recallText(plan, id);
    if (text) console.log(hookOutput(agent, call.eventName, text));
    return 0;
  } catch (err) {
    console.error(`origin recall: ${(err as Error).message}`);
    return 0;
  } finally {
    db?.close();
  }
}

/**
 * The scope of a recall asked for in a directory, for a project by name, or both: `project` names
 * the project, and `dir` the directory whose work tree is its (see briefIn in the MCP package).
 */
function askedScope(
  db: Database,
  dir: string | null,
  project: string | null,
): Pick<RecallInput, 'cwd' | 'root' | 'project'> {
  const scope = dir ? recallScope(dir, { db }) : { cwd: null, root: null, project: null };
  return project ? { ...scope, project } : scope;
}

function printPreview(plan: RecallPlan): void {
  const who = plan.source ? `as ${plan.source}` : 'for any agent';
  const where = plan.project ? `project ${plan.project}` : 'no project';
  const dir = plan.root ?? plan.cwd;
  console.log(`Preview ${who}, ${where}${dir ? ` (${dir})` : ''}; nothing is recorded.`);
  if (plan.items.length === 0) {
    console.log(
      plan.prompt ? 'No entry or past message matches this prompt.' : 'Nothing to hand over here.',
    );
    return;
  }
  console.log(`\n${recallText(plan, 'rcl_preview')}\n`);
  const scored = plan.items.filter((i) => i.score !== null);
  for (const i of scored) console.log(`Score ${i.score?.toFixed(2)}  ${i.ref}`);
  console.log(`${plan.items.length} items, about ${plan.tokens} of ${plan.budget} tokens.`);
}

export async function main(argv: string[], io: HookIO = STDIN): Promise<number> {
  let values: {
    hook?: string;
    cwd?: string;
    project?: string;
    prompt?: string;
    agent?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: {
        hook: { type: 'string' },
        cwd: { type: 'string' },
        project: { type: 'string' },
        prompt: { type: 'string' },
        agent: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.hook !== undefined) {
    if (!(HOOK_AGENTS as readonly string[]).includes(values.hook)) {
      console.error(`No recall hook for "${values.hook}" (hooks: ${HOOK_AGENTS.join(', ')}).`);
      return 2;
    }
    return runHook(values.hook as HookAgent, io);
  }
  if (
    values.agent &&
    !(KNOWN_SOURCE_IDS as readonly string[]).includes(values.agent) &&
    !isLinesSourceId(values.agent)
  ) {
    console.error(
      `Unknown agent "${values.agent}" (agents: ${KNOWN_SOURCE_IDS.join(', ')}, or a source of your own).`,
    );
    return 2;
  }
  const db = openStore(originHome());
  try {
    const prompt = values.prompt?.trim() || null;
    // A project named alone is not this directory's: the directory is the default only without one.
    const project = values.project?.trim() || null;
    const plan = planRecall(db, {
      occasion: prompt ? 'prompt' : 'start',
      source: values.agent ?? null,
      prompt,
      ...askedScope(db, values.cwd ?? (project ? null : process.cwd()), project),
    });
    printPreview(plan);
    return 0;
  } catch (err) {
    if (err instanceof OriginError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    db.close();
  }
}
