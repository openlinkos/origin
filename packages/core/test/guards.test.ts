import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  forget,
  openDatabase,
  remember,
  syncSource,
  transaction,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

/**
 * The append-only guards of store format 12: the tables a purge deletes from refuse deletes (and
 * raw_chunk updates) unless guard_lift names them, which only a purge's own transaction does; the
 * others refuse always.
 */

let tmp: string;
let home: string;
let db: Database;
let entryId: string;

/** Every table whose guard a purge lifts. */
const LIFTED = [
  'event',
  'entry',
  'entry_source',
  'imported_entry',
  'recall',
  'recall_item',
  'raw_chunk',
];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-guards-'));
  home = path.join(tmp, 'home');
  const logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  fs.writeFileSync(
    path.join(logs, 'a.jsonl'),
    `${line('1', 's1', 1000, 'user', 'deploy the staging cluster')}${line('2', 's1', 2000, 'assistant', 'Deployed the cluster.')}`,
  );
  db = openDatabase(path.join(home, 'origin.db'));
  await syncSource({ db, home }, fakeAdapter(logs));
  entryId = remember(db, {
    kind: 'knowledge',
    text: 'The cluster is called staging.',
    confidence: 1,
    author: 'user@laptop',
    sources: [{ eventId: 'fake:1' }],
  }).id;
  db.prepare(
    `INSERT INTO recall (id, at, origin, occasion, budget, tokens)
     VALUES ('rcl_000000000001', 1000, 'laptop', 'prompt', 400, 60)`,
  ).run();
  db.prepare(
    `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
     VALUES ('rcl_000000000001', 1, 'prompt', 'entry', ?, 2.5, 20)`,
  ).run(entryId);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

/** Run `fn` in a write transaction with guard_lift naming `names`, removed again before COMMIT. */
function lifted<T>(names: string[], fn: () => T): T {
  return transaction(
    db,
    () => {
      const add = db.prepare('INSERT INTO guard_lift (name) VALUES (?)');
      for (const name of names) add.run(name);
      try {
        return fn();
      } finally {
        db.exec('DELETE FROM guard_lift');
      }
    },
    { immediate: true },
  );
}

describe('append-only guards', () => {
  it('refuse deletes from the tables a purge deletes from, without a purge', () => {
    // A row trigger fires only for a row: give every guarded table one.
    db.prepare('INSERT INTO imported_entry (entry_id) VALUES (?)').run(entryId);
    db.prepare(
      `INSERT INTO raw_chunk (raw_file_id, first_line, line_count, byte_offset, byte_length,
                              frame_offset, frame_length)
       VALUES ((SELECT MIN(id) FROM raw_file), 1000, 1, 0, 1, 0, 1)`,
    ).run();
    for (const sql of [
      'DELETE FROM event',
      'DELETE FROM entry_source',
      'DELETE FROM imported_entry',
      'DELETE FROM entry',
      'DELETE FROM recall_item',
      'DELETE FROM recall',
      'DELETE FROM raw_chunk',
      'UPDATE raw_chunk SET line_count = 0',
    ]) {
      expect(() => db.prepare(sql).run(), sql).toThrow(/append-only/);
    }
    expect(count('SELECT COUNT(*) AS n FROM event')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM entry')).toBe(1);
    // Events may still be updated: nothing guards that, and a purge never does it.
    db.exec("UPDATE event SET cwd = '/work' WHERE id = 'fake:1'");
  });

  it('lift for a table that guard_lift names, inside one transaction', () => {
    lifted(LIFTED, () => {
      db.prepare(
        `INSERT INTO raw_chunk (raw_file_id, first_line, line_count, byte_offset, byte_length,
                                frame_offset, frame_length)
         VALUES ((SELECT MIN(id) FROM raw_file), 1000, 1, 0, 1, 0, 1)`,
      ).run();
      db.exec('UPDATE raw_chunk SET frame_length = 2 WHERE first_line = 1000');
      db.exec('DELETE FROM raw_chunk WHERE first_line = 1000');
      db.exec('DELETE FROM recall_item');
      db.exec('DELETE FROM recall');
      db.exec('DELETE FROM entry_source');
      db.exec('DELETE FROM imported_entry');
      db.exec('DELETE FROM entry');
      db.exec("DELETE FROM event WHERE id = 'fake:1'");
    });
    expect(count('SELECT COUNT(*) AS n FROM guard_lift')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM entry')).toBe(0);
    // The search indexes lost what was deleted (entry_ad, event_ad).
    expect(count(`SELECT COUNT(*) AS n FROM entry_fts WHERE entry_fts MATCH 'staging'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM event_fts WHERE event_fts MATCH 'sta'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH 'staging'`)).toBe(
      0,
    );
    expect(count(`SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH 'cluster'`)).toBe(
      1,
    );
    for (const index of ['entry_fts', 'event_fts', 'message_fts']) {
      expect(() =>
        db.exec(`INSERT INTO ${index} (${index}) VALUES ('integrity-check')`),
      ).not.toThrow();
    }
    // The guards hold again once the transaction is over.
    expect(() => db.exec('DELETE FROM event')).toThrow(/append-only/);
  });

  it('lift only for the tables guard_lift names', () => {
    expect(() =>
      lifted(['event'], () => {
        db.exec('DELETE FROM entry_source');
      }),
    ).toThrow(/entry_source is append-only/);
    expect(() =>
      lifted(['entry_source', 'recall_item'], () => {
        db.exec('DELETE FROM recall_item');
        db.exec('DELETE FROM entry_source');
        db.exec('DELETE FROM entry');
      }),
    ).toThrow(/entry is append-only/);
    // Rolled back with the transaction.
    expect(count('SELECT COUNT(*) AS n FROM entry_source')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM recall_item')).toBe(1);
  });

  it('never lift for entry updates, tombstones, recall updates, or the records of purges', () => {
    forget(db, entryId, { reason: 'wrong cluster', author: 'user@laptop' });
    db.prepare(
      `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts)
       VALUES ('prg_000000000001', 1000, 'laptop', 'user@laptop', 'cli', 'test', '{}', '{}')`,
    ).run();
    db.prepare(
      "INSERT INTO purged (kind, id, purge_id) VALUES ('event', 'fake:9', 'prg_000000000001')",
    ).run();
    db.prepare(
      `INSERT INTO purge_line (raw_file_id, first_line, line_count, purge_id)
       VALUES ((SELECT MIN(id) FROM raw_file), 1, 1, 'prg_000000000001')`,
    ).run();
    const every = [...LIFTED, 'tombstone', 'purge', 'purged', 'purge_line'];
    for (const sql of [
      "UPDATE entry SET text = 'changed'",
      "UPDATE tombstone SET reason = 'changed'",
      'DELETE FROM tombstone',
      'UPDATE recall SET tokens = 1',
      'UPDATE recall_item SET tokens = 1',
      "UPDATE purge SET reason = 'changed'",
      'DELETE FROM purge',
      "UPDATE purged SET id = 'fake:8'",
      'DELETE FROM purged',
      'UPDATE purge_line SET line_count = 2',
      'DELETE FROM purge_line',
    ]) {
      expect(() => lifted(every, () => db.exec(sql)), sql).toThrow(/append-only/);
    }
    // A purge's work queue is not a record: its rows go once the work is done.
    db.prepare(
      'INSERT INTO purge_pending (raw_file_id, since) VALUES ((SELECT MIN(id) FROM raw_file), 1)',
    ).run();
    db.exec('UPDATE purge_pending SET attempts = attempts + 1');
    db.exec('DELETE FROM purge_pending');
  });
});
