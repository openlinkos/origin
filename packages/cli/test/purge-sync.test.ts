import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  checkAuthorizationRequest,
  createAuthorizationCode,
  createToken,
  type Database,
  exchangeCode,
  getEntry,
  getEvent,
  getPurge,
  getRecall,
  getSetting,
  initStoreName,
  listEvents,
  listPurges,
  openDatabase,
  planRecall,
  purge,
  purgeFeed,
  recordRecall,
  registerClient,
  remember,
  searchEvents,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubConfig } from '../src/hub/config.js';
import { createHubServer } from '../src/hub/server.js';
import {
  type Call,
  type HubSyncResult,
  hubClient,
  pullPurges,
  purgesKey,
  syncWithHub,
} from '../src/hub/sync.js';
import { hubAdapters } from '../src/sources.js';

/**
 * A hub's purges going down to its devices over HTTP (GET /v1/purges), and what may never reach a
 * purge: device pushes, agents' tokens, and OAuth. On the synthetic Claude Code fixture only.
 */

const fixtures = fileURLToPath(
  new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
);
const SESSION = '0f1e2d3c-4b5a-4697-8877-665544332211';
const USER_EVENT = 'claude-code:22222222-2222-4222-8222-222222222222';

let tmp: string;
let hubHome: string;
let hubDb: Database;
let deviceDb: Database;
let deviceHome: string;
let server: http.Server;
let hub: HubConfig;
let replies: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purge-sync-'));
  hubHome = path.join(tmp, 'hub');
  deviceHome = path.join(tmp, 'device');
  hubDb = openDatabase(path.join(hubHome, 'origin.db'));
  deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
  initStoreName(deviceDb, 'laptop');
  const token = createToken(hubDb, 'laptop');
  server = createHubServer({
    db: hubDb,
    home: hubHome,
    adapters: [claudeCode()],
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
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  hubDb.close();
  deviceDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const claudeCode = () => createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') });
const sync = (over: Partial<Parameters<typeof syncWithHub>[0]> = {}) =>
  syncWithHub({ db: deviceDb, home: deviceHome, hub, ...over });
const onHub = { reason: 'pasted a secret', author: 'user@hub', channel: 'ui' as const };
const purgeOnHub = (ids: string[]) =>
  purge(hubDb, hubHome, hubAdapters([claudeCode()], hubHome), { kind: 'event', ids }, onHub);
const note = (db: Database, eventId: string, text: string) =>
  remember(db, {
    kind: 'knowledge',
    text,
    confidence: 0.8,
    author: 'claude-code@laptop',
    sources: [{ eventId }],
  });
const request = (pathname: string, token: string, method = 'GET') =>
  fetch(`${hub.url}${pathname}`, { method, headers: { Authorization: `Bearer ${token}` } });

describe('a hub purge reaching its device', () => {
  it('is applied at the next sync, before anything goes up, and nothing loops afterwards', async () => {
    const cited = note(deviceDb, USER_EVENT, 'The user checks the repository status first.');
    const kept = note(deviceDb, replies[1] as string, 'The working tree was clean.');
    await sync();
    expect(getEntry(hubDb, cited.id)).not.toBeNull();

    // Written on the device after its last sync, citing what the hub is about to purge.
    const late = note(deviceDb, USER_EVENT, 'The status check comes first, again.');
    const recalled = recordRecall(
      deviceDb,
      planRecall(deviceDb, {
        occasion: 'prompt',
        source: 'claude-code',
        sessionId: SESSION,
        prompt: 'repository status check',
      }),
    );
    expect(getRecall(deviceDb, recalled)?.items.map((i) => i.ref)).toContain(cited.id);

    const made = purgeOnHub([USER_EVENT]);
    expect(getEvent(hubDb, USER_EVENT)).toBeNull();
    expect(getEntry(hubDb, cited.id)).toBeNull(); // its chain cites the purged event

    const r = await sync();
    expect(r).toMatchObject({
      purgesApplied: 1,
      purgeError: null,
      refused: [],
      waiting: null,
      entriesPushed: 0, // the late entry went with the purge, here, before it was sent
      recallsPushed: 1,
    });
    expect(getEvent(deviceDb, USER_EVENT)).toBeNull();
    expect(searchEvents(deviceDb, 'checks the repository status')).toEqual([]);
    for (const id of [cited.id, late.id]) {
      expect(getEntry(deviceDb, id)).toBeNull();
      expect(getEntry(hubDb, id)).toBeNull();
    }
    expect(getEntry(deviceDb, kept.id)).not.toBeNull();
    expect(getPurge(deviceDb, made.id)).toMatchObject({
      origin: 'hub',
      author: 'user@hub',
      channel: 'hub',
      reason: 'pasted a secret',
    });
    expect(Number(getSetting(deviceDb, purgesKey(hub)))).toBe(listPurges(hubDb)[0]?.seq);
    // The recall went up without what was purged.
    expect(getRecall(hubDb, recalled)?.items.map((i) => i.ref)).not.toContain(cited.id);

    // Again: nothing to apply, and nothing to send.
    const again = await sync();
    expect(again).toMatchObject({
      purgesApplied: 0,
      purgeError: null,
      files: 0,
      bytes: 0,
      entriesPushed: 0,
      tombstonesPushed: 0,
      recallsPushed: 0,
      refused: [],
    });
    expect(listPurges(deviceDb)).toHaveLength(1);
  });

  it('goes on with the sync when a purge cannot be applied here, and applies it later', async () => {
    await sync();
    const made = purgeOnHub([USER_EVENT]);
    const failing = () => {
      throw new Error('no adapter here');
    };
    const r = await sync({ adapters: failing });
    expect(r.purgesApplied).toBe(0);
    expect(r.purgeError).toEqual({ id: made.id, error: 'no adapter here' });
    expect(getEvent(deviceDb, USER_EVENT)).not.toBeNull();
    expect(getSetting(deviceDb, purgesKey(hub))).toBeNull();

    expect(await sync()).toMatchObject({ purgesApplied: 1, purgeError: null });
    expect(getEvent(deviceDb, USER_EVENT)).toBeNull();
  });

  it('joins the pages of a large purge, and skips a hub from before purges', async () => {
    await sync();
    const made = purgeOnHub([USER_EVENT, replies[0] as string]);
    const result = { purgesApplied: 0, purgeError: null } as HubSyncResult;
    const asked: string[] = [];
    // The hub's feed, one id per page.
    const paged: Call = async (_method, pathname) => {
      asked.push(pathname);
      const q = new URL(pathname, 'http://hub').searchParams;
      return JSON.parse(
        JSON.stringify(
          purgeFeed(hubDb, {
            after: Number(q.get('after')),
            offset: Number(q.get('offset')),
            device: 'laptop',
            limit: 1,
          }),
        ),
      );
    };
    const opts = { db: deviceDb, home: deviceHome, hub };
    await pullPurges(opts, paged, result);
    expect(result.purgesApplied).toBe(1);
    expect(asked.length).toBeGreaterThan(2);
    // The two events, and what shares their lines, as on the hub.
    expect(made.record.counts.events).toBeGreaterThan(2);
    expect(getPurge(deviceDb, made.id)?.counts.events).toBe(made.record.counts.events);
    expect(getEvent(deviceDb, replies[0] as string)).toBeNull();

    const old: Call = async () => ({ error: 'Not found.' });
    const before = getSetting(deviceDb, purgesKey(hub));
    await pullPurges(opts, old, result);
    expect(getSetting(deviceDb, purgesKey(hub))).toBe(before);
  });

  it('counts the lines a writer sends again that a purge removed', async () => {
    const bot = createToken(hubDb, 'bot');
    const body = `${JSON.stringify({ id: 'n1', session: 'notes-1', time: '2026-10-20T08:00:00Z', role: 'user', kind: 'message', text: 'A synthetic note.' })}\n`;
    const send = () =>
      fetch(`${hub.url}/v1/sources/notes/lines?path=inbox.jsonl`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bot}`, 'Content-Type': 'application/x-ndjson' },
        body,
      });
    expect(await (await send()).json()).toMatchObject({ events: 1, purged: 0 });
    purgeOnHub(['notes:n1']);
    expect(await (await send()).json()).toEqual({
      lines: 1,
      events: 0,
      duplicates: 0,
      parse_errors: 0,
      purged: 1,
      errors: [],
    });
    expect(getEvent(hubDb, 'notes:n1')).toBeNull();
  });
});

/** An access token of an agent signed in by OAuth, which is for /mcp only. */
function oauthToken(): string {
  initStoreName(hubDb, 'hub');
  const client = registerClient(hubDb, {
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost:9/callback'],
  }).client;
  const verifier = 'v'.repeat(43);
  const check = checkAuthorizationRequest(
    hubDb,
    (k) =>
      ({
        client_id: client.id,
        redirect_uri: 'http://localhost:9/callback',
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })[k] ?? null,
    { resource: `${hub.url}/mcp`, issuer: hub.url },
  );
  if (!check.ok) throw new Error(check.description);
  const code = createAuthorizationCode(hubDb, check.request, { preset: 'readwrite', days: 30 });
  return exchangeCode(hubDb, { code, clientId: client.id, verifier }).access_token;
}

describe('who reaches the purge feed', () => {
  it('serves only GET, and only to a device with its own token', async () => {
    await sync();
    purgeOnHub([USER_EVENT]);
    const ok = await request('/v1/purges?after=0', hub.token);
    expect(ok.status).toBe(200);
    expect((await ok.json()).purge).toMatchObject({ origin: 'hub', author: 'user@hub' });
    expect((await request('/v1/purges?after=0&device=desk', hub.token)).status).toBe(403);
    expect((await request('/v1/purges?after=-1', hub.token)).status).toBe(400);
    expect((await request('/v1/purges?offset=x', hub.token)).status).toBe(400);

    // Nothing makes, sends, or deletes a purge through /v1.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await request('/v1/purges', hub.token, method)).status).toBe(404);
    }
    for (const p of ['/v1/purge', '/v1/purges/x', '/v1/purge-plan']) {
      expect((await request(p, hub.token, 'POST')).status).toBe(404);
    }

    // An agent's token, even one that may write, and an OAuth access token get nothing.
    const agent = createToken(hubDb, 'helper', Date.now(), { kind: 'agent' });
    const refused = await request('/v1/purges?after=0', agent);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).not.toContain('pasted a secret');
    expect((await request('/v1/purges?after=0', oauthToken())).status).toBe(403);
    expect(listPurges(hubDb)).toHaveLength(1);

    // A store connected with an agent's token still syncs, without the hub's purges.
    const viaAgent: HubConfig = { url: hub.url, token: agent, device: 'helper' };
    const said: string[] = [];
    const result = { purgesApplied: 0, purgeError: null } as HubSyncResult;
    await pullPurges(
      { db: deviceDb, home: deviceHome, hub: viaAgent, log: (m) => said.push(m) },
      hubClient({ db: deviceDb, home: deviceHome, hub: viaAgent }),
      result,
    );
    expect(result).toMatchObject({ purgesApplied: 0, purgeError: null });
    expect(said.join('\n')).toContain("Only a device's own token reads the hub's purges.");
    expect(getEvent(deviceDb, USER_EVENT)).not.toBeNull();
  });
});
