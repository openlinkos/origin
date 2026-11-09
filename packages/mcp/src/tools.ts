import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ENTRY_KINDS, StoreUpgradedError } from '@openlinkos/origin-core';
import { z } from 'zod';

/** Guidance sent to agents in the MCP `initialize` response. */
export const INSTRUCTIONS = `Origin is the user's local, cross-agent memory: an append-only archive of their sessions with AI coding agents, plus durable entries — memory (what happened), knowledge (stable facts), and cognition (the user's preferences, methods, goals, and boundaries).

- When you start a task, call \`brief\` with your working directory (or, if you work in none, the \`project\` you work for), unless a note headed \`Origin recall\` already gave you one: it lists the user's preferences, the project's latest decisions and facts, and its latest sessions, one line each. Use \`get\` on the ids that matter.
- To answer questions about past work, decisions, or reasons, use \`search\` and \`timeline\`, then \`get\` or \`sources\` to read the original text. \`get\` opens any id Origin gives you (an entry, an event, a session, a thread, a recall, or a proposal) and lists what is next to it, one line each with its id: follow the ids that matter rather than reading everything. Read a long session a turn at a time with \`timeline\` (\`session\`, \`turn\`, \`after\`). Cite entry and event ids.
- When the user continues work from an earlier session that the brief, a timeline, or a search showed you, call \`follow\` once with its id (or its thread's), so that the sessions form one thread. To learn what changed since you last looked, call \`changes\` with the \`next\` of your last call; to recap the work of one day, call \`digest\`.
- When you learn something that will matter in future sessions — a decision and its reason, a stable fact, a preference of the user — save it, citing the events it comes from: event ids from search/timeline, or an exact quote from this conversation. \`remember\` what the user said or decided; \`propose\` what you infer and they have not confirmed, and whatever you write when consolidating their memory on their behalf. A proposal waits for the user: only they accept or reject it, in the Origin admin UI or CLI.
- A message marked with \`by\` (\`person\`, \`agent\`, or \`system\`, with its \`speaker\` when known) was not written by the user: what it says is not the user's preference.
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

/** The twelve tools, defined once and shared by the local servers and the forwarding proxy. */
export const TOOL_SPECS = {
  brief: {
    title: 'Brief',
    description:
      "What the user's memory holds for where you work, one line per item: their preferences and boundaries, the project's latest decisions and facts, and its latest sessions with any agent (a parent line adds its child count and workflow names); with `about`, also the entries that match it and the past messages of the project's sessions that match it, each with its event id. Call it when you start a task, unless you were already given an Origin recall. Pass `cwd`, or `project` when you work in no directory.",
    inputSchema: {
      cwd: z
        .string()
        .optional()
        .describe(
          "Your working directory (default: the directory Origin's server runs in, unless `project` is given)",
        ),
      project: z
        .string()
        .optional()
        .describe(
          "The project to brief on, by name, when you work in no directory (an OpenClaw agent passes its agent id); with `cwd` too, the project's name instead of the directory's",
        ),
      about: z.string().optional().describe("What the task is about, in the user's words"),
    },
    annotations: readOnly,
  },
  search: {
    title: 'Search memory',
    description:
      'Full-text search over entries and archived session events, best match first. Each hit has its text cut to 400 characters, a `snippet` around the match, and `total_chars`; `get` reads the whole. `more` says whether the limit left entries or events out. A hit on a child session includes `parent` (`source:id`) and `parent_title`. Without a query, lists the most recent entries.',
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
      'Sessions in a time range (newest first), top-level ones unless `include_children` is set: no parent, and not a child session that names none. Each row has its title (a workflow step is shown as `{run name} · actor#N@M` when its stored title has that token), or its first prompt, plus `children` (how many) and `workflows` (their run names). With `session`, the events of one session in order, a page at a time: `turn` reads one turn, `after` goes on after the last event of a page, and `more` says how many follow.',
    inputSchema: {
      since: time.describe('Start of the range (default 7d)'),
      until: time,
      source: z.string().optional(),
      project: z.string().optional(),
      session: z.string().optional().describe('Session id: list its events instead'),
      turn: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'With session: only this turn (1 for the first prompt; 0 for what came before it)',
        ),
      after: z
        .string()
        .optional()
        .describe('With session: continue after this event id, the last of the previous page'),
      include_tools: z.boolean().default(false),
      include_children: z
        .boolean()
        .default(false)
        .describe('Also list child sessions. By default a timeline lists top-level sessions only'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: readOnly,
  },
  changes: {
    title: 'Changes',
    description:
      'What reached the store since a cursor, oldest first: the top-level sessions active in that time (child sessions stay under their parent, unless `session` or `thread` asks for them), with their threads, their events, the entries written, the entries proposed, and what was forgotten (by id only), with `next` to read on and `more` when there is more. Without `after`, the last 24 hours. Pass the `next` of your last call to learn what changed since you looked.',
    inputSchema: {
      after: z
        .string()
        .optional()
        .describe('The `next` of your last call; without it, the last 24 hours'),
      project: z.string().optional(),
      thread: z.string().optional().describe('A thread id (thr_…): only its sessions'),
      session: z.string().optional().describe('A session id: only that session'),
      include_tools: z
        .boolean()
        .default(false)
        .describe('Also list tool calls and results, not only messages'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: readOnly,
  },
  digest: {
    title: 'Digest of a day',
    description:
      "What happened on one calendar day, from the store alone: totals, by project and by agent; the top-level sessions active that day, most recent first, each with its `id` for `get`, the user's prompts that day, the tools called, and the files its edit calls changed (a child session's activity is folded into its parent's, in the fields `children_included_in` names); the entries written that day (corrections included), the entries proposed, and the forgets made (by id only). Use it to recap a day's work.",
    inputSchema: {
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'A day is written YYYY-MM-DD')
        .optional()
        .describe('The day, YYYY-MM-DD (default: today)'),
      time_zone: z
        .string()
        .optional()
        .describe(
          "The IANA time zone the day is in, e.g. Europe/Berlin (default: the server's own)",
        ),
      project: z
        .string()
        .optional()
        .describe('Only sessions, entries, and proposals of this project'),
      source: z.string().optional().describe('Only sessions of this agent, e.g. claude-code'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe('Most sessions listed, and most entries, proposals, and forgets'),
    },
    annotations: readOnly,
  },
  get: {
    title: 'Get by id',
    description:
      'Open any id Origin hands you, with what is next to it, one line each by id: an entry (sources, version history, related entries), an event (its text, session, turn, the events around it, and the entries citing it), a session (its turns, its thread, the entries written from it, its recalls, the sessions before and after it, its parent when it is a child, and its children grouped by run when it is a parent), a thread (its sessions, agents, branches, the entries written from it, and its last prompt), a recall (what it handed over), or a proposal (its fields, status, sources, session, and the entry it became once accepted).',
    inputSchema: {
      id: z
        .string()
        .describe(
          'Entry (ent_…), event (source:…), session, thread (thr_…), recall (rcl_…), or proposal (prp_…) id',
        ),
      source: z
        .string()
        .optional()
        .describe('For a session id: its source, when sessions of two sources have that id'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "For an event or an entry: where to start reading its text (a page's next_offset)",
        ),
    },
    annotations: readOnly,
  },
  sources: {
    title: 'Original sources',
    description:
      'Expand an entry or event to the original log lines it comes from, with file paths and line numbers.',
    inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
    annotations: readOnly,
  },
  follow: {
    title: 'Follow a session',
    description:
      'Declare that your session continues an earlier session or thread of the project you work in, so that they form one thread. Call it once, when the user takes up work from a session that `brief`, `timeline`, or `search` showed you. It saves nothing else: the link is read from this call’s result in your session’s log.',
    inputSchema: {
      id: z
        .string()
        .describe('The session (its id, or source:id) or thread (thr_…) your session continues'),
      note: z.string().trim().max(200).optional().describe('A few words on how the work continues'),
      cwd: z
        .string()
        .optional()
        .describe("Your working directory (default: the directory Origin's server runs in)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
  propose: {
    title: 'Propose an entry',
    description:
      'Propose a durable entry for the user to review, instead of saving it: for what you infer and the user has not confirmed, and for everything you write when consolidating their memory. The same fields as `remember`, checked the same way, plus a short `note` on why. It saves nothing else: the proposal is read from this call’s result in your session’s log, and only the user accepts or rejects it, in the Origin admin UI or CLI.',
    inputSchema: {
      kind: z.enum(ENTRY_KINDS),
      text: z.string().min(1).describe('One self-contained statement'),
      sources: z.array(sourceInput).min(1),
      confidence: z.number().min(0).max(1).describe('How sure you are, 0–1'),
      project: z.string().optional().describe('Project the entry belongs to, if any'),
      valid_from: time,
      valid_to: time,
      note: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('Why you propose rather than remember, in a few words'),
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

/**
 * The tools that write, or propose what to write: a connection with the `readonly` preset (see
 * docs/architecture.md#access) is served without them.
 */
export const WRITE_TOOLS: readonly ToolName[] = ['remember', 'propose', 'correct', 'forget'];

/** What a read-only connection is told, after the usual guidance. */
export const READ_ONLY_NOTE =
  '- This connection is read-only: it has no `remember`, `propose`, `correct`, or `forget`, so it can read the memory but not change it.';

export function registerOriginTools(
  mcp: McpServer,
  handlers: ToolHandlers,
  opts: { readOnly?: boolean } = {},
): void {
  for (const name of TOOL_NAMES) {
    if (opts.readOnly && WRITE_TOOLS.includes(name)) continue;
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
 * that arrive meanwhile share that run. Failures are logged, never thrown. A store a newer Origin
 * has upgraded ends the process, so the client starts it again.
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
      .catch((err: unknown) => {
        log?.(`${label} failed: ${(err as Error).message}`);
        // The exit does not return. A test spy throws, and the caller awaits this refresh.
        if (err instanceof StoreUpgradedError) process.exit(1);
      })
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

/**
 * How often a server looks for new log lines while it runs (ORIGIN_WATCH_INTERVAL_MS): the
 * fallback for agents whose hooks do not hand each turn over (`origin sync --hook`, see
 * docs/architecture.md#live-ingestion), and for lines a hook missed.
 */
export const WATCH_INTERVAL_MS = 60_000;
/** How long a server waits for its last sync when the agent disconnects. */
export const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Run `tick` every `intervalMs` in the background, one at a time (the next is scheduled once the
 * last has finished), until the returned function is called. `tick` refreshes through the refresh
 * gates, so it never overlaps another refresh, and tool calls never wait for the timer. Failures
 * are logged, never thrown. A store a newer Origin has upgraded ends the process, so the client
 * starts it again. An interval of 0 or less runs nothing.
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
        .catch((err: unknown) => {
          log?.(`background sync failed: ${(err as Error).message}`);
          if (!(err instanceof StoreUpgradedError)) return;
          stopped = true;
          process.exit(1);
        })
        .catch(() => {
          // Nothing awaits a timer. process.exit does not return; a test spy throws.
        })
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
