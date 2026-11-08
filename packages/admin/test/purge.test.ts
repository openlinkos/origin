import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createToken,
  type Database,
  forget,
  getEvent,
  getPurge,
  initStoreName,
  listAudit,
  listPurges,
  openDatabase,
  PURGE_LIMITS,
  type ScryptParams,
  setAdminPassword,
  setAdminUsername,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line, mirrorText } from '../../core/test/helpers.js';
import { en } from '../src/i18n/en.js';
import {
  type AdminHandler,
  type AdminOptions,
  createAdminHandler,
  createLocalAdmin,
  type LocalAdminOptions,
} from '../src/index.js';
import { PURGE_LIMIT_KEYS } from '../src/pages/purge.js';
import { selectorFromQuery, selectorQuery } from '../src/purge.js';
import { Browser, pageProblems, request } from './helpers.js';

/**
 * Purging from the admin UI and its JSON API: a preview of ids and counts, never text; a purge only
 * of the plan the owner confirmed, with a reason, the word typed, and on a hub a recent password;
 * and its records. A unique string in a purged event must appear on none of these pages.
 */

const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const CANARY = 'zebracanary-purge-7f3a';

let tmp: string;
let home: string;
let logs: string;
let db: Database;
let servers: http.Server[];
let clock: number;

const adapter = () => fakeAdapter(logs);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-purge-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'hub');
  await setAdminPassword(db, PASSWORD, { params: FAST });
  setAdminUsername(db, 'owner');
  servers = [];
  clock = Date.now();
  fs.writeFileSync(
    path.join(logs, 'a.jsonl'),
    line('1', 's1', 1000, 'user', 'Keep the schema simple.') +
      line('2', 's1', 2000, 'assistant', `The key is ${CANARY}.`) +
      line('3', 's1', 3000, 'user', 'Thanks.'),
  );
  await syncSource({ db, home }, adapter());
  expect(getEvent(db, 'fake:2')).not.toBeNull();
});

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function listen(handler: () => AdminHandler | null): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler()?.(req, res, new URL(req.url ?? '/', 'http://admin'));
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

/** The hub's admin UI, with the adapters of its sources. */
async function serve(opts: Partial<AdminOptions> = {}): Promise<string> {
  const handler = createAdminHandler({
    db,
    home,
    version: 'test',
    now: () => clock,
    adapters: [adapter()],
    ...opts,
  });
  return listen(() => handler);
}

/** `origin ui` for the same store, signed in with its one-time link. */
async function serveLocal(opts: Partial<LocalAdminOptions> = {}): Promise<Browser> {
  let handler: AdminHandler | null = null;
  const base = await listen(() => handler);
  const admin = createLocalAdmin({
    db,
    home,
    version: 'test',
    port: Number(new URL(base).port),
    now: () => clock,
    adapters: [adapter()],
    ...opts,
  });
  handler = admin.handler;
  const b = new Browser(base);
  expect((await b.get(admin.signInPath())).status).toBe(303);
  return b;
}

/** A hidden field of the page's form, as the browser would send it. */
function formValue(text: string, name: string): string {
  const raw = new RegExp(`name="${name}" value="([^"]*)"`).exec(text)?.[1] ?? '';
  return raw
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#96;', '`')
    .replaceAll('&amp;', '&');
}

/** The fields of the preview's form, filled in. */
function confirmForm(preview: string, reason = 'pasted a key'): Record<string, string> {
  return {
    selector: formValue(preview, 'selector'),
    digest: formValue(preview, 'digest'),
    reason,
    confirm: 'purge',
  };
}

describe('purging from the admin UI', () => {
  it('previews ids and counts only, and purges that plan with a reason, the word, and a recent password', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);

    // "Purge…" on the event's page leads to its preview.
    const event = await b.get(`/admin/event?id=${encodeURIComponent('fake:2')}`);
    expect(event.text).toContain(CANARY);
    expect(event.text).toContain('href="/admin/purge?event=fake%3A2"');

    const preview = await b.get('/admin/purge?event=fake%3A2');
    expect(preview.status).toBe(200);
    expect(pageProblems(preview.text)).toEqual([]);
    expect(preview.text).not.toContain(CANARY);
    expect(preview.text).toContain('href="/admin/event?id=fake%3A2"');
    expect(preview.text).toContain('This deletes 1 event and 0 entries for good');
    expect(preview.text).toContain('What a purge does not reach');
    expect(preview.text).toContain('name="confirm" required pattern="purge"');
    expect(formValue(preview.text, 'digest')).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(JSON.parse(formValue(preview.text, 'selector'))).toEqual({
      kind: 'event',
      ids: ['fake:2'],
    });
    const form = confirmForm(preview.text);

    // The word must be typed, and a reason given.
    const unconfirmed = await b.post('/admin/purge', { ...form, confirm: 'yes' });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.text).toContain('Type purge in the confirmation field');
    expect(unconfirmed.text).not.toContain(CANARY);
    const unexplained = await b.post('/admin/purge', { ...form, reason: '  ' });
    expect(unexplained.status).toBe(400);
    expect(unexplained.text).toContain('A reason is required');
    expect(getEvent(db, 'fake:2')).not.toBeNull();

    // A digest that is not the plan's now is refused, and the preview shown again as it is now.
    const stale = await b.post('/admin/purge', { ...form, digest: `sha256:${'0'.repeat(32)}` });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain('plan it again');
    expect(stale.text).not.toContain(CANARY);
    expect(formValue(stale.text, 'digest')).toBe(form.digest);
    expect(stale.text).toContain('pasted a key</textarea>');
    expect(getEvent(db, 'fake:2')).not.toBeNull();

    // On a hub, purging needs the password entered within the last 10 minutes.
    clock += 11 * 60_000;
    const later = await b.get('/admin/purge?event=fake%3A2');
    expect(later.text).not.toContain('action="/admin/purge"');
    expect(later.text).toContain('href="/admin/reauth?next=%2Fadmin%2Fpurge%3Fevent%3Dfake%253A2"');
    const refused = await b.post('/admin/purge', form);
    expect(refused.status).toBe(303);
    expect(refused.headers.location).toBe(
      `/admin/reauth?next=${encodeURIComponent('/admin/purge?event=fake%3A2')}`,
    );
    expect(getEvent(db, 'fake:2')).not.toBeNull();
    expect(
      (await b.post('/admin/reauth', { password: PASSWORD, next: '/admin/purge' })).status,
    ).toBe(303);

    const done = await b.post('/admin/purge', form);
    expect(done.status).toBe(303);
    const id = /^\/admin\/purge-record\?id=(prg_[0-9a-f]{12})&done=1$/.exec(
      done.headers.location ?? '',
    )?.[1];
    expect(id).toBeDefined();
    expect(getEvent(db, 'fake:2')).toBeNull();
    expect(getEvent(db, 'fake:1')).not.toBeNull();
    const detail = getPurge(db, id ?? '');
    expect(detail).toMatchObject({ channel: 'ui', author: 'user@hub', reason: 'pasted a key' });
    // The mirror's line was blanked as the purge answered.
    expect(detail?.mirrors.map((m) => m.pending)).toEqual([false]);
    expect(mirrorText(db, home, detail?.mirrors[0]?.rawFileId ?? 0)).not.toContain(CANARY);

    // Its record, the list of purges, and the overview: ids, counts, and the reason.
    const record = await b.get(done.headers.location ?? '');
    expect(record.status).toBe(200);
    expect(pageProblems(record.text)).toEqual([]);
    expect(record.text).toContain('Purged. What is listed here is gone from this store.');
    expect(record.text).toContain('fake:2');
    expect(record.text).toContain('pasted a key');
    expect(record.text).toContain('Blanked');
    const list = await b.get('/admin/purges');
    expect(pageProblems(list.text)).toEqual([]);
    expect(list.text).toContain(`href="/admin/purge-record?id=${id}"`);
    expect(list.text).toContain('1 event, 0 entries, 1 line');
    const overview = await b.get('/admin/');
    expect(overview.text).toContain('Latest purges');
    expect(overview.text).toContain(`href="/admin/purge-record?id=${id}"`);
    for (const page of [record, list, overview]) expect(page.text).not.toContain(CANARY);
    // The event is gone, and its preview says there is nothing to purge.
    expect((await b.get('/admin/event?id=fake%3A2')).status).toBe(404);
    const again = await b.get('/admin/purge?event=fake%3A2');
    expect(again.status).toBe(400);
    expect(again.text).not.toContain('action="/admin/purge"');

    // The audit log names the owner, with ids and counts only.
    const audit = listAudit(db).find((r) => r.action === 'purge');
    expect(audit).toMatchObject({ actor: 'owner', channel: 'ui', target: id });
    const all = JSON.stringify(listAudit(db));
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain('pasted a key');
  });

  it('cannot be reached with a device, agent, or any other token, or without a session', async () => {
    const base = await serve();
    const device = createToken(db, 'laptop');
    const agent = createToken(db, 'bot', Date.now(), { kind: 'agent', preset: 'readwrite' });
    const plan = (selector: string) => `${base}${selector}`;
    for (const token of [device, agent]) {
      const auth = { Authorization: `Bearer ${token}` };
      for (const p of [
        '/admin/purge?event=fake%3A2',
        '/admin/purges',
        '/admin/purge-record?id=prg_000000000000',
      ]) {
        const res = await request(plan(p), { headers: auth });
        expect(res.status, p).toBe(303);
        expect(res.headers.location, p).toMatch(/^\/admin\/login\?next=/);
      }
      for (const p of ['purge-plan?event=fake%3A2', 'purges', 'purge-record?id=x']) {
        expect((await request(`${base}/admin/api/${p}`, { headers: auth })).status, p).toBe(401);
      }
      const body = JSON.stringify({
        selector: { kind: 'event', ids: ['fake:2'] },
        digest: 'sha256:x',
        reason: 'r',
      });
      const api = await request(`${base}/admin/api/purge`, {
        method: 'POST',
        headers: { ...auth, Origin: base, 'Content-Type': 'application/json' },
        body,
      });
      expect(api.status).toBe(401);
      const page = await request(`${base}/admin/purge`, {
        method: 'POST',
        headers: {
          ...auth,
          Origin: base,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'selector=%7B%7D&digest=x&reason=r&confirm=purge',
      });
      expect(page.status).toBe(303);
      expect(page.headers.location).toBe('/admin/login');
    }
    expect(getEvent(db, 'fake:2')).not.toBeNull();
    expect(listPurges(db)).toEqual([]);
  });

  it('refuses a purge that needs to read mirrors when the adapters were not given', async () => {
    const base = await serve({ adapters: undefined });
    const b = new Browser(base);
    await b.login(PASSWORD);
    const preview = await b.get('/admin/purge?event=fake%3A2');
    expect(preview.status).toBe(400);
    expect(preview.text).toContain('needs the fake adapter');
    expect(preview.text).not.toContain('action="/admin/purge"');
    expect(pageProblems(preview.text)).toEqual([]);
  });

  it('marks the forgets a purge touched, on the Forgotten view and the forget page', async () => {
    const tombstone = forget(db, 'fake:2', { reason: 'hide it', author: 'user@hub' }).tombstoneId;
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    const forgetPage = await b.get(`/admin/tombstone?id=${tombstone}`);
    // The owner sees what the forget hides there, and nowhere else: not in the preview.
    expect(forgetPage.text).toContain(CANARY);
    expect(forgetPage.text).toContain(`href="/admin/purge?forgotten=${tombstone}"`);
    const preview = await b.get(`/admin/purge?forgotten=${tombstone}`);
    expect(preview.status).toBe(200);
    expect(preview.text).not.toContain(CANARY);
    expect(preview.text).toContain(`href="/admin/tombstone?id=${tombstone}"`);
    const done = await b.post('/admin/purge', confirmForm(preview.text, 'hidden was not enough'));
    expect(done.status).toBe(303);
    const id = listPurges(db)[0]?.id ?? '';
    expect(id).toMatch(/^prg_/);

    const list = await b.get('/admin/tombstones');
    expect(pageProblems(list.text)).toEqual([]);
    expect(list.text).toContain(
      `Purged by <a class="ol-mono" href="/admin/purge-record?id=${id}">`,
    );
    const page = await b.get(`/admin/tombstone?id=${tombstone}`);
    expect(pageProblems(page.text)).toEqual([]);
    expect(page.text).toContain('<dt>Purged by</dt>');
    expect(page.text).toContain(`href="/admin/purge-record?id=${id}"`);
    // What the forget covered is gone, so there is nothing left there to purge.
    expect(page.text).not.toContain(`href="/admin/purge?forgotten=${tombstone}"`);
    expect(page.text).not.toContain(CANARY);
    const api = (await b.api('GET', 'tombstones')).json();
    expect(api.purgedBy).toEqual({ [tombstone ?? '']: [id] });
    expect((await b.api('GET', `tombstone?id=${tombstone}`)).json().purgedBy).toMatchObject([
      { id, events: 1, entries: 0 },
    ]);
  });
});

describe('purging through the JSON API', () => {
  it('plans, refuses a stale digest (409) and a session without a recent password, then purges', async () => {
    const base = await serve();
    const b = new Browser(base);
    await b.login(PASSWORD);
    const planned = await b.api('GET', 'purge-plan?session=fake%3As1');
    expect(planned.status).toBe(200);
    expect(planned.text).not.toContain(CANARY);
    const plan = planned.json();
    expect(plan.selector).toEqual({ kind: 'session', source: 'fake', sessionId: 's1' });
    expect(plan.events).toEqual(['fake:1', 'fake:2', 'fake:3']);
    expect(plan.counts).toMatchObject({ events: 3, sessions: 1 });
    expect(plan.limits).toEqual(PURGE_LIMITS);
    const body = { selector: plan.selector, digest: plan.digest, reason: 'test data' };

    expect((await b.api('GET', 'purge-plan?event=x&entry=y')).status).toBe(400);
    expect((await b.api('POST', 'purge', { ...body, digest: undefined })).status).toBe(400);
    const stale = await b.api('POST', 'purge', { ...body, digest: `sha256:${'1'.repeat(32)}` });
    expect(stale.status).toBe(409);
    expect(stale.json().error).toMatch(/plan it again/);
    // Same-origin and the CSRF token, as for every write.
    expect((await b.api('POST', 'purge', body, { 'X-CSRF-Token': 'wrong' })).status).toBe(403);
    expect((await b.api('POST', 'purge', body, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    clock += 11 * 60_000;
    const notFresh = await b.api('POST', 'purge', body);
    expect(notFresh.status).toBe(403);
    expect(notFresh.json()).toMatchObject({ reauth: true });
    expect(getEvent(db, 'fake:2')).not.toBeNull();

    expect((await b.api('POST', 'reauth', { password: PASSWORD })).status).toBe(200);
    const done = await b.api('POST', 'purge', body);
    expect(done.status).toBe(200);
    const result = done.json();
    expect(result).toMatchObject({ pending: 0, record: { channel: 'api', reason: 'test data' } });
    expect(getEvent(db, 'fake:2')).toBeNull();

    const purges = (await b.api('GET', 'purges')).json();
    expect(purges).toMatchObject({ more: false, purges: [{ id: result.id, pending: 0 }] });
    const record = await b.api('GET', `purge-record?id=${result.id}`);
    expect(record.json().removed.sessions).toEqual([{ source: 'fake', sessionId: 's1' }]);
    expect(record.text).not.toContain(CANARY);
    expect((await b.api('GET', 'purge-record?id=prg_000000000000')).status).toBe(404);
    expect(listAudit(db).find((r) => r.action === 'purge')).toMatchObject({
      actor: 'owner',
      channel: 'api',
      target: result.id,
    });
  });
});

describe('purging on origin ui', () => {
  it('needs no password, and says that the hub keeps its copy, with the same purge there', async () => {
    const b = await serveLocal({
      hub: () => ({
        url: 'https://hub.example.com',
        device: 'laptop',
        lastSyncAt: null,
        syncing: false,
        lastError: null,
      }),
    });
    const session = await b.get('/admin/session?source=fake&id=s1');
    expect(session.text).toContain('href="/admin/purge?session=fake%3As1"');
    const preview = await b.get('/admin/purge?session=fake%3As1');
    expect(preview.status).toBe(200);
    expect(pageProblems(preview.text)).toEqual([]);
    expect(preview.text).not.toContain(CANARY);
    expect(preview.text).toContain('keeps its copy');
    expect(preview.text).toContain('href="https://hub.example.com/admin/purge?session=fake%3As1"');
    const done = await b.post('/admin/purge', confirmForm(preview.text, 'test session'));
    expect(done.status).toBe(303);
    expect(getEvent(db, 'fake:1')).toBeNull();
    const record = await b.get(done.headers.location ?? '');
    expect(record.text).toContain('keeps its copy');
    expect(record.text).not.toContain(CANARY);
    expect(listAudit(db).find((r) => r.action === 'purge')).toMatchObject({
      actor: 'local',
      channel: 'ui',
    });
  });
});

describe('purge selectors in a query', () => {
  it('read the words of origin purge, one kind at a time, and write them back', () => {
    const q = (s: string) => selectorFromQuery(new URLSearchParams(s));
    expect(q('event=a:1&event=a:2&event=a:1')).toEqual({ kind: 'event', ids: ['a:1', 'a:2'] });
    expect(q('session=claude-code:abc:def&keep-children=1')).toEqual({
      kind: 'session',
      source: 'claude-code',
      sessionId: 'abc:def',
      keepChildren: true,
    });
    expect(q('source=fake&session=s1')).toEqual({
      kind: 'session',
      source: 'fake',
      sessionId: 's1',
    });
    expect(q('forgotten=all')).toEqual({ kind: 'forgotten', tombstone: 'all' });
    expect(
      q('source=fake&from=laptop&file=3&lines=2-5&since=2026-11-01T00:00Z&unparsed=1'),
    ).toEqual({
      kind: 'lines',
      source: 'fake',
      from: 'laptop',
      file: 3,
      lines: { first: 2, last: 5 },
      since: Date.parse('2026-11-01T00:00Z'),
      unparsed: true,
    });
    for (const s of [
      'event=a:1',
      'session=fake:s1&keep-children=1',
      'entry=ent_1',
      'forgotten=tmb_1',
      'recall=rcl_1',
      'source=fake&from=laptop&path=%2Fa%2Fb.jsonl&file=3&lines=2-5&since=2026-11-01T00%3A00%3A00.000Z&until=2026-11-02T00%3A00%3A00.000Z&unparsed=1',
    ]) {
      expect(q(selectorQuery(q(s)))).toEqual(q(s));
    }
    for (const bad of [
      '',
      'event=a&entry=b',
      'session=nosource',
      'source=f&lines=5-2',
      'source=f&file=x',
    ]) {
      expect(() => q(bad), bad).toThrow();
    }
  });

  it('name in English exactly what core says a purge does not reach', () => {
    expect(PURGE_LIMIT_KEYS.map((k) => en[k])).toEqual([...PURGE_LIMITS]);
  });
});
