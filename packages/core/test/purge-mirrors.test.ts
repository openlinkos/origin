import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupStore,
  bucketFrameStore,
  completePurges,
  type Database,
  fitFrame,
  getEvent,
  initStoreName,
  journalDir,
  mirrorState,
  openDatabase,
  type PurgeResult,
  type PurgeSelector,
  purge,
  rawDir,
  rawLocator,
  readRawLine,
  releaseObjectStore,
  replayFrameJournals,
  type SourceAdapter,
  searchEvents,
  syncSource,
  uploadFrames,
  useObjectStore,
} from '../src/index.js';
import { memoryObjects } from './frame-contract.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

/**
 * Completing a purge: the lines it removed are blanked in the raw mirrors, in sealed frames (on
 * disk or in a bucket) and in open tails, and nothing else of the mirrors changes. Once a purge
 * is complete and the database checkpointed, its text is nowhere in the store.
 */

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purge-mirrors-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'laptop');
});

afterEach(() => {
  releaseObjectStore(home);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FRAME = 300;
const adapter = () => fakeAdapter(logs);
const sync = (frameBytes = FRAME) => syncSource({ db, home, frameBytes }, adapter());
const write = (file: string, text: string) => fs.appendFileSync(path.join(logs, file), text);
const by = { reason: 'pasted a secret', author: 'user@laptop', channel: 'cli' as const };
const run = (selector: PurgeSelector, opts: { complete?: boolean } = {}): PurgeResult =>
  purge(db, home, [adapter()], selector, { ...by, ...opts });
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
/** `n` lines of session `session`, with ids `<prefix>0`, `<prefix>1`, … */
const many = (prefix: string, session: string, n: number, from = 0) =>
  Array.from({ length: n }, (_, i) =>
    line(`${prefix}${from + i}`, session, 1000 + from + i, 'user', `${prefix} words ${from + i}`),
  ).join('');
const rawFileOf = (id: string) => getEvent(db, id)?.rawFileId as number;
const rawLine = (id: string) => readRawLine(db, home, rawLocator(db, home, getEvent(db, id)!)!);

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? filesUnder(p) : [p];
  });
}

/**
 * Where `needle` still is in the store at `root`: the bytes of every file (the database and its
 * WAL, frames, tails, journals), every sealed frame decompressed, the bucket's objects as they
 * are and decompressed, every mirror as the store reads it, and the purge tables and the audit log.
 */
function traces(
  needle: string,
  opts: { root?: string; db?: Database; objects?: Map<string, Buffer> } = {},
): string[] {
  const root = opts.root ?? home;
  const store = opts.db ?? db;
  const bytes = Buffer.from(needle);
  const found: string[] = [];
  for (const f of filesUnder(root)) {
    if (fs.readFileSync(f).includes(bytes)) found.push(path.relative(root, f));
  }
  const files = store.prepare('SELECT id, mirror FROM raw_file').all() as Array<{
    id: number;
    mirror: string;
  }>;
  for (const f of files) {
    const zst = `${path.join(rawDir(root), f.mirror)}.zst`;
    const data = fs.existsSync(zst) ? fs.readFileSync(zst) : null;
    const chunks = store
      .prepare('SELECT frame_offset, frame_length FROM raw_chunk WHERE raw_file_id = ?')
      .all(f.id) as Array<{ frame_offset: number; frame_length: number }>;
    for (const c of chunks) {
      const frame = data?.subarray(c.frame_offset, c.frame_offset + c.frame_length);
      if (
        frame &&
        frame.length === c.frame_length &&
        zlib.zstdDecompressSync(frame).includes(bytes)
      )
        found.push(`frame ${c.frame_offset} of ${f.mirror}`);
    }
    if (mirrorText(store, root, f.id).includes(needle)) found.push(`mirror ${f.mirror}`);
  }
  for (const [key, data] of opts.objects ?? []) {
    if (data.includes(bytes) || zlib.zstdDecompressSync(data).includes(bytes)) found.push(key);
  }
  for (const t of ['purge', 'purged', 'purge_line', 'purge_pending', 'audit_log']) {
    if (JSON.stringify(store.prepare(`SELECT * FROM ${t}`).all()).includes(needle)) found.push(t);
  }
  // A term of the search indexes may share its first bytes with the one before it: for a canary
  // of a letter nothing else uses, any block that holds the letter is a trace.
  const letter = Buffer.from([...needle][0] as string);
  for (const t of letter.length > 1 ? ['event_fts', 'message_fts', 'event_cjk', 'entry_fts'] : []) {
    const blocks = store.prepare(`SELECT block FROM ${t}_data`).all() as Array<{
      block: Uint8Array | null;
    }>;
    if (blocks.some((b) => b.block && Buffer.from(b.block).includes(letter))) found.push(t);
  }
  return found;
}

/** What records the mirrors' layout: none of it changes when lines are blanked. */
const layout = () => ({
  files: db.prepare('SELECT * FROM raw_file ORDER BY id').all(),
  chunks: db.prepare('SELECT * FROM raw_chunk ORDER BY raw_file_id, first_line').all(),
  sizes: filesUnder(rawDir(home))
    .sort()
    .map((f) => [path.relative(home, f), fs.statSync(f).size]),
});

/*
 * The canaries are runs of one letter that nothing else in a store uses: their only trigram (or
 * CJK bigram) is a term of its own in the search indexes, stored whole, so that finding its bytes
 * anywhere in the database means the index still holds it.
 */
const SEALED = 'ǂǂǂǂǂ';
const TAILED = 'ʘʘʘʘʘ';
const HAN = '龘龘龘龘';
/** The bytes each leaves in the search indexes, and in everything else. */
const trace = (canary: string) => [...canary].slice(0, 3).join('');

describe('completing a purge', () => {
  it('leaves none of the purged text in the store, from sealed frames to the tail', async () => {
    write('a.jsonl', many('k', 's1', 10) + line('c1', 's1', 1500, 'user', `${SEALED} ${HAN}`));
    write('a.jsonl', many('m', 's1', 10, 20));
    await sync();
    // Two short lines stay in the open tail.
    write('a.jsonl', line('c2', 's1', 9000, 'user', TAILED) + many('t', 's1', 1));
    await sync();
    const st = mirrorState(db, rawFileOf('fake:c1'))!;
    expect(st.sealedLines).toBe(21);
    expect(st.lines).toBe(23);
    const kept = ['fake:k3', 'fake:m25', 'fake:t0'].map((id) => [id, rawLine(id)] as const);
    const before = layout();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const canary of [SEALED, TAILED, HAN]) {
      expect(traces(trace(canary))).toEqual(expect.arrayContaining(['origin.db']));
    }

    const r = run({ kind: 'event', ids: ['fake:c1', 'fake:c2'] });
    expect(r.mirrors).toEqual({ done: 1, frames: 1, lines: 2, failed: [], pending: 0 });
    expect(r.pending).toBe(0);
    for (const canary of [SEALED, TAILED, HAN]) expect(traces(trace(canary))).toEqual([]);
    expect(searchEvents(db, SEALED)).toEqual([]);
    expect(searchEvents(db, '龘龘')).toEqual([]);
    expect(fs.statSync(path.join(home, 'origin.db-wal')).size).toBe(0);

    // Every offset stays: the mirrors, their frames, and the lines kept read back as they were.
    expect(layout()).toEqual(before);
    for (const [id, text] of kept) expect(rawLine(id)).toBe(text);
    const lines = mirrorText(db, home, st.rawFileId).split('\n');
    const c1 = line('c1', 's1', 1500, 'user', `${SEALED} ${HAN}`).trimEnd();
    expect(lines[10]).toBe(' '.repeat(Buffer.byteLength(c1)));
    expect(lines[21]?.trim()).toBe('');
    expect(lines).toHaveLength(24);
    expect(count('SELECT COUNT(*) AS n FROM purge_pending')).toBe(0);
  });

  it('removes a few events from the search tables in place, leaving none of their text', async () => {
    write(
      'a.jsonl',
      many('k', 'kept', 1100) + line('han', 'kept', 1100, 'user', '数据库') + many('m', 'kept', 10),
    );
    write('b.jsonl', line('c', 'doomed', 5000, 'user', `${SEALED} ${HAN}`));
    await sync(64 * 1024);
    const r = run({ kind: 'event', ids: ['fake:c'] });
    expect(r.mirrors).toMatchObject({ done: 1, failed: [], pending: 0 });
    for (const canary of [SEALED, HAN]) expect(traces(trace(canary))).toEqual([]);
    expect(searchEvents(db, '数据').map((h) => h.id)).toEqual(['fake:han']);
    for (const t of ['event_fts', 'message_fts', 'event_cjk', 'entry_fts']) {
      db.exec(`INSERT INTO ${t} (${t}) VALUES ('integrity-check')`);
      expect(db.prepare(`SELECT v FROM ${t}_config WHERE k = 'secure-delete'`).get()).toEqual({
        v: 0,
      });
    }
  });

  it('builds the search tables again when it deletes many events, leaving none of it', async () => {
    write('a.jsonl', many('k', 'kept', 40) + line('han', 'kept', 1100, 'user', '数据库'));
    write(
      'b.jsonl',
      many('d', 'doomed', 1200) +
        line('c', 'doomed', 5000, 'user', `${SEALED} ${HAN}`) +
        many('d', 'doomed', 1200, 1200),
    );
    await sync(16 * 1024);
    const r = run({ kind: 'session', source: 'fake', sessionId: 'doomed' });
    expect(r.record.counts.events).toBe(2401);
    expect(r.mirrors).toMatchObject({ done: 1, failed: [], pending: 0 });
    for (const canary of [SEALED, HAN]) expect(traces(trace(canary))).toEqual([]);
    expect(searchEvents(db, SEALED)).toEqual([]);
    // What was kept is found as before, and the indexes are as purging one by one leaves them.
    const hits = searchEvents(db, 'words 7').map((h) => h.id);
    expect(hits).toContain('fake:k7');
    expect(hits.every((id) => id.startsWith('fake:k'))).toBe(true);
    expect(searchEvents(db, '数据').map((h) => h.id)).toEqual(['fake:han']);
    for (const t of ['event_fts', 'message_fts', 'event_cjk', 'entry_fts']) {
      db.exec(`INSERT INTO ${t} (${t}) VALUES ('integrity-check')`);
      expect(db.prepare(`SELECT v FROM ${t}_config WHERE k = 'secure-delete'`).get()).toEqual({
        v: 0,
      });
    }
    expect(mirrorText(db, home, rawFileOf('fake:k0'))).toBe(
      fs.readFileSync(path.join(logs, 'a.jsonl'), 'utf8'),
    );
  });

  it('blanks frames in a bucket, and frames still on disk from before it', async () => {
    write('a.jsonl', many('k', 's1', 6) + line('c1', 's1', 1500, 'user', 'zqlocalcanary'));
    await sync();
    const objects = memoryObjects();
    useObjectStore(db, home, objects);
    write('a.jsonl', many('m', 's1', 6, 20) + line('c2', 's1', 2500, 'user', 'zqbucketcanary'));
    write('a.jsonl', many('n', 's1', 6, 40));
    await sync();
    const zst = `${path.join(rawDir(home), mirrorState(db, rawFileOf('fake:c1'))!.mirror)}.zst`;
    expect(fs.statSync(zst).size).toBeGreaterThan(0);
    expect(objects.objects.size).toBeGreaterThan(0);
    const kept = ['fake:k2', 'fake:m22', 'fake:n44'].map((id) => [id, rawLine(id)] as const);
    const before = layout();

    const r = run({ kind: 'event', ids: ['fake:c1', 'fake:c2'] });
    expect(r.mirrors).toMatchObject({ done: 1, frames: 2, lines: 2, failed: [] });
    for (const canary of ['zqlocalcanary', 'zqbucketcanary']) {
      expect(traces(canary, { objects: objects.objects })).toEqual([]);
    }
    expect(layout()).toEqual(before);
    // As a process that keeps nothing in memory reads them.
    useObjectStore(db, home, objects, { cacheBytes: 0 });
    for (const [id, text] of kept) expect(rawLine(id)).toBe(text);
  });

  it('makes other processes forget the frames they keep in memory', () => {
    const objects = memoryObjects();
    const mirror = path.join('fake', 'a.jsonl');
    const before = Buffer.from('a frame as it was');
    const after = Buffer.from('a frame blanked!!');
    // The hub's process wrote the frame, and keeps it in memory.
    const hub = bucketFrameStore(home, objects);
    hub.write(mirror, 0, [before]);
    expect(hub.read(mirror, 0, before.length)).toEqual(before);
    // A purge in a process of its own replaces it, with a store of its own over the same bucket.
    bucketFrameStore(home, objects).replace(mirror, [{ offset: 0, frame: after }]);
    expect(hub.read(mirror, 0, before.length)).toEqual(after);
    const gets = objects.gets;
    expect(hub.read(mirror, 0, before.length)).toEqual(after);
    expect(objects.gets).toBe(gets);
  });

  it('records an error and keeps the mirror pending when its frames cannot be written', async () => {
    write('a.jsonl', many('k', 's1', 6) + line('c', 's1', 1500, 'user', 'zqjournalcanary'));
    write('a.jsonl', many('m', 's1', 6, 20));
    await sync();
    const st = mirrorState(db, rawFileOf('fake:c'))!;
    const zst = `${path.join(rawDir(home), st.mirror)}.zst`;
    const original = fs.readFileSync(zst);
    fs.chmodSync(zst, 0o444);
    let r: PurgeResult;
    try {
      r = run({ kind: 'event', ids: ['fake:c'] });
    } finally {
      fs.chmodSync(zst, 0o644);
    }
    expect(r.mirrors).toMatchObject({ done: 0, pending: 1 });
    expect(r.mirrors?.failed).toEqual([
      expect.objectContaining({ rawFileId: st.rawFileId, mirror: st.mirror }),
    ]);
    expect(
      db.prepare('SELECT attempts, error FROM purge_pending').get() as Record<string, unknown>,
    ).toMatchObject({ attempts: 1, error: expect.any(String) });
    // The frames were left as they were, and the journal of the replacement was kept.
    expect(fs.readFileSync(zst)).toEqual(original);
    const journals = fs.readdirSync(journalDir(home)).filter((n) => n.endsWith('.journal'));
    expect(journals).toHaveLength(1);
    const journal = path.join(journalDir(home), journals[0] as string);
    const saved = fs.readFileSync(journal);

    // Replayed, it puts the blanked frames in place; replayed again, it changes nothing more.
    expect(replayFrameJournals(home)).toBe(1);
    const blanked = fs.readFileSync(zst);
    expect(blanked.length).toBe(original.length);
    expect(mirrorText(db, home, st.rawFileId)).not.toContain('zqjournalcanary');
    fs.writeFileSync(journal, saved);
    expect(replayFrameJournals(home)).toBe(1);
    expect(fs.readFileSync(zst)).toEqual(blanked);
    // A journal cut short was never applied: it is dropped.
    fs.writeFileSync(journal, saved.subarray(0, saved.length - 10));
    expect(replayFrameJournals(home)).toBe(0);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readFileSync(zst)).toEqual(blanked);

    // The next completion finds the lines blank, and the mirror done.
    expect(completePurges(db, home, [adapter()])).toMatchObject({
      done: 1,
      failed: [],
      pending: 0,
    });
    expect(traces('zqjournalcanary')).toEqual([]);
  });

  it('stops when its time is up, and goes on the next time', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'zqfirstcanary'));
    write('b.jsonl', line('2', 's2', 2000, 'user', 'zqsecondcanary'));
    await sync();
    run({ kind: 'event', ids: ['fake:1', 'fake:2'] }, { complete: false });
    expect(completePurges(db, home, [adapter()], { budgetMs: -1 })).toMatchObject({
      done: 0,
      pending: 2,
    });
    expect(completePurges(db, home, [adapter()])).toMatchObject({ done: 2, pending: 0 });
    expect(traces('zqfirstcanary')).toEqual([]);
    expect(traces('zqsecondcanary')).toEqual([]);
  });

  it('reads a frame again when what it read does not decompress', async () => {
    const objects = memoryObjects();
    useObjectStore(db, home, objects);
    write('a.jsonl', many('k', 's1', 10));
    await sync();
    useObjectStore(db, home, objects, { cacheBytes: 0 });
    const text = line('k1', 's1', 1001, 'user', 'k words 1').trimEnd();
    // The first read of a frame comes back torn, as one read while a purge replaced it.
    const get = objects.get.bind(objects);
    let torn = 1;
    objects.get = (key: string) => {
      const data = get(key);
      if (!data || torn-- <= 0) return data;
      const copy = Buffer.from(data);
      copy[copy.length - 1] = (copy[copy.length - 1] as number) ^ 0xff;
      return copy;
    };
    const gets = objects.gets;
    expect(rawLine('fake:k1')).toBe(text);
    expect(objects.gets - gets).toBe(2);
  });

  it('goes on from the continuation of a generated source whose last line it removed', async () => {
    const row = (n: number, text: string) => ({ n, id: String(n), session: 's1', ts: n, text });
    const rows = [row(1, 'kept'), row(2, 'zqgeneratedcanary')];
    const asked: Array<string | null> = [];
    const generated: SourceAdapter = {
      ...adapter(),
      async discover() {
        return [
          {
            absPath: 'db#1',
            relPath: 'db/1.jsonl',
            generated: {
              token: `rows:${rows.length}`,
              mtimeMs: 1,
              next(last) {
                asked.push(last);
                const after = last === null ? 0 : (JSON.parse(last) as { n: number }).n;
                return rows
                  .filter((r) => r.n > after)
                  .map((r) => JSON.stringify({ ...r, role: 'user' }));
              },
            },
          },
        ];
      },
      continuation: (l) => ({ n: (JSON.parse(l) as { n: number }).n }),
    };
    await syncSource({ db, home }, generated);
    const r = purge(db, home, [generated], { kind: 'event', ids: ['fake:2'] }, by);
    expect(r.mirrors).toMatchObject({ done: 1, failed: [] });
    const id = rawFileOf('fake:1');
    const last = mirrorText(db, home, id).split('\n')[1] as string;
    expect(last.trimEnd()).toBe(`{"origin_purged":"${r.id}","n":2}`);
    expect(Buffer.byteLength(last)).toBe(
      Buffer.byteLength(JSON.stringify({ ...rows[1], role: 'user' })),
    );

    rows.push(row(3, 'later'));
    expect(await syncSource({ db, home }, generated)).toMatchObject({ eventsAdded: 1 });
    expect(asked.slice(2)).toEqual([last, JSON.stringify({ ...rows[2], role: 'user' })]);
    expect(getEvent(db, 'fake:3')).not.toBeNull();
    expect(getEvent(db, 'fake:2')).toBeNull();
    expect(traces('zqgeneratedcanary')).toEqual([]);
  });
});

describe('fitting a frame into its slot', () => {
  const content = Buffer.from(
    Array.from({ length: 40 }, (_, i) => `line ${i} of some text ${'x'.repeat(i % 7)}\n`).join(''),
  );
  const at = (level: number, checksum: boolean) =>
    zlib.zstdCompressSync(content, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: level,
        [zlib.constants.ZSTD_c_checksumFlag]: checksum ? 1 : 0,
      },
    });
  const sealed = at(3, true);

  it('takes a frame of the slot size as it is', () => {
    expect(fitFrame(content, sealed.length)).toEqual(sealed);
    expect(fitFrame(content, sealed.length - 4)).toEqual(at(3, false));
  });

  it('fills the rest of the slot with a skippable frame', () => {
    for (const gap of [4, 5, 7, 8, 100]) {
      const frame = fitFrame(content, sealed.length + gap)!;
      expect(frame).toHaveLength(sealed.length + gap);
      expect(zlib.zstdDecompressSync(frame)).toEqual(content);
    }
  });

  it('gives nothing when no frame fits', () => {
    expect(fitFrame(content, 10)).toBeNull();
  });
});

describe('backing up a store with purges', () => {
  it('copies a mirror whole again once its lines were blanked', async () => {
    write('a.jsonl', many('k', 's1', 6) + line('c1', 's1', 1500, 'user', 'zqbackupcanary'));
    write('a.jsonl', many('m', 's1', 6, 20) + line('c2', 's1', 2500, 'user', 'zqlatercanary'));
    write('a.jsonl', many('n', 's1', 6, 40));
    await sync();
    const target = path.join(tmp, 'backup');
    const first = await backupStore(db, home, target);
    expect(first.pendingMirrors).toBe(0);
    const backedUp = () => {
      const copy = openDatabase(path.join(target, 'origin.db'));
      try {
        return {
          one: traces('zqbackupcanary', { root: target, db: copy }),
          two: traces('zqlatercanary', { root: target, db: copy }),
        };
      } finally {
        copy.close();
      }
    };

    // Purged, not blanked yet: copied as it is, and noted.
    run({ kind: 'event', ids: ['fake:c1'] }, { complete: false });
    const pending = await backupStore(db, home, target);
    expect(pending.pendingMirrors).toBe(1);
    expect(backedUp().one).not.toEqual([]);

    // Blanked since: the next backup copies the mirror whole.
    completePurges(db, home, [adapter()]);
    const blanked = await backupStore(db, home, target);
    expect(blanked).toMatchObject({ pendingMirrors: 0, mirrorFiles: 1 });
    expect(blanked.mirrorBytesCopied).toBe(first.mirrorBytesCopied);
    expect(backedUp().one).toEqual([]);

    // A purge since the previous backup, complete before this one.
    run({ kind: 'event', ids: ['fake:c2'] });
    const later = await backupStore(db, home, target);
    expect(later.mirrorBytesCopied).toBe(first.mirrorBytesCopied);
    expect(backedUp()).toEqual({ one: [], two: [] });

    // Nothing purged since: extended as before.
    expect((await backupStore(db, home, target)).mirrorBytesCopied).toBe(0);
  });
});

describe('moving frames into a bucket during a purge', () => {
  it('blanks again a frame that the upload put back as it was', async () => {
    write('a.jsonl', line('c', 's1', 1000, 'user', 'zqracecanary') + many('k', 's1', 8));
    await sync();
    const objects = memoryObjects();
    let during: PurgeResult | null = null;
    const racing = Object.assign(objects, {
      async putAsync(key: string, data: Buffer) {
        // The purge runs after the frame was read from disk, before it reaches the bucket.
        during ??= run({ kind: 'event', ids: ['fake:c'] });
        objects.put(key, data);
      },
    });
    useObjectStore(db, home, racing);
    const log: string[] = [];
    const up = await uploadFrames(db, home, {
      concurrency: 1,
      remove: true,
      log: (m) => log.push(m),
    });
    expect(during).not.toBeNull();
    expect(up.failed).toEqual([]);
    expect(log).toContain('a purge ran meanwhile: 1 mirror queued to be blanked again');
    expect(count('SELECT COUNT(*) AS n FROM purge_pending')).toBe(1);
    expect(traces('zqracecanary', { objects: objects.objects })).not.toEqual([]);

    expect(completePurges(db, home, [adapter()])).toMatchObject({ done: 1, failed: [] });
    expect(traces('zqracecanary', { objects: objects.objects })).toEqual([]);
  });
});
