import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEntry } from '../src/entries.js';
import {
  appendRemote,
  correct,
  type Database,
  type EntryKind,
  entryHistory,
  exportTombstone,
  forget,
  getEntry,
  getEvent,
  importedEntryId,
  isStoreNameFixed,
  listEntries,
  listSessions,
  openDatabase,
  ownChanges,
  receiveTombstone,
  remember,
  restore,
  type SourceAdapter,
  searchEntries,
  setStoreName,
  syncSource,
  type TombstoneRecord,
} from '../src/index.js';

let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-logs-'));
  db = openDatabase(path.join(home, 'origin.db'));
  setStoreName(db, 'laptop');
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(logs, { recursive: true, force: true });
});

interface MemoryVersion {
  id: string;
  prev?: string;
  at: number;
  /** Absent once the memory is deleted. */
  text?: string;
  kind?: EntryKind;
}

/**
 * A memory stream as an adapter writes it, kept as a plain file: one version of a memory per line,
 * read into a `memory` event and the memory it carries.
 */
const adapter: SourceAdapter = {
  id: 'agent',
  displayName: 'Agent',
  version: () => '1.0.0',
  async discover() {
    return fs
      .readdirSync(logs)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ absPath: path.join(logs, f), relPath: `memory/${f}` }));
  },
  parseLine(line) {
    const v = JSON.parse(line) as MemoryVersion;
    return {
      events: [
        {
          id: v.id,
          sessionId: 'memory/demo',
          ts: v.at,
          project: 'demo',
          role: 'assistant',
          kind: 'memory',
          text: v.text ?? '',
        },
      ],
      memory: {
        eventId: v.id,
        previous: v.prev ?? null,
        at: v.at,
        entry: v.text
          ? { kind: v.kind ?? 'knowledge', text: v.text, confidence: 0.9, project: 'demo' }
          : null,
      },
    };
  },
};

const stream = () => path.join(logs, 'demo.jsonl');
function write(v: MemoryVersion): string {
  const line = `${JSON.stringify(v)}\n`;
  fs.appendFileSync(stream(), line);
  return line;
}
const sync = () => syncSource({ db, home }, adapter);
/** The entry version derived from a memory version. */
const version = (id: string) => importedEntryId(`agent:${id}`);

describe('native memories', () => {
  it('imports each version of a memory as a version of one entry, citing its event', async () => {
    write({ id: 'm1', at: 1000, text: 'Deploys go through Flux.', kind: 'knowledge' });
    expect(await sync()).toMatchObject({ eventsAdded: 1, parseErrors: 0 });

    const first = getEntry(db, version('m1'));
    expect(first).toMatchObject({
      kind: 'knowledge',
      text: 'Deploys go through Flux.',
      confidence: 0.9,
      author: 'agent@laptop',
      origin: 'laptop',
      project: 'demo',
      supersedes: null,
      createdAt: 1000,
      validTo: null,
      status: 'active',
      imported: true,
    });
    expect(getEvent(db, 'agent:m1')).toMatchObject({ kind: 'memory', sessionId: 'memory/demo' });
    // A memory event belongs to no conversation.
    expect(listSessions(db, {})).toEqual([]);

    write({ id: 'm2', prev: 'm1', at: 2000, text: 'Deploys go through Flux, from master.' });
    await sync();
    const second = getEntry(db, version('m2'));
    expect(second).toMatchObject({ supersedes: version('m1'), root: version('m1') });
    expect(second?.status).toBe('active');
    expect(getEntry(db, version('m1'))?.status).toBe('superseded');
    expect(listEntries(db).map((e) => e.id)).toEqual([version('m2')]);

    // Parsing the same lines again derives nothing new.
    db.prepare('UPDATE raw_file SET bytes_ingested = 0, lines_ingested = 0').run();
    const again = await sync();
    expect(again.eventsAdded).toBe(0);
    expect(entryHistory(db, version('m2'))).toHaveLength(2);
  });

  it('closes the entry when its memory is deleted, and opens it again when it comes back', async () => {
    write({ id: 'm1', at: 1000, text: 'The hub runs in k3s.' });
    write({ id: 'm2', prev: 'm1', at: 2000 });
    await sync();

    const closed = getEntry(db, version('m2'));
    expect(closed).toMatchObject({
      text: 'The hub runs in k3s.',
      supersedes: version('m1'),
      validTo: 2000,
      status: 'active',
    });
    // Ended: history, no longer listed or found.
    expect(listEntries(db)).toEqual([]);
    expect(searchEntries(db, 'k3s')).toEqual([]);
    expect(listEntries(db, { includeEnded: true }).map((e) => e.id)).toEqual([version('m2')]);
    expect(listEntries(db, { includeSuperseded: true })).toHaveLength(2);

    write({ id: 'm3', prev: 'm2', at: 3000, text: 'The hub runs in k3s, on pve-us1.' });
    await sync();
    expect(getEntry(db, version('m3'))).toMatchObject({ supersedes: version('m2'), validTo: null });
    expect(searchEntries(db, 'k3s').map((e) => e.id)).toEqual([version('m3')]);
  });

  it('starts a new chain when the version before made no entry', async () => {
    write({ id: 'm1', at: 1000 }); // a memory file without content
    write({ id: 'm2', prev: 'm1', at: 2000, text: 'Now it says something.' });
    write({ id: 'm3', prev: 'm2', at: 3000 });
    write({ id: 'm4', prev: 'm3', at: 4000 }); // deleted twice: nothing more to close
    await sync();
    expect(getEntry(db, version('m1'))).toBeNull();
    expect(getEntry(db, version('m2'))).toMatchObject({ supersedes: null });
    expect(getEntry(db, version('m3'))).toMatchObject({ validTo: 3000 });
    expect(loadEntry(db, version('m4'))).toBeNull();
  });

  it('keeps a forgotten memory forgotten as its file changes, until the forget is restored', async () => {
    write({ id: 'm1', at: 1000, text: 'A memory the user does not want.' });
    await sync();
    const forgot = forget(db, version('m1'), { reason: 'not true' });

    write({ id: 'm2', prev: 'm1', at: 2000, text: 'Still not wanted.' });
    await sync();
    expect(getEntry(db, version('m2'))).toBeNull();
    expect(loadEntry(db, version('m2'))?.status).toBe('forgotten');
    expect(getEvent(db, 'agent:m2')).toBeNull();
    expect(listEntries(db, { includeEnded: true })).toEqual([]);

    restore(db, forgot.tombstoneId as string, { reason: 'it was true after all' });
    expect(getEntry(db, version('m2'))?.status).toBe('active');
  });

  it('lets a later version of the file win over a correction made in Origin', async () => {
    write({ id: 'm1', at: 1000, text: 'Port 7078.' });
    await sync();
    const fixed = correct(db, version('m1'), { text: 'Port 7079.', author: 'user@laptop' }, 1500);
    expect(getEntry(db, fixed.id)?.status).toBe('active');

    write({ id: 'm2', prev: 'm1', at: 2000, text: 'Port 7080.' });
    await sync();
    expect(getEntry(db, version('m2'))?.status).toBe('active');
    expect(getEntry(db, fixed.id)).toMatchObject({ status: 'superseded', concurrent: true });
  });

  it('is derived again by a hub from the stream, and never sent to it', async () => {
    const text = [
      write({ id: 'm1', at: 1000, text: 'Shared fact.' }),
      write({ id: 'm2', prev: 'm1', at: 2000, text: 'Shared fact, revised.' }),
    ].join('');
    await sync();
    const own = remember(db, {
      kind: 'memory',
      text: 'Written through Origin.',
      confidence: 1,
      author: 'user@laptop',
      sources: [{ eventId: 'agent:m1' }],
    });
    // Only what this store wrote itself goes to its hub.
    expect(ownChanges(db, 0).map((c) => c.id)).toEqual([own.id]);

    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
    const hub = openDatabase(path.join(hubHome, 'origin.db'));
    try {
      setStoreName(hub, 'hub');
      const r = appendRemote({ db: hub, home: hubHome }, adapter, {
        device: 'laptop',
        source: 'agent',
        path: stream(),
        relPath: 'memory/demo.jsonl',
        generation: 1,
        offset: 0,
        data: Buffer.from(text),
      });
      expect(r).toMatchObject({ ok: true, eventsAdded: 2, parseErrors: 0 });
      for (const id of [version('m1'), version('m2')]) {
        const { status: _a, supersededBy: _b, ...onHub } = getEntry(hub, id) ?? {};
        const { status: _c, supersededBy: _d, ...onDevice } = getEntry(db, id) ?? {};
        expect(onHub).toEqual(onDevice);
      }
      expect(getEntry(hub, version('m2'))).toMatchObject({
        author: 'agent@laptop',
        origin: 'laptop',
      });
    } finally {
      hub.close();
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
  });

  it("is read by a hub upgraded after it mirrored a device's memory stream", () => {
    const text = write({ id: 'm1', at: 1000, text: 'Mirrored before.' });
    const current: SourceAdapter = { ...adapter, id: 'claude-code' };
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
    const file = path.join(hubHome, 'origin.db');
    let hub = openDatabase(file);
    try {
      setStoreName(hub, 'hub');
      // A hub of an earlier version mirrors the stream, but reads nothing from it.
      const older = { ...current, parseLine: () => null };
      appendRemote({ db: hub, home: hubHome }, older, {
        device: 'laptop',
        source: 'claude-code',
        path: stream(),
        relPath: 'memory/demo.jsonl',
        generation: 1,
        offset: 0,
        data: Buffer.from(text),
      });
      expect(getEvent(hub, 'claude-code:m1')).toBeNull();
      hub.exec('PRAGMA user_version = 3');
      hub.close();

      hub = openDatabase(file, { adapters: [current] });
      expect(getEvent(hub, 'claude-code:m1')).toMatchObject({ kind: 'memory', rawLine: 1 });
      expect(getEntry(hub, importedEntryId('claude-code:m1'))).toMatchObject({
        text: 'Mirrored before.',
        author: 'claude-code@laptop',
        origin: 'laptop',
      });
    } finally {
      hub.close();
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
  });

  it.each([
    ['entry', importedEntryId('claude-code:m1')],
    ['event', 'claude-code:m1'],
  ])(
    'stays forgotten on a hub that received the forget of its %s before it could read the memory',
    async (_, target) => {
      const current: SourceAdapter = { ...adapter, id: 'claude-code' };
      const text = write({ id: 'm1', at: 1000, text: 'Forget me.' });
      await syncSource({ db, home }, current);
      const id = importedEntryId('claude-code:m1');
      const forgot = forget(db, target, { reason: 'wrong' });

      const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
      const file = path.join(hubHome, 'origin.db');
      let hub = openDatabase(file);
      try {
        setStoreName(hub, 'hub');
        appendRemote(
          { db: hub, home: hubHome },
          { ...current, parseLine: () => null },
          {
            device: 'laptop',
            source: 'claude-code',
            path: stream(),
            relPath: 'memory/demo.jsonl',
            generation: 1,
            offset: 0,
            data: Buffer.from(text),
          },
        );
        const tombstone = exportTombstone(db, forgot.tombstoneId as string);
        receiveTombstone(hub, tombstone as TombstoneRecord, { growthOrigin: 'hub' });
        hub.exec('PRAGMA user_version = 3');
        hub.close();

        hub = openDatabase(file, { adapters: [current] });
        expect(loadEntry(hub, id)?.status).toBe('forgotten');
        expect(getEvent(hub, 'claude-code:m1')).toBeNull();
      } finally {
        hub.close();
        fs.rmSync(hubHome, { recursive: true, force: true });
      }
    },
  );

  it("does not fix the store's name", async () => {
    const fresh = openDatabase(path.join(home, 'fresh.db'));
    try {
      setStoreName(fresh, 'old-name');
      write({ id: 'm1', at: 1000, text: 'A memory.' });
      await syncSource({ db: fresh, home }, adapter);
      expect(isStoreNameFixed(fresh)).toBe(false);
      expect(setStoreName(fresh, 'new-name')).toBe('new-name');
    } finally {
      fresh.close();
    }
  });
});
