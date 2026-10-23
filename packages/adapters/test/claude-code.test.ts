import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listEvents,
  listSessions,
  openMemoryDatabase,
  rawLocator,
  readRawLine,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
