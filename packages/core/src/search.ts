import { CJK_MESSAGE_TOKEN, cjkTermQuery, isCjkTerm } from './cjk.js';
import type { Database } from './db.js';
import { transaction } from './db.js';
import {
  EVENT_COLUMNS,
  type EventFilter,
  type RawEventRecord,
  type SearchHit,
  type SearchOptions,
  toEventRow,
} from './store.js';
import type { EventKind } from './types.js';

/**
 * Event search (see docs/architecture.md#search-and-timeline).
 *
 * Every whitespace-separated term must occur in an event's text, ignoring case. Terms of three or
 * more characters are found through the trigram indexes, terms of one or two CJK letters through
 * the CJK index, and other terms of one or two characters (`AI`, `C#`) by reading the candidates'
 * text. One index drives the query and the other terms filter its matches:
 *
 * - message_fts for message searches with a term of three or more characters (exact phrases, BM25);
 * - event_fts for searches that include other kinds (a superset filter by trigrams, then checked
 *   against the text; BM25 over the trigrams);
 * - event_cjk when the only indexed terms are CJK terms of one or two letters (no BM25);
 * - the event table itself, newest first, when no term has an index.
 *
 * The indexes are keyed by arrival (`seq`), not time: dense keys keep FTS5 doclists small, but old
 * sessions can arrive after newer ones. Queries read an index latest arrival first, in a few chains
 * of blocks of arrivals (see event_block), merged by the latest timestamp each chain can still hold,
 * and stop as soon as no unread event can be newer than the events they need.
 */

/** Ranking considers the newest RANK_WINDOW matches; with more matches, older ones are not ranked. */
export const RANK_WINDOW = 2_000;

/**
 * Terms that have no index are checked against at most SCAN_LIMIT candidates: the newest events the
 * search covers (its kinds, project, source, and time range) that match its indexed terms.
 */
export const SCAN_LIMIT = 25_000;

/** How a term is matched: `long` (3+ characters, trigram), `cjk` (1–2 CJK letters), `short` (other). */
export type TermKind = 'long' | 'cjk' | 'short';

export interface QueryTerm {
  text: string;
  kind: TermKind;
}

/** Split a query into distinct terms (case-insensitively) and classify them. */
export function parseQuery(query: string): QueryTerm[] {
  const seen = new Set<string>();
  const terms: QueryTerm[] = [];
  for (const text of query.split(/\s+/u)) {
    if (text.length === 0 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const kind: TermKind = [...text].length >= 3 ? 'long' : isCjkTerm(text) ? 'cjk' : 'short';
    terms.push({ text, kind });
  }
  return terms;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** FTS5 query for phrases that must all occur (a trigram index finds each one exactly). */
export function phraseQuery(terms: QueryTerm[]): string {
  return terms.map((t) => quote(t.text)).join(' AND ');
}

/** Trigrams used per term against event_fts; a subset still filters, and the text check is exact. */
const MAX_TRIGRAMS = 24;

/**
 * FTS5 query for event_fts, which records only which events contain each trigram (detail=none) and
 * so cannot match phrases: every trigram of every term, which events containing the terms must have.
 */
function trigramQuery(terms: QueryTerm[]): string {
  const all = new Set<string>();
  for (const t of terms) {
    const chars = [...t.text];
    const grams: string[] = [];
    for (let i = 0; i + 3 <= chars.length; i++) grams.push(chars.slice(i, i + 3).join(''));
    const n = Math.min(grams.length, MAX_TRIGRAMS);
    for (let i = 0; i < n; i++) {
      all.add(grams[n === 1 ? 0 : Math.round((i * (grams.length - 1)) / (n - 1))] as string);
    }
  }
  return [...all].map(quote).join(' AND ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQL that checks that `column` contains `term`, ignoring case: LIKE for ASCII terms, instr() for
 * terms without letter case (CJK, digits, symbols), and origin_contains() otherwise.
 */
export function termCheck(column: string, term: string, params: unknown[]): string {
  if (/^[\x20-\x7e]*$/.test(term)) {
    params.push(`%${escapeLike(term)}%`);
    return `${column} LIKE ? ESCAPE '\\'`;
  }
  if (term.toLowerCase() === term.toUpperCase()) {
    params.push(term);
    return `instr(${column}, ?) > 0`;
  }
  params.push(term.toLowerCase());
  return `origin_contains(${column}, ?)`;
}

/** Excluded events by seq: computed once per query, then probed without reading the events. */
const VISIBLE_SEQ = (seq: string) =>
  `+${seq} NOT IN (SELECT ev.seq FROM excluded_event x JOIN event ev ON ev.id = x.event_id)`;

const MIN_SEQ = -Number.MAX_SAFE_INTEGER;
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

interface Plan {
  /** The FTS table that drives the query, or null to read the event table newest first. */
  table: 'message_fts' | 'event_fts' | 'event_cjk' | null;
  match: string | null;
  /** CJK index query that the driving index's matches must also satisfy. */
  cjk: string | null;
  /** Terms that the driving index matches only roughly, checked against the text (event_fts). */
  verify: string[];
  /** Terms without an index, checked against the text of the candidates. */
  checks: string[];
  /** Kinds to filter on, when the driving index does not already. */
  kinds: EventKind[] | null;
  /** Whether the driving index gives a BM25 score. */
  scored: boolean;
  /** Whether at most SCAN_LIMIT candidates are read (some term has no index). */
  capped: boolean;
}

function plan(terms: QueryTerm[], kinds: EventKind[] | undefined): Plan | null {
  const long = terms.filter((t) => t.kind === 'long');
  const cjk = terms.filter((t) => t.kind === 'cjk');
  const checks = terms.filter((t) => t.kind === 'short').map((t) => t.text);
  const capped = checks.length > 0;
  const onlyMessages = !!kinds && kinds.length > 0 && kinds.every((k) => k === 'message');
  const kindFilter = kinds && kinds.length > 0 ? kinds : null;
  const cjkQuery = (ts: QueryTerm[]) => ts.map((t) => cjkTermQuery(t.text)).join(' AND ');
  if (long.length > 0) {
    const cjkFilter = cjk.length > 0 ? cjkQuery(cjk) : null;
    if (onlyMessages) {
      return {
        table: 'message_fts',
        match: phraseQuery(long),
        cjk: cjkFilter,
        verify: [],
        checks,
        kinds: null,
        scored: true,
        capped,
      };
    }
    return {
      table: 'event_fts',
      match: trigramQuery(long),
      cjk: cjkFilter,
      // A 3-character term is a single trigram, which event_fts matches exactly.
      verify: long.filter((t) => [...t.text].length > 3).map((t) => t.text),
      checks,
      kinds: kindFilter,
      scored: true,
      capped,
    };
  }
  if (cjk.length > 0) {
    return {
      table: 'event_cjk',
      match: onlyMessages ? `${cjkQuery(cjk)} AND ${CJK_MESSAGE_TOKEN}` : cjkQuery(cjk),
      cjk: null,
      verify: [],
      checks,
      kinds: onlyMessages ? null : kindFilter,
      scored: false,
      capped,
    };
  }
  if (checks.length > 0) {
    const scan = { table: null, match: null, cjk: null, verify: [], checks, kinds: kindFilter };
    return { ...scan, scored: false, capped: true };
  }
  return null;
}

/** A candidate as read: its seq and timestamp, and whether it passed the checks. */
interface Hit {
  seq: number;
  ts: number;
  pass: boolean;
}

interface Row {
  seq: number;
  ts: number;
  pass: number;
  text?: string;
}

interface Need {
  /** How many passing hits to return, newest first. */
  count: number;
  /** A check on the text that a hit must also pass (the text is read only for it). */
  accept?: (text: string) => boolean;
  /** Read at most SCAN_LIMIT candidates even if the plan does not require it. */
  capped?: boolean;
}

/**
 * What makes an event a candidate besides the indexed terms: the filters on its columns (source,
 * project, session, kinds) and, for event_fts, the terms its trigrams only roughly match.
 */
function candidateFilters(p: Plan, f: EventFilter, params: unknown[]): string[] {
  const parts: string[] = [];
  if (f.source) {
    parts.push('e.source = ?');
    params.push(f.source);
  }
  if (f.project) {
    parts.push('e.project = ?');
    params.push(f.project);
  }
  if (f.sessionId) {
    parts.push('e.session_id = ?');
    params.push(f.sessionId);
  }
  if (p.kinds) {
    parts.push(`e.kind IN (${p.kinds.map(() => '?').join(', ')})`);
    params.push(...p.kinds);
  }
  for (const term of p.verify) parts.push(termCheck('e.text', term, params));
  return parts;
}

/** `pass`: whether a candidate's text holds the terms that have no index. */
function passColumn(p: Plan, params: unknown[]): string {
  const checks = p.checks.map((t) => termCheck('e.text', t, params));
  return checks.length > 0 ? `(${checks.join(' AND ')})` : '1';
}

/**
 * SQL reading the candidates of an index-driven plan between two seqs (bound last), latest arrival
 * first: seq, ts, and `pass`.
 */
function rangeQuery(
  p: Plan,
  f: EventFilter,
  need: Need,
): { sql: string; params: (lo: number, hi: number) => unknown[] } {
  const table = p.table as string;
  const selectParams: unknown[] = [];
  const pass = passColumn(p, selectParams);
  const filterParams: unknown[] = [];
  const filters = candidateFilters(p, f, filterParams);
  const row = filters.length > 0 || pass !== '1' || !!need.accept;
  const ts = row ? 'e.ts' : 'x.ts';
  const columns = ['f.rowid AS seq', `${ts} AS ts`, `${pass} AS pass`];
  if (need.accept) columns.push('e.text AS text');
  // The index stays the outer loop (CROSS JOIN). An event is read only to filter or check it;
  // otherwise its timestamp comes from the narrow (seq, ts) index.
  const join = row
    ? 'CROSS JOIN event e ON e.seq = f.rowid'
    : 'CROSS JOIN event x INDEXED BY event_seq_ts ON x.seq = f.rowid';
  const conditions: string[] = [];
  const whereParams: unknown[] = [];
  if (p.cjk) {
    conditions.push('+f.rowid IN (SELECT rowid FROM event_cjk WHERE event_cjk MATCH ?)');
    whereParams.push(p.cjk);
  }
  if (f.since !== undefined) {
    conditions.push(`${ts} >= ?`);
    whereParams.push(f.since);
  }
  if (f.until !== undefined) {
    conditions.push(`${ts} <= ?`);
    whereParams.push(f.until);
  }
  conditions.push(...filters);
  whereParams.push(...filterParams);
  const sql = `SELECT ${columns.join(', ')} FROM ${table} f ${join}
    WHERE ${table} MATCH ? AND f.rowid BETWEEN ? AND ? AND ${VISIBLE_SEQ('f.rowid')}
    ${conditions.map((c) => `AND ${c}`).join(' ')}
    ORDER BY f.rowid DESC`;
  return { sql, params: (lo, hi) => [...selectParams, p.match, lo, hi, ...whereParams] };
}

/**
 * SQL reading the candidates of a plan without an index, newest first: the newest SCAN_LIMIT
 * events that pass the filters, in the time range, with `pass`.
 */
function scanQuery(p: Plan, f: EventFilter, need: Need): { sql: string; params: unknown[] } {
  const selectParams: unknown[] = [];
  const pass = passColumn(p, selectParams);
  const whereParams: unknown[] = [];
  const where = [VISIBLE_SEQ('e.seq'), ...candidateFilters(p, f, whereParams)];
  if (f.since !== undefined) {
    where.push('e.ts >= ?');
    whereParams.push(f.since);
  }
  if (f.until !== undefined) {
    where.push('e.ts <= ?');
    whereParams.push(f.until);
  }
  const text = need.accept ? ', e.text AS text' : '';
  return {
    sql: `SELECT e.seq AS seq, e.ts AS ts, ${pass} AS pass${text} FROM event e
          WHERE ${where.join(' AND ')} ORDER BY e.ts DESC, e.seq DESC LIMIT ${SCAN_LIMIT}`,
    params: [...selectParams, ...whereParams],
  };
}

const newestFirst = (a: Hit, b: Hit) => b.ts - a.ts || b.seq - a.seq;

/**
 * The newest `need.count` passing hits, by timestamp (ties: the later arrival first), among the
 * newest SCAN_LIMIT candidates when capped. Exact whatever order events arrived in.
 */
function newest(db: Database, p: Plan, f: EventFilter, need: Need): Hit[] {
  const capped = p.capped || need.capped === true;
  const cap = capped ? SCAN_LIMIT : Number.POSITIVE_INFINITY;
  const hits: Hit[] = [];
  const take = (r: Row) => {
    const pass = r.pass === 1 && (!need.accept || need.accept(r.text as string));
    hits.push({ seq: r.seq, ts: r.ts, pass });
  };
  if (!p.table) {
    // Read in time order already: stop at the first `need.count` passing events.
    const q = scanQuery(p, f, need);
    let passing = 0;
    for (const r of db.prepare(q.sql).iterate(...(q.params as never[])) as Iterable<Row>) {
      take(r);
      if ((hits.at(-1) as Hit).pass && ++passing === need.count) break;
    }
    return select(hits, need.count, cap);
  }
  const q = rangeQuery(p, f, need);

  // Few matches: read them all, in any order.
  const few = Math.max(5 * need.count, 2_000);
  const count = db.prepare(
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${p.table} WHERE ${p.table} MATCH ? LIMIT ?)`,
  );
  if ((count.get(p.match, few + 1) as { n: number }).n <= few) {
    const all = db.prepare(q.sql).iterate(...(q.params(MIN_SEQ, MAX_SEQ) as never[]));
    for (const r of all as Iterable<Row>) take(r);
    return select(hits, need.count, cap);
  }

  // Many matches: read the chains of blocks newest first, each with its own stream, always from the
  // chain that may still hold the newest unread hit, until no chain can hold one newer than those
  // needed (or older than the time range allows).
  const chains = chainsOf(
    db
      .prepare('SELECT block, max_ts FROM event_block ORDER BY block DESC')
      .all() as unknown as Block[],
  );
  const floor = f.since ?? Number.NEGATIVE_INFINITY;
  let cut = Number.NEGATIVE_INFINITY;
  let counted = 0;
  // The cutoff is recomputed as hits accumulate; a stale one is lower, which only means reading a
  // little more.
  const refresh = () => {
    const grown = hits.length - counted;
    if (hits.length >= Math.min(need.count, cap) && grown >= Math.max(64, counted / 4)) {
      cut = cutoff(hits, need.count, cap);
      counted = hits.length;
    }
  };
  try {
    for (;;) {
      let chain: Chain | null = null;
      for (const c of chains) if (!chain || c.bound() > chain.bound()) chain = c;
      if (!chain || chain.bound() < Math.max(cut, floor)) break;
      // Read this chain until the rest of it may no longer hold the newest unread hit.
      chain.rows ??= db
        .prepare(q.sql)
        .iterate(...(q.params(chain.lo, chain.hi) as never[]))
        [Symbol.iterator]() as Iterator<Row>;
      const bound = chain.bound();
      while (chain.bound() >= bound && chain.bound() >= Math.max(cut, floor)) {
        const r = chain.next();
        if (!r) break;
        take(r);
        refresh();
      }
    }
    return select(hits, need.count, cap);
  } finally {
    for (const c of chains) c.rows?.return?.();
  }
}

/** A block of 4,096 consecutive arrivals (event_block): its number and latest timestamp. */
interface Block {
  block: number;
  max_ts: number;
}

/** Arrivals are grouped by block: seq >> BLOCK_BITS (see the event_block trigger). */
const BLOCK_BITS = 12;

/** A block this much newer than the chain above it starts a new chain. */
const CHAIN_JUMP_MS = 86_400_000;

/** More chains than this are read as one, from the latest arrival down. */
const MAX_CHAINS = 16;

/**
 * A range of consecutive blocks read by one stream, latest arrival first. `bound()` is the latest
 * timestamp any unread hit of the chain can have: the latest of the blocks it has not passed yet.
 */
interface Chain {
  lo: number;
  hi: number;
  rows: Iterator<Row> | null;
  bound(): number;
  /** The next hit, or null at the end. */
  next(): Row | null;
}

/**
 * Split the blocks (latest arrival first) into chains where an older arrival is much newer, as when
 * old sessions arrived after newer ones. Within a chain, the stream then meets hits roughly from
 * the newest, and the chains are merged by their bounds.
 */
function chainsOf(blocks: Block[]): Chain[] {
  const groups: Block[][] = [];
  let oldest = Number.POSITIVE_INFINITY;
  for (const b of blocks) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && b.block === prev.block - 1 && b.max_ts <= oldest + CHAIN_JUMP_MS) {
      last.push(b);
      oldest = Math.min(oldest, b.max_ts);
    } else {
      groups.push([b]);
      oldest = b.max_ts;
    }
  }
  if (groups.length > MAX_CHAINS) groups.splice(0, groups.length, blocks);
  return groups.map((g) => chain(g));
}

function chain(blocks: Block[]): Chain {
  // suffix[i]: the latest timestamp in blocks i and below.
  const suffix = new Array<number>(blocks.length);
  let latest = Number.NEGATIVE_INFINITY;
  for (let i = blocks.length - 1; i >= 0; i--) {
    latest = Math.max(latest, (blocks[i] as Block).max_ts);
    suffix[i] = latest;
  }
  let at = 0;
  let pending: Row | null = null;
  let done = false;
  const c: Chain = {
    lo: (blocks.at(-1) as Block).block * 2 ** BLOCK_BITS,
    hi: ((blocks[0] as Block).block + 1) * 2 ** BLOCK_BITS - 1,
    rows: null,
    bound: () => (done ? Number.NEGATIVE_INFINITY : (suffix[at] as number)),
    next() {
      if (!pending && c.rows) {
        const r = c.rows.next();
        if (r.done) done = true;
        else pending = r.value;
      }
      if (!pending) return null;
      const block = Math.floor(pending.seq / 2 ** BLOCK_BITS);
      const before = at;
      while (at < blocks.length - 1 && (blocks[at] as Block).block > block) at++;
      if (at !== before && (suffix[at] as number) < (suffix[before] as number)) return null;
      const r = pending;
      pending = null;
      return r;
    },
  };
  return c;
}

/** The timestamp below which no further candidate can change the result. */
function cutoff(hits: Hit[], count: number, cap: number): number {
  hits.sort(newestFirst);
  let cut = Number.NEGATIVE_INFINITY;
  if (hits.length >= cap) cut = (hits[cap - 1] as Hit).ts;
  let passing = 0;
  for (let i = 0; i < hits.length && i < cap; i++) {
    const hit = hits[i] as Hit;
    if (hit.pass && ++passing === count) return Math.max(cut, hit.ts);
  }
  return cut;
}

function select(hits: Hit[], count: number, cap: number): Hit[] {
  hits.sort(newestFirst);
  const out: Hit[] = [];
  for (let i = 0; i < hits.length && i < cap && out.length < count; i++) {
    const hit = hits[i] as Hit;
    if (hit.pass) out.push(hit);
  }
  return out;
}

/**
 * BM25 scores of the hits, in one query: bm25() computes its statistics over the whole index once
 * per query, so the hits are read without it.
 */
function scores(db: Database, p: Plan, hits: Hit[]): Map<number, number> {
  if (hits.length === 0) return new Map();
  const seqs = hits.map((h) => h.seq);
  const rows = db
    .prepare(
      `SELECT f.rowid AS seq, bm25(${p.table}) AS score FROM ${p.table} f
       WHERE ${p.table} MATCH ? AND f.rowid BETWEEN ? AND ?
         AND +f.rowid IN (SELECT value FROM json_each(?))`,
    )
    .all(p.match, Math.min(...seqs), Math.max(...seqs), JSON.stringify(seqs)) as unknown as Array<{
    seq: number;
    score: number;
  }>;
  return new Map(rows.map((r) => [r.seq, r.score]));
}

/**
 * Full-text search over visible events. By default the newest RANK_WINDOW matches are ranked by
 * BM25 (best first; ties newest first); `order: 'recent'`, and queries without a term of three or
 * more characters, give the newest first: by timestamp, and among equal timestamps, the later
 * arrival first.
 */
export function searchEvents(db: Database, query: string, filter: SearchOptions = {}): SearchHit[] {
  const terms = parseQuery(query);
  const p = plan(terms, filter.kinds);
  if (!p) return [];
  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;
  const ranked = p.scored && filter.order !== 'recent';
  let hits = newest(db, p, filter, { count: ranked ? RANK_WINDOW : offset + limit });
  if (ranked) {
    const score = scores(db, p, hits);
    hits.sort((a, b) => (score.get(a.seq) ?? 0) - (score.get(b.seq) ?? 0) || newestFirst(a, b));
  }
  hits = hits.slice(offset, offset + limit);
  if (hits.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}, e.seq AS seq FROM event e
       WHERE e.seq IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(hits.map((h) => h.seq))) as unknown as Array<
    RawEventRecord & { seq: number }
  >;
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const words = terms.map((t) => t.text);
  return hits.map((h) => {
    const r = bySeq.get(h.seq) as RawEventRecord;
    return { ...toEventRow(r), snippet: snippetOf(r.text, words) };
  });
}

/**
 * The id of the newest visible event of `kind` that matches the query's terms and whose text
 * `accept` takes, among at most the newest SCAN_LIMIT candidates, so that a miss costs a bounded
 * number of reads.
 */
export function findNewest(
  db: Database,
  query: string,
  kind: EventKind,
  accept: (text: string) => boolean,
): string | null {
  const p = plan(parseQuery(query), [kind]);
  if (!p) return null;
  const [hit] = newest(db, p, {}, { count: 1, accept, capped: true });
  if (!hit) return null;
  return (db.prepare('SELECT id FROM event WHERE seq = ?').get(hit.seq) as { id: string }).id;
}

const SNIPPET_LENGTH = 200;
const SNIPPET_LEAD = 60;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A window of the text around the first match of any term, with matches in brackets and `…` where
 * the text was cut.
 */
export function snippetOf(text: string, terms: string[]): string {
  const pattern = terms.length > 0 ? terms.map(escapeRegExp).join('|') : null;
  let start = 0;
  if (pattern) {
    const first = new RegExp(pattern, 'iu').exec(text);
    if (first) start = Math.max(0, first.index - SNIPPET_LEAD);
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  if (start > 0 && /[\udc00-\udfff]/.test(text.charAt(start))) start--;
  if (end < text.length && /[\ud800-\udbff]/.test(text.charAt(end - 1))) end--;
  let body = text.slice(start, end);
  if (pattern) body = body.replace(new RegExp(pattern, 'giu'), (m) => `[${m}]`);
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * Rebuild everything search derives from the events and entries: the external-content indexes from
 * their content, the contentless CJK index from scratch, and the blocks. Results do not change; this
 * only repairs.
 */
export function rebuildSearchIndexes(db: Database): void {
  transaction(
    db,
    () => {
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
    },
    { immediate: true },
  );
}
