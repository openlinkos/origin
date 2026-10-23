import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { type Database, transaction } from './db.js';
import { OriginError } from './errors.js';
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
 * write. Every read and write of `raw/` goes through this module.
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

export function framesPath(home: string, mirror: string): string {
  return `${path.join(rawDir(home), mirror)}.zst`;
}

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
  const frame = readRange(
    framesPath(home, mirror),
    c.frame_offset,
    c.frame_offset + c.frame_length,
  );
  if (frame.length !== c.frame_length) {
    throw new OriginError(`The mirror ${mirror} is missing sealed data; the store is damaged.`);
  }
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
 * Drop bytes past what the database records (left by a write that never committed, or by a crash
 * between sealing the tail and emptying it), so that the next write appends at the right place.
 * Throws if a file holds less than the database records: the mirror lost data, and appending would
 * break provenance. Must run under the write lock.
 */
export function repairMirror(home: string, st: MirrorState): void {
  const frames = framesPath(home, st.mirror);
  const tail = tailPath(home, st.mirror);
  const expected: Array<[string, number]> = [
    [frames, st.frameBytes],
    [tail, st.bytes - st.sealedBytes],
  ];
  for (const [file, size] of expected) {
    const actual = fileSize(file);
    if (actual > size) fs.truncateSync(file, size);
    else if (actual < size) {
      throw new OriginError(
        `The mirror ${st.mirror} is shorter than the database records (${path.basename(file)}: ${actual} of ${size} bytes); the store is damaged.`,
      );
    }
  }
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
  const fd = fs.openSync(framesPath(home, st.mirror), 'a');
  try {
    let start = 0;
    let line = st.sealedLines + 1;
    let frameOffset = st.frameBytes;
    for (const end of frameEnds(content, frameBytes)) {
      const piece = content.subarray(start, end);
      const frame = zlib.zstdCompressSync(piece, ZSTD_PARAMS);
      writeAll(fd, frame);
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
    // The frames must be on disk before the tail they replace is emptied.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

function fileSize(file: string): number {
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

function writeAll(fd: number, buf: Buffer): void {
  for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
}
