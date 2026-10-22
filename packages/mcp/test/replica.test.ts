import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  correct,
  type Database,
  exportEntry,
  getEntry,
  getEvent,
  initStoreName,
  openDatabase,
  receiveEntry,
  remember,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { createOriginServer, createReplicaServer, type ReplicaOptions } from '../src/index.js';
import { refreshGate } from '../src/tools.js';
import { parse, startTestHub, type TestHub, TOKEN, type ToolCallResult } from './hub-fixture.js';

let dirs: string[];
let hub: TestHub;
let home: string;
let db: Database;
let agent: Client;
let syncs: number;
let replica: ReturnType<typeof createReplicaServer>;

const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** The session both stores have (the device pushed it), as the test hub holds it. */
const SHARED =
  line('e1', 's1', 1000, 'user', 'Keep the hub behind TLS and give every device its own token.') +
  line('e2', 's1', 2000, 'assistant', 'Done: one token per device, revocable.');

beforeEach(async () => {
  dirs = [];
  hub = await startTestHub();
  // A session from another device, on the hub only.
  const other = tmp('origin-other-');
  fs.writeFileSync(
    path.join(other, 'h.jsonl'),
    line('h1', 'sh', 5000, 'user', 'Keep commit messages short, says the other device.'),
  );
  await syncSource({ db: hub.db, home: hub.home }, fakeAdapter(other));
  // The device: the shared session, and one not pushed yet.
  home = tmp('origin-device-');
  const src = tmp('origin-src-');
  fs.writeFileSync(path.join(src, 's1.jsonl'), SHARED);
  fs.writeFileSync(
    path.join(src, 'd.jsonl'),
    line('d1', 'sd', 3000, 'user', 'Keep the device store local and fast.'),
  );
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'laptop');
  await syncSource({ db, home }, fakeAdapter(src));
});

afterEach(async () => {
  await agent?.close();
  await replica?.close();
  await hub.stop();
  db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(over: Partial<ReplicaOptions> = {}): Promise<void> {
  syncs = 0;
  replica = createReplicaServer({
    db,
    home,
    device: 'laptop',
    hub: { url: hub.url, token: TOKEN },
    sync: async () => {
      syncs++;
    },
    syncIntervalMs: 60_000,
    hubTimeoutMs: 2000,
    ...over,
  });
  agent = new Client({ name: 'agent-x', version: '1.0.0' });
  const [agentSide, replicaSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([agent.connect(agentSide), replica.mcp.connect(replicaSide)]);
}

const call = async (name: string, args: Record<string, unknown>) => {
  const raw = (await agent.callTool({ name, arguments: args })) as ToolCallResult;
  return { ...parse(raw), note: raw.content[1]?.text ?? null };
};

/** What a device's sync would do for one entry: the hub receives it. */
const replicate = (id: string) =>
  receiveEntry(hub.db, exportEntry(db, id)!, { growthOrigin: 'hub' });

const ids = (items: Array<{ id: string }>) => items.map((x) => x.id);
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((x) => [x.id, x]));

describe('origin mcp on a connected device', () => {
  it('merges search results from both stores, once each, labelled', async () => {
    await connect();
    expect((await agent.listTools()).tools).toHaveLength(7);
    const r = await call('search', { query: 'Keep' });
    expect(r.note).toBeNull();
    const events = byId<{ id: string; origin: string }>(r.json.events);
    expect([...events.keys()].sort()).toEqual(['fake:d1', 'fake:e1', 'fake:h1']);
    expect(events.get('fake:e1')?.origin).toBe('local');
    expect(events.get('fake:d1')?.origin).toBe('local');
    expect(events.get('fake:h1')?.origin).toBe('hub');
  });

  it('shows one current version per entry, and converges with the hub on concurrent corrections', async () => {
    await connect();
    const mine = await call('remember', {
      kind: 'knowledge',
      text: 'Every device gets its own hub token.',
      confidence: 0.9,
      sources: [{ event_id: 'fake:e1' }],
    });
    const a = mine.json.entry;
    expect(a).toMatchObject({ author: 'agent-x@laptop', origin: 'local', root: a.id });
    replicate(a.id);
    const b = remember(hub.db, {
      kind: 'cognition',
      text: 'Prefers short commit messages.',
      confidence: 0.8,
      author: 'cloud@ci',
      sources: [{ eventId: 'fake:h1' }],
    });

    let listed = await call('search', { scope: 'entries' });
    expect(
      listed.json.entries.map((e: { id: string; origin: string }) => [e.id, e.origin]),
    ).toEqual([
      [b.id, 'hub'],
      [a.id, 'local'],
    ]);

    // The hub corrects the entry: the device shows the hub's version, not its own older one.
    const onHub = correct(hub.db, a.id, { text: 'One token per device.', author: 'user@hub' });
    listed = await call('search', { scope: 'entries' });
    expect(ids(listed.json.entries)).toEqual([onHub.id, b.id]);
    const got = await call('get', { id: a.id });
    expect(got.json.entry).toMatchObject({ status: 'superseded', superseded_by: onHub.id });
    expect(ids(got.json.history)).toEqual([a.id, onHub.id]);

    // The device, unaware, corrects its own copy later: a concurrent correction, and the newer one.
    const onDevice = correct(
      db,
      a.id,
      { text: 'One revocable token per device.', author: 'user@laptop' },
      onHub.createdAt + 1,
    );
    listed = await call('search', { scope: 'entries' });
    expect(ids(listed.json.entries)).toEqual([onDevice.id, b.id]);
    const mineNow = await call('get', { id: onHub.id });
    // Once the device's version reaches the hub, both stores agree.
    replicate(onDevice.id);
    const theirs = parse(
      await (async () => {
        const server = createOriginServer({ db: hub.db, home: hub.home });
        const c = new Client({ name: 'check', version: '1' });
        const [x, y] = InMemoryTransport.createLinkedPair();
        await Promise.all([c.connect(x), server.mcp.connect(y)]);
        const out = await c.callTool({ name: 'get', arguments: { id: onHub.id } });
        await c.close();
        return out;
      })(),
    );
    const view = (r: { entry: object; history: object[] }) => ({
      entry: r.entry,
      history: r.history,
    });
    const strip = ({ origin: _o, ...rest }: Record<string, unknown>) => rest;
    expect(strip(view(mineNow.json).entry as Record<string, unknown>)).toEqual(
      view(theirs.json).entry,
    );
    expect(view(mineNow.json).history).toEqual(view(theirs.json).history);
    expect(mineNow.json.entry).toMatchObject({
      status: 'superseded',
      concurrent: true,
      superseded_by: onDevice.id,
    });
    expect(getEntry(hub.db, onHub.id)).toMatchObject({
      concurrent: true,
      supersededBy: onDevice.id,
    });
  });

  it('never shows what the device has forgotten, even while the hub still has it', async () => {
    await connect();
    const forgotten = await call('forget', { id: 'fake:e1' });
    expect(forgotten.json.excluded_events).toBe(1);
    expect(getEvent(hub.db, 'fake:e1')).not.toBeNull(); // not synced in this test
    const r = await call('search', { query: 'Keep' });
    expect(ids(r.json.events).sort()).toEqual(['fake:d1', 'fake:h1']);
    expect(await call('get', { id: 'fake:e1' })).toMatchObject({
      isError: true,
      text: 'fake:e1 has been forgotten.',
    });
    expect((await call('sources', { id: 'fake:e1' })).isError).toBe(true);
    const session = await call('timeline', { session: 's1' });
    expect(ids(session.json.events)).toEqual(['fake:e2']);
  });

  it('answers get and sources for ids only the hub has', async () => {
    await connect();
    const got = await call('get', { id: 'fake:h1' });
    expect(got.json).toMatchObject({ id: 'fake:h1', origin: 'hub' });
    const sources = await call('sources', { id: 'fake:h1' });
    expect(sources.json).toMatchObject([{ event_id: 'fake:h1', origin: 'hub', line: 1 }]);
    const local = await call('sources', { id: 'fake:d1' });
    expect(local.json).toMatchObject([{ event_id: 'fake:d1', origin: 'local' }]);
    expect(local.json[0].mirror_file.startsWith(home)).toBe(true);
    expect(await call('get', { id: 'fake:nope' })).toMatchObject({
      isError: true,
      text: 'Unknown entry or event fake:nope.',
    });
    const timeline = await call('timeline', { since: '1970-01-01' });
    expect(
      timeline.json.sessions.map((s: { session: string; origin: string }) => [s.session, s.origin]),
    ).toEqual([
      ['sh', 'hub'],
      ['sd', 'local'],
      ['s1', 'local'],
    ]);
  });

  it('answers from the device alone, with a note, when the hub is slow or down', async () => {
    await connect({ hubTimeoutMs: 150 });
    await call('search', { query: 'Keep' }); // connect while the hub is fast
    hub.delayMs = 1000;
    const started = Date.now();
    const slow = await call('search', { query: 'Keep' });
    expect(Date.now() - started).toBeLessThan(800);
    expect(ids(slow.json.events).sort()).toEqual(['fake:d1', 'fake:e1']);
    expect(slow.note).toMatch(/hub was not consulted \(no answer within 0\.15 s\)/);

    hub.delayMs = 0;
    await hub.stop();
    const down = await call('search', { query: 'Keep' });
    expect(ids(down.json.events).sort()).toEqual(['fake:d1', 'fake:e1']);
    expect(down.note).toMatch(
      /hub was not consulted \(the hub at http:\/\/127\.0\.0\.1:\d+ is unreachable/,
    );
    const missing = await call('get', { id: 'fake:h1' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(
      /^Unknown entry or event fake:h1\. \(The Origin hub was not consulted/,
    );
  });

  it('writes locally and syncs after, and does on the hub what only the hub has', async () => {
    await connect();
    await call('search', { query: 'Keep' });
    await call('timeline', {});
    expect(syncs).toBe(1); // reads sync at most once per interval
    const r = await call('remember', {
      kind: 'memory',
      text: 'Decided that every device keeps a full local store.',
      confidence: 0.8,
      sources: [{ quote: 'device store local' }],
    });
    expect(syncs).toBe(2); // and every write syncs
    expect(getEntry(db, r.json.entry.id)?.author).toBe('agent-x@laptop');
    expect(getEntry(hub.db, r.json.entry.id)).toBeNull();

    // An entry written on the hub by another agent: the device corrects and forgets it there.
    const theirs = remember(hub.db, {
      kind: 'knowledge',
      text: 'Commit messages are short.',
      confidence: 0.7,
      author: 'cloud@ci',
      sources: [{ eventId: 'fake:h1' }],
    });
    const corrected = await call('correct', {
      id: theirs.id,
      text: 'Commit messages are short and in English.',
    });
    expect(corrected.json).toMatchObject({ origin: 'hub', entry: { supersedes: theirs.id } });
    expect(getEntry(hub.db, corrected.json.entry.id)?.author).toBe('agent-x@laptop');
    expect(getEntry(db, corrected.json.entry.id)).toBeNull();
    const forgotten = await call('forget', { id: 'fake:h1' });
    expect(forgotten.json).toMatchObject({ origin: 'hub', excluded_events: 1 });
    expect(getEvent(hub.db, 'fake:h1')).toBeNull();

    await hub.stop();
    const offline = await call('correct', { id: corrected.json.entry.id, text: 'again' });
    expect(offline.isError).toBe(true);
    expect(offline.text).toMatch(/is not in this device's store, and the hub at .* is unreachable/);
  });
});

describe('refreshGate', () => {
  it('runs a forced refresh again after the one in flight, once for all who asked', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = refreshGate(
      () =>
        new Promise<void>((resolve) => {
          runs++;
          release = resolve;
        }),
      60_000,
    );
    const first = gate(true);
    const reader = gate(); // shares the run in flight
    const writerA = gate(true);
    const writerB = gate(true);
    expect(runs).toBe(1);
    release();
    await first;
    await reader;
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    release();
    await Promise.all([writerA, writerB]);
    expect(runs).toBe(2);
    await gate(); // within the interval: no run
    expect(runs).toBe(2);
  });
});
