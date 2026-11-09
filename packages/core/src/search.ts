import { isCjkTerm } from './cjk.js';
import type { SqlRow } from './database.js';
import type { Database } from './db.js';
import { idList } from './dialect.js';
import { pgSearch } from './pg/search.js';
import { resolvedProjectSql } from './places.js';
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
  type TermKind,
  VISIBLE_SEQ,
} from './search-driver.js';
import { fts5Search } from './search-fts5.js';
import {
  type EventFilter,
  eventColumns,
  type RawEventRecord,
  type SearchHit,
  type SearchOptions,
  toEventRow,
} from './store.js';
import type { EventKind } from './types.js';

export { type QueryTerm, type TermKind, termCheck } from './search-driver.js';

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
 *
 * This module plans a query and decides what to read and when to stop. The SQL that drives an
 * index, counts its matches, and scores them is the store's engine's (see search-driver.ts): FTS5's
 * in search-fts5.ts, and PostgreSQL's in pg/search.ts, whose GIN indexes stand for these.
 */

/** Ranking considers the newest RANK_WINDOW matches; with more matches, older ones are not ranked. */
export const RANK_WINDOW = 2_000;

/**
 * Terms that have no index are checked against at most SCAN_LIMIT candidates: the newest events the
 * search covers (its kinds, project, source, and time range) that match its indexed terms.
 */
export const SCAN_LIMIT = 25_000;

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

/** How a search reads its terms (see Plan), or null when it has none. */
export function plan(terms: QueryTerm[], kinds: EventKind[] | undefined): Plan | null {
  const long = terms.filter((t) => t.kind === 'long');
  const cjk = terms.filter((t) => t.kind === 'cjk');
  const checks = terms.filter((t) => t.kind === 'short').map((t) => t.text);
  const capped = checks.length > 0;
  const onlyMessages = !!kinds && kinds.length > 0 && kinds.every((k) => k === 'message');
  const kindFilter = kinds && kinds.length > 0 ? kinds : null;
  if (long.length > 0) {
    if (onlyMessages) {
      return {
        index: 'message',
        long,
        cjk,
        messages: false,
        verify: [],
        checks,
        kinds: null,
        scored: true,
        capped,
      };
    }
    return {
      index: 'event',
      long,
      cjk,
      messages: false,
      // A 3-character term is a single trigram, which the event index matches exactly.
      verify: long.filter((t) => [...t.text].length > 3).map((t) => t.text),
      checks,
      kinds: kindFilter,
      scored: true,
      capped,
    };
  }
  if (cjk.length > 0) {
    return {
      index: 'cjk',
      long,
      cjk,
      messages: onlyMessages,
      verify: [],
      checks,
      kinds: onlyMessages ? null : kindFilter,
      scored: false,
      capped,
    };
  }
  if (checks.length > 0) {
    const scan = { index: null, long, cjk, messages: false, verify: [], checks, kinds: kindFilter };
    return { ...scan, scored: false, capped: true };
  }
  return null;
}

/** The search indexes of the store's engine. */
function searchDriver(db: Database): SearchDriver {
  return db.dialect === 'postgres' ? pgSearch(db) : fts5Search(db);
}

/** The SQL of a plan's index (see IndexDriver), or null for a plan without one. */
function indexOf(db: Database, p: Plan): IndexDriver | null {
  return p.index ? searchDriver(db).events(p) : null;
}

/** The rows of the entries that match an entry search by terms of three or more characters. */
export function matchingEntries(db: Database, q: EntryQuery): SqlRow[] {
  return searchDriver(db).entries(q);
}

/** A candidate as read: its seq and timestamp, and whether it passed the checks. */
interface Hit {
  seq: number;
  ts: number;
  pass: boolean;
}

/**
 * A project with at most this many events in the time range can be matched through its index (its
 * events' seqs, read once), so that a search in it does not read every match to check its project:
 * when it is a small share of the store. A larger one, a large share, or a query with few matches
 * checks the project of each match it reads instead.
 */
const PROJECT_SET_LIMIT = 100_000;

/** How many events the filter's project has in its time range, from the session aggregates. */
function projectSize(db: Database, f: EventFilter): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(event_count), 0) AS n FROM session
       WHERE ${resolvedProjectSql('session.source', 'session.session_id', 'session.project')} = ?
         AND ended_at >= ? AND started_at <= ?`,
    )
    .get(f.project ?? null, f.since ?? MIN_SEQ, f.until ?? MAX_SEQ) as { n: number };
  return row.n;
}

/**
 * SQL reading the candidates of a plan without an index, newest first: the newest SCAN_LIMIT
 * events that pass the filters, in the time range, with `pass`.
 */
function scanQuery(
  db: Database,
  p: Plan,
  f: EventFilter,
  need: Need,
): { sql: string; params: unknown[] } {
  const selectParams: unknown[] = [];
  const pass = passColumn(db.dialect, p, selectParams);
  const whereParams: unknown[] = [];
  // PostgreSQL checks each event's project: its plan for the project's set of events is a nested
  // loop comparing every pair when its statistics have not caught up with a large ingest yet.
  const project = db.dialect === 'postgres' ? 'row' : 'set';
  const where = [VISIBLE_SEQ('e.seq'), ...candidateFilters(db.dialect, p, f, whereParams, project)];
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
    sql: `SELECT e.seq AS seq, e.ts AS ts, 1 AS cand, ${pass} AS pass${text} FROM event e
          WHERE ${where.join(' AND ')} ORDER BY e.ts DESC, e.seq DESC LIMIT ${SCAN_LIMIT}`,
    params: [...selectParams, ...whereParams],
  };
}

const newestFirst = (a: Hit, b: Hit) => b.ts - a.ts || b.seq - a.seq;

/**
 * The newest `need.count` passing hits, by timestamp (ties: the later arrival first), among the
 * newest SCAN_LIMIT candidates when capped. Exact whatever order events arrived in.
 */
function newest(
  db: Database,
  p: Plan,
  index: IndexDriver | null,
  f: EventFilter,
  need: Need,
): Hit[] {
  const capped = p.capped || need.capped === true;
  const cap = capped ? SCAN_LIMIT : Number.POSITIVE_INFINITY;
  const hits: Hit[] = [];
  const take = (r: Row) => {
    if (r.cand !== 1) return;
    const pass = r.pass === 1 && (!need.accept || need.accept(r.text as string));
    hits.push({ seq: r.seq, ts: r.ts, pass });
  };
  if (!index) {
    // Read in time order already: stop at the first `need.count` passing events.
    const q = scanQuery(db, p, f, need);
    let passing = 0;
    for (const r of db.prepare(q.sql).iterate(...(q.params as never[])) as Iterable<Row>) {
      take(r);
      if (r.cand === 1 && (hits.at(-1) as Hit).pass && ++passing === need.count) break;
    }
    return select(hits, need.count, cap);
  }
  const size = f.project ? projectSize(db, f) : 0;

  // Few matches: read them all, in any order, each checked for its project, unless the project has
  // fewer events than that: those are read once instead, and the matches need no row.
  const few = Math.max(5 * need.count, 2_000);
  const matches = index.countMatches(few + 1);
  if (matches <= few) {
    for (const r of index.all(f, need, size < matches)) take(r);
    return select(hits, need.count, cap);
  }
  // With many matches, a small project is matched through its events when that reads fewer rows
  // than checking matches until enough are in it: about need.count × (all events / its events), as
  // if its share of the matches were its share of the store.
  let projectSet = false;
  if (f.project && size <= PROJECT_SET_LIMIT) {
    const total = (
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event').get() as { n: number }
    ).n;
    projectSet = need.count * total > size * size;
  }
  const stream = index.stream(f, need, projectSet);

  // Many matches: read the chains of blocks newest first, each with its own stream, always from the
  // chain that may still hold the newest unread hit, until no chain can hold one newer than those
  // needed (or older than the time range allows).
  const chains = chainsOf(
    db
      .prepare('SELECT block, max_ts FROM event_block ORDER BY block DESC')
      .all() as unknown as Block[],
    f.since,
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
      // Every chain read to its end (its bound is then -Infinity) means every match was read, even
      // when too few of them pass for a cutoff ever to be set.
      const latest = chain?.bound() ?? Number.NEGATIVE_INFINITY;
      if (!chain || latest === Number.NEGATIVE_INFINITY || latest < Math.max(cut, floor)) break;
      // Read this chain until the rest of it may no longer hold the newest unread hit.
      chain.rows ??= stream(chain.lo, chain.hi);
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
 * the newest, and the chains are merged by their bounds. A chain stops at its last block that can
 * hold an event since `since`.
 */
function chainsOf(blocks: Block[], since?: number): Chain[] {
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
  return groups.map((g) => chain(g, since ?? Number.NEGATIVE_INFINITY)).filter((c) => c !== null);
}

function chain(all: Block[], since: number): Chain | null {
  // suffix[i]: the latest timestamp in blocks i and below. Blocks below the last one whose suffix
  // reaches `since` hold only older events.
  const suffix = new Array<number>(all.length);
  let latest = Number.NEGATIVE_INFINITY;
  for (let i = all.length - 1; i >= 0; i--) {
    latest = Math.max(latest, (all[i] as Block).max_ts);
    suffix[i] = latest;
  }
  let end = all.length;
  while (end > 0 && (suffix[end - 1] as number) < since) end--;
  if (end === 0) return null;
  const blocks = all.slice(0, end);
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
  const index = indexOf(db, p);
  let hits = newest(db, p, index, filter, { count: ranked ? RANK_WINDOW : offset + limit });
  if (ranked && index) {
    const score = index.scores(hits.map((h) => h.seq));
    hits.sort((a, b) => (score.get(a.seq) ?? 0) - (score.get(b.seq) ?? 0) || newestFirst(a, b));
  }
  hits = hits.slice(offset, offset + limit);
  if (hits.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT ${eventColumns(db.dialect)}, e.seq AS seq FROM event e
       WHERE e.seq IN (${idList(db.dialect, 'bigint')})`,
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
  const [hit] = newest(db, p, indexOf(db, p), {}, { count: 1, accept, capped: true });
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
 * only repairs. In the caller's transaction if one is open (an immediate one), else in its own.
 */
export function rebuildSearchIndexes(db: Database): void {
  searchDriver(db).rebuild();
}
