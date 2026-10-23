import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { forgetFrameBucket, frameBucket, framesPath } from './frames.js';
import {
  allMirrorStates,
  copyFrames,
  hasFrameBoundary,
  type MirrorState,
  readMirror,
  tailPath,
} from './mirror.js';
import { dbPath, rawDir } from './paths.js';

export interface BackupResult {
  /** Size of the database copy. */
  databaseBytes: number;
  /** Mirrors in the backup. */
  mirrorFiles: number;
  /**
   * Mirror bytes written this time, as stored (sealed frames and open tails); a previous backup
   * into the same directory is extended.
   */
  mirrorBytesCopied: number;
}

type BackupFn = (db: Database, path: string, options?: { rate?: number }) => Promise<number>;

/**
 * Back up a store into `target` (see docs/guide/privacy.md#backing-up): first the database, with
 * SQLite's online backup in a single step, so that the copy is one consistent snapshot even while
 * other processes keep writing (copied in small steps, it would restart at every write); then the
 * mirrors, exactly as that snapshot records them (see mirror.ts). Sealed frames never change, so
 * the frames a previous backup into `target` holds are extended with those it lacks; an open tail
 * is extended as long as no frame was sealed from it since, and written again otherwise. Its
 * content is read from the live store, where it may have been sealed in the meantime: a mirror's
 * content only grows, so it is the same. On a hub that keeps its sealed frames in a bucket, they
 * are copied from the bucket into `target`, laid out as on disk, so that a backup holds everything
 * on its own; the copy of the database then no longer records the bucket. To restore, copy
 * `target` into an empty ORIGIN_HOME.
 */
export async function backupStore(
  db: Database,
  home: string,
  target: string,
): Promise<BackupResult> {
  const backup = (sqlite as unknown as { backup: BackupFn }).backup;
  const dest = path.join(target, 'origin.db');
  const inside = path.relative(path.resolve(rawDir(home)), path.resolve(target));
  if (
    path.resolve(dest) === path.resolve(dbPath(home)) ||
    inside === '' ||
    !(inside.startsWith('..') || path.isAbsolute(inside))
  ) {
    throw new OriginError('Back up into a directory outside the store.');
  }
  fs.mkdirSync(target, { recursive: true });
  // What a previous backup here holds, to extend it rather than copy everything again.
  const previous = new Map(snapshotMirrors(dest)?.map((m) => [m.state.rawFileId, m]));
  for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) fs.rmSync(f, { force: true });
  await backup(db, dest, { rate: 2 ** 31 - 1 });
  const mirrors = snapshotMirrors(dest);
  if (!mirrors) throw new OriginError(`Cannot read the backed-up database ${dest}.`);
  let copied = 0;
  for (const m of mirrors) {
    const before = previous.get(m.state.rawFileId);
    copied += copyMirror(
      db,
      home,
      target,
      m.state,
      before && before.identity === m.identity ? before.state : undefined,
    );
  }
  // From a hub that keeps its sealed frames in a bucket, the frames were copied into the backup:
  // the copy keeps them all on disk, like any store without a bucket.
  if (frameBucket(db) !== null) {
    const copy = new sqlite.DatabaseSync(dest);
    try {
      forgetFrameBucket(copy);
    } finally {
      copy.close();
    }
  }
  return {
    databaseBytes: fs.statSync(dest).size,
    mirrorFiles: mirrors.length,
    mirrorBytesCopied: copied,
  };
}

/**
 * The mirrors a database file records, each with what identifies its raw file across copies of
 * the store (original path, generation, and when it was first seen), or null if there is no
 * database or it cannot be read.
 */
function snapshotMirrors(file: string): Array<{ state: MirrorState; identity: string }> | null {
  if (!fs.existsSync(file)) return null;
  let copy: sqlite.DatabaseSync | null = null;
  try {
    copy = new sqlite.DatabaseSync(file);
    const identities = new Map(
      (
        copy
          .prepare('SELECT id, source, path, generation, first_seen_at FROM raw_file')
          .all() as unknown as Array<{
          id: number;
          source: string;
          path: string;
          generation: number;
          first_seen_at: number;
        }>
      ).map((r) => [r.id, `${r.source}\n${r.path}\n${r.generation}\n${r.first_seen_at}`]),
    );
    return allMirrorStates(copy).map((state) => ({
      state,
      identity: identities.get(state.rawFileId) ?? '',
    }));
  } catch {
    return null;
  } finally {
    copy?.close();
  }
}

/**
 * Bring one mirror in `target` to the state `m` of the snapshot; `before` is its state in the
 * previous backup there. Returns the bytes written.
 */
function copyMirror(
  db: Database,
  home: string,
  target: string,
  m: MirrorState,
  before: MirrorState | undefined,
): number {
  const frames = framesPath(target, m.mirror);
  const tail = tailPath(target, m.mirror);
  fs.mkdirSync(path.dirname(frames), { recursive: true });
  // The previous backup is of this mirror if its frames end where one of this mirror's ends.
  const same =
    before !== undefined &&
    before.mirror === m.mirror &&
    before.bytes <= m.bytes &&
    before.frameBytes <= m.frameBytes &&
    hasFrameBoundary(db, m.rawFileId, before.frameBytes, before.sealedBytes);
  let written = 0;

  const haveFrames = same ? Math.min(fileSize(frames), before.frameBytes) : 0;
  if (m.frameBytes > 0 || fileSize(frames) > 0) {
    written += copyFrames(db, home, m, frames, haveFrames);
  }

  const tailLength = m.bytes - m.sealedBytes;
  const haveTail =
    same && before.sealedBytes === m.sealedBytes
      ? Math.min(fileSize(tail), before.bytes - before.sealedBytes)
      : 0;
  if (tailLength > 0 || fileSize(tail) > 0) {
    resize(tail, haveTail);
    if (tailLength > haveTail) {
      const data = readMirror(db, home, m.rawFileId, m.sealedBytes + haveTail, m.bytes);
      if (data.length !== tailLength - haveTail) {
        throw new OriginError(`The mirror ${m.mirror} is shorter than the database records.`);
      }
      fs.appendFileSync(tail, data);
      written += data.length;
    }
  }
  return written;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Create `file` if needed, and cut it to `size` bytes. */
function resize(file: string, size: number): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  if (fileSize(file) !== size) fs.truncateSync(file, size);
}
