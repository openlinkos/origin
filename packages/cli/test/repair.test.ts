import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrokAdapter } from '@openlinkos/origin-adapters';
import {
  dbPath,
  getSessionParent,
  makeRelay,
  openDatabase,
  readMirror,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const T0 = Date.parse('2026-10-20T01:00:00Z');
const MAIN = '01a0f000-0000-7000-8000-000000000001';
const CHILD = '01a0f000-0000-7000-8000-0000000000c1';
const KEPT = '01a0f000-0000-7000-8000-0000000000k1';

let tmp: string;
let home: string;
let saved: string | undefined;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-repair-'));
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

function grokLine(session: string, n: number, update: Record<string, unknown>): string {
  return `${JSON.stringify({
    method: 'session/update',
    params: {
      _meta: { agentTimestampMs: T0 + n * 1000, eventId: `${session}-${n}` },
      sessionId: session,
      update,
    },
    timestamp: (T0 + n * 1000) / 1000,
  })}\n`;
}

function writeGrok(grokHome: string, group: string, session: string, body: string): void {
  const dir = path.join(grokHome, 'sessions', group, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), body);
}

function placesBytes(db: ReturnType<typeof openDatabase>, origin: string): number {
  const raw = db
    .prepare(
      `SELECT id, bytes_ingested AS bytes FROM raw_file
        WHERE source = 'grok' AND path LIKE '%places.jsonl'`,
    )
    .all() as Array<{ id: number; bytes: number }>;
  return raw.reduce((sum, row) => sum + readMirror(db, origin, row.id, 0, row.bytes).length, 0);
}

describe('origin sessions repair', () => {
  it('fills a missing place and a parent the mirror already named, and can be repeated', async () => {
    const grokHome = path.join(tmp, 'grok');
    const work = path.join(tmp, 'demo-app', 'w1-storage');
    const other = path.join(tmp, 'other-app');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    const prompt = (session: string) =>
      grokLine(session, 1, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Work' },
        _meta: { promptIndex: 0 },
      });
    writeGrok(
      grokHome,
      encodeURIComponent(work),
      MAIN,
      prompt(MAIN) +
        grokLine(MAIN, 2, {
          sessionUpdate: 'subagent_spawned',
          child_session_id: CHILD,
          parent_session_id: MAIN,
        }),
    );
    writeGrok(grokHome, encodeURIComponent(other), KEPT, prompt(KEPT));

    const db = openDatabase(dbPath(home));
    await syncSource({ db, home }, createGrokAdapter({ home: grokHome }));
    expect(getSessionParent(db, 'grok', CHILD)?.signal).toBe('subagent_spawned');
    expect(
      db.prepare('SELECT project FROM session_place WHERE session_id = ?').get(MAIN),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT project, signal FROM session_place WHERE session_id = ?').get(KEPT),
    ).toMatchObject({ project: 'other-app', signal: 'git' });
    db.prepare('DELETE FROM session_parent').run();
    db.prepare('UPDATE session SET cwd = ? WHERE session_id = ?').run(work, KEPT);
    db.close();

    fs.mkdirSync(path.join(tmp, 'demo-app', '.git'), { recursive: true });
    fs.mkdirSync(work, { recursive: true });

    expect(await main(['sessions', 'repair', '--dry-run'])).toBe(0);
    expect(out.join('\n')).toContain('parent links filled: 1');
    expect(out.join('\n')).toContain('w1-storage → demo-app');
    let check = openDatabase(dbPath(home));
    expect(getSessionParent(check, 'grok', CHILD)).toBeNull();
    expect(
      check.prepare('SELECT project FROM session_place WHERE session_id = ?').get(MAIN),
    ).toBeUndefined();
    expect(
      check.prepare('SELECT project FROM session_place WHERE session_id = ?').get(KEPT),
    ).toEqual({ project: 'other-app' });
    const bytes = placesBytes(check, home);
    check.close();

    out.length = 0;
    expect(await main(['sessions', 'repair'])).toBe(0);
    expect(out.join('\n')).toContain('parent links filled: 1');
    expect(out.join('\n')).toContain('w1-storage → demo-app');
    check = openDatabase(dbPath(home));
    expect(getSessionParent(check, 'grok', CHILD)).toMatchObject({
      parentSessionId: MAIN,
      signal: 'subagent_spawned',
    });
    expect(
      check.prepare('SELECT project, signal FROM session_place WHERE session_id = ?').get(MAIN),
    ).toMatchObject({ project: 'demo-app', signal: 'git' });
    expect(
      check.prepare('SELECT project, signal FROM session_place WHERE session_id = ?').get(KEPT),
    ).toMatchObject({ project: 'other-app', signal: 'git' });
    const filled = placesBytes(check, home);
    expect(filled).toBeGreaterThan(bytes);
    check.close();

    out.length = 0;
    expect(await main(['sessions', 'repair'])).toBe(0);
    expect(out.join('\n')).toContain('parent links filled: 0');
    expect(out.join('\n')).not.toContain('w1-storage → demo-app');
    check = openDatabase(dbPath(home));
    expect(placesBytes(check, home)).toBe(filled);
    expect(getSessionParent(check, 'grok', CHILD)?.parentSessionId).toBe(MAIN);
    check.close();

    out.length = 0;
    expect(await main(['sessions', 'repair', '--dry-run'])).toBe(0);
    expect(out.join('\n')).toContain('parent links filled: 0');
    expect(out.join('\n')).not.toContain('w1-storage → demo-app');
    check = openDatabase(dbPath(home));
    expect(placesBytes(check, home)).toBe(filled);
    check.close();
  });

  it('refuses a relay', async () => {
    const relay = openDatabase(dbPath(home));
    makeRelay(relay);
    relay.close();
    expect(await main(['sessions', 'repair', '--dry-run'])).toBe(1);
    expect(err.join('\n')).toContain('relay');
    const again = openDatabase(dbPath(home));
    expect(again.prepare('SELECT COUNT(*) AS n FROM session_place').get()).toEqual({ n: 0 });
    again.close();
  });
});
