import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { SCHEMA } from './schema.js';
import type { SourceAdapter } from './types.js';

/**
 * Versions of the store format, and the migrations between them (see
 * docs/architecture.md#migrations).
 *
 * A store records its version in the database header, `PRAGMA user_version`: SQLite keeps it there
 * for applications, it can be read before any table exists, and it is written in the same
 * transaction as the changes it describes, so a migration and its version commit or roll back
 * together. A backup copies it with the database. Origin 0.1.0 wrote no version: a store without
 * one is version 1 if it has the tables of 0.1.0, and new otherwise.
 *
 * Opening a store brings it to the latest version, in order and once each:
 *
 * - A new store gets the current schema and the latest version in one transaction.
 * - An older store runs each migration it lacks in a transaction of its own, under the write lock
 *   (BEGIN IMMEDIATE). The version is read again once the lock is held, so when several processes
 *   open the store at once (the CLI, one MCP server per agent), one runs each migration and the
 *   others find it done. A migration that fails is rolled back with its version; the next open runs
 *   it again.
 * - A store whose version is newer than this code knows is refused, unchanged.
 *
 * Then the schema's idempotent statements run, as on every open: tables, indexes, views, and
 * triggers that are new, and that existing data needs nothing from, appear without a migration.
 */

/** What a migration can use. */
export interface MigrationContext {
  db: Database;
  /** ORIGIN_HOME: the raw mirrors are under `<home>/raw`. */
  home: string;
  /**
   * The adapter of a source, for a migration that parses mirrored lines again. Throws an
   * OriginError if the store was opened without it (core has no adapters of its own).
   */
  adapter(source: string): SourceAdapter;
  log(message: string): void;
}

/**
 * One step of the store format. A schema migration changes tables in place (ALTER TABLE, …); a
 * data migration changes or fills rows, reading the store and its raw mirrors. Either runs inside
 * a write transaction that also records its version, so it must not commit or begin one itself.
 */
export interface Migration {
  /** The version the store has once it has run: one more than the migration before it. */
  version: number;
  /** What it does, for messages. */
  name: string;
  up(ctx: MigrationContext): void;
}

/**
 * Origin's migrations, in order. Version 1 is the schema of 0.1.0, which has none. A migration is
 * never changed once released: a fix is a new migration.
 */
export const MIGRATIONS: Migration[] = [];

/** The version of a store created by 0.1.0, the first release, which recorded none. */
export const FIRST_VERSION = 1;

/** The latest version: what this code creates, and brings older stores to. */
export const STORE_VERSION = latestVersion(MIGRATIONS);

/** How long a process waits for another to finish a migration before it gives up. */
export const MIGRATION_WAIT_MS = 5 * 60_000;

export interface MigrateOptions {
  /** ORIGIN_HOME, for migrations that read raw mirrors. */
  home: string;
  /** The database file, for messages. */
  file?: string;
  /** Adapters, for migrations that parse mirrored lines again. */
  adapters?: SourceAdapter[];
  /**
   * Called once before the first migration this process runs, if any: set up what migrations
   * read, such as the frame store of a hub that keeps its sealed frames in a bucket. The store is
   * still at its old version, so this may use only what every version has (`setting`).
   */
  beforeMigrate?: (db: Database) => void;
  log?: (message: string) => void;
  /** The migrations to run, in order (tests); Origin's by default. */
  migrations?: Migration[];
}

function latestVersion(migrations: Migration[]): number {
  let version = FIRST_VERSION;
  for (const m of migrations) {
    if (m.version !== version + 1) {
      throw new Error(`Migration "${m.name}" is version ${m.version}; expected ${version + 1}.`);
    }
    version = m.version;
  }
  return version;
}

/** `PRAGMA user_version`: 0 for a store that records none. */
function userVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function hasTable(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * The version of a store: the one it records, else 1 for a store of 0.1.0 (which has the `raw_file`
 * and `event` tables), else 0 for a new one.
 */
export function storeVersion(db: Database): number {
  const recorded = userVersion(db);
  if (recorded > 0) return recorded;
  return hasTable(db, 'raw_file') && hasTable(db, 'event') ? FIRST_VERSION : 0;
}

/** A store written by a newer Origin than this one. */
class NewerStoreError extends OriginError {}

function refuseNewer(version: number, latest: number, file: string | undefined): void {
  if (version <= latest) return;
  throw new NewerStoreError(
    `The store${file ? ` at ${file}` : ''} has format version ${version}, but this Origin knows versions up to ${latest} only: a newer Origin has used it. Upgrade Origin to open it; nothing was changed.`,
  );
}

/**
 * Throw an OriginError if the store was written by a newer Origin, before anything is changed in
 * it, not even its journal mode.
 */
export function refuseNewerStore(
  db: Database,
  opts: Pick<MigrateOptions, 'file' | 'migrations'> = {},
): void {
  const latest = opts.migrations ? latestVersion(opts.migrations) : STORE_VERSION;
  refuseNewer(storeVersion(db), latest, opts.file);
}

/**
 * Run `fn` in a write transaction, waiting up to MIGRATION_WAIT_MS for the lock: another process
 * may be running a migration that takes a while.
 */
function underLock<T>(db: Database, fn: () => T): T {
  const timeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  db.exec(`PRAGMA busy_timeout = ${MIGRATION_WAIT_MS}`);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
  }
}

/**
 * Bring a store to the latest version (see the top of this file), then apply the schema's
 * idempotent statements. Throws an OriginError for a store newer than this code, or when a
 * migration fails; what earlier migrations did stays.
 */
export function migrate(db: Database, opts: MigrateOptions): void {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = opts.migrations ? latestVersion(migrations) : STORE_VERSION;
  const log = opts.log ?? (() => {});
  const found = storeVersion(db);
  const stamped = userVersion(db) !== 0;
  refuseNewer(found, latest, opts.file);

  if (found === 0) {
    underLock(db, () => {
      const now = storeVersion(db);
      refuseNewer(now, latest, opts.file);
      if (now !== 0) return; // created by another process meanwhile
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${latest}`);
    });
  } else if (found < latest || !stamped) {
    opts.beforeMigrate?.(db);
    const byId = new Map((opts.adapters ?? []).map((a) => [a.id, a]));
    const ctx: MigrationContext = {
      db,
      home: opts.home,
      adapter(source) {
        const adapter = byId.get(source);
        if (!adapter) {
          throw new OriginError(
            `This step re-reads the store's ${source} mirrors, which needs the ${source} adapter: open the store with the origin command.`,
          );
        }
        return adapter;
      },
      log,
    };
    // A store of 0.1.0 records no version yet: record 1, then go on from there.
    const steps: Array<{ version: number; name: string; up?: () => void }> = [
      { version: FIRST_VERSION, name: 'record the format version' },
      ...migrations.map((m) => ({ version: m.version, name: m.name, up: () => m.up(ctx) })),
    ];
    for (const step of steps) {
      if (step.version < found || (step.version === found && stamped)) continue;
      try {
        underLock(db, () => {
          const now = storeVersion(db);
          refuseNewer(now, latest, opts.file);
          // Done already, by another process that opened the store at the same time.
          if (now >= step.version && userVersion(db) !== 0) return;
          if (step.up) log(`Upgrading the store to version ${step.version}: ${step.name}.`);
          step.up?.();
          db.exec(`PRAGMA user_version = ${step.version}`);
        });
      } catch (err) {
        if (!step.up || err instanceof NewerStoreError) throw err;
        const reason = (err as Error).message.replace(/\.?$/, '.');
        throw Object.assign(
          new OriginError(
            `The store could not be upgraded to version ${step.version} (${step.name}): ${reason} Nothing of this step was kept; it runs again the next time the store is opened.`,
          ),
          { cause: err },
        );
      }
    }
  }
  db.exec(SCHEMA);
}
