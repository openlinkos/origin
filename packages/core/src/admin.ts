import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { secretHash } from './tokens.js';

/**
 * Admin UI sessions (see docs/architecture.md#admin-ui). The hub has one admin password and no
 * user names (see password.ts), so every session belongs to its owner.
 */
export const ADMIN_OWNER = 'owner';
/** A session ends after this long without a request. */
export const ADMIN_SESSION_IDLE_MS = 30 * 60_000;
/** A session ends this long after sign-in, however active. */
export const ADMIN_SESSION_MAX_MS = 12 * 3_600_000;
/** Sensitive actions need the password to have been entered this recently (sign-in or re-authentication). */
export const ADMIN_FRESH_MS = 10 * 60_000;

const TOUCH_RESOLUTION = 10_000;
const SESSION_RETENTION_MS = 30 * 86_400_000;

/** An admin session as listed: never its id or CSRF token. */
export interface AdminSessionInfo {
  /** A short, non-secret handle: the first 16 hex digits of the session id's hash. */
  handle: string;
  createdAt: number;
  lastSeenAt: number;
  /** When the password was last entered for this session (sign-in or re-authentication). */
  freshAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** A verified session, as the admin UI uses it. */
export interface AdminSession extends AdminSessionInfo {
  idHash: string;
  csrf: string;
}

/**
 * A row of admin_session. Its `key_name` column predates the single admin password; it now always
 * holds ADMIN_OWNER, and sessions with any other value (from earlier versions) are not valid.
 */
interface SessionRecord {
  id_hash: string;
  key_name: string;
  csrf: string;
  created_at: number;
  last_seen_at: number;
  fresh_at: number;
  ip: string | null;
  user_agent: string | null;
}

const SESSION_COLUMNS =
  'id_hash, key_name, csrf, created_at, last_seen_at, fresh_at, ip, user_agent';

function toInfo(r: SessionRecord): AdminSessionInfo {
  return {
    handle: r.id_hash.slice(0, 16),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    freshAt: r.fresh_at,
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

function toSession(r: SessionRecord): AdminSession {
  return { ...toInfo(r), idHash: r.id_hash, csrf: r.csrf };
}

function clipped(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Start a session after the admin password was verified. Returns the session id, which goes into
 * the cookie and is never stored (only its hash is), and the session with its CSRF token.
 */
export function createAdminSession(
  db: Database,
  input: { ip?: string | null; userAgent?: string | null } = {},
  now = Date.now(),
): { id: string; session: AdminSession } {
  db.prepare('DELETE FROM admin_session WHERE created_at < ?').run(now - SESSION_RETENTION_MS);
  const id = randomBytes(32).toString('base64url');
  const record: SessionRecord = {
    id_hash: secretHash(id),
    key_name: ADMIN_OWNER,
    csrf: randomBytes(32).toString('base64url'),
    created_at: now,
    last_seen_at: now,
    fresh_at: now,
    ip: clipped(input.ip, 64),
    user_agent: clipped(input.userAgent, 256),
  };
  db.prepare(`INSERT INTO admin_session (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id_hash,
    record.key_name,
    record.csrf,
    record.created_at,
    record.last_seen_at,
    record.fresh_at,
    record.ip,
    record.user_agent,
  );
  return { id, session: toSession(record) };
}

/** Whether a session is live at `now`: the owner's, not idle too long, and not too old. */
function live(r: SessionRecord, now: number): boolean {
  return (
    r.key_name === ADMIN_OWNER &&
    now - r.last_seen_at < ADMIN_SESSION_IDLE_MS &&
    now - r.created_at < ADMIN_SESSION_MAX_MS
  );
}

/**
 * The live session for a session id, or null when it is unknown, ended (by signing out, or by a
 * change of the admin password), or expired (idle or absolute). Records activity, at most every
 * few seconds.
 */
export function getAdminSession(
  db: Database,
  id: string,
  opts: { now?: number } = {},
): AdminSession | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  const now = opts.now ?? Date.now();
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM admin_session WHERE id_hash = ? AND ended_at IS NULL`)
    .get(secretHash(id)) as SessionRecord | undefined;
  if (!row || !live(row, now)) return null;
  if (now - row.last_seen_at >= TOUCH_RESOLUTION) {
    db.prepare('UPDATE admin_session SET last_seen_at = ? WHERE id_hash = ?').run(now, row.id_hash);
    row.last_seen_at = now;
  }
  return toSession(row);
}

/** Whether the password was entered for this session recently enough for a sensitive action. */
export function isAdminSessionFresh(session: AdminSessionInfo, now = Date.now()): boolean {
  return now - session.freshAt <= ADMIN_FRESH_MS;
}

/** Record that the password was entered again for this session. */
export function markAdminSessionFresh(db: Database, idHash: string, now = Date.now()): void {
  db.prepare(
    'UPDATE admin_session SET fresh_at = ?, last_seen_at = ? WHERE id_hash = ? AND ended_at IS NULL',
  ).run(now, now, idHash);
}

/** End one session (sign-out); false if it had already ended. */
export function endAdminSession(db: Database, idHash: string, now = Date.now()): boolean {
  return (
    db
      .prepare('UPDATE admin_session SET ended_at = ? WHERE id_hash = ? AND ended_at IS NULL')
      .run(now, idHash).changes > 0
  );
}

/**
 * End live sessions: the one with a given handle, or all of them, optionally except one (the
 * caller's own). Returns how many were ended.
 */
export function endAdminSessions(
  db: Database,
  filter: { handle?: string; exceptIdHash?: string } = {},
  now = Date.now(),
): number {
  const parts = ['ended_at IS NULL', 'last_seen_at > ?', 'created_at > ?'];
  const params: Array<string | number> = [now - ADMIN_SESSION_IDLE_MS, now - ADMIN_SESSION_MAX_MS];
  if (filter.handle !== undefined) {
    if (!/^[0-9a-f]{16}$/.test(filter.handle)) return 0;
    parts.push('substr(id_hash, 1, 16) = ?');
    params.push(filter.handle);
  }
  if (filter.exceptIdHash !== undefined) {
    parts.push('id_hash <> ?');
    params.push(filter.exceptIdHash);
  }
  const info = db
    .prepare(`UPDATE admin_session SET ended_at = ? WHERE ${parts.join(' AND ')}`)
    .run(now, ...params);
  return Number(info.changes);
}

/** Live sessions, most recently active first. */
export function listAdminSessions(db: Database, opts: { now?: number } = {}): AdminSessionInfo[] {
  const now = opts.now ?? Date.now();
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM admin_session WHERE ended_at IS NULL
       ORDER BY last_seen_at DESC`,
    )
    .all() as unknown as SessionRecord[];
  return rows.filter((r) => live(r, now)).map(toInfo);
}
