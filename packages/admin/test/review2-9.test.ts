import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Database,
  forget,
  openDatabase,
  remember,
  type SourceAdapter,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminService } from '../src/service.js';

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function adapter(root: string): SourceAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    version: () => null,
    async discover() {
      return fs
        .readdirSync(root)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ absPath: path.join(root, f), relPath: f }));
    },
    parseLine(raw) {
      const o = JSON.parse(raw) as {
        id: string;
        session: string;
        ts: number;
        text: string;
        project?: string;
      };
      return {
        events: [
          {
            id: o.id,
            sessionId: o.session,
            ts: o.ts,
            role: 'user' as const,
            kind: 'message' as const,
            text: o.text,
            project: o.project ?? 'demo-app',
          },
        ],
      };
    },
  };
}

const board = {
  agents: [] as string[],
  projects: [] as string[],
  range: 'all' as const,
  q: '',
  recalled: false,
  name: 'any' as const,
  sort: 'recent' as const,
  page: 0,
};

describe('a grandchild whose middle session was forgotten', () => {
  it('shows the grandchild under the visible root, including a search for its text', async () => {
    const base = tempDir('origin-review2-board-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const now = Date.now();
    const write = (file: string, row: Record<string, unknown>) => {
      fs.appendFileSync(path.join(logs, file), `${JSON.stringify(row)}\n`);
    };
    write('root.jsonl', { id: 'r1', session: 'root', ts: now - 3000, text: 'The root' });
    write('mid.jsonl', { id: 'm1', session: 'mid', ts: now - 2000, text: 'The middle' });
    write('grand.jsonl', {
      id: 'g1',
      session: 'grand',
      ts: now - 1000,
      text: 'zebragrand finishes the step',
    });
    const db = openDatabase(path.join(home, 'origin.db'));
    try {
      await syncSource({ db, home }, adapter(logs));
      db.prepare(
        `INSERT INTO session_parent
           (source, session_id, parent_source, parent_session_id, via, run_group, run_name, signal)
         VALUES ('fake', 'mid', 'fake', 'root', 'subagent', NULL, NULL, 'parent_id'),
                ('fake', 'grand', 'fake', 'mid', 'subagent', NULL, NULL, 'parent_id')`,
      ).run();
      forget(db, 'fake:m1', { reason: 'The middle run is gone', author: 'user@laptop' });
      const service = new AdminService({
        db,
        home,
        version: 'test',
        startedAt: now,
        publicUrl: null,
      });
      const listed = service.sessionBoard({ ...board, q: 'zebragrand' }, now);
      expect(listed.rows.map((r) => r.sessionId)).toEqual(['root']);
      expect(listed.rows[0]?.children.map((c) => c.sessionId)).toEqual(['grand']);
    } finally {
      db.close();
    }
  });
});

describe('entry facets', () => {
  it('does not file an entry under a cited session of another project', async () => {
    const base = tempDir('origin-review2-facet-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(logs, 's.jsonl'),
      `${JSON.stringify({
        id: 'e1',
        session: 's1',
        ts: now,
        text: 'Elsewhere',
        project: 'other-app',
      })}\n`,
    );
    const db: Database = openDatabase(path.join(home, 'origin.db'));
    try {
      await syncSource({ db, home }, adapter(logs));
      db.prepare(
        `INSERT INTO session_place (source, session_id, project, root, signal)
         VALUES ('fake', 's1', 'other-app', NULL, 'git')`,
      ).run();
      const entry = remember(db, {
        kind: 'cognition',
        text: 'Named demo-app on purpose.',
        confidence: 0.9,
        author: 'test',
        project: 'demo-app',
        sources: [{ eventId: 'fake:e1' }],
      });
      const service = new AdminService({
        db,
        home,
        version: 'test',
        startedAt: now,
        publicUrl: null,
      });
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
          now,
        );
      expect(entries(['demo-app']).rows.map((row) => row.id)).toEqual([entry.id]);
      expect(entries(['other-app']).rows).toEqual([]);
      expect(entries([]).facets.projects.map((facet) => facet.value)).not.toContain('other-app');
    } finally {
      db.close();
    }
  });
});
