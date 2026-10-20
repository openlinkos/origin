import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getEntry } from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxyServer, type ProxyServer } from '../src/index.js';
import { parse, startTestHub, type TestHub, TOKEN } from './hub-fixture.js';

let hub: TestHub;
let proxy: ProxyServer;
let agent: Client;
let refreshes: number;

async function connectAgent(token: string): Promise<void> {
  refreshes = 0;
  proxy = createProxyServer({
    url: hub.url,
    token,
    refresh: async () => {
      refreshes++;
    },
    syncIntervalMs: 60_000,
  });
  agent = new Client({ name: 'agent-x', version: '1.0.0' });
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await Promise.all([agent.connect(agentSide), proxy.mcp.connect(proxySide)]);
}

beforeEach(async () => {
  hub = await startTestHub();
});

afterEach(async () => {
  await agent.close();
  await proxy.close();
  await hub.stop();
});

describe('createProxyServer', () => {
  it('exposes the same tools and forwards calls to the hub', async () => {
    await connectAgent(TOKEN);
    const { tools } = await agent.listTools();
    expect(tools).toHaveLength(7);

    const found = parse(await agent.callTool({ name: 'search', arguments: { query: 'TLS' } }));
    expect(found.isError).toBe(false);
    expect(found.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:e1']);
  });

  it('refreshes before reads at most once per interval, and always before writes', async () => {
    await connectAgent(TOKEN);
    await agent.callTool({ name: 'search', arguments: { query: 'token' } });
    await agent.callTool({ name: 'timeline', arguments: { since: '1970-01-01' } });
    expect(refreshes).toBe(1);

    const remembered = parse(
      await agent.callTool({
        name: 'remember',
        arguments: {
          kind: 'memory',
          text: 'Decided on one revocable hub token per device.',
          confidence: 0.8,
          sources: [{ event_id: 'fake:e2' }],
        },
      }),
    );
    expect(refreshes).toBe(2);
    // The agent's name reaches the hub through the proxy's X-Origin-Client header.
    expect(remembered.json.entry.author).toBe('agent-x@test');
    expect(getEntry(hub.db, remembered.json.entry.id)?.author).toBe('agent-x@test');

    await agent.callTool({
      name: 'correct',
      arguments: { id: remembered.json.entry.id, text: 'One revocable token per device.' },
    });
    expect(refreshes).toBe(3);
  });

  it('reports an unreachable hub as a tool error', async () => {
    await connectAgent(TOKEN);
    await agent.callTool({ name: 'search', arguments: { query: 'token' } });
    await hub.stop();
    const r = parse(await agent.callTool({ name: 'search', arguments: { query: 'token' } }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Origin hub unreachable at http:\/\/127\.0\.0\.1:\d+/);
  });

  it('says so when the hub rejects the token', async () => {
    await connectAgent('ogn_wrong');
    const r = parse(await agent.callTool({ name: 'search', arguments: { query: 'token' } }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rejected the token');
  });
});
