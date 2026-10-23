import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupStore,
  type Database,
  forget,
  getEvent,
  OriginError,
  openDatabase,
  rawLocator,
  readRawLine,
  remember,
  searchEvents,
  stats,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

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

/** The files of the mirror of `a.jsonl` under a store or backup directory. */
const filesOf = (root: string) => {
  const base = path.join(root, 'raw', 'fake', 'a.jsonl');
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0));
  return { frames: read(`${base}.zst`), tail: read(`${base}.tail`) };
};
/** A store's mirror files take this much space, as stored. */
const storedSize = (root: string) => {
  const f = filesOf(root);
  return f.frames.length + f.tail.length;
};

/** Small frames, so that a few lines are sealed into several. */
const FRAME = 200;
const sync = (store: Database, storeHome: string) =>
  syncSource({ db: store, home: storeHome, frameBytes: FRAME }, fakeAdapter(src));

describe('backupStore', () => {
  it('copies the database and the mirrors, then only what is new', async () => {
    const file = path.join(src, 'a.jsonl');
    fs.writeFileSync(file, line('1', 's', 1000, 'user', 'back up the sqlite store'));
    await sync(db, home);
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
    expect(first.mirrorBytesCopied).toBe(storedSize(home));
    expect(filesOf(target)).toEqual(filesOf(home));
    expect((await backupStore(db, home, target)).mirrorBytesCopied).toBe(0);

    // New lines seal the open tail into frames: the backup adds the new frames, and writes the
    // tail again, since what it held is now sealed.
    for (let i = 2; i <= 6; i++) {
      fs.appendFileSync(file, line(String(i), 's', 1000 * i, 'user', `and then line ${i}`));
      await sync(db, home);
    }
    forget(db, 'fake:2', { reason: 'test' });
    const framesBefore = filesOf(target).frames.length;
    expect(filesOf(home).frames.length).toBeGreaterThan(framesBefore);
    const second = await backupStore(db, home, target);
    expect(second.mirrorBytesCopied).toBe(storedSize(home) - framesBefore);
    expect(filesOf(target)).toEqual(filesOf(home));

    // More lines that stay in the tail: only they are copied.
    const more = line('7', 's', 7000, 'user', 'tail');
    fs.appendFileSync(file, more);
    await sync(db, home);
    expect((await backupStore(db, home, target)).mirrorBytesCopied).toBe(Buffer.byteLength(more));
    expect(filesOf(target)).toEqual(filesOf(home));

    const copy = openDatabase(path.join(target, 'origin.db'));
    try {
      expect(stats(copy)).toEqual(stats(db));
      expect(searchEvents(copy, 'sqlite store').map((h) => h.id)).toEqual(['fake:1']);
      expect(searchEvents(copy, 'line 2')).toEqual([]); // forgotten before the backup
      expect(mirrorText(copy, target, getEvent(copy, 'fake:1')!.rawFileId)).toBe(
        fs.readFileSync(file, 'utf8'),
      );
    } finally {
      copy.close();
    }
  });

  it('restores into a store that reads every line and keeps ingesting', async () => {
    const file = path.join(src, 'a.jsonl');
    const lines = Array.from({ length: 12 }, (_, i) =>
      line(String(i + 1), 's', 1000 + i, 'user', `line ${i + 1} ${'·'.repeat(i * 7)}`),
    );
    fs.writeFileSync(file, lines.slice(0, 8).join(''));
    await sync(db, home);
    const target = path.join(tmp, 'backup');
    await backupStore(db, home, target);

    // Restore: copy the backup into an empty ORIGIN_HOME.
    const restored = path.join(tmp, 'restored');
    fs.cpSync(target, restored, { recursive: true });
    const copy = openDatabase(path.join(restored, 'origin.db'));
    try {
      for (let i = 1; i <= 8; i++) {
        const e = getEvent(copy, `fake:${i}`)!;
        expect(readRawLine(copy, restored, rawLocator(copy, restored, e)!)).toBe(
          (lines[i - 1] as string).trim(),
        );
      }
      // The restored store goes on from where the backup stopped, sealing more frames.
      fs.appendFileSync(file, lines.slice(8).join(''));
      expect((await sync(copy, restored)).eventsAdded).toBe(4);
      const rawFileId = getEvent(copy, 'fake:12')!.rawFileId;
      expect(mirrorText(copy, restored, rawFileId)).toBe(lines.join(''));
      expect(
        readRawLine(copy, restored, rawLocator(copy, restored, getEvent(copy, 'fake:12')!)!),
      ).toBe((lines[11] as string).trim());
    } finally {
      copy.close();
    }
  });

  it('copies everything again over the backup of another store', async () => {
    const file = path.join(src, 'a.jsonl');
    fs.writeFileSync(file, line('1', 's', 1000, 'user', 'the first store'));
    await sync(db, home);
    const target = path.join(tmp, 'backup');
    await backupStore(db, home, target);

    // Another store, with a mirror of the same name and different lines.
    const otherHome = path.join(tmp, 'other');
    const other = openDatabase(path.join(otherHome, 'origin.db'));
    try {
      fs.writeFileSync(file, line('9', 's', 9000, 'user', 'a second, different store'));
      await sync(other, otherHome);
      await backupStore(other, otherHome, target);
      expect(filesOf(target)).toEqual(filesOf(otherHome));
    } finally {
      other.close();
    }
  });

  it('refuses to back up a store into itself or its mirrors', async () => {
    await expect(backupStore(db, home, home)).rejects.toThrow(OriginError);
    await expect(backupStore(db, home, path.join(home, 'raw'))).rejects.toThrow(OriginError);
    await expect(backupStore(db, home, path.join(home, 'raw', 'b'))).rejects.toThrow(OriginError);
    await expect(backupStore(db, home, path.join(home, 'backup'))).resolves.toBeDefined();
  });
});
