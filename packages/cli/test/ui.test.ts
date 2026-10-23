import fs from 'node:fs';
import type http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  createToken,
  type Database,
  getEntry,
  getEvent,
  getSetting,
  initStoreName,
  listAudit,
  openDatabase,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Browser, pageProblems } from '../../admin/test/helpers.js';
import type { HubConfig } from '../src/hub/config.js';
import { createHubServer } from '../src/hub/server.js';
import { syncedKey } from '../src/hub/sync.js';
import { browserCommand, type RunningUi, startLocalUi, writeSignInFile } from '../src/ui.js';

const fixtures = fileURLToPath(
  new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';

let tmp: string;
let hubDb: Database;
let deviceDb: Database;
let deviceHome: string;
let hubServer: http.Server;
let hub: HubConfig;
let uis: RunningUi[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ui-'));
  const hubHome = path.join(tmp, 'hub');
  deviceHome = path.join(tmp, 'device');
  hubDb = openDatabase(path.join(hubHome, 'origin.db'));
  deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
  initStoreName(deviceDb, 'laptop');
  hubServer = createHubServer({
    db: hubDb,
    home: hubHome,
    adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
    version: 'test',
  });
  await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
  hub = {
    url: `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`,
    token: createToken(hubDb, 'laptop'),
    device: 'laptop',
  };
  await syncSource(
    { db: deviceDb, home: deviceHome },
    createClaudeCodeAdapter({ projectsDir: fixtures }),
  );
  uis = [];
});

afterEach(async () => {
  for (const ui of uis) await ui.close();
  hubServer.closeAllConnections();
  await new Promise((resolve) => hubServer.close(resolve));
  hubDb.close();
  deviceDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function start(connected: HubConfig | null, port = 0): Promise<RunningUi> {
  const ui = await startLocalUi({
    db: deviceDb,
    home: deviceHome,
    version: 'test',
    port,
    hub: () => connected,
  });
  uis.push(ui);
  return ui;
}

/** Sign in with the printed link, as the browser does. */
async function signIn(ui: RunningUi): Promise<Browser> {
  const link = new URL(ui.signInUrl);
  const b = new Browser(link.origin);
  expect((await b.get(`${link.pathname}${link.search}`)).status).toBe(303);
  expect((await b.get('/admin/')).status).toBe(200);
  return b;
}

describe('origin ui', () => {
  it('refuses to listen anywhere but 127.0.0.1', async () => {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.10']) {
      await expect(
        startLocalUi({
          db: deviceDb,
          home: deviceHome,
          version: 'test',
          host,
          port: 0,
          hub: () => null,
        }),
        host,
      ).rejects.toThrow(/listens only on 127\.0\.0\.1/);
    }
  });

  it('prints a link to 127.0.0.1 with a one-time secret', async () => {
    const ui = await start(null);
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/admin\/$/);
    expect(ui.signInUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/admin\/login\?secret=[A-Za-z0-9_-]{43}$/,
    );
    const b = await signIn(ui);
    const page = await b.get('/admin/');
    expect(pageProblems(page.text)).toEqual([]);
    expect(page.text).toContain('Not connected');
    const event = await b.get(`/admin/event?id=${encodeURIComponent(USER_EVENT)}`);
    expect(event.status).toBe(200);
    expect(event.text).toContain('帮我检查一下仓库的状态');
  });

  it('syncs what is written with the hub in the background, and shows the last sync', async () => {
    const ui = await start(hub);
    const b = await signIn(ui);
    expect((await b.get('/admin/')).text).toContain('<dd>never</dd>');

    await b.get(`/admin/remember?event=${encodeURIComponent(USER_EVENT)}`);
    const res = await b.post('/admin/remember', {
      event: USER_EVENT,
      kind: 'memory',
      text: 'Asked for a repository status check.',
    });
    expect(res.status).toBe(303);
    const id = /id=(ent_[0-9a-f]+)/.exec(res.headers.location ?? '')?.[1] ?? '';
    await ui.idle();
    expect(getEntry(hubDb, id)).toMatchObject({ author: 'user@laptop', origin: 'laptop' });
    const syncedAt = Number(getSetting(deviceDb, syncedKey(hub)));
    expect(syncedAt).toBeGreaterThan(0);
    const page = (await b.get('/admin/')).text;
    expect(page).toContain(`datetime="${new Date(syncedAt).toISOString()}"`);
    expect(page).toContain(hub.url);
    expect(page).not.toContain(hub.token);

    const plan = (await b.api('GET', `forget-plan?id=${id}`)).json();
    const done = await b.post('/admin/forget', { id, digest: plan.digest, confirm: id });
    expect(done.status).toBe(200);
    await ui.idle();
    expect(getEntry(hubDb, id)).toBeNull();
    expect(getEvent(hubDb, USER_EVENT)).toBeNull();
    expect(listAudit(deviceDb, { action: 'forget' })).toMatchObject([
      { actor: 'local', channel: 'ui', target: id },
    ]);
  });

  it('keeps a write when the hub cannot be reached, and says so', async () => {
    const away: HubConfig = { ...hub, url: 'http://127.0.0.1:9' };
    const ui = await start(away);
    const b = await signIn(ui);
    const created = await b.api('POST', 'entries', {
      eventId: USER_EVENT,
      kind: 'knowledge',
      text: 'The demo project is a git repository.',
    });
    expect(created.status).toBe(201);
    await ui.idle();
    expect(getEntry(deviceDb, created.json().entry.id)).not.toBeNull();
    const page = (await b.get('/admin/')).text;
    expect(page).toContain('Not synced');
    expect(page).toContain('The last sync with the hub failed');
    expect(getSetting(deviceDb, syncedKey(away))).toBeNull();
  });

  it('ends its sessions and its link when it stops', async () => {
    const first = await start(null);
    const b = await signIn(first);
    const unusedLink = new URL((await start(null)).signInUrl);
    await first.close();
    const refused = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(new URL(first.url).port), '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
    // The next run knows nothing of the sessions or links of earlier ones.
    const again = await start(null);
    const carried = new Browser(new URL(again.url).origin);
    for (const [k, v] of b.jar) carried.jar.set(k, v);
    expect((await carried.get('/admin/')).status).toBe(303);
    const other = new Browser(new URL(again.url).origin);
    expect((await other.get(`${unusedLink.pathname}${unusedLink.search}`)).status).toBe(401);
  });

  it('says when its port is taken', async () => {
    const first = await start(null);
    await expect(start(null, Number(new URL(first.url).port))).rejects.toThrow(
      /is in use \(is origin ui already running\?\)/,
    );
  });
});

describe('opening the browser', () => {
  it('uses what each platform has built in', () => {
    const file = 'C:\\Users\\A B\\AppData\\Local\\Temp\\origin-ui-x\\sign-in.html';
    expect(browserCommand('win32', file)).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"start "" "${file}""`],
      options: { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
    });
    expect(browserCommand('darwin', '/tmp/x.html')).toMatchObject({
      command: 'open',
      args: ['/tmp/x.html'],
      options: { detached: true },
    });
    expect(browserCommand('linux', '/tmp/x.html')).toMatchObject({
      command: 'xdg-open',
      args: ['/tmp/x.html'],
      options: { detached: true },
    });
  });

  it('goes through a file only its owner can read, so the secret stays off command lines', () => {
    const url = 'http://127.0.0.1:7079/admin/login?secret=abc_DEF-123&x="<y>"';
    const { file, remove } = writeSignInFile(url);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain(
      '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:7079/admin/login?secret=abc_DEF-123&#38;x=&#34;&#60;y&#62;&#34;">',
    );
    expect(text).not.toContain('"<y>"');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    remove();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });
});
