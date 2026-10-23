import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_BUCKET_MS,
  activeProjects,
  commandLine,
  type Database,
  type EventKind,
  eventActivity,
  forget,
  latestAgentVersions,
  listSessionEvents,
  listSessions,
  openDatabase,
  type SourceAdapter,
  sessionPrompts,
  sessionTurnStarts,
  syncSource,
} from '../src/index.js';

interface Line {
  id: string;
  session: string;
  ts: number;
  role?: 'user' | 'assistant';
  kind?: EventKind;
  text?: string;
  meta?: Record<string, unknown>;
  project?: string;
  version?: string;
  title?: string;
}

/** A source with meta and versions: one Line per line, in `<root>/<source>/*.jsonl`. */
function adapter(root: string, id = 'fake'): SourceAdapter {
  const dir = path.join(root, id);
  return {
    id,
    displayName: id,
    version: () => null,
    async discover() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((f) => ({ absPath: path.join(dir, f), relPath: f }));
    },
    parseLine(raw) {
      const o = JSON.parse(raw) as Line;
      if (o.title) return { events: [], sessionTitle: o.title, sessionId: o.session };
      return {
        events: [
          {
            id: o.id,
            sessionId: o.session,
            ts: o.ts,
            role: o.role ?? 'user',
            kind: o.kind ?? 'message',
            text: o.text ?? o.id,
            meta: o.meta ?? null,
            project: o.project ?? 'demo',
            agentVersion: o.version ?? null,
          },
        ],
      };
    },
  };
}

let home: string;
let src: string;
let db: Database;

function write(lines: Line[], source = 'fake', file = 'a.jsonl'): void {
  fs.mkdirSync(path.join(src, source), { recursive: true });
  fs.appendFileSync(
    path.join(src, source, file),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

const T = Date.UTC(2026, 9, 20, 9);

describe('session prompts', () => {
  it('are the prompts the user typed, in order, without sub-agents or forgotten ones', async () => {
    write([
      {
        id: 'caveat',
        session: 's',
        ts: T,
        kind: 'meta',
        text: '<local-command-caveat>x</local-command-caveat>',
      },
      { id: 'cmd', session: 's', ts: T + 1, text: '<command-name>/clear</command-name>' },
      { id: 'p1', session: 's', ts: T + 2, text: 'First prompt' },
      { id: 'r1', session: 's', ts: T + 3, role: 'assistant', text: 'Reply' },
      { id: 'sub', session: 's', ts: T + 4, text: 'Task prompt', meta: { sidechain: true } },
      { id: 'tool', session: 's', ts: T + 5, kind: 'tool_result', text: 'ok' },
      { id: 'p2', session: 's', ts: T + 6, text: '<ide_opened_file>a.ts</ide_opened_file> Second' },
      { id: 'p3', session: 's', ts: T + 7, text: 'Third' },
      { id: 'other', session: 't', ts: T + 8, text: 'Elsewhere' },
    ]);
    await syncSource({ db, home }, adapter(src));
    expect(sessionPrompts(db, 'fake', 's').map((p) => [p.id, p.prompt])).toEqual([
      ['fake:p1', 'First prompt'],
      ['fake:p2', 'Second'],
      ['fake:p3', 'Third'],
    ]);
    forget(db, 'fake:p2', { reason: 'test' });
    expect(sessionPrompts(db, 'fake', 's').map((p) => p.id)).toEqual(['fake:p1', 'fake:p3']);
  });

  it('are read through the index of user messages', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT e.id FROM event e INDEXED BY event_user_message
          WHERE e.source = ? AND e.session_id = ? AND e.role = 'user' AND e.kind = 'message'
          ORDER BY e.ts, e.seq`,
      )
      .all('fake', 's') as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail).join('\n');
    expect(details).toContain('event_user_message');
    expect(details).not.toContain('TEMP B-TREE');
  });
});

describe('turn starts', () => {
  const echo = (name: string, args = '') =>
    `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`;

  it('name a command and its arguments, and only a command', () => {
    expect(commandLine(echo('/review', 'PR 12'))).toBe('/review PR 12');
    expect(commandLine('<command-name>/clear</command-name>')).toBe('/clear');
    expect(commandLine('<command-name>/x</command-name> and a prompt')).toBeNull();
    expect(commandLine('<local-command-stdout>ok</local-command-stdout>')).toBeNull();
    expect(commandLine('Run /review')).toBeNull();
  });

  it('are the prompts, and the commands the agent acted on before the next prompt or command', async () => {
    write([
      { id: 'p1', session: 's', ts: T, text: 'First prompt' },
      { id: 'a1', session: 's', ts: T + 1, role: 'assistant', text: 'Done.' },
      // A local command: its output only, then a command the agent works on.
      { id: 'model', session: 's', ts: T + 2, text: echo('/model', 'opus') },
      {
        id: 'out',
        session: 's',
        ts: T + 3,
        text: '<local-command-stdout>Set model to opus</local-command-stdout>',
      },
      { id: 'review', session: 's', ts: T + 4, text: echo('/review', 'PR 12') },
      { id: 'expanded', session: 's', ts: T + 5, kind: 'meta', text: 'Review the pull request…' },
      { id: 'call', session: 's', ts: T + 6, role: 'assistant', kind: 'tool_use', text: 'Bash {}' },
      { id: 'result', session: 's', ts: T + 7, kind: 'tool_result', text: 'ok' },
      // A command only a sub-agent acted on, then one whose only answer is forgotten.
      { id: 'sub', session: 's', ts: T + 8, text: echo('/agents') },
      {
        id: 'subwork',
        session: 's',
        ts: T + 9,
        role: 'assistant',
        text: 'x',
        meta: { sidechain: true },
      },
      { id: 'clear', session: 's', ts: T + 10, text: echo('/clear') },
      { id: 'p2', session: 's', ts: T + 11, text: 'Second prompt' },
      { id: 'last', session: 's', ts: T + 12, text: echo('/summary') },
      { id: 'answer', session: 's', ts: T + 13, role: 'assistant', text: 'Summary.' },
    ]);
    await syncSource({ db, home }, adapter(src));
    const starts = () =>
      sessionTurnStarts(db, 'fake', 's').map((s) => [
        s.id.slice('fake:'.length),
        s.prompt,
        s.command,
      ]);
    expect(starts()).toEqual([
      ['p1', 'First prompt', false],
      ['review', '/review PR 12', true],
      ['p2', 'Second prompt', false],
      ['last', '/summary', true],
    ]);
    forget(db, 'fake:answer', { reason: 'test' });
    expect(starts().map((s) => s[0])).toEqual(['p1', 'review', 'p2']);
    // Prompts alone, and the provisional name, still skip every command.
    expect(sessionPrompts(db, 'fake', 's').map((p) => p.id)).toEqual(['fake:p1', 'fake:p2']);
    write([
      { id: 'c0', session: 'c', ts: T, text: echo('/review') },
      { id: 'c1', session: 'c', ts: T + 1, role: 'assistant', text: 'Working.' },
      { id: 'c2', session: 'c', ts: T + 2, text: 'The real prompt' },
    ]);
    await syncSource({ db, home }, adapter(src));
    expect(listSessions(db, { match: 'real' }).map((s) => s.prompt)).toEqual(['The real prompt']);
    expect(sessionTurnStarts(db, 'fake', 'c').map((s) => s.prompt)).toEqual([
      '/review',
      'The real prompt',
    ]);
  });
});

describe('a range of a session', () => {
  it('reads the events from one position to another, in time order', async () => {
    write(
      Array.from({ length: 10 }, (_, i) => ({
        id: `e${i}`,
        session: 's',
        ts: T + Math.floor(i / 2),
      })),
    );
    await syncSource({ db, home }, adapter(src));
    const prompts = (ids: string[]) =>
      db
        .prepare(
          `SELECT ts, seq FROM event WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`,
        )
        .all(...ids) as Array<{ ts: number; seq: number }>;
    const [from, to] = prompts(['fake:e3', 'fake:e7']);
    const ids = (o: Parameters<typeof listSessionEvents>[1]) =>
      listSessionEvents(db, o).map((e) => e.id.slice('fake:'.length));
    const key = { source: 'fake', sessionId: 's' };
    // Same timestamps (e2 and e3, e6 and e7) are told apart by arrival.
    expect(ids({ ...key, from, to })).toEqual(['e3', 'e4', 'e5', 'e6']);
    expect(ids({ ...key, to: from })).toEqual(['e0', 'e1', 'e2']);
    expect(ids({ ...key, from: to })).toEqual(['e7', 'e8', 'e9']);
    expect(ids({ ...key, from, limit: 2, offset: 1 })).toEqual(['e4', 'e5']);
    forget(db, 'fake:e4', { reason: 'test' });
    expect(ids({ ...key, from, to })).toEqual(['e3', 'e5', 'e6']);
  });
});

describe('sessions by name', () => {
  it('match titles and provisional names, ignoring case, page by page', async () => {
    write([
      { id: 'a1', session: 'a', ts: T, text: 'Fix the LOGIN form' },
      { id: 'b1', session: 'b', ts: T + 1, text: 'Untitled work on login' },
      { id: 'b2', session: 'b', title: 'Billing export', ts: 0 },
      { id: 'c1', session: 'c', ts: T + 2, text: 'Deploy script' },
      { id: 'd1', session: 'd', ts: T + 3, text: '<command-name>/login</command-name>' },
    ]);
    await syncSource({ db, home }, adapter(src));
    const names = (match: string, o: { limit?: number; offset?: number } = {}) =>
      listSessions(db, { match, ...o }).map((s) => s.sessionId);
    // b is titled "Billing export", so its first prompt does not name it.
    expect(names('login')).toEqual(['a']);
    expect(names('BILLING')).toEqual(['b']);
    expect(names('e')).toEqual(['c', 'b', 'a']);
    expect(names('e', { limit: 1, offset: 1 })).toEqual(['b']);
    expect(names('nothing')).toEqual([]);
    expect(names('  ')).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('activity', () => {
  it('counts visible events per source, project, and bucket, from the index alone', async () => {
    const day = 86_400_000;
    write([
      { id: 'old', session: 'x', ts: T - 40 * day, project: 'p' },
      { id: 'a1', session: 'a', ts: T, project: 'p' },
      { id: 'a2', session: 'a', ts: T + 60_000, project: 'p' },
      { id: 'a3', session: 'a', ts: T + day, project: 'p' },
      { id: 'b1', session: 'b', ts: T + day, project: 'q' },
    ]);
    write([{ id: 'c1', session: 'c', ts: T + day, project: 'p' }], 'other');
    await syncSource({ db, home }, adapter(src));
    await syncSource({ db, home }, adapter(src, 'other'));
    const since = T - day;
    const rows = () =>
      eventActivity(db, { since, until: T + 2 * day })
        .map((r) => `${r.source}/${r.project}/${(r.start - T) / ACTIVITY_BUCKET_MS}:${r.events}`)
        .sort();
    expect(rows()).toEqual(['fake/p/0:2', 'fake/p/96:1', 'fake/q/96:1', 'other/p/96:1']);
    // Forgetting takes an event off, and a session that is all forgotten counts no more.
    forget(db, 'fake:a2', { reason: 'test' });
    forget(db, 'fake:b1', { reason: 'test' });
    expect(rows()).toEqual(['fake/p/0:1', 'fake/p/96:1', 'other/p/96:1']);
    expect(activeProjects(db, { since })).toEqual([{ project: 'p', sessions: 2, lastAt: T + day }]);
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM session s CROSS JOIN event e INDEXED BY event_session
           ON e.source = s.source AND e.session_id = s.session_id WHERE s.ended_at >= 0 AND e.ts >= 0`,
        )
        .all() as Array<{ detail: string }>
    )
      .map((p) => p.detail)
      .join('\n');
    expect(plan).toContain('COVERING INDEX event_session');
  });
});

describe('agent versions', () => {
  it('are the latest recorded in each source’s latest sessions', async () => {
    write([
      { id: 'a1', session: 'a', ts: T, version: '1.0' },
      { id: 'b1', session: 'b', ts: T + 10, version: '1.1' },
      { id: 'b2', session: 'b', ts: T + 20, version: '1.2' },
      { id: 'b3', session: 'b', ts: T + 30 },
    ]);
    write([{ id: 'c1', session: 'c', ts: T }], 'other');
    await syncSource({ db, home }, adapter(src));
    await syncSource({ db, home }, adapter(src, 'other'));
    expect([...latestAgentVersions(db)]).toEqual([['fake', '1.2']]);
    forget(db, 'fake:b2', { reason: 'test' });
    expect([...latestAgentVersions(db)]).toEqual([['fake', '1.1']]);
  });
});
