import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { PgDatabase, type PgOptions } from '../../src/pg/client.js';
import { type PgTarget, parseDatabaseUrl } from '../../src/pg/url.js';

/**
 * PostgreSQL for the client's tests: the server ORIGIN_TEST_DATABASE_URL names, as a superuser (or
 * a role that may create databases). Without it, these tests are skipped. Each test file gets a
 * database of its own, created with the locale a store needs and dropped afterwards, and each test
 * a schema of its own in it.
 */
export const TEST_URL = process.env.ORIGIN_TEST_DATABASE_URL ?? '';
export const onPostgres = TEST_URL !== '';

const require = createRequire(import.meta.url);
/** Where `pg` is, for tests that act as another client of the server. */
export const pgPath = require.resolve('pg');

/** A connection of `pg` itself, for what a test does from outside the client. */
interface Admin {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

async function admin(url: string): Promise<Admin> {
  const pg = require(pgPath) as { Client: new (c: object) => Admin & { connect(): Promise<void> } };
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/** `url` with another database. */
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
}

let database = '';
let databaseUrl = '';
const opened: PgDatabase[] = [];

/** Create this file's database; close what the tests opened after each, and drop it at the end. */
export function usePostgres(): void {
  beforeAll(async () => {
    if (!onPostgres) return;
    database = `origin_test_${randomBytes(6).toString('hex')}`;
    const a = await admin(TEST_URL);
    try {
      await a.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`);
      // Messages in English, whatever the server's language, where the role may say so.
      await a.query(`ALTER DATABASE ${database} SET lc_messages = 'C'`).catch(() => {});
    } finally {
      await a.end();
    }
    databaseUrl = withDatabase(TEST_URL, database);
  });
  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });
  afterAll(async () => {
    if (!database) return;
    const a = await admin(TEST_URL);
    try {
      await a.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await a.end();
    }
  });
}

/** A target in this file's database, in a new schema unless `schema` names one. */
export function target(schema = `t_${randomBytes(6).toString('hex')}`): PgTarget {
  const u = new URL(databaseUrl);
  u.searchParams.set('schema', schema);
  return parseDatabaseUrl(u.href);
}

/** A client of `t`, closed after the test; SQL is checked as in test mode unless `opts` says. */
export function open(t: PgTarget, opts: PgOptions = {}): PgDatabase {
  const db = new PgDatabase(t, { checkSql: true, ...opts });
  opened.push(db);
  return db;
}

/** Run SQL from outside the client, on this file's database (or another, by URL). */
export async function outside(
  sql: string,
  params: unknown[] = [],
  url = databaseUrl,
): Promise<Array<Record<string, unknown>>> {
  const a = await admin(url);
  try {
    return (await a.query(sql, params)).rows;
  } finally {
    await a.end();
  }
}

/** The URL of the server's own database, and of this file's. */
export const urls = () => ({ server: TEST_URL, database: databaseUrl });

/**
 * Terminate backend `pid` `ms` from now, from a thread of its own: it runs while this thread is
 * blocked in a call to the client. Resolves once it has.
 */
export function terminateLater(pid: number, ms: number): Promise<void> {
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     const pg = require(workerData.pgPath);
     setTimeout(async () => {
       const c = new pg.Client({ connectionString: workerData.url });
       await c.connect();
       await c.query('SELECT pg_terminate_backend($1)', [workerData.pid]);
       await c.end();
       parentPort.postMessage('done');
     }, workerData.ms);`,
    { eval: true, workerData: { pgPath, url: databaseUrl, pid, ms } },
  );
  return new Promise((resolve, reject) => {
    worker.once('message', () => {
      void worker.terminate();
      resolve();
    });
    worker.once('error', reject);
  });
}

/** The backend of a client's connection. */
export function backend(db: PgDatabase): number {
  return (db.prepare('SELECT pg_backend_pid() AS pid').get() as { pid: number }).pid;
}

/** Block this thread for `ms` (the clients' workers and the server go on). */
export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
