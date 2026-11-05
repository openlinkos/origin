import type { Database } from './db.js';
import { transaction } from './db.js';
import { CURRENT_VERSION, type Entry, getEntry } from './entries.js';
import { OriginError } from './errors.js';
import { entryProjectMatchSql, resolvedProjectSql } from './places.js';
import { getProposal, type Proposal, VISIBLE_PROPOSAL } from './proposals.js';
import {
  EVENT_COLUMNS,
  getSession,
  type RawEventRecord,
  toEventRow,
  VISIBLE_EVENT,
} from './store.js';
import { threadSummary } from './threads.js';
import type { EventRow, SessionRow } from './types.js';

/**
 * The change feed (see docs/architecture.md#change-feed): what happened in a store since a cursor,
 * oldest first and bounded, so that an agent that looked before learns what changed without reading
 * everything again. Two streams, each in the order things reached this store: events, by `seq`,
 * and entries and tombstones, by their `change_log` sequence. A cursor records how far a reader has
 * got in both. Nothing hidden is ever in the feed (invariant 2): forgotten events and entries are
 * left out, and a forget shows only its id and its target's id.
 */

/** Where a reader of the feed has got to: the last event, and the last change_log row, it was given. */
export interface FeedCursor {
  event: number;
  change: number;
}

/** Most items of each stream in one page. */
export const FEED_LIMIT_MAX = 200;
/** Without a cursor, the feed starts this long ago. */
export const FEED_WINDOW_MS = 24 * 3_600_000;

/** A cursor as readers hand it back: base64url of a small JSON object. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** The value of a cursor string; throws an OriginError for one that is not a cursor. */
export function decodeCursor(text: string): unknown {
  const malformed = () =>
    new OriginError(
      `Malformed cursor ${JSON.stringify(text.slice(0, 40))}: pass the \`next\` of the last result, or no cursor to start from the last 24 hours.`,
    );
  if (!/^[A-Za-z0-9_-]{1,2000}$/.test(text)) throw malformed();
  try {
    return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw malformed();
  }
}

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * A feed cursor from its string (see encodeFeedCursor); throws an OriginError for a malformed one.
 * A connected device's cursor holds this store's as `l` (see the MCP package), which is taken.
 */
export function parseFeedCursor(text: string): FeedCursor {
  let value = decodeCursor(text) as Record<string, unknown> | null;
  if (value && typeof value === 'object' && value.l && typeof value.l === 'object') {
    value = value.l as Record<string, unknown>;
  }
  if (!value || typeof value !== 'object' || !isCount(value.e) || !isCount(value.c)) {
    throw new OriginError(
      `Malformed cursor ${JSON.stringify(text.slice(0, 40))}: pass the \`next\` of the last result, or no cursor to start from the last 24 hours.`,
    );
  }
  return { event: value.e, change: value.c };
}

export function encodeFeedCursor(c: FeedCursor): string {
  return encodeCursor({ e: c.event, c: c.change });
}

export interface FeedFilter {
  /** Where the last page ended; without it, the feed starts FEED_WINDOW_MS before `now`. */
  after?: FeedCursor | null;
  /** Events and sessions of this project, and entries of it. */
  project?: string;
  /** Events and sessions of this thread, and the entries written from them. */
  thread?: string;
  /** Events of this session, and the entries written from it. */
  session?: { source: string; sessionId: string };
  /** Also tool calls and results, injected context, and system events, not only messages. */
  includeTools?: boolean;
  /** Most events, and most entries and forgets, in the page (50 by default, at most 200). */
  limit?: number;
  now?: number;
}

/** A session in the feed: active in its range, and whether it started there. */
export interface FeedSession {
  session: SessionRow;
  started: boolean;
}

/** A forget or a restore in the feed: its id, its target's id, and when it was made. */
export interface FeedForget {
  id: string;
  target: string;
  at: number;
}

export interface ChangeFeed {
  /** The sessions of the events in the page, in the order they first appear. */
  sessions: FeedSession[];
  /** Visible events, in the order they reached the store. */
  events: EventRow[];
  /** Current entries written or received in the range, in the order they reached the store. */
  entries: Entry[];
  /** Forgets and restores in the range, in the order they reached the store. */
  forgets: FeedForget[];
  /**
   * Proposals made in the range, pending or accepted as the page is read: those whose event is in
   * the range of the events, whatever their kind, in the order they reached the store.
   */
  proposals: Proposal[];
  /** The cursor after the last item of the page: pass it as `after` to read on. */
  next: FeedCursor;
  /** Whether the range held more than the page: read on with `next` (without a cursor, older). */
  more: boolean;
}

type EventRecord = RawEventRecord & { seq: number };

/** The conditions of a filter's session or thread on the event `alias`, with their parameters. */
function sessionScope(f: FeedFilter, alias: string): { parts: string[]; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (f.session) {
    parts.push(`${alias}.source = ? AND ${alias}.session_id = ?`);
    values.push(f.session.source, f.session.sessionId);
  }
  if (f.thread !== undefined) {
    parts.push(`(${alias}.source, ${alias}.session_id) IN
      (SELECT t.source, t.session_id FROM session_thread t WHERE t.thread_id = ?)`);
    values.push(f.thread);
  }
  return { parts, values };
}

/**
 * What changed since `after`, oldest first: at most `limit` events, and at most `limit` entries and
 * forgets together, with the cursor after the last of each. Without a cursor, the changes of the
 * last 24 hours: the newest `limit` of each stream if there are more, and the cursor as of now.
 * Throws an OriginError for an unknown thread.
 */
export function changesSince(db: Database, f: FeedFilter = {}): ChangeFeed {
  const limit = Math.min(Math.max(1, Math.trunc(f.limit ?? 50)), FEED_LIMIT_MAX);
  const now = f.now ?? Date.now();
  const since = now - FEED_WINDOW_MS;
  if (f.thread !== undefined && !threadSummary(db, f.thread)) {
    throw new OriginError(`Unknown thread ${f.thread}.`);
  }
  // One snapshot for every query, so that the cursor and the page agree.
  return transaction(db, () => {
    const ends = db
      .prepare(
        `SELECT (SELECT COALESCE(MAX(seq), 0) FROM event) AS event,
                (SELECT COALESCE(MAX(seq), 0) FROM change_log) AS change`,
      )
      .get() as unknown as FeedCursor;
    const after = f.after ?? null;

    // Events.
    const where = [f.includeTools ? "e.kind <> 'memory'" : "e.kind = 'message'", 'e.seq <= ?'];
    const params: unknown[] = [ends.event];
    if (f.project !== undefined) {
      where.push(`${resolvedProjectSql('e.source', 'e.session_id', 'e.project')} = ?`);
      params.push(f.project);
    }
    const inSessions = sessionScope(f, 'e');
    where.push(...inSessions.parts);
    params.push(...inSessions.values);
    if (after) {
      where.push('e.seq > ?');
      params.push(after.event);
    } else {
      where.push('e.ts >= ?');
      params.push(since);
    }
    const rows = db
      .prepare(
        `SELECT ${EVENT_COLUMNS}, e.seq FROM event e
          WHERE ${where.join(' AND ')} AND ${VISIBLE_EVENT}
          ORDER BY e.seq ${after ? 'ASC' : 'DESC'} LIMIT ?`,
      )
      .all(...(params as never[]), limit + 1) as unknown as EventRecord[];
    let moreEvents = rows.length > limit;
    let page = rows.slice(0, limit);
    if (!after) page.reverse();
    let nextEvent =
      moreEvents && after && page.length > 0 ? (page.at(-1) as EventRecord).seq : ends.event;

    // Proposals made in the range: those whose event is in the events' range, whatever its kind.
    const proposalWhere = ['e.seq <= ?', VISIBLE_PROPOSAL];
    const proposalParams: unknown[] = [nextEvent];
    if (after) {
      proposalWhere.push('e.seq > ?');
      proposalParams.push(after.event);
    } else {
      proposalWhere.push('p.at >= ?');
      proposalParams.push(since);
    }
    if (f.project !== undefined) {
      proposalWhere.push(
        `COALESCE(p.project, ${resolvedProjectSql('e.source', 'e.session_id', 'e.project')}) = ?`,
      );
      proposalParams.push(f.project);
    }
    const proposalScope = sessionScope(f, 'e');
    proposalWhere.push(...proposalScope.parts);
    proposalParams.push(...proposalScope.values);
    const proposalRows = db
      .prepare(
        `SELECT p.id, e.seq FROM proposal p JOIN event e ON e.id = p.event_id
          WHERE ${proposalWhere.join(' AND ')}
          ORDER BY e.seq ${after ? 'ASC' : 'DESC'} LIMIT ?`,
      )
      .all(...(proposalParams as never[]), limit + 1) as unknown as Array<{
      id: string;
      seq: number;
    }>;
    const moreProposals = proposalRows.length > limit;
    const proposalPage = proposalRows.slice(0, limit);
    if (!after) proposalPage.reverse();
    if (moreProposals && after) {
      // The page ends with the last proposal it lists; the events after it come with the next one.
      nextEvent = (proposalPage.at(-1) as { seq: number }).seq;
      page = page.filter((r) => r.seq <= nextEvent);
      moreEvents = true;
    }
    const proposals = proposalPage
      .map((r) => getProposal(db, r.id))
      .filter((p): p is Proposal => p !== null);

    // Entries and forgets, in the order of change_log.
    const entryWhere = [
      'NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = en.id)',
      CURRENT_VERSION,
      '(en.valid_to IS NULL OR en.valid_to > ?)',
    ];
    const entryParams: unknown[] = [now];
    if (f.project !== undefined) {
      entryWhere.push(entryProjectMatchSql('en.id'));
      entryParams.push(f.project, f.project);
    }
    // Written from a session or thread: citing one of its visible events.
    const cited = sessionScope(f, 'c');
    if (cited.parts.length > 0) {
      entryWhere.push(`en.id IN (SELECT s.entry_id FROM entry_source s
        JOIN event c ON c.id = s.event_id
        WHERE ${cited.parts.join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = c.id))`);
      entryParams.push(...cited.values);
    }
    const range = after ? 'l.seq > ?' : 'l.at >= ?';
    const changes = db
      .prepare(
        `SELECT l.seq, l.kind, l.id FROM change_log l
          WHERE l.seq <= ? AND ${range} AND (l.kind = 'tombstone' OR (l.kind = 'entry' AND EXISTS
            (SELECT 1 FROM entry en WHERE en.id = l.id AND ${entryWhere.join(' AND ')})))
          ORDER BY l.seq ${after ? 'ASC' : 'DESC'} LIMIT ?`,
      )
      .all(
        ends.change,
        after ? after.change : since,
        ...(entryParams as never[]),
        limit + 1,
      ) as unknown as Array<{ seq: number; kind: 'entry' | 'tombstone'; id: string }>;
    const moreChanges = changes.length > limit;
    const changed = changes.slice(0, limit);
    if (!after) changed.reverse();
    const lastChange = changed.at(-1);

    const entries: Entry[] = [];
    const forgets: FeedForget[] = [];
    const seen = new Set<string>();
    const tombstone = db.prepare('SELECT id, target, created_at FROM tombstone WHERE id = ?');
    for (const c of changed) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.kind === 'entry') {
        const entry = getEntry(db, c.id);
        if (entry) entries.push(entry);
        continue;
      }
      const t = tombstone.get(c.id) as
        | { id: string; target: string; created_at: number }
        | undefined;
      if (t) forgets.push({ id: t.id, target: t.target, at: t.created_at });
    }

    // The sessions of the page's events.
    const sessions: FeedSession[] = [];
    const keys = new Set<string>();
    const before = db.prepare(
      `SELECT 1 FROM event e WHERE e.source = ? AND e.session_id = ? AND e.seq <= ?
          AND e.kind <> 'memory' AND ${VISIBLE_EVENT} LIMIT 1`,
    );
    for (const r of page) {
      const key = `${r.source}\n${r.session_id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const session = getSession(db, r.source, r.session_id);
      if (!session) continue;
      const started = after
        ? before.get(r.source, r.session_id, after.event) === undefined
        : session.startedAt !== null && session.startedAt >= since;
      sessions.push({ session, started });
    }

    return {
      sessions,
      events: page.map(toEventRow),
      entries,
      forgets,
      proposals,
      next: {
        event: nextEvent,
        change: moreChanges && after && lastChange ? lastChange.seq : ends.change,
      },
      more: moreEvents || moreChanges || moreProposals,
    };
  });
}
