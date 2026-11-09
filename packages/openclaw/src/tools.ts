import { type Config, projectOf, type ToolsMode } from './config.js';
import { callHubTool, TOOL_TIMEOUT_MS } from './hub-mcp.js';
import { agentOfSessionKey, asRecord, str } from './lines.js';
import type { Log } from './log.js';
import type { AgentTool, AgentToolResult, PluginApi } from './types.js';

/**
 * Origin's read tools for OpenClaw's agents: `origin_brief`, `origin_search`, `origin_get`,
 * `origin_timeline`, and `origin_digest`, each a call of the hub's MCP tool of the same name (see
 * docs/guide/openclaw.md#read-origin-from-your-agents), with the hub and the token the plugin
 * delivers with, offered only in the owner's turns (offeredIn). Their parameters are those of the
 * MCP tools, as Origin's MCP server publishes them
 * (packages/cli/test/openclaw-tools.test.ts keeps them the same), except that `origin_brief` has no
 * `cwd`: it briefs on the project the plugin files the agent's sessions under, unless the agent
 * names another.
 */

export interface OriginTool {
  name: string;
  /** The hub's MCP tool it calls. */
  mcp: 'brief' | 'search' | 'get' | 'timeline' | 'digest';
  label: string;
  description: string;
  /** A JSON Schema of an object. */
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TIME = 'Relative (30m, 24h, 7d, 2w) or absolute (YYYY-MM-DD, ISO 8601) time';
const OPEN = 'Open any id it returns with `origin_get`.';

export const ORIGIN_TOOLS: readonly OriginTool[] = [
  {
    name: 'origin_brief',
    mcp: 'brief',
    label: 'Origin brief',
    description: `What the user's memory in Origin holds for your project, one line per item: their preferences and boundaries, the project's latest decisions and facts, and its latest sessions with any agent; with \`about\`, also the entries and past messages that match it. Call it when you start a task that may build on earlier work, and before you answer a question about past work, decisions, or the user's preferences. ${OPEN}`,
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'The project to brief on, by name (default: the project your sessions are filed under in Origin, usually your agent id)',
        },
        about: { type: 'string', description: "What the task is about, in the user's words" },
      },
    },
  },
  {
    name: 'origin_search',
    mcp: 'search',
    label: 'Origin search',
    description: `Full-text search over the entries and archived session events of the user's memory in Origin, best match first. Each hit has its text cut to 400 characters, a \`snippet\` around the match, and \`total_chars\`; \`origin_get\` reads the whole. \`more\` says whether the limit left entries or events out. A hit on a child session includes \`parent\` (\`source:id\`) and \`parent_title\`. Without a query, lists the most recent entries. ${OPEN}`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or phrases to find (any language)' },
        scope: { type: 'string', enum: ['all', 'entries', 'events'], default: 'all' },
        kind: {
          type: 'string',
          enum: ['memory', 'knowledge', 'cognition'],
          description: 'Only entries of this kind',
        },
        since: { type: 'string', description: TIME },
        until: { type: 'string', description: TIME },
        source: { type: 'string', description: 'Agent id, e.g. claude-code' },
        project: { type: 'string' },
        include_tools: {
          type: 'boolean',
          default: false,
          description: 'Also match tool calls and tool results',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
  {
    name: 'origin_get',
    mcp: 'get',
    label: 'Origin get',
    description:
      'Open any id Origin hands you, with what is next to it, one line each by id: an entry (sources, version history, related entries), an event (its text, session, turn, the events around it, and the entries citing it), a session (its turns, its thread, the entries written from it, its recalls, the sessions before and after it, its parent when it is a child, and its children grouped by run when it is a parent), a thread (its sessions, agents, branches, the entries written from it, and its last prompt), a recall (what it handed over), or a proposal (its fields, status, sources, session, and the entry it became once accepted). Follow the ids that matter rather than reading everything.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Entry (ent_…), event (source:…), session, thread (thr_…), recall (rcl_…), or proposal (prp_…) id',
        },
        source: {
          type: 'string',
          description: 'For a session id: its source, when sessions of two sources have that id',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: "For an event: where to start reading its text (a page's next_offset)",
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'origin_timeline',
    mcp: 'timeline',
    label: 'Origin timeline',
    description: `Sessions in the user's memory in Origin in a time range (newest first), top-level ones unless \`include_children\` is set: no parent, and not a child session that names none. Each row has its title (a workflow step is shown as \`{run name} · actor#N@M\` when its stored title has that token), or its first prompt, plus \`children\` (how many) and \`workflows\` (their run names). With \`session\`, the events of one session in order, a page at a time: \`turn\` reads one turn, \`after\` goes on after the last event of a page, and \`more\` says how many follow. ${OPEN}`,
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start of the range (default 7d)' },
        until: { type: 'string', description: TIME },
        source: { type: 'string' },
        project: { type: 'string' },
        session: { type: 'string', description: 'Session id: list its events instead' },
        turn: {
          type: 'integer',
          minimum: 0,
          description:
            'With session: only this turn (1 for the first prompt; 0 for what came before it)',
        },
        after: {
          type: 'string',
          description: 'With session: continue after this event id, the last of the previous page',
        },
        include_tools: { type: 'boolean', default: false },
        include_children: {
          type: 'boolean',
          default: false,
          description:
            'Also list child sessions. By default a timeline lists top-level sessions only',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
  },
  {
    name: 'origin_digest',
    mcp: 'digest',
    label: 'Origin digest',
    description:
      "What happened on one calendar day, from the user's memory in Origin alone: totals, by project and by agent; the top-level sessions active that day, most recent first, each with its `id` for `origin_get`, the user's prompts that day, the tools called, and the files its edit calls changed (a child session's activity is folded into its parent's, in the fields `children_included_in` names); the entries written that day (corrections included), the entries proposed, and the forgets made (by id only). Use it to recap a day's work.",
    parameters: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'The day, YYYY-MM-DD (default: today)',
        },
        time_zone: {
          type: 'string',
          description:
            "The IANA time zone the day is in, e.g. Europe/Berlin (default: the server's own)",
        },
        project: {
          type: 'string',
          description: 'Only sessions, entries, and proposals of this project',
        },
        source: { type: 'string', description: 'Only sessions of this agent, e.g. claude-code' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 50,
          description: 'Most sessions listed, and most entries, proposals, and forgets',
        },
      },
    },
  },
];

export const TOOL_NAMES: readonly string[] = ORIGIN_TOOLS.map((t) => t.name);

export interface ToolsOptions {
  /** The hub token at the time of a call: null while there is none (see liveToken in index.ts). */
  token: () => string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Called when OpenClaw asks for a tool with a context lacking version 2's guard (originTool). */
  onUnguardedContext?: () => void;
}

/**
 * The first OpenClaw whose plugin tools get a version 2 tool context, with the turn's sender, its
 * guards, and its memory audience (ToolContextV2).
 */
export const TOOL_CONTEXT_VERSION = '2026.10.6';

/**
 * Register the read tools with OpenClaw, each as a versioned factory (`contextVersion: 2`) that
 * OpenClaw calls with a run's tool context: the tool is offered only in the owner's turns, as
 * `tools` says (offeredIn). Returns the names registered; none when the config gives the agents no
 * tools (no hub, or `tools` set to off), or when the host cannot register them or is older than
 * TOOL_CONTEXT_VERSION (said once, in `log`). The tools are never offered without that gate.
 */
export function registerTools(
  api: PluginApi,
  config: Config,
  opts: ToolsOptions,
  log?: Log,
): string[] {
  if (config.tools === 'off' || config.target.kind !== 'hub') return [];
  if (typeof api.registerTool !== 'function') {
    log?.warn('this OpenClaw cannot register tools: its agents get no Origin tools');
    return [];
  }
  const host = hostVersion(api);
  if (host && olderThan(host, TOOL_CONTEXT_VERSION)) {
    log?.warn(
      `the read tools need OpenClaw ${TOOL_CONTEXT_VERSION} or later, and this one is ${host}: its agents get no Origin tools`,
    );
    return [];
  }
  let said = false;
  const own: ToolsOptions = {
    ...opts,
    onUnguardedContext: () => {
      if (said) return;
      said = true;
      log?.warn(
        "the read tools need OpenClaw's invocation guard, and this OpenClaw built a tool without it: its agents get no Origin tools",
      );
    },
  };
  const registered: string[] = [];
  for (const spec of ORIGIN_TOOLS) {
    try {
      api.registerTool(
        { contextVersion: 2, create: (context: unknown) => originTool(spec, config, context, own) },
        { name: spec.name },
      );
      registered.push(spec.name);
    } catch (err) {
      log?.warn(`could not register ${spec.name}: ${(err as Error)?.message ?? err}`);
    }
  }
  return registered;
}

/**
 * The tool for the turn whose version 2 tool context is `context` (ToolContextV2), or null: offered
 * only in the owner's turns, as `tools` says (offeredIn). A context without
 * `assertInvocationCurrent` is not version 2's: no tool. Nor for an agent the plugin does not record
 * (`agents`). The guards, the invocation's and, when the turn has a memory audience, the
 * audience's, are called right before the call to the hub, which records a brief's recall, and
 * again right after it, before anything the hub answered is released: if either throws, the tool's
 * error says so, without the hub's answer.
 */
export function originTool(
  spec: OriginTool,
  config: Config,
  context: unknown,
  opts: ToolsOptions,
): AgentTool | null {
  if (config.target.kind !== 'hub' || config.tools === 'off') return null;
  const c = asRecord(context);
  if (!c) return null;
  const invocationCurrent = c.assertInvocationCurrent;
  if (typeof invocationCurrent !== 'function') {
    opts.onUnguardedContext?.();
    return null;
  }
  if (!offeredIn(config.tools, c)) return null;
  const audience = asRecord(c.memoryAudience);
  const audienceCurrent = c.assertMemoryAudienceCurrent;
  const assertCurrent = (): void => {
    try {
      invocationCurrent.call(c);
      if (typeof audienceCurrent === 'function') audienceCurrent.call(c);
    } catch (err) {
      throw new Error(
        `this turn may no longer read the owner's memory in Origin: ${(err as Error)?.message ?? err}`,
      );
    }
  };
  const sessionKey = str(c.sessionKey);
  const agentId =
    str(audience?.agentId) ?? str(c.agentId) ?? (sessionKey ? agentOfSessionKey(sessionKey) : null);
  if (config.agents && !(agentId && config.agents.includes(agentId))) return null;
  const channel =
    str(c.messageChannel) ?? str(c.channel) ?? str(c.messageProvider) ?? str(c.channelId);
  const project = projectOf(config, agentId, channel);
  const { url } = config.target;
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult> => {
      const args = argsFor(spec, asRecord(params) ?? {}, project);
      assertCurrent();
      const answer = await callHubTool({
        url,
        token: opts.token(),
        client: config.source,
        name: spec.mcp,
        args,
        timeoutMs: opts.timeoutMs ?? TOOL_TIMEOUT_MS,
        signal,
        fetchImpl: opts.fetchImpl,
      });
      assertCurrent();
      if (!answer.ok) throw new Error(answer.error);
      return {
        content: answer.texts.map((text) => ({ type: 'text', text })),
        details: { ok: true },
      };
    },
  };
}

/**
 * Whether the read tools are offered in the turn whose version 2 tool context is `c`, by `mode`
 * (Config.tools). Origin's archive is the owner's, kept raw, so they are offered only in the
 * owner's turns, by what OpenClaw says of the turn, never by what the model says:
 *
 * - In a turn OpenClaw resolved as the owner's private memory audience (`owner-private`), with
 *   either mode. OpenClaw 2026.10.6 resolves an audience only when its memory slot is a native
 *   provider, and the owner's private one only in a direct chat.
 * - With `owner-turns`, also in any turn the owner started, in a direct chat, a group, a channel,
 *   or a thread: OpenClaw names the sender of the message the turn answers (`requesterSenderId`)
 *   and takes that sender for its owner (`senderIsOwner`, by `commands.ownerAllowFrom`). A memory
 *   audience it resolved for such a turn must be bound to the turn's own session. A turn nobody
 *   sent, such as a heartbeat or an `openclaw agent` run, has no sender; a cron run, someone else's
 *   turn, and a batch of queued messages from several senders are not the owner's.
 *
 * Anything else, a field missing or of another type included, offers no tools.
 */
export function offeredIn(mode: ToolsMode, c: Record<string, unknown>): boolean {
  if (mode === 'off') return false;
  const audience = c.memoryAudience;
  if (asRecord(audience)?.kind === 'owner-private') return true;
  if (mode !== 'owner-turns') return false;
  if (c.senderIsOwner !== true || str(c.requesterSenderId) === null) return false;
  if (audience === undefined || audience === null) return true;
  const sessionKey = str(c.sessionKey);
  return sessionKey !== null && str(asRecord(audience)?.sessionKey) === sessionKey;
}

/** OpenClaw's version (`api.runtime.version`), or null when the host does not say. */
function hostVersion(api: PluginApi): string | null {
  try {
    return str(api.runtime?.version);
  } catch {
    return null;
  }
}

/**
 * Whether OpenClaw's version `version` (`2026.10.6`, `2026.10.6-beta.1`) is older than `floor`, by
 * year, month, and day; false for one it cannot read, whose tools are gated all the same.
 */
export function olderThan(version: string, floor: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(floor);
  if (!a || !b) return false;
  for (const [i, n] of a.entries()) {
    const m = b[i] ?? 0;
    if (n !== m) return n < m;
  }
  return false;
}

/**
 * The arguments the hub's tool gets: the agent's as they are, except that a brief is for the
 * project the agent names, or else the one its sessions are filed under, and takes nothing else.
 */
function argsFor(
  spec: OriginTool,
  params: Record<string, unknown>,
  project: string | null,
): Record<string, unknown> {
  if (spec.mcp !== 'brief') return params;
  const named = str(params.project) ?? project;
  if (!named) {
    throw new Error(
      'pass `project`, the project to brief on: this run does not say which agent it is',
    );
  }
  const about = str(params.about);
  return about ? { project: named, about } : { project: named };
}
