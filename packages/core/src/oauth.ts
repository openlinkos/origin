import { createHash, randomBytes, randomInt } from 'node:crypto';
import { type Database, transaction } from './db.js';
import { OriginError } from './errors.js';
import { storeName } from './identity.js';
import { getAdminUsername } from './password.js';
import {
  createToken,
  NAME_RE,
  PRESETS,
  type Preset,
  type PrincipalKind,
  revokeToken,
  secretHash,
  TOKEN_PREFIX,
  verifyToken,
} from './tokens.js';

/**
 * The hub as an OAuth 2.1 authorization server for its own /mcp, and the device authorization
 * grant for `origin hub connect` (see docs/architecture.md#access). Agents that sign in by OAuth
 * (Claude Code, Codex) and devices that connect by browser become principals of the owner, as
 * tokens are: an approved authorization is a *grant*, an agent of the owner with a preset, and a
 * device approved in the browser gets a device token. Everything secret is stored as a SHA-256
 * hash: codes, access and refresh tokens, and device codes. The HTTP endpoints and the pages that
 * ask the owner live in the admin package; fetching a client's metadata document, a network call,
 * is the CLI's. This module only stores and checks.
 */

/** Access tokens, which /mcp accepts for an hour. */
export const ACCESS_TOKEN_PREFIX = 'oga_';
/** Refresh tokens: each works once, and gives the next pair (rotation). */
export const REFRESH_TOKEN_PREFIX = 'ogr_';
const CODE_PREFIX = 'ogc_';
const DEVICE_CODE_PREFIX = 'ogd_';
const CLIENT_ID_PREFIX = 'ocl_';
const GRANT_ID_PREFIX = 'grt_';

export const ACCESS_TOKEN_TTL_MS = 3_600_000;
/** An authorization code works once, within a minute. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
/** A device waits this long for its owner to approve it. */
export const DEVICE_REQUEST_TTL_MS = 10 * 60_000;
/** How often a waiting device may ask, in seconds (RFC 8628); 5 more after each slow_down. */
export const DEVICE_POLL_INTERVAL_S = 5;
/** How long a grant can last, in days, as the consent page offers it. */
export const GRANT_DAYS = [1, 30, 90, 365] as const;
export const DEFAULT_GRANT_DAYS = 90;
/** The client id of Origin's own CLI, the only client of the device authorization grant. */
export const ORIGIN_CLIENT_ID = 'origin';
/** The presets, and `offline_access`, which asks for refresh tokens (they come with every grant). */
export const OAUTH_SCOPES = [...PRESETS, 'offline_access'] as const;
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const MAX_REDIRECT_URIS = 10;
const MAX_URI = 2000;
const MAX_CLIENT_NAME = 100;
const MAX_STATE = 1024;
/** Registered clients that never got a grant are dropped after a day. */
const UNUSED_CLIENT_MS = 86_400_000;
/** At most this many such clients at a time: registration needs no sign-in. */
const MAX_UNUSED_CLIENTS = 200;
/** At most this many devices waiting at a time. */
const MAX_PENDING_DEVICES = 20;
const LAST_USED_RESOLUTION = 60_000;
const DAY_MS = 86_400_000;

/**
 * An OAuth error (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 8628 §3.5): `code` is the `error` the client
 * reads, the message its `error_description`. `revoked` is the grant this request caused to be
 * revoked, a reused code or refresh token, for the audit log.
 */
export class OAuthError extends OriginError {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly revoked: GrantInfo | null = null,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

/**
 * Run `fn` in a write transaction that commits what it did even when its outcome is an OAuth
 * error, such as a code used up or a grant revoked for reuse; the error is thrown after the commit.
 */
function committed<T>(db: Database, fn: () => T | OAuthError): T {
  const out = transaction(db, fn, { immediate: true });
  if (out instanceof OAuthError) throw out;
  return out;
}
const base64url = (data: Buffer) => data.toString('base64url');

// ---------------------------------------------------------------------------------------------
// Clients

export interface OAuthClient {
  /** `ocl_…` for a registered client, the document's https URL for a metadata document. */
  id: string;
  /** As the client names itself; '' when it gave no name. */
  name: string;
  uri: string | null;
  redirectUris: string[];
  /** Described by a client ID metadata document, fetched from its id. */
  document: boolean;
  createdAt: number;
  /** A metadata document is fetched again after this; null for a registered client. */
  expiresAt: number | null;
}

function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/**
 * A redirect URI a client may register: `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`
 * on the machine that runs the client, or any `https://` URL; no fragment and no credentials.
 */
export function checkRedirectUri(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URI) {
    throw new OAuthError('invalid_redirect_uri', 'Each redirect URI must be a URL.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('invalid_redirect_uri', `Invalid redirect URI: ${value}`);
  }
  if (value.includes('#') || url.username || url.password) {
    throw new OAuthError(
      'invalid_redirect_uri',
      `A redirect URI has no fragment or credentials: ${value}`,
    );
  }
  if (url.protocol === 'https:' || isLoopbackRedirect(url)) return value;
  throw new OAuthError(
    'invalid_redirect_uri',
    `Redirect URIs must be http://127.0.0.1:<port>/…, http://localhost:<port>/…, or https://…: ${value}`,
  );
}

/**
 * Whether a redirect URI of an authorization request is one the client registered: the same
 * string, or, on a loopback address, the same but for its port, which a native app picks when it
 * starts listening (RFC 8252 §7.3).
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackRedirect(req) || requested.includes('#')) return false;
  return registered.some((r) => {
    const u = new URL(r);
    return (
      isLoopbackRedirect(u) &&
      u.hostname === req.hostname &&
      u.pathname === req.pathname &&
      u.search === req.search
    );
  });
}

/**
 * Whether a client id is the URL of a client ID metadata document: https, with a path, and
 * without a fragment, credentials, or dot segments.
 */
export function isClientIdUrl(id: string): boolean {
  if (id.length > MAX_URI || !id.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return false;
  }
  return (
    url.pathname.length > 1 &&
    !id.includes('#') &&
    !url.username &&
    !url.password &&
    !/\/\.\.?(\/|$)/.test(id.slice(url.origin.length))
  );
}

function clipName(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_CLIENT_NAME)
    : '';
}

function httpsUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URI) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function redirectList(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    throw new OAuthError(error, `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  return value.map((v) => {
    try {
      return checkRedirectUri(v);
    } catch (err) {
      if (err instanceof OAuthError && error !== err.code) throw new OAuthError(error, err.message);
      throw err;
    }
  });
}

interface ClientRow {
  id: string;
  name: string;
  uri: string | null;
  redirect_uris: string;
  document: number;
  created_at: number;
  expires_at: number | null;
}

const toClient = (r: ClientRow): OAuthClient => ({
  id: r.id,
  name: r.name,
  uri: r.uri,
  redirectUris: JSON.parse(r.redirect_uris) as string[],
  document: r.document === 1,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export function getClient(db: Database, id: string): OAuthClient | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_URI) return null;
  const row = db.prepare('SELECT * FROM oauth_client WHERE id = ?').get(id) as
    | ClientRow
    | undefined;
  return row ? toClient(row) : null;
}

/**
 * Dynamic client registration (RFC 7591), for public clients only: the client gets an id and no
 * secret, whatever authentication it asked for, and authenticates with PKCE. Registration needs
 * no sign-in, so clients that never got a grant are dropped after a day, and at most
 * MAX_UNUSED_CLIENTS of them wait at a time. Returns the client and the registration response.
 */
export function registerClient(
  db: Database,
  meta: Record<string, unknown>,
  now = Date.now(),
): { client: OAuthClient; response: Record<string, unknown> } {
  const redirectUris = redirectList(meta.redirect_uris, 'invalid_redirect_uri');
  const grants = meta.grant_types ?? ['authorization_code'];
  if (
    !Array.isArray(grants) ||
    !grants.every((g) => g === 'authorization_code' || g === 'refresh_token')
  ) {
    throw new OAuthError(
      'invalid_client_metadata',
      'grant_types may be authorization_code and refresh_token only.',
    );
  }
  const responses = meta.response_types ?? ['code'];
  if (!Array.isArray(responses) || !responses.every((r) => r === 'code')) {
    throw new OAuthError('invalid_client_metadata', 'response_types may be code only.');
  }
  const name = clipName(meta.client_name);
  const uri = httpsUri(meta.client_uri);
  return transaction(
    db,
    () => {
      db.prepare(
        `DELETE FROM oauth_client WHERE document = 0 AND created_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = oauth_client.id)`,
      ).run(now - UNUSED_CLIENT_MS);
      const waiting = db
        .prepare(
          `SELECT COUNT(*) AS n FROM oauth_client WHERE document = 0
             AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = oauth_client.id)`,
        )
        .get() as { n: number };
      if (waiting.n >= MAX_UNUSED_CLIENTS) {
        throw new OAuthError(
          'temporarily_unavailable',
          'Too many apps registered without being authorized; try again later.',
          429,
        );
      }
      const id = `${CLIENT_ID_PREFIX}${random(16)}`;
      db.prepare(
        `INSERT INTO oauth_client (id, name, uri, redirect_uris, document, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      ).run(id, name, uri, JSON.stringify(redirectUris), now);
      const client = getClient(db, id) as OAuthClient;
      return {
        client,
        response: {
          client_id: id,
          client_id_issued_at: Math.floor(now / 1000),
          ...(name ? { client_name: name } : {}),
          ...(uri ? { client_uri: uri } : {}),
          redirect_uris: redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
      };
    },
    { immediate: true },
  );
}

/**
 * Check a client ID metadata document fetched from its id, and keep it until `expiresAt`. It must
 * be a JSON object whose `client_id` is that URL exactly, with a `client_name` and the
 * `redirect_uris` the client may use, for a public client: no secret, and no authentication other
 * than `none`. Throws OAuthError `invalid_client` otherwise.
 */
export function saveClientDocument(
  db: Database,
  id: string,
  doc: unknown,
  opts: { now?: number; expiresAt: number },
): OAuthClient {
  const now = opts.now ?? Date.now();
  if (!isClientIdUrl(id)) {
    throw new OAuthError('invalid_client', `Not a client metadata document URL: ${id}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new OAuthError('invalid_client', 'The client metadata document is not a JSON object.');
  }
  const d = doc as Record<string, unknown>;
  if (d.client_id !== id) {
    throw new OAuthError(
      'invalid_client',
      'The client metadata document names another client_id than its own URL.',
    );
  }
  const name = clipName(d.client_name);
  if (!name)
    throw new OAuthError('invalid_client', 'The client metadata document has no client_name.');
  const redirectUris = redirectList(d.redirect_uris, 'invalid_client');
  if (d.client_secret !== undefined || d.client_secret_expires_at !== undefined) {
    throw new OAuthError('invalid_client', 'A client metadata document cannot hold a secret.');
  }
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== 'none') {
    throw new OAuthError(
      'invalid_client',
      `This hub takes public clients only (token_endpoint_auth_method "none"), not "${String(d.token_endpoint_auth_method)}".`,
    );
  }
  if (
    d.grant_types !== undefined &&
    (!Array.isArray(d.grant_types) || !d.grant_types.includes('authorization_code'))
  ) {
    throw new OAuthError('invalid_client', 'The client does not use the authorization code grant.');
  }
  db.prepare(
    `INSERT INTO oauth_client (id, name, uri, redirect_uris, document, created_at, expires_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, uri = excluded.uri,
       redirect_uris = excluded.redirect_uris, created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  ).run(id, name, httpsUri(d.client_uri), JSON.stringify(redirectUris), now, opts.expiresAt);
  return getClient(db, id) as OAuthClient;
}

// ---------------------------------------------------------------------------------------------
// Authorization requests

/** What resource a token is for: lowercase scheme and host, without a fragment or a trailing slash. */
export function canonicalResource(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** The presets the owner may grant: both, unless the client asked for readonly alone. */
  presets: Preset[];
  /** The client asked for `offline_access`. */
  offline: boolean;
  /** The canonical URI of the hub's /mcp. */
  resource: string;
}

export type AuthorizationCheck =
  | { ok: true; request: AuthorizationRequest }
  /** Shown to the owner: without a valid client and redirect URI, nothing is sent back. */
  | { ok: false; redirect: null; error: string; description: string }
  /** Sent back to the client, at `redirect`. */
  | { ok: false; redirect: string; error: string; description: string };

/** A redirect URI with OAuth parameters added to its query. */
export function withParams(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Check an authorization request (OAuth 2.1 §4.1.1) of a client already known to the store: one
 * that registered, or whose metadata document was fetched. The client and the redirect URI are
 * checked first, and an error there is for the owner's eyes only; any later error goes back to the
 * client, at its redirect URI, with the `state` and the issuer (RFC 9207). The code challenge is
 * required (S256), the `resource`, when given, must be the hub's /mcp, and the scopes must be
 * Origin's.
 */
export function checkAuthorizationRequest(
  db: Database,
  param: (name: string) => string | null,
  opts: { resource: string; issuer: string },
): AuthorizationCheck {
  const fail = (error: string, description: string) =>
    ({ ok: false, redirect: null, error, description }) as const;
  const clientId = param('client_id');
  if (!clientId) return fail('invalid_request', 'The request names no client (client_id).');
  const client = getClient(db, clientId);
  if (!client) return fail('invalid_client', 'This app is not registered with this hub.');
  let redirectUri = param('redirect_uri');
  if (redirectUri === null) {
    const only = client.redirectUris.length === 1 ? (client.redirectUris[0] as string) : null;
    if (only === null || isLoopbackRedirect(new URL(only))) {
      return fail('invalid_request', 'The request names no redirect URI (redirect_uri).');
    }
    redirectUri = only;
  }
  if (!redirectMatches(client.redirectUris, redirectUri)) {
    return fail('invalid_request', 'The redirect URI is not one this app registered.');
  }
  const stateParam = param('state');
  const state = stateParam !== null && stateParam.length <= MAX_STATE ? stateParam : null;
  const back = (error: string, description: string): AuthorizationCheck => ({
    ok: false,
    error,
    description,
    redirect: withParams(redirectUri as string, {
      error,
      error_description: description,
      state,
      iss: opts.issuer,
    }),
  });
  if (stateParam !== null && state === null) return back('invalid_request', 'state is too long.');
  if (param('response_type') !== 'code') {
    return back('unsupported_response_type', 'Only the authorization code flow is supported.');
  }
  const challenge = param('code_challenge');
  if (!challenge) return back('invalid_request', 'PKCE is required: send a code_challenge.');
  if (param('code_challenge_method') !== 'S256') {
    return back('invalid_request', 'PKCE needs code_challenge_method S256.');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return back('invalid_request', 'The code_challenge is not a base64url SHA-256 digest.');
  }
  const resource = param('resource');
  if (resource !== null && canonicalResource(resource) !== canonicalResource(opts.resource)) {
    return back('invalid_target', `This hub issues tokens for ${opts.resource} only.`);
  }
  const scopes = (param('scope') ?? '').split(' ').filter((s) => s !== '');
  const unknown = scopes.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    return back(
      'invalid_scope',
      `Unknown scope: ${unknown.join(' ')}. Origin's scopes are ${OAUTH_SCOPES.join(', ')}.`,
    );
  }
  const readonlyOnly = scopes.includes('readonly') && !scopes.includes('readwrite');
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      state,
      codeChallenge: challenge,
      presets: readonlyOnly ? ['readonly'] : ['readwrite', 'readonly'],
      offline: scopes.includes('offline_access'),
      resource: canonicalResource(opts.resource) as string,
    },
  };
}

/**
 * The owner allowed an authorization request: a one-time code for it, valid for a minute, which
 * remembers what the owner chose (the preset, from those the request allows, and for how many
 * days the grant lasts).
 */
export function createAuthorizationCode(
  db: Database,
  request: AuthorizationRequest,
  choice: { preset: Preset; days: number },
  now = Date.now(),
): string {
  if (!request.presets.includes(choice.preset)) {
    throw new OriginError(`This app asked for ${request.presets.join(' or ')} access only.`);
  }
  if (!(GRANT_DAYS as readonly number[]).includes(choice.days)) {
    throw new OriginError(`A grant lasts ${GRANT_DAYS.join(', ')} days.`);
  }
  const code = `${CODE_PREFIX}${random()}`;
  db.prepare('DELETE FROM oauth_code WHERE expires_at < ?').run(now - DAY_MS);
  db.prepare(
    `INSERT INTO oauth_code (hash, client_id, client_name, redirect_uri, challenge, preset, scope,
                             resource, days, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    secretHash(code),
    request.client.id,
    request.client.name,
    request.redirectUri,
    request.codeChallenge,
    choice.preset,
    scopeOf(choice.preset, request.offline),
    request.resource,
    choice.days,
    now,
    now + AUTHORIZATION_CODE_TTL_MS,
  );
  return code;
}

const scopeOf = (preset: Preset, offline: boolean) =>
  offline ? `${preset} offline_access` : preset;

// ---------------------------------------------------------------------------------------------
// Grants and tokens

export interface GrantInfo {
  id: string;
  /** The agent's name, from the client's: authors of what it writes, and in the audit log. */
  name: string;
  clientId: string;
  clientName: string;
  preset: Preset;
  scope: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** `owner` (in the admin UI or the CLI), `client` (the app signed out), or `reuse` (a code or refresh token presented twice). */
  revokedBy: string | null;
}

interface GrantRow {
  id: string;
  name: string;
  client_id: string;
  client_name: string;
  preset: Preset;
  scope: string;
  resource: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

const toGrant = (r: GrantRow): GrantInfo => ({
  id: r.id,
  name: r.name,
  clientId: r.client_id,
  clientName: r.client_name,
  preset: r.preset,
  scope: r.scope,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  revokedBy: r.revoked_by,
});

function grantRow(db: Database, id: string): GrantRow | undefined {
  return db.prepare('SELECT * FROM oauth_grant WHERE id = ?').get(id) as GrantRow | undefined;
}

/** Grants, newest first: active ones, and those revoked or expired, for the record. */
export function listGrants(db: Database): GrantInfo[] {
  return (
    db.prepare('SELECT * FROM oauth_grant ORDER BY created_at DESC').all() as unknown as GrantRow[]
  ).map(toGrant);
}

/** Whether a grant can be used at `now`: neither revoked nor expired. */
export function isGrantActive(g: GrantInfo, now = Date.now()): boolean {
  return g.revokedAt === null && g.expiresAt > now;
}

/** The active grant named `name`, if any. */
export function activeGrantNamed(db: Database, name: string, now = Date.now()): GrantInfo | null {
  const row = db
    .prepare(
      'SELECT * FROM oauth_grant WHERE name = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
    )
    .get(name, now) as GrantRow | undefined;
  return row ? toGrant(row) : null;
}

/** Revoke a grant and drop its tokens; null when it is unknown or already revoked. */
export function revokeGrant(
  db: Database,
  id: string,
  by: 'owner' | 'client' | 'reuse',
  now = Date.now(),
): GrantInfo | null {
  const info = db
    .prepare(
      'UPDATE oauth_grant SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL',
    )
    .run(now, by, id);
  if (info.changes === 0) return null;
  db.prepare('DELETE FROM oauth_token WHERE grant_id = ?').run(id);
  return toGrant(grantRow(db, id) as GrantRow);
}

/**
 * The name of a new grant's agent, from its client's: lowercase letters, digits, and hyphens, such
 * as `claude-code`; not the name of any token, of the hub, or of another active grant, so that
 * authors stay unambiguous (`claude-code-2` then).
 */
function grantName(db: Database, clientName: string, now: number): string {
  const base =
    clientName
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'agent';
  const taken = (name: string) =>
    name === storeName(db) ||
    db.prepare('SELECT 1 FROM api_token WHERE name = ?').get(name) !== undefined ||
    activeGrantNamed(db, name, now) !== null;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    if (NAME_RE.test(name) && !taken(name)) return name;
  }
}

/** What the token endpoint answers (RFC 6749 §5.1). */
export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function issueTokens(db: Database, grant: GrantRow, now: number): TokenSet {
  db.prepare('DELETE FROM oauth_token WHERE expires_at < ?').run(now);
  const access = `${ACCESS_TOKEN_PREFIX}${random()}`;
  const refresh = `${REFRESH_TOKEN_PREFIX}${random()}`;
  const accessExpires = Math.min(now + ACCESS_TOKEN_TTL_MS, grant.expires_at);
  const insert = db.prepare(
    'INSERT INTO oauth_token (hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(secretHash(access), grant.id, 'access', now, accessExpires);
  insert.run(secretHash(refresh), grant.id, 'refresh', now, grant.expires_at);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((accessExpires - now) / 1000)),
    refresh_token: refresh,
    scope: grant.scope,
  };
}

/** The error for a `resource` parameter other than the one a grant is for; null when it is absent or that one. */
function resourceError(resource: string | null | undefined, expected: string): OAuthError | null {
  if (resource === null || resource === undefined || resource === '') return null;
  return canonicalResource(resource) === canonicalResource(expected)
    ? null
    : new OAuthError('invalid_target', `This hub issues tokens for ${expected} only.`);
}

/**
 * Exchange an authorization code (OAuth 2.1 §4.1.3): for the client it was issued to, with the
 * redirect URI it was sent to, and the PKCE verifier of its challenge. A code works once: the
 * first presentation uses it up, whatever its outcome, and a code presented again revokes the
 * grant it gave (RFC 6749 §4.1.2). The grant starts here: an agent of the owner, with the preset
 * and the duration the owner chose.
 */
export function exchangeCode(
  db: Database,
  input: {
    code: unknown;
    clientId: unknown;
    redirectUri?: unknown;
    verifier: unknown;
    resource?: string | null;
  },
  opts: { now?: number } = {},
): TokenSet & { grant: GrantInfo } {
  const now = opts.now ?? Date.now();
  if (typeof input.clientId !== 'string' || input.clientId === '') {
    throw new OAuthError('invalid_request', 'Send the client_id.');
  }
  if (typeof input.code !== 'string' || !input.code.startsWith(CODE_PREFIX)) {
    throw new OAuthError('invalid_grant', 'Unknown or expired authorization code.');
  }
  const code = input.code;
  const clientId = input.clientId;
  return committed(db, () => {
    const row = db.prepare('SELECT * FROM oauth_code WHERE hash = ?').get(secretHash(code)) as
      | {
          hash: string;
          client_id: string;
          client_name: string;
          redirect_uri: string;
          challenge: string;
          preset: Preset;
          scope: string;
          resource: string;
          days: number;
          expires_at: number;
          used_at: number | null;
          grant_id: string | null;
        }
      | undefined;
    if (!row) throw new OAuthError('invalid_grant', 'Unknown or expired authorization code.');
    if (row.used_at !== null) {
      const revoked = row.grant_id ? revokeGrant(db, row.grant_id, 'reuse', now) : null;
      return new OAuthError(
        'invalid_grant',
        'This authorization code was already used; the tokens issued for it are revoked.',
        400,
        revoked,
      );
    }
    db.prepare('UPDATE oauth_code SET used_at = ? WHERE hash = ?').run(now, row.hash);
    if (now >= row.expires_at) {
      return new OAuthError('invalid_grant', 'Unknown or expired authorization code.');
    }
    if (clientId !== row.client_id) {
      return new OAuthError('invalid_grant', 'This code was issued to another client.');
    }
    if (
      input.redirectUri !== undefined &&
      input.redirectUri !== null &&
      input.redirectUri !== row.redirect_uri
    ) {
      return new OAuthError('invalid_grant', 'The redirect_uri differs from the one authorized.');
    }
    const verifier = input.verifier;
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return new OAuthError('invalid_grant', 'PKCE: send the code_verifier.');
    }
    if (base64url(createHash('sha256').update(verifier).digest()) !== row.challenge) {
      return new OAuthError('invalid_grant', 'PKCE: the code_verifier does not match.');
    }
    const target = resourceError(input.resource, row.resource);
    if (target) return target;
    const id = `${GRANT_ID_PREFIX}${randomBytes(8).toString('hex')}`;
    db.prepare(
      `INSERT INTO oauth_grant (id, name, client_id, client_name, preset, scope, resource,
                                  created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      grantName(db, row.client_name, now),
      row.client_id,
      row.client_name,
      row.preset,
      row.scope,
      row.resource,
      now,
      now + row.days * DAY_MS,
    );
    db.prepare('UPDATE oauth_code SET grant_id = ? WHERE hash = ?').run(id, row.hash);
    const grant = grantRow(db, id) as GrantRow;
    return { ...issueTokens(db, grant, now), grant: toGrant(grant) };
  });
}

/**
 * Exchange a refresh token for a new pair (OAuth 2.1 §4.3), for the client of its grant. Every
 * refresh token works once (rotation, required for public clients); one presented again was
 * stolen or copied, so its grant is revoked, every token with it (reuse detection). A grant's
 * tokens never outlive it, and a refresh cannot widen what it may do.
 */
export function refreshTokens(
  db: Database,
  input: { refreshToken: unknown; clientId: unknown; scope?: unknown; resource?: string | null },
  opts: { now?: number } = {},
): TokenSet & { grant: GrantInfo } {
  const now = opts.now ?? Date.now();
  if (typeof input.clientId !== 'string' || input.clientId === '') {
    throw new OAuthError('invalid_request', 'Send the client_id.');
  }
  const token = input.refreshToken;
  if (typeof token !== 'string' || !token.startsWith(REFRESH_TOKEN_PREFIX)) {
    throw new OAuthError('invalid_grant', 'Unknown, expired, or revoked refresh token.');
  }
  const clientId = input.clientId;
  return committed(db, () => {
    const row = db
      .prepare("SELECT * FROM oauth_token WHERE hash = ? AND kind = 'refresh'")
      .get(secretHash(token)) as
      | { hash: string; grant_id: string; expires_at: number; used_at: number | null }
      | undefined;
    const grant = row ? grantRow(db, row.grant_id) : undefined;
    if (!row || !grant || grant.revoked_at !== null || grant.expires_at <= now) {
      throw new OAuthError('invalid_grant', 'Unknown, expired, or revoked refresh token.');
    }
    if (grant.client_id !== clientId) {
      throw new OAuthError('invalid_grant', 'This refresh token was issued to another client.');
    }
    if (row.used_at !== null) {
      const revoked = revokeGrant(db, grant.id, 'reuse', now);
      return new OAuthError(
        'invalid_grant',
        'This refresh token was already used, so it may have been copied: the authorization is revoked. Sign in again.',
        400,
        revoked,
      );
    }
    if (row.expires_at <= now) {
      throw new OAuthError('invalid_grant', 'Unknown, expired, or revoked refresh token.');
    }
    const target = resourceError(input.resource, grant.resource);
    if (target) return target;
    if (typeof input.scope === 'string' && input.scope.trim() !== '') {
      const granted = grant.scope.split(' ');
      const wider = input.scope
        .split(' ')
        .filter((s) => s !== '' && !granted.includes(s) && s !== 'offline_access')
        .filter((s) => !(s === 'readonly' && grant.preset === 'readwrite'));
      if (wider.length > 0) {
        throw new OAuthError(
          'invalid_scope',
          `This authorization does not include ${wider.join(' ')}.`,
        );
      }
    }
    db.prepare('UPDATE oauth_token SET used_at = ? WHERE hash = ?').run(now, row.hash);
    return { ...issueTokens(db, grant, now), grant: toGrant(grant) };
  });
}

/**
 * Token revocation (RFC 7009) by the client it was issued to: a refresh token revokes its whole
 * grant, an access token only itself. Unknown tokens, and tokens of other clients or of other
 * kinds (a device's or an agent's preset token, which only the owner revokes), change nothing.
 * Returns the grant revoked, if any.
 */
export function revokeOAuthToken(
  db: Database,
  input: { token: unknown; clientId?: unknown },
  now = Date.now(),
): GrantInfo | null {
  const token = input.token;
  if (typeof token !== 'string') return null;
  const kind = token.startsWith(REFRESH_TOKEN_PREFIX)
    ? 'refresh'
    : token.startsWith(ACCESS_TOKEN_PREFIX)
      ? 'access'
      : null;
  if (kind === null) return null;
  const row = db
    .prepare('SELECT hash, grant_id FROM oauth_token WHERE hash = ? AND kind = ?')
    .get(secretHash(token), kind) as { hash: string; grant_id: string } | undefined;
  if (!row) return null;
  const grant = grantRow(db, row.grant_id);
  if (!grant) return null;
  if (typeof input.clientId === 'string' && input.clientId !== grant.client_id) return null;
  if (kind === 'access') {
    db.prepare('DELETE FROM oauth_token WHERE hash = ?').run(row.hash);
    return null;
  }
  return revokeGrant(db, grant.id, 'client', now);
}

// ---------------------------------------------------------------------------------------------
// Bearer credentials

/** Who a bearer credential belongs to: a device or an agent of the owner, and what it may do. */
export interface Principal {
  kind: PrincipalKind;
  name: string;
  preset: Preset;
  /** `token`: a preset token (`ogn_…`); `oauth`: an access token of a grant, for /mcp only. */
  via: 'token' | 'oauth';
  grantId: string | null;
}

/**
 * The principal of a bearer credential, or null: an active preset token, or an unexpired access
 * token of an active grant. Use is recorded at most once a minute.
 */
export function verifyBearer(db: Database, bearer: string, now = Date.now()): Principal | null {
  if (typeof bearer !== 'string') return null;
  if (bearer.startsWith(TOKEN_PREFIX)) {
    const t = verifyToken(db, bearer, now);
    return t ? { ...t, via: 'token', grantId: null } : null;
  }
  if (!bearer.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const row = db
    .prepare(
      `SELECT t.expires_at AS token_expires, g.* FROM oauth_token t
         JOIN oauth_grant g ON g.id = t.grant_id
       WHERE t.hash = ? AND t.kind = 'access'`,
    )
    .get(secretHash(bearer)) as (GrantRow & { token_expires: number }) | undefined;
  if (!row || row.token_expires <= now || row.revoked_at !== null || row.expires_at <= now) {
    return null;
  }
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION) {
    db.prepare('UPDATE oauth_grant SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return { kind: 'agent', name: row.name, preset: row.preset, via: 'oauth', grantId: row.id };
}

/** The audit log's actor for an agent of the owner: `<username> / <agent>`. */
export function agentActor(db: Database, name: string): string {
  return `${getAdminUsername(db) ?? 'owner'} / ${name}`;
}

// ---------------------------------------------------------------------------------------------
// Devices connecting by browser (RFC 8628)

/** Consonants only, so that a code spells no word and reads the same in any font. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** A user code as typed: letters only, uppercase, `XXXX-XXXX`. */
export function normalizeUserCode(input: unknown): string {
  const letters = typeof input === 'string' ? input.toUpperCase().replace(/[^A-Z]/g, '') : '';
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

export interface DeviceRequest {
  userCode: string;
  /** The name the device asks to connect under: its store's name. */
  device: string;
  ip: string | null;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'done';
  /** A device of that name has an active token, which approving replaces. */
  replaces: boolean;
}

interface DeviceRow {
  hash: string;
  user_code: string;
  device: string;
  ip: string | null;
  created_at: number;
  expires_at: number;
  interval_s: number;
  polled_at: number | null;
  status: DeviceRequest['status'];
}

function toDeviceRequest(db: Database, r: DeviceRow): DeviceRequest {
  return {
    userCode: r.user_code,
    device: r.device,
    ip: r.ip,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status: r.status,
    replaces:
      db.prepare('SELECT 1 FROM api_token WHERE name = ? AND revoked_at IS NULL').get(r.device) !==
      undefined,
  };
}

/** Throw unless `device` can connect under that name. */
function checkDeviceName(db: Database, device: unknown): string {
  if (typeof device !== 'string' || !NAME_RE.test(device)) {
    throw new OAuthError(
      'invalid_request',
      'Send the device name (device_name), as its store is named.',
    );
  }
  if (device === storeName(db)) {
    throw new OAuthError(
      'invalid_request',
      `"${device}" is this hub's own name; a device needs another.`,
    );
  }
  return device;
}

/**
 * A device asks to connect (RFC 8628 §3.1): it gets a device code to poll with, and a short user
 * code for its owner to approve in the admin UI, within DEVICE_REQUEST_TTL_MS. Only Origin's CLI
 * uses this grant, and at most MAX_PENDING_DEVICES wait at a time.
 */
export function startDeviceAuthorization(
  db: Database,
  input: { clientId: unknown; device: unknown; ip?: string | null },
  now = Date.now(),
): { deviceCode: string; userCode: string; expiresIn: number; interval: number } {
  if (input.clientId !== ORIGIN_CLIENT_ID) {
    throw new OAuthError(
      'invalid_client',
      `Devices connect with Origin's CLI (client_id "${ORIGIN_CLIENT_ID}").`,
      401,
    );
  }
  const device = checkDeviceName(db, input.device);
  return transaction(
    db,
    () => {
      db.prepare('DELETE FROM device_request WHERE expires_at < ?').run(now - DAY_MS);
      const pending = db
        .prepare(
          "SELECT COUNT(*) AS n FROM device_request WHERE status = 'pending' AND expires_at > ?",
        )
        .get(now) as { n: number };
      if (pending.n >= MAX_PENDING_DEVICES) {
        throw new OAuthError(
          'slow_down',
          'Too many devices are waiting for approval; try again in a few minutes.',
          429,
        );
      }
      const deviceCode = `${DEVICE_CODE_PREFIX}${random()}`;
      for (;;) {
        let letters = '';
        for (let i = 0; i < 8; i++)
          letters += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
        const userCode = normalizeUserCode(letters);
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO device_request (hash, user_code, device, ip, created_at, expires_at,
                                                   interval_s, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(
            secretHash(deviceCode),
            userCode,
            device,
            input.ip ?? null,
            now,
            now + DEVICE_REQUEST_TTL_MS,
            DEVICE_POLL_INTERVAL_S,
          );
        if (info.changes > 0) {
          return {
            deviceCode,
            userCode,
            expiresIn: DEVICE_REQUEST_TTL_MS / 1000,
            interval: DEVICE_POLL_INTERVAL_S,
          };
        }
      }
    },
    { immediate: true },
  );
}

/** The request of a user code, whatever its state; null when there is none. */
export function getDeviceRequest(db: Database, userCode: unknown): DeviceRequest | null {
  const code = normalizeUserCode(userCode);
  if (code.length !== 9) return null;
  const row = db.prepare('SELECT * FROM device_request WHERE user_code = ?').get(code) as
    | DeviceRow
    | undefined;
  return row ? toDeviceRequest(db, row) : null;
}

/**
 * The owner approves or denies a waiting device. Throws an OriginError when the code is unknown,
 * expired, or already decided, or when an app the owner authorized goes by the device's name.
 */
export function decideDeviceRequest(
  db: Database,
  userCode: unknown,
  approve: boolean,
  now = Date.now(),
): DeviceRequest {
  const request = getDeviceRequest(db, userCode);
  if (!request) throw new OriginError('No device is waiting with this code.');
  if (request.status !== 'pending') throw new OriginError('This code was already used.');
  if (now >= request.expiresAt) {
    throw new OriginError('This code expired. Run origin hub connect again for a new one.');
  }
  if (approve && activeGrantNamed(db, request.device, now)) {
    throw new OriginError(
      `An app you authorized goes by "${request.device}"; revoke it first, or connect the device under another name.`,
    );
  }
  db.prepare(
    "UPDATE device_request SET status = ?, decided_at = ? WHERE user_code = ? AND status = 'pending'",
  ).run(approve ? 'approved' : 'denied', now, request.userCode);
  return { ...request, status: approve ? 'approved' : 'denied' };
}

/**
 * A waiting device asks whether its owner decided (RFC 8628 §3.4): `authorization_pending` until
 * then, `slow_down` when it asks sooner than its interval (which grows by 5 seconds),
 * `access_denied`, or `expired_token`. Once approved, it gets its device token, once: a token of
 * kind `device` under its name, replacing an active token of that name. Returns the token and the
 * name, and whether a token was replaced.
 */
export function pollDeviceAuthorization(
  db: Database,
  input: { deviceCode: unknown; clientId: unknown },
  now = Date.now(),
): { token: string; device: string; replaced: boolean } {
  if (input.clientId !== ORIGIN_CLIENT_ID) {
    throw new OAuthError(
      'invalid_client',
      `Devices connect with client_id "${ORIGIN_CLIENT_ID}".`,
      401,
    );
  }
  const code = input.deviceCode;
  if (typeof code !== 'string' || !code.startsWith(DEVICE_CODE_PREFIX)) {
    throw new OAuthError('invalid_grant', 'Unknown device code.');
  }
  return committed(db, () => {
    const row = db.prepare('SELECT * FROM device_request WHERE hash = ?').get(secretHash(code)) as
      | DeviceRow
      | undefined;
    if (!row) throw new OAuthError('invalid_grant', 'Unknown device code.');
    if (row.status === 'done')
      throw new OAuthError('invalid_grant', 'This device code was already used.');
    if (now >= row.expires_at) {
      throw new OAuthError('expired_token', 'The code expired before it was approved.');
    }
    if (row.polled_at !== null && now - row.polled_at < row.interval_s * 1000) {
      db.prepare('UPDATE device_request SET polled_at = ?, interval_s = ? WHERE hash = ?').run(
        now,
        row.interval_s + 5,
        row.hash,
      );
      return new OAuthError('slow_down', `Ask at most every ${row.interval_s + 5} seconds.`);
    }
    db.prepare('UPDATE device_request SET polled_at = ? WHERE hash = ?').run(now, row.hash);
    if (row.status === 'pending') {
      return new OAuthError('authorization_pending', 'Waiting for the owner to approve.');
    }
    if (row.status === 'denied') return new OAuthError('access_denied', 'The owner denied it.');
    const replaced = revokeToken(db, row.device, now);
    const token = createToken(db, row.device, now, { kind: 'device' });
    db.prepare("UPDATE device_request SET status = 'done' WHERE hash = ?").run(row.hash);
    return { token, device: row.device, replaced };
  });
}
