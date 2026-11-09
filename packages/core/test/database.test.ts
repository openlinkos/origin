import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onPostgres } from '../../../test/pg.js';
import {
  type Database,
  openDatabase,
  openMemoryDatabase,
  SqliteDatabase,
  STORE_VERSION,
  setDatabaseFactory,
  transaction,
} from '../src/index.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-database-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the database a store is opened through', () => {
  it.skipIf(onPostgres)('is SQLite, and answers what the store needs to know of itself', () => {
    const file = path.join(tmp, 'origin.db');
    const db = openDatabase(file);
    try {
      expect(db.dialect).toBe('sqlite');
      expect(fs.realpathSync(db.location())).toBe(fs.realpathSync(file));
      expect(db.formatVersion()).toBe(STORE_VERSION);
      expect(db.hasTable('event')).toBe(true);
      expect(db.hasTable('event_fts')).toBe(true);
      expect(db.hasTable('no_such_table')).toBe(false);
      expect(db.hasColumn('recall_item', 'excerpt')).toBe(true);
      expect(db.hasColumn('recall_item', 'no_such_column')).toBe(false);
      const size = db.databaseBytes();
      expect(size.bytes).toBeGreaterThan(0);
      expect(size.walBytes).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });

  it('knows whether a transaction is open', () => {
    const db = openMemoryDatabase();
    try {
      // An in-memory database is nowhere; a store in PostgreSQL is in its schema.
      if (!onPostgres) expect(db.location()).toBe('');
      expect(db.isTransaction).toBe(false);
      transaction(db, () => expect(db.isTransaction).toBe(true), { immediate: true });
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it('records the format version in the transaction that brings the store there', () => {
    const db = openMemoryDatabase();
    try {
      expect(() =>
        transaction(
          db,
          () => {
            db.setFormatVersion(STORE_VERSION - 1);
            throw new Error('rolled back');
          },
          { immediate: true },
        ),
      ).toThrow('rolled back');
      expect(db.formatVersion()).toBe(STORE_VERSION);
    } finally {
      db.close();
    }
  });

  it.skipIf(onPostgres)('waits for the write lock as long as asked, then as before', async () => {
    const db = openDatabase(path.join(tmp, 'origin.db'));
    const timeout = () => (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    try {
      expect(timeout()).toBe(10_000);
      expect(db.withWaitTimeout(250, timeout)).toBe(250);
      expect(timeout()).toBe(10_000);
      expect(() =>
        db.withWaitTimeout(250, () => {
          throw new Error('failed');
        }),
      ).toThrow('failed');
      expect(timeout()).toBe(10_000);
      // Until the promise of an async `fn` settles.
      const later = db.withWaitTimeout(250, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return timeout();
      });
      expect(timeout()).toBe(250);
      await expect(later).resolves.toBe(250);
      expect(timeout()).toBe(10_000);
      await expect(
        db.withWaitTimeout(250, async () => {
          await new Promise((resolve) => setImmediate(resolve));
          throw new Error('failed later');
        }),
      ).rejects.toThrow('failed later');
      expect(timeout()).toBe(10_000);
    } finally {
      db.close();
    }
  });

  it('comes from the factory a test sets', () => {
    const opened: string[] = [];
    const made: Database[] = [];
    const before = setDatabaseFactory((file) => {
      opened.push(file);
      const db = new SqliteDatabase(new DatabaseSync(':memory:'));
      made.push(db);
      return db;
    });
    try {
      const db = openDatabase(path.join(tmp, 'origin.db'));
      expect(db).toBe(made[0]);
      // Made ready as any store: the latest format.
      expect(db.formatVersion()).toBe(STORE_VERSION);
      expect(db.hasTable('event')).toBe(true);
      db.close();
      openMemoryDatabase().close();
      expect(opened).toEqual([path.join(tmp, 'origin.db'), ':memory:']);
      expect(fs.existsSync(path.join(tmp, 'origin.db'))).toBe(false);
    } finally {
      setDatabaseFactory(before);
    }
  });
});
