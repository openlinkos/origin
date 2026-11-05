import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { AUTHOR_SQL, isOwnerPrompt } from './authors.js';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { CURRENT_VERSION, type EntryKind } from './entries.js';
import { storeName } from './identity.js';
import { sessionFold } from './parents.js';
import { comparePath, resolvedProjectSql, resolvePlace, underProjectAlias } from './places.js';
import { findNewest, searchEvents } from './search.js';
import {
  getEvent,
  isOwnerConversation,
  listThreadSessions,
  sessionPrompts,
  VISIBLE_EVENT,
} from './store.js';
import { threadLastPrompt, threadOf, threadSummary } from './threads.js';
import type { Author, EventRow } from './types.js';

/**
 * Recall (see docs/architecture.md#recall): what Origin hands an agent without being asked, and the
 * record of each time it does. No model is called; relevance comes in layers.
 *
 * - Scope: the session's project, the git work tree of its working directory (or the directory),
 *   told apart from another of the same name by the directories entries and sessions record.
 *   Memory and knowledge of another project are never handed over; cognition (the user's
 *   preferences, methods, goals, and boundaries) can be, when a prompt matches it.
 * - At the start of a session, a brief: cognition (this project's, then that of no project), this
 *   project's latest memory and knowledge, and its latest sessions with any agent, a thread of
 *   several sessions on one line.
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
  /**
   * When false, do not read the filesystem (a hub). Not stored on the recall. Defaults to true.
   */
  onDisk?: boolean;
}

/** What a recall item is: an entry, a session, or a thread of sessions. */
export type RecallItemKind = 'entry' | 'session' | 'thread';

export interface RecallItem {
  rank: number;
  layer: RecallLayer;
  kind: RecallItemKind;
  /** An entry id, `<source>:<session id>`, or a thread id. */
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
  /** Not stored. False on a hub, which does not read `.git`. */
  onDisk?: boolean;
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
 * The user's own words, the background of TermWeights: their latest prompts in the archive (see
 * isOwnerPrompt), each cut short (long ones are mostly pasted text, and segmenting them is what a
 * recall spends most on). What agents, programs, and other people wrote does not count: it does not
 * tell what the user says all the time.
 */
const BACKGROUND_PROMPTS = 1_000;
const BACKGROUND_CHARS = 1_000;

export function latestPrompts(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT e.text, (${AUTHOR_SQL}) AS author FROM event e INDEXED BY event_user_message
       WHERE e.role = 'user' AND e.kind = 'message' AND ${VISIBLE_EVENT}
       ORDER BY e.ts DESC, e.seq DESC`,
    )
    .iterate() as Iterable<{ text: string; author: Author }>;
  const out: string[] = [];
  for (const r of rows) {
    if (!isOwnerPrompt({ ...r, role: 'user', kind: 'message' })) continue;
    out.push(r.text.slice(0, BACKGROUND_CHARS));
    if (out.length >= BACKGROUND_PROMPTS) break;
  }
  return out;
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
         COALESCE(
           (SELECT e.cwd FROM imported_entry i JOIN entry_source s ON s.entry_id = i.entry_id
              JOIN event e ON e.id = s.event_id
            WHERE i.entry_id = en.id AND e.kind = 'memory' AND e.cwd IS NOT NULL LIMIT 1),
           (SELECT e.cwd FROM entry_source s JOIN event e ON e.id = s.event_id
            WHERE s.entry_id = en.id AND e.cwd IS NOT NULL ORDER BY e.ts LIMIT 1)
         ) AS home
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

/**
 * Whether something of a directory (`home`) or, failing that, of a project name belongs to the
 * recall's project: under its work tree, under an alias of that project, or on a directory that
 * resolves to the same work tree (a linked work tree beside the checkout). Else the same name.
 * A directory above the project is not the project. `onDisk` false never reads `.git`.
 */
function inProject(
  db: Database,
  plan: RecallPlan,
  home: string | null,
  project: string | null,
): boolean {
  if (home && (plan.root || plan.cwd)) {
    const h = comparePath(home);
    if (plan.root) {
      const root = comparePath(plan.root);
      if (h === root || h.startsWith(`${root}/`)) return true;
    }
    if (plan.project && underProjectAlias(db, home, plan.project)) return true;
    if (plan.onDisk !== false && plan.root) {
      const resolved = resolvePlace(home, { db, onDisk: true });
      const got = resolved.rootPath ?? (resolved.signal === 'learned' ? resolved.root : null);
      if (got && comparePath(got) === comparePath(plan.root)) return true;
    }
    return plan.cwd !== null && h === comparePath(plan.cwd);
  }
  return sameProject(project, plan.project);
}

/** Whether recall may hand the entry to this agent in this project at all. */
function inScope(db: Database, c: Candidate, plan: RecallPlan): boolean {
  const own = inProject(db, plan, c.home, c.project);
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
  kind: RecallItemKind;
  ref: string;
  score: number | null;
  line: string;
}

function entryLine(db: Database, c: Candidate, layer: RecallLayer, plan: RecallPlan): string {
  const tags: string[] = [];
  if (layer === 'prompt') {
    tags.push(c.kind);
    if (c.project && !inProject(db, plan, c.home, c.project)) tags.push(c.project);
  }
  if (layer !== 'cognition') tags.push(day(c.createdAt));
  return `- ${c.id}${tags.length > 0 ? ` (${tags.join(', ')})` : ''} ${entrySummary(c.text)}`;
}

/** A session's children, on its brief line: how many, and the workflow names among them. */
function childTail(fold: { children: number; workflows: string[] }): string {
  if (fold.children === 0) return '';
  const noun = fold.children === 1 ? 'child' : 'children';
  const names = fold.workflows.length > 0 ? ` (${fold.workflows.join(', ')})` : '';
  return ` · ${fold.children} ${noun}${names}`;
}

/** A session's line in a brief: its agent, when it ended, its id, its name, and its last prompt. */
function sessionLine(
  source: string,
  sessionId: string,
  at: number,
  name: string,
  last: string | null,
  fold: { children: number; workflows: string[] },
): string {
  return `- ${source} ${minute(at)} ${sessionId}: ${cutTokens(name, SUMMARY_TOKENS)}${lastPromptTail(name, last)}${childTail(fold)}`;
}

function lastPromptTail(name: string, last: string | null): string {
  return last && last !== name && [...last].length >= 6
    ? `; last prompt: ${cutTokens(last, SUMMARY_TOKENS / 2)}`
    : '';
}

/**
 * A thread's line in a brief: its id, how many sessions of which agents, from when to when, its
 * name (its root's), and its last prompt up to `until`; null for a thread gone or without a name.
 */
function threadLine(db: Database, id: string, until?: number): string | null {
  const summary = threadSummary(db, id);
  const root = listThreadSessions(db, id, { limit: 1 })[0];
  const name = root ? (root.title ?? root.prompt) : null;
  if (!summary || !root || !name || summary.startedAt === null || summary.endedAt === null) {
    return null;
  }
  const first = day(summary.startedAt);
  const last = day(until === undefined ? summary.endedAt : Math.min(until, summary.endedAt));
  const span = first === last ? first : `${first} – ${last}`;
  const prompt = threadLastPrompt(db, id, { until })?.prompt ?? null;
  const fold = sessionFold(db, root.source, root.sessionId);
  return `- ${id} (${summary.sessions} sessions: ${summary.agents.join(', ')}; ${span}): ${cutTokens(name, SUMMARY_TOKENS)}${lastPromptTail(name, prompt)}${childTail(fold)}`;
}

/**
 * The latest of the owner's conversations in the project (see isOwnerConversation), other than this
 * session, with their names and last prompts: those whose working directory is at or below its
 * root, or of the same name when the session has no directory. A sub-agent's session, a headless
 * run, or a session of other people's words alone is no conversation of the owner's, and is left
 * out. A session in a thread with others stands for its thread, on one line.
 */
function recentSessions(db: Database, plan: RecallPlan): Draft[] {
  if (!plan.project && !plan.root) return [];
  const rows = db
    .prepare(
      `SELECT source, session_id,
              ${resolvedProjectSql('session.source', 'session.session_id', 'session.project')} AS project,
              cwd, title, ended_at FROM session
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
  const threads = new Set<string>();
  for (const r of rows) {
    if (drafts.length >= LAYER_MAX.sessions) break;
    if (!inProject(db, plan, r.cwd, r.project)) continue;
    if (!isOwnerConversation(db, r.source, r.session_id)) continue;
    const thread = threadOf(db, r.source, r.session_id);
    if (thread) {
      if (threads.has(thread)) continue;
      threads.add(thread);
      const line = threadLine(db, thread);
      if (line) {
        drafts.push({ layer: 'sessions', kind: 'thread', ref: thread, score: null, line });
        continue;
      }
    }
    const prompts = sessionPrompts(db, r.source, r.session_id);
    const name = r.title ?? prompts[0]?.prompt ?? null;
    if (!name) continue;
    drafts.push({
      layer: 'sessions',
      kind: 'session',
      ref: `${r.source}:${r.session_id}`,
      score: null,
      line: sessionLine(
        r.source,
        r.session_id,
        r.ended_at,
        name,
        prompts.at(-1)?.prompt ?? null,
        sessionFold(db, r.source, r.session_id),
      ),
    });
  }
  return drafts;
}

/**
 * The brief's entries, newest first: this project's cognition, then cognition of no project; then
 * this project's memory and knowledge. Cognition of other projects comes only when a prompt
 * matches it: an agent's memory file of one project rarely says whether it holds everywhere.
 */
function briefEntries(db: Database, all: Candidate[], plan: RecallPlan): Draft[] {
  const own = (c: Candidate) => c.project !== null && inProject(db, plan, c.home, c.project);
  const cognition = [
    ...all.filter((c) => c.kind === 'cognition' && own(c)),
    ...all.filter((c) => c.kind === 'cognition' && c.project === null),
  ].slice(0, LAYER_MAX.cognition);
  const project = all.filter((c) => c.kind !== 'cognition' && own(c)).slice(0, LAYER_MAX.project);
  return [
    ...cognition.map((c) => draftOf(db, c, 'cognition', plan)),
    ...project.map((c) => draftOf(db, c, 'project', plan)),
  ];
}

function draftOf(
  db: Database,
  c: Candidate,
  layer: RecallLayer,
  plan: RecallPlan,
  score: number | null = null,
): Draft {
  return { layer, kind: 'entry', ref: c.id, score, line: entryLine(db, c, layer, plan) };
}

/** Placeholder for the id in the header, as long as a real one, to estimate the header's size. */
const ID_PLACEHOLDER = 'rcl_000000000000';

const HEADINGS: Record<RecallLayer, (plan: RecallPlan) => string> = {
  cognition: () => 'The user’s preferences and boundaries:',
  project: (p) => `Project ${p.project}:`,
  sessions: (p) => `Latest sessions in ${p.project}, any agent (source, time, session id):`,
  prompt: (p) => (p.occasion === 'prompt' ? 'Matching this prompt:' : 'Matching the task:'),
};

function header(plan: Pick<RecallPlan, 'occasion' | 'project'>, id: string): string {
  const scope = plan.project ? ` (project ${plan.project})` : '';
  const what =
    plan.occasion === 'prompt'
      ? 'entries from the user’s cross-agent memory that match this prompt'
      : `a brief from the user’s cross-agent memory${scope}`;
  return `Origin recall ${id}: ${what}, one line each. Origin's \`get\` opens any id here: an entry for its text and sources, a session or thread for its turns or sessions and what was written there. Entries can be outdated; the user's words in this session come first.`;
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
    onDisk: input.onDisk !== false,
  };
  const all = candidates(db, at).filter((c) => inScope(db, c, plan));
  const drafts: Draft[] = [];
  if (plan.occasion !== 'prompt') {
    drafts.push(...briefEntries(db, all, plan));
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
      drafts.push(draftOf(db, pool[m.index] as Candidate, 'prompt', plan, m.score));
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
    const heading = d.layer !== layer ? estimateTokens(HEADINGS[d.layer](plan)) : 0;
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
      lines.push('', HEADINGS[item.layer](plan));
      layer = item.layer;
    }
    lines.push(item.line);
  }
  return lines.join('\n');
}

/**
 * The text a recorded recall handed over, rebuilt from what the store holds now: each item's line
 * as planning writes it, from its entry or session as it is now, and a session's prompts and time
 * as they were at the recall. An item forgotten or gone since is left out, its ref in `missing`;
 * nothing hidden is ever shown.
 */
export function rebuildRecall(
  db: Database,
  recall: RecallRecord,
): { text: string; lines: Map<string, string>; missing: string[] } {
  const plan: RecallPlan = {
    occasion: recall.occasion,
    source: recall.source,
    sessionId: recall.sessionId,
    cwd: recall.cwd,
    root: recall.cwd,
    project: recall.project,
    prompt: null,
    at: recall.at,
    budget: recall.budget,
    tokens: recall.tokens,
    items: [],
  };
  const entry = db.prepare(
    `SELECT en.id, en.kind, en.text, en.project, en.author, en.created_at,
       EXISTS (SELECT 1 FROM imported_entry i WHERE i.entry_id = en.id) AS imported,
       COALESCE(
         (SELECT e.cwd FROM imported_entry i JOIN entry_source s ON s.entry_id = i.entry_id
            JOIN event e ON e.id = s.event_id
          WHERE i.entry_id = en.id AND e.kind = 'memory' AND e.cwd IS NOT NULL LIMIT 1),
         (SELECT e.cwd FROM entry_source s JOIN event e ON e.id = s.event_id
          WHERE s.entry_id = en.id AND e.cwd IS NOT NULL ORDER BY e.ts LIMIT 1)
       ) AS home
     FROM entry en
     WHERE en.id = ? AND NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = en.id)`,
  );
  const session = db.prepare(
    `SELECT s.title, (SELECT MAX(e.ts) FROM event e
         WHERE e.source = s.source AND e.session_id = s.session_id AND e.ts <= ? AND ${VISIBLE_EVENT}) AS at
     FROM session s WHERE s.source = ? AND s.session_id = ?`,
  );
  const lines = new Map<string, string>();
  const missing: string[] = [];
  for (const item of recall.items) {
    if (item.kind === 'entry') {
      const r = entry.get(item.ref) as
        | {
            id: string;
            kind: EntryKind;
            text: string;
            project: string | null;
            author: string;
            created_at: number;
            imported: number;
            home: string | null;
          }
        | undefined;
      if (!r) {
        missing.push(item.ref);
        continue;
      }
      const c: Candidate = {
        id: r.id,
        kind: r.kind,
        text: r.text,
        project: r.project,
        author: r.author,
        createdAt: r.created_at,
        imported: r.imported === 1,
        home: r.home,
      };
      lines.set(item.ref, entryLine(db, c, item.layer, plan));
      continue;
    }
    if (item.kind === 'thread') {
      // A thread as it is now, with its last prompt as it was at the recall.
      const line = threadLine(db, item.ref, recall.at);
      if (line) lines.set(item.ref, line);
      else missing.push(item.ref);
      continue;
    }
    const at = item.ref.indexOf(':');
    const source = item.ref.slice(0, at);
    const id = item.ref.slice(at + 1);
    const r = session.get(recall.at, source, id) as
      | { title: string | null; at: number | null }
      | undefined;
    const prompts = r ? sessionPrompts(db, source, id).filter((p) => p.ts <= recall.at) : [];
    const name = r?.title ?? prompts[0]?.prompt ?? null;
    if (!r || r.at === null || !name) {
      missing.push(item.ref);
      continue;
    }
    lines.set(
      item.ref,
      sessionLine(
        source,
        id,
        r.at,
        name,
        prompts.at(-1)?.prompt ?? null,
        sessionFold(db, source, id),
      ),
    );
  }
  const shown = recall.items.filter((i) => lines.has(i.ref));
  if (shown.length === 0) return { text: '', lines, missing };
  const out = [header(plan, recall.id)];
  let layer: RecallLayer | null = null;
  for (const item of shown) {
    if (item.layer !== layer) {
      out.push('', HEADINGS[item.layer](plan));
      layer = item.layer;
    }
    out.push(lines.get(item.ref) as string);
  }
  return { text: out.join('\n'), lines, missing };
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
export function recordRecall(
  db: Database,
  plan: RecallPlan,
  opts: {
    /** The device the recall is for, when this store answers for another (a hub, for a relay). */
    origin?: string;
  } = {},
): string {
  const id = `rcl_${randomBytes(6).toString('hex')}`;
  const record: RecallRecord = {
    id,
    at: plan.at,
    origin: opts.origin ?? storeName(db),
    source: plan.source,
    sessionId: plan.sessionId,
    occasion: plan.occasion,
    project: plan.project,
    cwd: plan.cwd,
    promptHash: plan.prompt ? promptHash(plan.prompt) : null,
    budget: plan.budget,
    tokens: plan.tokens,
    items: plan.items.map(({ rank, layer, kind, ref, score, tokens }) => ({
      rank,
      layer,
      kind,
      ref,
      score,
      tokens,
    })),
  };
  transaction(db, () => insertRecall(db, record), { immediate: true });
  return id;
}

/** Insert a recall and its items. Must run inside a write transaction. */
export function insertRecall(db: Database, r: RecallRecord): void {
  db.prepare(
    `INSERT INTO recall (id, at, origin, source, session_id, occasion, project, cwd, prompt_hash,
                         budget, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.at,
    r.origin,
    r.source,
    r.sessionId,
    r.occasion,
    r.project,
    r.cwd,
    r.promptHash,
    r.budget,
    r.tokens,
  );
  const insert = db.prepare(
    `INSERT INTO recall_item (recall_id, rank, layer, kind, ref, score, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of r.items) {
    insert.run(r.id, item.rank, item.layer, item.kind, item.ref, item.score, item.tokens);
  }
}

/**
 * The recalls this store made, after a sequence number, oldest first: what a device sends its hub
 * (see docs/architecture.md#replication-raw-mirrors-entries-and-tombstones-up-tombstones-down).
 */
export function ownRecalls(
  db: Database,
  after: number,
  limit = 200,
): Array<{ seq: number; recall: RecallRecord }> {
  const rows = db
    .prepare(
      `SELECT seq, id, at, origin, source, session_id, occasion, project, cwd, prompt_hash, budget,
              tokens
       FROM recall WHERE seq > ? AND origin = ? ORDER BY seq LIMIT ?`,
    )
    .all(after, storeName(db), limit) as unknown as Array<RecallRow & { seq: number }>;
  const recalls = withItems(db, rows);
  return rows.map((r, i) => ({ seq: r.seq, recall: recalls[i] as RecallRecord }));
}

export interface RecallItemRecord {
  rank: number;
  layer: RecallLayer;
  kind: RecallItemKind;
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
  /** The device the recall was made for. */
  origin?: string;
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
  if (filter.origin) {
    parts.push('r.origin = ?');
    params.push(filter.origin);
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
 * The session a recall was made for: the one it recorded (a hook knows its session), or, for an
 * agent that asked through MCP, which does not say, the session whose log holds the recall's id in
 * a tool result, once archived.
 */
export function recallSession(
  db: Database,
  recall: RecallRecord,
): { source: string; sessionId: string } | null {
  if (recall.source && recall.sessionId)
    return { source: recall.source, sessionId: recall.sessionId };
  const id = findNewest(db, recall.id, 'tool_result', (text) => briefIds(text).includes(recall.id));
  const event = id ? getEvent(db, id) : null;
  return event ? { source: event.source, sessionId: event.sessionId } : null;
}

/**
 * The refs of a recall's items that its session went on to use, as the archive shows so far: an
 * entry id, a session id, or a thread id, in a later tool call or reply of the agent in that
 * session.
 */
export function usedRefs(
  db: Database,
  recall: RecallRecord,
  only?: ReadonlySet<string>,
): Set<string> {
  const used = new Set<string>();
  const session = recallSession(db, recall);
  if (!session) return used;
  const find = db.prepare(
    `SELECT 1 FROM event e
     WHERE e.source = ? AND e.session_id = ? AND e.ts >= ? AND e.role = 'assistant'
       AND e.kind IN ('tool_use', 'message') AND instr(e.text, ?) > 0 AND ${VISIBLE_EVENT}
     LIMIT 1`,
  );
  for (const item of recall.items) {
    if (only && !only.has(item.ref)) continue;
    const needle = item.kind === 'session' ? item.ref.slice(item.ref.indexOf(':') + 1) : item.ref;
    if (find.get(session.source, session.sessionId, recall.at, needle)) used.add(item.ref);
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

/**
 * The main work tree that holds `dir`, or null. A `.git` directory is that checkout. A linked work
 * tree's `.git` file resolves to the checkout it was made from. A bare repo or a symlink does not.
 */
export function workTree(dir: string): string | null {
  return resolvePlace(dir, { onDisk: true }).rootPath;
}

/**
 * The scope of a recall made in a working directory. On this machine, a linked work tree is the
 * main checkout's project. A hub (`onDisk: false`) does not read `.git`; a `project_root` alias
 * still names the project, and without one the directory string is the project and the root is null.
 */
export function recallScope(
  cwd: string,
  opts: { onDisk?: boolean; db?: Database } = {},
): Pick<RecallInput, 'cwd' | 'root' | 'project'> {
  if (opts.onDisk === false) {
    const place = resolvePlace(cwd, { onDisk: false, db: opts.db });
    return {
      cwd,
      root: place.signal === 'segment' ? null : place.root,
      project: place.project,
    };
  }
  const dir = path.resolve(cwd);
  const place = resolvePlace(dir, { onDisk: true, db: opts.db });
  return {
    cwd: dir,
    root: place.rootPath ?? (place.signal === 'learned' ? place.root : null),
    project: place.project,
  };
}

/**
 * The ids of the recalls a tool result hands over: what `brief` returns, `{ "recall": "rcl_…" }`.
 * Other mentions of a recall's id, such as `origin recalls` printed in a shell, are not its session.
 */
export function briefIds(text: string): string[] {
  return [...text.matchAll(/"recall":\s*"(rcl_[0-9a-f]{12})"/g)].map((m) => m[1] as string);
}

/** Most briefs an agent is taken to have asked for in one session. */
const SESSION_BRIEFS = 100;

/**
 * The recalls made for a session, oldest first: those its hooks recorded, and those its agent asked
 * for with `brief`, whose ids are in its tool results.
 */
export function sessionRecalls(db: Database, source: string, sessionId: string): RecallRecord[] {
  const ids = new Set(
    (
      db
        .prepare('SELECT id FROM recall WHERE source = ? AND session_id = ?')
        .all(source, sessionId) as unknown as Array<{ id: string }>
    ).map((r) => r.id),
  );
  // Through the search index, so that a long session is not read for them.
  const results = searchEvents(db, 'rcl_', {
    source,
    sessionId,
    kinds: ['tool_result'],
    order: 'recent',
    limit: SESSION_BRIEFS,
  });
  for (const r of results) for (const id of briefIds(r.text)) ids.add(id);
  return [...ids]
    .map((id) => getRecall(db, id))
    .filter((r): r is RecallRecord => r !== null)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** The recalls that handed over any of these refs (the versions of an entry), newest first. */
export function recallsWith(
  db: Database,
  refs: string[],
  limit = 100,
): { recalls: RecallRecord[]; total: number } {
  if (refs.length === 0) return { recalls: [], total: 0 };
  const matching = `SELECT DISTINCT recall_id FROM recall_item WHERE ref IN (SELECT value FROM json_each(?))`;
  const list = JSON.stringify(refs);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${matching})`).get(list) as { n: number })
    .n;
  const rows = db
    .prepare(
      `SELECT id, at, origin, source, session_id, occasion, project, cwd, prompt_hash, budget, tokens
       FROM recall WHERE id IN (${matching}) ORDER BY at DESC, seq DESC LIMIT ?`,
    )
    .all(list, limit) as unknown as RecallRow[];
  return { recalls: withItems(db, rows), total };
}

/** The devices and agents recalls were made for, for filters. */
export function recallFacets(db: Database): { devices: string[]; agents: string[] } {
  const column = (name: 'origin' | 'source') =>
    (
      db
        .prepare(`SELECT DISTINCT ${name} AS v FROM recall WHERE ${name} IS NOT NULL ORDER BY 1`)
        .all() as unknown as Array<{ v: string }>
    ).map((r) => r.v);
  return { devices: column('origin'), agents: column('source') };
}
