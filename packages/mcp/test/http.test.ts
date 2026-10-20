import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getEntry } from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, startTestHub, type TestHub, TOKEN } from './hub-fixture.js';

let hub: TestHub;
let client: Client;

beforeEach(async () => {
  hub = await startTestHub();
  client = new Client({ name: 'http-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', hub.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Origin-Client': 'http-agent' },
      },
    }),
  );
});

afterEach(async () => {
  await client.close();
  await hub.stop();
});

describe('handleMcpHttp (stateless Streamable HTTP)', () => {
  it('serves the seven tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['correct', 'forget', 'get', 'remember', 'search', 'sources', 'timeline'].sort(),
    );
  });

  it('remembers with the author given by the caller, and finds the entry again', async () => {
    const remembered = parse(
      await client.callTool({
        name: 'remember',
        arguments: {
          kind: 'knowledge',
          text: 'Every device gets its own hub token.',
          confidence: 0.9,
          sources: [{ quote: 'give every device its own token' }],
        },
      }),
    );
    const entry = remembered.json.entry;
    expect(entry).toMatchObject({ author: 'http-agent@test', status: 'active' });
    expect(getEntry(hub.db, entry.id)?.author).toBe('http-agent@test');

    const found = parse(await client.callTool({ name: 'search', arguments: { query: 'token' } }));
    expect(found.json.entries.map((e: { id: string }) => e.id)).toEqual([entry.id]);
    expect(found.json.events.map((e: { id: string }) => e.id)).toContain('fake:e1');
  });

  it('rejects methods other than POST', async () => {
    const res = await fetch(new URL('/mcp', hub.url), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
  });
});
