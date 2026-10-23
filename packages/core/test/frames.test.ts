import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupStore,
  bucketFrameStore,
  type Database,
  FileFrameStore,
  fileFrameStore,
  frameBucket,
  frameKey,
  frameStore,
  getEvent,
  IDLE_SEAL_MS,
  openDatabase,
  rawLocator,
  readRawLine,
  releaseObjectStore,
  storeUsage,
  syncSource,
  uploadFrames,
  useObjectStore,
} from '../src/index.js';
import { frameStoreContract, memoryObjects } from './frame-contract.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

const temp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `origin-${name}-`));
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    releaseObjectStore(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const freshHome = () => {
  const home = temp('frames');
  cleanup.push(home);
  return home;
};

describe('frame store contract: files', () => {
  frameStoreContract(
    () => {
      const home = freshHome();
      return { store: fileFrameStore(home), home };
    },
    { detectsLoss: true },
  );
});

describe('frame store contract: bucket', () => {
  frameStoreContract(
    () => {
      const home = freshHome();
      return { store: bucketFrameStore(home, memoryObjects()), home };
    },
    { detectsLoss: false },
  );
});

describe('frameKey', () => {
  it('derives the key from the mirror and the offset recorded in raw_chunk', () => {
    expect(frameKey(path.join('devices', 'laptop', 'codex', 'a b.jsonl'), 0)).toBe(
      'devices/laptop/codex/a b.jsonl.zst/000000000000',
    );
    expect(frameKey(path.join('claude-code', 'x.jsonl.g2'), 123_456)).toBe(
      'claude-code/x.jsonl.g2.zst/000000123456',
    );
    expect(frameKey('x', 1_234_567_890_123)).toBe('x.zst/1234567890123');
  });
});

describe('a store with a bucket', () => {
  const FRAME = 300;
  let home: string;
  let src: string;
  let db: Database;
  let objects: ReturnType<typeof memoryObjects>;
  const file = () => path.join(src, 'z.jsonl');
  const ctx = () => ({ db, home, frameBytes: FRAME });
  const lineN = (i: number) =>
    line(`z${i}`, 'z', 1000 + i, 'user', `line ${i} ${'数据'.repeat(i % 9)}`);
  const write = (from: number, to: number) => {
    let text = '';
    for (let i = from; i < to; i++) text += lineN(i);
    fs.appendFileSync(file(), text);
  };
  const rawFileOf = () => getEvent(db, 'fake:z0')!.rawFileId;
  const mirrorBase = () => rawLocator(db, home, getEvent(db, 'fake:z0')!)!.mirrorPath;
  const mirrorName = () => path.relative(path.join(home, 'raw'), mirrorBase());
  const chunks = () =>
    db
      .prepare(
        'SELECT frame_offset, frame_length, byte_length FROM raw_chunk WHERE raw_file_id = ? ORDER BY first_line',
      )
      .all(rawFileOf()) as unknown as Array<{
      frame_offset: number;
      frame_length: number;
      byte_length: number;
    }>;
  /** Every line, read back as a reader with no cache would: a new process. */
  const expectIntact = (count: number) => {
    useObjectStore(db, home, objects, { cacheBytes: 0 });
    expect(mirrorText(db, home, rawFileOf())).toBe(fs.readFileSync(file(), 'utf8'));
    for (let i = 0; i < count; i++) {
      const e = getEvent(db, `fake:z${i}`)!;
      expect(readRawLine(db, home, rawLocator(db, home, e)!)).toBe(lineN(i).trim());
    }
    useObjectStore(db, home, objects);
  };

  beforeEach(() => {
    home = freshHome();
    src = freshHome();
    db = openDatabase(path.join(home, 'origin.db'));
    objects = memoryObjects();
  });
  afterEach(() => db.close());

  it('records its bucket, and refuses another', () => {
    expect(frameBucket(db)).toBeNull();
    useObjectStore(db, home, objects);
    expect(frameBucket(db)).toBe('s3://memory/test');
    expect(() => useObjectStore(db, home, memoryObjects('s3://other/test'))).toThrow(
      /keeps its sealed frames in s3:\/\/memory\/test, not s3:\/\/other\/test/,
    );
    useObjectStore(db, home, memoryObjects('s3://memory/test'));
  });

  it('seals frames into the bucket under their keys, and none on disk', async () => {
    useObjectStore(db, home, objects);
    for (let n = 0; n < 12; n += 3) {
      write(n, n + 3);
      await syncSource(ctx(), fakeAdapter(src));
    }
    const sealed = chunks();
    expect(sealed.length).toBeGreaterThan(1);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(false);
    expect([...objects.objects.keys()]).toEqual(
      sealed.map((c) => frameKey(mirrorName(), c.frame_offset)),
    );
    for (const c of sealed) {
      const frame = objects.objects.get(frameKey(mirrorName(), c.frame_offset))!;
      expect(frame.length).toBe(c.frame_length);
      expect(zlib.zstdDecompressSync(frame).length).toBe(c.byte_length);
    }
    expectIntact(12);
    // Storage is counted as before: frames as stored, wherever they are.
    const tail = fs.statSync(`${mirrorBase()}.tail`).size;
    const framesSize = sealed.reduce((n, c) => n + c.frame_length, 0);
    expect(storeUsage(db, home).mirrorStoredBytes.local).toBe(framesSize + tail);
  });

  it('seals the tail of a file that stopped growing into the bucket', async () => {
    useObjectStore(db, home, objects);
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    expect(objects.objects.size).toBe(0);
    db.prepare('UPDATE raw_file SET updated_at = ?').run(Date.now() - IDLE_SEAL_MS - 1);
    await syncSource(ctx(), fakeAdapter(src));
    expect(objects.objects.size).toBe(1);
    expect(fs.statSync(`${mirrorBase()}.tail`).size).toBe(0);
    expectIntact(2);
  });

  it('recovers from a crash after uploading a frame, before the transaction commits', async () => {
    useObjectStore(db, home, objects);
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    write(2, 8); // reaches the frame size: this sync seals
    const exec = db.exec.bind(db);
    db.exec = (s: string) => {
      if (s === 'COMMIT') throw new Error('simulated crash');
      return exec(s);
    };
    try {
      await expect(syncSource(ctx(), fakeAdapter(src))).rejects.toThrow('simulated crash');
    } finally {
      db.exec = exec;
    }
    // The frame is in the bucket, but the database records neither it nor the new lines.
    expect(chunks()).toEqual([]);
    const key = frameKey(mirrorName(), 0);
    const uncommitted = objects.objects.get(key)!;
    expect(uncommitted).toBeDefined();
    expect(getEvent(db, 'fake:z2')).toBeNull();

    // The next seal cuts its frames elsewhere (a smaller frame size): a different frame lands
    // under the same key, replacing the one nothing records.
    write(8, 9);
    await syncSource({ db, home, frameBytes: FRAME / 2 }, fakeAdapter(src));
    const [first] = chunks();
    expect(first?.frame_offset).toBe(0);
    expect(objects.objects.get(key)!.equals(uncommitted)).toBe(false);
    expect(objects.objects.get(key)!.length).toBe(first?.frame_length);
    // This process reads the new frame, not the one it kept in memory, and so does any other.
    expect(mirrorText(db, home, rawFileOf())).toBe(fs.readFileSync(file(), 'utf8'));
    expectIntact(9);
  });

  it('reads each frame from the bucket once while it stays in memory', async () => {
    useObjectStore(db, home, objects);
    write(0, 12);
    await syncSource(ctx(), fakeAdapter(src));
    // A new process: nothing in memory yet.
    useObjectStore(db, home, objects);
    const e = getEvent(db, 'fake:z1')!;
    const gets = objects.gets;
    for (let i = 0; i < 5; i++) readRawLine(db, home, rawLocator(db, home, e)!);
    expect(objects.gets).toBe(gets + 1);
    // With no room in memory, every read goes to the bucket.
    useObjectStore(db, home, objects, { cacheBytes: 0 });
    for (let i = 0; i < 3; i++) readRawLine(db, home, rawLocator(db, home, e)!);
    expect(objects.gets).toBe(gets + 4);
  });

  it('reports a frame that cannot be reached as an error, not as a missing line', async () => {
    useObjectStore(db, home, objects);
    write(0, 12);
    await syncSource(ctx(), fakeAdapter(src));
    useObjectStore(db, home, {
      location: objects.location,
      put: () => {
        throw new Error('bucket unreachable');
      },
      get: () => {
        throw new Error('bucket unreachable');
      },
    });
    const e = getEvent(db, 'fake:z1')!;
    expect(() => readRawLine(db, home, rawLocator(db, home, e)!)).toThrow('bucket unreachable');
    // A frame the bucket does not have is missing: the line is reported missing (invariant 1).
    useObjectStore(db, home, memoryObjects());
    expect(readRawLine(db, home, rawLocator(db, home, e)!)).toBeNull();
  });

  it('keeps reading frames sealed on disk before, and moves them to the bucket', async () => {
    // First without a bucket: frames on disk, and a crash leaves an unrecorded frame there too.
    write(0, 9);
    await syncSource(ctx(), fakeAdapter(src));
    const onDisk = fs.statSync(`${mirrorBase()}.zst`).size;
    expect(onDisk).toBeGreaterThan(0);
    fs.appendFileSync(`${mirrorBase()}.zst`, 'left by a write that never committed');

    // Then with one: new frames go to the bucket, old ones are read from disk.
    useObjectStore(db, home, objects);
    write(9, 18);
    await syncSource(ctx(), fakeAdapter(src));
    expect(fs.statSync(`${mirrorBase()}.zst`).size).toBe(onDisk); // the stray bytes are cut
    const sealed = chunks();
    const inBucket = sealed.filter((c) => c.frame_offset >= onDisk);
    expect(inBucket.length).toBeGreaterThan(0);
    expect(objects.objects.size).toBe(inBucket.length);
    expectIntact(18);

    // Moving them: verified, listed as removable, but kept until asked.
    const first = await uploadFrames(db, home);
    expect(first).toMatchObject({
      mirrors: 1,
      frames: sealed.length - inBucket.length,
      uploaded: sealed.length - inBucket.length,
      removed: 0,
      failed: [],
      stopped: null,
    });
    expect(first.removable).toEqual([{ mirror: mirrorName(), bytes: onDisk }]);
    expect(objects.objects.size).toBe(sealed.length);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(true);
    // Running it again uploads nothing, and removes the file now that it is asked to.
    const puts = objects.puts;
    expect(await uploadFrames(db, home, { remove: true })).toMatchObject({
      uploaded: 0,
      removed: 1,
    });
    expect(objects.puts).toBe(puts);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(false);
    expectIntact(18);
    expect(await uploadFrames(db, home, { remove: true })).toMatchObject({ mirrors: 0, frames: 0 });

    // Sealing goes on into the bucket.
    write(18, 27);
    await syncSource(ctx(), fakeAdapter(src));
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(false);
    expectIntact(27);
  });

  it('never removes a file whose frames it could not verify in the bucket', async () => {
    write(0, 12);
    await syncSource(ctx(), fakeAdapter(src));
    useObjectStore(db, home, objects);
    objects.corrupt = true;
    const wrong = await uploadFrames(db, home, { remove: true });
    expect(wrong).toMatchObject({ frames: 0, removable: [], removed: 0, stopped: null });
    expect(wrong.failed.length).toBeGreaterThan(0);
    for (const f of wrong.failed) expect(f.reason).toMatch(/differs from what was uploaded/);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(true);
    // A damaged frame on disk is never uploaded.
    objects.corrupt = false;
    objects.objects.clear();
    const zst = `${mirrorBase()}.zst`;
    const bytes = fs.readFileSync(zst);
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] as number) ^ 0xff;
    fs.writeFileSync(zst, bytes);
    const last = chunks().at(-1)!;
    const damaged = await uploadFrames(db, home, { remove: true });
    expect(damaged.failed).toEqual([
      {
        mirror: mirrorName(),
        key: frameKey(mirrorName(), last.frame_offset),
        reason: expect.stringMatching(/damaged frame/),
      },
    ]);
    expect(damaged).toMatchObject({ removable: [], removed: 0, stopped: null });
    expect(objects.objects.has(frameKey(mirrorName(), last.frame_offset))).toBe(false);
    expect(fs.existsSync(zst)).toBe(true);
  });

  it('needs a bucket to move frames to', async () => {
    await expect(uploadFrames(db, home)).rejects.toThrow(/give it a bucket first/);
  });

  describe('moving frames several at a time', () => {
    /** Frames on disk in `files` mirrors, sealed before the store used the bucket. */
    const onDisk = async (files: number) => {
      for (let f = 0; f < files; f++) {
        let text = '';
        for (let i = 0; i < 12; i++)
          text += line(
            `m${f}-${i}`,
            `m${f}`,
            1000 + i,
            'user',
            `${f} ${i} ${'数据'.repeat(i % 9)}`,
          );
        fs.writeFileSync(path.join(src, `m${f}.jsonl`), text);
      }
      await syncSource(ctx(), fakeAdapter(src));
      return (db.prepare('SELECT COUNT(*) AS n FROM raw_chunk').get() as { n: number }).n;
    };
    /** A bucket whose transfers take a few milliseconds each, without blocking. */
    const slowBucket = () => {
      const base = memoryObjects();
      const bucket = Object.assign(base, {
        inFlight: 0,
        maxInFlight: 0,
        /** Throws for a key, or for any key, as a bucket that fails would. */
        failPut: null as ((key: string) => Error | null) | null,
        /** Returns other bytes than were written for this key. */
        wrongKey: null as string | null,
        async transfer<T>(run: () => T): Promise<T> {
          bucket.inFlight++;
          bucket.maxInFlight = Math.max(bucket.maxInFlight, bucket.inFlight);
          try {
            await new Promise((resolve) => setTimeout(resolve, 3));
            return run();
          } finally {
            bucket.inFlight--;
          }
        },
        putAsync(key: string, data: Buffer) {
          return bucket.transfer(() => {
            const error = bucket.failPut?.(key);
            if (error) throw error;
            base.put(key, data);
          });
        },
        getAsync(key: string) {
          return bucket.transfer(() => {
            const data = base.get(key);
            return data && key === bucket.wrongKey ? Buffer.from('not the frame') : data;
          });
        },
      });
      return bucket;
    };

    it('never moves more frames at once than asked, and moves them all', async () => {
      const total = await onDisk(5);
      expect(total).toBeGreaterThan(10);
      const bucket = slowBucket();
      useObjectStore(db, home, bucket);
      const seen: number[] = [];
      const r = await uploadFrames(db, home, {
        concurrency: 3,
        remove: true,
        progress: (p) => seen.push(p.frames),
      });
      expect(bucket.maxInFlight).toBe(3);
      expect(r).toMatchObject({ mirrors: 5, frames: total, uploaded: total, removed: 5 });
      expect(r.failed).toEqual([]);
      expect(r.removable.map((f) => f.mirror)).toEqual(
        [0, 1, 2, 3, 4].map((f) => path.join('fake', `m${f}.jsonl`)),
      );
      expect(seen).toEqual(Array.from({ length: total + 1 }, (_, i) => i));
      expect(bucket.objects.size).toBe(total);
      for (let f = 0; f < 5; f++)
        expect(fs.existsSync(path.join(home, 'raw', 'fake', `m${f}.jsonl.zst`))).toBe(false);
      // Every line reads back from the bucket alone.
      useObjectStore(db, home, bucket, { cacheBytes: 0 });
      for (let f = 0; f < 5; f++) {
        for (let i = 0; i < 12; i++) {
          const e = getEvent(db, `fake:m${f}-${i}`)!;
          expect(readRawLine(db, home, rawLocator(db, home, e)!)).toContain(`"${f} ${i} `);
        }
      }
    });

    it('reports a frame that fails, keeps its file, and moves the others', async () => {
      const total = await onDisk(3);
      const bucket = slowBucket();
      useObjectStore(db, home, bucket);
      const bad = path.join('fake', 'm1.jsonl');
      bucket.wrongKey = frameKey(bad, 0);
      const r = await uploadFrames(db, home, { concurrency: 4, remove: true });
      expect(r.failed).toEqual([
        { mirror: bad, key: frameKey(bad, 0), reason: expect.stringMatching(/differs from/) },
      ]);
      expect(r.stopped).toBeNull();
      expect(r.removable.map((f) => f.mirror)).toEqual([
        path.join('fake', 'm0.jsonl'),
        path.join('fake', 'm2.jsonl'),
      ]);
      expect(fs.existsSync(path.join(home, 'raw', `${bad}.zst`))).toBe(true);
      // The other mirrors' frames are in the bucket, byte for byte, and read from there.
      useObjectStore(db, home, bucket, { cacheBytes: 0 });
      for (const f of [0, 2]) {
        for (let i = 0; i < 12; i++) {
          const e = getEvent(db, `fake:m${f}-${i}`)!;
          expect(readRawLine(db, home, rawLocator(db, home, e)!)).toContain(`"${f} ${i} `);
        }
      }
      // Once the bucket behaves, a second run moves only what is left.
      bucket.wrongKey = null;
      const puts = bucket.puts;
      const again = await uploadFrames(db, home, { concurrency: 4, remove: true });
      expect(again).toMatchObject({ mirrors: 1, failed: [], removed: 1 });
      expect(bucket.puts - puts).toBe(again.uploaded);
      expect(again.uploaded).toBeLessThan(total);
      expect(bucket.objects.size).toBe(total);
    });

    it('starts no frame after the bucket fails, and goes on from there the next time', async () => {
      const total = await onDisk(4);
      const bucket = slowBucket();
      useObjectStore(db, home, bucket);
      let puts = 0;
      bucket.failPut = () => (++puts > 4 ? new Error('connection refused') : null);
      const r = await uploadFrames(db, home, { concurrency: 2, remove: true });
      expect(r.stopped).toBe('connection refused');
      // The frames under way when it failed finished; none was started after.
      expect(r.frames).toBe(4);
      expect(r.failed.length).toBeLessThanOrEqual(2);
      expect(r.frames + r.failed.length).toBeLessThan(total);
      expect(bucket.objects.size).toBe(4);
      bucket.failPut = null;
      const again = await uploadFrames(db, home, { concurrency: 2, remove: true });
      // Files removed the first time are not counted again; what is left is uploaded once.
      expect(again).toMatchObject({ uploaded: total - 4, failed: [], stopped: null });
      expect(again.removed + r.removed).toBe(4);
      expect(bucket.objects.size).toBe(total);
      expect(bucket.puts).toBe(total); // each frame written once
    });
  });

  it('backs up the frames from the bucket into a backup that needs no bucket', async () => {
    write(0, 6);
    await syncSource(ctx(), fakeAdapter(src)); // some frames on disk
    useObjectStore(db, home, objects);
    write(6, 14);
    await syncSource(ctx(), fakeAdapter(src)); // and some in the bucket
    await uploadFrames(db, home, { remove: true }); // now all in the bucket
    write(14, 16);
    await syncSource(ctx(), fakeAdapter(src)); // and a tail
    const target = path.join(freshHome(), 'backup');
    const first = await backupStore(db, home, target);
    const framesSize = chunks().reduce((n, c) => n + c.frame_length, 0);
    const tail = fs.statSync(`${mirrorBase()}.tail`).size;
    expect(first.mirrorBytesCopied).toBe(framesSize + tail);
    const backedUp = path.join(target, 'raw', mirrorName());
    // Laid out as on disk: the frames one after another, exactly the objects' bytes.
    expect(fs.readFileSync(`${backedUp}.zst`)).toEqual(
      Buffer.concat(
        chunks().map((c) => objects.objects.get(frameKey(mirrorName(), c.frame_offset))!),
      ),
    );
    expect((await backupStore(db, home, target)).mirrorBytesCopied).toBe(0);

    // More frames: only they are copied.
    write(16, 30);
    await syncSource(ctx(), fakeAdapter(src));
    const second = await backupStore(db, home, target);
    const now = chunks().reduce((n, c) => n + c.frame_length, 0);
    expect(second.mirrorBytesCopied).toBe(
      now - framesSize + fs.statSync(`${mirrorBase()}.tail`).size,
    );

    // Restored without the bucket, every line reads from disk.
    const restored = freshHome();
    fs.cpSync(target, restored, { recursive: true });
    const copy = openDatabase(path.join(restored, 'origin.db'));
    try {
      expect(frameBucket(copy)).toBeNull();
      expect(frameStore(restored)).toBeInstanceOf(FileFrameStore);
      expect(mirrorText(copy, restored, getEvent(copy, 'fake:z0')!.rawFileId)).toBe(
        fs.readFileSync(file(), 'utf8'),
      );
      for (const i of [0, 7, 20, 29]) {
        const e = getEvent(copy, `fake:z${i}`)!;
        expect(readRawLine(copy, restored, rawLocator(copy, restored, e)!)).toBe(lineN(i).trim());
      }
    } finally {
      copy.close();
    }
  });
});
