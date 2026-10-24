import { createHash } from 'node:crypto';
import type { Database } from './db.js';
import { type EntryKind, insertEntry, validateEntry } from './entries.js';
import { coverArrival } from './forgetting.js';
import type { NativeMemory } from './types.js';

/**
 * Native memories (see docs/architecture.md#native-memories): the memory files agents keep for
 * themselves, such as Claude Code's `memory/` directories, imported as entries.
 *
 * An adapter writes each memory directory out as a generated source, a memory stream: one line for
 * every version of a memory file, and one when it is deleted. Each line's event is the version's
 * provenance (invariant 1). The entry versions are derived from these events, deterministically,
 * by every store that parses the stream: a device from its own files, and its hub from the device's
 * mirror (or from a relay's lines). Their ids are derived from the events' ids, so every store has
 * the same versions under the same ids, as with events, and they are never sent to another store.
 *
 * A memory's versions form one chain: each supersedes the version derived from the memory's
 * previous version, so a newer version of the file becomes the current version of the entry
 * (invariant 3: never edited in place). A deleted file closes the entry: its last version is
 * written again, valid until the deletion. A correction someone made in the meantime loses to
 * a later version of the file, by the rule for concurrent corrections; a forgotten chain stays
 * hidden, its new versions included (invariant 2).
 */

/** The confidence of the entries derived from a curated memory file (adapters may say otherwise). */
export const IMPORTED_CONFIDENCE = 0.9;

/** The id of the entry version derived from a memory event: the same on every store. */
export function importedEntryId(eventId: string): string {
  return `ent_${createHash('sha256').update(`memory\0${eventId}`).digest('hex').slice(0, 24)}`;
}

export interface ImportContext {
  /** The source (adapter id) of the memory stream. */
  source: string;
  /**
   * The device the memory is on: this store's name for its own files, or on a hub, the device
   * that sent the stream. The derived versions are its, as author (`<source>@<device>`) and origin.
   */
  device: string;
  /** This store's name, under which the growth of a forget that covers a new version is logged. */
  growthOrigin: string;
}

interface PreviousVersion {
  kind: EntryKind;
  text: string;
  confidence: number;
  project: string | null;
  valid_to: number | null;
  created_at: number;
}

/**
 * Derive the entry version of one version of a native memory, read from its event, unless it is
 * already here. Returns whether a version was added. Must run inside a write transaction, once the
 * event is stored; throws an OriginError for a memory that makes no valid entry.
 */
export function importMemory(db: Database, ctx: ImportContext, m: NativeMemory): boolean {
  const eventId = `${ctx.source}:${m.eventId}`;
  const id = importedEntryId(eventId);
  if (db.prepare('SELECT 1 FROM entry WHERE id = ?').get(id)) return false;
  if (!db.prepare('SELECT 1 FROM event WHERE id = ?').get(eventId)) return false;
  const previousId = m.previous ? importedEntryId(`${ctx.source}:${m.previous}`) : null;
  // The previous version derived nothing if it had no content: this one then starts a new chain.
  const previous = previousId
    ? (db
        .prepare(
          'SELECT kind, text, confidence, project, valid_to, created_at FROM entry WHERE id = ?',
        )
        .get(previousId) as PreviousVersion | undefined)
    : undefined;
  // Dated after the version it supersedes, like any correction.
  const createdAt = previous ? Math.max(m.at, previous.created_at + 1) : m.at;
  let fields: Omit<PreviousVersion, 'valid_to' | 'created_at'> & { validTo: number | null };
  if (m.entry) {
    fields = { ...m.entry, validTo: null };
  } else {
    // Deleted, or emptied: the memory held until now. Nothing to close if it already ended.
    if (!previous || previous.valid_to !== null) return false;
    fields = {
      kind: previous.kind,
      text: previous.text,
      confidence: previous.confidence,
      project: previous.project,
      validTo: createdAt,
    };
  }
  validateEntry(fields);
  insertEntry(db, {
    id,
    kind: fields.kind,
    text: fields.text.trim(),
    confidence: fields.confidence,
    author: `${ctx.source}@${ctx.device}`,
    project: fields.project,
    supersedes: previous ? previousId : null,
    validFrom: null,
    validTo: fields.validTo,
    createdAt,
    origin: ctx.device,
    sources: [{ eventId, quote: null }],
  });
  db.prepare('INSERT INTO imported_entry (entry_id) VALUES (?)').run(id);
  // A forget of the chain, or of the memory's events, covers the new version as well.
  coverArrival(db, id, ctx.growthOrigin);
  return true;
}

/** Whether an entry version was derived from a native memory. */
export function isImportedEntry(db: Database, id: string): boolean {
  return db.prepare('SELECT 1 FROM imported_entry WHERE entry_id = ?').get(id) !== undefined;
}
