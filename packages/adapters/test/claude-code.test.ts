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
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downgradeToV1, userVersion } from '../../core/test/legacy.js';
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
