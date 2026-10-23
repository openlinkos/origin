import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  type Database,
  getSetting,
  isRelay,
  listEvents,
  makeRelay,
  openDatabase,
  type RelayAnswer,
  type RelayChunk,
  type RelayHub,
  relayCursor,
  relayPending,
  relaySource,
  remoteCursors,
  type SourceAdapter,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

let tmp: string;
let src: string;
let home: string;
let db: Database;
let hubHome: string;
let hubDb: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-relay-'));
  src = path.join(tmp, 'logs');
  fs.mkdirSync(src);
  home = path.join(tmp, 'relay');
  db = openDatabase(path.join(home, 'origin.db'));
  hubHome = path.join(tmp, 'hub');
  hubDb = openDatabase(path.join(hubHome, 'origin.db'));
});

afterEach(() => {
  db.close();
  hubDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const count = (d: Database, table: string) =>
  (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * A hub for a relay named `laptop`: chunks go through appendRemote into `hubDb`, as the hub's
 * /v1/ingest does, and `holds` reads the hub's cursors as /v1/cursors does.
 */
function testHub(adapter: SourceAdapter, store = () => hubDb, storeHome = hubHome) {
  const state = {
    offline: false,
    refuse: null as string | null,
    sent: [] as RelayChunk[],
    /** Cursors as the hub reported them when a sync started (null: as they are now). */
    snapshot: null as Map<string, Map<number, number>> | null,
  };
  const cursors = () => {
    const held = new Map<string, Map<number, number>>();
    for (const c of remoteCursors(store(), 'laptop')) {
      const key = `${c.source}\n${c.path}`;
      held.set(key, (held.get(key) ?? new Map()).set(c.generation, c.bytes));
    }
    return held;
  };
  const hub: RelayHub = {
    holds: (source, p) => (state.snapshot ?? cursors()).get(`${source}\n${p}`) ?? new Map(),
    async send(chunk): Promise<RelayAnswer> {
      if (state.offline) throw new Error('connect ECONNREFUSED');
      if (state.refuse) return { status: 'refused', reason: state.refuse };
      state.sent.push(chunk);
      const r = appendRemote({ db: store(), home: storeHome }, adapter, {
        device: 'laptop',
        ...chunk,
      });
      return r.ok ? { status: 'accepted', ...r } : { status: 'conflict', bytes: r.bytes };
    },
  };
  return { hub, state, cursors };
}

const relay = (adapter: SourceAdapter, hub: RelayHub) => relaySource({ db }, adapter, hub);
const hubTexts = () => listEvents(hubDb, {}).map((e) => e.text);

describe('relay mode', () => {
  it('sends the complete lines of each log straight from it, and keeps only a cursor', async () => {
    const file = path.join(src, 's1.jsonl');
    const first =
      line('e1', 's1', 1000, 'user', 'first') + line('e2', 's1', 2000, 'user', 'second');
    fs.writeFileSync(file, `${first}{"id":"e3","sess`);
    const adapter = fakeAdapter(src);
    const { hub, state } = testHub(adapter);
    makeRelay(db);

    expect(await relay(adapter, hub)).toMatchObject({
      filesSeen: 1,
      filesChanged: 1,
      eventsAdded: 2,
      bytes: Buffer.byteLength(first),
      failed: [],
    });
    expect(hubTexts().sort()).toEqual(['first', 'second']);
    expect(listEvents(hubDb, {}).map((e) => e.id)).toContain('fake:e1');
    // Nothing is kept here but the cursor: no events, no mirrored files, no raw directory.
    expect([count(db, 'event'), count(db, 'raw_file')]).toEqual([0, 0]);
    expect(fs.existsSync(path.join(home, 'raw'))).toBe(false);
    expect(relayCursor(db, 'fake', file)).toMatchObject({
      generation: 1,
      bytes: Buffer.byteLength(first),
    });

    // Again: nothing to send. Then the partial line completes and goes.
    expect(await relay(adapter, hub)).toMatchObject({ bytes: 0, filesChanged: 0 });
    expect(state.sent).toHaveLength(1);
    fs.appendFileSync(file, 'ion":"s1","ts":3000,"role":"user","text":"third"}\n');
    expect(await relay(adapter, hub)).toMatchObject({ eventsAdded: 1, filesChanged: 1 });
    expect(mirrorText(hubDb, hubHome, 1)).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('moves no cursor while the hub cannot be reached or refuses a file', async () => {
    const file = path.join(src, 's1.jsonl');
    fs.writeFileSync(file, line('e1', 's1', 1000, 'user', 'kept in the log'));
    const adapter = fakeAdapter(src);
    const { hub, state } = testHub(adapter);
    makeRelay(db);

    state.offline = true;
    await expect(relay(adapter, hub)).rejects.toThrow(/ECONNREFUSED/);
    expect(relayCursor(db, 'fake', file)).toBeNull();
    state.offline = false;
    state.refuse = 'the hub refused it (413): Request body too large.';
    const refused = await relay(adapter, hub);
    expect(refused.failed).toEqual([{ path: file, reason: state.refuse }]);
    expect(relayCursor(db, 'fake', file)).toBeNull();
    expect(hubTexts()).toEqual([]);

    state.refuse = null;
    expect(await relay(adapter, hub)).toMatchObject({ eventsAdded: 1, failed: [] });
    expect(hubTexts()).toEqual(['kept in the log']);
  });

  it('opens a new generation from the start when a log is rewritten', async () => {
    const file = path.join(src, 's1.jsonl');
    fs.writeFileSync(
      file,
      line('e1', 's1', 1000, 'user', 'old one') + line('e2', 's1', 2000, 'user', 'old two'),
    );
    const adapter = fakeAdapter(src);
    const { hub } = testHub(adapter);
    makeRelay(db);
    await relay(adapter, hub);

    fs.writeFileSync(file, line('e9', 's1', 3000, 'user', 'rewritten'));
    expect(await relay(adapter, hub)).toMatchObject({ newGenerations: 1, eventsAdded: 1 });
    expect(relayCursor(db, 'fake', file)).toMatchObject({ generation: 2 });
    // The hub keeps the old generation, and its events.
    expect(remoteCursors(hubDb, 'laptop').map((c) => c.generation)).toEqual([1, 2]);
    expect(hubTexts().sort()).toEqual(['old one', 'old two', 'rewritten']);
    expect(await relay(adapter, hub)).toMatchObject({ newGenerations: 0, bytes: 0 });
  });

  it('sends a compressed log as its content, once', async () => {
    const content =
      line('z1', 'sz', 1000, 'user', 'compressed one') + line('z2', 'sz', 2000, 'user', 'two');
    const file = path.join(src, 'sz.jsonl.zst');
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(content)));
    const base = fakeAdapter(src);
    const adapter: SourceAdapter = {
      ...base,
      async discover() {
        return [{ absPath: file, relPath: 'sz.jsonl.zst', compression: 'zstd' }];
      },
    };
    const { hub, state } = testHub(adapter);
    makeRelay(db);
    expect(await relay(adapter, hub)).toMatchObject({
      eventsAdded: 2,
      bytes: Buffer.byteLength(content),
    });
    expect(mirrorText(hubDb, hubHome, 1)).toBe(content);
    expect(relayCursor(db, 'fake', file)).toMatchObject({ done: true });
    expect(await relay(adapter, hub)).toMatchObject({ bytes: 0 });
    expect(state.sent).toHaveLength(1);
  });

  it('goes on with a generated source from the last line the hub acknowledged', async () => {
    const rows: string[] = [];
    const source = { token: 't0', calls: [] as Array<string | null> };
    const adapter: SourceAdapter = {
      ...fakeAdapter(src),
      async discover() {
        return [
          {
            absPath: '/data/agent.db#s1',
            relPath: 'sessions/s1.jsonl',
            generated: {
              token: source.token,
              mtimeMs: 1000,
              next(last, maxBytes) {
                source.calls.push(last);
                const from = last === null ? 0 : rows.indexOf(last) + 1;
                const out: string[] = [];
                let bytes = 0;
                for (const row of rows.slice(from)) {
                  if (out.length > 0 && bytes + row.length > maxBytes) break;
                  out.push(row);
                  bytes += row.length + 1;
                }
                return out;
              },
            },
          },
        ];
      },
    };
    const add = (id: string, text: string) =>
      rows.push(line(id, 's1', 1000, 'user', text).trimEnd());
    const { hub } = testHub(adapter);
    makeRelay(db);
    add('1', 'first row');
    add('2', 'second row');

    expect(await relay(adapter, hub)).toMatchObject({ eventsAdded: 2 });
    expect(source.calls[0]).toBeNull();
    // The last line sent is kept with the cursor, and the token once nothing is left.
    expect(relayCursor(db, 'fake', '/data/agent.db#s1')).toMatchObject({
      last: rows[1],
      tail: 't0',
    });
    const asked = source.calls.length;
    expect(await relay(adapter, hub)).toMatchObject({ bytes: 0 });
    expect(source.calls).toHaveLength(asked); // same token: not asked

    add('3', 'third row');
    source.token = 't1';
    expect(await relay(adapter, hub)).toMatchObject({ eventsAdded: 1 });
    expect(source.calls[asked]).toBe(rows[1]);
    expect(mirrorText(hubDb, hubHome, 1)).toBe(`${rows.join('\n')}\n`);
    expect(count(db, 'event')).toBe(0);
  });

  it('goes on while another process sends the same log, however often it is first', async () => {
    const file = path.join(src, 's1.jsonl');
    const lines = Array.from({ length: 8 }, (_, i) =>
      line(`e${i}`, 's1', 1000 + i, 'user', `n${i}`),
    );
    fs.writeFileSync(file, lines.join(''));
    const adapter = fakeAdapter(src);
    const { hub } = testHub(adapter);
    // Each of the first five chunks is taken by the hub, and reported as sent by another process.
    let raced = 0;
    const racing: RelayHub = {
      holds: hub.holds,
      async send(chunk) {
        const answer = await hub.send(chunk);
        if (answer.status !== 'accepted' || raced >= 5) return answer;
        raced++;
        return { status: 'conflict', bytes: chunk.offset + chunk.data.length };
      },
    };
    makeRelay(db);
    expect(await relaySource({ db, chunkBytes: 1 }, adapter, racing)).toMatchObject({ failed: [] });
    expect(raced).toBe(5);
    expect(mirrorText(hubDb, hubHome, 1)).toBe(lines.join(''));
  });

  it('goes on from where the hub stands', async () => {
    const file = path.join(src, 's1.jsonl');
    const one = line('e1', 's1', 1000, 'user', 'one');
    const two = line('e2', 's1', 2000, 'user', 'two');
    const three = line('e3', 's1', 3000, 'user', 'three');
    fs.writeFileSync(file, one);
    const adapter = fakeAdapter(src);
    const { hub, state, cursors } = testHub(adapter);
    makeRelay(db);
    await relay(adapter, hub);

    // Another process sends the next line after this sync has read the hub's cursors: the chunk is
    // rejected for its offset, and the relay goes on from the hub's cursor.
    fs.appendFileSync(file, two);
    state.snapshot = cursors();
    appendRemote({ db: hubDb, home: hubHome }, adapter, {
      device: 'laptop',
      source: 'fake',
      path: file,
      relPath: 's1.jsonl',
      generation: 1,
      offset: Buffer.byteLength(one),
      data: Buffer.from(two),
    });
    fs.appendFileSync(file, three);
    expect(await relay(adapter, hub)).toMatchObject({ eventsAdded: 1, failed: [] });
    state.snapshot = null;
    expect(mirrorText(hubDb, hubHome, 1)).toBe(one + two + three);

    // A hub that lost what it had (say, restored from an older backup) receives it again.
    const restoredHome = path.join(tmp, 'restored');
    const restored = openDatabase(path.join(restoredHome, 'origin.db'));
    try {
      const fresh = testHub(adapter, () => restored, restoredHome);
      expect(await relay(adapter, fresh.hub)).toMatchObject({ eventsAdded: 3 });
      expect(listEvents(restored, {}).map((e) => e.text)).toEqual(['one', 'two', 'three']);
    } finally {
      restored.close();
    }
  });

  it('picks up where an earlier store of the same device left off on the hub', async () => {
    const file = path.join(src, 's1.jsonl');
    fs.writeFileSync(file, line('e1', 's1', 1000, 'user', 'one'));
    const adapter = fakeAdapter(src);
    const { hub, state } = testHub(adapter);
    makeRelay(db);
    await relay(adapter, hub);

    // A new relay store under the same name, with no cursors yet.
    const again = openDatabase(path.join(tmp, 'again', 'origin.db'));
    try {
      makeRelay(again);
      fs.appendFileSync(file, line('e2', 's1', 2000, 'user', 'two'));
      const r = await relaySource({ db: again }, adapter, hub);
      expect(r).toMatchObject({ eventsAdded: 1, failed: [] });
      expect(state.sent.map((c) => c.offset)).toEqual([
        0,
        Buffer.byteLength(line('e1', 's1', 1000, 'user', 'one')),
      ]);
      expect(hubTexts()).toEqual(['one', 'two']);
    } finally {
      again.close();
    }
  });

  it('tells what is still to send, without the hub', async () => {
    const file = path.join(src, 's1.jsonl');
    const first = line('e1', 's1', 1000, 'user', 'first');
    fs.writeFileSync(file, first);
    const adapter = fakeAdapter(src);
    const { hub } = testHub(adapter);
    makeRelay(db);
    expect(await relayPending(db, adapter)).toEqual({
      source: 'fake',
      files: 1,
      pendingFiles: 1,
      pendingBytes: Buffer.byteLength(first),
    });
    await relay(adapter, hub);
    expect(await relayPending(db, adapter)).toMatchObject({ pendingFiles: 0, pendingBytes: 0 });
    fs.appendFileSync(file, 'partial');
    expect(await relayPending(db, adapter)).toMatchObject({ pendingFiles: 1, pendingBytes: 7 });
  });

  it('becomes a relay only while it holds nothing, and a relay mirrors nothing', async () => {
    fs.writeFileSync(path.join(src, 's1.jsonl'), line('e1', 's1', 1000, 'user', 'local'));
    const adapter = fakeAdapter(src);
    const { hub } = testHub(adapter);
    await expect(relay(adapter, hub)).rejects.toThrow(/not a relay/);

    const full = openDatabase(path.join(tmp, 'full', 'origin.db'));
    try {
      await syncSource({ db: full, home: path.join(tmp, 'full') }, adapter);
      expect(() => makeRelay(full)).toThrow(
        /already holds 1 event, 1 mirrored file, and a relay keeps none.*nothing was changed/,
      );
      expect(isRelay(full)).toBe(false);
      expect(count(full, 'event')).toBe(1);
    } finally {
      full.close();
    }

    makeRelay(db);
    expect(getSetting(db, 'store.mode')).toBe('relay');
    await expect(syncSource({ db, home }, adapter)).rejects.toThrow(/This store is a relay/);
    expect(count(db, 'raw_file')).toBe(0);
  });
});
