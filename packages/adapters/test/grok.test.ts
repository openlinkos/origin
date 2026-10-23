import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRemote,
  listEvents,
  listSessions,
  openMemoryDatabase,
  rawLocator,
  readRawLine,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGrokAdapter,
  grokCwdFromGroup,
  grokSessionIdFromPath,
  parseGrokLine,
} from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/grok/', import.meta.url));
const SESSION = '01a0f000-0000-7000-8000-000000000001';
const REL = `sessions/%2Fhome%2Fdev%2Fdemo-app/${SESSION}/updates.jsonl`;
const lines = fs.readFileSync(path.join(fixtures, REL), 'utf8').trim().split('\n');
const T0 = Date.parse('2026-10-20T01:00:00Z');
const ctx = (lineNo: number) => ({
  absPath: path.join(fixtures, REL),
  relPath: REL,
  lineNo,
  fileMtimeMs: 0,
});
const parse = (i: number) => parseGrokLine(lines[i]!, ctx(i + 1));

describe('parseGrokLine', () => {
  it('ignores thoughts, call refinements, and turn and task bookkeeping', () => {
    for (const i of [1, 4, 13, 14]) expect(parse(i)).toBeNull();
  });

  it('maps messages, marking prompts hidden from the transcript as meta', () => {
    expect(parse(0)?.events[0]).toEqual({
      id: `${SESSION}:e1`,
      sessionId: SESSION,
      ts: T0 + 1000,
      cwd: '/home/dev/demo-app',
      project: 'demo-app',
      role: 'user',
      kind: 'message',
      text: 'Add a retry to the upload client.',
      agentVersion: null,
      meta: null,
    });
    expect(parse(2)?.events[0]).toMatchObject({
      role: 'assistant',
      kind: 'message',
      text: "I'll look at the upload client first.",
    });
    expect(parse(12)?.events[0]).toMatchObject({ role: 'user', kind: 'meta' });
    // Without the agent's timestamp, the line's own (in seconds) is used.
    expect(parse(15)?.events[0]?.ts).toBe(T0 + 16_000 + 250);
    // Ids that do not follow `<session-id>-<n>` are kept as they are.
    expect(parse(16)?.events[0]).toMatchObject({ id: `${SESSION}:host-turn-7`, text: '[image]' });
  });

  it('maps tool calls and what they returned', () => {
    expect(parse(3)?.events[0]).toMatchObject({
      role: 'assistant',
      kind: 'tool_use',
      text: 'read_file {"target_file":"src/upload.ts"}',
      meta: { toolName: 'read_file', callId: 'call-1' },
    });
    expect(parse(5)?.events[0]).toMatchObject({
      role: 'user',
      kind: 'tool_result',
      text: 'export async function upload(file) {\n  return fetch(url, { body: file });\n}',
      meta: { callId: 'call-1' },
    });
    expect(parse(6)?.events[0]?.text).toBe('web_search Web search: exponential backoff fetch');
    expect(parse(7)?.events[0]?.text).toContain('"query":"exponential backoff fetch"');
    expect(parse(8)?.events[0]?.text).toMatch(/^search_replace \{"file_path":"src\/upload.ts"/);
    expect(parse(9)?.events[0]?.text).toBe(
      '/home/dev/demo-app/src/upload.ts\nreturn withRetry(() => fetch(url, { body: file }));',
    );
    expect(parse(11)?.events[0]).toMatchObject({
      text: '1 failed, 41 passed',
      meta: { callId: 'call-3', status: 'failed' },
    });
  });

  it('reads the session and its working directory from the path', () => {
    expect(grokSessionIdFromPath(REL)).toBe(SESSION);
    expect(grokSessionIdFromPath(`sessions/x/${SESSION}/chat_history.jsonl`)).toBeNull();
    expect(grokCwdFromGroup('%2Fhome%2Fdev%2Fdemo-app')).toBe('/home/dev/demo-app');
    expect(grokCwdFromGroup('C%3A%5CUsers%5Cdev%5Capp')).toBe('C:\\Users\\dev\\app');
    // Too long to encode: a slug and a hash, with the path only in a `.cwd` file.
    expect(grokCwdFromGroup('very-long-project-path-3f9a1c')).toBeNull();
    expect(grokCwdFromGroup('%E0%A4%A')).toBeNull();
  });
});

describe('grok adapter', () => {
  let grokHome: string;
  let originHome: string;

  beforeEach(() => {
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-grok-'));
    originHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    fs.cpSync(fixtures, grokHome, { recursive: true });
    // Grok keeps its own search index next to the session groups.
    fs.writeFileSync(path.join(grokHome, 'sessions', 'session_search.sqlite'), '');
  });
  afterEach(() => {
    fs.rmSync(grokHome, { recursive: true, force: true });
    fs.rmSync(originHome, { recursive: true, force: true });
  });

  it('ingests the update stream of each session, and only that', async () => {
    const db = openMemoryDatabase();
    const adapter = createGrokAdapter({ home: grokHome });
    expect((await adapter.discover()).map((f) => f.relPath)).toEqual([REL]);

    const r = await syncSource({ db, home: originHome }, adapter);
    expect(r).toMatchObject({ source: 'grok', filesChanged: 1, parseErrors: 0, eventsAdded: 13 });
    expect(adapter.version()).toBe('1.0.41');

    const events = listEvents(db, { sessionId: SESSION });
    expect(events.map((e) => e.kind)).toEqual([
      'message',
      'message',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'meta',
      'message',
      'message',
    ]);
    expect(events[0]).toMatchObject({ id: `grok:${SESSION}:e1`, agentVersion: '1.0.41' });
    const loc = rawLocator(db, originHome, events[0]!)!;
    expect(JSON.parse(readRawLine(db, originHome, loc)!)).toMatchObject({
      params: { sessionId: SESSION },
    });
    expect(listSessions(db).map((s) => [s.sessionId, s.project])).toEqual([[SESSION, 'demo-app']]);

    const again = await syncSource({ db, home: originHome }, adapter);
    expect(again).toMatchObject({ filesChanged: 0, eventsAdded: 0 });
    db.close();
  });

  it('gives a hub the same events from the pushed mirror', async () => {
    const device = openMemoryDatabase();
    await syncSource({ db: device, home: originHome }, createGrokAdapter({ home: grokHome }));
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
    try {
      const hub = openMemoryDatabase();
      const content = `${lines.join('\n')}\n`;
      expect(
        appendRemote({ db: hub, home: hubHome }, createGrokAdapter({ home: hubHome }), {
          device: 'laptop',
          source: 'grok',
          path: `/home/me/.grok/${REL}`,
          relPath: REL,
          generation: 1,
          offset: 0,
          data: Buffer.from(content),
          agentVersion: '1.0.41',
        }),
      ).toMatchObject({ ok: true });
      const strip = (e: {
        id: string;
        kind: string;
        text: string;
        ts: number;
        cwd: string | null;
      }) => [e.id, e.kind, e.text, e.ts, e.cwd];
      expect(listEvents(hub, { sessionId: SESSION }).map(strip)).toEqual(
        listEvents(device, { sessionId: SESSION }).map(strip),
      );
      hub.close();
    } finally {
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
    device.close();
  });
});
