import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTombstone,
  correct,
  type Database,
  entryHistory,
  exportEntry,
  exportTombstone,
  forget,
  getEntry,
  getEvent,
  getSession,
  getTombstone,
  hiddenContent,
  initStoreName,
  listEntries,
  listTombstones,
  makeRelay,
  OriginError,
  openDatabase,
  planForget,
  planRestore,
  rebuildSearchIndexes,
  receiveEntry,
  receiveTombstone,
  remember,
  restore,
  searchEntries,
  searchEvents,
  syncSource,
  type TombstoneRecord,
  tombstoneFeed,
  unpushedOnly,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let dirs: string[];
const stores: Database[] = [];
let src: string;

const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** The same session on every store: four messages, e1 to e4. */
function writeSession(): void {
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('e1', 's1', 1000, 'user', 'We keep the store in SQLite.') +
      line('e2', 's1', 2000, 'assistant', 'SQLite with trigram search.') +
      line('e3', 's1', 3000, 'user', 'Every device keeps a whole store.') +
      line('e4', 's1', 4000, 'user', 'The hub is always online.'),
  );
}

async function store(name: string): Promise<Database> {
  const home = tmp(`origin-${name}-`);
  const db = openDatabase(path.join(home, 'origin.db'));
  stores.push(db);
  initStoreName(db, name);
  await syncSource({ db, home }, fakeAdapter(src));
  return db;
}

beforeEach(() => {
  dirs = [];
  src = tmp('origin-src-');
  writeSession();
});

afterEach(() => {
  for (const db of stores.splice(0)) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const note = (db: Database, events: string[], text: string, now = 10_000) =>
  remember(
    db,
    {
      kind: 'knowledge',
      text,
      confidence: 1,
      author: 'claude-code@laptop',
      sources: events.map((eventId) => ({ eventId })),
    },
    now,
  );

const why = (reason = 'asked by the owner', author = 'user@laptop') => ({ reason, author });

/** What is hidden on a store, and the session's visible event count: compared across stores. */
function hiddenState(db: Database) {
  const ids = (sql: string) =>
    (db.prepare(sql).all() as unknown as Array<{ id: string }>).map((r) => r.id);
  return {
    entries: ids('SELECT entry_id AS id FROM forgotten_entry ORDER BY entry_id'),
    events: ids('SELECT event_id AS id FROM excluded_event ORDER BY event_id'),
    eventCount: getSession(db, 'fake', 's1')?.eventCount ?? 0,
  };
}

describe('forgetting is a record', () => {
  it('needs a reason, and keeps it with the author', async () => {
    const db = await store('laptop');
    for (const reason of ['', '   ']) {
      expect(() => forget(db, 'fake:e1', { reason })).toThrow(/reason is required/);
    }
    expect(() => forget(db, 'fake:e1', { reason: 'x'.repeat(2001) })).toThrow(/too long/);
    expect(getEvent(db, 'fake:e1')).not.toBeNull();

    const f = forget(db, 'fake:e1', why(' pasted a secret '), 5000);
    expect(getTombstone(db, f.tombstoneId!)).toMatchObject({
      kind: 'forget',
      target: 'fake:e1',
      reason: 'pasted a secret',
      author: 'user@laptop',
      origin: 'laptop',
      inEffect: true,
      restoredBy: [],
      events: 1,
    });
    expect(exportTombstone(db, f.tombstoneId!)).toMatchObject({ author: 'user@laptop' });
    expect(() => restore(db, f.tombstoneId!, { reason: ' ' })).toThrow(/reason is required/);
  });
});

describe('restore', () => {
  it('brings back an entry and the events it cites, in every query, sessions included', async () => {
    const db = await store('laptop');
    const a = note(db, ['fake:e1', 'fake:e2'], 'Chose SQLite for the store.');
    const f = forget(db, a.id, why());
    expect(getEntry(db, a.id)).toBeNull();
    expect(searchEvents(db, 'sqlite').map((h) => h.id)).toEqual([]);
    expect(getSession(db, 'fake', 's1')?.eventCount).toBe(2);

    expect(planRestore(db, f.tombstoneId!)).toEqual({
      target: f.tombstoneId,
      entries: [a.id],
      events: ['fake:e1', 'fake:e2'],
    });
    // A plan writes nothing.
    expect(getEntry(db, a.id)).toBeNull();

    const r = restore(db, f.tombstoneId!, why('forgot the wrong one'), 9000);
    expect(r).toMatchObject({ target: f.tombstoneId, entries: [a.id] });
    expect(r.events.sort()).toEqual(['fake:e1', 'fake:e2']);
    expect(getEntry(db, a.id)).toMatchObject({ status: 'active' });
    expect(listEntries(db).map((e) => e.id)).toEqual([a.id]);
    expect(searchEntries(db, 'SQLite').map((e) => e.id)).toEqual([a.id]);
    expect(
      searchEvents(db, 'sqlite')
        .map((h) => h.id)
        .sort(),
    ).toEqual(['fake:e1', 'fake:e2']);
    expect(getSession(db, 'fake', 's1')?.eventCount).toBe(4);
    // The search indexes were never touched: rebuilding them gives the same answer.
    rebuildSearchIndexes(db);
    expect(
      searchEvents(db, 'sqlite')
        .map((h) => h.id)
        .sort(),
    ).toEqual(['fake:e1', 'fake:e2']);
    // Restored events can be cited again.
    expect(note(db, ['fake:e1'], 'Cites e1 again.').id).toMatch(/^ent_/);

    // Both records stay, newest first; the forget says what restored it.
    expect(listTombstones(db)).toMatchObject([
      { id: r.tombstoneId, kind: 'restore', target: f.tombstoneId, reason: 'forgot the wrong one' },
      { id: f.tombstoneId, kind: 'forget', inEffect: false, restoredBy: [r.tombstoneId] },
    ]);
    const log = db.prepare("SELECT id FROM change_log WHERE kind = 'tombstone' ORDER BY seq").all();
    expect(log).toEqual([{ id: f.tombstoneId }, { id: r.tombstoneId }]);
    expect(exportTombstone(db, r.tombstoneId)).toMatchObject({ entries: [], events: [] });
  });

  it('refuses what cannot be restored, and forgetting again makes a new record', async () => {
    const db = await store('laptop');
    const f = forget(db, 'fake:e1', why());
    expect(() => restore(db, 'tmb_000000000000', why())).toThrow(/Unknown forget/);
    const r = restore(db, f.tombstoneId!, why());
    expect(() => restore(db, f.tombstoneId!, why())).toThrow(/already been restored/);
    expect(() => restore(db, r.tombstoneId, why())).toThrow(/only a forget can be restored/);
    expect(() => planRestore(db, r.tombstoneId)).toThrow(OriginError);
    // A tombstone id is not something to forget: restoring is how a forget is undone.
    expect(() => forget(db, f.tombstoneId!, why())).toThrow(/Unknown entry or event/);

    const again = forget(db, 'fake:e1', why('it was right after all'));
    expect(again.tombstoneId).not.toBe(f.tombstoneId);
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(listTombstones(db).map((t) => [t.kind, t.inEffect])).toEqual([
      ['forget', true],
      ['restore', false],
      ['forget', false],
    ]);
    restore(db, again.tombstoneId!, why());
    expect(getEvent(db, 'fake:e1')).not.toBeNull();
  });

  it('keeps what another forget in effect still covers', async () => {
    const db = await store('laptop');
    const a = note(db, ['fake:e1', 'fake:e2'], 'a');
    const b = note(db, ['fake:e2', 'fake:e3'], 'b');
    const fa = forget(db, a.id, why());
    const fb = forget(db, b.id, why());
    // b's forget hid only what was left; it still covers e2.
    expect(fb.events).toEqual(['fake:e3']);

    const r = restore(db, fa.tombstoneId!, why());
    expect(r.entries).toEqual([a.id]);
    expect(r.events).toEqual(['fake:e1']);
    expect(getEvent(db, 'fake:e2')).toBeNull();
    expect(getEntry(db, b.id)).toBeNull();
    // a is back, but one of its sources is still hidden.
    expect(getEntry(db, a.id)?.status).toBe('active');

    restore(db, fb.tombstoneId!, why());
    expect(hiddenState(db)).toEqual({ entries: [], events: [], eventCount: 4 });
  });

  it('decides rule 3 again: as if the restored forget had never been made', async () => {
    const db = await store('laptop');
    const x = note(db, ['fake:e1'], 'x');
    const y = note(db, ['fake:e2'], 'y');
    const z = note(db, ['fake:e1', 'fake:e2'], 'z');
    const fx = forget(db, x.id, why());
    expect(getEntry(db, z.id)).not.toBeNull();
    const fy = forget(db, y.id, why());
    // z has lost every source (rule 3).
    expect(fy.entries.sort()).toEqual([y.id, z.id].sort());

    // Without x's forget, z keeps e1: it comes back, although y's forget hid it.
    const r = restore(db, fx.tombstoneId!, why());
    expect(r.entries.sort()).toEqual([x.id, z.id].sort());
    expect(getEntry(db, z.id)?.status).toBe('active');
    expect(getEntry(db, y.id)).toBeNull();

    // Forgetting x again takes z with it again, under the new forget; without y's forget, z keeps
    // e2 and comes back.
    const again = forget(db, x.id, why());
    expect(again.entries.sort()).toEqual([x.id, z.id].sort());
    restore(db, fy.tombstoneId!, why());
    expect(getEntry(db, y.id)).not.toBeNull();
    expect(getEntry(db, z.id)?.status).toBe('active');
    expect(getEntry(db, x.id)).toBeNull();
  });

  it('keeps an entry that would have no visible source hidden, under the forgets that hide them', async () => {
    const db = await store('laptop');
    const z = note(db, ['fake:e1', 'fake:e2'], 'z');
    const x = note(db, ['fake:e1', 'fake:e3'], 'x');
    const y = note(db, ['fake:e2', 'fake:e4'], 'y');
    const fz = forget(db, z.id, why());
    // x and y keep e3 and e4.
    expect(fz.entries).toEqual([z.id]);
    const fx = forget(db, x.id, why());
    forget(db, y.id, why());

    // z's own forget goes, but both of its sources are still hidden by x's and y's.
    const r = restore(db, fz.tombstoneId!, why());
    expect(r).toMatchObject({ entries: [], events: [] });
    expect(getEntry(db, z.id)).toBeNull();
    expect(
      hiddenContent(db, fx.tombstoneId!)
        .entries.map((e) => e.id)
        .sort(),
    ).toEqual([x.id, z.id].sort());

    // Once x's forget goes too, e1 is back, and so is z.
    restore(db, fx.tombstoneId!, why());
    expect(getEntry(db, z.id)?.status).toBe('active');
    expect(getEvent(db, 'fake:e2')).toBeNull();
  });

  it('brings back a whole chain, forks and current version included', async () => {
    const db = await store('laptop');
    const a = note(db, ['fake:e1'], 'v1', 10_000);
    const b = correct(
      db,
      a.id,
      { text: 'v2', author: 'user@laptop', sources: [{ eventId: 'fake:e3' }] },
      20_000,
    );
    const f = forget(db, a.id, why());
    expect(f.entries.sort()).toEqual([a.id, b.id].sort());
    restore(db, f.tombstoneId!, why());
    expect(getEntry(db, b.id)?.status).toBe('active');
    expect(getEntry(db, a.id)).toMatchObject({ status: 'superseded', supersededBy: b.id });
    expect(entryHistory(db, b.id).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('shows the owner what a forget in effect hides, and nothing once it is restored', async () => {
    const db = await store('laptop');
    const a = note(db, ['fake:e2'], 'Pasted <secret> here.');
    const f = forget(db, a.id, why());
    const content = hiddenContent(db, f.tombstoneId!);
    expect(content.entries.map((e) => [e.id, e.text, e.status])).toEqual([
      [a.id, 'Pasted <secret> here.', 'forgotten'],
    ]);
    expect(content.events.map((e) => [e.id, e.text])).toEqual([
      ['fake:e2', 'SQLite with trigram search.'],
    ]);
    expect(content).toMatchObject({ entryCount: 1, eventCount: 1 });
    expect(hiddenContent(db, f.tombstoneId!, { limit: 0 })).toMatchObject({
      entries: [],
      entryCount: 1,
    });
    restore(db, f.tombstoneId!, why());
    expect(hiddenContent(db, f.tombstoneId!)).toEqual({
      entries: [],
      events: [],
      entryCount: 0,
      eventCount: 0,
    });
  });
});

describe('restores across stores', () => {
  const record = (db: Database, id: string) => exportTombstone(db, id) as TombstoneRecord;

  // Every order of four records, each applied twice: slow on Windows CI.
  it('converge whatever order forgets and restores arrive in, applied twice or not', {
    timeout: 60_000,
  }, async () => {
    const origin = await store('laptop');
    const a = note(origin, ['fake:e1', 'fake:e2'], 'a');
    const b = note(origin, ['fake:e2', 'fake:e3'], 'b');
    const z = note(origin, ['fake:e3', 'fake:e4'], 'z');
    const fa = forget(origin, a.id, why());
    const fb = forget(origin, b.id, why());
    const f4 = forget(origin, 'fake:e4', why());
    const ra = restore(origin, fa.tombstoneId!, why());
    const records = [fa.tombstoneId!, fb.tombstoneId!, f4.tombstoneId!, ra.tombstoneId].map((id) =>
      record(origin, id),
    );
    const expected = hiddenState(origin);
    expect(expected.entries.sort()).toEqual([b.id, z.id].sort());

    // Four records in every order, on hubs that hold the same entries.
    const orders: number[][] = [];
    const permute = (rest: number[], done: number[]) => {
      if (rest.length === 0) orders.push(done);
      for (const i of rest) {
        permute(
          rest.filter((j) => j !== i),
          [...done, i],
        );
      }
    };
    permute([0, 1, 2, 3], []);
    expect(orders).toHaveLength(24);
    for (const [n, order] of orders.entries()) {
      const hub = await store(`hub${n}`);
      for (const e of [a, b, z])
        receiveEntry(hub, exportEntry(origin, e.id)!, { growthOrigin: 'h' });
      for (const i of order) receiveTombstone(hub, records[i]!, { growthOrigin: 'h' });
      expect(hiddenState(hub), `order ${order.join(',')}`).toEqual(expected);
      for (const i of order) receiveTombstone(hub, records[i]!, { growthOrigin: 'h' });
      expect(hiddenState(hub)).toEqual(expected);
      hub.close();
      stores.splice(stores.indexOf(hub), 1);
    }
  });

  it('reach a device from its hub, and a hub from its device', async () => {
    const hub = await store('hub');
    const device = await store('laptop');
    const pushedThrough = Number.MAX_SAFE_INTEGER;
    const judge = unpushedOnly(device, pushedThrough);
    // The device wrote x, y, z; the hub has them.
    const x = note(device, ['fake:e1'], 'x');
    const y = note(device, ['fake:e2'], 'y');
    const z = note(device, ['fake:e1', 'fake:e2'], 'z');
    for (const e of [x, y, z])
      receiveEntry(hub, exportEntry(device, e.id)!, { growthOrigin: 'hub' });
    const pull = (after: number) => {
      const feed = tombstoneFeed(hub, { after, device: 'laptop' });
      for (const t of feed.tombstones) applyTombstone(device, t, { judge });
      return feed.next;
    };

    // Forgotten on the hub; z loses both sources there, and the device takes the hub's word.
    const fx = forget(hub, x.id, why('wrong', 'user@hub'));
    forget(hub, y.id, why('wrong', 'user@hub'));
    let cursor = pull(0);
    expect(hiddenState(device)).toEqual(hiddenState(hub));
    expect(getEntry(device, z.id)).toBeNull();

    // Restored on the hub: the hub logs the forget whose coverage changed, so the device follows.
    restore(hub, fx.tombstoneId!, why('needed', 'user@hub'), Date.now(), { growthOrigin: 'hub' });
    expect(getEntry(hub, z.id)).not.toBeNull();
    cursor = pull(cursor);
    expect(hiddenState(device)).toEqual(hiddenState(hub));
    expect(getEntry(device, z.id)?.status).toBe('active');
    expect(getEntry(device, x.id)?.status).toBe('active');

    // Restored on the device: the hub applies the device's restore when it is pushed.
    const fy = listTombstones(device).find((t) => t.kind === 'forget' && t.inEffect)!;
    const ry = restore(device, fy.id, why());
    expect(getEntry(device, y.id)).not.toBeNull();
    receiveTombstone(hub, record(device, ry.tombstoneId), { growthOrigin: 'hub' });
    expect(getEntry(hub, y.id)).not.toBeNull();
    pull(cursor);
    expect(hiddenState(device)).toEqual(hiddenState(hub));
    expect(hiddenState(hub)).toEqual({ entries: [], events: [], eventCount: 4 });
  });

  it('wait for their forget on a hub, and are sent again after it', async () => {
    const origin = await store('laptop');
    const f = forget(origin, 'fake:e1', why());
    const r = restore(origin, f.tombstoneId!, why());
    const hub = await store('hub');
    // The restore arrives first: kept, pending.
    receiveTombstone(hub, record(origin, r.tombstoneId), { growthOrigin: 'hub' });
    expect(getTombstone(hub, r.tombstoneId)).toMatchObject({ kind: 'restore' });
    receiveTombstone(hub, record(origin, f.tombstoneId!), { growthOrigin: 'hub' });
    expect(getEvent(hub, 'fake:e1')).not.toBeNull();
    expect(getTombstone(hub, f.tombstoneId!)).toMatchObject({ inEffect: false });

    // A device keeps only restores of forgets it holds; the feed sends the restore again after the
    // forget, so the device ends up where the hub is, page by page or all at once.
    expect(tombstoneFeed(hub, { after: 0, device: 'desk' }).tombstones.map((t) => t.id)).toEqual([
      f.tombstoneId,
      r.tombstoneId,
    ]);
    const device = await store('desk');
    const seen: string[] = [];
    for (let after = 0, more = true; more; ) {
      const page = tombstoneFeed(hub, { after, device: 'desk', limit: 1 });
      for (const t of page.tombstones) {
        seen.push(t.id);
        applyTombstone(device, t);
        if (seen.length === 1) expect(getTombstone(device, r.tombstoneId)).toBeNull();
        if (seen.length === 2) expect(getEvent(device, 'fake:e1')).toBeNull();
      }
      after = page.next;
      more = page.more;
    }
    expect(seen).toEqual([r.tombstoneId, f.tombstoneId, r.tombstoneId]);
    expect(getEvent(device, 'fake:e1')).not.toBeNull();
    expect(hiddenState(device)).toEqual(hiddenState(hub));
  });

  it('keep what a remote list covers while its forget is in effect', async () => {
    const device = await store('laptop');
    // The hub forgot an entry the device never had, which cited e1 and e2, and listed them.
    const remote = {
      id: 'tmb_00000000000a',
      target: 'ent_0000000000aa',
      reason: 'from the hub',
      createdAt: 1000,
      origin: 'hub',
      entries: ['ent_0000000000aa'],
      events: ['fake:e1', 'fake:e2'],
    };
    applyTombstone(device, remote);
    const local = forget(device, 'fake:e2', why());
    expect(local.tombstoneId).toBeNull(); // nothing left to hide: e2 is hidden already
    const f3 = forget(device, 'fake:e3', why());
    restore(device, f3.tombstoneId!, why());
    expect(getEvent(device, 'fake:e2')).toBeNull();

    // The hub's forget is restored elsewhere; its restore reaches the device.
    applyTombstone(device, {
      id: 'tmb_00000000000b',
      target: remote.id,
      reason: 'restored on the hub',
      createdAt: 2000,
      origin: 'hub',
      entries: [],
      events: [],
    });
    expect(hiddenState(device)).toEqual({ entries: [], events: [], eventCount: 4 });
  });

  it('are refused when malformed, and keep nothing on a relay', async () => {
    const { parseTombstoneRecord } = await import('../src/index.js');
    const good = {
      id: 'tmb_0123456789ab',
      target: 'tmb_0123456789ac',
      reason: 'r',
      createdAt: 1,
      origin: 'laptop',
      author: 'user@laptop',
      entries: [],
      events: [],
    };
    expect(parseTombstoneRecord(good)).toEqual(good);
    for (const bad of [
      { ...good, target: 'tmb_nothex' },
      { ...good, target: good.id },
      { ...good, events: ['fake:e1'] },
      { ...good, reason: '  ' },
      { ...good, author: 3 },
    ]) {
      expect(() => parseTombstoneRecord(bad)).toThrow(OriginError);
    }

    const relay = openDatabase(path.join(tmp('origin-relay-'), 'origin.db'));
    stores.push(relay);
    makeRelay(relay);
    expect(applyTombstone(relay, { ...good, target: 'fake:e1' }, { keep: true })).toMatchObject({
      entries: 0,
      events: 0,
    });
    expect(relay.prepare('SELECT COUNT(*) AS n FROM tombstone').get()).toEqual({ n: 0 });
  });
});

describe('entries a restore brings back', () => {
  it('are logged again, so that a device sends them to its hub', async () => {
    const db = await store('laptop');
    const a = note(db, ['fake:e1'], 'a');
    const f = forget(db, a.id, why());
    const seq = (db.prepare('SELECT MAX(seq) AS s FROM change_log').get() as { s: number }).s;
    // Pushed past it: a was skipped, being forgotten, so the hub never had it.
    expect(unpushedOnly(db, seq)(a.id)).toBe(false);
    restore(db, f.tombstoneId!, why());
    const relogged = db
      .prepare("SELECT id, origin FROM change_log WHERE kind = 'entry' AND seq > ?")
      .all(seq);
    expect(relogged).toEqual([{ id: a.id, origin: 'laptop' }]);
    expect(unpushedOnly(db, seq)(a.id)).toBe(true);
  });
});

describe('stores written before restores existed', () => {
  it('get their forgets recorded when opened, overlaps included', async () => {
    const home = tmp('origin-old-');
    let db = openDatabase(path.join(home, 'origin.db'));
    initStoreName(db, 'laptop');
    await syncSource({ db, home }, fakeAdapter(src));
    const a = note(db, ['fake:e1', 'fake:e2'], 'a');
    const b = note(db, ['fake:e2', 'fake:e3'], 'b');
    const fa = forget(db, a.id, why());
    const fb = forget(db, b.id, why());
    // As Origin 0.1 left it: each item attributed to the first forget only, and nothing else.
    db.exec('DELETE FROM tombstone_effect; DELETE FROM tombstone_meta;');
    db.close();

    db = openDatabase(path.join(home, 'origin.db'));
    stores.push(db);
    expect(getTombstone(db, fb.tombstoneId!)).toMatchObject({
      author: null,
      entries: 1,
      events: 2,
    });
    restore(db, fa.tombstoneId!, why());
    // b's forget still covers e2, which the old store attributed to a's.
    expect(getEvent(db, 'fake:e2')).toBeNull();
    expect(getEvent(db, 'fake:e1')).not.toBeNull();
    expect(planForget(db, b.id)).toMatchObject({ entries: [], events: [] });
  });
});
