import os from 'node:os';
import path from 'node:path';

/**
 * The plugin's config (`plugins.entries.origin.config` in the Gateway's config), checked at
 * `register`. The manifest's JSON Schema checks each field before OpenClaw loads the plugin; this
 * checks the fields again, for hosts that do not, and the rules between fields, so that a
 * misconfigured plugin says once what is wrong and records nothing.
 */
export interface Config {
  /** The source the lines are recorded under, `openclaw` by default. */
  source: string;
  /** Where the lines go: a directory an Origin device reads, or a hub. */
  target: { kind: 'dir'; dir: string } | { kind: 'hub'; url: string; token: string };
  /** Each session's project: its agent's id, or its channel. */
  projectBy: 'agent' | 'channel';
  /** One project for every session, in place of projectBy. */
  project: string | null;
  includeTools: boolean;
  reconcileOnEnd: boolean;
  /** The agents to record, by id; null for all. */
  agents: string[] | null;
  /** The kinds of runs to record (`ctx.trigger`): user turns only by default. */
  triggers: string[];
  /** Where undelivered lines and the record of what was sent are kept. */
  stateDir: string;
  /** How long one delivery to a hub may take. */
  timeoutMs: number;
}

export interface ConfigEnv {
  env: NodeJS.ProcessEnv;
  /** OpenClaw's own path resolution, if the host gives it. */
  resolvePath?: (input: string) => string;
  /** The default state directory, under OpenClaw's state directory. */
  defaultStateDir: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };

/** The rule a source name follows in Origin (see docs/sources.md#your-own-sources-event-lines). */
const SOURCE_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** Built-in sources and reserved words, which Origin refuses as the name of a source of one's own. */
const NOT_A_SOURCE = [
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'zcode',
  'origin',
  'hub',
  'local',
  'all',
  'devices',
];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const KEYS = [
  'source',
  'dir',
  'hub',
  'token',
  'tokenEnv',
  'agents',
  'triggers',
  'projectBy',
  'project',
  'includeTools',
  'reconcileOnEnd',
  'spoolDir',
  'timeoutMs',
];
export const DEFAULT_TIMEOUT_MS = 5000;

/** Whether `name` can name a source of one's own in Origin. */
export function isSourceName(name: string): boolean {
  return SOURCE_RE.test(name) && !NOT_A_SOURCE.includes(name);
}

class ConfigError extends Error {}
const fail = (message: string): never => {
  throw new ConfigError(message);
};

/** Check the plugin's config and fill in its defaults. */
export function parseConfig(raw: unknown, ctx: ConfigEnv): ConfigResult {
  try {
    return { ok: true, config: parse(raw ?? {}, ctx) };
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, error: err.message };
    throw err;
  }
}

function parse(raw: unknown, ctx: ConfigEnv): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    fail('config must be an object');
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0)
    fail(`unknown config ${plural(unknown.length, 'key')} ${unknown.join(', ')}`);

  const source = optionalString(obj, 'source') ?? 'openclaw';
  if (!isSourceName(source)) {
    fail(
      `"source" ${JSON.stringify(source)} cannot name a source in Origin: 2 to 32 lowercase letters, digits, and hyphens, starting with a letter, other than ${NOT_A_SOURCE.join(', ')}`,
    );
  }

  const dir = optionalString(obj, 'dir');
  const hub = optionalString(obj, 'hub');
  const tokenEnv = optionalString(obj, 'tokenEnv');
  const tokenValue = obj.token;
  if (dir && hub) fail('set "dir" or "hub", not both');
  if (!dir && !hub) {
    fail('set "dir", a directory an Origin device reads, or "hub", the URL of your Origin hub');
  }
  let target: Config['target'];
  if (dir) {
    if (tokenValue !== undefined || tokenEnv)
      fail('"token" and "tokenEnv" go with "hub", not "dir"');
    target = { kind: 'dir', dir: resolveUserPath(dir, ctx) };
  } else {
    target = {
      kind: 'hub',
      url: hubUrl(hub as string),
      token: hubToken(tokenValue, tokenEnv, ctx.env),
    };
  }

  const projectBy = optionalString(obj, 'projectBy') ?? 'agent';
  if (projectBy !== 'agent' && projectBy !== 'channel')
    fail('"projectBy" must be agent or channel');
  const project = optionalString(obj, 'project');
  if (project !== null && (project.length > 200 || CONTROL_RE.test(project))) {
    fail('"project" must have at most 200 characters and no control characters');
  }

  const timeoutMs = obj.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    fail('"timeoutMs" must be a whole number of milliseconds from 100 to 60000');
  }
  const spoolDir = optionalString(obj, 'spoolDir');

  return {
    source,
    target,
    projectBy: projectBy as Config['projectBy'],
    project,
    includeTools: optionalBoolean(obj, 'includeTools') ?? true,
    reconcileOnEnd: optionalBoolean(obj, 'reconcileOnEnd') ?? false,
    agents: optionalList(obj, 'agents'),
    triggers: optionalList(obj, 'triggers') ?? ['user'],
    stateDir: spoolDir ? resolveUserPath(spoolDir, ctx) : ctx.defaultStateDir,
    timeoutMs: timeoutMs as number,
  };
}

/** The hub's base URL: http or https, without credentials, query, or fragment. */
function hubUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`"hub" ${JSON.stringify(value)} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    fail('"hub" must be an http or https URL');
  if (url.username || url.password)
    fail('"hub" must not hold credentials; set "token" or "tokenEnv"');
  if (url.search || url.hash) fail('"hub" must not have a query or a fragment');
  return url.href.replace(/\/+$/, '');
}

/**
 * The hub token: `token` as the Gateway resolved it (a string, or a SecretRef the Gateway resolved
 * to one), or the value of the environment variable `tokenEnv` names.
 */
function hubToken(value: unknown, envName: string | null, env: NodeJS.ProcessEnv): string {
  if (value !== undefined && value !== null && envName) fail('set "token" or "tokenEnv", not both');
  if (envName) {
    if (!ENV_NAME_RE.test(envName)) fail('"tokenEnv" must be the name of an environment variable');
    const token = env[envName]?.trim();
    if (!token) fail(`the environment variable ${envName} that "tokenEnv" names is not set`);
    return token as string;
  }
  if (value === undefined || value === null) {
    fail('set "token" (a SecretRef, best) or "tokenEnv" for the hub');
  }
  if (typeof value !== 'string') {
    // A SecretRef the Gateway could not resolve stays an object.
    fail('"token" is not a string: the Gateway did not resolve its SecretRef');
  }
  const token = (value as string).trim();
  if (!token) fail('"token" is empty');
  return token;
}

function resolveUserPath(input: string, ctx: ConfigEnv): string {
  if (ctx.resolvePath) {
    try {
      return path.resolve(ctx.resolvePath(input));
    } catch {
      // fall through to our own resolution
    }
  }
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\'))
    return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

function optionalString(obj: Record<string, unknown>, name: string): string | null {
  const v = obj[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return fail(`"${name}" must be a string`);
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalBoolean(obj: Record<string, unknown>, name: string): boolean | null {
  const v = obj[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') return fail(`"${name}" must be true or false`);
  return v;
}

function optionalList(obj: Record<string, unknown>, name: string): string[] | null {
  const v = obj[name];
  if (v === undefined || v === null) return null;
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    !v.every((s) => typeof s === 'string' && s.trim().length > 0)
  ) {
    return fail(`"${name}" must be a list of one or more names`);
  }
  return [...new Set((v as string[]).map((s) => s.trim()))];
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
