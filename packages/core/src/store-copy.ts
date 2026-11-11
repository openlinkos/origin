import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Database, SqlRow, SqlValue, Statement } from './database.js';
import { connectSqlite, transaction } from './db.js';
import { OriginError } from './errors.js';
import { STORE_VERSION } from './migrations.js';
import { missingObjects, PG_OBJECTS, PG_PRESENT_HERE_SQL } from './pg/schema.js';
import { SCHEMA } from './schema.js';
import { rebuildSearchIndexes, searchEvents } from './search.js';
import { BLOCK_BITS } from './search-driver.js';

/**
 * A store copied whole from one database into another, empty one, in either engine (see
 * docs/architecture.md#database-engines): `origin db move`, which moves a hub's store between
 * SQLite and PostgreSQL, and `origin backup` of a store in PostgreSQL, which exports it to SQLite.
 *
 * Every row of every table is copied as it is, keys included: event seq, change_log and recall seq,
 * audit ids, and the rowids of entry and tombstone (a column in PostgreSQL), so that cursors on them
 * (a device's on change_log, the change feed's on event) go on as before. Tables are copied in an
 * order that inserts each row after those it references, and in each table in the order of its key.
 * What search derives from the events is computed in the target, after the rows: SQLite's FTS5
 * indexes and CJK index, PostgreSQL's event_cjk and event_prompt (with GIN indexes created after the
 * load), and event_block, with PostgreSQL's counters. Triggers are created after the load, so that
 * none fires on a copied row (change_log, for one, is copied, not written again).
 *
 * The copy is checked before it counts: the same rows in each table (a digest of each table's
 * rows, every value written with its type: see TableDigest), the blocks the events give, a few
 * searches, and in SQLite its integrity and foreign keys. Into PostgreSQL the whole copy is one
 * transaction, checked before it commits; into SQLite it is a file that the caller names only once
 * it is checked (copyToSqliteFile).
 */

/** What search derives from the events, computed in the target; and the version, stamped there. */
const DERIVED = new Set(['store_format', 'event_block', 'event_cjk', 'event_prompt']);

/** The tables a copy carries, each after the tables it references. */
export const COPIED_TABLES: readonly string[] = PG_OBJECTS.filter(
  (o) => o.kind === 'table' && !DERIVED.has(o.name),
).map((o) => o.name);

/** Tables keyed, for the copy, by their rowid: SQLite's implicit one, a column in PostgreSQL. */
const ROWID_TABLES = new Set(['entry', 'tombstone']);

/** SQLite's search indexes and their shadow tables. */
const SQLITE_SEARCH = /^(event_fts|message_fts|event_cjk|entry_fts)(_|$)/;

/** The most rows, and parameters, of one INSERT into PostgreSQL, and the text it aims at. */
const BATCH_ROWS = 1_000;
const BATCH_PARAMS = 60_000;
const BATCH_BYTES = 8 * 1024 * 1024;

/** How many searches of the store are compared with the copy's, by default. */
const SEARCHES = 8;

/** The memory PostgreSQL may use to build each index of the copy. */
const INDEX_MEMORY = '256MB';

type Category = 'int' | 'real' | 'text';

interface Column {
  name: string;
  category: Category;
}

interface TableSpec {
  table: string;
  columns: Column[];
  key: string[];
}

/** The rows of one table of a copy, and their digest (see digestRow). */
export interface TableCopy {
  table: string;
  rows: number;
  sha256: string;
}

export interface CopyOptions {
  /** The store id a target in PostgreSQL records (store_format.store_id); a new one by default. */
  storeId?: string;
  /** How many searches to compare between the store and the copy (8 by default; 0 for none). */
  searches?: number;
  /** Progress, as the copy goes. */
  log?: (message: string) => void;
}

export interface CopyResult {
  /** Every table copied, in the order copied. */
  tables: TableCopy[];
  /** The digest of event_block as the store's events give it. */
  eventBlock: string;
  /** The searches compared. */
  searches: string[];
  /** Milliseconds spent loading the rows, building what is derived, and checking. */
  ms: { load: number; derive: number; check: number };
}

/** A copy that does not match the store. */
export class CopyMismatchError extends OriginError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The copy does not match the store: ${problems.join('; ')}.`);
    this.problems = problems;
  }
}

const quote = (name: string) => `"${name}"`;

function category(type: string): Category | null {
  switch (type.toLowerCase()) {
    case 'integer':
    case 'bigint':
    case 'smallint':
      return 'int';
    case 'real':
    case 'double precision':
      return 'real';
    case 'text':
      return 'text';
    default:
      return null;
  }
}

/** The columns of `table`, with their declared types and places in the primary key (0: none). */
function catalogColumns(
  db: Database,
  table: string,
): Array<{ name: string; type: string; pk: number }> {
  const sql =
    db.dialect === 'sqlite'
      ? 'SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid'
      : `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
           coalesce((SELECT k.n FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
                      WHERE k.attnum = a.attnum), 0) AS pk
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisprimary
         WHERE n.nspname = current_schema() AND c.relname = ? AND a.attnum > 0
           AND NOT a.attisdropped
         ORDER BY a.attnum`;
  return db.prepare(sql).all(table) as unknown as Array<{ name: string; type: string; pk: number }>;
}

/** What a copy reads and writes of `table` in `db`. */
function tableSpec(db: Database, table: string): TableSpec {
  const found = catalogColumns(db, table);
  if (found.length === 0) throw new OriginError(`The store has no table ${table}.`);
  const columns: Column[] = found.map((c) => {
    const cat = category(c.type);
    if (!cat)
      throw new OriginError(`${table}.${c.name} has type ${c.type}, which a copy cannot carry.`);
    return { name: c.name, category: cat };
  });
  if (!ROWID_TABLES.has(table)) {
    const key = found
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name);
    return { table, columns, key: key.length > 0 ? key : columns.map((c) => c.name) };
  }
  if (db.dialect === 'sqlite') columns.unshift({ name: 'rowid', category: 'int' });
  return { table, columns, key: ['rowid'] };
}

/** The tables of `db` a copy would leave out, which it must not: those it does not know. */
function unknownTables(db: Database): string[] {
  const known = new Set([...COPIED_TABLES, ...DERIVED]);
  const tables =
    db.dialect === 'sqlite'
      ? (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
            )
            .all() as Array<{ name: string }>
        )
          .map((r) => r.name)
          .filter((name) => !SQLITE_SEARCH.test(name))
      : (db.prepare(PG_PRESENT_HERE_SQL).all() as Array<{ kind: string; name: string }>)
          .filter((o) => o.kind === 'table')
          .map((o) => o.name);
  return tables.filter((t) => !known.has(t));
}

/** A text as PostgreSQL keeps it: U+0000 and lone surrogates, which its text cannot hold, as U+FFFD. */
function storedText(text: string): string {
  let out = text;
  if (out.includes('\0')) out = out.replaceAll('\0', '�');
  if (/[\uD800-\uDFFF]/.test(out)) {
    out = out.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '�',
    );
  }
  return out;
}

/** One value as the digest writes it: its type, then the value, the same from either engine. */
function canonical(value: SqlValue, cat: Category): string {
  if (value === null || value === undefined) return 'n';
  if (value instanceof Uint8Array) return `b${Buffer.from(value).toString('hex')}`;
  if (cat === 'text') {
    const text = storedText(String(value));
    return `s${text.length}:${text}`;
  }
  return `${cat === 'int' ? 'i' : 'r'}${typeof value === 'bigint' ? value.toString() : String(Number(value))}`;
}

/** 2^256 - 1: a table's digest adds up its rows' SHA-256 modulo 2^256. */
const MASK = (1n << 256n) - 1n;

/**
 * The digest of a table's rows, whatever the order they are read in: the SHA-256 of the number of
 * rows and of the sum, modulo 2^256, of each row's SHA-256 (its columns by name, each value written
 * with its type). The same rows give the same digest in either engine, although PostgreSQL may
 * order them otherwise: a text's U+0000 is U+FFFD there.
 */
class TableDigest {
  private readonly order: Column[];
  private sum = 0n;
  rows = 0;

  constructor(columns: Column[]) {
    this.order = [...columns].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  add(row: SqlRow): void {
    let line = '';
    for (const c of this.order)
      line += `${c.name}=${canonical(row[c.name] ?? null, c.category)}\x1f`;
    const h = createHash('sha256').update(line, 'utf8').digest('hex');
    this.sum = (this.sum + BigInt(`0x${h}`)) & MASK;
    this.rows++;
  }

  digest(table: string): TableCopy {
    const sha256 = createHash('sha256')
      .update(`${this.rows}:${this.sum.toString(16)}`)
      .digest('hex');
    return { table, rows: this.rows, sha256 };
  }
}

/** Every row of `spec`'s table, in the order of its key. */
function selectAll(spec: TableSpec): string {
  return `SELECT ${spec.columns.map((c) => quote(c.name)).join(', ')} FROM ${quote(spec.table)} ORDER BY ${spec.key.map(quote).join(', ')}`;
}

/** Every row of `spec`'s table in `db`, digested. */
function digestTable(db: Database, spec: TableSpec): TableCopy {
  const d = new TableDigest(spec.columns);
  for (const row of db.prepare(selectAll(spec)).iterate()) d.add(row);
  return d.digest(spec.table);
}

/**
 * The rows of every table a copy carries, digested as a copy digests them: equal for a store and
 * its copy, in either engine.
 */
export function digestStore(db: Database): TableCopy[] {
  return COPIED_TABLES.map((t) => digestTable(db, tableSpec(db, t)));
}

/**
 * The digest of event_block: as `db` keeps it (`stored`), or as its events give it (`events`), which
 * is what a copy rebuilds (a purge leaves a deleted event's time in its block).
 */
function blockDigest(db: Database, from: 'stored' | 'events'): string {
  const sql =
    from === 'stored'
      ? 'SELECT block, max_ts, latest_ts FROM event_block ORDER BY block'
      : `SELECT block, max_ts, MAX(max_ts) OVER (ORDER BY block ROWS UNBOUNDED PRECEDING) AS latest_ts
         FROM (SELECT seq >> ${BLOCK_BITS} AS block, MAX(ts) AS max_ts FROM event GROUP BY 1) AS b
         ORDER BY block`;
  const hash = createHash('sha256');
  for (const r of db.prepare(sql).iterate() as Iterable<{
    block: number;
    max_ts: number;
    latest_ts: number;
  }>) {
    hash.update(`${r.block} ${r.max_ts} ${r.latest_ts}\n`);
  }
  return hash.digest('hex');
}

/**
 * What in a store in SQLite a copy could not carry as it is: values whose type is not the one
 * declared (SQLite keeps what it is given), and rows whose references are broken. A real number
 * with no fraction in an INTEGER column is carried as the integer it is.
 */
/**
 * Whether this Node.js reads a text holding U+0000 from SQLite whole. Node.js 22.16's node:sqlite
 * stores such a text whole but reads it only up to that character, so a copy would keep the rest
 * of it nowhere, and its digests, read the same way, would not tell.
 */
export function sqliteReadsNul(db: Database): boolean {
  const row = db.prepare("SELECT 'a' || char(0) || 'b' AS x").get() as { x: string };
  return row.x.length === 3;
}

/** The text columns holding U+0000, which this Node.js cannot read whole (see sqliteReadsNul). */
function unreadableTexts(db: Database, specs: TableSpec[]): string[] {
  if (sqliteReadsNul(db)) return [];
  const problems: string[] = [];
  for (const spec of specs) {
    const columns = spec.columns.filter((c) => c.category === 'text');
    if (columns.length === 0) continue;
    const counts = db
      .prepare(
        `SELECT ${columns.map((c, i) => `SUM(CASE WHEN instr(${quote(c.name)}, char(0)) > 0 THEN 1 ELSE 0 END) AS n${i}`).join(', ')} FROM ${quote(spec.table)}`,
      )
      .get() as Record<string, number | null>;
    columns.forEach((c, i) => {
      const n = Number(counts[`n${i}`] ?? 0);
      if (n > 0) {
        problems.push(
          `${spec.table}.${c.name} holds U+0000 in ${n} row${n === 1 ? '' : 's'}, which Node.js ${process.versions.node} reads only up to that character: copy the store with a newer Node.js, such as 24`,
        );
      }
    });
  }
  return problems;
}

function preflight(db: Database, specs: TableSpec[]): string[] {
  const problems: string[] = unreadableTexts(db, specs);
  const bad = (c: Column) => {
    const v = quote(c.name);
    switch (c.category) {
      case 'int':
        return `(typeof(${v}) NOT IN ('integer', 'null') AND NOT (typeof(${v}) = 'real' AND ${v} = CAST(${v} AS INTEGER))) OR ${v} > 9007199254740991 OR ${v} < -9007199254740991`;
      case 'real':
        return `typeof(${v}) NOT IN ('integer', 'real', 'null')`;
      case 'text':
        return `typeof(${v}) NOT IN ('text', 'null')`;
    }
  };
  const want = { int: 'an integer', real: 'a number', text: 'text' };
  for (const spec of specs) {
    const columns = spec.columns.filter((c) => c.name !== 'rowid');
    const counts = db
      .prepare(
        `SELECT ${columns.map((c, i) => `SUM(CASE WHEN ${bad(c)} THEN 1 ELSE 0 END) AS b${i}`).join(', ')} FROM ${quote(spec.table)}`,
      )
      .get() as Record<string, number | null>;
    columns.forEach((c, i) => {
      const n = Number(counts[`b${i}`] ?? 0);
      if (n === 0) return;
      const keys = db
        .prepare(
          `SELECT ${spec.key.map(quote).join(', ')} FROM ${quote(spec.table)} WHERE ${bad(c)} LIMIT 3`,
        )
        .all()
        .map((r) => spec.key.map((k) => String(r[k])).join('/'));
      problems.push(
        `${spec.table}.${c.name} holds a value that is not ${want[c.category]} in ${n} row${n === 1 ? '' : 's'} (${keys.join(', ')}${n > keys.length ? ', …' : ''})`,
      );
    });
  }
  const broken = db.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    parent: string;
  }>;
  const byPair = new Map<string, number>();
  for (const r of broken) {
    const k = `${r.table} → ${r.parent}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }
  for (const [pair, n] of byPair) {
    problems.push(
      `${n} row${n === 1 ? '' : 's'} of ${pair} reference${n === 1 ? 's' : ''} a row that is not there`,
    );
  }
  return problems;
}

/**
 * Refuse a target that holds anything a copy could overwrite: a target in SQLite must be an empty
 * database, one in PostgreSQL an empty schema (what the client creates on connecting may be there).
 */
export function assertCopyTarget(db: Database): void {
  if (db.dialect === 'sqlite') {
    if (db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) {
      throw new OriginError(`The copy's database ${db.location()} is not empty.`);
    }
    return;
  }
  const tables = (db.prepare(PG_PRESENT_HERE_SQL).all() as Array<{ kind: string; name: string }>)
    .filter((o) => o.kind === 'table' && o.name !== 'store_format')
    .map((o) => o.name);
  if (db.formatVersion() !== 0 || tables.length > 0) {
    throw new OriginError(
      `${db.location()} is not empty${tables.length > 0 ? `: it has the tables ${tables.slice(0, 5).join(', ')}${tables.length > 5 ? ', …' : ''}` : ''}. A store is copied into an empty schema only.`,
    );
  }
}

/** Writes rows into a table of the copy: one at a time into SQLite, in batches into PostgreSQL. */
class Writer {
  private rows: SqlValue[][] = [];
  private bytes = 0;
  private readonly perBatch: number;
  private readonly statements = new Map<number, Statement>();

  constructor(
    private readonly db: Database,
    private readonly spec: TableSpec,
  ) {
    this.perBatch =
      db.dialect === 'sqlite'
        ? 1
        : Math.max(1, Math.min(BATCH_ROWS, Math.floor(BATCH_PARAMS / spec.columns.length)));
  }

  private statement(n: number): Statement {
    let s = this.statements.get(n);
    if (!s) {
      const one = `(${this.spec.columns.map(() => '?').join(', ')})`;
      s = this.db.prepare(
        `INSERT INTO ${quote(this.spec.table)} (${this.spec.columns.map((c) => quote(c.name)).join(', ')}) VALUES ${Array(n).fill(one).join(', ')}`,
      );
      this.statements.set(n, s);
    }
    return s;
  }

  add(row: SqlRow): void {
    const values = this.spec.columns.map((c) => row[c.name] ?? null);
    if (this.perBatch === 1) {
      this.statement(1).run(...values);
      return;
    }
    this.rows.push(values);
    for (const v of values) if (typeof v === 'string') this.bytes += v.length;
    if (this.rows.length >= this.perBatch || this.bytes >= BATCH_BYTES) this.flush();
  }

  flush(): void {
    if (this.rows.length === 0) return;
    this.statement(this.rows.length).run(...this.rows.flat());
    this.rows = [];
    this.bytes = 0;
  }
}

/** Load every table of the store into the copy, digesting what is read. */
function load(
  source: Database,
  target: Database,
  specs: TableSpec[],
  log: (message: string) => void,
): TableCopy[] {
  const copied: TableCopy[] = [];
  for (const spec of specs) {
    const digest = new TableDigest(spec.columns);
    const writer = new Writer(target, spec);
    for (const row of source.prepare(selectAll(spec)).iterate()) {
      digest.add(row);
      writer.add(row);
    }
    writer.flush();
    const done = digest.digest(spec.table);
    if (done.rows >= 10_000) log(`Copied ${done.rows} rows of ${spec.table}.`);
    copied.push(done);
  }
  return copied;
}

/** The terms of a few searches of the store: words of its messages, spread over its arrivals. */
function sampleTerms(db: Database, n: number): string[] {
  if (n <= 0) return [];
  const range = db
    .prepare("SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM event WHERE kind = 'message'")
    .get() as { lo: number | null; hi: number | null };
  if (range.lo === null || range.hi === null) return [];
  const next = db.prepare(
    "SELECT text FROM event WHERE kind = 'message' AND seq >= ? ORDER BY seq LIMIT 1",
  );
  const terms = new Set<string>();
  for (let i = 0; i < n; i++) {
    const at = range.lo + Math.floor(((range.hi - range.lo) * (2 * i + 1)) / (2 * n));
    const row = next.get(at) as { text: string } | undefined;
    if (!row) continue;
    const word = /[A-Za-z]{4,12}/.exec(row.text)?.[0];
    if (word) terms.add(word.toLowerCase());
    const han = /\p{Script=Han}{2}/u.exec(row.text)?.[0];
    if (han) terms.add(han);
  }
  return [...terms];
}

/** The newest matches of each search, by event id: what the copy must find too. */
function searchAll(db: Database, terms: string[]): string[][] {
  return terms.map((t) => searchEvents(db, t, { order: 'recent', limit: 20 }).map((h) => h.id));
}

/**
 * The events whose text holds U+0000, in SQLite: its LIKE reads a text only up to the first one,
 * so a search there misses a word after it, which PostgreSQL, keeping the character as U+FFFD,
 * finds. Only a store in SQLite holds the character; a copy from PostgreSQL holds U+FFFD instead.
 */
function nulTexts(db: Database): Set<string> {
  if (db.dialect !== 'sqlite') return new Set();
  const rows = db.prepare('SELECT id FROM event WHERE instr(text, char(0)) > 0').all() as Array<{
    id: string;
  }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether two lists of the newest matches agree, leaving out `skipped` events: where one engine
 * finds such an event and the other does not, it takes a place in one list only, so the shorter
 * list must be the start of the longer.
 */
function sameMatches(a: string[], b: string[], skipped: Set<string>): boolean {
  const x = a.filter((id) => !skipped.has(id));
  const y = b.filter((id) => !skipped.has(id));
  const n = Math.min(x.length, y.length);
  if (skipped.size === 0 && x.length !== y.length) return false;
  return x.slice(0, n).every((id, i) => id === y[i]);
}

/**
 * Check `target` against what was copied into it (see CopyResult): the rows of every table, the
 * blocks, and on SQLite its integrity and foreign keys; and, given the store, the same results of
 * `copied.searches` in both. Returns the problems found, none if the copy matches.
 */
export function verifyCopy(
  target: Database,
  copied: CopyResult,
  source: Database | null = null,
): string[] {
  const problems: string[] = [];
  for (const t of copied.tables) {
    const d = digestTable(target, tableSpec(target, t.table));
    if (d.rows !== t.rows)
      problems.push(`${t.table} has ${d.rows} rows in the copy, not ${t.rows}`);
    else if (d.sha256 !== t.sha256) problems.push(`the rows of ${t.table} differ in the copy`);
  }
  if (blockDigest(target, 'stored') !== copied.eventBlock) {
    problems.push('event_block of the copy differs from what the events give');
  }
  if (target.dialect === 'postgres') {
    const off = target
      .prepare(
        `SELECT (SELECT coalesce(SUM(docs), 0) FROM event_block) - (SELECT count(*) FROM event) AS docs,
           (SELECT coalesce(SUM(message_docs), 0) FROM event_block)
             - (SELECT count(*) FROM event WHERE kind = 'message') AS messages`,
      )
      .get() as { docs: number; messages: number };
    if (Number(off.docs) !== 0 || Number(off.messages) !== 0) {
      problems.push("event_block's counts of the copy differ from its events");
    }
  } else {
    const integrity = target.prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      problems.push(
        `the copy fails SQLite's integrity check: ${integrity
          .slice(0, 3)
          .map((r) => r.integrity_check)
          .join('; ')}`,
      );
    }
    const broken = target.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) problems.push(`${broken.length} rows of the copy break a foreign key`);
  }
  if (source && copied.searches.length > 0) {
    const want = searchAll(source, copied.searches);
    const got = searchAll(target, copied.searches);
    const skipped = new Set([...nulTexts(source), ...nulTexts(target)]);
    copied.searches.forEach((term, i) => {
      if (!sameMatches(want[i] ?? [], got[i] ?? [], skipped)) {
        problems.push(`a search for "${term}" finds other events in the copy`);
      }
    });
  }
  return problems;
}

/**
 * Copy the store `source`, at the latest format version, into `target`, an empty database (in
 * PostgreSQL, an empty schema: what the client creates on connecting may be there), and check the
 * copy (see the top of this file). The store is read in one transaction: the caller's, if one is
 * open (to keep the store from changing until the copy is in use), else a read of its own, which
 * lets other processes go on writing. Throws CopyMismatchError, having left nothing in a target in
 * PostgreSQL, if the copy does not match; a target in SQLite is then the caller's to remove.
 */
export function copyStore(source: Database, target: Database, opts: CopyOptions = {}): CopyResult {
  if (source.formatVersion() !== STORE_VERSION) {
    throw new OriginError(
      `The store has format version ${source.formatVersion()}, not ${STORE_VERSION}: open it with this Origin first, which upgrades it.`,
    );
  }
  assertCopyTarget(target);
  if (source.isTransaction) return copyIn(source, target, opts);
  return transaction(source, () => copyIn(source, target, opts));
}

function copyIn(source: Database, target: Database, opts: CopyOptions): CopyResult {
  const log = opts.log ?? (() => {});
  const unknown = unknownTables(source);
  if (unknown.length > 0) {
    throw new OriginError(
      `The store has tables this Origin does not know (${unknown.join(', ')}): a newer Origin made them. Copy it with that version.`,
    );
  }
  const specs = COPIED_TABLES.map((t) => tableSpec(source, t));
  if (source.dialect === 'sqlite') {
    const problems = preflight(source, specs);
    if (problems.length > 0) {
      throw new OriginError(
        `The store holds what a copy cannot carry as it is; nothing was copied:\n  ${problems.join('\n  ')}`,
      );
    }
  }
  const eventBlock = blockDigest(source, 'events');
  const searches = sampleTerms(source, opts.searches ?? SEARCHES);
  return target.dialect === 'postgres'
    ? intoPostgres(source, target, specs, { eventBlock, searches }, opts, log)
    : intoSqlite(source, target, specs, { eventBlock, searches }, log);
}

/** The table specs of the target must be the store's: the same columns, of the same types. */
function checkColumns(target: Database, specs: TableSpec[]): void {
  for (const spec of specs) {
    const there = tableSpec(target, spec.table);
    const shape = (s: TableSpec) =>
      s.columns
        .map((c) => `${c.name}:${c.category}`)
        .sort()
        .join(',');
    if (shape(there) !== shape(spec)) {
      throw new OriginError(
        `${spec.table} has other columns in the copy (${shape(there)}) than in the store (${shape(spec)}).`,
      );
    }
  }
}

function intoPostgres(
  source: Database,
  target: Database,
  specs: TableSpec[],
  expected: { eventBlock: string; searches: string[] },
  opts: CopyOptions,
  log: (message: string) => void,
): CopyResult {
  return transaction(
    target,
    () => {
      target.exec(`SET LOCAL maintenance_work_mem = '${INDEX_MEMORY}'`);
      const missing = missingObjects(
        target.prepare(PG_PRESENT_HERE_SQL).all() as Array<{ kind: string; name: string }>,
      );
      const now = (kinds: string[]) => missing.filter((o) => kinds.includes(o.kind));
      for (const o of now(['function', 'table'])) target.exec(o.sql);
      checkColumns(target, specs);
      const started = Date.now();
      const tables = load(source, target, specs, log);
      const loaded = Date.now();
      log('Creating the indexes and triggers, and what search derives from the events.');
      for (const o of now(['index', 'trigger'])) target.exec(o.sql);
      rebuildSearchIndexes(target);
      target
        .prepare('INSERT INTO store_format (one, version, store_id) VALUES (true, ?, ?)')
        .run(STORE_VERSION, opts.storeId ?? randomUUID());
      target.exec(
        `ANALYZE ${PG_OBJECTS.filter((o) => o.kind === 'table')
          .map((o) => o.name)
          .join(', ')}`,
      );
      const derived = Date.now();
      log('Checking the copy.');
      const copied: CopyResult = {
        tables,
        ...expected,
        ms: { load: loaded - started, derive: derived - loaded, check: 0 },
      };
      const problems = verifyCopy(target, copied, source);
      if (problems.length > 0) throw new CopyMismatchError(problems);
      copied.ms.check = Date.now() - derived;
      return copied;
    },
    { immediate: true },
  );
}

function intoSqlite(
  source: Database,
  target: Database,
  specs: TableSpec[],
  expected: { eventBlock: string; searches: string[] },
  log: (message: string) => void,
): CopyResult {
  target.exec(SCHEMA);
  // No trigger fires on a copied row: they are created again once the rows are in.
  const triggers = target
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  for (const t of triggers) target.exec(`DROP TRIGGER ${quote(t.name)}`);
  checkColumns(target, specs);
  // Rows go in an order that keeps every reference; the copy's foreign keys are checked after.
  target.exec('PRAGMA foreign_keys = OFF');
  const started = Date.now();
  const tables = transaction(target, () => load(source, target, specs, log), { immediate: true });
  const loaded = Date.now();
  target.exec('PRAGMA foreign_keys = ON');
  log('Creating the triggers, and what search derives from the events.');
  target.exec(SCHEMA);
  rebuildSearchIndexes(target);
  target.setFormatVersion(STORE_VERSION);
  const derived = Date.now();
  log('Checking the copy.');
  const copied: CopyResult = {
    tables,
    ...expected,
    ms: { load: loaded - started, derive: derived - loaded, check: 0 },
  };
  const problems = verifyCopy(target, copied, source);
  if (problems.length > 0) throw new CopyMismatchError(problems);
  copied.ms.check = Date.now() - derived;
  return copied;
}

/** Remove a SQLite database file and what SQLite keeps beside it. */
function removeDatabase(file: string): void {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    fs.rmSync(f, { force: true });
  }
}

/**
 * Copy the store `source` into a new SQLite database at `file` (see copyStore): written as
 * `<file>.partial`, checked, flushed to disk, then renamed to `file`. `file` must not exist.
 */
export function copyToSqliteFile(
  source: Database,
  file: string,
  opts: CopyOptions = {},
): CopyResult {
  if (fs.existsSync(file)) throw new OriginError(`${file} exists already.`);
  const partial = `${file}.partial`;
  removeDatabase(partial);
  const target = connectSqlite(partial);
  let copied: CopyResult;
  try {
    copied = copyStore(source, target, opts);
  } catch (err) {
    target.close();
    removeDatabase(partial);
    throw err;
  }
  target.close();
  const fd = fs.openSync(partial, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(partial, file);
  return copied;
}
