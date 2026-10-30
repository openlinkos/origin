import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createToken,
  type Database,
  hashAdminPassword,
  listAudit,
  openDatabase,
  type ScryptParams,
  setAdminPassword,
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

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-ui-'));
  db = openDatabase(path.join(tmp, 'origin.db'));
  await setAdminPassword(db, PASSWORD, { params: FAST });
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
        body: `password=${PASSWORD}`,
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
      body: JSON.stringify({ password: token }),
    });
    expect(login.status).toBe(401);
    // Even if the stored hash were a token's, a token never signs in.
    await setAdminPassword(db, 'placeholder-password', { params: FAST });
    db.prepare("UPDATE setting SET value = ? WHERE key = 'admin.password'").run(
      await hashAdminPassword(token, FAST),
    );
    expect((await new Browser(base).post('/admin/login', { password: token })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('use a strict, host-only cookie on loopback http', async () => {
    const base = await serve();
    const b = new Browser(base);
    const res = await b.post('/admin/login', { password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/');
    const cookie = res.setCookies.find((c) => c.startsWith('origin-admin='));
    expect(cookie).toMatch(/; Path=\/admin; SameSite=Strict; HttpOnly$/);
    expect(cookie).not.toContain('Secure');
  });

  it('use a __Host- Secure cookie from an https public origin', async () => {
    const base = await serve({ publicUrl: new URL('https://hub.example.com') });
    const b = new Browser(base, 'https://hub.example.com');
    const res = await b.api('POST', 'login', { password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.setCookies.find((c) => c.startsWith('__Host-origin-admin='));
    expect(cookie).toMatch(/; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
    expect(res.json()).toEqual({ signedIn: true, fresh: true, csrf: expect.any(String) });
  });

  it('accept only the __Host- cookie behind an https public URL', async () => {
    const base = await serve({ publicUrl: new URL('https://hub.example.com') });
    const headers = { Host: 'hub.example.com' };
    const b = new Browser(base, 'https://hub.example.com');
    await b.api('POST', 'login', { password: PASSWORD }, headers);
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
    const res = await b.post('/admin/login', { password: PASSWORD, next: 'https://evil.example/' });
    expect(res.headers.location).toBe('/admin/');
    const res2 = await b.post('/admin/login', {
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
        "/admin/correct (session)",
        "/admin/remember (session)",
        "/admin/forget (session)",
        "/admin/restore (session)",
        "/admin/signins/revoke (fresh)",
        "/admin/api/login (none)",
        "/admin/api/logout (session)",
        "/admin/api/reauth (session)",
        "/admin/api/tokens (fresh)",
        "/admin/api/token-revoke (fresh)",
        "/admin/api/entries (session)",
        "/admin/api/correct (session)",
        "/admin/api/forget (session)",
        "/admin/api/restore (session)",
        "/admin/api/sessions-revoke (fresh)",
      ]
    `);
    // Restoring a forget adds a record and deletes nothing. Nothing else could edit or delete
    // history, or change the admin password.
    for (const r of ADMIN_ROUTES) {
      expect(r.path).not.toMatch(/delete|edit|update|unforget|purge|password|key|sql|file/i);
    }
  });

  it('limit failed sign-ins per client and collapse them in the audit log', async () => {
    const base = await serve();
    const b = new Browser(base);
    for (let i = 0; i < 10; i++) {
      expect((await b.post('/admin/login', { password: `wrong-guess-${i}` })).status).toBe(401);
    }
    const blocked = await b.post('/admin/login', { password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(500);
    expect((await b.post('/admin/login', { password: PASSWORD })).status).toBe(429);
    expect(listAudit(db).map((r) => r.action)).toEqual(['login.blocked', 'login.failed']);
    expect(JSON.stringify(listAudit(db))).not.toContain('wrong-guess');
    clock += 10 * 60_000 + 1;
    expect((await b.post('/admin/login', { password: PASSWORD })).status).toBe(303);
  });

  it('count concurrent wrong passwords exactly, checking one at a time', async () => {
    const base = await serve();
    const attempts = Array.from({ length: 20 }, (_, i) =>
      new Browser(base).api('POST', 'login', { password: `concurrent-guess-${i}` }),
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

describe('the admin password', () => {
  it('signs in through a form that password managers recognize', async () => {
    const base = await serve();
    const page = await request(`${base}/admin/login`);
    expect(page.text).toContain(
      '<input type="text" name="username" value="origin-admin" autocomplete="username" hidden>',
    );
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
    expect((await new Browser(base).post('/admin/login', { password: PASSWORD })).status).toBe(401);
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
