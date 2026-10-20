import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema.js';

export type Database = DatabaseSync;

/** Open (creating if needed) the database and apply the schema. */
export function openDatabase(file: string): Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  // Several processes (CLI, one MCP server per agent session) may share the database.
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec(SCHEMA);
  return db;
}

/** In-memory database for tests and one-off analysis. */
export function openMemoryDatabase(): Database {
  const db = new DatabaseSync(':memory:');
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
