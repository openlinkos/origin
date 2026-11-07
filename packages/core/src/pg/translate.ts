/**
 * SQL written for SQLite, translated for PostgreSQL, and what it does. Origin's queries are written
 * once, in SQL both engines accept where possible; what differs only mechanically is rewritten here,
 * outside strings, quoted identifiers, and comments:
 *
 * - `?` becomes `$1`, `$2`, … in order;
 * - `LIKE` becomes `ILIKE` (SQLite's LIKE ignores ASCII case, as ILIKE does under the C ctype that
 *   a PostgreSQL store requires);
 * - `instr(` becomes `strpos(` (the same arguments, in the same order);
 * - SQLite's planner hints go: `INDEXED BY <index>` and `NOT INDEXED`, and `CROSS JOIN`, which
 *   SQLite reads as an inner join that keeps the join order, becomes `JOIN` when an `ON` or `USING`
 *   clause follows it (PostgreSQL allows none after CROSS JOIN).
 *
 * Each statement is classified as a read, a write (INSERT, UPDATE, or DELETE anywhere in it,
 * including inside WITH), DDL, or transaction control, which the PostgreSQL client needs to take
 * the store's lock and to run transactions as SQLite does. Fragments written for PostgreSQL may be
 * part of the text as long as they take their parameters as `?`: `::`, `->>`, and `@>` pass through,
 * as do dollar-quoted strings (but not the jsonb operators `?`, `?|`, and `?&`).
 *
 * Pure: no database is needed. Translator keeps the results of the latest TRANSLATIONS_KEPT texts
 * and, in test mode, refuses SQL that still holds what PostgreSQL does not have (see forbiddenIn).
 */

/** What a statement does, as the client needs to know to lock and to run it. */
export type StatementKind = 'read' | 'write' | 'ddl' | 'transaction' | 'other';

/** A transaction control statement, in SQLite's forms. */
export type TransactionControl =
  | { op: 'begin'; mode: 'deferred' | 'immediate' | 'exclusive' }
  | { op: 'commit' }
  | { op: 'rollback' }
  | { op: 'savepoint'; name: string }
  | { op: 'rollback to'; name: string }
  | { op: 'release'; name: string };

export interface Translation {
  /** The SQL for PostgreSQL. */
  readonly sql: string;
  /** How many parameters it takes: `$1` to `$params`. */
  readonly params: number;
  /** How many statements it holds (more than one only for `exec`). */
  readonly statements: number;
  /**
   * What it does: for several statements, the most of them (DDL, then a write, then another kind,
   * then a read). Transaction control is always a statement of its own.
   */
  readonly kind: StatementKind;
  /** The transaction control statement, when `kind` is 'transaction'. */
  readonly control?: TransactionControl;
}

/** SQL that cannot be translated, or (in test mode) that holds what PostgreSQL does not have. */
export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslateError';
  }
}

/** How many translations a Translator keeps. */
export const TRANSLATIONS_KEPT = 2_000;

type TokenType = 'space' | 'comment' | 'string' | 'quoted' | 'word' | 'number' | 'param' | 'symbol';

interface Token {
  type: TokenType;
  text: string;
}

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;
const DOLLAR_TAG = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u;
const SYMBOLS = ['->>', '::', '->', '@>', '<@', '||', '<=', '>=', '<>', '!=', '==', '<<', '>>'];

/**
 * Split SQL into tokens, whitespace and comments included, so that joining them gives it back.
 * Parameters are `?` in SQLite SQL, and `$1`, `$2`, … in `translated` SQL.
 */
function tokenize(sql: string, translated = false): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (type: TokenType, end: number) => {
    tokens.push({ type, text: sql.slice(i, end) });
    i = end;
  };
  /** The end of a string that starts with `quote` at `start`; `backslash` escapes in E'...'. */
  const quoted = (start: number, quote: string, backslash = false): number => {
    for (let j = start + 1; j < sql.length; j++) {
      const c = sql[j];
      if (backslash && c === '\\') j++;
      else if (c === quote) {
        if (sql[j + 1] !== quote) return j + 1;
        j++;
      }
    }
    throw new TranslateError(`unterminated ${quote === '"' ? 'identifier' : 'string'}: ${sql}`);
  };
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      let end = i + 1;
      while (end < sql.length && /\s/.test(sql[end] as string)) end++;
      push('space', end);
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      push('comment', end === -1 ? sql.length : end);
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      push('comment', end === -1 ? sql.length : end + 2);
    } else if (c === "'") {
      push('string', quoted(i, "'"));
    } else if (c === '"') {
      push('quoted', quoted(i, '"'));
    } else if (c === '?') {
      if (/\d/.test(next ?? '')) {
        throw new TranslateError(`numbered parameters (?NNN) are not supported: ${sql}`);
      }
      push('param', i + 1);
    } else if (c === '$' && translated && /\d/.test(next ?? '')) {
      let end = i + 1;
      while (end < sql.length && /\d/.test(sql[end] as string)) end++;
      push('param', end);
    } else if (c === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (!tag) throw new TranslateError(`parameters other than ? are not supported: ${sql}`);
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new TranslateError(`unterminated dollar-quoted string: ${sql}`);
      push('string', end + tag.length);
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(next ?? ''))) {
      push('number', i + (NUMBER.exec(sql.slice(i))?.[0].length ?? 1));
    } else if (WORD_START.test(c)) {
      let end = i + 1;
      while (end < sql.length && WORD_PART.test(sql[end] as string)) end++;
      const word = sql.slice(i, end);
      // E'…' holds backslash escapes; X'…' is a blob in SQLite (and a bit string in PostgreSQL).
      if (sql[end] === "'" && /^[EeXx]$/.test(word)) {
        push('string', quoted(end, "'", /[Ee]/.test(word)));
      } else {
        push('word', end);
      }
    } else {
      const symbol = SYMBOLS.find((s) => sql.startsWith(s, i));
      push('symbol', i + (symbol?.length ?? 1));
    }
  }
  return tokens;
}

const significant = (t: Token) => t.type !== 'space' && t.type !== 'comment';
const upper = (t: Token | undefined) => (t?.type === 'word' ? t.text.toUpperCase() : null);
const isSymbol = (t: Token | undefined, s: string) => t?.type === 'symbol' && t.text === s;
/** A replacement keyword in the case of the one it replaces. */
const sameCase = (was: string, word: string) =>
  was === was.toUpperCase() ? word.toUpperCase() : word.toLowerCase();

/** Words that end a join's table, subquery, or function and its alias. */
const JOIN_END = new Set([
  'JOIN',
  'CROSS',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'NATURAL',
  'WHERE',
  'GROUP',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'HAVING',
  'WINDOW',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'RETURNING',
]);

/**
 * Whether the join that starts at significant token `from` (after CROSS JOIN) has an ON or USING
 * clause: the first of them, or of what ends the join, at its own depth of parentheses.
 */
function joinHasCondition(tokens: Token[], sig: number[], from: number): boolean {
  let depth = 0;
  for (let k = from; k < sig.length; k++) {
    const t = tokens[sig[k] as number] as Token;
    if (t.type === 'symbol') {
      if (t.text === '(') depth++;
      else if (t.text === ')') {
        if (depth === 0) return false;
        depth--;
      } else if (depth === 0 && (t.text === ',' || t.text === ';')) return false;
      continue;
    }
    if (depth > 0) continue;
    const w = upper(t);
    if (w === 'ON') return upper(tokens[sig[k + 1] as number]) !== 'CONFLICT';
    if (w === 'USING') return true;
    if (w && JOIN_END.has(w)) return false;
  }
  return false;
}

/** Drop tokens `from` to `to` (inclusive), and the whitespace before them if `before`. */
function drop(tokens: Token[], from: number, to: number, before: boolean): void {
  for (let i = from; i <= to; i++) {
    const t = tokens[i] as Token;
    if (t.type !== 'comment') t.text = '';
  }
  if (before && tokens[from - 1]?.type === 'space') (tokens[from - 1] as Token).text = '';
}

/** The rewrites; returns the number of parameters. */
function rewrite(tokens: Token[], sig: number[]): number {
  let params = 0;
  const at = (k: number) => tokens[sig[k] as number];
  for (let k = 0; k < sig.length; k++) {
    const t = at(k) as Token;
    if (t.type === 'param') {
      t.text = `$${++params}`;
      continue;
    }
    switch (upper(t)) {
      case 'INDEXED':
        if (upper(at(k + 1)) === 'BY' && /^(word|quoted)$/.test(at(k + 2)?.type ?? '')) {
          drop(tokens, sig[k] as number, sig[k + 2] as number, true);
          k += 2;
        }
        break;
      case 'NOT':
        if (upper(at(k + 1)) === 'INDEXED' && upper(at(k + 2)) !== 'BY') {
          drop(tokens, sig[k] as number, sig[k + 1] as number, true);
          k += 1;
        }
        break;
      case 'CROSS':
        if (upper(at(k + 1)) === 'JOIN' && joinHasCondition(tokens, sig, k + 2)) {
          drop(tokens, sig[k] as number, (sig[k + 1] as number) - 1, false);
        }
        break;
      case 'LIKE':
        t.text = sameCase(t.text, 'ILIKE');
        break;
      case 'INSTR':
        if (isSymbol(at(k + 1), '(') && !isSymbol(at(k - 1), '.')) {
          t.text = sameCase(t.text, 'strpos');
        }
        break;
    }
  }
  return params;
}

/** Split significant tokens into statements at `;`, minding the bodies of SQLite triggers. */
function split(tokens: Token[], sig: number[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let trigger = false;
  let body = 0;
  for (const i of sig) {
    const t = tokens[i] as Token;
    if (isSymbol(t, ';') && body === 0) {
      if (current.length > 0) statements.push(current);
      current = [];
      trigger = false;
      continue;
    }
    const w = upper(t);
    if (w === 'TRIGGER' && upper(current[0]) === 'CREATE') trigger = true;
    else if (trigger && (w === 'BEGIN' || w === 'CASE')) body++;
    else if (trigger && w === 'END') body--;
    current.push(t);
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

const READS = new Set(['SELECT', 'VALUES', 'WITH', 'TABLE', 'EXPLAIN']);
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'TRUNCATE']);
const DDL = new Set([
  'CREATE',
  'DROP',
  'ALTER',
  'REINDEX',
  'ANALYZE',
  'VACUUM',
  'GRANT',
  'REVOKE',
  'COMMENT',
]);
const CONTROL = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

/** Parse a transaction control statement. */
function control(statement: Token[], sql: string): TransactionControl {
  const words = statement.map((t) => (t.type === 'word' ? t.text.toUpperCase() : t.text));
  const name = (k: number) => {
    const t = statement[k];
    if (statement.length !== k + 1 || (t?.type !== 'word' && t?.type !== 'quoted')) return null;
    return t.text;
  };
  let k = 1;
  const optional = (word: string) => {
    if (words[k] === word) k++;
  };
  let found: TransactionControl | null = null;
  switch (words[0]) {
    case 'BEGIN': {
      const mode = words[k];
      let m: 'deferred' | 'immediate' | 'exclusive' = 'deferred';
      if (mode === 'DEFERRED' || mode === 'IMMEDIATE' || mode === 'EXCLUSIVE') {
        m = mode.toLowerCase() as typeof m;
        k++;
      }
      optional('TRANSACTION');
      if (k === words.length) found = { op: 'begin', mode: m };
      break;
    }
    case 'COMMIT':
    case 'END':
      optional('TRANSACTION');
      if (k === words.length) found = { op: 'commit' };
      break;
    case 'ROLLBACK': {
      optional('TRANSACTION');
      if (k === words.length) {
        found = { op: 'rollback' };
        break;
      }
      if (words[k] !== 'TO') break;
      k++;
      optional('SAVEPOINT');
      const n = name(k);
      if (n) found = { op: 'rollback to', name: n };
      break;
    }
    case 'SAVEPOINT': {
      const n = name(k);
      if (n) found = { op: 'savepoint', name: n };
      break;
    }
    case 'RELEASE': {
      optional('SAVEPOINT');
      const n = name(k);
      if (n) found = { op: 'release', name: n };
      break;
    }
  }
  if (!found) throw new TranslateError(`unknown transaction statement: ${sql}`);
  return found;
}

const RANK: Record<StatementKind, number> = {
  read: 0,
  other: 1,
  write: 2,
  ddl: 3,
  transaction: 4,
};

function classify(statement: Token[]): StatementKind {
  const first = upper(statement[0]) ?? (isSymbol(statement[0], '(') ? 'SELECT' : null);
  if (first === null) return 'other';
  if (CONTROL.has(first)) return 'transaction';
  if (DDL.has(first)) return 'ddl';
  if (WRITES.has(first)) return 'write';
  if (!READS.has(first)) return 'other';
  const writes = statement.some((t) => {
    const w = upper(t);
    return w === 'INSERT' || w === 'UPDATE' || w === 'DELETE';
  });
  return writes ? 'write' : 'read';
}

/** Translate SQLite SQL for PostgreSQL (see the top of this file). */
export function translate(sql: string): Translation {
  const tokens = tokenize(sql);
  const sig: number[] = [];
  tokens.forEach((t, i) => {
    if (significant(t)) sig.push(i);
  });
  const statements = split(tokens, sig);
  const kinds = statements.map(classify);
  let kind: StatementKind = 'other';
  let controlled: TransactionControl | undefined;
  if (kinds.includes('transaction')) {
    if (statements.length > 1) {
      throw new TranslateError(`transaction control must be a statement of its own: ${sql}`);
    }
    kind = 'transaction';
    controlled = control(statements[0] as Token[], sql);
  } else if (kinds.length > 0) {
    kind = kinds.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  }
  const params = rewrite(tokens, sig);
  return {
    sql: tokens.map((t) => t.text).join(''),
    params,
    statements: statements.length,
    kind,
    ...(controlled ? { control: controlled } : {}),
  };
}

/** SQLite's functions that PostgreSQL does not have (or has with another meaning). */
const SQLITE_FUNCTIONS = new Set([
  'json_extract',
  'json_each',
  'json_tree',
  'json_group_array',
  'json_group_object',
  'group_concat',
  'julianday',
  'datetime',
  'strftime',
  'unixepoch',
  'ifnull',
  'iif',
  'printf',
  'typeof',
  'total',
  'randomblob',
  'zeroblob',
  'hex',
  'instr',
  'last_insert_rowid',
  'changes',
  'total_changes',
  'sqlite_version',
  'likelihood',
  'likely',
  'unlikely',
  'bm25',
  'highlight',
  'snippet',
  'origin_cjk',
  'origin_prompt',
  'raise',
]);

/** Words that are SQLite's alone, wherever they are. */
const SQLITE_WORDS = new Set([
  'PRAGMA',
  'MATCH',
  'GLOB',
  'REGEXP',
  'SQLITE_MASTER',
  'SQLITE_SCHEMA',
  'SQLITE_TEMP_MASTER',
  'INDEXED',
]);

/** What may follow IS in PostgreSQL. */
const IS_OPERAND = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'UNKNOWN',
  'DISTINCT',
  'JSON',
  'DOCUMENT',
  'NORMALIZED',
]);

/** Whether IS, or IS NOT, is followed by what PostgreSQL allows after it (not a value). */
function isOperand(sig: Token[], k: number): boolean {
  const w = upper(sig[upper(sig[k]) === 'NOT' ? k + 1 : k]);
  return w !== null && IS_OPERAND.has(w);
}

/** What ends the pattern of a LIKE (or its ESCAPE clause). */
const PATTERN_END = new Set([
  'AND',
  'OR',
  'THEN',
  'WHEN',
  'ELSE',
  'END',
  'WHERE',
  'GROUP',
  'ORDER',
  'LIMIT',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'ON',
  'JOIN',
  'RETURNING',
]);

/**
 * What translated SQL still holds that PostgreSQL does not have, or reads otherwise: SQLite's
 * statements, functions, and syntax (FTS5's MATCH, INSERT OR, LIMIT -1, WITHOUT ROWID, PRAGMA, and
 * so on), an `IS` comparison with a value, MAX or MIN of several arguments, blob literals, and LIKE
 * patterns whose backslashes PostgreSQL would read as escapes (a pattern that is not a literal must
 * name its ESCAPE character). Empty when there is nothing; strings, quoted identifiers, and
 * comments are not looked at.
 */
export function forbiddenIn(sql: string): string[] {
  const tokens = tokenize(sql, true);
  const found: string[] = [];
  for (const t of tokens) {
    if (t.type === 'comment' && t.text.startsWith('/*') && t.text.indexOf('/*', 2) !== -1) {
      found.push('a comment inside a comment');
    }
    if (t.type === 'string' && /^[Xx]'/.test(t.text)) found.push(`blob literal ${t.text}`);
  }
  const sig = tokens.filter(significant);
  for (let k = 0; k < sig.length; k++) {
    const problem = problemAt(sig, k);
    if (problem) found.push(problem);
  }
  return found;
}

/** What is wrong for PostgreSQL with the word at significant token `k`, if anything. */
function problemAt(sig: Token[], k: number): string | null {
  const t = sig[k] as Token;
  const w = upper(t);
  if (w === null) return null;
  const next = upper(sig[k + 1]);
  const before = sig[k - 1];
  if (w === 'INSERT' && next === 'OR') return 'INSERT OR';
  if (w === 'REPLACE' && next === 'INTO' && upper(before) !== 'OR') return 'REPLACE INTO';
  if (w === 'WITHOUT' && next === 'ROWID') return 'WITHOUT ROWID';
  if (w === 'LIMIT' && isSymbol(sig[k + 1], '-')) return 'LIMIT -1';
  if (w === 'IS' && !isOperand(sig, k + 1)) return `IS ${sig[k + 1]?.text ?? ''}`;
  if (SQLITE_WORDS.has(w)) return w;
  if (w === 'LIKE' || w === 'ILIKE') return likePattern(sig, k + 1);
  if (!isSymbol(sig[k + 1], '(')) return null;
  const name = t.text.toLowerCase();
  if (SQLITE_FUNCTIONS.has(name)) return `${name}(`;
  // char(n) is a type in PostgreSQL, and a function in SQLite.
  if (name === 'char' && upper(before) !== 'AS' && !isSymbol(before, '::')) return 'char(';
  if ((w === 'MAX' || w === 'MIN') && arguments_(sig, k + 1) > 1) return `${w}(a, b)`;
  return null;
}

/** How many arguments the call whose `(` is at `open` has. */
function arguments_(sig: Token[], open: number): number {
  let depth = 0;
  let count = 1;
  for (let k = open; k < sig.length; k++) {
    const t = sig[k] as Token;
    if (isSymbol(t, '(')) depth++;
    else if (isSymbol(t, ')') && --depth === 0) return count;
    else if (depth === 1 && isSymbol(t, ',')) count++;
  }
  return count;
}

/** What is wrong with the pattern of a LIKE that starts at `from`, if anything. */
function likePattern(sig: Token[], from: number): string | null {
  let depth = 0;
  let literal = true;
  let backslash = false;
  for (let k = from; k < sig.length; k++) {
    const t = sig[k] as Token;
    if (isSymbol(t, '(')) depth++;
    else if (isSymbol(t, ')')) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (isSymbol(t, ',') || isSymbol(t, ';'))) break;
    const w = upper(t);
    if (depth === 0 && w === 'ESCAPE') return null;
    if (depth === 0 && w && PATTERN_END.has(w)) break;
    if (t.type === 'string') backslash ||= t.text.includes('\\');
    else if (t.type !== 'symbol') literal = false;
  }
  if (!literal) return 'LIKE pattern without ESCAPE';
  if (backslash) return 'LIKE pattern with a backslash and no ESCAPE';
  return null;
}

/**
 * Translations, the latest TRANSLATIONS_KEPT of them kept by their SQLite text. In test mode
 * (`check`), SQL that still holds what PostgreSQL does not have (see forbiddenIn) is refused.
 */
export class Translator {
  private readonly kept = new Map<string, Translation>();
  private readonly size: number;
  private readonly check: boolean;

  constructor(opts: { size?: number; check?: boolean } = {}) {
    this.size = opts.size ?? TRANSLATIONS_KEPT;
    this.check = opts.check ?? false;
  }

  translate(sql: string): Translation {
    const kept = this.kept.get(sql);
    if (kept) {
      // The latest used goes last, so the least recently used is first.
      this.kept.delete(sql);
      this.kept.set(sql, kept);
      return kept;
    }
    const t = translate(sql);
    if (this.check) {
      const found = forbiddenIn(t.sql);
      if (found.length > 0) {
        throw new TranslateError(`not for PostgreSQL (${[...new Set(found)].join(', ')}): ${sql}`);
      }
    }
    this.kept.set(sql, t);
    if (this.kept.size > this.size) this.kept.delete(this.kept.keys().next().value as string);
    return t;
  }
}
