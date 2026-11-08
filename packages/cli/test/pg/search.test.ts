import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Database,
  type EventKind,
  forget,
  openDatabase,
  parseQuery,
  prepareStore,
  rebuildSearchIndexes,
  remember,
  type SearchOptions,
  searchEntries,
  searchEvents,
  transaction,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bm25Scorer } from '../../../core/src/bm25.js';
import { eventInserter, refreshSession } from '../../../core/src/ingest.js';
import {
  type Condition,
  DF_CAP,
  documentFrequency,
  indexStats,
  pgSearch,
} from '../../../core/src/pg/search.js';
import { plan } from '../../../core/src/search.js';
import { fts5Search } from '../../../core/src/search-fts5.js';
import { onPostgres, open, target, usePostgres } from './helpers.js';

/**
 * Search on PostgreSQL against search on SQLite, over the same synthetic events: the same hits in
 * the same order, the same BM25 scores, and n_i estimated beyond its cap as documented.
 */
usePostgres();

let home: string;
let lite: Database;
let pg: Database;

beforeEach(() => {
  if (!onPostgres) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-pg-search-'));
  lite = openDatabase(path.join(home, 'origin.db'));
  pg = open(target());
  prepareStore(pg, { home });
});

afterEach(() => {
  if (!onPostgres) return;
  lite.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const IMMEDIATE = { immediate: true };

/** A seeded random number generator, so that both stores get the same events. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** Words of several scripts and cases, picked about as often as 1 / rank. */
const WORDS = [
  'the',
  'and',
  'sqlite',
  'to',
  'deploy',
  'of',
  'server',
  'error',
  'build',
  'SQLite',
  'test',
  '部署',
  'origin',
  'search',
  'index',
  'query',
  'commit',
  '数据库',
  'database',
  'config',
  'Straße',
  'token',
  'École',
  'ÉCOLE',
  'hub',
  '证书',
  'device',
  'sync',
  '服务器',
  'ΣΟΦΙΑ',
  'σοφια',
  'event',
  'aaaaa',
  '100%',
  'snake_case',
  'qz',
  'DB',
  'AI',
  '🙂🙂🙂',
  'の',
  'カタカナ',
  '测试',
];

function words(rand: () => number, n: number): string {
  let text = '';
  for (let i = 0; i < n; i++) {
    const word = WORDS[Math.floor((WORDS.length + 1) ** rand()) - 1] as string;
    // CJK runs join without spaces now and then, as in Chinese text.
    const glue = i === 0 ? '' : /^\p{Script=Han}/u.test(word) && rand() < 0.5 ? '' : ' ';
    text += glue + word;
  }
  return text;
}

const KINDS: Array<[EventKind, number]> = [
  ['message', 0.45],
  ['tool_use', 0.15],
  ['tool_result', 0.3],
  ['meta', 0.05],
  ['system', 0.05],
];

/**
 * Write the same 6,000 events (two blocks of arrivals) into a store, in 24 sessions of 3 projects,
 * four of them placed in another, and forget a few.
 */
function seed(db: Database): void {
  const rand = random(7);
  transaction(
    db,
    () => {
      const raw = db
        .prepare(
          `INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at)
         VALUES ('fake', 'seed.jsonl', 'seed', 0, 0) RETURNING id`,
        )
        .get() as { id: number };
      const insert = eventInserter(db, 'fake', Number(raw.id), null);
      for (let i = 0; i < 6_000; i++) {
        let pick = rand();
        let kind: EventKind = 'message';
        for (const [k, p] of KINDS) {
          kind = k;
          pick -= p;
          if (pick < 0) break;
        }
        const session = `s${Math.floor(rand() * 24)}`;
        const long = kind === 'tool_result' && rand() < 0.1;
        const n = kind === 'message' ? 3 + Math.floor(rand() * 40) : 5 + Math.floor(rand() * 120);
        insert(i + 1, [
          {
            id: `e${i}`,
            sessionId: session,
            // Out of arrival order, with ties.
            ts: 1_700_000_000_000 + Math.floor(rand() * 1_000_000) * 1_000,
            project: ['alpha', 'beta', 'gamma'][Number(session.slice(1)) % 3] as string,
            role: kind === 'message' && rand() < 0.5 ? 'user' : 'assistant',
            kind,
            text: `${words(rand, long ? n * 20 : n)} #${i}`,
          },
        ]);
      }
      for (const s of ['s0', 's3', 's7', 's10']) {
        db.prepare(
          `INSERT INTO session_place (source, session_id, project, root, signal)
         VALUES ('fake', ?, 'beta', NULL, 'test')`,
        ).run(s);
      }
      for (let s = 0; s < 24; s++) refreshSession(db, 'fake', `s${s}`);
    },
    IMMEDIATE,
  );
  for (const id of ['fake:e11', 'fake:e2999', 'fake:e5990']) forget(db, id, { reason: 'test' }, 1);
}

const QUERIES = [
  'sqlite',
  'SQLITE',
  'deploy server',
  'straße',
  'école',
  'ÉCOLE',
  'σοφια',
  '🙂🙂',
  '🙂🙂🙂',
  'aaaa',
  '100%',
  'snake_case',
  '部署',
  '数据库',
  '部署 sqlite',
  '服务器 error',
  'sqlite qz',
  'qz',
  'db ai',
  'の',
  'カタカナ',
  'sqlite 部 db',
];

const OPTIONS: SearchOptions[] = [
  {},
  { kinds: ['message'] },
  { kinds: ['tool_result', 'tool_use'] },
  { order: 'recent' },
  { project: 'beta' },
  { kinds: ['message'], project: 'alpha', order: 'recent' },
  { since: 1_700_000_250_000_000, until: 1_700_000_600_000_000 },
  { limit: 30, offset: 15 },
  { limit: 3_000 },
];

describe.runIf(onPostgres)('search on PostgreSQL', { timeout: 120_000 }, () => {
  it('finds what SQLite finds, in the same order', () => {
    seed(lite);
    seed(pg);
    let found = 0;
    for (const q of QUERIES) {
      for (const opts of OPTIONS) {
        const want = searchEvents(lite, q, opts);
        expect(searchEvents(pg, q, opts), `${q} ${JSON.stringify(opts)}`).toEqual(want);
        found += want.length;
      }
    }
    expect(found).toBeGreaterThan(10_000);
  });

  it('scores as FTS5 does', () => {
    seed(lite);
    seed(pg);
    for (const q of ['sqlite', 'deploy server', 'école', 'aaaa', '部署 sqlite', '🙂🙂🙂']) {
      for (const kinds of [undefined, ['message'] as EventKind[]]) {
        const p = plan(parseQuery(q), kinds);
        if (!p) throw new Error(q);
        const seqs = (
          lite.prepare('SELECT seq FROM event ORDER BY seq').all() as Array<{ seq: number }>
        ).map((r) => Number(r.seq));
        const want = fts5Search(lite).events(p).scores(seqs);
        const got = pgSearch(pg).events(p).scores(seqs);
        expect(got.size, q).toBeGreaterThan(0);
        for (const [seq, score] of want) {
          // FTS5 scores every matching event; PostgreSQL every event asked for, a non-match 0.
          expect(got.get(seq), `${q} ${seq}`).toBeCloseTo(score, 9);
        }
      }
    }
  });

  it('ranks entries as FTS5 does', () => {
    seed(lite);
    seed(pg);
    for (const db of [lite, pg]) {
      const rand = random(11);
      for (let i = 0; i < 300; i++) {
        remember(
          db,
          {
            kind: i % 3 === 0 ? 'knowledge' : 'memory',
            text: `${words(rand, 3 + Math.floor(rand() * 30))} #${i}`,
            confidence: 0.5,
            author: 'test',
            sources: [{ eventId: `fake:e${1_000 + i}` }],
          },
          // Apart: entries found without ranking are ordered by time alone.
          1_000 + i,
        );
      }
    }
    const texts = (db: Database, q: string, o: { limit?: number; offset?: number }) =>
      searchEntries(db, q, o).map((e) => e.text);
    for (const q of ['sqlite', 'deploy server', '部署', 'école', 'aaaa', 'sqlite db', 'qz']) {
      for (const o of [{}, { limit: 100 }, { limit: 10, offset: 5 }]) {
        expect(texts(pg, q, o), q).toEqual(texts(lite, q, o));
      }
    }
  });

  it('rebuilds its search tables and counters as they were', () => {
    seed(pg);
    const snapshot = () => ({
      cjk: pg.prepare('SELECT seq, tokens FROM event_cjk ORDER BY seq').all(),
      prompts: pg.prepare('SELECT seq FROM event_prompt ORDER BY seq').all(),
      blocks: pg.prepare('SELECT * FROM event_block ORDER BY block').all(),
    });
    const before = snapshot();
    expect(before.cjk.length).toBeGreaterThan(1_000);
    expect(before.prompts.length).toBeGreaterThan(100);
    const results = QUERIES.map((q) => searchEvents(pg, q, { limit: 200 }));
    rebuildSearchIndexes(pg);
    expect(snapshot()).toEqual(before);
    expect(QUERIES.map((q) => searchEvents(pg, q, { limit: 200 }))).toEqual(results);
  });
});

describe.runIf(onPostgres)('n_i beyond its cap', { timeout: 120_000 }, () => {
  /**
   * 100 events in each of 60 blocks of arrivals: `zzqv` in every one, `yyk` in half of those of
   * the latest 16 blocks, `xxw` in every one of the oldest 10.
   */
  function blocks(db: Database): void {
    transaction(
      db,
      () => {
        const raw = db
          .prepare(
            `INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at)
           VALUES ('fake', 'blocks.jsonl', 'seed', 0, 0) RETURNING id`,
          )
          .get() as { id: number };
        const insert = db.prepare(
          `INSERT INTO event (seq, id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
         VALUES (?, ?, 'fake', 'S', ?, 'user', 'message', ?, ?, ?)`,
        );
        for (let b = 0; b < 60; b++) {
          for (let i = 0; i < 100; i++) {
            const seq = b * 4_096 + 1 + i;
            const text = [
              'some zzqv words',
              b >= 44 && i % 2 === 0 ? 'yyk' : '',
              b < 10 ? 'xxw' : '',
              'zzqv'.repeat(1 + (i % 3)),
              'x'.repeat(i % 7),
            ].join(' ');
            insert.run(seq, `fake:b${b}-${i}`, seq, text, Number(raw.id), seq);
          }
        }
      },
      IMMEDIATE,
    );
  }

  const grams = (gram: string): Condition => ({
    sql: 'origin_trigrams(e.text) @> ?::text[]',
    params: [`{${gram}}`],
  });

  it('is exact up to the cap, and scaled from the latest blocks beyond it', () => {
    blocks(pg);
    const stats = indexStats(pg, false);
    expect(stats.docs).toBe(6_000);
    expect(stats.blocks).toHaveLength(60);
    const n = (gram: string, cap: number) => documentFrequency(pg, grams(gram), stats, cap);
    expect(DF_CAP).toBe(20_000);
    expect(n('yyk', DF_CAP)).toBe(800);
    expect(n('yyk', 800)).toBe(800);
    // Beyond the cap: the latest block holds 50 of its 100 events, and the next 7, as many as the
    // other 250 should take with a quarter more, 350 of 700: half of all.
    expect(n('yyk', 300)).toBe(3_000);
    // A phrase in every event: the estimate is exact.
    expect(n('zzq', 500)).toBe(6_000);
    // Counted to the end without reaching the cap: exact.
    expect(n('zzq', 5_999)).toBe(6_000);
    expect(n('xxw', 200)).toBe(1_000);
  });

  it('scores with the estimate, which is FTS5 score where it is exact', () => {
    blocks(lite);
    blocks(pg);
    const seqs = (lite.prepare('SELECT seq FROM event').all() as Array<{ seq: number }>).map((r) =>
      Number(r.seq),
    );
    // zzqv is in every event: its estimated n_i is exact, so are the scores.
    for (const kinds of [undefined, ['message'] as EventKind[]]) {
      const p = plan(parseQuery('zzqv'), kinds);
      if (!p) throw new Error('zzqv');
      const want = fts5Search(lite).events(p).scores(seqs);
      const got = pgSearch(pg, 500).events(p).scores(seqs);
      expect(want.size).toBe(6_000);
      for (const [seq, score] of want) expect(got.get(seq)).toBeCloseTo(score, 9);
    }
    // yyk's is 3,000 rather than 800: lower scores, in the same order.
    const p = plan(parseQuery('yyk'), undefined);
    if (!p) throw new Error('yyk');
    const stats = indexStats(pg, false);
    const exact = pgSearch(pg).events(p).scores(seqs);
    const capped = pgSearch(pg, 300).events(p).scores(seqs);
    const estimated = bm25Scorer({
      docs: stats.docs,
      avgdl: stats.tokens / stats.docs,
      hits: [3_000],
    });
    const row = pg.prepare("SELECT seq, text FROM event WHERE id = 'fake:b59-0'").get() as {
      seq: number;
      text: string;
    };
    expect(capped.get(Number(row.seq))).toBeCloseTo(estimated([1], [...row.text].length - 2), 12);
    expect(exact.get(Number(row.seq))).toBeCloseTo(
      fts5Search(lite)
        .events(p)
        .scores([Number(row.seq)])
        .get(Number(row.seq)) as number,
      9,
    );
    const order = (m: Map<number, number>) =>
      [...m].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([s]) => s);
    expect(order(capped)).toEqual(order(exact));
  });
});
