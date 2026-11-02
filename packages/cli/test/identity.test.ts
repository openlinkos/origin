import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkAuthorizationRequest,
  createAuthorizationCode,
  type Database,
  exchangeCode,
  getAdminUsername,
  initStoreName,
  listAudit,
  listGrants,
  openDatabase,
  registerClient,
  type ScryptParams,
  setAdminPassword,
  storeName,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browser } from '../../admin/test/helpers.js';
import { readHubConfig } from '../src/hub/config.js';
import { type RunningHub, startHub } from '../src/hub/serve.js';
import { main } from '../src/main.js';

/** The owner's identity on the command line: the username, tokens of devices and agents, grants. */

const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-identity-'));
  home = path.join(tmp, 'hub');
  saved = {
    ORIGIN_HOME: process.env.ORIGIN_HOME,
    ORIGIN_DEVICE: process.env.ORIGIN_DEVICE,
    ORIGIN_HUB_URL: process.env.ORIGIN_HUB_URL,
    ORIGIN_HUB_TOKEN: process.env.ORIGIN_HUB_TOKEN,
  };
  process.env.ORIGIN_HOME = home;
  delete process.env.ORIGIN_HUB_URL;
  delete process.env.ORIGIN_HUB_TOKEN;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function withStore<T>(fn: (db: Database) => T, at = home): T {
  const db = openDatabase(path.join(at, 'origin.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('origin admin username', () => {
  it('shows that none is set, sets one, and refuses one that is not valid', async () => {
    expect(await main(['admin', 'username'])).toBe(0);
    expect(out.join('\n')).toContain('No username yet');
    expect(await main(['admin', 'username', 'Dana'])).toBe(0);
    expect(out.join('\n')).toContain("The owner's username is now dana.");
    expect(await main(['admin', 'username', 'no spaces please'])).toBe(1);
    expect(err.join('\n')).toContain('Invalid username');
    out = [];
    expect(await main(['admin', 'username'])).toBe(0);
    expect(out).toEqual(['dana']);
    withStore((db) => {
      expect(getAdminUsername(db)).toBe('dana');
      expect(listAudit(db)[0]).toMatchObject({
        actor: 'cli',
        action: 'username.set',
        target: 'dana',
      });
    });
  });
});

describe('origin token', () => {
  it('creates tokens of devices and of agents with a preset, and lists and revokes agents signed in by browser', async () => {
    expect(await main(['token', 'create', 'laptop'])).toBe(0);
    expect(out.join('\n')).toContain('Token for the device laptop');
    expect(await main(['token', 'create', 'reader', '--agent', '--readonly'])).toBe(0);
    expect(out.join('\n')).toContain('Token for the agent reader, readonly');
    // An agent signed in by OAuth.
    withStore((db) => {
      initStoreName(db, 'hub');
      const client = registerClient(db, {
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:9/callback'],
      }).client;
      const verifier = 'v'.repeat(43);
      const check = checkAuthorizationRequest(
        db,
        (k) =>
          ({
            client_id: client.id,
            redirect_uri: 'http://localhost:9/callback',
            response_type: 'code',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
          })[k] ?? null,
        { resource: 'http://127.0.0.1:1/mcp', issuer: 'http://127.0.0.1:1' },
      );
      if (!check.ok) throw new Error(check.description);
      const code = createAuthorizationCode(db, check.request, { preset: 'readwrite', days: 30 });
      exchangeCode(db, { code, clientId: client.id, verifier });
    });
    out = [];
    expect(await main(['token', 'list'])).toBe(0);
    const list = out.join('\n');
    expect(list).toMatch(/laptop\s+device\s+readwrite/);
    expect(list).toMatch(/reader\s+agent\s+readonly/);
    expect(list).toContain('Agents signed in by browser (OAuth):');
    expect(list).toMatch(/claude-code\s+Claude Code\s+readwrite/);
    expect(await main(['token', 'revoke', 'claude-code'])).toBe(0);
    expect(out.join('\n')).toContain('Revoked claude-code (Claude Code, signed in by browser).');
    expect(await main(['token', 'revoke', 'claude-code'])).toBe(1);
    withStore((db) => {
      expect(listGrants(db)[0]).toMatchObject({ revokedBy: 'owner' });
      expect(listAudit(db).map((r) => [r.actor, r.action, r.target])).toEqual([
        ['cli', 'grant.revoke', 'claude-code'],
        ['cli', 'token.create', 'reader'],
        ['cli', 'token.create', 'laptop'],
      ]);
    });
  });
});

describe('origin hub connect without a token', () => {
  let hub: RunningHub;

  afterEach(async () => {
    await hub?.close();
  });

  it('prints where to approve the device, waits for the owner, and connects under the store’s name', async () => {
    const hubDb = openDatabase(path.join(home, 'origin.db'));
    await setAdminPassword(hubDb, PASSWORD, { params: FAST });
    hub = await startHub({
      db: hubDb,
      home,
      host: '127.0.0.1',
      port: 0,
      adapters: [],
      version: 'test',
      admin: { passwordParams: FAST },
    });
    const deviceHome = path.join(tmp, 'device');
    process.env.ORIGIN_HOME = deviceHome;
    process.env.ORIGIN_DEVICE = 'studio';
    // The owner approves as soon as the device shows its code.
    const approved = (async () => {
      for (;;) {
        const code = /enter the code ([A-Z]{4}-[A-Z]{4})/.exec(err.join('\n'))?.[1];
        if (code) {
          const b = new Browser(hub.url);
          await b.login(PASSWORD, 'dana');
          await b.get(`/admin/activate?code=${code}`);
          return b.post('/admin/activate', { code, decision: 'approve' });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    try {
      expect(await main(['hub', 'connect', hub.url])).toBe(0);
      expect((await approved).text).toContain('studio is connected');
      const said = err.join('\n');
      expect(said).toContain(`To connect studio to ${hub.url}, open this link`);
      expect(said).toContain(`${hub.url}/admin/activate?code=`);
      expect(out.join('\n')).toContain(`Connected to ${hub.url} as studio.`);
      const saved = readHubConfig(deviceHome);
      expect(saved?.token).toMatch(/^ogn_/);
      withStore((db) => expect(storeName(db)).toBe('studio'), deviceHome);
      expect(
        listAudit(hubDb)
          .slice(0, 2)
          .map((r) => [r.actor, r.action]),
      ).toEqual([
        ['studio', 'device.connect'],
        ['dana', 'device.approve'],
      ]);
    } finally {
      hubDb.close();
    }
  }, 20_000);
});
