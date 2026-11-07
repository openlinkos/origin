/**
 * BM25 as SQLite's FTS5 computes it in its bm25() function (ext/fts5/fts5_aux.c), for search
 * indexes that do not compute it themselves: the same constants, the same floor on the IDF, the
 * same order of operations, and the same sign. Lower scores are better, so ranking sorts ascending,
 * as it does with bm25().
 *
 *   score = -Σ idf_i · f_i·(k1 + 1) / (f_i + k1·(1 - b + b·D/avgdl))
 *   idf_i = ln((N - n_i + 0.5) / (n_i + 0.5)), raised to 1e-6 when it is zero or negative
 *
 * The caller supplies the statistics. For Origin's trigram indexes (tokenize = 'trigram', which
 * folds case and emits every run of three characters), as FTS5 counts them, and as the parity test
 * (core/test/bm25.test.ts) pins them against FTS5:
 *
 * - a phrase is a query term (message_fts, entry_fts), or one of the trigrams the query selects
 *   (event_fts, detail = none);
 * - N is the number of rows in the index (every event; only messages for message_fts), and avgdl
 *   their total length divided by N;
 * - D, a row's length, is its number of trigrams: its length in characters (code points, not UTF-16
 *   units) less two, and never below zero;
 * - n_i is the number of rows the phrase matches on its own, over the whole index;
 * - f_i is the number of times the phrase occurs in the row's case-folded text, overlapping
 *   occurrences included ("aaa" occurs three times in "aaaaa"). This holds for event_fts too:
 *   detail = none keeps no positions, so bm25() tokenizes the row's text again to find them.
 */

/** k1, which bounds how much repeating a phrase adds. */
export const BM25_K1 = 1.2;

/** b, how much a row's length relative to the average weakens its matches. */
export const BM25_B = 0.75;

/** The IDF of a phrase that half the rows or more match. */
export const BM25_MIN_IDF = 1e-6;

/** The statistics of a query over a whole index, as bm25() computes them once per query. */
export interface Bm25Stats {
  /** N: rows in the index. */
  docs: number;
  /** avgdl: the average length of a row, in tokens (the total over the index divided by N). */
  avgdl: number;
  /** n_i: for each phrase of the query, in order, how many rows match it. */
  hits: readonly number[];
}

/**
 * The score of one row: `freq` holds f_i, how often each phrase occurs in the row (in the order of
 * `hits`), and `length` is D, the row's length in tokens.
 */
export type Bm25Scorer = (freq: readonly number[], length: number) => number;

/** The IDF of a phrase that `hits` of `docs` rows match. */
export function bm25Idf(docs: number, hits: number): number {
  const idf = Math.log((docs - hits + 0.5) / (hits + 0.5));
  return idf <= 0 ? BM25_MIN_IDF : idf;
}

/** Score rows of a query: the IDFs are computed once, then each row costs one pass over `freq`. */
export function bm25Scorer(stats: Bm25Stats): Bm25Scorer {
  const idf = stats.hits.map((n) => bm25Idf(stats.docs, n));
  const { avgdl } = stats;
  return (freq, length) => {
    if (freq.length !== idf.length) {
      throw new RangeError(`bm25: ${freq.length} frequencies for ${idf.length} phrases`);
    }
    // Written as fts5Bm25Function writes it, so that rounding is the same.
    let score = 0.0;
    for (let i = 0; i < idf.length; i++) {
      const f = freq[i] as number;
      score +=
        (idf[i] as number) *
        ((f * (BM25_K1 + 1.0)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgdl)));
    }
    return -1.0 * score;
  };
}
