import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  agentActor,
  type Database,
  DEVICE_CODE_GRANT,
  exchangeCode,
  type GrantInfo,
  OAUTH_SCOPES,
  type OAuthClient,
  OAuthError,
  PRESETS,
  pollDeviceAuthorization,
  recordAudit,
  refreshTokens,
  registerClient,
  revokeOAuthToken,
  startDeviceAuthorization,
} from '@openlinkos/origin-core';
import { clientIp, HttpError, readBody, requestOrigins } from './http.js';
import { docsHref } from './project.js';

/**
 * The hub as the OAuth 2.1 authorization server of its own /mcp (see
 * docs/architecture.md#access), offered only while the admin UI is mounted at /admin on the
 * hub's port, since the owner approves every client there:
 *
 * - `GET /.well-known/oauth-protected-resource[/mcp]`: protected resource metadata (RFC 9728);
 * - `GET /.well-known/oauth-authorization-server`: authorization server metadata (RFC 8414);
 * - `POST /oauth/register`: dynamic client registration of public clients (RFC 7591);
 * - `GET /oauth/authorize`: to the consent page, `/admin/oauth/authorize`, behind the sign-in;
 * - `POST /oauth/token`: authorization codes with PKCE, refresh tokens with rotation, and device
 *   codes (RFC 8628);
 * - `POST /oauth/revoke`: token revocation (RFC 7009);
 * - `POST /oauth/device`: device authorization, for `origin hub connect`.
 *
 * Clients whose id is an https URL are described by a client ID metadata document, which the CLI
 * fetches (`resolveClient`): this package makes no network calls. Storage and checks are core's
 * (oauth.ts).
 */
export interface OAuthServerOptions {
  db: Database;
  /** The hub's public URL; without it, OAuth is offered only to loopback requests, as the admin UI. */
  publicUrl: URL | null;
  clientIpHeader?: string | null;
  /**
   * Fetch, check, and keep the metadata document of a client whose id is an https URL, unless the
   * store has a fresh copy; throws an OAuthError when it cannot be had or is not valid.
   */
  resolveClient: ClientResolver;
  now?: () => number;
  log?: (message: string) => void;
}

export type ClientResolver = (clientId: string) => Promise<OAuthClient>;

export interface OAuthServer {
  /** Answer an OAuth path and return true, or return false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /**
   * The `WWW-Authenticate` value of a 401 from /mcp: where its protected resource metadata is, and
   * the scope to ask for, when OAuth is offered at the request's origin; plain `Bearer` otherwise.
   */
  challenge(req: IncomingMessage): string;
}

/** The scope an agent asks for when it signs in: the default preset (refresh tokens come with it). */
export const DEFAULT_SCOPE = 'readwrite';
/** Request bodies of the OAuth endpoints are small. */
const MAX_OAUTH_BODY = 16 * 1024;
const DOCS_PAGE = 'guide/connect-agents';

/**
 * The issuer for a request: the public URL's origin, or `http://<Host>` for a loopback request
 * addressed to a loopback name (as the admin UI answers it); null when OAuth is not offered there.
 */
export function oauthIssuer(req: IncomingMessage, publicUrl: URL | null): string | null {
  const origins = requestOrigins(req, publicUrl);
  return origins.public ?? origins.local;
}

/** The canonical URI of the hub's MCP endpoint, the resource of every token. */
export const mcpResource = (issuer: string) => `${issuer}/mcp`;

/** Where the protected resource metadata of /mcp is. */
export const resourceMetadataUrl = (issuer: string) =>
  `${issuer}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: mcpResource(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...PRESETS],
    bearer_methods_supported: ['header'],
    resource_name: 'Origin',
    resource_documentation: docsHref('en', DOCS_PAGE),
  };
}

export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    device_authorization_endpoint: `${issuer}/oauth/device`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: docsHref('en', DOCS_PAGE),
  };
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function send(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...NO_STORE,
    ...headers,
  });
  res.end(body);
}

function oauthError(res: ServerResponse, err: OAuthError): void {
  send(res, err.status, { error: err.code, error_description: err.message });
}

/** The fields of a form-encoded body (the token, revocation, and device endpoints). */
async function formBody(req: IncomingMessage): Promise<Record<string, string>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  const raw = await readLimited(req);
  if (type !== 'application/x-www-form-urlencoded') {
    throw new OAuthError(
      'invalid_request',
      'Send the parameters as application/x-www-form-urlencoded.',
    );
  }
  const out: Record<string, string> = {};
  const params = new URLSearchParams(raw.toString('utf8'));
  for (const [k, v] of params) {
    if (k in out) throw new OAuthError('invalid_request', `The parameter ${k} is repeated.`);
    out[k] = v;
  }
  return out;
}

async function readLimited(req: IncomingMessage): Promise<Buffer> {
  try {
    const body = await readBody(req);
    if (body.length > MAX_OAUTH_BODY)
      throw new OAuthError('invalid_request', 'The request is too large.', 413);
    return body;
  } catch (err) {
    if (err instanceof HttpError) throw new OAuthError('invalid_request', err.message, err.status);
    throw err;
  }
}

export function createOAuthServer(o: OAuthServerOptions): OAuthServer {
  const now = o.now ?? Date.now;
  const db = o.db;
  const who = (req: IncomingMessage) => ({
    ip: clientIp(req, o.clientIpHeader ?? null),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
  const audit = (
    req: IncomingMessage,
    actor: string,
    action: string,
    target: string,
    detail: Record<string, string | number | boolean> | null = null,
  ) => recordAudit(db, { actor, channel: 'api', action, target, detail, ...who(req) }, now());
  /** A grant revoked because a code or a refresh token came twice, for the audit log. */
  const reused = (req: IncomingMessage, grant: GrantInfo | null) => {
    if (grant)
      audit(req, agentActor(db, grant.name), 'grant.reuse', grant.name, {
        client: grant.clientName,
      });
  };

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const f = await formBody(req);
    const resource = f.resource ?? null;
    if (f.grant_type === 'authorization_code') {
      const t = exchangeCode(
        db,
        {
          code: f.code,
          clientId: f.client_id,
          redirectUri: f.redirect_uri,
          verifier: f.code_verifier,
          resource,
        },
        { now: now() },
      );
      const { grant: _grant, ...set } = t;
      return send(res, 200, set);
    }
    if (f.grant_type === 'refresh_token') {
      const t = refreshTokens(
        db,
        { refreshToken: f.refresh_token, clientId: f.client_id, scope: f.scope, resource },
        { now: now() },
      );
      const { grant: _grant, ...set } = t;
      return send(res, 200, set);
    }
    if (f.grant_type === DEVICE_CODE_GRANT) {
      const r = pollDeviceAuthorization(
        db,
        { deviceCode: f.device_code, clientId: f.client_id },
        now(),
      );
      audit(req, r.device, 'device.connect', r.device, { replaced: r.replaced });
      return send(res, 200, { access_token: r.token, token_type: 'Bearer', device: r.device });
    }
    throw new OAuthError(
      'unsupported_grant_type',
      'Use authorization_code, refresh_token, or the device code grant.',
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const wellKnown =
      path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/mcp' ||
      path === '/.well-known/oauth-authorization-server';
    if (!wellKnown && !path.startsWith('/oauth/')) return false;
    const issuer = oauthIssuer(req, o.publicUrl);
    if (issuer === null) {
      // Not offered at this origin: a hub without a public URL answers loopback requests only.
      send(res, 404, { error: 'not_found', error_description: 'Not found.' });
      return true;
    }
    const method = req.method ?? 'GET';
    try {
      if (wellKnown) {
        const cors = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'MCP-Protocol-Version',
        };
        if (method === 'OPTIONS') {
          res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET' }).end();
          return true;
        }
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        send(
          res,
          200,
          path === '/.well-known/oauth-authorization-server'
            ? authorizationServerMetadata(issuer)
            : protectedResourceMetadata(issuer),
          { ...cors, 'Cache-Control': 'public, max-age=3600' },
        );
        return true;
      }
      switch (path) {
        case '/oauth/authorize': {
          if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
          // The consent page is the admin UI's, behind its sign-in. The query is written again,
          // encoded, so that it survives the sign-in's `next` (see safeNext).
          const query = new URLSearchParams(url.searchParams).toString();
          res.writeHead(302, {
            Location: `/admin/oauth/authorize?${query}`,
            'Content-Length': 0,
            ...NO_STORE,
          });
          res.end();
          return true;
        }
        case '/oauth/register': {
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
          const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
          const raw = await readLimited(req);
          if (type !== 'application/json') {
            throw new OAuthError('invalid_client_metadata', 'Send the client metadata as JSON.');
          }
          let meta: unknown;
          try {
            meta = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new OAuthError('invalid_client_metadata', 'The body is not JSON.');
          }
          if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
            throw new OAuthError('invalid_client_metadata', 'The body must be a JSON object.');
          }
          send(res, 201, registerClient(db, meta as Record<string, unknown>, now()).response);
          return true;
        }
        case '/oauth/token':
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
          await token(req, res);
          return true;
        case '/oauth/revoke': {
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
          const f = await formBody(req);
          const grant = revokeOAuthToken(db, { token: f.token, clientId: f.client_id }, now());
          if (grant)
            audit(req, agentActor(db, grant.name), 'grant.revoke', grant.name, {
              client: grant.clientName,
            });
          send(res, 200, {});
          return true;
        }
        case '/oauth/device': {
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
          const f = await formBody(req);
          const r = startDeviceAuthorization(
            db,
            { clientId: f.client_id, device: f.device_name, ip: who(req).ip },
            now(),
          );
          const verify = `${issuer}/admin/activate`;
          send(res, 200, {
            device_code: r.deviceCode,
            user_code: r.userCode,
            verification_uri: verify,
            verification_uri_complete: `${verify}?code=${encodeURIComponent(r.userCode)}`,
            expires_in: r.expiresIn,
            interval: r.interval,
          });
          return true;
        }
        default:
          send(res, 404, { error: 'not_found', error_description: 'Not found.' });
          return true;
      }
    } catch (err) {
      if (err instanceof OAuthError) {
        reused(req, err.revoked);
        oauthError(res, err);
        return true;
      }
      if (err instanceof HttpError) {
        if (err.status === 405)
          res.setHeader(
            'Allow',
            path.startsWith('/.well-known/') ? 'GET' : path === '/oauth/authorize' ? 'GET' : 'POST',
          );
        send(res, err.status, { error: 'invalid_request', error_description: err.message });
        return true;
      }
      o.log?.(`oauth error: ${(err as Error).stack ?? String(err)}`);
      send(res, 500, { error: 'server_error', error_description: 'Internal error.' });
      return true;
    }
  }

  return {
    handle,
    challenge(req) {
      const issuer = oauthIssuer(req, o.publicUrl);
      return issuer === null
        ? 'Bearer'
        : `Bearer resource_metadata="${resourceMetadataUrl(issuer)}", scope="${DEFAULT_SCOPE}"`;
    },
  };
}
