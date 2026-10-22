import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  correct,
  type Database,
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
import {
  INSTRUCTIONS,
  refreshGate,
  registerOriginTools,
  type ToolHandlers,
  toolError,
  toolResult,
} from './tools.js';

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
  /** Author recorded on entries; defaults to the name of the connected MCP client. */
  author?: () => string;
}

export interface OriginServer {
  mcp: McpServer;
  /** Bring the archive up to date; `force` ignores the minimum interval. */
  refresh(force?: boolean): Promise<void>;
}

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
    concurrent: e.concurrent,
    root: e.root,
  };
}

const ok = toolResult;
const fail = toolError;

const optionalTime = (v: string | undefined) => (v === undefined ? undefined : parseTime(v));

/** Tool implementations against a local store. */
function localHandlers(
  db: Database,
  home: string,
  refresh: (force?: boolean) => Promise<void>,
  author: () => string,
): ToolHandlers {
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

  return {
    search: (args) =>
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

    timeline: (args) =>
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

    get: (args) =>
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

    sources: (args) =>
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

    remember: (args) =>
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

    correct: (args) =>
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

    forget: (args) =>
      run(() => {
        const r = forget(db, args.id, args.reason);
        return ok({
          tombstone: r.tombstoneId,
          forgotten_entries: r.entries,
          excluded_events: r.events.length,
        });
      }),
  };
}

export function createOriginServer(opts: OriginServerOptions): OriginServer {
  const refresh = refreshGate(opts.sync, opts.syncIntervalMs ?? 10_000, opts.log);
  const mcp = new McpServer(
    { name: 'origin', version: opts.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const author = opts.author ?? (() => mcp.server.getClientVersion()?.name ?? 'mcp');
  registerOriginTools(mcp, localHandlers(opts.db, opts.home, refresh, author));
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
