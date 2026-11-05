import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  type Database,
  defaultAuthor,
  getEvent,
  getSetting,
  listEvents,
  openDatabase,
  PULL_TOMBSTONES_AGAIN,
  rebuildAuthorship,
  receiveTombstone,
  type SourceAdapter,
  STORE_VERSION,
  syncSource,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';
import { downgradeToV6, downgradeToV7, schemaOf, userVersion } from './legacy.js';

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-authors-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const jsonl = (...lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');
const write = (name: string, ...lines: object[]) =>
  fs.appendFileSync(path.join(logs, name), jsonl(...lines));

/** Who wrote each event, as reads see it: author, signal, speaker. */
function authors(store: Database = db): Record<string, unknown> {
  return Object.fromEntries(
    listEvents(store, { limit: 1000 }).map((e) => [
      e.id,
      e.author === null ? null : [e.author, e.authorSignal, e.speaker],
    ]),
  );
}

/** What is stored of authorship, by event id. */
function stored(store: Database = db): unknown {
  return {
    authors: store
      .prepare(
        `SELECT e.id, a.author, a.speaker, a.signal FROM event_author a JOIN event e ON e.seq = a.seq
          ORDER BY e.id`,
      )
      .all(),
    kinds: store.prepare('SELECT * FROM session_kind ORDER BY source, session_id, kind').all(),
  };
}

/** A session of a few kinds of input, and one of its source's sub-agents. */
function writeSessions(): void {
  write(
    'a.jsonl',
    { id: 'p1', session: 's1', ts: 1000, role: 'user', text: 'Deploy the staging cluster.' },
    { id: 'r1', session: 's1', ts: 1100, role: 'assistant', text: 'Deployed.' },
    {
      id: 'c1',
      session: 's1',
      ts: 1200,
      role: 'user',
      text: '<command-name>/clear</command-name>',
    },
    { id: 'm1', session: 's1', ts: 1300, role: 'user', kind: 'meta', text: 'Reminder.' },
    { id: 't1', session: 's1', ts: 1400, role: 'user', kind: 'tool_result', text: 'ok' },
    {
      id: 'q1',
      session: 's1',
      ts: 1500,
      role: 'user',
      text: 'What did Bob say?',
      author: 'person',
      signal: 'from',
      speaker: '  Bob  ',
    },
    {
      id: 'n1',
      session: 's1',
      ts: 1600,
      role: 'user',
      text: 'A background task finished.',
      author: 'system',
      signal: 'origin.kind',
    },
    {
      id: 'x1',
      session: 's1',
      ts: 1700,
      role: 'user',
      text: 'Who knows.',
      author: 'person',
      speaker: 'x'.repeat(201),
    },
  );
}

describe('who wrote each input', () => {
  it('is kept with the input as ingestion stores it: what the line says, or by kind and text', async () => {
    writeSessions();
    await syncSource({ db, home }, fakeAdapter(logs));
    expect(authors()).toEqual({
      'fake:p1': ['owner', 'text', null],
      'fake:r1': null,
      'fake:c1': ['system', 'text', null],
      'fake:m1': ['system', 'kind', null],
      'fake:t1': null,
      'fake:q1': ['person', 'from', 'Bob'],
      'fake:n1': ['system', 'origin.kind', null],
      // A speaker longer than 200 characters is no name.
      'fake:x1': ['person', 'fake', null],
    });
    // Only input has a row; events are untouched.
    expect((stored() as { authors: unknown[] }).authors).toHaveLength(6);
    expect(getEvent(db, 'fake:p1')).toMatchObject({
      kind: 'message',
      text: 'Deploy the staging cluster.',
    });
  });

  it("makes every input of a child or headless session the agent's or the system's, whichever line says so first", async () => {
    // The parent's line names its sub-agent; the sub-agent's own prompt says it is the owner's.
    const child = { id: 'k1', session: 'kid', ts: 2000, role: 'user', text: 'Explore the repo.' };
    const spawn = { kinds: [{ session: 'kid', kind: 'child', signal: 'spawned' }] };
    const run = { kinds: [{ session: 'run', kind: 'headless', signal: 'entry' }] };
    const headless = { id: 'h1', session: 'run', ts: 3000, role: 'user', text: 'Summarize.' };
    for (const order of [
      [child, spawn, headless, run],
      [spawn, child, run, headless],
    ]) {
      const dir = fs.mkdtempSync(path.join(tmp, 'order-'));
      const store = openDatabase(path.join(dir, 'origin.db'));
      const adapter = fakeAdapter(dir);
      for (const [i, l] of order.entries()) {
        fs.writeFileSync(path.join(dir, `${i}.jsonl`), jsonl(l));
        await syncSource({ db: store, home: dir }, adapter);
      }
      expect(authors(store)).toEqual({
        'fake:k1': ['agent', 'spawned', null],
        'fake:h1': ['system', 'entry', null],
      });
      store.close();
    }
  });

  it('is read by kind and text for input stored without it, by a process of an earlier version', async () => {
    writeSessions();
    write('a.jsonl', {
      id: 'sc1',
      session: 's1',
      ts: 1800,
      role: 'user',
      text: 'Look at the tests.',
    });
    await syncSource({ db, home }, fakeAdapter(logs));
    db.exec('DELETE FROM event_author');
    const read = authors();
    for (const e of listEvents(db, { limit: 1000 })) {
      if (e.author === null) continue;
      const d = defaultAuthor(e);
      expect(read[e.id]).toEqual([d.author, d.signal, null]);
    }
    expect(read['fake:q1']).toEqual(['owner', 'text', null]);
    // A Claude Code sidechain's message, stored without its author, is the agent's.
    db.prepare(`UPDATE event SET meta = '{"sidechain":true}' WHERE id = 'fake:sc1'`).run();
    expect(getEvent(db, 'fake:sc1')).toMatchObject({ author: 'agent', authorSignal: 'sidechain' });
    expect(defaultAuthor({ kind: 'message', text: 'x', meta: { sidechain: true } })).toEqual({
      author: 'agent',
      signal: 'sidechain',
    });
  });

  it('is derived again from the raw mirrors, the same as ingestion derived it', async () => {
    writeSessions();
    write('b.jsonl', { kinds: [{ session: 's1', kind: 'child', signal: 'spawned' }] });
    await syncSource({ db, home }, fakeAdapter(logs));
    const before = stored();
    const read = authors();
    expect(read['fake:p1']).toEqual(['agent', 'spawned', null]);
    rebuildAuthorship(db, { home, adapters: [fakeAdapter(logs)] });
    expect(stored()).toEqual(before);
    expect(authors()).toEqual(read);
  });
});

describe('a store of an earlier version', () => {
  /** Ingest the logs as an earlier version did, whose adapter skipped some lines (`learnt`). */
  async function makeEarlier(store: Database, storeHome: string, adapter: SourceAdapter) {
    await syncSource({ db: store, home: storeHome }, adapter);
  }

  for (const [from, downgrade] of [
    [7, downgradeToV7],
    [6, downgradeToV6],
  ] as const) {
    it(`gets who wrote each input, and the events of lines it skipped, from its mirrors (${from} to 8)`, async () => {
      writeSessions();
      write(
        'a.jsonl',
        { id: 'l1', session: 's1', ts: 1900, role: 'user', text: 'typed while busy', learnt: true },
        { kinds: [{ session: 'kid', kind: 'child', signal: 'spawned' }] },
      );
      write('k.jsonl', { id: 'k1', session: 'kid', ts: 2000, role: 'user', text: 'Explore.' });
      // A new store, with the adapter as it is now.
      const fresh = openDatabase(path.join(tmp, 'fresh', 'origin.db'));
      await syncSource(
        { db: fresh, home: path.join(tmp, 'fresh') },
        fakeAdapter(logs, 'fake', { learnt: true }),
      );

      // The same logs in a store of the earlier version, whose adapter skipped the learnt line.
      await makeEarlier(db, home, fakeAdapter(logs));
      expect(getEvent(db, 'fake:l1')).toBeNull();
      db.close();
      downgrade(path.join(home, 'origin.db'));
      const old = new DatabaseSync(path.join(home, 'origin.db'));
      expect(userVersion(old)).toBe(from);
      old.close();

      const logged: string[] = [];
      db = openDatabase(path.join(home, 'origin.db'), {
        adapters: [fakeAdapter(logs, 'fake', { learnt: true })],
        log: (m) => logged.push(m),
      });
      expect(userVersion(db)).toBe(STORE_VERSION);
      expect(STORE_VERSION).toBe(10);
      expect(logged.join('\n')).toMatch(/Upgrading the store to version 8/);
      if (from === 6) expect(logged.join('\n')).toMatch(/Upgrading the store to version 7/);
      expect(authors()).toEqual(authors(fresh));
      expect(stored()).toEqual(stored(fresh));
      expect(getEvent(db, 'fake:l1')).toMatchObject({ author: 'owner', text: 'typed while busy' });
      expect(db.prepare("SELECT event_count FROM session WHERE session_id = 's1'").get()).toEqual(
        fresh.prepare("SELECT event_count FROM session WHERE session_id = 's1'").get(),
      );
      expect(schemaOf(db)).toEqual(schemaOf(fresh));
      fresh.close();
    });
  }

  it('is upgraded on a hub from the mirrors its devices pushed', async () => {
    const content = jsonl(
      { id: 'p1', session: 's1', ts: 1000, role: 'user', text: 'Deploy it.' },
      {
        id: 'q1',
        session: 's1',
        ts: 1100,
        role: 'user',
        text: 'Hi',
        author: 'person',
        speaker: 'Ann',
      },
      { id: 'l1', session: 's1', ts: 1200, role: 'user', text: 'queued one', learnt: true },
      { kinds: [{ session: 's2', kind: 'headless', signal: 'entry' }] },
      { id: 'h1', session: 's2', ts: 1300, role: 'user', text: 'Run the job.' },
    );
    const push = (store: Database, storeHome: string, adapter: SourceAdapter) =>
      appendRemote({ db: store, home: storeHome }, adapter, {
        device: 'laptop',
        source: 'fake',
        path: '/home/me/.fake/s1.jsonl',
        relPath: 's1.jsonl',
        generation: 1,
        offset: 0,
        data: Buffer.from(content),
      });
    const freshHome = path.join(tmp, 'fresh-hub');
    const fresh = openDatabase(path.join(freshHome, 'origin.db'));
    push(fresh, freshHome, fakeAdapter(logs, 'fake', { learnt: true }));
    push(db, home, fakeAdapter(logs));
    db.close();
    downgradeToV7(path.join(home, 'origin.db'));
    db = openDatabase(path.join(home, 'origin.db'), {
      adapters: [fakeAdapter(logs, 'fake', { learnt: true })],
    });
    expect(stored()).toEqual(stored(fresh));
    expect(authors()).toEqual({
      'fake:p1': ['owner', 'text', null],
      'fake:q1': ['person', 'fake', 'Ann'],
      'fake:l1': ['owner', 'text', null],
      'fake:h1': ['system', 'entry', null],
    });
    // A device that read the new event first, and pulls the hub's forgets again.
    expect(getSetting(db, PULL_TOMBSTONES_AGAIN)).not.toBeNull();
    fresh.close();
  });

  it('hides an event it now reads that a forget it kept already targets (invariant 2)', async () => {
    const content = jsonl(
      { id: 'p1', session: 's1', ts: 1000, role: 'user', text: 'Deploy it.' },
      { id: 'l1', session: 's1', ts: 1200, role: 'user', text: 'my token', learnt: true },
    );
    appendRemote({ db, home }, fakeAdapter(logs), {
      device: 'laptop',
      source: 'fake',
      path: '/home/me/.fake/s1.jsonl',
      relPath: 's1.jsonl',
      generation: 1,
      offset: 0,
      data: Buffer.from(content),
    });
    // The device, upgraded first, read the event and forgot it; this hub kept the forget, which
    // covered nothing here.
    receiveTombstone(
      db,
      {
        id: 'tmb_00000000000000000000000000000001',
        target: 'fake:l1',
        reason: 'a secret',
        createdAt: 5000,
        origin: 'laptop',
        entries: [],
        events: ['fake:l1'],
      },
      { growthOrigin: 'hub' },
    );
    db.close();
    downgradeToV7(path.join(home, 'origin.db'));
    db = openDatabase(path.join(home, 'origin.db'), {
      adapters: [fakeAdapter(logs, 'fake', { learnt: true })],
    });
    expect(getEvent(db, 'fake:l1')).toBeNull();
    expect(db.prepare("SELECT 1 FROM event WHERE id = 'fake:l1'").get()).toBeDefined();
    expect(listEvents(db).map((e) => e.id)).toEqual(['fake:p1']);
  });

  it('stays at version 7 when the upgrade fails half-way, and is upgraded on the next open', async () => {
    writeSessions();
    await makeEarlier(db, home, fakeAdapter(logs));
    // A built-in source, parsed after the first: its adapter is required.
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(
      path.join(other, 'c.jsonl'),
      jsonl({ id: 'o1', session: 'o', ts: 1000, role: 'user', text: 'Hello there.' }),
    );
    await makeEarlier(db, home, fakeAdapter(other, 'claude-code'));
    db.close();
    downgradeToV7(path.join(home, 'origin.db'));
    expect(() =>
      openDatabase(path.join(home, 'origin.db'), { adapters: [fakeAdapter(logs)] }),
    ).toThrow(/version 8 .*needs the claude-code adapter/);
    const raw = new DatabaseSync(path.join(home, 'origin.db'));
    expect(userVersion(raw)).toBe(7);
    expect(
      raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_author'").get(),
    ).toBeUndefined();
    raw.close();
    db = openDatabase(path.join(home, 'origin.db'), {
      adapters: [fakeAdapter(logs), fakeAdapter(other, 'claude-code')],
    });
    expect(userVersion(db)).toBe(STORE_VERSION);
    expect(authors()['fake:q1']).toEqual(['person', 'from', 'Bob']);
    expect(authors()['claude-code:o1']).toEqual(['owner', 'text', null]);
  });

  it('keeps the default author for a source of its own it has no adapter for', async () => {
    writeSessions();
    await makeEarlier(db, home, fakeAdapter(logs));
    db.close();
    downgradeToV7(path.join(home, 'origin.db'));
    const logged: string[] = [];
    db = openDatabase(path.join(home, 'origin.db'), { log: (m) => logged.push(m) });
    expect(logged.join('\n')).toMatch(/No adapter for fake/);
    expect(authors()['fake:q1']).toEqual(['owner', 'text', null]);
  });
});
