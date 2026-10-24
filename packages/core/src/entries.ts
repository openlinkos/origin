import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { OriginError } from './errors.js';
import { storeName } from './identity.js';
import { findNewest, parseQuery, phraseQuery, type QueryTerm, termCheck } from './search.js';
import { getEvent, VISIBLE_EVENT } from './store.js';
import type { EventRow } from './types.js';

/** memory = what happened; knowledge = stable facts; cognition = the person's preferences, methods, goals, boundaries. */
export const ENTRY_KINDS = ['memory', 'knowledge', 'cognition'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export type EntryStatus = 'active' | 'superseded' | 'forgotten';

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  confidence: number;
  author: string;
  project: string | null;
  supersedes: string | null;
  /** The current version of this entry, when this version is superseded. */
  supersededBy: string | null;
  /** The first version of this entry; every version of it shares the same root. */
  root: string;
  /** The store that wrote this version: a device's name, or the hub's. */
  origin: string;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
  status: EntryStatus;
  /**
   * Superseded although nothing corrects this version: a concurrent correction that lost to the
   * current version (see docs/architecture.md#entries).
   */
  concurrent: boolean;
  /**
   * Derived from a version of an agent's native memory, such as a memory file of Claude Code (see
   * memories.ts), rather than written through Origin.
   */
  imported: boolean;
}

/** A source to cite: an event id, an exact quote from an event, or both. */
export interface SourceInput {
  eventId?: string;
  quote?: string;
}

export interface EntrySource {
  eventId: string;
  quote: string | null;
  event: EventRow;
}

export interface RememberInput {
  kind: EntryKind;
  text: string;
  confidence: number;
  author: string;
  sources: SourceInput[];
  project?: string | null;
  validFrom?: number | null;
  validTo?: number | null;
}

export interface CorrectInput {
  text: string;
  author: string;
  kind?: EntryKind;
  confidence?: number;
  /** Added to the sources carried over from the corrected entry. */
  sources?: SourceInput[];
  validFrom?: number | null;
  validTo?: number | null;
}

export interface EntryFilter {
  kind?: EntryKind;
  project?: string;
  /** epoch ms, inclusive, on created_at. */
  since?: number;
  until?: number;
  /**
   * Include superseded versions, and entries whose validity has ended (forgotten entries are never
   * returned).
   */
  includeSuperseded?: boolean;
  /** Include entries whose validity has ended: their `valid_to` has passed. */
  includeEnded?: boolean;
  limit?: number;
  /** Rows to skip, for paging. */
  offset?: number;
}

/**
 * True when `en` is the current version of its entry: no other version of the same chain has a
 * greater (created_at, id). Concurrent corrections are therefore resolved the same way on every
 * store, whatever order they arrive in.
 */
export const CURRENT_VERSION = `NOT EXISTS (SELECT 1 FROM entry o WHERE o.root = en.root
  AND (o.created_at > en.created_at OR (o.created_at = en.created_at AND o.id > en.id)))`;

const ENTRY_SELECT = `SELECT en.id, en.kind, en.text, en.confidence, en.author, en.project,
  en.supersedes, en.root, en.origin, en.valid_from, en.valid_to, en.created_at,
  (SELECT o.id FROM entry o WHERE o.root = en.root ORDER BY o.created_at DESC, o.id DESC LIMIT 1)
    AS current_id,
  EXISTS (SELECT 1 FROM entry c WHERE c.supersedes = en.id) AS corrected,
  fe.entry_id IS NOT NULL AS forgotten,
  EXISTS (SELECT 1 FROM imported_entry i WHERE i.entry_id = en.id) AS imported
  FROM entry en
  LEFT JOIN forgotten_entry fe ON fe.entry_id = en.id`;

interface EntryRecord {
  id: string;
  kind: string;
  text: string;
  confidence: number;
  author: string;
  project: string | null;
  supersedes: string | null;
  root: string;
  origin: string;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
  current_id: string;
  corrected: number;
  forgotten: number;
  imported: number;
}

function toEntry(r: EntryRecord): Entry {
  const status: EntryStatus = r.forgotten
    ? 'forgotten'
    : r.current_id === r.id
      ? 'active'
      : 'superseded';
  return {
    id: r.id,
    kind: r.kind as EntryKind,
    text: r.text,
    confidence: r.confidence,
    author: r.author,
    project: r.project,
    supersedes: r.supersedes,
    supersededBy: status === 'superseded' ? r.current_id : null,
    root: r.root,
    origin: r.origin,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    createdAt: r.created_at,
    status,
    concurrent: status === 'superseded' && !r.corrected,
    imported: r.imported === 1,
  };
}

/** Entry ids: `ent_` and random hex, unique across stores. */
export const ENTRY_ID_RE = /^ent_[0-9a-f]{12,32}$/;

export function isEntryId(id: string): boolean {
  return id.startsWith('ent_');
}

function newEntryId(): string {
  return `ent_${randomBytes(6).toString('hex')}`;
}

/** An entry by id in any status, forgotten included (for internal use: never shown). */
export function loadEntry(db: Database, id: string): Entry | null {
  const row = db.prepare(`${ENTRY_SELECT} WHERE en.id = ?`).get(id) as EntryRecord | undefined;
  return row ? toEntry(row) : null;
}

/** An entry by id, in any status except forgotten (forgotten entries are reported as missing). */
export function getEntry(db: Database, id: string): Entry | null {
  const entry = loadEntry(db, id);
  return entry && entry.status !== 'forgotten' ? entry : null;
}

export function isEntryForgotten(db: Database, id: string): boolean {
  return db.prepare('SELECT 1 FROM forgotten_entry WHERE entry_id = ?').get(id) !== undefined;
}

function entryWhere(f: EntryFilter, params: unknown[]): string {
  const parts = ['fe.entry_id IS NULL'];
  if (!f.includeSuperseded) parts.push(CURRENT_VERSION);
  if (!f.includeSuperseded && !f.includeEnded) {
    // Ended, such as an imported memory whose file was deleted: history, no longer current.
    parts.push('(en.valid_to IS NULL OR en.valid_to > ?)');
    params.push(Date.now());
  }
  if (f.kind) {
    parts.push('en.kind = ?');
    params.push(f.kind);
  }
  if (f.project) {
    parts.push('en.project = ?');
    params.push(f.project);
  }
  if (f.since !== undefined) {
    parts.push('en.created_at >= ?');
    params.push(f.since);
  }
  if (f.until !== undefined) {
    parts.push('en.created_at <= ?');
    params.push(f.until);
  }
  return parts.join(' AND ');
}

/** Active entries, newest first. */
export function listEntries(db: Database, filter: EntryFilter = {}): Entry[] {
  const params: unknown[] = [];
  const where = entryWhere(filter, params);
  params.push(filter.limit ?? 50, filter.offset ?? 0);
  const rows = db
    .prepare(
      `${ENTRY_SELECT} WHERE ${where} ORDER BY en.created_at DESC, en.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as EntryRecord[];
  return rows.map(toEntry);
}

/** Entries that cite an event (active and superseded versions; never forgotten ones), newest first. */
export function entriesCiting(db: Database, eventId: string): Entry[] {
  const rows = db
    .prepare(
      `${ENTRY_SELECT} WHERE fe.entry_id IS NULL
         AND en.id IN (SELECT entry_id FROM entry_source WHERE event_id = ?)
       ORDER BY en.created_at DESC, en.id DESC`,
    )
    .all(eventId) as unknown as EntryRecord[];
  return rows.map(toEntry);
}

/**
 * Full-text search over active entries. Every term must occur in the text, ignoring case: terms of
 * three or more characters through the trigram index (ranked by BM25, best first), shorter ones by
 * checking the text. Without a term of three or more characters, newest first.
 */
export function searchEntries(db: Database, query: string, filter: EntryFilter = {}): Entry[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const long = terms.filter((t) => t.kind === 'long');
  const params: unknown[] = [];
  let sql: string;
  if (long.length > 0) {
    params.push(phraseQuery(long));
    sql = `${ENTRY_SELECT} JOIN entry_fts f ON f.rowid = en.rowid
           WHERE entry_fts MATCH ? AND ${entryWhere(filter, params)}${shortChecks(terms, params)}
           ORDER BY bm25(entry_fts), en.created_at DESC LIMIT ? OFFSET ?`;
  } else {
    sql = `${ENTRY_SELECT} WHERE ${entryWhere(filter, params)}${shortChecks(terms, params)}
           ORDER BY en.created_at DESC LIMIT ? OFFSET ?`;
  }
  params.push(filter.limit ?? 20, filter.offset ?? 0);
  return (db.prepare(sql).all(...(params as never[])) as unknown as EntryRecord[]).map(toEntry);
}

/** Checks for the terms the trigram index cannot find (entries are few, so they are read). */
function shortChecks(terms: QueryTerm[], params: unknown[]): string {
  return terms
    .filter((t) => t.kind !== 'long')
    .map((t) => ` AND ${termCheck('en.text', t.text, params)}`)
    .join('');
}

/** The visible sources of an entry (sources forgotten since are hidden). */
export function entrySources(db: Database, entryId: string): EntrySource[] {
  const rows = db
    .prepare(
      `SELECT s.event_id, s.quote FROM entry_source s JOIN event e ON e.id = s.event_id
       WHERE s.entry_id = ? AND ${VISIBLE_EVENT} ORDER BY e.ts`,
    )
    .all(entryId) as unknown as Array<{ event_id: string; quote: string | null }>;
  const out: EntrySource[] = [];
  for (const r of rows) {
    const event = getEvent(db, r.event_id);
    if (event) out.push({ eventId: r.event_id, quote: r.quote, event });
  }
  return out;
}

/** The root (first version) of an entry, or null if the entry is unknown. */
export function rootOf(db: Database, id: string): string | null {
  const row = db.prepare('SELECT root FROM entry WHERE id = ?').get(id) as
    | { root: string }
    | undefined;
  return row?.root ?? null;
}

/** Every version of the entry with this root, oldest first: its whole chain, forks included. */
export function chainOf(db: Database, root: string): string[] {
  return (
    db
      .prepare('SELECT id FROM entry WHERE root = ? ORDER BY created_at, id')
      .all(root) as unknown as Array<{ id: string }>
  ).map((r) => r.id);
}

/** The current version of the chain with this root: its greatest (created_at, id). */
export function currentOf(db: Database, root: string): string | null {
  const row = db
    .prepare('SELECT id FROM entry WHERE root = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(root) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Every event the given entries cite, visible or not. */
export function sourcesOf(db: Database, entryIds: string[]): string[] {
  if (entryIds.length === 0) return [];
  return (
    db
      .prepare(
        `SELECT DISTINCT event_id FROM entry_source WHERE entry_id IN (${entryIds.map(() => '?').join(',')})`,
      )
      .all(...entryIds) as unknown as Array<{ event_id: string }>
  ).map((r) => r.event_id);
}

/** Versions of a visible entry, oldest first, forks included; empty if the entry is unknown or forgotten. */
export function entryHistory(db: Database, id: string): Entry[] {
  const entry = getEntry(db, id);
  if (!entry) return [];
  return chainOf(db, entry.root)
    .map((v) => loadEntry(db, v))
    .filter((e): e is Entry => e !== null && e.status !== 'forgotten');
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Find the newest visible event containing a quote (whitespace and case are ignored): a message, or
 * failing that a tool result. Tool calls are never matched: the call that is citing the quote is
 * itself logged as a tool call. The quote's words are looked up like a search query, so at most the
 * newest SCAN_LIMIT events of each kind that contain all of them are checked.
 */
function findQuote(db: Database, quote: string): EventRow | null {
  const needle = normalize(quote);
  for (const kind of ['message', 'tool_result'] as const) {
    const id = findNewest(db, quote, kind, (text) => normalize(text).includes(needle));
    if (id) return getEvent(db, id);
  }
  return null;
}

/** Resolve sources to visible events (invariant 1, provenance; invariant 2, forgotten events cannot be cited). */
function resolveSources(
  db: Database,
  inputs: SourceInput[],
): Array<{ eventId: string; quote: string | null }> {
  const out = new Map<string, string | null>();
  for (const input of inputs) {
    const quote = input.quote?.trim() || null;
    let event: EventRow | null;
    if (input.eventId) {
      event = getEvent(db, input.eventId);
      if (!event) {
        const exists = db.prepare('SELECT 1 FROM event WHERE id = ?').get(input.eventId);
        throw new OriginError(
          exists
            ? `Event ${input.eventId} has been forgotten and cannot be cited.`
            : `Unknown event ${input.eventId}.`,
        );
      }
      if (quote && !normalize(event.text).includes(normalize(quote))) {
        throw new OriginError(`Quote not found in event ${input.eventId}: "${quote}"`);
      }
    } else if (quote) {
      event = findQuote(db, quote);
      if (!event) {
        throw new OriginError(
          `No event contains the quote "${quote}". Search for the event and cite its id instead.`,
        );
      }
    } else {
      throw new OriginError('Each source needs an event id or a quote.');
    }
    if (!out.has(event.id) || quote) out.set(event.id, quote);
  }
  if (out.size === 0) throw new OriginError('An entry needs at least one source.');
  return [...out].map(([eventId, q]) => ({ eventId, quote: q }));
}

export function validateEntry(input: {
  kind: string;
  text: string;
  confidence: number;
  validFrom?: number | null;
  validTo?: number | null;
}): void {
  if (!(ENTRY_KINDS as readonly string[]).includes(input.kind)) {
    throw new OriginError(`Unknown kind "${input.kind}"; expected ${ENTRY_KINDS.join(', ')}.`);
  }
  if (input.text.trim().length === 0) throw new OriginError('Entry text is empty.');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new OriginError('Confidence must be between 0 and 1.');
  }
  if (input.validFrom != null && input.validTo != null && input.validFrom > input.validTo) {
    throw new OriginError('valid_from is after valid_to.');
  }
}

/** The stored fields of one version of an entry, as written and as replicated. */
export interface EntryRecordInput {
  id: string;
  kind: EntryKind;
  text: string;
  confidence: number;
  author: string;
  project: string | null;
  supersedes: string | null;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
  origin: string;
  sources: Array<{ eventId: string; quote: string | null }>;
}

/**
 * Insert one version with its sources. The root is the superseded version's root, or the entry's
 * own id. Must run inside a write transaction; the caller checks the sources and the version it
 * supersedes.
 */
export function insertEntry(db: Database, e: EntryRecordInput): void {
  const root = e.supersedes ? rootOf(db, e.supersedes) : e.id;
  if (!root) throw new OriginError(`Unknown entry ${e.supersedes}.`);
  db.prepare(
    `INSERT INTO entry (id, kind, text, confidence, author, project, supersedes, root, valid_from,
                        valid_to, created_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.kind,
    e.text,
    e.confidence,
    e.author,
    e.project,
    e.supersedes,
    root,
    e.validFrom,
    e.validTo,
    e.createdAt,
    e.origin,
  );
  const insertSource = db.prepare(
    'INSERT INTO entry_source (entry_id, event_id, quote) VALUES (?, ?, ?)',
  );
  for (const s of e.sources) insertSource.run(e.id, s.eventId, s.quote);
}

/** Write a new entry. Every entry cites at least one visible event. */
export function remember(db: Database, input: RememberInput, now = Date.now()): Entry {
  validateEntry(input);
  const id = newEntryId();
  transaction(
    db,
    () =>
      insertEntry(db, {
        id,
        kind: input.kind,
        text: input.text.trim(),
        confidence: input.confidence,
        author: input.author,
        project: input.project ?? null,
        supersedes: null,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        createdAt: now,
        origin: storeName(db),
        sources: resolveSources(db, input.sources),
      }),
    { immediate: true },
  );
  return getEntry(db, id) as Entry;
}

/**
 * Supersede the current version of an entry with a corrected one (invariant 3: entries are never
 * edited in place). Sources carry over, plus any new ones. A correction is always dated after the
 * version it corrects, even when this machine's clock is behind, so it sorts after it everywhere.
 */
export function correct(db: Database, id: string, input: CorrectInput, now = Date.now()): Entry {
  const newId = newEntryId();
  transaction(
    db,
    () => {
      const old = getEntry(db, id);
      if (!old) {
        throw new OriginError(
          isEntryForgotten(db, id) ? `Entry ${id} has been forgotten.` : `Unknown entry ${id}.`,
        );
      }
      if (old.status === 'superseded') {
        throw new OriginError(
          old.concurrent
            ? `Entry ${id} lost to a concurrent correction, ${old.supersededBy}; correct that one instead.`
            : `Entry ${id} was already corrected; its current version is ${old.supersededBy}. Correct that one instead.`,
        );
      }
      const fields = {
        kind: input.kind ?? old.kind,
        text: input.text,
        confidence: input.confidence ?? old.confidence,
        validFrom: input.validFrom === undefined ? old.validFrom : input.validFrom,
        validTo: input.validTo === undefined ? old.validTo : input.validTo,
      };
      validateEntry(fields);
      const carried = entrySources(db, old.id).map((s) => ({ eventId: s.eventId, quote: s.quote }));
      const added = input.sources?.length ? resolveSources(db, input.sources) : [];
      const merged = new Map(carried.map((s) => [s.eventId, s.quote]));
      for (const s of added) merged.set(s.eventId, s.quote ?? merged.get(s.eventId) ?? null);
      if (merged.size === 0) {
        throw new OriginError(`Entry ${id} has no remaining sources; cite at least one.`);
      }
      insertEntry(db, {
        id: newId,
        ...fields,
        text: fields.text.trim(),
        author: input.author,
        project: old.project,
        supersedes: old.id,
        createdAt: Math.max(now, old.createdAt + 1),
        origin: storeName(db),
        sources: [...merged].map(([eventId, quote]) => ({ eventId, quote })),
      });
    },
    { immediate: true },
  );
  return getEntry(db, newId) as Entry;
}

/** Number of active entries per kind, as listed: those whose validity has not ended. */
export function entryCounts(db: Database): Record<EntryKind, number> {
  const counts: Record<EntryKind, number> = { memory: 0, knowledge: 0, cognition: 0 };
  const rows = db
    .prepare(
      `SELECT en.kind AS kind, COUNT(*) AS n FROM entry en
       LEFT JOIN forgotten_entry fe ON fe.entry_id = en.id
       WHERE fe.entry_id IS NULL AND ${CURRENT_VERSION}
         AND (en.valid_to IS NULL OR en.valid_to > ?) GROUP BY en.kind`,
    )
    .all(Date.now()) as unknown as Array<{ kind: EntryKind; n: number }>;
  for (const r of rows) counts[r.kind] = r.n;
  return counts;
}
