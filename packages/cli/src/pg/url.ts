import fs from 'node:fs';
import { OriginError } from '@openlinkos/origin-core';

/**
 * Where a hub's store lives when it is in PostgreSQL: `ORIGIN_DATABASE_URL`, or the file that
 * `ORIGIN_DATABASE_URL_FILE` names (for a secret mounted as a file), holding a
 * `postgres://user:password@host:port/database` URL. Its `schema` parameter, Origin's own, names the
 * schema the store's tables are in (`origin` by default); the rest of the URL goes to the driver as
 * it is, so its other parameters (`sslmode`, `sslrootcert`, `host` for a socket directory, and so
 * on) work as the driver documents them. The password never appears in a message: `display` hides
 * it, and `redact` removes it from any text.
 */

export const DATABASE_URL_ENV = 'ORIGIN_DATABASE_URL';

/** The schema a store is in unless its URL names one. */
export const DEFAULT_SCHEMA = 'origin';

/** A schema Origin may name: a lower-case identifier, which needs no quoting to mean itself. */
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

/** Query parameters whose values are secrets. */
const SECRET_PARAMS = new Set(['password', 'sslpassword']);

export interface PgTarget {
  /** The URL for the driver, without `schema`. It holds the password, if the URL has one. */
  readonly url: string;
  readonly schema: string;
  /** The URL with its secrets hidden, and the schema: for messages and `location()`. */
  readonly display: string;
  /** What must never appear in a message: the password, as written and decoded. */
  readonly secrets: readonly string[];
}

/**
 * The store's URL from the environment, or null when neither variable is set. Throws an OriginError
 * when both are, when the file cannot be read, or when the URL is not one.
 */
export function databaseUrlFrom(env: NodeJS.ProcessEnv): PgTarget | null {
  const name = DATABASE_URL_ENV;
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) throw new OriginError(`Set ${name} or ${name}_FILE, not both.`);
  if (!file) return direct ? parseDatabaseUrl(direct, name) : null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new OriginError(
      `Cannot read ${name}_FILE (${file}): ${(err as NodeJS.ErrnoException).code ?? 'error'}.`,
    );
  }
  if (!text) throw new OriginError(`${name}_FILE (${file}) is empty.`);
  return parseDatabaseUrl(text, `${name}_FILE`);
}

/** Read a store's URL; `from` names where it came from, for messages, which never quote it. */
export function parseDatabaseUrl(text: string, from = DATABASE_URL_ENV): PgTarget {
  const expected = 'expected postgres://user:password@host:port/database';
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new OriginError(`${from} is not a URL: ${expected}.`);
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new OriginError(`${from} is not a PostgreSQL URL: ${expected}.`);
  }
  const secrets = new Set<string>();
  if (u.password) {
    secrets.add(u.password);
    secrets.add(decode(u.password));
  }
  const schemas: string[] = [];
  const kept: string[] = [];
  const query = u.search.slice(1);
  // The URL goes to the driver as written, without `schema`: rebuilding it would encode it anew.
  for (const pair of query ? query.split('&') : []) {
    const at = pair.indexOf('=');
    const key = decode((at === -1 ? pair : pair.slice(0, at)).replaceAll('+', ' '));
    const value = at === -1 ? '' : decode(pair.slice(at + 1).replaceAll('+', ' '));
    if (SECRET_PARAMS.has(key) && value) {
      secrets.add(value);
      secrets.add(pair.slice(at + 1));
    }
    if (key === 'schema') schemas.push(value);
    else kept.push(pair);
  }
  if (schemas.length > 1) throw new OriginError(`${from} names more than one schema.`);
  const schema = schemas[0] ?? DEFAULT_SCHEMA;
  if (!SCHEMA.test(schema) || schema.startsWith('pg_')) {
    throw new OriginError(
      `${from} names schema "${schema}": a schema must be a lower-case name of letters, digits, and _ (not starting with pg_).`,
    );
  }
  const url =
    schemas.length === 0
      ? text
      : `${text.slice(0, text.length - u.hash.length - u.search.length)}${kept.length > 0 ? `?${kept.join('&')}` : ''}${u.hash}`;
  return { url, schema, display: display(u, schema), secrets: [...secrets] };
}

/** The URL with its password and secret parameters shown as `***`, and the store's schema. */
function display(u: URL, schema: string): string {
  const shown = new URL(u.href);
  if (shown.password) shown.password = '***';
  shown.hash = '';
  const params = new URLSearchParams(shown.search);
  for (const key of [...params.keys()]) {
    if (SECRET_PARAMS.has(key)) params.set(key, '***');
  }
  params.delete('schema');
  params.append('schema', schema);
  shown.search = params.toString().replaceAll('%2A', '*');
  return shown.href;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `text` with every secret replaced by `***`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  // Longest first, so that a secret that holds another is replaced whole.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}
