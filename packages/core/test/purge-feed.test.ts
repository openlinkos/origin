import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  applyHubPurge,
  type Database,
  getEvent,
  getPurge,
  type HubPurge,
  initStoreName,
  listAudit,
  listPurges,
  OriginError,
  openDatabase,
  type PurgeFeedPage,
  parsePurgeFeedPage,
  pendingPurgeMirrors,
  purge,
  purgeFeed,
  searchEvents,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

/**
 * A hub's purges going down to its devices: the feed a hub serves each device (purgeFeed), and a
 * device applying one of them (applyHubPurge). On synthetic lines only.
 */

let tmp: string;
let logs: string;
let hubHome: string;
let devHome: string;
let hub: Database;
let dev: Database;

const A = () => path.join(logs, 'a.jsonl');
const C = () => path.join(logs, 'c.jsonl');
const LINES_A =
  line('e1', 's1', 1000, 'user', 'The key is zebracanary.') +
  line('e2', 's1', 2000, 'assistant', 'Noted.');
const LINES_C = line('e3', 's2', 3000, 'user', 'Kept words.');

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purge-feed-'));
  logs = path.join(tmp, 'logs');
  hubHome = path.join(tmp, 'hub');
  devHome = path.join(tmp, 'laptop');
  fs.mkdirSync(logs);
  fs.writeFileSync(A(), LINES_A);
  fs.writeFileSync(C(), LINES_C);
  hub = openDatabase(path.join(hubHome, 'origin.db'));
  initStoreName(hub, 'hub');
  dev = openDatabase(path.join(devHome, 'origin.db'));
  initStoreName(dev, 'laptop');
  // The device ingests its logs; the hub holds what it pushed, and a file of another device.
  await syncSource({ db: dev, home: devHome }, adapter());
  push('laptop', A(), 'a.jsonl', LINES_A);
  push('laptop', C(), 'c.jsonl', LINES_C);
  push('desk', '/desk/d.jsonl', 'd.jsonl', line('e4', 'd1', 4000, 'user', 'On the desk.'));
});

afterEach(() => {
  hub.close();
  dev.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const adapter = () => fakeAdapter(logs);

function push(device: string, file: string, relPath: string, data: string): void {
  appendRemote({ db: hub, home: hubHome }, adapter(), {
    device,
    source: 'fake',
    path: file,
    relPath,
    generation: 1,
    offset: 0,
    data: Buffer.from(data),
  });
}

const byOwner = { reason: 'pasted a secret', author: 'user@hub', channel: 'ui' as const };

/** Every page of one purge of the feed, from `after`, joined. */
function wholePurge(after: number, device: string, limit?: number): PurgeFeedPage {
  let page = purgeFeed(hub, { after, device, limit });
  const all = page;
  while (page.next.offset !== 0) {
    page = purgeFeed(hub, { after, offset: page.next.offset, device, limit });
    expect(page.purge?.id).toBe(all.purge?.id);
    for (const k of ['events', 'entries', 'sessions', 'recalls', 'files'] as const) {
      (all.items[k] as unknown[]).push(...page.items[k]);
    }
    all.next = page.next;
    all.more = page.more;
  }
  return all;
}

const asHubPurge = (page: PurgeFeedPage): HubPurge => {
  if (!page.purge) throw new Error('no purge');
  return { ...page.purge, items: page.items };
};

describe('the purge feed of a hub', () => {
  it('lists the purges a hub made, one at a time, with the files of the device that asks', () => {
    const first = purge(
      hub,
      hubHome,
      [adapter()],
      { kind: 'session', source: 'fake', sessionId: 's1' },
      byOwner,
    );
    const second = purge(hub, hubHome, [adapter()], { kind: 'event', ids: ['fake:e4'] }, byOwner);

    const page = purgeFeed(hub, { after: 0, device: 'laptop' });
    expect(page.purge).toMatchObject({
      id: first.id,
      origin: 'hub',
      author: 'user@hub',
      reason: 'pasted a secret',
      selector: { kind: 'session', source: 'fake', sessionId: 's1' },
    });
    expect(page.items).toEqual({
      events: ['fake:e1', 'fake:e2'],
      entries: [],
      sessions: [['fake', 's1']],
      recalls: [],
      // Blocked: the device's own path, as it knows it.
      files: [['fake', A()]],
    });
    expect(page.more).toBe(true);
    const seq = page.purge?.seq as number;
    expect(page.next).toEqual({ after: seq, offset: 0 });
    // Ids and counts, never the text.
    expect(JSON.stringify(page)).not.toContain('zebracanary');

    // Another device's files are not listed to this one.
    expect(purgeFeed(hub, { after: 0, device: 'desk' }).items.files).toEqual([]);

    const next = purgeFeed(hub, { after: seq, device: 'laptop' });
    expect(next.purge?.id).toBe(second.id);
    expect(next.items.events).toEqual(['fake:e4']);
    expect(next.items.files).toEqual([]);
    expect(next.more).toBe(false);
    const end = purgeFeed(hub, { after: next.next.after, device: 'laptop' });
    expect(end).toEqual({
      purge: null,
      items: { events: [], entries: [], sessions: [], recalls: [], files: [] },
      more: false,
      next: { after: next.next.after, offset: 0 },
    });
  });

  it('pages the ids of a large purge, and the pages join to the whole', () => {
    purge(hub, hubHome, [adapter()], { kind: 'session', source: 'fake', sessionId: 's1' }, byOwner);
    const one = purgeFeed(hub, { after: 0, device: 'laptop', limit: 1 });
    expect(one.more).toBe(true);
    expect(one.next).toEqual({ after: 0, offset: 1 });
    const joined = wholePurge(0, 'laptop', 1);
    const whole = purgeFeed(hub, { after: 0, device: 'laptop' });
    expect(joined.items).toEqual(whole.items);
    expect(joined.next).toEqual(whole.next);
    expect(joined.more).toBe(false);
  });

  it('leaves out the purges a store received from its hub', () => {
    purge(hub, hubHome, [adapter()], { kind: 'session', source: 'fake', sessionId: 's1' }, byOwner);
    applyHubPurge(
      dev,
      devHome,
      [adapter()],
      asHubPurge(purgeFeed(hub, { after: 0, device: 'laptop' })),
    );
    expect(listPurges(dev)).toHaveLength(1);
    expect(purgeFeed(dev, { after: 0, device: 'laptop' }).purge).toBeNull();
  });

  it('checks a page as the hub sent it', () => {
    purge(hub, hubHome, [adapter()], { kind: 'session', source: 'fake', sessionId: 's1' }, byOwner);
    const page = JSON.parse(JSON.stringify(purgeFeed(hub, { after: 0, device: 'laptop' })));
    expect(parsePurgeFeedPage(page)).toEqual(page);
    expect(
      parsePurgeFeedPage({ purge: null, items: {}, more: false, next: { after: 3, offset: 0 } }),
    ).toMatchObject({ purge: null, next: { after: 3, offset: 0 } });
    const bad = (change: (p: typeof page) => void) => {
      const copy = JSON.parse(JSON.stringify(page));
      change(copy);
      return () => parsePurgeFeedPage(copy);
    };
    expect(bad((p) => (p.purge.id = 'tmb_1'))).toThrow(OriginError);
    expect(bad((p) => (p.purge.origin = '../x'))).toThrow(/origin/);
    expect(bad((p) => (p.purge.reason = ''))).toThrow(/reason/);
    expect(bad((p) => (p.items.events = [1]))).toThrow(/events/);
    expect(bad((p) => (p.items.sessions = [['fake']]))).toThrow(/sessions/);
    expect(bad((p) => (p.next.after = -1))).toThrow(/next/);
    expect(() => parsePurgeFeedPage('nope')).toThrow(OriginError);
  });
});

describe('a hub purge on a device', () => {
  it('deletes here what the hub purged, as the hub made it, and keeps it out', async () => {
    const made = purge(
      hub,
      hubHome,
      [adapter()],
      { kind: 'session', source: 'fake', sessionId: 's1' },
      byOwner,
    );
    const page = purgeFeed(hub, { after: 0, device: 'laptop' });

    const r = applyHubPurge(dev, devHome, [adapter()], asHubPurge(page), { now: 9_000 });
    expect(r?.id).toBe(made.id);
    expect(getEvent(dev, 'fake:e1')).toBeNull();
    expect(getEvent(dev, 'fake:e2')).toBeNull();
    expect(getEvent(dev, 'fake:e3')).not.toBeNull();
    expect(searchEvents(dev, 'zebracanary')).toEqual([]);
    expect(getPurge(dev, made.id)).toMatchObject({
      id: made.id,
      at: page.purge?.at,
      origin: 'hub',
      author: 'user@hub',
      channel: 'hub',
      reason: 'pasted a secret',
      receivedAt: 9_000,
      counts: { events: 2, sessions: 1 },
    });
    expect(listAudit(dev, { limit: 5 }).find((a) => a.action === 'purge')).toMatchObject({
      target: made.id,
      channel: 'api',
      actor: 'user@hub',
    });
    // Its lines are blanked here too, at once.
    expect(pendingPurgeMirrors(dev)).toEqual([]);
    const rawA = (dev.prepare('SELECT id FROM raw_file WHERE path = ?').get(A()) as { id: number })
      .id;
    expect(mirrorText(dev, devHome, rawA)).toBe(LINES_A.replace(/[^\n]/g, ' '));

    // Applied once: again, nothing happens.
    expect(applyHubPurge(dev, devHome, [adapter()], asHubPurge(page))).toBeNull();
    expect(listPurges(dev)).toHaveLength(1);

    // The agent's log still holds the lines, and writes more to the session: nothing comes back.
    fs.appendFileSync(A(), line('e5', 's1', 5000, 'user', 'More of it.'));
    await syncSource({ db: dev, home: devHome }, adapter());
    expect(getEvent(dev, 'fake:e1')).toBeNull();
    expect(getEvent(dev, 'fake:e5')).toBeNull();
  });

  it('records a purge of what this device does not hold, and deletes nothing', () => {
    const made = purge(hub, hubHome, [adapter()], { kind: 'event', ids: ['fake:e4'] }, byOwner);
    const r = applyHubPurge(
      dev,
      devHome,
      [adapter()],
      asHubPurge(purgeFeed(hub, { after: 0, device: 'laptop' })),
    );
    expect(r?.id).toBe(made.id);
    expect(getPurge(dev, made.id)).toMatchObject({
      channel: 'hub',
      counts: { events: 0, lines: 0 },
    });
    for (const id of ['fake:e1', 'fake:e2', 'fake:e3']) expect(getEvent(dev, id)).not.toBeNull();
  });

  it('refuses a purge with an invalid id or reason', () => {
    purge(hub, hubHome, [adapter()], { kind: 'event', ids: ['fake:e1'] }, byOwner);
    const p = asHubPurge(purgeFeed(hub, { after: 0, device: 'laptop' }));
    expect(() => applyHubPurge(dev, devHome, [adapter()], { ...p, id: 'prg_x' })).toThrow(
      OriginError,
    );
    expect(() => applyHubPurge(dev, devHome, [adapter()], { ...p, reason: ' ' })).toThrow(
      OriginError,
    );
    expect(getEvent(dev, 'fake:e1')).not.toBeNull();
  });
});
