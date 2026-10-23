import path from 'node:path';
import type { Database } from './db.js';
import { readMirrorLine } from './mirror.js';
import { parseRawPath, rawDir } from './paths.js';
import type { EventKind, EventRow, Role, SessionRow } from './types.js';

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

export const EVENT_COLUMNS = `e.id, e.source, e.session_id, e.parent_id, e.ts, e.project, e.cwd, e.git_branch,
  e.role, e.kind, e.text, e.raw_file_id, e.raw_line, e.agent_version, e.meta`;

/** Forgotten events are excluded from every query (invariant 2, sticky forgetting). */
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
  };
}

function whereClause(f: EventFilter, params: unknown[]): string {
  const parts: string[] = [VISIBLE_EVENT];
  if (f.source) {
    parts.push('e.source = ?');
    params.push(f.source);
  }
  if (f.project) {
    parts.push('e.project = ?');
    params.push(f.project);
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

/** Session timeline (most recent first). */
export function listSessions(
  db: Database,
  filter: Pick<EventFilter, 'source' | 'project' | 'since' | 'until' | 'limit' | 'offset'> = {},
): SessionRow[] {
  const params: unknown[] = [];
  const parts: string[] = ['event_count > 0'];
  if (filter.source) {
    parts.push('source = ?');
    params.push(filter.source);
  }
  if (filter.project) {
    parts.push('project = ?');
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
  params.push(filter.limit ?? 50, filter.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM session ${where}
       ORDER BY COALESCE(ended_at, 0) DESC LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as SessionRecord[];
  const prompt = promptFinder(db);
  return rows.map((r) => toSessionRow(r, prompt));
}

/** At most this many characters of a prompt stand in for the name of a session without a title. */
export const PROMPT_TITLE_MAX = 80;

/** Text this long is no lone bracketed notice, and only its start can become a name. */
const PROMPT_HEAD = 1000;

/**
 * A user message as a provisional name for a session without a title, or null if it is not a
 * prompt the user typed. Agents add context and echo commands as user messages made of XML-style
 * elements (`<tag …>…</tag>`), such as Claude Code's `<command-name>`, `<local-command-stdout>`,
 * and `<local-command-caveat>`, or Codex's `<environment_context>`: the elements a message starts
 * with are skipped, and what follows them is the prompt. Nothing left, or only a bracketed notice
 * such as `[Request interrupted by user]`, is no prompt. Whitespace is collapsed, and the prompt cut
 * to PROMPT_TITLE_MAX characters.
 */
export function promptTitle(text: string): string | null {
  let rest = text;
  for (;;) {
    rest = rest.trimStart();
    const open = /^<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?\/?>/.exec(rest);
    if (!open) break;
    const [tag, name = ''] = open;
    if (tag.endsWith('/>')) {
      rest = rest.slice(tag.length);
      continue;
    }
    const close = rest.indexOf(`</${name}>`, tag.length);
    if (close < 0) break; // not an element: a prompt that starts with `<`
    rest = rest.slice(close + name.length + 3);
  }
  const long = rest.length > PROMPT_HEAD;
  const prompt = (long ? rest.slice(0, PROMPT_HEAD) : rest).replace(/\s+/g, ' ').trim();
  if (prompt.length === 0 || (!long && /^\[[^\]]*\]$/.test(prompt))) return null;
  const chars = [...prompt];
  if (chars.length <= PROMPT_TITLE_MAX) return prompt;
  return `${chars
    .slice(0, PROMPT_TITLE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * The first prompt of a session (see promptTitle), from its visible user messages in time order:
 * computed when sessions are read, so that forgetting the event it came from drops it too
 * (invariant 2).
 */
function promptFinder(db: Database): (source: string, sessionId: string) => string | null {
  let stmt: ReturnType<Database['prepare']> | null = null;
  return (source, sessionId) => {
    stmt ??= db.prepare(
      `SELECT e.text FROM event e
        WHERE e.source = ? AND e.session_id = ? AND e.role = 'user' AND e.kind = 'message'
          AND ${VISIBLE_EVENT}
        ORDER BY e.ts, e.seq`,
    );
    for (const row of stmt.iterate(source, sessionId) as Iterable<{ text: string }>) {
      const prompt = promptTitle(row.text);
      if (prompt !== null) return prompt;
    }
    return null;
  };
}

const SESSION_COLUMNS =
  'source, session_id, project, cwd, title, started_at, ended_at, event_count';

interface SessionRecord {
  source: string;
  session_id: string;
  project: string | null;
  cwd: string | null;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  event_count: number;
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
  };
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
      `SELECT project, COUNT(*) AS sessions, SUM(event_count) AS events FROM session
       WHERE project IS NOT NULL AND event_count > 0 GROUP BY project ORDER BY sessions DESC, events DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ project: string; sessions: number; events: number }>;
}
