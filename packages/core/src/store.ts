import path from 'node:path';
import {
  AUTHOR_SIGNAL_SQL,
  AUTHOR_SQL,
  isOwnerPrompt,
  OWNER_PROMPT_SQL,
  SPEAKER_SQL,
} from './authors.js';
import type { Database } from './db.js';
import { readMirrorLine } from './mirror.js';
import { TOP_LEVEL_SESSION } from './parents.js';
import { parseRawPath, rawDir } from './paths.js';
import { projectEventSql, resolvedProjectSql } from './places.js';
import { PROMPT_TITLE_MAX, promptTitle } from './prompt.js';
import type { Author, EventKind, EventRow, Role, SessionRow } from './types.js';

export { PROMPT_TITLE_MAX, promptTitle };

export interface EventFilter {
  source?: string;
  project?: string;
  sessionId?: string;
  /** epoch ms, inclusive. */
  since?: number;
  /** epoch ms, inclusive. */
  until?: number;
  kinds?: EventKind[];
  limit?: number;
  /** Rows to skip, for paging. */
  offset?: number;
}

export interface SearchOptions extends EventFilter {
  /**
   * `relevance` (BM25 over the newest RANK_WINDOW matches, default) or `recent` (newest first).
   * Queries without a term of three or more characters are always `recent`.
   */
  order?: 'relevance' | 'recent';
}

export interface SearchHit extends EventRow {
  snippet: string;
}

/**
 * The columns of an event `e` as EventRow has them, its authorship included: who wrote an input, as
 * derived and combined with its session's kind (see authors.ts).
 */
export const EVENT_COLUMNS = `e.id, e.source, e.session_id, e.parent_id, e.ts,
  ${resolvedProjectSql('e.source', 'e.session_id', 'e.project')} AS project, e.cwd, e.git_branch,
  e.role, e.kind, e.text, e.raw_file_id, e.raw_line, e.agent_version, e.meta,
  (${AUTHOR_SQL}) AS author, (${AUTHOR_SIGNAL_SQL}) AS author_signal, (${SPEAKER_SQL}) AS speaker`;

/** Forgotten events are excluded from every query (invariant 2, recorded forgetting). */
export const VISIBLE_EVENT = 'NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)';

export interface RawEventRecord {
  id: string;
  source: string;
  session_id: string;
  parent_id: string | null;
  ts: number;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  role: string;
  kind: string;
  text: string;
  raw_file_id: number;
  raw_line: number;
  agent_version: string | null;
  meta: string | null;
  author: string | null;
  author_signal: string | null;
  speaker: string | null;
  snippet?: string;
}

export function toEventRow(r: RawEventRecord): EventRow {
  return {
    id: r.id,
    source: r.source,
    sessionId: r.session_id,
    parentId: r.parent_id,
    ts: r.ts,
    project: r.project,
    cwd: r.cwd,
    gitBranch: r.git_branch,
    role: r.role as Role,
    kind: r.kind as EventKind,
    text: r.text,
    rawFileId: r.raw_file_id,
    rawLine: r.raw_line,
    agentVersion: r.agent_version,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    author: (r.author as Author | null) ?? null,
    authorSignal: r.author_signal ?? null,
    speaker: r.speaker ?? null,
  };
}

function whereClause(f: EventFilter, params: unknown[]): string {
  const parts: string[] = [VISIBLE_EVENT];
  if (f.source) {
    parts.push('e.source = ?');
    params.push(f.source);
  }
  if (f.project) {
    parts.push(projectEventSql('e'));
    params.push(f.project, f.project);
  }
  if (f.sessionId) {
    parts.push('e.session_id = ?');
    params.push(f.sessionId);
  }
  if (f.since !== undefined) {
    parts.push('e.ts >= ?');
    params.push(f.since);
  }
  if (f.until !== undefined) {
    parts.push('e.ts <= ?');
    params.push(f.until);
  }
  if (f.kinds && f.kinds.length > 0) {
    parts.push(`e.kind IN (${f.kinds.map(() => '?').join(',')})`);
    params.push(...f.kinds);
  }
  return ` AND ${parts.join(' AND ')}`;
}

/**
 * Session timeline (most recent first). `match` keeps the sessions whose name contains it, ignoring
 * case: the title, or for a session without one its provisional name (the `prompt`, see
 * promptTitle). Provisional names are computed, not stored, so with `match` the sessions are read
 * newest first, and the prompts of those without a title found, until the page is full.
 */
export function listSessions(
  db: Database,
  filter: Pick<EventFilter, 'source' | 'project' | 'since' | 'until' | 'limit' | 'offset'> & {
    match?: string;
    /**
     * Only sessions that are not folded under a visible parent. Timelines ask for this; other
     * callers list every session, children included.
     */
    topLevel?: boolean;
  } = {},
): SessionRow[] {
  const params: unknown[] = [];
  const parts: string[] = ['event_count > 0'];
  if (filter.topLevel) parts.push(TOP_LEVEL_SESSION);
  if (filter.source) {
    parts.push('source = ?');
    params.push(filter.source);
  }
  if (filter.project) {
    parts.push(
      `${resolvedProjectSql('session.source', 'session.session_id', 'session.project')} = ?`,
    );
    params.push(filter.project);
  }
  if (filter.since !== undefined) {
    parts.push('ended_at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    parts.push('started_at <= ?');
    params.push(filter.until);
  }
  const where = `WHERE ${parts.join(' AND ')}`;
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const prompt = promptFinder(db);
  const match = filter.match?.trim().toLocaleLowerCase() ?? '';
  if (match === '') {
    params.push(limit, offset);
    const rows = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM session ${where}
         ORDER BY COALESCE(ended_at, 0) DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[])) as unknown as SessionRecord[];
    return rows.map((r) => toSessionRow(r, prompt));
  }
  const rows = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM session ${where} ORDER BY COALESCE(ended_at, 0) DESC`)
    .all(...(params as never[])) as unknown as SessionRecord[];
  const out: SessionRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.title !== null && !r.title.toLocaleLowerCase().includes(match)) continue;
    const row = toSessionRow(r, prompt);
    if (r.title === null && !(row.prompt ?? '').toLocaleLowerCase().includes(match)) continue;
    if (skipped < offset) {
      skipped++;
      continue;
    }
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The first prompt of a session's owner (see isOwnerPrompt), from its visible user messages in time
 * order: computed when sessions are read, so that forgetting the event it came from drops it too
 * (invariant 2).
 */
function promptFinder(db: Database): (source: string, sessionId: string) => string | null {
  let stmt: ReturnType<Database['prepare']> | null = null;
  return (source, sessionId) => {
    stmt ??= db.prepare(USER_MESSAGES);
    for (const r of stmt.iterate(source, sessionId) as Iterable<UserMessage>) {
      if (isOwnerPrompt(asInput(r))) return promptTitle(r.text);
    }
    return null;
  };
}

/** A position in a session's events, in time order: a timestamp, then the order of arrival. */
export interface EventPosition {
  ts: number;
  seq: number;
}

/** A prompt of a session: a turn of the conversation starts with it (see sessionPrompts). */
export interface SessionPrompt extends EventPosition {
  id: string;
  /** The prompt, cut short as a provisional name is (see promptTitle). */
  prompt: string;
  /** Who wrote it (see authors.ts): the owner, for a prompt; the system, as a rule, for a command. */
  author: Author;
  speaker: string | null;
}

/**
 * The prompts of a session, in time order: its visible prompts of the owner (see isOwnerPrompt),
 * which a sub-agent's, an agent's, a program's, or another person's message never is. Read through
 * the index of user messages (event_user_message), so that the turns of a long session are found
 * without reading its other events.
 */
export function sessionPrompts(db: Database, source: string, sessionId: string): SessionPrompt[] {
  const out: SessionPrompt[] = [];
  for (const r of userMessages(db, source, sessionId)) {
    if (!isOwnerPrompt(asInput(r))) continue;
    out.push({ ...positionOf(r), prompt: promptTitle(r.text) as string });
  }
  return out;
}

/** A user message of a session, with its effective author (see authors.ts). */
interface UserMessage {
  id: string;
  seq: number;
  ts: number;
  text: string;
  author: Author;
  speaker: string | null;
}

/** A session's visible user messages, in time order, through event_user_message. */
const USER_MESSAGES = `SELECT e.id, e.seq, e.ts, e.text, (${AUTHOR_SQL}) AS author,
    (${SPEAKER_SQL}) AS speaker
  FROM event e INDEXED BY event_user_message
  WHERE e.source = ? AND e.session_id = ? AND e.role = 'user' AND e.kind = 'message'
    AND ${VISIBLE_EVENT}
  ORDER BY e.ts, e.seq`;

function userMessages(db: Database, source: string, sessionId: string): UserMessage[] {
  return db.prepare(USER_MESSAGES).all(source, sessionId) as unknown as UserMessage[];
}

const asInput = (r: UserMessage) => ({ ...r, role: 'user', kind: 'message' });

const positionOf = (r: UserMessage) => ({
  id: r.id,
  seq: r.seq,
  ts: r.ts,
  author: r.author,
  speaker: r.speaker,
});

/**
 * Whether a session is the owner's conversation: whether it has a visible prompt of the owner (see
 * isOwnerPrompt). A child session, a session that has a parent, or a headless run never is; nor is
 * one of other people's words alone. Briefs list only the owner's conversations, and only they join
 * threads by their branch. An upgrade still on an earlier version has not created session_kind
 * (version 8) or session_parent (version 10); that exclusion is left out until the table exists.
 */
export function isOwnerConversation(db: Database, source: string, sessionId: string): boolean {
  const kind = db.hasTable('session_kind');
  const parent = db.hasTable('session_parent');
  const sql =
    kind && parent
      ? OWNER_CONVERSATION
      : `SELECT 1 FROM event e INDEXED BY event_user_message
  WHERE e.source = ? AND e.session_id = ? AND e.role = 'user' AND e.kind = 'message'
    ${
      kind
        ? `AND NOT EXISTS (SELECT 1 FROM session_kind k
      WHERE k.source = e.source AND k.session_id = e.session_id)`
        : ''
    }
    ${
      parent
        ? `AND NOT EXISTS (SELECT 1 FROM session_parent p
      WHERE p.source = e.source AND p.session_id = e.session_id)`
        : ''
    }
    AND ${VISIBLE_EVENT} AND ${OWNER_PROMPT_SQL}
  LIMIT 1`;
  return db.prepare(sql).get(source, sessionId) !== undefined;
}

const OWNER_CONVERSATION = `SELECT 1 FROM event e INDEXED BY event_user_message
  WHERE e.source = ? AND e.session_id = ? AND e.role = 'user' AND e.kind = 'message'
    AND NOT EXISTS (SELECT 1 FROM session_kind k
      WHERE k.source = e.source AND k.session_id = e.session_id)
    AND NOT EXISTS (SELECT 1 FROM session_parent p
      WHERE p.source = e.source AND p.session_id = e.session_id)
    AND ${VISIBLE_EVENT} AND ${OWNER_PROMPT_SQL}
  LIMIT 1`;

/** At most this many characters of a command and its arguments name a turn. */
const COMMAND_MAX = 200;

/**
 * The command a user message echoes, with its arguments (`/review PR 12`), or null: a message made
 * only of XML-style elements (see promptTitle) among which Claude Code's `<command-name>`, with its
 * `<command-args>`.
 */
export function commandLine(text: string): string | null {
  if (promptTitle(text) !== null) return null;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  const line = `${name}${args ? ` ${args}` : ''}`.replace(/\s+/g, ' ');
  return line.length > COMMAND_MAX ? `${line.slice(0, COMMAND_MAX - 1).trimEnd()}…` : line;
}

/** Where a turn starts: a prompt, or a command that set the agent to work (see sessionTurnStarts). */
export interface TurnStart extends SessionPrompt {
  /** Whether the turn starts at a command; `prompt` is then the command and its arguments. */
  command: boolean;
}

/**
 * Where a session's turns start, in time order: at each of its prompts (see sessionPrompts), and at
 * each command it echoes (see commandLine), unless a sub-agent's (its author is the agent), that the
 * agent acted on, with a message or a tool call of its own (not a sub-agent's), before the next
 * prompt or command. A command the agent did not act on, such as `/clear` or `/model`, starts no
 * turn. Prompts come from the index of user messages; each command costs one look into the
 * `(source, session_id, ts)` index, up to the agent's first event after it. A prompt is cut to
 * `chars` characters (PROMPT_TITLE_MAX by default).
 */
export function sessionTurnStarts(
  db: Database,
  source: string,
  sessionId: string,
  opts: { chars?: number } = {},
): TurnStart[] {
  const candidates: TurnStart[] = [];
  for (const r of userMessages(db, source, sessionId)) {
    if (isOwnerPrompt(asInput(r))) {
      const prompt = promptTitle(r.text, opts.chars) as string;
      candidates.push({ ...positionOf(r), prompt, command: false });
      continue;
    }
    const command = r.author === 'agent' ? null : commandLine(r.text);
    if (command !== null) candidates.push({ ...positionOf(r), prompt: command, command: true });
  }
  if (!candidates.some((c) => c.command)) return candidates;
  const agent = `e.source = ? AND e.session_id = ? AND e.ts >= ? AND (e.ts > ? OR e.seq > ?)
    AND e.role = 'assistant' AND e.kind IN ('message', 'tool_use')
    AND (e.meta IS NULL OR json_extract(e.meta, '$.sidechain') IS NOT 1) AND ${VISIBLE_EVENT}`;
  const before = db.prepare(
    `SELECT 1 FROM event e WHERE ${agent} AND e.ts <= ? AND (e.ts < ? OR e.seq < ?) LIMIT 1`,
  );
  const after = db.prepare(`SELECT 1 FROM event e WHERE ${agent} LIMIT 1`);
  return candidates.filter((c, i) => {
    if (!c.command) return true;
    const next = candidates[i + 1];
    const from = [source, sessionId, c.ts, c.ts, c.seq];
    return next
      ? before.get(...from, next.ts, next.ts, next.seq) !== undefined
      : after.get(...from) !== undefined;
  });
}

/**
 * The visible events of a session from position `from` (inclusive) up to `to` (exclusive), in time
 * order, through the `(source, session_id, ts)` index; either end may be left open. Pages of a
 * session by turns read one range of its events (see sessionPrompts).
 */
export function listSessionEvents(
  db: Database,
  o: {
    source: string;
    sessionId: string;
    from?: EventPosition | null;
    to?: EventPosition | null;
    limit?: number;
    offset?: number;
  },
): EventRow[] {
  const params: unknown[] = [o.source, o.sessionId];
  let where = '';
  if (o.from) {
    where += ' AND e.ts >= ? AND (e.ts > ? OR e.seq >= ?)';
    params.push(o.from.ts, o.from.ts, o.from.seq);
  }
  if (o.to) {
    where += ' AND e.ts <= ? AND (e.ts < ? OR e.seq < ?)';
    params.push(o.to.ts, o.to.ts, o.to.seq);
  }
  params.push(o.limit ?? 200, o.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.source = ? AND e.session_id = ?${where} AND ${VISIBLE_EVENT}
        ORDER BY e.ts, e.seq LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as RawEventRecord[];
  return rows.map(toEventRow);
}

/**
 * The agent version recorded most recently for each source: from the events of its latest
 * sessions (at most five per source, through the `(source, session_id, ts)` index), so that no
 * query reads a source's events at large. A source whose latest sessions record none is left out.
 */
export function latestAgentVersions(db: Database): Map<string, string> {
  const sessions = db
    .prepare(
      `SELECT source, session_id FROM (
         SELECT source, session_id,
                ROW_NUMBER() OVER (PARTITION BY source ORDER BY ended_at DESC) AS n
           FROM session WHERE event_count > 0)
        WHERE n <= 5 ORDER BY source, n`,
    )
    .all() as unknown as Array<{ source: string; session_id: string }>;
  const version = db.prepare(
    `SELECT e.agent_version AS v FROM event e
      WHERE e.source = ? AND e.session_id = ? AND e.agent_version IS NOT NULL AND ${VISIBLE_EVENT}
      ORDER BY e.ts DESC, e.seq DESC LIMIT 1`,
  );
  const out = new Map<string, string>();
  for (const s of sessions) {
    if (out.has(s.source)) continue;
    const row = version.get(s.source, s.session_id) as { v: string } | undefined;
    if (row) out.set(s.source, row.v);
  }
  return out;
}

const SESSION_COLUMNS = `source, session_id,
  ${resolvedProjectSql('session.source', 'session.session_id', 'session.project')} AS project,
  cwd, title, started_at, ended_at, event_count,
  (SELECT t.thread_id FROM session_thread t
    WHERE t.source = session.source AND t.session_id = session.session_id) AS thread_id`;

interface SessionRecord {
  source: string;
  session_id: string;
  project: string | null;
  cwd: string | null;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  event_count: number;
  thread_id: string | null;
}

function toSessionRow(
  r: SessionRecord,
  prompt: (source: string, sessionId: string) => string | null,
): SessionRow {
  return {
    source: r.source,
    sessionId: r.session_id,
    project: r.project,
    cwd: r.cwd,
    title: r.title,
    prompt: r.title === null ? prompt(r.source, r.session_id) : null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    eventCount: r.event_count,
    thread: r.thread_id,
  };
}

/**
 * The sessions of a thread (see threads.ts) with visible events, oldest first by when they started
 * (then source and id), from `offset` on, at most `limit`.
 */
export function listThreadSessions(
  db: Database,
  threadId: string,
  opts: { limit?: number; offset?: number } = {},
): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM session
        WHERE (source, session_id) IN
            (SELECT t.source, t.session_id FROM session_thread t WHERE t.thread_id = ?)
          AND event_count > 0
        ORDER BY started_at, source, session_id LIMIT ? OFFSET ?`,
    )
    .all(threadId, opts.limit ?? -1, opts.offset ?? 0) as unknown as SessionRecord[];
  const prompt = promptFinder(db);
  return rows.map((r) => toSessionRow(r, prompt));
}

/** One session with visible events, or null (a session whose events were all forgotten is hidden). */
export function getSession(db: Database, source: string, sessionId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM session
       WHERE source = ? AND session_id = ? AND event_count > 0`,
    )
    .get(source, sessionId) as SessionRecord | undefined;
  return row ? toSessionRow(row, promptFinder(db)) : null;
}

/** The sources that have a session with this id and visible events in it, by name. */
export function sessionSources(db: Database, sessionId: string): string[] {
  return (
    db
      .prepare(
        'SELECT source FROM session WHERE session_id = ? AND event_count > 0 ORDER BY source',
      )
      .all(sessionId) as unknown as Array<{ source: string }>
  ).map((r) => r.source);
}

/** The key of a session in sessionNames: its source and id. */
export const sessionKey = (source: string, sessionId: string) => `${source}\n${sessionId}`;

/**
 * The names of several sessions (see sessionKey), as one session's title or, without one, its
 * provisional name (see promptTitle); null for a session with neither, or with no visible events.
 * The titles come from one query; the prompts of those without a title, one look per session.
 */
export function sessionNames(
  db: Database,
  sessions: Array<{ source: string; sessionId: string }>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const keys = [...new Map(sessions.map((s) => [sessionKey(s.source, s.sessionId), s])).values()];
  if (keys.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT source, session_id, title FROM session
        WHERE event_count > 0 AND (source, session_id) IN
          (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`,
    )
    .all(JSON.stringify(keys.map((k) => [k.source, k.sessionId]))) as unknown as Array<{
    source: string;
    session_id: string;
    title: string | null;
  }>;
  const prompt = promptFinder(db);
  for (const r of rows) {
    out.set(sessionKey(r.source, r.session_id), r.title ?? prompt(r.source, r.session_id));
  }
  return out;
}

/** List events in chronological order. */
export function listEvents(db: Database, filter: EventFilter = {}): EventRow[] {
  const params: unknown[] = [];
  const where = whereClause(filter, params);
  params.push(filter.limit ?? 200, filter.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM event e WHERE 1 = 1${where} ORDER BY e.ts ASC, e.seq ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as RawEventRecord[];
  return rows.map(toEventRow);
}

/** A visible event by id; forgotten events are reported as missing. */
export function getEvent(db: Database, id: string): EventRow | null {
  const row = db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM event e WHERE e.id = ? AND ${VISIBLE_EVENT}`)
    .get(id) as RawEventRecord | undefined;
  return row ? toEventRow(row) : null;
}

/**
 * An event by id, forgotten or not: only for the owner's view of what a forget hides (see
 * tombstones.ts). Every other read uses getEvent.
 */
export function loadEvent(db: Database, id: string): EventRow | null {
  const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM event e WHERE e.id = ?`).get(id) as
    | RawEventRecord
    | undefined;
  return row ? toEventRow(row) : null;
}

export interface RawLocator {
  /** The raw file (one generation of the original file) the event was parsed from. */
  rawFileId: number;
  source: string;
  /** Device the file was replicated from (on a hub); null for this store's own files. */
  device: string | null;
  /** Absolute path of the source agent's original file (on that device). */
  originalPath: string;
  generation: number;
  /**
   * Absolute path of the mirror (the append-only copy). Its content is stored compressed, in
   * `<mirrorPath>.zst` and `<mirrorPath>.tail` (see mirror.ts); read it with readRawLine.
   */
  mirrorPath: string;
  /** 1-based line number in the mirror. */
  line: number;
}

/**
 * The agent version recorded for the latest event parsed from a raw file, or null. A device sends
 * it with the file's lines, so that a hub records the same version for events whose lines carry
 * none (the adapter's version at the time, see SourceAdapter.version).
 */
export function recordedAgentVersion(db: Database, rawFileId: number): string | null {
  const row = db
    .prepare(
      `SELECT agent_version AS v FROM event
         WHERE raw_file_id = ? AND agent_version IS NOT NULL ORDER BY seq DESC LIMIT 1`,
    )
    .get(rawFileId) as { v: string } | undefined;
  return row?.v ?? null;
}

/** Raw locator for an event (invariant 1, provenance: expandable to the original text). */
export function rawLocator(db: Database, home: string, event: EventRow): RawLocator | null {
  const row = db
    .prepare('SELECT source, path, generation, mirror FROM raw_file WHERE id = ?')
    .get(event.rawFileId) as
    | { source: string; path: string; generation: number; mirror: string }
    | undefined;
  if (!row) return null;
  const { device, originalPath } = parseRawPath(row.path);
  return {
    rawFileId: event.rawFileId,
    source: row.source,
    device,
    originalPath,
    generation: row.generation,
    mirrorPath: path.join(rawDir(home), row.mirror),
    line: event.rawLine,
  };
}

/** The original line an event points to, read from its mirror; null if it is missing. */
export function readRawLine(db: Database, home: string, locator: RawLocator): string | null {
  return readMirrorLine(db, home, locator.rawFileId, locator.line);
}

export interface SourceStats {
  source: string;
  sessions: number;
  /** Sessions with a title of their own. */
  titled: number;
  events: number;
  firstTs: number | null;
  lastTs: number | null;
  lastSyncAt: number | null;
  lastSyncEventsAdded: number | null;
  files: number;
}

/**
 * Totals per source. Sessions, events, and the time range come from the derived session table,
 * which aggregates visible events only, so this never scans the events themselves.
 */
export function stats(db: Database): SourceStats[] {
  const rows = db
    .prepare(
      `SELECT s.source AS source,
              COUNT(*) AS sessions,
              COUNT(s.title) AS titled,
              SUM(s.event_count) AS events,
              MIN(s.started_at) AS first_ts,
              MAX(s.ended_at) AS last_ts,
              (SELECT COUNT(*) FROM raw_file r WHERE r.source = s.source) AS files,
              (SELECT finished_at FROM sync_log l WHERE l.source = s.source ORDER BY id DESC LIMIT 1) AS last_sync_at,
              (SELECT events_added FROM sync_log l WHERE l.source = s.source ORDER BY id DESC LIMIT 1) AS last_added
       FROM session s WHERE s.event_count > 0 GROUP BY s.source ORDER BY s.source`,
    )
    .all() as unknown as Array<{
    source: string;
    sessions: number;
    titled: number;
    events: number;
    first_ts: number | null;
    last_ts: number | null;
    files: number;
    last_sync_at: number | null;
    last_added: number | null;
  }>;
  return rows.map((r) => ({
    source: r.source,
    sessions: r.sessions,
    titled: r.titled,
    events: r.events,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    files: r.files,
    lastSyncAt: r.last_sync_at,
    lastSyncEventsAdded: r.last_added,
  }));
}

/** Whether an event exists but has been forgotten. */
export function isEventForgotten(db: Database, id: string): boolean {
  return db.prepare('SELECT 1 FROM excluded_event WHERE event_id = ?').get(id) !== undefined;
}

/** Known project names (by session and event count, descending; from the derived session table). */
export function listProjects(
  db: Database,
  limit = 50,
): Array<{ project: string; sessions: number; events: number }> {
  return db
    .prepare(
      `SELECT ${resolvedProjectSql('session.source', 'session.session_id', 'session.project')} AS project,
              COUNT(*) AS sessions, SUM(event_count) AS events FROM session
       WHERE ${resolvedProjectSql('session.source', 'session.session_id', 'session.project')} IS NOT NULL
         AND event_count > 0
       GROUP BY 1 ORDER BY sessions DESC, events DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ project: string; sessions: number; events: number }>;
}
