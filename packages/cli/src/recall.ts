import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { allAdapters, KNOWN_SOURCE_IDS, projectFromCwd } from '@openlinkos/origin-adapters';
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
  type RecallInput,
  type RecallPlan,
  recallText,
  recordRecall,
} from '@openlinkos/origin-core';
import { setUpFrames } from './hub/bucket.js';

/**
 * `origin recall`: what Origin hands an agent unasked (see docs/architecture.md#recall). An agent's
 * hooks run it at the start of each session and with each prompt; it then records what it hands
 * over and prints it in the form the agent's hooks read. Without `--hook`, it shows what it would
 * hand over and records nothing. Loaded on its own (see bin.ts): it must start fast.
 */

/** Agents whose hooks `origin recall --hook` answers. */
export const HOOK_AGENTS = ['claude-code'] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

const USAGE = `Usage:
  origin recall [--cwd <dir>] [--prompt <text>] [--agent <id>]  Show what an agent would be handed; records nothing
  origin recall --hook <agent>                                    Run as the agent's hook, reading its event on standard input
Hooks: ${HOOK_AGENTS.join(', ')}`;

/** How long a hook waits for the store's write lock before handing nothing over. */
const HOOK_BUSY_MS = 3_000;

/** The top of the git work tree that holds `dir`, or null. */
export function workTree(dir: string): string | null {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The scope of a recall made in `cwd`: the directory, its work tree, and the project's name. */
export function scopeOf(cwd: string): Pick<RecallInput, 'cwd' | 'root' | 'project'> {
  const resolved = path.resolve(cwd);
  const root = workTree(resolved);
  return { cwd: resolved, root, project: projectFromCwd(root ?? resolved) };
}

/** The event a Claude Code hook reads on standard input, as far as recall needs it. */
interface ClaudeHookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  /** SessionStart: startup, resume, clear, or compact. */
  source?: string;
}

/**
 * The recall a hook event asks for, or null when it asks for none: a session that resumes already
 * had its brief (it is in its transcript).
 */
export function hookInput(
  db: Database,
  agent: HookAgent,
  event: ClaudeHookEvent,
): RecallInput | null {
  const sessionId = event.session_id?.toLowerCase() ?? null;
  if (!event.cwd) return null;
  const scope = { source: agent, sessionId, ...scopeOf(event.cwd) };
  if (event.hook_event_name === 'SessionStart') {
    if (event.source === 'resume' && sessionId && hasRecalled(db, agent, sessionId)) return null;
    return { occasion: 'start', ...scope };
  }
  if (event.hook_event_name === 'UserPromptSubmit' && event.prompt?.trim()) {
    return { occasion: 'prompt', prompt: event.prompt, ...scope };
  }
  return null;
}

/** What a Claude Code hook prints for the agent to read: the text as `additionalContext`. */
export function hookOutput(eventName: string, text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  });
}

function openStore(home: string): Database {
  const db = openDatabase(dbPath(home), { adapters: allAdapters(), log: (m) => console.error(m) });
  setUpFrames(db, home, { command: 'other', env: process.env });
  return db;
}

/**
 * Answer a hook: plan, record, print. A hook must never get in the agent's way, so any failure
 * prints nothing on standard output, says why on standard error, and exits 0.
 */
async function runHook(agent: HookAgent): Promise<number> {
  let db: Database | null = null;
  try {
    const event = JSON.parse(fs.readFileSync(0, 'utf8')) as ClaudeHookEvent;
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
    if (text) console.log(hookOutput(event.hook_event_name as string, text));
    return 0;
  } catch (err) {
    console.error(`origin recall: ${(err as Error).message}`);
    return 0;
  } finally {
    db?.close();
  }
}

function printPreview(plan: RecallPlan): void {
  const who = plan.source ? `as ${plan.source}` : 'for any agent';
  const where = plan.project ? `project ${plan.project}` : 'no project';
  console.log(`Preview ${who}, ${where} (${plan.root ?? plan.cwd}); nothing is recorded.`);
  if (plan.items.length === 0) {
    console.log(plan.prompt ? 'No entry matches this prompt.' : 'Nothing to hand over here.');
    return;
  }
  console.log(`\n${recallText(plan, 'rcl_preview')}\n`);
  const scored = plan.items.filter((i) => i.score !== null);
  for (const i of scored) console.log(`Score ${i.score?.toFixed(2)}  ${i.ref}`);
  console.log(`${plan.items.length} items, about ${plan.tokens} of ${plan.budget} tokens.`);
}

export async function main(argv: string[]): Promise<number> {
  let values: { hook?: string; cwd?: string; prompt?: string; agent?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: {
        hook: { type: 'string' },
        cwd: { type: 'string' },
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
    return runHook(values.hook as HookAgent);
  }
  if (values.agent && !(KNOWN_SOURCE_IDS as readonly string[]).includes(values.agent)) {
    console.error(`Unknown agent "${values.agent}" (agents: ${KNOWN_SOURCE_IDS.join(', ')}).`);
    return 2;
  }
  const db = openStore(originHome());
  try {
    const prompt = values.prompt?.trim() || null;
    const plan = planRecall(db, {
      occasion: prompt ? 'prompt' : 'start',
      source: values.agent ?? null,
      prompt,
      ...scopeOf(values.cwd ?? process.cwd()),
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
