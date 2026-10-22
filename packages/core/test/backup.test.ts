import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupStore,
  type Database,
  forget,
  OriginError,
  openDatabase,
  remember,
  searchEvents,
  stats,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let tmp: string;
let home: string;
let src: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-backup-'));
  home = path.join(tmp, 'home');
  src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mirrorOf = (root: string) => path.join(root, 'raw', 'fake', 'a.jsonl');

describe('backupStore', () => {
  it('copies the database and the mirrors, then only what is new', async () => {
    const file = path.join(src, 'a.jsonl');
    fs.writeFileSync(file, line('1', 's', 1000, 'user', 'back up the sqlite store'));
    await syncSource({ db, home }, fakeAdapter(src));
    remember(db, {
      kind: 'knowledge',
      text: 'Stores are backed up with the online backup.',
      confidence: 0.9,
      author: 'test',
      sources: [{ eventId: 'fake:1' }],
    });
    const target = path.join(tmp, 'backup');
    const first = await backupStore(db, home, target);
    expect(first.mirrorFiles).toBe(1);
    expect(first.mirrorBytesCopied).toBe(fs.statSync(mirrorOf(home)).size);

    fs.appendFileSync(file, line('2', 's', 2000, 'user', 'and then some more'));
    await syncSource({ db, home }, fakeAdapter(src));
    forget(db, 'fake:2');
    const second = await backupStore(db, home, target);
    expect(second.mirrorBytesCopied).toBe(
      line('2', 's', 2000, 'user', 'and then some more').length,
    );
    expect(fs.readFileSync(mirrorOf(target), 'utf8')).toBe(fs.readFileSync(file, 'utf8'));

    const copy = openDatabase(path.join(target, 'origin.db'));
    try {
      expect(stats(copy)).toEqual(stats(db));
      expect(searchEvents(copy, 'sqlite store').map((h) => h.id)).toEqual(['fake:1']);
      expect(searchEvents(copy, 'some more')).toEqual([]); // forgotten before the backup
    } finally {
      copy.close();
    }
  });

  it('refuses to back up a store into itself or its mirrors', async () => {
    await expect(backupStore(db, home, home)).rejects.toThrow(OriginError);
    await expect(backupStore(db, home, path.join(home, 'raw'))).rejects.toThrow(OriginError);
    await expect(backupStore(db, home, path.join(home, 'raw', 'b'))).rejects.toThrow(OriginError);
    await expect(backupStore(db, home, path.join(home, 'backup'))).resolves.toBeDefined();
  });
});
