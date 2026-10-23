import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { CURSOR_SETTLE_MS, createCursorAdapter, cursorTimestamp } from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/cursor/', import.meta.url));
const TRANSCRIPT = '7c1e2a90-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const REL = `projects/home-dev-demo-app/agent-transcripts/${TRANSCRIPT}/${TRANSCRIPT}.jsonl`;
const CONVERSATION = '3f2e1d0c-9b8a-4766-8554-433221100fed';
const T0 = Date.parse('2026-10-20T01:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('cursorTimestamp', () => {
  it('reads the time a user message embeds, in its offset', () => {
    const at = (s: string) => cursorTimestamp(`<timestamp>${s}</timestamp>`);
    expect(at('Saturday, Sep 20, 2026, 10:12 AM (UTC+8)')).toBe(Date.UTC(2026, 8, 20, 2, 12));
    expect(at('Sunday, Sep 21, 2026, 12:05 AM (UTC+0)')).toBe(Date.UTC(2026, 8, 21, 0, 5));
    expect(at('Sunday, Sep 21, 2026, 12:30 PM (UTC-5:30)')).toBe(Date.UTC(2026, 8, 21, 18, 0));
    expect(at('yesterday')).toBeNull();
  });
});

/** An editor database with a conversation of four shown messages and a hidden copy of one. */
function createEditorDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
    'secret://cursorAuth',
    'must-never-be-read',
  );
  return db;
}

function bubble(db: DatabaseSync, id: string, value: Record<string, unknown>): void {
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
    `bubbleId:${CONVERSATION}:${id}`,
    JSON.stringify({ _v: 3, bubbleId: id, ...value }),
  );
}

function conversation(
  db: DatabaseSync,
  shown: string[],
  extra: Record<string, unknown> = {},
): void {
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
    `composerData:${CONVERSATION}`,
    JSON.stringify({
      _v: 18,
      composerId: CONVERSATION,
      name: 'Upload retry',
      createdAt: T0,
      lastUpdatedAt: T0 + 9000,
      status: 'completed',
      generatingBubbleIds: [],
      workspaceIdentifier: { id: 'w1', uri: { fsPath: '/home/dev/demo-app', scheme: 'file' } },
      fullConversationHeadersOnly: shown.map((bubbleId) => ({ bubbleId, type: 2 })),
      ...extra,
    }),
  );
}

function seed(db: DatabaseSync): void {
  bubble(db, 'b1', {
    type: 1,
    text: 'Add a retry to the upload client.',
    createdAt: iso(T0 + 1000),
  });
  bubble(db, 'b2', { type: 2, text: "I'll read it first.", createdAt: iso(T0 + 2000) });
  bubble(db, 'b3', {
    type: 2,
    text: '',
    createdAt: iso(T0 + 3000),
    toolFormerData: {
      name: 'read_file_v2',
      params: '{"targetFile":"src/upload.ts"}',
      result: '{"contents":"export async function upload() {}"}',
      status: 'completed',
      toolCallId: 'tool_1',
    },
  });
  bubble(db, 'b4', {
    type: 2,
    createdAt: iso(T0 + 4000),
    toolFormerData: {
      name: 'run_terminal_command_v2',
      params: '{"command":"pnpm test"}',
      status: 'error',
      error: 'exit 1',
      toolCallId: 'tool_2',
    },
  });
  // A copy the editor keeps outside the conversation it shows.
  bubble(db, 'b2-copy', { type: 2, text: "I'll read it first.", createdAt: iso(T0 + 2500) });
  conversation(db, ['b1', 'b2', 'b3', 'b4']);
}

describe('cursor adapter', () => {
  let home: string;
  let userDir: string;
  let originHome: string;
  let editor: DatabaseSync;
  let now: number;
  const adapter = () => createCursorAdapter({ home, userDir, now: () => now, keepOpenMs: 0 });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cursor-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cursor-user-'));
    originHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    fs.cpSync(fixtures, home, { recursive: true });
    editor = createEditorDb(path.join(userDir, 'globalStorage', 'state.vscdb'));
    now = T0 + 60_000;
  });
  afterEach(() => {
    editor.close();
    for (const d of [home, userDir, originHome]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('archives CLI transcripts, timing replies by the prompt before them', async () => {
    const db = openMemoryDatabase();
    const a = adapter();
    expect((await a.discover()).map((f) => f.relPath)).toEqual([REL]);
    expect(await syncSource({ db, home: originHome }, a)).toMatchObject({
      filesChanged: 1,
      parseErrors: 0,
      eventsAdded: 6,
    });
    const events = listEvents(db, { sessionId: TRANSCRIPT });
    const prompt = Date.UTC(2026, 8, 20, 2, 12);
    expect(events.map((e) => [e.kind, e.text, e.ts])).toEqual([
      ['message', 'Add a retry to the upload client.', prompt],
      ['message', "I'll read the upload client first.", prompt],
      ['tool_use', 'Read {"path":"src/upload.ts"}', prompt],
      ['tool_use', expect.stringMatching(/^StrReplace \{"path":"src\/upload.ts"/), prompt],
      ['message', 'Now run the tests.', Date.UTC(2026, 8, 20, 4, 30)],
      ['message', 'All 42 tests pass.', Date.UTC(2026, 8, 20, 4, 30)],
    ]);
    expect(events[0]).toMatchObject({ project: 'home-dev-demo-app', cwd: null });
    expect(events[0]?.id).toMatch(new RegExp(`^cursor:${TRANSCRIPT}:L1-[0-9a-f]{8}$`));
    expect(events[2]?.id).toBe(`${events[1]?.id}#1`);
    db.close();
  });

  it('times a reply from the mirror when its prompt was ingested before', () => {
    // A hub, or a new process: the prompt is only in the mirror, read through readLine.
    const lines = fs.readFileSync(path.join(home, REL), 'utf8').trim().split('\n');
    const parsed = adapter().parseLine(lines[5]!, {
      absPath: path.join(home, REL),
      relPath: REL,
      lineNo: 6,
      fileMtimeMs: 0,
      readLine: (n) => lines[n - 1] ?? null,
    });
    expect(parsed?.events[0]?.ts).toBe(Date.UTC(2026, 8, 20, 4, 30));
  });

  it('archives the conversations the editor shows, and only those', async () => {
    seed(editor);
    const db = openMemoryDatabase();
    const a = adapter();
    const files = await a.discover();
    expect(files.map((f) => f.relPath)).toEqual([`editor/${CONVERSATION}.jsonl`, REL]);
    await syncSource({ db, home: originHome }, a);

    const events = listEvents(db, { sessionId: CONVERSATION });
    expect(events.map((e) => [e.id, e.role, e.kind, e.text])).toEqual([
      [`cursor:${CONVERSATION}:b1`, 'user', 'message', 'Add a retry to the upload client.'],
      [`cursor:${CONVERSATION}:b2`, 'assistant', 'message', "I'll read it first."],
      [
        `cursor:${CONVERSATION}:b3#1`,
        'assistant',
        'tool_use',
        'read_file_v2 {"targetFile":"src/upload.ts"}',
      ],
      [
        `cursor:${CONVERSATION}:b3#2`,
        'user',
        'tool_result',
        '{"contents":"export async function upload() {}"}',
      ],
      [
        `cursor:${CONVERSATION}:b4#1`,
        'assistant',
        'tool_use',
        'run_terminal_command_v2 {"command":"pnpm test"}',
      ],
      [`cursor:${CONVERSATION}:b4#2`, 'user', 'tool_result', 'exit 1'],
    ]);
    expect(events[0]).toMatchObject({
      ts: T0 + 1000,
      cwd: '/home/dev/demo-app',
      project: 'demo-app',
    });
    expect(events[5]?.meta).toEqual({ callId: 'tool_2', status: 'error' });
    expect(listSessions(db).find((s) => s.sessionId === CONVERSATION)?.title).toBe('Upload retry');
    const raw = JSON.parse(readRawLine(db, originHome, rawLocator(db, originHome, events[0]!)!)!);
    expect(raw).toMatchObject({
      key: `bubbleId:${CONVERSATION}:b1`,
      conversation: { name: 'Upload retry' },
    });

    expect(await syncSource({ db, home: originHome }, a)).toMatchObject({ filesChanged: 0 });
    db.close();
  });

  it('keeps the editor record of a conversation that also has a transcript', async () => {
    seed(editor);
    const dup = path.join(home, 'projects', 'home-dev-demo-app', 'agent-transcripts', CONVERSATION);
    fs.mkdirSync(dup);
    fs.copyFileSync(path.join(home, REL), path.join(dup, `${CONVERSATION}.jsonl`));
    const files = await adapter().discover();
    expect(files.map((f) => f.relPath)).toEqual([`editor/${CONVERSATION}.jsonl`, REL]);
  });

  it('waits for a message being generated, unless the conversation has gone quiet', async () => {
    bubble(editor, 'b1', { type: 1, text: 'Hello?', createdAt: iso(T0 + 1000) });
    bubble(editor, 'b2', { type: 2, text: 'Hel', createdAt: iso(T0 + 2000) });
    conversation(editor, ['b1', 'b2'], { status: 'generating', generatingBubbleIds: ['b2'] });
    const db = openMemoryDatabase();
    await syncSource({ db, home: originHome }, adapter());
    expect(listEvents(db, { sessionId: CONVERSATION }).map((e) => e.text)).toEqual(['Hello?']);

    now = T0 + 9000 + CURSOR_SETTLE_MS + 1;
    await syncSource({ db, home: originHome }, adapter());
    expect(listEvents(db, { sessionId: CONVERSATION }).map((e) => e.text)).toEqual([
      'Hello?',
      'Hel',
    ]);
    db.close();
  });

  it('gives a hub the same events from the pushed mirror', async () => {
    seed(editor);
    const device = openMemoryDatabase();
    await syncSource({ db: device, home: originHome }, adapter());
    const [first] = listEvents(device, { sessionId: CONVERSATION });
    const loc = rawLocator(device, originHome, first!)!;
    const lines = [1, 2, 3, 4].map((line) => readRawLine(device, originHome, { ...loc, line })!);
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
    try {
      const hub = openMemoryDatabase();
      expect(
        appendRemote(
          { db: hub, home: hubHome },
          createCursorAdapter({ home: hubHome, userDir: hubHome }),
          {
            device: 'laptop',
            source: 'cursor',
            path: `/home/me/.config/Cursor/User/globalStorage/state.vscdb#${CONVERSATION}`,
            relPath: `editor/${CONVERSATION}.jsonl`,
            generation: 1,
            offset: 0,
            data: Buffer.from(`${lines.join('\n')}\n`),
          },
        ),
      ).toMatchObject({ ok: true });
      const strip = (e: {
        id: string;
        kind: string;
        text: string;
        ts: number;
        cwd: string | null;
      }) => [e.id, e.kind, e.text, e.ts, e.cwd];
      expect(listEvents(hub, { sessionId: CONVERSATION }).map(strip)).toEqual(
        listEvents(device, { sessionId: CONVERSATION }).map(strip),
      );
      hub.close();
    } finally {
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
    device.close();
  });
});
