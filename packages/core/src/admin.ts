import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { checkName, newSecret, secretHash } from './tokens.js';

/**
 * Admin UI sign-in keys and sessions (see docs/architecture.md#admin-ui). Keys are issued on the hub
 * with `origin admin key create`, shown once, and stored only as SHA-256 hashes. They start with
 * `oga_`, hub access tokens with `ogn_`, and neither is ever accepted in place of the other.
 */
export const ADMIN_KEY_PREFIX = 'oga_';
/** A session ends after this long without a request. */
export const ADMIN_SESSION_IDLE_MS = 30 * 60_000;
/** A session ends this long after sign-in, however active. */
export const ADMIN_SESSION_MAX_MS = 12 * 3_600_000;
/** Sensitive actions need the key to have been entered this recently (sign-in or re-authentication). */
export const ADMIN_FRESH_MS = 10 * 60_000;
/** Keys configured as hashes in the environment are named `env:<first 8 hex digits of the hash>`. */
export const ENV_KEY_PREFIX = 'env:';

const LAST_USED_RESOLUTION = 60_000;
const TOUCH_RESOLUTION = 10_000;
const SESSION_RETENTION_MS = 30 * 86_400_000;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface AdminKeyInfo {
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** An admin session as listed: never its id or CSRF token. */
export interface AdminSessionInfo {
  /** A short, non-secret handle: the first 16 hex digits of the session id's hash. */
  handle: string;
  keyName: string;
  createdAt: number;
  lastSeenAt: number;
  /** When the key was last entered for this session (sign-in or re-authentication). */
  freshAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** A verified session, as the admin UI uses it. */
export interface AdminSession extends AdminSessionInfo {
  idHash: string;
  csrf: string;
}

/** Options for the key checks behind sessions: hashes configured in ORIGIN_ADMIN_KEY_SHA256. */
export interface AdminKeyOptions {
  envHashes?: readonly string[];
  now?: number;
}

/** Parse ORIGIN_ADMIN_KEY_SHA256: comma-separated SHA-256 hashes in hex. */
export function parseAdminKeyHashes(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) return [];
  const hashes = value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  for (const h of hashes) {
    if (!HASH_RE.test(h)) {
      throw new OriginError(
        'ORIGIN_ADMIN_KEY_SHA256 must list SHA-256 hashes as 64 hex digits, separated by commas.',
      );
    }
  }
  return [...new Set(hashes)];
}

/** The name under which a key configured by its hash appears in sessions and the audit log. */
export function envAdminKeyName(hash: string): string {
  return `${ENV_KEY_PREFIX}${hash.slice(0, 8)}`;
}

/** Create an admin key. It is returned once; only its SHA-256 hash is stored. */
export function createAdminKey(db: Database, name: string, now = Date.now()): string {
  checkName(name, 'admin key');
  if (db.prepare('SELECT 1 FROM admin_key WHERE name = ?').get(name)) {
    throw new OriginError(
      `An admin key named "${name}" exists or was revoked; choose another name.`,
    );
  }
  const key = newSecret(ADMIN_KEY_PREFIX);
  db.prepare('INSERT INTO admin_key (name, hash, created_at) VALUES (?, ?, ?)').run(
    name,
    secretHash(key),
    now,
  );
  return key;
}

export function listAdminKeys(db: Database): AdminKeyInfo[] {
  const rows = db
    .prepare('SELECT name, created_at, last_used_at, revoked_at FROM admin_key ORDER BY name')
    .all() as unknown as Array<{
    name: string;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
  }>;
  return rows.map((r) => ({
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

/**
 * Revoke an admin key and end its sessions; false if it is unknown or already revoked. Revoked
 * names cannot be reused.
 */
export function revokeAdminKey(db: Database, name: string, now = Date.now()): boolean {
  const info = db
    .prepare('UPDATE admin_key SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
    .run(now, name);
  if (info.changes === 0) return false;
  endAdminSessions(db, { keyName: name }, now);
  return true;
}

/**
 * The admin key matching `key`, or null: an active key from the store, or one whose hash is
 * configured in the environment. Hub access tokens (`ogn_`) are never accepted.
 */
export function verifyAdminKey(
  db: Database,
  key: string,
  opts: AdminKeyOptions = {},
): { name: string } | null {
  if (typeof key !== 'string' || !key.startsWith(ADMIN_KEY_PREFIX)) return null;
  const now = opts.now ?? Date.now();
  const hash = secretHash(key);
  if (opts.envHashes?.includes(hash)) return { name: envAdminKeyName(hash) };
  const row = db
    .prepare('SELECT name, last_used_at FROM admin_key WHERE hash = ? AND revoked_at IS NULL')
    .get(hash) as { name: string; last_used_at: number | null } | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION) {
    db.prepare('UPDATE admin_key SET last_used_at = ? WHERE name = ?').run(now, row.name);
  }
  return { name: row.name };
}

/** Whether the key behind a session is still valid. */
function keyActive(db: Database, keyName: string, envHashes: readonly string[]): boolean {
  if (keyName.startsWith(ENV_KEY_PREFIX)) {
    return envHashes.some((h) => envAdminKeyName(h) === keyName);
  }
  return (
    db.prepare('SELECT 1 FROM admin_key WHERE name = ? AND revoked_at IS NULL').get(keyName) !==
    undefined
  );
}

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

function toSession(r: SessionRecord): AdminSession {
  return {
    handle: r.id_hash.slice(0, 16),
    idHash: r.id_hash,
    keyName: r.key_name,
    csrf: r.csrf,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    freshAt: r.fresh_at,
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

function clipped(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Start a session for a verified key. Returns the session id, which goes into the cookie and is
 * never stored (only its hash is), and the session with its CSRF token.
 */
export function createAdminSession(
  db: Database,
  input: { keyName: string; ip?: string | null; userAgent?: string | null },
  now = Date.now(),
): { id: string; session: AdminSession } {
  db.prepare('DELETE FROM admin_session WHERE created_at < ?').run(now - SESSION_RETENTION_MS);
  const id = randomBytes(32).toString('base64url');
  const record: SessionRecord = {
    id_hash: secretHash(id),
    key_name: input.keyName,
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

/** Whether a session is live at `now`: not idle too long and not too old. */
function live(r: SessionRecord, now: number): boolean {
  return now - r.last_seen_at < ADMIN_SESSION_IDLE_MS && now - r.created_at < ADMIN_SESSION_MAX_MS;
}

/**
 * The live session for a session id, or null when it is unknown, ended, expired (idle or
 * absolute), or its key has been revoked. Records activity, at most every few seconds.
 */
export function getAdminSession(
  db: Database,
  id: string,
  opts: AdminKeyOptions = {},
): AdminSession | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  const now = opts.now ?? Date.now();
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM admin_session WHERE id_hash = ? AND ended_at IS NULL`)
    .get(secretHash(id)) as SessionRecord | undefined;
  if (!row || !live(row, now) || !keyActive(db, row.key_name, opts.envHashes ?? [])) return null;
  if (now - row.last_seen_at >= TOUCH_RESOLUTION) {
    db.prepare('UPDATE admin_session SET last_seen_at = ? WHERE id_hash = ?').run(now, row.id_hash);
    row.last_seen_at = now;
  }
  return toSession(row);
}

/** Whether the key was entered for this session recently enough for a sensitive action. */
export function isAdminSessionFresh(session: AdminSessionInfo, now = Date.now()): boolean {
  return now - session.freshAt <= ADMIN_FRESH_MS;
}

/** Record that the key was entered again for this session. */
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
 * End live sessions: those of one key, the one with a given handle, or all of them, optionally
 * except one (the caller's own). Returns how many were ended.
 */
export function endAdminSessions(
  db: Database,
  filter: { keyName?: string; handle?: string; exceptIdHash?: string } = {},
  now = Date.now(),
): number {
  const parts = ['ended_at IS NULL', 'last_seen_at > ?', 'created_at > ?'];
  const params: Array<string | number> = [now - ADMIN_SESSION_IDLE_MS, now - ADMIN_SESSION_MAX_MS];
  if (filter.keyName !== undefined) {
    parts.push('key_name = ?');
    params.push(filter.keyName);
  }
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
export function listAdminSessions(db: Database, opts: AdminKeyOptions = {}): AdminSessionInfo[] {
  const now = opts.now ?? Date.now();
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM admin_session WHERE ended_at IS NULL
       ORDER BY last_seen_at DESC`,
    )
    .all() as unknown as SessionRecord[];
  return rows
    .filter((r) => live(r, now) && keyActive(db, r.key_name, opts.envHashes ?? []))
    .map((r) => ({
      handle: r.id_hash.slice(0, 16),
      keyName: r.key_name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      freshAt: r.fresh_at,
      ip: r.ip,
      userAgent: r.user_agent,
    }));
}
