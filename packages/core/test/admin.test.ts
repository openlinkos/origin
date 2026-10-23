import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_FRESH_MS,
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_MAX_MS,
  appendRemote,
  createAdminSession,
  type Database,
  deviceFiles,
  endAdminSession,
  endAdminSessions,
  entriesCiting,
  forget,
  getAdminSession,
  getSession,
  ingestHealth,
  isAdminSessionFresh,
  listAdminSessions,
  listAudit,
  listEntries,
  listEvents,
  listSessions,
  listTombstones,
  markAdminSessionFresh,
  openDatabase,
  recordAudit,
  remember,
  storeName,
  storeUsage,
  syncSource,
  tombstoneCount,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let dirs: string[];
let home: string;
let db: Database;

const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  dirs = [];
  home = tmp('origin-admin-');
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('admin sessions', () => {
  it('store only a hash of the id and expire when idle or too old', () => {
    const t0 = 1_000_000;
    const { id, session } = createAdminSession(db, { ip: '127.0.0.1', userAgent: 'test' }, t0);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM admin_session').all())).not.toContain(id);
    expect(session.idHash).toBe(sha256(id));
    expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The key_name column predates the single password: it holds the owner.
    expect(db.prepare('SELECT key_name FROM admin_session').get()).toEqual({ key_name: 'owner' });

    expect(getAdminSession(db, id, { now: t0 + 1000 })?.handle).toBe(session.handle);
    expect(getAdminSession(db, 'nope', { now: t0 })).toBeNull();
    // Idle: no request for 30 minutes.
    expect(getAdminSession(db, id, { now: t0 + ADMIN_SESSION_IDLE_MS + 1 })).toBeNull();

    // Absolute: active all along, but older than 12 hours.
    const second = createAdminSession(db, {}, t0);
    let now = t0;
    while (now < t0 + ADMIN_SESSION_MAX_MS - ADMIN_SESSION_IDLE_MS) {
      now += ADMIN_SESSION_IDLE_MS / 2;
      expect(getAdminSession(db, second.id, { now })).not.toBeNull();
    }
    expect(getAdminSession(db, second.id, { now: t0 + ADMIN_SESSION_MAX_MS })).toBeNull();
  });

  it('track freshness and end on sign-out', () => {
    const t0 = 5_000_000;
    const a = createAdminSession(db, {}, t0);
    const b = createAdminSession(db, {}, t0);

    expect(isAdminSessionFresh(a.session, t0 + ADMIN_FRESH_MS)).toBe(true);
    expect(isAdminSessionFresh(a.session, t0 + ADMIN_FRESH_MS + 1)).toBe(false);
    markAdminSessionFresh(db, a.session.idHash, t0 + ADMIN_FRESH_MS + 1);
    const refreshed = getAdminSession(db, a.id, { now: t0 + ADMIN_FRESH_MS + 2 });
    expect(refreshed && isAdminSessionFresh(refreshed, t0 + ADMIN_FRESH_MS + 2)).toBe(true);

    expect(listAdminSessions(db, { now: t0 + 1 })).toHaveLength(2);
    expect(endAdminSession(db, b.session.idHash, t0 + 1)).toBe(true);
    expect(endAdminSession(db, b.session.idHash, t0 + 1)).toBe(false);
    expect(getAdminSession(db, b.id, { now: t0 + 2 })).toBeNull();
    expect(listAdminSessions(db, { now: t0 + 4 }).map((s) => s.handle)).toEqual([a.session.handle]);
    // Listing never exposes the id hash or the CSRF token.
    expect(Object.keys(listAdminSessions(db, { now: t0 + 4 })[0] ?? {})).not.toContain('csrf');
    expect(Object.keys(listAdminSessions(db, { now: t0 + 4 })[0] ?? {})).not.toContain('idHash');
  });

  it('can all be ended except the caller, or one by its handle', () => {
    const t0 = 9_000_000;
    const mine = createAdminSession(db, {}, t0);
    const other = createAdminSession(db, {}, t0);
    createAdminSession(db, {}, t0);
    createAdminSession(db, {}, t0);
    expect(endAdminSessions(db, { handle: 'not-a-handle' }, t0 + 1)).toBe(0);
    expect(endAdminSessions(db, { handle: other.session.handle }, t0 + 1)).toBe(1);
    expect(endAdminSessions(db, { exceptIdHash: mine.session.idHash }, t0 + 1)).toBe(2);
    expect(getAdminSession(db, mine.id, { now: t0 + 2 })).not.toBeNull();
    expect(endAdminSessions(db, {}, t0 + 3)).toBe(1);
    expect(listAdminSessions(db, { now: t0 + 4 })).toEqual([]);
  });

  it('from earlier versions, signed in with a named key, are not valid', () => {
    const t0 = 2_000_000;
    const { id } = createAdminSession(db, {}, t0);
    db.prepare("UPDATE admin_session SET key_name = 'laptop-key'").run();
    expect(getAdminSession(db, id, { now: t0 + 1 })).toBeNull();
    expect(listAdminSessions(db, { now: t0 + 1 })).toEqual([]);
  });
});

describe('audit log', () => {
  it('is append-only', () => {
    const id = recordAudit(
      db,
      {
        actor: 'owner',
        channel: 'ui',
        action: 'token.create',
        target: 'laptop',
        detail: { count: 1 },
        ip: '127.0.0.1',
        userAgent: 'test',
      },
      1234,
    );
    recordAudit(db, { actor: 'cli', channel: 'cli', action: 'token.revoke', target: 'laptop' });
    expect(listAudit(db)).toMatchObject([
      { action: 'token.revoke', channel: 'cli', detail: null },
      { id, at: 1234, actor: 'owner', detail: { count: 1 }, userAgent: 'test' },
    ]);
    expect(listAudit(db, { beforeId: id + 1 }).map((r) => r.id)).toEqual([id]);
    expect(() => db.prepare("UPDATE audit_log SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(() => recordAudit(db, { actor: 'x', channel: 'web' as 'ui', action: 'x' })).toThrow();
    expect(listAudit(db)).toHaveLength(2);
  });
});

describe('overview helpers', () => {
  async function seed() {
    const src = tmp('origin-src-');
    fs.writeFileSync(
      path.join(src, 's1.jsonl'),
      line('e1', 's1', 1000, 'user', 'We picked SQLite for the store.') +
        line('e2', 's1', 2000, 'assistant', 'Noted: SQLite, WAL mode.') +
        line('e3', 's1', 3000, 'assistant', 'ls -la', 'tool_use') +
        'not json\n',
    );
    await syncSource({ db, home }, fakeAdapter(src));
  }

  it('report storage, ingestion health, and device files', async () => {
    await seed();
    const usage = storeUsage(db, home);
    expect(usage.databaseBytes).toBeGreaterThan(0);
    expect(usage.mirrorBytes.local).toBeGreaterThan(0);
    expect(usage.mirrorBytes.remote).toBe(0);
    expect(usage.freeDiskBytes === null || usage.freeDiskBytes > 0).toBe(true);

    const adapter = fakeAdapter(tmp('origin-none-'));
    appendRemote({ db, home }, adapter, {
      device: 'laptop',
      source: 'fake',
      path: '/home/me/s2.jsonl',
      relPath: 's2.jsonl',
      generation: 1,
      offset: 0,
      data: Buffer.from(`${line('r1', 's2', 4000, 'user', 'remote line')}oops\n`),
    });
    expect(storeUsage(db, home).mirrorBytes.remote).toBeGreaterThan(0);

    const health = ingestHealth(db, { since: 0 });
    expect(health).toMatchObject([
      { source: 'fake', device: null, parseErrors: 1, eventsAdded: 3 },
      { source: 'fake', device: 'laptop', parseErrors: 1, eventsAdded: 1 },
    ]);
    expect(ingestHealth(db, { since: 0, device: 'laptop' })).toHaveLength(1);
    expect(ingestHealth(db, { since: Date.now() + 60_000 })).toEqual([]);

    expect(deviceFiles(db, 'laptop')).toMatchObject([
      { source: 'fake', originalPath: '/home/me/s2.jsonl', generation: 1, lines: 2 },
    ]);
    expect(deviceFiles(db, 'other')).toEqual([]);
  });

  it('list tombstones with counts only, citing entries, sessions, and pages', async () => {
    await seed();
    const entry = remember(db, {
      kind: 'knowledge',
      text: 'The store is SQLite.',
      confidence: 0.9,
      author: 'test',
      sources: [{ eventId: 'fake:e1' }],
    });
    expect(entriesCiting(db, 'fake:e1').map((e) => e.id)).toEqual([entry.id]);
    expect(entriesCiting(db, 'fake:e2')).toEqual([]);

    expect(getSession(db, 'fake', 's1')).toMatchObject({ eventCount: 3 });
    expect(getSession(db, 'fake', 'missing')).toBeNull();
    expect(listEvents(db, { sessionId: 's1', limit: 1, offset: 1 }).map((e) => e.id)).toEqual([
      'fake:e2',
    ]);
    expect(listSessions(db, { offset: 1 })).toEqual([]);
    expect(listEntries(db, { offset: 1 })).toEqual([]);

    const r = forget(db, 'fake:e1', { reason: 'pasted by mistake', author: 'user@test' }, 5000);
    expect(tombstoneCount(db)).toBe(1);
    const [t] = listTombstones(db);
    expect(t).toEqual({
      id: r.tombstoneId,
      kind: 'forget',
      target: 'fake:e1',
      reason: 'pasted by mistake',
      createdAt: 5000,
      origin: storeName(db),
      author: 'user@test',
      inEffect: true,
      restoredBy: [],
      entries: 1,
      events: 1,
    });
    expect(t?.id).toMatch(/^tmb_[0-9a-f]{12}$/);
    expect(listTombstones(db, { before: t!.id })).toEqual([]);
    expect(entriesCiting(db, 'fake:e1')).toEqual([]);

    const second = forget(db, 'fake:e2', { reason: 'test' });
    forget(db, 'fake:e3', { reason: 'test' });
    expect(getSession(db, 'fake', 's1')).toBeNull();
    expect(listTombstones(db).map((x) => x.target)).toEqual(['fake:e3', 'fake:e2', 'fake:e1']);
    expect(listTombstones(db, { before: second.tombstoneId!, limit: 5 })).toHaveLength(1);
  });
});
