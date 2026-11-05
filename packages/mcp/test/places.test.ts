import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Database, openDatabase, syncSource } from '@openlinkos/origin-core';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import { changesIn, timelineOf } from '../src/local.js';

let tmp: string;
let db: Database;

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP project names', () => {
  it('lists and shows the resolved project', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-place-'));
    const home = path.join(tmp, 'home');
    const src = path.join(tmp, 'logs');
    fs.mkdirSync(src);
    const ts = Date.now();
    fs.writeFileSync(
      path.join(src, 's.jsonl'),
      `${JSON.stringify({
        id: 'e1',
        session: 's1',
        ts,
        role: 'user',
        text: 'The cache holds retries',
        project: 'wt-name',
        cwd: 'D:\\demo\\wt-name',
      })}\n`,
    );
    db = openDatabase(path.join(home, 'origin.db'));
    await syncSource({ db, home }, fakeAdapter(src));
    db.prepare(
      `INSERT INTO session_place (source, session_id, project, root, signal)
       VALUES ('fake', 's1', 'demo-app', 'd:/demo/demo-app', 'git')`,
    ).run();
    const listed = timelineOf(db, {
      project: 'demo-app',
      since: '7d',
      include_tools: false,
      limit: 50,
    });
    expect('sessions' in listed && listed.sessions.map((session) => session.project)).toEqual([
      'demo-app',
    ]);
    const missed = timelineOf(db, {
      project: 'wt-name',
      since: '7d',
      include_tools: false,
      limit: 50,
    });
    expect('sessions' in missed && missed.sessions).toEqual([]);
    const page = timelineOf(db, { session: 's1', include_tools: false, limit: 50 });
    expect('events' in page && page.events.map((event) => event.project)).toEqual(['demo-app']);
    const feed = changesIn(db, { project: 'demo-app', include_tools: false, limit: 50 });
    expect(feed.sessions.map((session) => session.project)).toEqual(['demo-app']);
    expect(feed.events.map((event) => event.id)).toEqual(['fake:e1']);
    expect(changesIn(db, { project: 'wt-name', include_tools: false, limit: 50 }).events).toEqual(
      [],
    );
  });
});
