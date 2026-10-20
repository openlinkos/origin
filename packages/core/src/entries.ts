import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { OriginError } from './errors.js';
import { refreshSession } from './ingest.js';
import { getEvent, toFtsQuery, VISIBLE_EVENT } from './store.js';
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
  supersededBy: string | null;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
  status: EntryStatus;
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
  /** Include superseded versions (forgotten entries are never returned). */
  includeSuperseded?: boolean;
  limit?: number;
}

export interface ForgetResult {
  target: string;
  targetType: 'entry' | 'event';
  /** Entries newly forgotten (every version of each affected entry). */
  entries: string[];
  /** Events newly excluded. */
  events: string[];
  /** Null when there was nothing left to forget. */
  tombstoneId: number | null;
}

const ENTRY_SELECT = `SELECT en.id, en.kind, en.text, en.confidence, en.author, en.project,
  en.supersedes, nx.id AS superseded_by, en.valid_from, en.valid_to, en.created_at,
  CASE WHEN fe.entry_id IS NOT NULL THEN 'forgotten'
       WHEN nx.id IS NOT NULL THEN 'superseded'
       ELSE 'active' END AS status
  FROM entry en
  LEFT JOIN entry nx ON nx.supersedes = en.id
  LEFT JOIN forgotten_entry fe ON fe.entry_id = en.id`;

interface EntryRecord {
  id: string;
  kind: string;
  text: string;
  confidence: number;
  author: string;
  project: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
  status: string;
}

function toEntry(r: EntryRecord): Entry {
  return {
    id: r.id,
    kind: r.kind as EntryKind,
    text: r.text,
    confidence: r.confidence,
    author: r.author,
    project: r.project,
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    createdAt: r.created_at,
    status: r.status as EntryStatus,
  };
}

export function isEntryId(id: string): boolean {
  return id.startsWith('ent_');
}

function newEntryId(): string {
  return `ent_${randomBytes(6).toString('hex')}`;
}

function loadEntry(db: Database, id: string): Entry | null {
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
  if (!f.includeSuperseded) parts.push('nx.id IS NULL');
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
  params.push(filter.limit ?? 50);
  const rows = db
    .prepare(`${ENTRY_SELECT} WHERE ${where} ORDER BY en.created_at DESC LIMIT ?`)
    .all(...(params as never[])) as unknown as EntryRecord[];
  return rows.map(toEntry);
}

/** Full-text search over active entries, best match first. Queries shorter than 3 characters fall back to LIKE. */
export function searchEntries(db: Database, query: string, filter: EntryFilter = {}): Entry[] {
  const fts = toFtsQuery(query);
  const params: unknown[] = [];
  let sql: string;
  if (fts) {
    params.push(fts);
    sql = `${ENTRY_SELECT} JOIN entry_fts f ON f.rowid = en.rowid
           WHERE entry_fts MATCH ? AND ${entryWhere(filter, params)}
           ORDER BY bm25(entry_fts), en.created_at DESC LIMIT ?`;
  } else {
    const q = query.trim();
    if (q.length === 0) return [];
    params.push(`%${q}%`);
    sql = `${ENTRY_SELECT} WHERE en.text LIKE ? AND ${entryWhere(filter, params)}
           ORDER BY en.created_at DESC LIMIT ?`;
  }
  params.push(filter.limit ?? 20);
  return (db.prepare(sql).all(...(params as never[])) as unknown as EntryRecord[]).map(toEntry);
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

/** Every version of an entry, oldest first. */
function lineage(db: Database, id: string): string[] {
  const back: string[] = [];
  let cur: string | null = id;
  while (cur) {
    back.unshift(cur);
    const row = db.prepare('SELECT supersedes FROM entry WHERE id = ?').get(cur) as
      | { supersedes: string | null }
      | undefined;
    cur = row?.supersedes ?? null;
  }
  let next: string | null = id;
  while (next) {
    const row = db.prepare('SELECT id FROM entry WHERE supersedes = ?').get(next) as
      | { id: string }
      | undefined;
    next = row?.id ?? null;
    if (next) back.push(next);
  }
  return back;
}

/** Versions of a visible entry, oldest first; empty if the entry is unknown or forgotten. */
export function entryHistory(db: Database, id: string): Entry[] {
  if (!getEntry(db, id)) return [];
  return lineage(db, id)
    .map((v) => loadEntry(db, v))
    .filter((e): e is Entry => e !== null);
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Find the newest visible event containing a quote (whitespace and case are ignored). Tool calls are
 * never matched: the call that is citing the quote is itself logged as a tool call.
 */
function findQuote(db: Database, quote: string): EventRow | null {
  const needle = normalize(quote);
  const probe = quote
    .split(/\s+/)
    .reduce((longest, t) => (t.length > longest.length ? t : longest), '');
  for (const kind of ['message', 'tool_result']) {
    const rows = db
      .prepare(
        `SELECT e.id, e.text FROM event e
         WHERE e.kind = ? AND e.text LIKE ? ESCAPE '\\' AND ${VISIBLE_EVENT}
         ORDER BY e.ts DESC LIMIT 500`,
      )
      .all(kind, `%${escapeLike(probe)}%`) as unknown as Array<{ id: string; text: string }>;
    const hit = rows.find((r) => normalize(r.text).includes(needle));
    if (hit) return getEvent(db, hit.id);
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

function validate(input: {
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

function insertEntry(
  db: Database,
  fields: Omit<Entry, 'id' | 'supersededBy' | 'status' | 'createdAt'>,
  sources: Array<{ eventId: string; quote: string | null }>,
  now: number,
): string {
  const id = newEntryId();
  db.prepare(
    `INSERT INTO entry (id, kind, text, confidence, author, project, supersedes, valid_from, valid_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.kind,
    fields.text.trim(),
    fields.confidence,
    fields.author,
    fields.project,
    fields.supersedes,
    fields.validFrom,
    fields.validTo,
    now,
  );
  const insertSource = db.prepare(
    'INSERT INTO entry_source (entry_id, event_id, quote) VALUES (?, ?, ?)',
  );
  for (const s of sources) insertSource.run(id, s.eventId, s.quote);
  return id;
}

/** Write a new entry. Every entry cites at least one visible event. */
export function remember(db: Database, input: RememberInput, now = Date.now()): Entry {
  validate(input);
  const id = transaction(
    db,
    () =>
      insertEntry(
        db,
        {
          kind: input.kind,
          text: input.text,
          confidence: input.confidence,
          author: input.author,
          project: input.project ?? null,
          supersedes: null,
          validFrom: input.validFrom ?? null,
          validTo: input.validTo ?? null,
        },
        resolveSources(db, input.sources),
        now,
      ),
    { immediate: true },
  );
  return getEntry(db, id) as Entry;
}

/**
 * Supersede an active entry with a corrected version (invariant 3: entries are never edited in
 * place). Sources carry over, plus any new ones.
 */
export function correct(db: Database, id: string, input: CorrectInput, now = Date.now()): Entry {
  const newId = transaction(
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
          `Entry ${id} was already corrected by ${old.supersededBy}; correct that one instead.`,
        );
      }
      const fields = {
        kind: input.kind ?? old.kind,
        text: input.text,
        confidence: input.confidence ?? old.confidence,
        author: input.author,
        project: old.project,
        supersedes: old.id,
        validFrom: input.validFrom === undefined ? old.validFrom : input.validFrom,
        validTo: input.validTo === undefined ? old.validTo : input.validTo,
      };
      validate(fields);
      const carried = entrySources(db, old.id).map((s) => ({ eventId: s.eventId, quote: s.quote }));
      const added = input.sources?.length ? resolveSources(db, input.sources) : [];
      const merged = new Map(carried.map((s) => [s.eventId, s.quote]));
      for (const s of added) merged.set(s.eventId, s.quote ?? merged.get(s.eventId) ?? null);
      if (merged.size === 0) {
        throw new OriginError(`Entry ${id} has no remaining sources; cite at least one.`);
      }
      const sources = [...merged].map(([eventId, quote]) => ({ eventId, quote }));
      return insertEntry(db, fields, sources, now);
    },
    { immediate: true },
  );
  return getEntry(db, newId) as Entry;
}

function sourcesOf(db: Database, entryIds: string[]): string[] {
  if (entryIds.length === 0) return [];
  return (
    db
      .prepare(
        `SELECT DISTINCT event_id FROM entry_source WHERE entry_id IN (${entryIds.map(() => '?').join(',')})`,
      )
      .all(...entryIds) as unknown as Array<{ event_id: string }>
  ).map((r) => r.event_id);
}

/** What `forget` would do, without doing it. */
export function planForget(db: Database, id: string): ForgetResult {
  const forgottenEntry = (e: string) => isEntryForgotten(db, e);
  const excludedEvent = (e: string) =>
    db.prepare('SELECT 1 FROM excluded_event WHERE event_id = ?').get(e) !== undefined;
  let targetType: ForgetResult['targetType'];
  let entries: string[];
  let events: string[];
  if (db.prepare('SELECT 1 FROM entry WHERE id = ?').get(id)) {
    // Forgetting an entry forgets every version of it and excludes all of their sources.
    targetType = 'entry';
    entries = lineage(db, id);
    events = sourcesOf(db, entries);
  } else if (db.prepare('SELECT 1 FROM event WHERE id = ?').get(id)) {
    // Forgetting an event also forgets every entry that cites it, as above.
    targetType = 'event';
    const citing = (
      db.prepare('SELECT DISTINCT entry_id FROM entry_source WHERE event_id = ?').all(id) as Array<{
        entry_id: string;
      }>
    ).map((r) => r.entry_id);
    entries = [...new Set(citing.flatMap((e) => lineage(db, e)))];
    events = [id, ...sourcesOf(db, entries)];
  } else {
    throw new OriginError(`Unknown entry or event ${id}.`);
  }
  // An active entry left with no visible source has lost its provenance, so it is forgotten too.
  // This excludes no further events, so the cascade stops here.
  const excluded = new Set(events);
  const entrySet = new Set(entries);
  const affected = events.length
    ? (db
        .prepare(
          `SELECT DISTINCT s.entry_id FROM entry_source s LEFT JOIN entry nx ON nx.supersedes = s.entry_id
           WHERE nx.id IS NULL AND s.event_id IN (${events.map(() => '?').join(',')})`,
        )
        .all(...events) as unknown as Array<{ entry_id: string }>)
    : [];
  for (const { entry_id } of affected) {
    if (entrySet.has(entry_id) || forgottenEntry(entry_id)) continue;
    if (sourcesOf(db, [entry_id]).every((e) => excluded.has(e) || excludedEvent(e))) {
      for (const v of lineage(db, entry_id)) entrySet.add(v);
    }
  }
  return {
    target: id,
    targetType,
    entries: [...entrySet].filter((e) => !forgottenEntry(e)),
    events: [...new Set(events)].filter((e) => !excludedEvent(e)),
    tombstoneId: null,
  };
}

/**
 * Forget an entry or an event (invariant 2, sticky forgetting). Forgotten entries and excluded
 * events leave every query, and excluded events can never be cited again. Raw mirrors are kept
 * on disk but never shown. Irreversible.
 */
export function forget(db: Database, id: string, reason?: string, now = Date.now()): ForgetResult {
  return transaction(
    db,
    () => {
      const plan = planForget(db, id);
      if (plan.entries.length === 0 && plan.events.length === 0) return plan;
      const tombstoneId = Number(
        db
          .prepare('INSERT INTO tombstone (target, reason, created_at) VALUES (?, ?, ?)')
          .run(id, reason?.trim() || null, now).lastInsertRowid,
      );
      const forgetEntry = db.prepare(
        'INSERT OR IGNORE INTO forgotten_entry (entry_id, tombstone_id) VALUES (?, ?)',
      );
      for (const e of plan.entries) forgetEntry.run(e, tombstoneId);
      const exclude = db.prepare(
        'INSERT OR IGNORE INTO excluded_event (event_id, tombstone_id) VALUES (?, ?)',
      );
      const sessions = new Map<string, { source: string; sessionId: string }>();
      const sessionOf = db.prepare('SELECT source, session_id FROM event WHERE id = ?');
      for (const e of plan.events) {
        exclude.run(e, tombstoneId);
        const s = sessionOf.get(e) as { source: string; session_id: string };
        sessions.set(`${s.source}\n${s.session_id}`, { source: s.source, sessionId: s.session_id });
      }
      for (const s of sessions.values()) refreshSession(db, s.source, s.sessionId);
      return { ...plan, tombstoneId };
    },
    { immediate: true },
  );
}

/** Number of active entries per kind. */
export function entryCounts(db: Database): Record<EntryKind, number> {
  const counts: Record<EntryKind, number> = { memory: 0, knowledge: 0, cognition: 0 };
  const rows = db
    .prepare(
      `SELECT en.kind AS kind, COUNT(*) AS n FROM entry en
       LEFT JOIN entry nx ON nx.supersedes = en.id
       LEFT JOIN forgotten_entry fe ON fe.entry_id = en.id
       WHERE nx.id IS NULL AND fe.entry_id IS NULL GROUP BY en.kind`,
    )
    .all() as unknown as Array<{ kind: EntryKind; n: number }>;
  for (const r of rows) counts[r.kind] = r.n;
  return counts;
}
