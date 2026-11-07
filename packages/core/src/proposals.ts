import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { trigramFilter } from './dialect.js';
import {
  checkCognitionSources,
  ENTRY_KINDS,
  type Entry,
  type EntryKind,
  getEntry,
  rememberInTransaction,
  resolveSources,
  type SourceInput,
  validateEntry,
} from './entries.js';
import { OriginError } from './errors.js';
import { checkReason, type ForgetResult, forgetInTransaction, IN_EFFECT } from './forgetting.js';
import { resolvedProjectSql } from './places.js';
import { type PurgedLookup, purgedLookup } from './purged.js';
import { getEvent, getSession } from './store.js';
import { isoLocal } from './time.js';
import type { EventRow, SessionRow } from './types.js';

/**
 * Proposals (see docs/architecture.md#proposals): entries an agent proposes, with the MCP tool
 * `propose`, for the person to accept or reject, rather than writing them itself. The tool writes
 * nothing durable: its result, which the agent's log records as a tool result, carries the whole
 * proposal (`"proposal": "prp_…"`, its fields, and the events it cites). Ingestion derives a row of
 * `proposal` from each such event, the way follow links are derived (see threads.ts), so every store
 * that parses the line derives the same proposal and nothing needs replicating.
 *
 * Status is derived, never stored: `accepted` while an entry that is not forgotten cites the
 * proposal's event (accepting writes one, through `remember`); `rejected` while a forget in effect
 * targets that event (rejecting is such a forget, with the person's reason); otherwise `pending`.
 * A proposal is shown only while its event and every event it cites are visible (invariant 2): like
 * an entry whose source is forgotten, one that cites a hidden event leaves every list, and a restore
 * brings it back. Only the person accepts or rejects, from the CLI or the admin UI.
 */

/** Proposal ids: `prp_` and random hex, unique across stores. */
export const PROPOSAL_ID_RE = /^prp_[0-9a-f]{12}$/;

export function isProposalId(id: string): boolean {
  return id.startsWith('prp_');
}

export function newProposalId(): string {
  return `prp_${randomBytes(6).toString('hex')}`;
}

/** Longest note a proposal carries: a few words on why the agent proposes rather than remembers. */
export const PROPOSAL_NOTE_MAX = 200;

/**
 * Longest result of `propose`, in characters. Agents' logs are read with tool results cut at 4,000
 * characters (see the adapters), and a proposal is derived only from a result read whole.
 */
export const PROPOSAL_RESULT_MAX = 3_800;

/** What a proposal holds, as the result of `propose` carries it. */
export interface ProposalRecord {
  id: string;
  kind: EntryKind;
  text: string;
  confidence: number;
  /** The project it names, if any; the entry it becomes belongs to it. */
  project: string | null;
  validFrom: number | null;
  validTo: number | null;
  note: string | null;
  /** The events it cites, with their quotes, as `propose` resolved them. */
  sources: Array<{ eventId: string; quote: string | null }>;
}

/** The result of `propose`: what the agent's log records, and ingestion reads back (proposalIn). */
export interface ProposalJson {
  proposal: string;
  kind: EntryKind;
  text: string;
  confidence: number;
  project: string | null;
  valid_from: string | null;
  valid_to: string | null;
  note: string | null;
  sources: Array<{ event_id: string; quote: string | null }>;
}

/** The result of `propose` for a proposal, in the order its fields are written. */
export function proposalJson(p: ProposalRecord): ProposalJson {
  return {
    proposal: p.id,
    kind: p.kind,
    text: p.text,
    confidence: p.confidence,
    project: p.project,
    valid_from: p.validFrom === null ? null : isoLocal(p.validFrom),
    valid_to: p.validTo === null ? null : isoLocal(p.validTo),
    note: p.note,
    sources: p.sources.map((s) => ({ event_id: s.eventId, quote: s.quote })),
  };
}

/** What an agent proposes (see prepareProposal). */
export interface ProposalInput {
  kind: EntryKind;
  text: string;
  confidence: number;
  sources: SourceInput[];
  project?: string | null;
  validFrom?: number | null;
  validTo?: number | null;
  note?: string | null;
}

/**
 * Check a proposal as `remember` checks an entry (its fields, and its sources: visible events, and
 * quotes found in them), and give it an id; nothing is written. The caller hands the agent its
 * result (proposalJson), from which ingestion derives the proposal. Throws an OriginError for what
 * `remember` would refuse, for a note that is too long, and for a result too long for an agent's log
 * to keep whole.
 */
export function prepareProposal(db: Database, input: ProposalInput): ProposalRecord {
  validateEntry(input);
  const note = input.note?.trim() || null;
  if (note !== null && note.length > PROPOSAL_NOTE_MAX) {
    throw new OriginError(`The note is too long (at most ${PROPOSAL_NOTE_MAX} characters).`);
  }
  const record: ProposalRecord = {
    id: newProposalId(),
    kind: input.kind,
    text: input.text.trim(),
    confidence: input.confidence,
    project: input.project?.trim() || null,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    note,
    sources: resolveSources(db, input.sources),
  };
  checkCognitionSources(db, record.kind, record.sources);
  const length = JSON.stringify(proposalJson(record), null, 2).length;
  if (length > PROPOSAL_RESULT_MAX) {
    throw new OriginError(
      `This proposal would take ${length} characters, more than the ${PROPOSAL_RESULT_MAX} an agent's log keeps of a tool result: shorten its text or its quotes, or cite events by id alone.`,
    );
  }
  return record;
}

const PROPOSAL_KEY = /"proposal":\s*"(prp_[0-9a-f]{12})"/g;

/**
 * The end of the JSON object or array that starts at `start` (the index after its closing bracket),
 * or -1 when it does not close in `text`.
 */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const optionalString = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || typeof v === 'string';

/** A time as the result writes it (an ISO string), or null; undefined for one that is malformed. */
function timeOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** The proposal a parsed result holds, if it has the shape `propose` writes; otherwise null. */
function recordOf(value: unknown, id: string): ProposalRecord | null {
  if (!isObject(value) || value.proposal !== id) return null;
  const { kind, text, confidence, project, note, sources } = value;
  if (typeof kind !== 'string' || !(ENTRY_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof text !== 'string' || text.trim() === '') return null;
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null;
  if (!optionalString(project) || !optionalString(note)) return null;
  if (typeof note === 'string' && note.length > PROPOSAL_NOTE_MAX) return null;
  const validFrom = timeOf(value.valid_from);
  const validTo = timeOf(value.valid_to);
  if (validFrom === undefined || validTo === undefined) return null;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const cited: ProposalRecord['sources'] = [];
  for (const s of sources) {
    if (!isObject(s) || typeof s.event_id !== 'string' || !optionalString(s.quote)) return null;
    if (s.event_id.indexOf(':') <= 0) return null;
    if (!cited.some((c) => c.eventId === s.event_id)) {
      cited.push({ eventId: s.event_id, quote: s.quote || null });
    }
  }
  return {
    id,
    kind: kind as EntryKind,
    text,
    confidence,
    project: project || null,
    validFrom,
    validTo,
    note: note || null,
    sources: cited,
  };
}

/**
 * The proposal a tool result carries, or null: the JSON object, in the result's text, that holds
 * `"proposal": "prp_…"` and has the shape `propose` writes. The text may hold more than the object
 * (an agent may add a note after it), so the object is found and parsed on its own. The same text
 * quoted inside another result, such as a search that found it, has its quotes escaped, and a result
 * cut short no longer parses: neither is taken for one.
 */
export function proposalIn(text: string): ProposalRecord | null {
  if (!text.includes('"prp_')) return null;
  for (const m of text.matchAll(PROPOSAL_KEY)) {
    const id = m[1] as string;
    // The object that holds the key opens at one of the `{` before it, the nearest first.
    let tries = 0;
    for (let start = text.lastIndexOf('{', m.index); start >= 0 && tries < 50; tries++) {
      const end = valueEnd(text, start);
      if (end > m.index) {
        let value: unknown;
        try {
          value = JSON.parse(text.slice(start, end));
        } catch {
          value = undefined;
        }
        const record = recordOf(value, id);
        if (record) return record;
      }
      if (start === 0) break;
      start = text.lastIndexOf('{', start - 1);
    }
  }
  return null;
}

/** What deriveProposal reads of an event. */
export interface ProposalEvent {
  /** The event's full id, `<source>:…`. */
  id: string;
  source: string;
  sessionId: string;
  kind: string;
  ts: number;
  text: string;
}

/**
 * Record the proposal an event carries, if it is a tool result that carries one. The same proposal
 * in a later event is a copy (a tool printed the result again), so the earliest event that carries a
 * proposal is its own, by time and then id, whatever order they arrive in. None comes from an event
 * a purge removed, by id or by session (`purged`, of the caller's transaction, else looked up here).
 * Returns whether it recorded one. Must run inside a write transaction.
 */
export function deriveProposal(db: Database, ev: ProposalEvent, purged?: PurgedLookup): boolean {
  if (ev.kind !== 'tool_result') return false;
  const p = proposalIn(ev.text);
  if (!p) return false;
  const removed = purged ?? purgedLookup(db);
  if (
    removed.any &&
    (removed.event(ev.id) !== null || removed.session(ev.source, ev.sessionId) !== null)
  ) {
    return false;
  }
  const known = db.prepare('SELECT event_id, at FROM proposal WHERE id = ?').get(p.id) as
    | { event_id: string; at: number }
    | undefined;
  if (known) {
    if (known.at < ev.ts || (known.at === ev.ts && known.event_id <= ev.id)) return false;
    db.prepare('DELETE FROM proposal_source WHERE proposal_id = ?').run(p.id);
    db.prepare('DELETE FROM proposal WHERE id = ?').run(p.id);
  }
  db.prepare(
    `INSERT INTO proposal (id, source, session_id, event_id, kind, text, confidence, project,
                           valid_from, valid_to, note, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    ev.source,
    ev.sessionId,
    ev.id,
    p.kind,
    p.text,
    p.confidence,
    p.project,
    p.validFrom,
    p.validTo,
    p.note,
    ev.ts,
  );
  const cite = db.prepare(
    `INSERT INTO proposal_source (proposal_id, event_id, quote) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  for (const s of p.sources) cite.run(p.id, s.eventId, s.quote);
  return true;
}

/**
 * Derive every proposal from the events, from scratch: what ingestion derives as it goes. Hidden
 * events count too, so that the event a proposal is derived from does not change with what is
 * forgotten. Must run inside a write transaction (see rebuildProposals).
 */
export function deriveProposals(db: Database): number {
  db.exec('DELETE FROM proposal_source');
  db.exec('DELETE FROM proposal');
  // Through the search index: only tool results that contain a proposal id are read.
  const holding = trigramFilter(db.dialect, 'e', ['prp', 'rp_']);
  const candidates = db
    .prepare(
      `SELECT e.id, e.source, e.session_id AS "sessionId", e.kind, e.ts, e.text
         FROM ${holding.from}
        WHERE ${holding.where} AND e.kind = 'tool_result'`,
    )
    .all() as unknown as ProposalEvent[];
  const purged = purgedLookup(db);
  for (const ev of candidates) deriveProposal(db, ev, purged);
  return (db.prepare('SELECT COUNT(*) AS n FROM proposal').get() as { n: number }).n;
}

/** Rebuild the proposals from the events (see deriveProposals). */
export function rebuildProposals(db: Database): void {
  transaction(db, () => void deriveProposals(db), { immediate: true });
}

// ---------------------------------------------------------------------------------------------
// Reading

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/** A proposal that is shown: pending, or accepted. */
export interface Proposal extends ProposalRecord {
  /** The agent whose session made it, and that session. */
  source: string;
  sessionId: string;
  /** The tool result it was derived from. */
  eventId: string;
  /** The project of its session, which it belongs to when it names none. */
  sessionProject: string | null;
  /** When it was made: its event's time. */
  at: number;
  status: 'pending' | 'accepted';
  /** Once accepted: the current version of the entry it became. */
  entry: string | null;
}

/** A rejected proposal, as listed for the owner: ids, the reason, and when; never its text. */
export interface RejectedProposal {
  id: string;
  source: string;
  sessionId: string;
  eventId: string;
  at: number;
  /** The forget that rejected it, which a restore lifts. */
  forget: string;
  reason: string | null;
  rejectedAt: number;
  author: string | null;
}

/** The proposal `p` is shown: its event and every event it cites are visible (invariant 2). */
export const VISIBLE_PROPOSAL = `NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = p.event_id)
  AND NOT EXISTS (SELECT 1 FROM proposal_source ps JOIN excluded_event x ON x.event_id = ps.event_id
                   WHERE ps.proposal_id = p.id)`;

/** The proposal `p` was accepted: an entry that is not forgotten cites its event. */
const ACCEPTED = `EXISTS (SELECT 1 FROM entry_source es WHERE es.event_id = p.event_id
  AND NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = es.entry_id))`;

/** The proposal `p` was rejected: its event is hidden by a forget in effect that targets it. */
const REJECTED = `EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = p.event_id)
  AND EXISTS (SELECT 1 FROM tombstone t WHERE t.target = p.event_id AND ${IN_EFFECT})`;

/** The project a proposal belongs to: the one it names, or its session's resolved name. */
const PROJECT = `COALESCE(p.project, ${resolvedProjectSql('e.source', 'e.session_id', 'e.project')})`;

const COLUMNS = `p.id, p.source, p.session_id, p.event_id, p.kind, p.text, p.confidence, p.project,
  p.valid_from, p.valid_to, p.note, p.at,
  ${resolvedProjectSql('e.source', 'e.session_id', 'e.project')} AS session_project,
  ${ACCEPTED} AS accepted`;

interface ProposalRow {
  id: string;
  source: string;
  session_id: string;
  event_id: string;
  kind: string;
  text: string;
  confidence: number;
  project: string | null;
  valid_from: number | null;
  valid_to: number | null;
  note: string | null;
  at: number;
  session_project: string | null;
  accepted: number;
}

function toProposal(db: Database, r: ProposalRow): Proposal {
  // In the order of the events cited, as an entry's sources; events not here yet come last.
  const sources = (
    db
      .prepare(
        `SELECT ps.event_id, ps.quote FROM proposal_source ps LEFT JOIN event e ON e.id = ps.event_id
          WHERE ps.proposal_id = ? ORDER BY e.ts IS NULL, e.ts, ps.event_id`,
      )
      .all(r.id) as unknown as Array<{ event_id: string; quote: string | null }>
  ).map((s) => ({ eventId: s.event_id, quote: s.quote }));
  return {
    id: r.id,
    kind: r.kind as EntryKind,
    text: r.text,
    confidence: r.confidence,
    project: r.project,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    note: r.note,
    sources,
    source: r.source,
    sessionId: r.session_id,
    eventId: r.event_id,
    sessionProject: r.session_project,
    at: r.at,
    status: r.accepted ? 'accepted' : 'pending',
    entry: r.accepted ? acceptedAs(db, r.event_id) : null,
  };
}

/** The current version of the entry that cites a proposal's event, or null. */
function acceptedAs(db: Database, eventId: string): string | null {
  const row = db
    .prepare(
      `SELECT en.root FROM entry_source es JOIN entry en ON en.id = es.entry_id
        WHERE es.event_id = ?
          AND NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = en.id)
        ORDER BY en.created_at, en.id LIMIT 1`,
    )
    .get(eventId) as { root: string } | undefined;
  if (!row) return null;
  const current = db
    .prepare('SELECT id FROM entry WHERE root = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(row.root) as { id: string };
  return current.id;
}

export interface ProposalFilter {
  /** Pending or accepted; both when omitted. */
  status?: 'pending' | 'accepted';
  /** The project it belongs to: the one it names, or its session's. */
  project?: string;
  /** The session that made it. */
  session?: { source: string; sessionId: string };
  /** The agent whose session made it. */
  source?: string;
  /** epoch ms, inclusive, on when it was made. */
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

function filterWhere(f: ProposalFilter, params: unknown[]): string[] {
  const where = [VISIBLE_PROPOSAL];
  if (f.status === 'pending') where.push(`NOT ${ACCEPTED}`);
  if (f.status === 'accepted') where.push(ACCEPTED);
  if (f.project !== undefined) {
    where.push(`${PROJECT} = ?`);
    params.push(f.project);
  }
  if (f.session) {
    where.push('p.source = ? AND p.session_id = ?');
    params.push(f.session.source, f.session.sessionId);
  }
  if (f.source !== undefined) {
    where.push('p.source = ?');
    params.push(f.source);
  }
  if (f.since !== undefined) {
    where.push('p.at >= ?');
    params.push(f.since);
  }
  if (f.until !== undefined) {
    where.push('p.at <= ?');
    params.push(f.until);
  }
  return where;
}

/** Proposals that are shown (pending or accepted), newest first. */
export function listProposals(db: Database, f: ProposalFilter = {}): Proposal[] {
  const params: unknown[] = [];
  const where = filterWhere(f, params);
  params.push(f.limit ?? 50, f.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM proposal p JOIN event e ON e.id = p.event_id
        WHERE ${where.join(' AND ')} ORDER BY p.at DESC, p.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as ProposalRow[];
  return rows.map((r) => toProposal(db, r));
}

/** How many proposals are shown under a filter (pending or accepted). */
export function countProposals(db: Database, f: Omit<ProposalFilter, 'limit' | 'offset'> = {}) {
  const params: unknown[] = [];
  const where = filterWhere(f, params);
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM proposal p JOIN event e ON e.id = p.event_id
          WHERE ${where.join(' AND ')}`,
      )
      .get(...(params as never[])) as { n: number }
  ).n;
}

/** The projects of the proposals shown, with how many each has pending, most first. */
export function proposalProjects(db: Database): Array<{ project: string; pending: number }> {
  return db
    .prepare(
      `SELECT ${PROJECT} AS project, SUM(CASE WHEN ${ACCEPTED} THEN 0 ELSE 1 END) AS pending
         FROM proposal p JOIN event e ON e.id = p.event_id
        WHERE ${VISIBLE_PROPOSAL} AND ${PROJECT} IS NOT NULL
        GROUP BY 1 ORDER BY pending DESC, project`,
    )
    .all() as unknown as Array<{ project: string; pending: number }>;
}

const REJECTED_COLUMNS = `p.id, p.source, p.session_id, p.event_id, p.at,
  t.id AS forget, t.reason, t.created_at AS rejected_at, m.author`;

interface RejectedRow {
  id: string;
  source: string;
  session_id: string;
  event_id: string;
  at: number;
  forget: string;
  reason: string | null;
  rejected_at: number;
  author: string | null;
}

const toRejected = (r: RejectedRow): RejectedProposal => ({
  id: r.id,
  source: r.source,
  sessionId: r.session_id,
  eventId: r.event_id,
  at: r.at,
  forget: r.forget,
  reason: r.reason,
  rejectedAt: r.rejected_at,
  author: r.author,
});

/** The forget in effect that rejected the proposal `p`, its latest (for the join below). */
const REJECTING = `t.id = (SELECT t.id FROM tombstone t WHERE t.target = p.event_id AND ${IN_EFFECT}
  ORDER BY t.created_at DESC, t.id DESC LIMIT 1)`;

/**
 * Rejected proposals, the latest rejected first: their ids, the forget that rejected each, its
 * reason, author, and time; never what they proposed, which only the forget's own page shows its
 * owner (see docs/architecture.md#admin-ui).
 */
export function listRejectedProposals(
  db: Database,
  f: { project?: string; limit?: number; offset?: number } = {},
): RejectedProposal[] {
  const params: unknown[] = [];
  const where = [REJECTED];
  if (f.project !== undefined) {
    where.push(`${PROJECT} = ?`);
    params.push(f.project);
  }
  params.push(f.limit ?? 50, f.offset ?? 0);
  return (
    db
      .prepare(
        `SELECT ${REJECTED_COLUMNS} FROM proposal p JOIN event e ON e.id = p.event_id
           JOIN tombstone t ON ${REJECTING}
           LEFT JOIN tombstone_meta m ON m.tombstone_id = t.id
          WHERE ${where.join(' AND ')}
          ORDER BY t.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[])) as unknown as RejectedRow[]
  ).map(toRejected);
}

/** How many proposals are rejected. */
export function countRejectedProposals(db: Database, f: { project?: string } = {}): number {
  const params: unknown[] = [];
  const where = [REJECTED];
  if (f.project !== undefined) {
    where.push(`${PROJECT} = ?`);
    params.push(f.project);
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM proposal p JOIN event e ON e.id = p.event_id
          WHERE ${where.join(' AND ')}`,
      )
      .get(...(params as never[])) as { n: number }
  ).n;
}

/** A proposal that is shown, by id, or null. */
export function getProposal(db: Database, id: string): Proposal | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM proposal p JOIN event e ON e.id = p.event_id
        WHERE p.id = ? AND ${VISIBLE_PROPOSAL}`,
    )
    .get(id) as ProposalRow | undefined;
  return row ? toProposal(db, row) : null;
}

/**
 * Where a proposal stands: shown (pending or accepted), rejected (with the forget that rejected
 * it), or hidden otherwise (its event, or an event it cites, was forgotten); null for an id this
 * store does not know.
 */
export type ProposalState =
  | { state: 'shown'; proposal: Proposal }
  | { state: 'rejected'; rejected: RejectedProposal }
  | { state: 'hidden' };

export function proposalState(db: Database, id: string): ProposalState | null {
  const shown = getProposal(db, id);
  if (shown) return { state: 'shown', proposal: shown };
  if (!db.prepare('SELECT 1 FROM proposal WHERE id = ?').get(id)) return null;
  const rejected = db
    .prepare(
      `SELECT ${REJECTED_COLUMNS} FROM proposal p JOIN tombstone t ON ${REJECTING}
         LEFT JOIN tombstone_meta m ON m.tombstone_id = t.id
        WHERE p.id = ? AND ${REJECTED}`,
    )
    .get(id) as RejectedRow | undefined;
  return rejected ? { state: 'rejected', rejected: toRejected(rejected) } : { state: 'hidden' };
}

/** Why a proposal cannot be opened or acted on, as an error. */
function unavailable(id: string, state: ProposalState | null): OriginError {
  if (!state) return new OriginError(`Unknown proposal ${id}.`);
  if (state.state === 'rejected') {
    return new OriginError(
      `Proposal ${id} was rejected (${state.rejected.forget}); restoring that forget makes it pending again.`,
    );
  }
  return new OriginError(`Proposal ${id} has been forgotten.`);
}

/** A proposal and what is next to it (see describeProposal). */
export interface ProposalCard {
  proposal: Proposal;
  /** The session that made it. */
  session: SessionRow | null;
  /** The events it cites that this store has, with their quotes, in the order it cites them. */
  sources: Array<{ eventId: string; quote: string | null; event: EventRow }>;
  /** How many of the events it cites this store does not have (yet). */
  missing: number;
  /** The entry it became, once accepted: its current version. */
  entry: Entry | null;
}

/** A proposal that is shown, with its session, its sources, and the entry it became; or null. */
export function describeProposal(db: Database, id: string): ProposalCard | null {
  const proposal = getProposal(db, id);
  if (!proposal) return null;
  const sources: ProposalCard['sources'] = [];
  let missing = 0;
  for (const s of proposal.sources) {
    const event = getEvent(db, s.eventId);
    if (event) sources.push({ ...s, event });
    else missing++;
  }
  return {
    proposal,
    session: getSession(db, proposal.source, proposal.sessionId),
    sources,
    missing,
    entry: proposal.entry ? getEntry(db, proposal.entry) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Accepting and rejecting: the person only (the CLI and the admin UI; agents have no such tool).

/**
 * The proposal's text as its result records it, JSON-escaped, so that the quote occurs in its event
 * (an escaped line break, `\n`, stays as it is written there).
 */
function quoteOf(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Accept a pending proposal: write its entry through `remember`, with its kind, text, confidence,
 * project, and validity, as `author` (`user@<device>`). The entry cites the events the proposal
 * cites, with their quotes, and the proposal's own event, quoting the text proposed, so that its
 * provenance shows what it rests on and that it was proposed (invariant 1). The proposal is then
 * accepted, on every store the entry reaches. The person corrects or forgets the entry as any other.
 */
export function acceptProposal(db: Database, id: string, author: string, now = Date.now()): Entry {
  return transaction(
    db,
    () => {
      const state = proposalState(db, id);
      if (state?.state !== 'shown') throw unavailable(id, state);
      const p = state.proposal;
      if (p.status === 'accepted') {
        throw new OriginError(`Proposal ${id} was already accepted, as ${p.entry}.`);
      }
      const absent = p.sources.find(
        (s) => !db.prepare('SELECT 1 FROM event WHERE id = ?').get(s.eventId),
      );
      if (absent) {
        throw new OriginError(
          `Proposal ${id} cites ${absent.eventId}, which this store does not have yet: accept it on the hub, or once this store has that event.`,
        );
      }
      const own = getEvent(db, p.eventId) as EventRow;
      const quote = quoteOf(p.text);
      const quoted = own.text.includes(quote);
      return rememberInTransaction(
        db,
        {
          kind: p.kind,
          text: p.text,
          confidence: p.confidence,
          author,
          project: p.project,
          validFrom: p.validFrom,
          validTo: p.validTo,
          sources: [
            ...p.sources.map((s) => ({ eventId: s.eventId, quote: s.quote ?? undefined })),
            { eventId: p.eventId, quote: quoted ? quote : undefined },
          ],
        },
        now,
        { proposalEvent: p.eventId },
      );
    },
    { immediate: true },
  );
}

/**
 * Reject a pending proposal: forget its event with the person's reason, as `author`. The forget is
 * a record like any other: it reaches every store, the proposal leaves every list there, and a
 * restore makes it pending again. The conversation around it stays: the agent's call, with what it
 * proposed, is a tool call of its session like any other, which the person can forget too.
 */
export function rejectProposal(
  db: Database,
  id: string,
  input: { reason: string; author?: string | null },
  now = Date.now(),
): ForgetResult {
  const reason = checkReason(input.reason);
  return transaction(
    db,
    () => {
      const state = proposalState(db, id);
      if (state?.state !== 'shown') throw unavailable(id, state);
      const p = state.proposal;
      if (p.status === 'accepted') {
        throw new OriginError(
          `Proposal ${id} was accepted, as ${p.entry}: correct or forget that entry instead.`,
        );
      }
      return forgetInTransaction(db, p.eventId, { reason, author: input.author ?? null }, now);
    },
    { immediate: true },
  );
}

/** Why a proposal id cannot be opened, for callers that report it (MCP, the CLI, the admin UI). */
export function proposalError(db: Database, id: string): OriginError {
  return unavailable(id, proposalState(db, id));
}
