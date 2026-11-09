import { CJK_MESSAGE_TOKEN, cjkTermQuery } from './cjk.js';
import type { Database, SqlRow } from './database.js';
import { transaction } from './db.js';
import {
  BLOCK_BITS,
  candidateFilters,
  type EntryQuery,
  type IndexDriver,
  MAX_SEQ,
  MIN_SEQ,
  type Need,
  type Plan,
  passColumn,
  type QueryTerm,
  type Row,
  type SearchDriver,
  termTrigrams,
  VISIBLE_SEQ,
} from './search-driver.js';
import type { EventFilter } from './store.js';

/**
 * The search indexes of a store in SQLite: FTS5 tables kept by triggers (see schema.ts).
 *
 * - message_fts, a full trigram index of message events, matches terms as exact phrases;
 * - event_fts, a trigram index of every event that records only which events contain each trigram
 *   (detail=none), matches every trigram of every term, a superset that the plan's `verify` terms
 *   then narrow;
 * - event_cjk, contentless, matches CJK terms of one or two letters: a bigram, or a letter as a
 *   prefix;
 * - entry_fts, a full trigram index of entries.
 *
 * FTS5 streams an index in rowid order, so a query reads its matches latest arrival first as it
 * goes, and bm25() gives the scores.
 */

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** FTS5 query for phrases that must all occur (a trigram index finds each one exactly). */
export function phraseQuery(terms: QueryTerm[]): string {
  return terms.map((t) => quote(t.text)).join(' AND ');
}

/**
 * FTS5 query for event_fts, which records only which events contain each trigram (detail=none) and
 * so cannot match phrases: every trigram of every term, which events containing the terms must have.
 */
function trigramQuery(terms: QueryTerm[]): string {
  return termTrigrams(terms).map(quote).join(' AND ');
}

const cjkQuery = (ts: QueryTerm[]) => ts.map((t) => cjkTermQuery(t.text)).join(' AND ');

const TABLES = { message: 'message_fts', event: 'event_fts', cjk: 'event_cjk' } as const;

/** The FTS5 table that drives a plan, its MATCH query, and the CJK query its matches must satisfy. */
interface Fts5Plan extends Plan {
  table: 'message_fts' | 'event_fts' | 'event_cjk';
  match: string;
  cjkMatch: string | null;
}

function fts5Plan(p: Plan): Fts5Plan {
  if (!p.index) throw new Error('A plan without an index has no FTS5 table.');
  let match: string;
  if (p.index === 'message') match = phraseQuery(p.long);
  else if (p.index === 'event') match = trigramQuery(p.long);
  else match = p.messages ? `${cjkQuery(p.cjk)} AND ${CJK_MESSAGE_TOKEN}` : cjkQuery(p.cjk);
  const cjkMatch = p.index !== 'cjk' && p.cjk.length > 0 ? cjkQuery(p.cjk) : null;
  return { ...p, table: TABLES[p.index], match, cjkMatch };
}

/**
 * SQL reading the matches of an index-driven plan between two seqs (bound last), latest arrival
 * first: seq, ts, `cand`, and `pass`. Filters that need an event's row only set `cand`, so every
 * match comes back and a query can stop as soon as it has enough; the others (the time range, CJK
 * terms, and the project, when `projectSet` has it matched through its events) are part of the
 * WHERE clause and read no event.
 */
function rangeQuery(
  p: Fts5Plan,
  f: EventFilter,
  need: Need,
  projectSet: boolean,
): { sql: string; params: (lo: number, hi: number) => unknown[] } {
  const table = p.table;
  const conditions: string[] = [];
  const whereParams: unknown[] = [];
  if (p.cjkMatch) {
    conditions.push('+f.rowid IN (SELECT rowid FROM event_cjk WHERE event_cjk MATCH ?)');
    whereParams.push(p.cjkMatch);
  }
  const range = (column: string): string => {
    let sql = '';
    if (f.since !== undefined) {
      sql += ` AND ${column} >= ?`;
      whereParams.push(f.since);
    }
    if (f.until !== undefined) {
      sql += ` AND ${column} <= ?`;
      whereParams.push(f.until);
    }
    return sql;
  };
  const projectByIndex = !!f.project && projectSet;
  if (projectByIndex) {
    // Events with no place row still use the project index. Placed sessions match their resolved
    // name. `range` pushes its parameters as it is called, in the order the placeholders appear.
    whereParams.push(f.project);
    const unplaced = range('e.ts');
    whereParams.push(f.project);
    const placed = range('e.ts');
    conditions.push(`+f.rowid IN (
      SELECT e.seq FROM event e
       WHERE e.project = ? AND NOT EXISTS (
         SELECT 1 FROM session_place sp WHERE sp.source = e.source AND sp.session_id = e.session_id)${unplaced}
      UNION ALL
      SELECT e.seq FROM event e
        JOIN session_place sp ON sp.source = e.source AND sp.session_id = e.session_id
       WHERE sp.project = ?${placed})`);
  }
  const inRange = range('x.ts');
  if (inRange) conditions.push(inRange.slice(' AND '.length));
  const selectParams: unknown[] = [];
  // A match's row is read anyway to set `cand`: its project is checked there, not through every
  // event of a large project.
  const filters = candidateFilters('sqlite', p, f, selectParams, projectByIndex ? 'none' : 'row');
  const cand = filters.length > 0 ? `(${filters.join(' AND ')})` : '1';
  const pass = passColumn('sqlite', p, selectParams);
  const row = cand !== '1' || pass !== '1' || !!need.accept;
  const columns = ['f.rowid AS seq', 'x.ts AS ts', `${cand} AS cand`, `${pass} AS pass`];
  if (need.accept) columns.push('e.text AS text');
  // The index stays the outer loop (CROSS JOIN). Timestamps come from the narrow (seq, ts) index; an
  // event is read only to filter or check it, after the time range.
  const join = `CROSS JOIN event x INDEXED BY event_seq_ts ON x.seq = f.rowid${
    row ? ' CROSS JOIN event e ON e.seq = f.rowid' : ''
  }`;
  const sql = `SELECT ${columns.join(', ')} FROM ${table} f ${join}
    WHERE ${table} MATCH ? AND f.rowid BETWEEN ? AND ? AND ${VISIBLE_SEQ('f.rowid')}
    ${conditions.map((c) => `AND ${c}`).join(' ')}
    ORDER BY f.rowid DESC`;
  return { sql, params: (lo, hi) => [...selectParams, p.match, lo, hi, ...whereParams] };
}

/** The FTS5 driver of one plan (see IndexDriver). */
function eventIndex(db: Database, plan: Plan): IndexDriver {
  const p = fts5Plan(plan);
  const read = (sql: string, params: unknown[]) =>
    db.prepare(sql).iterate(...(params as never[])) as IterableIterator<Row>;
  return {
    countMatches(cap) {
      const count = db.prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM ${p.table} WHERE ${p.table} MATCH ? LIMIT ?)`,
      );
      return (count.get(p.match, cap) as { n: number }).n;
    },
    all(f, need, projectSet) {
      const q = rangeQuery(p, f, need, projectSet);
      return read(q.sql, q.params(MIN_SEQ, MAX_SEQ));
    },
    stream(f, need, projectSet) {
      const q = rangeQuery(p, f, need, projectSet);
      return (lo, hi) => read(q.sql, q.params(lo, hi))[Symbol.iterator]();
    },
    // In one query: bm25() computes its statistics over the whole index once per query, so the
    // hits are read without it.
    scores(seqs) {
      if (seqs.length === 0) return new Map();
      const rows = db
        .prepare(
          `SELECT f.rowid AS seq, bm25(${p.table}) AS score FROM ${p.table} f
       WHERE ${p.table} MATCH ? AND f.rowid BETWEEN ? AND ?
         AND +f.rowid IN (SELECT value FROM json_each(?))`,
        )
        .all(
          p.match,
          Math.min(...seqs),
          Math.max(...seqs),
          JSON.stringify(seqs),
        ) as unknown as Array<{
        seq: number;
        score: number;
      }>;
      return new Map(rows.map((r) => [r.seq, r.score]));
    },
  };
}

/** Entries matching the terms as phrases through entry_fts, ranked by bm25(). */
function entries(db: Database, q: EntryQuery): SqlRow[] {
  const params: unknown[] = [phraseQuery(q.long)];
  const sql = `${q.select} JOIN entry_fts f ON f.rowid = en.rowid
           WHERE entry_fts MATCH ? AND ${q.where(params)}
           ORDER BY bm25(entry_fts), en.created_at DESC LIMIT ? OFFSET ?`;
  params.push(q.limit, q.offset);
  return db.prepare(sql).all(...(params as never[]));
}

/**
 * Rebuild the external-content indexes from their content, the contentless CJK index from scratch,
 * and the blocks.
 */
function rebuild(db: Database): void {
  const run = () => {
    db.exec(`INSERT INTO event_fts (event_fts) VALUES ('rebuild');
        INSERT INTO message_fts (message_fts) VALUES ('rebuild');
        INSERT INTO event_cjk (event_cjk) VALUES ('delete-all');
        INSERT INTO event_cjk (rowid, text)
          SELECT seq, t FROM (SELECT seq, origin_cjk(text, kind) AS t FROM event)
          WHERE t IS NOT NULL;
        INSERT INTO entry_fts (entry_fts) VALUES ('rebuild');
        DELETE FROM event_block;
        INSERT INTO event_block (block, max_ts, latest_ts)
          SELECT block, max_ts, MAX(max_ts) OVER (ORDER BY block ROWS UNBOUNDED PRECEDING)
          FROM (SELECT seq >> ${BLOCK_BITS} AS block, MAX(ts) AS max_ts FROM event GROUP BY 1);`);
  };
  if (db.isTransaction) run();
  else transaction(db, run, { immediate: true });
}

/** The search indexes of a store in SQLite. */
export function fts5Search(db: Database): SearchDriver {
  return {
    events: (p) => eventIndex(db, p),
    entries: (q) => entries(db, q),
    rebuild: () => rebuild(db),
  };
}
