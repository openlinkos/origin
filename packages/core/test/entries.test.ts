import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  correct,
  type Database,
  entryHistory,
  entrySources,
  forget,
  getEntry,
  getEvent,
  isEntryForgotten,
  isEventForgotten,
  listEntries,
  listSessions,
  OriginError,
  openDatabase,
  planForget,
  type RememberInput,
  remember,
  searchEntries,
  searchEvents,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let home: string;
let src: string;
let db: Database;

const sync = () => syncSource({ db, home }, fakeAdapter(src));
const file = () => path.join(src, 's1.jsonl');

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
  fs.writeFileSync(
    file(),
    line('e1', 's1', 1000, 'user', 'Use SQLite with FTS5 for storage: it needs zero ops.') +
      line('e2', 's1', 2000, 'assistant', 'Agreed. SQLite keeps everything local.') +
      line('e3', 's1', 3000, 'user', 'I prefer commit messages without attribution trailers.') +
      line(
        'e4',
        's1',
        4000,
        'assistant',
        'remember {"quote":"I prefer commit messages without attribution trailers."}',
        'tool_use',
      ),
  );
  await sync();
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

const memory = (eventIds: string[], text = 'Chose SQLite + FTS5 for storage.'): RememberInput => ({
  kind: 'memory',
  text,
  confidence: 0.9,
  author: 'test',
  sources: eventIds.map((eventId) => ({ eventId })),
});

describe('remember', () => {
  it('stores an entry with its sources and makes it searchable', () => {
    const e = remember(db, { ...memory(['fake:e1']), project: 'demo' });
    expect(e).toMatchObject({ kind: 'memory', status: 'active', author: 'test', project: 'demo' });
    expect(e.id).toMatch(/^ent_[0-9a-f]{12}$/);
    expect(entrySources(db, e.id).map((s) => s.eventId)).toEqual(['fake:e1']);
    expect(searchEntries(db, 'SQLite').map((x) => x.id)).toEqual([e.id]);
    expect(searchEntries(db, 'DB')).toEqual([]); // short query falls back to LIKE
    expect(listEntries(db).map((x) => x.id)).toEqual([e.id]);
  });

  it('requires at least one valid source (invariant 1)', () => {
    expect(() => remember(db, memory([]))).toThrow(OriginError);
    expect(() => remember(db, memory(['fake:nope']))).toThrow(/Unknown event/);
    expect(() =>
      remember(db, { ...memory([]), sources: [{ eventId: 'fake:e1', quote: 'PostgreSQL' }] }),
    ).toThrow(/Quote not found/);
    expect(() => remember(db, { ...memory(['fake:e1']), confidence: 2 })).toThrow(/Confidence/);
  });

  it('resolves a quote to the message, never to the tool call that cites it', () => {
    const e = remember(db, {
      kind: 'cognition',
      text: 'Prefers commit messages without attribution trailers.',
      confidence: 0.95,
      author: 'test',
      sources: [{ quote: 'i prefer commit   messages WITHOUT attribution trailers' }],
    });
    expect(entrySources(db, e.id).map((s) => s.eventId)).toEqual(['fake:e3']);
  });
});

describe('correct', () => {
  it('supersedes an entry without editing it in place (invariant 3)', () => {
    const a = remember(db, memory(['fake:e1']));
    const b = correct(db, a.id, {
      text: 'Chose SQLite + FTS5 so that storage stays local.',
      author: 'user',
      sources: [{ eventId: 'fake:e2' }],
    });
    expect(b.supersedes).toBe(a.id);
    expect(getEntry(db, a.id)).toMatchObject({
      status: 'superseded',
      supersededBy: b.id,
      text: 'Chose SQLite + FTS5 for storage.',
    });
    expect(entrySources(db, b.id).map((s) => s.eventId)).toEqual(['fake:e1', 'fake:e2']);
    expect(listEntries(db).map((x) => x.id)).toEqual([b.id]);
    expect(listEntries(db, { includeSuperseded: true })).toHaveLength(2);
    expect(entryHistory(db, b.id).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(() => correct(db, a.id, { text: 'again', author: 'user' })).toThrow(/already corrected/);
  });
});

describe('forget (invariant 2)', () => {
  it('forgets every version of an entry and excludes its sources for good', async () => {
    const a = remember(db, memory(['fake:e1']));
    const b = correct(db, a.id, { text: 'v2', author: 'user', sources: [{ eventId: 'fake:e2' }] });

    const r = forget(db, a.id, { reason: 'test' });
    expect(r.tombstoneId).not.toBeNull();
    expect(r.entries.sort()).toEqual([a.id, b.id].sort());
    expect(r.events.sort()).toEqual(['fake:e1', 'fake:e2']);

    expect(getEntry(db, b.id)).toBeNull();
    expect(isEntryForgotten(db, b.id)).toBe(true);
    expect(listEntries(db, { includeSuperseded: true })).toEqual([]);
    expect(searchEntries(db, 'SQLite')).toEqual([]);
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(isEventForgotten(db, 'fake:e1')).toBe(true);
    expect(searchEvents(db, 'SQLite')).toEqual([]);

    expect(() => remember(db, memory(['fake:e1']))).toThrow(/forgotten/);
    expect(() =>
      remember(db, { ...memory([]), sources: [{ quote: 'SQLite keeps everything local' }] }),
    ).toThrow(/No event contains/);

    // Re-ingesting, even a rewritten source file, does not bring anything back.
    fs.writeFileSync(file(), fs.readFileSync(file(), 'utf8').replace('zero ops', 'no ops!!'));
    await sync();
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(searchEvents(db, 'SQLite')).toEqual([]);

    expect(forget(db, b.id, { reason: 'test' }).tombstoneId).toBeNull(); // nothing left to forget
  });

  it('forgets entries that cite a forgotten event, and entries left without sources', () => {
    const x = remember(db, memory(['fake:e3', 'fake:e1'], 'x'));
    const y = remember(db, memory(['fake:e1', 'fake:e2'], 'y'));
    const z = remember(db, memory(['fake:e1'], 'z'));

    const plan = planForget(db, 'fake:e3');
    expect(plan.targetType).toBe('event');
    expect(getEntry(db, x.id)).not.toBeNull(); // planning changes nothing

    const r = forget(db, 'fake:e3', { reason: 'test' });
    expect(r.events.sort()).toEqual(['fake:e1', 'fake:e3']);
    expect(r.entries.sort()).toEqual([x.id, z.id].sort());
    expect(getEntry(db, y.id)).not.toBeNull();
    expect(entrySources(db, y.id).map((s) => s.eventId)).toEqual(['fake:e2']);
  });

  it('keeps session aggregates in line with visible events', () => {
    expect(listSessions(db)[0]?.eventCount).toBe(4);
    forget(db, 'fake:e4', { reason: 'test' });
    expect(listSessions(db)[0]?.eventCount).toBe(3);
    for (const id of ['fake:e1', 'fake:e2', 'fake:e3']) forget(db, id, { reason: 'test' });
    expect(listSessions(db)).toEqual([]);
  });

  it('rejects unknown ids', () => {
    expect(() => forget(db, 'ent_000000000000', { reason: 'test' })).toThrow(
      /Unknown entry or event/,
    );
  });
});
