import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createToken,
  type Database,
  getAdminUsername,
  hashAdminPassword,
  listAudit,
  openDatabase,
  type ScryptParams,
  setAdminPassword,
  setAdminUsername,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_ROUTES, type AdminOptions, createAdminHandler } from '../src/index.js';
import { Browser, pageProblems, request } from './helpers.js';

let tmp: string;
let db: Database;
let servers: http.Server[];
let clock: number;

/** Cheap scrypt parameters for tests; a stored hash records its own parameters. */
const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

/** The routes of purging: a preview, its records, and the two writes that apply one. */
const PURGE_PATHS = [
  '/admin/purge',
  '/admin/purges',
  '/admin/purge-record',
  '/admin/api/purge-plan',
  '/admin/api/purge',
  '/admin/api/purges',
  '/admin/api/purge-record',
];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-ui-'));
  db = openDatabase(path.join(tmp, 'origin.db'));
  await setAdminPassword(db, PASSWORD, { params: FAST });
  setAdminUsername(db, 'owner');
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
    const kit = /href="(\/admin\/assets\/ui\.[0-9a-f]{10}\.css)"/.exec(page.text)?.[1];
    const css = /href="(\/admin\/assets\/admin\.[0-9a-f]{10}\.css)"/.exec(page.text)?.[1];
    const icon = /href="(\/admin\/assets\/favicon\.[0-9a-f]{10}\.svg)"/.exec(page.text)?.[1];
    expect(kit && css && icon).toBeTruthy();
    // The design system's stylesheet comes first; the admin's few additions follow it.
    expect(page.text.indexOf(kit ?? '')).toBeLessThan(page.text.indexOf(css ?? ''));
    for (const file of [kit, css]) {
      const cssRes = await request(`${base}${file}`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(cssRes.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(cssRes.headers['content-security-policy']).toBe(CSP);
    }
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
        body: `username=owner&password=${PASSWORD}`,
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
    await b.login(PASSWORD);
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
      body: `password=${'a'.repeat(65 * 1024)}`,
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

  it('never accept a bearer token, a device token, or the password as a session', async () => {
    const base = await serve();
    const token = createToken(db, 'laptop');
    for (const auth of [`Bearer ${token}`, `Bearer ${PASSWORD}`, `Basic ${PASSWORD}`]) {
      const res = await request(`${base}/admin/api/overview`, { headers: { Authorization: auth } });
      expect(res.status).toBe(401);
    }
    const login = await request(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: token }),
    });
    expect(login.status).toBe(401);
    // Even if the stored hash were a token's, a token never signs in.
    await setAdminPassword(db, 'placeholder-password', { params: FAST });
    db.prepare("UPDATE setting SET value = ? WHERE key = 'admin.password'").run(
      await hashAdminPassword(token, FAST),
    );
    expect(
      (await new Browser(base).post('/admin/login', { username: 'owner', password: token })).status,
    ).toBe(401);
  });
});

describe('sessions', () => {
  it('use a strict, host-only cookie on loopback http', async () => {
    const base = await serve();
    const b = new Browser(base);
    const res = await b.post('/admin/login', { username: 'owner', password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/');
    const cookie = res.setCookies.find((c) => c.startsWith('origin-admin='));
    expect(cookie).toMatch(/; Path=\/admin; SameSite=Strict; HttpOnly$/);
    expect(cookie).not.toContain('Secure');
  });

  it('use a __Host- Secure cookie from an https public origin', async () => {
    const base = await serve({ publicUrl: new URL('https://hub.example.com') });
    const b = new Browser(base, 'https://hub.example.com');
    const res = await b.api('POST', 'login', { username: 'owner', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.setCookies.find((c) => c.startsWith('__Host-origin-admin='));
    expect(cookie).toMatch(/; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
    expect(res.json()).toEqual({
      signedIn: true,
      fresh: true,
      username: 'owner',
      csrf: expect.any(String),
    });
  });

  it('accept only the __Host- cookie behind an https public URL', async () => {
    const base = await serve({ publicUrl: new URL('https://hub.example.com') });
    const headers = { Host: 'hub.example.com' };
    const b = new Browser(base, 'https://hub.example.com');
    await b.api('POST', 'login', { username: 'owner', password: PASSWORD }, headers);
    const id = b.jar.get('__Host-origin-admin') ?? '';
    expect(id).not.toBe('');
    const as = async (cookie: string) =>
      (
        await request(`${base}/admin/api/session`, { headers: { ...headers, Cookie: cookie } })
      ).json();
    expect(await as(`__Host-origin-admin=${id}`)).toMatchObject({ signedIn: true });
    // A plain cookie could have been planted from a sibling subdomain: it does not count here.
    expect(await as(`origin-admin=${id}`)).toMatchObject({ signedIn: false });
  });

  it('require the password again for sensitive actions', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    clock += 11 * 60_000;
    const page = await b.get('/admin/tokens/new');
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe('/admin/reauth?next=%2Fadmin%2Ftokens%2Fnew');
    const api = await b.api('POST', 'tokens', { name: 'laptop' });
    expect(api.status).toBe(403);
    expect(api.json()).toMatchObject({ reauth: true });

    const form = await b.get('/admin/reauth?next=%2Fadmin%2Ftokens%2Fnew');
    expect(form.text).toContain('autocomplete="current-password"');
    expect(form.text).toContain('Admin password');
    const wrong = await b.post('/admin/reauth', {
      password: `${PASSWORD}x`,
      next: '/admin/tokens/new',
    });
    expect(wrong.status).toBe(401);
    const ok = await b.post('/admin/reauth', { password: PASSWORD, next: '/admin/tokens/new' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/admin/tokens/new');
    expect((await b.api('POST', 'tokens', { name: 'laptop' })).status).toBe(201);
    expect(listAudit(db).map((r) => [r.action, r.actor])).toEqual([
      ['token.create', 'owner'],
      ['reauth', 'owner'],
      ['reauth.failed', 'owner'],
      ['login', 'owner'],
    ]);
    // The JSON API asks for the password again in the same way.
    clock += 11 * 60_000;
    expect((await b.api('POST', 'reauth', { password: 'wrong password!' })).status).toBe(401);
    expect((await b.api('POST', 'reauth', { password: PASSWORD })).json()).toEqual({ fresh: true });
    expect((await b.api('POST', 'tokens', { name: 'desk' })).status).toBe(201);
  });

  it('end when idle, and never redirect off-site after sign-in', async () => {
    const base = await serve();
    const b = new Browser(base);
    const res = await b.post('/admin/login', {
      username: 'owner',
      password: PASSWORD,
      next: 'https://evil.example/',
    });
    expect(res.headers.location).toBe('/admin/');
    const res2 = await b.post('/admin/login', {
      username: 'owner',
      password: PASSWORD,
      next: '//evil.example/admin/',
    });
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
        "/admin/grants/revoke (fresh)",
        "/admin/oauth/authorize (fresh)",
        "/admin/activate (fresh)",
        "/admin/proposal/accept (session)",
        "/admin/proposal/reject (session)",
        "/admin/correct (session)",
        "/admin/remember (session)",
        "/admin/forget (session)",
        "/admin/restore (session)",
        "/admin/purge (fresh)",
        "/admin/signins/revoke (fresh)",
        "/admin/api/login (none)",
        "/admin/api/logout (session)",
        "/admin/api/reauth (session)",
        "/admin/api/tokens (fresh)",
        "/admin/api/token-revoke (fresh)",
        "/admin/api/grant-revoke (fresh)",
        "/admin/api/entries (session)",
        "/admin/api/correct (session)",
        "/admin/api/proposal-accept (session)",
        "/admin/api/proposal-reject (session)",
        "/admin/api/forget (session)",
        "/admin/api/restore (session)",
        "/admin/api/purge (fresh)",
        "/admin/api/sessions-revoke (fresh)",
      ]
    `);
    // Restoring a forget adds a record and deletes nothing; accepting a proposal writes an entry
    // through remember, and rejecting one is a forget. Nothing else could edit history, delete
    // anything but by a purge, or change the admin password.
    for (const r of ADMIN_ROUTES) {
      if (PURGE_PATHS.includes(r.path)) continue;
      expect(r.path).not.toMatch(/delete|edit|update|unforget|purge|password|key|sql|file/i);
    }
    // The only routes that delete, each only with a recent password.
    expect(ADMIN_ROUTES.filter((r) => r.method === 'POST' && /purge/.test(r.path))).toEqual([
      { method: 'POST', path: '/admin/purge', auth: 'fresh' },
      { method: 'POST', path: '/admin/api/purge', auth: 'fresh' },
    ]);
    // Everything else of purging reads, behind a session.
    expect(
      ADMIN_ROUTES.filter((r) => /purge/.test(r.path)).map(
        (r) => `${r.method} ${r.path} (${r.auth})`,
      ),
    ).toEqual([
      'GET /admin/purge (session)',
      'POST /admin/purge (fresh)',
      'GET /admin/purges (session)',
      'GET /admin/purge-record (session)',
      'GET /admin/api/purge-plan (session)',
      'POST /admin/api/purge (fresh)',
      'GET /admin/api/purges (session)',
      'GET /admin/api/purge-record (session)',
    ]);
    expect(new Set(ADMIN_ROUTES.filter((r) => /purge/.test(r.path)).map((r) => r.path))).toEqual(
      new Set(PURGE_PATHS),
    );
  });

  it('limit failed sign-ins per client and collapse them in the audit log', async () => {
    const base = await serve();
    const b = new Browser(base);
    for (let i = 0; i < 10; i++) {
      expect(
        (await b.post('/admin/login', { username: 'owner', password: `wrong-guess-${i}` })).status,
      ).toBe(401);
    }
    const blocked = await b.post('/admin/login', { username: 'owner', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(500);
    expect((await b.post('/admin/login', { username: 'owner', password: PASSWORD })).status).toBe(
      429,
    );
    expect(listAudit(db).map((r) => r.action)).toEqual(['login.blocked', 'login.failed']);
    expect(JSON.stringify(listAudit(db))).not.toContain('wrong-guess');
    clock += 10 * 60_000 + 1;
    expect((await b.post('/admin/login', { username: 'owner', password: PASSWORD })).status).toBe(
      303,
    );
  });

  it('count concurrent wrong passwords exactly, checking one at a time', async () => {
    const base = await serve();
    const attempts = Array.from({ length: 20 }, (_, i) =>
      new Browser(base).api('POST', 'login', {
        username: 'owner',
        password: `concurrent-guess-${i}`,
      }),
    );
    const statuses = (await Promise.all(attempts)).map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
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

describe('pages', () => {
  it('use the design system with no inline style or script, and inline only the icons they use', async () => {
    const base = await serve();
    const anonymous = [await request(`${base}/admin/login`), await request(`${base}/admin/nope`)];
    const b = new Browser(base);
    await b.login(PASSWORD);
    const signedIn = [];
    for (const p of [
      '/admin/',
      '/admin/tokens',
      '/admin/tokens/new',
      '/admin/signins',
      '/admin/entry?id=ent_0000',
    ]) {
      signedIn.push(await b.get(p));
    }
    clock += 11 * 60_000;
    signedIn.push(await b.get('/admin/reauth?next=%2Fadmin%2F'));
    for (const page of [...anonymous, ...signedIn]) {
      expect(page.text).toContain('</html>');
      expect(pageProblems(page.text)).toEqual([]);
    }
    // One hidden sprite, before everything else in the body, with symbols from the design system.
    const overview = signedIn[0]?.text ?? '';
    expect(overview).toMatch(
      /<body data-brand="origin">\s*<svg xmlns="http:\/\/www.w3.org\/2000\/svg" hidden aria-hidden="true"><symbol id="i-/,
    );
    expect(overview).toContain('<use href="#i-layout-dashboard"/>');
    expect(overview).toMatch(/<symbol id="i-layout-dashboard" viewBox="0 0 24 24"><rect /);
    // Signed in: the app shell with its navigation, error pages included; signed out (and on
    // unknown paths, where the session is not read), the sign-in card and never the shell.
    expect(overview).toContain(
      '<a class="ol-nav-item" href="/admin/" title="Overview" aria-current="page">',
    );
    // The sidebar opens as a sheet on narrow screens: a popover, with the button that opens it.
    expect(overview).toContain('<aside class="ol-sidebar" id="nav" popover aria-label="Sections">');
    expect(overview).toMatch(/<button class="[^"]*ol-nav-open" type="button" popovertarget="nav"/);
    // The page is headed once, in the top bar.
    expect(overview.match(/<h1[ >]/g)).toHaveLength(1);
    expect(signedIn[4]?.status).toBe(404);
    expect(signedIn[4]?.text).toContain('class="ol-app ol-app-workbench"');
    for (const page of anonymous) {
      expect(page.text).toContain('class="ol-auth-card"');
      expect(page.text).not.toContain('class="ol-app ol-app-workbench"');
    }
    expect(signedIn[5]?.text).toContain('class="ol-auth-card"');
  });

  it('credit the open-source project: at the foot of the app, and under the sign-in form', async () => {
    const base = await serve();
    const login = await request(`${base}/admin/login`);
    expect(login.text).toContain(
      '<p class="ol-hint ol-cluster admin-oss"><span>Origin is open source.</span><a href="https://origin.openlinkos.com/" rel="noreferrer">Documentation</a><a href="https://github.com/openlinkos/origin" rel="noreferrer">GitHub</a></p>',
    );
    // Under the form, inside the card.
    const card = login.text.slice(login.text.indexOf('class="ol-auth-card"'));
    expect(card.indexOf('</form>')).toBeLessThan(card.indexOf('admin-oss'));
    expect(card.indexOf('admin-oss')).toBeLessThan(card.indexOf('class="ol-auth-foot"'));
    const zhLogin = await request(`${base}/admin/login`, {
      headers: { 'Accept-Language': 'zh-CN' },
    });
    expect(zhLogin.text).toContain(
      '<span>Origin 是开源软件。</span><a href="https://origin.openlinkos.com/zh/" rel="noreferrer">文档</a><a href="https://github.com/openlinkos/origin" rel="noreferrer">GitHub</a>',
    );

    const b = new Browser(base);
    await b.login(PASSWORD);
    const footer = (text: string) =>
      /<footer class="ol-footer admin-foot">[\s\S]*?<\/footer>/.exec(text)?.[0];
    for (const p of ['/admin/', '/admin/tokens', '/admin/entries', '/admin/entry?id=ent_0000']) {
      const page = await b.get(p);
      expect(footer(page.text), p).toBe(`<footer class="ol-footer admin-foot">
      <span>Origin vtest</span>
      <a href="https://origin.openlinkos.com/" rel="noreferrer">Documentation</a>
      <a href="https://github.com/openlinkos/origin" rel="noreferrer">GitHub</a>
      <a href="https://github.com/openlinkos/origin/issues/new/choose" rel="noreferrer">Report an issue</a>
    </footer>`);
      // After the content, inside the main column.
      expect(page.text.indexOf('</main>'), p).toBeLessThan(page.text.indexOf('admin-foot'));
      expect(pageProblems(page.text), p).toEqual([]);
    }
    await b.post('/admin/prefs', { lang: 'zh', next: '/admin/' });
    const zh = footer((await b.get('/admin/')).text) ?? '';
    expect(zh).toContain('<a href="https://origin.openlinkos.com/zh/" rel="noreferrer">文档</a>');
    expect(zh).toContain('rel="noreferrer">反馈问题</a>');
    // Signed out, the sign-in card has no app footer.
    expect(login.text).not.toContain('admin-foot');
  });

  it('switch the theme with POST buttons that show the current choice', async () => {
    const base = await serve();
    const auto = await request(`${base}/admin/login`);
    expect(auto.text).toContain('<html lang="en">');
    expect(auto.text).toMatch(/name="theme" value="auto" aria-pressed="true"/);
    const b = new Browser(base);
    const set = await b.post('/admin/prefs', { theme: 'dark', next: '/admin/login' });
    expect(set.status).toBe(303);
    const dark = await b.get('/admin/login');
    expect(dark.text).toContain('<html lang="en" data-theme="dark">');
    expect(dark.text).toMatch(/name="theme" value="dark" aria-pressed="true"/);
    expect(dark.text).toMatch(/name="theme" value="auto" aria-pressed="false"/);
  });
});

describe('the owner username', () => {
  it('is chosen at the first sign-in, with the admin password, and then required', async () => {
    db.prepare("DELETE FROM setting WHERE key = 'admin.username'").run();
    const base = await serve();
    const page = await request(`${base}/admin/login`);
    expect(page.text).toContain('Choose your username');
    expect(page.text).toContain('2 to 32 lowercase letters');
    const b = new Browser(base);
    const bad = await b.post('/admin/login', { username: 'x', password: PASSWORD });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Invalid username');
    const wrong = await b.post('/admin/login', { username: 'dana', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('That password was not accepted.');
    expect(getAdminUsername(db)).toBeNull();
    // Typed with capitals and spaces, kept in lowercase.
    const ok = await b.post('/admin/login', {
      username: ' Dana ',
      password: PASSWORD,
      next: '/admin/',
    });
    expect(ok.status).toBe(303);
    expect(getAdminUsername(db)).toBe('dana');
    expect(
      listAudit(db)
        .slice(0, 2)
        .map((r) => [r.actor, r.action]),
    ).toEqual([
      ['dana', 'login'],
      ['dana', 'username.set'],
    ]);
    // From now on the username is checked, and a wrong one fails like a wrong password.
    const other = await new Browser(base).post('/admin/login', {
      username: 'eve',
      password: PASSWORD,
    });
    expect(other.status).toBe(401);
    expect(other.text).toContain('That username and password were not accepted.');
    expect(getAdminUsername(db)).toBe('dana');
    expect((await new Browser(base).login(PASSWORD, 'DANA')).status).toBe(303);
    expect((await new Browser(base).api('POST', 'login', { password: PASSWORD })).status).toBe(401);
    // Actions are audited under the username, and the reauth form names it for password managers.
    await b.get('/admin/tokens/new');
    const created = await b.post('/admin/tokens', { name: 'ci' });
    expect(created.status).toBe(200);
    expect(listAudit(db)[0]).toMatchObject({ actor: 'dana', action: 'token.create', target: 'ci' });
    clock += 11 * 60_000;
    const reauth = await b.get('/admin/reauth?next=/admin/');
    expect(reauth.text).toContain(
      '<input type="text" name="username" value="dana" autocomplete="username" hidden>',
    );
  });

  it('is set at the first sign-in after an upgrade: earlier sessions count as signed out', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    expect((await b.get('/admin/')).status).toBe(200);
    // A hub of an earlier version had sessions but no username.
    db.prepare("DELETE FROM setting WHERE key = 'admin.username'").run();
    const after = await b.get('/admin/');
    expect(after.status).toBe(303);
    expect(after.headers.location).toMatch(/^\/admin\/login/);
    expect((await b.get('/admin/login')).text).toContain('Choose your username');
    expect((await b.login(PASSWORD, 'dana')).status).toBe(303);
    expect((await b.get('/admin/')).status).toBe(200);
    expect(getAdminUsername(db)).toBe('dana');
  });
});

describe('the admin password', () => {
  it('signs in through a form that password managers recognize', async () => {
    const base = await serve();
    const page = await request(`${base}/admin/login`);
    expect(page.text).toMatch(
      /<label class="ol-label" for="username">Username<\/label>\s*<input class="ol-input ol-input-lg" id="username" type="text" name="username" required autocomplete="username"/,
    );
    expect(page.text).not.toContain('origin-admin');
    expect(page.text).toMatch(
      /<label class="ol-label" for="password">Admin password<\/label>\s*<input class="ol-input ol-input-lg" id="password" type="password" name="password" required autocomplete="current-password"/,
    );
    expect(page.text).toContain('origin admin password');
    expect(page.text).not.toMatch(/oga_|admin key/i);
    const zh = await request(`${base}/admin/login`, { headers: { 'Accept-Language': 'zh-CN' } });
    expect(zh.text).toContain('<label class="ol-label" for="password">管理密码</label>');
    expect(zh.text).not.toContain('密钥');
  });

  it('is checked against ORIGIN_ADMIN_PASSWORD when the hub was started with it', async () => {
    const env = 'from-the-environment';
    const base = await serve({
      credential: { source: 'env', hash: await hashAdminPassword(env, FAST) },
    });
    expect(
      (await new Browser(base).post('/admin/login', { username: 'owner', password: PASSWORD }))
        .status,
    ).toBe(401);
    const b = new Browser(base);
    expect((await b.login(env)).status).toBe(303);
    expect((await b.get('/admin/')).status).toBe(200);
  });

  it('takes effect at once when replaced, and ends every session', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    const signins = await b.get('/admin/signins');
    expect(signins.status).toBe(200);
    expect(signins.text).not.toMatch(/admin key|owner/i);
    expect(signins.text).toContain('this session');

    await setAdminPassword(db, 'a-brand-new-password', { params: FAST });
    const after = await b.get('/admin/');
    expect(after.status).toBe(303);
    expect(after.headers.location).toMatch(/^\/admin\/login/);
    expect((await new Browser(base).login(PASSWORD)).status).toBe(401);
    expect((await new Browser(base).login('a-brand-new-password')).status).toBe(303);
  });
});

describe('breadcrumb', () => {
  it('names the navigation group, never the host', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    // The pages above, then the page's heading, as the top bar reads.
    const crumbs = (text: string) =>
      /<header class="ol-topbar">([\s\S]*?)<div class="ol-topbar-actions">/
        .exec(text)?.[1]
        ?.replace(/<button[\s\S]*?<\/button>/, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    expect(crumbs((await b.get('/admin/audit')).text)).toBe('Settings Audit log');
    expect(crumbs((await b.get('/admin/')).text)).toBe('Overview');
    const host = new URL(base).host;
    for (const path of ['/admin/', '/admin/sessions', '/admin/login']) {
      const text = (await b.get(path)).text;
      expect(crumbs(text) ?? '', path).not.toContain(host);
    }
  });
});

describe('language', () => {
  it('follows the cookie, then Accept-Language', async () => {
    const base = await serve();
    const zh = await request(`${base}/admin/login`, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    expect(zh.text).toContain('<html lang="zh-CN"');
    expect(zh.text).toContain('<h1 class="ol-auth-title">登录</h1>');
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

describe('a device', () => {
  it('lists its files a page at a time, the most recently updated first', async () => {
    const insert = db.prepare(
      `INSERT INTO raw_file (source, path, generation, mirror, bytes_ingested, lines_ingested, first_seen_at, updated_at)
       VALUES ('claude-code', ?, 1, ?, 100, 2, ?, ?)`,
    );
    for (let i = 0; i < 60; i++) {
      const name = `@laptop:/home/dana/.claude/projects/demo/s${String(i).padStart(2, '0')}.jsonl`;
      insert.run(name, `m${i}`, clock - 60_000, clock - (60 - i) * 1000);
    }
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    const first = await b.get('/admin/device?name=laptop');
    expect(first.status).toBe(200);
    expect(pageProblems(first.text)).toEqual([]);
    expect(first.text).toContain('1–50 of 60');
    expect(first.text).toContain('s59.jsonl');
    expect(first.text).not.toContain('s09.jsonl');
    expect(first.text.indexOf('s59.jsonl')).toBeLessThan(first.text.indexOf('s58.jsonl'));
    const second = await b.get('/admin/device?name=laptop&page=1');
    expect(second.text).toContain('51–60 of 60');
    expect(second.text).toContain('s00.jsonl');
    expect(second.text).not.toContain('s59.jsonl');
  });
});

describe('devices and agents', () => {
  it('lists devices, agents with a preset, and agents signed in by browser, each revocable', async () => {
    createToken(db, 'laptop');
    createToken(db, 'reader', clock, { kind: 'agent', preset: 'readonly' });
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    const page = await b.get('/admin/tokens');
    expect(page.status).toBe(200);
    expect(pageProblems(page.text)).toEqual([]);
    expect(page.text).toContain('<h1');
    expect(page.text).toContain('Devices and agents');
    expect(page.text).toContain('Agents with a token');
    expect(page.text).toContain('Read only');
    expect(page.text).toContain('href="/admin/tokens/revoke?name=reader"');
    const zh = await b.get('/admin/tokens', { 'Accept-Language': 'zh-CN' });
    expect(zh.text).toContain('设备和 Agent');

    // A readonly agent: a token, with the Claude Code and Codex commands, and no event lines.
    await b.get('/admin/tokens/new');
    const created = await b.post('/admin/tokens', { name: 'notes-bot', preset: 'readonly' });
    expect(created.status).toBe(200);
    expect(pageProblems(created.text)).toEqual([]);
    const token = /ogn_[A-Za-z0-9_-]{43}/.exec(created.text)?.[0] ?? '';
    expect(created.text).toContain(
      `claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header &quot;Authorization: Bearer ${token}&quot;`,
    );
    expect(created.text).toContain(`export ORIGIN_TOKEN=${token}`);
    expect(created.text).not.toContain('/v1/sources/');
    const readwrite = await b.post('/admin/tokens', { name: 'chat-ops' });
    expect(readwrite.text).toContain('/v1/sources/chat-ops/lines?path=events.jsonl');
    expect(listAudit(db)[0]).toMatchObject({
      actor: 'owner',
      action: 'token.create',
      target: 'chat-ops',
      detail: { kind: 'agent', preset: 'readwrite' },
    });
    const bad = await b.post('/admin/tokens', { name: 'x', preset: 'everything' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Unknown preset');
  });

  it('show the connect page by browser sign-in when the hub offers it, and with tokens when not', async () => {
    const withOAuth = await serve({
      oauth: {
        resolveClient: async () => {
          throw new Error('no fetching here');
        },
      },
    });
    const b = new Browser(withOAuth);
    await b.login(PASSWORD);
    const page = await b.get('/admin/connect');
    expect(pageProblems(page.text)).toEqual([]);
    expect(page.text).toContain('origin hub connect https://hub.example.com\norigin sync');
    expect(page.text).toContain('claude mcp login origin');
    expect(page.text).toContain('codex mcp login origin');
    const plain = await serve();
    const c = new Browser(plain);
    await c.login(PASSWORD);
    const tokens = await c.get('/admin/connect');
    expect(tokens.text).toContain('--token &lt;token&gt; --device &lt;device-name&gt;');
    expect(tokens.text).toContain('Signing in by browser needs the admin UI');
  });
});
