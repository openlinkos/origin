import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Config, isSourceName, parseConfig } from './config.js';
import { DirSink, HubSink, type Sink } from './delivery.js';
import { asRecord, speakerName, str } from './lines.js';
import { type Log, pluginLog } from './log.js';
import { Recorder, type TurnSource } from './recorder.js';
import type { HookHandler, PluginApi, PluginDefinition } from './types.js';

/**
 * Origin's plugin for OpenClaw (docs/guide/openclaw.md): it writes the sessions of a Gateway's
 * agents to Origin as event lines, into a directory an Origin device on the same host reads, or to
 * an Origin hub. It depends on nothing but Node: OpenClaw loads its default export.
 */

export const PLUGIN_ID = 'origin';

export interface RegisterOptions {
  /** Replaces the sink the config names, for tests. */
  sink?: Sink;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Register the plugin's hooks, and return its recorder; null when it records nothing: a load that
 * is not the Gateway's own (`registrationMode` other than `full`), or a config that is not valid,
 * which it says once.
 */
export function registerOrigin(api: PluginApi, opts: RegisterOptions = {}): Recorder | null {
  if (api.registrationMode !== undefined && api.registrationMode !== 'full') return null;
  const log = pluginLog(api.logger);
  const env = opts.env ?? process.env;
  const parsed = parseConfig(api.pluginConfig, {
    env,
    resolvePath: typeof api.resolvePath === 'function' ? api.resolvePath.bind(api) : undefined,
    defaultStateDir: path.join(openclawStateDir(api, env), 'origin-openclaw'),
  });
  if (!parsed.ok) {
    log.error(`not recording: ${parsed.error} (plugins.entries.${api.id ?? PLUGIN_ID}.config)`);
    return null;
  }
  const config = parsed.config;
  const turns: TurnSource = hasConversationAccess(api.config, api.id ?? PLUGIN_ID)
    ? 'agent_end'
    : 'messages';
  const recorder = new Recorder({
    config,
    sink: opts.sink ?? sinkFor(config, api, log),
    log,
    turns,
    agentNames: agentNames(api.config),
    now: opts.now,
  });

  const on = (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
    hook(api, log, name, handler);
  on('gateway_start', () => recorder.gatewayStart());
  on('gateway_stop', () => recorder.gatewayStop());
  if (turns === 'agent_end') {
    on('agent_end', (e, c) => recorder.agentEnd(e, c));
    on('before_compaction', (e, c) => recorder.beforeCompaction(e, c));
  }
  on('message_received', (e, c) => recorder.messageReceived(e, c));
  on('message_sent', (e, c) => recorder.messageSent(e, c));
  if (config.includeTools) on('after_tool_call', (e, c) => recorder.afterToolCall(e, c));
  on('session_end', (e, c) => recorder.sessionEnd(e, c));

  const who = config.agents ? `agents ${config.agents.join(', ')}` : 'every agent';
  const where =
    config.target.kind === 'hub'
      ? `to ${config.target.url} as source ${config.source}`
      : `into ${config.target.dir}`;
  if (config.target.kind === 'dir' && !isSourceName(path.basename(config.target.dir))) {
    log.warn(
      `Origin reads a directory under sources/ as the source named after it, and ignores ${path.basename(config.target.dir)}: name it as a source, such as openclaw`,
    );
  }
  log.info(
    `recording ${who} (${config.triggers.join(', ')} runs) ${where}, ${
      turns === 'agent_end'
        ? 'from agent_end'
        : 'from the message hooks (no conversation access: set hooks.allowConversationAccess for agent_end)'
    }`,
  );
  return recorder;
}

/** Register a hook whose handler never throws into OpenClaw; errors are logged. */
function hook(
  api: PluginApi,
  log: Log,
  name: string,
  handler: (event: unknown, ctx: unknown) => unknown,
) {
  const safe: HookHandler = (event, ctx) => {
    try {
      const r = handler(event, ctx);
      if (r instanceof Promise) {
        return r.catch((err) => log.error(`${name} failed: ${(err as Error)?.message ?? err}`));
      }
      return undefined;
    } catch (err) {
      log.error(`${name} failed: ${(err as Error)?.message ?? err}`);
      return undefined;
    }
  };
  try {
    api.on(name, safe);
  } catch (err) {
    log.warn(`could not register ${name}: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Whether the Gateway lets this plugin read conversations (`agent_end`), by the rule OpenClaw
 * applies to a plugin that is not bundled with it: `plugins.entries.<id>.hooks.allowConversationAccess`
 * set to true. Without it, OpenClaw refuses the plugin's `agent_end` and the turn is assembled from
 * the message hooks.
 */
export function hasConversationAccess(config: unknown, id: string): boolean {
  const entries = asRecord(asRecord(asRecord(config)?.plugins)?.entries);
  if (!entries) return false;
  const key =
    Object.keys(entries).find((k) => k === id) ??
    Object.keys(entries).find((k) => k.toLowerCase() === id.toLowerCase());
  const entry = key ? asRecord(entries[key]) : null;
  return asRecord(entry?.hooks)?.allowConversationAccess === true;
}

/**
 * The names of the Gateway's agents, by id in lowercase as session keys hold it, from its config as
 * OpenClaw lists them: `agents.entries`, keyed by id, or else `agents.list`; each named by its
 * `name`, or its `identity.name`. An agent without a name is left out.
 */
export function agentNames(config: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const agents = asRecord(asRecord(config)?.agents);
  const add = (id: unknown, entry: unknown) => {
    const e = asRecord(entry);
    const key = str(id)?.toLowerCase();
    const name = speakerName(e?.name) ?? speakerName(asRecord(e?.identity)?.name);
    if (key && name && !names.has(key)) names.set(key, name);
  };
  if (agents?.entries !== undefined) {
    for (const [id, entry] of Object.entries(asRecord(agents.entries) ?? {})) add(id, entry);
  } else if (Array.isArray(agents?.list)) {
    for (const entry of agents.list) add(asRecord(entry)?.id, entry);
  }
  return names;
}

function sinkFor(config: Config, api: PluginApi, log: Log): Sink {
  if (config.target.kind === 'hub') {
    if (config.target.url.startsWith('http:') && !isLoopback(config.target.url)) {
      log.warn(
        `${config.target.url} is plain http: the token and the lines cross the network unencrypted`,
      );
    }
    return new HubSink(
      config.target.url,
      config.source,
      config.target.token,
      config.timeoutMs,
      log,
    );
  }
  return new DirSink(config.target.dir, versionLine(api));
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** OpenClaw's state directory, where the plugin keeps its own under `origin-openclaw/`. */
function openclawStateDir(api: PluginApi, env: NodeJS.ProcessEnv): string {
  try {
    const dir = api.runtime?.state?.resolveStateDir?.(env);
    if (typeof dir === 'string' && dir.length > 0) return dir;
  } catch {
    // an older host, or a load without the runtime
  }
  return env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
}

/** The VERSION line of a source directory: OpenClaw's version and the plugin's. */
function versionLine(api: PluginApi): string | null {
  let host: string | undefined;
  try {
    host = api.runtime?.version;
  } catch {
    host = undefined;
  }
  const own = packageVersion();
  if (!host && !own) return null;
  return [host ? `OpenClaw ${host}` : 'OpenClaw', own ? `(origin-openclaw ${own})` : null]
    .filter(Boolean)
    .join(' ');
}

function packageVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

const plugin: PluginDefinition = {
  id: PLUGIN_ID,
  name: 'Origin',
  description:
    "Writes this Gateway's agent sessions to Origin, a cross-agent personal memory, as event lines.",
  register(api: PluginApi): void {
    registerOrigin(api);
  },
};

export default plugin;
