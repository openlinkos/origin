import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createAdminHandler, createOAuthServer } from '@openlinkos/origin-admin';
import {
  createToken,
  type Database,
  getDeviceRequest,
  listAudit,
  listGrants,
  openDatabase,
  type ScryptParams,
  setAdminPassword,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Browser, pageProblems, request } from '../../admin/test/helpers.js';
import {
  cacheMs,
  createClientResolver,
  fetchClientDocument,
  isPublicAddress,
} from '../src/hub/client-metadata.js';
import { checkHub } from '../src/hub/connect.js';
import { connectByBrowser } from '../src/hub/device-flow.js';
import { createHubServer } from '../src/hub/server.js';
import { selfSignedCert } from './tls.js';

const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const TLS = selfSignedCert();
const WRITE_TOOLS = ['correct', 'forget', 'propose', 'remember'];

let tmp: string;
let db: Database;
let clock: number;
let servers: Array<http.Server | https.Server>;
let base: string;

async function listen(server: http.Server | https.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A hub with its admin UI at /admin, its OAuth endpoints, and a clock of the test's. */
async function startHub(o: { oauth?: boolean } = {}): Promise<string> {
  const resolveClient = createClientResolver(db, {
    allowPrivate: true,
    ca: TLS.cert,
    now: () => clock,
  });
  const withOAuth = o.oauth ?? true;
  const admin = createAdminHandler({
    db,
    home: tmp,
    version: 'test',
    now: () => clock,
    oauth: withOAuth ? { resolveClient } : null,
  });
  const server = createHubServer({
    db,
    home: tmp,
    adapters: [],
    version: 'test',
    admin,
    oauth: withOAuth
      ? createOAuthServer({ db, publicUrl: null, resolveClient, now: () => clock })
      : undefined,
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-oauth-'));
  db = openDatabase(path.join(tmp, 'origin.db'));
  await setAdminPassword(db, PASSWORD, { params: FAST });
  clock = Date.now();
  servers = [];
  base = await startHub();
});

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An MCP client's OAuth state, as Claude Code or Codex keep it, and where it sends the browser. */
class TestProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authUrl: URL | undefined;
  constructor(
    readonly redirect = 'http://localhost:33418/callback',
    readonly clientMetadataUrl?: string,
  ) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Code',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function signedIn(): Promise<Browser> {
  const b = new Browser(base);
  expect((await b.login(PASSWORD)).status).toBe(303);
  return b;
}

/** Open an authorization URL as the owner's browser and answer the consent page. */
async function consent(
  b: Browser,
  authUrl: URL,
  answer: { decision?: 'allow' | 'deny'; preset?: string; days?: string } = {},
): Promise<{ page: string; back: URL }> {
  const first = await request(authUrl.toString());
  expect(first.status).toBe(302);
  const location = first.headers.location ?? '';
  expect(location).toMatch(/^\/admin\/oauth\/authorize\?/);
  const page = await b.get(location);
  expect(page.status).toBe(200);
  expect(pageProblems(page.text)).toEqual([]);
  const params = Object.fromEntries(new URL(location, base).searchParams);
  const res = await b.post('/admin/oauth/authorize', {
    ...params,
    decision: answer.decision ?? 'allow',
    preset: answer.preset ?? 'readwrite',
    days: answer.days ?? '30',
  });
  expect(res.status).toBe(303);
  return { page: page.text, back: new URL(res.headers.location ?? '') };
}

/** Sign an SDK client in, as an agent signs in, and connect with it. */
async function signIn(
  provider: TestProvider,
  answer: { preset?: string } = {},
): Promise<{ client: Client; page: string }> {
  const url = new URL('/mcp', base);
  const first = new Client({ name: 'claude-code', version: '1.0.0' });
  await expect(
    first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })),
  ).rejects.toThrow(UnauthorizedError);
  expect(provider.authUrl).toBeDefined();
  const b = await signedIn();
  const { page, back } = await consent(b, provider.authUrl as URL, answer);
  expect(back.origin).toBe('http://localhost:33418');
  expect(back.searchParams.get('iss')).toBe(base);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await transport.finishAuth(back.searchParams.get('code') ?? '');
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  return { client, page };
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

describe('discovery', () => {
  it('points a 401 from /mcp at the metadata, which names the hub as the authorization server', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="readwrite"`,
    );
    expect((await fetch(`${base}/v1/device`)).headers.get('www-authenticate')).toBe('Bearer');
    for (const p of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      expect(await (await fetch(`${base}${p}`)).json()).toEqual({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['readwrite', 'readonly'],
        bearer_methods_supported: ['header'],
        resource_name: 'Origin',
        resource_documentation: 'https://origin.openlinkos.com/guide/connect-agents',
      });
    }
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      device_authorization_endpoint: `${base}/oauth/device`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['readwrite', 'readonly', 'offline_access'],
    });
  });

  it('says nothing without the admin UI: no metadata, and a plain 401 as before', async () => {
    const plain = await startHub({ oauth: false });
    for (const p of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/device',
    ]) {
      expect((await fetch(`${plain}${p}`)).status).toBe(404);
    }
    const res = await fetch(`${plain}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await request(`${plain}/admin/activate`)).status).toBe(303); // sign in first…
    const b = new Browser(plain);
    await b.login(PASSWORD);
    expect((await b.get('/admin/activate')).status).toBe(404); // …and there is no such page
    expect((await b.get('/admin/oauth/authorize?client_id=x')).status).toBe(404);
  });

  it('is offered only at the origins the admin UI answers', async () => {
    const res = await request(`${base}/.well-known/oauth-authorization-server`, {
      headers: { Host: 'hub.evil.example' },
    });
    expect(res.status).toBe(404);
  });
});

describe('agents signing in by OAuth', () => {
  it('register, get the owner’s consent, and use /mcp as an agent of the owner', async () => {
    const provider = new TestProvider();
    const { client, page } = await signIn(provider);
    expect(page).toContain('Claude Code wants to use your Origin memory');
    expect(page).toContain('localhost:33418');
    expect(page).toContain('cannot prove which app it is');
    expect(page).toContain('registered itself with this hub');
    expect(provider.info?.client_id).toMatch(/^ocl_/);
    expect(provider.saved).toMatchObject({
      token_type: 'Bearer',
      scope: expect.stringContaining('readwrite'),
    });
    expect(provider.saved?.refresh_token).toMatch(/^ogr_/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(WRITE_TOOLS));
    const [grant] = listGrants(db);
    expect(grant).toMatchObject({
      name: 'claude-code',
      clientName: 'Claude Code',
      preset: 'readwrite',
    });
    expect(grant!.expiresAt - grant!.createdAt).toBe(30 * 86_400_000);
    await client.close();
    // Listed on Devices and agents, and audited under the owner's username.
    const b = await signedIn();
    const list = await b.get('/admin/tokens');
    expect(list.text).toContain('claude-code');
    expect(list.text).toContain('Agents signed in by browser');
    expect(listAudit(db).find((r) => r.action === 'oauth.allow')).toMatchObject({
      actor: 'owner',
      channel: 'ui',
      target: 'Claude Code',
      detail: { preset: 'readwrite', days: 30 },
    });
  });

  it('serve a readonly agent without the tools that write, and keep OAuth tokens to /mcp', async () => {
    const provider = new TestProvider();
    const { client } = await signIn(provider, { preset: 'readonly' });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain('search');
    await client.close();
    const token = provider.saved?.access_token ?? '';
    const v1 = await fetch(`${base}/v1/device`, { headers: { Authorization: `Bearer ${token}` } });
    expect(v1.status).toBe(403);
    expect((await v1.json()).error).toMatch(/MCP endpoint/);
  });

  it('let the owner deny, and say so to the app', async () => {
    const provider = new TestProvider();
    const first = new Client({ name: 'x', version: '1' });
    await expect(
      first.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', base), { authProvider: provider }),
      ),
    ).rejects.toThrow(UnauthorizedError);
    const { back } = await consent(await signedIn(), provider.authUrl as URL, { decision: 'deny' });
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(base);
    expect(listGrants(db)).toEqual([]);
  });

  it('describe an app by its client ID metadata document, fetched over https', async () => {
    const port = await listen(
      https.createServer({ cert: TLS.cert, key: TLS.key }, (req, res) => {
        const id = `https://localhost:${port}${req.url}`;
        const doc =
          req.url === '/codex.json'
            ? { client_id: id, client_name: 'Codex', redirect_uris: ['http://localhost/callback'] }
            : {
                client_id: 'https://someone-else.example/c.json',
                client_name: 'X',
                redirect_uris: ['http://localhost/cb'],
              };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' });
        res.end(JSON.stringify(doc));
      }),
    );
    const provider = new TestProvider(
      'http://localhost:33418/callback',
      `https://localhost:${port}/codex.json`,
    );
    const { client, page } = await signIn(provider);
    expect(page).toContain('Codex wants to use your Origin memory');
    expect(page).toContain(`The app describes itself at localhost:${port}.`);
    expect(provider.info?.client_id).toBe(`https://localhost:${port}/codex.json`);
    expect(listGrants(db)[0]).toMatchObject({
      name: 'codex',
      clientId: `https://localhost:${port}/codex.json`,
    });
    await client.close();

    // A document that names another client is refused, on the page, without a redirect.
    const b = await signedIn();
    const bad = await b.get(
      `/admin/oauth/authorize?${new URLSearchParams({
        client_id: `https://localhost:${port}/other.json`,
        redirect_uri: 'http://localhost:1/cb',
        response_type: 'code',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('another client_id than its own URL');
  });

  it('refuse a wrong redirect on the page, and a wrong resource or no PKCE back at the app', async () => {
    const reg = await (
      await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Tester',
          redirect_uris: ['http://127.0.0.1:5000/cb'],
        }),
      })
    ).json();
    expect(reg.client_id).toMatch(/^ocl_/);
    const b = await signedIn();
    const authorize = (extra: Record<string, string>) =>
      b.get(
        `/admin/oauth/authorize?${new URLSearchParams({
          client_id: reg.client_id,
          redirect_uri: 'http://127.0.0.1:6000/cb',
          response_type: 'code',
          code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
          code_challenge_method: 'S256',
          state: 'st',
          ...extra,
        })}`,
      );
    const wrongRedirect = await authorize({ redirect_uri: 'http://127.0.0.1:6000/elsewhere' });
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.location).toBeUndefined();
    const wrongResource = await authorize({ resource: 'https://other.example/mcp' });
    expect(wrongResource.status).toBe(303);
    const back = new URL(wrongResource.headers.location ?? '');
    expect([back.origin, back.searchParams.get('error'), back.searchParams.get('state')]).toEqual([
      'http://127.0.0.1:6000',
      'invalid_target',
      'st',
    ]);
    const noPkce = await authorize({ code_challenge: '' });
    expect(new URL(noPkce.headers.location ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    // Another port on the loopback address is fine (RFC 8252); the consent page allows posting there.
    const ok = await authorize({});
    expect(ok.status).toBe(200);
    expect(ok.headers['content-security-policy']).toContain(
      "form-action 'self' http://127.0.0.1:6000;",
    );
    expect(
      (
        await fetch(`${base}/oauth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
        })
      ).status,
    ).toBe(400);
  });

  it('exchange a code once with PKCE, rotate refresh tokens, revoke on reuse, and on request', async () => {
    const provider = new TestProvider();
    const { client } = await signIn(provider);
    await client.close();
    const clientId = provider.info?.client_id ?? '';
    const first = provider.saved as OAuthTokens;
    const refresh = (token: string) =>
      fetch(
        `${base}/oauth/token`,
        form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
      );
    const r1 = await refresh(first.refresh_token ?? '');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('cache-control')).toBe('no-store');
    const second = (await r1.json()) as OAuthTokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const mcp = (token: string) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await mcp(second.access_token)).status).toBe(200);
    // The first refresh token again: it was copied, so the whole grant goes.
    const reuse = await refresh(first.refresh_token ?? '');
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe('invalid_grant');
    expect((await mcp(second.access_token)).status).toBe(401);
    expect(listGrants(db)[0]).toMatchObject({ revokedBy: 'reuse' });
    expect(listAudit(db)[0]).toMatchObject({
      actor: 'owner / claude-code',
      channel: 'api',
      action: 'grant.reuse',
      target: 'claude-code',
    });

    // Sign in again, then sign out: revoking the refresh token ends the grant.
    const again = new TestProvider();
    (await signIn(again)).client.close();
    const tokens = again.saved as OAuthTokens;
    const revoke = await fetch(
      `${base}/oauth/revoke`,
      form({ token: tokens.refresh_token ?? '', client_id: again.info?.client_id ?? '' }),
    );
    expect(revoke.status).toBe(200);
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect(listAudit(db)[0]).toMatchObject({
      actor: 'owner / claude-code',
      action: 'grant.revoke',
    });
  });

  it('refuse a code presented twice, or with the wrong verifier', async () => {
    const reg = await (
      await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Tester',
          redirect_uris: ['http://127.0.0.1:5000/cb'],
        }),
      })
    ).json();
    const verifier = 'v'.repeat(43);
    const b = await signedIn();
    const getCode = async () => {
      const params = {
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:5000/cb',
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: `${base}/mcp`,
      };
      const res = await b.post('/admin/oauth/authorize', {
        ...params,
        decision: 'allow',
        preset: 'readwrite',
        days: '1',
      });
      return new URL(res.headers.location ?? '').searchParams.get('code') ?? '';
    };
    const exchange = (code: string, v = verifier) =>
      fetch(
        `${base}/oauth/token`,
        form({
          grant_type: 'authorization_code',
          code,
          client_id: reg.client_id,
          redirect_uri: 'http://127.0.0.1:5000/cb',
          code_verifier: v,
          resource: `${base}/mcp`,
        }),
      );
    const wrong = await exchange(await getCode(), 'w'.repeat(43));
    expect(await wrong.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringMatching(/PKCE/),
    });
    const code = await getCode();
    expect((await exchange(code)).status).toBe(200);
    const twice = await exchange(code);
    expect(await twice.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringMatching(/already used/),
    });
    expect(listGrants(db)[0]).toMatchObject({ revokedBy: 'reuse' });
    // Grant types and bodies the endpoint does not take.
    expect(
      await (await fetch(`${base}/oauth/token`, form({ grant_type: 'password' }))).json(),
    ).toMatchObject({
      error: 'unsupported_grant_type',
    });
    expect(
      (
        await fetch(`${base}/oauth/token`, {
          method: 'POST',
          body: '{}',
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('tokens with presets', () => {
  it('keep a readonly agent to reading, and every earlier token as it was', async () => {
    const reader = createToken(db, 'reader', Date.now(), { kind: 'agent', preset: 'readonly' });
    const legacy = createToken(db, 'laptop');
    const tools = async (token: string) => {
      const client = new Client({ name: 'x', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', base), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return names;
    };
    expect(await tools(reader)).not.toEqual(expect.arrayContaining(['remember']));
    expect(await tools(legacy)).toEqual(expect.arrayContaining(WRITE_TOOLS));
    const post = (token: string, p: string, body: string, type = 'application/json') =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
        body,
      });
    const line = `${JSON.stringify({ id: 'l1', session: 's1', time: '2026-11-01T00:00:00Z', role: 'user', text: 'hi' })}\n`;
    for (const [p, body, type] of [
      ['/v1/sources/notes/lines?path=a.jsonl', line, 'application/x-ndjson'],
      ['/v1/entries', JSON.stringify({ entries: [] })],
      ['/v1/tombstones', JSON.stringify({ tombstones: [] })],
      ['/v1/recalls', JSON.stringify({ recalls: [] })],
      ['/v1/ingest', JSON.stringify({})],
    ] as const) {
      const res = await post(reader, p, body, type);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/read-only agent/);
    }
    expect(
      (
        await fetch(`${base}/v1/tombstones?after=0`, {
          headers: { Authorization: `Bearer ${reader}` },
        })
      ).status,
    ).toBe(200);
    expect((await post(legacy, '/v1/entries', JSON.stringify({ entries: [] }))).status).toBe(200);
  });
});

describe('devices connecting by browser', () => {
  const device = (name: string) =>
    fetch(`${base}/oauth/device`, form({ client_id: 'origin', device_name: name }));
  const poll = (code: string) =>
    fetch(
      `${base}/oauth/token`,
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code,
        client_id: 'origin',
      }),
    );

  it('wait, slow down, are approved by the owner, and get a device token', async () => {
    const res = await device('desk');
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d).toMatchObject({
      verification_uri: `${base}/admin/activate`,
      verification_uri_complete: `${base}/admin/activate?code=${encodeURIComponent(d.user_code)}`,
      expires_in: 600,
      interval: 5,
    });
    expect(await (await poll(d.device_code)).json()).toMatchObject({
      error: 'authorization_pending',
    });
    expect(await (await poll(d.device_code)).json()).toMatchObject({ error: 'slow_down' });

    const b = await signedIn();
    const page = await b.get(`/admin/activate?code=${encodeURIComponent(d.user_code)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Connect device desk to your hub?');
    expect(pageProblems(page.text)).toEqual([]);
    const done = await b.post('/admin/activate', { code: d.user_code, decision: 'approve' });
    expect(done.text).toContain('desk is connected');

    clock += 20_000;
    const got = await poll(d.device_code);
    expect(got.status).toBe(200);
    const { access_token: token } = await got.json();
    expect(token).toMatch(/^ogn_/);
    await expect(
      checkHub({ url: base, token, device: 'desk' }, { renamable: false }),
    ).resolves.toBeUndefined();
    expect(await (await poll(d.device_code)).json()).toMatchObject({ error: 'invalid_grant' });
    expect(
      listAudit(db)
        .slice(0, 2)
        .map((r) => [r.actor, r.channel, r.action, r.target]),
    ).toEqual([
      ['desk', 'api', 'device.connect', 'desk'],
      ['owner', 'ui', 'device.approve', 'desk'],
    ]);
  });

  it('report a denial and an expiry, and refuse unknown codes on the page', async () => {
    const denied = await (await device('desk')).json();
    const b = await signedIn();
    await b.get(`/admin/activate?code=${denied.user_code}`);
    expect(
      (await b.post('/admin/activate', { code: denied.user_code, decision: 'deny' })).text,
    ).toContain('desk was not connected');
    expect(await (await poll(denied.device_code)).json()).toMatchObject({ error: 'access_denied' });
    const late = await (await device('desk')).json();
    clock += 11 * 60_000;
    expect(await (await poll(late.device_code)).json()).toMatchObject({ error: 'expired_token' });
    // Approving needs the password entered within 10 minutes: sign in again.
    expect((await b.get(`/admin/activate?code=${late.user_code}`)).headers.location).toMatch(
      /^\/admin\/reauth/,
    );
    const again = await signedIn();
    expect((await again.get(`/admin/activate?code=${late.user_code}`)).text).toContain(
      'This code expired',
    );
    expect((await again.get('/admin/activate?code=BCDF-GHJK')).text).toContain(
      'No device is waiting',
    );
    expect((await again.get('/admin/activate')).text).toContain('Enter the code');
    expect(
      await (
        await fetch(`${base}/oauth/device`, form({ client_id: 'claude', device_name: 'x' }))
      ).json(),
    ).toMatchObject({
      error: 'invalid_client',
    });
  });

  it('connect `origin hub connect` without a token, at the polling interval', async () => {
    const said: string[] = [];
    const waits: number[] = [];
    let approved = false;
    const token = await connectByBrowser(base, 'studio', {
      log: (m) => said.push(m),
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
        if (!approved && waits.length === 2) {
          const code = /enter the code ([A-Z]{4}-[A-Z]{4})/.exec(said.join('\n'))?.[1] ?? '';
          expect(getDeviceRequest(db, code)?.device).toBe('studio');
          const b = await signedIn();
          await b.post('/admin/activate', { code, decision: 'approve' });
          approved = true;
        }
      },
    });
    expect(said.join('\n')).toContain(`${base}/admin/activate?code=`);
    expect(waits).toEqual([5000, 5000]);
    await expect(
      checkHub({ url: base, token, device: 'studio' }, { renamable: false }),
    ).resolves.toBeUndefined();
  });

  it('say how to connect with a token to a hub that has no browser sign-in', async () => {
    const plain = await startHub({ oauth: false });
    await expect(connectByBrowser(plain, 'desk', { log: () => {} })).rejects.toThrow(
      /origin token create desk/,
    );
  });
});

describe('client metadata documents', () => {
  it('are fetched from public https addresses only, small, quickly, and cached within bounds', async () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '169.254.169.254',
      '::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      'fd00::1',
      '0.0.0.0',
    ]) {
      expect(isPublicAddress(a)).toBe(false);
    }
    for (const a of [
      '93.184.216.34',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      // A proxy's fake-IP DNS answers with addresses of the benchmarking ranges.
      '198.18.3.227',
      '2001:2::3dd',
    ]) {
      expect(isPublicAddress(a)).toBe(true);
    }
    for (const a of ['64:ff9b::a00:1', '100.100.1.2', '2001:db8::1'])
      expect(isPublicAddress(a)).toBe(false);
    expect(cacheMs('max-age=60')).toBe(5 * 60_000);
    expect(cacheMs('public, max-age=7200')).toBe(7_200_000);
    expect(cacheMs('max-age=999999')).toBe(86_400_000);
    expect(cacheMs(undefined)).toBe(3_600_000);
    expect(cacheMs('no-store')).toBe(5 * 60_000);

    let hits = 0;
    const port = await listen(
      https.createServer({ cert: TLS.cert, key: TLS.key }, (req, res) => {
        hits++;
        if (req.url === '/big.json') return res.end('x'.repeat(10_000));
        if (req.url === '/slow.json') return setTimeout(() => res.end('{}'), 1000);
        if (req.url === '/hop.json') {
          res.writeHead(302, { Location: 'https://127.0.0.1:1/private.json' });
          return res.end();
        }
        const id = `https://localhost:${port}${req.url}`;
        res.end(
          JSON.stringify({
            client_id: id,
            client_name: 'App',
            redirect_uris: ['https://app.example/cb'],
          }),
        );
      }),
    );
    const at = (p: string) => `https://localhost:${port}${p}`;
    // localhost is not a public address: refused unless a test allows it.
    await expect(fetchClientDocument(at('/a.json'), { ca: TLS.cert })).rejects.toThrow(
      /not a public address/,
    );
    expect(hits).toBe(0);
    await expect(
      fetchClientDocument(at('/big.json'), { ca: TLS.cert, allowPrivate: true }),
    ).rejects.toThrow(/larger than/);
    await expect(
      fetchClientDocument(at('/slow.json'), { ca: TLS.cert, allowPrivate: true, timeoutMs: 200 }),
    ).rejects.toThrow(/too long/);
    await expect(
      fetchClientDocument(`http://localhost:${port}/a.json`, { allowPrivate: true }),
    ).rejects.toThrow(/only https/);
    // A redirect is checked like the first address.
    await expect(
      fetchClientDocument(at('/hop.json'), { ca: TLS.cert, allowPrivate: false }),
    ).rejects.toThrow(/not a public address/);

    const resolve = createClientResolver(db, {
      ca: TLS.cert,
      allowPrivate: true,
      now: () => clock,
    });
    const before = hits;
    expect((await resolve(at('/a.json'))).name).toBe('App');
    await resolve(at('/a.json'));
    expect(hits).toBe(before + 1);
    clock += 2 * 3_600_000;
    await resolve(at('/a.json'));
    expect(hits).toBe(before + 2);
  });
});
