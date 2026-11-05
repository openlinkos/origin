import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Database, openDatabase, remember, syncSource } from '@openlinkos/origin-core';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import { AdminService } from '../src/service.js';

let tmp: string;
let db: Database;

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('admin project names', () => {
  it('uses session_place for the board, the entry filter, the event, and the overview', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-place-'));
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
    const entry = remember(db, {
      kind: 'memory',
      text: 'The cache holds retries.',
      confidence: 0.9,
      author: 'test',
      project: 'wt-name',
      sources: [{ eventId: 'fake:e1' }],
    });
    const service = new AdminService({ db, home, version: 'test', startedAt: ts, publicUrl: null });
    const board = (projects: string[]) =>
      service.sessionBoard(
        {
          agents: [],
          projects,
          range: 'all',
          q: '',
          recalled: false,
          name: 'any',
          sort: 'recent',
          page: 0,
        },
        ts,
      );
    expect(board(['demo-app']).rows.map((row) => row.project)).toEqual(['demo-app']);
    expect(board(['wt-name']).rows).toEqual([]);
    const entries = (projects: string[]) =>
      service.entryBoard(
        {
          kinds: [],
          projects,
          authors: [],
          origin: 'any',
          recalled: false,
          history: false,
          range: 'all',
          q: '',
          page: 0,
        },
        ts,
      );
    expect(entries(['demo-app']).rows.map((row) => [row.id, row.project])).toEqual([
      [entry.id, 'wt-name'],
    ]);
    expect(entries(['wt-name']).rows.map((row) => row.id)).toEqual([entry.id]);
    expect(
      entries([])
        .facets.projects.map((facet) => facet.value)
        .sort(),
    ).toEqual(['demo-app', 'wt-name']);
    expect(service.event('fake:e1').event.project).toBe('demo-app');
    expect(service.overview(ts).projects.map((project) => project.project)).toContain('demo-app');
    expect(service.overview(ts).projects.map((project) => project.project)).not.toContain(
      'wt-name',
    );
    expect(
      (db.prepare('SELECT project FROM event WHERE id = ?').get('fake:e1') as { project: string })
        .project,
    ).toBe('wt-name');
  });
});
