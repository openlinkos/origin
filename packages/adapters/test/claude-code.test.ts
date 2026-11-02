import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRemote,
  type Database,
  listEvents,
  listSessions,
  localRawFiles,
  openDatabase,
  openMemoryDatabase,
  rawLocator,
  readMirror,
  readRawLine,
  STORE_VERSION,
  syncFile,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downgradeToV1, downgradeToV7, userVersion } from '../../core/test/legacy.js';
import {
  createClaudeCodeAdapter,
  parseClaudeCodeLine,
  projectFromCwd,
  sessionIdFromPath,
} from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/claude-code/', import.meta.url));
const SESSION = '0f1e2d3c-4b5a-4697-8877-665544332211';
const REL = `D--demo-project/${SESSION}.jsonl`;
const ctx = (lineNo: number) => ({
  absPath: path.join(fixtures, REL),
  relPath: REL,
  lineNo,
  fileMtimeMs: 0,
});

describe('parseClaudeCodeLine', () => {
  const lines = fs.readFileSync(path.join(fixtures, REL), 'utf8').trim().split('\n');

  it('ignores non-conversation rows', () => {
    expect(parseClaudeCodeLine(lines[0]!, ctx(1))).toBeNull(); // mode
    expect(parseClaudeCodeLine(lines[1]!, ctx(2))).toBeNull(); // permission-mode
    expect(parseClaudeCodeLine(lines[2]!, ctx(3))).toBeNull(); // file-history-snapshot
  });

  it('marks meta user rows and keeps plain user text', () => {
    const meta = parseClaudeCodeLine(lines[3]!, ctx(4))!;
    expect(meta.events).toHaveLength(1);
    expect(meta.events[0]).toMatchObject({
      kind: 'meta',
      role: 'user',
      project: 'project',
      gitBranch: 'master',
    });

    const user = parseClaudeCodeLine(lines[4]!, ctx(5))!;
    expect(user.events[0]).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'message',
      role: 'user',
      text: '帮我检查一下仓库的状态',
      sessionId: SESSION,
      ts: Date.parse('2026-10-19T03:42:00.000Z'),
      agentVersion: '2.1.303',
    });
  });

  it('splits assistant text and tool_use blocks, skipping thinking', () => {
    const a = parseClaudeCodeLine(lines[5]!, ctx(6))!;
    expect(a.events.map((e) => [e.id, e.kind])).toEqual([
      ['33333333-3333-4333-8333-333333333333#2', 'tool_use'],
      ['33333333-3333-4333-8333-333333333333', 'message'],
    ]);
    expect(a.events[0]?.text).toBe(
      'Bash {"command":"git status","description":"Show working tree status"}',
    );
    expect(a.events[0]?.meta).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'toolu_01',
      model: 'claude-fable-5-1',
    });
    expect(a.events[1]?.text).toBe('Sure, let me check the working tree.');
    expect(JSON.stringify(a.events)).not.toContain('private reasoning');
  });

  it('turns tool_result rows into tool_result events', () => {
    const r = parseClaudeCodeLine(lines[6]!, ctx(7))!;
    expect(r.events[0]).toMatchObject({ kind: 'tool_result', role: 'user' });
    expect(r.events[0]?.text).toContain('working tree clean');
    expect(r.events[0]?.meta).toMatchObject({ toolUseId: 'toolu_01', isError: false });
  });

  it('maps summary rows to the session title derived from the file name', () => {
    const s = parseClaudeCodeLine(lines[8]!, ctx(9))!;
    expect(s).toEqual({ events: [], sessionTitle: 'Check repository status', sessionId: SESSION });
  });
});

describe('helpers', () => {
  it('derives session id from uuid file names only', () => {
    expect(sessionIdFromPath(REL)).toBe(SESSION);
    expect(sessionIdFromPath(`D--x/${SESSION}/subagents/agent-abc.jsonl`)).toBeNull();
  });
  it('derives project from either path separator', () => {
    expect(projectFromCwd('D:\\devs\\codes\\origin')).toBe('origin');
    expect(projectFromCwd('/home/u/work/my-app/')).toBe('my-app');
    expect(projectFromCwd(undefined)).toBeNull();
  });
});

describe('createClaudeCodeAdapter end-to-end', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cc-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('discovers fixture files and ingests them into the event store', async () => {
    const db = openMemoryDatabase();
    const adapter = createClaudeCodeAdapter({ projectsDir: fixtures });
    const files = await adapter.discover();
    expect(files.map((f) => f.relPath)).toEqual([REL]);

    const r = await syncSource({ db, home }, adapter);
    expect(r).toMatchObject({
      source: 'claude-code',
      filesSeen: 1,
      filesChanged: 1,
      parseErrors: 0,
    });
    expect(r.eventsAdded).toBe(6); // meta, user, tool_use, assistant, tool_result, assistant

    const events = listEvents(db, { sessionId: SESSION });
    expect(events.map((e) => e.kind)).toEqual([
      'meta',
      'message',
      'tool_use',
      'message',
      'tool_result',
      'message',
    ]);
    expect(events.every((e) => e.id.startsWith('claude-code:'))).toBe(true);
    expect(events[1]?.rawLine).toBe(5);

    const [session] = listSessions(db);
    expect(session).toMatchObject({
      source: 'claude-code',
      sessionId: SESSION,
      project: 'project',
      title: 'Check repository status',
      eventCount: 6,
    });
    expect(adapter.version()).toBe('2.1.303');
    // The mirror holds the file's lines (in its open tail: the file is smaller than a frame).
    expect(readRawLine(db, home, rawLocator(db, home, events[1]!)!)).toBe(
      fs.readFileSync(path.join(fixtures, REL), 'utf8').split(/\r?\n/)[4],
    );
    db.close();
  });
});

describe('who wrote a Claude Code input', () => {
  const user = (fields: Record<string, unknown>, content: unknown = 'Fix the flaky test.') =>
    JSON.stringify({
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      sessionId: SESSION,
      timestamp: '2026-10-20T09:00:00.000Z',
      cwd: 'D:\\demo\\project',
      version: '2.1.303',
      entrypoint: 'cli',
      message: { role: 'user', content },
      ...fields,
    });
  const input = (fields: Record<string, unknown>, rel = REL, content?: unknown) =>
    parseClaudeCodeLine(user(fields, content), { ...ctx(1), relPath: rel })?.events[0];

  it('reads origin.kind, isCompactSummary, and promptSource, as 2.1.303 writes them', () => {
    expect(input({ origin: { kind: 'human' }, promptSource: 'typed' })).toMatchObject({
      author: 'owner',
      authorSignal: 'origin.kind',
    });
    expect(input({ origin: { kind: 'task-notification' }, promptSource: 'system' })).toMatchObject({
      author: 'system',
      authorSignal: 'origin.kind',
    });
    // Another agent's message, named as Claude Code names it, never by its id.
    expect(
      input({ isMeta: true, origin: { kind: 'peer', name: 'reviewer', from: 'a1b2c3d4e5f60718' } }),
    ).toMatchObject({ kind: 'meta', author: 'agent', speaker: 'reviewer' });
    expect(input({ origin: { kind: 'coordinator' } })).toMatchObject({ author: 'agent' });
    expect(input({ isCompactSummary: true, isVisibleInTranscriptOnly: true })).toMatchObject({
      author: 'system',
      authorSignal: 'isCompactSummary',
    });
    expect(input({ promptSource: 'queued' })).toMatchObject({
      author: 'owner',
      authorSignal: 'promptSource',
    });
    // Older versions record none of it: the prompt's kind and text decide, in the store.
    expect(input({ entrypoint: undefined })?.author).toBeUndefined();
    expect(input({ isMeta: true })?.author).toBeUndefined();
  });

  it("makes a sub-agent's and a headless run's input the agent's and the system's, whatever else it says", () => {
    expect(input({ isSidechain: true, origin: { kind: 'human' } })).toMatchObject({
      author: 'agent',
      authorSignal: 'isSidechain',
    });
    expect(
      input({ promptSource: 'typed' }, `D--demo-project/${SESSION}/subagents/agent-a1.jsonl`),
    ).toMatchObject({ author: 'agent', authorSignal: 'subagents' });
    expect(input({ entrypoint: 'sdk-cli', promptSource: 'sdk' })).toMatchObject({
      author: 'system',
      authorSignal: 'entrypoint',
    });
  });

  it('gives a tool result no author', () => {
    const result = input({ origin: { kind: 'human' } }, REL, [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
    ]);
    expect(result).toMatchObject({ kind: 'tool_result' });
    expect(result?.author).toBeUndefined();
  });

  it('is what a store reads, the text rule deciding for older lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cc-authors-'));
    try {
      const projects = path.join(dir, 'projects');
      fs.mkdirSync(path.join(projects, 'D--demo-project'), { recursive: true });
      const lines = [
        user({ uuid: 'a0000000-0000-4000-8000-000000000001', origin: { kind: 'human' } }),
        user({ uuid: 'a0000000-0000-4000-8000-000000000002', isCompactSummary: true }),
        user(
          { uuid: 'a0000000-0000-4000-8000-000000000003', entrypoint: undefined },
          '<command-name>/clear</command-name>',
        ),
        user({ uuid: 'a0000000-0000-4000-8000-000000000004', entrypoint: undefined }),
      ];
      fs.writeFileSync(path.join(projects, REL), `${lines.join('\n')}\n`);
      const db = openMemoryDatabase();
      await syncSource({ db, home: dir }, createClaudeCodeAdapter({ projectsDir: projects }));
      expect(listEvents(db).map((e) => [e.id.slice(-1), e.author, e.authorSignal])).toEqual([
        ['1', 'owner', 'origin.kind'],
        ['2', 'system', 'isCompactSummary'],
        ['3', 'system', 'text'],
        ['4', 'owner', 'text'],
      ]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prompts the user queued while Claude Code was busy', () => {
  const queued = (fields: Record<string, unknown>, attachment: Record<string, unknown>) =>
    JSON.stringify({
      type: 'attachment',
      uuid: '44444444-4444-4444-8444-444444444444',
      parentUuid: '22222222-2222-4222-8222-222222222222',
      sessionId: SESSION,
      timestamp: '2026-10-20T09:05:00.000Z',
      cwd: 'D:\\demo\\project',
      gitBranch: 'retry-fix',
      version: '2.1.303',
      entrypoint: 'cli',
      userType: 'external',
      isSidechain: false,
      attachment: {
        type: 'queued_command',
        prompt: 'Also run the linter.',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        humanTurn: true,
        ...attachment,
      },
      ...fields,
    });
  const parse = (line: string, rel = REL) => parseClaudeCodeLine(line, { ...ctx(9), relPath: rel });

  it("become the owner's messages, under the line's uuid, with their text as written", () => {
    expect(parse(queued({}, {}))).toEqual({
      events: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          sessionId: SESSION,
          parentId: '22222222-2222-4222-8222-222222222222',
          ts: Date.parse('2026-10-20T09:05:00.000Z'),
          project: 'project',
          cwd: 'D:\\demo\\project',
          gitBranch: 'retry-fix',
          agentVersion: '2.1.303',
          role: 'user',
          kind: 'message',
          text: 'Also run the linter.',
          meta: { queued: true, userType: 'external', entrypoint: 'cli' },
          author: 'owner',
          authorSignal: 'queued_command',
        },
      ],
    });
    expect(
      parse(
        queued(
          {},
          {
            prompt: [
              { type: 'text', text: 'Look at this screenshot.' },
              { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=' } },
            ],
          },
        ),
      )?.events[0]?.text,
    ).toBe('Look at this screenshot.\n[image]');
  });

  it("yields nothing for a queued notice, a sub-agent's, or another attachment", () => {
    expect(
      parse(
        queued({}, { origin: { kind: 'task-notification' }, commandMode: 'task-notification' }),
      ),
    ).toBeNull();
    expect(parse(queued({ isSidechain: true }, { isMeta: true }))).toBeNull();
    expect(parse(queued({}, {}), `D--demo-project/${SESSION}/subagents/agent-a1.jsonl`)).toBeNull();
    expect(parse(queued({}, { prompt: '   ' }))).toBeNull();
    expect(
      parse(JSON.stringify({ type: 'attachment', uuid: 'x', attachment: { type: 'date' } })),
    ).toBeNull();
  });

  it('are recovered when a store of version 7 is upgraded, as a new store reads them', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cc-queued-'));
    try {
      const projects = path.join(tmp, 'projects');
      fs.mkdirSync(path.join(projects, 'D--demo-project'), { recursive: true });
      const typed = (uuid: string, text: string, at: string) =>
        JSON.stringify({
          type: 'user',
          uuid,
          sessionId: SESSION,
          timestamp: at,
          cwd: 'D:\\demo\\project',
          version: '2.1.303',
          entrypoint: 'cli',
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { role: 'user', content: text },
        });
      fs.writeFileSync(
        path.join(projects, REL),
        `${[
          typed(
            'a1000000-0000-4000-8000-000000000001',
            'Fix the flaky upload test.',
            '2026-10-20T09:00:00.000Z',
          ),
          queued({}, {}),
          typed('a1000000-0000-4000-8000-000000000003', 'Then push.', '2026-10-20T09:09:00.000Z'),
        ].join('\n')}\n`,
      );
      const adapter = () => createClaudeCodeAdapter({ projectsDir: projects });
      const held = (db: Database) => ({
        events: listEvents(db).map((e) => [e.id, e.ts, e.text, e.author, e.authorSignal]),
        sessions: listSessions(db).map((s) => [s.sessionId, s.eventCount, s.endedAt]),
      });

      const freshHome = path.join(tmp, 'fresh');
      const fresh = openDatabase(path.join(freshHome, 'origin.db'));
      await syncSource({ db: fresh, home: freshHome }, adapter());
      const expected = held(fresh);
      expect(expected.events.map((e) => e[2])).toEqual([
        'Fix the flaky upload test.',
        'Also run the linter.',
        'Then push.',
      ]);

      // Version 7 skipped attachment lines: the queued prompt is only in the mirror.
      const home = path.join(tmp, 'device');
      const file = path.join(home, 'origin.db');
      const before = openDatabase(file);
      const v6 = adapter();
      await syncSource(
        { db: before, home },
        { ...v6, parseLine: (l, c) => (l.includes('"attachment"') ? null : v6.parseLine(l, c)) },
      );
      expect(listEvents(before)).toHaveLength(2);
      before.close();
      downgradeToV7(file);
      const upgraded = openDatabase(file, { adapters: [adapter()] });
      expect(userVersion(upgraded)).toBe(STORE_VERSION);
      expect(held(upgraded)).toEqual(expected);
      // And it goes on as a new store does: nothing is read twice.
      expect(await syncSource({ db: upgraded, home }, adapter())).toMatchObject({ eventsAdded: 0 });
      upgraded.close();
      fresh.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** What a store holds of its sessions' files: each mirror with its cursor and content, and the events. */
function holdings(db: Database, home: string) {
  const files = (
    db
      .prepare(
        `SELECT id, source, path, generation, mirror, bytes_ingested, lines_ingested, tail_hash
         FROM raw_file ORDER BY path, generation`,
      )
      .all() as Array<{ id: number; mirror: string }>
  )
    .filter((f) => !f.mirror.replace(/\\/g, '/').startsWith('claude-code/memory/'))
    .map(({ id, ...row }) => ({
      ...row,
      content: readMirror(db, home, id, 0, Number.MAX_SAFE_INTEGER).toString('utf8'),
    }));
  const events = db
    .prepare(
      `SELECT e.id, e.session_id, e.ts, e.role, e.kind, e.text, e.raw_line, e.agent_version, r.path
       FROM event e JOIN raw_file r ON r.id = e.raw_file_id WHERE e.kind <> 'memory' ORDER BY e.id`,
    )
    .all();
  return { files, events, sessions: listSessions(db) };
}

describe('Claude Code, one transcript at a time', () => {
  let tmp: string;
  let root: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cc-locate-'));
    root = path.join(tmp, 'projects');
    writeTitledSessions(root);
    fs.mkdirSync(path.join(root, 'D--work-alpha', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'D--work-alpha', 'memory', 'note.md'), '# A note\n');
    fs.writeFileSync(path.join(root, 'D--work-alpha', 'memory', 'stray.jsonl'), '{}\n');
    const results = path.join(root, 'D--work-alpha', RENAMED, 'tool-results');
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, 'out.jsonl'), '{}\n');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('locates every log discover() lists, sub-agents included, and nothing else', async () => {
    const adapter = createClaudeCodeAdapter({ projectsDir: root });
    const logs = (await adapter.discover()).filter((f) => !f.generated);
    expect(logs.map((f) => f.relPath)).toContain(
      `D--work-alpha/${RENAMED}/subagents/agent-a1.jsonl`,
    );
    for (const f of logs) expect(adapter.locate?.(f.absPath)).toEqual(f);
    // However the path is spelled, the file is the one discover() lists.
    const sub = logs.find((f) => f.relPath.endsWith('agent-a1.jsonl'));
    const spelled = path.join(root, 'D--work-alpha', '.', RENAMED, 'subagents', 'agent-a1.jsonl');
    expect(adapter.locate?.(spelled)).toEqual(sub);
    // Pure: a log that is not there yet is located all the same.
    const next = `D--work-delta/${RENAMED}.jsonl`;
    expect(adapter.locate?.(path.join(root, next))).toEqual({
      absPath: path.join(root, next),
      relPath: next,
    });
    for (const p of [
      path.join(tmp, `${RENAMED}.jsonl`),
      path.join(root, 'D--work-alpha', 'memory', 'stray.jsonl'),
      path.join(root, 'D--work-alpha', 'memory', 'note.md'),
      path.join(root, 'D--work-alpha', RENAMED, 'tool-results', 'out.jsonl'),
      path.join(root, 'D--work-alpha'),
      root,
    ]) {
      expect(adapter.locate?.(p)).toBeNull();
    }
  });

  it('ingests a session and its sub-agent one file at a time, as syncSource ingests them', async () => {
    const one = { db: openMemoryDatabase(), home: path.join(tmp, 'one') };
    const all = { db: openMemoryDatabase(), home: path.join(tmp, 'all') };
    const adapter = () => createClaudeCodeAdapter({ projectsDir: root });
    const logs = (await adapter().discover()).filter((f) => !f.generated);
    // The sub-agent's log first, as a SubagentStop hook would, then the rest.
    const order = [...logs].sort(
      (a, b) =>
        Number(b.relPath.includes('/subagents/')) - Number(a.relPath.includes('/subagents/')),
    );
    const located = adapter();
    for (const f of order) {
      const r = await syncFile(one, located, f.absPath);
      expect(r).toMatchObject({ filesSeen: 1, filesChanged: 1, parseErrors: 0 });
      expect(await syncFile(one, located, f.absPath)).toMatchObject({ linesRead: 0 });
    }
    await syncSource(all, adapter());
    expect(holdings(one.db, one.home)).toEqual(holdings(all.db, all.home));
    expect(titles(one.db)).toEqual(EXPECTED_TITLES);
    one.db.close();
    all.db.close();
  });
});

const RENAMED = 'a1a1a1a1-0000-4000-8000-000000000001';
const RETITLED = 'b2b2b2b2-0000-4000-8000-000000000002';
const SUMMARIZED = 'c3c3c3c3-0000-4000-8000-000000000003';

/** Synthetic Claude Code 2.1 sessions whose titles come from each kind of title line. */
function writeTitledSessions(root: string): void {
  let n = 0;
  const message = (session: string, type: 'user' | 'assistant', text: string) =>
    JSON.stringify({
      type,
      uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      sessionId: session,
      timestamp: new Date(Date.UTC(2026, 9, 20, 9, 0, n)).toISOString(),
      cwd: '/work/alpha',
      version: '2.1.310',
      message: { role: type, content: text },
    });
  const title = (session: string, type: string, field: string, text: string) =>
    JSON.stringify({ type, [field]: text, sessionId: session });
  const write = (rel: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `${lines.join('\n')}\n`);
  };
  // Renamed by the user, after which Claude Code still writes AI titles.
  write(`D--work-alpha/${RENAMED}.jsonl`, [
    message(RENAMED, 'user', 'the login form rejects valid passwords'),
    title(RENAMED, 'ai-title', 'aiTitle', 'Fix login form'),
    message(RENAMED, 'assistant', 'Looking at the form handler.'),
    title(RENAMED, 'ai-title', 'aiTitle', 'Fix login password check'),
    title(RENAMED, 'custom-title', 'customTitle', 'Login work'),
    title(RENAMED, 'agent-name', 'agentName', 'Login work'),
    message(RENAMED, 'user', 'and the session expiry too'),
    title(RENAMED, 'ai-title', 'aiTitle', 'Fix login and session expiry'),
  ]);
  // A sub-agent's log names the parent session but does not title it.
  write(`D--work-alpha/${RENAMED}/subagents/agent-a1.jsonl`, [
    message(RENAMED, 'user', 'search the codebase for the password check'),
    title(RENAMED, 'ai-title', 'aiTitle', 'Search for password check'),
  ]);
  // Titled by Claude Code alone: the latest AI title is current.
  write(`D--work-beta/${RETITLED}.jsonl`, [
    message(RETITLED, 'user', 'add a dark mode'),
    title(RETITLED, 'ai-title', 'aiTitle', 'Dark mode'),
    message(RETITLED, 'assistant', 'Adding a theme switch.'),
    title(RETITLED, 'ai-title', 'aiTitle', 'Dark mode with a theme switch'),
  ]);
  // An older log, with a summary line.
  write(`D--work-gamma/${SUMMARIZED}.jsonl`, [
    message(SUMMARIZED, 'user', 'bump the dependencies'),
    JSON.stringify({ type: 'summary', summary: 'Dependency bump', leafUuid: 'x' }),
  ]);
}

const EXPECTED_TITLES = [
  [RENAMED, 'Login work'],
  [RETITLED, 'Dark mode with a theme switch'],
  [SUMMARIZED, 'Dependency bump'],
];

const titles = (db: Database) =>
  listSessions(db)
    .map((s) => [s.sessionId, s.title])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('Claude Code session titles', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cc-titles-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads ai-title, custom-title, and summary lines, and not agent-name lines', () => {
    const rel = `D--x/${RETITLED}.jsonl`;
    const at = { absPath: rel, relPath: rel, lineNo: 1, fileMtimeMs: 0 };
    const parse = (o: Record<string, unknown>) => parseClaudeCodeLine(JSON.stringify(o), at);
    expect(parse({ type: 'ai-title', aiTitle: ' Dark mode ', sessionId: RETITLED })).toEqual({
      events: [],
      sessionTitle: 'Dark mode',
      sessionId: RETITLED,
    });
    expect(parse({ type: 'custom-title', customTitle: 'Mine', sessionId: RETITLED })).toEqual({
      events: [],
      sessionTitle: 'Mine',
      sessionId: RETITLED,
      manualTitle: true,
    });
    expect(parse({ type: 'agent-name', agentName: 'Mine', sessionId: RETITLED })).toBeNull();
    expect(parse({ type: 'ai-title', aiTitle: '  ', sessionId: RETITLED })).toBeNull();
    expect(parse({ type: 'constructor' })).toBeNull();
    const sub = `D--x/${RETITLED}/subagents/agent-1.jsonl`;
    expect(
      parseClaudeCodeLine(
        JSON.stringify({ type: 'ai-title', aiTitle: 'Sub', sessionId: RETITLED }),
        {
          ...at,
          relPath: sub,
        },
      ),
    ).toBeNull();
  });

  it('keeps the latest AI title, unless the user renamed the session', async () => {
    const projects = path.join(tmp, 'projects');
    writeTitledSessions(projects);
    const db = openMemoryDatabase();
    await syncSource({ db, home: tmp }, createClaudeCodeAdapter({ projectsDir: projects }));
    expect(titles(db)).toEqual(EXPECTED_TITLES);

    // Renaming again replaces the user's title; AI titles still do not.
    fs.appendFileSync(
      path.join(projects, `D--work-alpha/${RENAMED}.jsonl`),
      `${JSON.stringify({ type: 'custom-title', customTitle: 'Auth', sessionId: RENAMED })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Later', sessionId: RENAMED })}\n`,
    );
    await syncSource({ db, home: tmp }, createClaudeCodeAdapter({ projectsDir: projects }));
    expect(titles(db)[0]).toEqual([RENAMED, 'Auth']);
    db.close();
  });

  it('are set when a store of 0.1.0 is upgraded, from its mirrors alone', async () => {
    const projects = path.join(tmp, 'projects');
    writeTitledSessions(projects);
    const home = path.join(tmp, 'device');
    const file = path.join(home, 'origin.db');
    const adapter = () => createClaudeCodeAdapter({ projectsDir: projects });
    // Small frames, so that the title lines are in sealed frames as well as in the open tails.
    const db = openDatabase(file);
    await syncSource({ db, home, frameBytes: 400 }, adapter());
    expect(db.prepare('SELECT COUNT(*) AS n FROM raw_chunk').get()).not.toEqual({ n: 0 });
    db.close();
    downgradeToV1(file);
    // The agent has since deleted its logs (cleanupPeriodDays): the mirrors are all there is.
    fs.rmSync(projects, { recursive: true, force: true });

    // The migration needs the adapter; without it, the store stays at the version before.
    expect(() => openDatabase(file)).toThrow(/needs the claude-code adapter/);
    const upgraded = openDatabase(file, { adapters: [adapter()] });
    expect(userVersion(upgraded)).toBe(STORE_VERSION);
    expect(titles(upgraded)).toEqual(EXPECTED_TITLES);
    // The user's title is known to be the user's: an AI title that arrives later does not replace it.
    fs.mkdirSync(path.join(projects, 'D--work-alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(projects, `D--work-alpha/${RENAMED}.jsonl`),
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Later', sessionId: RENAMED })}\n`,
    );
    await syncSource({ db: upgraded, home }, adapter());
    expect(titles(upgraded)).toEqual(EXPECTED_TITLES);
    upgraded.close();
  });

  it('are set when a hub of 0.1.0 is upgraded, from the mirrors its devices pushed', async () => {
    const projects = path.join(tmp, 'projects');
    writeTitledSessions(projects);
    const deviceHome = path.join(tmp, 'device');
    const device = openDatabase(path.join(deviceHome, 'origin.db'));
    await syncSource(
      { db: device, home: deviceHome },
      createClaudeCodeAdapter({ projectsDir: projects }),
    );
    const hubHome = path.join(tmp, 'hub');
    const hubFile = path.join(hubHome, 'origin.db');
    const hub = openDatabase(hubFile);
    const onHub = createClaudeCodeAdapter({ projectsDir: path.join(hubHome, 'unused') });
    for (const f of localRawFiles(device)) {
      expect(
        appendRemote({ db: hub, home: hubHome, frameBytes: 400 }, onHub, {
          device: 'laptop',
          source: f.source,
          path: f.path,
          relPath: f.relPath,
          generation: f.generation,
          offset: 0,
          data: readMirror(device, deviceHome, f.id, 0, f.bytes),
        }),
      ).toMatchObject({ ok: true });
    }
    expect(titles(hub)).toEqual(EXPECTED_TITLES);
    device.close();
    hub.close();
    expect(fs.existsSync(path.join(hubHome, 'raw', 'devices', 'laptop', 'claude-code'))).toBe(true);

    downgradeToV1(hubFile);
    const upgraded = openDatabase(hubFile, { adapters: [onHub] });
    expect(userVersion(upgraded)).toBe(STORE_VERSION);
    expect(titles(upgraded)).toEqual(EXPECTED_TITLES);
    upgraded.close();
  });
});
