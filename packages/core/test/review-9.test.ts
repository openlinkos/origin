import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { onPostgres } from '../../../test/pg.js';
import {
  appendRemote,
  changesSince,
  childSessions,
  comparePath,
  type Database,
  ingestPlacesFile,
  isFoldedChild,
  listEvents,
  listSessions,
  openDatabase,
  parsePlaceLine,
  placesSourceFile,
  planRecall,
  projectEventSql,
  rebuildThreads,
  recallScope,
  remember,
  reproject,
  resolvePlace,
  syncSource,
  threadOf,
} from '../src/index.js';
import { fakeAdapter, mirrorText } from './helpers.js';

const temps: string[] = [];
const HOUR = 3_600_000;
const DAY = 86_400_000;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function gitCheckout(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

function linkedWorktree(main: string, wt: string): void {
  const gitDir = path.join(main, '.git', 'worktrees', 'feature');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
}

function open(home: string): Database {
  fs.mkdirSync(home, { recursive: true });
  return openDatabase(path.join(home, 'origin.db'));
}

function placeOf(db: Database, sessionId: string): { project: string; signal: string } | undefined {
  return db
    .prepare('SELECT project, signal FROM session_place WHERE session_id = ?')
    .get(sessionId) as { project: string; signal: string } | undefined;
}

function writeLog(dir: string, row: Record<string, unknown>, file = 's.jsonl'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(row)}\n`);
}

describe('places that were mirrored before the tables existed', () => {
  it.skipIf(onPostgres)(
    'applies places.jsonl that were mirrored before the project tables',
    async () => {
      const home = tempDir('origin-review-upgrade-');
      const db = open(home);
      const root = JSON.stringify({
        v: 1,
        type: 'root',
        path: 'd:/demo-app',
        project: 'demo-app',
        root: 'd:/demo-app',
        signal: 'git',
      });
      const place = JSON.stringify({
        v: 1,
        type: 'place',
        session: 's1',
        project: 'demo-app',
        root: 'd:/demo-app',
        signal: 'git',
      });
      const later = '{"v":2,"type":"place","session":"s1","project":"future-app"}';
      try {
        db.exec('DROP TABLE IF EXISTS place_head');
        db.exec('DROP INDEX IF EXISTS session_place_project');
        db.exec('DROP TABLE IF EXISTS session_place');
        db.exec('DROP TABLE IF EXISTS project_root');
        db.exec('PRAGMA user_version = 8');
        let pending: string[] | null = [root, later, place];
        const file = {
          absPath: 'places.jsonl',
          relPath: 'places.jsonl',
          generated: {
            token: 'pre-upgrade',
            mtimeMs: 1,
            next: () => {
              const out = pending ?? [];
              pending = null;
              return out;
            },
          },
        };
        await ingestPlacesFile({ db, home }, 'fake', file);
        expect(
          db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_place'").get(),
        ).toBeUndefined();
        db.close();
        const logged: string[] = [];
        const upgraded = openDatabase(path.join(home, 'origin.db'), { log: (m) => logged.push(m) });
        try {
          expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
          expect(logged.join('\n')).toMatch(/version 10/);
          expect(placeOf(upgraded, 's1')).toMatchObject({ project: 'demo-app', signal: 'git' });
          const roots = upgraded.prepare('SELECT project FROM project_root').all() as Array<{
            project: string;
          }>;
          expect(roots.map((r) => r.project)).toEqual(['demo-app']);
          const raw = upgraded.prepare('SELECT id FROM raw_file').get() as { id: number };
          expect(mirrorText(upgraded, home, raw.id)).toContain(later);
          expect(logged.join('\n')).toMatch(/version 2 is not read by this Origin/);
          expect(logged.join('\n')).not.toMatch(/"v" must be 1/);
        } finally {
          upgraded.close();
        }
      } finally {
        if (db.isOpen) db.close();
      }
    },
  );
});

describe('the latest place line is the conclusion', () => {
  it('appends a place again when the session returns to an earlier project', async () => {
    const base = tempDir('origin-review-return-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const main = path.join(base, 'demo-app');
    const other = path.join(base, 'other-app');
    gitCheckout(main);
    gitCheckout(other);
    const db = open(home);
    const hubHome = path.join(base, 'hub');
    const hub = open(hubHome);
    try {
      writeLog(logs, {
        id: 'e1',
        session: 's1',
        ts: 1_000,
        role: 'user',
        text: 'Start in the main checkout',
        cwd: main,
        project: 'demo-app',
      });
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
      const setCwd = (cwd: string) => {
        db.prepare('UPDATE event SET cwd = ? WHERE session_id = ?').run(cwd, 's1');
        db.prepare('UPDATE session SET cwd = ? WHERE session_id = ?').run(cwd, 's1');
      };
      setCwd(other);
      const moved = placesSourceFile(db, home, 'fake');
      expect(moved).not.toBeNull();
      await ingestPlacesFile({ db, home }, 'fake', moved as NonNullable<typeof moved>);
      expect(placeOf(db, 's1')?.project).toBe('other-app');
      setCwd(main);
      const back = placesSourceFile(db, home, 'fake');
      expect(back).not.toBeNull();
      await ingestPlacesFile({ db, home }, 'fake', back as NonNullable<typeof back>);
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
      const raw = db.prepare("SELECT id FROM raw_file WHERE path = 'places.jsonl'").get() as {
        id: number;
      };
      const text = mirrorText(db, home, raw.id).trim().split('\n');
      const places = text.filter((row) => row.includes('"type":"place"'));
      expect(places.length).toBeGreaterThanOrEqual(3);
      expect(places.at(-1)).toContain('"project":"demo-app"');
      const pushed = appendRemote({ db: hub, home: hubHome }, fakeAdapter(logs), {
        device: 'laptop',
        source: 'fake',
        path: 'places.jsonl',
        relPath: 'places.jsonl',
        generation: 1,
        offset: 0,
        data: Buffer.from(mirrorText(db, home, raw.id)),
      });
      expect(pushed.ok).toBe(true);
      expect(placeOf(hub, 's1')?.project).toBe('demo-app');
    } finally {
      db.close();
      hub.close();
    }
  });

  it('keeps the current resolution when a stale places file is ingested later', async () => {
    const base = tempDir('origin-review-stale-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const main = path.join(base, 'demo-app');
    const other = path.join(base, 'other-app');
    gitCheckout(main);
    gitCheckout(other);
    const db = open(home);
    try {
      writeLog(logs, {
        id: 'e1',
        session: 's1',
        ts: 1_000,
        role: 'user',
        text: 'Start',
        cwd: main,
        project: 'demo-app',
      });
      await syncSource({ db, home }, fakeAdapter(logs));
      const setCwd = (cwd: string) => {
        db.prepare('UPDATE event SET cwd = ? WHERE session_id = ?').run(cwd, 's1');
        db.prepare('UPDATE session SET cwd = ? WHERE session_id = ?').run(cwd, 's1');
      };
      setCwd(other);
      const early = placesSourceFile(db, home, 'fake');
      expect(early).not.toBeNull();
      setCwd(main);
      await ingestPlacesFile({ db, home }, 'fake', early as NonNullable<typeof early>);
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
      const raw = db.prepare("SELECT id FROM raw_file WHERE path = 'places.jsonl'").get() as {
        id: number;
      };
      const places = mirrorText(db, home, raw.id)
        .trim()
        .split('\n')
        .filter((row) => row.includes('"type":"place"'));
      expect(places.some((row) => row.includes('"project":"other-app"'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('learned roots and devices', () => {
  it('does not let a learned root claim a directory that still exists', () => {
    const base = tempDir('origin-review-learned-');
    const parent = path.join(base, 'old-app');
    const child = path.join(parent, 'src');
    fs.mkdirSync(child, { recursive: true });
    const db = open(path.join(base, 'home'));
    try {
      const root = comparePath(parent);
      db.prepare(
        `INSERT INTO project_root (path, project, root, signal, seen_at) VALUES (?, 'old-app', ?, 'git', 1)`,
      ).run(root, root);
      expect(resolvePlace(child, { db })).toMatchObject({ signal: 'segment', project: 'src' });
      const gone = path.join(parent, 'missing');
      expect(resolvePlace(gone, { db })).toMatchObject({ signal: 'learned', project: 'old-app' });
    } finally {
      db.close();
    }
  });

  it("keeps each device's project root when the path is the same", () => {
    const base = tempDir('origin-review-device-');
    const home = path.join(base, 'home');
    const db = open(home);
    try {
      const key = comparePath('D:/work/demo-app');
      const send = (device: string, project: string) => {
        const row = JSON.stringify({
          v: 1,
          type: 'root',
          path: key,
          project,
          root: key,
          signal: 'git',
        });
        const result = appendRemote({ db, home }, fakeAdapter(base), {
          device,
          source: 'fake',
          path: 'places.jsonl',
          relPath: 'places.jsonl',
          generation: 1,
          offset: 0,
          data: Buffer.from(`${row}\n`),
        });
        expect(result.ok).toBe(true);
      };
      send('laptop', 'demo-app');
      send('other', 'other-app');
      const rows = db
        .prepare('SELECT device, project FROM project_root ORDER BY device')
        .all() as Array<{
        device: string;
        project: string;
      }>;
      expect(rows).toEqual([
        { device: 'laptop', project: 'demo-app' },
        { device: 'other', project: 'other-app' },
      ]);
      const cwd = 'D:/work/demo-app/src';
      expect(recallScope(cwd, { onDisk: false, db, device: 'laptop' }).project).toBe('demo-app');
      expect(recallScope(cwd, { onDisk: false, db, device: 'other' }).project).toBe('other-app');
    } finally {
      db.close();
    }
  });

  it('uses the directory that holds .git when the work tree cannot be read', () => {
    const base = tempDir('origin-review-holder-');
    const bare = path.join(base, 'bare-app');
    fs.mkdirSync(path.join(bare, '.git'), { recursive: true });
    fs.writeFileSync(path.join(bare, '.git', 'config'), '[core]\nbare = true\n');
    const sub = path.join(bare, 'pkg', 'core');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolvePlace(sub)).toMatchObject({
      signal: 'git',
      project: 'bare-app',
      rootPath: path.resolve(bare),
      emitSignal: 'git',
    });
  });

  it('matches a UNC root in either case and not a posix path', () => {
    const db = open(tempDir('origin-review-unc-'));
    try {
      const root = comparePath('//Server/Share');
      expect(root).toBe('//server/share');
      db.prepare(
        `INSERT INTO project_root (path, project, root, signal, seen_at) VALUES (?, 'share-app', ?, 'git', 1)`,
      ).run(root, root);
      expect(resolvePlace('//Server/Share/proj', { db })).toMatchObject({
        signal: 'learned',
        project: 'share-app',
      });
      expect(resolvePlace('/Server/Share/proj', { db }).signal).toBe('segment');
    } finally {
      db.close();
    }
  });
});

describe('threads follow the resolved project', () => {
  it("joins a worktree session to the main checkout's branch", async () => {
    const base = tempDir('origin-review-thread-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const main = path.join(base, 'demo-app');
    const wt = path.join(base, 'feature-wt');
    gitCheckout(main);
    linkedWorktree(main, wt);
    const t0 = Date.UTC(2026, 10, 1, 9);
    writeLog(logs, {
      id: 'm1',
      session: 'main-1',
      ts: t0,
      role: 'user',
      text: 'Work on the branch',
      cwd: main,
      project: 'demo-app',
      branch: 'feature',
    });
    writeLog(logs, {
      id: 'm2',
      session: 'main-1',
      ts: t0 + HOUR,
      role: 'assistant',
      text: 'Done on main',
      cwd: main,
      project: 'demo-app',
      branch: 'feature',
    });
    writeLog(
      logs,
      {
        id: 'w1',
        session: 'wt-1',
        ts: t0 + 2 * HOUR,
        role: 'user',
        text: 'Work in the work tree',
        cwd: wt,
        project: 'feature-wt',
        branch: 'feature',
      },
      'w.jsonl',
    );
    writeLog(
      logs,
      {
        id: 'w2',
        session: 'wt-1',
        ts: t0 + 3 * HOUR,
        role: 'assistant',
        text: 'Done in the work tree',
        cwd: wt,
        project: 'feature-wt',
        branch: 'feature',
      },
      'w.jsonl',
    );
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(placeOf(db, 'wt-1')?.project).toBe('demo-app');
      const joined = threadOf(db, 'fake', 'main-1');
      expect(joined).not.toBeNull();
      expect(threadOf(db, 'fake', 'wt-1')).toBe(joined);
      db.prepare('DELETE FROM session_place').run();
      db.prepare('DELETE FROM project_root').run();
      rebuildThreads(db);
      const apartMain = threadOf(db, 'fake', 'main-1');
      const apartWt = threadOf(db, 'fake', 'wt-1');
      expect(apartMain !== null && apartMain === apartWt).toBe(false);
      const live = reproject(db, { home });
      for (const file of live.files) await ingestPlacesFile({ db, home }, file.source, file.file);
      expect(placeOf(db, 'wt-1')?.project).toBe('demo-app');
      const again = threadOf(db, 'fake', 'main-1');
      expect(again).not.toBeNull();
      expect(threadOf(db, 'fake', 'wt-1')).toBe(again);
    } finally {
      db.close();
    }
  });
});

describe('a sync resolves only what changed', () => {
  it('resolves only the sessions this sync changed', async () => {
    const base = tempDir('origin-review-touch-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const main = path.join(base, 'demo-app');
    const other = path.join(base, 'other-app');
    gitCheckout(main);
    gitCheckout(other);
    writeLog(logs, {
      id: 'a1',
      session: 's1',
      ts: 1_000,
      role: 'user',
      text: 'Main',
      cwd: main,
      project: 'demo-app',
    });
    writeLog(
      logs,
      {
        id: 'b1',
        session: 's2',
        ts: 1_000,
        role: 'user',
        text: 'Other',
        cwd: other,
        project: 'other-app',
      },
      'b.jsonl',
    );
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
      expect(placeOf(db, 's2')?.project).toBe('other-app');
      db.prepare('UPDATE event SET cwd = ? WHERE session_id = ?').run(main, 's2');
      db.prepare('UPDATE session SET cwd = ? WHERE session_id = ?').run(main, 's2');
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(placeOf(db, 's2')?.project).toBe('other-app');
      writeLog(
        logs,
        {
          id: 'b2',
          session: 's2',
          ts: 2_000,
          role: 'assistant',
          text: 'Moved',
          cwd: main,
          project: 'other-app',
        },
        'b.jsonl',
      );
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(placeOf(db, 's2')?.project).toBe('demo-app');
    } finally {
      db.close();
    }
  });

  it("uses the project index when listing a project's events", async () => {
    const base = tempDir('origin-review-index-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    writeLog(logs, {
      id: 'e1',
      session: 's1',
      ts: 1_000,
      role: 'user',
      text: 'Indexed',
      project: 'demo-app',
    });
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(listEvents(db, { project: 'demo-app' }).map((e) => e.id)).toEqual(['fake:e1']);
      // SQLite's plan; PostgreSQL plans by its statistics.
      if (onPostgres) return;
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT e.seq FROM event e WHERE ${projectEventSql('e')}`)
        .all('demo-app', 'demo-app') as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join('\n')).toMatch(/event_project/);
    } finally {
      db.close();
    }
  });
});

describe('folding a child', () => {
  it('lists an orphan, a grandchild, and a cycle', async () => {
    const base = tempDir('origin-review-fold-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const parents = (
      session: string,
      parent: string,
    ): Array<{ session: string; parent: string; via: 'subagent'; signal: string }> => [
      { session, parent, via: 'subagent', signal: 'parent_id' },
    ];
    const row = (id: string, session: string, parent?: string) => ({
      id,
      session,
      ts: 1_000,
      role: 'user' as const,
      text: id,
      parents: parent ? parents(session, parent) : undefined,
    });
    writeLog(logs, row('o1', 'orphan', 'missing'), 'orphan.jsonl');
    writeLog(logs, row('p1', 'top'), 'top.jsonl');
    writeLog(logs, row('c1', 'child', 'top'), 'child.jsonl');
    writeLog(logs, row('g1', 'grand', 'child'), 'grand.jsonl');
    writeLog(logs, row('a1', 'cycle-a', 'cycle-b'), 'a.jsonl');
    writeLog(logs, row('b1', 'cycle-b', 'cycle-a'), 'b.jsonl');
    writeLog(logs, row('x1', 'tri-a', 'tri-c'), 'xa.jsonl');
    writeLog(logs, row('y1', 'tri-b', 'tri-a'), 'xb.jsonl');
    writeLog(logs, row('z1', 'tri-c', 'tri-b'), 'xc.jsonl');
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      const top = listSessions(db, { topLevel: true })
        .map((s) => s.sessionId)
        .sort();
      expect(top).toEqual(['cycle-a', 'cycle-b', 'orphan', 'top', 'tri-a', 'tri-b', 'tri-c']);
      expect(isFoldedChild(db, 'fake', 'child')).toBe(true);
      expect(isFoldedChild(db, 'fake', 'grand')).toBe(true);
      expect(isFoldedChild(db, 'fake', 'orphan')).toBe(false);
      expect(childSessions(db, 'fake', 'top').map((s) => s.sessionId)).toEqual(['child']);
      expect(childSessions(db, 'fake', 'child').map((s) => s.sessionId)).toEqual(['grand']);
    } finally {
      db.close();
    }
  });

  it('names the parent when a child event is the only one on the page', async () => {
    const base = tempDir('origin-review-feed-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const now = Date.UTC(2026, 10, 5, 12);
    writeLog(logs, {
      id: 'p1',
      session: 'parent-1',
      ts: now - 2 * DAY,
      role: 'user',
      text: 'Parent started earlier',
    });
    writeLog(
      logs,
      {
        id: 'c1',
        session: 'child-1',
        ts: now - HOUR,
        role: 'user',
        text: 'The step',
        parents: [{ session: 'child-1', parent: 'parent-1', via: 'workflow', signal: 'dwf_run' }],
      },
      'child.jsonl',
    );
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      const feed = changesSince(db, { now });
      expect(feed.events.map((e) => e.id)).toEqual(['fake:c1']);
      expect(feed.sessions.map((s) => s.session.sessionId)).toEqual(['parent-1']);
    } finally {
      db.close();
    }
  });
});

describe('place lines that must not lock or steal a file', () => {
  it('rejects a place line that would lock the project', async () => {
    const base = tempDir('origin-review-signal-');
    const home = path.join(base, 'home');
    const db = open(home);
    const bad =
      '{"v":1,"type":"place","session":"s1","project":"locked","root":null,"signal":"explicit"}';
    try {
      expect(parsePlaceLine(bad).warning).toMatch(/signal/);
      expect(parsePlaceLine('{"v":2}').warning).toMatch(/version 2 is not read/);
      expect(parsePlaceLine('{"v":2}').events).toEqual([]);
      let pending = [bad];
      const file = {
        absPath: 'places.jsonl',
        relPath: 'places.jsonl',
        generated: {
          token: 'bad-signal',
          mtimeMs: 1,
          next: () => {
            const out = pending;
            pending = [];
            return out;
          },
        },
      };
      await ingestPlacesFile({ db, home }, 'fake', file);
      expect(placeOf(db, 's1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('does not claim a places.jsonl inside a source', async () => {
    const base = tempDir('origin-review-rel-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const file = path.join(logs, 'notes', 'places.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        id: 'e1',
        session: 's1',
        ts: 1_000,
        role: 'user',
        text: 'An ordinary event',
      })}\n${JSON.stringify({
        v: 1,
        type: 'place',
        session: 's1',
        project: 'stolen',
        root: null,
        signal: 'git',
      })}\n`,
    );
    const adapter = fakeAdapter(logs);
    adapter.discover = async () => [{ absPath: file, relPath: 'notes/places.jsonl' }];
    const db = open(home);
    try {
      await syncSource({ db, home }, adapter);
      expect(listEvents(db, {}).map((e) => e.id)).toContain('fake:e1');
      expect(placeOf(db, 's1')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('a hub brief of a work tree', () => {
  it('uses a device root alias for the brief', async () => {
    const base = tempDir('origin-review-brief-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    writeLog(logs, {
      id: 'e1',
      session: 's1',
      ts: 1_000,
      role: 'user',
      text: 'Cite me',
      project: 'demo-app',
      cwd: 'D:/work/demo-app',
    });
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      const fact = remember(
        db,
        {
          kind: 'knowledge',
          text: 'The work tree is the main checkout',
          confidence: 0.9,
          author: 'test',
          project: 'demo-app',
          sources: [{ eventId: 'fake:e1' }],
        },
        1_000,
      ).id;
      const cwd = 'D:/work/feature-wt';
      const root = comparePath('D:/work/demo-app');
      db.prepare(
        `INSERT INTO project_root (device, path, project, root, signal, seen_at)
         VALUES ('laptop', ?, 'demo-app', ?, 'git', 1)`,
      ).run(comparePath(cwd), root);
      const scope = recallScope(cwd, { onDisk: false, db, device: 'laptop' });
      expect(scope.project).toBe('demo-app');
      const plan = planRecall(db, {
        occasion: 'start',
        source: 'codex',
        sessionId: 'now',
        cwd,
        root: scope.root,
        project: scope.project,
        onDisk: false,
        device: 'laptop',
        now: 2_000,
      });
      expect(plan.items.map((item) => item.ref)).toContain(fact);
    } finally {
      db.close();
    }
  });
});
