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
  FIRST_VERSION,
  getEntry,
  listSessions,
  type Migration,
  OriginError,
  openDatabase,
  openMemoryDatabase,
  rawLocator,
  readRawLine,
  remember,
  STORE_VERSION,
  searchEvents,
  storeName,
  storeVersion,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';
import { legacyStore, schemaOf, userVersion } from './legacy.js';

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
    expect(storeVersion(empty)).toBe(0);
    empty.close();
    legacyStore(file).close();
    const legacy = new DatabaseSync(file);
    expect(userVersion(legacy)).toBe(0);
    expect(storeVersion(legacy)).toBe(FIRST_VERSION);
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
    openDatabase(other, { migrations: counted([]) }).close();
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
