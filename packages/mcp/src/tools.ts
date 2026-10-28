import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ENTRY_KINDS } from '@openlinkos/origin-core';
import { z } from 'zod';

/** Guidance sent to agents in the MCP `initialize` response. */
export const INSTRUCTIONS = `Origin is the user's local, cross-agent memory: an append-only archive of their sessions with AI coding agents, plus durable entries — memory (what happened), knowledge (stable facts), and cognition (the user's preferences, methods, goals, and boundaries).

- When you start a task, call \`brief\` with your working directory, unless a note headed \`Origin recall\` already gave you one: it lists the user's preferences, the project's latest decisions and facts, and its latest sessions, one line each. Use \`get\` on the ids that matter.
- To answer questions about past work, decisions, or reasons, use \`search\` and \`timeline\`, then \`get\` or \`sources\` to read the original text. Cite entry and event ids.
- When you learn something that will matter in future sessions — a decision and its reason, a stable fact, a preference of the user — save it with \`remember\`, citing the events it comes from: event ids from search/timeline, or an exact quote from this conversation.
- Entries marked \`imported\` mirror an agent's own memory files (such as Claude Code's memory directory); a later version of the file supersedes a correction made here. Entries whose validity has ended are left out of search unless you ask for one by id.
- If an entry is wrong or outdated, use \`correct\`. Use \`forget\` only when the user explicitly asks, and pass their reason: it hides the entry or event from every query on every store and is kept as a record; only the user can restore it, from the Origin CLI or admin UI.
- Time arguments accept relative values (30m, 24h, 7d, 2w) or dates (YYYY-MM-DD).`;

const time = z
  .string()
  .optional()
  .describe('Relative (30m, 24h, 7d, 2w) or absolute (YYYY-MM-DD, ISO 8601) time');

const sourceInput = z
  .object({
    event_id: z.string().optional().describe('Id of the event to cite'),
    quote: z
      .string()
      .optional()
      .describe('Exact text from the event; alone, it finds the most recent message containing it'),
  })
  .describe('An event id, an exact quote, or both');

interface ToolSpec {
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** The eight tools, defined once and shared by the local servers and the forwarding proxy. */
export const TOOL_SPECS = {
  brief: {
    title: 'Brief',
    description:
      "What the user's memory holds for where you work, one line per item: their preferences and boundaries, the project's latest decisions and facts, and its latest sessions with any agent; with `about`, also the entries that match it. Call it when you start a task, unless you were already given an Origin recall.",
    inputSchema: {
      cwd: z
        .string()
        .optional()
        .describe("Your working directory (default: the directory Origin's server runs in)"),
      about: z.string().optional().describe("What the task is about, in the user's words"),
    },
    annotations: readOnly,
  },
  search: {
    title: 'Search memory',
    description:
      'Full-text search over entries and archived session events, best match first. Without a query, lists the most recent entries.',
    inputSchema: {
      query: z.string().optional().describe('Words or phrases to find (any language)'),
      scope: z.enum(['all', 'entries', 'events']).default('all'),
      kind: z.enum(ENTRY_KINDS).optional().describe('Only entries of this kind'),
      since: time,
      until: time,
      source: z.string().optional().describe('Agent id, e.g. claude-code'),
      project: z.string().optional(),
      include_tools: z.boolean().default(false).describe('Also match tool calls and tool results'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  },
  timeline: {
    title: 'Timeline',
    description:
      'Sessions in a time range (newest first), each with its title or, when it has none, its first prompt; or the events of one session in order when `session` is given.',
    inputSchema: {
      since: time.describe('Start of the range (default 7d)'),
      until: time,
      source: z.string().optional(),
      project: z.string().optional(),
      session: z.string().optional().describe('Session id: list its events instead'),
      include_tools: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: readOnly,
  },
  get: {
    title: 'Get entry or event',
    description:
      'Fetch an entry (with its sources and version history) or an event (full text) by id.',
    inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
    annotations: readOnly,
  },
  sources: {
    title: 'Original sources',
    description:
      'Expand an entry or event to the original log lines it comes from, with file paths and line numbers.',
    inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
    annotations: readOnly,
  },
  remember: {
    title: 'Remember',
    description:
      'Save a durable entry that cites the events it comes from. memory = what happened (a decision and why); knowledge = a stable fact; cognition = the user’s preferences, methods, goals, or boundaries.',
    inputSchema: {
      kind: z.enum(ENTRY_KINDS),
      text: z.string().min(1).describe('One self-contained statement'),
      sources: z.array(sourceInput).min(1),
      confidence: z.number().min(0).max(1).describe('How sure you are, 0–1'),
      project: z.string().optional().describe('Project the entry belongs to, if any'),
      valid_from: time,
      valid_to: time,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  correct: {
    title: 'Correct an entry',
    description:
      'Replace an entry with a corrected version. The old version is kept as history and no longer returned; its sources carry over.',
    inputSchema: {
      id: z.string().describe('Entry id (ent_…)'),
      text: z.string().min(1),
      kind: z.enum(ENTRY_KINDS).optional(),
      confidence: z.number().min(0).max(1).optional(),
      sources: z.array(sourceInput).optional().describe('Additional sources'),
      valid_from: time,
      valid_to: time,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  forget: {
    title: 'Forget',
    description:
      'Hide an entry (every version, and the events it cites) or an event (and every entry that cites it) from every query, on every store. Only on the user’s explicit request, with their reason. The forget is kept as a record with its reason; the user can restore it later from the Origin CLI or admin UI, and agents cannot.',
    inputSchema: {
      id: z.string().describe('Entry id (ent_…) or event id (source:…)'),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe('Why the user wants it forgotten (required; kept with the record)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
} satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_SPECS;

export const TOOL_NAMES = Object.keys(TOOL_SPECS) as ToolName[];

/** Validated arguments of a tool, after defaults are applied. */
export type ToolArgs<N extends ToolName> = z.output<
  z.ZodObject<(typeof TOOL_SPECS)[N]['inputSchema']>
>;

export type ToolHandlers = { [N in ToolName]: (args: ToolArgs<N>) => Promise<CallToolResult> };

export function registerOriginTools(mcp: McpServer, handlers: ToolHandlers): void {
  for (const name of TOOL_NAMES) {
    const handler = handlers[name] as (args: unknown) => Promise<CallToolResult>;
    mcp.registerTool(
      name,
      TOOL_SPECS[name] as ToolSpec,
      ((args: unknown) => handler(args)) as never,
    );
  }
}

export function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Coalesce refreshes: at most one in flight, and reads skip it when the last one finished less
 * than `intervalMs` ago, even while another (a background one) is running. A read that needs a
 * refresh shares the one in flight. A forced refresh (after or before a write) asked for while one
 * is in flight runs once more after it, so that it covers what was just written; forced requests
 * that arrive meanwhile share that run. Failures are logged, never thrown.
 */
export function refreshGate(
  fn: (() => Promise<void>) | undefined,
  intervalMs: number,
  log?: (message: string) => void,
  label = 'sync',
): (force?: boolean) => Promise<void> {
  let last = 0;
  let inflight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const run = (): Promise<void> => {
    queued = null;
    const current = (fn as () => Promise<void>)()
      .catch((err: unknown) => log?.(`${label} failed: ${(err as Error).message}`))
      .finally(() => {
        last = Date.now();
        if (inflight === current) inflight = null;
      });
    inflight = current;
    return current;
  };
  return async (force = false) => {
    if (!fn) return;
    if (!force && Date.now() - last < intervalMs) return;
    if (inflight) {
      if (!force) return inflight;
      queued ??= inflight.then(run);
      return queued;
    }
    return run();
  };
}

/** How often a server looks for new log lines while it runs (ORIGIN_WATCH_INTERVAL_MS). */
export const WATCH_INTERVAL_MS = 60_000;
/** How long a server waits for its last sync when the agent disconnects. */
export const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Run `tick` every `intervalMs` in the background, one at a time (the next is scheduled once the
 * last has finished), until the returned function is called. `tick` refreshes through the refresh
 * gates, so it never overlaps another refresh, and tool calls never wait for the timer. Failures
 * are logged, never thrown. An interval of 0 or less runs nothing.
 */
export function startWatch(
  intervalMs: number,
  tick: () => Promise<void>,
  log?: (message: string) => void,
): () => void {
  if (!(intervalMs > 0)) return () => {};
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      tick()
        .catch((err: unknown) => log?.(`background sync failed: ${(err as Error).message}`))
        .finally(() => {
          if (!stopped) schedule();
        });
    }, intervalMs);
    // The transport keeps the process alive, not the timer.
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

class Timeout extends Error {}

/** Settle with `promise`, or reject with a Timeout after `ms`. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), Math.max(0, ms));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Timeout;
}

/** Wait for `promise` at most until `deadline`; never throws. */
export async function upTo(promise: Promise<unknown>, deadline: number): Promise<void> {
  try {
    await within(promise, deadline - Date.now());
  } catch {
    // slower than the deadline, or failed: it keeps running, or was logged, by its owner
  }
}

/**
 * Call `close` once the agent is gone: when standard input ends, or on a termination signal (a
 * second signal ends the process as usual).
 */
export function onDisconnect(close: () => void): void {
  process.stdin.once('end', close);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, close);
}
