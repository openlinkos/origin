import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  correct,
  createToken,
  type Database,
  getEntry,
  getEvent,
  getSetting,
  initStoreName,
  listAudit,
  openDatabase,
  remember,
  type ScryptParams,
  setAdminPassword,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Browser, pageProblems, request } from '../../admin/test/helpers.js';
import type { HubConfig } from '../src/hub/config.js';
import { type RunningHub, startHub } from '../src/hub/serve.js';
import { syncWithHub } from '../src/hub/sync.js';

const fixtures = fileURLToPath(
  new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';
const XSS_SESSION = '77777777-7777-4777-8777-777777777777';
const XSS_TEXT = '<img src=x onerror=alert(1)><script>alert(2)</script>';

let tmp: string;
let hubHome: string;
let deviceHome: string;
let hubDb: Database;
let deviceDb: Database;
let hub: RunningHub;
let extra: RunningHub[];
let device: HubConfig;

/** Cheap scrypt parameters for tests; a stored hash records its own parameters. */
const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

/** A synthetic Claude Code session whose message and title are markup. */
function writeXssSession(projects: string): void {
  const dir = path.join(projects, 'D--demo-xss');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    {
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: XSS_TEXT },
      uuid: '66666666-6666-4666-8666-666666666666',
      timestamp: '2026-10-19T04:00:00.000Z',
      cwd: 'D:\\demo\\xss',
      sessionId: XSS_SESSION,
      version: '2.1.303',
      gitBranch: 'master',
    },
    { type: 'summary', summary: '<b onmouseover=alert(3)>XSS</b> title', leafUuid: '6666' },
  ];
  fs.writeFileSync(
    path.join(dir, `${XSS_SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-e2e-'));
  hubHome = path.join(tmp, 'hub');
  deviceHome = path.join(tmp, 'device');
  hubDb = openDatabase(path.join(hubHome, 'origin.db'));
  deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
  initStoreName(deviceDb, 'laptop');
  await setAdminPassword(hubDb, PASSWORD, { params: FAST });
  extra = [];
  hub = await startHub({
    db: hubDb,
    home: hubHome,
    host: '127.0.0.1',
    port: 0,
    adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
    version: 'test',
    admin: { passwordParams: FAST },
  });
  device = { url: hub.url, token: createToken(hubDb, 'laptop'), device: 'laptop' };

  const projects = path.join(tmp, 'projects');
  fs.cpSync(fixtures, projects, { recursive: true });
  writeXssSession(projects);
  await syncSource(
    { db: deviceDb, home: deviceHome },
    createClaudeCodeAdapter({ projectsDir: projects }),
  );
  await push();
});

afterEach(async () => {
  await hub.close();
  for (const h of extra) await h.close();
  hubDb.close();
  deviceDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const push = (hubConfig: HubConfig = device) =>
  syncWithHub({ db: deviceDb, home: deviceHome, hub: hubConfig });

async function signedIn(): Promise<Browser> {
  const b = new Browser(hub.url);
  const res = await b.login(PASSWORD);
  expect(res.status).toBe(303);
  return b;
}

async function mcp(): Promise<Client> {
  const client = new Client({ name: 'cloud-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', hub.url), {
      requestInit: { headers: { Authorization: `Bearer ${device.token}` } },
    }),
  );
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: MCP tool results are untyped JSON
const toolJson = (result: any) => JSON.parse(result.content[0].text);

describe('admin UI on the hub', () => {
  it('signs in with the admin password and shows the device and its events', async () => {
    const b = await signedIn();
    const page = await b.get('/admin/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('href="/admin/device?name=laptop"');
    const overview = (await b.api('GET', 'overview')).json();
    expect(overview.counts).toMatchObject({ events: 7, devices: 1, activeTokens: 1 });
    expect(overview.devices).toMatchObject([{ device: 'laptop', stale: false }]);
    expect(overview.version).toBe('test');

    for (const p of [
      '/admin/devices',
      '/admin/device?name=laptop',
      '/admin/connect',
      '/admin/tokens',
      '/admin/sessions',
      `/admin/session?source=claude-code&id=0f1e2d3c-4b5a-4697-8877-665544332211&tools=1`,
      `/admin/event?id=${encodeURIComponent(USER_EVENT)}`,
      `/admin/event-raw?id=${encodeURIComponent(USER_EVENT)}`,
      '/admin/search?q=%E4%BB%93%E5%BA%93',
      '/admin/entries?history=1',
      '/admin/tombstones',
      '/admin/audit',
      '/admin/signins',
      `/admin/remember?event=${encodeURIComponent(USER_EVENT)}`,
    ]) {
      const res = await b.get(p);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain('</html>');
      expect(pageProblems(res.text), p).toEqual([]);
    }
    const event = await b.get(`/admin/event?id=${encodeURIComponent(USER_EVENT)}`);
    expect(event.text).toContain('帮我检查一下仓库的状态');
    expect(event.text).toContain('raw/devices/laptop/claude-code/D--demo-project/');
    const raw = (await b.api('GET', `event-raw?id=${encodeURIComponent(USER_EVENT)}`)).json();
    expect(raw).toMatchObject({ id: USER_EVENT, truncated: false });
    expect(JSON.parse(raw.line).uuid).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('keeps admin sessions and hub tokens apart', async () => {
    const b = await signedIn();
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    expect(
      (await request(`${hub.url}/admin/api/overview`, { headers: bearer(device.token) })).status,
    ).toBe(401);
    expect(
      (await request(`${hub.url}/admin/api/overview`, { headers: bearer(PASSWORD) })).status,
    ).toBe(401);

    const cookie = [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'x', version: '0' },
      },
    });
    const mcpHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const viaCookie = await request(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, Cookie: cookie },
      body: init,
    });
    expect(viaCookie.status).toBe(401);
    const viaPassword = await request(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, ...bearer(PASSWORD) },
      body: init,
    });
    expect(viaPassword.status).toBe(401);
    expect(
      (await request(`${hub.url}/v1/cursors?device=laptop`, { headers: bearer(PASSWORD) })).status,
    ).toBe(401);
    // A hub token is never an admin password.
    expect(
      (await new Browser(hub.url).post('/admin/login', { password: device.token })).status,
    ).toBe(401);
    expect(
      (await request(`${hub.url}/v1/cursors?device=laptop`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
  });

  it('is a 404 when disabled, and can run on its own listener', async () => {
    const plain = await startHub({
      db: hubDb,
      home: hubHome,
      host: '127.0.0.1',
      port: 0,
      adapters: [],
      version: 'test',
    });
    extra.push(plain);
    expect(plain.adminUrl).toBeNull();
    for (const p of ['/admin', '/admin/', '/admin/login', '/admin/api/overview']) {
      expect((await request(`${plain.url}${p}`)).status, p).toBe(404);
    }

    const split = await startHub({
      db: hubDb,
      home: hubHome,
      host: '127.0.0.1',
      port: 0,
      adapters: [],
      version: 'test',
      admin: { listen: { host: '127.0.0.1', port: 0 } },
    });
    extra.push(split);
    expect((await request(`${split.url}/admin/login`)).status).toBe(404);
    expect(split.adminUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/admin\/$/);
    expect((await request(`${split.adminUrl}`.replace(/\/admin\/$/, '/admin/login'))).status).toBe(
      200,
    );
  });

  it('refuses to serve the admin UI over plain HTTP beyond loopback', async () => {
    const start = (admin: Parameters<typeof startHub>[0]['admin'], host = '0.0.0.0') =>
      startHub({ db: hubDb, home: hubHome, host, port: 0, adapters: [], version: 'test', admin });
    await expect(start({})).rejects.toThrow(/not a loopback address/);
    await expect(start({ publicUrl: new URL('http://hub.example.com') })).rejects.toThrow(
      /unencrypted/,
    );
    await expect(start({ listen: { host: '0.0.0.0', port: 0 } }, '127.0.0.1')).rejects.toThrow(
      /not a loopback address/,
    );
    const ok = await start({ publicUrl: new URL('https://hub.example.com') });
    extra.push(ok);
  });

  it('rate-limits failed sign-ins', async () => {
    const b = new Browser(hub.url);
    for (let i = 0; i < 10; i++) {
      expect((await b.post('/admin/login', { password: `wrong-guess-${i}` })).status).toBe(401);
    }
    const eleventh = await b.post('/admin/login', { password: 'wrong-guess-10' });
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    expect((await b.post('/admin/login', { password: PASSWORD })).status).toBe(429);
  });

  it('generates a password on the first start and logs it only that once', async () => {
    const home = path.join(tmp, 'fresh-hub');
    const db = openDatabase(path.join(home, 'origin.db'));
    try {
      const start = async (log: string[]) => {
        const h = await startHub({
          db,
          home,
          host: '127.0.0.1',
          port: 0,
          adapters: [],
          version: 'test',
          log: (m) => log.push(m),
          admin: { passwordParams: FAST },
        });
        extra.push(h);
        return h;
      };
      const firstLog: string[] = [];
      const first = await start(firstLog);
      const notice = firstLog.join('\n');
      expect(notice).toContain(
        'Generated an admin password for the admin UI (shown only this once):',
      );
      expect(notice).toContain('origin admin password');
      const password = /^ {4}([0-9a-z]{5}(?:-[0-9a-z]{5}){3})$/m.exec(notice)?.[1] ?? '';
      expect(password).not.toBe('');
      const b = new Browser(first.url);
      expect((await b.login(password)).status).toBe(303);
      await first.close();

      const secondLog: string[] = [];
      const second = await start(secondLog);
      expect(secondLog.join('\n')).not.toContain('Generated');
      expect(secondLog.join('\n')).not.toContain(password);
      // The same password still works, and the session survived the restart.
      const again = new Browser(second.url);
      for (const [k, v] of b.jar) again.jar.set(k, v);
      expect((await again.get('/admin/')).status).toBe(200);
      expect(listAudit(db).map((r) => [r.action, r.actor])).toEqual([
        ['login', 'owner'],
        ['password.generate', 'hub'],
      ]);
      expect(JSON.stringify(listAudit(db))).not.toContain(password);
    } finally {
      for (const h of extra.splice(0)) await h.close();
      db.close();
    }
  });

  it('prefers ORIGIN_ADMIN_PASSWORD, and ends sessions when it changes', async () => {
    const start = async (envPassword: string) => {
      const h = await startHub({
        db: hubDb,
        home: hubHome,
        host: '127.0.0.1',
        port: 0,
        adapters: [],
        version: 'test',
        admin: { envPassword, passwordParams: FAST },
      });
      extra.push(h);
      return h;
    };
    const stored = await signedIn();
    const first = await start('env-password-one');
    const carry = (from: Browser, url: string) => {
      const b = new Browser(url);
      for (const [k, v] of from.jar) b.jar.set(k, v);
      return b;
    };
    // Switching to the environment password ended the session made with the stored one.
    expect((await carry(stored, first.url).get('/admin/')).status).toBe(303);
    expect((await new Browser(first.url).login(PASSWORD)).status).toBe(401);
    const b = new Browser(first.url);
    expect((await b.login('env-password-one')).status).toBe(303);

    // Restarted with the same value: the session stays.
    const same = await start('env-password-one');
    expect((await carry(b, same.url).get('/admin/')).status).toBe(200);

    // Restarted with another value: every session ends, and only the new value signs in.
    const changed = await start('env-password-two');
    expect((await carry(b, changed.url).get('/admin/')).status).toBe(303);
    expect((await new Browser(changed.url).login('env-password-one')).status).toBe(401);
    expect((await new Browser(changed.url).login('env-password-two')).status).toBe(303);
    expect(
      listAudit(hubDb, { action: 'password.change' }).map((r) => [r.actor, r.detail?.source]),
    ).toEqual([
      ['hub', 'env'],
      ['hub', 'env'],
      // The first start, in beforeEach, with the stored password.
      ['hub', 'stored'],
    ]);

    await expect(start('too-short')).rejects.toThrow(
      /ORIGIN_ADMIN_PASSWORD must be at least 10 characters/,
    );
  });

  it('keeps the admin password on the hub: devices never receive it', async () => {
    await push();
    expect(getSetting(hubDb, 'admin.password')).toMatch(/^scrypt\$/);
    expect(getSetting(deviceDb, 'admin.password')).toBeNull();
    expect(getSetting(deviceDb, 'admin.credential')).toBeNull();
  });

  it('ends the session on sign-out', async () => {
    const b = await signedIn();
    const jar = new Map(b.jar);
    expect((await b.post('/admin/logout', {})).status).toBe(303);
    const stale = new Browser(hub.url);
    for (const [k, v] of jar) stale.jar.set(k, v);
    const page = await stale.get('/admin/');
    expect(page.status).toBe(303);
    expect(page.headers.location).toMatch(/^\/admin\/login/);
    expect((await stale.api('GET', 'overview')).status).toBe(401);
  });

  it('creates and revokes tokens, with audit records', async () => {
    const b = await signedIn();
    await b.get('/admin/tokens/new');
    const created = await b.post('/admin/tokens', { name: 'desk' });
    expect(created.status).toBe(200);
    const token = /ogn_[A-Za-z0-9_-]{43}/.exec(created.text)?.[0];
    expect(token).toBeDefined();
    expect(created.text).toContain(
      `origin hub connect https://hub.example.com --token ${token} --device desk`,
    );
    expect(created.text).toContain(`--header &quot;Authorization: Bearer ${token}&quot;`);
    expect(created.text).toContain('--bearer-token-env-var ORIGIN_TOKEN');

    const desk: HubConfig = { url: hub.url, token: token ?? '', device: 'desk' };
    await expect(push(desk)).resolves.toMatchObject({ files: 2 });
    expect((await b.get('/admin/tokens')).text).not.toContain(token ?? 'missing');

    await b.get('/admin/tokens/revoke?name=desk');
    const revoked = await b.post('/admin/tokens/revoke', { name: 'desk' });
    expect(revoked.status).toBe(303);
    await expect(push(desk)).rejects.toThrow(/rejected the token/);

    const audit = listAudit(hubDb).filter((r) => r.action.startsWith('token.'));
    expect(audit).toMatchObject([
      {
        action: 'token.revoke',
        target: 'desk',
        actor: 'owner',
        channel: 'ui',
        ip: '127.0.0.1',
      },
      { action: 'token.create', target: 'desk', actor: 'owner', channel: 'ui' },
    ]);
  });

  it('renders session content only as text', async () => {
    const b = await signedIn();
    const pages = [
      await b.get(`/admin/session?source=claude-code&id=${XSS_SESSION}`),
      await b.get('/admin/search?q=onerror'),
      await b.get('/admin/search?q=alert(2)'),
      await b.get('/admin/sessions'),
    ];
    for (const page of pages) {
      expect(page.status).toBe(200);
      expect(pageProblems(page.text)).toEqual([]);
      expect(page.text).not.toContain('<script>alert');
      expect(page.text).not.toContain('<img src=x');
      expect(page.text).not.toContain('<b onmouseover');
    }
    expect(pages[0]?.text).toContain(
      '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;',
    );
    expect(pages[1]?.text).toContain('&lt;img src=x [onerror]');
    expect(pages[2]?.text).toContain('&lt;script&gt;[alert(2)]&lt;/script&gt;');
    expect(pages[3]?.text).toContain('&lt;b onmouseover=alert(3)&gt;XSS&lt;/b&gt; title');
  });

  it('forgets an event everywhere, and keeps no text in the audit log', async () => {
    const b = await signedIn();
    await b.get(`/admin/remember?event=${encodeURIComponent(USER_EVENT)}`);
    const remembered = await b.post('/admin/remember', {
      event: USER_EVENT,
      kind: 'memory',
      text: 'Asked for a repository status check.',
      quote: '检查一下仓库',
    });
    expect(remembered.status).toBe(303);
    const entryId = /id=(ent_[0-9a-f]+)/.exec(remembered.headers.location ?? '')?.[1] ?? '';
    expect(getEntry(hubDb, entryId)).toMatchObject({ author: 'user@hub', confidence: 1 });

    const preview = await b.get(`/admin/forget?id=${encodeURIComponent(USER_EVENT)}`);
    expect(preview.status).toBe(200);
    expect(preview.text).toContain(entryId);
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(preview.text)?.[1] ?? '';
    const wrong = await b.post('/admin/forget', { id: USER_EVENT, digest, confirm: 'nope' });
    expect(wrong.status).toBe(400);
    const done = await b.post('/admin/forget', {
      id: USER_EVENT,
      digest,
      confirm: USER_EVENT,
      reason: 'test',
    });
    expect(done.status).toBe(200);

    const client = await mcp();
    const found = toolJson(await client.callTool({ name: 'search', arguments: { query: '仓库' } }));
    expect(found.events).toEqual([]);
    expect(found.entries).toEqual([]);
    const got = await client.callTool({ name: 'get', arguments: { id: USER_EVENT } });
    expect(got.isError).toBe(true);
    const gotEntry = await client.callTool({ name: 'get', arguments: { id: entryId } });
    expect(gotEntry.isError).toBe(true);
    await client.close();

    expect((await b.get(`/admin/event?id=${encodeURIComponent(USER_EVENT)}`)).status).toBe(410);
    expect((await b.api('GET', `event-raw?id=${encodeURIComponent(USER_EVENT)}`)).status).toBe(410);
    expect((await b.get(`/admin/entry?id=${entryId}`)).status).toBe(410);

    expect(getEvent(deviceDb, USER_EVENT)).not.toBeNull();
    expect((await push()).tombstonesApplied).toBe(1);
    expect(getEvent(deviceDb, USER_EVENT)).toBeNull();

    const records = listAudit(hubDb);
    const forgetRecord = records.find((r) => r.action === 'forget');
    expect(forgetRecord).toMatchObject({
      target: USER_EVENT,
      detail: { targetType: 'event', entries: 1, events: 1 },
    });
    const all = JSON.stringify(records);
    for (const text of ['仓库', 'repository status', '检查一下', 'test']) {
      expect(all).not.toContain(text);
    }
    const tombstones = await b.get('/admin/tombstones');
    expect(tombstones.text).not.toContain('仓库');
    expect(tombstones.text).toContain(USER_EVENT);
  });

  it('refuses to forget when the plan has changed', async () => {
    const b = await signedIn();
    const plan = (await b.api('GET', `forget-plan?id=${encodeURIComponent(USER_EVENT)}`)).json();
    expect(plan.plan.entries).toEqual([]);
    const created = await b.api('POST', 'entries', {
      eventId: USER_EVENT,
      kind: 'knowledge',
      text: 'The demo project is a git repository.',
    });
    expect(created.status).toBe(201);
    const stale = await b.api('POST', 'forget', {
      id: USER_EVENT,
      digest: plan.digest,
      confirm: USER_EVENT,
    });
    expect(stale.status).toBe(409);
    expect(getEvent(hubDb, USER_EVENT)).not.toBeNull();
    const fresh = (await b.api('GET', `forget-plan?id=${encodeURIComponent(USER_EVENT)}`)).json();
    const ok = await b.api('POST', 'forget', {
      id: USER_EVENT,
      digest: fresh.digest,
      confirm: USER_EVENT,
    });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ entries: 1, events: 1, targetType: 'event' });
  });

  it('corrects an entry by adding a version and leaving the old row as it was', async () => {
    const b = await signedIn();
    const created = (
      await b.api('POST', 'entries', {
        eventId: USER_EVENT,
        kind: 'memory',
        text: 'Checked the repository.',
        confidence: 0.6,
      })
    ).json();
    const oldId = created.entry.id as string;
    const before = hubDb.prepare('SELECT * FROM entry WHERE id = ?').get(oldId);

    await b.get(`/admin/correct?id=${oldId}`);
    const res = await b.post('/admin/correct', {
      id: oldId,
      text: 'Checked the repository status; the tree was clean.',
      kind: 'memory',
    });
    expect(res.status).toBe(303);
    const newId = /id=(ent_[0-9a-f]+)/.exec(res.headers.location ?? '')?.[1] ?? '';
    expect(newId).not.toBe(oldId);
    expect(hubDb.prepare('SELECT * FROM entry WHERE id = ?').get(oldId)).toEqual(before);
    expect(getEntry(hubDb, newId)).toMatchObject({
      supersedes: oldId,
      author: 'user@hub',
      confidence: 1,
      status: 'active',
    });
    expect(getEntry(hubDb, oldId)).toMatchObject({ status: 'superseded', supersededBy: newId });
    const page = await b.get(`/admin/entry?id=${oldId}`);
    expect(page.text).toContain(newId);
    expect(listAudit(hubDb, { action: 'entry.correct' })).toMatchObject([
      { target: oldId, detail: { newId } },
    ]);
  });

  it('shows where each version was written and marks concurrent corrections', async () => {
    const b = await signedIn();
    const first = remember(
      deviceDb,
      {
        kind: 'memory',
        text: 'Checked the repository.',
        confidence: 0.5,
        author: 'claude-code@laptop',
        sources: [{ eventId: USER_EVENT }],
      },
      1_000,
    );
    await push();
    const onHub = correct(hubDb, first.id, { text: 'Hub version.', author: 'user@hub' }, 2_000);
    const onDevice = correct(
      deviceDb,
      first.id,
      { text: 'Device version.', author: 'user@laptop' },
      3_000,
    );
    await push();

    const lost = await b.get(`/admin/entry?id=${onHub.id}`);
    expect(lost.status).toBe(200);
    expect(lost.text).toContain('lost to a concurrent correction');
    expect(lost.text).toContain(onDevice.id);
    expect(lost.text).toContain('concurrent edit');
    const original = await b.get(`/admin/entry?id=${first.id}`);
    expect(original.text).toContain('Written on');
    expect(original.text).toContain('<dd>laptop</dd>');
    expect((await b.get(`/admin/entry?id=${onHub.id}`)).text).toContain('<dd>hub</dd>');
  });
});
