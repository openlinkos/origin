import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { OriginError } from './errors.js';

/** Token and device names: lowercase ASCII, digits, `.`, `_`, `-`; at most 63 characters. */
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const TOKEN_PREFIX = 'ogn_';
const LAST_USED_RESOLUTION = 60_000;

export interface TokenInfo {
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create a hub access token. The token is returned once; only its SHA-256 hash is stored. */
export function createToken(db: Database, name: string, now = Date.now()): string {
  if (!NAME_RE.test(name)) {
    throw new OriginError(
      `Invalid token name "${name}": use lowercase letters, digits, ".", "_" or "-" (at most 63 characters).`,
    );
  }
  if (db.prepare('SELECT 1 FROM api_token WHERE name = ?').get(name)) {
    throw new OriginError(`A token named "${name}" exists or was revoked; choose another name.`);
  }
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO api_token (name, hash, created_at) VALUES (?, ?, ?)').run(
    name,
    hashToken(token),
    now,
  );
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
    .get(hashToken(token)) as { name: string; last_used_at: number | null } | undefined;
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

/** Revoke a token; false if it is unknown or already revoked. Revoked names cannot be reused. */
export function revokeToken(db: Database, name: string, now = Date.now()): boolean {
  const info = db
    .prepare('UPDATE api_token SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
    .run(now, name);
  return info.changes > 0;
}
