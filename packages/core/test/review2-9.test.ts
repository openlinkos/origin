import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLinesAdapter } from '@openlinkos/origin-adapters';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  changesSince,
  childSessions,
  type Database,
  forget,
  ingestPlacesFile,
  isFoldedChild,
  listEntries,
  listEvents,
  listSessions,
  openDatabase,
  remember,
  reparsePlaces,
  reproject,
  searchEntries,
  searchEvents,
  syncFile,
  syncSource,
} from '../src/index.js';
import { tailPath } from '../src/mirror.js';
import { fakeAdapter } from './helpers.js';

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

function placeJson(session: string, project: string): string {
  return JSON.stringify({ v: 1, type: 'place', session, project, root: null, signal: 'git' });
}

function writeLog(dir: string, row: Record<string, unknown>, file = 's.jsonl'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(row)}\n`);
}

describe('a session ingested by a hook', () => {
  it('resolves a linked work tree when syncFile ingests it before syncSource', async () => {
    const base = tempDir('origin-review2-hook-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const main = path.join(base, 'demo-app');
    const wt = path.join(base, 'feature-wt');
    gitCheckout(main);
    linkedWorktree(main, wt);
    writeLog(logs, {
      id: 'e1',
      session: 's1',
      ts: 1_000,
      role: 'user',
      text: 'Hooked from the work tree',
      cwd: wt,
      project: 'feature-wt',
    });
    const db = open(home);
    try {
      const adapter = fakeAdapter(logs);
      await syncFile({ db, home }, adapter, path.join(logs, 's.jsonl'));
      await syncSource({ db, home }, adapter);
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
    } finally {
      db.close();
    }
  });
});

describe('two syncs of one work tree', () => {
  it('appends one place line when two connections sync the same session', async () => {
    const base = tempDir('origin-review2-race-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const main = path.join(base, 'demo-app');
    const wt = path.join(base, 'feature-wt');
    gitCheckout(main);
    linkedWorktree(main, wt);
    writeLog(logs, {
      id: 'e1',
      session: 's1',
      ts: 1_000,
      role: 'user',
      text: 'Synced twice',
      cwd: wt,
      project: 'feature-wt',
    });
    const db = open(home);
    const second = openDatabase(path.join(home, 'origin.db'));
    try {
      const adapter = fakeAdapter(logs);
      await Promise.all([
        syncSource({ db, home }, adapter),
        syncSource({ db: second, home }, adapter),
      ]);
      expect(placeOf(db, 's1')?.project).toBe('demo-app');
      const raw = db.prepare("SELECT id FROM raw_file WHERE path = 'places.jsonl'").get() as {
        id: number;
      };
      const text = fs.readFileSync(
        tailPath(
          home,
          (db.prepare('SELECT mirror FROM raw_file WHERE id = ?').get(raw.id) as { mirror: string })
            .mirror,
        ),
        'utf8',
      );
      const places = text.split('\n').filter((row) => row.includes('"type":"place"'));
      expect(places).toHaveLength(1);
    } finally {
      second.close();
      db.close();
    }
  });
});

describe('a lines file named places.jsonl', () => {
  it("keeps the events in a person's places.jsonl and does not apply its place lines", async () => {
    const base = tempDir('origin-review2-lines-');
    const home = path.join(base, 'home');
    const dir = path.join(base, 'chat');
    const event = (id: string, session: string, text: string) =>
      JSON.stringify({
        id,
        session,
        time: '2026-11-02T09:30:00Z',
        role: 'user',
        kind: 'message',
        text,
      });
    const stolen = JSON.stringify({
      v: 1,
      type: 'place',
      session: 's-notes',
      project: 'stolen',
      root: null,
      signal: 'git',
    });
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'notes', 'places.jsonl'),
      `${event('m1', 's-notes', 'kept in notes')}\n${stolen}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'places.jsonl'),
      `${event('m2', 's-top', 'kept at the top')}\n${JSON.stringify({
        v: 1,
        type: 'place',
        session: 's-top',
        project: 'stolen',
        root: null,
        signal: 'git',
      })}\n`,
    );
    const db = open(home);
    try {
      await syncSource({ db, home }, createLinesAdapter({ id: 'chat-ops', dir }));
      expect(
        listEvents(db, {})
          .map((e) => e.text)
          .sort(),
      ).toEqual(['kept at the top', 'kept in notes']);
      expect(placeOf(db, 's-notes')).toBeUndefined();
      expect(placeOf(db, 's-top')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('reproject on a hub', () => {
  it('keeps a device conclusion when the hub reprojects', async () => {
    const base = tempDir('origin-review2-hub-');
    const home = path.join(base, 'hub');
    const main = path.join(base, 'demo-app');
    gitCheckout(main);
    const db = open(home);
    try {
      const session = `${JSON.stringify({
        id: 'e1',
        session: 's1',
        ts: 1_000,
        role: 'user',
        text: 'On the laptop',
        cwd: main,
        project: 'laptop-proj',
      })}\n`;
      expect(
        appendRemote({ db, home }, fakeAdapter(path.join(base, 'empty')), {
          device: 'laptop',
          source: 'fake',
          path: '/home/me/laptop-proj/s.jsonl',
          relPath: 's.jsonl',
          generation: 1,
          offset: 0,
          data: Buffer.from(session),
        }).ok,
      ).toBe(true);
      fs.mkdirSync(path.join(base, 'empty'), { recursive: true });
      expect(
        appendRemote({ db, home }, fakeAdapter(path.join(base, 'empty')), {
          device: 'laptop',
          source: 'fake',
          path: 'places.jsonl',
          relPath: 'places.jsonl',
          generation: 1,
          offset: 0,
          data: Buffer.from(`${placeJson('s1', 'laptop-proj')}\n`),
        }).ok,
      ).toBe(true);
      expect(placeOf(db, 's1')?.project).toBe('laptop-proj');
      const result = reproject(db, { home });
      for (const { source, file } of result.files) {
        await ingestPlacesFile({ db, home }, source, file);
      }
      expect(placeOf(db, 's1')?.project).toBe('laptop-proj');
    } finally {
      db.close();
    }
  });
});

describe('a forgotten session in the middle', () => {
  function chain(home: string, logs: string): Database {
    const parents = (session: string, parent: string) => [
      { session, parent, via: 'subagent' as const, signal: 'parent_id' },
    ];
    const row = (id: string, session: string, text: string, parent?: string) => ({
      id,
      session,
      ts: 1_000,
      role: 'user' as const,
      text,
      parents: parent ? parents(session, parent) : undefined,
    });
    writeLog(logs, row('r1', 'root', 'The root'), 'root.jsonl');
    writeLog(logs, row('m1', 'mid', 'The middle', 'root'), 'mid.jsonl');
    writeLog(logs, row('g1', 'grand', 'zebragrand finishes', 'mid'), 'grand.jsonl');
    const db = open(home);
    return db;
  }

  it('hangs the grandchild under the nearest visible ancestor', async () => {
    const base = tempDir('origin-review2-fold-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const db = chain(home, logs);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      expect(childSessions(db, 'fake', 'root').map((s) => s.sessionId)).toEqual(['mid']);
      forget(db, 'fake:m1', { reason: 'The middle run is gone', author: 'user@laptop' });
      expect(childSessions(db, 'fake', 'root').map((s) => s.sessionId)).toEqual(['grand']);
      expect(isFoldedChild(db, 'fake', 'grand')).toBe(true);
      expect(listSessions(db, { topLevel: true }).map((s) => s.sessionId)).not.toContain('grand');
      expect(childSessions(db, 'fake', 'root')[0]).toMatchObject({
        parentSessionId: 'root',
        via: 'subagent',
      });
    } finally {
      db.close();
    }
  });

  it('still finds the grandchild text after the middle session is forgotten', async () => {
    const base = tempDir('origin-review2-find-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const db = chain(home, logs);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      forget(db, 'fake:m1', { reason: 'The middle run is gone', author: 'user@laptop' });
      expect(searchEvents(db, 'zebragrand').map((h) => h.id)).toContain('fake:g1');
    } finally {
      db.close();
    }
  });
});

describe('an entry cited from another project', () => {
  it('keeps the entry in the project it was given', async () => {
    const base = tempDir('origin-review2-entry-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    const ts = Date.now();
    writeLog(logs, {
      id: 'e1',
      session: 's1',
      ts,
      role: 'user',
      text: 'A session in the other tree',
      project: 'other-app',
      cwd: 'D:/work/other-app',
    });
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      db.prepare(
        `INSERT INTO session_place (source, session_id, project, root, signal)
         VALUES ('fake', 's1', 'other-app', 'd:/work/other-app', 'git')`,
      ).run();
      const entry = remember(db, {
        kind: 'cognition',
        text: 'Stay with the project the entry names.',
        confidence: 0.9,
        author: 'test',
        project: 'demo-app',
        sources: [{ eventId: 'fake:e1' }],
      });
      expect(listEntries(db, { project: 'demo-app' }).map((e) => e.id)).toEqual([entry.id]);
      expect(listEntries(db, { project: 'other-app' })).toEqual([]);
      expect(searchEntries(db, 'Stay', { project: 'demo-app' }).map((e) => e.id)).toEqual([
        entry.id,
      ]);
      expect(searchEntries(db, 'Stay', { project: 'other-app' })).toEqual([]);
      expect(
        changesSince(db, { project: 'demo-app', now: ts + 1000 }).entries.map((e) => e.id),
      ).toEqual([entry.id]);
      expect(changesSince(db, { project: 'other-app', now: ts + 1000 }).entries).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('places re-read while a newer line arrives', () => {
  it('applies the line that landed during the re-read', async () => {
    const home = tempDir('origin-review2-lock-');
    const db = open(home);
    const oldLine = placeJson('s1', 'old-app');
    const newer = placeJson('s1', 'newer-app');
    let pending: string[] | null = ['{"v":2}', oldLine];
    const file = {
      absPath: 'places.jsonl',
      relPath: 'places.jsonl',
      generated: {
        token: 'old',
        mtimeMs: 1,
        next: () => {
          const out = pending ?? [];
          pending = null;
          return out;
        },
      },
    };
    try {
      await ingestPlacesFile({ db, home }, 'fake', file);
      expect(placeOf(db, 's1')?.project).toBe('old-app');
      let appended = false;
      reparsePlaces(db, home, () => {
        if (appended) return;
        appended = true;
        const row = db
          .prepare(
            `SELECT id, mirror, bytes_ingested AS bytes, lines_ingested AS lines
               FROM raw_file WHERE path = 'places.jsonl'`,
          )
          .get() as { id: number; mirror: string; bytes: number; lines: number };
        const extra = Buffer.from(`${newer}\n`);
        fs.appendFileSync(tailPath(home, row.mirror), extra);
        db.prepare('UPDATE raw_file SET bytes_ingested = ?, lines_ingested = ? WHERE id = ?').run(
          row.bytes + extra.length,
          row.lines + 1,
          row.id,
        );
      });
      expect(placeOf(db, 's1')?.project).toBe('newer-app');
    } finally {
      db.close();
    }
  });
});

describe('the upgrade guide', () => {
  it('says a work-tree session already in the mirror waits for reproject', () => {
    const text = fs.readFileSync(
      path.join(import.meta.dirname, '../../../docs/guide/upgrading.md'),
      'utf8',
    );
    expect(text).toContain('origin sessions reproject');
    expect(text).toMatch(/already in the mirror/);
  });
});
