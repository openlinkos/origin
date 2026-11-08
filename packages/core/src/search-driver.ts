import type { SqlRow } from './database.js';
import { projectEventSql, resolvedProjectSql } from './places.js';
import type { EventFilter } from './store.js';
import type { EventKind } from './types.js';

/**
 * What a search index driver is (see search.ts): the SQL that drives an index, counts its matches,
 * and scores them, which differs between SQLite's FTS5 (search-fts5.ts) and PostgreSQL. A query's
 * plan, the order it reads in, and when it stops are the same on both; this module holds them and
 * the SQL both drivers share.
 */

/** How a term is matched: `long` (3+ characters, trigram), `cjk` (1–2 CJK letters), `short` (other). */
export type TermKind = 'long' | 'cjk' | 'short';

export interface QueryTerm {
  text: string;
  kind: TermKind;
}

/** Trigrams used per term against the trigram index of every event; a subset still filters. */
const MAX_TRIGRAMS = 24;

/**
 * The trigrams of the terms that an event matching them must contain, as written (each engine
 * folds their case): up to MAX_TRIGRAMS per term, spread evenly over it, the first and the last
 * included; distinct.
 */
export function termTrigrams(terms: QueryTerm[]): string[] {
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
  return [...all];
}

/** The index that drives a query (see search.ts). */
export type IndexKind = 'message' | 'event' | 'cjk';

export interface Plan {
  /**
   * The index that drives the query: `message` (message events, each term matched exactly, BM25),
   * `event` (every event, by trigrams, then checked against the text; BM25 over the trigrams),
   * `cjk` (CJK terms of one or two letters, no BM25), or null to read the event table newest first.
   */
  index: IndexKind | null;
  /** The terms of three or more characters, which the message or event index matches. */
  long: QueryTerm[];
  /** CJK terms of one or two letters: what the cjk index matches, or a filter on the others' matches. */
  cjk: QueryTerm[];
  /** For the cjk index: whether it matches message events alone. */
  messages: boolean;
  /** Terms that the driving index matches only roughly, checked against the text (event index). */
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

export interface Row {
  seq: number;
  ts: number;
  /** Whether the event passes the filters that need its row: a candidate. */
  cand: number;
  pass: number;
  text?: string;
}

export interface Need {
  /** How many passing hits to return, newest first. */
  count: number;
  /** A check on the text that a hit must also pass (the text is read only for it). */
  accept?: (text: string) => boolean;
  /** Read at most SCAN_LIMIT candidates even if the plan does not require it. */
  capped?: boolean;
}

/** The SQL of one query's index: its matches, how many there are, and their scores. */
export interface IndexDriver {
  /** How many events the index matches, counting at most `cap` of them. */
  countMatches(cap: number): number;
  /**
   * Every match, in any order: seq, ts, `cand`, and `pass` (see Row). `projectSet`: the filter's
   * project is matched through its events rather than checked on each match's row.
   */
  all(f: EventFilter, need: Need, projectSet: boolean): Iterable<Row>;
  /** A reader of the matches between two seqs (inclusive), latest arrival first. */
  stream(
    f: EventFilter,
    need: Need,
    projectSet: boolean,
  ): (lo: number, hi: number) => Iterator<Row>;
  /** The BM25 scores of the events by seq (lower is better), for a scored plan. */
  scores(seqs: number[]): Map<number, number>;
}

/** An entry search by terms of three or more characters (see searchEntries). */
export interface EntryQuery {
  /** The terms of three or more characters, each matched exactly. */
  long: QueryTerm[];
  /** `SELECT … FROM entry en …`, its columns including `text`, to which the WHERE clause is added. */
  select: string;
  /** The conditions on entries besides the terms', as SQL; it adds their parameters to `params`. */
  where: (params: unknown[]) => string;
  limit: number;
  offset: number;
}

/** A search engine's indexes: of events, of entries, and how they are rebuilt. */
export interface SearchDriver {
  events(p: Plan): IndexDriver;
  /** The rows of the matching entries, best first by BM25 (ties newest first), one page of them. */
  entries(q: EntryQuery): SqlRow[];
  /** Rebuild everything search derives from the events and entries (see rebuildSearchIndexes). */
  rebuild(): void;
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
export const VISIBLE_SEQ = (seq: string) =>
  `+${seq} NOT IN (SELECT ev.seq FROM excluded_event x JOIN event ev ON ev.id = x.event_id)`;

/** Arrivals are grouped by block: seq >> BLOCK_BITS (see the event_block trigger). */
export const BLOCK_BITS = 12;

export const MIN_SEQ = -Number.MAX_SAFE_INTEGER;
export const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * How a query checks an event's project: through the project's events, read once (`set`); for
 * each candidate, through its session's place (`row`), which reads nothing more than the row it
 * already has; or not at all, when the driving index is matched against the project already.
 */
export type ProjectCheck = 'set' | 'row' | 'none';

/**
 * What makes an event a candidate besides the indexed terms and the time range: the filters on its
 * columns (source, project unless matched by its index, session, kinds) and, for the event index,
 * the terms its trigrams only roughly match.
 */
export function candidateFilters(
  p: Plan,
  f: EventFilter,
  params: unknown[],
  project: ProjectCheck = 'set',
): string[] {
  const parts: string[] = [];
  if (f.source) {
    parts.push('e.source = ?');
    params.push(f.source);
  }
  if (f.project && project === 'set') {
    parts.push(projectEventSql('e'));
    params.push(f.project, f.project);
  } else if (f.project && project === 'row') {
    parts.push(`${resolvedProjectSql('e.source', 'e.session_id', 'e.project')} = ?`);
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
export function passColumn(p: Plan, params: unknown[]): string {
  const checks = p.checks.map((t) => termCheck('e.text', t, params));
  return checks.length > 0 ? `(${checks.join(' AND ')})` : '1';
}
