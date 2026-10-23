import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { type FrameStore, type ObjectStore, OriginError, rawDir } from '../src/index.js';

/**
 * What every frame store must do (see frames.ts), whatever keeps the bytes. Run against the
 * filesystem store, a bucket over memory (frames.test.ts), and a bucket over S3 (cli s3.test.ts).
 * `make` gives a fresh store over a fresh ORIGIN_HOME.
 */
export function frameStoreContract(
  make: () => Promise<{ store: FrameStore; home: string }> | { store: FrameStore; home: string },
  opts: { detectsLoss: boolean },
): void {
  const frames = (...sizes: number[]) =>
    sizes.map((n, i) => Buffer.alloc(n, String.fromCharCode(97 + i)));
  // As appendMirror does, the mirror's directory exists before frames are written.
  const prepare = (home: string, mirror: string) =>
    fs.mkdirSync(path.dirname(path.join(rawDir(home), mirror)), { recursive: true });
  const MIRROR = path.join('devices', 'laptop', 'claude-code', '项目 a+b', 'session (1).jsonl');

  it('reads back each frame it wrote, at its offset', async () => {
    const { store, home } = await make();
    prepare(home, MIRROR);
    const [a, b, c] = frames(10, 25, 7) as [Buffer, Buffer, Buffer];
    store.repair(MIRROR, 0);
    store.write(MIRROR, 0, [a, b]);
    store.repair(MIRROR, 35);
    store.write(MIRROR, 35, [c]);
    expect(store.read(MIRROR, 0, 10)).toEqual(a);
    expect(store.read(MIRROR, 10, 25)).toEqual(b);
    expect(store.read(MIRROR, 35, 7)).toEqual(c);
  });

  it('replaces what a write that never committed left at the same offset', async () => {
    const { store, home } = await make();
    prepare(home, MIRROR);
    const [a, uncommitted, b] = frames(10, 40, 12) as [Buffer, Buffer, Buffer];
    store.write(MIRROR, 0, [a]);
    store.write(MIRROR, 10, [uncommitted]);
    expect(store.read(MIRROR, 10, 40)).toEqual(uncommitted);
    // The transaction that recorded it rolled back: the database records only `a`.
    store.repair(MIRROR, 10);
    store.write(MIRROR, 10, [b]);
    expect(store.read(MIRROR, 0, 10)).toEqual(a);
    expect(store.read(MIRROR, 10, 12)).toEqual(b);
  });

  it('throws an OriginError for a frame it does not hold', async () => {
    const { store, home } = await make();
    prepare(home, MIRROR);
    expect(() => store.read(path.join('codex', 'never-written.jsonl'), 0, 10)).toThrow(OriginError);
    store.write(MIRROR, 0, frames(10));
    expect(() => store.read(MIRROR, 10, 10)).toThrow(OriginError);
  });

  it(
    opts.detectsLoss
      ? 'refuses to go on from frames it lost'
      : 'cannot tell lost frames from frames in the bucket',
    async () => {
      const { store, home } = await make();
      prepare(home, MIRROR);
      store.write(MIRROR, 0, frames(10));
      if (opts.detectsLoss) {
        expect(() => store.repair(MIRROR, 20)).toThrow(/the store is damaged/);
      } else {
        expect(() => store.repair(MIRROR, 20)).not.toThrow();
      }
    },
  );
}

/** An object store in memory, counting its calls; `corrupt` makes it return other bytes. */
export function memoryObjects(location = 's3://memory/test'): ObjectStore & {
  objects: Map<string, Buffer>;
  gets: number;
  puts: number;
  corrupt: boolean;
} {
  const objects = new Map<string, Buffer>();
  const store = {
    location,
    objects,
    gets: 0,
    puts: 0,
    corrupt: false,
    put(key: string, data: Buffer) {
      store.puts++;
      objects.set(key, Buffer.from(data));
    },
    get(key: string) {
      store.gets++;
      const data = objects.get(key);
      if (!data) return null;
      return store.corrupt ? Buffer.concat([data.subarray(1), Buffer.from('x')]) : data;
    },
  };
  return store;
}
