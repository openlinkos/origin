import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Database,
  getEvent,
  importedEntryId,
  listEntries,
  listSessions,
  openDatabase,
  setStoreName,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter, createGrokAdapter, createZCodeAdapter } from '../src/index.js';
import {
  frontMatter,
  type MemoryDir,
  type MemoryLine,
  memoryKind,
  memoryLines,
  parseMemoryLine,
  readFrontMatterMemory,
  readPlainMemory,
} from '../src/memory.js';

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-memory-'));
  db = openDatabase(path.join(tmp, 'origin', 'origin.db'));
  setStoreName(db, 'laptop');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-20T01:00:00Z');

/** Write a file with a given modification time. */
function put(file: string, content: string, mtime = T0): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

const feedback = `---
name: commit-style
description: Commit messages are in English, without attribution trailers
metadata:
  type: feedback
  originSessionId: 2f1e8c47-0000-4000-8000-000000000001
---

Write Conventional Commits in English.

**Why:** the history is public.
`;

describe('memory streams', () => {
  const dirOf = (dir: string): MemoryDir => ({
    dir,
    relPath: 'memory/demo.jsonl',
    files: () => fs.readdirSync(dir).filter((f) => f.endsWith('.md')),
    where: () => ({ project: 'demo-app', cwd: '/home/dev/demo-app' }),
  });
  const parse = (line: string) => JSON.parse(line) as MemoryLine;

  it('writes a line for every new or changed file, oldest first, and one for every deleted file', () => {
    const dir = path.join(tmp, 'memory');
    put(path.join(dir, 'b.md'), 'second', T0 + 1000);
    put(path.join(dir, 'a.md'), 'first', T0);
    const m = dirOf(dir);

    const first = memoryLines(m, null, 1 << 20, T0 + 5000).map(parse);
    expect(first.map((l) => [l.file, l.op, l.at, l.content, l.prev])).toEqual([
      ['a.md', 'write', T0, 'first', null],
      ['b.md', 'write', T0 + 1000, 'second', null],
    ]);
    expect(first[1]?.state).toEqual({
      'a.md': [first[0]?.id, expect.any(String)],
      'b.md': [first[1]?.id, expect.any(String)],
    });
    expect(first[0]).toMatchObject({ project: 'demo-app', cwd: '/home/dev/demo-app' });
    let last = JSON.stringify(first[1]);
    expect(memoryLines(m, last, 1 << 20, T0 + 5000)).toEqual([]);

    put(path.join(dir, 'a.md'), 'first, revised', T0 + 2000);
    const changed = memoryLines(m, last, 1 << 20, T0 + 5000).map(parse);
    expect(changed.map((l) => [l.file, l.op, l.prev])).toEqual([['a.md', 'write', first[0]?.id]]);
    last = JSON.stringify(changed[0]);

    fs.rmSync(path.join(dir, 'b.md'));
    const deleted = memoryLines(m, last, 1 << 20, T0 + 9000).map(parse);
    expect(deleted.map((l) => [l.file, l.op, l.at, l.prev, l.content])).toEqual([
      ['b.md', 'delete', T0 + 9000, first[1]?.id, undefined],
    ]);
    expect(deleted[0]?.state['b.md']).toEqual([deleted[0]?.id, null]);
    last = JSON.stringify(deleted[0]);

    // Back with the content it had: a new version, chained from the deletion.
    put(path.join(dir, 'b.md'), 'second', T0 + 10_000);
    const back = memoryLines(m, last, 1 << 20, T0 + 11_000).map(parse);
    expect(back.map((l) => [l.file, l.op, l.prev])).toEqual([['b.md', 'write', deleted[0]?.id]]);
    expect(back[0]?.id).not.toBe(first[1]?.id);
  });

  it('writes the same ids for the same history, and stops at about maxBytes', () => {
    const one = path.join(tmp, 'one');
    const two = path.join(tmp, 'two');
    for (const dir of [one, two]) {
      put(path.join(dir, 'a.md'), 'alpha', T0);
      put(path.join(dir, 'b.md'), 'beta', T0 + 1);
    }
    const ids = (dir: string) => memoryLines(dirOf(dir), null, 1 << 20, T0).map((l) => parse(l).id);
    expect(ids(one)).toEqual(ids(two));
    expect(memoryLines(dirOf(one), null, 10, T0)).toHaveLength(1);
  });

  it('parses a line into a memory event and the version of the memory it carries', () => {
    const dir = path.join(tmp, 'memory');
    put(path.join(dir, 'commit-style.md'), feedback);
    const [line] = memoryLines(dirOf(dir), null, 1 << 20, T0);
    const ctx = { absPath: dir, relPath: 'memory/demo.jsonl', lineNo: 1, fileMtimeMs: T0 };
    const parsed = parseMemoryLine(line as string, ctx, (_file, content) =>
      readFrontMatterMemory(content),
    );
    const id = `memory:${parse(line as string).id}`;
    expect(parsed.events).toEqual([
      {
        id,
        sessionId: 'memory/demo',
        ts: T0,
        project: 'demo-app',
        cwd: '/home/dev/demo-app',
        role: 'assistant',
        kind: 'memory',
        text: feedback,
        meta: { file: 'commit-style.md', op: 'write' },
      },
    ]);
    expect(parsed.memory).toEqual({
      eventId: id,
      previous: null,
      at: T0,
      entry: {
        kind: 'cognition',
        text: 'Commit messages are in English, without attribution trailers\n\nWrite Conventional Commits in English.\n\n**Why:** the history is public.',
        confidence: 0.9,
        project: 'demo-app',
      },
    });
  });
});

describe('memory files', () => {
  it('reads front matter: top-level keys, one level of nesting, quotes, and CRLF', () => {
    const { data, body } = frontMatter(
      '---\r\nname: "a \\"quoted\\" name"\r\ntype: project\r\nkeywords: ["x", "y"]\r\nmetadata:\r\n  type: user\r\n  note: \'it\'\'s\'\r\n---\r\n\r\nBody.\r\n',
    );
    expect(data).toEqual({
      name: 'a "quoted" name',
      type: 'project',
      keywords: '["x", "y"]',
      metadata: { type: 'user', note: "it's" },
    });
    expect(body).toBe('\nBody.\n');
    expect(frontMatter('# No front matter\n')).toEqual({ data: {}, body: '# No front matter\n' });
  });

  it('maps memory types to kinds, and leaves files without content out', () => {
    expect(
      ['user', 'feedback', 'project', 'reference', 'other', undefined].map(memoryKind),
    ).toEqual(['cognition', 'cognition', 'memory', 'knowledge', 'knowledge', 'knowledge']);
    expect(readFrontMatterMemory('---\ntype: project\n---\nShipped.')).toEqual({
      kind: 'memory',
      text: 'Shipped.',
      confidence: 0.9,
    });
    expect(readFrontMatterMemory('---\nname: empty\n---\n\n')).toBeNull();
    const template =
      '# Global Memory\n\n> Managed by the agent.\n\n## Preferences\n\n<!-- Add preferences here -->\n';
    expect(readPlainMemory(template, 'knowledge')).toBeNull();
    expect(readPlainMemory(`${template}- Prefers pnpm.\n`, 'knowledge')).toEqual({
      kind: 'knowledge',
      text: '# Global Memory\n\n> Managed by the agent.\n\n## Preferences\n\n- Prefers pnpm.',
      confidence: 0.9,
    });
  });
});

describe('agents', () => {
  it("imports Claude Code's memory directories, with their project from the sessions", async () => {
    const projects = path.join(tmp, 'projects');
    const slug = path.join(projects, '-home-dev-demo-app');
    put(
      path.join(slug, '2f1e8c47-0000-4000-8000-000000000001.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: '7d0c4a1e-0000-4000-8000-000000000001',
        sessionId: '2f1e8c47-0000-4000-8000-000000000001',
        timestamp: '2026-10-20T01:00:00.000Z',
        cwd: '/home/dev/demo-app',
        message: { role: 'user', content: 'Set up the release workflow.' },
      })}\n`,
    );
    put(path.join(slug, 'memory', 'MEMORY.md'), '- [Commit style](commit-style.md)\n');
    put(path.join(slug, 'memory', 'commit-style.md'), feedback, T0);
    put(
      path.join(slug, 'memory', 'release-plan.md'),
      '---\nname: release-plan\ndescription: Releases are tagged from master\nmetadata:\n  type: project\n---\n\nTag v<version> after CI passes.\n',
      T0 + 1000,
    );
    const adapter = createClaudeCodeAdapter({ projectsDir: projects });
    await syncSource({ db, home: path.join(tmp, 'origin') }, adapter);

    const entries = listEntries(db);
    expect(entries.map((e) => [e.kind, e.project, e.author, e.imported])).toEqual([
      ['memory', 'demo-app', 'claude-code@laptop', true],
      ['cognition', 'demo-app', 'claude-code@laptop', true],
    ]);
    // The index is not a memory, and memories are counted in no session.
    expect(listSessions(db).map((s) => s.sessionId)).toEqual([
      '2f1e8c47-0000-4000-8000-000000000001',
    ]);

    fs.rmSync(path.join(slug, 'memory', 'release-plan.md'));
    await syncSource({ db, home: path.join(tmp, 'origin') }, adapter);
    expect(listEntries(db).map((e) => e.kind)).toEqual(['cognition']);
    expect(listEntries(db, { includeEnded: true }).map((e) => e.kind)).toEqual([
      'memory',
      'cognition',
    ]);
  });

  it("imports ZCode's memory directories, with their working directory from the hash in their name", async () => {
    const home = path.join(tmp, 'zcode');
    fs.mkdirSync(path.join(home, 'cli', 'db'), { recursive: true });
    const zdb = new DatabaseSync(path.join(home, 'cli', 'db', 'db.sqlite'));
    zdb.exec(`
      CREATE TABLE session (id text primary key, directory text not null, version text not null,
        time_updated integer not null);
      CREATE TABLE message (id text primary key, session_id text not null, sequence integer,
        time_updated integer not null);
      INSERT INTO session VALUES ('ses_1', 'D:\\Work\\Demo-App', '0.16.9', 0);
    `);
    zdb.close();
    const hash = createHash('sha256').update('d:\\work\\demo-app').digest('hex').slice(0, 16);
    const projects = path.join(home, 'cli', 'memories', 'projects');
    put(path.join(projects, `Demo-App-${hash}`, 'memory', 'commit-style.md'), feedback);
    put(
      path.join(projects, `scratch-${'0'.repeat(16)}`, 'memory', 'note.md'),
      '---\nname: note\nmetadata:\n  type: reference\n---\n\nThe staging bucket is origin-test.\n',
    );
    await syncSource(
      { db, home: path.join(tmp, 'origin') },
      createZCodeAdapter({ home, keepOpenMs: 0 }),
    );

    const entries = listEntries(db);
    expect(entries.map((e) => [e.kind, e.project]).sort()).toEqual([
      ['cognition', 'Demo-App'],
      ['knowledge', 'scratch'],
    ]);
    const cognition = entries.find((e) => e.kind === 'cognition');
    const [event] = db
      .prepare('SELECT event_id FROM entry_source WHERE entry_id = ?')
      .all(cognition?.id as string) as Array<{ event_id: string }>;
    expect(getEvent(db, event?.event_id as string)).toMatchObject({
      cwd: 'D:\\Work\\Demo-App',
      kind: 'memory',
    });
  });

  it("imports Grok Build's topics and pending observations, but not its indexes or templates", async () => {
    const home = path.join(tmp, 'grok');
    const session = '01a0c4ce-6fcb-7cd2-80ed-000000000001';
    fs.mkdirSync(path.join(home, 'sessions', encodeURIComponent('/home/dev/demo-app'), session), {
      recursive: true,
    });
    const ws = path.join(home, 'memory-v2', 'workspaces', 'demo-app-1a2b3c4d');
    put(
      path.join(ws, 'MEMORY.md'),
      '# Workspace memory index\n\n- **Environment** (`topics/environment.md`)\n',
    );
    put(
      path.join(ws, 'topics', 'environment.md'),
      '# Environment\nHow tools are set up.\n\n## Node\n- Node 24 via fnm.\n',
    );
    put(
      path.join(ws, 'observations', '_inbox', `${session}__t000001-000001__n000.md`),
      `---\nschema_version: 2\ntype: user\nsession_id: "${session}"\n---\n\n# The user reviews every release note.\n`,
      T0 + 1000,
    );
    put(
      path.join(ws, 'archive', 'dream_1', `${session}__t000000-000000__n000.md`),
      `---\ntype: project\nsession_id: "${session}"\n---\n\n# Consolidated already.\n`,
    );
    put(
      path.join(home, 'memory', 'MEMORY.md'),
      '# Global Memory\n\n> Managed by Grok.\n\n## Preferences\n\n<!-- Add preferences here -->\n',
    );
    const r = await syncSource({ db, home: path.join(tmp, 'origin') }, createGrokAdapter({ home }));
    expect(r.parseErrors).toBe(0);

    const entries = listEntries(db);
    expect(entries.map((e) => [e.kind, e.confidence, e.project, e.text.split('\n')[0]])).toEqual([
      ['cognition', 0.7, 'demo-app', '# The user reviews every release note.'],
      ['knowledge', 0.9, 'demo-app', '# Environment'],
    ]);
    const events = db
      .prepare("SELECT cwd, meta FROM event WHERE kind = 'memory' ORDER BY ts")
      .all() as Array<{ cwd: string | null; meta: string }>;
    // The template of version 1 is mirrored, but holds no memory.
    expect(events.map((e) => [e.cwd, JSON.parse(e.meta).file])).toEqual([
      [null, 'MEMORY.md'],
      ['/home/dev/demo-app', 'topics/environment.md'],
      ['/home/dev/demo-app', `observations/_inbox/${session}__t000001-000001__n000.md`],
    ]);
    expect(importedEntryId('x')).toMatch(/^ent_[0-9a-f]{24}$/);
  });
});
