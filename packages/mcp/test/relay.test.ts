import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getEntry, getEvent, syncSource } from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { createRelayServer, type RelayServerOptions } from '../src/index.js';
import { parse, startTestHub, type TestHub, TOKEN, type ToolCallResult } from './hub-fixture.js';

/**
 * origin mcp on a relay (see docs/architecture.md#relays): every tool is the hub's. The sync is a
 * stand-in for the relay's upload: it hands the hub the lines written to `logs` since the last one.
 */

let hub: TestHub;
let logs: string;
let agent: Client | undefined;
let relay: ReturnType<typeof createRelayServer> | undefined;
let syncs: number;

beforeEach(async () => {
  hub = await startTestHub();
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-relay-logs-'));
  syncs = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  await agent?.close();
  await relay?.close();
  agent = undefined;
  relay = undefined;
  await hub.stop();
  fs.rmSync(logs, { recursive: true, force: true });
});

async function connect(over: Partial<RelayServerOptions> = {}): Promise<void> {
  relay = createRelayServer({
    device: 'laptop',
    hub: { url: hub.url, token: TOKEN },
    sync: async () => {
      syncs++;
      await syncSource({ db: hub.db, home: hub.home }, fakeAdapter(logs));
    },
    syncIntervalMs: 60_000,
    ...over,
  });
  agent = new Client({ name: 'agent-x', version: '1.0.0' });
  const [agentSide, relaySide] = InMemoryTransport.createLinkedPair();
  await Promise.all([agent.connect(agentSide), relay.mcp.connect(relaySide)]);
}

const call = async (name: string, args: Record<string, unknown>) =>
  parse((await (agent as Client).callTool({ name, arguments: args })) as ToolCallResult);

describe('origin mcp on a relay', () => {
  it('answers every read from the hub, once the new log lines have reached it', async () => {
    await connect();
    expect((await (agent as Client).listTools()).tools).toHaveLength(7);
    // Written to the agent's log a moment ago: only the hub can find it, once it has been sent.
    fs.writeFileSync(
      path.join(logs, 'now.jsonl'),
      line('n1', 'sn', 9000, 'user', 'Rotate the relay token every quarter.'),
    );
    const found = await call('search', { query: 'Rotate' });
    expect(found.isError).toBe(false);
    expect(found.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:n1']);
    expect(found.json.events[0].origin).toBeUndefined(); // the hub's answer, as it is
    expect(syncs).toBe(1);

    expect((await call('get', { id: 'fake:e1' })).json).toMatchObject({
      text: 'Keep the hub behind TLS and give every device its own token.',
    });
    expect((await call('sources', { id: 'fake:e1' })).json[0]).toMatchObject({ line: 1 });
    expect((await call('timeline', { session: 's1' })).json.events).toHaveLength(2);
    // Reads within the interval do not send again.
    expect(syncs).toBe(1);
    expect((await call('get', { id: 'fake:nope' })).text).toMatch(/Unknown entry or event/);
  });

  it("writes on the hub, as this device's agent, after sending what it cites", async () => {
    await connect();
    await call('search', { query: 'warm up' });
    fs.writeFileSync(
      path.join(logs, 'now.jsonl'),
      line('n1', 'sn', 9000, 'user', 'Use the relay on the small VPS.'),
    );
    const saved = await call('remember', {
      kind: 'memory',
      text: 'The small VPS runs Origin as a relay.',
      confidence: 0.9,
      sources: [{ quote: 'relay on the small VPS' }],
    });
    expect(saved.isError).toBe(false);
    expect(syncs).toBe(2); // a write always sends first, whatever the interval
    expect(saved.json.entry).toMatchObject({ author: 'agent-x@laptop' });
    expect(getEntry(hub.db, saved.json.entry.id)).toMatchObject({
      author: 'agent-x@laptop',
      origin: 'hub',
    });

    const fixed = await call('correct', { id: saved.json.entry.id, text: 'The VPS is a relay.' });
    expect(getEntry(hub.db, fixed.json.entry.id)).toMatchObject({ author: 'agent-x@laptop' });
    const gone = await call('forget', { id: 'fake:e2' });
    expect(gone.json.excluded_events).toBe(1);
    expect(getEvent(hub.db, 'fake:e2')).toBeNull();
  });

  it('says that a relay cannot answer or write while its hub is unreachable', async () => {
    await connect({ answerTimeoutMs: 3000 });
    await hub.stop();
    const read = await call('search', { query: 'token' });
    expect(read.isError).toBe(true);
    expect(read.text).toMatch(
      /^This device is an Origin relay: it keeps no memory of its own and answers only through its hub, but the hub at .* is unreachable/,
    );
    const write = await call('remember', {
      kind: 'memory',
      text: 'Never saved.',
      confidence: 0.5,
      sources: [{ quote: 'token' }],
    });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/`remember` is done on its hub, but .*Nothing was changed/);
  });

  it('says when the hub rejects the token', async () => {
    relay = createRelayServer({ device: 'laptop', hub: { url: hub.url, token: 'ogn_wrong' } });
    agent = new Client({ name: 'agent-x', version: '1.0.0' });
    const [agentSide, relaySide] = InMemoryTransport.createLinkedPair();
    await Promise.all([agent.connect(agentSide), relay.mcp.connect(relaySide)]);
    expect((await call('timeline', {})).text).toMatch(/rejected the token \(HTTP 401\)/);
  });

  it('sends new log lines in the background, retries a failed sync, and sends once more on leaving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let dirty = false;
    let failing = true;
    relay = createRelayServer({
      device: 'laptop',
      hub: { url: hub.url, token: TOKEN },
      sync: async () => {
        syncs++;
        if (failing) throw new Error('hub unreachable');
      },
      changed: async () => dirty,
    });
    relay.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncs).toBe(0); // nothing changed, nothing owed
    dirty = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncs).toBe(1); // failed
    dirty = false;
    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncs).toBe(2); // retried, though nothing changed since
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncs).toBe(2);
    await relay.stop();
    expect(syncs).toBe(3);
  });
});
