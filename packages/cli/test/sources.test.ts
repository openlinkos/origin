import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createClaudeCodeAdapter, createLinesAdapter } from '@openlinkos/origin-adapters';
import {
  createToken,
  type Database,
  dbPath,
  getEvent,
  getSession,
  initStoreName,
  listEvents,
  makeRelay,
  openDatabase,
  rawLocator,
  remoteCursors,
  syncFile,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubConfig } from '../src/hub/config.js';
import { relayWithHub } from '../src/hub/relay.js';
import { createHubServer } from '../src/hub/server.js';
import { syncWithHub } from '../src/hub/sync.js';
import { main } from '../src/main.js';
import { main as recall } from '../src/recall.js';
import { hubAdapters, sourceAdapter, sourceAdapters } from '../src/sources.js';

/** Synthetic event lines: a person's notes pipeline and a chat bot, never real logs. */
const HOUR = 3_600_000;
const T0 = Date.now() - 5 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

let tmp: string;
let home: string;
let work: string;
let out: string[];
let err: string[];
let saved: Record<string, string | undefined>;

/** The working directory the lines name, whose last segment is their project. */
const CWD = () => path.join(work, 'demo-app');

function eventLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    role: 'user',
    kind: 'message',
    cwd: CWD(),
    branch: 'retry-fix',
    ...fields,
  });
}

/** Two sessions on one work branch, a turn each, and a note that is not an event. */
function notesLines(): string[] {
  return [
    eventLine({
      id: 'a1',
      session: 'retry-1',
      time: iso(T0),
      text: 'Add exponential backoff to the upload client',
      title: 'Upload retries',
      title_by: 'user',
    }),
    eventLine({
      id: 'a2',
      session: 'retry-1',
      time: iso(T0 + 60_000),
      role: 'assistant',
      text: 'Backoff added: 3 tries, doubling from 200 ms.',
      parent: 'a1',
    }),
    eventLine({
      id: 'b1',
      session: 'retry-2',
      time: T0 + 2 * HOUR,
      text: 'Make the retry count configurable',
    }),
    eventLine({
      id: 'b2',
      session: 'retry-2',
      time: T0 + 2 * HOUR + 60_000,
      role: 'assistant',
      text: 'It is an option now, retries: 3 by default.',
    }),
    '{"id":"c1","session":"retry-2","note":"not an event"}',
  ];
}

function writeSource(name: string, rel: string, lines: string[]): string {
  const file = path.join(home, 'sources', name, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sources-'));
  home = path.join(tmp, 'home');
  work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(work, 'demo-app'), { recursive: true });
  saved = { ORIGIN_HOME: process.env.ORIGIN_HOME, ORIGIN_DEVICE: process.env.ORIGIN_DEVICE };
  process.env.ORIGIN_HOME = home;
  process.env.ORIGIN_DEVICE = 'laptop';
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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run a command and return what it printed, clearing the capture. */
async function run(args: string[], command = main): Promise<{ code: number; out: string }> {
  out.length = 0;
  const code = await command(args);
  return { code, out: out.join('\n') };
}

describe('your own sources on a device', () => {
  it('syncs a directory of event lines into sessions that every command reads', async () => {
    writeSource('notes', '2026/11/02.jsonl', notesLines());
    // Only this source: the built-in adapters would read this machine's own agents.
    const sync = await run(['sync', '--local', '--source', 'notes']);
    expect(sync.code).toBe(0);
    expect(sync.out).toMatch(/notes\s+1\s+1\s+5\s+4\s+1\s+0/);

    const db = openDatabase(dbPath(home));
    const thread = getSession(db, 'notes', 'retry-1')?.thread;
    expect(getSession(db, 'notes', 'retry-1')).toMatchObject({
      title: 'Upload retries',
      project: 'demo-app',
      cwd: CWD(),
      eventCount: 2,
    });
    // Two sessions of the project on one work branch make a thread, as for any agent.
    expect(thread).toMatch(/^thr_[0-9a-f]{12}$/);
    expect(getSession(db, 'notes', 'retry-2')?.thread).toBe(thread);
    db.close();

    const status = await run(['status']);
    expect(status.out).toMatch(/notes\s+1\s+2\s+1\s+4/);

    const timeline = await run(['timeline', '--source', 'notes']);
    expect(timeline.out).toContain('Upload retries');
    expect(timeline.out).toContain('“Make the retry count configurable”');
    expect(timeline.out).toContain(`retry-1  thread ${thread}`);

    const search = await run(['search', 'backoff', '--source', 'notes']);
    expect(search.out).toContain('notes:a2');

    const show = await run(['show', 'retry-1']);
    expect(show.out).toContain('Session     retry-1  notes, project demo-app');
    expect(show.out).toContain(`Thread      ${thread}, 2 sessions`);
    expect(show.out).toContain('notes:a1');

    const event = await run(['show', 'notes:a2']);
    expect(event.out).toContain('Backoff added: 3 tries, doubling from 200 ms.');

    // What an agent starting there is handed: the project's latest work, of any source.
    const brief = await run(['recall', '--cwd', CWD()], recall);
    expect(brief.code).toBe(0);
    expect(brief.out).toContain('Latest sessions in demo-app, any agent');
    expect(brief.out).toContain(thread as string);
  });

  it('ignores directories that name no source, warning once each', async () => {
    writeSource('notes', 'a.jsonl', notesLines().slice(0, 2));
    for (const name of ['Bad_Name', 'codex', 'devices', '.hidden']) {
      fs.mkdirSync(path.join(home, 'sources', name), { recursive: true });
    }
    fs.writeFileSync(path.join(home, 'sources', 'README.md'), 'my sources');
    expect((await run(['sync', '--local', '--source', 'notes'])).code).toBe(0);
    const warnings = err.filter((e) => e.startsWith('Ignored '));
    expect(warnings).toHaveLength(3);
    for (const name of ['Bad_Name', 'codex', 'devices']) {
      expect(warnings.some((w) => w.includes(path.join(home, 'sources', name)))).toBe(true);
    }
    expect(warnings[0]).toContain('2 to 32 lowercase letters, digits, and hyphens');
    expect(sourceAdapters(home).map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'grok',
      'zcode',
      'cursor',
      'notes',
    ]);

    // A source is chosen by its name; one that names no source is not there.
    expect((await run(['sync', '--local', '--source', 'Bad_Name'])).code).toBe(2);
    expect(err.at(-1)).toMatch(/^No source Bad_Name \(sources: claude-code, .*, notes\)/);
  });

  it('ingests one file through its adapter, as a hook would', async () => {
    const file = writeSource('notes', 'inbox.jsonl', notesLines().slice(0, 1));
    const adapter = sourceAdapter(home, 'notes');
    expect(adapter?.locate?.(file)).toEqual({ absPath: file, relPath: 'inbox.jsonl' });
    const db = openDatabase(dbPath(home));
    try {
      expect(await syncFile({ db, home }, adapter as never, file)).toMatchObject({
        filesSeen: 1,
        eventsAdded: 1,
      });
      fs.appendFileSync(file, `${notesLines()[1]}\n`);
      expect(await syncFile({ db, home }, adapter as never, file)).toMatchObject({
        linesRead: 1,
        eventsAdded: 1,
      });
      expect(listEvents(db, { source: 'notes' }).map((e) => e.id)).toEqual([
        'notes:a1',
        'notes:a2',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('your own sources on a hub', () => {
  let hubHome: string;
  let hubDb: Database;
  let server: http.Server;
  let url: string;
  let laptopToken: string;

  beforeEach(async () => {
    hubHome = path.join(tmp, 'hub');
    hubDb = openDatabase(path.join(hubHome, 'origin.db'));
    laptopToken = createToken(hubDb, 'laptop');
    server = createHubServer({
      db: hubDb,
      home: hubHome,
      adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
      version: 'test',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    hubDb.close();
  });

  const lines = (n: number) =>
    notesLines()
      .slice(0, n)
      .map((l) => `${l}\n`)
      .join('');

  it('parses the sources/ mirrors a device pushes', async () => {
    const deviceHome = path.join(tmp, 'device');
    const deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
    try {
      initStoreName(deviceDb, 'laptop');
      const dir = path.join(deviceHome, 'sources', 'notes');
      fs.mkdirSync(path.join(dir, '2026', '11'), { recursive: true });
      fs.writeFileSync(path.join(dir, '2026', '11', '02.jsonl'), lines(4));
      await syncSource(
        { db: deviceDb, home: deviceHome },
        createLinesAdapter({ id: 'notes', dir }),
      );
      const hub: HubConfig = { url, token: laptopToken, device: 'laptop' };
      const r = await syncWithHub({ db: deviceDb, home: deviceHome, hub });
      expect(r).toMatchObject({ files: 1, eventsAdded: 4, refused: [] });

      // The same events on the hub, read from its own mirror of the device's file.
      expect(listEvents(hubDb, { source: 'notes' }).map((e) => e.id)).toEqual(
        listEvents(deviceDb, { source: 'notes' }).map((e) => e.id),
      );
      const ev = getEvent(hubDb, 'notes:b2');
      expect(rawLocator(hubDb, hubHome, ev as NonNullable<typeof ev>)).toMatchObject({
        device: 'laptop',
        mirrorPath: path.join(
          hubHome,
          'raw',
          'devices',
          'laptop',
          'notes',
          '2026',
          '11',
          '02.jsonl',
        ),
      });
      expect(getSession(hubDb, 'notes', 'retry-1')?.thread).toBe(
        getSession(deviceDb, 'notes', 'retry-1')?.thread,
      );
    } finally {
      deviceDb.close();
    }
  });

  it('leaves a source a hub does not know for later, and still syncs the rest', async () => {
    const deviceHome = path.join(tmp, 'device');
    const deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
    try {
      initStoreName(deviceDb, 'laptop');
      const dir = path.join(deviceHome, 'sources', 'notes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.jsonl'), lines(2));
      await syncSource(
        { db: deviceDb, home: deviceHome },
        createLinesAdapter({ id: 'notes', dir }),
      );
      // A hub of an earlier version knows only its built-in sources.
      const old: typeof fetch = async (input, init) => {
        if (String(input).endsWith('/v1/ingest')) {
          const body = JSON.parse(zlib.gunzipSync(init?.body as Buffer).toString('utf8'));
          if (body.source === 'notes') {
            return new Response(JSON.stringify({ error: 'Unknown source: notes' }), {
              status: 400,
            });
          }
        }
        return fetch(input, init);
      };
      const hub: HubConfig = { url, token: laptopToken, device: 'laptop' };
      const r = await syncWithHub({ db: deviceDb, home: deviceHome, hub, fetch: old });
      expect(r).toMatchObject({
        files: 0,
        refused: [
          { source: 'notes', path: path.join(dir, 'a.jsonl'), reason: 'Unknown source: notes' },
        ],
        recallsPushed: 0,
      });
      // Once the hub knows it, the next sync sends it.
      expect(await syncWithHub({ db: deviceDb, home: deviceHome, hub })).toMatchObject({
        files: 1,
        eventsAdded: 2,
        refused: [],
      });
    } finally {
      deviceDb.close();
    }
  });

  it('receives the lines of a sources/ directory from a relay', async () => {
    const relayHome = path.join(tmp, 'relay');
    const relayDb = openDatabase(path.join(relayHome, 'origin.db'));
    try {
      initStoreName(relayDb, 'laptop');
      makeRelay(relayDb);
      const file = path.join(relayHome, 'sources', 'notes', 'a.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines(2));
      const hub: HubConfig = { url, token: laptopToken, device: 'laptop' };
      const adapters = sourceAdapters(relayHome).filter((a) => a.id === 'notes');
      const r = await relayWithHub({ db: relayDb, home: relayHome, hub, adapters });
      expect(r).toMatchObject({ files: 1, eventsAdded: 2, failed: [] });
      expect(remoteCursors(hubDb, 'laptop')).toEqual([
        { source: 'notes', path: file, generation: 1, bytes: Buffer.byteLength(lines(2)) },
      ]);
      expect(getEvent(hubDb, 'notes:a2')).toMatchObject({ parentId: 'a1' });
      // The relay keeps no copy.
      expect(fs.existsSync(path.join(relayHome, 'raw'))).toBe(false);
    } finally {
      relayDb.close();
    }
  });

  it('finds a lines adapter for any name of one’s own, and none for other names', () => {
    const built = createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') });
    const adapterFor = hubAdapters([built], hubHome);
    expect(adapterFor('claude-code')).toBe(built);
    expect(adapterFor('notes')?.id).toBe('notes');
    expect(adapterFor('notes')).toBe(adapterFor('notes'));
    for (const name of ['codex', 'Notes', 'devices', '']) expect(adapterFor(name), name).toBeNull();
  });
});
