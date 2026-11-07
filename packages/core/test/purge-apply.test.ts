import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  ConflictError,
  changesSince,
  type Database,
  forget,
  getEntry,
  getEvent,
  getPurge,
  getSession,
  ingestPlacesFile,
  initStoreName,
  insertRecall,
  listAudit,
  listPurges,
  OriginError,
  openDatabase,
  ownRecalls,
  type PurgeSelector,
  planPurge,
  purge,
  type RecallRecord,
  rebuildAuthorship,
  rebuildProposals,
  remember,
  reparsePlaces,
  restore,
  searchEntries,
  searchEvents,
  syncSource,
  tombstoneFeed,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

/**
 * Applying a purge: one write transaction that deletes what the plan names, records the purge,
 * and queues the mirrors whose lines are to be blanked. The mirrors themselves are not rewritten
 * here (see purge-mirrors.test.ts).
 */

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purge-apply-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'laptop');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const adapter = () => fakeAdapter(logs);
const sync = () => syncSource({ db, home }, adapter());
const write = (file: string, text: string) => fs.appendFileSync(path.join(logs, file), text);
const by = { reason: 'pasted a secret', author: 'user@laptop', channel: 'cli' as const };
const run = (selector: PurgeSelector, opts: Partial<typeof by> & { digest?: string } = {}) =>
  purge(db, home, [adapter()], selector, { ...by, ...opts });
const count = (sql: string, ...params: unknown[]) =>
  (db.prepare(sql).get(...(params as never[])) as { n: number }).n;
const why = { reason: 'asked by the owner', author: 'user@laptop' };
const recall = (id: string, over: Partial<RecallRecord> = {}): RecallRecord => ({
  id,
  at: 5000,
  origin: 'laptop',
  source: 'fake',
  sessionId: 's1',
  occasion: 'start',
  project: 'demo',
  cwd: null,
  promptHash: null,
  budget: 100,
  tokens: 10,
  items: [],
  ...over,
});

describe('a purge', () => {
  it('deletes the event and its search rows, and records itself with ids and counts only', async () => {
    write(
      'a.jsonl',
      line('1', 's1', 1000, 'user', 'kept words') + line('2', 's1', 2000, 'user', 'zebracanary'),
    );
    await sync();
    expect(searchEvents(db, 'zebracanary')).toHaveLength(1);
    const r = run({ kind: 'event', ids: ['fake:2'] }, { now: 9000 });
    expect(r.id).toMatch(/^prg_[0-9a-f]{12}$/);
    expect(getEvent(db, 'fake:2')).toBeNull();
    expect(getEvent(db, 'fake:1')).not.toBeNull();
    expect(searchEvents(db, 'zebracanary')).toEqual([]);
    expect(getSession(db, 'fake', 's1')?.eventCount).toBe(1);
    expect(r.record).toMatchObject({
      id: r.id,
      at: 9000,
      origin: 'laptop',
      author: 'user@laptop',
      channel: 'cli',
      reason: 'pasted a secret',
      selector: { kind: 'event', ids: ['fake:2'] },
      counts: { events: 1, mirrors: 1, lines: 1 },
      seqFloor: 2,
      receivedAt: null,
    });
    expect(r.pending).toBe(1);
    expect(listPurges(db)).toEqual([r.record]);
    const detail = getPurge(db, r.id);
    expect(detail?.removed.events).toEqual(['fake:2']);
    expect(detail?.mirrors).toEqual([
      expect.objectContaining({ lines: [[2, 1]], pending: true, error: null }),
    ]);
    expect(getPurge(db, 'prg_000000000000')).toBeNull();
    const audit = listAudit(db, { limit: 5 }).find((a) => a.action === 'purge');
    expect(audit).toMatchObject({ target: r.id, channel: 'cli', actor: 'user@laptop' });
    expect(JSON.stringify(audit)).not.toContain('zebracanary');
    // The guards are back.
    expect(count('SELECT COUNT(*) AS n FROM guard_lift')).toBe(0);
    expect(() => db.prepare("DELETE FROM event WHERE id = 'fake:1'").run()).toThrow(/append-only/);
  });

  it('needs a reason and an author, and something to delete', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one'));
    await sync();
    expect(() => run({ kind: 'event', ids: ['fake:1'] }, { reason: ' ' })).toThrow(/reason/);
    expect(() => run({ kind: 'event', ids: ['fake:1'] }, { author: '' })).toThrow(/author/);
    run({ kind: 'event', ids: ['fake:1'] });
    expect(() => run({ kind: 'event', ids: ['fake:1'] })).toThrow(OriginError);
  });

  it('deletes nothing and lifts no guard when it fails', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one'));
    await sync();
    db.exec(
      "CREATE TEMP TRIGGER purge_fails BEFORE INSERT ON purge BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => run({ kind: 'event', ids: ['fake:1'] })).toThrow(/boom/);
    db.exec('DROP TRIGGER purge_fails');
    expect(getEvent(db, 'fake:1')).not.toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM guard_lift')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM purge')).toBe(0);
    expect(() => db.prepare("DELETE FROM event WHERE id = 'fake:1'").run()).toThrow(/append-only/);
  });
});

describe('a plan applied later', () => {
  it('is refused if the store would now delete something else, and applied as it is otherwise', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one') + line('2', 's1', 2000, 'user', 'two'));
    await sync();
    const selector: PurgeSelector = { kind: 'event', ids: ['fake:2'] };
    const plan = planPurge(db, home, [adapter()], selector);
    // The agent writes the same line again before the purge is applied.
    write('a.jsonl', line('2', 's1', 2000, 'user', 'two'));
    await sync();
    expect(() => purge(db, home, [adapter()], selector, { ...by, plan })).toThrow(ConflictError);
    expect(() => run(selector, { digest: plan.digest })).toThrow(ConflictError);
    expect(getEvent(db, 'fake:2')).not.toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM guard_lift')).toBe(0);

    const again = planPurge(db, home, [adapter()], selector);
    const r = purge(db, home, [adapter()], selector, { ...by, plan: again });
    expect(r.plan.digest).toBe(again.digest);
    expect(getPurge(db, r.id)?.mirrors[0]?.lines).toEqual([[2, 2]]);
  });
});

describe('event numbers', () => {
  it('are never given out again, so that a reader after the purge sees what comes next', async () => {
    write(
      'a.jsonl',
      line('1', 's1', Date.now() - 3000, 'user', 'one') +
        line('2', 's1', Date.now() - 2000, 'user', 'two') +
        line('3', 's1', Date.now() - 1000, 'user', 'three'),
    );
    await sync();
    const before = changesSince(db, { after: { event: 0, change: 0 } }).next;
    expect(before.event).toBe(3);
    run({ kind: 'event', ids: ['fake:2', 'fake:3'] });
    // The cursor does not go back.
    expect(changesSince(db, { after: before }).next.event).toBe(3);
    expect(changesSince(db).next.event).toBe(3);
    write('a.jsonl', line('4', 's1', Date.now(), 'user', 'four'));
    await sync();
    const after = changesSince(db, { after: before });
    expect(after.events.map((e) => e.id)).toEqual(['fake:4']);
    expect(after.next.event).toBe(4);
  });

  it('of recalls are not given out again either', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one'));
    await sync();
    insertRecall(db, recall('rcl_000000000001', { sessionId: null, source: null }));
    insertRecall(db, recall('rcl_000000000002', { sessionId: null, source: null }));
    const sent = ownRecalls(db, 0).at(-1)?.seq as number;
    run({ kind: 'recall', id: 'rcl_000000000002' });
    insertRecall(db, recall('rcl_000000000003', { sessionId: null, source: null }));
    expect(ownRecalls(db, sent).map((r) => r.recall.id)).toEqual(['rcl_000000000003']);
  });
});

describe('a forget whose items a purge deleted', () => {
  it('stays, covering less, and a restore of it brings nothing back', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one') + line('2', 's1', 2000, 'user', 'two'));
    await sync();
    const f = forget(db, 'fake:2', why);
    const feed = tombstoneFeed(db, { after: 0, device: 'phone' });
    const r = run({ kind: 'forgotten', tombstone: f.tombstoneId as string });
    expect(r.record.touched.tombstones).toEqual([f.tombstoneId]);
    expect(count('SELECT COUNT(*) AS n FROM tombstone WHERE id = ?', f.tombstoneId)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM tombstone_effect')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM excluded_event')).toBe(0);
    // The feed lists the same forgets, not logged again: each with what it covers here now.
    const later = tombstoneFeed(db, { after: 0, device: 'phone' });
    expect(later.next).toBe(feed.next);
    expect(later.tombstones.map((t) => t.id)).toEqual(feed.tombstones.map((t) => t.id));
    expect(feed.tombstones[0]?.events).toEqual(['fake:2']);
    expect(later.tombstones[0]?.events).toEqual([]);
    restore(db, f.tombstoneId as string, { reason: 'it was fine', author: 'user@laptop' });
    expect(count("SELECT COUNT(*) AS n FROM event WHERE id = 'fake:2'")).toBe(0);
  });
});

describe('a purged event, entry, or session', () => {
  it('does not come back when its file is written again', async () => {
    const file = path.join(logs, 'a.jsonl');
    fs.writeFileSync(
      file,
      line('1', 's1', 1000, 'user', 'one') + line('2', 's1', 2000, 'user', 'two'),
    );
    await sync();
    run({ kind: 'event', ids: ['fake:2'] });
    fs.writeFileSync(
      file,
      line('0', 's1', 500, 'user', 'a rewrite, from scratch') +
        line('2', 's1', 2000, 'user', 'two'),
    );
    await sync();
    expect(count("SELECT COUNT(*) AS n FROM event WHERE id = 'fake:2'")).toBe(0);
    expect(getEvent(db, 'fake:0')).not.toBeNull();
    // Nor when the mirrors, not yet blanked, are parsed again.
    rebuildAuthorship(db, { home, adapters: [adapter()] });
    reparsePlaces(db, home, () => {});
    rebuildProposals(db);
    expect(count("SELECT COUNT(*) AS n FROM event WHERE id = 'fake:2'")).toBe(0);
  });

  it('takes the entries that cite it, every version, out of search and the change feed', async () => {
    write('a.jsonl', line('1', 's1', Date.now(), 'user', 'one'));
    await sync();
    const e = remember(db, {
      kind: 'knowledge',
      text: 'the quokkacanary note',
      confidence: 1,
      author: 'claude-code@laptop',
      sources: [{ eventId: 'fake:1' }],
    });
    expect(searchEntries(db, 'quokkacanary')).toHaveLength(1);
    const r = run({ kind: 'event', ids: ['fake:1'] });
    expect(r.record.counts).toMatchObject({ events: 1, entries: 1, chains: 1 });
    expect(getEntry(db, e.id)).toBeNull();
    expect(searchEntries(db, 'quokkacanary')).toEqual([]);
    expect(changesSince(db, { after: { event: 0, change: 0 } }).entries).toEqual([]);
    expect(getPurge(db, r.id)?.removed.entries).toEqual([e.id]);
  });

  it('takes a session whole: its rows, recalls, places, and the items that name it', async () => {
    write('s1.jsonl', line('1', 's1', 1000, 'user', 'parent'));
    write(
      'kid.jsonl',
      `${JSON.stringify({ id: 'k1', session: 'kid', ts: 1500, role: 'assistant', text: 'child', parents: [{ session: 'kid', parent: 's1' }] })}\n`,
    );
    write('s2.jsonl', line('2', 's2', 1200, 'user', 'other'));
    await sync();
    await ingestPlacesFile({ db, home }, 'fake', {
      absPath: 'places.jsonl',
      relPath: 'places.jsonl',
      generated: {
        token: 't1',
        mtimeMs: 1,
        next: (last) =>
          last
            ? []
            : [
                '{"v":1,"type":"place","session":"s1","project":"demo","root":null,"signal":"git"}',
                '{"v":1,"type":"place","session":"s2","project":"demo","root":null,"signal":"git"}',
              ],
      },
    });
    insertRecall(db, recall('rcl_00000000000a'));
    insertRecall(
      db,
      recall('rcl_00000000000b', {
        sessionId: 's2',
        items: [
          {
            rank: 1,
            layer: 'sessions',
            kind: 'session',
            ref: 'fake:s1',
            score: null,
            tokens: 5,
            excerpt: null,
          },
          {
            rank: 2,
            layer: 'sessions',
            kind: 'session',
            ref: 'fake:s2',
            score: null,
            tokens: 5,
            excerpt: null,
          },
        ],
      }),
    );
    const r = run({ kind: 'session', source: 'fake', sessionId: 's1' });
    expect(r.record.counts).toMatchObject({ sessions: 2, events: 2, recalls: 1, recallItems: 1 });
    expect(r.record.touched.recalls).toEqual(['rcl_00000000000b']);
    for (const table of ['session', 'session_place', 'session_parent', 'session_thread']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id IN ('s1', 'kid')`)).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM session_place WHERE session_id = 's2'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM recall WHERE id = 'rcl_00000000000a'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM recall_item WHERE ref = 'fake:s1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM recall_item WHERE ref = 'fake:s2'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM place_head WHERE line LIKE \'%"s1"%\'')).toBe(0);
    const detail = getPurge(db, r.id);
    expect(detail?.removed.sessions).toEqual([
      { source: 'fake', sessionId: 'kid' },
      { source: 'fake', sessionId: 's1' },
    ]);
    // Events of a purged session are not listed one by one on a device.
    expect(detail?.removed.events).toEqual([]);
    expect(detail?.removed.files.map((f) => path.basename(f.path)).sort()).toEqual([
      'kid.jsonl',
      's1.jsonl',
    ]);
    expect(detail?.removed.recalls).toEqual(['rcl_00000000000a']);
    // Later lines of its files arrive blank.
    write('s1.jsonl', line('3', 's1', 3000, 'user', 'later'));
    await sync();
    expect(count("SELECT COUNT(*) AS n FROM event WHERE session_id = 's1'")).toBe(0);
  });

  it('lists the events of a session a device sent, on a hub, so that entries citing them find them purged', () => {
    appendRemote({ db, home }, adapter(), {
      device: 'phone',
      source: 'fake',
      path: '/p/a.jsonl',
      relPath: 'a.jsonl',
      generation: 1,
      offset: 0,
      data: Buffer.from(
        line('1', 's1', 1000, 'user', 'one') + line('2', 's1', 2000, 'user', 'two'),
      ),
    });
    const r = run({ kind: 'session', source: 'fake', sessionId: 's1' });
    expect(getPurge(db, r.id)?.removed).toMatchObject({
      events: ['fake:1', 'fake:2'],
      sessions: [{ source: 'fake', sessionId: 's1' }],
      files: [{ source: 'fake', path: '@phone:/p/a.jsonl' }],
    });
  });

  it('leaves a session the title its other lines give when the line of its title goes', async () => {
    write(
      'a.jsonl',
      `${line('1', 's1', 1000, 'user', 'one')}${JSON.stringify({ session: 's1', title: 'First title' })}\n${JSON.stringify({ session: 's1', title: 'Secret title' })}\n`,
    );
    await sync();
    expect(getSession(db, 'fake', 's1')?.title).toBe('Secret title');
    const file = (db.prepare('SELECT id FROM raw_file').get() as { id: number }).id;
    run({ kind: 'lines', source: 'fake', file, lines: { first: 3, last: 3 } });
    expect(getSession(db, 'fake', 's1')?.title).toBe('First title');
  });
});
