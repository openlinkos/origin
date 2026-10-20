import type { Database } from './db.js';
import { transaction } from './db.js';
import { refreshSession } from './ingest.js';

/** A forget operation as a hub hands it to its devices (see docs/architecture.md#personal-hub). */
export interface TombstoneRecord {
  id: number;
  target: string;
  reason: string | null;
  createdAt: number;
  /** Entries this tombstone forgot. */
  entries: string[];
  /** Events this tombstone excluded. */
  events: string[];
}

/** Tombstones with an id greater than `afterId`, oldest first. */
export function tombstonesAfter(db: Database, afterId: number, limit = 500): TombstoneRecord[] {
  const rows = db
    .prepare(
      'SELECT id, target, reason, created_at FROM tombstone WHERE id > ? ORDER BY id LIMIT ?',
    )
    .all(afterId, limit) as unknown as Array<{
    id: number;
    target: string;
    reason: string | null;
    created_at: number;
  }>;
  const entries = db.prepare(
    'SELECT entry_id FROM forgotten_entry WHERE tombstone_id = ? ORDER BY entry_id',
  );
  const events = db.prepare(
    'SELECT event_id FROM excluded_event WHERE tombstone_id = ? ORDER BY event_id',
  );
  return rows.map((r) => ({
    id: r.id,
    target: r.target,
    reason: r.reason,
    createdAt: r.created_at,
    entries: (entries.all(r.id) as unknown as Array<{ entry_id: string }>).map((e) => e.entry_id),
    events: (events.all(r.id) as unknown as Array<{ event_id: string }>).map((e) => e.event_id),
  }));
}

/**
 * Apply a hub's tombstone to this store, so forgetting reaches every replica (invariant 2, sticky
 * forgetting, see docs/architecture.md). Only entries and events known here and not yet forgotten
 * are affected; when there are none, nothing is written, which makes re-applying a no-op.
 */
export function applyRemoteTombstone(
  db: Database,
  t: TombstoneRecord,
  origin: string,
  now = Date.now(),
): { entries: number; events: number } {
  return transaction(
    db,
    () => {
      const entryKnown = db.prepare(
        `SELECT 1 FROM entry en WHERE en.id = ?
           AND NOT EXISTS (SELECT 1 FROM forgotten_entry f WHERE f.entry_id = en.id)`,
      );
      const eventKnown = db.prepare(
        `SELECT 1 FROM event e WHERE e.id = ?
           AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)`,
      );
      const entries = [...new Set(t.entries)].filter((id) => entryKnown.get(id) !== undefined);
      const events = [...new Set(t.events)].filter((id) => eventKnown.get(id) !== undefined);
      if (entries.length === 0 && events.length === 0) return { entries: 0, events: 0 };

      const reason = t.reason ? `${origin}#${t.id}: ${t.reason}` : `${origin}#${t.id}`;
      const tombstoneId = Number(
        db
          .prepare('INSERT INTO tombstone (target, reason, created_at) VALUES (?, ?, ?)')
          .run(t.target, reason, now).lastInsertRowid,
      );
      const forgetEntry = db.prepare(
        'INSERT OR IGNORE INTO forgotten_entry (entry_id, tombstone_id) VALUES (?, ?)',
      );
      for (const id of entries) forgetEntry.run(id, tombstoneId);
      const exclude = db.prepare(
        'INSERT OR IGNORE INTO excluded_event (event_id, tombstone_id) VALUES (?, ?)',
      );
      const sessionOf = db.prepare('SELECT source, session_id FROM event WHERE id = ?');
      const sessions = new Map<string, { source: string; sessionId: string }>();
      for (const id of events) {
        exclude.run(id, tombstoneId);
        const s = sessionOf.get(id) as { source: string; session_id: string };
        sessions.set(`${s.source}\n${s.session_id}`, { source: s.source, sessionId: s.session_id });
      }
      for (const s of sessions.values()) refreshSession(db, s.source, s.sessionId);
      return { entries: entries.length, events: events.length };
    },
    { immediate: true },
  );
}
