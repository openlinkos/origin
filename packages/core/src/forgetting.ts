import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { chainOf, currentOf, rootOf, sourcesOf } from './entries.js';
import { ConflictError, OriginError } from './errors.js';
import { storeName } from './identity.js';
import { refreshSession } from './ingest.js';

/**
 * Forgetting (invariant 2, sticky forgetting; see docs/architecture.md#forgetting). A tombstone
 * records one forget operation under a global id; its effects (the entries it forgot and the events
 * it excluded) are recorded per store, because each store applies it to the data it holds.
 */

export interface ForgetResult {
  target: string;
  targetType: 'entry' | 'event';
  /** Entries newly forgotten (every version of each affected entry). */
  entries: string[];
  /** Events newly excluded. */
  events: string[];
  /** Null when there was nothing left to forget. */
  tombstoneId: string | null;
}

/** A tombstone as stores exchange it: what it targets, and its effects on the store sending it. */
export interface TombstoneRecord {
  id: string;
  target: string;
  reason: string | null;
  createdAt: number;
  /** The store that created it: a device's name, or the hub's. */
  origin: string;
  /** Entries this tombstone forgot on the sending store. */
  entries: string[];
  /** Events this tombstone excluded on the sending store. */
  events: string[];
}

/** Tombstone ids: `tmb_` and random hex, unique across stores. */
export const TOMBSTONE_ID_RE = /^tmb_[0-9a-f]{12,32}$/;

function newTombstoneId(): string {
  return `tmb_${randomBytes(6).toString('hex')}`;
}

/** Whether rule 3 may be decided here for the chain with this root (see applyTombstone). */
export type RuleThreeJudge = (root: string) => boolean;

interface Effects {
  /** null when the target is not known to this store. */
  targetType: 'entry' | 'event' | null;
  /** Entries to forget that are not forgotten yet. */
  entries: string[];
  /** Existing events to exclude that are not excluded yet. */
  events: string[];
}

const NOTHING_LISTED = { entries: [] as string[], events: [] as string[] };

/** Roots of the entries that cite any of these events. */
function citingRoots(db: Database, events: string[]): Set<string> {
  const roots = new Set<string>();
  for (let i = 0; i < events.length; i += 500) {
    const batch = events.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT DISTINCT en.root FROM entry_source s JOIN entry en ON en.id = s.entry_id
         WHERE s.event_id IN (${batch.map(() => '?').join(',')})`,
      )
      .all(...batch) as unknown as Array<{ root: string }>;
    for (const r of rows) roots.add(r.root);
  }
  return roots;
}

/**
 * What applying a tombstone does to this store:
 *
 * 1. Forgetting an entry forgets every version of it (its whole chain, forks included) and excludes
 *    every event those versions cite.
 * 2. Forgetting an event excludes it and forgets every entry that cites it, as in rule 1.
 * 3. An entry whose current version is left with no visible source has lost its provenance and is
 *    forgotten as well, every version of it; this excludes no further events.
 *
 * `listed` are the effects the tombstone had on the store that sent it: those known here are
 * applied too, and a listed entry takes its whole chain with it, so stores converge on the union of
 * what each of them forgot. `judge` limits rule 3 to the chains this store may decide for.
 */
function computeEffects(
  db: Database,
  target: string,
  listed: { entries: string[]; events: string[] },
  judge?: RuleThreeJudge,
): Effects {
  const entryExists = db.prepare('SELECT 1 FROM entry WHERE id = ?');
  const eventExists = db.prepare('SELECT 1 FROM event WHERE id = ?');
  const forgotten = db.prepare('SELECT 1 FROM forgotten_entry WHERE entry_id = ?');
  const excluded = db.prepare('SELECT 1 FROM excluded_event WHERE event_id = ?');

  const entries = new Set<string>();
  const events = new Set<string>();
  const chains = new Set<string>();
  const forgetChain = (root: string | null, excludeSources: boolean) => {
    if (!root) return;
    const versions = chainOf(db, root);
    chains.add(root);
    for (const v of versions) entries.add(v);
    if (excludeSources) for (const s of sourcesOf(db, versions)) events.add(s);
  };

  let targetType: Effects['targetType'] = null;
  if (entryExists.get(target)) {
    targetType = 'entry';
    forgetChain(rootOf(db, target), true);
  } else if (eventExists.get(target)) {
    targetType = 'event';
    events.add(target);
    for (const root of citingRoots(db, [target])) forgetChain(root, true);
  }
  for (const id of new Set(listed.entries)) {
    if (entryExists.get(id)) forgetChain(rootOf(db, id), false);
  }
  for (const id of new Set(listed.events)) {
    if (eventExists.get(id)) events.add(id);
  }

  // Rule 3: chains whose current version has no visible source left.
  const gone = (e: string) => events.has(e) || excluded.get(e) !== undefined;
  for (const root of citingRoots(db, [...events])) {
    if (chains.has(root) || forgotten.get(root)) continue;
    if (judge && !judge(root)) continue;
    const current = currentOf(db, root);
    if (current && sourcesOf(db, [current]).every(gone)) forgetChain(root, false);
  }

  return {
    targetType,
    entries: [...entries].filter((e) => forgotten.get(e) === undefined),
    events: [...events].filter((e) => eventExists.get(e) && excluded.get(e) === undefined),
  };
}

/** Record a tombstone's effects on this store. Must run inside a write transaction. */
function insertEffects(
  db: Database,
  tombstoneId: string,
  effects: Pick<Effects, 'entries' | 'events'>,
): void {
  const forgetEntry = db.prepare(
    'INSERT OR IGNORE INTO forgotten_entry (entry_id, tombstone_id) VALUES (?, ?)',
  );
  for (const e of effects.entries) forgetEntry.run(e, tombstoneId);
  const exclude = db.prepare(
    'INSERT OR IGNORE INTO excluded_event (event_id, tombstone_id) VALUES (?, ?)',
  );
  const sessionOf = db.prepare('SELECT source, session_id FROM event WHERE id = ?');
  const sessions = new Map<string, { source: string; sessionId: string }>();
  for (const e of effects.events) {
    exclude.run(e, tombstoneId);
    const s = sessionOf.get(e) as { source: string; session_id: string };
    sessions.set(`${s.source}\n${s.session_id}`, { source: s.source, sessionId: s.session_id });
  }
  for (const s of sessions.values()) refreshSession(db, s.source, s.sessionId);
}

function plan(db: Database, id: string): ForgetResult {
  const effects = computeEffects(db, id, NOTHING_LISTED);
  if (effects.targetType === null) throw new OriginError(`Unknown entry or event ${id}.`);
  return {
    target: id,
    targetType: effects.targetType,
    entries: effects.entries,
    events: effects.events,
    tombstoneId: null,
  };
}

/** What `forget` would do, without doing it. */
export function planForget(db: Database, id: string): ForgetResult {
  return plan(db, id);
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
      const result = plan(db, id);
      if (result.entries.length === 0 && result.events.length === 0) return result;
      const tombstoneId = newTombstoneId();
      db.prepare(
        'INSERT INTO tombstone (id, target, reason, created_at, origin) VALUES (?, ?, ?, ?, ?)',
      ).run(tombstoneId, id, reason?.trim() || null, now, storeName(db));
      insertEffects(db, tombstoneId, result);
      return { ...result, tombstoneId };
    },
    { immediate: true },
  );
}

export interface ApplyOptions {
  /** Record the tombstone even when it changes nothing here (a hub keeps every tombstone). */
  keep?: boolean;
  /** Limit rule 3 to some chains (a device leaves chains its hub already has to the hub). */
  judge?: RuleThreeJudge;
  /**
   * On a hub: when the tombstone's effects here go beyond those listed, append a change under this
   * origin so that every device, the sender included, receives the larger effects.
   */
  growthOrigin?: string;
}

export interface ApplyResult {
  /** Entries newly forgotten here. */
  entries: number;
  /** Events newly excluded here. */
  events: number;
}

/** Apply a tombstone from another store, or re-apply one of ours. Must run inside a write transaction. */
export function applyTombstoneInTransaction(
  db: Database,
  t: TombstoneRecord,
  opts: ApplyOptions = {},
): ApplyResult {
  const existing = db
    .prepare('SELECT target, reason, created_at, origin FROM tombstone WHERE id = ?')
    .get(t.id) as
    | { target: string; reason: string | null; created_at: number; origin: string }
    | undefined;
  if (
    existing &&
    (existing.target !== t.target ||
      existing.reason !== t.reason ||
      existing.created_at !== t.createdAt ||
      existing.origin !== t.origin)
  ) {
    throw new ConflictError(`Tombstone ${t.id} already exists with different content.`);
  }
  const effects = computeEffects(db, t.target, t, opts.judge);
  const changed = effects.entries.length + effects.events.length;
  if (!existing) {
    if (changed === 0 && !opts.keep) return { entries: 0, events: 0 };
    db.prepare(
      'INSERT INTO tombstone (id, target, reason, created_at, origin) VALUES (?, ?, ?, ?, ?)',
    ).run(t.id, t.target, t.reason, t.createdAt, t.origin);
  }
  insertEffects(db, t.id, effects);
  if (opts.growthOrigin && changed > 0) {
    const listed = new Set([...t.entries, ...t.events]);
    if ([...effects.entries, ...effects.events].some((id) => !listed.has(id))) {
      db.prepare('INSERT INTO change_log (kind, id, origin, at) VALUES (?, ?, ?, ?)').run(
        'tombstone',
        t.id,
        opts.growthOrigin,
        Date.now(),
      );
    }
  }
  return { entries: effects.entries.length, events: effects.events.length };
}

/**
 * Apply a tombstone created on another store (invariant 2: forgetting reaches every replica). The
 * tombstone keeps its id, origin, and reason. Its target is forgotten here by the rules above, and
 * the effects it lists are applied as far as this store knows them. Without `keep`, a tombstone
 * that changes nothing here is not recorded. Re-applying is a no-op.
 */
export function applyTombstone(
  db: Database,
  t: TombstoneRecord,
  opts: ApplyOptions = {},
): ApplyResult {
  return transaction(db, () => applyTombstoneInTransaction(db, t, opts), { immediate: true });
}

/** A tombstone of this store with its effects here, as it is sent to other stores. */
export function exportTombstone(db: Database, id: string): TombstoneRecord | null {
  const row = db
    .prepare('SELECT id, target, reason, created_at, origin FROM tombstone WHERE id = ?')
    .get(id) as
    | { id: string; target: string; reason: string | null; created_at: number; origin: string }
    | undefined;
  if (!row) return null;
  const entries = db
    .prepare('SELECT entry_id FROM forgotten_entry WHERE tombstone_id = ? ORDER BY entry_id')
    .all(id) as unknown as Array<{ entry_id: string }>;
  const events = db
    .prepare('SELECT event_id FROM excluded_event WHERE tombstone_id = ? ORDER BY event_id')
    .all(id) as unknown as Array<{ event_id: string }>;
  return {
    id: row.id,
    target: row.target,
    reason: row.reason,
    createdAt: row.created_at,
    origin: row.origin,
    entries: entries.map((e) => e.entry_id),
    events: events.map((e) => e.event_id),
  };
}
