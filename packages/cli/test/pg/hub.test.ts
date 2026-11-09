import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  createToken,
  type Database,
  dbPath,
  getEvent,
  initStoreName,
  openDatabase,
  type ScryptParams,
  setAdminPassword,
  storeName,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browser } from '../../../admin/test/helpers.js';
import { type RunningHub, startHub } from '../../src/hub/serve.js';
import { syncWithHub } from '../../src/hub/sync.js';
import { main } from '../../src/main.js';
import { readPairing, writePairing } from '../../src/pairing.js';
import { main as recall } from '../../src/recall.js';
import { holdServeLock, openStore } from '../../src/store.js';
import { main as syncHook } from '../../src/sync-hook.js';
import { backend, onPostgres, outside, terminateLater, urls, usePostgres } from './helpers.js';

/**
 * A hub whose store is in PostgreSQL (see packages/cli/src/store.ts): the commands that refuse to
 * run there, store.json's pairing of the database with ORIGIN_HOME, the lock of origin serve, and a
 * device synced into it, searched through /mcp, and purged through the admin API.
 */

usePostgres();

const fixtures = fileURLToPath(
  new URL('../../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';
const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const ENV = [
  'ORIGIN_HOME',
  'ORIGIN_DATABASE_URL',
  'ORIGIN_DATABASE_URL_FILE',
  'ORIGIN_CLAUDE_PROJECTS',
  'ORIGIN_DEVICE',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let err: string[];
let out: string[];
let opened: Database[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-pg-hub-'));
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  opened = [];
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) db.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The URL of a store in schema `schema` of this file's database. */
function storeUrl(schema: string): string {
  const u = new URL(urls().database);
  u.searchParams.set('schema', schema);
  return u.href;
}

/** Open the store of `home` as the CLI does, in `schema`; closed after the test. */
function openHub(home: string, schema: string, command = 'serve'): Database {
  const db = openStore(home, { ORIGIN_DATABASE_URL: storeUrl(schema) }, { command });
  opened.push(db);
  return db;
}

describe('commands that do not run on a store in PostgreSQL', () => {
  // Refused before any connection: the URL is never used.
  const URL = 'postgres://origin:secret@127.0.0.1:1/origin';

  it('refuse the commands of a device, saying why, with exit code 2', async () => {
    process.env.ORIGIN_HOME = path.join(tmp, 'home');
    process.env.ORIGIN_DATABASE_URL = URL;
    const refused = [
      ['sync'],
      ['push'],
      ['hub', 'status'],
      ['hub', 'connect', 'https://hub.example.com'],
      ['mcp'],
      ['ui'],
      ['sessions', 'reproject'],
      ['sessions', 'parents'],
      ['agents', 'connect', 'claude-code'],
    ];
    for (const argv of refused) {
      err = [];
      expect(await main(argv), argv.join(' ')).toBe(2);
      expect(err.join('\n')).toMatch(
        new RegExp(`^origin ${argv[0]}( ${argv[1]})?? does not run where ORIGIN_DATABASE_URL`),
      );
      expect(err.join('\n')).not.toContain('secret');
    }
    expect(fs.existsSync(path.join(tmp, 'home'))).toBe(false);
    // Asking for help still answers.
    expect(await main(['sync', '--help'])).toBe(0);
  });

  it('let agents hooks exit 0 with one line on standard error, and open nothing', async () => {
    const projects = path.join(tmp, 'projects');
    fs.cpSync(fixtures, projects, { recursive: true });
    const transcript = path.join(
      projects,
      'D--demo-project',
      '0f1e2d3c-4b5a-4697-8877-665544332211.jsonl',
    );
    process.env.ORIGIN_HOME = path.join(tmp, 'home');
    process.env.ORIGIN_CLAUDE_PROJECTS = projects;
    process.env.ORIGIN_DATABASE_URL = URL;
    const stdin = (event: unknown) => ({ stdin: () => JSON.stringify(event), env: {} });
    expect(
      await syncHook(
        ['sync', '--hook', 'claude-code'],
        stdin({ transcript_path: transcript, hook_event_name: 'Stop' }),
      ),
    ).toBe(0);
    expect(
      await recall(
        ['recall', '--hook', 'claude-code'],
        stdin({ hook_event_name: 'SessionStart', session_id: 's', cwd: tmp, source: 'startup' }),
      ),
    ).toBe(0);
    expect(out).toEqual([]);
    expect(err).toHaveLength(2);
    expect(err[0]).toMatch(/^origin sync: ORIGIN_DATABASE_URL names a hub's store/);
    expect(err[1]).toMatch(/^origin recall: ORIGIN_DATABASE_URL names a hub's store/);
    expect(fs.existsSync(path.join(tmp, 'home'))).toBe(false);
  });

  it('refuse to open a store in SQLite where store.json says the store is in PostgreSQL', async () => {
    const home = path.join(tmp, 'home');
    writePairing(home, { id: 'a-store', engine: 'postgres' });
    process.env.ORIGIN_HOME = home;
    expect(await main(['status'])).toBe(1);
    expect(err.join('\n')).toMatch(
      /store of ORIGIN_HOME .* is in PostgreSQL \(store a-store, .*store\.json\): set ORIGIN_DATABASE_URL/,
    );
    expect(fs.existsSync(dbPath(home))).toBe(false);
  });
});

describe.skipIf(!onPostgres)('a hub on PostgreSQL', () => {
  it('pairs its database with ORIGIN_HOME in store.json, and refuses what does not belong', async () => {
    const home = path.join(tmp, 'hub');
    const db = openHub(home, 'paired');
    const pairing = readPairing(home);
    const [row] = await outside('SELECT store_id FROM paired.store_format');
    expect(pairing).toEqual({ id: row?.store_id, engine: 'postgres' });
    expect(storeName(db)).toBe('hub');
    db.close();

    // Opened again from the same ORIGIN_HOME: the same store.
    openHub(home, 'paired').close();
    // Another ORIGIN_HOME with no mirrors may take a store that has none either.
    openHub(path.join(tmp, 'empty'), 'paired').close();
    expect(readPairing(path.join(tmp, 'empty'))).toEqual(pairing);

    // Once the store has mirrors, an ORIGIN_HOME without store.json is refused.
    const device = await syncedDevice();
    const hubDb = openHub(home, 'paired');
    const token = createToken(hubDb, 'laptop');
    const hub = await startHub({
      db: hubDb,
      home,
      host: '127.0.0.1',
      port: 0,
      adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
      version: 'test',
    });
    try {
      const r = await syncWithHub({
        db: device.db,
        home: device.home,
        hub: { url: hub.url, token, device: 'laptop' },
      });
      expect(r).toMatchObject({ files: 1, eventsAdded: 6 });
    } finally {
      await hub.close();
    }
    expect(() => openHub(path.join(tmp, 'other'), 'paired')).toThrow(
      /is not paired with ORIGIN_HOME .*other, which has no store\.json/,
    );
    // An ORIGIN_HOME that belongs to another store, which is not in this schema.
    expect(() => openHub(home, 'elsewhere')).toThrow(
      /belongs to store .*, which is not at .*schema=elsewhere/,
    );
    writePairing(path.join(tmp, 'wrong'), { id: 'another', engine: 'postgres' });
    expect(() => openHub(path.join(tmp, 'wrong'), 'paired')).toThrow(
      /holds store .*, but ORIGIN_HOME .*wrong belongs to store another/,
    );
    // An ORIGIN_HOME that holds a store in SQLite.
    const local = openDatabase(path.join(tmp, 'local', 'origin.db'));
    local.close();
    expect(() => openHub(path.join(tmp, 'local'), 'fresh')).toThrow(
      /holds a store in SQLite \(origin\.db\).*origin db move --to <postgres-url>/,
    );
    // Without the URL, the store's ORIGIN_HOME refuses to open a new store in SQLite.
    expect(() => openStore(home, {}, { command: 'status' })).toThrow(/is in PostgreSQL/);
    expect(fs.existsSync(dbPath(home))).toBe(false);
    // A store moved away is not opened.
    await outside("UPDATE paired.store_format SET moved_to = '/data/origin.db'");
    expect(() => openHub(home, 'paired')).toThrow(/has been moved to \/data\/origin\.db/);
  });

  it('runs one origin serve at a time on a store, and takes its lock again after a lost connection', async () => {
    const home = path.join(tmp, 'hub');
    const first = openHub(home, 'served');
    const second = openHub(home, 'served');
    holdServeLock(first);
    expect(() => holdServeLock(second)).toThrow(/Another origin serve is running on the store at/);
    expect(() => holdServeLock(second)).not.toThrow(/secret|password/);

    // The first loses its connection; the second takes the lock meanwhile, so the first may no
    // longer use the store.
    await terminateLater(backend(first), 0);
    holdServeLock(second);
    expect(() => first.prepare('SELECT 1 AS one').get()).toThrow(/Another origin serve/);
    second.close();
    expect(first.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
  });

  it('serves a device synced into it over /mcp, and purges through the admin API', async () => {
    const home = path.join(tmp, 'hub');
    process.env.ORIGIN_HOME = home;
    process.env.ORIGIN_DATABASE_URL = storeUrl('served');
    const db = openHub(home, 'served');
    await setAdminPassword(db, PASSWORD, { params: FAST });
    let hub: RunningHub | null = null;
    try {
      holdServeLock(db);
      hub = await startHub({
        db,
        home,
        host: '127.0.0.1',
        port: 0,
        adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
        version: 'test',
        admin: { passwordParams: FAST },
      });
      const token = createToken(db, 'laptop');
      const device = await syncedDevice();
      const r = await syncWithHub({
        db: device.db,
        home: device.home,
        hub: { url: hub.url, token, device: 'laptop' },
      });
      expect(r).toMatchObject({ files: 1, eventsAdded: 6 });
      expect(getEvent(db, USER_EVENT)?.text).toBe('帮我检查一下仓库的状态');

      const client = new Client({ name: 'cloud-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', hub.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const found = (await client.callTool({
        name: 'search',
        arguments: { query: '仓库' },
      })) as { content: Array<{ text: string }> };
      const events = JSON.parse(found.content[0]?.text ?? '{}').events as Array<{ id: string }>;
      expect(events.map((e) => e.id)).toEqual([USER_EVENT]);
      await client.close();

      // The overview: the database's size and where it is, without its password, and no WAL row.
      const b = new Browser(hub.url);
      await b.login(PASSWORD);
      const page = await b.get('/admin/');
      expect(page.text).toContain('schema=served');
      expect(page.text).not.toContain('Write-ahead log');
      const password = new URL(urls().database).password;
      if (password) expect(page.text).not.toContain(password);

      const event = getEvent(db, USER_EVENT);
      const plan = (
        await b.api(
          'GET',
          `purge-plan?session=${encodeURIComponent(`claude-code:${event?.sessionId}`)}`,
        )
      ).json();
      expect(plan.counts).toMatchObject({ events: 6, sessions: 1 });
      const done = await b.api('POST', 'purge', {
        selector: plan.selector,
        digest: plan.digest,
        reason: 'test data',
      });
      expect(done.status).toBe(200);
      expect(getEvent(db, USER_EVENT)).toBeNull();
      const purges = (await b.api('GET', 'purges')).json();
      expect(purges.purges.map((p: { id: string }) => p.id)).toEqual([done.json().id]);

      // origin status on the hub's host names the database, without its password.
      expect(await main(['status'])).toBe(0);
      expect(out.join('\n')).toMatch(/Database: postgres(ql)?:\/\/.*schema=served/);
      if (password) expect(out.join('\n')).not.toContain(password);
    } finally {
      await hub?.close();
    }
  });
});

/** A device's store in SQLite, with the Claude Code fixture synced into it. */
async function syncedDevice(): Promise<{ db: Database; home: string }> {
  const home = path.join(tmp, `device-${opened.length}`);
  const db = openDatabase(dbPath(home));
  opened.push(db);
  initStoreName(db, 'laptop');
  await syncSource({ db, home }, createClaudeCodeAdapter({ projectsDir: fixtures }));
  return { db, home };
}
