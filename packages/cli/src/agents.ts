import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { table } from './format.js';

/**
 * `origin agents`: connect the agents installed on this machine to Origin (see
 * docs/guide/connect-agents.md). It registers Origin's MCP server with each, and adds Origin's
 * hooks to those whose hooks Origin uses: the recall hooks, which hand context over (see
 * docs/architecture.md#recall), and the ingest hooks, which ingest a session's new lines as each
 * turn ends (see docs/architecture.md#live-ingestion). It shows what it would change first, and
 * changes it only with `--yes`, backing up each file it writes; it only ever adds or removes
 * Origin's own entries, which it recognises by their command, and ZCode's switch for all hooks,
 * which it turns on only when Origin's are the only hooks there.
 */

/** One kind of Origin's hooks: the command each agent runs, and how it is set up. */
interface HookKind {
  /** What the hooks do, for the preview: `recall` or `ingest`. */
  name: 'recall' | 'ingest';
  command(agent: string): string;
  /** How a hook of this kind is recognised, whatever an agent did to its spacing. */
  ours: RegExp;
  /** Seconds an agent gives the hook. */
  timeout: number;
  /** Run in the background, so that the agent never waits for it. */
  async: boolean;
}

/** `origin recall --hook`: the agent waits for its answer, a brief or a prompt's matches. */
const RECALL_HOOKS: HookKind = {
  name: 'recall',
  command: (agent) => `origin recall --hook ${agent}`,
  ours: /\borigin\s+recall\s+--hook\b/,
  timeout: 10,
  async: false,
};

/** `origin sync --hook`: hands Origin the transcript a turn wrote; nothing for the agent to wait for. */
const INGEST_HOOKS: HookKind = {
  name: 'ingest',
  command: (agent) => `origin sync --hook ${agent}`,
  ours: /\borigin\s+sync\s+--hook\b/,
  timeout: 60,
  async: true,
};

/** Origin's two kinds of hooks. */
const KINDS = [RECALL_HOOKS, INGEST_HOOKS];

export interface AgentEnv {
  home: string;
  platform: NodeJS.Platform;
  /** Whether a command is on the PATH. */
  has(command: string): boolean;
  /** Run a command; its exit code and output. */
  run(command: string, args: string[]): { status: number; output: string };
  now(): Date;
}

export function defaultEnv(): AgentEnv {
  const shell = process.platform === 'win32';
  return {
    home: os.homedir(),
    platform: process.platform,
    has: (command) =>
      spawnSync(shell ? 'where' : 'which', [command], { stdio: 'ignore', shell }).status === 0,
    run: (command, args) => {
      const r = spawnSync(command, args, { encoding: 'utf8', shell });
      return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
    },
    now: () => new Date(),
  };
}

/** How agents start Origin's server: on Windows, npm's `origin.cmd` needs `cmd /c`. */
function serverCommand(env: AgentEnv): { command: string; args: string[] } {
  return env.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'origin', 'mcp'] }
    : { command: 'origin', args: ['mcp'] };
}

/** A change to make: a file to write, or a command to run, with what it does in words. */
export interface Change {
  agent: string;
  /** What it does, for the preview. */
  what: string;
  /** The files it writes, backed up first. */
  files: string[];
  apply(): void;
  /** Something the user still has to do afterwards, if anything. */
  afterwards?: string;
}

/**
 * How an agent's hooks of one kind stand: set up, not (or not on every event), set up but off (ZCode
 * runs none while its `hooks.enabled` is not true), or set up but not trusted yet (Codex).
 */
export type HookStatus = 'hooks' | 'no-hooks' | 'off' | 'untrusted';

/** How one agent is connected now. */
export interface AgentState {
  agent: string;
  installed: boolean;
  /** Origin's MCP server: registered, through another agent's registration, or not. */
  mcp: 'registered' | 'via-claude-code' | 'missing';
  /** Recall: through hooks, or by asking with `brief`. */
  recall: HookStatus | 'brief';
  /**
   * New session lines: through hooks after each turn, or picked up by looking, as `origin mcp`
   * does every minute and `origin sync` does.
   */
  ingest: HookStatus | 'watch';
}

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file} does not hold a JSON object.`);
  }
  return value as Json;
}

/** Write JSON as agents do: two-space indent, the file's line endings and final newline kept. */
function writeJson(file: string, value: Json): void {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = old.includes('\r\n') ? '\r\n' : '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2).replace(/\n/g, eol)}${eol}`);
}

/** The object under a key, created when missing. */
function child(o: Json, key: string): Json {
  const v = o[key];
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Json;
  const fresh: Json = {};
  o[key] = fresh;
  return fresh;
}

/**
 * Where an agent keeps its hooks, and how it writes one. Claude Code, Codex, and ZCode list matcher
 * groups under each event (`{ "hooks": [ <hook> ] }`); Cursor lists the hooks themselves.
 */
interface HookFile {
  /** The settings file, under the home directory. */
  file: string[];
  /** The keys of the object that maps events to their hooks: `hooks`, or ZCode's `hooks.events`. */
  events: string[];
  /** Origin's hook of this kind, as the agent writes it under an event. */
  entry(kind: HookKind, agent: string): Json;
  /**
   * The key of a switch that must be true for the agent to run any hook (ZCode's `hooks.enabled`,
   * off by default). Origin turns it on only when the file holds no hooks but its own, so that no
   * hook the user left off starts running.
   */
  enabled?: string[];
  /** What a file the agent reads needs besides the hooks: Cursor's `version`. */
  prepare?(settings: Json): void;
}

/** A matcher group of one command hook, as Claude Code and Codex write it. */
const claudeEntry = (kind: HookKind, agent: string): Json => {
  const hook = { type: 'command', command: kind.command(agent), timeout: kind.timeout };
  return { hooks: [kind.async ? { ...hook, async: true } : hook] };
};

/**
 * The commands of the hooks an entry under an event holds: those of a matcher group, or the one of
 * a hook listed by itself, as Cursor lists them.
 */
function commandsOf(entry: unknown): string[] {
  if (typeof entry !== 'object' || entry === null) return [];
  const e = entry as { command?: unknown; hooks?: unknown };
  if (Array.isArray(e.hooks)) {
    return e.hooks.map((h) =>
      typeof h === 'object' && h !== null && typeof h.command === 'string' ? h.command : '',
    );
  }
  return typeof e.command === 'string' ? [e.command] : [];
}

/** The object at `keys`, or null; `create` makes the objects missing on the way. */
function objectAt(root: Json, keys: string[], create = false): Json | null {
  let at = root;
  for (const key of keys) {
    const v = at[key];
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) at = v as Json;
    else if (create) at = child(at, key);
    else return null;
  }
  return at;
}

const entriesOf = (events: Json | null, event: string): unknown[] =>
  events && Array.isArray(events[event]) ? (events[event] as unknown[]) : [];

const isOurs = (kind: HookKind) => (entry: unknown) =>
  commandsOf(entry).some((c) => kind.ours.test(c));

const isOrigins = (command: string) => KINDS.some((k) => k.ours.test(command));

/** Whether any hook in the file is not one of Origin's. */
function othersIn(events: Json | null): boolean {
  return Object.keys(events ?? {}).some((e) =>
    entriesOf(events, e).some((entry) => commandsOf(entry).some((c) => !isOrigins(c))),
  );
}

/** The value at `keys`, or undefined. */
function valueAt(root: Json, keys: string[]): unknown {
  const parent = objectAt(root, keys.slice(0, -1));
  return parent ? parent[keys.at(-1) as string] : undefined;
}

/** On how many of `events` a settings file has a hook of this kind: all, some, or none. */
function hookState(file: string, at: HookFile, kind: HookKind, events: string[]) {
  const hooks = objectAt(readJson(file), at.events);
  const set = events.filter((e) => entriesOf(hooks, e).some(isOurs(kind))).length;
  return set === 0 ? 'none' : set === events.length ? 'all' : 'some';
}

/** Whether the agent runs the file's hooks at all; null when it would but Origin cannot turn it on. */
function switchedOn(file: string, at: HookFile): boolean | null {
  if (!at.enabled) return true;
  const settings = readJson(file);
  if (valueAt(settings, at.enabled) === true) return true;
  return othersIn(objectAt(settings, at.events)) ? null : false;
}

/**
 * Add a hook of this kind to every event that lacks one, next to the hooks already there, and turn
 * the agent's hooks on if they are off and the file holds no hooks but Origin's.
 */
function addHooks(file: string, at: HookFile, agent: string, kind: HookKind, events: string[]) {
  const settings = readJson(file);
  at.prepare?.(settings);
  const hooks = objectAt(settings, at.events, true) as Json;
  for (const event of events) {
    const entries = entriesOf(hooks, event);
    if (entries.some(isOurs(kind))) continue;
    hooks[event] = [...entries, at.entry(kind, agent)];
  }
  if (at.enabled && !othersIn(hooks)) {
    const parent = objectAt(settings, at.enabled.slice(0, -1), true) as Json;
    parent[at.enabled.at(-1) as string] = true;
  }
  writeJson(file, settings);
}

/**
 * Remove the hooks of this kind, from every event; the agent's other hooks stay as they are. What
 * is left empty goes, and so does a switch left with no hook to run (ZCode's `hooks.enabled`).
 */
function removeHooks(file: string, at: HookFile, kind: HookKind): void {
  const settings = readJson(file);
  const hooks = objectAt(settings, at.events);
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const entries = (hooks[event] as unknown[]).flatMap((entry) => {
      if (!isOurs(kind)(entry)) return [entry];
      const e = entry as { hooks?: unknown };
      if (!Array.isArray(e.hooks)) return [];
      const left = e.hooks.filter(
        (h) => !commandsOf({ hooks: [h] }).some((c) => kind.ours.test(c)),
      );
      return left.length > 0 ? [{ ...e, hooks: left }] : [];
    });
    if (entries.length > 0) hooks[event] = entries;
    else delete hooks[event];
  }
  // Empty objects on the way to the events go, from the innermost out.
  for (let n = at.events.length; n > 0; n--) {
    const keys = at.events.slice(0, n);
    const o = objectAt(settings, keys);
    if (!o) continue;
    const rest = Object.keys(o).filter(
      (k) => !(at.enabled && keys.length === at.enabled.length - 1 && k === at.enabled.at(-1)),
    );
    if (rest.length > 0) break;
    delete (objectAt(settings, keys.slice(0, -1)) as Json)[keys.at(-1) as string];
  }
  writeJson(file, settings);
}

/** The JSON object agents keep their MCP servers in, by the path to it. */
function serversIn(file: string, keys: string[]): Json | null {
  let at: unknown = readJson(file);
  for (const key of keys) {
    if (typeof at !== 'object' || at === null) return null;
    at = (at as Json)[key];
  }
  return typeof at === 'object' && at !== null ? (at as Json) : null;
}

function setServer(file: string, keys: string[], entry: Json | null): void {
  const root = readJson(file);
  let at = root;
  for (const key of keys) at = child(at, key);
  if (entry) at.origin = entry;
  else delete at.origin;
  writeJson(file, root);
}

/** Whether a TOML file has the `[mcp_servers.origin]` table. */
const TOML_TABLE = /^\[mcp_servers\.origin\]\s*$/m;

function tomlHasServer(file: string): boolean {
  return fs.existsSync(file) && TOML_TABLE.test(fs.readFileSync(file, 'utf8'));
}

function tomlAddServer(file: string, env: AgentEnv): void {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = old.includes('\r\n') ? '\r\n' : '\n';
  const { command, args } = serverCommand(env);
  const table = [
    '[mcp_servers.origin]',
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
  ].join(eol);
  const gap = old === '' ? '' : old.endsWith(eol) ? eol : `${eol}${eol}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${old}${gap}${table}${eol}`);
}

/** Remove the `[mcp_servers.origin]` table: its header and lines, up to the next table. */
function tomlRemoveServer(file: string): void {
  const lines = fs.readFileSync(file, 'utf8').split(/(?<=\n)/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = TOML_TABLE.test(line.trimEnd());
    if (!skipping) out.push(line);
  }
  fs.writeFileSync(file, out.join('').replace(/(\r?\n)(\r?\n)+$/, '$1'));
}

interface AgentSpec {
  id: string;
  /** The directory whose presence says the agent is installed. */
  dir: string;
  /** Recall, and ingestion, through hooks in this file; or recall by asking with `brief`. */
  hooks: {
    at: HookFile;
    /** The events recall answers (see recall.ts). */
    recall: string[];
    /**
     * The hook events after which a session's transcript may have new lines (see sync-hook.ts); none
     * for an agent whose sessions are found by looking. Not SessionEnd: its budget (1.5 s in Claude
     * Code, 1 s in Codex) is too short to reach a hub, and the MCP server's last sync, or the next
     * hook, reads a session's last lines.
     */
    ingest: string[];
    /** True when the agent certainly runs none of the file's hooks yet, until the user trusts them. */
    untrusted?(env: AgentEnv): boolean;
  } | null;
  mcp: {
    has(env: AgentEnv): boolean;
    add(env: AgentEnv): Omit<Change, 'agent'>;
    remove(env: AgentEnv): Omit<Change, 'agent'>;
  };
}

const p = (env: AgentEnv, ...parts: string[]) => path.join(env.home, ...parts);

/** An MCP server entry in a JSON file, under `keys`. */
function jsonServer(file: (env: AgentEnv) => string, keys: string[]): AgentSpec['mcp'] {
  return {
    has: (env) => !!serversIn(file(env), keys)?.origin,
    add: (env) => ({
      what: `register the MCP server in ${file(env)}`,
      files: [file(env)],
      apply: () => setServer(file(env), keys, serverCommand(env)),
    }),
    remove: (env) => ({
      what: `remove the MCP server from ${file(env)}`,
      files: [file(env)],
      apply: () => setServer(file(env), keys, null),
    }),
  };
}

/** An `[mcp_servers.origin]` table in a TOML file. */
function tomlServer(file: (env: AgentEnv) => string): AgentSpec['mcp'] {
  return {
    has: (env) => tomlHasServer(file(env)),
    add: (env) => ({
      what: `register the MCP server in ${file(env)}`,
      files: [file(env)],
      apply: () => tomlAddServer(file(env), env),
    }),
    remove: (env) => ({
      what: `remove the MCP server from ${file(env)}`,
      files: [file(env)],
      apply: () => tomlRemoveServer(file(env)),
    }),
  };
}

const claudeJson = (env: AgentEnv) => p(env, '.claude.json');

/** The events Claude Code, Codex, and ZCode run recall at: a session starts, a prompt is sent. */
const RECALL_EVENTS = ['SessionStart', 'UserPromptSubmit'];

/**
 * Whether Codex has trusted no hook at all: it records the hash of each hook the user trusts with
 * `/hooks` as a `trusted_hash` in its config.toml (under `hooks.state`), and runs no other. With
 * any recorded, Origin cannot tell which are its own without Codex's hash, and says nothing.
 */
function codexTrustsNone(env: AgentEnv): boolean {
  const file = p(env, '.codex', 'config.toml');
  return !fs.existsSync(file) || !/\btrusted_hash\b/.test(fs.readFileSync(file, 'utf8'));
}

/**
 * The agents Origin connects. Claude Code keeps its MCP servers in `~/.claude.json`, which it
 * rewrites as it runs, so its own CLI registers them.
 */
const AGENTS: AgentSpec[] = [
  {
    id: 'claude-code',
    dir: '.claude',
    hooks: {
      at: { file: ['.claude', 'settings.json'], events: ['hooks'], entry: claudeEntry },
      recall: RECALL_EVENTS,
      ingest: ['Stop', 'SubagentStop', 'PostCompact'],
    },
    mcp: {
      has: (env) => !!serversIn(claudeJson(env), ['mcpServers'])?.origin,
      add: (env) => {
        const { command, args } = serverCommand(env);
        const argv = ['mcp', 'add', '--scope', 'user', 'origin', '--', command, ...args];
        return {
          what: `register the MCP server: claude ${argv.join(' ')}`,
          files: [claudeJson(env)],
          apply: () => runAgentCli(env, 'claude', argv),
        };
      },
      remove: (env) => {
        const argv = ['mcp', 'remove', '--scope', 'user', 'origin'];
        return {
          what: `remove the MCP server: claude ${argv.join(' ')}`,
          files: [claudeJson(env)],
          apply: () => runAgentCli(env, 'claude', argv),
        };
      },
    },
  },
  {
    id: 'codex',
    dir: '.codex',
    hooks: {
      at: { file: ['.codex', 'hooks.json'], events: ['hooks'], entry: claudeEntry },
      recall: RECALL_EVENTS,
      ingest: ['Stop', 'SubagentStop'],
      untrusted: codexTrustsNone,
    },
    mcp: tomlServer((env) => p(env, '.codex', 'config.toml')),
  },
  // Cursor and ZCode get recall hooks only: their sessions, in databases, are found by looking.
  {
    // Cursor's own hooks, `{ "command", "timeout" }` under each event of a file with a `version`.
    // Its `sessionStart` hook runs while the conversation is being created, and what it returns is
    // often lost: a conversation's first prompt brings its brief instead (see recall.ts).
    id: 'cursor',
    dir: '.cursor',
    hooks: {
      at: {
        file: ['.cursor', 'hooks.json'],
        events: ['hooks'],
        entry: (kind, agent) => ({ command: kind.command(agent), timeout: kind.timeout }),
        prepare: (settings) => {
          settings.version ??= 1;
        },
      },
      recall: ['beforeSubmitPrompt'],
      ingest: [],
    },
    mcp: jsonServer((env) => p(env, '.cursor', 'mcp.json'), ['mcpServers']),
  },
  {
    // ZCode's hooks, under `hooks.events`, run only with `hooks.enabled`. Its schema is strict, and
    // one entry it refuses turns every hook off, so Origin's has `type`, `command`, and `timeoutMs`
    // alone, in milliseconds.
    id: 'zcode',
    dir: '.zcode',
    hooks: {
      at: {
        file: ['.zcode', 'cli', 'config.json'],
        events: ['hooks', 'events'],
        entry: (kind, agent) => ({
          hooks: [
            { type: 'command', command: kind.command(agent), timeoutMs: kind.timeout * 1000 },
          ],
        }),
        enabled: ['hooks', 'enabled'],
      },
      recall: RECALL_EVENTS,
      ingest: [],
    },
    mcp: jsonServer((env) => p(env, '.zcode', 'cli', 'config.json'), ['mcp', 'servers']),
  },
  {
    // Grok Build merges the servers of ~/.claude.json; without them, its own config.toml. It runs
    // Claude Code's hooks too, but reads nothing they return at a session's start or a prompt; its
    // agents call `brief` as Origin's instructions say.
    id: 'grok',
    dir: '.grok',
    hooks: null,
    mcp: tomlServer((env) => p(env, '.grok', 'config.toml')),
  },
];

export const AGENT_IDS = AGENTS.map((a) => a.id);

function runAgentCli(env: AgentEnv, command: string, args: string[]): void {
  if (!env.has(command)) {
    throw new Error(
      `\`${command}\` is not on the PATH; run it yourself: ${command} ${args.join(' ')}`,
    );
  }
  const r = env.run(command, args);
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${r.output}`);
}

/** Each kind of hook an agent takes, with the events it goes on. */
const hookKinds = (a: AgentSpec): Array<[HookKind, string[]]> =>
  a.hooks
    ? (
        [
          [RECALL_HOOKS, a.hooks.recall],
          [INGEST_HOOKS, a.hooks.ingest],
        ] as Array<[HookKind, string[]]>
      ).filter(([, events]) => events.length > 0)
    : [];

/** How an agent's hooks of one kind stand (see HookStatus). */
function hookStatus(env: AgentEnv, a: AgentSpec, kind: HookKind, events: string[]): HookStatus {
  const hooks = a.hooks as NonNullable<AgentSpec['hooks']>;
  const file = p(env, ...hooks.at.file);
  if (hookState(file, hooks.at, kind, events) !== 'all') return 'no-hooks';
  if (switchedOn(file, hooks.at) !== true) return 'off';
  return hooks.untrusted?.(env) ? 'untrusted' : 'hooks';
}

/** How each agent is connected now. */
export function agentStates(env: AgentEnv): AgentState[] {
  return AGENTS.map((a) => {
    const installed = fs.existsSync(p(env, a.dir));
    const own = a.mcp.has(env);
    const viaClaude =
      a.id === 'grok' && !own && !!serversIn(claudeJson(env), ['mcpServers'])?.origin;
    return {
      agent: a.id,
      installed,
      mcp: own ? 'registered' : viaClaude ? 'via-claude-code' : 'missing',
      recall: a.hooks ? hookStatus(env, a, RECALL_HOOKS, a.hooks.recall) : 'brief',
      ingest:
        a.hooks && a.hooks.ingest.length > 0
          ? hookStatus(env, a, INGEST_HOOKS, a.hooks.ingest)
          : 'watch',
    };
  });
}

/** What the user still has to do for an agent to run the hooks Origin adds. */
function hooksAfterwards(a: AgentSpec, file: string): string | undefined {
  if (a.id === 'codex')
    return 'Codex runs new hooks only once you trust them: open /hooks in Codex.';
  const at = a.hooks?.at;
  if (at?.enabled && switchedOn(file, at) === null) {
    return `ZCode runs no hooks while ${at.enabled.join('.')} is not true in ${file}. Origin left it as it was, since turning it on runs the other hooks there too.`;
  }
  return undefined;
}

/**
 * What connecting these agents changes; agents that are not installed are left alone. Hooks an
 * agent lacks are added, so an agent connected by an earlier version gets the new ones; an
 * agent's hooks that are off are turned on, when Origin's are the only ones there.
 */
export function planConnect(env: AgentEnv, agents: string[]): Change[] {
  const states = new Map(agentStates(env).map((s) => [s.agent, s]));
  const changes: Change[] = [];
  for (const a of AGENTS) {
    const s = states.get(a.id);
    if (!agents.includes(a.id) || !s?.installed) continue;
    if (s.mcp === 'missing') changes.push({ agent: a.id, ...a.mcp.add(env) });
    if (!a.hooks) continue;
    const at = a.hooks.at;
    const file = p(env, ...at.file);
    for (const [kind, events] of hookKinds(a)) {
      const all = hookState(file, at, kind, events) === 'all';
      if (all && switchedOn(file, at) !== false) continue;
      changes.push({
        agent: a.id,
        what: all
          ? `turn on the hooks in ${file} (${at.enabled?.join('.')})`
          : `add the ${kind.name} hooks (${events.join(', ')}) to ${file}`,
        files: [file],
        apply: () => addHooks(file, at, a.id, kind, events),
        afterwards: hooksAfterwards(a, file),
      });
    }
  }
  return changes;
}

/** What disconnecting these agents changes: Origin's own entries, removed. */
export function planDisconnect(env: AgentEnv, agents: string[]): Change[] {
  const states = new Map(agentStates(env).map((s) => [s.agent, s]));
  const changes: Change[] = [];
  for (const a of AGENTS) {
    const s = states.get(a.id);
    if (!agents.includes(a.id) || !s) continue;
    if (s.mcp === 'registered') changes.push({ agent: a.id, ...a.mcp.remove(env) });
    if (!a.hooks) continue;
    const at = a.hooks.at;
    const file = p(env, ...at.file);
    const events = Object.keys(objectAt(readJson(file), at.events) ?? {});
    for (const [kind] of hookKinds(a)) {
      // Any of ours goes, on whatever event it was found.
      if (hookState(file, at, kind, events) === 'none') continue;
      changes.push({
        agent: a.id,
        what: `remove the ${kind.name} hooks from ${file}`,
        files: [file],
        apply: () => removeHooks(file, at, kind),
      });
    }
  }
  return changes;
}

/** Back up the files a change writes, next to them, then make it. Returns the backups. */
export function applyChange(env: AgentEnv, change: Change): string[] {
  const stamp = env.now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const backups: string[] = [];
  for (const file of change.files) {
    if (!fs.existsSync(file)) continue;
    const backup = `${file}.origin-backup-${stamp}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    backups.push(backup);
  }
  change.apply();
  return backups;
}

/** Hooks set up but not run yet, whatever they do. */
const WAITING: Record<'off' | 'untrusted' | 'no-hooks', string> = {
  'no-hooks': 'not set up (origin agents connect)',
  off: 'hooks set up, but off (hooks.enabled)',
  untrusted: 'hooks set up, not trusted yet (/hooks in Codex)',
};
const RECALL_TEXT: Record<AgentState['recall'], string> = {
  ...WAITING,
  hooks: 'hooks: a brief at session start, matches with each prompt',
  brief: 'asks with the brief tool',
};
const INGEST_TEXT: Record<AgentState['ingest'], string> = {
  ...WAITING,
  hooks: 'hooks: as each turn ends',
  watch: 'every minute while origin mcp runs',
};
/** Cursor's recall hook runs at each prompt (see the agent's spec). */
const CURSOR_RECALL = 'hooks: a brief with the first prompt, matches with each one after';
const MCP_TEXT: Record<AgentState['mcp'], string> = {
  registered: 'registered',
  'via-claude-code': "through Claude Code's registration",
  missing: 'not registered (origin agents connect)',
};

const USAGE = `Usage:
  origin agents                                    How each agent on this machine is connected
  origin agents connect    [<agent>...] [--yes]    Register Origin, and its hooks, with the agents
  origin agents disconnect [<agent>...] [--yes]    Remove what connect added
Agents: ${AGENT_IDS.join(', ')} (all installed ones by default). Changes are shown first, and made with --yes.`;

export function cmdAgents(args: string[], env: AgentEnv = defaultEnv()): number {
  const { values, positionals } = parseArgs({
    args,
    options: { yes: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [action, ...named] = positionals;
  if (action === undefined) {
    const rows = agentStates(env).map((s) =>
      s.installed
        ? [
            s.agent,
            'yes',
            MCP_TEXT[s.mcp],
            s.agent === 'cursor' && s.recall === 'hooks' ? CURSOR_RECALL : RECALL_TEXT[s.recall],
            INGEST_TEXT[s.ingest],
          ]
        : [s.agent, 'no', '—', '—', '—'],
    );
    console.log(table(rows, ['Agent', 'Installed', 'MCP server', 'Recall', 'New lines']));
    return 0;
  }
  if (action !== 'connect' && action !== 'disconnect') {
    console.error(USAGE);
    return 2;
  }
  const unknown = named.filter((a) => !AGENT_IDS.includes(a));
  if (unknown.length > 0) {
    console.error(`Unknown agent: ${unknown.join(', ')} (agents: ${AGENT_IDS.join(', ')})`);
    return 2;
  }
  const agents = named.length > 0 ? named : AGENT_IDS;
  const changes = action === 'connect' ? planConnect(env, agents) : planDisconnect(env, agents);
  if (changes.length === 0) {
    console.log(
      action === 'connect'
        ? 'Nothing to change: these agents are connected already, or not installed.'
        : 'Nothing to change: Origin is not set up in these agents.',
    );
    return 0;
  }
  if (!values.yes) {
    console.log(`origin agents ${action} would:`);
    for (const c of changes) console.log(`  ${c.agent}: ${c.what}`);
    console.log(
      '\nRun again with --yes to make these changes; each file is backed up next to it first.',
    );
    return 0;
  }
  let failed = 0;
  const afterwards = new Set<string>();
  for (const c of changes) {
    try {
      const backups = applyChange(env, c);
      console.log(
        `${c.agent}: ${c.what}${backups.length > 0 ? ` (backup: ${backups.join(', ')})` : ''}`,
      );
      if (c.afterwards) afterwards.add(c.afterwards);
    } catch (err) {
      failed++;
      console.error(`${c.agent}: could not ${c.what}: ${(err as Error).message}`);
    }
  }
  for (const note of afterwards) console.log(note);
  console.log('Start a new session of each agent to load the changes.');
  return failed > 0 ? 1 : 0;
}
