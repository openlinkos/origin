import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getEvent,
  getSession,
  listEvents,
  openMemoryDatabase,
  rawLocator,
  readRawLine,
  syncFile,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLinesAdapter, isLinesSourceId, linesSources, parseEventLine } from '../src/index.js';

/** A synthetic event line, with the required fields filled in. */
const event = (fields: Record<string, unknown> = {}) => ({
  id: 'n-1',
  session: 'standup-2026-11-02',
  time: '2026-11-02T09:30:00Z',
  role: 'user',
  kind: 'message',
  text: 'Ship the retry fix before the demo.',
  ...fields,
});
const line = (fields: Record<string, unknown> = {}) => JSON.stringify(event(fields));
const without = (name: string) => {
  const e: Record<string, unknown> = event();
  delete e[name];
  return JSON.stringify(e);
};
const T = Date.parse('2026-11-02T09:30:00Z');

describe('parseEventLine', () => {
  it('maps a line to one event, its id and session as written', () => {
    expect(parseEventLine(line())).toEqual({
      events: [
        {
          id: 'n-1',
          sessionId: 'standup-2026-11-02',
          parentId: null,
          ts: T,
          project: null,
          cwd: null,
          gitBranch: null,
          role: 'user',
          kind: 'message',
          text: 'Ship the retry fix before the demo.',
          meta: null,
        },
      ],
    });
  });

  it('keeps the optional fields: project, directory, branch, parent, and meta', () => {
    const parsed = parseEventLine(
      line({
        id: 'n-2',
        role: 'assistant',
        kind: 'tool_result',
        text: '3 passed',
        project: 'demo-app',
        cwd: '/home/dev/demo-app',
        branch: 'retry-fix',
        parent: 'n-1',
        meta: { callId: 'c1', channel: 'ops' },
        extra: 'fields Origin does not know are left in the mirror',
      }),
    );
    expect(parsed.events[0]).toMatchObject({
      id: 'n-2',
      parentId: 'n-1',
      project: 'demo-app',
      cwd: '/home/dev/demo-app',
      gitBranch: 'retry-fix',
      role: 'assistant',
      kind: 'tool_result',
      meta: { callId: 'c1', channel: 'ops' },
    });
    // Without a project, the directory's last segment names it, as for every agent.
    expect(parseEventLine(line({ cwd: 'C:\\dev\\demo-app' })).events[0]?.project).toBe('demo-app');
    // null and empty strings are as good as absent.
    expect(
      parseEventLine(line({ project: null, cwd: '', parent: null, meta: null })).events[0],
    ).toMatchObject({ project: null, cwd: null, parentId: null, meta: null });
  });

  it('reads the time as ISO 8601 with an offset, or as epoch milliseconds', () => {
    const ts = (time: unknown) => parseEventLine(line({ time })).events[0]?.ts;
    expect(ts('2026-11-02T09:30:00Z')).toBe(T);
    expect(ts('2026-11-02T17:30:00+08:00')).toBe(T);
    expect(ts('2026-11-02T09:30:00.250Z')).toBe(T + 250);
    expect(ts(T)).toBe(T);
    expect(ts(T + 0.4)).toBe(T);
    for (const time of ['2026-11-02T09:30:00', '2026-11-02', 'yesterday', '', null, true, 1e20]) {
      expect(() => parseEventLine(line({ time })), String(time)).toThrow(/"time"/);
    }
  });

  it('refuses a line without each required field, or with one of the wrong kind', () => {
    for (const name of ['id', 'session', 'time', 'role', 'kind', 'text']) {
      expect(() => parseEventLine(without(name)), name).toThrow(`"${name}"`);
    }
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ id: 7 }, '"id"'],
      [{ id: '' }, '"id"'],
      [{ id: 'x'.repeat(201) }, '"id"'],
      [{ id: 'a\nb' }, '"id"'],
      [{ session: '' }, '"session"'],
      [{ session: 's'.repeat(201) }, '"session"'],
      [{ role: 'tool' }, '"role"'],
      [{ kind: 'note' }, '"kind"'],
      [{ text: null }, '"text"'],
      [{ project: 3 }, '"project"'],
      [{ cwd: ['/'] }, '"cwd"'],
      [{ branch: {} }, '"branch"'],
      [{ parent: '' }, '"parent"'],
      [{ meta: [1] }, '"meta"'],
      [{ meta: 'x' }, '"meta"'],
      [{ title: 5 }, '"title"'],
      [{ title: 'T', title_by: 'me' }, '"title_by"'],
    ];
    for (const [fields, message] of refused) {
      expect(() => parseEventLine(line(fields)), JSON.stringify(fields)).toThrow(message);
    }
    expect(parseEventLine(line({ id: 'x'.repeat(200) })).events[0]?.id).toHaveLength(200);
    expect(parseEventLine(line({ text: '' })).events[0]?.text).toBe('');
  });

  it('refuses the memory kind, which belongs to the memory files agents keep', () => {
    expect(() => parseEventLine(line({ kind: 'memory' }))).toThrow(/reserved/);
  });

  it('refuses what is not a JSON object', () => {
    for (const text of ['not json', '[1,2]', 'null', '"a line"', '42']) {
      expect(() => parseEventLine(text), text).toThrow(/JSON/);
    }
  });

  it('carries the title a line gives its session, and whether the person gave it', () => {
    const generated = parseEventLine(line({ title: '  Retry fix  ' }));
    expect(generated).toMatchObject({ sessionTitle: 'Retry fix', sessionId: 'standup-2026-11-02' });
    expect(generated.manualTitle).toBeUndefined();
    expect(parseEventLine(line({ title: 'Retry fix', title_by: 'agent' })).manualTitle).toBe(
      undefined,
    );
    expect(parseEventLine(line({ title: 'Retry fix', title_by: 'user' })).manualTitle).toBe(true);
    // A blank title is none.
    expect(parseEventLine(line({ title: '   ' })).sessionTitle).toBeUndefined();
  });
});

describe('source names', () => {
  it('takes lowercase names of 2 to 32 characters that are neither built in nor reserved', () => {
    for (const name of ['notes', 'chat-ops', 'a1', `n${'x'.repeat(31)}`]) {
      expect(isLinesSourceId(name), name).toBe(true);
    }
    for (const name of [
      'n',
      `n${'x'.repeat(32)}`,
      'Notes',
      '1notes',
      '-notes',
      'my_notes',
      'my.notes',
      'claude-code',
      'codex',
      'cursor',
      'grok',
      'zcode',
      'origin',
      'hub',
      'local',
      'all',
      'devices',
    ]) {
      expect(isLinesSourceId(name), name).toBe(false);
    }
    expect(() => createLinesAdapter({ id: 'codex', dir: '.' })).toThrow(/cannot name a source/);
  });
});

describe('lines adapter', () => {
  let tmp: string;
  let dir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-lines-'));
    dir = path.join(tmp, 'sources', 'notes');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (rel: string, lines: string[], mtimeMs?: number) => {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };

  it('discovers the .jsonl files below its directory, oldest first, skipping hidden ones', async () => {
    write('2026/11/02.jsonl', [line()], T);
    write('2026/11/01.jsonl', [line()], T - 86_400_000);
    write('inbox.jsonl', [line()], T + 60_000);
    write('notes.txt', ['not event lines']);
    write('.drafts/a.jsonl', [line()]);
    write('2026/.partial.jsonl', [line()]);
    const adapter = createLinesAdapter({ id: 'notes', dir });
    expect((await adapter.discover()).map((f) => f.relPath)).toEqual([
      '2026/11/01.jsonl',
      '2026/11/02.jsonl',
      'inbox.jsonl',
    ]);
    expect(
      await createLinesAdapter({ id: 'notes', dir: path.join(tmp, 'none') }).discover(),
    ).toEqual([]);
  });

  it('locates the files discover() lists, and nothing else', async () => {
    write('2026/11/02.jsonl', [line()]);
    write('inbox.jsonl', [line()]);
    const adapter = createLinesAdapter({ id: 'notes', dir });
    const files = await adapter.discover();
    expect(files).toHaveLength(2);
    for (const f of files) expect(adapter.locate?.(f.absPath)).toEqual(f);
    // Pure: a file not written yet is located all the same.
    expect(adapter.locate?.(path.join(dir, 'later', 'x.jsonl'))).toEqual({
      absPath: path.join(dir, 'later', 'x.jsonl'),
      relPath: 'later/x.jsonl',
    });
    for (const p of [
      dir,
      path.join(dir, 'notes.txt'),
      path.join(dir, '.drafts', 'a.jsonl'),
      path.join(dir, '2026', '.partial.jsonl'),
      path.join(tmp, 'sources', 'other', 'a.jsonl'),
      path.join(tmp, 'a.jsonl'),
    ]) {
      expect(adapter.locate?.(p), p).toBeNull();
    }
  });

  it('records the version a VERSION file names, if any', () => {
    const adapter = createLinesAdapter({ id: 'notes', dir });
    expect(adapter.version()).toBeNull();
    fs.writeFileSync(path.join(dir, 'VERSION'), 'notes-pipeline 1.4.2\n');
    expect(adapter.version()).toBe('notes-pipeline 1.4.2');
    fs.writeFileSync(path.join(dir, 'VERSION'), '\n');
    expect(adapter.version()).toBeNull();
  });

  it('ingests sessions with titles, branches, and provenance, counting bad lines and duplicates', async () => {
    const file = write('2026/11/02.jsonl', [
      line({ title: 'Morning standup', title_by: 'user', project: 'demo-app' }),
      line({ id: 'n-2', role: 'assistant', text: 'Noted.', parent: 'n-1', title: 'Generated' }),
      '{"id":"n-3","session":"standup-2026-11-02","role":"user","kind":"message","text":"no time"}',
      'not json',
      line({ id: 'n-4', session: 'retro', branch: 'retry-fix', version: 'ignored' }),
      line(), // the same id again
    ]);
    fs.writeFileSync(path.join(dir, 'VERSION'), 'notes-pipeline 1.4.2\n');
    const db = openMemoryDatabase();
    const home = path.join(tmp, 'home');
    const adapter = createLinesAdapter({ id: 'notes', dir });
    const r = await syncSource({ db, home }, adapter);
    expect(r).toMatchObject({ source: 'notes', linesRead: 6, eventsAdded: 3, parseErrors: 2 });

    // The title the person gave stays, though a generated one follows it.
    expect(getSession(db, 'notes', 'standup-2026-11-02')).toMatchObject({
      title: 'Morning standup',
      project: 'demo-app',
      eventCount: 2,
    });
    expect(getEvent(db, 'notes:n-2')).toMatchObject({
      parentId: 'n-1',
      agentVersion: 'notes-pipeline 1.4.2',
      rawLine: 2,
    });
    expect(listEvents(db, { sessionId: 'retro' })[0]).toMatchObject({ gitBranch: 'retry-fix' });
    // Every event points to its line in the mirror (invariant 1).
    const locator = rawLocator(
      db,
      home,
      getEvent(db, 'notes:n-4') as NonNullable<ReturnType<typeof getEvent>>,
    );
    expect(locator && readRawLine(db, home, locator)).toBe(
      line({ id: 'n-4', session: 'retro', branch: 'retry-fix', version: 'ignored' }),
    );

    // Idempotent: nothing new, nothing added; appended lines are read from the cursor.
    expect((await syncSource({ db, home }, adapter)).eventsAdded).toBe(0);
    fs.appendFileSync(file, `${line({ id: 'n-5', text: 'One more thing.' })}\n`);
    const again = await syncFile({ db, home }, adapter, file);
    expect(again).toMatchObject({ filesSeen: 1, linesRead: 1, eventsAdded: 1 });
    expect(getEvent(db, 'notes:n-5')?.rawLine).toBe(7);
    // A path outside the source is ingested as nothing.
    expect((await syncFile({ db, home }, adapter, path.join(tmp, 'x.jsonl'))).filesSeen).toBe(0);
  });
});

describe('linesSources', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sources-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads one source per directory with a valid name, and names the others', () => {
    for (const name of ['notes', 'chat-ops', 'Bad', 'codex', 'all', 'x', '.git']) {
      fs.mkdirSync(path.join(tmp, name));
    }
    fs.writeFileSync(path.join(tmp, 'README.md'), 'not a source');
    const { adapters, ignored } = linesSources(tmp);
    expect(adapters.map((a) => a.id)).toEqual(['chat-ops', 'notes']);
    expect(adapters.map((a) => a.displayName)).toEqual(['chat-ops', 'notes']);
    expect(ignored).toEqual(['Bad', 'all', 'codex', 'x']);
    expect(linesSources(path.join(tmp, 'none'))).toEqual({ adapters: [], ignored: [] });
  });
});
