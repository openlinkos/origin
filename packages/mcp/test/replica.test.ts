import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  correct,
  type Database,
  exportEntry,
  forget,
  getEntry,
  getEvent,
  getRecall,
  initStoreName,
  openDatabase,
  planRecall,
  receiveEntry,
  recordRecall,
  remember,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import {
  createOriginServer,
  createReplicaServer,
  type EventResult,
  type RecallResult,
  type ReplicaOptions,
  type SessionResult,
} from '../src/index.js';
import { type LocalFacts, mergeGet, mergeTimeline } from '../src/merge.js';
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
  it("briefs from the device's own store, as its hooks do", async () => {
    const cwd = path.join(tmp('origin-work-'), 'demo');
    fs.mkdirSync(cwd);
    const mine = remember(db, {
      kind: 'cognition',
      text: 'Keep the device store local and fast.',
      confidence: 0.9,
      author: 'test',
      project: 'demo',
      sources: [{ eventId: 'fake:d1' }],
    });
    const theirs = remember(hub.db, {
      kind: 'cognition',
      text: 'Keep commit messages short.',
      confidence: 0.9,
      author: 'test',
      project: 'demo',
      sources: [{ eventId: 'fake:h1' }],
    });
    await connect({ cwd });
    const r = await call('brief', {});
    expect(r.json.text).toContain(mine.id);
    expect(r.json.text).not.toContain(theirs.id);
    expect(getRecall(db, r.json.recall)).toMatchObject({ origin: 'laptop', source: 'agent-x' });
    expect(getRecall(hub.db, r.json.recall)).toBeNull();
  });

  it('merges search results from both stores, once each, labelled', async () => {
    await connect();
    expect((await agent.listTools()).tools).toHaveLength(11);
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
    const forgotten = await call('forget', { id: 'fake:e1', reason: 'test' });
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

  it('consults a slow hub in time once the connection has been warmed', async () => {
    // Each hub request takes 100 ms. Cold, the first read must also initialize the connection
    // (two more requests), which does not fit in 250 ms; warmed, only the call itself remains.
    hub.delayMs = 100;
    await connect({ hubTimeoutMs: 250 });
    const cold = await call('search', { query: 'Keep' });
    expect(cold.note).toMatch(/hub was not consulted/);

    await replica.close();
    await connect({ hubTimeoutMs: 250 });
    await replica.warm();
    const warm = await call('search', { query: 'Keep' });
    expect(warm.note).toBeNull();
    expect(ids(warm.json.events).sort()).toEqual(['fake:d1', 'fake:e1', 'fake:h1']);
    hub.delayMs = 0;
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
    const forgotten = await call('forget', { id: 'fake:h1', reason: 'test' });
    expect(forgotten.json).toMatchObject({ origin: 'hub', excluded_events: 1 });
    expect(getEvent(hub.db, 'fake:h1')).toBeNull();

    await hub.stop();
    const offline = await call('correct', { id: corrected.json.entry.id, text: 'again' });
    expect(offline.isError).toBe(true);
    expect(offline.text).toMatch(/is not in this device's store, and the hub at .* is unreachable/);
  });
});

describe('reading along references on a connected device', () => {
  it("opens a session, an event, or a recall from one store, the device's when it has it", async () => {
    // An entry on the hub that cites the shared session: the device's card does not take it in.
    remember(hub.db, {
      kind: 'memory',
      text: 'Tokens are per device.',
      confidence: 0.9,
      author: 'cloud@ci',
      sources: [{ eventId: 'fake:e1' }],
    });
    const own = remember(db, {
      kind: 'memory',
      text: 'Tokens can be revoked.',
      confidence: 0.9,
      author: 'test',
      sources: [{ eventId: 'fake:e2' }],
    });
    const brief = remember(hub.db, {
      kind: 'memory',
      text: 'Commit messages are short.',
      confidence: 0.9,
      author: 'cloud@ci',
      project: 'demo',
      sources: [{ eventId: 'fake:h1' }],
    });
    const recall = recordRecall(
      hub.db,
      planRecall(hub.db, { occasion: 'request', source: 'cloud', cwd: '/w/demo', project: 'demo' }),
    );
    await connect();

    const mine = await call('get', { id: 's1' });
    expect(mine.json).toMatchObject({ session: 's1', origin: 'local', turns: 1 });
    expect(ids(mine.json.entries)).toEqual([own.id]);
    const theirs = await call('get', { id: 'sh' });
    expect(theirs.json).toMatchObject({
      session: 'sh',
      origin: 'hub',
      prompt: 'Keep commit messages short, says the other device.',
      turns: 1,
    });
    expect(ids(theirs.json.entries)).toEqual([brief.id]);

    const event = await call('get', { id: 'fake:h1' });
    expect(event.json).toMatchObject({
      origin: 'hub',
      session_title: 'Keep commit messages short, says the other device.',
      turn: { number: 1 },
      cited_by: [{ id: brief.id }],
    });
    const local = await call('get', { id: 'fake:e2' });
    expect(local.json).toMatchObject({ origin: 'local', cited_by: [{ id: own.id }] });

    const opened = await call('get', { id: recall });
    expect(opened.json).toMatchObject({ id: recall, origin: 'hub', items: [{ id: brief.id }] });
    expect(opened.json.text).toContain(brief.id);

    // A session's page: merged by id, with the count of what follows from the side that had it.
    const page = await call('timeline', { session: 's1', limit: 1 });
    expect(page.json).toMatchObject({
      session: 's1',
      prompt: 'Keep the hub behind TLS and give every device its own token.',
      more: 1,
    });
    expect(ids(page.json.events)).toEqual(['fake:e1']);
    const rest = await call('timeline', { session: 's1', after: 'fake:e1' });
    expect(rest.json).toMatchObject({ more: 0 });
    expect(ids(rest.json.events)).toEqual(['fake:e2']);
    const hubOnly = await call('timeline', { session: 'sh', turn: 1 });
    expect(hubOnly.json).toMatchObject({ more: 0, prompt: theirs.json.prompt });
    expect(ids(hubOnly.json.events)).toEqual(['fake:h1']);

    const found = await call('search', { query: 'Keep' });
    expect(
      found.json.events.map((e: { id: string; session_title: string }) => [e.id, e.session_title]),
    ).toEqual(
      expect.arrayContaining([
        ['fake:h1', theirs.json.prompt],
        ['fake:d1', 'Keep the device store local and fast.'],
      ]),
    );
  });

  /** What a device knows, for merging: it has `known`, and has forgotten `forgotten`. */
  const factsOf = (known: string[], forgotten: string[] = []): LocalFacts => ({
    known: (id) => known.includes(id) || forgotten.includes(id),
    forgotten: (id) => forgotten.includes(id),
    entryStatus: (id) =>
      forgotten.includes(id) ? 'forgotten' : known.includes(id) ? 'active' : null,
    versions: () => [],
  });
  const stub = (id: string) => ({ id, time: '', role: 'user', kind: 'message', text: id });
  const entry = (id: string) => ({ id, kind: 'memory', text: id, created: '' });

  it("leaves out of the hub's cards what the device has forgotten (invariant 2)", () => {
    const facts = factsOf([], ['fake:x1', 'ent_00000000000a', 'fake:p2']);
    const event = mergeGet(
      null,
      {
        id: 'fake:x2',
        time: '',
        source: 'fake',
        project: null,
        session: 's',
        role: 'assistant',
        kind: 'message',
        text: '',
        cwd: null,
        git_branch: null,
        agent_version: null,
        turn: { number: 1, prompt: stub('fake:x1') },
        replies_to: stub('fake:x1'),
        around: { before: [stub('fake:x1'), stub('fake:x0')], after: [stub('fake:x3')] },
        cited_by: [entry('ent_00000000000a'), entry('ent_00000000000b')],
      } satisfies EventResult,
      facts,
    ) as EventResult;
    expect(event).toMatchObject({ origin: 'hub', turn: null, replies_to: null });
    expect(ids(event.around?.before ?? [])).toEqual(['fake:x0']);
    expect(ids(event.cited_by ?? [])).toEqual(['ent_00000000000b']);

    const session = mergeGet(
      null,
      {
        session: 's',
        source: 'fake',
        project: null,
        cwd: null,
        title: null,
        prompt: 'p1',
        started: null,
        ended: null,
        events: 4,
        turns: 2,
        prompts: [
          { turn: 1, id: 'fake:p1', time: '', text: 'p1' },
          { turn: 2, id: 'fake:p2', time: '', text: 'p2' },
        ],
        more_prompts: 0,
        entries: [entry('ent_00000000000a'), entry('ent_00000000000b')],
        recalls: [],
        before: null,
        after: null,
      } satisfies SessionResult,
      facts,
    ) as SessionResult;
    expect(session).toMatchObject({ origin: 'hub', turns: 1 });
    expect(ids(session.prompts)).toEqual(['fake:p1']);
    expect(ids(session.entries)).toEqual(['ent_00000000000b']);

    const item = (rank: number, id: string) => ({
      rank,
      layer: 'project',
      kind: 'entry' as const,
      id,
      score: null,
      used: null,
    });
    const recall = (items: string[], text: string): RecallResult => ({
      id: 'rcl_000000000001',
      time: '',
      occasion: 'start',
      agent: 'codex',
      session: null,
      device: 'desktop',
      project: 'demo',
      directory: null,
      budget: 800,
      tokens: 40,
      items: items.map((id, i) => item(i + 1, id)),
      text,
    });
    const header = 'Origin recall rcl_000000000001: a brief.';
    const both = mergeGet(
      null,
      recall(
        ['ent_00000000000b', 'ent_00000000000a'],
        `${header}\n\nThe user’s preferences and boundaries:\n- ent_00000000000b B\n\nProject demo:\n- ent_00000000000a (2026-10-20) A`,
      ),
      facts,
    ) as RecallResult;
    expect(ids(both.items)).toEqual(['ent_00000000000b']);
    expect(both.text).toBe(
      `${header}\n\nThe user’s preferences and boundaries:\n- ent_00000000000b B`,
    );
    const none = mergeGet(
      null,
      recall(['ent_00000000000a'], `${header}\n\nProject demo:\n- ent_00000000000a A`),
      facts,
    ) as RecallResult;
    expect(none).toMatchObject({ items: [], text: '' });
  });

  it("pages a session with the device's count of what follows, or the hub's", () => {
    const ev = (id: string, time: string) => ({
      id,
      time,
      source: 'fake',
      project: null,
      session: 's',
      role: 'user',
      kind: 'message',
      text: id,
    });
    const facts = factsOf(['fake:a', 'fake:b']);
    const local = {
      session: 's',
      title: null,
      prompt: 'mine',
      events: [ev('fake:a', '2026-10-20T10:00:00.000Z'), ev('fake:b', '2026-10-20T10:01:00.000Z')],
      more: 1,
    };
    const hub = {
      session: 's',
      title: null,
      prompt: 'theirs',
      events: [ev('fake:a', '2026-10-20T10:00:00.000Z'), ev('fake:c', '2026-10-20T10:02:00.000Z')],
      more: 7,
    };
    expect(mergeTimeline(local, hub, facts, 2)).toMatchObject({
      prompt: 'mine',
      more: 2, // the device's 1, and fake:c, left out by the limit
    });
    const empty = { session: 's', title: null, prompt: null, events: [], more: 0 };
    expect(mergeTimeline(empty, hub, facts, 5)).toMatchObject({ prompt: 'theirs', more: 7 });
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

describe('changes and follow on a connected device', () => {
  const fakeLine = (fields: Record<string, unknown>) =>
    `${JSON.stringify({ role: 'user', ...fields })}\n`;

  it("merges both stores' changes, labelled, under a cursor of both", async () => {
    await connect();
    const first = await call('changes', {});
    expect(first.json.events).toEqual([]);
    const cursor = JSON.parse(Buffer.from(first.json.next, 'base64url').toString('utf8'));
    expect(cursor).toEqual({ l: { e: expect.any(Number), c: 0 }, h: expect.any(String) });

    const now = Date.now();
    const shared = fakeLine({ id: 'x1', session: 'sx', ts: now - 2000, text: 'Shared work.' });
    const deviceOnly = tmp('origin-src-');
    fs.writeFileSync(path.join(deviceOnly, 'x.jsonl'), shared);
    fs.writeFileSync(
      path.join(deviceOnly, 'y.jsonl'),
      fakeLine({ id: 'y1', session: 'sy', ts: now - 1000, text: 'Only here.' }),
    );
    await syncSource({ db, home }, fakeAdapter(deviceOnly));
    const hubOnly = tmp('origin-other-');
    fs.writeFileSync(path.join(hubOnly, 'x.jsonl'), shared);
    fs.writeFileSync(
      path.join(hubOnly, 'z.jsonl'),
      fakeLine({ id: 'z1', session: 'sz', ts: now - 500, text: 'Only on the hub.' }) +
        fakeLine({ id: 'z2', session: 'sz', ts: now - 400, text: 'Forgotten here.' }),
    );
    await syncSource({ db: hub.db, home: hub.home }, fakeAdapter(hubOnly));
    // The device forgot what the hub still shows: it stays out of the device's answer.
    fs.writeFileSync(
      path.join(deviceOnly, 'z.jsonl'),
      fakeLine({ id: 'z2', session: 'sz', ts: 1, text: 'Forgotten here.' }),
    );
    await syncSource({ db, home }, fakeAdapter(deviceOnly));
    forget(db, 'fake:z2', { reason: 'not on this device' });

    const page = await call('changes', { after: first.json.next });
    expect(page.note).toBeNull();
    expect(page.json.events.map((e: { id: string; origin: string }) => [e.id, e.origin])).toEqual([
      ['fake:x1', 'local'],
      ['fake:y1', 'local'],
      ['fake:z1', 'hub'],
    ]);
    expect(
      page.json.sessions.map((s: { session: string; origin: string }) => [s.session, s.origin]),
    ).toEqual([
      ['sx', 'local'],
      ['sy', 'local'],
      ['sz', 'hub'],
    ]);
    expect(page.json.forgets.map((f: { target: string }) => f.target)).toEqual(['fake:z2']);
    expect(page.json.more).toBe(false);
    const done = await call('changes', { after: page.json.next });
    expect(done.json).toMatchObject({ events: [], forgets: [], more: false });

    // The hub out of reach: the device's own changes, and the hub's part of the cursor unchanged.
    hub.delayMs = 3000;
    const alone = await call('changes', { after: page.json.next });
    expect(alone.note).toContain('the Origin hub was not consulted');
    const kept = JSON.parse(Buffer.from(alone.json.next, 'base64url').toString('utf8'));
    expect(kept.h).toBe(JSON.parse(Buffer.from(page.json.next, 'base64url').toString('utf8')).h);
    hub.delayMs = 0;
    expect(await call('changes', { after: 'garbage!' })).toMatchObject({ isError: true });
  });

  it('follows a session only the hub has, which the hub checks', async () => {
    const work = path.join(tmp('origin-work-'), 'demo');
    fs.mkdirSync(work);
    await connect({ cwd: work });
    const local = await call('follow', { id: 's1' });
    expect(local.json).toMatchObject({ follows: 'fake:s1', thread: null });
    const fromHub = await call('follow', { id: 'sh', note: 'from the other device' });
    expect(fromHub.isError).toBe(false);
    expect(fromHub.json).toMatchObject({
      link: expect.stringMatching(/^lnk_/),
      follows: 'fake:sh',
      note: 'from the other device',
    });
    expect((await call('follow', { id: 'nowhere' })).text).toBe(
      'Unknown session or thread nowhere.',
    );
    expect(
      (await call('follow', { id: 'sh', cwd: path.join(work, '..', 'other') })).text,
    ).toContain('not of project other');
  });
});

describe('proposals on a connected device', () => {
  /** What `propose` returned, as an agent's log on `store` records it. */
  async function logResult(store: { db: Database; home: string }, id: string, text: string) {
    const dir = tmp('origin-proposed-');
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ id, session: `s-${id}`, ts: Date.now(), role: 'user', kind: 'tool_result', text })}\n`,
    );
    await syncSource(store, fakeAdapter(dir));
  }

  it("checks a proposal against the device's store, and opens and lists those of either store", async () => {
    await connect();
    const mine = await call('propose', {
      kind: 'knowledge',
      text: 'The device store is local and fast.',
      confidence: 0.6,
      sources: [{ event_id: 'fake:d1' }],
    });
    expect(mine.isError).toBe(false);
    // The result stays as `propose` writes it: ingestion reads it from the agent's log.
    expect(mine.json).not.toHaveProperty('origin');
    // As `remember`, it cites what this device holds.
    const elsewhere = await call('propose', {
      kind: 'knowledge',
      text: 'Commit messages are short.',
      confidence: 0.6,
      sources: [{ event_id: 'fake:h1' }],
    });
    expect(elsewhere.text).toBe('Unknown event fake:h1.');

    await logResult({ db, home }, 'mine', mine.text);
    // Another device proposed on the hub, citing the session both stores have.
    const theirs = JSON.stringify(
      {
        proposal: 'prp_0000000000f1',
        kind: 'cognition',
        text: 'Wants one token per device.',
        confidence: 0.5,
        project: null,
        valid_from: null,
        valid_to: null,
        note: null,
        sources: [{ event_id: 'fake:e1', quote: null }],
      },
      null,
      2,
    );
    await logResult(hub, 'theirs', theirs);

    expect((await call('get', { id: mine.json.proposal })).json).toMatchObject({
      status: 'pending',
      event: 'fake:mine',
      origin: 'local',
    });
    expect((await call('get', { id: 'prp_0000000000f1' })).json).toMatchObject({
      status: 'pending',
      event: 'fake:theirs',
      sources: [expect.objectContaining({ id: 'fake:e1' })],
      origin: 'hub',
    });
    const feed = await call('changes', { include_tools: true });
    expect(
      new Map(feed.json.proposals.map((p: { id: string; origin: string }) => [p.id, p.origin])),
    ).toEqual(
      new Map([
        [mine.json.proposal, 'local'],
        ['prp_0000000000f1', 'hub'],
      ]),
    );

    // What this device has forgotten is never shown: a proposal citing it is hidden here.
    forget(db, 'fake:e1', { reason: 'test' });
    expect((await call('get', { id: 'prp_0000000000f1' })).text).toBe(
      'prp_0000000000f1 has been forgotten.',
    );
    forget(db, 'fake:mine', { reason: 'Rejected.' });
    const after = await call('changes', { include_tools: true });
    expect(after.json.proposals.map((p: { id: string }) => p.id)).toEqual(['prp_0000000000f1']);
  });
});
