import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { type DatabaseFactory, setDatabaseFactory } from '@openlinkos/origin-core';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import { PgDatabase, type PgOptions } from '../../src/pg/client.js';
import { type PgTarget, parseDatabaseUrl } from '../../src/pg/url.js';

/**
 * PostgreSQL for the client's tests: the server ORIGIN_TEST_DATABASE_URL names, as a superuser (or
 * a role that may create databases). Without it, these tests are skipped. They use the database of
 * this run (see test/pg-global.ts), each test a schema of its own in it.
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

const databaseUrl = inject('originTestDatabase');
const opened: PgDatabase[] = [];

/**
 * Open stores as Origin does, and close what each test opened after it. These tests choose each
 * store's engine themselves: in PostgreSQL through `open` or a URL, and in SQLite, as on a device,
 * through openDatabase, which elsewhere in a run on PostgreSQL opens a schema (test/pg-setup.ts).
 */
export function usePostgres(): void {
  let before: DatabaseFactory | null = null;
  beforeAll(() => {
    before = setDatabaseFactory(null);
  });
  afterAll(() => {
    setDatabaseFactory(before);
  });
  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });
}

/** A target in this run's database, in a new schema unless `schema` names one. */
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

/** Run SQL from outside the client, on this run's database (or another, by URL). */
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

/**
 * A connection of `pg` itself to this run's database, with `schema` alone on its search_path, as
 * a program other than Origin would connect: the caller ends it.
 */
export async function connect(schema: string): Promise<Admin> {
  const a = await admin(databaseUrl);
  await a.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
  return a;
}

/** The URL of the server's own database, and of this run's. */
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
