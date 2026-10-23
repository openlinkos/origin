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
  openMemoryDatabase,
  rawLocator,
  readMirror,
  readRawLine,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGrokAdapter,
  grokCwdFromGroup,
  grokSessionIdFromPath,
  parseGrokLine,
  parseGrokTitleLine,
} from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/grok/', import.meta.url));
const SESSION = '01a0f000-0000-7000-8000-000000000001';
const REL = `sessions/%2Fhome%2Fdev%2Fdemo-app/${SESSION}/updates.jsonl`;
const TITLE_REL = `sessions/%2Fhome%2Fdev%2Fdemo-app/${SESSION}/title.jsonl`;
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

  it('ingests the update stream and the title of each session, and nothing else', async () => {
    const db = openMemoryDatabase();
    const adapter = createGrokAdapter({ home: grokHome });
    expect((await adapter.discover()).map((f) => f.relPath)).toEqual([TITLE_REL, REL]);

    const r = await syncSource({ db, home: originHome }, adapter);
    expect(r).toMatchObject({ source: 'grok', filesChanged: 2, parseErrors: 0, eventsAdded: 13 });
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
    expect(listSessions(db).map((s) => [s.sessionId, s.project, s.title])).toEqual([
      [SESSION, 'demo-app', 'Upload retry'],
    ]);

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

describe('grok session titles', () => {
  let grokHome: string;
  let originHome: string;
  const summaryFile = () =>
    path.join(grokHome, 'sessions', '%2Fhome%2Fdev%2Fdemo-app', SESSION, 'summary.json');
  /** Rewrite summary.json in place, as Grok does every turn, with these changes. */
  const rewrite = (changes: Record<string, unknown>) => {
    const summary = JSON.parse(fs.readFileSync(summaryFile(), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(summaryFile(), JSON.stringify({ ...summary, ...changes }));
    // A later modification time, as the next turn would leave.
    const t = new Date(Date.now() + ++turns * 1000);
    fs.utimesSync(summaryFile(), t, t);
  };
  let turns = 0;
  const titleLines = (db: Database) => {
    const raw = db
      .prepare("SELECT id, bytes_ingested AS bytes FROM raw_file WHERE path LIKE '%summary.json'")
      .get() as { id: number; bytes: number };
    return readMirror(db, originHome, raw.id, 0, raw.bytes)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const title = (db: Database) => listSessions(db)[0]?.title;

  beforeEach(() => {
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-grok-'));
    originHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    fs.cpSync(fixtures, grokHome, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(grokHome, { recursive: true, force: true });
    fs.rmSync(originHome, { recursive: true, force: true });
  });

  it('parses a title line: the generated or renamed title, else the summary', () => {
    const at = { absPath: summaryFile(), relPath: TITLE_REL, lineNo: 1, fileMtimeMs: 0 };
    const parse = (o: Record<string, unknown>) => parseGrokTitleLine(JSON.stringify(o), at);
    expect(parse({ generated_title: ' Upload retry ', session_summary: 'x' })).toEqual({
      events: [],
      sessionTitle: 'Upload retry',
      sessionId: SESSION,
    });
    expect(parse({ generated_title: '', session_summary: 'Older clients read this' })).toEqual({
      events: [],
      sessionTitle: 'Older clients read this',
      sessionId: SESSION,
    });
    expect(parse({ generated_title: null, session_summary: '' })).toBeNull();
    expect(parseGrokTitleLine('{"generated_title":"x"}', { ...at, relPath: REL })).toBeNull();
  });

  it('writes a line each time the title changes, and only then', async () => {
    const db = openMemoryDatabase();
    const adapter = createGrokAdapter({ home: grokHome });
    await syncSource({ db, home: originHome }, adapter);
    expect(title(db)).toBe('Upload retry');
    expect(titleLines(db)).toEqual([
      {
        info: { id: SESSION, cwd: '/home/dev/demo-app' },
        generated_title: 'Upload retry',
        session_summary: 'Upload retry',
        updated_at: '2026-10-20T01:00:20Z',
      },
    ]);

    // Another turn: summary.json is rewritten, its title is the same.
    rewrite({ num_messages: 30, updated_at: '2026-10-20T01:05:00Z' });
    await syncSource({ db, home: originHome }, adapter);
    expect(titleLines(db)).toHaveLength(1);

    // Renamed with /rename; then back to automatic titles with /rename --auto, which blanks the
    // title until a new one is generated.
    rewrite({ generated_title: 'Retry with backoff', title_is_manual: true });
    await syncSource({ db, home: originHome }, adapter);
    expect(title(db)).toBe('Retry with backoff');
    rewrite({ generated_title: null, session_summary: '', title_is_manual: false });
    await syncSource({ db, home: originHome }, adapter);
    expect(title(db)).toBe('Retry with backoff');
    rewrite({ generated_title: 'Upload client retries' });
    await syncSource({ db, home: originHome }, adapter);
    expect(title(db)).toBe('Upload client retries');
    expect(titleLines(db).map((l) => [l.generated_title, l.title_is_manual])).toEqual([
      ['Upload retry', undefined],
      ['Retry with backoff', true],
      ['Upload client retries', false],
    ]);

    // Caught mid-write: nothing now, the title once the file is whole again.
    const whole = fs.readFileSync(summaryFile(), 'utf8');
    fs.writeFileSync(summaryFile(), '{"generated_title":"Half');
    const t = new Date(Date.now() + ++turns * 1000);
    fs.utimesSync(summaryFile(), t, t);
    expect(await syncSource({ db, home: originHome }, adapter)).toMatchObject({ parseErrors: 0 });
    expect(titleLines(db)).toHaveLength(3);
    fs.writeFileSync(summaryFile(), whole);
    rewrite({ generated_title: 'Whole again' });
    await syncSource({ db, home: originHome }, adapter);
    expect(title(db)).toBe('Whole again');
    db.close();
  });

  it('gives a hub the same title from the pushed mirror', async () => {
    const device = openMemoryDatabase();
    await syncSource({ db: device, home: originHome }, createGrokAdapter({ home: grokHome }));
    rewrite({ generated_title: 'Retry with backoff', title_is_manual: true });
    await syncSource({ db: device, home: originHome }, createGrokAdapter({ home: grokHome }));
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
    try {
      const hub = openMemoryDatabase();
      const onHub = createGrokAdapter({ home: hubHome });
      for (const f of localRawFiles(device)) {
        expect(
          appendRemote({ db: hub, home: hubHome }, onHub, {
            device: 'laptop',
            source: 'grok',
            path: f.path,
            relPath: f.relPath,
            generation: f.generation,
            offset: 0,
            data: readMirror(device, originHome, f.id, 0, f.bytes),
          }),
        ).toMatchObject({ ok: true, parseErrors: 0 });
      }
      expect(listSessions(hub).map((s) => [s.sessionId, s.title, s.eventCount])).toEqual(
        listSessions(device).map((s) => [s.sessionId, s.title, s.eventCount]),
      );
      expect(title(hub)).toBe('Retry with backoff');
      hub.close();
    } finally {
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
    device.close();
  });
});
