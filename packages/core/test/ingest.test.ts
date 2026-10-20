import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  getEvent,
  listEvents,
  listSessions,
  openDatabase,
  rawLocator,
  readRawLine,
  searchEvents,
  stats,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let home: string;
let src: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe('syncSource', () => {
  it('ingests, is idempotent, and follows appends without re-reading', async () => {
    const file = path.join(src, 'a.jsonl');
    fs.writeFileSync(
      file,
      line('1', 's1', 1000, 'user', '先整理一下数据库结构') +
        line('2', 's1', 2000, 'assistant', 'OK, starting with the schema'),
    );
    const adapter = fakeAdapter(src);

    const r1 = await syncSource({ db, home }, adapter);
    expect(r1.eventsAdded).toBe(2);
    expect(r1.filesChanged).toBe(1);

    const r2 = await syncSource({ db, home }, adapter);
    expect(r2.eventsAdded).toBe(0);
    expect(r2.filesChanged).toBe(0);

    fs.appendFileSync(file, line('3', 's1', 3000, 'user', '然后补充测试用例'));
    const r3 = await syncSource({ db, home }, adapter);
    expect(r3.eventsAdded).toBe(1);
    expect(r3.linesRead).toBe(1);

    const events = listEvents(db, { sessionId: 's1' });
    expect(events.map((e) => e.id)).toEqual(['fake:1', 'fake:2', 'fake:3']);
    expect(events[2]?.rawLine).toBe(3);

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 's1',
      eventCount: 3,
      startedAt: 1000,
      endedAt: 3000,
    });
  });

  it('keeps a partial trailing line until it is completed', async () => {
    const file = path.join(src, 'b.jsonl');
    fs.writeFileSync(
      file,
      `${line('1', 's2', 1000, 'user', 'first')}{"id":"2","session":"s2","ts":2000,"role":"user","te`,
    );
    const adapter = fakeAdapter(src);
    expect((await syncSource({ db, home }, adapter)).eventsAdded).toBe(1);
    fs.appendFileSync(file, 'xt":"second"}\n');
    expect((await syncSource({ db, home }, adapter)).eventsAdded).toBe(1);
    expect(getEvent(db, 'fake:2')?.text).toBe('second');
  });

  it('opens a new generation when the source file is rewritten, keeping the old mirror', async () => {
    const file = path.join(src, 'c.jsonl');
    fs.writeFileSync(file, line('1', 's3', 1000, 'user', 'original content here'));
    const adapter = fakeAdapter(src);
    await syncSource({ db, home }, adapter);

    fs.writeFileSync(file, line('9', 's3', 5000, 'user', 'rewritten from scratch!!'));
    const r = await syncSource({ db, home }, adapter);
    expect(r.newGenerations).toBe(1);
    expect(r.eventsAdded).toBe(1);

    const first = getEvent(db, 'fake:1');
    const second = getEvent(db, 'fake:9');
    expect(first && second).toBeTruthy();
    const loc1 = rawLocator(db, home, first!);
    const loc2 = rawLocator(db, home, second!);
    expect(loc1?.generation).toBe(1);
    expect(loc2?.generation).toBe(2);
    expect(readRawLine(loc1!)).toContain('original content here');
    expect(readRawLine(loc2!)).toContain('rewritten from scratch');
  });

  it('records parse errors without aborting the file', async () => {
    const file = path.join(src, 'd.jsonl');
    fs.writeFileSync(
      file,
      `${line('1', 's4', 1000, 'user', 'good')}not json at all\n${line('2', 's4', 2000, 'user', 'also good')}`,
    );
    const r = await syncSource({ db, home }, fakeAdapter(src));
    expect(r.parseErrors).toBe(1);
    expect(r.eventsAdded).toBe(2);
  });

  it('drops mirror bytes left by an interrupted sync before appending (invariant 1)', async () => {
    const file = path.join(src, 'm.jsonl');
    fs.writeFileSync(file, line('1', 's7', 1000, 'user', 'first'));
    await syncSource({ db, home }, fakeAdapter(src));
    const first = getEvent(db, 'fake:1');
    const mirror = rawLocator(db, home, first!)!.mirrorPath;
    fs.appendFileSync(mirror, line('x', 's7', 1500, 'user', 'uncommitted'));

    fs.appendFileSync(file, line('2', 's7', 2000, 'user', 'second'));
    await syncSource({ db, home }, fakeAdapter(src));
    const second = getEvent(db, 'fake:2')!;
    expect(readRawLine(rawLocator(db, home, second)!)).toBe(
      line('2', 's7', 2000, 'user', 'second').trim(),
    );
    expect(fs.readFileSync(mirror, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('applies session titles and exposes stats', async () => {
    fs.writeFileSync(
      path.join(src, 'e.jsonl'),
      `${line('1', 's5', 1000, 'user', 'hello')}${JSON.stringify({ session: 's5', title: '打招呼' })}\n`,
    );
    await syncSource({ db, home }, fakeAdapter(src));
    expect(listSessions(db)[0]?.title).toBe('打招呼');
    const s = stats(db);
    expect(s[0]).toMatchObject({ source: 'fake', sessions: 1, events: 1, files: 1 });
  });
});

describe('searchEvents', () => {
  it('matches Chinese substrings and English words via trigram FTS', async () => {
    fs.writeFileSync(
      path.join(src, 'f.jsonl'),
      line('1', 's6', 1000, 'user', 'AI助手帮我重构了数据库代码') +
        line('2', 's6', 2000, 'assistant', 'Use a pnpm workspace with four packages') +
        line('3', 's6', 3000, 'user', 'unrelated'),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    expect(searchEvents(db, '数据库').map((h) => h.id)).toEqual(['fake:1']);
    expect(searchEvents(db, 'PNPM workspace').map((h) => h.id)).toEqual(['fake:2']);
    expect(searchEvents(db, 'pnpm', { since: 2500 })).toHaveLength(0);
    // short queries fall back to LIKE
    expect(searchEvents(db, 'AI').map((h) => h.id)).toEqual(['fake:1']);
  });

  it('ranks by relevance by default and by time on request', async () => {
    fs.writeFileSync(
      path.join(src, 'g.jsonl'),
      line('old', 's8', 1000, 'user', 'sqlite migration plan for sqlite') +
        line(
          'new',
          's8',
          2000,
          'user',
          'a long recap of the week covering deployment, hiring, budgets, and briefly sqlite',
        ),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    expect(searchEvents(db, 'sqlite').map((h) => h.id)).toEqual(['fake:old', 'fake:new']);
    expect(searchEvents(db, 'sqlite', { order: 'recent' }).map((h) => h.id)).toEqual([
      'fake:new',
      'fake:old',
    ]);
  });
});
