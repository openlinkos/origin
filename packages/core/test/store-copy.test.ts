import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COPIED_TABLES,
  CopyMismatchError,
  connectSqlite,
  copyStore,
  copyToSqliteFile,
  type Database,
  digestStore,
  getEntry,
  listEntries,
  OriginError,
  openDatabase,
  remember,
  searchEvents,
  verifyCopy,
} from '../src/index.js';
import { buildRichStore, RICH_TABLES } from './rich-store.js';

let tmp: string;
let home: string;
let db: Database;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-store-copy-'));
  home = path.join(tmp, 'home');
  db = openDatabase(path.join(home, 'origin.db'));
  await buildRichStore(db, home, path.join(tmp, 'logs'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ids = (store: Database, term: string) =>
  searchEvents(store, term, { order: 'recent', limit: 20 }).map((h) => h.id);
const keys = (store: Database, sql: string) =>
  (store.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => Object.values(r));

describe('copyToSqliteFile', () => {
  it('copies every row with its keys, and the copy is a store like the original', () => {
    const file = path.join(tmp, 'copy', 'origin.db');
    const copied = copyToSqliteFile(db, file);
    expect(copied.tables.map((t) => t.table)).toEqual(COPIED_TABLES);
    expect(copied.searches.length).toBeGreaterThan(0);
    const rows = Object.fromEntries(copied.tables.map((t) => [t.table, t.rows]));
    for (const t of RICH_TABLES) expect(rows[t], t).toBeGreaterThan(0);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);

    // A store in SQLite whatever engine the store is in (connectSqlite: no factory of the tests).
    const copy = connectSqlite(file);
    try {
      // The same rows, by the copy's own reading of them.
      expect(verifyCopy(copy, copied, db)).toEqual([]);
      expect(digestStore(copy)).toEqual(digestStore(db));
      expect(copy.formatVersion()).toBe(db.formatVersion());
      for (const sql of [
        'SELECT seq, id FROM event ORDER BY seq',
        'SELECT rowid, id FROM entry ORDER BY rowid',
        'SELECT rowid, id FROM tombstone ORDER BY rowid',
        'SELECT seq, kind, id FROM change_log ORDER BY seq',
        'SELECT id, action FROM audit_log ORDER BY id',
        'SELECT seq, id FROM recall ORDER BY seq',
      ]) {
        expect(keys(copy, sql)).toEqual(keys(db, sql));
      }
      for (const term of ['仓库', '数据库', 'digests', 'rowids', 'hunter2', 'pipeline']) {
        expect(ids(copy, term)).toEqual(ids(db, term));
      }
      expect(ids(copy, 'digests').length).toBeGreaterThan(0);
      expect(ids(copy, '数据库').length).toBeGreaterThan(0);
      expect(listEntries(copy, {}).map((e) => e.id)).toEqual(listEntries(db, {}).map((e) => e.id));
      const entry = listEntries(db, {})[0];
      if (entry) expect(getEntry(copy, entry.id)).toEqual(getEntry(db, entry.id));
      // The triggers are in place again: entries are append-only, and a new one is logged.
      expect(() =>
        copy.exec(`UPDATE entry SET confidence = 0.1 WHERE id = '${entry?.id}'`),
      ).toThrow(/append-only/);
      const last = () => Number(keys(copy, 'SELECT MAX(seq) FROM change_log')[0]?.[0]);
      const before = last();
      remember(copy, {
        kind: 'knowledge',
        text: 'Written to the copy.',
        confidence: 0.5,
        author: 'test',
        sources: [{ eventId: 'fake:a1' }],
      });
      expect(last()).toBe(before + 1);
    } finally {
      copy.close();
    }
  });

  it('refuses a file that exists, and leaves nothing of a copy that fails', () => {
    const file = path.join(tmp, 'origin.db');
    fs.writeFileSync(file, '');
    expect(() => copyToSqliteFile(db, file)).toThrow(/exists already/);

    // A value of another type than its column's, which SQLite keeps and PostgreSQL would not.
    if (db.dialect !== 'sqlite') return;
    db.exec("UPDATE event SET ts = 'yesterday' WHERE id = 'fake:a1'");
    const other = path.join(tmp, 'other.db');
    expect(() => copyToSqliteFile(db, other)).toThrow(
      /event\.ts holds a value that is not an integer/,
    );
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.existsSync(`${other}.partial`)).toBe(false);
  });

  it('refuses a store with tables it does not know', () => {
    db.exec('CREATE TABLE later_feature (id INTEGER PRIMARY KEY)');
    expect(() => copyToSqliteFile(db, path.join(tmp, 'c.db'))).toThrow(/later_feature/);
  });
});

describe('copyStore', () => {
  it('copies only into an empty database', () => {
    const target = connectSqlite(path.join(tmp, 'busy.db'));
    try {
      target.exec('CREATE TABLE t (x)');
      expect(() => copyStore(db, target)).toThrow(OriginError);
    } finally {
      target.close();
    }
  });

  it('finds a copy that differs', () => {
    const file = path.join(tmp, 'copy.db');
    const copied = copyToSqliteFile(db, file, { searches: 0 });
    const copy = connectSqlite(file);
    try {
      copy.exec("UPDATE event SET text = 'changed' WHERE id = 'fake:a2'");
      copy.exec('DELETE FROM api_token');
      const problems = verifyCopy(copy, copied);
      expect(problems).toContain('the rows of event differ in the copy');
      expect(problems).toContain('api_token has 0 rows in the copy, not 1');
      expect(new CopyMismatchError(problems).message).toMatch(/does not match the store/);
    } finally {
      copy.close();
    }
  });
});
