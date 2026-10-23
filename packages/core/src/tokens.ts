import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { OriginError } from './errors.js';

/** Token and device names: lowercase ASCII, digits, `.`, `_`, `-`; at most 63 characters. */
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * Hub access tokens (devices and agents). The admin password can never start with it (see
 * password.ts). A token is bound to one device, the one it is named after: on the hub's
 * replication API it sends and receives data only for that device (see docs/architecture.md#access).
 */
export const TOKEN_PREFIX = 'ogn_';
const LAST_USED_RESOLUTION = 60_000;

export interface TokenInfo {
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** SHA-256 (hex) of a secret: the only form in which tokens and admin session ids are stored. */
export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** A new secret: `prefix` plus 32 random bytes in base64url. */
export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Throw unless `name` is a valid token or device name. */
export function checkName(name: string, what: string): void {
  if (!NAME_RE.test(name)) {
    throw new OriginError(
      `Invalid ${what} name "${name}": use lowercase letters, digits, ".", "_" or "-" (at most 63 characters).`,
    );
  }
}

/**
 * Create a hub access token for the device or agent `name`. The token is returned once; only its
 * SHA-256 hash is stored. A device keeps its name, so a revoked token can be replaced by a new one
 * of the same name (the revoked token stays invalid); an active token must be revoked first.
 */
export function createToken(db: Database, name: string, now = Date.now()): string {
  checkName(name, 'token');
  const existing = db.prepare('SELECT revoked_at FROM api_token WHERE name = ?').get(name) as
    | { revoked_at: number | null }
    | undefined;
  if (existing && existing.revoked_at === null) {
    throw new OriginError(
      `A token named "${name}" is active; revoke it first to give ${name} a new one.`,
    );
  }
  const token = newSecret(TOKEN_PREFIX);
  db.prepare(
    `INSERT INTO api_token (name, hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       hash = excluded.hash, created_at = excluded.created_at, last_used_at = NULL, revoked_at = NULL`,
  ).run(name, secretHash(token), now);
  return token;
}

/** The active token matching `token`, or null. Records use at most once a minute. */
export function verifyToken(
  db: Database,
  token: string,
  now = Date.now(),
): { name: string } | null {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = db
    .prepare('SELECT name, last_used_at FROM api_token WHERE hash = ? AND revoked_at IS NULL')
    .get(secretHash(token)) as { name: string; last_used_at: number | null } | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION) {
    db.prepare('UPDATE api_token SET last_used_at = ? WHERE name = ?').run(now, row.name);
  }
  return { name: row.name };
}

export function listTokens(db: Database): TokenInfo[] {
  const rows = db
    .prepare('SELECT name, created_at, last_used_at, revoked_at FROM api_token ORDER BY name')
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
 * Revoke a token; false if it is unknown or already revoked. The name stays listed as revoked until
 * a new token is created under it.
 */
export function revokeToken(db: Database, name: string, now = Date.now()): boolean {
  const info = db
    .prepare('UPDATE api_token SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
    .run(now, name);
  return info.changes > 0;
}
