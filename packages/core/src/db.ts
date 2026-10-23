import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { cjkIndexText } from './cjk.js';
import { OriginError } from './errors.js';
import { type Migration, migrate, refuseNewerStore } from './migrations.js';
import { BACKFILL_EFFECTS, NEEDS_BACKFILL } from './schema.js';
import type { SourceAdapter } from './types.js';

export type Database = DatabaseSync;

/**
 * Origin needs Node.js 22.16 or later: zstd in node:zlib (raw mirrors are compressed with it) and
 * the online backup of node:sqlite. Fail clearly on anything older.
 */
function checkRuntime(): void {
  if (
    typeof zlib.zstdCompressSync !== 'function' ||
    typeof (sqlite as { backup?: unknown }).backup !== 'function'
  ) {
    throw new OriginError(`Origin needs Node.js 22.16 or later; this is ${process.version}.`);
  }
}

/** The size the write-ahead log is truncated to after a checkpoint. */
export const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

/**
 * Functions the schema and the queries use, registered on every connection: `origin_cjk` fills the
 * CJK index from a trigger, and `origin_contains` checks a lowercased term against a text, ignoring
 * case beyond ASCII (which LIKE does not).
 */
function registerFunctions(db: Database): void {
  db.function('origin_cjk', { deterministic: true }, (text, kind) =>
    typeof text === 'string' ? cjkIndexText(text, String(kind)) : null,
  );
  db.function('origin_contains', { deterministic: true }, (text, needle) =>
    typeof text === 'string' && typeof needle === 'string' && text.toLowerCase().includes(needle)
      ? 1
      : 0,
  );
}

export interface OpenOptions {
  /**
   * The source adapters, for a migration that parses mirrored lines again (see migrations.ts).
   * Opening a store that needs one without them fails at that migration.
   */
  adapters?: SourceAdapter[];
  /**
   * Called before the first migration this process runs, if any: set up what migrations read,
   * such as the frame store of a hub that keeps its sealed frames in a bucket.
   */
  beforeMigrate?: (db: Database) => void;
  /** Where to say that a migration runs (the CLI: standard error). */
  log?: (message: string) => void;
  /** The migrations to run (tests); Origin's by default. */
  migrations?: Migration[];
}

/**
 * Open (creating if needed) the database of the store whose ORIGIN_HOME is the file's directory,
 * and bring it to the latest format version (see migrations.ts). A store written by a newer Origin
 * is refused, unchanged.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): Database {
  checkRuntime();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    registerFunctions(db);
    // Several processes (CLI, one MCP server per agent session) may share the database. Writes are
    // short (see TRANSACTION_BYTES), so waiting up to 10 s for the write lock is plenty.
    db.exec('PRAGMA busy_timeout = 10000;');
    refuseNewerStore(db, { file, migrations: opts.migrations });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA synchronous = NORMAL;');
    // A large import grows the write-ahead log; truncate it back to 64 MiB after each checkpoint.
    db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT};`);
    migrate(db, { ...opts, home: path.dirname(path.resolve(file)), file });
    backfillTombstoneEffects(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Fill tombstone_effect for tombstones written without it: by a store from before it existed, or by
 * a process of an older version still running against this store (see BACKFILL_EFFECTS). The check
 * is a read, so opening a store that needs nothing takes no write lock.
 */
function backfillTombstoneEffects(db: Database): void {
  if (db.prepare(NEEDS_BACKFILL).get()) {
    transaction(db, () => db.exec(BACKFILL_EFFECTS), { immediate: true });
  }
}

/** In-memory database for tests and one-off analysis, at the latest format version. */
export function openMemoryDatabase(): Database {
  checkRuntime();
  const db = new DatabaseSync(':memory:');
  registerFunctions(db);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, { home: '' });
  return db;
}

/**
 * Run inside a transaction; on error, roll back and rethrow. `immediate` takes the write lock up
 * front, so read-then-write sequences are serialized across processes.
 */
export function transaction<T>(db: Database, fn: () => T, opts: { immediate?: boolean } = {}): T {
  db.exec(opts.immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
