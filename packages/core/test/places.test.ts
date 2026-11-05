import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeProjects,
  appendRemote,
  changesSince,
  comparePath,
  type Database,
  eventActivity,
  getEvent,
  getSession,
  ingestPlacesFile,
  lastSegment,
  listEntries,
  listProjects,
  listProposals,
  listSessions,
  openDatabase,
  parsePlaceLine,
  planRecall,
  proposalProjects,
  recallScope,
  recallText,
  remember,
  reparsePlaces,
  reproject,
  resolvePlace,
  type SourceAdapter,
  STORE_VERSION,
  searchEvents,
  syncSource,
  workTree,
} from '../src/index.js';
import { tailPath } from '../src/mirror.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

const temps: string[] = [];

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

/** A linked work tree beside `main`, not inside it. */
function linkedWorktree(main: string, wt: string): void {
  const gitDir = path.join(main, '.git', 'worktrees', 'feature');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
}

function writeLog(dir: string, row: Record<string, unknown>, file = 's.jsonl'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(row)}\n`);
}

function open(home: string): Database {
  fs.mkdirSync(home, { recursive: true });
  return openDatabase(path.join(home, 'origin.db'));
}

function rawProject(db: Database, id: string): string | null {
  return (
    db.prepare('SELECT project FROM event WHERE id = ?').get(id) as { project: string | null }
  ).project;
}

function placeOf(db: Database, sessionId: string): { project: string; signal: string } | undefined {
  return db
    .prepare('SELECT project, signal FROM session_place WHERE session_id = ?')
    .get(sessionId) as { project: string; signal: string } | undefined;
}

/** The fake adapter, marking every event's project as one the line named. */
function explicitAdapter(root: string): SourceAdapter {
  const base = fakeAdapter(root);
  return {
    ...base,
    parseLine(line, ctx) {
      const parsed = base.parseLine(line, ctx);
      return {
        ...parsed,
        events: parsed.events.map((event) => ({ ...event, projectSignal: 'explicit' as const })),
      };
    },
  };
}

describe('comparePath', () => {
  it('lowercases only a Windows drive or a UNC path', () => {
    expect(comparePath('D:\\Work\\Demo')).toBe(comparePath('d:/work/demo'));
    expect(comparePath('/Work/Demo')).not.toBe(comparePath('/work/demo'));
    expect(comparePath('\\\\Server\\Share\\A')).toBe(comparePath('//server/share/a'));
    expect(lastSegment('D:\\Work\\Demo')).toBe('Demo');
  });
});

describe('git work trees', () => {
  it('keeps a .git directory as that checkout', () => {
    const repo = path.join(tempDir('origin-place-git-'), 'demo-app');
    gitCheckout(repo);
    fs.mkdirSync(path.join(repo, 'src'));
    expect(workTree(repo)).toBe(path.resolve(repo));
    expect(resolvePlace(repo)).toMatchObject({
      project: 'demo-app',
      signal: 'git',
      rootPath: path.resolve(repo),
    });
    expect(recallScope(path.join(repo, 'src'))).toMatchObject({
      root: path.resolve(repo),
      project: 'demo-app',
    });
  });

  it('resolves a linked work tree to the main checkout', async () => {
    const base = tempDir('origin-place-wt-');
    const main = path.join(base, 'demo-app');
    const wt = path.join(base, 'feature-wt');
    gitCheckout(main);
    linkedWorktree(main, wt);
    expect(comparePath(wt).startsWith(`${comparePath(main)}/`)).toBe(false);
    const home = path.join(base, 'home');
    const src = path.join(base, 'logs');
    const ts = Date.now();
    writeLog(src, {
      id: 'e1',
      session: 's1',
      ts,
      role: 'user',
      text: 'The cache holds retries for demo-app',
      project: 'feature-wt',
      cwd: wt,
    });
    const db = open(home);
    try {
      const synced = await syncSource({ db, home }, fakeAdapter(src));
      expect(synced).toMatchObject({ filesSeen: 1, linesRead: 1, eventsAdded: 1, parseErrors: 0 });
      expect(rawProject(db, 'fake:e1')).toBe('feature-wt');
      expect(
        (
          db.prepare('SELECT project FROM session WHERE session_id = ?').get('s1') as {
            project: string;
          }
        ).project,
      ).toBe('feature-wt');
      expect(placeOf(db, 's1')).toMatchObject({ project: 'demo-app', signal: 'git' });
      const places = db.prepare(`SELECT id FROM raw_file WHERE path = 'places.jsonl'`).get() as
        | { id: number }
        | undefined;
      expect(places).toBeTruthy();
      expect(mirrorText(db, home, places?.id ?? 0)).toContain('"project":"demo-app"');

      const entry = remember(db, {
        kind: 'memory',
        text: 'The work tree belongs with the main checkout.',
        confidence: 0.9,
        author: 'test',
        project: 'feature-wt',
        sources: [{ eventId: 'fake:e1' }],
      });
      const fromMain = planRecall(db, { occasion: 'start', ...recallScope(main, { db }) });
      const fromWt = planRecall(db, { occasion: 'start', ...recallScope(wt, { db }) });
      expect(fromMain.project).toBe('demo-app');
      expect(fromWt.project).toBe('demo-app');
      expect(fromMain.items.map((item) => item.ref)).toContain(entry.id);
      expect(fromWt.items.map((item) => item.ref)).toContain(entry.id);
      expect(recallText(fromMain, 'rcl_000000000001')).toContain(entry.id);

      expect(getEvent(db, 'fake:e1')?.project).toBe('demo-app');
      expect(getSession(db, 'fake', 's1')?.project).toBe('demo-app');
      expect(listSessions(db, { project: 'demo-app' }).map((s) => s.sessionId)).toEqual(['s1']);
      expect(listSessions(db, { project: 'feature-wt' })).toEqual([]);
      expect(listProjects(db).map((p) => p.project)).toEqual(['demo-app']);
      expect(searchEvents(db, 'cache', { project: 'demo-app' }).map((h) => h.project)).toEqual([
        'demo-app',
      ]);
      expect(searchEvents(db, 'cache', { project: 'feature-wt' })).toEqual([]);
      expect(
        changesSince(db, { project: 'demo-app', now: ts + 1000 }).events.map((e) => e.id),
      ).toEqual(['fake:e1']);
      expect(changesSince(db, { project: 'feature-wt', now: ts + 1000 }).events).toEqual([]);
      expect(listEntries(db, { project: 'demo-app' }).map((e) => e.id)).toEqual([entry.id]);
      expect(listEntries(db, { project: 'feature-wt' }).map((e) => e.id)).toEqual([entry.id]);
      expect(listEntries(db, { project: 'feature-wt' })[0]?.project).toBe('feature-wt');
      const activity = eventActivity(db, { since: ts - 86_400_000, until: ts + 1000 });
      expect(activity.map((row) => row.project)).toContain('demo-app');
      expect(activity.map((row) => row.project)).not.toContain('feature-wt');
      expect(activeProjects(db, { since: ts - 86_400_000 }).map((p) => p.project)).toEqual([
        'demo-app',
      ]);

      db.prepare('DELETE FROM session_place').run();
      db.prepare('DELETE FROM project_root').run();
      const before = db.prepare('SELECT COUNT(*) AS n FROM raw_file').get() as { n: number };
      const dry = reproject(db, { home, dryRun: true });
      expect(dry.files).toEqual([]);
      expect(dry.report.text).toContain('feature-wt → demo-app  1 sessions');
      expect(dry.report.text).toContain('entries still named an old project: 1');
      expect(dry.report.text).toContain(
        'sessions: 1 top-level, 0 children → 1 top-level, 0 children',
      );
      expect(placeOf(db, 's1')).toBeUndefined();
      expect((db.prepare('SELECT COUNT(*) AS n FROM raw_file').get() as { n: number }).n).toBe(
        before.n,
      );
      expect(rawProject(db, 'fake:e1')).toBe('feature-wt');

      const live = reproject(db, { home });
      for (const file of live.files) await ingestPlacesFile({ db, home }, file.source, file.file);
      expect(placeOf(db, 's1')).toMatchObject({ project: 'demo-app' });
      expect(rawProject(db, 'fake:e1')).toBe('feature-wt');
    } finally {
      db.close();
    }
  });

  it('treats a submodule as its own project', () => {
    const base = tempDir('origin-place-sub-');
    const sup = path.join(base, 'super-app');
    const sub = path.join(base, 'lib-mod');
    gitCheckout(sup);
    const gitDir = path.join(sup, '.git', 'modules', 'lib');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${gitDir}\n`);
    expect(resolvePlace(sub)).toMatchObject({ project: 'lib-mod', rootPath: path.resolve(sub) });
  });

  it('does not take a bare repo or an unreadable git dir', () => {
    const base = tempDir('origin-place-bare-');
    const bare = path.join(base, 'bare-app');
    fs.mkdirSync(path.join(bare, '.git'), { recursive: true });
    fs.writeFileSync(path.join(bare, '.git', 'config'), '[core]\nbare = true\n');
    expect(resolvePlace(bare)).toMatchObject({
      signal: 'segment',
      project: 'bare-app',
      rootPath: null,
    });
    const broken = path.join(base, 'broken-app');
    fs.mkdirSync(path.join(broken, '.git', 'config'), { recursive: true });
    expect(resolvePlace(broken).signal).toBe('segment');
  });

  it('does not take a symlink .git', () => {
    const base = tempDir('origin-place-link-');
    const dir = path.join(base, 'link-app');
    fs.mkdirSync(dir);
    try {
      fs.symlinkSync(path.join(dir, 'absent'), path.join(dir, '.git'));
    } catch {
      return;
    }
    expect(resolvePlace(dir).signal).toBe('segment');
  });
});

describe('a hub that cannot read the disk', () => {
  it('uses a project_root alias and otherwise keeps the directory string', () => {
    const home = tempDir('origin-place-hub-');
    const db = open(home);
    try {
      const cwd = 'C:\\work\\feature-wt';
      expect(recallScope(cwd, { onDisk: false, db })).toEqual({
        cwd,
        root: null,
        project: 'feature-wt',
      });
      const root = comparePath('D:\\work\\demo-app');
      db.prepare(
        `INSERT INTO project_root (path, project, root, signal, seen_at) VALUES (?, 'demo-app', ?, 'git', 1)`,
      ).run(comparePath(cwd), root);
      expect(recallScope(`${cwd}\\src`, { onDisk: false, db })).toEqual({
        cwd: `${cwd}\\src`,
        root,
        project: 'demo-app',
      });
      expect(recallScope('C:\\work\\acme', { onDisk: false })).toEqual({
        cwd: 'C:\\work\\acme',
        root: null,
        project: 'acme',
      });
    } finally {
      db.close();
    }
  });
});

describe('reads use session_place', () => {
  it('filters events, proposals, and entries by the resolved name', async () => {
    const base = tempDir('origin-place-read-');
    const home = path.join(base, 'home');
    const src = path.join(base, 'logs');
    const ts = Date.now();
    writeLog(src, {
      id: 'e1',
      session: 's1',
      ts,
      role: 'user',
      text: 'The cache holds retries',
      project: 'wt-name',
      cwd: 'D:\\demo\\wt-name',
    });
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(src));
      expect(
        db.prepare(`SELECT id FROM raw_file WHERE path = 'places.jsonl'`).get(),
      ).toBeUndefined();
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
      db.prepare(
        `INSERT INTO proposal (id, source, session_id, event_id, kind, text, confidence, project, at)
         VALUES ('prp_0000000000a1', 'fake', 's1', 'fake:e1', 'memory', 'Use a cache', 0.8, NULL, ?)`,
      ).run(ts);
      db.prepare(
        `INSERT INTO proposal (id, source, session_id, event_id, kind, text, confidence, project, at)
         VALUES ('prp_0000000000a2', 'fake', 's1', 'fake:e1', 'memory', 'Keep the name', 0.8, 'kept', ?)`,
      ).run(ts);
      expect(searchEvents(db, 'cache', { project: 'demo-app' }).map((h) => h.id)).toEqual([
        'fake:e1',
      ]);
      expect(searchEvents(db, 'cache', { project: 'wt-name' })).toEqual([]);
      expect(listSessions(db, { project: 'wt-name' })).toEqual([]);
      expect(listProjects(db).map((p) => p.project)).toEqual(['demo-app']);
      const feed = changesSince(db, { project: 'demo-app', now: ts + 1000 });
      expect(feed.events.map((e) => e.project)).toEqual(['demo-app']);
      expect(feed.entries.map((e) => e.id)).toEqual([entry.id]);
      expect(feed.proposals.map((p) => p.id)).toEqual(['prp_0000000000a1']);
      expect(
        changesSince(db, { project: 'wt-name', now: ts + 1000 }).entries.map((e) => e.id),
      ).toEqual([entry.id]);
      expect(changesSince(db, { project: 'wt-name', now: ts + 1000 }).events).toEqual([]);
      expect(listProposals(db, { project: 'demo-app' }).map((p) => p.id)).toEqual([
        'prp_0000000000a1',
      ]);
      expect(listProposals(db, { project: 'wt-name' })).toEqual([]);
      expect(listProposals(db, { project: 'kept' }).map((p) => [p.id, p.sessionProject])).toEqual([
        ['prp_0000000000a2', 'demo-app'],
      ]);
      expect(
        proposalProjects(db)
          .map((p) => p.project)
          .sort(),
      ).toEqual(['demo-app', 'kept']);
      expect(rawProject(db, 'fake:e1')).toBe('wt-name');
    } finally {
      db.close();
    }
  });

  it('leaves an explicit or manual name, and a project that is not the directory', async () => {
    const base = tempDir('origin-place-explicit-');
    const main = path.join(base, 'demo-app');
    gitCheckout(main);
    const home = path.join(base, 'home');
    const src = path.join(base, 'logs');
    writeLog(src, {
      id: 'e1',
      session: 's1',
      ts: Date.now(),
      role: 'user',
      text: 'Named by the line',
      project: 'chosen-app',
      cwd: main,
    });
    const db = open(home);
    try {
      await syncSource({ db, home }, explicitAdapter(src));
      expect(placeOf(db, 's1')).toMatchObject({ project: 'chosen-app', signal: 'explicit' });
      expect(
        db.prepare(`SELECT id FROM raw_file WHERE path = 'places.jsonl'`).get(),
      ).toBeUndefined();
      const dry = reproject(db, { home, dryRun: true });
      expect(dry.report.moves).toEqual([]);
      expect(placeOf(db, 's1')?.project).toBe('chosen-app');
      db.prepare(
        `UPDATE session_place SET signal = 'manual', project = 'manual-app' WHERE session_id = 's1'`,
      ).run();
      reproject(db, { home });
      expect(placeOf(db, 's1')).toMatchObject({ project: 'manual-app', signal: 'manual' });
    } finally {
      db.close();
    }
  });
});

describe('places.jsonl', () => {
  it('parses root and place lines, and ignores a parent line', () => {
    expect(
      parsePlaceLine(
        '{"v":1,"type":"parent","session":"s1","parent":"p1","via":"workflow","signal":"dwf_run"}',
      ),
    ).toEqual({
      events: [],
      sessionParents: [
        {
          sessionId: 's1',
          parentSessionId: 'p1',
          via: 'workflow',
          runGroup: null,
          runName: null,
          signal: 'dwf_run',
          fromAgent: false,
        },
      ],
    });
    const root = parsePlaceLine(
      '{"v":1,"type":"root","path":"d:/wt","project":"demo-app","root":"d:/demo-app","signal":"git"}',
    );
    expect(root.events).toEqual([]);
    expect(root.roots?.[0]).toMatchObject({ project: 'demo-app', signal: 'git' });
    const place = parsePlaceLine(
      '{"v":1,"type":"place","session":"s1","project":"demo-app","root":null,"signal":"agent"}',
    );
    expect(place.places?.[0]).toMatchObject({ sessionId: 's1', root: null, signal: 'agent' });
    expect(parsePlaceLine('{"v":1,"type":"other"}')).toEqual({ events: [] });
    expect(parsePlaceLine('not json')).toEqual({ events: [], warning: 'places.jsonl: not JSON' });
    expect(parsePlaceLine('[]').warning).toMatch(/JSON object/);
    expect(parsePlaceLine('{"v":2}').warning).toMatch(/"v" must be 1/);
  });

  it('does not let a place line replace an explicit name', async () => {
    const base = tempDir('origin-place-line-');
    const home = path.join(base, 'home');
    const db = open(home);
    try {
      const gitLine =
        '{"v":1,"type":"place","session":"s1","project":"demo-app","root":"d:/demo-app","signal":"git"}';
      const pending = [gitLine, gitLine];
      const file = {
        absPath: 'places.jsonl',
        relPath: 'places.jsonl',
        generated: {
          token: 't1',
          mtimeMs: 1,
          next() {
            const row = pending.shift();
            return row ? [row] : [];
          },
        },
      };
      await ingestPlacesFile({ db, home }, 'fake', file);
      expect(placeOf(db, 's1')).toMatchObject({ project: 'demo-app', signal: 'git' });
      db.prepare(`UPDATE session_place SET signal = 'explicit', project = 'chosen-app'`).run();
      file.generated.token = 't2';
      await ingestPlacesFile({ db, home }, 'fake', file);
      expect(placeOf(db, 's1')).toMatchObject({ project: 'chosen-app', signal: 'explicit' });
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM session_parent').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is store format 10 and starts empty', () => {
    expect(STORE_VERSION).toBe(10);
    const db = open(tempDir('origin-place-ver-'));
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
      expect((db.prepare('SELECT COUNT(*) AS n FROM session_place').get() as { n: number }).n).toBe(
        0,
      );
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_root').get() as { n: number }).n).toBe(
        0,
      );
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM session_parent').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('skips a bad line, warns, and keeps the other lines and sources', async () => {
    const base = tempDir('origin-place-bad-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const other = path.join(base, 'other');
    fs.mkdirSync(logs);
    fs.mkdirSync(other);
    const first = placeJson('s1', 'demo-app');
    const second = placeJson('s2', 'other-app');
    fs.writeFileSync(path.join(logs, 'places.jsonl'), `${first}\nnot json\n${second}\n`);
    fs.writeFileSync(path.join(logs, 'e.jsonl'), line('e1', 's', 1, 'user', 'kept'));
    fs.writeFileSync(path.join(other, 'e.jsonl'), line('o1', 's', 2, 'user', 'other source'));
    const warnings: string[] = [];
    const db = open(home);
    try {
      const synced = await syncSource(
        { db, home, log: (m) => warnings.push(m) },
        fakeAdapter(logs),
      );
      expect(synced.parseErrors).toBe(1);
      expect(synced.eventsAdded).toBe(1);
      expect(placeOf(db, 's1')).toMatchObject({ project: 'demo-app', signal: 'git' });
      expect(placeOf(db, 's2')).toMatchObject({ project: 'other-app', signal: 'git' });
      expect(getEvent(db, 'fake:e1')?.text).toBe('kept');
      expect(warnings.some((m) => m.includes('warning') && m.includes('not JSON'))).toBe(true);
      await syncSource({ db, home }, fakeAdapter(other, 'other'));
      expect(getEvent(db, 'other:o1')?.text).toBe('other source');
    } finally {
      db.close();
    }
    const again = open(home);
    try {
      const againLogs: string[] = [];
      reparsePlaces(again, home, (m) => againLogs.push(m));
      expect(placeOf(again, 's1')?.project).toBe('demo-app');
      expect(placeOf(again, 's2')?.project).toBe('other-app');
      expect(againLogs.some((m) => m.includes('warning') && m.includes('not JSON'))).toBe(true);
    } finally {
      again.close();
    }
  });

  it('reads a line appended after a truncated one', async () => {
    const base = tempDir('origin-place-trunc-');
    const home = path.join(base, 'home');
    const db = open(home);
    const first = placeJson('s1', 'demo-app');
    const second = placeJson('s2', 'other-app');
    const warnings: string[] = [];
    let batch = [first];
    const file = {
      absPath: 'places.jsonl',
      relPath: 'places.jsonl',
      generated: {
        token: 't1',
        mtimeMs: 1,
        next() {
          const out = batch;
          batch = [];
          return out;
        },
      },
    };
    try {
      await ingestPlacesFile({ db, home }, 'fake', file);
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
      const row = db
        .prepare(
          `SELECT id, mirror, bytes_ingested AS bytes FROM raw_file WHERE path = 'places.jsonl'`,
        )
        .get() as { id: number; mirror: string; bytes: number };
      const fragment = Buffer.from('{"trunc');
      fs.appendFileSync(tailPath(home, row.mirror), fragment);
      db.prepare('UPDATE raw_file SET bytes_ingested = ? WHERE id = ?').run(
        row.bytes + fragment.length,
        row.id,
      );
      batch = [second];
      file.generated.token = 't2';
      await ingestPlacesFile({ db, home, log: (m) => warnings.push(m) }, 'fake', file);
      expect(placeOf(db, 's2')).toMatchObject({ project: 'other-app', signal: 'git' });
      const text = mirrorText(db, home, row.id);
      expect(text).toBe(`${first}\n{"trunc\n${second}\n`);
      expect(warnings.some((m) => m.includes('closed a line that did not end'))).toBe(true);

      const hubHome = path.join(base, 'hub');
      const hub = open(hubHome);
      const hubLogs: string[] = [];
      try {
        fs.mkdirSync(path.join(base, 'empty'));
        const pushed = appendRemote(
          { db: hub, home: hubHome, log: (m) => hubLogs.push(m) },
          fakeAdapter(path.join(base, 'empty')),
          {
            device: 'laptop',
            source: 'fake',
            path: '/tmp/demo/places.jsonl',
            relPath: 'places.jsonl',
            generation: 1,
            offset: 0,
            data: Buffer.from(text),
          },
        );
        expect(pushed).toMatchObject({ ok: true, parseErrors: 1 });
        expect(placeOf(hub, 's1')?.project).toBe('demo-app');
        expect(placeOf(hub, 's2')?.project).toBe('other-app');
        expect(hubLogs.some((m) => m.includes('warning') && m.includes('not JSON'))).toBe(true);
      } finally {
        hub.close();
      }
    } finally {
      db.close();
    }
    const again = open(home);
    try {
      const againLogs: string[] = [];
      reparsePlaces(again, home, (m) => againLogs.push(m));
      expect(placeOf(again, 's2')?.project).toBe('other-app');
      expect(againLogs.some((m) => m.includes('warning') && m.includes('not JSON'))).toBe(true);
    } finally {
      again.close();
    }
  });
});

function placeJson(session: string, project: string): string {
  return JSON.stringify({ v: 1, type: 'place', session, project, root: null, signal: 'git' });
}
