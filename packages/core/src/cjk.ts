/**
 * The CJK index (see docs/architecture.md#search-and-timeline). A trigram index cannot find terms
 * of one or two characters, and in Chinese and Japanese most words are that short. The CJK index
 * holds, for each event with CJK text, every pair of adjacent CJK letters and the last letter of
 * each run of them, so that a two-letter term is one token and a one-letter term is a prefix.
 */

/** A letter of a script written without spaces between words: Han, kana, or Hangul. */
const CJK_LETTER = '(?=\\p{L})[\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}]';
const CJK_RUN = new RegExp(`(?:${CJK_LETTER})+`, 'gu');
const CJK_TERM = new RegExp(`^(?:${CJK_LETTER})+$`, 'u');

/** Token added to the CJK index text of message events, so that message searches need no join. */
export const CJK_MESSAGE_TOKEN = 'msg';

/** Whether a term is made only of CJK letters. */
export function isCjkTerm(term: string): boolean {
  return CJK_TERM.test(term);
}

/**
 * The CJK index text of an event: its CJK bigrams and run-final letters, space-separated (the
 * index uses the `ascii` tokenizer, which keeps non-ASCII text as is), or null if it has no CJK
 * letters. Deterministic; registered on every connection as `origin_cjk(text, kind)`.
 */
export function cjkIndexText(text: string, kind: string): string | null {
  const runs = text.match(CJK_RUN);
  if (!runs) return null;
  const tokens = new Set<string>();
  for (const run of runs) {
    const letters = [...run];
    for (let i = 0; i + 1 < letters.length; i++) tokens.add(`${letters[i]}${letters[i + 1]}`);
    tokens.add(letters[letters.length - 1] as string);
  }
  if (kind === 'message') tokens.add(CJK_MESSAGE_TOKEN);
  return [...tokens].join(' ');
}

/** The CJK index query for a term of one or two CJK letters: the bigram, or the letter as a prefix. */
export function cjkTermQuery(term: string): string {
  return [...term].length === 1 ? `"${term}" *` : `"${term}"`;
}
