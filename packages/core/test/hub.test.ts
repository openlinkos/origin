import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppendResult,
  appendRemote,
  applyTombstone,
  createToken,
  type Database,
  forget,
  getEvent,
  getSetting,
  IDLE_SEAL_MS,
  initStoreName,
  listDevices,
  listEvents,
  listSessions,
  listTokens,
  localRawFiles,
  OriginError,
  openDatabase,
  type ParseContext,
  parseTombstoneRecord,
  type RemoteChunk,
  rawLocator,
  readRawLine,
  remember,
  remoteCursors,
  revokeToken,
  sealIdleMirrors,
  setSetting,
  syncSource,
  tombstoneCount,
  tombstoneFeed,
  verifyToken,
} from '../src/index.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

let dirs: string[];
let home: string;
let db: Database;

const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  dirs = [];
  home = tmp('origin-hub-');
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The fake adapter, recording the parse context of every line. */
function spyAdapter() {
  const adapter = fakeAdapter(tmp('origin-src-'));
  const seen: ParseContext[] = [];
  return {
    seen,
    adapter: {
      ...adapter,
      parseLine: (l: string, ctx: ParseContext) => {
        seen.push(ctx);
        return adapter.parseLine(l, ctx);
      },
    },
  };
}

const chunk = (over: Partial<RemoteChunk> & { text?: string }): RemoteChunk => {
  const { text, ...rest } = over;
  return {
    device: 'laptop',
    source: 'fake',
    path: '/home/me/.fake/proj/s1.jsonl',
    relPath: 'proj/s1.jsonl',
    generation: 1,
    offset: 0,
    data: Buffer.from(text ?? ''),
    ...rest,
  };
};

const two =
  line('e1', 's1', 1000, 'user', 'first message') +
  line('e2', 's1', 2000, 'assistant', 'second message');

describe('appendRemote', () => {
  it("appends a device's chunk to its own mirror and parses it with the same adapter", () => {
    const { adapter, seen } = spyAdapter();
    const r = appendRemote(
      { db, home },
      adapter,
      chunk({ text: two, mtimeMs: 42, agentVersion: '9.9.9' }),
    );
    expect(r).toEqual({
      ok: true,
      bytes: Buffer.byteLength(two),
      linesRead: 2,
      eventsAdded: 2,
      parseErrors: 0,
    });

    const mirror = path.join(home, 'raw', 'devices', 'laptop', 'fake', 'proj', 's1.jsonl');
    const id = getEvent(db, 'fake:e1')!.rawFileId;
    expect(mirrorText(db, home, id)).toBe(two);
    expect(fs.readFileSync(`${mirror}.tail`, 'utf8')).toBe(two); // smaller than a frame
    expect(seen.map((c) => [c.absPath, c.relPath, c.lineNo, c.fileMtimeMs])).toEqual([
      [mirror, 'proj/s1.jsonl', 1, 42],
      [mirror, 'proj/s1.jsonl', 2, 42],
    ]);

    const ev = getEvent(db, 'fake:e2')!;
    expect(ev).toMatchObject({ sessionId: 's1', agentVersion: '9.9.9', rawLine: 2 });
    const loc = rawLocator(db, home, ev)!;
    expect(loc).toMatchObject({
      device: 'laptop',
      originalPath: '/home/me/.fake/proj/s1.jsonl',
      mirrorPath: mirror,
      line: 2,
    });
    expect(readRawLine(db, home, loc)).toBe(
      line('e2', 's1', 2000, 'assistant', 'second message').trim(),
    );
    expect(listSessions(db)[0]).toMatchObject({ sessionId: 's1', eventCount: 2 });

    const log = db.prepare('SELECT note, events_added FROM sync_log').all();
    expect(log).toEqual([{ note: 'device laptop', events_added: 2 }]);
  });

  it('rejects chunks that do not start at the cursor, so the device can resume', () => {
    const { adapter } = spyAdapter();
    const first = line('e1', 's1', 1000, 'user', 'one');
    const second = line('e2', 's1', 2000, 'user', 'two');
    const n = Buffer.byteLength(first);

    expect(appendRemote({ db, home }, adapter, chunk({ offset: 5, text: first }))).toEqual({
      ok: false,
      bytes: 0,
    });
    // An empty chunk for an unknown file is fine and creates nothing.
    expect(appendRemote({ db, home }, adapter, chunk({}))).toMatchObject({ ok: true, bytes: 0 });
    expect(remoteCursors(db, 'laptop')).toEqual([]);

    expect(appendRemote({ db, home }, adapter, chunk({ text: first }))).toMatchObject({
      ok: true,
      bytes: n,
    });
    const stale: AppendResult = appendRemote({ db, home }, adapter, chunk({ text: first }));
    expect(stale).toEqual({ ok: false, bytes: n });
    expect(appendRemote({ db, home }, adapter, chunk({ offset: n + 3, text: second }))).toEqual({
      ok: false,
      bytes: n,
    });
    expect(appendRemote({ db, home }, adapter, chunk({ offset: n, text: second }))).toMatchObject({
      ok: true,
      bytes: n + Buffer.byteLength(second),
      eventsAdded: 1,
    });
    expect(listEvents(db).map((e) => [e.id, e.rawLine])).toEqual([
      ['fake:e1', 1],
      ['fake:e2', 2],
    ]);
  });

  it('compresses what devices push, keeping offsets and tail hashes in uncompressed bytes', () => {
    const { adapter } = spyAdapter();
    const lines = Array.from({ length: 60 }, (_, i) =>
      line(
        `e${i}`,
        's1',
        1000 + i,
        i % 2 ? 'assistant' : 'user',
        `message ${i} 镜像 ${'z'.repeat(i)}`,
      ),
    );
    const text = lines.join('');
    let offset = 0;
    for (let i = 0; i < lines.length; i += 3) {
      const piece = lines.slice(i, i + 3).join('');
      const r = appendRemote(
        { db, home, frameBytes: 512 },
        adapter,
        chunk({ offset, text: piece }),
      );
      expect(r).toMatchObject({ ok: true, bytes: offset + Buffer.byteLength(piece) });
      offset += Buffer.byteLength(piece);
    }
    const id = getEvent(db, 'fake:e0')!.rawFileId;
    expect(mirrorText(db, home, id)).toBe(text);
    expect(remoteCursors(db, 'laptop')[0]?.bytes).toBe(Buffer.byteLength(text));
    const frames = (
      db.prepare('SELECT COUNT(*) AS n FROM raw_chunk WHERE raw_file_id = ?').get(id) as {
        n: number;
      }
    ).n;
    expect(frames).toBeGreaterThan(5);
    for (const [i, l] of lines.entries()) {
      const loc = rawLocator(db, home, getEvent(db, `fake:e${i}`)!)!;
      expect(readRawLine(db, home, loc)).toBe(l.trim());
    }
    // The tail hash is of the last 4 KB of the content, as for a local file.
    const { tail_hash } = db.prepare('SELECT tail_hash FROM raw_file WHERE id = ?').get(id) as {
      tail_hash: string;
    };
    const content = Buffer.from(text);
    expect(tail_hash).toBe(
      createHash('sha256')
        .update(content.subarray(content.length - 4096))
        .digest('hex'),
    );
  });

  it("seals the tails of devices' files that stopped growing", async () => {
    const { adapter } = spyAdapter();
    appendRemote({ db, home }, adapter, chunk({ text: two }));
    const local = tmp('origin-local-');
    fs.writeFileSync(path.join(local, 'l.jsonl'), line('l1', 'sl', 1000, 'user', 'local'));
    await syncSource({ db, home }, fakeAdapter(local));
    const frames = () =>
      db
        .prepare(
          `SELECT substr(r.path, 1, 1) = '@' AS remote, COUNT(c.first_line) AS n
           FROM raw_file r LEFT JOIN raw_chunk c ON c.raw_file_id = r.id GROUP BY 1 ORDER BY 1`,
        )
        .all();
    expect(sealIdleMirrors(db, home, { before: Date.now() - IDLE_SEAL_MS, remote: true })).toBe(0);
    expect(sealIdleMirrors(db, home, { before: Date.now() + 1, remote: true })).toBe(1);
    expect(frames()).toEqual([
      { remote: 0, n: 0 },
      { remote: 1, n: 1 },
    ]);
    expect(mirrorText(db, home, getEvent(db, 'fake:e1')!.rawFileId)).toBe(two);
    // Nothing left to seal; and more lines from the device start a new tail.
    expect(sealIdleMirrors(db, home, { before: Date.now() + 1, remote: true })).toBe(0);
    const third = line('e3', 's1', 3000, 'user', 'third');
    appendRemote({ db, home }, adapter, chunk({ offset: Buffer.byteLength(two), text: third }));
    expect(mirrorText(db, home, getEvent(db, 'fake:e3')!.rawFileId)).toBe(two + third);
  });

  it('opens a separate raw file and mirror for each generation', () => {
    const { adapter } = spyAdapter();
    appendRemote({ db, home }, adapter, chunk({ text: line('e1', 's1', 1000, 'user', 'one') }));
    const r = appendRemote(
      { db, home },
      adapter,
      chunk({ generation: 2, text: line('e3', 's1', 3000, 'user', 'three') }),
    );
    expect(r).toMatchObject({ ok: true, eventsAdded: 1 });
    expect(
      fs.existsSync(
        path.join(home, 'raw', 'devices', 'laptop', 'fake', 'proj', 's1.jsonl.g2.tail'),
      ),
    ).toBe(true);
    expect(rawLocator(db, home, getEvent(db, 'fake:e3')!)).toMatchObject({
      generation: 2,
      line: 1,
    });
    expect(remoteCursors(db, 'laptop').map((c) => [c.path, c.generation])).toEqual([
      ['/home/me/.fake/proj/s1.jsonl', 1],
      ['/home/me/.fake/proj/s1.jsonl', 2],
    ]);
  });

  it('refuses anything that could escape the mirror directory or break the mirror', () => {
    const { adapter } = spyAdapter();
    const text = line('e1', 's1', 1000, 'user', 'one');
    const bad: Array<Partial<RemoteChunk> & { text?: string }> = [
      { relPath: '../escape.jsonl' },
      { relPath: 'a/../../escape.jsonl' },
      { relPath: 'a\\..\\..\\escape.jsonl' },
      { relPath: '/etc/escape.jsonl' },
      { relPath: '\\escape.jsonl' },
      { relPath: 'C:/escape.jsonl' },
      { relPath: 'C:escape.jsonl' },
      { relPath: 'a\0b.jsonl' },
      { relPath: '' },
      { device: 'Laptop' },
      { device: '../laptop' },
      { device: 'lap:top' },
      { device: '' },
      { source: 'other' },
      { generation: 0 },
      { generation: 1.5 },
      { offset: -1 },
      { path: '' },
      { text: 'no trailing newline' },
    ];
    for (const over of bad) {
      expect(() => appendRemote({ db, home }, adapter, chunk({ text, ...over }))).toThrow(
        OriginError,
      );
    }
    expect(fs.existsSync(path.join(home, 'raw'))).toBe(false);
    expect(listEvents(db)).toEqual([]);
  });

  it('keeps events forgotten on the hub forgotten when a device pushes them again', () => {
    const { adapter } = spyAdapter();
    appendRemote({ db, home }, adapter, chunk({ text: two }));
    forget(db, 'fake:e1');
    // The device rewrote the file (new generation) and pushes the same lines again.
    appendRemote({ db, home }, adapter, chunk({ generation: 2, text: two }));
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(listEvents(db).map((e) => e.id)).toEqual(['fake:e2']);
    expect(listSessions(db)[0]?.eventCount).toBe(1);
  });

  it('keeps cursors and device listings per device, apart from local files', async () => {
    const { adapter } = spyAdapter();
    appendRemote({ db, home }, adapter, chunk({ text: two }));
    appendRemote(
      { db, home },
      adapter,
      chunk({
        device: 'desk',
        path: 'D:\\fake\\s9.jsonl',
        relPath: 's9.jsonl',
        text: line('e9', 's9', 9000, 'user', 'nine'),
      }),
    );
    const src = tmp('origin-local-');
    fs.writeFileSync(path.join(src, 'local.jsonl'), line('l1', 'sl', 500, 'user', 'local'));
    await syncSource({ db, home }, fakeAdapter(src));

    expect(remoteCursors(db, 'laptop')).toEqual([
      {
        source: 'fake',
        path: '/home/me/.fake/proj/s1.jsonl',
        generation: 1,
        bytes: Buffer.byteLength(two),
      },
    ]);
    expect(remoteCursors(db, 'desk').map((c) => c.path)).toEqual(['D:\\fake\\s9.jsonl']);
    expect(listDevices(db).map((d) => [d.device, d.files, d.bytes])).toEqual([
      ['desk', 1, Buffer.byteLength(line('e9', 's9', 9000, 'user', 'nine'))],
      ['laptop', 1, Buffer.byteLength(two)],
    ]);
    expect(localRawFiles(db).map((f) => f.path)).toEqual([path.join(src, 'local.jsonl')]);
    expect(rawLocator(db, home, getEvent(db, 'fake:l1')!)?.device).toBeNull();
    expect(rawLocator(db, home, getEvent(db, 'fake:e9')!)).toMatchObject({
      device: 'desk',
      originalPath: 'D:\\fake\\s9.jsonl',
    });
  });
});

describe('localRawFiles', () => {
  it('derives each mirror relPath, across generations and path separators', async () => {
    const src = tmp('origin-local-');
    const file = path.join(src, 'a.jsonl');
    const original = line('a1', 'sa', 1000, 'user', 'original');
    const rewritten = line('a2', 'sa', 2000, 'user', 'rewritten');
    fs.writeFileSync(file, original);
    await syncSource({ db, home }, fakeAdapter(src));
    fs.writeFileSync(file, rewritten);
    await syncSource({ db, home }, fakeAdapter(src));
    // A row written on Windows: backslashes in both the original path and the mirror.
    db.prepare(
      `INSERT INTO raw_file (source, path, generation, mirror, bytes_ingested, first_seen_at, updated_at)
       VALUES ('fake', ?, 2, ?, 7, 1, 1)`,
    ).run(['C:', 'x', 'b.jsonl'].join('\\'), ['fake', 'win', 'b.jsonl.g2'].join('\\'));

    const files = localRawFiles(db)
      .map((f) => [f.relPath, f.generation, f.bytes])
      .sort((x, y) => String(x).localeCompare(String(y)));
    expect(files).toEqual([
      ['a.jsonl', 1, Buffer.byteLength(original)],
      ['a.jsonl', 2, Buffer.byteLength(rewritten)],
      ['win/b.jsonl', 2, 7],
    ]);
    const g2 = localRawFiles(db).find((f) => f.path === file && f.generation === 2);
    expect(mirrorText(db, home, g2!.id)).toBe(rewritten);
  });
});

describe('tokens', () => {
  it('creates, verifies, lists, and revokes tokens', () => {
    const token = createToken(db, 'laptop', 1000);
    expect(token).toMatch(/^ogn_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM api_token').all())).not.toContain(token);

    expect(verifyToken(db, token, 2000)).toEqual({ name: 'laptop' });
    expect(verifyToken(db, `${token}x`, 2000)).toBeNull();
    expect(verifyToken(db, 'not-a-token', 2000)).toBeNull();
    expect(listTokens(db)).toEqual([
      { name: 'laptop', createdAt: 1000, lastUsedAt: 2000, revokedAt: null },
    ]);

    expect(() => createToken(db, 'laptop')).toThrow(/is active; revoke it first/);
    expect(() => createToken(db, 'Bad Name')).toThrow(OriginError);
    expect(() => createToken(db, '-dash')).toThrow(OriginError);
    expect(() => createToken(db, 'a'.repeat(64))).toThrow(OriginError);

    expect(revokeToken(db, 'laptop', 3000)).toBe(true);
    expect(revokeToken(db, 'laptop', 3000)).toBe(false);
    expect(revokeToken(db, 'nobody')).toBe(false);
    expect(verifyToken(db, token)).toBeNull();
    expect(listTokens(db)[0]?.revokedAt).toBe(3000);

    // A token is bound to the device it is named after, so a device that lost its token gets a
    // new one under the same name; the revoked token stays invalid.
    const renewed = createToken(db, 'laptop', 4000);
    expect(renewed).not.toBe(token);
    expect(verifyToken(db, token, 5000)).toBeNull();
    expect(verifyToken(db, renewed, 5000)).toEqual({ name: 'laptop' });
    expect(listTokens(db)).toEqual([
      { name: 'laptop', createdAt: 4000, lastUsedAt: 5000, revokedAt: null },
    ]);
  });

  it('records use at most once a minute', () => {
    const token = createToken(db, 'ci', 0);
    verifyToken(db, token, 1_000);
    verifyToken(db, token, 31_000);
    expect(listTokens(db)[0]?.lastUsedAt).toBe(1_000);
    verifyToken(db, token, 61_000);
    expect(listTokens(db)[0]?.lastUsedAt).toBe(61_000);
  });
});

describe('settings', () => {
  it('stores small key-value state', () => {
    expect(getSetting(db, 'hub.pulled')).toBeNull();
    setSetting(db, 'hub.pulled', '3');
    setSetting(db, 'hub.pulled', '7');
    expect(getSetting(db, 'hub.pulled')).toBe('7');
  });
});

describe('tombstones', () => {
  let device: Database;
  let deviceHome: string;

  beforeEach(async () => {
    initStoreName(db, 'hub');
    deviceHome = tmp('origin-device-');
    device = openDatabase(path.join(deviceHome, 'origin.db'));
    initStoreName(device, 'laptop');
    const src = tmp('origin-src-');
    fs.writeFileSync(
      path.join(src, 's1.jsonl'),
      line('e1', 's1', 1000, 'user', 'shared one') + line('e2', 's1', 2000, 'user', 'shared two'),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    await syncSource({ db: device, home: deviceHome }, fakeAdapter(src));
    // An event only the hub knows (pushed by another device).
    fs.writeFileSync(path.join(src, 's2.jsonl'), line('h1', 's2', 3000, 'user', 'hub only'));
    await syncSource({ db, home }, fakeAdapter(src));
  });

  afterEach(() => device.close());

  it('feeds tombstones in change order, each with its effects, without the device own', () => {
    const e = remember(db, {
      kind: 'memory',
      text: 'x',
      confidence: 1,
      author: 'test',
      sources: [{ eventId: 'fake:e1' }],
    });
    const first = forget(db, e.id, 'test');
    const second = forget(db, 'fake:h1');
    // A tombstone a device pushed: it keeps its id and origin.
    applyTombstone(
      db,
      {
        id: 'tmb_0123456789ab',
        target: 'fake:e2',
        reason: null,
        createdAt: 4000,
        origin: 'laptop',
        entries: [],
        events: ['fake:e2'],
      },
      { keep: true },
    );

    const all = tombstoneFeed(db, { after: 0, device: 'desk' });
    expect(
      all.tombstones.map((t) => [t.id, t.target, t.reason, t.origin, t.entries, t.events]),
    ).toEqual([
      [first.tombstoneId, e.id, 'test', 'hub', [e.id], ['fake:e1']],
      [second.tombstoneId, 'fake:h1', null, 'hub', [], ['fake:h1']],
      ['tmb_0123456789ab', 'fake:e2', null, 'laptop', [], ['fake:e2']],
    ]);
    expect(all.more).toBe(false);
    // The device that created a tombstone does not get it back.
    const laptop = tombstoneFeed(db, { after: 0, device: 'laptop' });
    expect(laptop.tombstones.map((t) => t.id)).toEqual([first.tombstoneId, second.tombstoneId]);

    const page = tombstoneFeed(db, { after: 0, device: 'desk', limit: 1 });
    expect(page.tombstones.map((t) => t.id)).toEqual([first.tombstoneId]);
    expect(page.more).toBe(true);
    const rest = tombstoneFeed(db, { after: page.next, device: 'desk' });
    expect(rest.tombstones.map((t) => t.id)).toEqual([second.tombstoneId, 'tmb_0123456789ab']);
    expect(tombstoneFeed(db, { after: rest.next, device: 'desk' })).toEqual({
      tombstones: [],
      next: rest.next,
      more: false,
    });
  });

  it("applies a hub's tombstone to what the device knows, once, under the same id", () => {
    const e = remember(db, {
      kind: 'memory',
      text: 'x',
      confidence: 1,
      author: 'test',
      sources: [{ eventId: 'fake:e1' }],
    });
    forget(db, e.id, 'secret');
    forget(db, 'fake:h1');
    const [first, second] = tombstoneFeed(db, { after: 0, device: 'laptop' }).tombstones;

    expect(listSessions(device)[0]?.eventCount).toBe(2);
    expect(applyTombstone(device, first!)).toEqual({ entries: 0, events: 1 });
    expect(getEvent(device, 'fake:e1')).toBeNull();
    expect(listSessions(device)[0]?.eventCount).toBe(1);
    expect(tombstoneFeed(device, { after: 0, device: 'other' }).tombstones).toEqual([
      { ...first!, entries: [] },
    ]);

    // Re-applying, or applying a tombstone about events the device never had, writes nothing.
    expect(applyTombstone(device, first!)).toEqual({ entries: 0, events: 0 });
    expect(applyTombstone(device, second!)).toEqual({ entries: 0, events: 0 });
    expect(tombstoneCount(device)).toBe(1);
    expect(() => applyTombstone(device, { ...first!, reason: 'changed' })).toThrow(
      /different content/,
    );
  });

  it('rejects malformed tombstones', () => {
    const good = {
      id: 'tmb_0123456789ab',
      target: 'fake:e1',
      reason: null,
      createdAt: 1,
      origin: 'laptop',
      entries: [],
      events: ['fake:e1'],
    };
    expect(parseTombstoneRecord(good)).toEqual(good);
    for (const bad of [
      null,
      [],
      { ...good, id: 7 },
      { ...good, id: 'ent_0123456789ab' },
      { ...good, target: '' },
      { ...good, reason: 3 },
      { ...good, createdAt: -1 },
      { ...good, createdAt: 1.5 },
      { ...good, origin: 'Bad Name' },
      { ...good, entries: 'x' },
      { ...good, events: [1] },
    ]) {
      expect(() => parseTombstoneRecord(bad)).toThrow(OriginError);
    }
  });
});
