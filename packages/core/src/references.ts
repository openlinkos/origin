import type { Database } from './db.js';
import {
  currentEntriesCiting,
  type Entry,
  entriesOfSession,
  entriesOfThread,
  isEntryId,
} from './entries.js';
import { OriginError } from './errors.js';
import { isRecallId, type RecallRecord, rebuildRecall, sessionRecalls } from './recall.js';
import {
  EVENT_COLUMNS,
  type EventPosition,
  getEvent,
  getSession,
  isEventForgotten,
  listThreadSessions,
  type RawEventRecord,
  type SessionPrompt,
  sessionPrompts,
  sessionSources,
  sessionTurnStarts,
  type TurnStart,
  toEventRow,
  VISIBLE_EVENT,
} from './store.js';
import { isThreadId, threadSummary } from './threads.js';
import type { EventKind, EventRow, SessionRow } from './types.js';

/**
 * Reading along references (see docs/architecture.md#reading-along-references). Every id Origin
 * hands an agent can be opened, and what it opens names what is next to it, one line each, by id:
 * an event's session, its turn, the events around it, the event it follows, and the entries that
 * cite it; a session's turns, its thread, the entries written from it, the recalls it was handed,
 * and the sessions before and after it in its project; a thread's sessions, the entries written
 * from them, and its last prompt. An agent follows the ids that matter one hop at a
 * time, and reads a long session a turn or a page at a time. Every list is bounded, and nothing
 * hidden is in a list or a count (invariant 2): these queries read visible events and current
 * entries only. No model is called.
 */

/** A stub's text is cut to about this many characters. */
export const STUB_CHARS = 120;
/** Most entries, and most recalls, in a list of neighbours. */
export const NEIGHBOUR_MAX = 10;
/** How many events are listed on each side of an event. */
export const AROUND = 2;
/** How many turn prompts a session's card lists. */
export const CARD_PROMPTS = 20;
/** How many sessions a thread's card lists. */
export const CARD_SESSIONS = 20;

/** Text as a stub shows it: on one line, cut to `max` characters with `…`. */
export function stubText(text: string, max = STUB_CHARS): string {
  // A tool result can be long: only its start can show.
  const head =
    text.length > max * 4 ? text.slice(0, max * 4).replace(/[\uD800-\uDBFF]$/, '') : text;
  const flat = head.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= max && head === text) return flat;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** What an id opens (see resolveId). */
export type Opened =
  | { kind: 'entry'; id: string }
  | { kind: 'recall'; id: string }
  | { kind: 'thread'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'session'; session: SessionRow };

/**
 * What an id opens: `ent_…` an entry, `rcl_…` a recall, `thr_…` a thread, an event's id
 * (`<source>:…`), visible or forgotten, the event; any other id a session, written as recalls record
 * one (`<source>:<session id>`) or as its id alone, with `source` when sessions of two sources have
 * that id. Null for an id this store does not know, such as a session whose events were all
 * forgotten, or a thread none of whose sessions it has. Throws when a session id alone names
 * sessions of more than one source.
 */
export function resolveId(db: Database, id: string, source?: string): Opened | null {
  if (isEntryId(id)) return { kind: 'entry', id };
  if (isRecallId(id)) return { kind: 'recall', id };
  if (isThreadId(id)) return threadSummary(db, id) ? { kind: 'thread', id } : null;
  const at = id.indexOf(':');
  if (at > 0) {
    if (db.prepare('SELECT 1 FROM event WHERE id = ?').get(id) !== undefined) {
      return { kind: 'event', id };
    }
    const prefix = id.slice(0, at);
    if (!source || source === prefix) {
      const session = getSession(db, prefix, id.slice(at + 1));
      if (session) return { kind: 'session', session };
    }
  }
  const session = findSession(db, id, source);
  return session ? { kind: 'session', session } : null;
}

/**
 * A session by its id, with visible events, or null: of `source` when given, otherwise of the one
 * source that has a session of that id. Throws when sessions of more than one source have it.
 */
export function findSession(db: Database, sessionId: string, source?: string): SessionRow | null {
  if (source) return getSession(db, source, sessionId);
  const sources = sessionSources(db, sessionId);
  if (sources.length > 1) {
    throw new OriginError(
      `Session ${sessionId} exists under more than one source (${sources.join(', ')}); pass \`source\` to choose one.`,
    );
  }
  return sources[0] ? getSession(db, sources[0], sessionId) : null;
}

/** Where a visible event is in its session, or null. */
function positionOf(db: Database, id: string): EventPosition | null {
  const row = db
    .prepare(`SELECT e.ts, e.seq FROM event e WHERE e.id = ? AND ${VISIBLE_EVENT}`)
    .get(id) as EventPosition | undefined;
  return row ? { ts: row.ts, seq: row.seq } : null;
}

/** The number of the turn a position falls in, from its session's turn starts; 0 before the first. */
export function turnAt(starts: EventPosition[], at: EventPosition): number {
  let n = 0;
  for (const s of starts) {
    if (s.ts > at.ts || (s.ts === at.ts && s.seq > at.seq)) break;
    n++;
  }
  return n;
}

/** What is next to an event (see eventContext). */
export interface EventContext {
  /** The event's session, for its name. */
  session: SessionRow | null;
  /** The turn the event falls in, with where it starts; null before the session's first prompt. */
  turn: { number: number; start: TurnStart } | null;
  /** The event the agent recorded this one as following (its parent), when visible. */
  repliesTo: EventRow | null;
  /** Up to AROUND visible events on each side, in the same session, in time order. */
  before: EventRow[];
  after: EventRow[];
  /** The current entries that cite the event, newest first, at most NEIGHBOUR_MAX. */
  citedBy: Entry[];
}

/**
 * What is next to a visible event: its session, its turn and the prompt that started it, the event
 * it follows, the events around it (messages only, unless it is a tool call or result, whose
 * neighbours are of any kind), and the current entries that cite it.
 */
export function eventContext(db: Database, event: EventRow): EventContext {
  const at = positionOf(db, event.id);
  const starts = sessionTurnStarts(db, event.source, event.sessionId, { chars: STUB_CHARS });
  const number = at ? turnAt(starts, at) : 0;
  const tool = event.kind === 'tool_use' || event.kind === 'tool_result';
  return {
    session: getSession(db, event.source, event.sessionId),
    turn: number > 0 ? { number, start: starts[number - 1] as TurnStart } : null,
    repliesTo: parentOf(db, event),
    ...(at ? around(db, event, at, tool ? null : ['message']) : { before: [], after: [] }),
    citedBy: currentEntriesCiting(db, event.id, NEIGHBOUR_MAX),
  };
}

/** The visible events next to a position in its session, AROUND on each side, of `kinds` if given. */
function around(
  db: Database,
  event: EventRow,
  at: EventPosition,
  kinds: EventKind[] | null,
): { before: EventRow[]; after: EventRow[] } {
  const kind = kinds ? ` AND e.kind IN (${kinds.map(() => '?').join(', ')})` : '';
  const base = `SELECT ${EVENT_COLUMNS} FROM event e
    WHERE e.source = ? AND e.session_id = ?${kind} AND ${VISIBLE_EVENT}`;
  const params = [event.source, event.sessionId, ...(kinds ?? []), at.ts, at.ts, at.seq, AROUND];
  const before = db
    .prepare(
      `${base} AND e.ts <= ? AND (e.ts < ? OR e.seq < ?) ORDER BY e.ts DESC, e.seq DESC LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as RawEventRecord[];
  const after = db
    .prepare(`${base} AND e.ts >= ? AND (e.ts > ? OR e.seq > ?) ORDER BY e.ts, e.seq LIMIT ?`)
    .all(...(params as never[])) as unknown as RawEventRecord[];
  return { before: before.map(toEventRow).reverse(), after: after.map(toEventRow) };
}

/**
 * The event an event follows, as its agent recorded it (Claude Code's `parentUuid`), when visible:
 * the event of that id, or, for a line split into several events (`<id>#<n>`), the first of them.
 */
function parentOf(db: Database, event: EventRow): EventRow | null {
  if (!event.parentId) return null;
  const id = `${event.source}:${event.parentId}`;
  if (db.prepare('SELECT 1 FROM event WHERE id = ?').get(id) !== undefined) return getEvent(db, id);
  const row = db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.id > ? AND e.id < ? AND ${VISIBLE_EVENT} ORDER BY e.seq LIMIT 1`,
    )
    .get(`${id}#`, `${id}$`) as RawEventRecord | undefined;
  return row ? toEventRow(row) : null;
}

/** A session as a card (see describeSession). */
export interface SessionCard {
  session: SessionRow;
  /** How many turns it has (see sessionTurnStarts); what came before the first is not one. */
  turns: number;
  /** Where its first CARD_PROMPTS turns start, with their numbers, in time order. */
  prompts: Array<TurnStart & { turn: number }>;
  /** How many turns there are after those. */
  morePrompts: number;
  /** The current entries written from it (that cite its events), newest first. */
  entries: Entry[];
  /** The latest recalls it was handed, newest first, with how many of their items are visible. */
  recalls: Array<{ recall: RecallRecord; items: number }>;
  /** The thread it is in with other sessions, and how many sessions that thread has; or null. */
  thread: { id: string; sessions: number } | null;
  /** The sessions just before and after it in its project, of any agent, by when they started. */
  before: SessionRow | null;
  after: SessionRow | null;
}

/**
 * A session and what is next to it: its turns, the entries written from it, the recalls it was
 * handed, and the sessions before and after it in its project. Bounded: CARD_PROMPTS prompts and
 * NEIGHBOUR_MAX entries and recalls. A recall whose items were all forgotten since is left out.
 */
export function describeSession(db: Database, session: SessionRow): SessionCard {
  const { source, sessionId } = session;
  const starts = sessionTurnStarts(db, source, sessionId, { chars: STUB_CHARS });
  const recalls: SessionCard['recalls'] = [];
  for (const recall of sessionRecalls(db, source, sessionId).reverse()) {
    if (recalls.length >= NEIGHBOUR_MAX) break;
    if (recall.items.length === 0) continue;
    const items = rebuildRecall(db, recall).lines.size;
    if (items > 0) recalls.push({ recall, items });
  }
  return {
    session,
    turns: starts.length,
    prompts: starts.slice(0, CARD_PROMPTS).map((s, i) => ({ ...s, turn: i + 1 })),
    morePrompts: Math.max(0, starts.length - CARD_PROMPTS),
    entries: entriesOfSession(db, source, sessionId, NEIGHBOUR_MAX),
    recalls,
    thread: session.thread ? threadCount(db, session.thread) : null,
    before: nextSession(db, session, 'before'),
    after: nextSession(db, session, 'after'),
  };
}

function threadCount(db: Database, id: string): { id: string; sessions: number } | null {
  const summary = threadSummary(db, id);
  return summary ? { id, sessions: summary.sessions } : null;
}

/** A thread as a card (see describeThread). */
export interface ThreadCard {
  id: string;
  /** Its root: the session that started first, which names it and whose project it is. */
  root: SessionRow;
  project: string | null;
  /** The root's title, or its first prompt. */
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Its first CARD_SESSIONS sessions, oldest first. */
  sessions: SessionRow[];
  /** How many sessions it has in all. */
  count: number;
  /** The agents (sources) of its sessions, and the work branches they were on, by name. */
  agents: string[];
  branches: string[];
  /** The current entries written from its sessions, newest first, at most NEIGHBOUR_MAX. */
  entries: Entry[];
  /** The latest prompt of its most recent session that has one, with that session. */
  lastPrompt: (SessionPrompt & { source: string; sessionId: string }) | null;
}

/** How many of a thread's latest sessions are looked at for its last prompt. */
const LAST_PROMPT_SESSIONS = 5;

/**
 * A thread and what is next to it: its sessions, the agents and branches they were of, the entries
 * written from them, and its last prompt. Bounded: CARD_SESSIONS sessions and NEIGHBOUR_MAX
 * entries. Null for a thread with no visible sessions: a forgotten session leaves its thread
 * (invariant 2).
 */
export function describeThread(db: Database, id: string): ThreadCard | null {
  const summary = threadSummary(db, id);
  const sessions = listThreadSessions(db, id, { limit: CARD_SESSIONS });
  const root = sessions[0];
  if (!summary || !root) return null;
  return {
    id,
    root,
    project: root.project,
    title: root.title ?? root.prompt,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    sessions,
    count: summary.sessions,
    agents: summary.agents,
    branches: summary.branches,
    entries: entriesOfThread(db, id, NEIGHBOUR_MAX),
    lastPrompt: threadLastPrompt(db, id),
  };
}

/** The latest prompt of a thread: of its most recent session that has one (see describeThread). */
export function threadLastPrompt(
  db: Database,
  id: string,
  opts: { until?: number } = {},
): ThreadCard['lastPrompt'] {
  const latest = db
    .prepare(
      `SELECT s.source, s.session_id FROM session_thread t
         JOIN session s ON s.source = t.source AND s.session_id = t.session_id
        WHERE t.thread_id = ? AND s.event_count > 0 AND s.started_at <= ?
        ORDER BY s.ended_at DESC, s.source, s.session_id LIMIT ?`,
    )
    .all(id, opts.until ?? Number.MAX_SAFE_INTEGER, LAST_PROMPT_SESSIONS) as unknown as Array<{
    source: string;
    session_id: string;
  }>;
  for (const s of latest) {
    const prompts = sessionPrompts(db, s.source, s.session_id);
    const last = (
      opts.until === undefined ? prompts : prompts.filter((p) => p.ts <= (opts.until as number))
    ).at(-1);
    if (last) return { ...last, source: s.source, sessionId: s.session_id };
  }
  return null;
}

/** The session just before or after one in its project, by when they started, or null. */
function nextSession(db: Database, s: SessionRow, side: 'before' | 'after'): SessionRow | null {
  if (s.project === null || s.startedAt === null) return null;
  const [cmp, order] = side === 'before' ? ['<', 'DESC'] : ['>', 'ASC'];
  const row = db
    .prepare(
      `SELECT source, session_id FROM session
        WHERE project = ? AND event_count > 0 AND started_at IS NOT NULL
          AND (started_at ${cmp} ? OR (started_at = ? AND (source, session_id) ${cmp} (?, ?)))
        ORDER BY started_at ${order}, source ${order}, session_id ${order} LIMIT 1`,
    )
    .get(s.project, s.startedAt, s.startedAt, s.source, s.sessionId) as
    | { source: string; session_id: string }
    | undefined;
  return row ? getSession(db, row.source, row.session_id) : null;
}

/** A page of a session's events (see readSession). */
export interface SessionPage {
  events: EventRow[];
  /** How many visible events of the range asked for follow the last one. */
  more: number;
}

/**
 * A page of a session's visible events, in time order: of `kinds`, if given; of one turn, if
 * `turn` is given (1 for the first prompt, 0 for what came before it); after the event `after`, if
 * given, to go on from the last event of a page; at most `limit` (50 by default). `more` counts
 * what follows in that range, so that the agent knows whether to read on.
 */
export function readSession(
  db: Database,
  o: {
    source: string;
    sessionId: string;
    kinds?: EventKind[];
    turn?: number;
    after?: string;
    limit?: number;
  },
): SessionPage {
  const where = ['e.source = ?', 'e.session_id = ?'];
  const params: unknown[] = [o.source, o.sessionId];
  if (o.turn !== undefined) {
    const starts = sessionTurnStarts(db, o.source, o.sessionId);
    if (!Number.isInteger(o.turn) || o.turn < 0 || o.turn > starts.length) {
      const turns = starts.length === 1 ? '1 turn' : `${starts.length} turns`;
      throw new OriginError(
        `Session ${o.sessionId} has ${turns}; turn 0 is what came before the first prompt.`,
      );
    }
    const from = o.turn > 0 ? (starts[o.turn - 1] as TurnStart) : null;
    const to = starts[o.turn] ?? null;
    if (from) {
      where.push('e.ts >= ? AND (e.ts > ? OR e.seq >= ?)');
      params.push(from.ts, from.ts, from.seq);
    }
    if (to) {
      where.push('e.ts <= ? AND (e.ts < ? OR e.seq < ?)');
      params.push(to.ts, to.ts, to.seq);
    }
  }
  if (o.after !== undefined) {
    const at = db
      .prepare(
        `SELECT e.ts, e.seq FROM event e
          WHERE e.id = ? AND e.source = ? AND e.session_id = ? AND ${VISIBLE_EVENT}`,
      )
      .get(o.after, o.source, o.sessionId) as EventPosition | undefined;
    if (!at) {
      throw new OriginError(
        isEventForgotten(db, o.after)
          ? `${o.after} has been forgotten.`
          : `Event ${o.after} is not in session ${o.sessionId}.`,
      );
    }
    where.push('e.ts >= ? AND (e.ts > ? OR e.seq > ?)');
    params.push(at.ts, at.ts, at.seq);
  }
  if (o.kinds && o.kinds.length > 0) {
    where.push(`e.kind IN (${o.kinds.map(() => '?').join(', ')})`);
    params.push(...o.kinds);
  }
  where.push(VISIBLE_EVENT);
  const range = where.join(' AND ');
  const rows = db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM event e WHERE ${range} ORDER BY e.ts, e.seq LIMIT ?`)
    .all(...(params as never[]), o.limit ?? 50) as unknown as RawEventRecord[];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM event e WHERE ${range}`).get(...(params as never[])) as {
      n: number;
    }
  ).n;
  return { events: rows.map(toEventRow), more: Math.max(0, total - rows.length) };
}
