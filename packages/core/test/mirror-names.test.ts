import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onPostgres } from '../../../test/pg.js';
import {
  backupStore,
  type Database,
  getEvent,
  localRawFiles,
  openDatabase,
  rawLocator,
  readRawLine,
  sealIdleMirrors,
  syncSource,
} from '../src/index.js';
import { tailPath } from '../src/mirror.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

/**
 * Two files of one source with one relative path, such as an agent's directory before and after it
 * moved: each has a mirror of its own, so that neither writes into the other's (invariants 1, 3).
 */

let tmp: string;
let home: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-names-'));
  home = path.join(tmp, 'home');
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A directory of the fake source, with one file `s.jsonl` (or `name`) of these lines. */
function dir(name: string, lines: string[], file = 's.jsonl'): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, file), lines.join(''));
  return d;
}

const rawFiles = () =>
  db
    .prepare('SELECT id, path, generation, mirror FROM raw_file ORDER BY id')
    .all() as unknown as Array<{ id: number; path: string; generation: number; mirror: string }>;

/** The raw line of an event, as `origin show` and the MCP tool `sources` read it. */
function rawLineOf(store: Database, storeHome: string, id: string): string | null {
  const ev = getEvent(store, id);
  if (!ev) throw new Error(`no event ${id}`);
  const loc = rawLocator(store, storeHome, ev);
  return loc ? readRawLine(store, storeHome, loc) : null;
}

const mark = (p: string) => createHash('sha256').update(p).digest('hex').slice(0, 12);
const a1 = line('a1', 'sa', 1000, 'user', 'first file, first line');
const a2 = line('a2', 'sa', 1001, 'assistant', 'first file, second line');
const b1 = line('b1', 'sb', 2000, 'user', 'second file, first line');
const c1 = line('c1', 'sc', 3000, 'user', 'third file, in another case');

describe('mirror names', () => {
  it('keeps two files with one relative path in mirrors of their own, and both readable', async () => {
    const a = dir('a', [a1, a2]);
    const b = dir('b', [b1]);
    const c = dir('c', [c1], 'S.jsonl');
    await syncSource({ db, home }, fakeAdapter(a));
    await syncSource({ db, home }, fakeAdapter(b));
    await syncSource({ db, home }, fakeAdapter(c));

    const files = rawFiles();
    expect(files.map((f) => f.mirror.split(path.sep).join('/'))).toEqual([
      'fake/s.jsonl',
      `fake/s.~${mark(path.join(b, 's.jsonl'))}.jsonl`,
      `fake/S.~${mark(path.join(c, 'S.jsonl'))}.jsonl`,
    ]);
    expect(files.map((f) => mirrorText(db, home, f.id))).toEqual([a1 + a2, b1, c1]);
    // Every event, of both files, finds its own line; each file keeps its relative path.
    for (const [id, text] of [
      ['fake:a1', a1],
      ['fake:a2', a2],
      ['fake:b1', b1],
      ['fake:c1', c1],
    ] as const) {
      expect(rawLineOf(db, home, id), id).toBe(text.trim());
    }
    expect(localRawFiles(db).map((f) => f.relPath)).toEqual(['s.jsonl', 's.jsonl', 'S.jsonl']);

    // The same file keeps its mirror as it grows, and the other's lines stay as they were.
    const a3 = line('a3', 'sa', 1002, 'user', 'first file, third line');
    const b2 = line('b2', 'sb', 2001, 'assistant', 'second file, second line');
    fs.appendFileSync(path.join(a, 's.jsonl'), a3);
    fs.appendFileSync(path.join(b, 's.jsonl'), b2);
    expect((await syncSource({ db, home }, fakeAdapter(b))).newGenerations).toBe(0);
    expect((await syncSource({ db, home }, fakeAdapter(a))).newGenerations).toBe(0);
    expect(rawFiles()).toEqual(files);
    expect(rawFiles().map((f) => mirrorText(db, home, f.id))).toEqual([a1 + a2 + a3, b1 + b2, c1]);

    // Sealed, backed up, and read from the backup: the same lines.
    expect(
      sealIdleMirrors(db, home, { before: Date.now() + IDLE, remote: false, frameBytes: 64 }),
    ).toBe(3);
    // A backup copies a store in SQLite only.
    if (onPostgres) return;
    const target = path.join(tmp, 'backup');
    await backupStore(db, home, target);
    const copy = openDatabase(path.join(target, 'origin.db'));
    try {
      for (const id of ['fake:a1', 'fake:a3', 'fake:b1', 'fake:b2', 'fake:c1']) {
        expect(rawLineOf(copy, target, id), id).toBe(rawLineOf(db, home, id));
      }
    } finally {
      copy.close();
    }
  });

  it('moves a file whose mirror an earlier version let another file share to a mirror of its own', async () => {
    const a = dir('a', [a1, a2]);
    const b = dir('b', [b1]);
    await syncSource({ db, home }, fakeAdapter(a));
    await syncSource({ db, home }, fakeAdapter(b));
    // As an earlier version left them: the second file's row names the first's mirror, whose tail
    // the second file's lines replaced.
    const [first, second] = rawFiles() as [
      ReturnType<typeof rawFiles>[number],
      ReturnType<typeof rawFiles>[number],
    ];
    fs.copyFileSync(tailPath(home, second.mirror), tailPath(home, first.mirror));
    db.prepare('UPDATE raw_file SET mirror = ? WHERE id = ?').run(first.mirror, second.id);
    const shared = fs.readFileSync(tailPath(home, first.mirror));
    expect(rawLineOf(db, home, 'fake:b1')).toBe(b1.trim());

    // Nothing seals a shared mirror: one file's tail would cut the other's lines.
    expect(sealIdleMirrors(db, home, { before: Date.now() + IDLE, remote: false })).toBe(0);

    // The next lines of either file go to a new generation with a mirror of its own; the shared
    // mirror is left as it was, and the events already read keep their lines.
    const b2 = line('b2', 'sb', 2001, 'assistant', 'second file, second line');
    fs.appendFileSync(path.join(b, 's.jsonl'), b2);
    expect(await syncSource({ db, home }, fakeAdapter(b))).toMatchObject({
      newGenerations: 1,
      eventsAdded: 1,
    });
    const a3 = line('a3', 'sa', 1002, 'user', 'first file, third line');
    fs.appendFileSync(path.join(a, 's.jsonl'), a3);
    expect(await syncSource({ db, home }, fakeAdapter(a))).toMatchObject({
      newGenerations: 1,
      eventsAdded: 1,
    });
    expect(rawLineOf(db, home, 'fake:b2')).toBe(b2.trim());
    expect(rawLineOf(db, home, 'fake:a3')).toBe(a3.trim());
    expect(rawLineOf(db, home, 'fake:b1')).toBe(b1.trim());
    expect(fs.readFileSync(tailPath(home, first.mirror))).toEqual(shared);
    const mirrors = rawFiles().map((f) => f.mirror.toLowerCase());
    expect(new Set(mirrors.slice(2)).size).toBe(2);
    expect(mirrors.slice(2)).not.toContain(first.mirror.toLowerCase());
  });
});

/** Later than any file's last change, so that every tail counts as idle. */
const IDLE = 2 * 60 * 60_000;
