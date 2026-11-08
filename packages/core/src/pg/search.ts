import { bm25Scorer } from '../bm25.js';
import { CJK_MESSAGE_TOKEN, cjkTokens } from '../cjk.js';
import type { Database, SqlRow } from '../database.js';
import { transaction } from '../db.js';
import { idList } from '../dialect.js';
import { promptTitle } from '../prompt.js';
import {
  BLOCK_BITS,
  candidateFilters,
  type EntryQuery,
  foldedSql,
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
} from '../search-driver.js';
import type { EventFilter } from '../store.js';

/**
 * The search indexes of a store in PostgreSQL (see pg/schema.ts), for the plans of search.ts, which
 * reads them as it reads FTS5's (search-fts5.ts) and gets the same results:
 *
 * - event_grams, a GIN index over the trigrams of every event's text (origin_trigrams, folded by
 *   pg_c_utf8), stands for event_fts: an event must contain the trigrams the terms select (the same
 *   ones, up to 24 a term), and is then checked against the terms (`verify`), as with event_fts.
 * - event_message_grams, the same over messages alone, stands for message_fts: the terms are then
 *   checked as substrings of the folded text in the WHERE clause, as message_fts matches phrases
 *   exactly.
 * - event_cjk, a table of each event's CJK tokens (see cjkTokens) with a GIN index, stands for
 *   FTS5's event_cjk.
 * - entry_grams stands for entry_fts.
 *
 * Terms and trigrams are folded by the server, as the indexed text is, and passed as constants, so
 * that each query is planned with what it looks for.
 *
 * A GIN index gives its matches in no order, so a stream reads them by windows of arrivals, latest
 * first: one block (4,096 arrivals), then twice as many each time, up to WINDOW_MAX, each window
 * sorted. The chains of search.ts read these as they read FTS5's streams.
 *
 * BM25 is computed here (see bm25.ts) from what FTS5 computes it from: the rows and tokens of the
 * index (event_block's counters), how many rows each phrase matches (n_i: exact up to DF_CAP, and
 * estimated beyond it), and how often each phrase occurs in each hit (f_i, counted by the server in
 * the folded text, overlapping occurrences included).
 */

/** n_i is counted exactly up to DF_CAP events, and estimated beyond (see documentFrequency). */
export const DF_CAP = 20_000;

/** The first window of a stream (one block of arrivals), and the largest. */
const WINDOW_FIRST = 4_096;
const WINDOW_MAX = 1_048_576;

/** A text[] value as PostgreSQL reads one from text: `{"a","b"}`. */
function textArray(items: readonly string[]): string {
  return `{${items.map((s) => `"${s.replace(/[\\"]/g, '\\$&')}"`).join(',')}}`;
}

/** The texts folded as the server folds the text its trigram indexes hold, in order. */
function fold(db: Database, texts: readonly string[]): string[] {
  if (texts.length === 0) return [];
  return db
    .prepare(
      `SELECT ${foldedSql('a.t')} AS t
       FROM json_array_elements_text(?::json) WITH ORDINALITY AS a (t, i) ORDER BY a.i`,
    )
    .all(JSON.stringify(texts))
    .map((r) => r.t as string);
}

/** The terms of three or more characters of a query, folded, and the trigrams they select. */
interface FoldedTerms {
  /** Each term, folded. */
  terms: string[];
  /** Each term's selected trigrams, folded and distinct. */
  grams: string[][];
  /** The trigrams of all the terms, as FTS5's event_fts query lists them (see termTrigrams), folded. */
  phrases: string[];
  /** Every trigram an event must contain, folded and distinct. */
  all: string[];
}

function foldTerms(db: Database, long: QueryTerm[]): FoldedTerms {
  const selected = termTrigrams(long);
  const folded = fold(db, [...selected, ...long.map((t) => t.text)]);
  const phrases = folded.slice(0, selected.length);
  const byTrigram = new Map(selected.map((g, i) => [g, phrases[i] as string]));
  return {
    terms: folded.slice(selected.length),
    grams: long.map((t) => [...new Set(termTrigrams([t]).map((g) => byTrigram.get(g) as string))]),
    phrases,
    all: [...new Set(phrases)],
  };
}

/** Whether a folded term is longer than the trigram that matches it exactly. */
const longerThanTrigram = (term: string) => [...term].length > 3;

/** Whether a phrase has a proper prefix that is also its suffix: its occurrences can overlap. */
function hasBorder(phrase: string): boolean {
  const c = [...phrase];
  for (let k = 1; k < c.length; k++) {
    if (c.slice(0, k).join('') === c.slice(c.length - k).join('')) return true;
  }
  return false;
}

/**
 * SQL counting the occurrences of a folded phrase in the folded text `t`, overlapping ones included:
 * by what removing it takes off the text when its occurrences cannot overlap, and otherwise as the
 * positions where it starts (a lookahead, which matches without consuming the text).
 */
function occurrencesSql(t: string, phrase: string, params: unknown[]): string {
  if (!hasBorder(phrase)) {
    params.push(phrase);
    return `(char_length(${t}) - char_length(replace(${t}, ?::text, ''))) / ${[...phrase].length}`;
  }
  params.push(`(?=${phrase.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')})`);
  return `regexp_count(${t}, ?::text)`;
}

/**
 * The occurrences of each distinct phrase in folded text `t`, as one text of numbers separated by
 * commas, and how to read a row's into the frequencies of `phrases`, in order.
 */
function frequencies(
  t: string,
  phrases: readonly string[],
  params: unknown[],
): { sql: string; read: (text: unknown) => number[] } {
  const unique = [...new Set(phrases)];
  const at = new Map(unique.map((ph, i) => [ph, i]));
  const sql = `concat_ws(',', ${unique.map((ph) => occurrencesSql(t, ph, params)).join(', ')})`;
  return {
    sql,
    read: (text) => {
      const counts = String(text).split(',').map(Number);
      return phrases.map((ph) => counts[at.get(ph) as number] as number);
    },
  };
}

/** A condition on event `e`, with its parameters. */
export interface Condition {
  sql: string;
  params: unknown[];
}

/** Events that contain the folded trigrams, through the GIN index of every event or of messages. */
const hasGrams = (grams: readonly string[]): Condition => ({
  sql: 'origin_trigrams(e.text) @> ?::text[]',
  params: [textArray(grams)],
});

/** Message events that contain a folded term (see FoldedTerms), through the index of messages. */
function messageHas(term: string, grams: readonly string[]): Condition {
  const c = hasGrams(grams);
  const exact = longerThanTrigram(term);
  return {
    sql: `e.kind = 'message' AND ${c.sql}${exact ? ` AND strpos(${foldedSql('e.text')}, ?) > 0` : ''}`,
    params: exact ? [...c.params, term] : c.params,
  };
}

/**
 * Events with the CJK tokens (see cjkTokens), looked up for each event the driving index matches:
 * as a join, the planner may compare every match with every event of the tokens.
 */
const hasTokens = (tokens: readonly string[]): Condition => ({
  sql: '(SELECT c.tokens FROM event_cjk c WHERE c.seq = e.seq) @> ?::text[]',
  params: [textArray(tokens)],
});

/** What a plan's index matches, and the phrases BM25 scores, for PostgreSQL. */
interface PgPlan {
  /**
   * What the query reads its matches from: the events (`e`), or for the cjk index, event_cjk (`c`)
   * and their events; and the seq of a match there.
   */
  from: string;
  key: string;
  /** The condition that the driving index matches, on `e` (or on `c`, for the cjk index). */
  match: Condition;
  /** The CJK tokens the driving index's matches must also have. */
  cjk: Condition | null;
  /** BM25's phrases, folded, with the condition on `e` that each matches on its own. */
  phrases: Array<{ phrase: string; match: Condition }>;
}

function pgPlan(db: Database, p: Plan): PgPlan {
  const cjk = p.cjk.map((t) => t.text);
  if (p.index === 'cjk') {
    const tokens = p.messages ? [...cjk, CJK_MESSAGE_TOKEN] : cjk;
    return {
      from: 'event_cjk c JOIN event e ON e.seq = c.seq',
      key: 'c.seq',
      match: { sql: 'c.tokens @> ?::text[]', params: [textArray(tokens)] },
      cjk: null,
      phrases: [],
    };
  }
  const t = foldTerms(db, p.long);
  const cjkFilter = cjk.length > 0 ? hasTokens(cjk) : null;
  if (p.index === 'message') {
    const exact = t.terms.filter(longerThanTrigram);
    return {
      from: 'event e',
      key: 'e.seq',
      match: {
        sql: `e.kind = 'message' AND ${hasGrams(t.all).sql}${exact.map(() => ` AND strpos(${foldedSql('e.text')}, ?) > 0`).join('')}`,
        params: [textArray(t.all), ...exact],
      },
      cjk: cjkFilter,
      phrases: t.terms.map((phrase, i) => ({
        phrase,
        match: messageHas(phrase, t.grams[i] as string[]),
      })),
    };
  }
  return {
    from: 'event e',
    key: 'e.seq',
    match: hasGrams(t.all),
    cjk: cjkFilter,
    phrases: t.phrases.map((phrase) => ({ phrase, match: hasGrams([phrase]) })),
  };
}

const VISIBLE =
  'e.seq NOT IN (SELECT ev.seq FROM excluded_event x JOIN event ev ON ev.id = x.event_id)';

/** Where a range query's parameters take the bounds of its window. */
const LO = Symbol('lo');
const HI = Symbol('hi');

/** The index of one plan (see IndexDriver). */
function eventIndex(db: Database, plan: Plan, dfCap: number): IndexDriver {
  const p = pgPlan(db, plan);
  // Read at once, not through a cursor: a window or a few matches are bounded, and a cursor is
  // planned to return its first rows fast, by plans that can take far longer to return them all.
  const read = (sql: string, params: unknown[]) =>
    db.prepare(sql).all(...(params as never[])) as unknown as Row[];

  /**
   * As rangeQuery in search-fts5.ts: the matches between two seqs when `windowed`, or else all of
   * them, latest arrival first.
   */
  function rangeQuery(
    f: EventFilter,
    need: Need,
    projectSet: boolean,
    windowed: boolean,
  ): { sql: string; params: (lo: number, hi: number) => unknown[] } {
    const selectParams: unknown[] = [];
    const projectByIndex = !!f.project && projectSet;
    const filters = candidateFilters(
      'postgres',
      plan,
      f,
      selectParams,
      projectByIndex ? 'none' : 'row',
    );
    const cand = filters.length > 0 ? `(${filters.join(' AND ')})` : '1';
    const pass = passColumn('postgres', plan, selectParams);
    const columns = [`${p.key} AS seq`, 'e.ts AS ts', `${cand} AS cand`, `${pass} AS pass`];
    if (need.accept) columns.push('e.text AS text');
    const whereParams: unknown[] = [];
    // A window's seqs; none for all the matches, so that the planner never reads every event of
    // the range to compute their trigrams when, its statistics behind, it expects few.
    const between = (column: string): string => {
      if (!windowed) return '';
      whereParams.push(LO, HI);
      return ` AND ${column} BETWEEN ? AND ?`;
    };
    const conditions: string[] = [`${p.match.sql}${between(p.key)}`, VISIBLE];
    if (p.cjk) {
      conditions.push(p.cjk.sql);
      whereParams.push(...p.cjk.params);
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
    if (projectByIndex) {
      // As in search-fts5.ts: events of unplaced sessions by their project, placed ones by their
      // session's, of the window alone. IS TRUE keeps the set a hashed subplan, read once, rather
      // than a join, which the planner makes a nested loop comparing every pair when statistics
      // have not caught up with a large ingest yet.
      whereParams.push(f.project);
      const unplaced = `${between('pe.seq')}${range('pe.ts')}`;
      whereParams.push(f.project);
      const placed = `${between('pe.seq')}${range('pe.ts')}`;
      conditions.push(`(e.seq IN (
        SELECT pe.seq FROM event pe
         WHERE pe.project = ?${unplaced} AND NOT EXISTS (
           SELECT 1 FROM session_place sp WHERE sp.source = pe.source AND sp.session_id = pe.session_id)
        UNION ALL
        SELECT pe.seq FROM event pe
          JOIN session_place sp ON sp.source = pe.source AND sp.session_id = pe.session_id
         WHERE sp.project = ?${placed})) IS TRUE`);
    }
    const inRange = range('e.ts');
    if (inRange) conditions.push(inRange.slice(' AND '.length));
    const sql = `SELECT ${columns.join(', ')} FROM ${p.from}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${p.key} DESC`;
    return {
      sql,
      params: (lo, hi) => [
        ...selectParams,
        ...p.match.params,
        ...whereParams.map((v) => (v === LO ? lo : v === HI ? hi : v)),
      ],
    };
  }

  /** The matches of a query between two seqs, a window at a time from the latest arrival down. */
  function* windows(
    q: ReturnType<typeof rangeQuery>,
    lo: number,
    hi: number,
  ): Generator<Row, void, undefined> {
    let size = WINDOW_FIRST;
    for (let top = hi; top >= lo; ) {
      const bottom = Math.max(lo, top - size + 1);
      yield* read(q.sql, q.params(bottom, top));
      top = bottom - 1;
      size = Math.min(size * 2, WINDOW_MAX);
    }
  }

  return {
    countMatches(cap) {
      // event_cjk alone, for the cjk index: each of its rows is an event's.
      const from = p.key === 'c.seq' ? 'event_cjk c' : p.from;
      const n = db
        .prepare(
          `SELECT count(*) AS n FROM (SELECT 1 FROM ${from} WHERE ${p.match.sql} LIMIT ?) AS m`,
        )
        .get(...(p.match.params as never[]), cap) as { n: number };
      return Number(n.n);
    },
    all(f, need, projectSet) {
      const q = rangeQuery(f, need, projectSet, false);
      return read(q.sql, q.params(MIN_SEQ, MAX_SEQ));
    },
    stream(f, need, projectSet) {
      const q = rangeQuery(f, need, projectSet, true);
      return (lo, hi) => windows(q, lo, hi);
    },
    scores(seqs) {
      if (seqs.length === 0 || p.phrases.length === 0) return new Map();
      const messages = plan.index === 'message';
      const stats = indexStats(db, messages);
      const n = new Map<string, number>();
      for (const { phrase, match } of p.phrases) {
        if (!n.has(phrase)) n.set(phrase, documentFrequency(db, match, stats, dfCap));
      }
      const phrases = p.phrases.map((ph) => ph.phrase);
      const score = bm25Scorer({
        docs: stats.docs,
        avgdl: stats.tokens / stats.docs,
        hits: phrases.map((ph) => n.get(ph) as number),
      });
      const params: unknown[] = [];
      const freq = frequencies('h.t', phrases, params);
      const rows = db
        .prepare(
          `SELECT e.seq AS seq, greatest(char_length(e.text) - 2, 0) AS d, ${freq.sql} AS f
           FROM event e CROSS JOIN LATERAL (SELECT ${foldedSql('e.text')} AS t) AS h
           WHERE e.seq IN (${idList('postgres', 'bigint')})`,
        )
        .all(...(params as never[]), JSON.stringify(seqs));
      return new Map(rows.map((r) => [Number(r.seq), score(freq.read(r.f), Number(r.d))]));
    },
  };
}

/** What BM25 knows of an index as a whole: its rows (N), its tokens, and its blocks of arrivals. */
export interface IndexStats {
  docs: number;
  tokens: number;
  /** The blocks that hold any of its rows, latest first, with how many. */
  blocks: Array<{ block: number; docs: number }>;
  /** Whether it is the index of messages alone. */
  messages: boolean;
}

/** The totals of the events' index, or the messages', from event_block (as FTS5 keeps them). */
export function indexStats(db: Database, messages: boolean): IndexStats {
  const docs = messages ? 'message_docs' : 'docs';
  const tokens = messages ? 'message_tokens' : 'tokens';
  const blocks = db
    .prepare(
      `SELECT block, ${docs} AS docs, ${tokens} AS tokens FROM event_block
       WHERE ${docs} > 0 ORDER BY block DESC`,
    )
    .all() as unknown as Array<{ block: number; docs: number; tokens: number }>;
  let total = 0;
  let length = 0;
  for (const b of blocks) {
    total += Number(b.docs);
    length += Number(b.tokens);
  }
  return {
    docs: total,
    tokens: length,
    blocks: blocks.map((b) => ({ block: Number(b.block), docs: Number(b.docs) })),
    messages,
  };
}

/**
 * n_i: how many events of the index a phrase matches on its own, counted over windows of the
 * latest blocks: exact if they come to all of it before more than `cap` are counted; otherwise
 * scaled to the whole index by the share of its rows those blocks hold. A phrase that common has an
 * IDF near zero anyway, and counting it all would read every one of its events. Each window reads
 * the phrase's whole posting list again, so after the first block the next window is as large as
 * should hold the rest at the density counted so far, and never less than twice the last one.
 */
export function documentFrequency(
  db: Database,
  match: Condition,
  stats: IndexStats,
  cap = DF_CAP,
): number {
  const window = db.prepare(
    `SELECT count(*) AS n FROM event e WHERE ${match.sql} AND e.seq BETWEEN ? AND ?`,
  );
  const { blocks } = stats;
  let counted = 0;
  let covered = 0;
  let at = 0;
  let size = 1;
  while (at < blocks.length && counted <= cap) {
    const part = blocks.slice(at, at + size);
    const lo = (part.at(-1) as { block: number }).block * 2 ** BLOCK_BITS;
    const hi = ((part[0] as { block: number }).block + 1) * 2 ** BLOCK_BITS - 1;
    counted += Number(
      (window.get(...(match.params as never[]), lo, hi) as { n: number } | undefined)?.n ?? 0,
    );
    for (const b of part) covered += b.docs;
    at += part.length;
    // The rows the rest should take at this density, with a quarter more.
    const wanted = counted > 0 ? (((cap + 1 - counted) * covered) / counted) * 1.25 : 0;
    let next = 0;
    for (let rows = 0; at + next < blocks.length && rows < wanted; next++) {
      rows += (blocks[at + next] as { docs: number }).docs;
    }
    size = Math.max(next, size * 2);
  }
  return at >= blocks.length ? counted : (counted * stats.docs) / covered;
}

/**
 * Entries matching every term as a substring of their folded text, through entry_grams, ranked in
 * TypeScript by BM25 with exact statistics over every entry (entries are few), as entry_fts ranks
 * them: best first, ties newest first.
 */
function entries(db: Database, q: EntryQuery): SqlRow[] {
  const t = foldTerms(db, q.long);
  const params: unknown[] = [];
  const freq = frequencies('h.t', t.terms, params);
  const exact = t.terms.filter(longerThanTrigram);
  params.push(textArray(t.all), ...exact);
  const where = q.where(params);
  const rows = db
    .prepare(
      `SELECT m.*, greatest(char_length(m.text) - 2, 0) AS bm25_length, ${freq.sql} AS bm25_freq
       FROM (${q.select}
             WHERE origin_trigrams(en.text) @> ?::text[]${exact.map(() => ` AND strpos(${foldedSql('en.text')}, ?) > 0`).join('')}
               AND ${where}) AS m
       CROSS JOIN LATERAL (SELECT ${foldedSql('m.text')} AS t) AS h`,
    )
    .all(...(params as never[]));
  if (rows.length === 0) return [];
  const stats = db
    .prepare(
      `SELECT count(*) AS docs, coalesce(sum(greatest(char_length(text) - 2, 0)), 0) AS tokens
       FROM entry`,
    )
    .get() as { docs: number; tokens: number };
  const docs = Number(stats.docs);
  const hits = t.terms.map((term, i) => {
    const grams = t.grams[i] as string[];
    const check = longerThanTrigram(term) ? ` AND strpos(${foldedSql('en.text')}, ?) > 0` : '';
    const n = db
      .prepare(
        `SELECT count(*) AS n FROM entry en WHERE origin_trigrams(en.text) @> ?::text[]${check}`,
      )
      .get(textArray(grams), ...(check ? [term] : [])) as { n: number };
    return Number(n.n);
  });
  const score = bm25Scorer({ docs, avgdl: Number(stats.tokens) / docs, hits });
  const ranked = rows.map((r) => {
    const { bm25_length, bm25_freq, ...row } = r;
    return { row, score: score(freq.read(bm25_freq), Number(bm25_length)) };
  });
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.row.created_at) - Number(a.row.created_at) ||
      (String(b.row.id) < String(a.row.id) ? -1 : String(b.row.id) > String(a.row.id) ? 1 : 0),
  );
  return ranked.slice(q.offset, q.offset + q.limit).map((r) => r.row);
}

/** Whether an event reads as a prompt of a user, for event_prompt (see isPrompt in dialect.ts). */
const isPromptEvent = (role: string, kind: string, text: string) =>
  role === 'user' && kind === 'message' && promptTitle(text) !== null;

/** The text as the store keeps it: PostgreSQL's text holds no U+0000, which the client replaces. */
const stored = (text: string) => (text.includes('\0') ? text.replaceAll('\0', '�') : text);

/**
 * What PostgreSQL keeps of an event that SQLite computes in functions of the connection: its CJK
 * tokens in event_cjk and, for a user message that reads as a prompt, its row in event_prompt.
 * Returns the writer for events just inserted, by seq.
 */
export function eventDerivations(
  db: Database,
): (seq: number, ev: { role: string; kind: string; text: string }) => void {
  const cjk = db.prepare("INSERT INTO event_cjk (seq, tokens) VALUES (?, string_to_array(?, ' '))");
  const prompt = db.prepare('INSERT INTO event_prompt (seq) VALUES (?)');
  return (seq, ev) => {
    const text = stored(ev.text);
    const tokens = cjkTokens(text, ev.kind);
    if (tokens) cjk.run(seq, tokens.join(' '));
    if (isPromptEvent(ev.role, ev.kind, text)) prompt.run(seq);
  };
}

/** How many derived rows are written at once by rebuild. */
const REBUILD_BATCH = 1_000;

/**
 * Rebuild what search derives from the events: event_cjk and event_prompt from every event's text,
 * and event_block with its counters. The GIN indexes keep themselves.
 */
function rebuild(db: Database): void {
  transaction(
    db,
    () => {
      db.exec('DELETE FROM event_cjk');
      db.exec('DELETE FROM event_prompt');
      const cjk = db.prepare(
        `INSERT INTO event_cjk (seq, tokens)
         SELECT (r ->> 0)::bigint, string_to_array(r ->> 1, ' ') FROM json_array_elements(?::json) AS r`,
      );
      const prompt = db.prepare(`INSERT INTO event_prompt (seq) ${idList('postgres', 'bigint')}`);
      let tokens: Array<[number, string]> = [];
      let prompts: number[] = [];
      const flush = () => {
        if (tokens.length > 0) cjk.run(JSON.stringify(tokens));
        if (prompts.length > 0) prompt.run(JSON.stringify(prompts));
        tokens = [];
        prompts = [];
      };
      const events = db
        .prepare('SELECT seq, role, kind, text FROM event ORDER BY seq')
        .iterate() as Iterable<{ seq: number; role: string; kind: string; text: string }>;
      for (const e of events) {
        const t = cjkTokens(e.text, e.kind);
        if (t) tokens.push([Number(e.seq), t.join(' ')]);
        if (isPromptEvent(e.role, e.kind, e.text)) prompts.push(Number(e.seq));
        if (tokens.length >= REBUILD_BATCH || prompts.length >= REBUILD_BATCH) flush();
      }
      flush();
      db.exec('DELETE FROM event_block');
      db.exec(`INSERT INTO event_block
          (block, max_ts, latest_ts, docs, tokens, message_docs, message_tokens)
        SELECT block, max_ts, max(max_ts) OVER (ORDER BY block ROWS UNBOUNDED PRECEDING),
               docs, tokens, message_docs, message_tokens
        FROM (SELECT seq >> 12 AS block, max(ts) AS max_ts, count(*) AS docs,
                     sum(greatest(char_length(text) - 2, 0)) AS tokens,
                     count(*) FILTER (WHERE kind = 'message') AS message_docs,
                     coalesce(sum(greatest(char_length(text) - 2, 0))
                       FILTER (WHERE kind = 'message'), 0) AS message_tokens
              FROM event GROUP BY 1) AS b`);
    },
    { immediate: true },
  );
}

/** The search indexes of a store in PostgreSQL, with n_i exact up to `dfCap` events. */
export function pgSearch(db: Database, dfCap = DF_CAP): SearchDriver {
  return {
    events: (p) => eventIndex(db, p, dfCap),
    entries: (q) => entries(db, q),
    rebuild: () => rebuild(db),
  };
}
