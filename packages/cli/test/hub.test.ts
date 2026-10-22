import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  createToken,
  type Database,
  getEntry,
  getEvent,
  initStoreName,
  openDatabase,
  rawLocator,
  revokeToken,
  syncSource,
} from '@openlinkos/origin-core';
import { createReplicaServer } from '@openlinkos/origin-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubConfig } from '../src/hub/config.js';
import { createHubServer } from '../src/hub/server.js';
import { syncWithHub } from '../src/hub/sync.js';

const fixtures = fileURLToPath(
  new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';

let tmp: string;
let hubHome: string;
let deviceHome: string;
let hubDb: Database;
let deviceDb: Database;
let server: http.Server;
let hub: HubConfig;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
  hubHome = path.join(tmp, 'hub');
  deviceHome = path.join(tmp, 'device');
  hubDb = openDatabase(path.join(hubHome, 'origin.db'));
  deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
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
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  hubDb.close();
  deviceDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const push = () => syncWithHub({ db: deviceDb, home: deviceHome, hub });

async function hubClient(): Promise<Client> {
  const client = new Client({ name: 'cloud-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', hub.url), {
      requestInit: { headers: { Authorization: `Bearer ${hub.token}` } },
    }),
  );
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: MCP tool results are untyped JSON
const json = (result: any) => JSON.parse(result.content[0].text);

describe('personal hub', () => {
  it('replicates a device and serves it to agents over MCP', async () => {
    expect(await push()).toMatchObject({ files: 1, eventsAdded: 6, tombstonesApplied: 0 });
    const event = getEvent(hubDb, USER_EVENT);
    expect(event?.text).toBe('帮我检查一下仓库的状态');
    expect(rawLocator(hubDb, hubHome, event!)).toMatchObject({ device: 'laptop', line: 5 });
    expect(await push()).toMatchObject({ files: 0, bytes: 0 }); // resumable and idempotent

    const client = await hubClient();
    const found = json(await client.callTool({ name: 'search', arguments: { query: '仓库' } }));
    expect(found.events.map((e: { id: string }) => e.id)).toEqual([USER_EVENT]);
    const remembered = json(
      await client.callTool({
        name: 'remember',
        arguments: {
          kind: 'memory',
          text: 'Asked the agent to check the repository status.',
          confidence: 0.8,
          sources: [{ event_id: USER_EVENT }],
        },
      }),
    );
    expect(remembered.entry.author).toBe('laptop');
    await client.close();
  });

  it('propagates forgetting from the hub to the device (invariant 2)', async () => {
    await push();
    const client = await hubClient();
    await client.callTool({ name: 'forget', arguments: { id: USER_EVENT } });
    await client.close();

    expect(getEvent(deviceDb, USER_EVENT)).not.toBeNull();
    expect((await push()).tombstonesApplied).toBe(1);
    expect(getEvent(deviceDb, USER_EVENT)).toBeNull();
    expect((await push()).tombstonesApplied).toBe(0);
    expect(getEvent(hubDb, USER_EVENT)).toBeNull();
  });

  it('serves a device agent from its own store, then syncs what it wrote', async () => {
    initStoreName(deviceDb, 'laptop');
    let syncs = 0;
    const replica = createReplicaServer({
      db: deviceDb,
      home: deviceHome,
      device: 'laptop',
      hub: { url: hub.url, token: hub.token },
      sync: async () => {
        syncs++;
        await push();
      },
    });
    const client = new Client({ name: 'agent-x', version: '1.0.0' });
    const [clientSide, replicaSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientSide), replica.mcp.connect(replicaSide)]);

    // The quoted line is only on the device: the entry is written there, then synced up.
    const remembered = json(
      await client.callTool({
        name: 'remember',
        arguments: {
          kind: 'cognition',
          text: 'Checks the repository status before starting work.',
          confidence: 0.7,
          sources: [{ quote: '检查一下仓库的状态' }],
        },
      }),
    );
    expect(remembered.entry).toMatchObject({ author: 'agent-x@laptop', origin: 'local' });
    expect(syncs).toBe(1);
    expect(getEntry(hubDb, remembered.entry.id)).toMatchObject({
      author: 'agent-x@laptop',
      origin: 'laptop',
    });
    await client.close();
    await replica.close();
  });

  it('rejects missing or revoked tokens, unsafe paths, and unknown sources', async () => {
    expect((await fetch(`${hub.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${hub.url}/v1/cursors?device=laptop`)).status).toBe(401);

    const ingest = (body: Record<string, unknown>) =>
      fetch(`${hub.url}/v1/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: 'laptop',
          source: 'claude-code',
          path: '/home/me/.claude/projects/p/s.jsonl',
          relPath: 'p/s.jsonl',
          generation: 1,
          offset: 0,
          data: Buffer.from('{}\n').toString('base64'),
          ...body,
        }),
      });
    expect((await ingest({ relPath: '../../../etc/passwd' })).status).toBe(400);
    expect((await ingest({ relPath: 'C:/Windows/x.jsonl' })).status).toBe(400);
    expect((await ingest({ device: '../evil' })).status).toBe(400);
    expect((await ingest({ source: 'nope' })).status).toBe(400);
    // A device may not take the hub's own name: it would never receive the hub's tombstones.
    expect((await ingest({ device: 'hub' })).status).toBe(400);
    const asHub = await fetch(`${hub.url}/v1/tombstones?after=0&device=hub`, {
      headers: { Authorization: `Bearer ${hub.token}` },
    });
    expect(asHub.status).toBe(400);
    expect((await ingest({})).status).toBe(200);

    revokeToken(hubDb, 'laptop');
    const res = await fetch(`${hub.url}/v1/cursors?device=laptop`, {
      headers: { Authorization: `Bearer ${hub.token}` },
    });
    expect(res.status).toBe(401);
  });
});
