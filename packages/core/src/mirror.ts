import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { type Database, transaction } from './db.js';
import { OriginError } from './errors.js';
import {
  BucketFrameStore,
  FileFrameStore,
  fileSize,
  frameKey,
  frameStore,
  framesPath,
  readRange,
  repairFile,
  writeAll,
} from './frames.js';
import { rawDir } from './paths.js';

/**
 * Raw mirrors on disk (see docs/architecture.md#storage). The content of a mirror is the ingested
 * bytes of one generation of a file: complete lines that only ever grow (invariant 3). It is stored
 * in two files next to the mirror's name `<raw>/<mirror>`:
 *
 * - `<mirror>.zst`, the sealed frames: independent zstd frames, each holding complete lines,
 *   appended in order. Each frame is recorded in `raw_chunk` with its first line, its line count,
 *   its offset and length in the content, and its offset and length in the file, so that one line
 *   is read by decompressing one frame.
 * - `<mirror>.tail`, the open tail: the newest lines, uncompressed, that do not fill a frame yet.
 *
 * The content is the decompressed frames followed by the tail, both up to what the database
 * records: `raw_chunk` for the frames, and `raw_file.bytes_ingested` for the end. Bytes past that,
 * left by a write that never committed, are not part of the mirror and are dropped by the next
 * write. Every read and write of `raw/` goes through this module and its frame store (frames.ts),
 * which keeps the sealed frames in `<mirror>.zst` or, on a hub given one, in a bucket.
 */

/** A frame is sealed once the open tail reaches this many bytes. */
export const FRAME_BYTES = 1024 * 1024;

const ZSTD_PARAMS = {
  params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 3,
    [zlib.constants.ZSTD_c_checksumFlag]: 1,
  },
};

/** Where a mirror stands, as the database records it. */
export interface MirrorState {
  rawFileId: number;
  /** The mirror's name, relative to raw/. */
  mirror: string;
  /** Content size and line count (`raw_file.bytes_ingested`, `lines_ingested`). */
  bytes: number;
  lines: number;
  /** Content and lines in sealed frames; the tail holds the rest. */
  sealedBytes: number;
  sealedLines: number;
  /** Size of the sealed frames in `<mirror>.zst`. */
  frameBytes: number;
}

/** One sealed frame, as `raw_chunk` records it. */
interface Chunk {
  first_line: number;
  line_count: number;
  byte_offset: number;
  byte_length: number;
  frame_offset: number;
  frame_length: number;
}

const CHUNK_COLUMNS =
  'first_line, line_count, byte_offset, byte_length, frame_offset, frame_length';

export function tailPath(home: string, mirror: string): string {
  return `${path.join(rawDir(home), mirror)}.tail`;
}

/** Mirror states, each read with its last frame in one statement, so that its parts agree. */
const STATE_QUERY = `SELECT r.id, r.mirror, r.bytes_ingested, r.lines_ingested,
         c.byte_offset + c.byte_length AS sealed_bytes,
         c.first_line + c.line_count - 1 AS sealed_lines,
         c.frame_offset + c.frame_length AS frame_bytes
  FROM raw_file r
  LEFT JOIN raw_chunk c ON c.raw_file_id = r.id
    AND c.first_line = (SELECT MAX(first_line) FROM raw_chunk WHERE raw_file_id = r.id)`;

interface StateRow {
  id: number;
  mirror: string;
  bytes_ingested: number;
  lines_ingested: number;
  sealed_bytes: number | null;
  sealed_lines: number | null;
  frame_bytes: number | null;
}

function toState(row: StateRow): MirrorState {
  return {
    rawFileId: row.id,
    mirror: row.mirror,
    bytes: row.bytes_ingested,
    lines: row.lines_ingested,
    sealedBytes: row.sealed_bytes ?? 0,
    sealedLines: row.sealed_lines ?? 0,
    frameBytes: row.frame_bytes ?? 0,
  };
}

/** The state of a mirror, as the database records it now. */
export function mirrorState(db: Database, rawFileId: number): MirrorState | null {
  const row = db.prepare(`${STATE_QUERY} WHERE r.id = ?`).get(rawFileId) as StateRow | undefined;
  return row ? toState(row) : null;
}

/** The state of every mirror of a store, from one consistent read. */
export function allMirrorStates(db: Database): MirrorState[] {
  return (db.prepare(`${STATE_QUERY} ORDER BY r.id`).all() as unknown as StateRow[]).map(toState);
}

/** Whether a mirror has a sealed frame ending at `frameBytes` in its file and `bytes` in its content. */
export function hasFrameBoundary(
  db: Database,
  rawFileId: number,
  frameBytes: number,
  bytes: number,
): boolean {
  if (frameBytes === 0) return bytes === 0;
  return (
    db
      .prepare(
        `SELECT 1 FROM raw_chunk WHERE raw_file_id = ? AND byte_offset + byte_length = ?
           AND frame_offset + frame_length = ?`,
      )
      .get(rawFileId, bytes, frameBytes) !== undefined
  );
}

/** Bytes of the sealed frames, as the database records them now. */
function sealedNow(db: Database, rawFileId: number): number {
  const row = db
    .prepare(
      `SELECT byte_offset + byte_length AS sealed FROM raw_chunk WHERE raw_file_id = ?
       ORDER BY first_line DESC LIMIT 1`,
    )
    .get(rawFileId) as { sealed: number } | undefined;
  return row?.sealed ?? 0;
}

/**
 * Reads of the tail are checked against concurrent sealing: a write in another process may seal
 * the tail into a frame and then empty it, after this process read the mirror's state. The tail
 * bytes are valid only if no frame was sealed in the meantime; otherwise the read starts over.
 */
const READ_ATTEMPTS = 5;

/** The uncompressed content of one sealed frame. */
function readFrame(home: string, mirror: string, c: Chunk): Buffer {
  return decompressFrame(mirror, c, frameStore(home).read(mirror, c.frame_offset, c.frame_length));
}

/** A sealed frame's content, checked against what `raw_chunk` records. */
function decompressFrame(mirror: string, c: Chunk, frame: Buffer): Buffer {
  let data: Buffer;
  try {
    data = zlib.zstdDecompressSync(frame);
  } catch (err) {
    throw new OriginError(
      `The mirror ${mirror} has a damaged frame at ${c.frame_offset}: ${(err as Error).message}`,
    );
  }
  if (data.length !== c.byte_length) {
    throw new OriginError(
      `The mirror ${mirror} has a frame of the wrong size; the store is damaged.`,
    );
  }
  return data;
}

/** Bytes `[from, to)` of the tail, or null if it is shorter (emptied by a concurrent seal). */
function readTail(home: string, st: MirrorState, from: number, to: number): Buffer | null {
  if (to <= from) return Buffer.alloc(0);
  let buf: Buffer;
  try {
    buf = readRange(tailPath(home, st.mirror), from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return buf.length === to - from ? buf : null;
}

/**
 * Line `line` (1-based) of a mirror, without its line break, or null if the mirror has no such line
 * or its data is missing (invariant 1, provenance). Decompresses at most one frame.
 */
export function readMirrorLine(
  db: Database,
  home: string,
  rawFileId: number,
  line: number,
): string | null {
  if (!Number.isInteger(line) || line < 1) return null;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const st = mirrorState(db, rawFileId);
    if (!st || line > st.lines) return null;
    try {
      if (line <= st.sealedLines) {
        const c = db
          .prepare(
            `SELECT ${CHUNK_COLUMNS} FROM raw_chunk WHERE raw_file_id = ? AND first_line <= ?
             ORDER BY first_line DESC LIMIT 1`,
          )
          .get(rawFileId, line) as Chunk | undefined;
        if (!c) return null;
        // Sealed frames never change: no need to check for a concurrent seal.
        return lineAt(readFrame(home, st.mirror, c), line - c.first_line + 1);
      }
      const tail = readTail(home, st, 0, st.bytes - st.sealedBytes);
      if (tail && sealedNow(db, rawFileId) === st.sealedBytes) {
        return lineAt(tail, line - st.sealedLines);
      }
    } catch (err) {
      if (err instanceof OriginError) return null;
      throw err;
    }
  }
  return null;
}

/**
 * Bytes `[start, end)` of a mirror's content (clipped to its size), decompressing the frames they
 * span. Throws an OriginError if the mirror's data is missing or damaged.
 */
export function readMirror(
  db: Database,
  home: string,
  rawFileId: number,
  start: number,
  end: number,
): Buffer {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const st = mirrorState(db, rawFileId);
    if (!st) throw new OriginError(`Unknown raw file ${rawFileId}.`);
    const to = Math.min(end, st.bytes);
    const from = Math.max(0, start);
    if (to <= from) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    if (from < st.sealedBytes) {
      const chunks = db
        .prepare(
          `SELECT ${CHUNK_COLUMNS} FROM raw_chunk WHERE raw_file_id = ? AND byte_offset < ?
             AND byte_offset >= COALESCE((SELECT MAX(byte_offset) FROM raw_chunk
                                          WHERE raw_file_id = ? AND byte_offset <= ?), 0)
           ORDER BY byte_offset`,
        )
        .all(rawFileId, Math.min(to, st.sealedBytes), rawFileId, from) as unknown as Chunk[];
      for (const c of chunks) {
        const data = readFrame(home, st.mirror, c);
        parts.push(
          data.subarray(
            Math.max(0, from - c.byte_offset),
            Math.min(c.byte_length, to - c.byte_offset),
          ),
        );
      }
    }
    if (to > st.sealedBytes) {
      const tail = readTail(
        home,
        st,
        Math.max(from, st.sealedBytes) - st.sealedBytes,
        to - st.sealedBytes,
      );
      if (!tail || sealedNow(db, rawFileId) !== st.sealedBytes) continue;
      parts.push(tail);
    }
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }
  throw new OriginError(`The mirror of raw file ${rawFileId} kept changing while it was read.`);
}

/**
 * Complete lines of a mirror's content starting at `offset`: at most `maxBytes`, or one longer
 * line. Empty at the end of the content.
 */
export function readMirrorLines(
  db: Database,
  home: string,
  rawFileId: number,
  offset: number,
  maxBytes: number,
): Buffer {
  let size = maxBytes;
  for (;;) {
    const data = readMirror(db, home, rawFileId, offset, offset + size);
    if (data.length === 0) return data;
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl >= 0) return data.subarray(0, lastNl + 1);
    if (data.length < size) throw new OriginError('The mirror does not end with a line break.');
    size *= 2;
  }
}

/**
 * Call `fn` with each line of a mirror that contains one of `needles`, in order, with its 1-based
 * line number, for a data migration that parses some lines again (see reparse.ts). Each sealed
 * frame is decompressed once, and lines without a needle are never decoded. Throws an OriginError
 * if the mirror's data is missing, and any other error if a frame could not be reached.
 */
export function scanMirrorLines(
  db: Database,
  home: string,
  rawFileId: number,
  needles: string[],
  fn: (line: string, lineNo: number) => void,
): void {
  const st = mirrorState(db, rawFileId);
  if (!st || st.lines === 0) return;
  const patterns = needles.map((n) => Buffer.from(n, 'utf8'));
  const chunks = db
    .prepare(`SELECT ${CHUNK_COLUMNS} FROM raw_chunk WHERE raw_file_id = ? ORDER BY first_line`)
    .all(rawFileId) as unknown as Chunk[];
  for (const c of chunks) {
    scanLines(readFrame(home, st.mirror, c), c.first_line, patterns, fn);
  }
  if (st.bytes > st.sealedBytes) {
    const tail = readMirror(db, home, rawFileId, st.sealedBytes, st.bytes);
    scanLines(tail, st.sealedLines + 1, patterns, fn);
  }
}

/** The lines of `buf`, complete lines of which the first is line `first`, that hold a pattern. */
function scanLines(
  buf: Buffer,
  first: number,
  patterns: Buffer[],
  fn: (line: string, lineNo: number) => void,
): void {
  const starts = new Set<number>();
  for (const p of patterns) {
    let at = buf.indexOf(p);
    while (at >= 0) {
      starts.add(at === 0 ? 0 : buf.lastIndexOf(0x0a, at - 1) + 1);
      const end = buf.indexOf(0x0a, at);
      at = end < 0 ? -1 : buf.indexOf(p, end + 1);
    }
  }
  let lineNo = first;
  let pos = 0;
  for (const start of [...starts].sort((a, b) => a - b)) {
    for (let nl = buf.indexOf(0x0a, pos); nl >= 0 && nl < start; nl = buf.indexOf(0x0a, pos)) {
      lineNo++;
      pos = nl + 1;
    }
    const end = buf.indexOf(0x0a, start);
    let line = buf.toString('utf8', start, end < 0 ? buf.length : end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    fn(line, lineNo);
  }
}

/**
 * Drop bytes past what the database records (left by a write that never committed, or by a crash
 * between sealing the tail and emptying it), so that the next write appends at the right place.
 * Throws if a file holds less than the database records: the mirror lost data, and appending would
 * break provenance. Must run under the write lock.
 */
export function repairMirror(home: string, st: MirrorState): void {
  frameStore(home).repair(st.mirror, st.frameBytes);
  repairFile(st.mirror, tailPath(home, st.mirror), st.bytes - st.sealedBytes);
}

/**
 * Append complete lines to a mirror. Lines go to the open tail until it would reach `frameBytes`;
 * then the tail and the new lines are sealed into frames of about that size, flushed to disk, and
 * recorded in `raw_chunk`, and the tail is left to be emptied once the transaction has committed
 * (see settleMirror). `seal` seals the tail and the lines whatever their size (see
 * sealIdleMirrors). Sealing never changes the content (invariant 3). Must run inside a write
 * transaction, which also advances `raw_file`'s cursor when there are new lines. Returns whether
 * frames were sealed.
 */
export function appendMirror(
  db: Database,
  home: string,
  st: MirrorState,
  data: Buffer,
  frameBytes = FRAME_BYTES,
  seal = false,
): boolean {
  fs.mkdirSync(path.dirname(path.join(rawDir(home), st.mirror)), { recursive: true });
  repairMirror(home, st);
  const tailLength = st.bytes - st.sealedBytes;
  if (tailLength + data.length === 0) return false;
  if (!seal && tailLength + data.length < frameBytes) {
    fs.appendFileSync(tailPath(home, st.mirror), data);
    return false;
  }
  const tail = tailLength > 0 ? readRange(tailPath(home, st.mirror), 0, tailLength) : null;
  const content = tail ? Buffer.concat([tail, data]) : data;
  const insert = db.prepare(
    `INSERT INTO raw_chunk (raw_file_id, ${CHUNK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const frames: Buffer[] = [];
  let start = 0;
  let line = st.sealedLines + 1;
  let frameOffset = st.frameBytes;
  for (const end of frameEnds(content, frameBytes)) {
    const piece = content.subarray(start, end);
    const frame = zlib.zstdCompressSync(piece, ZSTD_PARAMS);
    frames.push(frame);
    const lines = countLines(piece);
    insert.run(
      st.rawFileId,
      line,
      lines,
      st.sealedBytes + start,
      piece.length,
      frameOffset,
      frame.length,
    );
    line += lines;
    frameOffset += frame.length;
    start = end;
  }
  // Stored, and durable, before the transaction that records them commits: on disk or in the
  // bucket, the frames must be there before the tail they replace is emptied.
  frameStore(home).write(st.mirror, st.frameBytes, frames);
  return true;
}

/**
 * After a transaction that sealed frames has committed: make the commit durable, then empty the
 * tail under the write lock. If the commit cannot be made durable here, the tail is left as it is;
 * its bytes are past what the database records, so readers ignore them, and the next write to the
 * mirror drops them.
 */
export function settleMirror(db: Database, home: string, rawFileId: number): void {
  settleMirrors(db, home, [rawFileId]);
}

function settleMirrors(db: Database, home: string, rawFileIds: number[]): void {
  if (rawFileIds.length === 0 || !syncWriteAheadLog(db)) return;
  transaction(
    db,
    () => {
      for (const id of rawFileIds) {
        const st = mirrorState(db, id);
        if (st) repairMirror(home, st);
      }
    },
    { immediate: true },
  );
}

/**
 * A mirror whose file has not grown for this long is likely finished: its open tail is sealed too,
 * so that files smaller than a frame, and the last lines of every file, are stored compressed.
 */
export const IDLE_SEAL_MS = 60 * 60_000;

/** Most mirrors, and most tail bytes, sealed in one write transaction. */
const IDLE_SEAL_BATCH = { mirrors: 32, bytes: 4 * 1024 * 1024 };

/**
 * Seal the open tails of mirrors that have not grown since `before` (`raw_file.updated_at`): this
 * store's own files, or with `remote`, those replicated from devices; optionally of one source.
 * A tail sealed this way may make a frame smaller than FRAME_BYTES; lines appended later start a
 * new tail. Seals in short write transactions of a few mirrors each. Returns how many it sealed.
 */
export function sealIdleMirrors(
  db: Database,
  home: string,
  opts: { before: number; remote: boolean; source?: string; frameBytes?: number },
): number {
  const idle = `r.updated_at < ? AND (substr(r.path, 1, 1) = '@') = ?
    AND r.bytes_ingested > COALESCE((SELECT byte_offset + byte_length FROM raw_chunk
                                     WHERE raw_file_id = r.id ORDER BY first_line DESC LIMIT 1), 0)`;
  const params: Array<number | string> = [opts.before, opts.remote ? 1 : 0];
  const bySource = opts.source === undefined ? '' : ' AND r.source = ?';
  if (opts.source !== undefined) params.push(opts.source);
  const ids = (
    db
      .prepare(`SELECT r.id FROM raw_file r WHERE ${idle}${bySource} ORDER BY r.id`)
      .all(...params) as unknown as Array<{ id: number }>
  ).map((r) => r.id);
  const stillIdle = db.prepare(`SELECT 1 FROM raw_file r WHERE r.id = ? AND ${idle}`);
  let sealed = 0;
  for (let i = 0; i < ids.length; ) {
    const batch: number[] = [];
    transaction(
      db,
      () => {
        let bytes = 0;
        while (
          i < ids.length &&
          batch.length < IDLE_SEAL_BATCH.mirrors &&
          bytes < IDLE_SEAL_BATCH.bytes
        ) {
          const id = ids[i++] as number;
          // Checked again under the write lock: another process may have appended or sealed.
          if (!stillIdle.get(id, opts.before, opts.remote ? 1 : 0)) continue;
          const st = mirrorState(db, id) as MirrorState;
          if (appendMirror(db, home, st, Buffer.alloc(0), opts.frameBytes, true)) {
            batch.push(id);
            bytes += st.bytes - st.sealedBytes;
          }
        }
      },
      { immediate: true },
    );
    settleMirrors(db, home, batch);
    sealed += batch.length;
  }
  return sealed;
}

/** Flush the database's write-ahead log to disk; false if that failed. */
function syncWriteAheadLog(db: Database): boolean {
  const main = (
    db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>
  ).find((d) => d.name === 'main')?.file;
  if (!main) return true; // an in-memory database
  let fd: number;
  try {
    fd = fs.openSync(`${main}-wal`, 'r+');
  } catch (err) {
    // No log: the commit was checkpointed into the database, which a checkpoint flushes.
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  try {
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Disk usage of the mirrors: content size and stored size, for this store's files and devices'. */
export interface MirrorUsage {
  local: { bytes: number; storedBytes: number };
  remote: { bytes: number; storedBytes: number };
}

export function mirrorUsage(db: Database): MirrorUsage {
  const rows = db
    .prepare(
      `SELECT substr(r.path, 1, 1) = '@' AS remote,
              COALESCE(SUM(r.bytes_ingested), 0) AS bytes,
              COALESCE(SUM(r.bytes_ingested - COALESCE(c.sealed, 0) + COALESCE(c.frames, 0)), 0) AS stored
       FROM raw_file r
       LEFT JOIN (SELECT raw_file_id, SUM(byte_length) AS sealed, SUM(frame_length) AS frames
                  FROM raw_chunk GROUP BY raw_file_id) c ON c.raw_file_id = r.id
       GROUP BY 1`,
    )
    .all() as unknown as Array<{ remote: number; bytes: number; stored: number }>;
  const usage: MirrorUsage = {
    local: { bytes: 0, storedBytes: 0 },
    remote: { bytes: 0, storedBytes: 0 },
  };
  for (const r of rows) {
    usage[r.remote ? 'remote' : 'local'] = { bytes: r.bytes, storedBytes: r.stored };
  }
  return usage;
}

/** Frames are copied from a file on disk in pieces of this size. */
const COPY_CHUNK = 4 * 1024 * 1024;

/**
 * Write the sealed frames of mirror state `m` into `file`, laid out as `<mirror>.zst` (backups):
 * keep the first `have` bytes the file holds, and append the rest up to `m.frameBytes`. From a
 * bucket, frames are copied whole, so the copy starts at the frame that holds byte `have`.
 * Returns the bytes written.
 */
export function copyFrames(
  db: Database,
  home: string,
  m: MirrorState,
  file: string,
  have: number,
): number {
  const store = frameStore(home);
  let start = Math.min(have, m.frameBytes);
  let chunks: Chunk[] = [];
  if (!(store instanceof FileFrameStore)) {
    chunks = db
      .prepare(
        `SELECT ${CHUNK_COLUMNS} FROM raw_chunk WHERE raw_file_id = ?
           AND frame_offset + frame_length > ? AND frame_offset + frame_length <= ?
         ORDER BY frame_offset`,
      )
      .all(m.rawFileId, start, m.frameBytes) as unknown as Chunk[];
    start = chunks[0]?.frame_offset ?? start;
  }
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  if (fileSize(file) !== start) fs.truncateSync(file, start);
  if (store instanceof FileFrameStore) {
    appendRange(framesPath(home, m.mirror), file, start, m.frameBytes);
    return m.frameBytes - start;
  }
  const fd = fs.openSync(file, 'a');
  try {
    for (const c of chunks) writeAll(fd, store.read(m.mirror, c.frame_offset, c.frame_length));
  } finally {
    fs.closeSync(fd);
  }
  return m.frameBytes - start;
}

/** Append bytes `[start, end)` of `src` to `dst`. */
function appendRange(src: string, dst: string, start: number, end: number): void {
  if (end <= start) return;
  const input = fs.openSync(src, 'r');
  const output = fs.openSync(dst, 'a');
  try {
    const buf = Buffer.alloc(Math.min(COPY_CHUNK, end - start));
    for (let at = start; at < end; ) {
      const n = fs.readSync(input, buf, 0, Math.min(buf.length, end - at), at);
      if (n <= 0) throw new OriginError(`The mirror ${src} is shorter than the database records.`);
      fs.writeSync(output, buf, 0, n);
      at += n;
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/** What uploadFrames did. */
export interface FrameUpload {
  /** Mirrors with frames on disk. */
  mirrors: number;
  /** Frames on disk that the database records, each now verified in the bucket. */
  frames: number;
  /** Of those, uploaded this time, and their size. */
  uploaded: number;
  uploadedBytes: number;
  /** `<mirror>.zst` files whose every frame is verified in the bucket, with their size. */
  removable: Array<{ mirror: string; bytes: number }>;
  /** Of those, removed this time. */
  removed: number;
  /** Frames that could not be verified in the bucket, each with why; their files are kept. */
  failed: Array<{ mirror: string; key: string; reason: string }>;
  /** Why the run stopped before it had tried every frame (the bucket could not be used), or null. */
  stopped: string | null;
}

/** How far uploadFrames is: reported before the first frame and after each one. */
export interface FrameUploadProgress {
  /** Frames verified in the bucket so far, of the frames on disk, and the size of all of them. */
  frames: number;
  total: number;
  totalBytes: number;
  /** Of the frames verified, those uploaded, and their size. */
  uploaded: number;
  uploadedBytes: number;
  failed: number;
}

export interface FrameUploadOptions {
  /** Remove each `<mirror>.zst` file once every frame in it is verified in the bucket. */
  remove?: boolean;
  /**
   * Frames moved at once (default UPLOAD_CONCURRENCY). More than one helps only a bucket with
   * putAsync and getAsync: the others block on each request.
   */
  concurrency?: number;
  log?: (message: string) => void;
  progress?: (p: FrameUploadProgress) => void;
}

/** How many frames uploadFrames moves at once, unless told otherwise. */
export const UPLOAD_CONCURRENCY = 8;

/** A mirror with frames on disk, as uploadFrames moves them. */
interface FramesOnDisk {
  mirror: string;
  file: string;
  size: number;
  /** The frames the file holds, one after another from offset 0, as `raw_chunk` records them. */
  frames: Chunk[];
  /** Whether those frames are all the file holds of what the database records. */
  whole: boolean;
  /** Frames not done yet: neither verified, nor failed, nor skipped. */
  left: number;
  failed: boolean;
}

/**
 * Move the sealed frames a store still keeps on disk to its bucket (see useObjectStore), under the
 * same keys new frames get, so that running it again, or after a crash, uploads nothing twice.
 * Every frame is checked before it is uploaded (it must decompress, with its checksum, to the size
 * `raw_chunk` records) and read back from the bucket afterwards; a frame already there with the
 * same bytes is not uploaded again. A `<mirror>.zst` file is listed as removable only once every
 * frame in it is verified in the bucket, and removed only with `remove`; frames sealed since the
 * store uses the bucket are never on disk. May run while the hub serves.
 *
 * It runs outside transactions, so with a bucket that offers putAsync and getAsync it moves several
 * frames at once (`concurrency`), each still checked, uploaded, and read back in that order. A frame
 * that fails a check (damaged on disk, or read back different) is reported in `failed`, its file is
 * kept, and the other mirrors go on; any other error, such as a bucket that cannot be reached, would
 * fail every frame, so no frame is started after it (`stopped`) and the run ends once the frames
 * under way are done. Either way, a later run only verifies the frames already in the bucket.
 */
export async function uploadFrames(
  db: Database,
  home: string,
  opts: FrameUploadOptions = {},
): Promise<FrameUpload> {
  const store = frameStore(home);
  if (!(store instanceof BucketFrameStore)) {
    throw new OriginError('This store keeps its sealed frames on disk; give it a bucket first.');
  }
  const objects = store.objects;
  const put =
    objects.putAsync?.bind(objects) ??
    (async (key: string, data: Buffer) => objects.put(key, data));
  const get = objects.getAsync?.bind(objects) ?? (async (key: string) => objects.get(key));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? UPLOAD_CONCURRENCY));
  const result: FrameUpload = {
    mirrors: 0,
    frames: 0,
    uploaded: 0,
    uploadedBytes: 0,
    removable: [],
    removed: 0,
    failed: [],
    stopped: null,
  };

  // What is on disk. Each `<mirror>.zst` holds the frames sealed before the store used the bucket,
  // and perhaps bytes past what the database records, left by a write that never committed; those
  // are not frames.
  const framesOf = db.prepare(
    `SELECT ${CHUNK_COLUMNS} FROM raw_chunk WHERE raw_file_id = ? AND frame_offset < ?
       AND frame_offset + frame_length <= ? ORDER BY frame_offset`,
  );
  const mirrors: FramesOnDisk[] = [];
  let total = 0;
  let totalBytes = 0;
  for (const st of allMirrorStates(db)) {
    const file = framesPath(home, st.mirror);
    const size = fileSize(file);
    if (size === 0) continue;
    const end = Math.min(size, st.frameBytes);
    const frames: Chunk[] = [];
    let covered = 0;
    for (const c of framesOf.all(st.rawFileId, end, st.frameBytes) as unknown as Chunk[]) {
      if (c.frame_offset !== covered || c.frame_offset + c.frame_length > end) break;
      frames.push(c);
      covered = c.frame_offset + c.frame_length;
    }
    const whole = covered === end;
    mirrors.push({
      mirror: st.mirror,
      file,
      size,
      frames,
      whole,
      left: frames.length,
      failed: false,
    });
    total += frames.length;
    totalBytes += covered;
  }
  result.mirrors = mirrors.length;
  const progress = () =>
    opts.progress?.({
      frames: result.frames,
      total,
      totalBytes,
      uploaded: result.uploaded,
      uploadedBytes: result.uploadedBytes,
      failed: result.failed.length,
    });

  /** Once every frame of a mirror is done: list its file as removable, and remove it if asked. */
  const settle = (m: FramesOnDisk) => {
    if (m.failed) return;
    if (!m.whole) {
      opts.log?.(`${m.mirror}.zst does not end at a frame; it is kept`);
      return;
    }
    result.removable.push({ mirror: m.mirror, bytes: m.size });
    if (!opts.remove) return;
    try {
      // A reader that opens the file meanwhile finds it gone and reads the bucket instead.
      fs.rmSync(m.file, { force: true });
      result.removed++;
    } catch (err) {
      opts.log?.(`could not remove ${m.mirror}.zst: ${(err as Error).message}`);
    }
  };

  /** Check one frame, upload it unless the bucket holds it already, and read it back. */
  const move = async (m: FramesOnDisk, c: Chunk): Promise<boolean> => {
    const frame = readRange(m.file, c.frame_offset, c.frame_offset + c.frame_length);
    decompressFrame(m.mirror, c, frame);
    const key = frameKey(m.mirror, c.frame_offset);
    if ((await get(key))?.equals(frame)) return false;
    await put(key, frame);
    if (!(await get(key))?.equals(frame)) {
      throw new OriginError(
        `The frame ${key} read back from ${objects.location} differs from what was uploaded.`,
      );
    }
    return true;
  };

  // The frames in order, mirror by mirror, taken by `concurrency` workers one at a time.
  function* queue(): Generator<[FramesOnDisk, Chunk]> {
    for (const m of mirrors) {
      if (m.frames.length === 0) settle(m);
      for (const c of m.frames) yield [m, c];
    }
  }
  const next = queue();
  const work = async () => {
    for (;;) {
      if (result.stopped !== null) return;
      const item = next.next();
      if (item.done) return;
      const [m, c] = item.value;
      // A mirror with a frame that failed keeps its file, so its other frames need not go now.
      if (!m.failed) {
        try {
          if (await move(m, c)) {
            result.uploaded++;
            result.uploadedBytes += c.frame_length;
          }
          result.frames++;
        } catch (err) {
          const reason = (err as Error).message;
          m.failed = true;
          result.failed.push({ mirror: m.mirror, key: frameKey(m.mirror, c.frame_offset), reason });
          // A failed check concerns its frame; any other error would fail the next frames too.
          if (!(err instanceof OriginError)) result.stopped ??= reason;
        }
        progress();
      }
      if (--m.left === 0) settle(m);
    }
  };
  progress();
  await Promise.all(Array.from({ length: concurrency }, work));
  const order = new Map(mirrors.map((m, i) => [m.mirror, i]));
  result.removable.sort((a, b) => (order.get(a.mirror) ?? 0) - (order.get(b.mirror) ?? 0));
  return result;
}

/**
 * Where to cut complete lines into frames: each frame ends at the first line break once it holds
 * `target` bytes, and a last piece smaller than half the target joins the frame before it.
 */
function frameEnds(content: Buffer, target: number): number[] {
  const ends: number[] = [];
  let start = 0;
  while (start < content.length) {
    if (content.length - start <= target) {
      ends.push(content.length);
      break;
    }
    const nl = content.indexOf(0x0a, start + target - 1);
    const end = nl < 0 ? content.length : nl + 1;
    ends.push(end);
    start = end;
  }
  const n = ends.length;
  if (n >= 2 && (ends[n - 1] as number) - (ends[n - 2] as number) < target / 2) {
    ends.splice(n - 2, 1);
  }
  return ends;
}

function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a); i >= 0; i = buf.indexOf(0x0a, i + 1)) n++;
  return n;
}

/** Line `n` (1-based) of complete lines, without its line break (and a trailing `\r`). */
function lineAt(buf: Buffer, n: number): string | null {
  let start = 0;
  for (let i = 1; i < n; i++) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  if (start >= buf.length) return null;
  const nl = buf.indexOf(0x0a, start);
  const line = buf.toString('utf8', start, nl < 0 ? buf.length : nl);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
