import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { claudeProjectsDir, createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  type Database,
  describeThread,
  isRelay,
  listProposals,
  listSessions,
  listThreadSessions,
  OriginError,
  type Proposal,
  parseTime,
  recallScope,
  type SessionRow,
  syncFile,
  syncSource,
} from '@openlinkos/origin-core';
import { count, oneLine } from './format.js';
import { fmtDateTime, fmtDuration } from './time.js';

/**
 * `origin distill` (see docs/guide/distill.md): consolidation as a headless coding-agent task, not
 * a model API integration (see docs/architecture.md#design-principles). It builds a deterministic
 * scope (a project or a thread, over a time range), writes a prompt for it, and runs Claude Code
 * headless (`claude -p`) against this Origin's own MCP server and nothing else, with only Origin's
 * tools, of which it may not use those that write. The agent reads the scope through Origin's
 * tools and proposes entries with `propose`; nothing is recorded beyond its session, from which
 * ingestion derives the proposals, for the person to accept or reject.
 */

/** The agents that can run a consolidation. The runner is written so that `codex exec` can join. */
export const DISTILL_AGENTS = ['claude-code'] as const;
export const DISTILL_MAX = 10;
export const DISTILL_TURNS = 40;
/** How many of the scope's sessions, and of the project's pending proposals, the prompt lists. */
export const SCOPE_SESSIONS = 30;
export const SCOPE_PENDING = 20;
/**
 * The prompt of a consolidation run starts with this, and its session is named so: such sessions
 * are left out of later scopes, so that a run does not consolidate what runs proposed.
 */
export const DISTILL_HEADER = 'Origin distill:';

const DAY_MS = 86_400_000;

export interface DistillOptions {
  project?: string;
  thread?: string;
  /** A local day, `YYYY-MM-DD`. */
  day?: string;
  /** The start of the range: relative (`24h`, `7d`) or absolute. */
  since?: string;
  agent?: string;
  /** Most proposals the run may make. */
  max?: number;
  /** Most turns the agent may take. */
  maxTurns?: number;
}

/** What a run consolidates. */
export interface DistillScope {
  project: string | null;
  thread: { id: string; title: string | null } | null;
  /** The range, epoch ms; `from` is null for a whole thread. */
  from: number | null;
  until: number;
  /** The range in words, for the prompt and the session's name. */
  label: string;
  /** Whether the range is the last 24 hours up to now, which `changes` lists. */
  recent: boolean;
  /** The scope's sessions, oldest first, at most SCOPE_SESSIONS, and how many more there are. */
  sessions: SessionRow[];
  moreSessions: number;
  /** The project's pending proposals, newest first, at most SCOPE_PENDING, and how many more. */
  pending: Proposal[];
  morePending: number;
  /** Where the run works: the project's directory on this machine, if known. */
  cwd: string;
}

/** Local midnight that starts a `YYYY-MM-DD` day, or throws. */
function dayStart(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) throw new OriginError(`Not a day: ${day} (expected YYYY-MM-DD).`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getDate() !== Number(m[3])) throw new OriginError(`Not a day: ${day}.`);
  return d.getTime();
}

/** A session that a consolidation run made: named so, or prompted so. */
const isDistillRun = (s: SessionRow) =>
  (s.title ?? '').startsWith(DISTILL_HEADER) || (s.prompt ?? '').startsWith(DISTILL_HEADER);

function isDirectory(dir: string | null): dir is string {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The scope of a run, the same for the same store, options, and time: a thread (all of it, or its
 * sessions in the range), or a project, by default the one of the work tree `cwd` is in, over a
 * day, since a time, or by default the last 24 hours. Sessions of earlier runs are left out.
 */
export function distillScope(
  db: Database,
  o: DistillOptions,
  at: { now: number; cwd: string },
): DistillScope {
  if (o.day && o.since) throw new OriginError('Give --day or --since, not both.');
  const card = o.thread ? describeThread(db, o.thread) : null;
  if (o.thread && !card) throw new OriginError(`Unknown thread ${o.thread}.`);
  const project = o.project ?? card?.project ?? recallScope(at.cwd).project ?? null;

  let from: number | null;
  let until = at.now;
  let label: string;
  if (o.day) {
    from = dayStart(o.day);
    until = from + DAY_MS - 1;
    label = `the day of ${o.day}`;
  } else if (o.since) {
    from = parseTime(o.since, at.now) as number;
    label = `since ${fmtDateTime(from)}`;
  } else if (card) {
    from = null;
    label = 'the whole thread';
  } else {
    from = at.now - DAY_MS;
    label = 'the last 24 hours';
  }
  const recent = !o.day && from !== null && at.now - from <= DAY_MS;

  const inRange = (s: SessionRow) =>
    (from === null || (s.endedAt ?? 0) >= from) && (s.startedAt ?? 0) <= until;
  const candidates = card
    ? listThreadSessions(db, card.id).filter(inRange)
    : listSessions(db, {
        project: project ?? undefined,
        since: from ?? undefined,
        until,
        limit: Number.MAX_SAFE_INTEGER,
      });
  const sessions = candidates
    .filter((s) => !isDistillRun(s))
    .sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.sessionId < b.sessionId ? -1 : 1),
    );

  const pending = project
    ? listProposals(db, { status: 'pending', project, limit: SCOPE_PENDING + 1 })
    : [];
  // The project's directory on this machine: the latest of its sessions' that is here.
  const latest = project
    ? listSessions(db, { project, limit: 50 }).find((s) => isDirectory(s.cwd))
    : undefined;
  return {
    project,
    thread: card ? { id: card.id, title: card.title } : null,
    from,
    until,
    label,
    recent,
    sessions: sessions.slice(0, SCOPE_SESSIONS),
    moreSessions: Math.max(0, sessions.length - SCOPE_SESSIONS),
    pending: pending.slice(0, SCOPE_PENDING),
    morePending: Math.max(0, pending.length - SCOPE_PENDING),
    cwd: latest?.cwd ?? at.cwd,
  };
}

/** The scope in a few words, for the session's name. */
export function scopeName(scope: DistillScope): string {
  const what = scope.thread ? `thread ${scope.thread.id}` : (scope.project ?? 'no project');
  return `${DISTILL_HEADER} ${what}, ${scope.label}`;
}

/**
 * The prompt of a run (plain English): what it is doing and for whom, the scope, how to read it
 * through Origin's tools, what to propose and how, what is pending already, and how to finish.
 */
export function distillPrompt(scope: DistillScope, o: { max: number }): string {
  const where = scope.thread
    ? `thread ${scope.thread.id}${scope.thread.title ? ` (“${oneLine(scope.thread.title, 80)}”)` : ''}`
    : scope.project
      ? `project ${scope.project}`
      : 'the sessions of no project';
  const range =
    scope.from === null
      ? `all of it, up to ${fmtDateTime(scope.until)}`
      : `${fmtDateTime(scope.from)} to ${fmtDateTime(scope.until)} (${scope.label})`;
  const sessionLines = scope.sessions.map((s) => {
    const name = s.title ?? (s.prompt ? `“${s.prompt}”` : '(no prompt)');
    return `  - ${s.source} ${s.sessionId}: ${fmtDateTime(s.startedAt)} to ${fmtDateTime(s.endedAt)}, ${count(s.eventCount, 'event')}: ${oneLine(name, 100)}`;
  });
  if (scope.moreSessions > 0) {
    sessionLines.push(
      `  - … and ${count(scope.moreSessions, 'more session')}: list them with \`timeline\`${scope.project ? ` (\`project\`: "${scope.project}")` : ''}, \`since\`, and \`until\`.`,
    );
  }
  const filter = scope.thread
    ? `\`thread\`: "${scope.thread.id}"`
    : scope.project
      ? `\`project\`: "${scope.project}"`
      : 'no filter';
  const lines = [
    `${DISTILL_HEADER} consolidate the user's memory of ${where}, ${scope.label}.`,
    '',
    "You are running headless, on behalf of the user, as Origin's consolidation task. Origin is the user's local, cross-agent memory: an archive of their sessions with AI coding agents, and durable entries that cite those sessions: memory (what happened), knowledge (stable facts), and cognition (the user's preferences, methods, goals, and boundaries). Read what happened in the scope below, and propose the entries that will matter in future sessions and that Origin does not hold yet. The user reviews every proposal and accepts or rejects it; nothing you propose becomes an entry until they accept it.",
    '',
    'Scope',
    `- ${scope.thread ? 'Thread' : 'Project'}: ${scope.thread ? where.slice('thread '.length) : (scope.project ?? '(none)')}`,
    `- Time: ${range}`,
    ...(scope.sessions.length > 0
      ? [`- Sessions, oldest first:`, ...sessionLines]
      : [
          '- Sessions: none in the archive for this scope. Propose nothing, and say so in your last line.',
        ]),
    '',
    'How to read',
    '- Open a session with `get` and its id: its card lists its turns, its thread, and the entries already written from it. Read a turn with `timeline` (`session` and `turn`), or the events after one with `after`. Open any id Origin gives you with `get`.',
    scope.recent
      ? `- \`changes\` (${filter}, no cursor) lists what reached the store in the last 24 hours: the sessions, their messages, the entries already written, and what is already proposed.`
      : `- \`changes\` lists only what reached the store in the last 24 hours; for this scope, read the sessions above.`,
    `- Before you propose anything, \`search\` the entries (\`scope\`: "entries"${scope.project ? `, \`project\`: "${scope.project}"` : ''}) for what they already say, and \`search\` the user's preferences (\`kind\`: "cognition"). Never propose what an existing entry, or a pending proposal listed below, already says.`,
    '',
    'What to propose',
    '- memory: a decision and its reason, as the user made or confirmed it.',
    '- knowledge: a stable fact about the project, its code, its tools, or how it is run.',
    "- cognition: a preference, method, goal, or boundary of the user, from the user's own words.",
    '- One self-contained statement per proposal, specific enough to stand on its own, in the language the user writes in. Leave out what was only tried and dropped, what the code or its documentation already says, and passing details.',
    `- Call \`propose\` for each, citing the events it rests on by id (from \`timeline\` or \`get\`), with a short exact quote from each where it helps. Give ${scope.project ? `\`project\`: "${scope.project}"` : 'the project'} for memory and knowledge of this project, and no project for cognition that holds everywhere. Say in \`note\`, in a few words, what it rests on. Set \`confidence\` to how sure you are.`,
    '- Never call `remember`, `correct`, `forget`, or `follow`: only the user decides what is remembered.',
    `- Propose at most ${o.max} ${o.max === 1 ? 'entry' : 'entries'}. Fewer strong proposals are better than many weak ones, and none is fine when nothing new is worth keeping.`,
  ];
  if (scope.pending.length > 0) {
    lines.push(
      '',
      'Pending proposals of this project, waiting for the user (do not propose these again):',
    );
    for (const p of scope.pending) lines.push(`- ${p.id} (${p.kind}): ${oneLine(p.text, 140)}`);
    if (scope.morePending > 0) lines.push(`- … and ${count(scope.morePending, 'more')}`);
  }
  lines.push(
    '',
    'When you are done, end with one line that says how many entries you proposed, such as "Proposed 3 entries."',
  );
  return lines.join('\n');
}

/** The MCP configuration of a run: this Origin's own server, with this store, and no other. */
export function mcpConfig(o: {
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  node?: string;
}): {
  mcpServers: {
    origin: { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };
  };
} {
  const env: Record<string, string> = {};
  // What chooses this Origin's store, its hub, and its sources' directories. Secrets stay out of
  // the file (and of --dry-run): the server inherits them from the run's environment.
  for (const [k, v] of Object.entries(o.env)) {
    if (v === undefined || k === 'ORIGIN_DISTILL_COMMAND') continue;
    if (/TOKEN|PASSWORD|SECRET|_KEY/i.test(k)) continue;
    if (/^ORIGIN_/.test(k) || ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME'].includes(k)) {
      env[k] = v;
    }
  }
  env.ORIGIN_HOME = path.resolve(o.home);
  return {
    mcpServers: {
      origin: { type: 'stdio', command: o.node ?? process.execPath, args: [o.bin, 'mcp'], env },
    },
  };
}

/** Origin's tools that write: a consolidation run may only propose. */
export const DENIED_TOOLS = ['remember', 'correct', 'forget', 'follow'].map(
  (t) => `mcp__origin__${t}`,
);

/**
 * The arguments of `claude` for a run: print mode with a JSON result, the MCP configuration file
 * and no other servers, Origin's tools only (no built-in tools, none that write), the turns it may
 * take, and the session's id and name. The prompt goes on standard input.
 */
export function claudeArgs(o: {
  configFile: string;
  maxTurns: number;
  sessionId: string;
  name: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--mcp-config',
    o.configFile,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__origin__*',
    '--disallowedTools',
    DENIED_TOOLS.join(','),
    '--tools',
    '',
    '--max-turns',
    String(o.maxTurns),
    '--session-id',
    o.sessionId,
    '--name',
    o.name,
  ];
}

/** How the agent's command is started. */
export interface AgentCommand {
  /** The program, and the arguments that come before the run's own. */
  file: string;
  prefix: string[];
  /** A Windows batch file (an npm shim, `claude.cmd`), which needs cmd.exe. */
  batch: boolean;
}

/** An executable named `name` on the PATH, with the extensions Windows tries, or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not there
      }
    }
  }
  return null;
}

/**
 * The command that runs the agent: ORIGIN_DISTILL_COMMAND when set (a script, run with this Node,
 * or a program), else `claude` on the PATH; null when there is none.
 */
export function agentCommand(env: NodeJS.ProcessEnv = process.env): AgentCommand | null {
  const override = env.ORIGIN_DISTILL_COMMAND?.trim();
  const isBatch = (f: string) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(f);
  if (override) {
    if (/\.[cm]?js$/i.test(override)) {
      return { file: process.execPath, prefix: [path.resolve(override)], batch: false };
    }
    const file = path.isAbsolute(override) ? override : (findOnPath(override, env) ?? override);
    return { file, prefix: [], batch: isBatch(file) };
  }
  const file = findOnPath('claude', env);
  return file ? { file, prefix: [], batch: isBatch(file) } : null;
}

/** cmd.exe's special characters, escaped with `^` outside quotes (as cross-spawn does). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** An argument for a command line that cmd.exe parses, then the program (MSVC rules). */
function cmdArg(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}

/** How to spawn a command: a batch file through cmd.exe, anything else directly. */
export function spawnSpec(
  cmd: AgentCommand,
  args: string[],
): { file: string; args: string[]; verbatim: boolean } {
  const all = [...cmd.prefix, ...args];
  if (!cmd.batch) return { file: cmd.file, args: all, verbatim: false };
  const line = [cmd.file.replace(CMD_META, '^$1'), ...all.map(cmdArg)].join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/** A command line as a person would type it, for --dry-run. */
export function shellLine(file: string, args: string[]): string {
  const q = (a: string) => (a === '' ? '""' : /[\s"'*$`\\]/.test(a) ? JSON.stringify(a) : a);
  return [file, ...args].map(q).join(' ');
}

/** What `claude -p --output-format json` prints when it is done. */
interface ClaudeResult {
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  result?: string;
}

/** The last JSON object an agent printed, or null. */
export function lastJson(stdout: string): ClaudeResult | null {
  const text = stdout.trim();
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as ClaudeResult;
  } catch {
    // several lines, or noise before it
  }
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as ClaudeResult;
    } catch {
      // not this one
    }
  }
  return null;
}

/** The transcript of a Claude Code session, under its projects directory, or null. */
export function findTranscript(sessionId: string, projects = claudeProjectsDir()): string | null {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(projects, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export interface DistillCtx {
  db: Database;
  home: string;
  /** After the run's session is ingested, on a connected device: sync with the hub. */
  afterChange: () => Promise<void>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: number;
  cwd?: string;
}

const USAGE =
  'Usage: origin distill [--project <name>] [--thread <thr_…>] [--day <YYYY-MM-DD> | --since <time>] [--agent claude-code] [--max <n>] [--max-turns <n>] [--dry-run]';

/** A positive integer option, or throws. */
function positive(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new OriginError(`--${name} takes a whole number of 1 or more.`);
  return n;
}

/** `origin distill`: run a consolidation for a scope, or with --dry-run show how it would run. */
export async function cmdDistill(ctx: DistillCtx, argv: string[]): Promise<number> {
  const out = ctx.out ?? ((line: string) => console.log(line));
  const err = ctx.err ?? ((line: string) => console.error(line));
  const env = ctx.env ?? process.env;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        project: { type: 'string' },
        thread: { type: 'string' },
        day: { type: 'string' },
        since: { type: 'string' },
        agent: { type: 'string', default: 'claude-code' },
        max: { type: 'string' },
        'max-turns': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const agent = String(values.agent);
  if (!(DISTILL_AGENTS as readonly string[]).includes(agent)) {
    throw new OriginError(
      `origin distill runs ${DISTILL_AGENTS.join(', ')} for now, not ${agent}: it needs a headless mode that takes an MCP configuration and limits the agent to Origin's tools.`,
    );
  }
  if (isRelay(ctx.db)) {
    throw new OriginError(
      'This store is a relay and keeps no sessions to consolidate: run origin distill on the hub, or on a device with a complete store.',
    );
  }
  const max = positive(values.max as string | undefined, 'max', DISTILL_MAX);
  const maxTurns = positive(values['max-turns'] as string | undefined, 'max-turns', DISTILL_TURNS);
  const now = ctx.now ?? Date.now();
  const scope = distillScope(
    ctx.db,
    {
      project: values.project as string | undefined,
      thread: values.thread as string | undefined,
      day: values.day as string | undefined,
      since: values.since as string | undefined,
    },
    { now, cwd: ctx.cwd ?? process.cwd() },
  );
  const prompt = distillPrompt(scope, { max });
  const sessionId = randomUUID();
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const config = mcpConfig({ home: ctx.home, bin, env });

  if (values['dry-run']) {
    const args = claudeArgs({
      configFile: '<mcp config>',
      maxTurns,
      sessionId,
      name: scopeName(scope),
    });
    out('Prompt (on standard input):\n');
    out(prompt);
    out(`\nCommand, run in ${scope.cwd}:\n`);
    out(`${shellLine('claude', args)} < <prompt>`);
    out('\nMCP config (<mcp config>, a temporary file):\n');
    out(JSON.stringify(config, null, 2));
    out('\nNothing was run (--dry-run).');
    return 0;
  }

  const cmd = agentCommand(env);
  if (!cmd) {
    throw new OriginError(
      'Claude Code (claude) is not on the PATH: install it (https://docs.claude.com/en/docs/claude-code), or set ORIGIN_DISTILL_COMMAND to the command that runs it.',
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-distill-'));
  const configFile = path.join(tmp, 'mcp.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  const args = claudeArgs({ configFile, maxTurns, sessionId, name: scopeName(scope) });
  out(
    `Consolidating ${scope.thread ? `thread ${scope.thread.id}` : `project ${scope.project ?? '(none)'}`}, ${scope.label}: ${count(scope.sessions.length + scope.moreSessions, 'session')}, at most ${count(max, 'proposal')}.`,
  );
  out(`Running Claude Code headless in ${scope.cwd} (session ${sessionId}) …`);
  const started = Date.now();
  let run: { code: number | null; stdout: string; stderr: string };
  try {
    run = await runAgent(cmd, args, {
      cwd: scope.cwd,
      env: { ...env, ORIGIN_HOME: path.resolve(ctx.home) },
      input: prompt,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const result = lastJson(run.stdout);
  const ran = result?.session_id ?? sessionId;
  if (!result) {
    err(`The agent ended (exit code ${run.code}) without a result.`);
    if (run.stderr.trim()) err(run.stderr.trim().split(/\r?\n/).slice(-10).join('\n'));
  }

  // The run is its session: ingest it (the agent's hooks may have already), then its proposals.
  const adapter = createClaudeCodeAdapter();
  const transcript = findTranscript(ran);
  if (transcript) await syncFile({ db: ctx.db, home: ctx.home }, adapter, transcript);
  else await syncSource({ db: ctx.db, home: ctx.home }, adapter);
  await ctx.afterChange();
  const proposals = listProposals(ctx.db, {
    session: { source: 'claude-code', sessionId: ran },
    limit: 1000,
  });

  const took = fmtDuration(result?.duration_ms ?? Date.now() - started);
  const cost =
    typeof result?.total_cost_usd === 'number' ? `, $${result.total_cost_usd.toFixed(2)}` : '';
  const turns = typeof result?.num_turns === 'number' ? `${count(result.num_turns, 'turn')}, ` : '';
  out(
    `\nSession ${ran}: ${turns}${took}${cost}${result?.subtype && result.subtype !== 'success' ? ` (${result.subtype})` : ''}.`,
  );
  if (result?.result)
    out(
      `The agent said: ${oneLine(
        result.result
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .at(-1) ?? '',
        200,
      )}`,
    );
  if (proposals.length === 0) {
    out('It proposed nothing.');
  } else {
    out(`\nIt proposed ${count(proposals.length, 'entry', 'entries')}:`);
    for (const p of [...proposals].reverse()) {
      out(`  ${p.id}  ${p.kind.padEnd(9)}  ${oneLine(p.text, 100)}`);
    }
    out(
      '\nReview them: origin show <id>, then origin accept <id> or origin reject <id> --reason <text>; or the Proposals page of origin ui.',
    );
  }
  if (!transcript)
    out(
      `\nIts transcript was not found under ${claudeProjectsDir()}; a sync of Claude Code's sessions looked for it.`,
    );
  return result && !result.is_error ? 0 : 1;
}

/** Run the agent with the prompt on standard input; resolves with its exit code and output. */
function runAgent(
  cmd: AgentCommand,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; input: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const spec = spawnSpec(cmd, args);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (e) =>
      reject(new OriginError(`Could not run ${cmd.file}: ${(e as Error).message}`)),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {
      // the agent may exit before reading all of it; its exit code says what happened
    });
    child.stdin.end(o.input);
  });
}
