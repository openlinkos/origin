import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { OriginError } from './errors.js';

/** Token and device names: lowercase ASCII, digits, `.`, `_`, `-`; at most 63 characters. */
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * Hub access tokens, each the credential of a device or of an agent of the hub's owner (see
 * docs/architecture.md#access). The admin password can never start with the prefix (see
 * password.ts). A token is bound to the one name it was created under: on the hub's replication
 * API it sends and receives data only for the device of that name.
 */
export const TOKEN_PREFIX = 'ogn_';
const LAST_USED_RESOLUTION = 60_000;

/**
 * What a token, or an OAuth grant, belongs to. A device is a machine of the owner with a store of
 * its own, which replicates with the hub; an agent is a cloud agent, a bot, or a pipeline, which
 * uses the hub's /mcp and may append event lines.
 */
export const PRINCIPAL_KINDS = ['device', 'agent'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * What a credential may do. `readwrite`: everything a token could always do (devices, and agents
 * by default). `readonly`, for agents only: read through /mcp, without the tools that write
 * (`remember`, `propose`, `correct`, `forget`), and nothing posted to the replication API.
 */
export const PRESETS = ['readwrite', 'readonly'] as const;
export type Preset = (typeof PRESETS)[number];

export interface TokenInfo {
  name: string;
  kind: PrincipalKind;
  preset: Preset;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface TokenOptions {
  /** `device` by default: a token is named after the device that uses it. */
  kind?: PrincipalKind;
  /** `readwrite` by default; `readonly` only for an agent. */
  preset?: Preset;
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

/** A preset from untrusted input; `readwrite` when absent. */
export function parsePreset(value: unknown): Preset {
  if (value === undefined || value === null || value === '') return 'readwrite';
  if (typeof value === 'string' && (PRESETS as readonly string[]).includes(value)) {
    return value as Preset;
  }
  throw new OriginError(`Unknown preset "${String(value)}"; expected ${PRESETS.join(' or ')}.`);
}

/** Whether an active OAuth grant (see oauth.ts) goes by `name`. */
function grantNamed(db: Database, name: string, now: number): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM oauth_grant WHERE name = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
      )
      .get(name, now) !== undefined
  );
}

/**
 * Create a hub access token for the device or agent `name`. The token is returned once; only its
 * SHA-256 hash is stored. A device keeps its name, so a revoked token can be replaced by a new one
 * of the same name (the revoked token stays invalid); an active token must be revoked first.
 */
export function createToken(
  db: Database,
  name: string,
  now = Date.now(),
  opts: TokenOptions = {},
): string {
  checkName(name, 'token');
  const kind = opts.kind ?? 'device';
  if (!(PRINCIPAL_KINDS as readonly string[]).includes(kind)) {
    throw new OriginError(`Unknown kind "${kind}"; expected device or agent.`);
  }
  const preset = parsePreset(opts.preset);
  if (kind === 'device' && preset !== 'readwrite') {
    throw new OriginError(
      'A device sends its sessions to the hub, so its token is readwrite; readonly is for agents.',
    );
  }
  const existing = db.prepare('SELECT revoked_at FROM api_token WHERE name = ?').get(name) as
    | { revoked_at: number | null }
    | undefined;
  if (existing && existing.revoked_at === null) {
    throw new OriginError(
      `A token named "${name}" is active; revoke it first to give ${name} a new one.`,
    );
  }
  if (grantNamed(db, name, now)) {
    throw new OriginError(
      `An app you authorized goes by "${name}"; choose another name, or revoke that app first.`,
    );
  }
  const token = newSecret(TOKEN_PREFIX);
  db.prepare(
    `INSERT INTO api_token (name, hash, created_at, kind, preset) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       hash = excluded.hash, created_at = excluded.created_at, last_used_at = NULL,
       revoked_at = NULL, kind = excluded.kind, preset = excluded.preset`,
  ).run(name, secretHash(token), now, kind, preset);
  return token;
}

/** The active token matching `token`, or null. Records use at most once a minute. */
export function verifyToken(
  db: Database,
  token: string,
  now = Date.now(),
): { name: string; kind: PrincipalKind; preset: Preset } | null {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = db
    .prepare(
      'SELECT name, last_used_at, kind, preset FROM api_token WHERE hash = ? AND revoked_at IS NULL',
    )
    .get(secretHash(token)) as
    | { name: string; last_used_at: number | null; kind: PrincipalKind; preset: Preset }
    | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION) {
    db.prepare('UPDATE api_token SET last_used_at = ? WHERE name = ?').run(now, row.name);
  }
  return { name: row.name, kind: row.kind, preset: row.preset };
}

export function listTokens(db: Database): TokenInfo[] {
  const rows = db
    .prepare(
      'SELECT name, kind, preset, created_at, last_used_at, revoked_at FROM api_token ORDER BY name',
    )
    .all() as unknown as Array<{
    name: string;
    kind: PrincipalKind;
    preset: Preset;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
  }>;
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    preset: r.preset,
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
