import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTombstone,
  correct,
  type Database,
  defaultStoreName,
  entryCounts,
  entryHistory,
  entrySources,
  exportTombstone,
  forget,
  getEntry,
  getEvent,
  initStoreName,
  isEntryForgotten,
  listEntries,
  OriginError,
  openDatabase,
  remember,
  setStoreName,
  storeName,
  syncSource,
} from '../src/index.js';
import { applied, fakeAdapter, line } from './helpers.js';

let home: string;
let src: string;
let db: Database;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('e1', 's1', 1000, 'user', 'The store is SQLite.') +
      line('e2', 's1', 2000, 'assistant', 'SQLite with FTS5 trigram search.') +
      line('e3', 's1', 3000, 'user', 'Every device keeps a full local store.') +
      line('e4', 's1', 4000, 'user', 'The hub is always online.'),
  );
  await syncSource({ db, home }, fakeAdapter(src));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

const note = (eventIds: string[], text = 'Chose SQLite.', now = 10_000) =>
  remember(
    db,
    {
      kind: 'knowledge',
      text,
      confidence: 0.9,
      author: 'claude-code@laptop',
      sources: eventIds.map((eventId) => ({ eventId })),
    },
    now,
  );

/** A version written on another store, inserted as replication would. */
function arrive(v: {
  id: string;
  supersedes: string;
  createdAt: number;
  sources: string[];
  text?: string;
  origin?: string;
}): void {
  const { root } = db.prepare('SELECT root FROM entry WHERE id = ?').get(v.supersedes) as {
    root: string;
  };
  db.prepare(
    `INSERT INTO entry (id, kind, text, confidence, author, project, supersedes, root, created_at, origin)
     VALUES (?, 'knowledge', ?, 1, 'user@hub', NULL, ?, ?, ?, ?)`,
  ).run(v.id, v.text ?? `version ${v.id}`, v.supersedes, root, v.createdAt, v.origin ?? 'hub');
  for (const s of v.sources) {
    db.prepare('INSERT INTO entry_source (entry_id, event_id, quote) VALUES (?, ?, NULL)').run(
      v.id,
      s,
    );
  }
}

describe('store identity', () => {
  it('names the store once and keeps the name once it has written under it', () => {
    expect(defaultStoreName()).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    const fresh = openDatabase(':memory:');
    expect(initStoreName(fresh, 'laptop')).toBe('laptop');
    expect(initStoreName(fresh, 'desk')).toBe('laptop');
    expect(setStoreName(fresh, 'desk')).toBe('desk'); // nothing written yet
    expect(() => setStoreName(fresh, 'Bad Name')).toThrow(OriginError);
    fresh.close();

    setStoreName(db, 'laptop');
    const e = note(['fake:e1']);
    expect(e).toMatchObject({ origin: 'laptop', root: e.id });
    expect(storeName(db)).toBe('laptop');
    expect(() => setStoreName(db, 'desk')).toThrow(/keeps it/);
    expect(setStoreName(db, 'laptop')).toBe('laptop');
  });

  it('logs every entry and tombstone in an append-only change log', () => {
    setStoreName(db, 'laptop');
    const a = note(['fake:e1']);
    const b = correct(db, a.id, { text: 'Chose SQLite with FTS5.', author: 'user@laptop' });
    const t = forget(db, 'fake:e4', { reason: 'test' });
    const log = db.prepare('SELECT seq, kind, id, origin FROM change_log ORDER BY seq').all();
    expect(log).toEqual([
      { seq: 1, kind: 'entry', id: a.id, origin: 'laptop' },
      { seq: 2, kind: 'entry', id: b.id, origin: 'laptop' },
      { seq: 3, kind: 'tombstone', id: t.tombstoneId, origin: 'laptop' },
    ]);
    expect(t.tombstoneId).toMatch(/^tmb_[0-9a-f]{12}$/);
    expect(() => db.exec('DELETE FROM change_log')).toThrow(/append-only/);
    expect(() => db.exec("UPDATE change_log SET origin = 'x'")).toThrow(/append-only/);
  });
});

describe('concurrent corrections', () => {
  it('make the version with the greatest (created_at, id) current, wherever it was written', () => {
    const a = note(['fake:e1'], 'v1', 10_000);
    const mine = correct(db, a.id, { text: 'device version', author: 'user@laptop' }, 20_000);
    // A correction of the same version, written on the hub a little later.
    arrive({ id: 'ent_00000000000f', supersedes: a.id, createdAt: 30_000, sources: ['fake:e2'] });

    expect(getEntry(db, 'ent_00000000000f')).toMatchObject({ status: 'active', concurrent: false });
    expect(getEntry(db, mine.id)).toMatchObject({
      status: 'superseded',
      concurrent: true,
      supersededBy: 'ent_00000000000f',
    });
    expect(getEntry(db, a.id)).toMatchObject({
      status: 'superseded',
      concurrent: false,
      supersededBy: 'ent_00000000000f',
    });
    expect(listEntries(db).map((e) => e.id)).toEqual(['ent_00000000000f']);
    expect(listEntries(db, { includeSuperseded: true })).toHaveLength(3);
    expect(entryCounts(db).knowledge).toBe(1);
    expect(entryHistory(db, mine.id).map((e) => e.id)).toEqual([a.id, mine.id, 'ent_00000000000f']);

    // Only the current version can be corrected; the error names it.
    expect(() => correct(db, mine.id, { text: 'again', author: 'user@laptop' })).toThrow(
      /lost to a concurrent correction, ent_00000000000f/,
    );
    expect(() => correct(db, a.id, { text: 'again', author: 'user@laptop' })).toThrow(
      /current version is ent_00000000000f/,
    );

    // Correcting the losing branch's sibling continues the chain; equal times fall back to the id.
    arrive({
      id: 'ent_00000000000a',
      supersedes: mine.id,
      createdAt: 30_000,
      sources: ['fake:e3'],
    });
    expect(getEntry(db, 'ent_00000000000f')?.status).toBe('active');
    arrive({
      id: 'ent_0000000000ff',
      supersedes: mine.id,
      createdAt: 30_000,
      sources: ['fake:e3'],
    });
    expect(getEntry(db, 'ent_0000000000ff')?.status).toBe('active');
    expect(getEntry(db, 'ent_00000000000f')).toMatchObject({ concurrent: true });
    expect(getEntry(db, mine.id)).toMatchObject({ concurrent: false });
  });

  it('date a correction after the version it corrects, even with a clock behind', () => {
    const a = note(['fake:e1'], 'v1', 50_000);
    const b = correct(db, a.id, { text: 'v2', author: 'user@laptop' }, 40_000);
    expect(b.createdAt).toBe(50_001);
    expect(getEntry(db, b.id)?.status).toBe('active');
  });

  it('forget every version of a forked entry, and the events each version cites', () => {
    const a = note(['fake:e1'], 'v1', 10_000);
    const mine = correct(db, a.id, { text: 'device version', author: 'user@laptop' }, 20_000);
    arrive({ id: 'ent_00000000000f', supersedes: a.id, createdAt: 30_000, sources: ['fake:e2'] });

    const r = forget(db, mine.id, { reason: 'test' });
    expect(r.entries.sort()).toEqual([a.id, mine.id, 'ent_00000000000f'].sort());
    expect(r.events.sort()).toEqual(['fake:e1', 'fake:e2']);
    expect(listEntries(db, { includeSuperseded: true })).toEqual([]);
  });

  it('judge provenance (rule 3) by the current version', () => {
    const a = note(['fake:e1'], 'v1', 10_000);
    const b = correct(
      db,
      a.id,
      { text: 'v2', author: 'user@laptop', sources: [{ eventId: 'fake:e3' }] },
      20_000,
    );
    // The current version still has a visible source: nothing more is forgotten.
    forget(db, 'fake:e2', { reason: 'test' });
    const other = note(['fake:e1'], 'only e1', 15_000);
    forget(db, other.id, { reason: 'test' });
    expect(getEntry(db, b.id)?.status).toBe('active');
    expect(entrySources(db, b.id).map((s) => s.eventId)).toEqual(['fake:e3']);
    // Its last source goes: the whole chain has lost its provenance.
    const r = forget(db, 'fake:e4', { reason: 'test' });
    expect(r.entries).toEqual([]);
    const last = note(['fake:e3'], 'cites e3', 25_000);
    forget(db, last.id, { reason: 'test' });
    expect(isEntryForgotten(db, a.id)).toBe(true);
    expect(isEntryForgotten(db, b.id)).toBe(true);
  });
});

describe('applying tombstones from other stores', () => {
  it('applies listed effects with whole chains, and only known ids', () => {
    setStoreName(db, 'laptop');
    const a = note(['fake:e1'], 'v1', 10_000);
    const b = correct(
      db,
      a.id,
      { text: 'v2', author: 'user@laptop', sources: [{ eventId: 'fake:e3' }] },
      20_000,
    );
    // The hub forgot version a (it had not seen b yet) and its source, plus things unknown here.
    const t = {
      id: 'tmb_00000000000a',
      target: 'fake:h9',
      reason: null,
      createdAt: 30_000,
      origin: 'hub',
      entries: [a.id, 'ent_ffffffffffff'],
      events: ['fake:e1', 'fake:h9'],
    };
    expect(applyTombstone(db, t)).toEqual(applied(2, 1));
    expect(isEntryForgotten(db, b.id)).toBe(true);
    // Version b's own new source was not listed, and a listed entry excludes nothing by itself.
    expect(getEvent(db, 'fake:e3')).not.toBeNull();
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(exportTombstone(db, t.id)).toEqual({
      ...t,
      entries: [a.id, b.id].sort(),
      events: ['fake:e1'],
    });
    // Its change carries the hub's origin, so a device never sends it back.
    const log = db.prepare("SELECT origin FROM change_log WHERE kind = 'tombstone'").all();
    expect(log).toEqual([{ origin: 'hub' }]);
  });

  it('applies the target by the rules too, and records growth when asked to', () => {
    setStoreName(db, 'hub');
    const a = note(['fake:e1', 'fake:e2'], 'v1', 10_000);
    // A device forgot event e1; it knew no entry citing it.
    const t = {
      id: 'tmb_00000000000b',
      target: 'fake:e1',
      reason: 'pasted a secret',
      createdAt: 30_000,
      origin: 'laptop',
      entries: [],
      events: ['fake:e1'],
    };
    expect(applyTombstone(db, t, { keep: true, growthOrigin: 'hub' })).toEqual(applied(1, 2));
    expect(isEntryForgotten(db, a.id)).toBe(true);
    expect(getEvent(db, 'fake:e2')).toBeNull();
    const log = db.prepare("SELECT origin FROM change_log WHERE kind = 'tombstone'").all();
    // Inserted under the device's origin, then grown here: the device must learn about a and e2.
    expect(log).toEqual([{ origin: 'laptop' }, { origin: 'hub' }]);

    // Applying again changes nothing and logs nothing.
    expect(applyTombstone(db, t, { keep: true, growthOrigin: 'hub' })).toEqual(applied(0, 0));
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual({ n: 3 });

    // A hub keeps tombstones that change nothing; a device does not.
    const none = { ...t, id: 'tmb_00000000000c', target: 'fake:zz', events: ['fake:zz'] };
    expect(applyTombstone(db, none)).toEqual(applied(0, 0));
    expect(exportTombstone(db, none.id)).toBeNull();
    applyTombstone(db, none, { keep: true });
    expect(exportTombstone(db, none.id)).toMatchObject({ entries: [], events: [] });
  });
});
