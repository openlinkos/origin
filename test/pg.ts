import { setDatabaseFactory } from '@openlinkos/origin-core';

/**
 * Which engine this run's stores are in. With ORIGIN_TEST_DATABASE_URL set, every store a test opens
 * through openDatabase or openMemoryDatabase is in PostgreSQL (see pg-setup.ts); a test of what only
 * SQLite has (its files, its pragmas, its FTS5 tables, stores of old versions) is skipped there,
 * through `describe.skipIf(onPostgres)` or `it.skipIf(onPostgres)`.
 */
export const onPostgres = (process.env.ORIGIN_TEST_DATABASE_URL ?? '') !== '';

/**
 * Run `open` with stores in SQLite whatever the run's engine: for a test that compares the two
 * engines, or reads what it writes with SQLite's own tools.
 */
export function inSqlite<T>(open: () => T): T {
  const before = setDatabaseFactory(null);
  try {
    return open();
  } finally {
    setDatabaseFactory(before);
  }
}
