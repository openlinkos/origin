import type { Database } from './db.js';
import { exportTombstone, type TombstoneRecord } from './forgetting.js';

/**
 * Tombstones in the change log, as a hub hands them to one device (see
 * docs/architecture.md#personal-hub): those after `afterSeq` in this store's change sequence, minus
 * the ones that device created, each with its current effects here. A tombstone appears again when
 * its effects here have grown. `next` is the sequence number to continue after.
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
  const seen = new Set<string>();
  const tombstones: TombstoneRecord[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const t = exportTombstone(db, r.id);
    if (t) tombstones.push(t);
  }
  return {
    tombstones,
    next: rows.length > 0 ? (rows[rows.length - 1] as { seq: number }).seq : opts.after,
    more: rows.length === limit,
  };
}

/** A forget operation as listed for the owner: ids and counts, never the forgotten text. */
export interface TombstoneSummary {
  id: string;
  target: string;
  reason: string | null;
  createdAt: number;
  /** The store that created it. */
  origin: string;
  /** Entries this tombstone forgot here. */
  entries: number;
  /** Events this tombstone excluded here. */
  events: number;
}

/** Tombstones, newest first (in the order this store recorded them). `before` pages backwards. */
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
    .prepare(
      `SELECT t.id, t.target, t.reason, t.created_at, t.origin,
              (SELECT COUNT(*) FROM forgotten_entry f WHERE f.tombstone_id = t.id) AS entries,
              (SELECT COUNT(*) FROM excluded_event x WHERE x.tombstone_id = t.id) AS events
       FROM tombstone t ${where} ORDER BY t.rowid DESC LIMIT ?`,
    )
    .all(...params) as unknown as Array<{
    id: string;
    target: string;
    reason: string | null;
    created_at: number;
    origin: string;
    entries: number;
    events: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    target: r.target,
    reason: r.reason,
    createdAt: r.created_at,
    origin: r.origin,
    entries: r.entries,
    events: r.events,
  }));
}

/** Number of tombstones in the store. */
export function tombstoneCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tombstone').get() as { n: number }).n;
}
