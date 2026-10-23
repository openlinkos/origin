import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ADMIN_SESSION_MAX_MS,
  createAdminSession,
  type Database,
  getEntry,
  getEvent,
  initStoreName,
  listAudit,
  openDatabase,
  remember,
  type SourceAdapter,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdminHandler,
  createLocalAdmin,
  type HubLink,
  LOCAL_ROUTES,
  type LocalAdmin,
  type LocalAdminOptions,
  SIGN_IN_LINK_MS,
} from '../src/index.js';
import { Browser, pageProblems, request } from './helpers.js';

let tmp: string;
let db: Database;
let servers: http.Server[];
let clock: number;

const SESSION = 'session-one';
const EVENT = 'fake:evt-user-1';
const XSS = '<img src=x onerror=alert(1)>';

/** A synthetic source: one JSON object per line, in `<tmp>/agent/*.jsonl`. */
function fakeAdapter(root: string): SourceAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    version: () => '0.0.1',
    async discover() {
      return fs
        .readdirSync(root)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ absPath: path.join(root, f), relPath: f }));
    },
    parseLine(line) {
      const o = JSON.parse(line) as {
        id: string;
        ts: number;
        role: 'user' | 'assistant';
        text: string;
      };
      return {
        events: [
          {
            id: o.id,
            sessionId: SESSION,
            ts: o.ts,
            role: o.role,
            kind: 'message',
            text: o.text,
            project: 'demo',
          },
        ],
      };
    },
  };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-local-ui-'));
  db = openDatabase(path.join(tmp, 'origin.db'));
  initStoreName(db, 'laptop');
  servers = [];
  clock = Date.now();
  const agent = path.join(tmp, 'agent');
  fs.mkdirSync(agent);
  const lines = [
    {
      id: 'evt-user-1',
      ts: Date.UTC(2026, 9, 20, 9),
      role: 'user',
      text: 'Keep the schema simple.',
    },
    { id: 'evt-asst-1', ts: Date.UTC(2026, 9, 20, 9, 1), role: 'assistant', text: XSS },
  ];
  fs.writeFileSync(
    path.join(agent, `${SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
  await syncSource({ db, home: tmp }, fakeAdapter(agent));
  expect(getEvent(db, EVENT)).not.toBeNull();
});

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Local {
  base: string;
  port: number;
  admin: LocalAdmin;
  /** A browser signed in with a fresh link. */
  signedIn(): Promise<Browser>;
}

/** Serve `origin ui` on 127.0.0.1, as the CLI does: listen first, then answer for that port. */
async function serveLocal(opts: Partial<LocalAdminOptions> = {}): Promise<Local> {
  let handler: AdminHandler | null = null;
  const server = http.createServer((req, res) => {
    void handler?.(req, res, new URL(req.url ?? '/', 'http://admin'));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const admin = createLocalAdmin({
    db,
    home: tmp,
    version: 'test',
    port,
    now: () => clock,
    ...opts,
  });
  handler = admin.handler;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    admin,
    async signedIn() {
      const b = new Browser(base);
      const res = await b.get(admin.signInPath());
      expect(res.status).toBe(303);
      expect((await b.get('/admin/')).status).toBe(200);
      return b;
    },
  };
}

describe('origin ui: requests', () => {
  it('answer only to 127.0.0.1 and localhost on its own port (DNS rebinding)', async () => {
    const { base, port } = await serveLocal();
    for (const host of [
      'evil.example',
      `evil.example:${port}`,
      '127.0.0.1',
      'localhost',
      `localhost:${port + 1}`,
      `origin.localhost:${port}`,
      `127.0.0.2:${port}`,
      `[::1]:${port}`,
    ]) {
      const res = await request(`${base}/admin/login`, { headers: { Host: host } });
      expect(res.status, host).toBe(421);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const res = await request(`${base}/admin/login`, { headers: { Host: host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('keep the strict headers of the admin UI', async () => {
    const { base } = await serveLocal();
    const res = await request(`${base}/admin/login`);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(pageProblems(res.text)).toEqual([]);
  });

  it('reject cross-site and foreign-origin writes, and writes without the CSRF token', async () => {
    const local = await serveLocal();
    const b = await local.signedIn();
    const form = { id: EVENT, event: EVENT, kind: 'memory', text: 'From a cross-site form.' };
    const attempts = [
      { Origin: 'https://evil.example' },
      { Origin: local.base, 'Sec-Fetch-Site': 'cross-site' },
      // The right port, but the other name: Origin must match the Host the page was loaded from.
      { Origin: `http://localhost:${local.port}` },
      { Origin: 'null' },
    ];
    for (const headers of attempts) {
      expect((await b.post('/admin/remember', form, headers)).status).toBe(403);
    }
    expect((await b.post('/admin/remember', { ...form, _csrf: 'x'.repeat(43) })).status).toBe(403);
    expect(
      (
        await b.api(
          'POST',
          'entries',
          { eventId: EVENT, kind: 'memory', text: 'x' },
          { 'X-CSRF-Token': 'no' },
        )
      ).status,
    ).toBe(403);
    expect(listAudit(db, { action: 'entry.remember' })).toEqual([]);
    // Opened as localhost, the same checks hold with that origin.
    const viaName = new Browser(local.base, `http://localhost:${local.port}`);
    const host = { Host: `localhost:${local.port}` };
    expect((await viaName.get(local.admin.signInPath(), host)).status).toBe(303);
    expect((await viaName.get('/admin/', host)).status).toBe(200);
    expect((await viaName.post('/admin/remember', form, host)).status).toBe(303);
    expect((await viaName.post('/admin/remember', form)).status).toBe(403);
  });
});

describe('origin ui: the sign-in link', () => {
  it('is exchanged once for a session cookie, then redirects to a clean URL', async () => {
    const { base, admin } = await serveLocal();
    const link = admin.signInPath();
    expect(link).toMatch(/^\/admin\/login\?secret=[A-Za-z0-9_-]{43}$/);
    const b = new Browser(base);
    const res = await b.get(link);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/');
    expect(res.setCookies).toHaveLength(1);
    expect(res.setCookies[0]).toMatch(
      /^origin-ui=[A-Za-z0-9_-]{43}; Path=\/admin; SameSite=Lax; HttpOnly$/,
    );
    const page = await b.get('/admin/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('class="ol-app"');

    // Used up: another browser gets nothing; the signed-in one is just sent on.
    const other = new Browser(base);
    const again = await other.get(link);
    expect(again.status).toBe(401);
    expect(again.text).toContain('already been used');
    expect(again.setCookies).toEqual([]);
    expect((await other.get('/admin/')).status).toBe(303);
    expect((await b.get(link)).status).toBe(303);
    expect(listAudit(db).map((r) => [r.action, r.actor, r.channel, r.detail])).toEqual([
      ['login.failed', 'anonymous', 'ui', { used: 1 }],
      ['login', 'local', 'ui', null],
    ]);
    expect(JSON.stringify(listAudit(db))).not.toContain(link.split('=')[1]);
  });

  it('works when the browser follows it from a local file, which is cross-site', async () => {
    const { base, admin } = await serveLocal();
    const b = new Browser(base);
    const res = await b.get(admin.signInPath(), { 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(303);
    expect((await b.get('/admin/', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200);
  });

  it('expires, and a new link replaces the old one', async () => {
    const { base, admin } = await serveLocal();
    const old = admin.signInPath();
    clock += SIGN_IN_LINK_MS;
    const expired = await new Browser(base).get(old);
    expect(expired.status).toBe(401);
    expect(expired.text).toContain('has expired');
    const fresh = admin.signInPath();
    expect((await new Browser(base).get(old)).text).toContain('not valid');
    expect((await new Browser(base).get(fresh)).status).toBe(303);
  });

  it('rejects made-up secrets, and records failures once per window', async () => {
    const { base, admin } = await serveLocal();
    admin.signInPath();
    for (const secret of ['nope', 'x'.repeat(43), '', 'y'.repeat(500)]) {
      const res = await request(`${base}/admin/login?secret=${secret}`);
      expect(res.status, secret).toBe(401);
      expect(res.setCookies).toEqual([]);
    }
    expect(listAudit(db).map((r) => [r.action, r.detail])).toEqual([
      ['login.failed', { invalid: 1 }],
    ]);
    clock += 10 * 60_000;
    await request(`${base}/admin/login?secret=nope`);
    expect(listAudit(db, { action: 'login.failed' })).toHaveLength(2);
  });

  it('explains where to find a link when signed out, and offers no password form', async () => {
    const { base } = await serveLocal();
    const res = await request(`${base}/admin/`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/login?next=%2Fadmin%2F');
    const page = await request(`${base}/admin/login?next=%2Fadmin%2F`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('prints a sign-in link');
    expect(page.text).not.toContain('type="password"');
    expect(page.text).not.toContain('origin admin password');
    expect(pageProblems(page.text)).toEqual([]);
    const zh = await request(`${base}/admin/login`, { headers: { 'Accept-Language': 'zh-CN' } });
    expect(zh.text).toContain('登录链接');
  });
});

describe('origin ui: sessions', () => {
  it('live in this process only: a stored admin session never counts, nor does a restart', async () => {
    const first = await serveLocal();
    const b = await first.signedIn();
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_session').get()).toEqual({ n: 0 });

    // A hub admin session in the same store, presented under either cookie name.
    const { id } = createAdminSession(db, {}, clock);
    for (const cookie of [`origin-ui=${id}`, `origin-admin=${id}`, `__Host-origin-admin=${id}`]) {
      const res = await request(`${first.base}/admin/api/session`, { headers: { Cookie: cookie } });
      expect(res.json(), cookie).toEqual({ signedIn: false });
    }
    // Another run of origin ui does not know this run's sessions.
    const second = await serveLocal();
    const carried = new Browser(second.base);
    for (const [k, v] of b.jar) carried.jar.set(k, v);
    expect((await carried.get('/admin/')).status).toBe(303);
    expect((await b.get('/admin/')).status).toBe(200);
  });

  it('need no re-authentication, and end after 12 hours or on sign-out', async () => {
    const local = await serveLocal();
    const b = await local.signedIn();
    expect((await b.api('GET', 'session')).json()).toMatchObject({ signedIn: true, fresh: true });
    clock += ADMIN_SESSION_MAX_MS - 1;
    expect((await b.get(`/admin/forget?id=${encodeURIComponent(EVENT)}`)).status).toBe(200);
    clock += 1;
    expect((await b.get('/admin/')).status).toBe(303);

    const c = await local.signedIn();
    expect((await c.post('/admin/logout', {})).status).toBe(303);
    expect((await c.get('/admin/')).status).toBe(303);
    expect(listAudit(db).map((r) => [r.action, r.actor])).toContainEqual(['logout', 'local']);
  });
});

describe('origin ui: pages', () => {
  it('render the local store with no hub-only page or link', async () => {
    const local = await serveLocal();
    const b = await local.signedIn();
    const entry = remember(db, {
      kind: 'memory',
      text: 'Keep the schema simple.',
      confidence: 1,
      author: 'claude-code@laptop',
      sources: [{ eventId: EVENT }],
    });
    for (const p of [
      '/admin/',
      '/admin/sessions',
      `/admin/session?source=fake&id=${SESSION}`,
      `/admin/event?id=${encodeURIComponent(EVENT)}`,
      `/admin/event-raw?id=${encodeURIComponent(EVENT)}`,
      '/admin/search?q=schema',
      '/admin/entries',
      `/admin/entry?id=${entry.id}`,
      `/admin/correct?id=${entry.id}`,
      `/admin/remember?event=${encodeURIComponent(EVENT)}`,
      `/admin/forget?id=${entry.id}`,
      '/admin/tombstones',
      '/admin/audit',
    ]) {
      const res = await b.get(p);
      expect(res.status, p).toBe(200);
      expect(pageProblems(res.text), p).toEqual([]);
      expect(res.text, p).toContain('<span class="ol-brand-tag">Local</span>');
      expect(res.text, p).not.toMatch(/href="\/admin\/(tokens|devices?|connect|signins|reauth)\b/);
      expect(res.text, p).not.toContain('<img src=x');
    }
    const overview = (await b.get('/admin/')).text;
    expect(overview).toContain('href="/admin/sessions?source=fake"');
    expect(overview).not.toContain('Raw mirrors, from devices');
    const api = (await b.api('GET', 'overview')).json();
    expect(api.counts).toMatchObject({ events: 2, sessions: 1, entries: 1 });
    expect(api.hub).toBeNull();
    const session = await b.get(`/admin/session?source=fake&id=${SESSION}`);
    expect(session.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const zh = await b.get('/admin/', { 'Accept-Language': 'zh-CN' });
    expect(zh.text).toContain('<span class="ol-brand-tag">本机</span>');
  });

  it('leave out what only a hub has', async () => {
    const local = await serveLocal();
    const b = await local.signedIn();
    for (const p of [
      '/admin/tokens',
      '/admin/tokens/new',
      '/admin/tokens/revoke?name=x',
      '/admin/devices',
      '/admin/device?name=x',
      '/admin/connect',
      '/admin/signins',
      '/admin/reauth',
      '/admin/api/tokens',
      '/admin/api/devices',
      '/admin/api/device?name=x',
      '/admin/api/connect',
      '/admin/api/admin-sessions',
    ]) {
      expect((await b.get(p)).status, p).toBe(404);
    }
    expect((await b.post('/admin/login', { password: 'anything at all' })).status).toBe(405);
    for (const p of ['/admin/tokens', '/admin/tokens/revoke', '/admin/signins/revoke']) {
      expect((await b.post(p, { name: 'x' })).status, p).toBe(404);
    }
    for (const p of ['login', 'reauth', 'tokens', 'token-revoke', 'sessions-revoke']) {
      expect((await b.api('POST', p, { password: 'anything at all' })).status, p).toBe(404);
    }
  });

  it('show the hub this device is connected to, and how its last sync went', async () => {
    let hub: HubLink | null = {
      url: 'https://hub.example.com',
      device: 'laptop',
      lastSyncAt: null,
      syncing: false,
      lastError: null,
    };
    const local = await serveLocal({ hub: () => hub });
    const b = await local.signedIn();
    let page = (await b.get('/admin/')).text;
    expect(page).toContain('<dd class="ol-mono ol-break">https://hub.example.com</dd>');
    expect(page).toContain('<dd>laptop</dd>');
    expect(page).toContain('<dd>never</dd>');
    expect(page).toContain('Connected');
    hub = { ...hub, lastSyncAt: clock, lastError: 'The hub could not be reached.' };
    page = (await b.get('/admin/')).text;
    expect(page).toContain(`datetime="${new Date(clock).toISOString()}"`);
    expect(page).toContain('Not synced');
    expect(page).toContain('The last sync with the hub failed: The hub could not be reached.');
    hub = null;
    page = (await b.get('/admin/')).text;
    expect(page).toContain('Not connected');
    expect(pageProblems(page)).toEqual([]);
  });
});

describe('origin ui: writes', () => {
  it('remember, correct, and forget without a password, as actor local, then call afterWrite', async () => {
    let writes = 0;
    const local = await serveLocal({
      afterWrite: () => {
        writes++;
      },
      hub: () => ({
        url: 'https://hub.example.com',
        device: 'laptop',
        lastSyncAt: null,
        syncing: true,
        lastError: null,
      }),
    });
    const b = await local.signedIn();
    await b.get(`/admin/remember?event=${encodeURIComponent(EVENT)}`);
    const remembered = await b.post('/admin/remember', {
      event: EVENT,
      kind: 'knowledge',
      text: 'The demo project keeps its schema simple.',
    });
    expect(remembered.status).toBe(303);
    const id = /id=(ent_[0-9a-f]+)/.exec(remembered.headers.location ?? '')?.[1] ?? '';
    expect(getEntry(db, id)).toMatchObject({ author: 'user@laptop', origin: 'laptop' });

    const corrected = await b.post('/admin/correct', { id, text: 'Simple schema, no versions.' });
    expect(corrected.status).toBe(303);
    const newId = /id=(ent_[0-9a-f]+)/.exec(corrected.headers.location ?? '')?.[1] ?? '';

    // Long after signing in: nothing asks for a password again.
    clock += 11 * 60_000;
    const preview = await b.get(`/admin/forget?id=${newId}`);
    expect(preview.status).toBe(200);
    expect(preview.text).toContain('on the hub and your other devices after the next sync');
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(preview.text)?.[1] ?? '';
    const done = await b.post('/admin/forget', { id: newId, digest, confirm: newId });
    expect(done.status).toBe(200);
    expect(done.text).toContain('It is being sent to your hub');
    expect(getEntry(db, newId)).toBeNull();
    expect(writes).toBe(3);
    expect(
      listAudit(db)
        .filter((r) => !r.action.startsWith('login'))
        .map((r) => [r.action, r.actor, r.channel]),
    ).toEqual([
      ['forget', 'local', 'ui'],
      ['entry.correct', 'local', 'ui'],
      ['entry.remember', 'local', 'ui'],
    ]);
    expect(JSON.stringify(listAudit(db))).not.toContain('schema');
  });

  it('say that a forget stays here when no hub is connected', async () => {
    const local = await serveLocal();
    const b = await local.signedIn();
    const plan = (await b.api('GET', `forget-plan?id=${encodeURIComponent(EVENT)}`)).json();
    const res = await b.post('/admin/forget', { id: EVENT, digest: plan.digest, confirm: EVENT });
    expect(res.status).toBe(200);
    expect(res.text).toContain('This device is not connected to a hub.');
  });

  it('are exactly these', () => {
    expect(new Set(LOCAL_ROUTES.map((r) => r.method))).toEqual(new Set(['GET', 'POST']));
    expect(LOCAL_ROUTES.some((r) => r.auth === 'fresh')).toBe(false);
    const writes = LOCAL_ROUTES.filter((r) => r.method === 'POST').map(
      (r) => `${r.path} (${r.auth})`,
    );
    expect(writes).toEqual([
      '/admin/logout (session)',
      '/admin/prefs (none)',
      '/admin/correct (session)',
      '/admin/remember (session)',
      '/admin/forget (session)',
      '/admin/api/logout (session)',
      '/admin/api/entries (session)',
      '/admin/api/correct (session)',
      '/admin/api/forget (session)',
    ]);
    for (const r of LOCAL_ROUTES) {
      expect(r.path).not.toMatch(
        /delete|edit|update|unforget|restore|password|key|sql|file|token/i,
      );
    }
  });
});
