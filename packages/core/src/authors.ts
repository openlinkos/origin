import type { Database } from './db.js';
import { isPrompt, jsonIsOne, perDialect } from './dialect.js';
import { promptTitle } from './prompt.js';
import type { Author, EventInput, SessionKind, SessionKindFact } from './types.js';

/**
 * Who wrote each input (see docs/architecture.md#core-objects). Every human-side input, a user
 * message or a meta event (tool results are described by their kind), has an author:
 *
 * - `owner`: its source knows the owner of this memory wrote it;
 * - `person`: a human wrote it, not known to be the owner;
 * - `agent`: an agent wrote it, such as a parent agent's prompt to a sub-agent;
 * - `system`: the agent's runtime or a program generated it.
 *
 * and, when its source shows one, a speaker: a name or label as people see it, never an opaque id.
 * This records who wrote an input; it identifies no one and filters nothing.
 *
 * Authorship is derived and rebuildable, as sessions are; events are never touched. Adapters say who
 * wrote each input as its line shows (EventInput.author), and which sessions are an agent's or a
 * program's (ParsedLine.sessionKinds), which another session's line may say. Ingestion keeps both,
 * apart (event_author, session_kind), and a rebuild derives them again from the raw mirrors (see
 * reparse.ts). Reading combines them, so the order lines arrive in does not matter: an input of a
 * child session is the agent's, of a headless run the system's, and otherwise its own author's
 * (its effective author, authorSql).
 */

export const AUTHORS: readonly Author[] = ['owner', 'person', 'agent', 'system'];
export const SESSION_KINDS: readonly SessionKind[] = ['child', 'headless'];

export function isAuthor(v: unknown): v is Author {
  return typeof v === 'string' && (AUTHORS as readonly string[]).includes(v);
}

/** The longest speaker, in characters. */
export const SPEAKER_MAX = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A speaker as kept: a string of 1 to SPEAKER_MAX characters, without control characters; else null. */
export function cleanSpeaker(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= SPEAKER_MAX && !CONTROL_RE.test(s) ? s : null;
}

/** Whether an event is human-side input, which has an author: a user message or meta event. */
export function hasAuthor(e: { role: string; kind: string }): boolean {
  return e.role === 'user' && (e.kind === 'message' || e.kind === 'meta');
}

/** An input's author, and the field that decided it. */
export interface Authorship {
  author: Author;
  signal: string;
}

/**
 * The author of an input whose line says nothing more: a meta event is the system's (rule 3), and a
 * message is the owner's when it reads as a prompt (see promptTitle) and is not a sub-agent's (a
 * Claude Code sidechain), the system's otherwise (rule 4, for older logs without the fields that
 * say it). authorSql applies the same rule to an input stored without its author.
 */
export function defaultAuthor(e: {
  kind: string;
  text: string;
  meta?: Record<string, unknown> | null;
}): Authorship {
  if (e.kind !== 'message') return { author: 'system', signal: 'kind' };
  if (e.meta?.sidechain === true) return { author: 'agent', signal: 'sidechain' };
  return promptTitle(e.text) !== null
    ? { author: 'owner', signal: 'text' }
    : { author: 'system', signal: 'text' };
}

/** The authorship ingestion keeps for an input: what its adapter said, or else the default. */
export function authorOf(ev: EventInput): Authorship & { speaker: string | null } {
  const own = isAuthor(ev.author)
    ? { author: ev.author, signal: cleanSignal(ev.authorSignal) }
    : defaultAuthor(ev);
  return { ...own, speaker: cleanSpeaker(ev.speaker) };
}

const cleanSignal = (v: unknown): string =>
  typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : 'source';

/** The inputs of event `e`, as an SQL condition: a user message or meta event. */
const INPUT = `e.role = 'user' AND e.kind IN ('message', 'meta')`;

/** The session kind of `e`'s session, as an SQL expression: `child` before `headless`, or null. */
const SESSION_KIND = `(SELECT MIN(k.kind) FROM session_kind k
  WHERE k.source = e.source AND k.session_id = e.session_id)`;

/**
 * The effective author of event `e`, as an SQL expression (null for an event that is not input):
 * `agent` for an input of a child session, `system` for one of a headless run, otherwise the author
 * ingestion kept, or, for an input stored without one (by a process of an earlier version still
 * running against the store), the default (see defaultAuthor). Every query that reads an event's
 * author reads it here.
 */
export const authorSql = perDialect(
  (d) => `CASE WHEN ${INPUT} THEN COALESCE(
  CASE ${SESSION_KIND} WHEN 'child' THEN 'agent' WHEN 'headless' THEN 'system' END,
  (SELECT a.author FROM event_author a WHERE a.seq = e.seq),
  CASE WHEN e.kind <> 'message' THEN 'system'
       WHEN ${jsonIsOne(d, 'e.meta', 'sidechain')} THEN 'agent'
       WHEN ${isPrompt(d, 'e')} THEN 'owner' ELSE 'system' END) END`,
);

/** The field that decided authorSql, as an SQL expression. */
export const authorSignalSql = perDialect(
  (d) => `CASE WHEN ${INPUT} THEN COALESCE(
  (SELECT k.signal FROM session_kind k WHERE k.source = e.source AND k.session_id = e.session_id
    ORDER BY k.kind, k.signal LIMIT 1),
  (SELECT a.signal FROM event_author a WHERE a.seq = e.seq),
  CASE WHEN e.kind <> 'message' THEN 'kind'
       WHEN ${jsonIsOne(d, 'e.meta', 'sidechain')} THEN 'sidechain' ELSE 'text' END) END`,
);

/** The speaker of event `e`, as an SQL expression, or null. */
export const SPEAKER_SQL = `CASE WHEN ${INPUT} THEN
  (SELECT a.speaker FROM event_author a WHERE a.seq = e.seq) END`;

/**
 * Whether an event is a prompt of the owner: a message whose effective author is the owner and that
 * reads as a prompt (see promptTitle). The one rule for what the owner said: it names sessions
 * without a title, starts turns, makes a session the owner's conversation, and is the background of
 * recall's term weights. ownerPromptSql is the same rule in a query.
 */
export function isOwnerPrompt(e: {
  role: string;
  kind: string;
  text: string;
  author: Author | null;
}): boolean {
  return (
    e.role === 'user' &&
    e.kind === 'message' &&
    e.author === 'owner' &&
    promptTitle(e.text) !== null
  );
}

/** isOwnerPrompt as an SQL condition on event `e`. */
export const ownerPromptSql = perDialect(
  (d) => `(e.role = 'user' AND e.kind = 'message'
  AND (${authorSql(d)}) = 'owner' AND ${isPrompt(d, 'e')})`,
);

/**
 * Keeps the authorship of an input just stored, under its event's `seq`; other events are left
 * alone. Must run inside a write transaction.
 */
export function authorWriter(db: Database): (seq: number, ev: EventInput) => void {
  const insert = db.prepare(
    `INSERT INTO event_author (seq, author, speaker, signal) VALUES (?, ?, ?, ?)
     ON CONFLICT (seq) DO UPDATE
       SET author = excluded.author, speaker = excluded.speaker, signal = excluded.signal`,
  );
  return (seq, ev) => {
    if (!hasAuthor(ev)) return;
    const a = authorOf(ev);
    insert.run(seq, a.author, a.speaker, a.signal);
  };
}

/**
 * Keeps a line's statement that a session of `source` is a child or a headless run; returns whether
 * it is new. A statement that names no session, or another kind, is passed over. Must run inside a
 * write transaction.
 */
export function recordSessionKind(db: Database, source: string, fact: SessionKindFact): boolean {
  if (typeof fact.sessionId !== 'string' || fact.sessionId.length === 0) return false;
  if (!(SESSION_KINDS as readonly string[]).includes(fact.kind)) return false;
  return (
    db
      .prepare(
        `INSERT INTO session_kind (source, session_id, kind, signal) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(source, fact.sessionId, fact.kind, cleanSignal(fact.signal)).changes > 0
  );
}
