import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { cjkIndexText } from './cjk.js';
import { type Database, databaseFactory, SqliteDatabase } from './database.js';
import { OriginError, StoreUpgradedError } from './errors.js';
import { type Migration, migrate, refuseNewerStore, STORE_VERSION } from './migrations.js';
import { comparePath } from './places.js';
import { promptTitle } from './prompt.js';
import { BACKFILL_EFFECTS, NEEDS_BACKFILL } from './schema.js';
import type { SourceAdapter } from './types.js';

export type { Database } from './database.js';

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
 * CJK index from a trigger, `origin_contains` checks a lowercased term against a text, ignoring
 * case beyond ASCII (which LIKE does not), and `origin_prompt` tells whether a text reads as a
 * prompt (see promptTitle), for the rule of the owner's prompts in a query (see authors.ts).
 */
function registerFunctions(db: DatabaseSync): void {
  db.function('origin_cjk', { deterministic: true }, (text, kind) =>
    typeof text === 'string' ? cjkIndexText(text, String(kind)) : null,
  );
  db.function('origin_contains', { deterministic: true }, (text, needle) =>
    typeof text === 'string' && typeof needle === 'string' && text.toLowerCase().includes(needle)
      ? 1
      : 0,
  );
  db.function('origin_prompt', { deterministic: true }, (text) =>
    typeof text === 'string' && promptTitle(text) !== null ? 1 : 0,
  );
  db.function('origin_path', { deterministic: true }, (text) =>
    typeof text === 'string' ? comparePath(text) : null,
  );
}

/**
 * A SQLite connection to a store's database file (or ':memory:'), with Origin's functions and the
 * settings of the connection. Nothing in the file changes yet: its journal mode is set once the
 * store is known to be one this Origin may change (see prepareStore).
 */
function openSqlite(file: string): SqliteDatabase {
  const memory = file === ':memory:';
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  try {
    registerFunctions(handle);
    // Several processes (CLI, one MCP server per agent session) may share the database. Writes are
    // short (see TRANSACTION_BYTES), so waiting up to 10 s for the write lock is plenty.
    if (!memory) handle.exec('PRAGMA busy_timeout = 10000;');
    handle.exec('PRAGMA foreign_keys = ON;');
  } catch (err) {
    handle.close();
    throw err;
  }
  return new SqliteDatabase(handle);
}

/** The write-ahead log, for a database file: a setting of the file, so it waits for prepareStore. */
function useWriteAheadLog(db: SqliteDatabase): void {
  if (db.location() === '') return; // an in-memory database
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  // A large import grows the write-ahead log; truncate it back to 64 MiB after each checkpoint.
  db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT};`);
}

/** A connection to a store's database: SQLite, unless a test set another factory. */
function connect(file: string): Database {
  return (databaseFactory() ?? openSqlite)(file);
}

export interface OpenOptions {
  /**
   * The source adapters, for a migration that parses mirrored lines again (see migrations.ts): a
   * list, or a function that finds the adapter of a source by its id, such as one that reads a
   * person's own sources whatever their names. Opening a store that needs one without them fails
   * at that migration.
   */
  adapters?: SourceAdapter[] | ((source: string) => SourceAdapter | null);
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

export interface PrepareOptions extends OpenOptions {
  /** ORIGIN_HOME: the raw mirrors are under `<home>/raw`. */
  home: string;
  /** Where the database is, for messages. */
  file?: string;
}

/**
 * Open (creating if needed) the database of the store whose ORIGIN_HOME is the file's directory,
 * and bring it to the latest format version (see migrations.ts). A store written by a newer Origin
 * is refused, unchanged.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): Database {
  checkRuntime();
  const db = connect(file);
  try {
    prepareStore(db, { ...opts, home: path.dirname(path.resolve(file)), file });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Make a store's database, just connected, ready for use: refuse a store of a newer Origin before
 * anything in it changes, bring an older one to the latest format version (creating a new one),
 * and fill what is derived from older rows (see backfillTombstoneEffects).
 */
export function prepareStore(db: Database, opts: PrepareOptions): void {
  refuseNewerStore(db, { file: opts.file, migrations: opts.migrations });
  if (db instanceof SqliteDatabase) useWriteAheadLog(db);
  migrate(db, opts);
  backfillTombstoneEffects(db);
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
  const db = connect(':memory:');
  try {
    prepareStore(db, { home: '' });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Refuse a write when a newer Origin has upgraded the store since this process opened it. A read
 * of the format version, before the write transaction starts. A store this process is itself
 * upgrading is still at an older version, so the upgrade is not refused.
 */
export function assertStoreCurrent(db: Database): void {
  if (db.formatVersion() > STORE_VERSION) throw new StoreUpgradedError();
}

/**
 * Run inside a transaction; on error, roll back and rethrow. `immediate` takes the write lock up
 * front, so read-then-write sequences are serialized across processes.
 */
export function transaction<T>(db: Database, fn: () => T, opts: { immediate?: boolean } = {}): T {
  assertStoreCurrent(db);
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
