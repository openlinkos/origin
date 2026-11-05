import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGrokAdapter, createZCodeAdapter } from '@openlinkos/origin-adapters';
import {
  appendRemote,
  dbPath,
  openDatabase,
  readMirror,
  reparsePlaces,
  syncSource,
  transaction,
} from '@openlinkos/origin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorRelPath } from '../../core/src/paths.js';
import { reparseParents } from '../../core/src/reparse.js';
import { fakeAdapter } from '../../core/test/helpers.js';
import { main } from '../src/main.js';

const T0 = Date.parse('2026-10-20T01:00:00Z');

let tmp: string;
let home: string;
let saved: string | undefined;

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

/** Workflow tables added after the sessions were ingested, as a later `parents` run sees them. */
function addWorkflow(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE dwf_run (
      id text primary key, name text, resumed_from text,
      time_created integer not null, time_updated integer not null);
    CREATE TABLE dwf_actor (
      id integer primary key autoincrement, run_id text not null,
      site_id text not null, ordinal integer not null, session_id text,
      time_created integer not null, time_updated integer not null);
  `);
  db.prepare(
    `INSERT INTO dwf_run (id, name, resumed_from, time_created, time_updated)
     VALUES ('run_root', 'Older', NULL, ?, ?), ('run_step', 'Ship', 'run_root', ?, ?)`,
  ).run(T0, T0, T0, T0);
  const actor = db.prepare(
    `INSERT INTO dwf_actor (run_id, site_id, ordinal, session_id, time_created, time_updated)
     VALUES ('run_step', 'site', 0, ?, ?, ?)`,
  );
  actor.run('ses_child', T0, T0);
  actor.run('ses_plain', T0, T0);
  db.prepare(
    "UPDATE session SET parent_id = 'ses_parent', task_type = 'workflow_child' WHERE id = 'ses_plain'",
  ).run();
  db.close();
}

function rows(db: ReturnType<typeof openDatabase>, sql: string, ...args: unknown[]): unknown[] {
  return db.prepare(sql).all(...args) as unknown[];
}

describe('places lines round-trip onto a fresh hub', () => {
  it('parses sync, reproject, and parents lines into the same tables', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-roundtrip-'));
    home = path.join(tmp, 'home');
    saved = process.env.ORIGIN_HOME;
    process.env.ORIGIN_HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const demo = path.join(tmp, 'demo-app');
    const later = path.join(tmp, 'later-app');
    fs.mkdirSync(path.join(demo, '.git'), { recursive: true });
    fs.mkdirSync(later, { recursive: true });
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir);
    const event = (id: string, session: string, cwd: string, project: string) =>
      `${JSON.stringify({
        id,
        session,
        ts: T0,
        role: 'user',
        text: 'Work',
        project,
        cwd,
      })}\n`;
    fs.writeFileSync(path.join(logDir, 'sync.jsonl'), event('e-sync', 's-sync', demo, 'demo-app'));
    fs.writeFileSync(
      path.join(logDir, 'later.jsonl'),
      event('e-later', 's-later', later, 'later-app'),
    );

    const zfile = zcodeFile();
    const grok = path.join(tmp, 'grok', 'sessions', 'group', 'child-g');
    fs.mkdirSync(grok, { recursive: true });
    fs.writeFileSync(
      path.join(grok, 'summary.json'),
      JSON.stringify({ parent_session_id: 'parent-g' }),
    );

    const db = openDatabase(dbPath(home));
    await syncSource({ db, home }, fakeAdapter(logDir));
    await syncSource(
      { db, home },
      createZCodeAdapter({
        home: path.dirname(path.dirname(path.dirname(zfile))),
        now: () => T0 + 60_000,
        keepOpenMs: 0,
        settleMs: 0,
      }),
    );
    db.prepare(
      `INSERT INTO session (source, session_id, title, event_count, started_at, ended_at)
       VALUES ('grok', 'child-g', 'Explore', 1, 1, 2)`,
    ).run();
    db.close();
    addWorkflow(zfile);

    fs.mkdirSync(path.join(later, '.git'), { recursive: true });
    expect(await main(['sessions', 'reproject'])).toBe(0);
    expect(
      await main([
        'sessions',
        'parents',
        '--zcode-db',
        zfile,
        '--grok-home',
        path.join(tmp, 'grok'),
      ]),
    ).toBe(0);

    const device = openDatabase(dbPath(home));
    const placeSql = `SELECT source, session_id, project, root, signal FROM session_place
        ORDER BY source, session_id`;
    const parentSql = `SELECT source, session_id, parent_source, parent_session_id, via, run_group, run_name, signal
         FROM session_parent ORDER BY source, session_id`;
    const rootSql = `SELECT path, project, root, signal FROM project_root WHERE device = ?
        ORDER BY path`;
    const devicePlaces = rows(device, placeSql);
    const deviceParents = rows(device, parentSql);
    const deviceRoots = rows(device, rootSql, '');
    expect(devicePlaces.length).toBeGreaterThan(0);
    expect(deviceParents.length).toBeGreaterThan(0);
    expect(deviceRoots.length).toBeGreaterThan(0);

    const files = device
      .prepare(
        `SELECT id, source, path, generation, mirror, bytes_ingested AS bytes FROM raw_file
          WHERE bytes_ingested > 0 ORDER BY id`,
      )
      .all() as unknown as Array<{
      id: number;
      source: string;
      path: string;
      generation: number;
      mirror: string;
      bytes: number;
    }>;
    const chunks = files.map((file) => ({
      source: file.source,
      path: file.path,
      relPath: mirrorRelPath(file),
      generation: file.generation,
      data: readMirror(device, home, file.id, 0, file.bytes),
    }));
    device.close();

    const hubHome = path.join(tmp, 'hub');
    const hub = openDatabase(dbPath(hubHome));
    const adapters = new Map<string, ReturnType<typeof fakeAdapter>>([
      ['fake', fakeAdapter(logDir)],
      [
        'zcode',
        createZCodeAdapter({
          home: path.dirname(path.dirname(path.dirname(zfile))),
          now: () => T0,
          keepOpenMs: 0,
          settleMs: 0,
        }),
      ],
      ['grok', createGrokAdapter({ home: path.join(tmp, 'grok') })],
    ]);
    for (const chunk of chunks) {
      const adapter = adapters.get(chunk.source);
      expect(adapter, chunk.source).toBeDefined();
      const pushed = appendRemote({ db: hub, home: hubHome }, adapter!, {
        device: 'laptop',
        source: chunk.source,
        path: chunk.path,
        relPath: chunk.relPath,
        generation: chunk.generation,
        offset: 0,
        data: chunk.data,
      });
      expect(pushed.ok).toBe(true);
    }
    hub.exec('DELETE FROM session_place');
    hub.exec('DELETE FROM project_root');
    hub.exec('DELETE FROM session_parent');
    hub.exec('DELETE FROM place_head');
    const logs: string[] = [];
    const find = (source: string) => adapters.get(source) ?? null;
    transaction(
      hub,
      () => {
        reparseParents({
          db: hub,
          home: hubHome,
          adapter(source) {
            const adapter = find(source);
            if (!adapter) throw new Error(`no adapter for ${source}`);
            return adapter;
          },
          findAdapter: find,
          log: (message) => logs.push(message),
        });
        reparsePlaces(hub, hubHome, (message) => logs.push(message));
      },
      { immediate: true },
    );
    try {
      expect(logs.join('\n')).not.toContain('could not be parsed');
      expect(rows(hub, placeSql)).toEqual(devicePlaces);
      expect(rows(hub, parentSql)).toEqual(deviceParents);
      expect(rows(hub, rootSql, 'laptop')).toEqual(deviceRoots);
    } finally {
      hub.close();
    }
  });
});
