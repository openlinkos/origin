import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setDatabaseFactory } from '@openlinkos/origin-core';
import { afterAll, inject } from 'vitest';

/**
 * Each test file's setup for a run on PostgreSQL (see pg-global.ts): every store the file opens
 * through openDatabase or openMemoryDatabase is a schema of this run's database, so that the suite
 * runs unchanged on PostgreSQL. On SQLite, it does nothing.
 *
 * A store's file stands for its schema as it stands for a SQLite database: opening a file that does
 * not exist creates a store, in a new schema, and the file, which names the schema; opening the file
 * again reaches the same store, wherever the test is; removing the file (or its directory) removes
 * the store from the test's sight. `:memory:` is a new schema each time. The stores still open after
 * the file's tests are closed then.
 */

const url = inject('originTestDatabase');

/** What a store's file holds on PostgreSQL: this, then the schema. */
const MARK = 'An Origin test store in PostgreSQL, in schema ';

/** The schema of the store whose file is `file` (see the top of this file). */
function schemaOf(file: string): string {
  if (file === ':memory:') return `m_${randomBytes(6).toString('hex')}`;
  let text = '';
  try {
    text = fs.readFileSync(file, 'latin1');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text.startsWith(MARK)) return text.slice(MARK.length).trim();
  if (text !== '') {
    throw new Error(
      `${file} is a SQLite database: a test that writes one runs on SQLite only (describe.skipIf(onPostgres), see test/pg.ts)`,
    );
  }
  const schema = `f_${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${MARK}${schema}\n`);
  return schema;
}

if (url) {
  const { PgDatabase } = await import('../packages/cli/src/pg/client.js');
  const { parseDatabaseUrl } = await import('../packages/cli/src/pg/url.js');
  const opened: Array<{ close(): void }> = [];
  setDatabaseFactory((file) => {
    const u = new URL(url);
    u.searchParams.set('schema', schemaOf(file === ':memory:' ? file : path.resolve(file)));
    const db = new PgDatabase(parseDatabaseUrl(u.href), { checkSql: true });
    opened.push(db);
    return db;
  });
  afterAll(() => {
    for (const db of opened.splice(0)) db.close();
  });
}
