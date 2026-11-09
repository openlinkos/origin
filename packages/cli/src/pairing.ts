import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type Database,
  dbPath,
  type OpenOptions,
  OriginError,
  openDatabase,
} from '@openlinkos/origin-core';

/**
 * `store.json`, which pairs a store kept in PostgreSQL with the ORIGIN_HOME that holds its raw
 * mirrors (see store.ts), and the opening of a store in SQLite, which it may refuse. Apart from
 * store.ts, so that agents' hooks, which never open a store in PostgreSQL, do not load its client.
 */

/** The pairing file in ORIGIN_HOME. */
export const PAIRING_FILE = 'store.json';

/** The environment variable that names a store's PostgreSQL database (see pg/url.ts). */
const DATABASE_URL_ENV = 'ORIGIN_DATABASE_URL';

/** What store.json says: the store's id, and the engine it is kept in. */
export interface Pairing {
  id: string;
  engine: 'sqlite' | 'postgres';
}

/** Whether the environment names a PostgreSQL database for the store (set, not yet read). */
export function postgresConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[DATABASE_URL_ENV]?.trim() || env[`${DATABASE_URL_ENV}_FILE`]?.trim());
}

/** store.json of `home`, or null without one. Throws an OriginError if it cannot be read. */
export function readPairing(home: string): Pairing | null {
  const file = path.join(home, PAIRING_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OriginError(`Cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? err}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const p = value as Partial<Pairing> | null;
  if (
    !p ||
    typeof p.id !== 'string' ||
    p.id === '' ||
    (p.engine !== 'sqlite' && p.engine !== 'postgres')
  ) {
    throw new OriginError(
      `${file} is not a store's pairing file: it should hold {"id": "<store id>", "engine": "postgres" or "sqlite"}.`,
    );
  }
  return { id: p.id, engine: p.engine };
}

/** Write store.json of `home`, replacing it whole. */
export function writePairing(home: string, pairing: Pairing): void {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, PAIRING_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ id: pairing.id, engine: pairing.engine }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** A new store id, for a store that has none yet (one in SQLite, until it is moved). */
export function newStoreId(): string {
  return randomUUID();
}

/**
 * Open the store in SQLite of ORIGIN_HOME `home` (see openDatabase), unless its store.json says
 * that its store is in PostgreSQL: then the URL was left out, and a new, empty store must not be
 * made here instead.
 */
export function openLocalStore(home: string, opts: OpenOptions = {}): Database {
  const pairing = readPairing(home);
  if (pairing?.engine === 'postgres') {
    throw new OriginError(
      `The store of ORIGIN_HOME ${home} is in PostgreSQL (store ${pairing.id}, ${path.join(home, PAIRING_FILE)}): set ORIGIN_DATABASE_URL, or ORIGIN_DATABASE_URL_FILE, to open it.`,
    );
  }
  return openDatabase(dbPath(home), opts);
}
