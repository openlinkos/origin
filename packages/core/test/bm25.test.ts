import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inSqlite } from '../../../test/pg.js';
import { BM25_MIN_IDF, bm25Idf, bm25Scorer } from '../src/bm25.js';
import { type Database, type EventKind, openMemoryDatabase } from '../src/index.js';

/**
 * bm25.ts against FTS5's own bm25(), on Origin's search indexes: the statistics come from SQL
 * (MATCH counts and lengths in characters) and from counting occurrences in the folded text, and
 * the scores must equal FTS5's. This pins the formula, and what each input is, for a search index
 * that is not FTS5.
 */

/** A deterministic pseudo-random sequence (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Words with repeats inside them (`aaaa`, `abab`), case, letters beyond ASCII whose lower case is
 * the same character in JavaScript and in FTS5 (`É`, `Ä`, Cyrillic), CJK, characters outside the
 * Basic Multilingual Plane, and very common words, whose IDF is the floor.
 */
const WORDS = [
  'sqlite',
  'SQLite',
  'database',
  'Databases',
  'data',
  'base',
  'deploy',
  'DEPLOY',
  'origin',
  'banana',
  'aaaa',
  'aa',
  'abab',
  'ababab',
  'café',
  'CAFÉ',
  'Ärger',
  'naïve',
  '数据库',
  '数据',
  '部署',
  '😀',
  '😀😀',
  'дом',
  'ДОМ',
  'grep',
  'tool_use',
  'C#',
  'x',
  '...',
];
const COMMON = ['the', 'and', 'the', 'of', 'is'];
const KINDS: EventKind[] = ['message', 'message', 'message', 'tool_use', 'tool_result', 'meta'];

/** Texts of every length, words joined with and without separators. */
function corpus(count: number): Array<{ kind: EventKind; text: string }> {
  const next = random(20261107);
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
  const rows: Array<{ kind: EventKind; text: string }> = [
    { kind: 'message', text: '' },
    { kind: 'message', text: 'ab' },
    { kind: 'message', text: 'aaaaaaaaaa' },
    { kind: 'message', text: 'abc abc abc' },
    { kind: 'message', text: '😀😀😀😀' },
  ];
  while (rows.length < count) {
    const words = Math.floor(next() ** 2 * 60);
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(next() < 0.6 ? pick(COMMON) : pick(WORDS));
    const sep = pick([' ', ' ', ' ', '', '\n', ', ']);
    rows.push({ kind: pick(KINDS), text: parts.join(sep) });
  }
  return rows;
}

/** How often `needle` occurs in `text`, overlapping occurrences included. */
function occurrences(text: string, needle: string): number {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) n++;
  return n;
}

/** Every distinct trigram of the terms, by characters (code points), case-folded. */
function trigrams(terms: string[]): string[] {
  const all = new Set<string>();
  for (const term of terms) {
    const chars = [...term.toLowerCase()];
    for (let i = 0; i + 3 <= chars.length; i++) all.add(chars.slice(i, i + 3).join(''));
  }
  return [...all];
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Terms of three or more characters, as a search would send them. */
const QUERIES = [
  ['sqlite'],
  ['SQLITE'],
  ['database'],
  ['data'],
  ['ase'],
  ['the'],
  ['and'],
  ['aaa'],
  ['aaaa'],
  ['abab'],
  ['bab'],
  ['banana', 'data'],
  ['sqlite', 'deploy', 'origin'],
  ['café'],
  ['ärger'],
  ['naïve'],
  ['数据库'],
  ['😀😀😀'],
  ['дом'],
  ['tool_use'],
  ['abc'],
  ['the', 'grep'],
];

interface Index {
  /** The FTS5 table. */
  table: string;
  /** The rows it indexes, with their keys as the FTS5 table's rowid. */
  rows: string;
  key: string;
  /** Phrases of a query: its terms, or (detail = none) their trigrams. */
  phrases: (terms: string[]) => string[];
}

const INDEXES: Index[] = [
  // The event plan: every kind, trigrams only (detail = none).
  { table: 'event_fts', rows: 'event', key: 'seq', phrases: trigrams },
  // The message plan: exact phrases.
  {
    table: 'message_fts',
    rows: "(SELECT seq, text FROM event WHERE kind = 'message')",
    key: 'seq',
    phrases: (terms) => terms,
  },
  // Entries: exact phrases, as the message plan.
  { table: 'entry_fts', rows: 'entry', key: 'rowid', phrases: (terms) => terms },
];

let db: Database;
beforeAll(() => {
  // FTS5 is SQLite's: the scores are compared there whatever engine the run's stores are in.
  db = inSqlite(openMemoryDatabase);
  db.prepare(
    `INSERT INTO raw_file (id, source, path, mirror, first_seen_at, updated_at)
     VALUES (1, 'fake', 'f.jsonl', 'f', 0, 0)`,
  ).run();
  const event = db.prepare(
    `INSERT INTO event (id, source, session_id, ts, role, kind, text, raw_file_id, raw_line)
     VALUES (?, 'fake', 'S', ?, 'user', ?, ?, 1, ?)`,
  );
  const entry = db.prepare(
    `INSERT INTO entry (id, kind, text, confidence, author, root, created_at, origin)
     VALUES (?, 'memory', ?, 1, 'test', ?, ?, 'test')`,
  );
  corpus(600).forEach((row, i) => {
    event.run(`e${i}`, 1000 + i, row.kind, row.text, i + 1);
    if (i % 3 === 0) entry.run(`n${i}`, row.text, `n${i}`, 1000 + i);
  });
});
afterAll(() => db.close());

const num = (sql: string, ...params: Array<string | number>) =>
  Number((db.prepare(sql).get(...params) as { n: number }).n);

describe('BM25', () => {
  it('raises an IDF of zero or less to the floor, as FTS5 does', () => {
    expect(bm25Idf(10, 5)).toBe(BM25_MIN_IDF);
    expect(bm25Idf(10, 9)).toBe(BM25_MIN_IDF);
    expect(bm25Idf(10, 4)).toBeCloseTo(Math.log(6.5 / 4.5), 15);
    expect(bm25Idf(1000, 1)).toBeCloseTo(Math.log(999.5 / 1.5), 15);
  });

  it('scores lower for better matches, and nothing for phrases a row does not have', () => {
    const score = bm25Scorer({ docs: 100, avgdl: 20, hits: [3, 50] });
    expect(score([0, 0], 20)).toBe(-0);
    expect(score([2, 0], 20)).toBeLessThan(score([1, 0], 20));
    expect(score([1, 0], 10)).toBeLessThan(score([1, 0], 40));
    expect(score([1, 0], 20)).toBeLessThan(score([0, 1], 20));
    expect(() => score([1], 20)).toThrow(RangeError);
  });

  it.each(INDEXES)('equals bm25() of $table', ({ table, rows, key, phrases }) => {
    const docs = num(`SELECT count(*) AS n FROM ${rows}`);
    const tokens = num(`SELECT total(max(length(text) - 2, 0)) AS n FROM ${rows}`);
    const length = db.prepare(`SELECT text, max(length(text) - 2, 0) AS d FROM ${rows}
                               WHERE ${key} = ?`);
    let compared = 0;
    let repeated = 0;
    let floored = 0;
    let worst = 0;
    for (const terms of QUERIES) {
      const list = phrases(terms);
      const hits = list.map((p) =>
        num(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`, quote(p)),
      );
      floored += hits.filter((n) => bm25Idf(docs, n) === BM25_MIN_IDF).length;
      const score = bm25Scorer({ docs, avgdl: tokens / docs, hits });
      const matches = db
        .prepare(`SELECT rowid AS k, bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ?`)
        .all(list.map(quote).join(' AND ')) as unknown as Array<{ k: number; score: number }>;
      expect(matches.length, terms.join(' ')).toBeGreaterThan(0);
      for (const m of matches) {
        const row = length.get(m.k) as { text: string; d: number };
        const folded = row.text.toLowerCase();
        const freq = list.map((p) => occurrences(folded, p.toLowerCase()));
        expect(Math.min(...freq), `${terms.join(' ')} in ${row.text}`).toBeGreaterThan(0);
        if (Math.max(...freq) > 1) repeated++;
        const ours = score(freq, row.d);
        worst = Math.max(worst, Math.abs(ours - m.score));
        expect(Math.abs(ours - m.score), `${terms.join(' ')} in ${row.text}`).toBeLessThanOrEqual(
          1e-9,
        );
        compared++;
      }
    }
    // The corpus covers what the formula depends on.
    expect(compared).toBeGreaterThan(500);
    expect(repeated).toBeGreaterThan(50);
    expect(floored).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-12);
  });

  it('counts every occurrence of a trigram in event_fts, which keeps no positions', () => {
    // detail = none: bm25() tokenizes the row again to find its phrases, so a trigram that occurs
    // three times counts three times, not once.
    const docs = num('SELECT count(*) AS n FROM event');
    const tokens = num('SELECT total(max(length(text) - 2, 0)) AS n FROM event');
    const hits = [num(`SELECT count(*) AS n FROM event_fts WHERE event_fts MATCH '"abc"'`)];
    const fts = db
      .prepare(
        `SELECT bm25(event_fts) AS score FROM event_fts
         WHERE event_fts MATCH '"abc"' AND rowid = (SELECT seq FROM event WHERE text = ?)`,
      )
      .get('abc abc abc') as { score: number };
    const score = bm25Scorer({ docs, avgdl: tokens / docs, hits });
    expect(score([3], 9)).toBeCloseTo(fts.score, 12);
    expect(score([1], 9)).not.toBeCloseTo(fts.score, 6);
  });

  it('measures a row in characters, not UTF-16 units, as FTS5 does', () => {
    // FTS5 keeps each row's length in tokens as a varint in its docsize table.
    const rows = db
      .prepare(
        'SELECT e.text AS text, d.sz AS sz FROM event e JOIN event_fts_docsize d ON d.id = e.seq',
      )
      .all() as unknown as Array<{ text: string; sz: Uint8Array }>;
    expect(rows.length).toBe(num('SELECT count(*) AS n FROM event'));
    for (const { text, sz } of rows) {
      let tokens = 0;
      for (const byte of sz) {
        tokens = tokens * 128 + (byte & 0x7f);
        if (byte < 0x80) break;
      }
      expect(tokens, text).toBe(Math.max([...text].length - 2, 0));
    }
  });
});
