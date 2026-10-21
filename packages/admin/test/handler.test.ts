import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createAdminKey,
  createToken,
  type Database,
  listAudit,
  openDatabase,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_ROUTES, type AdminOptions, createAdminHandler } from '../src/index.js';
import { Browser, request } from './helpers.js';

let tmp: string;
let db: Database;
let servers: http.Server[];
let key: string;
let clock: number;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-ui-'));
  db = openDatabase(path.join(tmp, 'origin.db'));
  key = createAdminKey(db, 'owner');
  servers = [];
  clock = Date.now();
});

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function serve(opts: Partial<AdminOptions> = {}): Promise<string> {
  const handler = createAdminHandler({
    db,
    home: tmp,
    version: 'test',
    now: () => clock,
    ...opts,
  });
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://admin'));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

describe('guard headers', () => {
  it('are set on every response', async () => {
    const base = await serve();
    for (const p of ['/admin/login', '/admin/', '/admin/nope', '/admin/api/overview']) {
      const res = await request(`${base}${p}`);
      expect(res.headers['content-security-policy']).toBe(CSP);
      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(res.headers.vary).toBe('Cookie');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('add HSTS behind an https public URL', async () => {
    const base = await serve({ publicUrl: new URL('https://hub.example.com') });
    const res = await request(`${base}/admin/login`);
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('serve hashed assets as immutable, and SVG with an inline-style-only policy', async () => {
    const base = await serve();
    const page = await request(`${base}/admin/login`);
    const css = /href="(\/admin\/assets\/admin\.[0-9a-f]{10}\.css)"/.exec(page.text)?.[1];
    const icon = /href="(\/admin\/assets\/favicon\.[0-9a-f]{10}\.svg)"/.exec(page.text)?.[1];
    expect(css && icon).toBeTruthy();
    const cssRes = await request(`${base}${css}`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(cssRes.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const svg = await request(`${base}${icon}`);
    expect(svg.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect((await request(`${base}/admin/assets/admin.css`)).status).toBe(404);
    expect((await request(`${base}/admin/assets/../../package.json`)).status).toBe(404);
  });
});

describe('request checks', () => {
  it('reject cross-site and foreign-origin posts, and posts without an Origin', async () => {
    const base = await serve();
    const login = (headers: Record<string, string>) =>
      request(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: `key=${key}`,
      });
    expect((await login({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await login({ Origin: base, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await login({})).status).toBe(403);
    expect((await login({ Origin: 'null' })).status).toBe(403);
    expect((await login({ Origin: base })).status).toBe(303);
    expect(
      (await request(`${base}/admin/api/session`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }))
        .status,
    ).toBe(403);
  });

  it('require the CSRF token of the session on every signed-in post', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(key);
    expect(b.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await b.post('/admin/logout', { _csrf: '' })).status).toBe(403);
    expect((await b.post('/admin/logout', { _csrf: 'x'.repeat(43) })).status).toBe(403);
    expect((await b.api('POST', 'logout', {}, { 'X-CSRF-Token': 'wrong' })).status).toBe(403);
    expect((await b.get('/admin/')).status).toBe(200);
    expect((await b.post('/admin/logout', {})).status).toBe(303);
    expect((await b.get('/admin/')).status).toBe(303);
  });

  it('reject bodies over 64 KiB and unsupported content types', async () => {
    const base = await serve();
    const big = await request(`${base}/admin/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `key=${'a'.repeat(65 * 1024)}`,
    });
    expect(big.status).toBe(413);
    const xml = await request(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'text/xml' },
      body: '<key/>',
    });
    expect(xml.status).toBe(415);
  });

  it('allow only GET and POST', async () => {
    const base = await serve();
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const res = await request(`${base}/admin/api/tokens`, { method });
      expect(res.status).toBe(405);
      if (method !== 'HEAD') expect(res.headers.allow).toBe('GET, POST');
    }
    const wrong = await request(`${base}/admin/api/overview`, {
      method: 'POST',
      headers: { Origin: base },
    });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('GET');
  });

  it('answer only loopback names without a public URL (DNS rebinding)', async () => {
    const base = await serve();
    const res = await request(`${base}/admin/login`, { headers: { Host: 'evil.example:7077' } });
    expect(res.status).toBe(421);
    expect((await request(`${base}/admin/login`, { headers: { Host: 'localhost' } })).status).toBe(
      200,
    );
  });

  it('never accept a bearer token or a device token as a session', async () => {
    const base = await serve();
    const token = createToken(db, 'laptop');
    for (const auth of [`Bearer ${token}`, `Bearer ${key}`]) {
      const res = await request(`${base}/admin/api/overview`, { headers: { Authorization: auth } });
      expect(res.status).toBe(401);
    }
    const login = await request(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: token }),
    });
    expect(login.status).toBe(401);
  });
});

describe('sessions', () => {
  it('use a strict, host-only cookie on loopback http', async () => {
    const base = await serve();
    const b = new Browser(base);
    const res = await b.post('/admin/login', { key });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/');
    const cookie = res.setCookies.find((c) => c.startsWith('origin-admin='));
    expect(cookie).toMatch(/; Path=\/admin; SameSite=Strict; HttpOnly$/);
    expect(cookie).not.toContain('Secure');
  });

  it('use a __Host- Secure cookie from an https public origin', async () => {
    const base = await serve({ publicUrl: new URL('https://hub.example.com') });
    const b = new Browser(base, 'https://hub.example.com');
    const res = await b.api('POST', 'login', { key });
    expect(res.status).toBe(200);
    const cookie = res.setCookies.find((c) => c.startsWith('__Host-origin-admin='));
    expect(cookie).toMatch(/; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
    expect(res.json()).toMatchObject({ signedIn: true, key: 'owner', fresh: true });
  });

  it('require a fresh key entry for sensitive actions', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(key);
    clock += 11 * 60_000;
    const page = await b.get('/admin/tokens/new');
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe('/admin/reauth?next=%2Fadmin%2Ftokens%2Fnew');
    const api = await b.api('POST', 'tokens', { name: 'laptop' });
    expect(api.status).toBe(403);
    expect(api.json()).toMatchObject({ reauth: true });

    await b.get('/admin/reauth?next=%2Fadmin%2Ftokens%2Fnew');
    const wrong = await b.post('/admin/reauth', { key: `${key}x`, next: '/admin/tokens/new' });
    expect(wrong.status).toBe(401);
    const ok = await b.post('/admin/reauth', { key, next: '/admin/tokens/new' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/admin/tokens/new');
    expect((await b.api('POST', 'tokens', { name: 'laptop' })).status).toBe(201);
    expect(listAudit(db).map((r) => r.action)).toEqual([
      'token.create',
      'reauth',
      'reauth.failed',
      'login',
    ]);
  });

  it('end when idle, and never redirect off-site after sign-in', async () => {
    const base = await serve();
    const b = new Browser(base);
    const res = await b.post('/admin/login', { key, next: 'https://evil.example/' });
    expect(res.headers.location).toBe('/admin/');
    const res2 = await b.post('/admin/login', { key, next: '//evil.example/admin/' });
    expect(res2.headers.location).toBe('/admin/');
    clock += 31 * 60_000;
    const after = await b.get('/admin/entries');
    expect(after.status).toBe(303);
    expect(after.headers.location).toBe('/admin/login?next=%2Fadmin%2Fentries');
  });
});

describe('routes', () => {
  it('are only GET and POST, and the writes are exactly these', () => {
    expect(new Set(ADMIN_ROUTES.map((r) => r.method))).toEqual(new Set(['GET', 'POST']));
    const writes = ADMIN_ROUTES.filter((r) => r.method === 'POST').map(
      (r) => `${r.path} (${r.auth})`,
    );
    expect(writes).toMatchInlineSnapshot(`
      [
        "/admin/login (none)",
        "/admin/logout (session)",
        "/admin/reauth (session)",
        "/admin/prefs (none)",
        "/admin/tokens (fresh)",
        "/admin/tokens/revoke (fresh)",
        "/admin/correct (session)",
        "/admin/remember (session)",
        "/admin/forget (fresh)",
        "/admin/signins/revoke (fresh)",
        "/admin/api/login (none)",
        "/admin/api/logout (session)",
        "/admin/api/reauth (session)",
        "/admin/api/tokens (fresh)",
        "/admin/api/token-revoke (fresh)",
        "/admin/api/entries (session)",
        "/admin/api/correct (session)",
        "/admin/api/forget (fresh)",
        "/admin/api/sessions-revoke (fresh)",
      ]
    `);
    // Nothing that could edit or delete history, un-forget, or mint admin keys.
    for (const r of ADMIN_ROUTES) {
      expect(r.path).not.toMatch(/delete|edit|update|unforget|restore|admin-key|sql|file/i);
    }
  });

  it('limit failed sign-ins per client and collapse them in the audit log', async () => {
    const base = await serve();
    const b = new Browser(base);
    for (let i = 0; i < 10; i++) {
      expect((await b.post('/admin/login', { key: `oga_wrong${i}` })).status).toBe(401);
    }
    const blocked = await b.post('/admin/login', { key });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(500);
    expect((await b.post('/admin/login', { key })).status).toBe(429);
    expect(listAudit(db).map((r) => r.action)).toEqual(['login.blocked', 'login.failed']);
    clock += 10 * 60_000 + 1;
    expect((await b.post('/admin/login', { key })).status).toBe(303);
  });

  it('render a 404 page for unknown paths and JSON for the API', async () => {
    const base = await serve();
    const page = await request(`${base}/admin/nope`);
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toContain('text/html');
    const api = await request(`${base}/admin/api/nope`);
    expect(api.status).toBe(404);
    expect(api.json()).toEqual({ error: 'Not found.' });
    const root = await request(`${base}/admin`);
    expect(root.status).toBe(303);
    expect(root.headers.location).toBe('/admin/');
  });
});

describe('language', () => {
  it('follows the cookie, then Accept-Language', async () => {
    const base = await serve();
    const zh = await request(`${base}/admin/login`, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    expect(zh.text).toContain('<html lang="zh-CN"');
    expect(zh.text).toContain('登录 Origin');
    const en = await request(`${base}/admin/login`, {
      headers: { 'Accept-Language': 'zh-CN', Cookie: 'origin-admin-lang=en' },
    });
    expect(en.text).toContain('<html lang="en"');
    const b = new Browser(base);
    const set = await b.post('/admin/prefs', { lang: 'zh', next: '/admin/login' });
    expect(set.status).toBe(303);
    expect(set.setCookies[0]).toMatch(
      /^origin-admin-lang=zh; Path=\/admin; SameSite=Lax; Max-Age=/,
    );
    expect((await b.get('/admin/login')).text).toContain('<html lang="zh-CN"');
  });
});
