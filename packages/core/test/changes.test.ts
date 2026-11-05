import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changesSince,
  type Database,
  encodeCursor,
  encodeFeedCursor,
  forget,
  OriginError,
  openDatabase,
  parseFeedCursor,
  remember,
  syncSource,
  threadIdOf,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';

const HOUR = 3_600_000;
const NOW = Date.now();

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-changes-'));
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

function write(file: string, lines: Line[]): void {
  const text = lines.map((l) => JSON.stringify({ role: 'user', text: `text ${l.id}`, ...l }));
  fs.appendFileSync(path.join(logs, file), `${text.join('\n')}\n`);
}

const sync = () => syncSource({ db, home }, fakeAdapter(logs));
const ids = (items: Array<{ id: string }>) => items.map((x) => x.id);

describe('the change feed', () => {
  it('starts with the last 24 hours, newest first if there is more, and the cursor as of now', async () => {
    write('old.jsonl', [{ id: 'o1', session: 'old', ts: NOW - 72 * HOUR }]);
    write('s1.jsonl', [
      { id: 'a1', session: 's1', ts: NOW - 30 * HOUR },
      { id: 'a2', session: 's1', ts: NOW - 5 * HOUR },
      { id: 'a3', session: 's1', ts: NOW - 4 * HOUR, kind: 'tool_use', role: 'assistant' },
    ]);
    write('s2.jsonl', [
      { id: 'b1', session: 's2', ts: NOW - 3 * HOUR },
      { id: 'b2', session: 's2', ts: NOW - 2 * HOUR, role: 'assistant' },
    ]);
    await sync();
    const first = changesSince(db, { now: NOW });
    expect(ids(first.events)).toEqual(['fake:a2', 'fake:b1', 'fake:b2']);
    expect(first.sessions.map((s) => [s.session.sessionId, s.started])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
    expect(first.more).toBe(false);
    expect(ids(changesSince(db, { now: NOW, includeTools: true }).events)).toEqual([
      'fake:a2',
      'fake:a3',
      'fake:b1',
      'fake:b2',
    ]);

    const two = changesSince(db, { now: NOW, limit: 2 });
    expect(ids(two.events)).toEqual(['fake:b1', 'fake:b2']);
    expect(two.more).toBe(true);
    // The cursor is as of now: what came before the page is for search and timeline.
    expect(two.next).toEqual(first.next);
    expect(changesSince(db, { now: NOW, after: two.next }).events).toEqual([]);
  });

  it('pages through what arrived after a cursor, entries and forgets included', async () => {
    write('s1.jsonl', [{ id: 'a1', session: 's1', ts: NOW - HOUR }]);
    await sync();
    const start = changesSince(db, { now: NOW }).next;

    write('s1.jsonl', [
      { id: 'a2', session: 's1', ts: NOW - 50 * HOUR },
      { id: 'a3', session: 's1', ts: NOW + 1, role: 'assistant' },
    ]);
    write('s2.jsonl', [{ id: 'b1', session: 's2', ts: NOW + 2 }]);
    await sync();
    const entry = remember(db, {
      kind: 'memory',
      text: 'The feed pages by arrival.',
      confidence: 0.9,
      author: 'user@laptop',
      sources: [{ eventId: 'fake:a3' }],
    });
    const gone = forget(db, 'fake:a2', { reason: 'not for the feed' });

    const page1 = changesSince(db, { now: NOW, after: start, limit: 2 });
    // a2 arrived after the cursor, but it is forgotten: only its forget says so, by id.
    expect(ids(page1.events)).toEqual(['fake:a3', 'fake:b1']);
    expect(ids(page1.entries)).toEqual([entry.id]);
    expect(page1.forgets).toEqual([
      { id: gone.tombstoneId, target: 'fake:a2', at: expect.any(Number) },
    ]);
    expect(JSON.stringify(page1)).not.toContain('text a2');
    expect(page1.sessions.map((s) => [s.session.sessionId, s.started])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
    expect(page1.more).toBe(false);

    const one = changesSince(db, { now: NOW, after: start, limit: 1 });
    expect(ids(one.events)).toEqual(['fake:a3']);
    expect(ids(one.entries)).toEqual([entry.id]);
    expect(one.forgets).toEqual([]);
    expect(one.more).toBe(true);
    const rest = changesSince(db, { now: NOW, after: one.next, limit: 1 });
    expect(ids(rest.events)).toEqual(['fake:b1']);
    expect(ids(rest.forgets)).toEqual([gone.tombstoneId]);
    expect(rest.more).toBe(false);
    const end = changesSince(db, { now: NOW, after: rest.next });
    expect(end).toMatchObject({ events: [], entries: [], forgets: [], more: false });
    expect(end.next).toEqual(rest.next);
  });

  it('keeps to a project, a session, or a thread', async () => {
    write('s1.jsonl', [
      { id: 'a1', session: 's1', ts: NOW - 3 * HOUR, branch: 'feat-q' },
      { id: 'a2', session: 's1', ts: NOW - 3 * HOUR + 1, branch: 'feat-q' },
    ]);
    write('s2.jsonl', [{ id: 'b1', session: 's2', ts: NOW - 2 * HOUR, branch: 'feat-q' }]);
    write('s3.jsonl', [{ id: 'c1', session: 's3', ts: NOW - HOUR, project: 'other' }]);
    await sync();
    const fromS1 = remember(db, {
      kind: 'knowledge',
      text: 'Written from s1.',
      confidence: 1,
      author: 'user@laptop',
      project: 'demo',
      sources: [{ eventId: 'fake:a1' }],
    });
    const fromS3 = remember(db, {
      kind: 'knowledge',
      text: 'Written from s3.',
      confidence: 1,
      author: 'user@laptop',
      project: 'other',
      sources: [{ eventId: 'fake:c1' }],
    });
    const thread = threadIdOf('fake', 's1');
    const byProject = changesSince(db, { now: NOW, project: 'other' });
    expect(ids(byProject.events)).toEqual(['fake:c1']);
    expect(ids(byProject.entries)).toEqual([fromS3.id]);
    const bySession = changesSince(db, { now: NOW, session: { source: 'fake', sessionId: 's2' } });
    expect(ids(bySession.events)).toEqual(['fake:b1']);
    expect(bySession.entries).toEqual([]);
    const byThread = changesSince(db, { now: NOW, thread });
    expect(ids(byThread.events)).toEqual(['fake:a1', 'fake:a2', 'fake:b1']);
    expect(ids(byThread.entries)).toEqual([fromS1.id]);
    expect(byThread.sessions.map((s) => s.session.thread)).toEqual([thread, thread]);
    expect(() => changesSince(db, { thread: 'thr_000000000000' })).toThrow(/Unknown thread/);
  });

  it('leaves a child session out of the feed unless asked for that session', async () => {
    write('parent.jsonl', [
      { id: 'p1', session: 'parent-1', ts: NOW - 2 * HOUR },
      { id: 'p2', session: 'parent-1', ts: NOW - HOUR },
    ]);
    fs.appendFileSync(
      path.join(logs, 'child.jsonl'),
      `${JSON.stringify({
        id: 'c1',
        session: 'child-1',
        ts: NOW - 30 * 60_000,
        role: 'user',
        text: 'zebraparentlink step',
        parents: [
          {
            session: 'child-1',
            parent: 'parent-1',
            via: 'workflow',
            signal: 'dwf_run',
            group: 'run-1',
            name: 'Ship',
          },
        ],
      })}\n`,
    );
    await sync();
    const feed = changesSince(db, { now: NOW });
    expect(feed.sessions.map((s) => s.session.sessionId)).toEqual(['parent-1']);
    expect(ids(feed.events)).toContain('fake:c1');
    const asked = changesSince(db, {
      now: NOW,
      session: { source: 'fake', sessionId: 'child-1' },
    });
    expect(asked.sessions.map((s) => s.session.sessionId)).toEqual(['child-1']);
    expect(ids(asked.events)).toEqual(['fake:c1']);
  });

  it('refuses a malformed cursor', () => {
    expect(parseFeedCursor(encodeFeedCursor({ event: 3, change: 4 }))).toEqual({
      event: 3,
      change: 4,
    });
    // A connected device's cursor holds this store's.
    expect(
      parseFeedCursor(
        encodeCursor({ l: { e: 1, c: 2 }, h: encodeFeedCursor({ event: 9, change: 9 }) }),
      ),
    ).toEqual({ event: 1, change: 2 });
    for (const bad of ['', 'not a cursor!', encodeCursor({ e: -1, c: 0 }), encodeCursor([1, 2])]) {
      expect(() => parseFeedCursor(bad)).toThrow(OriginError);
    }
    expect(() => parseFeedCursor('bm90IGpzb24')).toThrow(/Malformed cursor/);
  });
});
