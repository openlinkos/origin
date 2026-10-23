import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL_SIZE_LIMIT } from '../src/db.js';
import {
  type Database,
  forget,
  getEvent,
  IDLE_SEAL_MS,
  listEvents,
  listSessions,
  openDatabase,
  rawLocator,
  readRawLine,
  searchEvents,
  stats,
  storeUsage,
  syncSource,
} from '../src/index.js';
import { TRANSACTION_BYTES } from '../src/ingest.js';
import { VISIBLE_EVENT } from '../src/store.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

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
    expect(readRawLine(db, home, loc1!)).toContain('original content here');
    expect(readRawLine(db, home, loc2!)).toContain('rewritten from scratch');
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
    fs.appendFileSync(`${mirror}.tail`, line('x', 's7', 1500, 'user', 'uncommitted'));

    fs.appendFileSync(file, line('2', 's7', 2000, 'user', 'second'));
    await syncSource({ db, home }, fakeAdapter(src));
    const second = getEvent(db, 'fake:2')!;
    expect(readRawLine(db, home, rawLocator(db, home, second)!)).toBe(
      line('2', 's7', 2000, 'user', 'second').trim(),
    );
    expect(mirrorText(db, home, second.rawFileId)).toBe(fs.readFileSync(file, 'utf8'));
    expect(fs.readFileSync(`${mirror}.tail`, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
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

describe('write transactions', () => {
  /** Count the write transactions a sync opens. */
  async function syncCountingTransactions(): Promise<number> {
    let count = 0;
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') count++;
      return exec(sql);
    };
    try {
      await syncSource({ db, home }, fakeAdapter(src));
    } finally {
      db.exec = exec;
    }
    return count;
  }

  it('ingests a large file in bounded transactions, as if in one', async () => {
    const file = path.join(src, 'big.jsonl');
    const pad = 'x'.repeat(2000);
    let content = '';
    for (let i = 0; i < 1500; i++) content += line(`b${i}`, 'big', 1000 + i, 'user', `${i} ${pad}`);
    fs.writeFileSync(file, content);
    expect(content.length).toBeGreaterThan(2.5 * TRANSACTION_BYTES);
    // One more transaction empties the open tail after its lines were sealed into frames.
    expect(await syncCountingTransactions()).toBe(
      Math.ceil(content.length / TRANSACTION_BYTES) + 1,
    );
    const events = listEvents(db, { sessionId: 'big', limit: 2000 });
    expect(events).toHaveLength(1500);
    expect(events[1499]?.rawLine).toBe(1500);
    expect(readRawLine(db, home, rawLocator(db, home, events[1499]!)!)).toBe(
      line('b1499', 'big', 2499, 'user', `1499 ${pad}`).trim(),
    );
    expect(mirrorText(db, home, events[0]!.rawFileId)).toBe(content);
    expect(listSessions(db)[0]?.eventCount).toBe(1500);
  });

  it('takes a line longer than the bound whole', async () => {
    const long = 'y'.repeat(TRANSACTION_BYTES + 100);
    fs.writeFileSync(
      path.join(src, 'long.jsonl'),
      line('l1', 'long', 1000, 'user', long) + line('l2', 'long', 2000, 'user', 'short'),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    expect(getEvent(db, 'fake:l1')?.text).toBe(long);
    expect(getEvent(db, 'fake:l2')?.rawLine).toBe(2);
  });

  it('takes no write lock for files that have not changed', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(src, `u${i}.jsonl`), line(`u${i}`, 'u', 1000 + i, 'user', 'same'));
    }
    expect(await syncCountingTransactions()).toBe(5);
    expect(await syncCountingTransactions()).toBe(0);
    fs.appendFileSync(path.join(src, 'u3.jsonl'), line('u3b', 'u', 2000, 'user', 'more'));
    expect(await syncCountingTransactions()).toBe(1);
    expect(getEvent(db, 'fake:u3b')).not.toBeNull();
  });

  it('limits the write-ahead log kept after a checkpoint', () => {
    expect(db.prepare('PRAGMA journal_size_limit').get()).toEqual({
      journal_size_limit: JOURNAL_SIZE_LIMIT,
    });
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

describe('compressed mirrors', () => {
  const FRAME = 300;
  const file = () => path.join(src, 'z.jsonl');
  const ctx = () => ({ db, home, frameBytes: FRAME });
  const lineN = (i: number) =>
    line(`z${i}`, 'z', 1000 + i, 'user', `line ${i} ${'数据'.repeat(i % 9)}`);
  const write = (from: number, to: number) => {
    let text = '';
    for (let i = from; i < to; i++) text += lineN(i);
    fs.appendFileSync(file(), text);
  };
  const chunks = (rawFileId: number) =>
    db
      .prepare(
        `SELECT first_line, line_count, byte_offset, byte_length, frame_offset, frame_length
         FROM raw_chunk WHERE raw_file_id = ? ORDER BY first_line`,
      )
      .all(rawFileId) as unknown as Array<{
      first_line: number;
      line_count: number;
      byte_offset: number;
      byte_length: number;
      frame_offset: number;
      frame_length: number;
    }>;
  const rawFileOf = () => getEvent(db, 'fake:z0')!.rawFileId;
  const mirrorBase = () => rawLocator(db, home, getEvent(db, 'fake:z0')!)!.mirrorPath;
  /** Every line of the source, read back from the mirror, and the mirror's whole content. */
  const expectIntact = (count: number) => {
    const source = fs.readFileSync(file(), 'utf8');
    expect(mirrorText(db, home, rawFileOf())).toBe(source);
    for (let i = 0; i < count; i++) {
      const e = getEvent(db, `fake:z${i}`)!;
      expect(e.rawLine).toBe(i + 1);
      expect(readRawLine(db, home, rawLocator(db, home, e)!)).toBe(lineN(i).trim());
    }
    expect(listEvents(db, { sessionId: 'z', limit: 1000 })).toHaveLength(count);
  };

  it('seals the open tail into zstd frames of complete lines, keeping the content (invariant 3)', async () => {
    // Batches of one to four lines: some stay in the tail, some reach the frame size and seal it.
    let n = 0;
    for (const size of [1, 2, 4, 1, 3, 4, 2, 1, 4, 3, 1]) {
      write(n, n + size);
      n += size;
      await syncSource(ctx(), fakeAdapter(src));
    }
    expectIntact(n);

    const id = rawFileOf();
    const sealed = chunks(id);
    expect(sealed.length).toBeGreaterThan(2);
    const frames = fs.readFileSync(`${mirrorBase()}.zst`);
    const content = fs.readFileSync(file());
    let firstLine = 1;
    let offset = 0;
    let frameOffset = 0;
    for (const c of sealed) {
      // Contiguous, and each frame decompresses on its own into complete lines.
      expect([c.first_line, c.byte_offset, c.frame_offset]).toEqual([
        firstLine,
        offset,
        frameOffset,
      ]);
      const piece = zlib.zstdDecompressSync(
        frames.subarray(c.frame_offset, c.frame_offset + c.frame_length),
      );
      expect(piece.equals(content.subarray(c.byte_offset, c.byte_offset + c.byte_length))).toBe(
        true,
      );
      expect(piece.at(-1)).toBe(0x0a);
      expect(piece.toString('utf8').split('\n').length - 1).toBe(c.line_count);
      expect(c.byte_length).toBeGreaterThanOrEqual(FRAME / 2);
      firstLine += c.line_count;
      offset += c.byte_length;
      frameOffset += c.frame_length;
    }
    // The frames fill the frames file, and the tail holds the rest, uncompressed.
    expect(frames.length).toBe(frameOffset);
    const tail = fs.readFileSync(`${mirrorBase()}.tail`);
    expect(tail.equals(content.subarray(offset))).toBe(true);
    expect(tail.length).toBeLessThan(FRAME);

    const usage = storeUsage(db, home);
    expect(usage.mirrorBytes.local).toBe(content.length);
    expect(usage.mirrorStoredBytes.local).toBe(frames.length + tail.length);
    // Frames are never rewritten.
    expect(() => db.prepare('UPDATE raw_chunk SET line_count = 0').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM raw_chunk').run()).toThrow(/append-only/);
  });

  it('seals the tail of a file that stopped growing, whatever its size', async () => {
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    const id = rawFileOf();
    expect(chunks(id)).toEqual([]);
    const { updated_at } = db.prepare('SELECT updated_at FROM raw_file WHERE id = ?').get(id) as {
      updated_at: number;
    };
    // An hour later, a sync with nothing new seals the tail into one small frame.
    const hourAgo = updated_at - IDLE_SEAL_MS - 1;
    db.prepare('UPDATE raw_file SET updated_at = ? WHERE id = ?').run(hourAgo, id);
    await syncSource(ctx(), fakeAdapter(src));
    expect(chunks(id)).toMatchObject([{ first_line: 1, line_count: 2 }]);
    expect(fs.statSync(`${mirrorBase()}.tail`).size).toBe(0);
    expectIntact(2);
    // Sealing leaves the cursor alone; new lines start a new tail.
    expect(db.prepare('SELECT updated_at FROM raw_file WHERE id = ?').get(id)).toEqual({
      updated_at: hourAgo,
    });
    write(2, 3);
    await syncSource(ctx(), fakeAdapter(src));
    expect(fs.readFileSync(`${mirrorBase()}.tail`, 'utf8')).toBe(lineN(2));
    expectIntact(3);
  });

  it('seals a line longer than a frame whole, and reads it back', async () => {
    const long = line('z0', 'z', 1000, 'user', 'w'.repeat(5 * FRAME));
    fs.writeFileSync(file(), long + lineN(1));
    await syncSource(ctx(), fakeAdapter(src));
    expect(chunks(rawFileOf())).toHaveLength(1);
    expect(readRawLine(db, home, rawLocator(db, home, getEvent(db, 'fake:z0')!)!)).toBe(
      long.trim(),
    );
    expect(mirrorText(db, home, rawFileOf())).toBe(long + lineN(1));
  });

  /** Run a sync whose `n`-th `sql` statement (1-based) fails, as if the process died there. */
  async function crashAt(sql: string, n: number): Promise<void> {
    let seen = 0;
    const exec = db.exec.bind(db);
    db.exec = (s: string) => {
      if (s === sql && ++seen === n) throw new Error('simulated crash');
      return exec(s);
    };
    try {
      await expect(syncSource(ctx(), fakeAdapter(src))).rejects.toThrow('simulated crash');
    } finally {
      db.exec = exec;
    }
  }

  it('recovers from a crash after writing a frame, before the transaction commits', async () => {
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    const tail = fs.readFileSync(`${mirrorBase()}.tail`);
    write(2, 8); // reaches the frame size: this sync seals
    await crashAt('COMMIT', 1);
    // The frame reached the disk, but the database records neither it nor the new lines.
    expect(fs.statSync(`${mirrorBase()}.zst`).size).toBeGreaterThan(0);
    expect(chunks(rawFileOf())).toEqual([]);
    expect(fs.readFileSync(`${mirrorBase()}.tail`).equals(tail)).toBe(true);
    expect(getEvent(db, 'fake:z2')).toBeNull();
    expect(mirrorText(db, home, rawFileOf())).toBe(tail.toString('utf8'));

    // The next sync drops the frame nothing records, then seals again: no line lost or doubled.
    await syncSource(ctx(), fakeAdapter(src));
    expectIntact(8);
    const last = chunks(rawFileOf()).at(-1)!;
    expect(fs.statSync(`${mirrorBase()}.zst`).size).toBe(last.frame_offset + last.frame_length);
  });

  it('recovers from a crash after sealing commits, before the tail is emptied', async () => {
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    write(2, 8);
    // The first write transaction seals and commits; the second, which empties the tail, never runs.
    await crashAt('BEGIN IMMEDIATE', 2);
    expect(chunks(rawFileOf()).length).toBeGreaterThan(0);
    // The tail still holds lines that are now in frames; readers ignore them.
    expect(fs.statSync(`${mirrorBase()}.tail`).size).toBeGreaterThan(0);
    expectIntact(8);

    // The next write to the mirror drops them before appending.
    write(8, 9);
    await syncSource(ctx(), fakeAdapter(src));
    expectIntact(9);
    expect(fs.readFileSync(`${mirrorBase()}.tail`, 'utf8')).toBe(lineN(8));
  });

  it('refuses to append to a mirror that lost data (invariant 1)', async () => {
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    fs.truncateSync(`${mirrorBase()}.tail`, 10);
    write(2, 3);
    await expect(syncSource(ctx(), fakeAdapter(src))).rejects.toThrow(/the store is damaged/);
    expect(getEvent(db, 'fake:z2')).toBeNull();
  });
});
