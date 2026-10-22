import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { dbPath, rawDir } from './paths.js';

export interface BackupResult {
  /** Size of the database copy. */
  databaseBytes: number;
  /** Mirror files in the backup. */
  mirrorFiles: number;
  /** Mirror bytes copied this time (a previous backup into the same directory is extended). */
  mirrorBytesCopied: number;
}

type BackupFn = (db: Database, path: string, options?: { rate?: number }) => Promise<number>;

/** Mirror bytes are copied in pieces of this size. */
const COPY_CHUNK = 4 * 1024 * 1024;

/**
 * Back up a store into `target` (see docs/guide/privacy.md#backing-up): first the database, with
 * SQLite's online backup in a single step, so that the copy is one consistent snapshot even while
 * other processes keep writing (copied in small steps, it would restart at every write); then the
 * raw mirrors. Mirrors only grow, so a mirror already in `target` is extended with the bytes it
 * lacks. Copying mirrors after the database means the backup holds every line the database refers
 * to. To restore, copy `target` into an empty ORIGIN_HOME.
 */
export async function backupStore(
  db: Database,
  home: string,
  target: string,
): Promise<BackupResult> {
  const backup = (sqlite as unknown as { backup?: BackupFn }).backup;
  if (typeof backup !== 'function') {
    throw new OriginError('Backing up needs Node.js 22.16 or later (node:sqlite backup).');
  }
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
  for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) fs.rmSync(f, { force: true });
  await backup(db, dest, { rate: 2 ** 31 - 1 });
  const copied = { files: 0, bytes: 0 };
  copyMirrors(rawDir(home), path.join(target, 'raw'), copied);
  return {
    databaseBytes: fs.statSync(dest).size,
    mirrorFiles: copied.files,
    mirrorBytesCopied: copied.bytes,
  };
}

function copyMirrors(from: string, to: string, copied: { files: number; bytes: number }): void {
  if (!fs.existsSync(from)) return;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyMirrors(src, dst, copied);
      continue;
    }
    if (!entry.isFile()) continue;
    fs.mkdirSync(to, { recursive: true });
    const size = fs.statSync(src).size;
    let have = fs.existsSync(dst) ? fs.statSync(dst).size : 0;
    if (have > size) {
      // Not a prefix of the mirror (a mirror never shrinks): copy it again.
      fs.rmSync(dst);
      have = 0;
    }
    copied.files++;
    if (have === size) continue;
    appendRange(src, dst, have, size);
    copied.bytes += size - have;
  }
}

function appendRange(src: string, dst: string, start: number, end: number): void {
  const input = fs.openSync(src, 'r');
  const output = fs.openSync(dst, 'a');
  try {
    const buf = Buffer.alloc(Math.min(COPY_CHUNK, end - start));
    for (let at = start; at < end; ) {
      const n = fs.readSync(input, buf, 0, Math.min(buf.length, end - at), at);
      if (n <= 0) break;
      fs.writeSync(output, buf, 0, n);
      at += n;
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}
