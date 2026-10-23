import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  createToken,
  type Database,
  getEntry,
  getEvent,
  getSetting,
  initStoreName,
  isEntryForgotten,
  listEntries,
  makeRelay,
  openDatabase,
  readMirror,
  relayCursor,
  remember,
  remoteCursors,
  revokeToken,
  syncSource,
} from '@openlinkos/origin-core';
import { createRelayServer, type SearchResult } from '@openlinkos/origin-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubConfig } from '../src/hub/config.js';
import { relayWithHub } from '../src/hub/relay.js';
import { askHub } from '../src/hub/remote.js';
import { createHubServer } from '../src/hub/server.js';
import { lastHubSync, pulledKey, syncWithHub } from '../src/hub/sync.js';

const fixtures = fileURLToPath(
  new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const SESSION = '0f1e2d3c-4b5a-4697-8877-665544332211';
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';
const NEW_EVENT = 'claude-code:44444444-4444-4444-8444-444444444444';

interface RunningHub {
  db: Database;
  home: string;
  server: http.Server;
  url: string;
  token: string;
}

let tmp: string;
let projects: string;
let logFile: string;
let hubs: RunningHub[];
let main: RunningHub;
let hub: HubConfig;
let relayHome: string;
let relayDb: Database;
let others: Database[];

async function startHub(home: string): Promise<RunningHub> {
  const db = openDatabase(path.join(home, 'origin.db'));
  const token = createToken(db, 'laptop');
  const server = createHubServer({
    db,
    home,
    adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
    version: 'test',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const running = {
    db,
    home,
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
  };
  hubs.push(running);
  return running;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-relay-'));
  hubs = [];
  others = [];
  // The agent's own logs: a copy of the fixture, so that tests can append to it and rewrite it.
  projects = path.join(tmp, 'projects');
  fs.cpSync(fixtures, projects, { recursive: true });
  logFile = path.join(projects, 'D--demo-project', `${SESSION}.jsonl`);
  main = await startHub(path.join(tmp, 'hub'));
  hub = { url: main.url, token: main.token, device: 'laptop' };
  relayHome = path.join(tmp, 'relay');
  relayDb = openDatabase(path.join(relayHome, 'origin.db'));
  initStoreName(relayDb, 'laptop');
  makeRelay(relayDb);
});

afterEach(async () => {
  for (const h of hubs) {
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
    h.db.close();
  }
  for (const db of [relayDb, ...others]) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const adapter = () => createClaudeCodeAdapter({ projectsDir: projects });
const sync = (over: Partial<Parameters<typeof relayWithHub>[0]> = {}) =>
  relayWithHub({ db: relayDb, home: relayHome, hub, adapters: [adapter()], ...over });
const count = (db: Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A Claude Code user message of the fixture's session. */
const userLine = (uuid: string, text: string, timestamp: string) =>
  `${JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp,
    cwd: 'D:\\demo\\project',
    sessionId: SESSION,
    version: '2.1.303',
    gitBranch: 'master',
  })}\n`;

// biome-ignore lint/suspicious/noExplicitAny: MCP tool results are untyped JSON
const json = (result: any) => JSON.parse(result.content[0].text);

describe('relay mode', () => {
  it('sends the logs straight from the agent, and the hub gets the events a mirroring device sends', async () => {
    const r = await sync();
    expect(r).toMatchObject({ files: 1, eventsAdded: 6, failed: [] });
    expect(r.bytes).toBe(fs.statSync(logFile).size);
    // The relay keeps no events and no mirrors.
    expect([count(relayDb, 'event'), count(relayDb, 'raw_file')]).toEqual([0, 0]);
    expect(fs.existsSync(path.join(relayHome, 'raw'))).toBe(false);
    expect(await sync()).toMatchObject({ files: 0, bytes: 0, eventsAdded: 0 });

    // A device that mirrors the same logs, pushing to a hub of its own.
    const other = await startHub(path.join(tmp, 'hub2'));
    const deviceHome = path.join(tmp, 'device');
    const deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
    others.push(deviceDb);
    initStoreName(deviceDb, 'laptop');
    await syncSource({ db: deviceDb, home: deviceHome }, adapter());
    await syncWithHub({
      db: deviceDb,
      home: deviceHome,
      hub: { url: other.url, token: other.token, device: 'laptop' },
    });

    const events = (db: Database) =>
      db
        .prepare(
          `SELECT id, source, session_id, parent_id, ts, project, cwd, git_branch, role, kind, text,
                  raw_line, agent_version, meta FROM event ORDER BY id`,
        )
        .all();
    expect(events(main.db)).toHaveLength(6);
    expect(events(main.db)).toEqual(events(other.db));
    const mirrors = (h: RunningHub) =>
      (
        h.db
          .prepare(
            'SELECT id, source, path, generation, mirror, bytes_ingested, lines_ingested, tail_hash FROM raw_file',
          )
          .all() as Array<{ id: number }>
      ).map(({ id, ...row }) => ({
        ...row,
        content: readMirror(h.db, h.home, id, 0, Number.MAX_SAFE_INTEGER).toString('utf8'),
      }));
    expect(mirrors(main)).toEqual(mirrors(other));
    expect(mirrors(main)[0]?.content).toBe(fs.readFileSync(logFile, 'utf8'));
  });

  it('moves no cursor until the hub has acknowledged the bytes', async () => {
    const offline: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(sync({ fetch: offline })).rejects.toThrow(/Cannot reach the hub/);
    expect(relayCursor(relayDb, 'claude-code', logFile)).toBeNull();
    // Recorded as a device's sync is, for origin status and origin hub status.
    expect(lastHubSync(relayDb, hub)).toMatchObject({
      at: null,
      failure: { error: /Cannot reach the hub/ },
    });

    // A token of another device, then a revoked one: refused, and nothing moves.
    const desk = createToken(main.db, 'desk');
    await expect(sync({ hub: { ...hub, token: desk } })).rejects.toThrow(/\(403\)/);
    revokeToken(main.db, 'laptop');
    await expect(sync()).rejects.toThrow(/rejected the token/);
    expect(relayCursor(relayDb, 'claude-code', logFile)).toBeNull();
    expect(getEvent(main.db, USER_EVENT)).toBeNull();
    hub = { ...hub, token: createToken(main.db, 'laptop') };

    // The hub goes away after the first file: that one is done, the second waits.
    const second = path.join(projects, 'D--demo-project', 'second.jsonl');
    fs.writeFileSync(
      second,
      userLine(NEW_EVENT.slice(12), 'Second session.', '2026-10-21T00:00:00.000Z'),
    );
    fs.utimesSync(second, new Date(), new Date(Date.now() + 60_000)); // the newer one, sent last
    let posts = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).includes('/v1/ingest') && ++posts > 1) throw new Error('connection reset');
      return fetch(input, init);
    };
    await expect(sync({ fetch: flaky })).rejects.toThrow(/connection reset/);
    expect(relayCursor(relayDb, 'claude-code', logFile)?.bytes).toBe(fs.statSync(logFile).size);
    expect(relayCursor(relayDb, 'claude-code', second)).toBeNull();
    expect(await sync()).toMatchObject({ files: 1, eventsAdded: 1 });
    expect(getEvent(main.db, NEW_EVENT)?.text).toBe('Second session.');
    expect(lastHubSync(relayDb, hub)).toMatchObject({ at: expect.any(Number), failure: null });
  });

  it('sends a rewritten log as a new generation', async () => {
    await sync();
    fs.writeFileSync(
      logFile,
      userLine(NEW_EVENT.slice(12), 'Starting over.', '2026-10-20T00:00:00.000Z'),
    );
    const r = await sync();
    expect(r.sources[0]).toMatchObject({ newGenerations: 1, eventsAdded: 1 });
    expect(remoteCursors(main.db, 'laptop').map((c) => c.generation)).toEqual([1, 2]);
    expect(getEvent(main.db, USER_EVENT)).not.toBeNull(); // the old generation stays
  });

  it("lets a relay's agents read and write through the hub, as this device", async () => {
    const relay = createRelayServer({
      device: 'laptop',
      hub: { url: hub.url, token: hub.token },
      sync: async () => {
        await sync();
      },
    });
    const agent = new Client({ name: 'agent-x', version: '1.0.0' });
    const [agentSide, relaySide] = InMemoryTransport.createLinkedPair();
    await Promise.all([agent.connect(agentSide), relay.mcp.connect(relaySide)]);
    try {
      // Said a moment ago: the write sends it to the hub first, so the quote can be cited.
      fs.appendFileSync(
        logFile,
        userLine(
          NEW_EVENT.slice(12),
          'Run Origin as a relay on the small VPS.',
          '2026-10-19T04:00:00.000Z',
        ),
      );
      const saved = json(
        await agent.callTool({
          name: 'remember',
          arguments: {
            kind: 'memory',
            text: 'The small VPS runs Origin as a relay.',
            confidence: 0.9,
            sources: [{ quote: 'relay on the small VPS' }],
          },
        }),
      );
      expect(saved.entry.author).toBe('agent-x@laptop');
      expect(getEntry(main.db, saved.entry.id)).toMatchObject({
        author: 'agent-x@laptop',
        origin: 'hub',
      });
      expect(listEntries(relayDb)).toEqual([]);

      const found = json(
        await agent.callTool({ name: 'search', arguments: { query: 'small VPS' } }),
      );
      expect(found.entries.map((e: { id: string }) => e.id)).toEqual([saved.entry.id]);
      expect(found.events.map((e: { id: string }) => e.id)).toEqual([NEW_EVENT]);

      // Forgetting happens on the hub; the relay has nothing to hide, and its cursors still move.
      await agent.callTool({ name: 'forget', arguments: { id: saved.entry.id } });
      expect(isEntryForgotten(main.db, saved.entry.id)).toBe(true);
      expect(await sync()).toMatchObject({ tombstonesApplied: 0, tombstonesPushed: 0 });
      expect(getSetting(relayDb, pulledKey(hub))).not.toBeNull();
      expect(count(relayDb, 'tombstone')).toBe(0);
    } finally {
      await agent.close();
      await relay.close();
    }
  });

  it('answers CLI commands on a relay from the hub, and corrects there as user@laptop', async () => {
    await sync();
    const found = (await askHub(hub, 'search', { query: '仓库' })) as SearchResult;
    expect(found.events.map((e) => e.id)).toEqual([USER_EVENT]);
    const entry = remember(main.db, {
      kind: 'memory',
      text: 'Checked the repository status.',
      confidence: 0.8,
      author: 'claude-code@laptop',
      sources: [{ eventId: USER_EVENT }],
    });
    const fixed = (await askHub(hub, 'correct', { id: entry.id, text: 'Checked the status.' })) as {
      entry: { id: string; author: string };
    };
    expect(fixed.entry.author).toBe('user@laptop');
    await expect(askHub(hub, 'get', { id: 'claude-code:nope' })).rejects.toThrow(
      /Unknown entry or event/,
    );

    // A hub that is gone: the command says that a relay has nothing else to ask.
    const gone = http.createServer();
    await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
    await new Promise((resolve) => gone.close(resolve));
    await expect(askHub({ ...hub, url }, 'search', { query: 'x' })).rejects.toThrow(
      /This store is a relay: it keeps no memory of its own and asks its hub, but the hub at .* is unreachable/,
    );
  });
});
