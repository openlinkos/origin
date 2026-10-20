import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  correct,
  type Database,
  ENTRY_KINDS,
  type Entry,
  type EventRow,
  entryHistory,
  entrySources,
  forget,
  getEntry,
  getEvent,
  isEntryForgotten,
  isEntryId,
  isEventForgotten,
  isoLocal,
  listEntries,
  listEvents,
  listSessions,
  parseTime,
  rawLocator,
  readRawLine,
  remember,
  searchEntries,
  searchEvents,
} from '@openlinkos/origin-core';
import { z } from 'zod';

export interface OriginServerOptions {
  db: Database;
  home: string;
  /** Incremental ingestion of all sources; injected so that this package depends only on core. */
  sync?: () => Promise<void>;
  /** Minimum time between syncs triggered by read tools (default 10 s). */
  syncIntervalMs?: number;
  version?: string;
  /** Diagnostics. Never write to stdout: it carries the protocol. */
  log?: (message: string) => void;
}

export interface OriginServer {
  mcp: McpServer;
  /** Bring the archive up to date; `force` ignores the minimum interval. */
  refresh(force?: boolean): Promise<void>;
}

const INSTRUCTIONS = `Origin is the user's local, cross-agent memory: an append-only archive of their sessions with AI coding agents, plus durable entries — memory (what happened), knowledge (stable facts), and cognition (the user's preferences, methods, goals, and boundaries).

- To answer questions about past work, decisions, or reasons, use \`search\` and \`timeline\`, then \`get\` or \`sources\` to read the original text. Cite entry and event ids.
- When you learn something that will matter in future sessions — a decision and its reason, a stable fact, a preference of the user — save it with \`remember\`, citing the events it comes from: event ids from search/timeline, or an exact quote from this conversation.
- If an entry is wrong or outdated, use \`correct\`. Use \`forget\` only when the user explicitly asks; it cannot be undone.
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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

function eventView(e: EventRow, maxText: number) {
  return {
    id: e.id,
    time: isoLocal(e.ts),
    source: e.source,
    project: e.project,
    session: e.sessionId,
    role: e.role,
    kind: e.kind,
    text: clip(e.text, maxText),
  };
}

function entryView(e: Entry) {
  return {
    id: e.id,
    kind: e.kind,
    text: e.text,
    confidence: e.confidence,
    status: e.status,
    project: e.project,
    author: e.author,
    created: isoLocal(e.createdAt),
    valid_from: e.validFrom === null ? null : isoLocal(e.validFrom),
    valid_to: e.validTo === null ? null : isoLocal(e.validTo),
    supersedes: e.supersedes,
    superseded_by: e.supersededBy,
  };
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const optionalTime = (v: string | undefined) => (v === undefined ? undefined : parseTime(v));

export function createOriginServer(opts: OriginServerOptions): OriginServer {
  const { db, home } = opts;
  const interval = opts.syncIntervalMs ?? 10_000;
  let lastSync = 0;
  let inflight: Promise<void> | null = null;

  const refresh = async (force = false): Promise<void> => {
    if (!opts.sync) return;
    if (inflight) return inflight;
    if (!force && Date.now() - lastSync < interval) return;
    inflight = opts
      .sync()
      .catch((err: unknown) => opts.log?.(`sync failed: ${(err as Error).message}`))
      .finally(() => {
        lastSync = Date.now();
        inflight = null;
      });
    return inflight;
  };

  const mcp = new McpServer(
    { name: 'origin', version: opts.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const author = () => mcp.server.getClientVersion()?.name ?? 'mcp';

  /** Run a tool body; caller errors (bad ids, bad input) come back as tool errors, not crashes. */
  const run = async (
    body: () => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    try {
      return await body();
    } catch (err) {
      return fail((err as Error).message);
    }
  };

  const missing = (id: string) =>
    isEntryForgotten(db, id) || isEventForgotten(db, id)
      ? fail(`${id} has been forgotten.`)
      : fail(`Unknown entry or event ${id}.`);

  mcp.registerTool(
    'search',
    {
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
        include_tools: z
          .boolean()
          .default(false)
          .describe('Also match tool calls and tool results'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        await refresh();
        const since = optionalTime(args.since);
        const until = optionalTime(args.until);
        const query = args.query?.trim() ?? '';
        const entryFilter = {
          kind: args.kind,
          project: args.project,
          since,
          until,
          limit: args.limit,
        };
        const entries =
          args.scope === 'events'
            ? []
            : query
              ? searchEntries(db, query, entryFilter)
              : listEntries(db, entryFilter);
        const events =
          args.scope === 'entries' || !query
            ? []
            : searchEvents(db, query, {
                since,
                until,
                source: args.source,
                project: args.project,
                kinds: args.include_tools ? undefined : ['message'],
                limit: args.limit,
              });
        return ok({
          entries: entries.map(entryView),
          events: events.map((h) => ({ ...eventView(h, 400), snippet: h.snippet })),
        });
      }),
  );

  mcp.registerTool(
    'timeline',
    {
      title: 'Timeline',
      description:
        'Sessions in a time range (newest first), or the events of one session in order when `session` is given.',
      inputSchema: {
        since: time.describe('Start of the range (default 7d)'),
        until: time,
        source: z.string().optional(),
        project: z.string().optional(),
        session: z.string().optional().describe('Session id: list its events instead'),
        include_tools: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        await refresh();
        if (args.session) {
          const events = listEvents(db, {
            sessionId: args.session,
            source: args.source,
            kinds: args.include_tools ? undefined : ['message'],
            limit: args.limit,
          });
          return ok({ session: args.session, events: events.map((e) => eventView(e, 1000)) });
        }
        const sessions = listSessions(db, {
          since: parseTime(args.since ?? '7d'),
          until: optionalTime(args.until),
          source: args.source,
          project: args.project,
          limit: args.limit,
        });
        return ok({
          sessions: sessions.map((s) => ({
            session: s.sessionId,
            source: s.source,
            project: s.project,
            title: s.title,
            started: s.startedAt === null ? null : isoLocal(s.startedAt),
            ended: s.endedAt === null ? null : isoLocal(s.endedAt),
            events: s.eventCount,
          })),
        });
      }),
  );

  mcp.registerTool(
    'get',
    {
      title: 'Get entry or event',
      description:
        'Fetch an entry (with its sources and version history) or an event (full text) by id.',
      inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(() => {
        if (isEntryId(args.id)) {
          const entry = getEntry(db, args.id);
          if (!entry) return missing(args.id);
          return ok({
            entry: entryView(entry),
            sources: entrySources(db, entry.id).map((s) => ({
              quote: s.quote,
              ...eventView(s.event, 500),
            })),
            history: entryHistory(db, entry.id).map((v) => v.id),
          });
        }
        const event = getEvent(db, args.id);
        if (!event) return missing(args.id);
        return ok({
          ...eventView(event, 20_000),
          cwd: event.cwd,
          git_branch: event.gitBranch,
          agent_version: event.agentVersion,
        });
      }),
  );

  mcp.registerTool(
    'sources',
    {
      title: 'Original sources',
      description:
        'Expand an entry or event to the original log lines it comes from, with file paths and line numbers.',
      inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(() => {
        let cited: Array<{ quote: string | null; event: EventRow }>;
        if (isEntryId(args.id)) {
          if (!getEntry(db, args.id)) return missing(args.id);
          cited = entrySources(db, args.id);
        } else {
          const event = getEvent(db, args.id);
          if (!event) return missing(args.id);
          cited = [{ quote: null, event }];
        }
        return ok(
          cited.map(({ quote, event }) => {
            const loc = rawLocator(db, home, event);
            const raw = loc ? readRawLine(loc) : null;
            return {
              event_id: event.id,
              time: isoLocal(event.ts),
              quote,
              original_file: loc?.originalPath ?? null,
              mirror_file: loc?.mirrorPath ?? null,
              line: loc?.line ?? null,
              raw: raw === null ? null : clip(raw, 4000),
            };
          }),
        );
      }),
  );

  mcp.registerTool(
    'remember',
    {
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
    (args) =>
      run(async () => {
        await refresh(true); // the cited lines may have just been written
        const entry = remember(db, {
          kind: args.kind,
          text: args.text,
          confidence: args.confidence,
          author: author(),
          project: args.project ?? null,
          validFrom: optionalTime(args.valid_from) ?? null,
          validTo: optionalTime(args.valid_to) ?? null,
          sources: args.sources.map((s) => ({ eventId: s.event_id, quote: s.quote })),
        });
        return ok({ entry: entryView(entry) });
      }),
  );

  mcp.registerTool(
    'correct',
    {
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
    (args) =>
      run(async () => {
        await refresh(true);
        const entry = correct(db, args.id, {
          text: args.text,
          author: author(),
          kind: args.kind,
          confidence: args.confidence,
          validFrom: optionalTime(args.valid_from),
          validTo: optionalTime(args.valid_to),
          sources: args.sources?.map((s) => ({ eventId: s.event_id, quote: s.quote })),
        });
        return ok({ entry: entryView(entry) });
      }),
  );

  mcp.registerTool(
    'forget',
    {
      title: 'Forget',
      description:
        'Permanently forget an entry (every version, and the events it cites) or an event (and every entry that cites it). Only on the user’s explicit request; cannot be undone.',
      inputSchema: {
        id: z.string().describe('Entry id (ent_…) or event id (source:…)'),
        reason: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) =>
      run(() => {
        const r = forget(db, args.id, args.reason);
        return ok({ forgotten_entries: r.entries, excluded_events: r.events.length });
      }),
  );

  return { mcp, refresh };
}

/** Serve over stdio until the client disconnects. */
export async function serveStdio(opts: OriginServerOptions): Promise<void> {
  const server = createOriginServer(opts);
  const closed = new Promise<void>((resolve) => {
    server.mcp.server.onclose = () => resolve();
  });
  await server.mcp.connect(new StdioServerTransport());
  process.stdin.once('end', () => void server.mcp.close());
  void server.refresh(true);
  await closed;
}
