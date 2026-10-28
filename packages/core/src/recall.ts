import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { CURRENT_VERSION, type EntryKind } from './entries.js';
import { storeName } from './identity.js';
import { getEvent, sessionPrompts, VISIBLE_EVENT } from './store.js';
import type { EventRow } from './types.js';

/**
 * Recall (see docs/architecture.md#recall): what Origin hands an agent without being asked, and the
 * record of each time it does. No model is called; relevance comes in layers.
 *
 * - Scope: the session's project, the git work tree of its working directory (or the directory),
 *   told apart from another of the same name by the directories entries and sessions record.
 *   Memory and knowledge of another project are never handed over; cognition (the user's
 *   preferences, methods, goals, and boundaries) can be, when a prompt matches it.
 * - At the start of a session, a brief: cognition (this project's, then that of no project), this
 *   project's latest memory and knowledge, and its latest sessions with any agent.
 * - With a prompt: the entries whose first line it matches, scored with BM25 over words weighed by
 *   how rarely the user says them, above a threshold, leaving out what the session was handed
 *   since its last brief.
 * - Entries imported from an agent's own memory files for this project are not handed back to that
 *   agent, which loads those files itself.
 * - One line per item, within a token budget: the agent asks for the rest with `get`.
 */

export const RECALL_OCCASIONS = ['start', 'prompt', 'request'] as const;
/** When a recall happens: a session starts, the user sends a prompt, or an agent asks. */
export type RecallOccasion = (typeof RECALL_OCCASIONS)[number];

export type RecallLayer = 'cognition' | 'project' | 'sessions' | 'prompt';

/** Default token budgets: a brief, what a prompt adds, and a brief an agent asks for. */
export const RECALL_BUDGET: Record<RecallOccasion, number> = {
  start: 800,
  prompt: 400,
  request: 1200,
};

/** Most items per layer. */
const LAYER_MAX: Record<RecallLayer, number> = { cognition: 5, project: 5, sessions: 3, prompt: 5 };

/** An item's summary is cut to this many tokens. */
const SUMMARY_TOKENS = 40;

/** Sessions that ended longer ago than this are left out of a brief. */
const SESSION_MAX_AGE_MS = 30 * 86_400_000;

export interface RecallInput {
  occasion: RecallOccasion;
  /** The agent (source id) the recall is for, when known. */
  source?: string | null;
  /** The agent's session id, when known. */
  sessionId?: string | null;
  /** The session's working directory. */
  cwd?: string | null;
  /** The top of the git work tree that holds `cwd`, if any: what is in it is the project's. */
  root?: string | null;
  /** The project's name, as the archive names projects: the last segment of `root` or `cwd`. */
  project?: string | null;
  /** The user's prompt (`prompt`), or what an agent asks about (`request`, optional). */
  prompt?: string | null;
  /** Token budget; RECALL_BUDGET by default. */
  budget?: number;
  now?: number;
}

export interface RecallItem {
  rank: number;
  layer: RecallLayer;
  kind: 'entry' | 'session';
  /** An entry id, or `<source>:<session id>`. */
  ref: string;
  /** The prompt's BM25 score for the entry (prompt items only). */
  score: number | null;
  /** The line handed to the agent. */
  line: string;
  tokens: number;
}

export interface RecallPlan {
  occasion: RecallOccasion;
  source: string | null;
  sessionId: string | null;
  cwd: string | null;
  root: string | null;
  project: string | null;
  prompt: string | null;
  at: number;
  budget: number;
  /** The estimated tokens of the whole text, header included; 0 when there is nothing to hand. */
  tokens: number;
  items: RecallItem[];
}

/** Where CJK and full-width characters start (CJK Radicals Supplement). */
const WIDE = 0x2e80;

/**
 * A rough count of the tokens a text costs an agent: one per CJK letter or full-width symbol, one
 * per four other characters. Deterministic, so that budgets are the same on every machine.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) as number) >= WIDE) wide++;
    else narrow++;
  }
  return Math.ceil(wide + narrow / 4);
}

/** The text cut to at most `max` tokens, with `…` where it was cut. */
function cutTokens(text: string, max: number): string {
  if (estimateTokens(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (estimateTokens(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return `${out}…`;
}

/** An entry's first line with text, without Markdown heading or emphasis marks; '' if none. */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) return line;
  }
  return '';
}

/** An entry's one-line summary: its first line, cut to SUMMARY_TOKENS. */
export function entrySummary(text: string): string {
  return cutTokens(firstLine(text), SUMMARY_TOKENS);
}

const STOP_WORDS = new Set(
  `a about after again all also am an and any are as at be because been before being but by can
  could did do does doing done for from get got had has have having he her here him his how i if in
  into is it its just let lets like me more most my no not now of off ok okay on once only or other
  our out over please same she should so some such than that the their them then there these they
  this those through to too try under until up us very was we were what when where which while who
  why will with would yes you your
  一下 一个 一些 一样 一点 一起 不是 不用 不要 之类 他们 以及 以后 但是 你们 其他 可以 可能 因为 如何 如果 好的 就是
  已经 希望 帮我 并且 应该 当前 怎么 我们 所以 所有 时候 是否 有没有 没有 然后 现在 比较 这个 这些 这样 这种 这里
  进行 那个 那些 那种 需要 非常 麻烦 看看 知道 继续 自己 觉得 还是 更加 直接 目前 请你 什么 为什么 不需要 进一步
  是不是 能不能 怎么样 它们`.split(/\s+/),
);

/** Word segmentation for CJK text, from the platform (ICU). */
const WORDS = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * The terms of a text for recall, with repeats, lowercased and without stop words, as the platform
 * (ICU) segments it into words: words outside CJK split at anything but letters, digits, and `_`,
 * of two characters or more (numbers of three digits or more); CJK words as they are, except that a
 * run of one-letter words, which the segmenter leaves where it knows no word, gives the pairs of
 * adjacent letters.
 */
export function recallTerms(text: string): string[] {
  return tokenize(text).terms;
}

/** recallTerms, and which of them are only pairs of one-letter words: guesses at a word. */
function tokenize(text: string): { terms: string[]; guessed: Set<string> } {
  const terms: string[] = [];
  const words = new Set<string>();
  const guessed = new Set<string>();
  const add = (t: string, guess = false) => {
    if (STOP_WORDS.has(t)) return;
    terms.push(t);
    if (guess) guessed.add(t);
    else words.add(t);
  };
  let singles: string[] = [];
  const pairs = () => {
    for (let i = 0; i + 1 < singles.length; i++) add(`${singles[i]}${singles[i + 1]}`, true);
    singles = [];
  };
  for (const s of WORDS.segment(text.toLowerCase())) {
    const word = s.segment;
    if (s.isWordLike && (word.codePointAt(0) as number) >= WIDE) {
      if ([...word].length === 1) singles.push(word);
      else {
        pairs();
        add(word);
      }
      continue;
    }
    pairs();
    if (!s.isWordLike) continue;
    if (/^[a-z0-9_]+$/.test(word)) {
      if (word.length >= 2 && !(word.length < 3 && /^\d+$/.test(word))) add(word);
      continue;
    }
    // A name such as linkos.io or v0.3.0 counts as a whole as well as in parts.
    if (word.length <= 64) add(word);
    for (const part of word.match(/[\p{L}\p{N}_]+/gu) ?? []) {
      if (part.length >= 2 && !(part.length < 3 && /^\d+$/.test(part))) add(part);
    }
  }
  pairs();
  for (const t of words) guessed.delete(t);
  return { terms, guessed };
}

/** Only the start of a long prompt (a pasted log, say) is read. */
const PROMPT_CHARS = 4_000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Evidence a match needs: the weights of the distinct query terms the entry holds, summed, must
 * exceed this multiple of the largest weight a term can have. At 1, no term is enough alone: two
 * rare terms, or several common ones.
 */
export const RECALL_EVIDENCE = 1;
/** What a term of the query found only as a pair of one-letter words counts for. */
const GUESS_WEIGHT = 0.5;
/** A match also needs at least this share of the best match's score. */
export const RECALL_RELATIVE = 0.4;

/**
 * How much a term says: its inverse document frequency over a corpus of the user's own words (their
 * latest prompts) and the entries' first lines, so that what the user says all the time weighs
 * little, whatever the entries hold.
 */
export interface TermWeights {
  weight(term: string): number;
  /** The weight of a term found in one document of the corpus, or none. */
  max: number;
}

export function termWeights(corpus: string[]): TermWeights {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    for (const t of new Set(recallTerms(doc))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = corpus.length;
  const idf = (k: number) => Math.log(1 + (n - k + 0.5) / (k + 0.5));
  return { weight: (t) => idf(Math.min(df.get(t) ?? 1, n)), max: idf(1) };
}

export interface TermMatch {
  /** Index of the document. */
  index: number;
  /** BM25 score. */
  score: number;
  /** The summed weights of the distinct query terms the document holds. */
  evidence: number;
  /** The query terms the document holds. */
  terms: string[];
}

/**
 * The documents a query matches well enough, best first: BM25 over recallTerms with the given
 * weights, keeping the documents whose evidence exceeds RECALL_EVIDENCE and whose score reaches
 * RECALL_RELATIVE of the best one's. Terms in `ignore` (the project's own name) do not count. Pure
 * and deterministic for a given platform.
 */
export function matchTerms(
  query: string,
  docs: string[],
  weights: TermWeights,
  ignore: string[] = [],
): TermMatch[] {
  const skip = new Set(ignore.map((t) => t.toLowerCase()));
  const asked = tokenize(query.slice(0, PROMPT_CHARS));
  const wanted = new Set(asked.terms.filter((t) => !skip.has(t)));
  if (wanted.size === 0 || docs.length === 0) return [];
  const counts = docs.map((d) => {
    const all = recallTerms(d);
    const tf = new Map<string, number>();
    for (const t of all) if (wanted.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, length: all.length };
  });
  const avg = Math.max(1, counts.reduce((sum, c) => sum + c.length, 0) / docs.length);
  const found: TermMatch[] = [];
  counts.forEach((c, index) => {
    let score = 0;
    let evidence = 0;
    for (const [t, tf] of c.tf) {
      // A pair of one-letter words in the query is a guess at a word, and counts half.
      const w = weights.weight(t) * (asked.guessed.has(t) ? GUESS_WEIGHT : 1);
      evidence += w;
      score += (w * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * c.length) / avg));
    }
    if (evidence > RECALL_EVIDENCE * weights.max) {
      found.push({ index, score, evidence, terms: [...c.tf.keys()] });
    }
  });
  const best = Math.max(0, ...found.map((m) => m.score));
  return found
    .filter((m) => m.score >= RECALL_RELATIVE * best)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * The user's own words, the background of TermWeights: their latest prompts in the archive, each
 * cut short (long ones are mostly pasted text, and segmenting them is what a recall spends most on).
 */
const BACKGROUND_PROMPTS = 1_000;
const BACKGROUND_CHARS = 1_000;

function latestPrompts(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT e.text FROM event e INDEXED BY event_user_message
         WHERE e.role = 'user' AND e.kind = 'message' AND ${VISIBLE_EVENT}
         ORDER BY e.ts DESC LIMIT ?`,
      )
      .all(BACKGROUND_PROMPTS) as unknown as Array<{ text: string }>
  ).map((r) => r.text.slice(0, BACKGROUND_CHARS));
}

/** A current entry recall may hand over. */
interface Candidate {
  id: string;
  kind: EntryKind;
  text: string;
  project: string | null;
  author: string;
  createdAt: number;
  imported: boolean;
  /** For an imported entry, the directory of the memory file's project, when known. */
  home: string | null;
}

/** Current entries in effect at `now`: not superseded, forgotten, ended, or yet to start. */
function candidates(db: Database, now: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT en.id, en.kind, en.text, en.project, en.author, en.created_at,
         EXISTS (SELECT 1 FROM imported_entry i WHERE i.entry_id = en.id) AS imported,
         (SELECT e.cwd FROM imported_entry i JOIN entry_source s ON s.entry_id = i.entry_id
            JOIN event e ON e.id = s.event_id
          WHERE i.entry_id = en.id AND e.kind = 'memory' LIMIT 1) AS home
       FROM entry en
       WHERE NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = en.id)
         AND ${CURRENT_VERSION}
         AND (en.valid_to IS NULL OR en.valid_to > ?) AND (en.valid_from IS NULL OR en.valid_from <= ?)
       ORDER BY en.created_at DESC, en.id DESC`,
    )
    .all(now, now) as unknown as Array<{
    id: string;
    kind: EntryKind;
    text: string;
    project: string | null;
    author: string;
    created_at: number;
    imported: number;
    home: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    project: r.project,
    author: r.author,
    createdAt: r.created_at,
    imported: r.imported === 1,
    home: r.home,
  }));
}

const sameProject = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** A path compared across sources: forward slashes, no trailing slash, lowercase. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether something of a directory (`home`) or, failing that, of a project name belongs to the
 * recall's project: a directory in its work tree, or its very working directory when it has no
 * work tree; else the same name. Two checkouts with the same name are told apart by their
 * directories, and a directory above (a home directory, say) is not the project.
 */
function inProject(plan: RecallPlan, home: string | null, project: string | null): boolean {
  if (home && (plan.root || plan.cwd)) {
    const h = normPath(home);
    if (plan.root) {
      const root = normPath(plan.root);
      if (h === root || h.startsWith(`${root}/`)) return true;
    }
    return plan.cwd !== null && h === normPath(plan.cwd);
  }
  return sameProject(project, plan.project);
}

/** Whether recall may hand the entry to this agent in this project at all. */
function inScope(c: Candidate, plan: RecallPlan): boolean {
  const own = inProject(plan, c.home, c.project);
  if (c.imported && plan.source && c.author.startsWith(`${plan.source}@`) && own) return false;
  return c.kind === 'cognition' || c.project === null || own;
}

/** Refs handed to this session since its latest brief (all of them, if it had none). */
function handedSince(db: Database, source: string, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT i.ref FROM recall_item i JOIN recall r ON r.id = i.recall_id
       WHERE r.source = ? AND r.session_id = ? AND r.seq >= COALESCE(
         (SELECT MAX(seq) FROM recall WHERE source = ? AND session_id = ? AND occasion = 'start'), 0)`,
    )
    .all(source, sessionId, source, sessionId) as unknown as Array<{ ref: string }>;
  return new Set(rows.map((r) => r.ref));
}

/** Whether this session has been handed anything (or had a brief) before. */
export function hasRecalled(db: Database, source: string, sessionId: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM recall WHERE source = ? AND session_id = ? LIMIT 1')
      .get(source, sessionId) !== undefined
  );
}

function day(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minute(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Draft {
  layer: RecallLayer;
  kind: 'entry' | 'session';
  ref: string;
  score: number | null;
  line: string;
}

function entryLine(c: Candidate, layer: RecallLayer, plan: RecallPlan): string {
  const tags: string[] = [];
  if (layer === 'prompt') {
    tags.push(c.kind);
    if (c.project && !inProject(plan, c.home, c.project)) tags.push(c.project);
  }
  if (layer !== 'cognition') tags.push(day(c.createdAt));
  return `- ${c.id}${tags.length > 0 ? ` (${tags.join(', ')})` : ''} ${entrySummary(c.text)}`;
}

/**
 * The latest sessions of the project, other than this one, with their names and last prompts:
 * those whose working directory is at or below its root, or of the same name when the session
 * has no directory.
 */
function recentSessions(db: Database, plan: RecallPlan): Draft[] {
  if (!plan.project && !plan.root) return [];
  const rows = db
    .prepare(
      `SELECT source, session_id, project, cwd, title, ended_at FROM session
       WHERE event_count >= 2 AND ended_at >= ? AND NOT (source = ? AND session_id = ?)
       ORDER BY ended_at DESC`,
    )
    .iterate(plan.at - SESSION_MAX_AGE_MS, plan.source ?? '', plan.sessionId ?? '') as Iterable<{
    source: string;
    session_id: string;
    project: string | null;
    cwd: string | null;
    title: string | null;
    ended_at: number;
  }>;
  const drafts: Draft[] = [];
  for (const r of rows) {
    if (drafts.length >= LAYER_MAX.sessions) break;
    if (!inProject(plan, r.cwd, r.project)) continue;
    const prompts = sessionPrompts(db, r.source, r.session_id);
    const name = r.title ?? prompts[0]?.prompt ?? null;
    if (!name) continue;
    const last = prompts.at(-1)?.prompt ?? null;
    const tail =
      last && last !== name && [...last].length >= 6
        ? `; last prompt: ${cutTokens(last, SUMMARY_TOKENS / 2)}`
        : '';
    drafts.push({
      layer: 'sessions',
      kind: 'session',
      ref: `${r.source}:${r.session_id}`,
      score: null,
      line: `- ${r.source} ${minute(r.ended_at)} ${r.session_id}: ${cutTokens(name, SUMMARY_TOKENS)}${tail}`,
    });
  }
  return drafts;
}

/**
 * The brief's entries, newest first: this project's cognition, then cognition of no project; then
 * this project's memory and knowledge. Cognition of other projects comes only when a prompt
 * matches it: an agent's memory file of one project rarely says whether it holds everywhere.
 */
function briefEntries(all: Candidate[], plan: RecallPlan): Draft[] {
  const own = (c: Candidate) => c.project !== null && inProject(plan, c.home, c.project);
  const cognition = [
    ...all.filter((c) => c.kind === 'cognition' && own(c)),
    ...all.filter((c) => c.kind === 'cognition' && c.project === null),
  ].slice(0, LAYER_MAX.cognition);
  const project = all.filter((c) => c.kind !== 'cognition' && own(c)).slice(0, LAYER_MAX.project);
  return [
    ...cognition.map((c) => draftOf(c, 'cognition', plan)),
    ...project.map((c) => draftOf(c, 'project', plan)),
  ];
}

function draftOf(
  c: Candidate,
  layer: RecallLayer,
  plan: RecallPlan,
  score: number | null = null,
): Draft {
  return { layer, kind: 'entry', ref: c.id, score, line: entryLine(c, layer, plan) };
}

/** Placeholder for the id in the header, as long as a real one, to estimate the header's size. */
const ID_PLACEHOLDER = 'rcl_000000000000';

const HEADINGS: Record<RecallLayer, (project: string | null) => string> = {
  cognition: () => 'The user’s preferences and boundaries:',
  project: (p) => `Project ${p}:`,
  sessions: (p) => `Latest sessions in ${p}, any agent (source, time, session id):`,
  prompt: () => 'Matching this prompt:',
};

function header(plan: Pick<RecallPlan, 'occasion' | 'project'>, id: string): string {
  const scope = plan.project ? ` (project ${plan.project})` : '';
  const what =
    plan.occasion === 'prompt'
      ? 'entries from the user’s cross-agent memory that match this prompt'
      : `a brief from the user’s cross-agent memory${scope}`;
  return `Origin recall ${id}: ${what}, one line each. Call Origin's \`get\` with an entry id for its full text and sources, or \`timeline\` with a session id to read that session. Entries can be outdated; the user's words in this session come first.`;
}

/**
 * What to hand an agent: the items, in order, that fit the budget. Reads only; nothing is
 * recorded (see recordRecall).
 */
export function planRecall(db: Database, input: RecallInput): RecallPlan {
  const at = input.now ?? Date.now();
  const plan: RecallPlan = {
    occasion: input.occasion,
    source: input.source ?? null,
    sessionId: input.sessionId ?? null,
    cwd: input.cwd ?? null,
    root: input.root ?? null,
    project: input.project ?? null,
    prompt: input.prompt?.trim() || null,
    at,
    budget: input.budget ?? RECALL_BUDGET[input.occasion],
    tokens: 0,
    items: [],
  };
  const all = candidates(db, at).filter((c) => inScope(c, plan));
  const drafts: Draft[] = [];
  if (plan.occasion !== 'prompt') {
    drafts.push(...briefEntries(all, plan));
    drafts.push(...recentSessions(db, plan));
  }
  if (plan.prompt) {
    const handed =
      plan.occasion === 'prompt' && plan.source && plan.sessionId
        ? handedSince(db, plan.source, plan.sessionId)
        : new Set<string>();
    for (const d of drafts) handed.add(d.ref);
    const pool = all.filter((c) => !handed.has(c.id));
    // An entry is matched on its first line, which says what it is about; its body would match
    // most prompts somewhere.
    const lines = all.map((c) => firstLine(c.text));
    const weights = termWeights([...latestPrompts(db), ...lines]);
    const matches = matchTerms(
      plan.prompt,
      pool.map((c) => firstLine(c.text)),
      weights,
      plan.project ? [plan.project] : [],
    ).slice(0, LAYER_MAX.prompt);
    for (const m of matches) {
      drafts.push(draftOf(pool[m.index] as Candidate, 'prompt', plan, m.score));
    }
  }
  fit(plan, drafts);
  return plan;
}

/** Keep the drafts that fit the budget, in order, counting the header and each layer's heading. */
function fit(plan: RecallPlan, drafts: Draft[]): void {
  let used = estimateTokens(header(plan, ID_PLACEHOLDER));
  let layer: RecallLayer | null = null;
  for (const d of drafts) {
    const heading = d.layer !== layer ? estimateTokens(HEADINGS[d.layer](plan.project)) : 0;
    const tokens = estimateTokens(d.line);
    if (used + heading + tokens > plan.budget) continue;
    used += heading + tokens;
    layer = d.layer;
    plan.items.push({ ...d, rank: plan.items.length + 1, tokens });
  }
  plan.tokens = plan.items.length > 0 ? used : 0;
}

/** The text handed to the agent for a recorded plan; empty when it has no items. */
export function recallText(plan: RecallPlan, id: string): string {
  if (plan.items.length === 0) return '';
  const lines = [header(plan, id)];
  let layer: RecallLayer | null = null;
  for (const item of plan.items) {
    if (item.layer !== layer) {
      lines.push('', HEADINGS[item.layer](plan.project));
      layer = item.layer;
    }
    lines.push(item.line);
  }
  return lines.join('\n');
}

/** Recall ids: `rcl_` and random hex, unique across stores. */
export const RECALL_ID_RE = /^rcl_[0-9a-f]{12}$/;

export function isRecallId(id: string): boolean {
  return id.startsWith('rcl_');
}

/** A hash of a prompt, to find it in the archive later without keeping its text. */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 32);
}

/**
 * Record a recall, with or without items (a prompt that matched nothing is worth knowing too), and
 * return its id. Only ids, scores, and sizes are kept: the text can always be rebuilt from what is
 * still visible.
 */
export function recordRecall(db: Database, plan: RecallPlan): string {
  const id = `rcl_${randomBytes(6).toString('hex')}`;
  transaction(
    db,
    () => {
      db.prepare(
        `INSERT INTO recall (id, at, origin, source, session_id, occasion, project, cwd, prompt_hash,
                             budget, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        plan.at,
        storeName(db),
        plan.source,
        plan.sessionId,
        plan.occasion,
        plan.project,
        plan.cwd,
        plan.prompt ? promptHash(plan.prompt) : null,
        plan.budget,
        plan.tokens,
      );
      const insert = db.prepare(
        `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of plan.items) {
        insert.run(id, item.rank, item.layer, item.kind, item.ref, item.score, item.tokens);
      }
    },
    { immediate: true },
  );
  return id;
}

export interface RecallItemRecord {
  rank: number;
  layer: RecallLayer;
  kind: 'entry' | 'session';
  ref: string;
  score: number | null;
  tokens: number;
}

export interface RecallRecord {
  id: string;
  at: number;
  /** The store that made the recall: a device's name. */
  origin: string;
  source: string | null;
  sessionId: string | null;
  occasion: RecallOccasion;
  project: string | null;
  cwd: string | null;
  promptHash: string | null;
  budget: number;
  tokens: number;
  items: RecallItemRecord[];
}

export interface RecallFilter {
  source?: string;
  sessionId?: string;
  /** epoch ms, inclusive. */
  since?: number;
  until?: number;
  /** Also list recalls that handed nothing. */
  includeEmpty?: boolean;
  limit?: number;
  offset?: number;
}

interface RecallRow {
  id: string;
  at: number;
  origin: string;
  source: string | null;
  session_id: string | null;
  occasion: RecallOccasion;
  project: string | null;
  cwd: string | null;
  prompt_hash: string | null;
  budget: number;
  tokens: number;
}

function withItems(db: Database, rows: RecallRow[]): RecallRecord[] {
  const items = db.prepare(
    'SELECT rank, layer, kind, ref, score, tokens FROM recall_item WHERE recall_id = ? ORDER BY rank',
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    origin: r.origin,
    source: r.source,
    sessionId: r.session_id,
    occasion: r.occasion,
    project: r.project,
    cwd: r.cwd,
    promptHash: r.prompt_hash,
    budget: r.budget,
    tokens: r.tokens,
    items: items.all(r.id) as unknown as RecallItemRecord[],
  }));
}

/** Recalls, newest first. */
export function listRecalls(db: Database, filter: RecallFilter = {}): RecallRecord[] {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.source) {
    parts.push('r.source = ?');
    params.push(filter.source);
  }
  if (filter.sessionId) {
    parts.push('r.session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.since !== undefined) {
    parts.push('r.at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    parts.push('r.at <= ?');
    params.push(filter.until);
  }
  if (!filter.includeEmpty) {
    parts.push('EXISTS (SELECT 1 FROM recall_item i WHERE i.recall_id = r.id)');
  }
  params.push(filter.limit ?? 50, filter.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT r.id, r.at, r.origin, r.source, r.session_id, r.occasion, r.project, r.cwd,
              r.prompt_hash, r.budget, r.tokens
       FROM recall r ${parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''}
       ORDER BY r.at DESC, r.seq DESC LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as RecallRow[];
  return withItems(db, rows);
}

export function getRecall(db: Database, id: string): RecallRecord | null {
  const row = db
    .prepare(
      `SELECT id, at, origin, source, session_id, occasion, project, cwd, prompt_hash, budget, tokens
       FROM recall WHERE id = ?`,
    )
    .get(id) as RecallRow | undefined;
  return row ? (withItems(db, [row])[0] as RecallRecord) : null;
}

/**
 * The refs of a recall's items that its session went on to use, as the archive shows so far: an
 * entry id, or a session id, in a later tool call or reply of the agent in that session.
 */
export function usedRefs(db: Database, recall: RecallRecord): Set<string> {
  const used = new Set<string>();
  if (!recall.source || !recall.sessionId) return used;
  const find = db.prepare(
    `SELECT 1 FROM event e
     WHERE e.source = ? AND e.session_id = ? AND e.ts >= ? AND e.role = 'assistant'
       AND e.kind IN ('tool_use', 'message') AND instr(e.text, ?) > 0 AND ${VISIBLE_EVENT}
     LIMIT 1`,
  );
  for (const item of recall.items) {
    const needle = item.kind === 'session' ? item.ref.slice(item.ref.indexOf(':') + 1) : item.ref;
    if (find.get(recall.source, recall.sessionId, recall.at, needle)) used.add(item.ref);
  }
  return used;
}

/** How far from a recall its prompt can be in the archive (clocks of the agent and the hook). */
const PROMPT_WINDOW_MS = 10 * 60_000;

/**
 * The prompt a recall answered, once the archive has it and unless it was forgotten: the user
 * message of its session, near its time, whose hash it recorded.
 */
export function recallPrompt(db: Database, recall: RecallRecord): EventRow | null {
  if (!recall.promptHash || !recall.source || !recall.sessionId) return null;
  const rows = db
    .prepare(
      `SELECT e.id, e.text FROM event e
       WHERE e.source = ? AND e.session_id = ? AND e.role = 'user' AND e.kind = 'message'
         AND e.ts BETWEEN ? AND ? AND ${VISIBLE_EVENT}
       ORDER BY e.ts, e.seq`,
    )
    .all(
      recall.source,
      recall.sessionId,
      recall.at - PROMPT_WINDOW_MS,
      recall.at + PROMPT_WINDOW_MS,
    ) as unknown as Array<{ id: string; text: string }>;
  const hit = rows.find((r) => promptHash(r.text) === recall.promptHash);
  return hit ? getEvent(db, hit.id) : null;
}
