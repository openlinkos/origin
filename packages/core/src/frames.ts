import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { rawDir } from './paths.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Where the sealed frames of a store's mirrors are kept (see docs/architecture.md#frame-stores).
 * mirror.ts decides what the frames are and records them in `raw_chunk`; a frame store only keeps
 * their bytes, at the offsets `raw_chunk` records, as if they were appended to one file per mirror.
 *
 * Every method is synchronous: node:sqlite is, and frames are written and read inside write
 * transactions (sealing, and an adapter's readLine while it parses a device's push).
 */
export interface FrameStore {
  /** Where the frames are, for messages: never credentials. */
  readonly location: string;
  /**
   * Under the write lock, with the size of the mirror's frames as the database records it: drop
   * what is stored past it, left by a write that never committed. Throws an OriginError if the
   * store holds less than the database records and so lost data.
   */
  repair(mirror: string, frameBytes: number): void;
  /**
   * Store the frames sealed by one append to a mirror, one after another from `offset` (where the
   * recorded frames end). They must be durable when this returns: the transaction that records
   * them commits next. Whatever a write that never committed left at these offsets is replaced.
   */
  write(mirror: string, offset: number, frames: Buffer[]): void;
  /**
   * The frame of `length` bytes at `offset`. Throws an OriginError if it is missing or shorter,
   * and any other error if the frame could not be reached.
   */
  read(mirror: string, offset: number, length: number): Buffer;
}

/**
 * A bucket of an object store (S3 in the CLI), holding objects by key. Synchronous, like the frame
 * stores built on it. Objects are only ever written, and written again under the same key only to
 * replace what a write that never committed left there; they are never deleted.
 */
export interface ObjectStore {
  /** The bucket and prefix, such as `s3://origin/hub`; recorded in the store, never credentials. */
  readonly location: string;
  /** Store `data` under `key`, replacing any object there. Durable when it returns. */
  put(key: string, data: Buffer): void;
  /** The object under `key`, or null if there is none. */
  get(key: string): Buffer | null;
}

export function framesPath(home: string, mirror: string): string {
  return `${path.join(rawDir(home), mirror)}.zst`;
}

/**
 * The object key of the frame at `offset` in a mirror's frames: `<mirror>.zst/<offset>`, with `/`
 * between path segments and the offset in at least 12 decimal digits, so that keys list in order.
 * The key is derived from what `raw_chunk` records, so a frame written again after a write that
 * never committed lands under the same key.
 */
export function frameKey(mirror: string, offset: number): string {
  return `${mirror.split(path.sep).join('/')}.zst/${String(offset).padStart(12, '0')}`;
}

/** The setting that records the bucket a store keeps its sealed frames in. */
const BUCKET_SETTING = 'raw.bucket';

/** The bucket this store keeps its sealed frames in, or null if it keeps them on disk. */
export function frameBucket(db: Database): string | null {
  return getSetting(db, BUCKET_SETTING);
}

/** Drop the record of a bucket from a database that holds all its frames on disk (backups). */
export function forgetFrameBucket(db: Database): void {
  db.prepare('DELETE FROM setting WHERE key = ?').run(BUCKET_SETTING);
}

/** Frame stores in use, by resolved ORIGIN_HOME; a store not listed keeps its frames on disk. */
const inUse = new Map<string, FrameStore>();

/** The frame store of the store at `home`. */
export function frameStore(home: string): FrameStore {
  return inUse.get(path.resolve(home)) ?? fileFrameStore(home);
}

/**
 * Most bytes of frames the bucket frame store keeps in memory. A frame holds about 1 MiB of lines,
 * which take 200 to 300 KiB compressed (up to about 1 MiB for data that does not compress, such as
 * screenshots), so this keeps at least 32 frames and usually over a hundred: enough for the
 * frames a hub reads again and again (the newest frame of each mirror a device is pushing, which
 * the next push reads for its tail hash, and the first frame, which some adapters read for every
 * chunk), at a small fraction of the hub's memory.
 */
export const FRAME_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Keep the sealed frames of the store at `home` in `objects` from now on, in this process (see
 * docs/architecture.md#frame-stores). The first time, records the bucket in the store, so that
 * every later process knows where its frames are; a store that records another bucket is refused.
 * Frames already on disk stay there and are read from there until they are moved (uploadFrames).
 */
export function useObjectStore(
  db: Database,
  home: string,
  objects: ObjectStore,
  opts: { cacheBytes?: number } = {},
): FrameStore {
  const recorded = frameBucket(db);
  if (recorded !== null && recorded !== objects.location) {
    throw new OriginError(
      `This store keeps its sealed frames in ${recorded}, not ${objects.location}; configure that bucket.`,
    );
  }
  if (recorded === null) setSetting(db, BUCKET_SETTING, objects.location);
  const store = bucketFrameStore(home, objects, opts);
  inUse.set(path.resolve(home), store);
  return store;
}

/** Stop using an object store for `home` in this process (tests, shutdown). */
export function releaseObjectStore(home: string): void {
  inUse.delete(path.resolve(home));
}

/**
 * Frames on disk, in `<mirror>.zst`, appended one after another: the layout of every store that
 * does not use a bucket.
 */
export class FileFrameStore implements FrameStore {
  readonly location: string;
  constructor(readonly home: string) {
    this.location = rawDir(home);
  }

  repair(mirror: string, frameBytes: number): void {
    repairFile(mirror, framesPath(this.home, mirror), frameBytes);
  }

  write(mirror: string, _offset: number, frames: Buffer[]): void {
    // repair() has cut the file to `offset`, so appending puts the frames there.
    const fd = fs.openSync(framesPath(this.home, mirror), 'a');
    try {
      for (const frame of frames) writeAll(fd, frame);
      // The frames must be on disk before the tail they replace is emptied.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  read(mirror: string, offset: number, length: number): Buffer {
    const frame = readLocal(framesPath(this.home, mirror), offset, length);
    if (!frame) {
      throw new OriginError(`The mirror ${mirror} is missing sealed data; the store is damaged.`);
    }
    return frame;
  }
}

export function fileFrameStore(home: string): FileFrameStore {
  return new FileFrameStore(home);
}

/**
 * Frames in a bucket, one object per frame under frameKey(). Frames that were sealed before the
 * store used the bucket stay in `<mirror>.zst` until they are moved, and are read from there:
 * that file only ever holds a prefix of the frames, since every frame sealed since goes to the
 * bucket. Frames written or read lately are kept in memory (FRAME_CACHE_BYTES).
 */
export class BucketFrameStore implements FrameStore {
  readonly location: string;
  private readonly cache: FrameCache;
  constructor(
    readonly home: string,
    readonly objects: ObjectStore,
    cacheBytes: number,
  ) {
    this.location = objects.location;
    this.cache = new FrameCache(cacheBytes);
  }

  repair(mirror: string, frameBytes: number): void {
    // Bytes on disk past what the database records were left by a write that never committed,
    // before the store used the bucket. Cut them, so that the file never holds anything but frames
    // the database records; it may be shorter, since newer frames are in the bucket. Objects past
    // what the database records are not read, and are replaced by the next frames.
    const local = framesPath(this.home, mirror);
    if (fileSize(local) > frameBytes) fs.truncateSync(local, frameBytes);
  }

  write(mirror: string, offset: number, frames: Buffer[]): void {
    // Frames kept from a write that never committed are no longer what their keys hold.
    this.cache.dropFrom(mirror, offset);
    let at = offset;
    for (const frame of frames) {
      const key = frameKey(mirror, at);
      this.objects.put(key, frame);
      // A mirror's newest frame is read again soon: for the tail hash of the next push, say.
      this.cache.set(key, frame);
      at += frame.length;
    }
  }

  read(mirror: string, offset: number, length: number): Buffer {
    const key = frameKey(mirror, offset);
    const cached = this.cache.get(key, length);
    if (cached) return cached;
    const local = readLocal(framesPath(this.home, mirror), offset, length);
    if (local) return local;
    const frame = this.objects.get(key);
    if (frame === null) {
      throw new OriginError(
        `The mirror ${mirror} is missing the sealed frame ${key} in ${this.location}; the store is damaged.`,
      );
    }
    if (frame.length !== length) {
      throw new OriginError(
        `The sealed frame ${key} in ${this.location} has the wrong size; the store is damaged.`,
      );
    }
    this.cache.set(key, frame);
    return frame;
  }
}

export function bucketFrameStore(
  home: string,
  objects: ObjectStore,
  opts: { cacheBytes?: number } = {},
): BucketFrameStore {
  return new BucketFrameStore(home, objects, opts.cacheBytes ?? FRAME_CACHE_BYTES);
}

/** A frame from a file on disk, or null if the file does not hold it (moved to the bucket). */
function readLocal(file: string, offset: number, length: number): Buffer | null {
  try {
    const buf = readRange(file, offset, offset + length);
    return buf.length === length ? buf : null;
  } catch (err) {
    // Removed after its frames were moved to the bucket (uploadFrames).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Frames by key, least recently used first, up to a total size. */
class FrameCache {
  private readonly frames = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  get(key: string, length: number): Buffer | undefined {
    const frame = this.frames.get(key);
    if (!frame) return undefined;
    this.delete(key);
    if (frame.length !== length) return undefined;
    this.frames.set(key, frame);
    this.bytes += frame.length;
    return frame;
  }

  set(key: string, frame: Buffer): void {
    this.delete(key);
    if (frame.length > this.maxBytes) return;
    this.frames.set(key, frame);
    this.bytes += frame.length;
    for (const oldest of this.frames.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(oldest);
    }
  }

  /** Forget the frames of `mirror` at `offset` and past it. */
  dropFrom(mirror: string, offset: number): void {
    const prefix = frameKey(mirror, 0).slice(0, -12);
    for (const key of [...this.frames.keys()]) {
      if (key.startsWith(prefix) && Number(key.slice(prefix.length)) >= offset) this.delete(key);
    }
  }

  private delete(key: string): void {
    const frame = this.frames.get(key);
    if (!frame) return;
    this.frames.delete(key);
    this.bytes -= frame.length;
  }
}

/**
 * Cut `file` to `size` bytes if it is longer; throw if it is shorter: the mirror lost data, and
 * appending would break provenance (invariant 1).
 */
export function repairFile(mirror: string, file: string, size: number): void {
  const actual = fileSize(file);
  if (actual > size) fs.truncateSync(file, size);
  else if (actual < size) {
    throw new OriginError(
      `The mirror ${mirror} is shorter than the database records (${path.basename(file)}: ${actual} of ${size} bytes); the store is damaged.`,
    );
  }
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Bytes `[start, end)` of a file; shorter if the file is. */
export function readRange(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return off === buf.length ? buf : buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeAll(fd: number, buf: Buffer): void {
  for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
}
