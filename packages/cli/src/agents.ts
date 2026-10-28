import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { table } from './format.js';

/**
 * `origin agents`: connect the agents installed on this machine to Origin (see
 * docs/guide/connect-agents.md). It registers Origin's MCP server with each, and adds the recall
 * hooks to those whose hooks can hand context over (see docs/architecture.md#recall). It shows what
 * it would change first, and changes it only with `--yes`, backing up each file it writes; it only
 * ever adds or removes Origin's own entries.
 */

/** The hook command each agent runs (see recall.ts). */
const hookCommand = (agent: string) => `origin recall --hook ${agent}`;
/** How a hook of ours is recognised, whatever an agent did to its spacing. */
const OUR_HOOK = /\borigin\s+recall\s+--hook\b/;
/** The hook events recall answers. */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const;
/** Seconds an agent waits for the hook. */
const HOOK_TIMEOUT = 10;

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

/** How one agent is connected now. */
export interface AgentState {
  agent: string;
  installed: boolean;
  /** Origin's MCP server: registered, through another agent's registration, or not. */
  mcp: 'registered' | 'via-claude-code' | 'missing';
  /** Recall: through hooks (set up or not), or by asking with `brief`. */
  recall: 'hooks' | 'no-hooks' | 'brief';
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

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

const groupsOf = (hooks: Json, event: string): HookGroup[] =>
  Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];

const isOurs = (g: HookGroup) => (g.hooks ?? []).some((h) => OUR_HOOK.test(h.command ?? ''));

/** Whether a settings file has our hook on every recall event. */
function hasHooks(file: string): boolean {
  const hooks = readJson(file).hooks as Json | undefined;
  return !!hooks && HOOK_EVENTS.every((e) => groupsOf(hooks, e).some(isOurs));
}

function addHooks(file: string, agent: string): void {
  const settings = readJson(file);
  const hooks = child(settings, 'hooks');
  for (const event of HOOK_EVENTS) {
    const groups = groupsOf(hooks, event);
    if (groups.some(isOurs)) continue;
    groups.push({
      hooks: [{ type: 'command', command: hookCommand(agent), timeout: HOOK_TIMEOUT }],
    });
    hooks[event] = groups;
  }
  writeJson(file, settings);
}

function removeHooks(file: string): void {
  const settings = readJson(file);
  const hooks = settings.hooks as Json | undefined;
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    const groups = groupsOf(hooks, event)
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !OUR_HOOK.test(h.command ?? '')) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
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
  /** Recall through hooks, in this settings file, or by asking with `brief`. */
  hooks: string | null;
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

/**
 * The agents Origin connects. Claude Code keeps its MCP servers in `~/.claude.json`, which it
 * rewrites as it runs, so its own CLI registers them.
 */
const AGENTS: AgentSpec[] = [
  {
    id: 'claude-code',
    dir: '.claude',
    hooks: path.join('.claude', 'settings.json'),
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
    hooks: path.join('.codex', 'hooks.json'),
    mcp: tomlServer((env) => p(env, '.codex', 'config.toml')),
  },
  {
    id: 'cursor',
    dir: '.cursor',
    hooks: null,
    mcp: jsonServer((env) => p(env, '.cursor', 'mcp.json'), ['mcpServers']),
  },
  {
    id: 'zcode',
    dir: '.zcode',
    hooks: null,
    mcp: jsonServer((env) => p(env, '.zcode', 'cli', 'config.json'), ['mcp', 'servers']),
  },
  {
    // Grok Build merges the servers of ~/.claude.json; without them, its own config.toml.
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
      recall: a.hooks ? (hasHooks(p(env, a.hooks)) ? 'hooks' : 'no-hooks') : 'brief',
    };
  });
}

/** What connecting these agents changes; agents that are not installed are left alone. */
export function planConnect(env: AgentEnv, agents: string[]): Change[] {
  const states = new Map(agentStates(env).map((s) => [s.agent, s]));
  const changes: Change[] = [];
  for (const a of AGENTS) {
    const s = states.get(a.id);
    if (!agents.includes(a.id) || !s?.installed) continue;
    if (s.mcp === 'missing') changes.push({ agent: a.id, ...a.mcp.add(env) });
    if (a.hooks && s.recall === 'no-hooks') {
      const file = p(env, a.hooks);
      changes.push({
        agent: a.id,
        what: `add the recall hooks (${HOOK_EVENTS.join(', ')}) to ${file}`,
        files: [file],
        apply: () => addHooks(file, a.id),
        afterwards:
          a.id === 'codex'
            ? 'Codex runs new hooks only once you trust them: open /hooks in Codex.'
            : undefined,
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
    if (a.hooks && s.recall === 'hooks') {
      const file = p(env, a.hooks);
      changes.push({
        agent: a.id,
        what: `remove the recall hooks from ${file}`,
        files: [file],
        apply: () => removeHooks(file),
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

const RECALL_TEXT: Record<AgentState['recall'], string> = {
  hooks: 'hooks: a brief at session start, matches with each prompt',
  'no-hooks': 'not set up (origin agents connect)',
  brief: 'asks with the brief tool',
};
const MCP_TEXT: Record<AgentState['mcp'], string> = {
  registered: 'registered',
  'via-claude-code': "through Claude Code's registration",
  missing: 'not registered (origin agents connect)',
};

const USAGE = `Usage:
  origin agents                                    How each agent on this machine is connected
  origin agents connect    [<agent>...] [--yes]    Register Origin, and its recall hooks, with the agents
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
        ? [s.agent, 'yes', MCP_TEXT[s.mcp], RECALL_TEXT[s.recall]]
        : [s.agent, 'no', '—', '—'],
    );
    console.log(table(rows, ['Agent', 'Installed', 'MCP server', 'Recall']));
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
