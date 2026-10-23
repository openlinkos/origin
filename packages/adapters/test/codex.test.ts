import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
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
import { codexSessionIdFromPath, createCodexAdapter, parseCodexLine } from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/codex/', import.meta.url));
const SESSION = '0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d';
const REL = `sessions/2026/10/20/rollout-2026-10-20T09-00-00-${SESSION}.jsonl`;
const lines = fs.readFileSync(path.join(fixtures, REL), 'utf8').trim().split('\n');
const info = { cwd: '/home/dev/demo-app', version: '0.160.0' };
const ctx = (lineNo: number) => ({
  absPath: path.join(fixtures, REL),
  relPath: REL,
  lineNo,
  fileMtimeMs: 0,
});
const parse = (i: number) => parseCodexLine(lines[i]!, ctx(i + 1), info);

describe('parseCodexLine', () => {
  it('ignores metadata, instructions, reasoning, and UI duplicates', () => {
    for (const i of [0, 1, 2, 3, 6, 7, 13, 16]) expect(parse(i)).toBeNull();
  });

  it('maps messages, marking injected context as meta', () => {
    expect(parse(4)?.events[0]).toMatchObject({ role: 'user', kind: 'meta' });
    expect(parse(5)?.events[0]).toMatchObject({
      id: `${SESSION}:o5`,
      sessionId: SESSION,
      role: 'user',
      kind: 'message',
      text: 'Raise the login API timeout to 30 seconds.',
      cwd: '/home/dev/demo-app',
      project: 'demo-app',
      agentVersion: '0.160.0',
      ts: Date.parse('2026-10-20T01:00:05.000Z'),
    });
    expect(parse(12)?.events[0]).toMatchObject({
      role: 'assistant',
      kind: 'message',
      meta: { phase: 'final_answer' },
    });
  });

  it('maps every kind of tool call and its output', () => {
    expect(parse(8)?.events[0]).toMatchObject({
      kind: 'tool_use',
      text: 'shell {"command":["rg","timeout","src"]}',
      meta: { toolName: 'shell', callId: 'call_1' },
    });
    expect(parse(9)?.events[0]).toMatchObject({
      role: 'user',
      kind: 'tool_result',
      text: 'src/api/login.ts:12:  timeout: 10_000,',
    });
    expect(parse(10)?.events[0]?.text).toMatch(/^apply_patch \*\*\* Begin Patch/);
    expect(parse(11)?.events[0]?.text).toBe('Success. Updated src/api/login.ts');
    expect(parse(14)?.events[0]?.text).toBe('shell pnpm test');
    expect(parse(15)?.events[0]?.text).toBe('web_search node fetch timeout');
  });

  it('falls back to the item id, then the line number, when there is no ordinal', () => {
    const item = (o: Record<string, unknown>) =>
      JSON.stringify({
        timestamp: '2026-10-20T01:00:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
          ...o,
        },
      });
    expect(parseCodexLine(item({ id: 'msg_x' }), ctx(7), info)?.events[0]?.id).toBe(
      `${SESSION}:msg_x`,
    );
    expect(parseCodexLine(item({}), ctx(7), info)?.events[0]?.id).toBe(`${SESSION}:L7`);
  });

  it('reads the session id from the file name', () => {
    expect(codexSessionIdFromPath(REL)).toBe(SESSION);
    expect(
      codexSessionIdFromPath(`archived_sessions/rollout-x-${SESSION.toUpperCase()}.jsonl.zst`),
    ).toBe(SESSION);
    expect(codexSessionIdFromPath('sessions/notes.jsonl')).toBeNull();
  });
});

describe('codex adapter', () => {
  let codexHome: string;
  let originHome: string;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codex-'));
    originHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    fs.cpSync(fixtures, codexHome, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(originHome, { recursive: true, force: true });
  });

  it('ingests rollouts, including zstd-compressed archives', async () => {
    const archived = path.join(codexHome, 'archived_sessions');
    fs.mkdirSync(archived);
    const other = '0199f0a2-0000-7000-8000-000000000001';
    const otherLines = [
      lines[0]!.replaceAll(SESSION, other).replace('/home/dev/demo-app', '/home/dev/billing'),
      JSON.stringify({
        timestamp: '2026-10-19T08:00:00Z',
        ordinal: 1,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Archive me.' }],
        },
      }),
    ];
    fs.writeFileSync(
      path.join(archived, `rollout-2026-10-19T08-00-00-${other}.jsonl.zst`),
      zlib.zstdCompressSync(Buffer.from(`${otherLines.join('\n')}\n`)),
    );
    fs.writeFileSync(path.join(archived, 'notes.txt'), 'not a rollout');

    const db = openMemoryDatabase();
    const adapter = createCodexAdapter({ home: codexHome });
    const files = await adapter.discover();
    expect(files.map((f) => [f.relPath, f.compression])).toEqual([
      [`archived_sessions/rollout-2026-10-19T08-00-00-${other}.jsonl.zst`, 'zstd'],
      [REL, undefined],
    ]);

    const r = await syncSource({ db, home: originHome }, adapter);
    expect(r).toMatchObject({ source: 'codex', filesChanged: 2, parseErrors: 0, eventsAdded: 10 });
    expect(adapter.version()).toBe('0.160.0');

    const events = listEvents(db, { sessionId: SESSION });
    expect(events.map((e) => e.kind)).toEqual([
      'meta',
      'message',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'message',
      'tool_use',
      'tool_use',
    ]);
    expect(events[1]?.id).toBe(`codex:${SESSION}:o5`);

    const [archivedEvent] = listEvents(db, { sessionId: other });
    expect(archivedEvent).toMatchObject({ text: 'Archive me.', project: 'billing' });
    const loc = rawLocator(db, originHome, archivedEvent!)!;
    expect(JSON.parse(readRawLine(db, originHome, loc)!)).toMatchObject({ ordinal: 1 });

    expect(
      listSessions(db)
        .map((s) => s.project)
        .sort(),
    ).toEqual(['billing', 'demo-app']);
    const again = await syncSource({ db, home: originHome }, adapter);
    expect(again).toMatchObject({ filesChanged: 0, eventsAdded: 0 });
    db.close();
  });

  it('knows the session cwd for lines appended after the first sync', async () => {
    const db = openMemoryDatabase();
    const file = path.join(codexHome, REL);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${lines.slice(0, 6).join('\n')}\n`);
    await syncSource({ db, home: originHome }, createCodexAdapter({ home: codexHome }));
    fs.writeFileSync(file, original);
    // A fresh adapter, as in a new process: the session_meta line is not part of this sync.
    await syncSource({ db, home: originHome }, createCodexAdapter({ home: codexHome }));
    const last = listEvents(db, { sessionId: SESSION }).at(-1);
    expect(last).toMatchObject({ kind: 'tool_use', project: 'demo-app', agentVersion: '0.160.0' });
    db.close();
  });

  it('knows the session cwd on a hub, from the mirror, after a restart', () => {
    // A hub has only the mirror, stored compressed: a fresh adapter (a restarted hub) reads the
    // session_meta line of earlier pushes through readLine, not from a file.
    const db = openMemoryDatabase();
    const push = (text: string, offset: number) =>
      appendRemote(
        { db, home: originHome, frameBytes: 64 },
        createCodexAdapter({ home: codexHome }),
        {
          device: 'laptop',
          source: 'codex',
          path: `/home/me/.codex/${REL}`,
          relPath: REL,
          generation: 1,
          offset,
          data: Buffer.from(text),
        },
      );
    const head = `${lines.slice(0, 6).join('\n')}\n`;
    expect(push(head, 0)).toMatchObject({ ok: true });
    expect(push(`${lines.slice(6).join('\n')}\n`, Buffer.byteLength(head))).toMatchObject({
      ok: true,
    });
    const last = listEvents(db, { sessionId: SESSION }).at(-1);
    expect(last).toMatchObject({ kind: 'tool_use', project: 'demo-app', agentVersion: '0.160.0' });
    db.close();
  });

  it('detects compression by magic bytes, not by file name', () => {
    // A rollout named `.jsonl.zst` may hold plain JSONL, and a compressed one may lack the suffix.
    const content = `${lines.join('\n')}\n`;
    const plainZst = path.join(codexHome, `rollout-2026-10-20T09-00-00-${SESSION}.jsonl.zst`);
    const realZst = path.join(codexHome, 'other', `rollout-2026-10-20T09-00-00-${SESSION}.jsonl`);
    fs.writeFileSync(plainZst, content);
    fs.mkdirSync(path.dirname(realZst));
    fs.writeFileSync(realZst, zlib.zstdCompressSync(Buffer.from(content)));
    for (const absPath of [plainZst, realZst]) {
      // A fresh adapter has not seen the session_meta line, so it must read the file's head.
      const parsed = createCodexAdapter({ home: codexHome }).parseLine(lines[5]!, {
        absPath,
        relPath: path.basename(absPath),
        lineNo: 6,
        fileMtimeMs: 0,
      });
      expect(parsed?.events[0]).toMatchObject({ project: 'demo-app', agentVersion: '0.160.0' });
    }
  });
});
