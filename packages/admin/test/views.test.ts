import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Database,
  type EventKind,
  forget,
  openDatabase,
  remember,
  type SourceAdapter,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_DAYS, AdminService, TURN_EVENT_BUDGET, TURNS_PER_PAGE } from '../src/service.js';
import { dayKey } from '../src/turns.js';

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

/** A synthetic source: one Line per line, in `<root>/<id>/*.jsonl`. */
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
let service: AdminService;
const NOW = Date.now();
const DAY = 86_400_000;

function write(lines: Line[], source = 'fake', file = 'a.jsonl'): void {
  fs.mkdirSync(path.join(src, source), { recursive: true });
  fs.appendFileSync(
    path.join(src, source, file),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
  );
}

const sync = async (source = 'fake') => {
  await syncSource({ db, home }, adapter(src, source));
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-views-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
  service = new AdminService({ db, home, version: 'test', startedAt: NOW, publicUrl: null });
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

/** A session `s`: a caveat, then `prompts` prompts, each with a tool call, its result, and a reply. */
function conversation(prompts: number, start: number, step = 60_000): Line[] {
  const lines: Line[] = [
    {
      id: 'caveat',
      session: 's',
      ts: start,
      kind: 'meta',
      text: '<local-command-caveat>x</local-command-caveat>',
    },
  ];
  for (let i = 1; i <= prompts; i++) {
    const t = start + i * step;
    lines.push(
      { id: `p${i}`, session: 's', ts: t, text: `Prompt ${i}` },
      {
        id: `c${i}`,
        session: 's',
        ts: t + 1,
        role: 'assistant',
        kind: 'tool_use',
        text: 'Read {"file_path":"a.ts"}',
        meta: { toolName: 'Read', callId: `k${i}` },
      },
      {
        id: `r${i}`,
        session: 's',
        ts: t + 2,
        kind: 'tool_result',
        text: 'ok',
        meta: { callId: `k${i}` },
      },
      { id: `a${i}`, session: 's', ts: t + 3, role: 'assistant', text: `Reply ${i}` },
    );
  }
  return lines;
}

describe('a session by turns', () => {
  it('pages by turns, with what came before the first prompt first', async () => {
    write(conversation(25, NOW - DAY));
    await sync();
    const first = service.sessionTurns('fake', 's');
    expect(first).toMatchObject({ total: 26, preamble: true, turn: 0, part: 0, continues: false });
    expect(first.turns.map((t) => t.number)).toEqual(
      Array.from({ length: TURNS_PER_PAGE }, (_, i) => i),
    );
    expect(first.turns[0]).toMatchObject({ prompt: null, events: 1 });
    expect(first.turns[1]).toMatchObject({ events: 4, tools: { calls: 1, ok: 1 } });
    expect(first.turns[1]?.reply?.text).toBe('Reply 1');
    expect(first.next).toEqual({ turn: 20, part: 0 });
    expect(first.previous).toBeNull();
    const second = service.sessionTurns('fake', 's', { turn: 20 });
    expect(second.turns.map((t) => t.number)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(second.next).toBeNull();
    expect(second.previous).toEqual({ turn: 0, part: 0 });
    // From an event: the page starts with the turn that holds it.
    expect(service.sessionTurns('fake', 's', { at: 'fake:r23' }).turn).toBe(23);
    expect(service.sessionTurns('fake', 's', { at: 'fake:caveat' }).turn).toBe(0);
    expect(service.sessionTurns('fake', 's', { at: 'fake:nothing' }).turn).toBe(0);
    expect(service.sessionTurns('fake', 's', { at: 'fake:r23', turn: 5 }).turn).toBe(5);
    // Out of range: the last turn, or the first.
    expect(service.sessionTurns('fake', 's', { turn: 999 }).turn).toBe(25);
    expect(service.sessionTurns('fake', 's', { turn: 0 }).turn).toBe(0);
  });

  it('reads only the events of the turns on the page', async () => {
    write(conversation(30, NOW - DAY));
    await sync();
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      statements.push(sql);
      return prepare(sql);
    };
    const page = service.sessionTurns('fake', 's', { turn: 11 });
    db.prepare = prepare;
    expect(page.turns.map((t) => t.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
    expect(page.turns.reduce((n, t) => n + t.events, 0)).toBe(80);
    // The session, its prompts through their index, whether something precedes the first, and the range.
    expect(statements.some((s) => s.includes('INDEXED BY event_user_message'))).toBe(true);
    expect(
      statements.filter((s) => /FROM event e\b/.test(s) && !s.includes('INDEXED BY')),
    ).toHaveLength(3);
  });

  it('stops a page before a turn that would pass the budget, and shows a long turn in parts', async () => {
    const t = NOW - DAY;
    const lines: Line[] = [
      { id: 'p1', session: 's', ts: t, text: 'Short' },
      { id: 'a1', session: 's', ts: t + 1, role: 'assistant', text: 'ok' },
      { id: 'p2', session: 's', ts: t + 1000, text: 'Long' },
    ];
    const long = TURN_EVENT_BUDGET + 100;
    for (let i = 0; i < long; i++) {
      lines.push({
        id: `x${i}`,
        session: 's',
        ts: t + 2000 + i,
        role: 'assistant',
        kind: 'tool_use',
        text: `Bash {"command":"echo ${i}"}`,
        meta: { toolName: 'Bash' },
      });
    }
    lines.push({ id: 'p3', session: 's', ts: t + 10_000_000, text: 'After' });
    write(lines);
    await sync();
    const first = service.sessionTurns('fake', 's');
    expect(first.preamble).toBe(false);
    expect(first.turns.map((x) => x.number)).toEqual([1]);
    expect(first.next).toEqual({ turn: 2, part: 0 });
    const long1 = service.sessionTurns('fake', 's', { turn: 2 });
    expect(long1.turns.map((x) => [x.number, x.events])).toEqual([[2, TURN_EVENT_BUDGET]]);
    expect(long1).toMatchObject({ continues: true, next: { turn: 2, part: 1 } });
    const long2 = service.sessionTurns('fake', 's', { turn: 2, part: 1 });
    expect(long2.turns.map((x) => [x.number, x.prompt, x.events])).toEqual([[2, null, 101]]);
    expect(long2).toMatchObject({
      continues: false,
      next: { turn: 3, part: 0 },
      previous: { turn: 2, part: 0 },
    });
  });

  it('indexes the days of its turns, and follows forgetting', async () => {
    const day = (k: number, h: number) => {
      const d = new Date(NOW);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k, h).getTime();
    };
    write([
      { id: 'p1', session: 's', ts: day(3, 9), text: 'one' },
      { id: 'p2', session: 's', ts: day(3, 10), text: 'two' },
      { id: 'p3', session: 's', ts: day(1, 9), text: 'three' },
    ]);
    await sync();
    expect(service.sessionTurns('fake', 's').days).toEqual([
      { day: dayKey(day(3, 9)), turn: 1, turns: 2 },
      { day: dayKey(day(1, 9)), turn: 3, turns: 1 },
    ]);
    forget(db, 'fake:p2', { reason: 'test' });
    const after = service.sessionTurns('fake', 's');
    expect(after.total).toBe(2);
    expect(after.turns.map((t) => t.prompt?.text)).toEqual(['one', 'three']);
  });
});

describe('commands', () => {
  it('start a turn when the agent acts on them, and stay notes otherwise', async () => {
    const t = NOW - DAY;
    write([
      { id: 'p1', session: 's', ts: t, text: 'Hello' },
      { id: 'a1', session: 's', ts: t + 1, role: 'assistant', text: 'Hi.' },
      { id: 'clear', session: 's', ts: t + 2, text: '<command-name>/clear</command-name>' },
      { id: 'out', session: 's', ts: t + 3, text: '<local-command-stdout></local-command-stdout>' },
      {
        id: 'review',
        session: 's',
        ts: t + 4,
        text: '<command-name>/review</command-name><command-args>PR 12</command-args>',
      },
      { id: 'meta', session: 's', ts: t + 5, kind: 'meta', text: 'Review the pull request.' },
      { id: 'a2', session: 's', ts: t + 6, role: 'assistant', text: 'Reviewed.' },
    ]);
    await sync();
    const page = service.sessionTurns('fake', 's');
    expect(page.total).toBe(2);
    expect(page.turns.map((x) => [x.number, x.command, x.events])).toEqual([
      [1, null, 4],
      [2, '/review PR 12', 3],
    ]);
    expect(page.days).toEqual([{ day: dayKey(t), turn: 1, turns: 2 }]);
    expect(service.sessions({}).sessions.map((s) => [s.prompt, s.turns])).toEqual([['Hello', 2]]);
    expect(service.sessionTurns('fake', 's', { at: 'fake:a2' }).turn).toBe(2);
  });
});

describe('the timeline', () => {
  it('counts the turns of each session, and filters by name', async () => {
    write([
      { id: 'a1', session: 'a', ts: NOW - 3000, text: 'Fix the login form' },
      { id: 'a2', session: 'a', ts: NOW - 2000, text: 'And the logout' },
      { id: 'a3', session: 'a', ts: NOW - 1000, text: '<command-name>/clear</command-name>' },
      { id: 'b1', session: 'b', ts: NOW - 500, text: 'Deploy' },
      { id: 'b2', session: 'b', title: 'Release notes', ts: 0 },
    ]);
    await sync();
    const all = service.sessions({});
    expect(all.sessions.map((s) => [s.sessionId, s.title, s.prompt, s.turns])).toEqual([
      ['b', 'Release notes', null, 1],
      ['a', null, 'Fix the login form', 2],
    ]);
    expect(service.sessions({ q: 'LOGIN' }).sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(service.sessions({ q: 'release' }).sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(service.sessions({ q: 'deploy' }).sessions).toEqual([]);
  });
});

describe('the overview', () => {
  it('charts the last 30 days by source, and ranks projects by their events then', async () => {
    const today = new Date(NOW);
    // Late in the day, so that every event of the day is in the past, whatever the clock says.
    const late = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23).getTime();
    const at = (k: number) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - k, 12).getTime();
    write([
      { id: 'old', session: 'o', ts: at(40), project: 'old' },
      { id: 'a1', session: 'a', ts: at(2), project: 'web', version: '2.1.0' },
      { id: 'a2', session: 'a', ts: at(2) + 1000, project: 'web', version: '2.1.3' },
      { id: 'a3', session: 'a', ts: at(0), project: 'web' },
      { id: 'b1', session: 'b', ts: at(0), project: 'api' },
    ]);
    write(
      [
        { id: 'c1', session: 'c', ts: at(0), project: 'api' },
        { id: 'c2', session: 'c', ts: at(0), project: 'api' },
      ],
      'other',
    );
    await sync();
    await sync('other');
    forget(db, 'fake:a1', { reason: 'test' });
    const o = service.overview(late);
    expect(o.activity).toHaveLength(ACTIVITY_DAYS);
    expect(o.activity.at(-1)).toMatchObject({
      day: dayKey(late),
      events: 4,
      bySource: { fake: 2, other: 2 },
    });
    expect(o.activity.at(-3)).toMatchObject({ events: 1, bySource: { fake: 1 } });
    expect(o.activity.reduce((n, d) => n + d.events, 0)).toBe(5);
    expect(o.projects).toEqual([
      { project: 'api', sessions: 2, events: 3, lastAt: at(0) },
      { project: 'web', sessions: 1, events: 2, lastAt: at(0) },
    ]);
    expect(o.sources.map((s) => [s.source, s.agentVersion, s.parseErrors7d])).toEqual([
      ['fake', '2.1.3', 0],
      ['other', null, 0],
    ]);
    expect(o.recent.map((s) => s.sessionId)).toEqual(['a', 'b', 'c', 'o']);
    expect(o.usage).toMatchObject({
      bucket: null,
      mirrorDiskBytes: o.usage.mirrorStoredBytes.local,
    });
    expect(o.latestTombstones.map((t) => [t.kind, t.target])).toEqual([['forget', 'fake:a1']]);
    // Kept while nothing changes, counted again when events arrive or are forgotten.
    expect(service.overview(late).activity).toEqual(o.activity);
    write([{ id: 'b2', session: 'b', ts: at(0) + 5, project: 'api' }]);
    await sync();
    expect(service.overview(late).activity.at(-1)?.events).toBe(5);
    forget(db, 'fake:b2', { reason: 'test' });
    forget(db, 'fake:a3', { reason: 'test' });
    expect(service.overview(late).activity.at(-1)?.events).toBe(3);
  });

  it('lists the latest entries and forgets, never what a forget hides', async () => {
    write([
      { id: 'e1', session: 's', ts: NOW - 1000, text: 'A secret plan' },
      { id: 'e2', session: 's', ts: NOW, text: 'Public' },
    ]);
    await sync();
    const kept = remember(db, {
      kind: 'memory',
      text: 'Kept entry',
      confidence: 1,
      author: 'test',
      sources: [{ eventId: 'fake:e2' }],
    });
    remember(db, {
      kind: 'knowledge',
      text: 'Secret entry',
      confidence: 1,
      author: 'test',
      sources: [{ eventId: 'fake:e1' }],
    });
    forget(db, 'fake:e1', { reason: 'private' });
    const o = service.overview(NOW);
    expect(o.latestEntries.map((e) => e.id)).toEqual([kept.id]);
    expect(o.latestTombstones.map((t) => [t.target, t.reason, t.entries, t.events])).toEqual([
      ['fake:e1', 'private', 1, 1],
    ]);
    expect(JSON.stringify(o)).not.toContain('Secret');
    expect(JSON.stringify(o)).not.toContain('secret plan');
  });
});

describe('the workbench lists', () => {
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

  it('filter sessions by agent and project, counting each facet as if it alone were open', async () => {
    write([{ id: 'a1', session: 'a', ts: NOW - 3 * DAY, project: 'web', text: 'Fix the form' }]);
    write([{ id: 'b1', session: 'b', ts: NOW - 1000, project: 'api', text: 'Add a route' }]);
    write([{ id: 'c1', session: 'c', ts: NOW - 2000, project: 'web', text: 'Ship it' }], 'other');
    await sync();
    await sync('other');
    const all = service.sessionBoard(board, NOW);
    expect(all.rows.map((r) => r.sessionId)).toEqual(['b', 'c', 'a']);
    expect(all.facets.agents).toEqual([
      { value: 'fake', count: 2 },
      { value: 'other', count: 1 },
    ]);
    const web = service.sessionBoard({ ...board, projects: ['web'] }, NOW);
    expect(web.rows.map((r) => r.sessionId)).toEqual(['c', 'a']);
    // The agents facet counts under the project filter; the projects facet ignores its own.
    expect(web.facets.agents).toEqual([
      { value: 'fake', count: 1 },
      { value: 'other', count: 1 },
    ]);
    expect(web.facets.projects.map((p) => p.value)).toEqual(['web', 'api']);
    expect(service.sessionBoard({ ...board, range: 'today' }, NOW).ranges).toMatchObject({
      all: 3,
    });
    expect(service.sessionBoard({ ...board, agents: ['other'] }, NOW).total).toBe(1);
  });

  it('show a session as a trace: every turn with its calls and failures, the latest in full', async () => {
    write(conversation(3, NOW - DAY));
    write([
      {
        id: 'x',
        session: 's',
        ts: NOW - DAY + 3 * 60_000 + 10,
        kind: 'tool_result',
        text: 'boom',
        meta: { callId: 'k3', isError: true },
      },
    ]);
    await sync();
    const trace = service.sessionTrace('fake', 's');
    expect(trace.number).toBe(3);
    expect(trace.outline.map((t) => [t.number, t.label, t.tools])).toEqual([
      [0, null, 0],
      [1, 'Prompt 1', 1],
      [2, 'Prompt 2', 1],
      [3, 'Prompt 3', 1],
    ]);
    expect(trace.steps.map((s) => s.kind)).toEqual(['prompt', 'tool', 'reply']);
    expect(trace.steps[1]).toMatchObject({ label: 'Read', count: 1 });
    expect(service.sessionTrace('fake', 's', { turn: 1 })).toMatchObject({
      number: 1,
      previous: 0,
      next: 2,
    });
  });

  it('filter entries by kind, origin, and text, older versions only when asked', async () => {
    write([{ id: 'e1', session: 'e', ts: NOW - DAY }]);
    await sync();
    const cite = [{ eventId: 'fake:e1' }];
    const kept = remember(db, {
      kind: 'cognition',
      text: 'Prefer small commits',
      confidence: 0.9,
      author: 'claude-code@laptop',
      sources: cite,
    });
    remember(db, {
      kind: 'knowledge',
      text: 'The hub listens on 7077',
      confidence: 1,
      author: 'user@laptop',
      sources: cite,
    });
    const f = {
      kinds: [] as string[],
      projects: [] as string[],
      authors: [] as string[],
      origin: 'any' as const,
      recalled: false,
      history: false,
      range: 'all' as const,
      q: '',
      page: 0,
    };
    const all = service.entryBoard(f, NOW);
    expect(all.total).toBe(2);
    expect(all.facets.authors.map((a) => a.value).sort()).toEqual(['claude-code', 'user']);
    expect(all.facets.written).toBe(2);
    expect(service.entryBoard({ ...f, kinds: ['cognition'] }, NOW).rows.map((e) => e.id)).toEqual([
      kept.id,
    ]);
    expect(service.entryBoard({ ...f, q: 'HUB' }, NOW).total).toBe(1);
    expect(service.entryBoard({ ...f, origin: 'imported' }, NOW).total).toBe(0);
  });
});
