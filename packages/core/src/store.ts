import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './db.js';
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
  return rows.map(toSessionRow);
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

function toSessionRow(r: SessionRecord): SessionRow {
  return {
    source: r.source,
    sessionId: r.session_id,
    project: r.project,
    cwd: r.cwd,
    title: r.title,
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
  return row ? toSessionRow(row) : null;
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
  source: string;
  /** Device the file was replicated from (on a hub); null for this store's own files. */
  device: string | null;
  /** Absolute path of the source agent's original file (on that device). */
  originalPath: string;
  generation: number;
  /** Absolute path of the mirror file (append-only copy). */
  mirrorPath: string;
  /** 1-based line number in the mirror. */
  line: number;
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
    source: row.source,
    device,
    originalPath,
    generation: row.generation,
    mirrorPath: path.join(rawDir(home), row.mirror),
    line: event.rawLine,
  };
}

/** Read an original line from the mirror (1-based). A sequential scan is fine since mirrors are append-only. */
export function readRawLine(locator: RawLocator): string | null {
  if (!fs.existsSync(locator.mirrorPath)) return null;
  const content = fs.readFileSync(locator.mirrorPath, 'utf8');
  let lineNo = 0;
  let start = 0;
  while (start <= content.length) {
    const nl = content.indexOf('\n', start);
    const end = nl < 0 ? content.length : nl;
    lineNo++;
    if (lineNo === locator.line) return content.slice(start, end).replace(/\r$/, '');
    if (nl < 0) break;
    start = nl + 1;
  }
  return null;
}

export interface SourceStats {
  source: string;
  sessions: number;
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
