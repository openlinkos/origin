import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  displayTitle,
  getSessionParent,
  listSessions,
  openDatabase,
  parsePlaceLine,
  recordSessionParent,
  STORE_VERSION,
  sessionFold,
  syncSource,
  transaction,
} from '../src/index.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

const PARENT = JSON.stringify({
  v: 1,
  type: 'parent',
  session: 'child',
  parent: 'root',
  via: 'workflow',
  group: 'run-root',
  name: 'Ship',
  signal: 'dwf_run',
});

describe('parsePlaceLine', () => {
  it('reads a parent line and ignores the lines p1 owns', () => {
    expect(parsePlaceLine(PARENT)?.events).toEqual([]);
    expect(parsePlaceLine(PARENT)?.sessionParents).toEqual([
      {
        sessionId: 'child',
        parentSessionId: 'root',
        via: 'workflow',
        runGroup: 'run-root',
        runName: 'Ship',
        signal: 'dwf_run',
        fromAgent: false,
      },
    ]);
    expect(
      parsePlaceLine(
        JSON.stringify({
          v: 1,
          type: 'root',
          path: '/tmp/demo',
          project: 'demo-app',
          root: '/tmp/demo',
          signal: 'git',
        }),
      ),
    ).toEqual({
      events: [],
      roots: [{ path: '/tmp/demo', project: 'demo-app', root: '/tmp/demo', signal: 'git' }],
    });
    expect(
      parsePlaceLine(
        JSON.stringify({
          v: 1,
          type: 'place',
          session: 's',
          project: 'demo-app',
          root: null,
          signal: 'git',
        }),
      ),
    ).toEqual({
      events: [],
      places: [{ sessionId: 's', project: 'demo-app', root: null, signal: 'git' }],
    });
    expect(parsePlaceLine('not json')).toEqual({ events: [], warning: 'places.jsonl: not JSON' });
    expect(parsePlaceLine(JSON.stringify({ v: 1, type: 'parent', session: 'c' }))).toEqual({
      events: [],
    });
  });
});

describe('display titles', () => {
  it('shows a workflow step as its run name and the actor token', () => {
    const parent = { via: 'workflow' as const, runName: 'Ship' };
    expect(displayTitle('actor#3@4 retry', parent)).toBe('Ship · actor#3@4');
    expect(displayTitle('plain title', parent)).toBe('plain title');
    expect(displayTitle('actor#3@4', { via: 'subagent', runName: 'Ship' })).toBe('actor#3@4');
    expect(displayTitle(null, parent)).toBeNull();
  });
});

describe('session_parent', () => {
  let tmp: string;
  let home: string;
  let db: Database;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-parents-'));
    home = path.join(tmp, 'home');
    db = openDatabase(path.join(home, 'origin.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps an agent parent and still fills a missing group and name', () => {
    transaction(
      db,
      () => {
        recordSessionParent(db, 'zcode', {
          sessionId: 'child',
          parentSessionId: 'agent-parent',
          parentSource: 'zcode',
          via: 'workflow',
          signal: 'parent_id',
          fromAgent: true,
        });
        recordSessionParent(db, 'zcode', {
          sessionId: 'child',
          parentSessionId: 'other',
          via: 'workflow',
          runGroup: 'run-root',
          runName: 'Ship',
          signal: 'dwf_run',
          fromAgent: false,
        });
      },
      { immediate: true },
    );
    expect(getSessionParent(db, 'zcode', 'child')).toMatchObject({
      parentSessionId: 'agent-parent',
      runGroup: 'run-root',
      runName: 'Ship',
      signal: 'parent_id',
    });
    expect(sessionFold(db, 'zcode', 'agent-parent')).toEqual({ children: 1, workflows: ['Ship'] });
  });

  it('ingests places.jsonl without message events, and a later line fills the group', async () => {
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 's.jsonl'), line('e1', 'root', 1000, 'user', 'Start'));
    fs.writeFileSync(
      path.join(logs, 'places.jsonl'),
      `${JSON.stringify({ v: 1, type: 'root', path: '/tmp/demo', project: 'demo-app', root: '/tmp/demo', signal: 'git' })}\n${JSON.stringify({ v: 1, type: 'place', session: 'root', project: 'demo-app', root: null, signal: 'git' })}\n${PARENT}\n`,
    );
    const result = await syncSource({ db, home }, fakeAdapter(logs));
    expect(result.parseErrors).toBe(0);
    expect(result.eventsAdded).toBe(1);
    expect(getSessionParent(db, 'fake', 'child')).toMatchObject({
      parentSessionId: 'root',
      runGroup: 'run-root',
      runName: 'Ship',
      signal: 'dwf_run',
    });
  });

  it('restores parents from mirrored lines on upgrade, and does not invent a run group', async () => {
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(logs);
    const child = JSON.stringify({
      id: 'e1',
      session: 'child',
      ts: 1000,
      role: 'user',
      text: 'Step',
      parent_id: 'root',
      task_type: 'workflow_child',
      parents: [{ session: 'child', parent: 'root', via: 'workflow', signal: 'parent_id' }],
    });
    fs.writeFileSync(path.join(logs, 'c.jsonl'), `${child}\n`);
    const adapter = fakeAdapter(logs, 'zcode');
    await syncSource({ db, home }, adapter);
    expect(getSessionParent(db, 'zcode', 'child')).toMatchObject({
      parentSessionId: 'root',
      via: 'workflow',
      signal: 'parent_id',
      runGroup: null,
      runName: null,
    });
    db.exec('DROP TABLE session_parent');
    db.exec('PRAGMA user_version = 8');
    db.close();
    const logged: string[] = [];
    db = openDatabase(path.join(home, 'origin.db'), {
      adapters: [adapter],
      log: (m) => logged.push(m),
    });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: STORE_VERSION });
    expect(logged.join('\n')).toMatch(/Upgrading the store to version 10/);
    expect(getSessionParent(db, 'zcode', 'child')).toMatchObject({
      parentSessionId: 'root',
      runGroup: null,
      signal: 'parent_id',
    });
    const raw = db.prepare('SELECT id FROM raw_file').get() as { id: number };
    expect(mirrorText(db, home, raw.id)).toBe(`${child}\n`);
    expect(listSessions(db, { topLevel: true }).map((s) => s.sessionId)).toEqual([]);
    expect(listSessions(db).map((s) => s.sessionId)).toEqual(['child']);
  });
});
