import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cjkIndexText } from './cjk.js';
import { SCHEMA } from './schema.js';

export type Database = DatabaseSync;

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

/** Open (creating if needed) the database and apply the schema. */
export function openDatabase(file: string): Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  registerFunctions(db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  // Several processes (CLI, one MCP server per agent session) may share the database. Writes are
  // short (see TRANSACTION_BYTES), so waiting up to 10 s for the write lock is plenty.
  db.exec('PRAGMA busy_timeout = 10000;');
  // A large import grows the write-ahead log; truncate it back to 64 MiB after each checkpoint.
  db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT};`);
  db.exec(SCHEMA);
  return db;
}

/** In-memory database for tests and one-off analysis. */
export function openMemoryDatabase(): Database {
  const db = new DatabaseSync(':memory:');
  registerFunctions(db);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
