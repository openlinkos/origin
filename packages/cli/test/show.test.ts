import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dbPath,
  insertRecall,
  openDatabase,
  remember,
  syncSource,
  threadIdOf,
  transaction,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { main } from '../src/main.js';

let tmp: string;
let home: string;
let entry: string;
let saved: string | undefined;
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-show-'));
  home = path.join(tmp, 'home');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, 's0.jsonl'),
    line('a1', 's0', 1000, 'user', 'Sketch the cache layer'),
  );
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('b1', 's1', 2000, 'user', 'Add an LRU cache to the API client') +
      line('b2', 's1', 2010, 'assistant', 'Done: the client caches with an LRU.') +
      line('b3', 's1', 3000, 'user', 'Now make the TTL configurable') +
      line('b4', 's1', 3010, 'assistant', 'TTL is an option now.'),
  );
  const db = openDatabase(dbPath(home));
  await syncSource({ db, home }, fakeAdapter(src));
  entry = remember(db, {
    kind: 'memory',
    text: 'The API client caches with an LRU.\n\nIts TTL is configurable.',
    confidence: 0.9,
    author: 'test',
    project: 'demo',
    sources: [{ eventId: 'fake:b2' }],
  }).id;
  transaction(
    db,
    () =>
      insertRecall(db, {
        id: 'rcl_0000000000a1',
        at: 2005,
        origin: 'laptop',
        source: 'fake',
        sessionId: 's1',
        occasion: 'prompt',
        project: 'demo',
        cwd: null,
        promptHash: null,
        budget: 400,
        tokens: 40,
        items: [{ rank: 1, layer: 'prompt', kind: 'entry', ref: entry, score: 2, tokens: 20 }],
      }),
    { immediate: true },
  );
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

describe('origin show <session id>', () => {
  it('prints the session card: its turns, the entries written from it, its recalls, its neighbours', async () => {
    expect(await main(['show', 's1'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Session     s1  fake, project demo');
    expect(text).toContain('Name        “Add an LRU cache to the API client”');
    expect(text).toContain('Events      4 events, 2 turns');
    expect(text).toMatch(/ {2}1\. \[.*\] Add an LRU cache to the API client\n {7}↳ fake:b1/);
    expect(text).toMatch(/ {2}2\. \[.*\] Now make the TTL configurable\n {7}↳ fake:b3/);
    expect(text).toContain('Entries written from it:');
    expect(text).toMatch(
      new RegExp(`memory {2}The API client caches with an LRU\\.\\n {6}↳ ${entry}`),
    );
    expect(text).toMatch(/at a prompt, 1 item {2}↳ rcl_0000000000a1/);
    expect(text).toMatch(/Before {6}fake .* {2}“Sketch the cache layer”\n {12}↳ s0/);
    expect(text).toContain('After       —');

    // As recalls record a session, too.
    out = [];
    expect(await main(['show', 'fake:s1'])).toBe(0);
    expect(out.join('\n')).toContain('Session     s1  fake, project demo');
    expect(await main(['show', 'nope'])).toBe(1);
    expect(out.at(-1)).toBe('Not found: nope');
  });

  it('asks for the source of a session id that two sources have', async () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 's1.jsonl'), line('z1', 's1', 9000, 'user', 'Elsewhere'));
    const db = openDatabase(dbPath(home));
    await syncSource({ db, home }, { ...fakeAdapter(other), id: 'twin' });
    db.close();
    expect(await main(['show', 's1'])).toBe(1);
    expect(err.join('\n')).toContain('more than one source (fake, twin)');
    out = [];
    expect(await main(['show', 's1', '--source', 'twin'])).toBe(0);
    expect(out.join('\n')).toContain('Session     s1  twin, project demo');
  });
});

describe('origin show <thread id>', () => {
  it('prints the thread card: its sessions, agents, branches, entries, and last prompt', async () => {
    const src = path.join(tmp, 'branch');
    fs.mkdirSync(src);
    const at = (id: string, session: string, ts: number, role: string, text: string) =>
      `${JSON.stringify({ id, session, ts, role, text, branch: 'feat-cache' })}\n`;
    fs.writeFileSync(
      path.join(src, 't1.jsonl'),
      at('c1', 't1', 5000, 'user', 'Start the cache rework') +
        at('c2', 't1', 5010, 'assistant', 'Started.'),
    );
    fs.writeFileSync(
      path.join(src, 't2.jsonl'),
      at('d1', 't2', 9000, 'user', 'Finish the cache rework') +
        at('d2', 't2', 9010, 'assistant', 'Finished.'),
    );
    const db = openDatabase(dbPath(home));
    await syncSource({ db, home }, { ...fakeAdapter(src), id: 'agent' });
    const written = remember(db, {
      kind: 'memory',
      text: 'The cache rework is finished.',
      confidence: 0.9,
      author: 'test',
      sources: [{ eventId: 'agent:d2' }],
    }).id;
    const thread = threadIdOf('agent', 't1');
    db.close();

    expect(await main(['timeline', '--since', '1970-01-01'])).toBe(0);
    expect(out.join('\n')).toContain(`↳ t2  thread ${thread}`);
    out = [];
    expect(await main(['show', thread])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`Thread      ${thread}  project demo`);
    expect(text).toContain('Name        Start the cache rework');
    expect(text).toContain('Sessions    2 sessions, of agent');
    expect(text).toContain('Branches    feat-cache');
    expect(text).toMatch(/agent {7} {4}2 events {2}“Start the cache rework”\n {6}↳ t1/);
    expect(text).toMatch(
      new RegExp(`memory {2}The cache rework is finished\\.\\n {6}↳ ${written}`),
    );
    expect(text).toMatch(/Last prompt \[.*\] Finish the cache rework\n {6}↳ agent:d1/);
    out = [];
    expect(await main(['show', 't2'])).toBe(0);
    expect(out.join('\n')).toContain(`Thread      ${thread}, 2 sessions`);
    expect(await main(['show', 'thr_000000000000'])).toBe(1);
    expect(out.at(-1)).toBe('Not found: thr_000000000000');
  });
});
