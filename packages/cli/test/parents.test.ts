import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZCodeAdapter } from '@openlinkos/origin-adapters';
import {
  dbPath,
  getSession,
  getSessionParent,
  openDatabase,
  readMirror,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import { main } from '../src/main.js';

const T0 = Date.parse('2026-10-20T01:00:00Z');

let tmp: string;
let home: string;
let saved: string | undefined;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-parents-'));
  home = path.join(tmp, 'home');
  saved = process.env.ORIGIN_HOME;
  process.env.ORIGIN_HOME = home;
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
  if (saved === undefined) delete process.env.ORIGIN_HOME;
  else process.env.ORIGIN_HOME = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function zcodeFile(): string {
  const file = path.join(tmp, 'zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id text primary key, project_id text not null, parent_id text,
      directory text not null, title text not null, version text not null,
      task_type text not null default 'interactive', time_created integer not null,
      time_updated integer not null);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null,
      sequence integer);
  `);
  const session = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, title, version, task_type,
                          time_created, time_updated)
     VALUES (?, 'prj_1', ?, '/home/dev/demo-app', ?, '0.16.9', ?, ?, ?)`,
  );
  const message = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  const part = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  );
  const add = (id: string, parent: string | null, title: string, task: string) => {
    session.run(id, parent, title, task, T0, T0);
    message.run(`msg_${id}`, id, T0, T0, JSON.stringify({ role: 'user' }));
    part.run(`prt_${id}`, `msg_${id}`, id, T0, T0, JSON.stringify({ type: 'text', text: 'Go.' }));
  };
  add('ses_child', 'ses_parent', 'actor#1@2', 'workflow_child');
  add('ses_plain', null, 'Plain', 'interactive');
  db.close();
  return file;
}

describe('origin sessions parents', () => {
  it('appends run groups and Grok parents the mirror does not already hold', async () => {
    const file = zcodeFile();
    const grok = path.join(tmp, 'grok');
    const summary = (id: string, body: unknown) => {
      const dir = path.join(grok, 'sessions', 'group', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(body));
    };
    const db = openDatabase(dbPath(home));
    await syncSource(
      { db, home },
      createZCodeAdapter({
        home: path.dirname(path.dirname(path.dirname(file))),
        now: () => T0 + 60_000,
        keepOpenMs: 0,
        settleMs: 0,
      }),
    );
    expect(getSessionParent(db, 'zcode', 'ses_child')).toMatchObject({
      parentSessionId: 'ses_parent',
      runGroup: null,
      runName: null,
      signal: 'parent_id',
    });
    expect(getSessionParent(db, 'zcode', 'ses_plain')).toBeNull();
    expect(getSession(db, 'zcode', 'ses_child')?.title).toBe('actor#1@2');
    db.prepare(
      `INSERT INTO session (source, session_id, title, event_count, started_at, ended_at)
       VALUES ('grok', 'child-g', 'Explore', 1, 1, 2)`,
    ).run();
    db.close();

    const zdb = new DatabaseSync(file);
    zdb.exec(`
      CREATE TABLE dwf_run (
        id text primary key, name text, resumed_from text,
        time_created integer not null, time_updated integer not null);
      CREATE TABLE dwf_actor (
        id integer primary key autoincrement, run_id text not null,
        site_id text not null, ordinal integer not null, session_id text,
        time_created integer not null, time_updated integer not null);
    `);
    zdb
      .prepare(
        `INSERT INTO dwf_run (id, name, resumed_from, time_created, time_updated)
         VALUES ('run_root', 'Older', NULL, ?, ?), ('run_step', 'Ship', 'run_root', ?, ?)`,
      )
      .run(T0, T0, T0, T0);
    const actor = zdb.prepare(
      `INSERT INTO dwf_actor (run_id, site_id, ordinal, session_id, time_created, time_updated)
       VALUES ('run_step', 'site', 0, ?, ?, ?)`,
    );
    actor.run('ses_child', T0, T0);
    actor.run('ses_plain', T0, T0);
    actor.run('ses_unknown', T0, T0);
    zdb
      .prepare(
        "UPDATE session SET parent_id = 'ses_parent', task_type = 'workflow_child' WHERE id = 'ses_plain'",
      )
      .run();
    zdb.close();
    summary('child-g', { parent_session_id: 'parent-g', generated_title: 'Explore' });
    summary('missing', { parent_session_id: 'parent-g' });

    const flags = ['--zcode-db', file, '--grok-home', grok];
    expect(await main(['sessions', 'parents', '--dry-run', ...flags])).toBe(0);
    expect(out.join('\n')).toContain('ZCode: would append 2 parent lines.');
    expect(out.join('\n')).toContain('Grok: would append 1 parent line.');
    let check = openDatabase(dbPath(home));
    expect(
      check.prepare("SELECT COUNT(*) AS n FROM raw_file WHERE path = 'places.jsonl'").get(),
    ).toEqual({ n: 0 });
    expect(getSessionParent(check, 'zcode', 'ses_child')?.runGroup).toBeNull();
    check.close();

    out.length = 0;
    expect(await main(['sessions', 'parents', ...flags])).toBe(0);
    expect(out.join('\n')).toContain('ZCode: appended 2 parent lines.');
    expect(out.join('\n')).toContain('Grok: appended 1 parent line.');
    check = openDatabase(dbPath(home));
    expect(getSession(check, 'zcode', 'ses_child')?.title).toBe('actor#1@2');
    expect(getSessionParent(check, 'zcode', 'ses_child')).toMatchObject({
      parentSessionId: 'ses_parent',
      runGroup: 'run_root',
      runName: 'Ship',
      signal: 'parent_id',
    });
    expect(getSessionParent(check, 'zcode', 'ses_plain')).toMatchObject({
      parentSessionId: 'ses_parent',
      via: 'workflow',
      runGroup: 'run_root',
      runName: 'Ship',
      signal: 'dwf_run',
    });
    expect(getSessionParent(check, 'grok', 'child-g')).toMatchObject({
      parentSessionId: 'parent-g',
      via: 'subagent',
      signal: 'parent_session_id',
    });
    expect(getSessionParent(check, 'zcode', 'ses_unknown')).toBeNull();
    const places = (source: string) => {
      const raw = check
        .prepare(
          "SELECT id, bytes_ingested AS bytes FROM raw_file WHERE source = ? AND path = 'places.jsonl'",
        )
        .get(source) as { id: number; bytes: number };
      return readMirror(check, home, raw.id, 0, raw.bytes).toString('utf8').trim().split('\n');
    };
    expect(places('zcode')).toHaveLength(2);
    expect(places('grok')).toEqual([
      JSON.stringify({
        v: 1,
        type: 'parent',
        session: 'child-g',
        parent: 'parent-g',
        via: 'subagent',
        signal: 'parent_session_id',
      }),
    ]);
    check.close();

    out.length = 0;
    expect(await main(['sessions', 'parents', ...flags])).toBe(0);
    expect(out.join('\n')).toContain('ZCode: appended 0 parent lines.');
    expect(out.join('\n')).toContain('Grok: appended 0 parent lines.');
  });

  it('says when the given homes are missing and writes nothing', async () => {
    const missingDb = path.join(tmp, 'no-such.sqlite');
    const missingGrok = path.join(tmp, 'no-grok');
    expect(
      await main(['sessions', 'parents', '--zcode-db', missingDb, '--grok-home', missingGrok]),
    ).toBe(0);
    expect(out.join('\n')).toContain('ZCode database not found; skipped.');
    expect(out.join('\n')).toContain('Grok sessions directory not found; skipped.');
    expect(fs.existsSync(missingDb)).toBe(false);
    expect(fs.existsSync(missingGrok)).toBe(false);
  });
});

describe('origin timeline --children', () => {
  it('lists a child session only with --children', async () => {
    const grok = path.join(tmp, 'grok');
    const zcode = path.join(tmp, 'zcode');
    fs.mkdirSync(grok);
    fs.mkdirSync(zcode);
    const prev = {
      GROK_HOME: process.env.GROK_HOME,
      ZCODE_HOME: process.env.ZCODE_HOME,
      ORIGIN_ZCODE_HOME: process.env.ORIGIN_ZCODE_HOME,
    };
    process.env.GROK_HOME = grok;
    process.env.ZCODE_HOME = zcode;
    delete process.env.ORIGIN_ZCODE_HOME;
    try {
      const logs = path.join(tmp, 'logs');
      fs.mkdirSync(logs);
      const now = Date.now();
      fs.writeFileSync(
        path.join(logs, 's.jsonl'),
        `${[
          JSON.stringify({
            id: 'r1',
            session: 'parent-1',
            ts: now - 2000,
            role: 'user',
            text: 'Start the cache work',
            project: 'demo',
          }),
          JSON.stringify({
            id: 'r2',
            session: 'parent-1',
            ts: now - 1000,
            role: 'user',
            text: 'Keep going on the cache',
            project: 'demo',
          }),
          JSON.stringify({ session: 'parent-1', title: 'Cache the retries' }),
          JSON.stringify({
            id: 'c1',
            session: 'child-1',
            ts: now,
            role: 'user',
            text: 'zebraparentlink step',
            project: 'demo',
            parents: [
              {
                session: 'child-1',
                parent: 'parent-1',
                via: 'workflow',
                signal: 'dwf_run',
                group: 'run-1',
                name: 'Ship',
              },
            ],
          }),
        ].join('\n')}\n`,
      );
      const db = openDatabase(dbPath(home));
      await syncSource({ db, home }, fakeAdapter(logs));
      db.close();
      out.length = 0;
      expect(await main(['timeline', '--since', '1970-01-01'])).toBe(0);
      const plain = out.join('\n');
      expect(plain).toContain('parent-1');
      expect(plain).toContain('· 1 child (Ship)');
      expect(plain).not.toContain('child-1');
      out.length = 0;
      expect(await main(['timeline', '--since', '1970-01-01', '--children'])).toBe(0);
      expect(out.join('\n')).toContain('child-1');
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
