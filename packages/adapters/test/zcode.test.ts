import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { createZCodeAdapter, parseZCodeLine, ZCODE_SETTLE_MS } from '../src/index.js';

const SESSION = 'ses_0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d';
const T0 = Date.parse('2026-10-20T01:00:00Z');

/** A ZCode database with the tables and columns the adapter reads, as ZCode 0.16 has them. */
function createZCodeDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session (id text primary key, project_id text not null, parent_id text,
      directory text not null, title text not null, version text not null,
      task_type text not null default 'interactive', time_created integer not null,
      time_updated integer not null);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null,
      sequence integer);
  `);
  return db;
}

class Conversation {
  private seq = 0;
  constructor(private readonly db: DatabaseSync) {
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
       VALUES (?, 'prj_1', '/home/dev/demo-app', 'Upload retry', '0.16.9', ?, ?)`,
    ).run(SESSION, T0, T0);
  }

  /** Add a message and its parts; returns the message id. */
  add(data: Record<string, unknown>, parts: Array<Record<string, unknown>>, at = T0): string {
    const sequence = this.seq++;
    const id = `msg_${sequence}`;
    this.db
      .prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, SESSION, at + sequence * 1000, at + sequence * 1000, JSON.stringify(data), sequence);
    for (const [i, p] of parts.entries()) {
      this.db
        .prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          `prt_${sequence}_${i}`,
          id,
          SESSION,
          at + sequence * 1000,
          at + sequence * 1000,
          JSON.stringify(p),
          i,
        );
    }
    return id;
  }

  update(id: string, data: Record<string, unknown>, at: number): void {
    this.db
      .prepare('UPDATE message SET data = ?, time_updated = ? WHERE id = ?')
      .run(JSON.stringify(data), at, id);
  }
}

const user = () => ({
  role: 'user',
  time: { created: T0 },
  semantics: { kind: 'user_prompt', transcriptVisibility: 'visible' },
});
const reply = (completed: boolean) => ({
  role: 'assistant',
  path: { cwd: '/home/dev/demo-app', root: '/home/dev/demo-app' },
  time: completed ? { created: T0, completed: T0 + 9000 } : { created: T0 },
  semantics: { kind: 'assistant_response', transcriptVisibility: 'visible' },
});

/** The conversation most tests start from: a prompt, a reply with tools, and a hidden reminder. */
function seed(c: Conversation): void {
  c.add(user(), [
    { type: 'text', text: 'Add a retry to the upload client.', time: { start: T0, end: T0 } },
    { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' },
  ]);
  c.add(reply(true), [
    { type: 'step-start' },
    { type: 'reasoning', text: 'Planning the change.', time: { start: T0 + 1100, end: T0 + 1200 } },
    {
      type: 'tool',
      tool: 'Read',
      callID: 'call_1',
      state: {
        status: 'completed',
        input: { file_path: 'src/upload.ts' },
        output: 'export async function upload(file) {}',
        title: 'src/upload.ts',
        time: { start: T0 + 1300, end: T0 + 1400 },
      },
    },
    {
      type: 'tool',
      tool: 'Bash',
      callID: 'call_2',
      state: {
        status: 'error',
        input: { command: 'pnpm test' },
        error: '1 failed, 41 passed',
        time: { start: T0 + 1500, end: T0 + 1600 },
      },
    },
    {
      type: 'text',
      text: 'Added a retry with backoff.',
      time: { start: T0 + 1700, end: T0 + 1800 },
    },
    { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } },
  ]);
  c.add(
    {
      role: 'user',
      time: { created: T0 },
      semantics: { kind: 'todo_reminder', transcriptVisibility: 'hidden' },
    },
    [{ type: 'text', text: 'Remember the todo list.', synthetic: true }],
  );
}

describe('zcode adapter', () => {
  let zcodeHome: string;
  let originHome: string;
  let db: DatabaseSync;
  let conversation: Conversation;
  let now: number;
  const adapter = () => createZCodeAdapter({ home: zcodeHome, now: () => now, keepOpenMs: 0 });

  beforeEach(() => {
    zcodeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-zcode-'));
    originHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    db = createZCodeDb(path.join(zcodeHome, 'cli', 'db', 'db.sqlite'));
    conversation = new Conversation(db);
    now = T0 + 60_000;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(zcodeHome, { recursive: true, force: true });
    fs.rmSync(originHome, { recursive: true, force: true });
  });

  it('writes each settled message out once and maps its parts', async () => {
    seed(conversation);
    const origin = openMemoryDatabase();
    const a = adapter();
    const files = await a.discover();
    expect(files.map((f) => [f.relPath, f.absPath.endsWith(`db.sqlite#${SESSION}`)])).toEqual([
      [`sessions/${SESSION}.jsonl`, true],
    ]);

    const r = await syncSource({ db: origin, home: originHome }, a);
    expect(r).toMatchObject({ source: 'zcode', filesChanged: 1, linesRead: 3, parseErrors: 0 });
    expect(a.version()).toBe('0.16.9');
    const events = listEvents(origin, { sessionId: SESSION });
    expect(events.map((e) => [e.id, e.role, e.kind, e.text])).toEqual([
      [`zcode:${SESSION}:0.0`, 'user', 'message', 'Add a retry to the upload client.'],
      [`zcode:${SESSION}:0.1`, 'user', 'message', '[image]'],
      [`zcode:${SESSION}:1.2`, 'assistant', 'tool_use', 'Read {"file_path":"src/upload.ts"}'],
      [`zcode:${SESSION}:1.2#1`, 'user', 'tool_result', 'export async function upload(file) {}'],
      [`zcode:${SESSION}:1.3`, 'assistant', 'tool_use', 'Bash {"command":"pnpm test"}'],
      [`zcode:${SESSION}:1.3#1`, 'user', 'tool_result', '1 failed, 41 passed'],
      [`zcode:${SESSION}:1.4`, 'assistant', 'message', 'Added a retry with backoff.'],
      [`zcode:${SESSION}:2.0`, 'user', 'meta', 'Remember the todo list.'],
    ]);
    expect(events[0]).toMatchObject({
      ts: T0,
      cwd: '/home/dev/demo-app',
      project: 'demo-app',
      agentVersion: '0.16.9',
    });
    expect(events[2]?.meta).toEqual({ toolName: 'Read', callId: 'call_1' });
    expect(events[5]?.meta).toEqual({ callId: 'call_2', status: 'error' });
    expect(listSessions(origin).map((s) => s.title)).toEqual(['Upload retry']);

    // The mirror holds the rows as stored.
    const raw = JSON.parse(
      readRawLine(origin, originHome, rawLocator(origin, originHome, events[2]!)!)!,
    );
    expect(raw.message).toMatchObject({ id: 'msg_1', sequence: 1 });
    expect(JSON.parse(raw.parts[2].data)).toMatchObject({ tool: 'Read' });

    expect(await syncSource({ db: origin, home: originHome }, a)).toMatchObject({
      filesChanged: 0,
    });
    origin.close();
  });

  it('waits for a reply to finish, and for its session to go quiet if it never does', async () => {
    conversation.add(user(), [{ type: 'text', text: 'Hello?' }]);
    const streaming = conversation.add(reply(false), [{ type: 'text', text: 'Hel' }]);
    const origin = openMemoryDatabase();
    await syncSource({ db: origin, home: originHome }, adapter());
    expect(listEvents(origin, { sessionId: SESSION }).map((e) => e.text)).toEqual(['Hello?']);

    // It completes: written out as it is now.
    db.prepare("UPDATE part SET data = ? WHERE id = 'prt_1_0'").run(
      JSON.stringify({ type: 'text', text: 'Hello! How can I help?' }),
    );
    conversation.update(streaming, reply(true), T0 + 30_000);
    await syncSource({ db: origin, home: originHome }, adapter());
    expect(listEvents(origin, { sessionId: SESSION }).map((e) => e.text)).toEqual([
      'Hello?',
      'Hello! How can I help?',
    ]);

    // A reply left unfinished is written out once it has not changed for an hour.
    conversation.add(reply(false), [{ type: 'text', text: 'Interrupted' }]);
    await syncSource({ db: origin, home: originHome }, adapter());
    expect(listEvents(origin, { sessionId: SESSION })).toHaveLength(2);
    // Quiet means no change to any message of the session, the last at T0 + 30 s.
    now = T0 + 30_000 + ZCODE_SETTLE_MS + 1;
    await syncSource({ db: origin, home: originHome }, adapter());
    expect(listEvents(origin, { sessionId: SESSION }).at(-1)?.text).toBe('Interrupted');
    origin.close();
  });

  it('gives a hub the same events from the pushed mirror', async () => {
    seed(conversation);
    const device = openMemoryDatabase();
    await syncSource({ db: device, home: originHome }, adapter());
    const [event] = listEvents(device, { sessionId: SESSION });
    const loc = rawLocator(device, originHome, event!)!;
    const lines = [1, 2, 3].map((line) => readRawLine(device, originHome, { ...loc, line })!);

    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
    try {
      const hub = openMemoryDatabase();
      expect(
        appendRemote({ db: hub, home: hubHome }, createZCodeAdapter({ home: hubHome }), {
          device: 'laptop',
          source: 'zcode',
          path: `/home/me/.zcode/cli/db/db.sqlite#${SESSION}`,
          relPath: `sessions/${SESSION}.jsonl`,
          generation: 1,
          offset: 0,
          data: Buffer.from(`${lines.join('\n')}\n`),
          agentVersion: '0.16.9',
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

  it('finds nothing without a ZCode database', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-zcode-none-'));
    try {
      expect(await createZCodeAdapter({ home: empty }).discover()).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('parses a line without the database', () => {
    const line = JSON.stringify({
      session: { id: SESSION, directory: '/srv/app', title: '', version: '0.16.9' },
      message: {
        id: 'm',
        sequence: 4,
        time_created: T0,
        time_updated: T0,
        data: JSON.stringify(user()),
      },
      parts: [
        {
          id: 'p',
          sequence: 0,
          time_created: T0 + 5,
          data: JSON.stringify({ type: 'text', text: 'From a hub' }),
        },
      ],
    });
    expect(parseZCodeLine(line)).toEqual({
      events: [
        {
          id: `${SESSION}:4.0`,
          sessionId: SESSION,
          ts: T0 + 5,
          cwd: '/srv/app',
          project: 'app',
          role: 'user',
          kind: 'message',
          text: 'From a hub',
          agentVersion: '0.16.9',
          meta: null,
        },
      ],
      sessionTitle: undefined,
      sessionId: SESSION,
    });
  });
});
