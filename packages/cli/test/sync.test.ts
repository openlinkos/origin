import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter, createGrokAdapter } from '@openlinkos/origin-adapters';
import {
  correct,
  createToken,
  type Database,
  entryHistory,
  exportTombstone,
  forget,
  getEntry,
  getEvent,
  getSetting,
  initStoreName,
  isEntryForgotten,
  listEntries,
  listEvents,
  localRawFiles,
  openDatabase,
  remember,
  setSetting,
  syncSource,
  tombstoneFeed,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubConfig } from '../src/hub/config.js';
import { createHubServer } from '../src/hub/server.js';
import { lastHubSync, pushedKey, syncFailedKey, syncWithHub } from '../src/hub/sync.js';

const fixtures = fileURLToPath(
  new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';

let tmp: string;
let hubDb: Database;
let deviceDb: Database;
let deviceHome: string;
let server: http.Server;
let hub: HubConfig;
/** The fixture's assistant messages, oldest first. */
let replies: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sync-'));
  const hubHome = path.join(tmp, 'hub');
  deviceHome = path.join(tmp, 'device');
  hubDb = openDatabase(path.join(hubHome, 'origin.db'));
  deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
  initStoreName(deviceDb, 'laptop');
  const token = createToken(hubDb, 'laptop');
  server = createHubServer({
    db: hubDb,
    home: hubHome,
    adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
    version: 'test',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    device: 'laptop',
  };
  await syncSource(
    { db: deviceDb, home: deviceHome },
    createClaudeCodeAdapter({ projectsDir: fixtures }),
  );
  replies = listEvents(deviceDb, { kinds: ['message'] })
    .filter((e) => e.role === 'assistant')
    .map((e) => e.id);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  hubDb.close();
  deviceDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sync = (fetchImpl?: typeof fetch) =>
  syncWithHub({ db: deviceDb, home: deviceHome, hub, fetch: fetchImpl });

const offline: typeof fetch = async () => {
  throw new Error('connect ECONNREFUSED');
};

const note = (db: Database, eventId: string, text: string, now?: number) =>
  remember(
    db,
    {
      kind: 'knowledge',
      text,
      confidence: 0.8,
      author: 'claude-code@laptop',
      sources: [{ eventId }],
    },
    now,
  );

const changeCount = (db: Database) =>
  (db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n;

describe('device to hub replication', () => {
  it('uploads what was written offline once the hub is back, once', async () => {
    const a = note(deviceDb, USER_EVENT, 'The user checks the repository status first.');
    const b = correct(deviceDb, a.id, {
      text: 'Checks the repository status.',
      author: 'user@laptop',
    });
    const k = note(deviceDb, replies[0]!, 'A note the user regrets.');
    const t = forget(deviceDb, k.id, 'not needed');

    await expect(sync(offline)).rejects.toThrow(/Cannot reach the hub/);
    expect(getSetting(deviceDb, pushedKey(hub))).toBeNull();

    const first = await sync();
    expect(first).toMatchObject({
      files: 1,
      entriesPushed: 2, // the forgotten entry never leaves the device
      tombstonesPushed: 1,
      waiting: null,
      tombstonesApplied: 0,
    });
    expect(getEntry(hubDb, b.id)).toMatchObject({
      status: 'active',
      author: 'user@laptop',
      origin: 'laptop',
      supersedes: a.id,
    });
    expect(getEntry(hubDb, a.id)).toMatchObject({ status: 'superseded', supersededBy: b.id });
    expect(getEntry(hubDb, k.id)).toBeNull();
    // The device's tombstone reached the hub under its own id and hid the same event there.
    expect(exportTombstone(hubDb, t.tombstoneId!)).toMatchObject({
      origin: 'laptop',
      reason: 'not needed',
      events: [replies[0]],
    });
    expect(getEvent(hubDb, replies[0]!)).toBeNull();

    // Nothing comes back, and running again sends nothing.
    const hubChanges = changeCount(hubDb);
    const deviceChanges = changeCount(deviceDb);
    expect(await sync()).toMatchObject({
      files: 0,
      bytes: 0,
      entriesPushed: 0,
      tombstonesPushed: 0,
      tombstonesApplied: 0,
    });
    expect(changeCount(hubDb)).toBe(hubChanges);
    expect(changeCount(deviceDb)).toBe(deviceChanges);
    expect(
      listEntries(hubDb, { includeSuperseded: true })
        .map((e) => e.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('carries forgetting both ways without echoes', async () => {
    const a = note(deviceDb, USER_EVENT, 'Asked for the repository status.');
    await sync();

    // Forgotten on the hub: the device's copy goes on its next sync.
    const onHub = forget(hubDb, a.id, 'wrong');
    expect(await sync()).toMatchObject({ tombstonesApplied: 1, tombstonesPushed: 0 });
    expect(isEntryForgotten(deviceDb, a.id)).toBe(true);
    expect(getEvent(deviceDb, USER_EVENT)).toBeNull();
    expect(exportTombstone(deviceDb, onHub.tombstoneId!)).toMatchObject({ origin: 'hub' });
    // The device does not send the hub's tombstone back.
    expect(await sync()).toMatchObject({ tombstonesApplied: 0, tombstonesPushed: 0 });

    // Forgotten on the device: the hub's copy goes, and the hub does not send it back.
    const b = note(deviceDb, replies[1]!, 'The working tree was clean.');
    await sync();
    expect(getEntry(hubDb, b.id)?.status).toBe('active');
    const onDevice = forget(deviceDb, b.id);
    expect(await sync()).toMatchObject({ tombstonesPushed: 1, tombstonesApplied: 0 });
    expect(isEntryForgotten(hubDb, b.id)).toBe(true);
    expect(getEvent(hubDb, replies[1]!)).toBeNull();
    expect(
      tombstoneFeed(hubDb, { after: 0, device: 'laptop' }).tombstones.map((t) => t.id),
    ).toEqual([onHub.tombstoneId]);
    expect(tombstoneFeed(hubDb, { after: 0, device: 'desk' }).tombstones.map((t) => t.id)).toEqual([
      onHub.tombstoneId,
      onDevice.tombstoneId,
    ]);
  });

  it('resolves concurrent corrections on the hub by (created_at, id)', async () => {
    const a = note(deviceDb, USER_EVENT, 'v1', 1_000);
    await sync();
    const onHub = correct(hubDb, a.id, { text: 'hub version', author: 'user@hub' }, 2_000);
    const onDevice = correct(
      deviceDb,
      a.id,
      { text: 'device version', author: 'user@laptop' },
      3_000,
    );
    await sync();

    expect(getEntry(hubDb, onDevice.id)).toMatchObject({ status: 'active' });
    expect(getEntry(hubDb, onHub.id)).toMatchObject({
      status: 'superseded',
      concurrent: true,
      supersededBy: onDevice.id,
    });
    expect(entryHistory(hubDb, a.id).map((e) => e.id)).toEqual([a.id, onHub.id, onDevice.id]);
    expect(listEntries(hubDb).map((e) => e.id)).toEqual([onDevice.id]);

    // A later correction on the hub wins over the device's.
    const later = correct(hubDb, onDevice.id, { text: 'hub again', author: 'user@hub' }, 4_000);
    expect(listEntries(hubDb).map((e) => e.id)).toEqual([later.id]);
  });

  it('forgets a correction that joins a forgotten chain, and an entry citing a forgotten event', async () => {
    const a = note(deviceDb, USER_EVENT, 'v1');
    await sync();
    const gone = forget(hubDb, a.id);
    // Before hearing of it, the device corrects the entry and cites one more event.
    const d = correct(deviceDb, a.id, {
      text: 'v2',
      author: 'user@laptop',
      sources: [{ eventId: replies[0]! }],
    });
    // And cites an event that the hub forgets meanwhile.
    const x = note(deviceDb, replies[1]!, 'The tree was clean.');
    forget(hubDb, replies[1]!);

    const r = await sync();
    expect(r.entriesPushed).toBe(2);
    expect(isEntryForgotten(hubDb, d.id)).toBe(true);
    expect(getEvent(hubDb, replies[0]!)).toBeNull(); // rule 1 for the new version
    expect(isEntryForgotten(hubDb, x.id)).toBe(true); // rule 2 on arrival
    // The hub's tombstones grew; the device applied them in the same sync.
    expect(exportTombstone(hubDb, gone.tombstoneId!)?.entries.sort()).toEqual([a.id, d.id].sort());
    for (const id of [a.id, d.id, x.id]) expect(isEntryForgotten(deviceDb, id)).toBe(true);
    for (const id of [USER_EVENT, replies[0]!, replies[1]!])
      expect(getEvent(deviceDb, id)).toBeNull();
    expect(await sync()).toMatchObject({
      tombstonesApplied: 0,
      tombstonesPushed: 0,
      entriesPushed: 0,
    });
  });

  it('leaves the provenance of entries the hub already has to the hub', async () => {
    const a = note(deviceDb, replies[0]!, 'v1', 1_000);
    await sync();
    // The hub's newer version cites one more event.
    correct(
      hubDb,
      a.id,
      { text: 'hub', author: 'user@hub', sources: [{ eventId: USER_EVENT }] },
      2_000,
    );
    // Then another entry citing the same event is forgotten on the hub (rule 1 excludes it).
    const other = note(hubDb, replies[0]!, 'other', 3_000);
    forget(hubDb, other.id);
    await sync();
    // On the hub the current version keeps a visible source, so the entry stays, and the device
    // does not decide otherwise from its partial view.
    expect(getEntry(hubDb, a.id)?.status).toBe('superseded');
    expect(isEntryForgotten(deviceDb, a.id)).toBe(false);
    expect(getEvent(deviceDb, replies[0]!)).toBeNull();
  });

  it('holds back an entry until what it cites reaches the hub, without holding back forgetting', async () => {
    // A first sync whose mirror push is skipped: the hub has no events yet.
    const noMirrors: typeof fetch = async (input, init) => {
      if (!String(input).includes('/v1/cursors')) return fetch(input, init);
      const cursors = localRawFiles(deviceDb).map((f) => ({
        source: f.source,
        path: f.path,
        generation: f.generation,
        bytes: f.bytes,
      }));
      return new Response(JSON.stringify({ cursors }));
    };
    const a = note(deviceDb, USER_EVENT, 'v1');
    const t = forget(deviceDb, replies[1]!);
    const r = await sync(noMirrors);
    expect(r).toMatchObject({ files: 0, entriesPushed: 0, tombstonesPushed: 1 });
    expect(r.waiting).toEqual({ id: a.id, missing: [USER_EVENT] });
    expect(getEntry(hubDb, a.id)).toBeNull();
    expect(exportTombstone(hubDb, t.tombstoneId!)).not.toBeNull();

    const next = await sync();
    expect(next).toMatchObject({ files: 1, entriesPushed: 1, waiting: null });
    expect(getEntry(hubDb, a.id)?.status).toBe('active');
    expect(await sync()).toMatchObject({ entriesPushed: 0, tombstonesPushed: 0 });
  });

  it('validates what devices send', async () => {
    const a = note(deviceDb, USER_EVENT, 'v1');
    await sync();
    const post = (path: string, body: unknown) =>
      fetch(`${hub.url}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const entry = {
      id: 'ent_0123456789ab',
      kind: 'memory',
      text: 'x',
      confidence: 0.5,
      author: 'x@laptop',
      project: null,
      supersedes: null,
      validFrom: null,
      validTo: null,
      createdAt: 1,
      origin: 'laptop',
      sources: [{ eventId: USER_EVENT, quote: null }],
    };
    const bad = [
      { ...entry, id: 'nope' },
      { ...entry, kind: 'opinion' },
      { ...entry, text: '  ' },
      { ...entry, confidence: 2 },
      { ...entry, author: '' },
      { ...entry, supersedes: 'ent_0123456789ab' },
      { ...entry, validFrom: 5, validTo: 1 },
      { ...entry, createdAt: 'yesterday' },
      { ...entry, sources: [] },
      { ...entry, sources: [{ eventId: USER_EVENT }, { eventId: USER_EVENT }] },
    ];
    for (const e of bad) {
      expect((await post('/v1/entries', { device: 'laptop', entries: [e] })).status).toBe(400);
    }
    // The token of laptop sends only what laptop wrote, and only as laptop.
    const foreign = await post('/v1/entries', {
      device: 'laptop',
      entries: [{ ...entry, origin: 'desk' }],
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: expect.stringMatching(/written by desk/) });
    expect((await post('/v1/entries', { device: 'desk', entries: [] })).status).toBe(403);
    expect((await post('/v1/entries', { device: 'hub', entries: [entry] })).status).toBe(403);
    expect((await post('/v1/entries', { device: 'laptop', entries: 'x' })).status).toBe(400);

    const missing = { ...entry, sources: [{ eventId: 'claude-code:nope', quote: null }] };
    const pending = await post('/v1/entries', { device: 'laptop', entries: [missing] });
    expect(await pending.json()).toEqual({
      applied: 0,
      pending: { id: entry.id, missing: ['claude-code:nope'] },
    });

    expect(
      await (await post('/v1/entries', { device: 'laptop', entries: [entry] })).json(),
    ).toEqual({ applied: 1, pending: null });
    // The same body again is fine; a different body under the same id is a conflict.
    expect((await post('/v1/entries', { device: 'laptop', entries: [entry] })).status).toBe(200);
    const changed = await post('/v1/entries', {
      device: 'laptop',
      entries: [{ ...entry, text: 'y' }],
    });
    expect(changed.status).toBe(409);
    // A correction must be dated after the version it corrects.
    const early = { ...entry, id: 'ent_0123456789ac', supersedes: a.id, createdAt: 0 };
    expect((await post('/v1/entries', { device: 'laptop', entries: [early] })).status).toBe(400);

    const tombstone = {
      id: 'tmb_0123456789ab',
      target: USER_EVENT,
      reason: null,
      createdAt: 1,
      origin: 'laptop',
      entries: [],
      events: [USER_EVENT],
    };
    expect(
      (
        await post('/v1/tombstones', {
          device: 'laptop',
          tombstones: [{ ...tombstone, origin: 'desk' }],
        })
      ).status,
    ).toBe(403);
    expect(
      (await post('/v1/tombstones', { device: 'laptop', tombstones: [{ ...tombstone, id: 'x' }] }))
        .status,
    ).toBe(400);
    expect(
      (await post('/v1/tombstones', { device: 'laptop', tombstones: [tombstone] })).status,
    ).toBe(200);
    expect(
      (
        await post('/v1/tombstones', {
          device: 'laptop',
          tombstones: [{ ...tombstone, reason: 'z' }],
        })
      ).status,
    ).toBe(409);
    expect(getEvent(hubDb, USER_EVENT)).toBeNull();
    expect(isEntryForgotten(hubDb, a.id)).toBe(true);
  });
});

describe('the last sync', () => {
  it('records when a sync finished, and why a later one failed, until one succeeds', async () => {
    expect(lastHubSync(deviceDb, hub)).toEqual({ at: null, failure: null });
    await expect(sync(offline)).rejects.toThrow(/ECONNREFUSED/);
    const failed = lastHubSync(deviceDb, hub);
    expect(failed.at).toBeNull();
    expect(failed.failure?.error).toMatch(/Cannot reach the hub at .*ECONNREFUSED/);

    const before = Date.now();
    await sync();
    const ok = lastHubSync(deviceDb, hub);
    expect(ok.at).toBeGreaterThanOrEqual(before);
    expect(ok.failure).toBeNull();

    // A failure after it is shown; it still says when the last sync finished.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(sync(offline)).rejects.toThrow();
    expect(lastHubSync(deviceDb, hub)).toMatchObject({
      at: ok.at,
      failure: { error: /ECONNREFUSED/ },
    });
    // Kept per hub: another hub has its own.
    expect(lastHubSync(deviceDb, { ...hub, url: 'http://127.0.0.1:1' })).toEqual({
      at: null,
      failure: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sync();
    expect(lastHubSync(deviceDb, hub).failure).toBeNull();
    // An unreadable record is as good as none.
    setSetting(deviceDb, syncFailedKey(hub), '{not json');
    expect(lastHubSync(deviceDb, hub).failure).toBeNull();
  });
});

describe('agent versions', () => {
  it('sends the version the device recorded, for sources whose lines carry none', async () => {
    // Grok Build lines carry no version: the device records the one installed when it ingested
    // them, and the hub, which has no Grok of its own, must record the same.
    const grokHome = path.join(tmp, 'grok');
    fs.cpSync(
      fileURLToPath(new URL('../../adapters/test/fixtures/grok/', import.meta.url)),
      grokHome,
      {
        recursive: true,
      },
    );
    await syncSource({ db: deviceDb, home: deviceHome }, createGrokAdapter({ home: grokHome }));
    const grokHub = createHubServer({
      db: hubDb,
      home: path.join(tmp, 'hub'),
      adapters: [
        createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') }),
        createGrokAdapter({ home: path.join(tmp, 'no-grok-here') }),
      ],
      version: 'test',
    });
    await new Promise<void>((resolve) => grokHub.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(grokHub.address() as AddressInfo).port}`;
      await syncWithHub({ db: deviceDb, home: deviceHome, hub: { ...hub, url } });
      const versions = (db: Database) => [
        ...new Set(listEvents(db, { source: 'grok' }).map((e) => e.agentVersion)),
      ];
      expect(versions(deviceDb)).toEqual(['1.0.41']);
      expect(versions(hubDb)).toEqual(['1.0.41']);
    } finally {
      await new Promise((resolve) => grokHub.close(resolve));
    }
  });
});

describe('concurrent pushes', () => {
  it('goes on while another process pushes the same file, from where the hub stands', async () => {
    // A long session: several chunks. Another process (say, an agent's origin mcp) pushes each
    // chunk first, so every request of this sync meets a hub that has already moved on.
    const projects = path.join(tmp, 'long');
    const session = '33333333-3333-4333-8333-333333333333';
    fs.mkdirSync(path.join(projects, 'D--long'), { recursive: true });
    const lines = Array.from({ length: 6000 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        sessionId: session,
        timestamp: new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString(),
        cwd: '/home/dev/long',
        message: { role: 'user', content: `line ${i} ${'x'.repeat(1000)}` },
      }),
    );
    fs.writeFileSync(path.join(projects, 'D--long', `${session}.jsonl`), `${lines.join('\n')}\n`);
    await syncSource(
      { db: deviceDb, home: deviceHome },
      createClaudeCodeAdapter({ projectsDir: projects }),
    );

    let raced = 0;
    const racing: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith('/v1/ingest') || res.status !== 200 || raced >= 5) return res;
      // The hub took these bytes; answer as if the other process had sent them just before.
      raced++;
      const { bytes } = (await res.json()) as { bytes: number };
      return new Response(JSON.stringify({ bytes }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    };
    await sync(racing);
    expect(raced).toBe(5);
    expect(listEvents(hubDb, { sessionId: session, limit: 10_000 })).toHaveLength(6000);
  });
});
