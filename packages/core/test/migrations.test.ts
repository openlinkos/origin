import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupStore,
  createToken,
  FIRST_VERSION,
  getEntry,
  listAudit,
  listSessions,
  listTokens,
  type Migration,
  OriginError,
  openDatabase,
  openMemoryDatabase,
  rawLocator,
  readRawLine,
  recordAudit,
  remember,
  SqliteDatabase,
  STORE_VERSION,
  searchEvents,
  storeName,
  storeVersion,
  syncSource,
  threadIdOf,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';
import {
  downgradeToV5,
  downgradeToV6,
  downgradeToV10,
  legacyStore,
  schemaOf,
  store040,
  userVersion,
} from './legacy.js';

let tmp: string;
let home: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-migrate-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  file = path.join(home, 'origin.db');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Migrations 2, 3, and 4 that record the order they ran in, in a table of their own. */
function counted(runs: number[], fail?: number): Migration[] {
  return [2, 3, 4].map((version) => ({
    version,
    name: `step ${version}`,
    up: ({ db }) => {
      db.exec('CREATE TABLE IF NOT EXISTS step (version INTEGER PRIMARY KEY)');
      db.prepare('INSERT INTO step (version) VALUES (?)').run(version);
      runs.push(version);
      if (version === fail) throw new Error('disk on fire');
    },
  }));
}

/** A store of 0.1.0 with one source file of two lines, mirrored and ingested, and an entry. */
function makeLegacyStore(logs: string): void {
  fs.mkdirSync(logs, { recursive: true });
  const content = `${line('1', 's1', 1000, 'user', 'deploy the staging cluster')}${line('2', 's1', 2000, 'assistant', 'Deployed.')}`;
  const log = path.join(logs, 'a.jsonl');
  fs.writeFileSync(log, content);
  fs.mkdirSync(path.join(home, 'raw', 'fake'), { recursive: true });
  // The mirror: content this small is all in its open tail.
  fs.writeFileSync(path.join(home, 'raw', 'fake', 'a.jsonl.tail'), content);
  const db = legacyStore(file);
  const bytes = Buffer.byteLength(content);
  db.prepare(
    `INSERT INTO raw_file (id, source, path, generation, mirror, bytes_ingested, lines_ingested,
                           tail_hash, first_seen_at, updated_at)
     VALUES (1, 'fake', ?, 1, ?, ?, 2, ?, 1000, 2000)`,
  ).run(
    log,
    path.join('fake', 'a.jsonl'),
    bytes,
    createHash('sha256').update(content).digest('hex'),
  );
  const ev = db.prepare(
    `INSERT INTO event (id, source, session_id, ts, project, role, kind, text, raw_file_id, raw_line)
     VALUES (?, 'fake', 's1', ?, 'demo', ?, 'message', ?, 1, ?)`,
  );
  ev.run('fake:1', 1000, 'user', 'deploy the staging cluster', 1);
  ev.run('fake:2', 2000, 'assistant', 'Deployed.', 2);
  db.prepare(
    `INSERT INTO session (source, session_id, project, title, started_at, ended_at, event_count)
     VALUES ('fake', 's1', 'demo', 'Staging', 1000, 2000, 2)`,
  ).run();
  db.prepare(
    `INSERT INTO entry (id, kind, text, confidence, author, root, created_at, origin)
     VALUES ('ent_000000000001', 'memory', 'Staging was deployed.', 0.9, 'user@laptop', 'ent_000000000001', 3000, 'laptop')`,
  ).run();
  db.prepare(
    "INSERT INTO entry_source (entry_id, event_id, quote) VALUES ('ent_000000000001', 'fake:2', NULL)",
  ).run();
  db.prepare("INSERT INTO setting (key, value) VALUES ('store.name', 'laptop')").run();
  db.close();
}

describe('the format version', () => {
  it('is recorded in a new store, whose schema is that of 0.1.0 plus the migrations', () => {
    const fresh = openDatabase(file);
    expect(userVersion(fresh)).toBe(STORE_VERSION);
    expect(storeVersion(fresh)).toBe(STORE_VERSION);
    const legacyFile = path.join(tmp, 'legacy', 'origin.db');
    fs.mkdirSync(path.dirname(legacyFile));
    legacyStore(legacyFile).close();
    const upgraded = openDatabase(legacyFile);
    expect(userVersion(upgraded)).toBe(STORE_VERSION);
    expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
    upgraded.close();
    fresh.close();

    const memory = openMemoryDatabase();
    expect(userVersion(memory)).toBe(STORE_VERSION);
    memory.close();
  });

  it('tells a store of 0.1.0, which records none, from a new one', () => {
    const empty = new DatabaseSync(file);
    expect(storeVersion(new SqliteDatabase(empty))).toBe(0);
    empty.close();
    legacyStore(file).close();
    const legacy = new DatabaseSync(file);
    expect(userVersion(legacy)).toBe(0);
    expect(storeVersion(new SqliteDatabase(legacy))).toBe(FIRST_VERSION);
    legacy.close();
  });

  it('is kept by a backup', async () => {
    const db = openDatabase(file, { migrations: counted([]) });
    expect(userVersion(db)).toBe(4);
    await backupStore(db, home, path.join(tmp, 'backup'));
    db.close();
    const copy = new DatabaseSync(path.join(tmp, 'backup', 'origin.db'));
    expect(userVersion(copy)).toBe(4);
    copy.close();
  });
});

describe('a store of 0.1.0', () => {
  it('is upgraded in place and keeps everything it holds', async () => {
    const logs = path.join(tmp, 'logs');
    makeLegacyStore(logs);
    const db = openDatabase(file);
    expect(userVersion(db)).toBe(STORE_VERSION);
    expect(storeName(db)).toBe('laptop');
    expect(listSessions(db)).toMatchObject([{ sessionId: 's1', title: 'Staging', eventCount: 2 }]);
    const [hit] = searchEvents(db, 'staging');
    expect(hit?.id).toBe('fake:1');
    expect(readRawLine(db, home, rawLocator(db, home, hit!)!)).toContain('deploy the staging');
    expect(getEntry(db, 'ent_000000000001')).toMatchObject({ status: 'active' });
    const added = remember(db, {
      kind: 'knowledge',
      text: 'The cluster is called staging.',
      confidence: 1,
      author: 'user@laptop',
      sources: [{ eventId: 'fake:1' }],
    });
    expect(getEntry(db, added.id)).toMatchObject({ status: 'active' });

    // Ingestion goes on where 0.1.0 stopped: only the new line is read.
    fs.appendFileSync(
      path.join(logs, 'a.jsonl'),
      line('3', 's1', 3000, 'user', 'and production next week'),
    );
    const r = await syncSource({ db, home }, fakeAdapter(logs));
    expect(r).toMatchObject({ linesRead: 1, eventsAdded: 1, newGenerations: 0 });
    db.close();
  });

  it('runs each migration once, in order, each in its own transaction', () => {
    legacyStore(file).close();
    const runs: number[] = [];
    const db = openDatabase(file, { migrations: counted(runs) });
    expect(runs).toEqual([2, 3, 4]);
    expect(userVersion(db)).toBe(4);
    db.close();
    const again = openDatabase(file, { migrations: counted(runs) });
    expect(runs).toEqual([2, 3, 4]);
    expect(
      (
        again.prepare('SELECT version FROM step ORDER BY version').all() as Array<{
          version: number;
        }>
      ).map((r) => r.version),
    ).toEqual([2, 3, 4]);
    again.close();
  });

  it('keeps the migrations before one that fails, and runs that one again on the next open', () => {
    legacyStore(file).close();
    const runs: number[] = [];
    let message = '';
    try {
      openDatabase(file, { migrations: counted(runs, 3) });
    } catch (err) {
      expect(err).toBeInstanceOf(OriginError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/upgraded to version 3 \(step 3\): disk on fire/);
    const raw = new DatabaseSync(file);
    expect(userVersion(raw)).toBe(2);
    // Migration 3 rolled back with its version: only migration 2's row is there.
    expect(raw.prepare('SELECT version FROM step').all()).toEqual([{ version: 2 }]);
    raw.close();

    const db = openDatabase(file, { migrations: counted(runs) });
    expect(runs).toEqual([2, 3, 3, 4]);
    expect(userVersion(db)).toBe(4);
    db.close();
  });

  it('sets up what migrations need only when one runs', () => {
    legacyStore(file).close();
    let calls = 0;
    const beforeMigrate = () => void calls++;
    openDatabase(file, { migrations: counted([]), beforeMigrate }).close();
    expect(calls).toBe(1);
    openDatabase(file, { migrations: counted([]), beforeMigrate }).close();
    openDatabase(path.join(tmp, 'new.db'), { migrations: counted([]), beforeMigrate }).close();
    expect(calls).toBe(1);
  });

  it('gives a migration the adapters it was opened with, and fails clearly without', () => {
    legacyStore(file).close();
    const adapter = fakeAdapter(tmp);
    const needsFake: Migration[] = [
      { version: 2, name: 'parse again', up: (ctx) => void ctx.adapter('fake').parseLine },
    ];
    expect(() => openDatabase(file, { migrations: needsFake })).toThrow(
      /version 2 \(parse again\).*needs the fake adapter/,
    );
    const db = openDatabase(file, { migrations: needsFake, adapters: [adapter] });
    expect(userVersion(db)).toBe(2);
    db.close();
    // Or a lookup by id, which finds the adapter of any source the store may hold.
    legacyStore(path.join(tmp, 'other.db')).close();
    const asked: string[] = [];
    const lookup = (source: string) => {
      asked.push(source);
      return source === 'fake' ? adapter : null;
    };
    openDatabase(path.join(tmp, 'other.db'), { migrations: needsFake, adapters: lookup }).close();
    expect(asked).toEqual(['fake']);
  });
});

describe('a store of 0.4.0 (version 4)', () => {
  /** Three sessions on a work branch and one on main, and a recall, as 0.4.0 stored them. */
  function makeStore040(): void {
    const db = store040(file);
    db.prepare(
      `INSERT INTO raw_file (id, source, path, generation, mirror, bytes_ingested, lines_ingested,
                             tail_hash, first_seen_at, updated_at)
       VALUES (1, 'fake', '/logs/a.jsonl', 1, 'fake/a.jsonl', 0, 0, '', 1000, 1000)`,
    ).run();
    const ev = db.prepare(
      `INSERT INTO event (id, source, session_id, ts, project, git_branch, role, kind, text,
                          raw_file_id, raw_line)
       VALUES (?, 'fake', ?, ?, 'demo', ?, ?, 'message', ?, 1, ?)`,
    );
    const day = 86_400_000;
    const rows: Array<[string, string, number, string | null]> = [
      ['a1', 's1', 1 * day, 'feat-x'],
      ['a2', 's1', 1 * day + 5, 'feat-x'],
      ['b1', 's2', 3 * day, 'main'],
      ['b2', 's2', 3 * day + 5, 'feat-x'],
      ['b3', 's2', 3 * day + 9, 'feat-x'],
      ['c1', 's3', 4 * day, 'main'],
      ['c2', 's3', 4 * day + 5, 'main'],
      ['d1', 's4', 5 * day, null],
    ];
    rows.forEach(([id, session, ts, branch], i) => {
      ev.run(`fake:${id}`, session, ts, branch, i % 2 ? 'assistant' : 'user', `text ${id}`, i + 1);
    });
    for (const s of ['s1', 's2', 's3', 's4']) {
      db.prepare(
        `INSERT INTO session (source, session_id, project, started_at, ended_at, event_count)
         SELECT 'fake', ?, 'demo', MIN(ts), MAX(ts), COUNT(*) FROM event WHERE session_id = ?`,
      ).run(s, s);
    }
    db.prepare(
      `INSERT INTO recall (id, at, origin, occasion, budget, tokens)
       VALUES ('rcl_000000000001', 1000, 'laptop', 'start', 800, 40)`,
    ).run();
    db.prepare(
      `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
       VALUES ('rcl_000000000001', 1, 'sessions', 'session', 'fake:s1', NULL, 20)`,
    ).run();
    db.close();
  }

  it('gets session branches, threads, and recall items that name a thread (version 5)', () => {
    makeStore040();
    const db = openDatabase(file);
    expect(userVersion(db)).toBe(STORE_VERSION);
    const branches = db
      .prepare('SELECT session_id, git_branch FROM session ORDER BY session_id')
      .all();
    expect(branches).toEqual([
      { session_id: 's1', git_branch: 'feat-x' },
      { session_id: 's2', git_branch: 'feat-x' },
      { session_id: 's3', git_branch: 'main' },
      { session_id: 's4', git_branch: null },
    ]);
    const thread = threadIdOf('fake', 's1');
    expect(listSessions(db, { since: 0 }).map((s) => [s.sessionId, s.thread])).toEqual([
      ['s4', null],
      ['s3', null],
      ['s2', thread],
      ['s1', thread],
    ]);
    // Recall items kept, and a thread can be an item now.
    expect(db.prepare('SELECT ref FROM recall_item').all()).toEqual([{ ref: 'fake:s1' }]);
    db.prepare(
      `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
       VALUES ('rcl_000000000001', 2, 'sessions', 'thread', ?, NULL, 20)`,
    ).run(thread);
    expect(() => db.prepare('DELETE FROM recall_item').run()).toThrow(/append-only/);
    const fresh = openDatabase(path.join(tmp, 'fresh.db'));
    expect(schemaOf(db)).toEqual(schemaOf(fresh));
    fresh.close();
    db.close();
  });
});

describe('a store of version 5', () => {
  it('gets the proposals of the tool results it already holds (version 6)', async () => {
    // A hub that received a device's lines before it was upgraded: the result of `propose` is
    // archived, but no proposal was derived from it.
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(logs);
    const result = JSON.stringify(
      {
        proposal: 'prp_0000000000a1',
        kind: 'cognition',
        text: 'Prefers small, runnable increments.',
        confidence: 0.6,
        project: null,
        valid_from: null,
        valid_to: null,
        note: null,
        sources: [{ event_id: 'fake:1', quote: 'small increments' }],
      },
      null,
      2,
    );
    fs.writeFileSync(
      path.join(logs, 'a.jsonl'),
      `${line('1', 's1', 1000, 'user', 'I like small increments that run.')}${line('2', 's1', 2000, 'user', result, 'tool_result')}`,
    );
    let db = openDatabase(file);
    await syncSource({ db, home }, fakeAdapter(logs));
    const derived = {
      proposals: db.prepare('SELECT * FROM proposal').all(),
      sources: db.prepare('SELECT * FROM proposal_source').all(),
    };
    expect(derived.proposals).toHaveLength(1);
    db.close();
    downgradeToV5(file);
    const v5 = new DatabaseSync(file);
    expect(userVersion(v5)).toBe(5);
    expect(v5.prepare("SELECT 1 FROM sqlite_master WHERE name = 'proposal'").get()).toBeUndefined();
    v5.close();

    db = openDatabase(file);
    expect(userVersion(db)).toBe(STORE_VERSION);
    expect(STORE_VERSION).toBe(11);
    expect({
      proposals: db.prepare('SELECT * FROM proposal').all(),
      sources: db.prepare('SELECT * FROM proposal_source').all(),
    }).toEqual(derived);
    const fresh = openDatabase(path.join(tmp, 'fresh.db'));
    expect(schemaOf(db)).toEqual(schemaOf(fresh));
    fresh.close();
    db.close();
  });
});

describe('a store of version 6', () => {
  it('makes each token a device or an agent, readwrite, and audits the hub API (version 7)', () => {
    let db = openDatabase(file);
    for (const name of ['laptop', 'bot', 'ci', 'fresh', 'desk']) createToken(db, name, 1000);
    const used = db.prepare('UPDATE api_token SET last_used_at = 2000 WHERE name = ?');
    for (const name of ['laptop', 'bot', 'ci', 'desk']) used.run(name);
    const file_ = db.prepare(
      `INSERT INTO raw_file (source, path, generation, mirror, bytes_ingested, first_seen_at, updated_at)
       VALUES (?, ?, 1, ?, 0, 1, 1)`,
    );
    // Pushed from a device's disk, and lines a program appended under its token.
    file_.run(
      'claude-code',
      `@laptop:${['C:', 'Users', 'dana', '.claude', 'projects', 'p', 's.jsonl'].join('\\')}`,
      'devices/laptop/a',
    );
    file_.run('chat-ops', '@bot:incidents.jsonl', 'devices/bot/b');
    db.prepare(
      `INSERT INTO entry (id, kind, text, confidence, author, root, created_at, origin)
       VALUES ('ent_00000000000d', 'memory', 'From the desk.', 1, 'user@desk', 'ent_00000000000d', 3000, 'desk')`,
    ).run();
    recordAudit(db, { actor: 'owner', channel: 'ui', action: 'login' }, 4000);
    db.close();
    downgradeToV6(file);
    const v6 = new DatabaseSync(file);
    expect(userVersion(v6)).toBe(6);
    expect(() =>
      v6
        .prepare("INSERT INTO audit_log (at, actor, channel, action) VALUES (1, 'x', 'api', 'y')")
        .run(),
    ).toThrow(/CHECK/);
    v6.close();

    db = openDatabase(file);
    expect(userVersion(db)).toBe(STORE_VERSION);
    expect(
      Object.fromEntries(listTokens(db).map((t) => [t.name, `${t.kind} ${t.preset}`])),
    ).toEqual({
      bot: 'agent readwrite',
      ci: 'agent readwrite',
      desk: 'device readwrite',
      fresh: 'device readwrite',
      laptop: 'device readwrite',
    });
    recordAudit(db, { actor: 'dana / ci', channel: 'api', action: 'grant.revoke' }, 5000);
    expect(listAudit(db).map((r) => [r.channel, r.action])).toEqual([
      ['api', 'grant.revoke'],
      ['ui', 'login'],
    ]);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    const fresh = openDatabase(path.join(tmp, 'fresh.db'));
    expect(schemaOf(db)).toEqual(schemaOf(fresh));
    fresh.close();
    db.close();
  });
});

describe('a store of version 10', () => {
  it('keeps its recall items, which can now be past messages with an excerpt (version 11)', () => {
    let db = openDatabase(file);
    db.prepare(
      `INSERT INTO recall (id, at, origin, occasion, budget, tokens)
       VALUES ('rcl_000000000001', 1000, 'laptop', 'prompt', 400, 60)`,
    ).run();
    const item = db.prepare(
      `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
       VALUES ('rcl_000000000001', ?, ?, ?, ?, ?, 20)`,
    );
    item.run(1, 'prompt', 'entry', 'ent_000000000001', 2.5);
    item.run(2, 'sessions', 'thread', 'thr_0123456789ab', null);
    const before = db.prepare('SELECT * FROM recall_item ORDER BY rank').all();
    db.close();
    downgradeToV10(file);
    const v10 = new DatabaseSync(file);
    expect(userVersion(v10)).toBe(10);
    expect(() =>
      v10
        .prepare(
          `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
           VALUES ('rcl_000000000001', 3, 'messages', 'event', 'fake:1', 1, 20)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    v10.close();

    const logged: string[] = [];
    db = openDatabase(file, { log: (m) => logged.push(m) });
    expect(userVersion(db)).toBe(STORE_VERSION);
    expect(STORE_VERSION).toBe(11);
    expect(logged.join('\n')).toMatch(/Upgrading the store to version 11/);
    // Every row kept, with no excerpt.
    expect(db.prepare('SELECT * FROM recall_item ORDER BY rank').all()).toEqual(before);
    expect(before).toEqual([
      expect.objectContaining({ rank: 1, kind: 'entry', excerpt: null }),
      expect.objectContaining({ rank: 2, kind: 'thread', excerpt: null }),
    ]);
    // A past message, with where its excerpt starts; no other kind has one.
    db.prepare(
      `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens, excerpt)
       VALUES ('rcl_000000000001', 3, 'messages', 'event', 'fake:1', 1.5, 20, 42)`,
    ).run();
    const bad = db.prepare(
      `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens, excerpt)
       VALUES ('rcl_000000000001', 4, ?, ?, 'x', NULL, 1, ?)`,
    );
    expect(() => bad.run('prompt', 'entry', 3)).toThrow(/CHECK/);
    expect(() => bad.run('messages', 'event', -1)).toThrow(/CHECK/);
    expect(() => bad.run('later', 'event', null)).toThrow(/CHECK/);
    expect(db.prepare('SELECT ref, excerpt FROM recall_item WHERE kind = ?').get('event')).toEqual({
      ref: 'fake:1',
      excerpt: 42,
    });
    expect(() => db.prepare('UPDATE recall_item SET excerpt = 1').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM recall_item').run()).toThrow(/append-only/);
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'recall_item_ref'")
        .get(),
    ).toBeDefined();
    const fresh = openDatabase(path.join(tmp, 'fresh.db'));
    expect(schemaOf(db)).toEqual(schemaOf(fresh));
    fresh.close();
    db.close();
  });
});

describe('a store of a newer Origin', () => {
  it('is refused, and left as it is', () => {
    const newer = new DatabaseSync(file);
    newer.exec(`PRAGMA user_version = ${STORE_VERSION + 1}`);
    newer.close();
    expect(() => openDatabase(file)).toThrow(
      new RegExp(
        `format version ${STORE_VERSION + 1}, but this Origin knows versions up to ${STORE_VERSION} only`,
      ),
    );
    const raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()).toEqual({ n: 0 });
    expect(userVersion(raw)).toBe(STORE_VERSION + 1);
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    raw.close();

    // A store this code would have to go back for, after a newer one migrated it.
    const other = path.join(tmp, 'other.db');
    const beyond: Migration[] = Array.from({ length: STORE_VERSION }, (_, i) => ({
      version: i + 2,
      name: `step ${i + 2}`,
      up: () => {},
    }));
    openDatabase(other, { migrations: beyond }).close();
    expect(() => openDatabase(other)).toThrow(OriginError);
  });
});

describe('several processes opening a store at once', () => {
  const script = fileURLToPath(new URL('./fixtures/migrate-elsewhere.mjs', import.meta.url));
  const migration2: Migration = {
    version: 2,
    name: 'who migrated',
    up: ({ db }) => {
      db.exec('CREATE TABLE migrated_by (who TEXT NOT NULL)');
      db.exec("INSERT INTO migrated_by VALUES ('this process')");
    },
  };

  /** Start the other process and wait until it holds the write lock. */
  async function otherProcess(mode: 'migrate' | 'crash') {
    const child = fork(script, [file, mode, '400'], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`exited early (${code})`)));
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { exited };
  }

  it('lets one run a migration while the others wait and then find it done', async () => {
    const setup = openDatabase(file, { migrations: [] });
    setup.close();
    const other = await otherProcess('migrate');
    // Blocks until the other process has committed: then version 2 is there, and nothing reruns.
    const db = openDatabase(file, { migrations: [migration2] });
    expect(await other.exited).toBe(0);
    expect(userVersion(db)).toBe(2);
    expect(db.prepare('SELECT who FROM migrated_by').all()).toEqual([{ who: 'other process' }]);
    db.close();
  });

  it('runs a migration that another process started and never committed', async () => {
    openDatabase(file, { migrations: [] }).close();
    const other = await otherProcess('crash');
    const db = openDatabase(file, { migrations: [migration2] });
    expect(await other.exited).toBe(3);
    expect(userVersion(db)).toBe(2);
    expect(db.prepare('SELECT who FROM migrated_by').all()).toEqual([{ who: 'this process' }]);
    db.close();
  });
});
