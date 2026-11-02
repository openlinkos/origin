import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  describeSession,
  describeThread,
  followLink,
  forget,
  getSession,
  isWorkBranch,
  listSessions,
  openDatabase,
  rebuildThreads,
  remember,
  resolveId,
  restore,
  syncSource,
  threadIdOf,
  threadOf,
  threadSummary,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 9);

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-threads-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Line {
  id: string;
  session: string;
  ts: number;
  role?: 'user' | 'assistant';
  text?: string;
  kind?: string;
  project?: string;
  branch?: string;
}

/** Write a session's lines to its own log file (appending), in the fake adapter's format. */
function write(file: string, lines: Line[], dir?: string): void {
  const text = lines
    .map((l) => JSON.stringify({ role: 'user', text: `prompt ${l.id}`, ...l }))
    .join('\n');
  fs.appendFileSync(path.join(dir ?? logs, file), `${text}\n`);
}

/** A session of two events, a day long, on a branch. */
function session(id: string, start: number, branch?: string, project = 'demo'): Line[] {
  return [
    { id: `${id}a`, session: id, ts: start, text: `Work on ${id}`, branch, project },
    {
      id: `${id}b`,
      session: id,
      ts: start + DAY,
      role: 'assistant',
      text: `Done with ${id}`,
      branch,
      project,
    },
  ];
}

/** What `follow` returns, as the agent's log records its result. */
const followResult = (link: string, follows: string) =>
  JSON.stringify({ link, follows, thread: null, note: 'goes on with it' }, null, 2);

const sync = (source = 'fake', dir = logs) => syncSource({ db, home }, fakeAdapter(dir, source));

/** The threads of the store: each thread id with its members, sorted. */
function threads(): Record<string, string[]> {
  const rows = db
    .prepare('SELECT thread_id, source, session_id FROM session_thread ORDER BY 1, 2, 3')
    .all() as Array<{ thread_id: string; source: string; session_id: string }>;
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    out[r.thread_id] = [...(out[r.thread_id] ?? []), `${r.source}:${r.session_id}`];
  }
  return out;
}

const tables = () => ({
  threads: db.prepare('SELECT * FROM session_thread ORDER BY 1, 2').all(),
  follows: db.prepare('SELECT * FROM session_follow ORDER BY event_id').all(),
});

describe('threads by branch (R2)', () => {
  it('join sessions of one project on one work branch, within 30 days of each other', async () => {
    write('s1.jsonl', session('s1', T0, 'feat-x'));
    write('s2.jsonl', session('s2', T0 + 20 * DAY, 'feat-x'));
    // 31 days after s2 ended: a new piece of work on a reused branch name.
    write('s3.jsonl', session('s3', T0 + 52 * DAY, 'feat-x'));
    write('s4.jsonl', session('s4', T0 + DAY, 'main'));
    write('s5.jsonl', session('s5', T0 + 2 * DAY, 'main'));
    write('s6.jsonl', session('s6', T0 + DAY, 'feat-x', 'other'));
    await sync();
    expect(threads()).toEqual({ [threadIdOf('fake', 's1')]: ['fake:s1', 'fake:s2'] });
    expect(threadOf(db, 'fake', 's3')).toBeNull();
    expect(getSession(db, 'fake', 's2')?.thread).toBe(threadIdOf('fake', 's1'));
    expect(listSessions(db, { since: 0 }).find((s) => s.sessionId === 's4')?.thread).toBeNull();
    expect(isWorkBranch('Main')).toBe(false);
    expect(isWorkBranch('HEAD')).toBe(false);
    expect(isWorkBranch('fix/login')).toBe(true);
  });

  it("take a session's branch from most of its events, the latest of those that tie", async () => {
    write('s1.jsonl', [
      { id: 'a', session: 's1', ts: T0, branch: 'main' },
      { id: 'b', session: 's1', ts: T0 + 1, branch: 'feat-y' },
      { id: 'c', session: 's1', ts: T0 + 2, branch: 'feat-y' },
      { id: 'd', session: 's1', ts: T0 + 3 },
    ]);
    write('s2.jsonl', [
      { id: 'e', session: 's2', ts: T0, branch: 'one' },
      { id: 'f', session: 's2', ts: T0 + 5, branch: 'two' },
    ]);
    await sync();
    const branch = (id: string) =>
      (
        db.prepare('SELECT git_branch FROM session WHERE session_id = ?').get(id) as {
          git_branch: string | null;
        }
      ).git_branch;
    expect(branch('s1')).toBe('feat-y');
    expect(branch('s2')).toBe('two');
  });
});

describe('threads by follow links (R1)', () => {
  it('are derived from the result of follow in an agent log, and join the two sessions', async () => {
    write('s1.jsonl', session('s1', T0));
    write('s2.jsonl', [
      ...session('s2', T0 + 3 * DAY),
      {
        id: 's2c',
        session: 's2',
        ts: T0 + 3 * DAY + 10,
        role: 'user',
        kind: 'tool_result',
        text: followResult('lnk_0123456789ab', 'fake:s1'),
      },
    ]);
    await sync();
    expect(tables().follows).toEqual([
      {
        source: 'fake',
        session_id: 's2',
        link_id: 'lnk_0123456789ab',
        target_source: 'fake',
        target_session_id: 's1',
        event_id: 'fake:s2c',
      },
    ]);
    expect(threads()).toEqual({ [threadIdOf('fake', 's1')]: ['fake:s1', 'fake:s2'] });
  });

  it('are not taken from a result that only quotes one, nor from a message', async () => {
    const quoted = JSON.stringify({
      events: [{ text: followResult('lnk_aaaaaaaaaaaa', 'fake:s1') }],
    });
    expect(followLink(quoted)).toBeNull();
    expect(followLink(followResult('lnk_aaaaaaaaaaaa', 'fake:s1'))).toEqual({
      link: 'lnk_aaaaaaaaaaaa',
      source: 'fake',
      sessionId: 's1',
    });
    write('s1.jsonl', session('s1', T0));
    write('s2.jsonl', [
      ...session('s2', T0 + DAY),
      { id: 'q', session: 's2', ts: T0 + DAY + 5, kind: 'tool_result', text: quoted },
      {
        id: 'm',
        session: 's2',
        ts: T0 + DAY + 6,
        role: 'assistant',
        text: followResult('lnk_bbbbbbbbbbbb', 'fake:s1'),
      },
    ]);
    await sync();
    expect(tables().follows).toEqual([]);
    expect(threads()).toEqual({});
  });

  it('wait for a session that arrives later, and link the sessions of two agents', async () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    write(
      'b2.jsonl',
      [
        ...session('b2', T0 + 5 * DAY),
        {
          id: 'b2c',
          session: 'b2',
          ts: T0 + 5 * DAY + 1,
          kind: 'tool_result',
          text: followResult('lnk_0000000000c1', 'fake:a1'),
        },
      ],
      other,
    );
    await sync('other', other);
    expect(threads()).toEqual({});
    write('a1.jsonl', session('a1', T0));
    await sync('fake');
    expect(threads()).toEqual({ [threadIdOf('fake', 'a1')]: ['fake:a1', 'other:b2'] });
    expect(threadSummary(db, threadIdOf('fake', 'a1'))?.agents).toEqual(['fake', 'other']);
  });
});

describe('a thread', () => {
  it('is the closure of both rules, named after its root, which an earlier session replaces', async () => {
    write('s2.jsonl', session('s2', T0 + 10 * DAY, 'feat-z'));
    write('s3.jsonl', session('s3', T0 + 15 * DAY, 'feat-z'));
    write('s4.jsonl', [
      ...session('s4', T0 + 40 * DAY),
      {
        id: 's4c',
        session: 's4',
        ts: T0 + 40 * DAY + 1,
        kind: 'tool_result',
        text: followResult('lnk_000000000004', 'fake:s3'),
      },
    ]);
    write('s5.jsonl', [
      ...session('s5', T0 + 41 * DAY),
      {
        id: 's5c',
        session: 's5',
        ts: T0 + 41 * DAY + 1,
        kind: 'tool_result',
        text: followResult('lnk_000000000005', 'fake:s4'),
      },
    ]);
    await sync();
    const later = threadIdOf('fake', 's2');
    expect(threads()).toEqual({ [later]: ['fake:s2', 'fake:s3', 'fake:s4', 'fake:s5'] });
    const before = tables();
    rebuildThreads(db);
    expect(tables()).toEqual(before);

    // Older logs arrive: a session that started first joins, and the thread takes its name.
    write('s1.jsonl', session('s1', T0, 'feat-z'));
    await sync();
    const id = threadIdOf('fake', 's1');
    expect(threads()).toEqual({ [id]: ['fake:s1', 'fake:s2', 'fake:s3', 'fake:s4', 'fake:s5'] });
    expect(resolveId(db, later)).toBeNull();
    expect(resolveId(db, id)).toEqual({ kind: 'thread', id });
    const incremental = tables();
    rebuildThreads(db);
    expect(tables()).toEqual(incremental);
  });

  it('is described as a card: sessions, agents, branches, entries, and its last prompt', async () => {
    write('s1.jsonl', session('s1', T0, 'feat-c'));
    write('s2.jsonl', [
      ...session('s2', T0 + 2 * DAY, 'feat-c'),
      { id: 's2z', session: 's2', ts: T0 + 3 * DAY + 5, text: 'Ship the card next' },
    ]);
    await sync();
    const id = threadIdOf('fake', 's1');
    const entry = remember(db, {
      kind: 'memory',
      text: 'The card lists sessions oldest first.',
      confidence: 0.9,
      author: 'user@laptop',
      sources: [{ eventId: 'fake:s2b' }],
    });
    const card = describeThread(db, id);
    expect(card).toMatchObject({
      id,
      project: 'demo',
      title: 'Work on s1',
      startedAt: T0,
      endedAt: T0 + 3 * DAY + 5,
      count: 2,
      agents: ['fake'],
      branches: ['feat-c'],
      lastPrompt: { id: 'fake:s2z', prompt: 'Ship the card next', sessionId: 's2' },
    });
    expect(card?.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(card?.entries.map((e) => e.id)).toEqual([entry.id]);
    const s2 = getSession(db, 'fake', 's2');
    expect(describeSession(db, s2!).thread).toEqual({ id, sessions: 2 });
    expect(threadSummary(db, 'thr_000000000000')).toBeNull();
  });

  // Invariant 2: a forgotten link or session leaves its thread, every list, and every count, and a
  // restore brings them back.
  it('loses a link whose event is forgotten, and a session whose events all are', async () => {
    write('s1.jsonl', session('s1', T0));
    write('s2.jsonl', [
      ...session('s2', T0 + DAY),
      {
        id: 's2c',
        session: 's2',
        ts: T0 + DAY + 1,
        kind: 'tool_result',
        text: followResult('lnk_00000000000a', 'fake:s1'),
      },
    ]);
    write('s3.jsonl', [
      ...session('s3', T0 + 2 * DAY),
      {
        id: 's3c',
        session: 's3',
        ts: T0 + 2 * DAY + 1,
        kind: 'tool_result',
        text: followResult('lnk_00000000000b', 'fake:s2'),
      },
    ]);
    await sync();
    const id = threadIdOf('fake', 's1');
    expect(threadSummary(db, id)?.sessions).toBe(3);

    const link = forget(db, 'fake:s3c', { reason: 'not part of this work' });
    expect(threads()).toEqual({ [id]: ['fake:s1', 'fake:s2'] });
    expect(getSession(db, 'fake', 's3')?.thread).toBeNull();

    // s1's events all forgotten: the session is gone, and s2 is left with no thread.
    const a = forget(db, 'fake:s1a', { reason: 'private' });
    forget(db, 'fake:s1b', { reason: 'private' });
    expect(threads()).toEqual({});
    expect(describeThread(db, id)).toBeNull();
    expect(resolveId(db, id)).toBeNull();

    restore(db, a.tombstoneId as string, { reason: 'fine after all' });
    restore(db, link.tombstoneId as string, { reason: 'it was part of it' });
    expect(threads()).toEqual({ [id]: ['fake:s1', 'fake:s2', 'fake:s3'] });
    const incremental = tables();
    rebuildThreads(db);
    expect(tables()).toEqual(incremental);
  });
});
