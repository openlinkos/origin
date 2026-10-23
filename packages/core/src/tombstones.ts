import type { Database } from './db.js';
import { type Entry, loadEntry } from './entries.js';
import { exportTombstone, isRestoreTarget, type TombstoneRecord } from './forgetting.js';
import { loadEvent } from './store.js';
import type { EventRow } from './types.js';

/**
 * Tombstones in the change log, as a hub hands them to one device (see
 * docs/architecture.md#personal-hub): those after `afterSeq` in this store's change sequence, minus
 * the ones that device created, each with what it covers here now. A forget appears again when
 * its coverage here has changed, and a restore after a forget that arrived later than it. `next`
 * is the sequence number to continue after.
 */
export function tombstoneFeed(
  db: Database,
  opts: { after: number; device: string; limit?: number },
): { tombstones: TombstoneRecord[]; next: number; more: boolean } {
  const limit = opts.limit ?? 500;
  const rows = db
    .prepare(
      `SELECT seq, id FROM change_log WHERE kind = 'tombstone' AND seq > ? AND origin <> ?
       ORDER BY seq LIMIT ?`,
    )
    .all(opts.after, opts.device, limit) as unknown as Array<{ seq: number; id: string }>;
  // A tombstone logged more than once in a page is sent once, where it was logged last, so that a
  // restore logged again after its forget comes after it.
  const last = new Map<string, number>();
  for (const [i, r] of rows.entries()) last.set(r.id, i);
  const tombstones: TombstoneRecord[] = [];
  for (const [i, r] of rows.entries()) {
    if (last.get(r.id) !== i) continue;
    const t = exportTombstone(db, r.id);
    if (t) tombstones.push(t);
  }
  return {
    tombstones,
    next: rows.length > 0 ? (rows[rows.length - 1] as { seq: number }).seq : opts.after,
    more: rows.length === limit,
  };
}

/** A forget or a restore as listed for the owner. */
export interface TombstoneSummary {
  id: string;
  kind: 'forget' | 'restore';
  /** For a forget, the entry or event it hides; for a restore, the forget it lifts. */
  target: string;
  reason: string | null;
  createdAt: number;
  /** The store that created it. */
  origin: string;
  /** Who made it, when known. */
  author: string | null;
  /** For a forget: whether it is in effect here (no restore targets it). */
  inEffect: boolean;
  /** For a forget: the restores that lifted it, oldest first. */
  restoredBy: string[];
  /** For a forget: the entries and events it covers here (hidden while it is in effect). */
  entries: number;
  events: number;
}

const SUMMARY = `SELECT t.id, t.target, t.reason, t.created_at, t.origin, m.author,
    (SELECT COUNT(DISTINCT x.item) FROM tombstone_effect x
       WHERE x.tombstone_id = t.id AND x.kind = 'entry') AS entries,
    (SELECT COUNT(DISTINCT x.item) FROM tombstone_effect x
       WHERE x.tombstone_id = t.id AND x.kind = 'event') AS events,
    (SELECT group_concat(r.id, ' ') FROM tombstone r WHERE r.target = t.id) AS restored_by
  FROM tombstone t LEFT JOIN tombstone_meta m ON m.tombstone_id = t.id`;

interface SummaryRow {
  id: string;
  target: string;
  reason: string | null;
  created_at: number;
  origin: string;
  author: string | null;
  entries: number;
  events: number;
  restored_by: string | null;
}

function toSummary(r: SummaryRow): TombstoneSummary {
  const restore = isRestoreTarget(r.target);
  const restoredBy = restore || !r.restored_by ? [] : r.restored_by.split(' ');
  return {
    id: r.id,
    kind: restore ? 'restore' : 'forget',
    target: r.target,
    reason: r.reason,
    createdAt: r.created_at,
    origin: r.origin,
    author: r.author,
    inEffect: !restore && restoredBy.length === 0,
    restoredBy,
    entries: restore ? 0 : r.entries,
    events: restore ? 0 : r.events,
  };
}

/** Forgets and restores, newest first (in the order this store recorded them). `before` pages backwards. */
export function listTombstones(
  db: Database,
  opts: { limit?: number; before?: string } = {},
): TombstoneSummary[] {
  const params: Array<string | number> = [];
  let where = '';
  if (opts.before !== undefined) {
    where = 'WHERE t.rowid < (SELECT b.rowid FROM tombstone b WHERE b.id = ?)';
    params.push(opts.before);
  }
  params.push(opts.limit ?? 50);
  const rows = db
    .prepare(`${SUMMARY} ${where} ORDER BY t.rowid DESC LIMIT ?`)
    .all(...params) as unknown as SummaryRow[];
  return rows.map(toSummary);
}

/** One forget or restore. */
export function getTombstone(db: Database, id: string): TombstoneSummary | null {
  const row = db.prepare(`${SUMMARY} WHERE t.id = ?`).get(id) as SummaryRow | undefined;
  return row ? toSummary(row) : null;
}

/** Number of tombstones in the store: forgets and restores. */
export function tombstoneCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tombstone').get() as { n: number }).n;
}

/** What a forget in effect hides here, text included, for its owner (see the admin UI). */
export interface HiddenContent {
  /** Hidden entries it covers, newest first (at most `limit`). */
  entries: Entry[];
  /** Hidden events it covers, in session order (at most `limit`). */
  events: EventRow[];
  /** How many there are in all. */
  entryCount: number;
  eventCount: number;
}

/**
 * The entries and events a forget covers that are hidden here, with their text. Only the owner's
 * view of a forget shows this (the admin UI's Forgotten page), so that they can decide whether to
 * restore it; every other read leaves hidden content out. Empty unless the forget is in effect.
 */
export function hiddenContent(
  db: Database,
  id: string,
  opts: { limit?: number } = {},
): HiddenContent {
  const limit = opts.limit ?? 100;
  const none: HiddenContent = { entries: [], events: [], entryCount: 0, eventCount: 0 };
  const t = getTombstone(db, id);
  if (!t?.inEffect) return none;
  const entryIds = (
    db
      .prepare(
        `SELECT DISTINCT x.item AS id, en.created_at FROM tombstone_effect x
         JOIN forgotten_entry f ON f.entry_id = x.item JOIN entry en ON en.id = x.item
         WHERE x.tombstone_id = ? AND x.kind = 'entry'
         ORDER BY en.created_at DESC, en.id DESC`,
      )
      .all(id) as unknown as Array<{ id: string }>
  ).map((r) => r.id);
  const eventIds = (
    db
      .prepare(
        `SELECT DISTINCT x.item AS id, e.source, e.session_id, e.ts, e.seq FROM tombstone_effect x
         JOIN excluded_event v ON v.event_id = x.item JOIN event e ON e.id = x.item
         WHERE x.tombstone_id = ? AND x.kind = 'event'
         ORDER BY e.source, e.session_id, e.ts, e.seq`,
      )
      .all(id) as unknown as Array<{ id: string }>
  ).map((r) => r.id);
  return {
    entries: entryIds
      .slice(0, limit)
      .map((e) => loadEntry(db, e))
      .filter((e): e is Entry => e !== null),
    events: eventIds
      .slice(0, limit)
      .map((e) => loadEvent(db, e))
      .filter((e): e is EventRow => e !== null),
    entryCount: entryIds.length,
    eventCount: eventIds.length,
  };
}
