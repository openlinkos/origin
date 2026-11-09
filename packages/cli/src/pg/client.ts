import os from 'node:os';
import {
  type Database,
  type Dialect,
  missingObjects,
  OriginError,
  PG_CLIENT_OBJECTS,
  PG_LOCK_TAG,
  PG_PREFLIGHT_SQL,
  PG_PRESENT_SQL,
  type PgPreflight,
  preflightProblem,
  type RunResult,
  type SqlRow,
  type SqlValue,
  STORE_VERSION,
  type Statement,
  StoreUpgradedError,
  type TransactionControl,
  type Translation,
  Translator,
} from '@openlinkos/origin-core';
import { SyncWorker, SyncWorkerError } from '../sync-worker.js';
import { type PgTarget, redact } from './url.js';
import { PG_WORKER_SOURCE, pgModulePath } from './worker-source.js';

/**
 * A store's database in PostgreSQL, through the Database interface that Origin's code uses for
 * SQLite (see docs/architecture.md#storage). That interface is synchronous, as node:sqlite is, and
 * PostgreSQL's driver is not: a worker thread holds the connection (worker-source.ts), and this
 * thread blocks on each request until the worker answers (sync-worker.ts). Nothing here loads `pg`.
 *
 * SQL is written for SQLite and translated (Translator: `?` to `$n`, LIKE to ILIKE, …); SQL this
 * client writes itself is PostgreSQL's. Values are bound and read as node:sqlite binds and reads
 * them; U+0000, which PostgreSQL's text cannot hold, is bound as U+FFFD.
 *
 * Transactions and locking follow SQLite's, so that the code above them works unchanged:
 *
 * - `BEGIN IMMEDIATE` begins a transaction and takes the store's write lock, a transaction-level
 *   advisory lock keyed by the store's schema (origin_lock_key), waiting up to 10 s for it (or what
 *   withWaitTimeout says), then refuses the transaction if a newer Origin has upgraded the store.
 *   Every write takes the lock first, so Origin's writers never deadlock, and the keys the store
 *   assigns (MAX + 1) become visible in the order they were assigned.
 * - A write outside a transaction is one: the same BEGIN, the statement, COMMIT.
 * - `BEGIN` (deferred) begins a REPEATABLE READ READ ONLY transaction: a snapshot, as SQLite's read
 *   transaction is. A write inside one is refused: SQLite would take the write lock then, and
 *   Origin's rule is that every transaction that writes is immediate.
 * - A read outside a transaction runs alone, as SQLite's does.
 * - iterate() reads through a cursor, in batches. Outside a transaction, the cursors open at the same
 *   time share one REPEATABLE READ READ ONLY snapshot, committed when the last one closes, and reads
 *   meanwhile run in it. A write or a BEGIN meanwhile first reads what is left of them into memory
 *   and ends the snapshot. A cursor still open when the event loop next turns is closed, and reading
 *   it further fails: an iterator outside a transaction is read within the task that opened it.
 *
 * When the connection is lost, a request outside a transaction connects again (with backoff, up to
 * 30 s) and a read is tried once more; a write is tried again only if its COMMIT was never sent. A
 * transaction that loses its connection is gone: the statement fails with ConnectionLostError,
 * every statement after it too, until the ROLLBACK that ends it (which then does nothing).
 */

/** How long a writing transaction waits for the store's write lock by default (as busy_timeout). */
const WAIT_MS = 10_000;
/** How long one statement may run by default (statement_timeout). */
const STATEMENT_TIMEOUT_MS = 5 * 60_000;
/** The memory of each sort and bitmap of a session's queries. */
const WORK_MEM = '64MB';
/** How long a session may sit in a transaction doing nothing. */
const IDLE_IN_TRANSACTION_MS = 5 * 60_000;
/** Connecting: one attempt, and the retries while the server cannot be reached. */
const CONNECT_TIMEOUT_MS = 10_000;
const RETRY_FIRST_MS = 200;
const RETRY_MAX_MS = 5_000;
const RETRY_TOTAL_MS = 30_000;
/** How much longer than the statement's own limit this thread waits for the worker. */
const GRACE_MS = 30_000;
/** The most all() reads at once (its text, about); iterate() reads more, a batch at a time. */
const RESULT_CAP = 256 * 1024 * 1024;
/** Rows a cursor fetches at first, and at most, per round trip; and the text a batch aims at. */
const FETCH_FIRST = 64;
const FETCH_MAX = 1024;
const FETCH_BYTES = 8 * 1024 * 1024;

/**
 * The rows a cursor fetches next: twice as many as last time, up to FETCH_MAX, but no more than
 * fit in FETCH_BYTES at the size the last ones had.
 */
function nextBatch(last: number, rows: number, bytes: number): number {
  const fit = rows > 0 && bytes > 0 ? Math.floor((FETCH_BYTES * rows) / bytes) : FETCH_MAX;
  return Math.max(1, Math.min(last * 2, FETCH_MAX, fit));
}

/** An error PostgreSQL reported, with its SQLSTATE `code`. */
export class PgError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  /** The server's own message, where `message` says it in other words (a lock or time limit). */
  readonly serverMessage: string;

  constructor(message: string, fields: Record<string, unknown>, serverMessage = message) {
    super(message);
    this.name = 'PgError';
    const text = (key: string) => (typeof fields[key] === 'string' ? fields[key] : undefined);
    this.code = text('code') ?? '';
    this.detail = text('detail');
    this.hint = text('hint');
    this.constraint = text('constraint');
    this.table = text('table');
    this.column = text('column');
    this.serverMessage = serverMessage;
  }
}

/**
 * The connection to the database was lost, or could not be made: the request may not have run. One
 * inside a transaction ended it; `committing` says it was lost during the COMMIT, so the transaction
 * may or may not have been saved.
 */
export class ConnectionLostError extends Error {
  readonly committing: boolean;

  constructor(message: string, committing = false) {
    super(message);
    this.name = 'ConnectionLostError';
    this.committing = committing;
  }
}

export interface PgOptions {
  /** The command, for the session's application_name: `origin <command> <host>:<pid>`. */
  command?: string;
  /**
   * Refuse SQL that still holds, translated, what PostgreSQL does not have or reads otherwise (see
   * forbiddenIn): for tests, which then find what was written for SQLite alone.
   */
  checkSql?: boolean;
  /** How long one statement may run (statement_timeout); 5 minutes by default. */
  statementTimeoutMs?: number;
  /**
   * The most text a result read at once may hold (256 MB by default): all() of more fails, and
   * asks for iterate().
   */
  resultCapBytes?: number;
}

/** One statement of a request to the worker (see worker-source.ts). */
interface Step {
  sql: string;
  params?: unknown[];
  /** The simple protocol: several statements, no parameters. */
  simple?: boolean;
  want?: 'none' | 'one' | 'all';
  /** A FETCH of this many rows: the cursor is done when fewer come. */
  fetch?: number;
  /** Run only once the FETCH before has found the cursor done. */
  ifDone?: boolean;
  /** The COMMIT: losing the connection from here on may have saved the transaction or not. */
  commit?: boolean;
  /** Fail if COMMIT rolled back (the transaction had failed). */
  expectCommit?: boolean;
  /** The BEGIN batch of a writing transaction: refuse a store newer than this version, or moved. */
  store?: number;
  /** The most text the rows may hold. */
  cap?: number;
}

interface StepResult {
  fields: string[];
  rows: unknown[][];
  count: number | null;
  command: string;
  /** The text its rows hold, about (counted for steps with a cap). */
  bytes: number;
}

interface Answer {
  conn: string;
  results: Array<StepResult | null>;
  done: boolean;
}

interface Request {
  steps: Step[];
  /** The connection a transaction is on: the request fails if it is gone. */
  conn?: string | null;
  /** Whether the request may run again on a new connection (see worker-source.ts). */
  retry?: 'read' | 'write';
  /** Roll back if the request fails: it begins a transaction. */
  rollback?: boolean;
}

const NO_RESULT: StepResult = { fields: [], rows: [], count: null, command: '', bytes: 0 };

/** A cursor of iterate(), and the rows it has fetched. */
interface Cursor {
  readonly name: string;
  readonly sql: string;
  readonly params: unknown[];
  /** new: not yet declared; open: declared on the server; held: what is left is in memory. */
  state: 'new' | 'open' | 'held' | 'closed';
  /** In the shared snapshot, outside a transaction. */
  implicit: boolean;
  fields: string[];
  rows: unknown[][];
  at: number;
  batch: number;
  /** Why reading it further fails. */
  error: Error | null;
}

/** What iterate() can read through a cursor: a query (a write or EXPLAIN cannot be declared). */
const CURSOR_QUERY =
  /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:\(|SELECT\b|VALUES\b|WITH\b|TABLE\b)/i;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** SQLite's own error for transaction control out of place, as node:sqlite throws it. */
function sqliteError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR' });
}

/** A row as node:sqlite returns it: an object without a prototype; of two columns named alike, the last. */
function rowOf(fields: string[], values: unknown[]): SqlRow {
  const row = Object.create(null) as Record<string, SqlValue>;
  for (let i = 0; i < fields.length; i++) row[fields[i] as string] = values[i] as SqlValue;
  return row;
}

function runResult(changes: number): RunResult {
  return {
    changes,
    get lastInsertRowid(): number {
      throw new Error('PostgreSQL has no rowid of the last insert: use INSERT ... RETURNING');
    },
  };
}

/** The parameters to bind, checked and converted as node:sqlite would take them. */
function bind(t: Translation, params: unknown[]): unknown[] {
  if (params.length > t.params) {
    throw new RangeError(
      `${params.length} parameters given, but the statement takes ${t.params}: ${t.sql}`,
    );
  }
  const out = new Array<unknown>(t.params).fill(null);
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v === null || typeof v === 'number' || typeof v === 'bigint') out[i] = v;
    else if (typeof v === 'string') out[i] = v.includes('\0') ? v.replaceAll('\0', '\uFFFD') : v;
    else if (typeof v === 'boolean') out[i] = v ? 1 : 0;
    else if (v instanceof Uint8Array) out[i] = v;
    else {
      throw Object.assign(
        new TypeError(`Provided value cannot be bound to PostgreSQL parameter ${i + 1}.`),
        { code: 'ERR_INVALID_ARG_TYPE' },
      );
    }
  }
  return out;
}

/** The base of the iterators iterate() returns: Iterator, for its helpers (toArray, …), where there is one. */
const IteratorBase = ((globalThis as { Iterator?: new () => object }).Iterator ??
  Object) as new () => object;

class RowIterator extends IteratorBase implements IterableIterator<SqlRow> {
  constructor(
    private readonly pull: () => SqlRow | undefined,
    private readonly stop: () => void,
  ) {
    super();
  }

  next(): IteratorResult<SqlRow> {
    const row = this.pull();
    return row === undefined ? { done: true, value: undefined } : { done: false, value: row };
  }

  return(): IteratorResult<SqlRow> {
    this.stop();
    return { done: true, value: undefined };
  }

  [Symbol.iterator](): this {
    return this;
  }
}

class PgStatement implements Statement {
  constructor(
    private readonly db: PgDatabase,
    private readonly t: Translation,
  ) {}

  run(...params: SqlValue[]): RunResult {
    const r = this.db.execute(this.t, bind(this.t, params), 'none');
    return runResult(this.t.kind === 'write' ? (r.count ?? 0) : 0);
  }

  get(...params: SqlValue[]): SqlRow | undefined {
    const r = this.db.execute(this.t, bind(this.t, params), 'one');
    const first = r.rows[0];
    return first ? rowOf(r.fields, first) : undefined;
  }

  all(...params: SqlValue[]): SqlRow[] {
    const r = this.db.execute(this.t, bind(this.t, params), 'all');
    return r.rows.map((values) => rowOf(r.fields, values));
  }

  iterate(...params: SqlValue[]): IterableIterator<SqlRow> {
    return this.db.iterate(this.t, bind(this.t, params));
  }
}

export class PgDatabase implements Database {
  readonly dialect: Dialect = 'postgres';
  private readonly worker: SyncWorker;
  private readonly translator: Translator;
  private readonly callTimeoutMs: number;
  private readonly cap: number;
  private open = true;
  /** The connection the transaction or the snapshot is on. */
  private conn: string | null = null;
  private txn: 'immediate' | 'deferred' | null = null;
  /**
   * A transaction that has ended on the server but not yet here: its connection was lost, or its
   * COMMIT failed. As in SQLite after a failed COMMIT, the caller still rolls it back; until then
   * every statement fails, and ROLLBACK (or ROLLBACK TO, RELEASE) does nothing.
   */
  private ended: 'lost' | 'failed' | null = null;
  /** The REPEATABLE READ snapshot shared by cursors outside a transaction. */
  private snapshot = false;
  /** Cursors declared on the server. */
  private readonly cursors = new Set<Cursor>();
  private nextCursor = 1;
  private waitMs = WAIT_MS;
  private sweep: NodeJS.Immediate | null = null;

  /**
   * Connect to the store's database (blocking until connected, retrying for up to 30 s while the
   * server cannot be reached), check that the server and the database may hold a store, and create
   * the store's schema and what this client needs in it (see PG_CLIENT_OBJECTS) if they are missing.
   * Throws an OriginError when it cannot.
   */
  constructor(
    readonly target: PgTarget,
    opts: PgOptions = {},
  ) {
    this.translator = new Translator({ check: opts.checkSql ?? false });
    const statementMs = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
    this.callTimeoutMs = statementMs + RETRY_TOTAL_MS + CONNECT_TIMEOUT_MS + GRACE_MS;
    this.cap = opts.resultCapBytes ?? RESULT_CAP;
    const command = opts.command ? `${opts.command} ` : '';
    this.worker = new SyncWorker({
      source: PG_WORKER_SOURCE,
      data: {
        pgPath: pgModulePath(),
        connection: {
          connectionString: target.url,
          application_name: `origin ${command}${os.hostname()}:${process.pid}`,
        },
        session: [
          'SET synchronous_commit = on',
          `SET statement_timeout = ${statementMs}`,
          `SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_MS}`,
          'SET plan_cache_mode = force_custom_plan',
          'SET jit = off',
          // Search's bitmaps of GIN matches stay exact: a lossy page has origin_trigrams() computed
          // again for each of its rows.
          `SET work_mem = '${WORK_MEM}'`,
          "SET client_encoding = 'UTF8'",
          `SET search_path TO ${quoteIdent(target.schema)}`,
        ].join('; '),
        // A statement whose client has gone (a process killed) ends within 10 s, rather than
        // holding the write lock until it finishes: not on servers that run on Windows.
        sessionIfAny: ['SET client_connection_check_interval = 10000'],
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        retryFirstMs: RETRY_FIRST_MS,
        retryMaxMs: RETRY_MAX_MS,
        retryTotalMs: RETRY_TOTAL_MS,
      },
    });
    try {
      this.setUp();
    } catch (err) {
      this.open = false;
      this.worker.close();
      if (err instanceof OriginError) throw err;
      throw Object.assign(
        new OriginError(`Cannot open the store at ${target.display}: ${(err as Error).message}`),
        { cause: err },
      );
    }
  }

  /** The preflight, then the schema and the client's objects, created under a lock of their own. */
  private setUp(): void {
    const [found] = this.rows(PG_PREFLIGHT_SQL, []) as unknown as PgPreflight[];
    const problem = found ? preflightProblem(found) : 'The database cannot be read.';
    if (problem) throw new OriginError(problem);
    const schema = this.target.schema;
    const lacking = () =>
      missingObjects(
        this.rows(PG_PRESENT_SQL, [schema]) as unknown as Array<{ kind: string; name: string }>,
        PG_CLIENT_OBJECTS,
      );
    const hasSchema = () =>
      this.rows('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema]).length > 0;
    if (hasSchema() && lacking().length === 0) return;
    // Two processes may set up the same schema at once: one waits for the other, under a lock of
    // two keys, apart from the store's write lock (one key).
    const begun = this.batch({
      steps: [
        { sql: 'BEGIN', simple: true },
        { sql: 'SELECT pg_advisory_xact_lock($1, hashtext($2))', params: [PG_LOCK_TAG, schema] },
      ],
      retry: 'read',
      rollback: true,
    });
    this.conn = begun.conn;
    this.txn = 'immediate';
    try {
      if (!hasSchema())
        this.inSession({ sql: `CREATE SCHEMA ${quoteIdent(schema)}`, simple: true });
      for (const o of lacking()) this.inSession({ sql: o.sql, simple: true });
      this.inSession({ sql: 'COMMIT', simple: true, commit: true, expectCommit: true });
    } catch (err) {
      if (this.txn) this.batch({ steps: [{ sql: 'ROLLBACK', simple: true }], conn: this.conn });
      throw err;
    } finally {
      this.txn = null;
      this.ended = null;
    }
  }

  get isTransaction(): boolean {
    return this.txn !== null || this.ended !== null;
  }

  prepare(sql: string): Statement {
    this.assertOpen();
    const t = this.translator.translate(sql);
    if (t.statements > 1) throw new Error(`prepare() takes one statement: ${sql}`);
    return new PgStatement(this, t);
  }

  exec(sql: string): void {
    this.assertOpen();
    const t = this.translator.translate(sql);
    if (t.params > 0) throw new Error(`exec() takes no parameters: ${sql}`);
    this.execute(t, [], 'none', true);
  }

  close(): void {
    if (!this.open) return;
    if (this.sweep) clearImmediate(this.sweep);
    this.sweep = null;
    for (const c of this.cursors) this.fail(c, new Error('the database was closed'));
    this.cursors.clear();
    try {
      this.worker.call({ op: 'end' }, { timeoutMs: 5_000 });
    } catch {
      // The connection ends with the worker.
    }
    this.open = false;
    this.worker.close();
  }

  formatVersion(): number {
    const [row] = this.rows('SELECT version FROM store_format', []);
    return row ? Number(row.version) : 0;
  }

  setFormatVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`Not a format version: ${version}`);
    }
    this.execute(
      native(
        `INSERT INTO store_format (one, version, store_id) VALUES (true, $1, gen_random_uuid()::text)
         ON CONFLICT (one) DO UPDATE SET version = excluded.version`,
        1,
        'write',
      ),
      [version],
      'none',
    );
  }

  hasTable(name: string): boolean {
    return (
      this.rows(
        `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relname = $1 AND c.relkind IN ('r', 'p')`,
        [name],
      ).length > 0
    );
  }

  hasColumn(table: string, column: string): boolean {
    return (
      this.rows(
        `SELECT 1 FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attname = $2
           AND a.attnum > 0 AND NOT a.attisdropped`,
        [table, column],
      ).length > 0
    );
  }

  /**
   * Through the lock_timeout of BEGIN IMMEDIATE (0 waits the least PostgreSQL can, 1 ms); until the
   * promise settles if `fn` returns one.
   */
  withWaitTimeout<T>(ms: number, fn: () => T): T {
    const before = this.waitMs;
    this.waitMs = Math.max(1, Math.floor(ms));
    let out: T;
    try {
      out = fn();
    } catch (err) {
      this.waitMs = before;
      throw err;
    }
    if (out instanceof Promise) {
      return out.finally(() => {
        this.waitMs = before;
      }) as T;
    }
    this.waitMs = before;
    return out;
  }

  /** The tables, indexes, and TOAST of the store's schema; PostgreSQL's WAL is the server's own. */
  databaseBytes(): { bytes: number; walBytes: number | null } {
    const [row] = this.rows(
      `SELECT coalesce(sum(pg_catalog.pg_total_relation_size(c.oid)), 0) AS bytes
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'm')`,
      [],
    );
    return { bytes: Number(row?.bytes ?? 0), walBytes: null };
  }

  /** The URL, without its password, and the schema. */
  location(): string {
    return this.target.display;
  }

  /**
   * Hold a session-level advisory lock for as long as this client is open: the high 32 bits of its
   * key are `tag`, the low 32 the oid of the store's schema, as for the store's write lock. Throws
   * an OriginError saying `message` when another session holds it. The connection takes it again
   * whenever it connects again; if another session took it meanwhile, every request fails with
   * `message` until the lock is free.
   */
  holdLock(tag: number, message: string): void {
    this.assertUsable(false);
    this.call({
      op: 'lock',
      sql: `SELECT pg_catalog.pg_try_advisory_lock((${tag}::bigint << 32) | (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema())::bigint)`,
      message: redact(message, this.target.secrets),
    });
  }

  /** Tests: the worker exits `afterMs` from now, during whatever request runs then. */
  exitWorkerForTests(afterMs: number): void {
    this.call({ op: 'exit', afterMs });
  }

  /** Run a statement as its kind requires (see the top of this file). */
  execute(
    t: Translation,
    params: unknown[],
    want: 'none' | 'one' | 'all',
    simple = false,
  ): StepResult {
    this.assertUsable(t.kind === 'transaction');
    if (t.kind === 'transaction') {
      this.control(t.control as TransactionControl, t.sql);
      return NO_RESULT;
    }
    const step: Step = { sql: t.sql, params, want, simple, cap: this.cap };
    if (t.kind === 'write' || t.kind === 'ddl') {
      if (this.txn === 'deferred') {
        throw new Error(
          `writing transactions must be immediate: begin them with BEGIN IMMEDIATE (${t.sql})`,
        );
      }
      if (this.snapshot) this.endSnapshot('drain');
      if (this.txn === 'immediate') return this.inSession(step);
      // A write on its own is a transaction of its own, under the lock.
      const a = this.batch({
        steps: [
          this.beginStep(),
          step,
          { sql: 'COMMIT', simple: true, commit: true, expectCommit: true },
        ],
        retry: 'write',
        rollback: true,
      });
      return a.results[1] ?? NO_RESULT;
    }
    if (this.txn !== null || this.snapshot) return this.inSession(step);
    return this.batch({ steps: [step], retry: 'read' }).results[0] ?? NO_RESULT;
  }

  /** Rows through a cursor, fetched as they are read (see the top of this file). */
  iterate(t: Translation, params: unknown[]): IterableIterator<SqlRow> {
    this.assertUsable(false);
    if (t.kind !== 'read' || !CURSOR_QUERY.test(t.sql)) {
      const r = this.execute(t, params, 'all');
      let at = 0;
      return new RowIterator(
        () => {
          const values = r.rows[at++];
          return values ? rowOf(r.fields, values) : undefined;
        },
        () => {
          at = r.rows.length;
        },
      );
    }
    const c: Cursor = {
      name: `o${this.nextCursor++}`,
      sql: t.sql.replace(/;\s*$/, ''),
      params,
      state: 'new',
      implicit: false,
      fields: [],
      rows: [],
      at: 0,
      batch: FETCH_FIRST,
      error: null,
    };
    return new RowIterator(
      () => this.pull(c),
      () => this.stop(c),
    );
  }

  private pull(c: Cursor): SqlRow | undefined {
    for (;;) {
      if (c.error) throw c.error;
      const values = c.rows[c.at];
      if (values) {
        c.at++;
        return rowOf(c.fields, values);
      }
      if (c.state === 'held' || c.state === 'closed') return undefined;
      try {
        if (c.state === 'new') this.declare(c);
        else this.fetch(c);
      } catch (err) {
        // Rows that failed to arrive are gone from the cursor: it cannot go on.
        if (c.state === 'open') this.stop(c);
        if (!c.error) this.fail(c, err as Error);
        throw err;
      }
    }
  }

  /** Declare the cursor and fetch its first rows: in the transaction, or in the snapshot. */
  private declare(c: Cursor): void {
    this.assertUsable(false);
    const starting = this.txn === null && !this.snapshot;
    const steps: Step[] = [];
    if (starting)
      steps.push({ sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', simple: true });
    steps.push(
      { sql: `DECLARE ${c.name} NO SCROLL CURSOR FOR ${c.sql}`, params: c.params },
      { sql: `FETCH ${c.batch} FROM ${c.name}`, fetch: c.batch, want: 'all', cap: RESULT_CAP },
      { sql: `CLOSE ${c.name}`, simple: true, ifDone: true },
    );
    if (starting) steps.push({ sql: 'COMMIT', simple: true, ifDone: true });
    const fetched = starting ? 2 : 1;
    const a = starting
      ? this.batch({ steps, retry: 'read', rollback: true })
      : this.inSession(steps, true);
    if (starting && !a.done) {
      this.snapshot = true;
      this.conn = a.conn;
      this.scheduleSweep();
    }
    const r = a.results[fetched] as StepResult;
    c.implicit = this.txn === null;
    c.fields = r.fields;
    c.rows = r.rows;
    c.at = 0;
    c.batch = nextBatch(c.batch, r.rows.length, r.bytes);
    c.state = a.done ? 'closed' : 'open';
    if (!a.done) this.cursors.add(c);
  }

  private fetch(c: Cursor): void {
    this.assertUsable(false);
    const last = c.implicit && this.implicitCursors() === 1;
    const steps: Step[] = [
      { sql: `FETCH ${c.batch} FROM ${c.name}`, fetch: c.batch, want: 'all', cap: RESULT_CAP },
      { sql: `CLOSE ${c.name}`, simple: true, ifDone: true },
    ];
    if (last) steps.push({ sql: 'COMMIT', simple: true, ifDone: true });
    const a = this.inSession(steps, true);
    const r = a.results[0] as StepResult;
    c.rows = r.rows;
    c.at = 0;
    c.batch = nextBatch(c.batch, r.rows.length, r.bytes);
    if (a.done) {
      c.state = 'closed';
      this.cursors.delete(c);
      if (last) this.snapshot = false;
    }
  }

  /** The iterator's return(): close its cursor, and the snapshot if it was the last one in it. */
  private stop(c: Cursor): void {
    c.rows = [];
    c.at = 0;
    if (c.state !== 'open') {
      if (c.state === 'new') c.state = 'closed';
      return;
    }
    c.state = 'closed';
    this.cursors.delete(c);
    if (!this.open || (this.txn === null && !this.snapshot)) return;
    const last = c.implicit && this.implicitCursors() === 0;
    const steps: Step[] = [{ sql: `CLOSE ${c.name}`, simple: true }];
    if (last) steps.push({ sql: 'COMMIT', simple: true });
    try {
      this.batch({ steps, conn: this.conn });
      if (last) this.snapshot = false;
    } catch {
      // Lost, or the transaction failed: a ROLLBACK ends it. The iterator ends either way.
      if (last && this.snapshot) this.endSnapshot('rollback');
    }
  }

  private implicitCursors(): number {
    let n = 0;
    for (const c of this.cursors) if (c.implicit) n++;
    return n;
  }

  /**
   * End the snapshot of the cursors outside a transaction: `drain` reads what is left of them into
   * memory and commits, so that they go on from there; `close` closes them, and reading them further
   * fails; `rollback`, after an error in the snapshot, fails them with `why`.
   */
  private endSnapshot(how: 'drain' | 'close' | 'rollback', why?: Error): void {
    const open = [...this.cursors].filter((c) => c.implicit);
    for (const c of open) this.cursors.delete(c);
    this.snapshot = false;
    if (how === 'rollback') {
      const reason = why ? `: ${why.message}` : '';
      for (const c of open) {
        this.fail(c, new Error(`the snapshot this iterator read ended after an error${reason}`));
      }
      try {
        this.batch({ steps: [{ sql: 'ROLLBACK', simple: true }], conn: this.conn });
      } catch {
        // Lost: the server rolled it back.
      }
      return;
    }
    const steps: Step[] = [];
    for (const c of open) {
      if (how === 'drain')
        steps.push({ sql: `FETCH ALL FROM ${c.name}`, want: 'all', cap: this.cap });
      steps.push({ sql: `CLOSE ${c.name}`, simple: true });
    }
    steps.push({ sql: 'COMMIT', simple: true });
    let a: Answer;
    try {
      a = this.batch({ steps, conn: this.conn });
    } catch (err) {
      for (const c of open) this.fail(c, err as Error);
      if (!(err instanceof ConnectionLostError)) {
        try {
          this.batch({ steps: [{ sql: 'ROLLBACK', simple: true }], conn: this.conn });
        } catch {
          // Lost: the server rolled it back.
        }
      }
      throw err;
    }
    open.forEach((c, i) => {
      if (how === 'close') {
        this.fail(
          c,
          new Error(
            'this iterator was closed: on PostgreSQL an iterator outside a transaction is read, or closed, before the event loop turns',
          ),
        );
        return;
      }
      this.hold(c, a.results[2 * i] as StepResult);
    });
  }

  private fail(c: Cursor, err: Error): void {
    c.error = err;
    c.state = 'closed';
    c.rows = [];
    c.at = 0;
  }

  /** Close the snapshot's cursors once the task that opened them is over. */
  private scheduleSweep(): void {
    if (this.sweep) return;
    this.sweep = setImmediate(() => {
      this.sweep = null;
      if (!this.open || !this.snapshot) return;
      try {
        this.endSnapshot('close');
      } catch {
        // Lost: the cursors have failed already.
      }
    });
    this.sweep.unref();
  }

  private control(c: TransactionControl, sql: string): void {
    switch (c.op) {
      case 'begin': {
        if (this.isTransaction)
          throw sqliteError('cannot start a transaction within a transaction');
        if (this.snapshot) this.endSnapshot('drain');
        const step: Step =
          c.mode === 'deferred'
            ? { sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', simple: true }
            : this.beginStep();
        const a = this.batch({ steps: [step], retry: 'read', rollback: true });
        this.conn = a.conn;
        this.txn = c.mode === 'deferred' ? 'deferred' : 'immediate';
        return;
      }
      case 'commit': {
        if (this.ended) throw this.endedError();
        if (!this.txn) throw sqliteError('cannot commit - no transaction is active');
        const open = [...this.cursors];
        this.cursors.clear();
        const steps: Step[] = [];
        for (const cur of open) {
          steps.push(
            { sql: `FETCH ALL FROM ${cur.name}`, want: 'all', cap: this.cap },
            { sql: `CLOSE ${cur.name}`, simple: true },
          );
        }
        steps.push({ sql: 'COMMIT', simple: true, commit: true, expectCommit: true });
        try {
          const a = this.batch({ steps, conn: this.conn });
          // The transaction's cursors go on from memory.
          open.forEach((cur, i) => {
            this.hold(cur, a.results[2 * i] as StepResult);
          });
          this.txn = null;
        } catch (err) {
          for (const cur of open) this.fail(cur, err as Error);
          if (this.txn) {
            // A COMMIT that fails ends the transaction on the server (a FETCH that fails before it
            // leaves it to a ROLLBACK); here it waits for the caller's ROLLBACK, as in SQLite.
            try {
              this.batch({ steps: [{ sql: 'ROLLBACK', simple: true }], conn: this.conn });
            } catch {
              // Lost: the server rolled it back.
            }
            this.txn = null;
            this.ended ??= 'failed';
          }
          throw err;
        }
        return;
      }
      case 'rollback': {
        if (this.ended) {
          this.ended = null;
          return;
        }
        if (!this.txn) throw sqliteError('cannot rollback - no transaction is active');
        const open = [...this.cursors];
        this.cursors.clear();
        for (const cur of open) {
          this.fail(cur, new Error('the transaction this iterator read in was rolled back'));
        }
        try {
          this.batch({ steps: [{ sql: 'ROLLBACK', simple: true }], conn: this.conn });
        } catch (err) {
          // A lost connection has rolled it back already.
          if (!(err instanceof ConnectionLostError)) throw err;
          this.ended = null;
        } finally {
          this.txn = null;
        }
        return;
      }
      default: {
        // SAVEPOINT, ROLLBACK TO, RELEASE: as they are, inside a transaction. In one that has
        // ended, ROLLBACK TO and RELEASE do nothing, as ROLLBACK does.
        if (this.ended) {
          if (c.op === 'savepoint') throw this.endedError();
          return;
        }
        if (!this.txn) {
          throw sqliteError(
            c.op === 'savepoint'
              ? 'SAVEPOINT outside a transaction: on PostgreSQL begin one first (BEGIN IMMEDIATE)'
              : `no such savepoint: ${c.name}`,
          );
        }
        this.inSession({ sql, simple: true });
      }
    }
  }

  /** A cursor's rows from here on are in memory: what it had, then the rest (`fetched`). */
  private hold(c: Cursor, fetched: StepResult): void {
    c.rows = c.rows.slice(c.at).concat(fetched.rows);
    c.at = 0;
    c.state = 'held';
  }

  /** The BEGIN batch of a writing transaction (see the top of this file). */
  private beginStep(): Step {
    return {
      sql: `BEGIN; SET LOCAL lock_timeout = ${this.waitMs}; SELECT pg_advisory_xact_lock(origin_lock_key()); SELECT version, moved_to FROM store_format`,
      simple: true,
      store: STORE_VERSION,
    };
  }

  /** Rows of SQL for PostgreSQL, read as any read is (in the transaction or snapshot if one is open). */
  private rows(sql: string, params: unknown[]): SqlRow[] {
    const r = this.execute(native(sql, params.length, 'read'), params, 'all');
    return r.rows.map((values) => rowOf(r.fields, values));
  }

  /** A step on the connection of the open transaction or snapshot, and its result. */
  private inSession(step: Step): StepResult;
  /** Steps on the connection of the open transaction or snapshot. */
  private inSession(steps: Step[], all: true): Answer;
  private inSession(step: Step | Step[], all?: true): StepResult | Answer {
    try {
      const a = this.batch({ steps: Array.isArray(step) ? step : [step], conn: this.conn });
      return all ? a : (a.results[0] ?? NO_RESULT);
    } catch (err) {
      // An error from the server has aborted the snapshot: its cursors cannot go on.
      if (this.snapshot && this.txn === null && err instanceof PgError) {
        this.endSnapshot('rollback', err);
      }
      throw err;
    }
  }

  private batch(req: Request): Answer {
    return this.call<Answer>({ op: 'batch', ...req });
  }

  private call<T>(request: Record<string, unknown>): T {
    this.assertOpen();
    try {
      return this.worker.call<T>(request, { timeoutMs: this.callTimeoutMs });
    } catch (err) {
      throw this.failed(err);
    }
  }

  /** The error to throw for what the worker threw. */
  private failed(err: unknown): Error {
    const e = err as Error & Record<string, unknown>;
    const message = redact(String(e?.message ?? err), this.target.secrets);
    if (err instanceof SyncWorkerError || e?.name === 'ConnectionLostError') {
      this.lose();
      return new ConnectionLostError(
        err instanceof SyncWorkerError
          ? `the connection to the database was lost: ${message}`
          : message,
        e.committing === true,
      );
    }
    if (e?.name === 'StoreUpgradedError') return new StoreUpgradedError();
    if (e?.name === 'SessionLockError') return new OriginError(message);
    if (e?.name === 'StoreMovedError') {
      return new OriginError(
        `This store has been moved to ${redact(String(e.movedTo), this.target.secrets)}; it is no longer written here.`,
      );
    }
    if (e?.name === 'RangeError') return Object.assign(new RangeError(message), { code: e.code });
    if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      if (e.code === '55P03') {
        return new PgError(
          "database is locked: another Origin process holds the store's write lock",
          e,
          message,
        );
      }
      if (e.code === '57014') return new PgError('statement timed out', e, message);
      return new PgError(message, e);
    }
    return Object.assign(new Error(message), typeof e?.code === 'string' ? { code: e.code } : {});
  }

  /** The connection is gone, and with it any transaction, snapshot, and cursor. */
  private lose(): void {
    if (this.txn) this.ended = 'lost';
    this.txn = null;
    this.snapshot = false;
    this.conn = null;
    const err = new ConnectionLostError('the connection to the database was lost while reading');
    for (const c of this.cursors) this.fail(c, err);
    this.cursors.clear();
  }

  private endedError(): Error {
    return this.ended === 'lost'
      ? new ConnectionLostError('the transaction ended when its connection was lost: roll it back')
      : new Error('the transaction ended when its COMMIT failed: roll it back');
  }

  private assertOpen(): void {
    if (!this.open) {
      throw Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' });
    }
  }

  /** Open, and not in a transaction that has ended (but for transaction control). */
  private assertUsable(control: boolean): void {
    this.assertOpen();
    if (this.ended && !control) throw this.endedError();
  }
}

/** SQL for PostgreSQL as a translation of itself. */
function native(sql: string, params: number, kind: Translation['kind']): Translation {
  return { sql, params, statements: 1, kind };
}
