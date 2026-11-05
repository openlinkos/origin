import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dbPath,
  digestDay,
  localTimeZone,
  openDatabase,
  remember,
  syncSource,
} from '@openlinkos/origin-core';
import { digestOf } from '@openlinkos/origin-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import { main } from '../src/main.js';

let tmp: string;
let home: string;
let day: string;
let zone: string;
let entry: string;
let saved: string | undefined;
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-digest-'));
  home = path.join(tmp, 'home');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  // Today, in this machine's zone, as `origin digest` reads it without --day.
  zone = localTimeZone();
  const today = digestDay(undefined, zone);
  day = today.day;
  const at = (minute: number) => today.from + minute * 60_000;
  const cwd = '/work/demo';
  const lines = [
    { id: 'q1', session: 'cc', ts: at(1), role: 'user', text: 'Fix the login form', cwd },
    {
      id: 'u1',
      session: 'cc',
      ts: at(2),
      role: 'assistant',
      kind: 'tool_use',
      cwd,
      // The tool's input, as Claude Code's adapter keeps it in the event's text.
      text: `Edit ${JSON.stringify({ file_path: `${cwd}/src/login.ts`, old_string: 'a' })}`,
      meta: { toolName: 'Edit', toolUseId: 'tu-1' },
    },
    { id: 'a1', session: 'cc', ts: at(3), role: 'assistant', text: 'The form validates.', cwd },
    // Yesterday's work is not today's.
    { id: 'y1', session: 'old', ts: today.from - 60_000, role: 'user', text: 'Old work', cwd },
  ];
  fs.writeFileSync(path.join(src, 'cc.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const db = openDatabase(dbPath(home));
  await syncSource({ db, home }, fakeAdapter(src, 'claude-code'));
  entry = remember(db, {
    kind: 'knowledge',
    text: 'The login form validates on the client.',
    confidence: 0.9,
    author: 'test',
    project: 'demo',
    sources: [{ eventId: 'claude-code:a1' }],
  }).id;
  db.close();
  saved = process.env.ORIGIN_HOME;
  process.env.ORIGIN_HOME = home;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.ORIGIN_HOME;
  else process.env.ORIGIN_HOME = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('origin digest', () => {
  it("prints today's sessions, prompts, tools, files, and entries by id", async () => {
    expect(await main(['digest'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`Digest of ${day} (${zone})`);
    expect(text).toContain('1 session · 3 events · 1 prompt · 1 project · 1 agent');
    expect(text).toContain('↳ claude-code:cc');
    expect(text).toContain('“Fix the login form”');
    expect(text).toContain('Edit 1');
    expect(text).toContain('src/login.ts');
    expect(text).toContain('Entries written (1)');
    expect(text).toContain(entry);
    expect(text).toContain('Open any id: origin show <id>');
    expect(text).not.toContain('Old work');
    expect(err).toEqual([]);

    // The ids it prints open with `origin show`.
    out = [];
    expect(await main(['show', 'claude-code:cc'])).toBe(0);
    expect(out.join('\n')).toContain('Fix the login form');
  });

  it('prints with --json exactly what the MCP tool digest returns', async () => {
    expect(await main(['digest', '--json', '--project', 'demo', '--limit', '10'])).toBe(0);
    const printed = JSON.parse(out.join('\n'));
    const db = openDatabase(dbPath(home));
    try {
      expect(printed).toEqual(
        digestOf(db, { day: undefined, time_zone: zone, project: 'demo', limit: 10 }),
      );
    } finally {
      db.close();
    }
    expect(printed.day).toBe(day);
    expect(printed.sessions.map((s: { id: string }) => s.id)).toEqual(['claude-code:cc']);
  });

  it('reads another day with --day, and says when nothing happened', async () => {
    expect(await main(['digest', '--day', '2001-01-01'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Digest of 2001-01-01');
    expect(text).toContain('Nothing happened in this store that day.');
  });
});
