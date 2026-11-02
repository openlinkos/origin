import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  type AuthorizationRequest,
  agentActor,
  checkAdminUsername,
  checkAuthorizationRequest,
  checkRedirectUri,
  createAuthorizationCode,
  createToken,
  type Database,
  DEVICE_REQUEST_TTL_MS,
  decideDeviceRequest,
  exchangeCode,
  getAdminUsername,
  getDeviceRequest,
  initStoreName,
  isClientIdUrl,
  listGrants,
  listTokens,
  normalizeUserCode,
  OAuthError,
  OriginError,
  openMemoryDatabase,
  pollDeviceAuthorization,
  redirectMatches,
  refreshTokens,
  registerClient,
  revokeGrant,
  revokeOAuthToken,
  saveClientDocument,
  setAdminUsername,
  startDeviceAuthorization,
  verifyBearer,
} from '../src/index.js';

const ISSUER = 'https://hub.example.com';
const RESOURCE = `${ISSUER}/mcp`;
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let db: Database;

beforeEach(() => {
  db = openMemoryDatabase();
  initStoreName(db, 'hub');
});
afterEach(() => db.close());

/** What an OAuthError carries, or the error itself if it is another. */
function oauthError(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof OAuthError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected an OAuthError');
}

function register(name = 'Claude Code', redirect = 'http://localhost:33418/callback') {
  return registerClient(db, { client_name: name, redirect_uris: [redirect] }, 1000).client;
}

function authorize(params: Record<string, string>): ReturnType<typeof checkAuthorizationRequest> {
  return checkAuthorizationRequest(db, (k) => params[k] ?? null, {
    resource: RESOURCE,
    issuer: ISSUER,
  });
}

function request(clientId: string, extra: Record<string, string> = {}): AuthorizationRequest {
  const r = authorize({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://localhost:40001/callback',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: RESOURCE,
    ...extra,
  });
  if (!r.ok) throw new Error(`${r.error}: ${r.description}`);
  return r.request;
}

describe('the owner username', () => {
  it('is none until set, then normalized and checked', () => {
    expect(getAdminUsername(db)).toBeNull();
    expect(setAdminUsername(db, '  HCZhang ')).toBe('hczhang');
    expect(getAdminUsername(db)).toBe('hczhang');
    for (const bad of ['a', 'x'.repeat(33), 'with space', 'dana!', '']) {
      expect(() => checkAdminUsername(bad)).toThrow(OriginError);
    }
    for (const good of ['dana', 'd.ana_2-x', '42'])
      expect(() => checkAdminUsername(good)).not.toThrow();
    expect(agentActor(db, 'claude-code')).toBe('hczhang / claude-code');
  });
});

describe('clients', () => {
  it('register public clients with loopback or https redirect URIs only', () => {
    const { client, response } = registerClient(
      db,
      {
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:33418/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
      5000,
    );
    expect(client.id).toMatch(/^ocl_/);
    expect(response).toMatchObject({
      client_id: client.id,
      client_id_issued_at: 5,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    expect(response).not.toHaveProperty('client_secret');
    for (const uri of [
      'http://example.com/cb',
      'http://192.168.1.2:8080/cb',
      'ftp://localhost/cb',
      'https://app.example.com/cb#frag',
      'not a url',
    ]) {
      expect(oauthError(() => checkRedirectUri(uri)).code).toBe('invalid_redirect_uri');
    }
    expect(checkRedirectUri('http://127.0.0.1:1234/callback')).toBe(
      'http://127.0.0.1:1234/callback',
    );
    expect(checkRedirectUri('https://app.example.com/cb')).toBe('https://app.example.com/cb');
    expect(
      oauthError(() => registerClient(db, { redirect_uris: ['http://evil.example/cb'] })).code,
    ).toBe('invalid_redirect_uri');
    expect(
      oauthError(() =>
        registerClient(db, { redirect_uris: ['http://localhost/cb'], grant_types: ['password'] }),
      ).code,
    ).toBe('invalid_client_metadata');
  });

  it('match a loopback redirect URI on any port, anything else exactly', () => {
    const registered = ['http://127.0.0.1/callback', 'https://app.example.com/cb'];
    expect(redirectMatches(registered, 'http://127.0.0.1:52011/callback')).toBe(true);
    expect(redirectMatches(registered, 'http://127.0.0.1:52011/other')).toBe(false);
    expect(redirectMatches(registered, 'http://localhost:52011/callback')).toBe(false);
    expect(redirectMatches(registered, 'https://app.example.com/cb')).toBe(true);
    expect(redirectMatches(registered, 'https://app.example.com:444/cb')).toBe(false);
  });

  it('take metadata documents whose client_id is their URL', () => {
    const id = 'https://app.example.com/oauth/client.json';
    expect(isClientIdUrl(id)).toBe(true);
    for (const bad of [
      'http://app.example.com/c.json',
      'https://app.example.com',
      'https://app.example.com/a/../c',
    ]) {
      expect(isClientIdUrl(bad)).toBe(false);
    }
    const doc = {
      client_id: id,
      client_name: 'Example',
      redirect_uris: ['http://127.0.0.1/callback'],
    };
    const client = saveClientDocument(db, id, doc, { now: 1, expiresAt: 100 });
    expect(client).toMatchObject({ id, name: 'Example', document: true, expiresAt: 100 });
    expect(
      oauthError(() =>
        saveClientDocument(db, id, { ...doc, client_id: `${id}x` }, { expiresAt: 1 }),
      ).code,
    ).toBe('invalid_client');
    expect(
      oauthError(() => saveClientDocument(db, id, { ...doc, client_name: '' }, { expiresAt: 1 }))
        .code,
    ).toBe('invalid_client');
    expect(
      oauthError(() =>
        saveClientDocument(
          db,
          id,
          { ...doc, token_endpoint_auth_method: 'private_key_jwt' },
          { expiresAt: 1 },
        ),
      ).message,
    ).toMatch(/public clients only/);
    expect(
      oauthError(() =>
        saveClientDocument(
          db,
          id,
          { ...doc, redirect_uris: ['http://evil.example/cb'] },
          { expiresAt: 1 },
        ),
      ).code,
    ).toBe('invalid_client');
  });
});

describe('authorization requests', () => {
  it('show client and redirect errors to the owner, and send the others back', () => {
    const client = register();
    expect(authorize({ client_id: 'ocl_nobody' })).toMatchObject({
      ok: false,
      redirect: null,
      error: 'invalid_client',
    });
    expect(
      authorize({ client_id: client.id, redirect_uri: 'http://localhost:1/elsewhere' }),
    ).toMatchObject({ ok: false, redirect: null });
    const base = {
      client_id: client.id,
      redirect_uri: 'http://localhost:40001/callback',
      state: 's1',
    };
    const back = (params: Record<string, string>) => {
      const r = authorize({ ...base, ...params });
      if (r.ok || r.redirect === null) throw new Error('expected a redirect');
      const url = new URL(r.redirect);
      expect(url.origin).toBe('http://localhost:40001');
      expect(url.searchParams.get('state')).toBe('s1');
      expect(url.searchParams.get('iss')).toBe(ISSUER);
      return url.searchParams.get('error');
    };
    expect(back({ response_type: 'token' })).toBe('unsupported_response_type');
    expect(back({ response_type: 'code' })).toBe('invalid_request'); // no PKCE
    expect(
      back({ response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'plain' }),
    ).toBe('invalid_request');
    const pkce = {
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    };
    expect(back({ ...pkce, resource: 'https://elsewhere.example/mcp' })).toBe('invalid_target');
    expect(back({ ...pkce, scope: 'admin' })).toBe('invalid_scope');
    expect(authorize({ ...base, ...pkce, resource: 'HTTPS://HUB.example.com/mcp/' })).toMatchObject(
      { ok: true },
    );
  });

  it('let the owner grant readonly to an app that asked for readwrite, never the reverse', () => {
    const client = register();
    expect(request(client.id).presets).toEqual(['readwrite', 'readonly']);
    expect(request(client.id, { scope: 'readwrite offline_access' })).toMatchObject({
      presets: ['readwrite', 'readonly'],
      offline: true,
    });
    const readonly = request(client.id, { scope: 'readonly' });
    expect(readonly.presets).toEqual(['readonly']);
    expect(() => createAuthorizationCode(db, readonly, { preset: 'readwrite', days: 30 })).toThrow(
      /readonly access only/,
    );
    expect(() => createAuthorizationCode(db, readonly, { preset: 'readonly', days: 7 })).toThrow(
      /days/,
    );
  });
});

describe('codes and tokens', () => {
  function issue(now = 10_000, preset: 'readwrite' | 'readonly' = 'readwrite') {
    const client = register();
    const req = request(client.id, { scope: 'readwrite offline_access' });
    const code = createAuthorizationCode(db, req, { preset, days: 30 }, now);
    return { client, code };
  }

  it('exchange a code once, with PKCE, for an agent of the owner', () => {
    const { client, code } = issue();
    const tokens = exchangeCode(
      db,
      {
        code,
        clientId: client.id,
        redirectUri: 'http://localhost:40001/callback',
        verifier: VERIFIER,
        resource: RESOURCE,
      },
      { now: 11_000 },
    );
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: 'readwrite offline_access',
    });
    expect(tokens.access_token).toMatch(/^oga_/);
    expect(tokens.refresh_token).toMatch(/^ogr_/);
    expect(tokens.grant).toMatchObject({
      name: 'claude-code',
      clientName: 'Claude Code',
      preset: 'readwrite',
    });
    expect(verifyBearer(db, tokens.access_token, 12_000)).toEqual({
      kind: 'agent',
      name: 'claude-code',
      preset: 'readwrite',
      via: 'oauth',
      grantId: tokens.grant.id,
    });
    // Hashes only.
    const stored = JSON.stringify(db.prepare('SELECT * FROM oauth_token').all());
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    expect(verifyBearer(db, tokens.access_token, 11_000 + ACCESS_TOKEN_TTL_MS)).toBeNull();
  });

  it('use a code up on its first presentation, and revoke what it gave when it comes again', () => {
    const { client, code } = issue();
    const input = { code, clientId: client.id, verifier: VERIFIER };
    const first = exchangeCode(db, input, { now: 11_000 });
    const again = (() => {
      try {
        exchangeCode(db, input, { now: 12_000 });
      } catch (err) {
        return err as OAuthError;
      }
      throw new Error('expected an error');
    })();
    expect(again.code).toBe('invalid_grant');
    expect(again.revoked?.id).toBe(first.grant.id);
    expect(verifyBearer(db, first.access_token, 12_000)).toBeNull();
  });

  it('refuse a wrong verifier, client, redirect, resource, or an expired code, and use the code up', () => {
    const cases: Array<[Record<string, unknown>, RegExp | string]> = [
      [{ verifier: 'b'.repeat(43) }, /does not match/],
      [{ verifier: 'short' }, /send the code_verifier/],
      [{ clientId: 'ocl_other' }, /another client/],
      [{ redirectUri: 'http://localhost:40001/other' }, /redirect_uri/],
      [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
    ];
    for (const [change, expected] of cases) {
      const { client, code } = issue();
      const input = { code, clientId: client.id, verifier: VERIFIER, ...change };
      const err = oauthError(() => exchangeCode(db, input, { now: 11_000 }));
      if (typeof expected === 'string') expect(err.code).toBe(expected);
      else expect(err.message).toMatch(expected);
      // The code is spent even though the exchange failed.
      expect(
        oauthError(() =>
          exchangeCode(db, { code, clientId: client.id, verifier: VERIFIER }, { now: 11_500 }),
        ).message,
      ).toMatch(/already used/);
    }
    const { client, code } = issue(10_000);
    expect(
      oauthError(() =>
        exchangeCode(
          db,
          { code, clientId: client.id, verifier: VERIFIER },
          { now: 10_000 + AUTHORIZATION_CODE_TTL_MS },
        ),
      ).message,
    ).toMatch(/expired/);
    expect(listGrants(db)).toEqual([]);
  });

  it('rotate refresh tokens, and revoke the grant when one is used twice', () => {
    const { client, code } = issue();
    const first = exchangeCode(
      db,
      { code, clientId: client.id, verifier: VERIFIER },
      { now: 11_000 },
    );
    const second = refreshTokens(
      db,
      { refreshToken: first.refresh_token, clientId: client.id, resource: RESOURCE },
      { now: 20_000 },
    );
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(verifyBearer(db, second.access_token, 20_001)).not.toBeNull();
    // The first access token stays valid until it expires; the first refresh token is spent.
    const reuse = (() => {
      try {
        refreshTokens(
          db,
          { refreshToken: first.refresh_token, clientId: client.id },
          { now: 21_000 },
        );
      } catch (err) {
        return err as OAuthError;
      }
      throw new Error('expected an error');
    })();
    expect(reuse.code).toBe('invalid_grant');
    expect(reuse.revoked).toMatchObject({ id: first.grant.id, revokedBy: 'reuse' });
    expect(verifyBearer(db, second.access_token, 21_001)).toBeNull();
    expect(
      oauthError(() =>
        refreshTokens(
          db,
          { refreshToken: second.refresh_token, clientId: client.id },
          { now: 22_000 },
        ),
      ).code,
    ).toBe('invalid_grant');
  });

  it('refuse a refresh of another client, past the grant, or wider than it', () => {
    const { client, code } = issue(10_000, 'readonly');
    const t = exchangeCode(db, { code, clientId: client.id, verifier: VERIFIER }, { now: 11_000 });
    expect(t.grant.preset).toBe('readonly');
    expect(
      oauthError(() =>
        refreshTokens(
          db,
          { refreshToken: t.refresh_token, clientId: 'ocl_other' },
          { now: 12_000 },
        ),
      ).message,
    ).toMatch(/another client/);
    expect(
      oauthError(() =>
        refreshTokens(
          db,
          { refreshToken: t.refresh_token, clientId: client.id, scope: 'readwrite' },
          { now: 12_000 },
        ),
      ).code,
    ).toBe('invalid_scope');
    expect(
      oauthError(() =>
        refreshTokens(
          db,
          { refreshToken: t.refresh_token, clientId: client.id },
          { now: 11_000 + 31 * 86_400_000 },
        ),
      ).code,
    ).toBe('invalid_grant');
  });

  it('revoke by the client: a refresh token ends its grant, an access token itself', () => {
    const { client, code } = issue();
    const t = exchangeCode(db, { code, clientId: client.id, verifier: VERIFIER }, { now: 11_000 });
    expect(
      revokeOAuthToken(db, { token: t.access_token, clientId: 'ocl_other' }, 12_000),
    ).toBeNull();
    expect(verifyBearer(db, t.access_token, 12_000)).not.toBeNull();
    expect(revokeOAuthToken(db, { token: t.access_token, clientId: client.id }, 12_000)).toBeNull();
    expect(verifyBearer(db, t.access_token, 12_000)).toBeNull();
    const revoked = revokeOAuthToken(db, { token: t.refresh_token, clientId: client.id }, 13_000);
    expect(revoked).toMatchObject({ id: t.grant.id, revokedBy: 'client' });
    // A preset token is the owner's to revoke.
    const ci = createToken(db, 'ci', 1, { kind: 'agent' });
    expect(revokeOAuthToken(db, { token: ci }, 14_000)).toBeNull();
    expect(verifyBearer(db, ci, 14_000)).toMatchObject({ name: 'ci', via: 'token' });
  });

  it('name each agent after its app, apart from tokens and other active grants', () => {
    createToken(db, 'claude-code', 1, { kind: 'agent' });
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { client, code } = issue();
      names.push(
        exchangeCode(db, { code, clientId: client.id, verifier: VERIFIER }, { now: 11_000 }).grant
          .name,
      );
    }
    expect(names).toEqual(['claude-code-2', 'claude-code-3']);
    // A token cannot take the name of an active grant.
    expect(() => createToken(db, 'claude-code-2', 12_000, { kind: 'agent' })).toThrow(/authorized/);
    const grant = listGrants(db).find((g) => g.name === 'claude-code-2');
    revokeGrant(db, grant!.id, 'owner', 13_000);
    expect(() => createToken(db, 'claude-code-2', 14_000, { kind: 'agent' })).not.toThrow();
  });
});

describe('devices connecting by browser', () => {
  const start = (device = 'laptop', now = 1_000) =>
    startDeviceAuthorization(db, { clientId: 'origin', device, ip: '203.0.113.9' }, now);
  const poll = (deviceCode: string, now: number) =>
    oauthError(() => pollDeviceAuthorization(db, { deviceCode, clientId: 'origin' }, now)).code;

  it('wait, slow down, and hand the approved device its token once', () => {
    const r = start();
    expect(r.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(r).toMatchObject({ expiresIn: DEVICE_REQUEST_TTL_MS / 1000, interval: 5 });
    expect(normalizeUserCode(r.userCode.toLowerCase().replace('-', ' '))).toBe(r.userCode);
    expect(getDeviceRequest(db, r.userCode)).toMatchObject({
      device: 'laptop',
      status: 'pending',
      ip: '203.0.113.9',
      replaces: false,
    });
    expect(poll(r.deviceCode, 2_000)).toBe('authorization_pending');
    expect(poll(r.deviceCode, 3_000)).toBe('slow_down'); // within 5 s
    expect(poll(r.deviceCode, 9_000)).toBe('slow_down'); // the interval was 10 s, and is now 15 s
    expect(poll(r.deviceCode, 24_500)).toBe('authorization_pending');
    decideDeviceRequest(db, r.userCode, true, 25_000);
    const got = pollDeviceAuthorization(
      db,
      { deviceCode: r.deviceCode, clientId: 'origin' },
      40_000,
    );
    expect(got).toMatchObject({ device: 'laptop', replaced: false });
    expect(verifyBearer(db, got.token, 40_001)).toMatchObject({
      kind: 'device',
      name: 'laptop',
      preset: 'readwrite',
    });
    expect(poll(r.deviceCode, 60_000)).toBe('invalid_grant');
  });

  it('replace the token of a device of that name, which the approval page says', () => {
    const old = createToken(db, 'laptop', 1);
    const r = start();
    expect(getDeviceRequest(db, r.userCode)?.replaces).toBe(true);
    decideDeviceRequest(db, r.userCode, true, 2_000);
    const got = pollDeviceAuthorization(
      db,
      { deviceCode: r.deviceCode, clientId: 'origin' },
      10_000,
    );
    expect(got.replaced).toBe(true);
    expect(verifyBearer(db, old, 10_001)).toBeNull();
    expect(listTokens(db)).toHaveLength(1);
  });

  it('report a denial and an expiry, and take no decision twice', () => {
    const denied = start();
    decideDeviceRequest(db, denied.userCode, false, 2_000);
    expect(poll(denied.deviceCode, 10_000)).toBe('access_denied');
    expect(() => decideDeviceRequest(db, denied.userCode, true, 3_000)).toThrow(/already used/);
    const late = start('desk');
    expect(() =>
      decideDeviceRequest(db, late.userCode, true, 1_000 + DEVICE_REQUEST_TTL_MS),
    ).toThrow(/expired/);
    expect(poll(late.deviceCode, 1_000 + DEVICE_REQUEST_TTL_MS)).toBe('expired_token');
    expect(() => decideDeviceRequest(db, 'BCDF-GHJK', true, 1_000)).toThrow(/No device/);
  });

  it('take only Origin’s CLI, a valid name, and not the hub’s own', () => {
    expect(
      oauthError(() => startDeviceAuthorization(db, { clientId: 'ocl_x', device: 'laptop' })).code,
    ).toBe('invalid_client');
    expect(oauthError(() => start('Bad Name')).code).toBe('invalid_request');
    expect(oauthError(() => start('hub')).message).toMatch(/hub's own name/);
    expect(poll('ogd_unknown', 1)).toBe('invalid_grant');
  });
});
