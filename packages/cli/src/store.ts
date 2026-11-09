import fs from 'node:fs';
import path from 'node:path';
import {
  type Database,
  dbPath,
  HUB_STORE_NAME,
  initStoreName,
  type OpenOptions,
  OriginError,
  prepareStore,
  rawDir,
} from '@openlinkos/origin-core';
import {
  openLocalStore,
  PAIRING_FILE,
  type Pairing,
  readPairing,
  writePairing,
} from './pairing.js';
import { PgDatabase } from './pg/client.js';
import { databaseUrlFrom, type PgTarget } from './pg/url.js';

export { postgresConfigured } from './pairing.js';

/**
 * Where the CLI opens a store (see docs/architecture.md#database-engines): SQLite, in ORIGIN_HOME's
 * `origin.db`, unless ORIGIN_DATABASE_URL (or ORIGIN_DATABASE_URL_FILE) names a PostgreSQL
 * database, which only a hub may use. Either way ORIGIN_HOME holds the raw mirrors.
 *
 * A store in PostgreSQL and its ORIGIN_HOME are paired by `store.json`, which names the store's id
 * (store_format.store_id) and engine: a database is never used with another store's mirrors, and
 * an ORIGIN_HOME whose store moved into PostgreSQL never opens a new, empty SQLite store because
 * the URL was left out.
 */

/** The high 32 bits of the lock `origin serve` holds on a store in PostgreSQL ('SERV'). */
export const PG_SERVE_LOCK_TAG = 0x53455256;

export interface OpenStoreOptions extends OpenOptions {
  /** The command, for the connection's application_name in PostgreSQL. */
  command: string;
}

/** Whether ORIGIN_HOME holds raw mirrors (anything under raw/). */
function hasMirrors(home: string): boolean {
  try {
    return fs.readdirSync(rawDir(home)).length > 0;
  } catch {
    return false;
  }
}

/** The row of store_format, if the store has one. */
interface StoreFormat {
  version: number;
  storeId: string;
  movedTo: string | null;
}

function storeFormat(db: Database): StoreFormat | null {
  const row = db.prepare('SELECT version, store_id, moved_to FROM store_format').get() as
    | { version: number; store_id: string; moved_to: string | null }
    | undefined;
  return row ? { version: row.version, storeId: row.store_id, movedTo: row.moved_to } : null;
}

/**
 * Refuse a database and an ORIGIN_HOME that do not belong together: the store's raw mirrors are in
 * the ORIGIN_HOME whose store.json names it. A database without a store (`found` null) is paired
 * with an ORIGIN_HOME that holds no store of its own; one with a store, but no store.json yet, only
 * while neither has a mirror (a store whose creation stopped before store.json was written).
 */
function checkPairing(
  db: Database,
  home: string,
  where: string,
  found: StoreFormat | null,
  pairing: Pairing | null,
): void {
  if (found && pairing?.engine === 'postgres' && pairing.id === found.storeId) return;
  const file = path.join(home, PAIRING_FILE);
  if (pairing && found) {
    throw new OriginError(
      pairing.engine === 'postgres'
        ? `The database at ${where} holds store ${found.storeId}, but ORIGIN_HOME ${home} belongs to store ${pairing.id} (${file}): a store's raw mirrors are in the ORIGIN_HOME whose store.json names it. Check ORIGIN_DATABASE_URL (and its schema), or ORIGIN_HOME.`
        : `ORIGIN_HOME ${home} belongs to a store in SQLite (${file}), not to the one at ${where}. Unset ORIGIN_DATABASE_URL to open it, or give this database the ORIGIN_HOME whose store.json names store ${found.storeId}.`,
    );
  }
  if (fs.existsSync(dbPath(home))) {
    throw new OriginError(
      `ORIGIN_HOME ${home} holds a store in SQLite (origin.db), so it cannot hold the raw mirrors of the store at ${where}. To move that store into PostgreSQL, unset ORIGIN_DATABASE_URL and run: origin db move --to <postgres-url>`,
    );
  }
  const mirrors = hasMirrors(home);
  if (found) {
    const rawFiles = db.hasTable('raw_file') && db.prepare('SELECT 1 FROM raw_file LIMIT 1').get();
    if (mirrors || rawFiles) {
      throw new OriginError(
        `The store at ${where} (store ${found.storeId}) is not paired with ORIGIN_HOME ${home}, which has no ${PAIRING_FILE}: its raw mirrors are in the ORIGIN_HOME whose store.json names it. Point ORIGIN_HOME there.`,
      );
    }
    return;
  }
  if (pairing && mirrors) {
    throw new OriginError(
      `ORIGIN_HOME ${home} belongs to store ${pairing.id} (${file}), which is not at ${where}: nothing is there yet. Check ORIGIN_DATABASE_URL (and its schema).`,
    );
  }
  if (mirrors) {
    throw new OriginError(
      `ORIGIN_HOME ${home} holds the raw mirrors of another store (raw/), without ${PAIRING_FILE}: a new store in ${where} needs an ORIGIN_HOME of its own.`,
    );
  }
}

/**
 * Open the store of ORIGIN_HOME `home`, in the engine the environment names, and bring it to the
 * latest format (see prepareStore). In PostgreSQL, refuse a store that was moved away or that is
 * not paired with `home` (see checkPairing), create one if the database has none, and write
 * store.json; in SQLite, refuse an ORIGIN_HOME whose store.json says its store is in PostgreSQL.
 */
export function openStore(home: string, env: NodeJS.ProcessEnv, opts: OpenStoreOptions): Database {
  const target = databaseUrlFrom(env);
  if (target) return openPostgres(home, target, readPairing(home), opts);
  const { command: _, ...rest } = opts;
  return openLocalStore(home, rest);
}

function openPostgres(
  home: string,
  target: PgTarget,
  pairing: Pairing | null,
  opts: OpenStoreOptions,
): PgDatabase {
  const { command, ...rest } = opts;
  const db = new PgDatabase(target, { command });
  try {
    const found = storeFormat(db);
    if (found?.movedTo) {
      throw new OriginError(
        `The store at ${target.display} has been moved to ${found.movedTo}; it is no longer used. Point ORIGIN_DATABASE_URL at where it is now, or unset it if it is in SQLite.`,
      );
    }
    checkPairing(db, home, target.display, found, pairing);
    prepareStore(db, { ...rest, home, file: target.display });
    const now = storeFormat(db);
    if (!now) throw new OriginError(`The store at ${target.display} has no store_format row.`);
    if (pairing?.engine !== 'postgres' || pairing.id !== now.storeId) {
      writePairing(home, { id: now.storeId, engine: 'postgres' });
    }
    // A store in PostgreSQL is a hub's, from the start.
    initStoreName(db, HUB_STORE_NAME);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * `origin serve` on a store in PostgreSQL: hold the serve lock for as long as it runs, so that a
 * second hub on the same store, from this machine or another, is refused. Nothing on SQLite.
 */
export function holdServeLock(db: Database): void {
  if (!(db instanceof PgDatabase)) return;
  db.holdLock(
    PG_SERVE_LOCK_TAG,
    `Another origin serve is running on the store at ${db.location()}: a store is served by one hub at a time.`,
  );
}

/** Why `command` (with its first argument, for subcommands) does not run on a hub in PostgreSQL. */
const DEVICE_ONLY: Readonly<Record<string, string>> = {
  sync: 'a hub in PostgreSQL ingests nothing of this machine; it receives sessions from its devices, which run origin sync',
  push: 'a hub in PostgreSQL ingests nothing of this machine; it receives sessions from its devices, which run origin sync',
  hub: 'it connects a device to a hub, and this store is a hub',
  mcp: "agents use the hub's /mcp over HTTP, with an agent token or by signing in (OAuth)",
  ui: "use the hub's admin UI: origin serve --admin",
  agents: "it registers Origin with this machine's agents, whose sessions go to a device's store",
  'sessions reproject': "it resolves sessions against this machine's files; run it on the devices",
  'sessions parents': "it reads this machine's agent databases; run it on the devices",
};

/**
 * The message for a command that does not run when the store is in PostgreSQL (see
 * docs/guide/hub.md), or null if it runs. `args` are the command's arguments.
 */
export function refusedOnPostgres(command: string, args: readonly string[]): string | null {
  const reason = DEVICE_ONLY[`${command} ${args[0] ?? ''}`] ?? DEVICE_ONLY[command];
  if (!reason) return null;
  const name = DEVICE_ONLY[command] ? command : `${command} ${args[0]}`;
  return `origin ${name} does not run where ORIGIN_DATABASE_URL names the store: ${reason}.`;
}
