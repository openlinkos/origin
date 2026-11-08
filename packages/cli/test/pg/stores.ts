import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { type DatabaseFactory, setDatabaseFactory } from '@openlinkos/origin-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { onPostgres, open, target, usePostgres } from './helpers.js';

/**
 * Stores in PostgreSQL for a test file of core's: every store the file opens (openDatabase,
 * openMemoryDatabase) is a schema in this file's database, so that core's own tests run on
 * PostgreSQL unchanged. A store's file maps to one schema, so that opening the same file again
 * reaches the same store; `:memory:` is a new schema each time.
 */
export function usePostgresStores(): void {
  usePostgres();
  let before: DatabaseFactory | null = null;
  beforeAll(() => {
    if (!onPostgres) return;
    before = setDatabaseFactory((file) => {
      const schema =
        file === ':memory:'
          ? `m_${randomBytes(6).toString('hex')}`
          : `f_${createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 16)}`;
      return open(target(schema));
    });
  });
  afterAll(() => {
    if (onPostgres) setDatabaseFactory(before);
  });
}

/**
 * Run core's test file `name` (`search` for core/test/search.test.ts) on PostgreSQL, or report it
 * skipped without ORIGIN_TEST_DATABASE_URL.
 */
export async function runCoreTests(name: string, load: () => Promise<unknown>): Promise<void> {
  usePostgresStores();
  if (onPostgres) await load();
  else describe.skip(`core's ${name} tests on PostgreSQL`, () => it('needs a server', () => {}));
}
