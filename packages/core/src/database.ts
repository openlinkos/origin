import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The connection a store is read and written through. Origin's code uses only what this interface
 * offers, so that a store can live in another engine than SQLite, such as PostgreSQL on a hub (see
 * docs/architecture.md#storage). Statements are written in SQL that both engines accept; what one
 * engine spells differently goes through the helpers in dialect.ts.
 */

/** The engine a store is kept in. */
export type Dialect = 'sqlite' | 'postgres';

/** A value bound to a statement's parameter or read from a row. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** A row: each column's value by its name. */
export type SqlRow = Record<string, SqlValue>;

/** What a statement that writes changed. */
export interface RunResult {
  /** The rows the statement itself inserted, updated, or deleted (not those of its triggers). */
  changes: number | bigint;
  /**
   * SQLite's rowid of the last row inserted. Use `INSERT ... RETURNING` instead: another engine has
   * no such value.
   */
  lastInsertRowid: number | bigint;
}

/** A prepared statement. Parameters are positional (`?`). */
export interface Statement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
}

export interface Database {
  readonly dialect: Dialect;
  /** Whether a transaction is open on this connection. */
  readonly isTransaction: boolean;
  prepare(sql: string): Statement;
  /** Run one or more statements that return nothing, such as transaction control or DDL. */
  exec(sql: string): void;
  close(): void;
  /** The version of the store's format it records (see migrations.ts), or 0 if it records none. */
  formatVersion(): number;
  /** Record the version of the store's format, inside the transaction that brings it there. */
  setFormatVersion(version: number): void;
  /**
   * Whether the store has the table now, asked each time: a migration on the same connection may
   * create it later.
   */
  hasTable(name: string): boolean;
  hasColumn(table: string, column: string): boolean;
  /**
   * Run `fn` waiting up to `ms`, instead of the usual 10 s, for the write lock (`BEGIN
   * IMMEDIATE`) when another process holds it. If `fn` returns a promise, until it settles.
   */
  withWaitTimeout<T>(ms: number, fn: () => T): T;
  /** The size of the database, and of its write-ahead log where it has one of its own. */
  databaseBytes(): { bytes: number; walBytes: number | null };
  /** Where the database is, for messages: its file, or '' for an in-memory database. */
  location(): string;
}

/** A SQLite database through node:sqlite. */
export class SqliteDatabase implements Database {
  readonly dialect = 'sqlite';

  constructor(
    /** The node:sqlite connection, for what only SQLite has (its online backup). */
    readonly handle: DatabaseSync,
  ) {}

  get isTransaction(): boolean {
    return this.handle.isTransaction;
  }

  get isOpen(): boolean {
    return this.handle.isOpen;
  }

  prepare(sql: string): Statement {
    return this.handle.prepare(sql);
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  close(): void {
    if (this.handle.isOpen) this.handle.close();
  }

  /** `PRAGMA user_version`, kept in the database header (see migrations.ts). */
  formatVersion(): number {
    return (this.handle.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
  }

  setFormatVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`Not a format version: ${version}`);
    }
    this.handle.exec(`PRAGMA user_version = ${version}`);
  }

  hasTable(name: string): boolean {
    return (
      this.handle
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== undefined
    );
  }

  hasColumn(table: string, column: string): boolean {
    return (
      this.handle.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
    ).some((c) => c.name === column);
  }

  /** Through `busy_timeout`, set back to what it was afterwards. */
  withWaitTimeout<T>(ms: number, fn: () => T): T {
    const before = (this.handle.prepare('PRAGMA busy_timeout').get() as { timeout: number })
      .timeout;
    this.handle.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`);
    return afterwards(fn, () => {
      if (this.handle.isOpen) this.handle.exec(`PRAGMA busy_timeout = ${before}`);
    });
  }

  /** Page count × page size, and the `-wal` file next to the database (0 if there is none). */
  databaseBytes(): { bytes: number; walBytes: number | null } {
    const pageCount = (this.handle.prepare('PRAGMA page_count').get() as { page_count: number })
      .page_count;
    const pageSize = (this.handle.prepare('PRAGMA page_size').get() as { page_size: number })
      .page_size;
    let walBytes = 0;
    const file = this.location();
    if (file) {
      try {
        walBytes = fs.statSync(`${file}-wal`).size;
      } catch {
        // no WAL file (checkpointed and removed)
      }
    }
    return { bytes: pageCount * pageSize, walBytes };
  }

  location(): string {
    return this.handle.location() ?? '';
  }
}

/**
 * Run `fn`, then `done`: once its promise settles if it returns one (see
 * Database.withWaitTimeout), at once otherwise.
 */
function afterwards<T>(fn: () => T, done: () => void): T {
  let out: T;
  try {
    out = fn();
  } catch (err) {
    done();
    throw err;
  }
  if (out instanceof Promise) return out.finally(done) as T;
  done();
  return out;
}

/** Opens the database of a store: its file, or ':memory:'. */
export type DatabaseFactory = (file: string) => Database;

let factory: DatabaseFactory | null = null;

/**
 * Tests only: open every store through `make` instead of SQLite, such as a store in PostgreSQL
 * for each file path, so that the same suite runs on another engine. `null` goes back to SQLite.
 * Returns the factory it replaces.
 */
export function setDatabaseFactory(make: DatabaseFactory | null): DatabaseFactory | null {
  const before = factory;
  factory = make;
  return before;
}

/** The factory a test set, if any (see setDatabaseFactory). */
export function databaseFactory(): DatabaseFactory | null {
  return factory;
}
