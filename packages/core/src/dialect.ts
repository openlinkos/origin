import type { Dialect } from './database.js';

/**
 * SQL that SQLite and PostgreSQL spell differently, as fragments for either engine (see
 * database.ts). Every other statement is written in SQL both accept. A fragment holds `?` where it
 * takes a parameter, like the statement around it.
 */

/** A key of a JSON object that a fragment may name: a plain identifier. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error(`Not a JSON key a query may name: ${key}`);
  return key;
}

/**
 * Build a fragment once per engine: for SQL that a module keeps, such as the columns of an event
 * with their authorship.
 */
export function perDialect(build: (d: Dialect) => string): (d: Dialect) => string {
  const built = new Map<Dialect, string>();
  return (d) => {
    let sql = built.get(d);
    if (sql === undefined) {
      sql = build(d);
      built.set(d, sql);
    }
    return sql;
  };
}

/**
 * The value under `key` of the JSON object in column `col`, or NULL. SQLite returns a JSON number or
 * boolean as a number; PostgreSQL returns every value as text.
 */
export function json(d: Dialect, col: string, key: string): string {
  checkKey(key);
  return d === 'sqlite' ? `json_extract(${col}, '$.${key}')` : `(${col})::json ->> '${key}'`;
}

/** Whether the value under `key` of the JSON object in `col` is 1 or true; false when it is absent. */
export function jsonIsOne(d: Dialect, col: string, key: string): string {
  checkKey(key);
  return d === 'sqlite'
    ? `json_extract(${col}, '$.${key}') IS 1`
    : `coalesce((${col})::json ->> '${key}' IN ('true', '1'), false)`;
}

/** The negation of jsonIsOne: true when the value is absent too. */
export function jsonIsNotOne(d: Dialect, col: string, key: string): string {
  checkKey(key);
  return d === 'sqlite'
    ? `json_extract(${col}, '$.${key}') IS NOT 1`
    : `NOT coalesce((${col})::json ->> '${key}' IN ('true', '1'), false)`;
}

/**
 * The values of a JSON array given as one parameter (`?`, a JSON text), as a subquery for `IN`:
 * numbers (`bigint`, such as event `seq`s) or strings (`text`, such as ids).
 */
export function idList(d: Dialect, type: 'bigint' | 'text'): string {
  if (d === 'sqlite') return 'SELECT value FROM json_each(?)';
  return type === 'bigint'
    ? 'SELECT value::bigint FROM json_array_elements_text(?::json) AS value'
    : 'SELECT value FROM json_array_elements_text(?::json) AS value';
}

/**
 * The pairs of a JSON array of two-string arrays given as one parameter (`?`), as a subquery of two
 * columns for a row-value `IN`, such as `(source, session_id) IN (...)`.
 */
export function pairList(d: Dialect): string {
  return d === 'sqlite'
    ? "SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)"
    : 'SELECT pair ->> 0, pair ->> 1 FROM json_array_elements(?::json) AS pair';
}

/**
 * Whether the text of event `alias` reads as a prompt (see promptTitle): through a function of the
 * connection on SQLite, and on PostgreSQL through `event_prompt`, which ingestion fills from the same
 * function.
 */
export function isPrompt(d: Dialect, alias: string): string {
  return d === 'sqlite'
    ? `origin_prompt(${alias}.text) = 1`
    : `EXISTS (SELECT 1 FROM event_prompt ep WHERE ep.seq = ${alias}.seq)`;
}

/**
 * Events `alias` whose text may hold every one of `grams`, three letters each, through the trigram
 * index of every event, as the FROM and the WHERE condition of a query: a cheap filter, which the
 * caller follows with an exact check of the text.
 */
export function trigramFilter(
  d: Dialect,
  alias: string,
  grams: string[],
): { from: string; where: string } {
  for (const g of grams) {
    if ([...g].length !== 3 || /["'\\]/.test(g)) throw new Error(`Not a trigram: ${g}`);
  }
  if (d === 'sqlite') {
    return {
      from: `event_fts f JOIN event ${alias} ON ${alias}.seq = f.rowid`,
      where: `event_fts MATCH '${grams.map((g) => `"${g}"`).join(' AND ')}'`,
    };
  }
  return {
    from: `event ${alias}`,
    where: `origin_trigrams(${alias}.text) @> ARRAY[${grams.map((g) => `'${g}'`).join(', ')}]`,
  };
}
