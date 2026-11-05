import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath, makeRelay, openDatabase, syncSource } from '@openlinkos/origin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import { main } from '../src/main.js';

let tmp: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];

function keepEnv(): void {
  saved = {
    ORIGIN_HOME: process.env.ORIGIN_HOME,
    GROK_HOME: process.env.GROK_HOME,
    ZCODE_HOME: process.env.ZCODE_HOME,
    ORIGIN_ZCODE_HOME: process.env.ORIGIN_ZCODE_HOME,
  };
}

function pointHomes(origin: string, grok: string, zcode: string): void {
  process.env.ORIGIN_HOME = origin;
  process.env.GROK_HOME = grok;
  process.env.ZCODE_HOME = zcode;
  delete process.env.ORIGIN_ZCODE_HOME;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function spy(): void {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
}

describe('origin sessions reproject', () => {
  it('resolves a work tree, and timeline, search, show, and projects use that name', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-place-'));
    keepEnv();
    const home = path.join(tmp, 'home');
    const grok = path.join(tmp, 'grok');
    const zcode = path.join(tmp, 'zcode');
    fs.mkdirSync(grok);
    fs.mkdirSync(zcode);
    const mainRepo = path.join(tmp, 'demo-app');
    const wt = path.join(tmp, 'feature-wt');
    fs.mkdirSync(path.join(mainRepo, '.git'), { recursive: true });
    const gitDir = path.join(mainRepo, '.git', 'worktrees', 'feature');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    const src = path.join(tmp, 'logs');
    fs.mkdirSync(src);
    fs.writeFileSync(
      path.join(src, 's.jsonl'),
      `${JSON.stringify({
        id: 'e1',
        session: 's1',
        ts: Date.now(),
        role: 'user',
        text: 'The cache holds retries',
        project: 'feature-wt',
        cwd: wt,
      })}\n`,
    );
    const db = openDatabase(dbPath(home));
    await syncSource({ db, home }, fakeAdapter(src));
    db.prepare('DELETE FROM session_place').run();
    db.prepare('DELETE FROM project_root').run();
    db.close();
    pointHomes(home, grok, zcode);
    spy();
    expect(await main(['sessions', 'reproject', '--dry-run'])).toBe(0);
    const dry = out.join('\n');
    expect(dry).toContain('feature-wt → demo-app  1 sessions');
    expect(dry).toContain('entries still named an old project: 0');
    expect(dry).toContain('0 children →');
    const check = openDatabase(dbPath(home));
    expect(check.prepare('SELECT project FROM session_place').get()).toBeUndefined();
    expect(
      (
        check.prepare('SELECT project FROM event WHERE id = ?').get('fake:e1') as {
          project: string;
        }
      ).project,
    ).toBe('feature-wt');
    check.close();
    out = [];
    expect(await main(['sessions', 'reproject'])).toBe(0);
    out = [];
    expect(await main(['projects'])).toBe(0);
    expect(out.join('\n')).toContain('demo-app');
    expect(out.join('\n')).not.toContain('feature-wt');
    out = [];
    expect(await main(['timeline', '--project', 'demo-app', '--since', '30d'])).toBe(0);
    expect(out.join('\n')).toContain('demo-app');
    expect(out.join('\n')).toContain('s1');
    out = [];
    expect(await main(['timeline', '--project', 'feature-wt', '--since', '30d'])).toBe(0);
    expect(out.join('\n')).toContain('No sessions');
    out = [];
    expect(await main(['timeline', '--session', 's1'])).toBe(0);
    expect(out.join('\n')).toContain('project demo-app');
    out = [];
    expect(await main(['search', 'cache', '--project', 'demo-app'])).toBe(0);
    expect(out.join('\n')).toContain('demo-app');
    out = [];
    expect(await main(['search', 'cache', '--project', 'feature-wt'])).toBe(0);
    expect(out.join('\n')).not.toContain('fake:e1');
    out = [];
    expect(await main(['show', 'fake:e1'])).toBe(0);
    expect(out.join('\n')).toContain('Project  demo-app');
  });

  it('reads a gone directory from the agent, and a relay writes nothing', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-agent-'));
    keepEnv();
    const home = path.join(tmp, 'home');
    const grok = path.join(tmp, 'grok');
    const zcode = path.join(tmp, 'zcode');
    const mainRepo = path.join(tmp, 'demo-app');
    fs.mkdirSync(path.join(mainRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(grok, 'sessions', 'group', 's1'), { recursive: true });
    fs.writeFileSync(
      path.join(grok, 'sessions', 'group', 's1', 'summary.json'),
      JSON.stringify({ git_root_dir: mainRepo }),
    );
    const zdbPath = path.join(zcode, 'cli', 'db', 'db.sqlite');
    fs.mkdirSync(path.dirname(zdbPath), { recursive: true });
    const zdb = new DatabaseSync(zdbPath);
    zdb.exec('CREATE TABLE session (id TEXT, directory TEXT)');
    zdb.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('s2', mainRepo);
    zdb.close();
    const src = path.join(tmp, 'logs');
    fs.mkdirSync(src);
    const gone = 'D:\\missing\\feature-wt';
    const line = (id: string, session: string) =>
      `${JSON.stringify({
        id,
        session,
        ts: Date.now(),
        role: 'user',
        text: 'The cache holds retries',
        project: 'feature-wt',
        cwd: gone,
      })}\n`;
    fs.writeFileSync(path.join(src, 'g.jsonl'), line('e1', 's1'));
    fs.writeFileSync(path.join(src, 'z.jsonl'), line('e2', 's2'));
    const db = openDatabase(dbPath(home));
    await syncSource({ db, home }, fakeAdapter(src, 'grok'));
    await syncSource({ db, home }, fakeAdapter(src, 'zcode'));
    db.close();
    pointHomes(home, grok, zcode);
    spy();
    expect(await main(['sessions', 'reproject', '--dry-run'])).toBe(0);
    expect(out.join('\n')).toContain('feature-wt → demo-app  2 sessions');
    const afterDry = openDatabase(dbPath(home));
    expect(afterDry.prepare('SELECT COUNT(*) AS n FROM session_place').get()).toEqual({ n: 0 });
    afterDry.close();
    expect(await main(['sessions', 'reproject'])).toBe(0);
    const after = openDatabase(dbPath(home));
    const rows = after
      .prepare('SELECT source, project, signal FROM session_place ORDER BY source')
      .all() as Array<{ source: string; project: string; signal: string }>;
    expect(rows).toEqual([
      { source: 'grok', project: 'demo-app', signal: 'agent' },
      { source: 'zcode', project: 'demo-app', signal: 'agent' },
    ]);
    after.close();

    const relayHome = path.join(tmp, 'relay');
    const relay = openDatabase(dbPath(relayHome));
    makeRelay(relay);
    relay.close();
    process.env.ORIGIN_HOME = relayHome;
    out = [];
    err = [];
    expect(await main(['sessions', 'reproject', '--dry-run'])).toBe(1);
    expect(err.join('\n')).toContain('relay');
    expect(err.join('\n')).not.toContain('on the hub');
    const relayDb = openDatabase(dbPath(relayHome));
    expect(relayDb.prepare('SELECT COUNT(*) AS n FROM session_place').get()).toEqual({ n: 0 });
    expect(
      relayDb.prepare(`SELECT id FROM raw_file WHERE path = 'places.jsonl'`).get(),
    ).toBeUndefined();
    relayDb.close();
  });
});
