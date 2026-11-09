import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertCopyTarget,
  type CopyResult,
  copyStore,
  copyToSqliteFile,
  type Database,
  dbPath,
  OriginError,
  rawDir,
  rebuildSearchIndexes,
  SqliteDatabase,
  transaction,
} from '@openlinkos/origin-core';
import { ARGS } from './args.js';
import { count } from './format.js';
import { readHubConfig } from './hub/config.js';
import {
  newStoreId,
  PAIRING_FILE,
  postgresConfigured,
  readPairing,
  writePairing,
} from './pairing.js';
import { PgDatabase } from './pg/client.js';
import { type PgTarget, parseDatabaseUrl } from './pg/url.js';
import { PG_SERVE_LOCK_TAG } from './store.js';
import { fmtDuration } from './time.js';

/**
 * `origin db move` and `origin db rebuild-search` (see docs/guide/cli.md#database-engines): move a
 * hub's store between SQLite and PostgreSQL, or into another PostgreSQL schema or database, with
 * copyStore (core/src/store-copy.ts); and rebuild what search derives from the events.
 *
 * A move runs with the hub stopped. It reads the store under its write lock, so that nothing
 * changes it meanwhile, copies it into the target, which must be empty, and checks the copy. Only
 * then is the store retired: a database in SQLite is renamed `origin.db.moved-<date>` (and kept),
 * one in PostgreSQL records where it went (store_format.moved_to), and store.json names the store's
 * new engine. The raw mirrors stay where they are, in ORIGIN_HOME.
 */

/** How long one statement of a move or a rebuild may run in PostgreSQL: building an index can be long. */
export const DB_STATEMENT_TIMEOUT_MS = 24 * 3600_000;

/** What `--to` names. */
type MoveTarget = { engine: 'sqlite' } | { engine: 'postgres'; target: PgTarget };

function moveTarget(to: string): MoveTarget {
  const t = to.trim();
  return t === 'sqlite'
    ? { engine: 'sqlite' }
    : { engine: 'postgres', target: parseDatabaseUrl(t, '--to') };
}

/**
 * What must hold before `origin db` opens the store, which upgrades an older one: a store in SQLite
 * to move or rebuild must be there, not made anew.
 */
export function dbCommandProblem(home: string, env: NodeJS.ProcessEnv): string | null {
  if (postgresConfigured(env) || fs.existsSync(dbPath(home))) return null;
  if (fs.existsSync(path.join(home, PAIRING_FILE))) return null; // opening says what is missing
  return `ORIGIN_HOME ${home} holds no store (no origin.db), and ORIGIN_DATABASE_URL names none.`;
}

/** Counts of what a store holds, for the preview and the summary. */
function summary(db: Database): string {
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return `${count(n('SELECT count(*) AS n FROM event'), 'event')}, ${count(n('SELECT count(*) AS n FROM entry'), 'entry', 'entries')}, ${count(n('SELECT count(*) AS n FROM raw_file'), 'raw file')}`;
}

/** Where a store is, in words. */
function described(db: Database): string {
  return db instanceof PgDatabase ? `PostgreSQL at ${db.location()}` : `SQLite at ${db.location()}`;
}

/** A name for the retired database file that is not taken: origin.db.moved-<date>[-n]. */
function retiredName(file: string, now = new Date()): string {
  const base = `${file}.moved-${now.toISOString().slice(0, 10)}`;
  let name = base;
  for (let i = 2; fs.existsSync(name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * Make sure nothing else uses the store while it is moved or rebuilt: a hub in PostgreSQL holds the
 * serve lock (taken here until the connection closes, so that no hub starts meanwhile); a database
 * in SQLite leaves the write-ahead log only when no other process has it open (which also writes
 * the log into the database, so that the file is the whole store). Opening it again returns it to
 * the write-ahead log.
 */
function holdStore(db: Database, what: string): void {
  if (db instanceof PgDatabase) {
    db.holdLock(
      PG_SERVE_LOCK_TAG,
      `origin serve is running on the store at ${db.location()}: stop the hub, then ${what}.`,
    );
    // The store is read in one transaction, which waits while the target builds its indexes.
    db.exec('SET idle_in_transaction_session_timeout = 0');
    return;
  }
  if (!(db instanceof SqliteDatabase)) return;
  db.exec('PRAGMA busy_timeout = 0');
  let mode: string | undefined;
  try {
    mode = (db.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode?: string })
      ?.journal_mode;
  } catch {
    mode = undefined;
  } finally {
    db.exec('PRAGMA busy_timeout = 10000');
  }
  if (mode !== 'delete') {
    throw new OriginError(
      `Another process has the store open (origin serve, origin mcp, origin ui, or an agent's hook): stop it, then ${what}.`,
    );
  }
}

/** Run `origin db <subcommand>` on the store `db` of ORIGIN_HOME `home`, which main opened. */
export async function cmdDb(db: Database, home: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'rebuild-search') return rebuildSearch(db);
  if (sub !== 'move') throw new OriginError(ARGS.db.usage);
  const { values } = parseArgs({ args: rest, options: ARGS.db.sub.move.options });
  return move(db, home, moveTarget(values.to ?? ''), values.yes === true);
}

function move(db: Database, home: string, to: MoveTarget, yes: boolean): number {
  const out = (m: string) => console.log(m);
  const log = (m: string) => console.error(`origin db move: ${m}`);
  const fromPg = db instanceof PgDatabase;
  if (!fromPg && to.engine === 'sqlite') throw new OriginError('The store is in SQLite already.');
  if (fromPg && to.engine === 'postgres') {
    const here = (db as PgDatabase).target;
    if (here.url === to.target.url && here.schema === to.target.schema) {
      throw new OriginError('The store is there already.');
    }
  }
  if (!fromPg && readHubConfig(home)) {
    throw new OriginError(
      `This store is connected to a hub (${path.join(home, 'hub.json')}): only a hub's store moves into PostgreSQL, where a device's commands do not run. Run origin hub disconnect first if this store is to become a hub.`,
    );
  }
  const file = dbPath(home);
  if (to.engine === 'sqlite' && fs.existsSync(file)) {
    throw new OriginError(
      `${file} exists already: move it away, or keep it and leave the store where it is.`,
    );
  }
  const where = to.engine === 'sqlite' ? `SQLite at ${file}` : `PostgreSQL at ${to.target.display}`;
  const target =
    to.engine === 'postgres'
      ? new PgDatabase(to.target, {
          command: 'db move',
          statementTimeoutMs: DB_STATEMENT_TIMEOUT_MS,
        })
      : null;
  try {
    if (target) assertCopyTarget(target);
    if (!yes) {
      out(`This will copy the store of ORIGIN_HOME ${home} (${summary(db)})`);
      out(`  from ${described(db)}`);
      out(`  into ${where}, which is empty,`);
      out(
        `check the copy, and retire the store where it is: ${fromPg ? 'its database records where it went' : `origin.db is kept as ${path.basename(retiredName(file))}`}, and ${PAIRING_FILE} names the store's new place. The raw mirrors stay in ${rawDir(home)}.`,
      );
      out(
        `\nStop the hub, and anything else that uses the store, first. Then re-run with --yes.${to.engine === 'postgres' ? ' Afterwards, run the hub with ORIGIN_DATABASE_URL naming the new database.' : ' Afterwards, run the hub without ORIGIN_DATABASE_URL.'}`,
      );
      return 1;
    }
    holdStore(db, 'move its store');
    const started = Date.now();
    const storeId = storeIdOf(db, home);
    db.exec('BEGIN IMMEDIATE');
    let copied: CopyResult;
    try {
      copied = target
        ? copyStore(db, target, { storeId, log })
        : copyToSqliteFile(db, file, { log });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // The copy is checked and in place: retire the store.
    let retired = '';
    if (fromPg) {
      writePairing(home, { id: storeId, engine: to.engine });
      db.prepare('UPDATE store_format SET moved_to = ?').run(where);
      db.exec('COMMIT');
    } else {
      db.exec('ROLLBACK');
      writePairing(home, { id: storeId, engine: 'postgres' });
      db.close();
      retired = retiredName(file);
      fs.renameSync(file, retired);
    }
    const rows = copied.tables.reduce((n, t) => n + t.rows, 0);
    out(
      `Moved the store into ${where}: ${count(rows, 'row')} in ${fmtDuration(Date.now() - started)} (loading ${fmtDuration(copied.ms.load)}, search indexes ${fmtDuration(copied.ms.derive)}, checking ${fmtDuration(copied.ms.check)}), the same in every table.`,
    );
    out(
      fromPg
        ? `The store in ${described(db)} records that it moved, and is no longer opened.`
        : `The SQLite database is kept as ${retired}; remove it once the hub runs on PostgreSQL.`,
    );
    out(
      to.engine === 'postgres'
        ? `Run the hub with ORIGIN_DATABASE_URL naming the new database (${to.target.display}) and the same ORIGIN_HOME.`
        : 'Run the hub without ORIGIN_DATABASE_URL, with the same ORIGIN_HOME.',
    );
    return 0;
  } finally {
    target?.close();
  }
}

/**
 * The id of the store: its own in PostgreSQL; in SQLite, the one store.json gave it when it last
 * moved out of PostgreSQL, else a new one.
 */
function storeIdOf(db: Database, home: string): string {
  if (db instanceof PgDatabase) {
    const row = db.prepare('SELECT store_id FROM store_format').get() as
      | { store_id: string }
      | undefined;
    if (!row) throw new OriginError(`The store at ${db.location()} has no store_format row.`);
    return row.store_id;
  }
  const pairing = readPairing(home);
  return pairing?.engine === 'sqlite' ? pairing.id : newStoreId();
}

/** The indexes in PostgreSQL over text folded with the server's Unicode tables (pg_c_utf8). */
const FOLDED_INDEXES = ['event_grams', 'event_message_grams', 'entry_grams'];

function rebuildSearch(db: Database): number {
  const started = Date.now();
  // In SQLite the rebuild waits for the write lock like any write; in PostgreSQL it locks the
  // indexes it rebuilds, which a running hub would wait for.
  if (db instanceof PgDatabase) holdStore(db, 'rebuild its search indexes');
  transaction(
    db,
    () => {
      if (db instanceof PgDatabase) for (const i of FOLDED_INDEXES) db.exec(`REINDEX INDEX ${i}`);
      rebuildSearchIndexes(db);
    },
    { immediate: true },
  );
  console.log(
    `Rebuilt the search indexes of the store (${summary(db)}) in ${fmtDuration(Date.now() - started)}.`,
  );
  return 0;
}
