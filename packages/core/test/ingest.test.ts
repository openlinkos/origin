import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  forget,
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
import { VISIBLE_EVENT } from '../src/store.js';
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

  it('counts visible sessions and events per source, as a scan of the events would', async () => {
    fs.writeFileSync(
      path.join(src, 'h.jsonl'),
      line('1', 'h1', 5000, 'user', 'one') +
        line('2', 'h1', 1000, 'assistant', 'two') +
        line('3', 'h2', 7000, 'user', 'three') +
        line('4', 'h3', 3000, 'user', 'only event of h3') +
        `${JSON.stringify({ session: 'h4', title: 'a title without events' })}\n`,
    );
    await syncSource({ db, home }, fakeAdapter(src));
    forget(db, 'fake:4');
    forget(db, 'fake:3');
    const scan = db
      .prepare(
        `SELECT source, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events, MIN(ts) AS first,
                MAX(ts) AS last
         FROM event e WHERE ${VISIBLE_EVENT} GROUP BY source`,
      )
      .all();
    expect(stats(db)).toEqual([
      expect.objectContaining({
        source: 'fake',
        sessions: 1,
        events: 2,
        firstTs: 1000,
        lastTs: 5000,
      }),
    ]);
    expect(scan).toEqual([{ source: 'fake', sessions: 1, events: 2, first: 1000, last: 5000 }]);
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

describe('time order', () => {
  // Newer events arrive first, then a backfill of older ones (as when a hub receives a device's old
  // sessions later), including one with the same timestamp as an earlier arrival.
  async function ingestOutOfOrder(): Promise<void> {
    fs.writeFileSync(
      path.join(src, 'a-new.jsonl'),
      line('n1', 'new', 5000, 'user', 'sqlite plan one') +
        line('n2', 'new', 6000, 'user', 'sqlite plan two'),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    fs.writeFileSync(
      path.join(src, 'b-old.jsonl'),
      line('o1', 'old', 1000, 'user', 'sqlite plan zero') +
        line('o2', 'old', 5500, 'user', 'sqlite plan between') +
        line('o3', 'old', 6000, 'user', 'sqlite plan tie'),
    );
    await syncSource({ db, home }, fakeAdapter(src));
  }

  it('returns search results newest first whatever order they arrived in', async () => {
    await ingestOutOfOrder();
    const recent = (o: Parameters<typeof searchEvents>[2] = {}) =>
      searchEvents(db, 'sqlite plan', { order: 'recent', ...o }).map((h) => h.id);
    // Same timestamp: the later arrival comes first.
    expect(recent()).toEqual(['fake:o3', 'fake:n2', 'fake:o2', 'fake:n1', 'fake:o1']);
    expect(recent({ limit: 2, offset: 1 })).toEqual(['fake:n2', 'fake:o2']);
    expect(recent({ since: 5500, until: 6000 })).toEqual(['fake:o3', 'fake:n2', 'fake:o2']);
    expect(recent({ until: 5499 })).toEqual(['fake:n1', 'fake:o1']);
    expect(recent({ project: 'demo', since: 5001 })).toEqual(['fake:o3', 'fake:n2', 'fake:o2']);
  });

  it('lists events in time order, ties in arrival order', async () => {
    await ingestOutOfOrder();
    expect(listEvents(db).map((e) => e.id)).toEqual([
      'fake:o1',
      'fake:n1',
      'fake:o2',
      'fake:n2',
      'fake:o3',
    ]);
  });

  it('keeps the arrival order of events with the same timestamp', async () => {
    fs.writeFileSync(
      path.join(src, 'same.jsonl'),
      Array.from({ length: 50 }, (_, i) => line(`s${i}`, 'same', 7000, 'user', `tied ${i}`)).join(
        '',
      ),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    const ids = Array.from({ length: 50 }, (_, i) => `fake:s${i}`);
    expect(listEvents(db).map((e) => e.id)).toEqual(ids);
    expect(searchEvents(db, 'tied', { order: 'recent', limit: 50 }).map((h) => h.id)).toEqual(
      [...ids].reverse(),
    );
  });

  it('ingests the files of a sync oldest first', async () => {
    fs.writeFileSync(path.join(src, 'a.jsonl'), line('recent', 'a', 9000, 'user', 'recent'));
    fs.writeFileSync(path.join(src, 'b.jsonl'), line('old', 'b', 1000, 'user', 'old'));
    fs.utimesSync(path.join(src, 'b.jsonl'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await syncSource({ db, home }, fakeAdapter(src));
    const arrival = db.prepare('SELECT id FROM event ORDER BY seq').all() as Array<{ id: string }>;
    expect(arrival.map((r) => r.id)).toEqual(['fake:old', 'fake:recent']);
  });

  it('orders extreme timestamps too', async () => {
    fs.writeFileSync(
      path.join(src, 'far.jsonl'),
      line('far-future', 'far', 5e15, 'user', 'far away') +
        line('normal', 'far', 2000, 'user', 'far away') +
        line('far-past', 'far', -5e15, 'user', 'far away'),
    );
    expect((await syncSource({ db, home }, fakeAdapter(src))).eventsAdded).toBe(3);
    expect(searchEvents(db, 'far away', { order: 'recent' }).map((h) => h.id)).toEqual([
      'fake:far-future',
      'fake:normal',
      'fake:far-past',
    ]);
    expect(getEvent(db, 'fake:far-future')?.ts).toBe(5e15);
  });
});
