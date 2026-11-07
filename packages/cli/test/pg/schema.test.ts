import {
  comparePath,
  type Database,
  missingObjects,
  openMemoryDatabase,
  PG_OBJECTS,
  PG_PRESENT_HERE_SQL,
  prepareStore,
  STORE_VERSION,
  transaction,
} from '@openlinkos/origin-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { PgDatabase } from '../../src/pg/client.js';
import { connect, onPostgres, open, outside, target, usePostgres } from './helpers.js';

/**
 * The store's schema in PostgreSQL (core's pg/schema.ts) against SQLite's (schema.ts): the same
 * tables, columns, constraints, indexes, and guards but for the differences listed below; keys
 * assigned as SQLite assigns rowids; event_block as SQLite keeps it, with the totals FTS5 keeps;
 * and the SQL functions that stand in for SQLite's JavaScript ones.
 */

usePostgres();

const lite: Database[] = [];
afterEach(() => {
  for (const db of lite.splice(0)) db.close();
});

/** A new store in SQLite, in memory, closed after the test. */
function sqlite(): Database {
  const db = openMemoryDatabase();
  lite.push(db);
  return db;
}

/** A store in PostgreSQL, in a new schema (or `schema`), created or opened as Origin opens one. */
function postgres(schema?: string): PgDatabase {
  const db = open(target(schema));
  prepareStore(db, { home: '' });
  return db;
}

/** What a PostgreSQL store lacks of its schema. */
const missing = (db: Database) =>
  missingObjects(db.prepare(PG_PRESENT_HERE_SQL).all() as Array<{ kind: string; name: string }>);

/** The error `fn` throws. */
function thrown(fn: () => unknown): Error & Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error('expected an error');
}

// --- The schema of each engine, in one shape --------------------------------------------------

interface ColumnShape {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
}

interface TableShape {
  columns: ColumnShape[];
  primaryKey: string[];
  unique: string[];
  foreignKeys: string[];
  checks: string[];
}

interface IndexShape {
  table: string;
  unique: boolean;
  columns: string[];
  where: string | null;
}

interface TriggerShape {
  table: string;
  when: string;
  /** For an append-only guard: `always`, or the guard_lift name that lifts it. */
  guard: string | null;
}

interface SchemaShape {
  tables: Record<string, TableShape>;
  views: string[];
  indexes: Record<string, IndexShape>;
  triggers: Record<string, TriggerShape>;
}

/**
 * An expression as both engines can be compared on: lower case, without casts, `= ANY (ARRAY[…])`
 * as IN, TRIM(BOTH FROM x) as trim(x), and without parentheses or spaces (PostgreSQL prints every
 * expression fully parenthesized).
 */
function expr(s: string): string {
  return s
    .toLowerCase()
    .replace(/::(?:text|bigint|integer|double precision|numeric|boolean)\b/g, '')
    .replace(/=\s*any\s*\(\s*array\[([^\]]*)\]\s*\)/g, ' in ($1)')
    .replace(/trim\(both from /g, 'trim(')
    .replace(/[()\s]/g, '');
}

/** What the parentheses that open at `sql[open]` hold, and where they close. */
function enclosed(sql: string, open: number): [string, number] {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')' && --depth === 0) return [sql.slice(open + 1, i), i];
  }
  throw new Error(`unbalanced: ${sql}`);
}

/** `list` split at the commas outside parentheses and quotes. */
function items(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && c === ',') {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out;
}

const FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

const foreignKey = (from: string[], table: string, to: string[], update: string, del: string) =>
  `(${from.join(', ')}) REFERENCES ${table} (${to.join(', ')}) ON UPDATE ${update} ON DELETE ${del}`;

/** SQLite's schema, from sqlite_master and its pragmas. */
function sqliteShape(db: Database): SchemaShape {
  type Row = { type: string; name: string; tbl: string; sql: string };
  const master = db
    .prepare(
      "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all() as Row[];
  const virtual = master
    .filter((o) => o.type === 'table' && /^CREATE VIRTUAL/i.test(o.sql))
    .map((o) => o.name);
  const shape: SchemaShape = { tables: {}, views: [], indexes: {}, triggers: {} };
  const columnsOf = (index: string) =>
    (db.prepare(`PRAGMA index_info("${index}")`).all() as Array<{ seqno: number; name: string }>)
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
  for (const o of master) {
    if (o.type === 'view') shape.views.push(o.name);
    if (o.type === 'trigger') {
      const m =
        /^CREATE TRIGGER (?:IF NOT EXISTS )?\w+\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)\b.*?\bON\s+(\w+)/is.exec(
          o.sql,
        );
      if (!m) throw new Error(`unread trigger: ${o.sql}`);
      const lift = /guard_lift WHERE name = '(\w+)'/.exec(o.sql)?.[1];
      shape.triggers[o.name] = {
        table: m[3] as string,
        when: `${m[1]} ${m[2]} FOR EACH ROW`.toUpperCase(),
        guard: /is append-only/.test(o.sql) ? (lift ?? 'always') : null,
      };
    }
    if (o.type === 'index') {
      const on = /\bON\s+\w+\s*\(/i.exec(o.sql);
      if (!on) throw new Error(`unread index: ${o.sql}`);
      const [columns, end] = enclosed(o.sql, on.index + on[0].length - 1);
      const where = /^\s*WHERE\s+([\s\S]*)$/i.exec(o.sql.slice(end + 1))?.[1];
      shape.indexes[o.name] = {
        table: o.tbl,
        unique: /^CREATE UNIQUE/i.test(o.sql),
        columns: items(columns).map(expr),
        where: where ? expr(where) : null,
      };
    }
    if (o.type !== 'table' || virtual.some((v) => o.name.startsWith(`${v}_`))) continue;
    if (virtual.includes(o.name)) {
      shape.tables[o.name] = {
        columns: [],
        primaryKey: [],
        unique: [],
        foreignKeys: [],
        checks: [],
      };
      continue;
    }
    const columns = db.prepare(`PRAGMA table_xinfo("${o.name}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const fks = db.prepare(`PRAGMA foreign_key_list("${o.name}")`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>;
    const byId = new Map<number, typeof fks>();
    for (const fk of fks) byId.set(fk.id, [...(byId.get(fk.id) ?? []), fk]);
    const indexes = db.prepare(`PRAGMA index_list("${o.name}")`).all() as Array<{
      name: string;
      origin: string;
    }>;
    const checks: string[] = [];
    for (const m of o.sql.matchAll(/\bCHECK\s*\(/gi)) {
      checks.push(expr(enclosed(o.sql, (m.index as number) + m[0].length - 1)[0]));
    }
    shape.tables[o.name] = {
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        // A primary key is never NULL in PostgreSQL; SQLite allows NULL in one of a table with a
        // rowid (other than its INTEGER PRIMARY KEY), which Origin never writes.
        notNull: c.notnull === 1 || c.pk > 0,
        default: c.dflt_value === null ? null : expr(c.dflt_value),
      })),
      primaryKey: columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
      unique: indexes
        .filter((i) => i.origin === 'u')
        .map((i) => columnsOf(i.name).join(', '))
        .sort(),
      foreignKeys: [...byId.values()]
        .map((list) => {
          const cols = list.sort((a, b) => a.seq - b.seq);
          const first = cols[0] as (typeof fks)[number];
          return foreignKey(
            cols.map((c) => c.from),
            first.table,
            cols.map((c) => c.to),
            first.on_update,
            first.on_delete,
          );
        })
        .sort(),
      checks: checks.sort(),
    };
  }
  shape.views.sort();
  return shape;
}

/** PostgreSQL's schema, from its catalog. */
async function postgresShape(schema: string): Promise<SchemaShape> {
  const shape: SchemaShape = { tables: {}, views: [], indexes: {}, triggers: {} };
  const columns = await outside(
    `SELECT c.relname AS tbl, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS notnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS dflt
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname, a.attnum`,
    [schema],
  );
  const table = (name: string) => {
    shape.tables[name] ??= { columns: [], primaryKey: [], unique: [], foreignKeys: [], checks: [] };
    return shape.tables[name];
  };
  for (const c of columns) {
    table(c.tbl as string).columns.push({
      name: c.name as string,
      type: c.type as string,
      notNull: c.notnull as boolean,
      default: c.dflt === null ? null : expr(c.dflt as string),
    });
  }
  const constraints = await outside(
    `SELECT c.relname AS tbl, k.contype AS type,
       ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS u(n, i)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n
             ORDER BY u.i) AS columns,
       f.relname AS ref,
       ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS u(n, i)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n
             ORDER BY u.i) AS refcolumns,
       k.confupdtype AS onupdate, k.confdeltype AS ondelete,
       pg_catalog.pg_get_expr(k.conbin, k.conrelid) AS expr
     FROM pg_catalog.pg_constraint k
     JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_class f ON f.oid = k.confrelid
     WHERE n.nspname = $1 AND k.contype IN ('p', 'u', 'f', 'c')`,
    [schema],
  );
  for (const k of constraints) {
    const t = table(k.tbl as string);
    const cols = k.columns as string[];
    if (k.type === 'p') t.primaryKey = cols;
    if (k.type === 'u') t.unique.push(cols.join(', '));
    if (k.type === 'c') t.checks.push(expr(k.expr as string));
    if (k.type === 'f') {
      t.foreignKeys.push(
        foreignKey(
          cols,
          k.ref as string,
          k.refcolumns as string[],
          FK_ACTIONS[k.onupdate as string] as string,
          FK_ACTIONS[k.ondelete as string] as string,
        ),
      );
    }
  }
  for (const t of Object.values(shape.tables)) {
    t.unique.sort();
    t.foreignKeys.sort();
    t.checks.sort();
  }
  const indexes = await outside(
    `SELECT ci.relname AS name, ct.relname AS tbl, i.indisunique AS "unique",
       ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, k, true)
             FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k) AS columns,
       pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS pred
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid
     JOIN pg_catalog.pg_class ct ON ct.oid = i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = ci.relnamespace
     WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
       WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u'))`,
    [schema],
  );
  for (const i of indexes) {
    shape.indexes[i.name as string] = {
      table: i.tbl as string,
      unique: i.unique as boolean,
      columns: (i.columns as string[]).map(expr),
      where: i.pred === null ? null : expr(i.pred as string),
    };
  }
  const triggers = await outside(
    `SELECT t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid) AS def
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND NOT t.tgisinternal`,
    [schema],
  );
  for (const t of triggers) {
    const m =
      /^CREATE TRIGGER \w+ (BEFORE|AFTER|INSTEAD OF) (INSERT|UPDATE|DELETE|TRUNCATE)\b.*? ON (?:\S+\.)?(\w+) FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION (?:\S+\.)?(\w+)\((.*)\)$/.exec(
        t.def as string,
      );
    if (!m) throw new Error(`unread trigger: ${t.def}`);
    shape.triggers[t.name as string] = {
      table: m[3] as string,
      when: `${m[1]} ${m[2]} FOR EACH ${m[4]}`,
      guard: m[5] === 'origin_append_only' ? (/^'(\w+)'$/.exec(m[6] ?? '')?.[1] ?? 'always') : null,
    };
  }
  const views = await outside(
    'SELECT viewname AS name FROM pg_catalog.pg_views WHERE schemaname = $1 ORDER BY 1',
    [schema],
  );
  shape.views = views.map((v) => v.name as string);
  return shape;
}

// --- What differs on purpose -----------------------------------------------------------------

/** Where SQLite assigns a rowid, and PostgreSQL a trigger of this name (see key() in pg/schema.ts). */
const KEY_TRIGGERS = [
  'raw_file_id',
  'event_seq',
  'sync_log_id',
  'entry_rowid',
  'tombstone_rowid',
  'change_log_seq',
  'recall_seq',
  'purge_seq',
  'audit_log_id',
];

/** The tables SQLite guards as append-only: PostgreSQL refuses TRUNCATE on each too. */
const GUARDED = [
  'raw_chunk',
  'event',
  'entry',
  'entry_source',
  'imported_entry',
  'tombstone',
  'change_log',
  'recall',
  'recall_item',
  'purge',
  'purged',
  'purge_line',
  'audit_log',
];

/**
 * How the schemas differ on purpose, besides two rules the comparison applies throughout (INTEGER
 * is BIGINT and REAL is DOUBLE PRECISION; a primary key is never NULL). Each is taken away from its
 * side, and must be there to be taken, so that the list stays exact.
 */
const ONLY_SQLITE = {
  // FTS5's tables (their own tables aside), the view message_fts reads, and the triggers that keep
  // them: in PostgreSQL, GIN indexes, and event_cjk and event_prompt filled from TypeScript.
  tables: ['event_fts', 'message_fts', 'event_cjk', 'entry_fts'],
  views: ['event_message'],
  triggers: ['event_ai', 'event_ad', 'event_au', 'entry_ai', 'entry_ad'],
};

const ONLY_POSTGRES = {
  // The format version, which SQLite keeps in PRAGMA user_version; the CJK tokens and the prompts.
  tables: ['store_format', 'event_cjk', 'event_prompt'],
  // SQLite's implicit rowid, which queries read; the counts BM25 needs, which FTS5 keeps itself.
  columns: {
    entry: ['rowid'],
    tombstone: ['rowid'],
    event_block: ['docs', 'tokens', 'message_docs', 'message_tokens'],
  },
  unique: { entry: ['rowid'], tombstone: ['rowid'] },
  // Flags, which stay INTEGER, 0 or 1.
  checks: { session: ['title_manual IN (0, 1)'], oauth_client: ['document IN (0, 1)'] },
  indexes: ['event_grams', 'event_message_grams', 'entry_grams', 'event_cjk_tokens'],
  triggers: [
    ...KEY_TRIGGERS,
    ...GUARDED.map((t) => `${t}_no_truncate`),
    // event_block's counts without a deleted event, and with an updated one's new text.
    'event_block_ad',
    'event_block_au',
  ],
};

/** SQLite's INTEGER columns that are INTEGER, not BIGINT, in PostgreSQL. */
const FLAGS: Record<string, string[]> = { session: ['title_manual'], oauth_client: ['document'] };

const TYPES: Record<string, string> = {
  INTEGER: 'bigint',
  REAL: 'double precision',
  TEXT: 'text',
};

/** Take `name` away from `list`, which must have it. */
function take(list: string[], name: string, where: string): void {
  const at = list.indexOf(name);
  if (at === -1) throw new Error(`${where} has no ${name}: it no longer differs`);
  list.splice(at, 1);
}

function takeKey<T>(record: Record<string, T>, name: string, where: string): void {
  if (!(name in record)) throw new Error(`${where} has no ${name}: it no longer differs`);
  delete record[name];
}

/** Both shapes, less what differs on purpose, and SQLite's types as PostgreSQL's. */
function comparable(sqlite: SchemaShape, pg: SchemaShape): [SchemaShape, SchemaShape] {
  for (const t of ONLY_SQLITE.tables) takeKey(sqlite.tables, t, 'SQLite');
  for (const v of ONLY_SQLITE.views) take(sqlite.views, v, 'SQLite');
  for (const t of ONLY_SQLITE.triggers) takeKey(sqlite.triggers, t, 'SQLite');
  for (const t of ONLY_POSTGRES.tables) takeKey(pg.tables, t, 'PostgreSQL');
  for (const [t, names] of Object.entries(ONLY_POSTGRES.columns)) {
    const columns = pg.tables[t]?.columns ?? [];
    for (const name of names) {
      take(
        columns.map((c) => c.name),
        name,
        `PostgreSQL's ${t}`,
      );
      columns.splice(
        columns.findIndex((c) => c.name === name),
        1,
      );
    }
  }
  for (const [t, keys] of Object.entries(ONLY_POSTGRES.unique)) {
    for (const k of keys) take(pg.tables[t]?.unique ?? [], k, `PostgreSQL's ${t}`);
  }
  for (const [t, checks] of Object.entries(ONLY_POSTGRES.checks)) {
    for (const c of checks) take(pg.tables[t]?.checks ?? [], expr(c), `PostgreSQL's ${t}`);
  }
  for (const i of ONLY_POSTGRES.indexes) takeKey(pg.indexes, i, 'PostgreSQL');
  for (const t of ONLY_POSTGRES.triggers) takeKey(pg.triggers, t, 'PostgreSQL');
  for (const [name, t] of Object.entries(sqlite.tables)) {
    for (const c of t.columns) {
      const type = FLAGS[name]?.includes(c.name) ? 'integer' : TYPES[c.type];
      if (!type) throw new Error(`${name}.${c.name} has type ${c.type}, which has no counterpart`);
      c.type = type;
    }
  }
  return [sqlite, pg];
}

// --- The tests ------------------------------------------------------------------------------

describe.skipIf(!onPostgres)('the schema of a store in PostgreSQL', () => {
  it("is SQLite's, but for what differs on purpose", async () => {
    const [want, got] = comparable(
      sqliteShape(sqlite()),
      await postgresShape(postgres().target.schema),
    );
    // Every difference at once, table by table.
    expect.soft(Object.keys(got.tables).sort()).toEqual(Object.keys(want.tables).sort());
    for (const name of Object.keys(want.tables)) {
      expect.soft(got.tables[name], name).toEqual(want.tables[name]);
    }
    expect.soft(got.views).toEqual(want.views);
    expect.soft(got.indexes).toEqual(want.indexes);
    expect.soft(got.triggers).toEqual(want.triggers);
  });

  it('creates a new store at the latest format, and opens it again as it is', async () => {
    const db = postgres();
    const { schema } = db.target;
    expect(db.formatVersion()).toBe(STORE_VERSION);
    expect(missing(db)).toEqual([]);
    const format = async () =>
      (await outside(`SELECT version, store_id FROM "${schema}".store_format`))[0];
    const created = await format();
    expect(created?.version).toBe(STORE_VERSION);
    expect(created?.store_id).toMatch(/^[0-9a-f-]{36}$/);
    // Each function finds the store's tables whatever the caller's search_path.
    const functions = await outside(
      `SELECT p.proname AS name, p.proconfig AS config FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
      [schema],
    );
    expect(functions.length).toBe(PG_OBJECTS.filter((o) => o.kind === 'function').length);
    for (const f of functions) {
      expect(f.config as string[], f.name as string).toContain(`search_path=${schema}`);
    }
    // Every object, by its oid: opening the store again creates and replaces none.
    const objects = async () =>
      (
        await outside(
          `SELECT c.oid::text AS o FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
           UNION ALL SELECT p.oid::text FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
           UNION ALL SELECT t.oid::text FROM pg_catalog.pg_trigger t
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
           ORDER BY 1`,
          [schema],
        )
      ).map((r) => r.o);
    const before = await objects();
    db.close();
    const again = postgres(schema);
    expect(again.formatVersion()).toBe(STORE_VERSION);
    expect(await objects()).toEqual(before);
    expect(await format()).toEqual(created);
  });

  it('creates what a store lacks, and replaces nothing it has', async () => {
    const db = postgres();
    const { schema } = db.target;
    db.close();
    await outside(`DROP INDEX "${schema}".event_ts;
      DROP TRIGGER event_no_delete ON "${schema}".event;
      DROP TRIGGER event_seq ON "${schema}".event;
      CREATE OR REPLACE FUNCTION "${schema}".origin_path(p text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT 'changed' $$`);
    const again = postgres(schema);
    expect(missing(again)).toEqual([]);
    expect(again.prepare('SELECT origin_path(?) AS p').get('C:\\Work')?.p).toBe('changed');
  });

  it('refuses a store of a newer Origin, unchanged', () => {
    const db = postgres();
    db.setFormatVersion(STORE_VERSION + 1);
    db.close();
    expect(() => postgres(db.target.schema)).toThrow(/a newer Origin has used it/);
  });
});

/** Rows in every guarded table, and in purge_pending. */
const FIXTURE = [
  `INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at)
   VALUES ('fake', 'a.jsonl', 'fake/a.jsonl', 0, 0)`,
  `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
   VALUES ('fake:1', 'fake', 's1', 1000, 'user', 'message', 'deploy the staging cluster', 1, 1)`,
  `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
   VALUES ('fake:2', 'fake', 's1', 2000, 'assistant', 'message', 'Deployed the cluster.', 1, 2)`,
  `INSERT INTO entry (id, kind, text, confidence, author, root, created_at, origin)
   VALUES ('ent_1', 'knowledge', 'The cluster is called staging.', 1, 'owner', 'ent_1', 1000, 'laptop')`,
  "INSERT INTO entry_source (entry_id, event_id) VALUES ('ent_1', 'fake:1')",
  "INSERT INTO imported_entry (entry_id) VALUES ('ent_1')",
  `INSERT INTO raw_chunk (raw_file_id, first_line, line_count, byte_offset, byte_length,
                          frame_offset, frame_length)
   VALUES (1, 1, 1, 0, 1, 0, 1)`,
  `INSERT INTO recall (id, at, origin, occasion, budget, tokens)
   VALUES ('rcl_1', 1000, 'laptop', 'prompt', 400, 60)`,
  `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
   VALUES ('rcl_1', 1, 'prompt', 'entry', 'ent_1', 2.5, 20)`,
  `INSERT INTO tombstone (id, target, reason, created_at, origin)
   VALUES ('tmb_1', 'ent_9', 'wrong', 1000, 'laptop')`,
  `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts)
   VALUES ('prg_1', 1000, 'laptop', 'owner', 'cli', 'test', '{}', '{}')`,
  "INSERT INTO purged (kind, id, purge_id) VALUES ('event', 'fake:9', 'prg_1')",
  `INSERT INTO purge_line (raw_file_id, first_line, line_count, purge_id)
   VALUES (1, 1, 1, 'prg_1')`,
  "INSERT INTO audit_log (at, actor, channel, action) VALUES (1000, 'owner', 'cli', 'test')",
  'INSERT INTO purge_pending (raw_file_id, since) VALUES (1, 1)',
];

/** A store of each engine, filled with FIXTURE. */
function filled(): Array<[string, Database]> {
  const stores: Array<[string, Database]> = [
    ['sqlite', sqlite()],
    ['postgres', postgres()],
  ];
  for (const [, db] of stores) for (const sql of FIXTURE) db.prepare(sql).run();
  return stores;
}

/**
 * Run `fn` in a write transaction with guard_lift naming `names`, as a purge does. The rows go
 * before COMMIT, or with the ROLLBACK after an error (in PostgreSQL, an error aborts the
 * transaction, so nothing more can run in it).
 */
function lifted<T>(db: Database, names: string[], fn: () => T): T {
  return transaction(
    db,
    () => {
      const add = db.prepare('INSERT INTO guard_lift (name) VALUES (?)');
      for (const name of names) add.run(name);
      const out = fn();
      db.exec('DELETE FROM guard_lift');
      return out;
    },
    { immediate: true },
  );
}

const count = (db: Database, table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/** The tables whose guards a purge lifts, and what each refuses until then. */
const LIFTED: Array<[table: string, sql: string]> = [
  ['recall_item', 'DELETE FROM recall_item'],
  ['recall', 'DELETE FROM recall'],
  ['entry_source', 'DELETE FROM entry_source'],
  ['imported_entry', 'DELETE FROM imported_entry'],
  ['entry', 'DELETE FROM entry'],
  ['event', "DELETE FROM event WHERE id = 'fake:1'"],
  ['raw_chunk', 'UPDATE raw_chunk SET frame_length = 2'],
  ['raw_chunk', 'DELETE FROM raw_chunk'],
];

/** What no guard_lift lifts. */
const NEVER = [
  "UPDATE entry SET text = 'changed'",
  "UPDATE tombstone SET reason = 'changed'",
  'DELETE FROM tombstone',
  "UPDATE change_log SET origin = 'changed'",
  'DELETE FROM change_log',
  'UPDATE recall SET tokens = 1',
  'UPDATE recall_item SET tokens = 1',
  "UPDATE purge SET reason = 'changed'",
  'DELETE FROM purge',
  "UPDATE purged SET id = 'fake:8'",
  'DELETE FROM purged',
  'UPDATE purge_line SET line_count = 2',
  'DELETE FROM purge_line',
  "UPDATE audit_log SET actor = 'changed'",
  'DELETE FROM audit_log',
];

describe.skipIf(!onPostgres)('append-only guards in PostgreSQL, as in SQLite', () => {
  it('refuse what a purge deletes, except inside its transaction', () => {
    for (const [engine, db] of filled()) {
      for (const [, sql] of LIFTED) {
        expect(() => db.prepare(sql).run(), `${engine}: ${sql}`).toThrow(/append-only/);
      }
      expect(count(db, 'event'), engine).toBe(2);
      // Each table's guard holds until guard_lift names that table.
      for (let i = 0; i < LIFTED.length; i++) {
        const [table, sql] = LIFTED[i] as [string, string];
        const others = [...new Set(LIFTED.map(([t]) => t))].filter((t) => t !== table);
        expect(() => lifted(db, others, () => db.exec(sql)), `${engine}: ${sql}`).toThrow(
          `${table} is append-only`,
        );
      }
      lifted(db, [...new Set(LIFTED.map(([t]) => t))], () => {
        for (const [, sql] of LIFTED) db.exec(sql);
      });
      expect(count(db, 'guard_lift'), engine).toBe(0);
      expect(count(db, 'event'), engine).toBe(1);
      expect(count(db, 'entry'), engine).toBe(0);
      expect(count(db, 'raw_chunk'), engine).toBe(0);
      // Once the transaction is over, the guards hold again; events may still be updated.
      expect(() => db.exec('DELETE FROM event'), engine).toThrow(/event is append-only/);
      db.exec("UPDATE event SET cwd = '/work'");
    }
  });

  it('never lift for entry updates, tombstones, the change log, recall updates, purge records, or the audit log', () => {
    for (const [engine, db] of filled()) {
      const every = [...new Set(LIFTED.map(([t]) => t)), 'tombstone', 'change_log', 'purge'];
      for (const sql of NEVER) {
        expect(() => lifted(db, every, () => db.exec(sql)), `${engine}: ${sql}`).toThrow(
          /append-only/,
        );
      }
      expect(count(db, 'tombstone'), engine).toBe(1);
      expect(count(db, 'purge'), engine).toBe(1);
      // A purge's work queue is not a record: its rows go once the work is done.
      db.exec('UPDATE purge_pending SET attempts = attempts + 1');
      db.exec('DELETE FROM purge_pending');
    }
  });

  it('refuse TRUNCATE of every guarded table, which skips row triggers, even inside a purge', () => {
    const db = filled()[1]?.[1] as Database;
    for (const table of GUARDED) {
      const err = thrown(() => lifted(db, GUARDED, () => db.exec(`TRUNCATE ${table} CASCADE`)));
      expect(err.message, table).toMatch(/is append-only$/);
      expect(err.code, table).toBe('23001');
    }
    expect(count(db, 'event')).toBe(2);
  });
});

describe.skipIf(!onPostgres)('keys in PostgreSQL', () => {
  /** Statements that leave keys to the store, and what each returns or reads. */
  const STEPS = [
    "INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at) VALUES ('f', 'a', 'a', 0, 0) RETURNING id",
    "INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at) VALUES ('f', 'b', 'b', 0, 0) RETURNING id",
    // Nothing inserted, no key used up.
    "INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at) VALUES ('f', 'a', 'a', 0, 0) ON CONFLICT DO NOTHING RETURNING id",
    "INSERT INTO raw_file (id, source, path, mirror, first_seen_at, updated_at) VALUES (10, 'f', 'c', 'c', 0, 0) RETURNING id",
    "INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at) VALUES ('f', 'd', 'd', 0, 0) RETURNING id",
    // Several rows in one statement.
    `INSERT INTO sync_log (source, started_at, finished_at, files_seen, files_changed, lines_read,
       events_added, parse_errors)
     VALUES ('a', 0, 0, 0, 0, 0, 0, 0), ('b', 0, 0, 0, 0, 0, 0, 0), ('c', 0, 0, 0, 0, 0, 0, 0)
     RETURNING id`,
    `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
     VALUES ('f:1', 'f', 's', 1, 'user', 'message', 'one', 1, 1),
            ('f:2', 'f', 's', 2, 'user', 'message', 'two', 1, 2) RETURNING seq`,
    `INSERT INTO event (seq, id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
     VALUES (5000, 'f:3', 'f', 's', 3, 'user', 'message', 'three', 1, 3) RETURNING seq`,
    `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
     VALUES ('f:4', 'f', 's', 4, 'user', 'message', 'four', 1, 4) RETURNING seq`,
    `INSERT INTO entry (id, kind, text, confidence, author, root, created_at, origin)
     VALUES ('ent_1', 'memory', 'one', 1, 'owner', 'ent_1', 1, 'laptop'),
            ('ent_2', 'memory', 'two', 1, 'owner', 'ent_2', 2, 'laptop')`,
    `INSERT INTO tombstone (id, target, created_at, origin)
     VALUES ('tmb_1', 'ent_1', 3, 'laptop')`,
    `INSERT INTO entry (id, kind, text, confidence, author, supersedes, root, created_at, origin)
     VALUES ('ent_3', 'memory', 'three', 1, 'owner', 'ent_2', 'ent_2', 4, 'laptop')`,
    'SELECT id, rowid FROM entry ORDER BY rowid',
    'SELECT id, rowid FROM tombstone ORDER BY rowid',
    'SELECT seq, kind, id FROM change_log ORDER BY seq',
    `INSERT INTO recall (id, at, origin, occasion, budget, tokens)
     VALUES ('rcl_1', 1, 'laptop', 'prompt', 1, 1), ('rcl_2', 2, 'laptop', 'start', 1, 1)
     RETURNING seq`,
    `INSERT INTO audit_log (at, actor, channel, action) VALUES (1, 'owner', 'cli', 'a') RETURNING id`,
    `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts)
     VALUES ('prg_1', 1, 'laptop', 'owner', 'cli', 'test', '{}', '{}') RETURNING seq`,
  ];

  it('are taken as SQLite takes rowids: the next after the greatest', () => {
    const results = [sqlite(), postgres()].map((db) =>
      STEPS.map((sql) =>
        db
          .prepare(sql)
          .all()
          .map((row) => ({ ...row })),
      ),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.[0]).toEqual([{ id: 1 }]);
    expect(results[0]?.[2]).toEqual([]);
    expect(results[0]?.[4]).toEqual([{ id: 11 }]);
    expect(results[0]?.[14]).toHaveLength(4);
  });

  it('give an event a seq after every one a purge deleted', () => {
    const db = postgres();
    for (const sql of STEPS.slice(0, 1)) db.prepare(sql).run();
    const add = db.prepare(
      `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
       VALUES (?, 'f', 's', 1, 'user', 'message', 'text', 1, 1) RETURNING seq`,
    );
    expect(add.get('f:1')).toEqual({ seq: 1 });
    db.prepare(
      `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts, seq_floor)
       VALUES ('prg_1', 1, 'laptop', 'owner', 'cli', 'test', '{}', '{}', 40)`,
    ).run();
    expect(add.get('f:2')).toEqual({ seq: 41 });
    expect(add.get('f:3')).toEqual({ seq: 42 });
    db.prepare(
      `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts, seq_floor)
       VALUES ('prg_2', 2, 'laptop', 'owner', 'cli', 'test', '{}', '{}', 30)`,
    ).run();
    expect(add.get('f:4')).toEqual({ seq: 43 });
  });

  it('stay dense when two connections insert at once, outside Origin', async () => {
    const { schema } = postgres().target;
    const [a, b] = await Promise.all([connect(schema), connect(schema)]);
    const event = (id: string) =>
      `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
       VALUES ('${id}', 'f', 's', 1, 'user', 'message', 'text', 1, 1)`;
    try {
      await a.query(
        "INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at) VALUES ('f', 'a', 'a', 0, 0)",
      );
      // A takes a key in a transaction it holds; B's insert waits for the store's lock, then
      // takes the next key, not the same one.
      await a.query('BEGIN');
      await a.query(event('a:0'));
      let waited = true;
      const later = b.query(event('b:0')).then(() => {
        waited = false;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(waited).toBe(true);
      await a.query('COMMIT');
      await later;
      // Then many at once, from both: change_log takes its keys inside the triggers of entries
      // and tombstones.
      await Promise.all(
        [a, b].map(async (c, n) => {
          for (let i = 1; i <= 60; i++) {
            await c.query(event(`${n}:${i}`));
            await c.query(
              `INSERT INTO sync_log (source, started_at, finished_at, files_seen, files_changed,
                 lines_read, events_added, parse_errors) VALUES ('f', 0, 0, 0, 0, 0, 0, 0)`,
            );
            if (i % 3 === 0) {
              await c.query(
                `INSERT INTO entry (id, kind, text, confidence, author, root, created_at, origin)
                 VALUES ('ent_${n}_${i}', 'memory', 'text', 1, 'owner', 'ent_${n}_${i}', 1, 'x')`,
              );
            }
            if (i % 5 === 0) {
              await c.query(
                `INSERT INTO tombstone (id, target, created_at, origin)
                 VALUES ('tmb_${n}_${i}', 'x', 1, 'x')`,
              );
            }
          }
        }),
      );
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    for (const [table, key, n] of [
      ['event', 'seq', 122],
      ['sync_log', 'id', 120],
      ['entry', 'rowid', 40],
      ['tombstone', 'rowid', 24],
      ['change_log', 'seq', 64],
    ] as const) {
      const [row] = await outside(
        `SELECT count(*)::int AS n, min(${key})::int AS lo, max(${key})::int AS hi
         FROM "${schema}".${table}`,
      );
      expect(row, table).toEqual({ n, lo: 1, hi: n });
    }
  });
});

/** The totals FTS5 keeps for an index (its averages record): rows, and tokens of its column. */
function ftsTotals(db: Database, index: string): { rows: number; tokens: number } {
  const { block } = db.prepare(`SELECT block FROM ${index}_data WHERE id = 1`).get() as {
    block: Uint8Array;
  };
  // SQLite's varints: big-endian groups of 7 bits, the high bit set on all but the last; a ninth
  // byte holds 8.
  let at = 0;
  const varint = () => {
    let v = 0;
    for (let i = 0; i < 9; i++) {
      const byte = block[at++] as number;
      if (i === 8) return v * 256 + byte;
      v = v * 128 + (byte & 0x7f);
      if (byte < 0x80) return v;
    }
    return v;
  };
  const rows = varint();
  return { rows, tokens: varint() };
}

describe.skipIf(!onPostgres)('event_block in PostgreSQL', () => {
  const TEXTS = [
    '',
    'ab',
    'abc',
    'deploy the staging cluster',
    '数据库部署',
    '😀😀😀😀',
    'Café DÉJÀ VU',
    'x'.repeat(70),
    'line one\nline two',
  ];
  const KINDS = ['message', 'tool_use', 'message', 'meta', 'tool_result'];

  /** Events in four blocks, arriving out of time order, some with a seq of their own. */
  function events(): Array<[seq: number | null, ts: number, kind: string, text: string]> {
    const out: Array<[number | null, number, string, string]> = [];
    let n = 0;
    const add = (seq: number | null, ts: number) => {
      out.push([seq, ts, KINDS[n % KINDS.length] as string, TEXTS[n % TEXTS.length] as string]);
      n++;
    };
    for (let i = 0; i < 25; i++) add(null, 10_000 + ((i * 7919) % 101) * 10);
    add(4094, 5_000);
    for (let i = 0; i < 6; i++) add(null, 20_000 - i * 100);
    add(12_000, 15_000);
    for (let i = 0; i < 5; i++) add(null, 1_000 + i);
    add(20_480, 30_000);
    add(null, 2_000);
    return out;
  }

  function fill(db: Database): void {
    db.prepare(
      `INSERT INTO raw_file (id, source, path, mirror, first_seen_at, updated_at)
       VALUES (1, 'f', 'a', 'a', 0, 0)`,
    ).run();
    const auto = db.prepare(
      `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
       VALUES (?, 'f', 's', ?, 'user', ?, ?, 1, 1)`,
    );
    const at = db.prepare(
      `INSERT INTO event (seq, id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
       VALUES (?, ?, 'f', 's', ?, 'user', ?, ?, 1, 1)`,
    );
    events().forEach(([seq, ts, kind, text], i) => {
      if (seq === null) auto.run(`f:${i}`, ts, kind, text);
      else at.run(seq, `f:${i}`, ts, kind, text);
    });
  }

  const blocks = (db: Database) =>
    db
      .prepare('SELECT block, max_ts, latest_ts FROM event_block ORDER BY block')
      .all()
      .map((r) => ({ ...r }));

  /** SQLite's events, counted as event_block counts them in PostgreSQL. */
  const counted = (db: Database) =>
    db
      .prepare(
        `SELECT seq >> 12 AS block, COUNT(*) AS docs, SUM(MAX(length(text) - 2, 0)) AS tokens,
           SUM(kind = 'message') AS message_docs,
           SUM(CASE WHEN kind = 'message' THEN MAX(length(text) - 2, 0) ELSE 0 END) AS message_tokens
         FROM event GROUP BY 1 ORDER BY 1`,
      )
      .all()
      .map((r) => ({ ...r }));

  const counts = (db: Database) =>
    db
      .prepare(
        `SELECT block, docs, tokens, message_docs, message_tokens FROM event_block
         WHERE docs > 0 ORDER BY block`,
      )
      .all()
      .map((r) => ({ ...r }));

  /** The two engines agree, and PostgreSQL's totals are FTS5's. */
  function same(lite: Database, pg: Database): void {
    expect(blocks(pg)).toEqual(blocks(lite));
    const per = counts(pg);
    expect(per).toEqual(counted(lite));
    const sum = (key: string) => per.reduce((s, r) => s + Number(r[key]), 0);
    expect({ rows: sum('docs'), tokens: sum('tokens') }).toEqual(ftsTotals(lite, 'event_fts'));
    expect({ rows: sum('message_docs'), tokens: sum('message_tokens') }).toEqual(
      ftsTotals(lite, 'message_fts'),
    );
  }

  it('is what SQLite keeps after the same inserts, deletes, and updates', () => {
    const [lite, pg] = [sqlite(), postgres()];
    for (const db of [lite, pg]) fill(db);
    expect(blocks(lite)).toHaveLength(4);
    same(lite, pg);
    for (const db of [lite, pg]) {
      lifted(db, ['event'], () =>
        db.exec('DELETE FROM event WHERE seq IN (2, 4095, 12000, 20480)'),
      );
      db.exec("UPDATE event SET text = 'now a longer message', kind = 'message' WHERE seq = 3");
      db.exec("UPDATE event SET text = 'x', kind = 'meta' WHERE seq = 4");
    }
    same(lite, pg);
  });
});

describe.skipIf(!onPostgres)('functions in PostgreSQL', () => {
  const PATHS = [
    'C:\\Users\\Me\\Work\\Origin\\',
    'c:/users/me/work/origin',
    'D:/Projekte/Ärger/Ünïcode///',
    '//Server/Share/Dir/',
    '\\\\Server\\Share\\Dir',
    '/home/Me/Work/Origin/',
    '/home/Me/Work/Origin',
    '/Users/Me/文档/项目/',
    'C:/用户/Me/ПРОЕКТ',
    'relative\\Path\\',
    'Work/ÄÖÜ/',
    'Ω:/not/a/drive/',
    'C:',
    'C:\\',
    '/',
    '//',
    '',
  ];

  it('fold paths as comparePath does', () => {
    const [lite, pg] = [sqlite(), postgres()];
    for (const db of [lite, pg]) {
      const fold = db.prepare('SELECT origin_path(?) AS p');
      for (const p of PATHS) expect(fold.get(p)?.p, p).toBe(comparePath(p));
      expect(fold.get(null)?.p).toBeNull();
    }
  });

  /** Every distinct run of three characters of a text, lower case: FTS5's trigrams. */
  function trigrams(text: string): string[] {
    const chars = [...text.toLowerCase()];
    const all = new Set<string>();
    for (let i = 0; i + 3 <= chars.length; i++) all.add(chars.slice(i, i + 3).join(''));
    return [...all].sort();
  }

  it('give the trigrams of a text, by characters, case folded', () => {
    const db = postgres();
    const grams = db.prepare('SELECT g FROM unnest(origin_trigrams(?)) AS g');
    for (const text of [
      '',
      'a',
      'ab',
      'abc',
      'Hello, World',
      'aaaaaa',
      'Café DÉJÀ VU naïve',
      'Ärger über Öl',
      'дом ДОМ',
      '数据库部署',
      '部署数据库的时候',
      '😀😀😀😀',
      'mixed 数据 and ASCII',
      'tab\tand\nnewline',
      `quote ' and " and \\`,
    ]) {
      expect(
        grams
          .all(text)
          .map((r) => r.g as string)
          .sort(),
        text,
      ).toEqual(trigrams(text));
    }
    expect(db.prepare('SELECT origin_trigrams(NULL) IS NULL AS n').get()).toEqual({ n: 1 });
  });

  it('tell whether a text contains a lower case term, as SQLite does', () => {
    const cases: Array<[string | null, string]> = [
      ['Déjà Vu at the café', 'déjà vu'],
      ['ÄRGER', 'ärger'],
      ['дом ДОМ', 'дом'],
      ['数据库部署', '部署'],
      ['abc', 'abd'],
      ['ABC', 'abc'],
      [null, 'x'],
    ];
    const answers = [sqlite(), postgres()].map((db) => {
      const contains = db.prepare('SELECT origin_contains(?, ?) AS c');
      return cases.map(([text, term]) => contains.get(text, term)?.c);
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[1]).toEqual([1, 1, 1, 1, 0, 1, 0]);
  });

  it('serve trigram and CJK queries from the GIN indexes', () => {
    const db = postgres();
    db.exec('SET enable_seqscan = off');
    const plan = (sql: string) =>
      db
        .prepare(`EXPLAIN ${sql}`)
        .all()
        .map((r) => r['QUERY PLAN'])
        .join('\n');
    expect(
      plan("SELECT seq FROM event WHERE origin_trigrams(text) @> ARRAY['dep', 'epl']"),
    ).toMatch(/Bitmap Index Scan on event_grams/);
    expect(
      plan(
        "SELECT seq FROM event WHERE kind = 'message' AND origin_trigrams(text) @> ARRAY['dep']",
      ),
    ).toMatch(/Bitmap Index Scan on event_message_grams/);
    expect(plan("SELECT id FROM entry WHERE origin_trigrams(text) @> ARRAY['dep']")).toMatch(
      /Bitmap Index Scan on entry_grams/,
    );
    expect(plan("SELECT seq FROM event_cjk WHERE tokens @> ARRAY['部署']")).toMatch(
      /Bitmap Index Scan on event_cjk_tokens/,
    );
  });
});
