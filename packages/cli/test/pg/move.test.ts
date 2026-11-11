import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  connectSqlite,
  copyStore,
  type Database,
  dbPath,
  digestStore,
  openDatabase,
  searchEvents,
  verifyCopy,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRichStore } from '../../../core/test/rich-store.js';
import { main } from '../../src/main.js';
import { readPairing } from '../../src/pairing.js';
import { holdServeLock, openStore } from '../../src/store.js';
import { onPostgres, open, outside, target, urls, usePostgres } from './helpers.js';

/**
 * `origin db move` (see packages/cli/src/db-move.ts): a store with a little of everything moved
 * from SQLite into PostgreSQL, into another schema, and back into SQLite, the same in every table;
 * what it refuses; `origin backup` of a store in PostgreSQL; and `origin db rebuild-search`.
 */

usePostgres();

const ENV = ['ORIGIN_HOME', 'ORIGIN_DATABASE_URL', 'ORIGIN_DATABASE_URL_FILE'] as const;
const TERMS = ['仓库', '数据库', 'digests', 'rowids', 'pipeline', 'subagent', 'copystore'];

let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];
const opened: Database[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-pg-move-'));
  home = path.join(tmp, 'home');
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ORIGIN_HOME = home;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) db.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The URL of a store in schema `schema` of this file's database. */
function storeUrl(schema: string): string {
  const u = new URL(urls().database);
  u.searchParams.set('schema', schema);
  return u.href;
}

/** The newest matches of each of TERMS, by id. */
const searches = (db: Database) =>
  TERMS.map((t) => searchEvents(db, t, { order: 'recent', limit: 20 }).map((h) => h.id));

/** A store in SQLite in `home`, with a little of everything: its digests and searches. */
async function richStore(): Promise<{
  digests: ReturnType<typeof digestStore>;
  found: string[][];
}> {
  const db = openDatabase(dbPath(home));
  try {
    await buildRichStore(db, home, path.join(tmp, 'logs'));
    return { digests: digestStore(db), found: searches(db) };
  } finally {
    db.close();
  }
}

/** Open the store of `home` in PostgreSQL, in `schema`, as the CLI does; closed after the test. */
function openPg(schema: string): Database {
  const db = openStore(home, { ORIGIN_DATABASE_URL: storeUrl(schema) }, { command: 'test' });
  opened.push(db);
  return db;
}

const run = async (argv: string[]) => {
  out = [];
  err = [];
  return main(argv);
};

/** Run `argv`, which must succeed. */
const ok = async (argv: string[]) => {
  const code = await run(argv);
  expect(code, err.join('\n')).toBe(0);
};

describe.skipIf(!onPostgres)('origin db move', () => {
  it('moves a store into PostgreSQL, into another schema, and back, the same in every table', async () => {
    const original = await richStore();
    expect(original.found.some((ids) => ids.length > 0)).toBe(true);
    const first = storeUrl('moved_a');
    const second = storeUrl('moved_b');

    // Without --yes, it says what it would do, and does nothing.
    expect(await run(['db', 'move', '--to', first])).toBe(1);
    expect(out.join('\n')).toMatch(/This will copy the store/);
    expect(out.join('\n')).toContain('re-run with --yes');
    expect(
      await outside("SELECT 1 FROM pg_tables WHERE schemaname = 'moved_a' AND tablename = 'event'"),
    ).toEqual([]);

    // A process that has the store open (a hub, say) stops the move.
    const busy = openDatabase(dbPath(home));
    expect(await run(['db', 'move', '--to', first, '--yes'])).toBe(1);
    expect(err.join('\n')).toMatch(/Another process has the store open/);
    busy.close();

    // SQLite → PostgreSQL.
    await ok(['db', 'move', '--to', first, '--yes']);
    expect(out.join('\n')).toMatch(/Moved the store into PostgreSQL/);
    const pairing = readPairing(home);
    expect(pairing?.engine).toBe('postgres');
    expect(fs.existsSync(dbPath(home))).toBe(false);
    const retired = fs.readdirSync(home).filter((f) => f.startsWith('origin.db.moved-'));
    expect(retired).toHaveLength(1);
    const a = openPg('moved_a');
    expect(digestStore(a)).toEqual(original.digests);
    expect(searches(a)).toEqual(original.found);
    a.close();

    // Without the URL, ORIGIN_HOME no longer opens a store in SQLite.
    expect(await run(['status'])).toBe(1);
    expect(err.join('\n')).toMatch(/is in PostgreSQL/);

    // A hub running on it stops a move.
    process.env.ORIGIN_DATABASE_URL = first;
    const hub = openPg('moved_a');
    holdServeLock(hub);
    expect(await run(['db', 'move', '--to', second, '--yes'])).toBe(1);
    expect(err.join('\n')).toMatch(/origin serve is running/);
    hub.close();

    // PostgreSQL → another schema: the store keeps its id, and the first is retired.
    await ok(['db', 'move', '--to', second, '--yes']);
    expect(readPairing(home)).toEqual(pairing);
    expect(await run(['status'])).toBe(1);
    expect(err.join('\n')).toMatch(/has been moved to PostgreSQL at/);
    expect(err.join('\n')).not.toContain(new URL(urls().database).password || '\0');

    // PostgreSQL → SQLite.
    process.env.ORIGIN_DATABASE_URL = second;
    await ok(['db', 'move', '--to', 'sqlite', '--yes']);
    expect(readPairing(home)).toEqual({ id: pairing?.id, engine: 'sqlite' });
    expect(await run(['status'])).toBe(1);
    expect(err.join('\n')).toMatch(/has been moved to SQLite at/);
    delete process.env.ORIGIN_DATABASE_URL;
    const back = openDatabase(dbPath(home));
    try {
      expect(digestStore(back)).toEqual(original.digests);
      expect(searches(back)).toEqual(original.found);
      const check = back.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      expect(check.integrity_check).toBe('ok');
    } finally {
      back.close();
    }
    await ok(['status']);

    // Into PostgreSQL again: the store keeps the id store.json gave it.
    await ok(['db', 'move', '--to', storeUrl('moved_c'), '--yes']);
    expect(readPairing(home)).toEqual(pairing);
  });

  it('checks searches past a word that follows U+0000, which only PostgreSQL finds', async () => {
    await richStore();
    const source = openDatabase(dbPath(home));
    try {
      // The rich store's message "A line with a NUL\u0000in it, which PostgreSQL text cannot hold."
      const nul = searchEvents(source, 'cannot hold', { order: 'recent', limit: 20 });
      const copy = open(target());
      const copied = copyStore(source, copy, { searches: 0 });
      const there = searchEvents(copy, 'cannot hold', { order: 'recent', limit: 20 });
      // SQLite's LIKE reads a text only up to its first U+0000; PostgreSQL keeps it as U+FFFD.
      expect(there.length).toBe(nul.length + 1);
      expect(
        verifyCopy(copy, { ...copied, searches: ['cannot hold', 'pipeline'] }, source),
      ).toEqual([]);
    } finally {
      source.close();
    }
  });

  it('refuses a target that is not empty, and leaves the store as it was', async () => {
    const original = await richStore();
    // Another store in the target schema.
    const elsewhere = path.join(tmp, 'elsewhere');
    opened.push(
      openStore(elsewhere, { ORIGIN_DATABASE_URL: storeUrl('taken') }, { command: 'test' }),
    );
    expect(await run(['db', 'move', '--to', storeUrl('taken'), '--yes'])).toBe(1);
    expect(err.join('\n')).toMatch(/is not empty/);
    expect(fs.existsSync(path.join(home, 'store.json'))).toBe(false);
    const db = openDatabase(dbPath(home));
    try {
      expect(digestStore(db)).toEqual(original.digests);
    } finally {
      db.close();
    }
    // Nor into SQLite where it is already, nor anywhere without --to.
    expect(await run(['db', 'move', '--to', 'sqlite', '--yes'])).toBe(1);
    expect(err.join('\n')).toMatch(/in SQLite already/);
    expect(await run(['db', 'move'])).toBe(2);
    expect(await run(['db', 'move', '--to', 'mysql://x'])).toBe(2);
  });

  it('backs up a store in PostgreSQL as a store in SQLite, and rebuilds its search', async () => {
    const original = await richStore();
    await ok(['db', 'move', '--to', storeUrl('backed'), '--yes']);
    process.env.ORIGIN_DATABASE_URL = storeUrl('backed');

    const target = path.join(tmp, 'backup');
    await ok(['backup', target]);
    const copy = connectSqlite(path.join(target, 'origin.db'));
    try {
      expect(digestStore(copy)).toEqual(original.digests);
    } finally {
      copy.close();
    }
    expect(fs.readdirSync(path.join(target, 'raw', 'fake')).length).toBeGreaterThan(0);

    await ok(['db', 'rebuild-search']);
    expect(out.join('\n')).toMatch(/Rebuilt the search indexes/);
    expect(searches(openPg('backed'))).toEqual(original.found);
  });
});
