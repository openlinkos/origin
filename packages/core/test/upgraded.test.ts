import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { onPostgres } from '../../../test/pg.js';
import { openDatabase, reparsePlaces, STORE_VERSION, transaction } from '../src/index.js';

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(onPostgres)('a store a newer Origin has upgraded', () => {
  it('refuses the next write and leaves the store unchanged', () => {
    const home = tempDir('origin-upgraded-');
    const db = openDatabase(path.join(home, 'origin.db'));
    try {
      transaction(db, () => {
        db.exec('CREATE TABLE still_open (id INTEGER)');
      });
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'still_open'").get(),
      ).toBeDefined();
      db.exec(`PRAGMA user_version = ${STORE_VERSION + 1}`);
      expect(() =>
        transaction(db, () => {
          db.exec('CREATE TABLE wrote_after (id INTEGER)');
        }),
      ).toThrow(/Restart this process/);
      expect(() => reparsePlaces(db, home)).toThrow(/Restart this process/);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'wrote_after'").get(),
      ).toBeUndefined();
      expect(db.prepare('PRAGMA user_version').get()).toEqual({
        user_version: STORE_VERSION + 1,
      });
    } finally {
      db.close();
    }
  });

  it('refuses a migration write when the store was upgraded further first', () => {
    const home = tempDir('origin-upgraded-migrate-');
    const file = path.join(home, 'origin.db');
    const opened = openDatabase(file);
    opened.close();
    // The list has to be the whole sequence. One later step is what this process would run.
    const migrations = Array.from({ length: STORE_VERSION }, (_, i) => ({
      version: i + 2,
      name: `v${i + 2}`,
      up() {},
    }));
    expect(() =>
      openDatabase(file, {
        migrations,
        beforeMigrate(db) {
          db.exec(`PRAGMA user_version = ${STORE_VERSION + 2}`);
        },
      }),
    ).toThrow(/Restart this process/);
    const again = new DatabaseSync(file, { readOnly: true });
    try {
      expect(again.prepare('PRAGMA user_version').get()).toEqual({
        user_version: STORE_VERSION + 2,
      });
    } finally {
      again.close();
    }
  });

  it('still writes a store this process knows, including one it is upgrading', () => {
    const home = tempDir('origin-current-');
    const db = openDatabase(path.join(home, 'origin.db'));
    try {
      db.exec(`PRAGMA user_version = ${STORE_VERSION - 1}`);
      transaction(db, () => {
        db.exec('CREATE TABLE during_upgrade (id INTEGER)');
      });
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'during_upgrade'").get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });
});
