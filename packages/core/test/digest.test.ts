import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  correct,
  type Database,
  digest,
  digestDay,
  editedFiles,
  forget,
  isoIn,
  localTimeZone,
  OriginError,
  openDatabase,
  rejectProposal,
  remember,
  restore,
  syncSource,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ZONE = 'Asia/Shanghai';
const DAY = '2026-10-20';
/** Midnight of DAY in ZONE (UTC+8). */
const MIDNIGHT = Date.UTC(2026, 9, 19, 16);
/** A time on DAY in ZONE. */
const at = (h: number, m = 0) => MIDNIGHT + h * HOUR + m * MIN;

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-digest-'));
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
  id?: string;
  session: string;
  ts?: number;
  role?: 'user' | 'assistant';
  text?: string;
  kind?: string;
  project?: string;
  cwd?: string;
  author?: string;
  meta?: Record<string, unknown>;
  parents?: Array<Record<string, unknown>>;
  kinds?: Array<Record<string, unknown>>;
  title?: string;
}

/** Lines of one agent's log, in a directory of that agent's own. */
function write(file: string, lines: Line[], source = 'fake'): void {
  const dir = path.join(logs, source);
  fs.mkdirSync(dir, { recursive: true });
  const text = lines.map((l) => JSON.stringify({ role: 'user', text: `text ${l.id}`, ...l }));
  fs.appendFileSync(path.join(dir, file), `${text.join('\n')}\n`);
}

async function sync(...sources: string[]): Promise<void> {
  for (const source of sources.length > 0 ? sources : ['fake']) {
    await syncSource({ db, home }, fakeAdapter(path.join(logs, source), source));
  }
}

const day = (opts: Parameters<typeof digest>[1] = {}) =>
  digest(db, { day: DAY, timeZone: ZONE, ...opts });

describe('the day of a digest', () => {
  it('runs from midnight to midnight in the time zone', () => {
    expect(digestDay(DAY, ZONE)).toEqual({
      day: DAY,
      timeZone: ZONE,
      from: MIDNIGHT,
      until: MIDNIGHT + 24 * HOUR,
    });
    expect(isoIn(MIDNIGHT, ZONE)).toBe('2026-10-20T00:00:00.000+08:00');
    expect(isoIn(MIDNIGHT - 1, ZONE)).toBe('2026-10-19T23:59:59.999+08:00');
    expect(isoIn(MIDNIGHT, 'UTC')).toBe('2026-10-19T16:00:00.000+00:00');
  });

  it('is 23 or 25 hours long when the zone changes its offset in it', () => {
    const spring = digestDay('2026-03-08', 'America/New_York');
    expect(spring.from).toBe(Date.UTC(2026, 2, 8, 5));
    expect(spring.until - spring.from).toBe(23 * HOUR);
    const autumn = digestDay('2026-11-01', 'America/New_York');
    expect(autumn.from).toBe(Date.UTC(2026, 10, 1, 4));
    expect(autumn.until - autumn.from).toBe(25 * HOUR);
    expect(isoIn(autumn.from, 'America/New_York')).toBe('2026-11-01T00:00:00.000-04:00');
    expect(isoIn(autumn.until, 'America/New_York')).toBe('2026-11-02T00:00:00.000-05:00');
    // São Paulo skipped midnight on 2018-11-04: the day began at 01:00.
    const skipped = digestDay('2018-11-04', 'America/Sao_Paulo');
    expect(skipped.from).toBe(Date.UTC(2018, 10, 4, 3));
    expect(isoIn(skipped.from, 'America/Sao_Paulo')).toBe('2018-11-04T01:00:00.000-02:00');
  });

  it('is today by default, in the time zone of this process by default', () => {
    expect(digestDay(undefined, ZONE, MIDNIGHT + 24 * HOUR + 1).day).toBe('2026-10-21');
    expect(digestDay(undefined, ZONE, MIDNIGHT - 1).day).toBe('2026-10-19');
    const here = digestDay('2026-10-20');
    expect(here.timeZone).toBe(localTimeZone());
    expect(here.from).toBe(new Date(2026, 9, 20).getTime());
    expect(here.until).toBe(new Date(2026, 9, 21).getTime());
  });

  it('refuses what is not a day or a time zone', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '20261020', '0026-10-20']) {
      expect(() => digestDay(bad, ZONE)).toThrow(OriginError);
      expect(() => digestDay(bad, ZONE)).toThrow(/Not a day/);
    }
    expect(() => digestDay(DAY, 'Mars/Olympus')).toThrow(/Unknown time zone/);
    expect(() => digest(db, { day: DAY, timeZone: ZONE, limit: 0 })).toThrow(/limit/);
  });
});

describe('a digest', () => {
  it('counts the events of the day, from its first minute to its last', async () => {
    write('s1.jsonl', [
      { id: 'a0', session: 's1', ts: at(0) - MIN, text: 'late the night before' },
      { id: 'a1', session: 's1', ts: at(0, 1), text: 'Start the migration' },
      { id: 'a2', session: 's1', ts: at(9), role: 'assistant', text: 'Done.' },
      { id: 'a3', session: 's1', ts: at(23, 59), role: 'assistant', text: 'Still here.' },
      { id: 'a4', session: 's1', ts: at(24, 1), text: 'the next day' },
    ]);
    write('old.jsonl', [{ id: 'o1', session: 'old', ts: at(-30), text: 'two days before' }]);
    await sync();
    const d = day();
    expect(d.sessions.map((s) => [s.sessionId, s.events, s.first, s.last])).toEqual([
      ['s1', 3, at(0, 1), at(23, 59)],
    ]);
    expect(d.totals).toEqual({
      sessions: 1,
      events: 3,
      prompts: 1,
      projects: 1,
      agents: 1,
      children: 0,
    });
    // The same events, read in a time zone eight hours behind, fall on two days.
    const utc = digest(db, { day: '2026-10-19', timeZone: 'UTC' });
    expect(utc.sessions.map((s) => s.events)).toEqual([2]);
    expect(utc.from).toBe(Date.UTC(2026, 9, 19));
  });

  it('groups sessions by their resolved project, a work tree under its main one', async () => {
    write('s1.jsonl', [
      { id: 'w1', session: 's1', ts: at(10), text: 'Fix it in the work tree', project: 'wt-name' },
    ]);
    write('s2.jsonl', [
      { id: 'm1', session: 's2', ts: at(11), text: 'Review it', project: 'demo-app' },
      { id: 'm2', session: 's2', ts: at(11, 5), role: 'assistant', text: 'Reviewed.' },
    ]);
    write('s3.jsonl', [{ id: 'x1', session: 's3', ts: at(12), text: 'Other', project: 'other' }]);
    await sync();
    db.prepare(
      `INSERT INTO session_place (source, session_id, project, root, signal)
       VALUES ('fake', 's1', 'demo-app', 'd:/demo/demo-app', 'git')`,
    ).run();
    const d = day();
    expect(d.projects).toEqual([
      { project: 'demo-app', sessions: 2, events: 3, prompts: 2 },
      { project: 'other', sessions: 1, events: 1, prompts: 1 },
    ]);
    expect(d.sessions.map((s) => [s.sessionId, s.project])).toEqual([
      ['s3', 'other'],
      ['s2', 'demo-app'],
      ['s1', 'demo-app'],
    ]);
    expect(day({ project: 'demo-app' }).sessions.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(day({ project: 'wt-name' }).sessions).toEqual([]);
    expect(day({ project: 'demo-app' }).totals.projects).toBe(1);
  });

  it('folds active children into their top-level session, even one quiet that day', async () => {
    write('parent.jsonl', [
      { id: 'p1', session: 'parent', ts: at(-5), text: 'Ship the release' },
      { id: 'p2', session: 'parent', ts: at(-4), role: 'assistant', text: 'Starting.' },
    ]);
    write('child.jsonl', [
      {
        id: 'c1',
        session: 'child',
        ts: at(1),
        text: 'Run the tests',
        parents: [
          { session: 'child', parent: 'parent', via: 'workflow', group: 'run-1', name: 'Ship' },
        ],
      },
      {
        id: 'c2',
        session: 'child',
        ts: at(2),
        role: 'assistant',
        kind: 'tool_use',
        text: 'Bash {"command":"pnpm test"}',
        meta: { toolName: 'Bash' },
      },
    ]);
    write('grandchild.jsonl', [
      {
        id: 'g1',
        session: 'grandchild',
        ts: at(3),
        text: 'Check the docs',
        parents: [{ session: 'grandchild', parent: 'child', via: 'subagent' }],
      },
    ]);
    write('other.jsonl', [{ id: 'o1', session: 'other', ts: at(4), text: 'Unrelated' }]);
    await sync();
    const d = day();
    expect(d.sessions.map((s) => s.sessionId)).toEqual(['other', 'parent']);
    const parent = d.sessions.find((s) => s.sessionId === 'parent');
    expect(parent).toMatchObject({
      events: 3,
      first: at(1),
      last: at(3),
      children: 2,
      workflows: ['Ship'],
      tools: [{ name: 'Bash', calls: 1 }],
      toolCalls: 1,
      // A child's prompts are an agent's, and the parent wrote none that day.
      prompts: [],
      promptCount: 0,
      prompt: 'Ship the release',
    });
    expect(d.totals).toMatchObject({ sessions: 2, events: 4, prompts: 1, children: 2 });
  });

  it("lists only the owner's prompts, in order, cut short", async () => {
    const long = `Explain ${'the cache '.repeat(40)}please`;
    write('s1.jsonl', [
      { id: 'u1', session: 's1', ts: at(9), text: 'First, look at the logs' },
      { id: 'u2', session: 's1', ts: at(9, 1), role: 'assistant', text: 'Looking.' },
      {
        id: 'u3',
        session: 's1',
        ts: at(9, 2),
        text: 'A note from Dana: merge it',
        author: 'person',
      },
      {
        id: 'u4',
        session: 's1',
        ts: at(9, 3),
        text: '<command-name>/clear</command-name>',
      },
      { id: 'u5', session: 's1', ts: at(9, 4), text: long },
      ...[6, 7, 8, 9, 10].map((n) => ({
        id: `u${n}`,
        session: 's1',
        ts: at(10, n),
        text: `Prompt ${n}`,
      })),
    ]);
    write('headless.jsonl', [
      {
        id: 'h1',
        session: 'headless',
        ts: at(11),
        text: 'Summarize the run',
        kinds: [{ session: 'headless', kind: 'headless', signal: 'test' }],
      },
    ]);
    await sync();
    const d = day();
    const s1 = d.sessions.find((s) => s.sessionId === 's1');
    expect(s1?.promptCount).toBe(7);
    expect(s1?.prompts.map((p) => p.id)).toEqual([
      'fake:u1',
      'fake:u5',
      'fake:u6',
      'fake:u7',
      'fake:u8',
    ]);
    const cut = s1?.prompts[1]?.text ?? '';
    expect([...cut]).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(d.sessions.find((s) => s.sessionId === 'headless')?.promptCount).toBe(0);
    expect(d.totals.prompts).toBe(7);
  });

  it("counts Claude Code's tools and the files its edits changed, not the failed ones", async () => {
    const cwd = 'D:\\demo\\app';
    const use = (id: string, minute: number, tool: string, input: string, extra = {}) => ({
      id,
      session: 'cc',
      ts: at(14, minute),
      role: 'assistant' as const,
      kind: 'tool_use',
      cwd,
      text: `${tool} ${input}`,
      meta: { toolName: tool, toolUseId: `tu-${id}`, ...extra },
    });
    const result = (id: string, minute: number, isError: boolean) => ({
      id: `${id}r`,
      session: 'cc',
      ts: at(14, minute),
      kind: 'tool_result',
      cwd,
      text: isError ? 'String not found' : 'ok',
      meta: { toolUseId: `tu-${id}`, isError },
    });
    write(
      'cc.jsonl',
      [
        { id: 'q', session: 'cc', ts: at(14), text: 'Fix the login', cwd },
        use(
          'e1',
          1,
          'Edit',
          JSON.stringify({ file_path: `${cwd}\\src\\login.ts`, old_string: 'a' }),
        ),
        result('e1', 2, false),
        use(
          'e2',
          3,
          'Edit',
          JSON.stringify({ file_path: `${cwd}\\src\\login.ts`, old_string: 'b' }),
        ),
        use(
          'e3',
          4,
          'Write',
          JSON.stringify({ file_path: 'D:\\elsewhere\\notes.md', content: 'x' }),
        ),
        use(
          'e4',
          5,
          'Edit',
          JSON.stringify({ file_path: `${cwd}\\src\\gone.ts`, old_string: 'c' }),
        ),
        result('e4', 6, true),
        use('e5', 7, 'MultiEdit', JSON.stringify({ file_path: `${cwd}\\README.md`, edits: [] })),
        use('e6', 8, 'NotebookEdit', JSON.stringify({ notebook_path: `${cwd}\\nb.ipynb` })),
        // Cut at 2,000 characters after the path: the path is read.
        use(
          'e7',
          9,
          'Write',
          `${JSON.stringify({ file_path: `${cwd}\\src\\big.ts`, content: 'y'.repeat(1900) }).slice(0, 1990)}…[+120 chars]`,
        ),
        // Cut inside the path: nothing is read.
        use('e8', 10, 'Write', `{"file_path":"D:\\\\demo\\\\app\\\\src\\\\cu…[+3000 chars]`),
        use('b1', 11, 'Bash', JSON.stringify({ command: 'git diff' })),
        use('r1', 12, 'Read', JSON.stringify({ file_path: `${cwd}\\src\\login.ts` })),
      ],
      'claude-code',
    );
    await sync('claude-code');
    const [cc] = day().sessions;
    expect(cc?.tools).toEqual([
      { name: 'Edit', calls: 3 },
      { name: 'Write', calls: 3 },
      { name: 'Bash', calls: 1 },
      { name: 'MultiEdit', calls: 1 },
      { name: 'NotebookEdit', calls: 1 },
      { name: 'Read', calls: 1 },
    ]);
    expect(cc?.toolCalls).toBe(10);
    expect(cc?.files).toEqual([
      'src/login.ts',
      'D:/elsewhere/notes.md',
      'README.md',
      'nb.ipynb',
      'src/big.ts',
    ]);
    expect(cc?.fileCount).toBe(5);
  });

  it("reads the files of Codex's apply_patch, in either form, cut short or not", async () => {
    const patch = (body: string) => `*** Begin Patch\n${body}*** End Patch`;
    const call = (id: string, minute: number, input: string) => ({
      id,
      session: 'cx',
      ts: at(15, minute),
      role: 'assistant' as const,
      kind: 'tool_use',
      cwd: '/home/dev/app',
      text: `apply_patch ${input}`,
      meta: { toolName: 'apply_patch', callId: `call-${id}` },
    });
    write(
      'cx.jsonl',
      [
        { id: 'q', session: 'cx', ts: at(15), text: 'Raise the timeout' },
        call(
          'p1',
          1,
          patch('*** Update File: src/api/login.ts\n-  a\n+  b\n*** Add File: src/new.ts\n+x\n'),
        ),
        call(
          'p2',
          2,
          JSON.stringify({
            input: patch('*** Delete File: old.ts\n*** Update File: a.ts\n*** Move to: b.ts\n'),
          }),
        ),
        call(
          'p3',
          3,
          `${patch('*** Update File: src/one.ts\n+1\n*** Update File: src/tw')}`.slice(0, 60) +
            '…[+300 chars]',
        ),
        call('p4', 4, patch('*** Update File: /home/dev/app/src/abs.ts\n+1\n')),
        {
          id: 's1',
          session: 'cx',
          ts: at(15, 5),
          role: 'assistant',
          kind: 'tool_use',
          text: 'shell {"command":["apply_patch","*** Begin Patch\\n*** Add File: x.ts\\n"]}',
          meta: { toolName: 'shell' },
        },
      ],
      'codex',
    );
    await sync('codex');
    const [cx] = day().sessions;
    expect(cx?.tools).toEqual([
      { name: 'apply_patch', calls: 4 },
      { name: 'shell', calls: 1 },
    ]);
    expect([...(cx?.files ?? [])].sort()).toEqual(
      [
        'a.ts',
        'b.ts',
        'old.ts',
        'src/abs.ts',
        'src/api/login.ts',
        'src/new.ts',
        'src/one.ts',
      ].sort(),
    );
  });

  it('reads edit paths only from the tools of each source that edit files', () => {
    expect(
      editedFiles('grok', 'search_replace', 'search_replace {"file_path":"src/up.ts"}'),
    ).toEqual(['src/up.ts']);
    expect(
      editedFiles('cursor', 'StrReplace', 'StrReplace {"path":"src/up.ts","old":"a"}'),
    ).toEqual(['src/up.ts']);
    expect(editedFiles('claude-code', 'Read', 'Read {"file_path":"a.ts"}')).toEqual([]);
    expect(editedFiles('zcode', 'Edit', 'Edit {"file_path":"a.ts"}')).toEqual([]);
    expect(editedFiles('fake', 'Edit', 'Edit {"file_path":"a.ts"}')).toEqual([]);
    // A key inside another field's text is not the call's own.
    expect(
      editedFiles('claude-code', 'Write', 'Write {"content":"say \\"file_path\\":\\"x\\""}'),
    ).toEqual([]);
  });

  it('lists the entries, corrections, proposals, and forgets of the day, by id', async () => {
    write('s1.jsonl', [
      { id: 'm1', session: 's1', ts: at(8), text: 'We always deploy from main, through CI.' },
      { id: 'm2', session: 's1', ts: at(8, 1), role: 'assistant', text: 'Noted.' },
    ]);
    const proposal = (id: string, minute: number, text: string) => ({
      id: `r${minute}`,
      session: 's2',
      ts: at(9, minute),
      kind: 'tool_result',
      text: JSON.stringify({
        proposal: id,
        kind: 'knowledge',
        text,
        confidence: 0.8,
        project: 'demo',
        valid_from: null,
        valid_to: null,
        note: null,
        sources: [{ event_id: 'fake:m1', quote: 'deploy from main' }],
      }),
    });
    write('s2.jsonl', [
      { id: 'q1', session: 's2', ts: at(9), text: 'Consolidate the day.' },
      proposal('prp_0000000000a1', 1, 'CI deploys main.'),
      proposal('prp_0000000000a2', 2, 'Deploys happen on Fridays.'),
    ]);
    await sync();
    const before = remember(
      db,
      {
        kind: 'memory',
        text: 'Yesterday',
        confidence: 0.9,
        author: 'u',
        sources: [{ eventId: 'fake:m1' }],
      },
      at(-2),
    );
    const first = remember(
      db,
      {
        kind: 'knowledge',
        text: 'Deploys go through CI.\nMore detail.',
        confidence: 0.9,
        author: 'claude-code@laptop',
        sources: [{ eventId: 'fake:m1' }],
      },
      at(10),
    );
    const fixed = correct(
      db,
      first.id,
      { text: 'Deploys go from main through CI.', author: 'u' },
      at(11),
    );
    const hidden = remember(
      db,
      {
        kind: 'memory',
        text: 'Secret plan',
        confidence: 0.9,
        author: 'u',
        sources: [{ eventId: 'fake:m2' }],
      },
      at(12),
    );
    const forgot = forget(db, hidden.id, { reason: 'private reason' }, at(13));
    const rejected = rejectProposal(db, 'prp_0000000000a2', { reason: 'not true' }, at(13, 30));
    const undone = restore(db, forgot.tombstoneId as string, { reason: 'fine after all' }, at(14));
    const again = forget(db, hidden.id, { reason: 'private again' }, at(15));

    const d = day();
    expect(d.entries.map((e) => [e.id, e.supersedes])).toEqual([
      [fixed.id, first.id],
      [first.id, null],
    ]);
    expect(d.entries.map((e) => e.id)).not.toContain(before.id);
    expect(d.proposals.map((p) => [p.id, p.status])).toEqual([['prp_0000000000a1', 'pending']]);
    expect(d.forgets).toEqual([
      { id: again.tombstoneId, kind: 'forget', target: hidden.id, targetKind: 'entry', at: at(15) },
      {
        id: undone.tombstoneId,
        kind: 'restore',
        target: forgot.tombstoneId,
        targetKind: 'forget',
        at: at(14),
      },
      {
        id: rejected.tombstoneId,
        kind: 'forget',
        target: 'fake:r2',
        targetKind: 'proposal',
        at: at(13, 30),
      },
      {
        id: forgot.tombstoneId,
        kind: 'forget',
        target: hidden.id,
        targetKind: 'entry',
        at: at(13),
      },
    ]);
    const text = JSON.stringify(d);
    for (const word of ['Secret plan', 'private', 'not true', 'fine after all', 'Fridays']) {
      expect(text).not.toContain(word);
    }
    // A project, or an agent, narrows the entries and proposals too; forgets stay.
    expect(day({ project: 'elsewhere' }).entries).toEqual([]);
    expect(day({ project: 'elsewhere' }).proposals).toEqual([]);
    expect(day({ project: 'elsewhere' }).forgets).toHaveLength(4);
    expect(day({ source: 'fake' }).entries).toHaveLength(2);
    expect(day({ source: 'codex' }).entries).toEqual([]);
    expect(day({ source: 'codex' }).proposals).toEqual([]);
  });

  it('shows nothing forgotten', async () => {
    write('s1.jsonl', [
      { id: 'a1', session: 's1', ts: at(9), text: 'Keep this prompt' },
      { id: 'a2', session: 's1', ts: at(9, 1), text: 'zebra secret prompt' },
      {
        id: 'a3',
        session: 's1',
        ts: at(9, 2),
        role: 'assistant',
        kind: 'tool_use',
        text: 'Edit {"file_path":"zebra-secret.ts"}',
        meta: { toolName: 'Edit' },
      },
    ]);
    write('s2.jsonl', [{ id: 'b1', session: 's2', ts: at(10), text: 'zebra session' }]);
    await sync();
    forget(db, 'fake:a2', { reason: 'zebra' }, at(11));
    forget(db, 'fake:a3', { reason: 'zebra' }, at(11));
    forget(db, 'fake:b1', { reason: 'zebra' }, at(11));
    const d = day();
    expect(d.sessions.map((s) => [s.sessionId, s.events, s.promptCount, s.toolCalls])).toEqual([
      ['s1', 1, 1, 0],
    ]);
    expect(d.totals).toMatchObject({ sessions: 1, events: 1, prompts: 1 });
    expect(JSON.stringify(d)).not.toContain('zebra');
    expect(d.forgets).toHaveLength(3);
  });

  it('lists at most `limit` sessions, the most recently active first, and counts the rest', async () => {
    for (const [i, hour] of [9, 13, 11].entries()) {
      write(`s${i}.jsonl`, [{ id: `x${i}`, session: `s${i}`, ts: at(hour), text: `Prompt ${i}` }]);
    }
    await sync();
    const d = day({ limit: 2 });
    expect(d.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(d.moreSessions).toBe(1);
    expect(d.totals.sessions).toBe(3);
    expect(day().moreSessions).toBe(0);
    expect(day({ source: 'other' }).sessions).toEqual([]);
  });
});
