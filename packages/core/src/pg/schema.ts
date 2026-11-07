/**
 * The schema of a store in PostgreSQL, beside the tables schema.ts creates in SQLite (see
 * docs/architecture.md#storage), and what a PostgreSQL server and database must be for a store.
 *
 * So far it holds what the PostgreSQL client needs before it can take the store's write lock:
 * `store_format`, which records the format version (SQLite keeps it in `PRAGMA user_version`), the
 * store's id, and where it was moved; and `origin_lock_key()`, the key of the advisory lock that
 * every writing transaction takes. Each object's SQL is PostgreSQL's own (never translated), run with
 * the store's schema first on `search_path`. An object is created when the store lacks it, and never
 * replaced: changing one needs a migration.
 */

/** An object of a store's schema, by the name it has in the catalog. */
export interface PgObject {
  kind: 'table' | 'index' | 'function' | 'trigger';
  name: string;
  /** The statement that creates it. */
  sql: string;
}

/** The first PostgreSQL release a store may live in (`server_version_num`). */
export const PG_MIN_SERVER_VERSION = 170_000;

/** The command that creates a database a store may live in, for messages. */
export const PG_CREATE_DATABASE =
  "CREATE DATABASE origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';";

/**
 * The high 32 bits of the store's lock key ('ORIG'); the low 32 bits are the oid of the store's
 * schema, so that stores in two schemas of one database never wait for each other.
 */
export const PG_LOCK_TAG = 0x4f524947;

/**
 * What the client needs before it can take the store's write lock, and so creates on connecting
 * when the store lacks it (the rest of the schema is created when the store is opened).
 */
export const PG_CLIENT_OBJECTS: readonly PgObject[] = [
  {
    kind: 'table',
    name: 'store_format',
    sql: `CREATE TABLE store_format (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  version integer NOT NULL,
  store_id text NOT NULL,
  moved_to text
)`,
  },
  {
    kind: 'function',
    name: 'origin_lock_key',
    // SET search_path FROM CURRENT fixes current_schema() to the store's schema, whatever the
    // caller's search_path; the oid is looked up by name, which needs no quoting.
    sql: `CREATE FUNCTION origin_lock_key() RETURNS bigint LANGUAGE sql STABLE
SET search_path FROM CURRENT AS
$$ SELECT (${PG_LOCK_TAG}::bigint << 32) | (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema())::bigint $$`,
  },
];

/** Every object of a store's schema in PostgreSQL. */
export const PG_OBJECTS: readonly PgObject[] = [...PG_CLIENT_OBJECTS];

/**
 * The objects a schema (`$1`, its name) has, as rows of `kind` and `name`: its tables, indexes,
 * functions, and triggers (not those PostgreSQL makes for constraints).
 */
export const PG_PRESENT_SQL = `WITH s AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)
SELECT CASE WHEN c.relkind = 'i' THEN 'index' ELSE 'table' END AS kind, c.relname AS name
  FROM pg_catalog.pg_class c JOIN s ON c.relnamespace = s.oid WHERE c.relkind IN ('r', 'p', 'i')
UNION ALL
SELECT 'function', p.proname FROM pg_catalog.pg_proc p JOIN s ON p.pronamespace = s.oid
UNION ALL
SELECT 'trigger', t.tgname FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN s ON c.relnamespace = s.oid
  WHERE NOT t.tgisinternal`;

/** Of `objects`, those that `present` (rows of PG_PRESENT_SQL) lacks, in order. */
export function missingObjects(
  present: ReadonlyArray<{ kind: string; name: string }>,
  objects: readonly PgObject[] = PG_OBJECTS,
): PgObject[] {
  const have = new Set(present.map((o) => `${o.kind} ${o.name}`));
  return objects.filter((o) => !have.has(`${o.kind} ${o.name}`));
}

/**
 * The server and the database, as preflightProblem reads them: one row. `datlocale` is read through
 * to_jsonb, so that the query runs on any release and an old one is refused by its version.
 */
export const PG_PREFLIGHT_SQL = `SELECT current_setting('server_version_num')::integer AS version,
  current_setting('server_version') AS release,
  d.datname AS database, pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
  d.datlocprovider::text AS provider, d.datcollate AS collate, d.datctype AS ctype,
  pg_catalog.to_jsonb(d) ->> 'datlocale' AS locale
FROM pg_catalog.pg_database d WHERE d.datname = current_database()`;

/** A row of PG_PREFLIGHT_SQL. */
export interface PgPreflight {
  version: number;
  release: string;
  database: string;
  encoding: string;
  /** `c` (libc), `i` (ICU), or `b` (builtin). */
  provider: string;
  collate: string;
  ctype: string;
  locale: string | null;
}

const C_LOCALES = new Set(['C', 'POSIX']);

/**
 * Why a store may not live in this database, or null if it may. PostgreSQL 17 or later, and a UTF8
 * database whose collation and character classes are C: SQLite's lower() and LIKE fold ASCII only,
 * and so must PostgreSQL's, for every value whatever its collation (literals and parameters take
 * the database's). C.UTF-8 folds beyond ASCII, so it is refused too.
 */
export function preflightProblem(p: PgPreflight): string | null {
  if (p.version < PG_MIN_SERVER_VERSION) {
    return `Origin needs PostgreSQL 17 or later; this server runs ${p.release}.`;
  }
  const libc = p.provider === 'c' && C_LOCALES.has(p.collate) && C_LOCALES.has(p.ctype);
  const builtin = p.provider === 'b' && p.locale === 'C';
  if (p.encoding === 'UTF8' && (libc || builtin)) return null;
  const locale = p.provider === 'c' ? `${p.collate}/${p.ctype}` : `${p.locale ?? '?'}`;
  const provider = { c: 'libc', i: 'ICU', b: 'builtin' }[p.provider] ?? p.provider;
  return `The database ${p.database} has encoding ${p.encoding} and locale ${locale} (${provider}); a store needs a UTF8 database whose locale is C. Create one with: ${PG_CREATE_DATABASE}`;
}
