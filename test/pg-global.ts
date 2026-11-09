import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { TestProject } from 'vitest/node';

/**
 * Vitest's global setup for a run on PostgreSQL: when ORIGIN_TEST_DATABASE_URL names a server (as a
 * role that may create databases), create a database for this run, `origin_test_<run>`, with the
 * encoding and collation a store needs whatever the cluster's defaults, hand its URL to the test
 * files (pg-setup.ts), and drop it at the end. Without the variable, it does nothing.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** The URL of this run's database on PostgreSQL, or '' on SQLite. */
    originTestDatabase: string;
  }
}

/** `pg`, a dependency of the CLI's alone. */
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));

interface Client {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

async function onServer(url: string, statements: string[]): Promise<void> {
  const pg = require('pg') as { Client: new (c: object) => Client };
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const sql of statements) await c.query(sql);
  } finally {
    await c.end();
  }
}

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  const server = process.env.ORIGIN_TEST_DATABASE_URL ?? '';
  project.provide('originTestDatabase', '');
  if (!server) return;
  const name = `origin_test_${randomBytes(6).toString('hex')}`;
  await onServer(server, [`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`]);
  // Messages in English, whatever the server's language, where the role may say so.
  await onServer(server, [`ALTER DATABASE ${name} SET lc_messages = 'C'`]).catch(() => {});
  const url = new URL(server);
  url.pathname = `/${name}`;
  project.provide('originTestDatabase', url.href);
  return async () => {
    await onServer(server, [`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
  };
}
