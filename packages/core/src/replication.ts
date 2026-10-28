import type { Database } from './db.js';
import { transaction } from './db.js';
import {
  ENTRY_ID_RE,
  ENTRY_KINDS,
  type EntryKind,
  type EntryRecordInput,
  insertEntry,
  isEntryForgotten,
} from './entries.js';
import { ConflictError, OriginError } from './errors.js';
import {
  type ApplyResult,
  applyTombstone,
  coverArrival,
  isRestoreTarget,
  MAX_REASON,
  type RuleThreeJudge,
  TOMBSTONE_ID_RE,
  type TombstoneRecord,
} from './forgetting.js';
import { storeName } from './identity.js';
import { isImportedEntry } from './memories.js';
import {
  getRecall,
  insertRecall,
  RECALL_ID_RE,
  RECALL_OCCASIONS,
  type RecallItemRecord,
  type RecallOccasion,
  type RecallRecord,
} from './recall.js';
import { NAME_RE } from './tokens.js';

/**
 * Replication between a device and its hub (see docs/architecture.md#personal-hub). A device sends
 * the entries and tombstones (forgets and restores) it wrote, in the order of its change log, and
 * the recalls it made; the hub sends back only tombstones. Everything that arrives over the network is validated field by
 * field first.
 */

/** One version of an entry as stores exchange it: its stored fields and every source it cites. */
export type ReplicaEntry = EntryRecordInput;

/** Longest id accepted for an entry, event, or tombstone target. */
const MAX_ID = 512;
/** Most ids one tombstone may list, per kind. */
const MAX_EFFECTS = 1_000_000;
/** Most sources one entry may cite. */
const MAX_SOURCES = 1000;

function invalid(what: string): never {
  throw new OriginError(`Invalid ${what}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(what);
  return value;
}

function checkOptionalString(value: unknown, what: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return checkString(value, what, max);
}

function checkTime(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(what);
  return value;
}

function checkOptionalTime(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(what);
  return value;
}

function checkStoreName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !NAME_RE.test(value)) invalid(what);
  return value;
}

function checkIds(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EFFECTS) invalid(what);
  return value.map((id) => checkString(id, what, MAX_ID));
}

/**
 * A tombstone as another store sent it, or an OriginError. A restore's target is a tombstone id,
 * other than its own, and it lists nothing. The reason may be missing only on tombstones written
 * by Origin 0.1; the author is optional.
 */
export function parseTombstoneRecord(value: unknown): TombstoneRecord {
  if (!isRecord(value)) invalid('tombstone');
  const id = value.id;
  if (typeof id !== 'string' || !TOMBSTONE_ID_RE.test(id)) invalid('tombstone id');
  const target = checkString(value.target, `target of ${id}`, MAX_ID);
  const entries = checkIds(value.entries, `entries of ${id}`);
  const events = checkIds(value.events, `events of ${id}`);
  if (
    isRestoreTarget(target) &&
    (!TOMBSTONE_ID_RE.test(target) || target === id || entries.length + events.length > 0)
  ) {
    invalid(`restore ${id}`);
  }
  const reason = checkOptionalString(value.reason, `reason of ${id}`, MAX_REASON);
  if (reason !== null && reason.trim().length === 0) invalid(`reason of ${id}`);
  const author = checkOptionalString(value.author, `author of ${id}`, 200);
  return {
    id,
    target,
    reason,
    createdAt: checkTime(value.createdAt, `createdAt of ${id}`),
    origin: checkStoreName(value.origin, `origin of ${id}`),
    ...(author !== null ? { author } : {}),
    entries,
    events,
  };
}

/** One version of an entry as another store sent it, or an OriginError. */
export function parseReplicaEntry(value: unknown): ReplicaEntry {
  if (!isRecord(value)) invalid('entry');
  const id = value.id;
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) invalid('entry id');
  const kind = value.kind;
  if (typeof kind !== 'string' || !(ENTRY_KINDS as readonly string[]).includes(kind)) {
    invalid(`kind of ${id}`);
  }
  const text = checkString(value.text, `text of ${id}`, 100_000);
  if (text.trim().length === 0) invalid(`text of ${id}`);
  const confidence = value.confidence;
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) {
    invalid(`confidence of ${id}`);
  }
  const supersedes = value.supersedes ?? null;
  if (
    supersedes !== null &&
    (typeof supersedes !== 'string' || !ENTRY_ID_RE.test(supersedes) || supersedes === id)
  ) {
    invalid(`supersedes of ${id}`);
  }
  const validFrom = checkOptionalTime(value.validFrom, `validFrom of ${id}`);
  const validTo = checkOptionalTime(value.validTo, `validTo of ${id}`);
  if (validFrom !== null && validTo !== null && validFrom > validTo) invalid(`validity of ${id}`);
  if (!Array.isArray(value.sources) || value.sources.length === 0) invalid(`sources of ${id}`);
  if (value.sources.length > MAX_SOURCES) invalid(`sources of ${id}`);
  const sources = value.sources.map((s) => {
    if (!isRecord(s)) invalid(`source of ${id}`);
    return {
      eventId: checkString(s.eventId, `source of ${id}`, MAX_ID),
      quote: checkOptionalString(s.quote, `quote of ${id}`, 20_000),
    };
  });
  if (new Set(sources.map((s) => s.eventId)).size !== sources.length) {
    invalid(`sources of ${id}`);
  }
  return {
    id,
    kind: kind as EntryKind,
    text,
    confidence,
    author: checkString(value.author, `author of ${id}`, 200),
    project: checkOptionalString(value.project, `project of ${id}`, 500),
    supersedes,
    validFrom,
    validTo,
    createdAt: checkTime(value.createdAt, `createdAt of ${id}`),
    origin: checkStoreName(value.origin, `origin of ${id}`),
    sources,
  };
}

/** One version of an entry of this store, with every source it cites, as it is sent to others. */
export function exportEntry(db: Database, id: string): ReplicaEntry | null {
  const row = db
    .prepare(
      `SELECT id, kind, text, confidence, author, project, supersedes, valid_from, valid_to,
              created_at, origin FROM entry WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        kind: EntryKind;
        text: string;
        confidence: number;
        author: string;
        project: string | null;
        supersedes: string | null;
        valid_from: number | null;
        valid_to: number | null;
        created_at: number;
        origin: string;
      }
    | undefined;
  if (!row) return null;
  const sources = db
    .prepare('SELECT event_id, quote FROM entry_source WHERE entry_id = ? ORDER BY event_id')
    .all(id) as unknown as Array<{ event_id: string; quote: string | null }>;
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    confidence: row.confidence,
    author: row.author,
    project: row.project,
    supersedes: row.supersedes,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
    origin: row.origin,
    sources: sources.map((s) => ({ eventId: s.event_id, quote: s.quote })),
  };
}

function sameEntry(a: ReplicaEntry, b: ReplicaEntry): boolean {
  const sources = (e: ReplicaEntry) =>
    JSON.stringify(
      [...e.sources]
        .sort((x, y) => (x.eventId < y.eventId ? -1 : 1))
        .map((s) => [s.eventId, s.quote ?? null]),
    );
  return (
    a.kind === b.kind &&
    a.text === b.text &&
    a.confidence === b.confidence &&
    a.author === b.author &&
    a.project === b.project &&
    a.supersedes === b.supersedes &&
    a.validFrom === b.validFrom &&
    a.validTo === b.validTo &&
    a.createdAt === b.createdAt &&
    a.origin === b.origin &&
    sources(a) === sources(b)
  );
}

export type ReceiveResult =
  | { status: 'applied' | 'exists' }
  /** The version it supersedes or events it cites are not here yet: send it again later. */
  | { status: 'pending'; missing: string[] };

/**
 * Store a version of an entry written on another store (on a hub: pushed by a device). Idempotent
 * by id; the same id with a different body is refused. The version it supersedes and every event
 * it cites must already be here, or the result is `pending`. A version that joins a hidden chain,
 * or cites events hidden here, is hidden on arrival by the forgets concerned (invariant 2), and
 * their growth is logged under `growthOrigin`.
 */
export function receiveEntry(
  db: Database,
  e: ReplicaEntry,
  opts: { growthOrigin: string },
): ReceiveResult {
  return transaction(
    db,
    (): ReceiveResult => {
      const existing = exportEntry(db, e.id);
      if (existing) {
        if (!sameEntry(existing, e)) {
          throw new ConflictError(`Entry ${e.id} already exists with different content.`);
        }
        return { status: 'exists' };
      }
      const missing: string[] = [];
      if (e.supersedes) {
        const parent = db.prepare('SELECT created_at FROM entry WHERE id = ?').get(e.supersedes) as
          | { created_at: number }
          | undefined;
        if (!parent) missing.push(e.supersedes);
        else if (e.createdAt <= parent.created_at) {
          throw new OriginError(`Entry ${e.id} is dated before the version it corrects.`);
        }
      }
      const eventExists = db.prepare('SELECT 1 FROM event WHERE id = ?');
      for (const s of e.sources) if (!eventExists.get(s.eventId)) missing.push(s.eventId);
      if (missing.length > 0) return { status: 'pending', missing };

      insertEntry(db, e);
      // Forgets that cover another version of its chain or one of its sources cover it too.
      coverArrival(db, e.id, opts.growthOrigin);
      return { status: 'applied' };
    },
    { immediate: true },
  );
}

/**
 * Store a tombstone created on another store (on a hub: pushed by a device). The hub keeps every
 * tombstone it receives, a restore whose forget it has not received yet included, adds what the
 * device covered to what the hub covers, and logs a forget again when its coverage here changes
 * beyond what was listed.
 */
export function receiveTombstone(
  db: Database,
  t: TombstoneRecord,
  opts: { growthOrigin: string },
): ApplyResult {
  return applyTombstone(db, t, { keep: true, growthOrigin: opts.growthOrigin, from: 'device' });
}

/** A change this store made itself, in the order of its change log. */
export interface OwnChange {
  seq: number;
  kind: 'entry' | 'tombstone';
  id: string;
}

/**
 * The entries and tombstones this store wrote itself after `after`, oldest first. Entries derived
 * from native memories are not among them: every store that has the memory stream derives them
 * (see memories.ts).
 */
export function ownChanges(db: Database, after: number, limit = 100): OwnChange[] {
  return db
    .prepare(
      `SELECT seq, kind, id FROM change_log c WHERE seq > ? AND origin = ?
         AND NOT (kind = 'entry' AND EXISTS (SELECT 1 FROM imported_entry i WHERE i.entry_id = c.id))
       ORDER BY seq LIMIT ?`,
    )
    .all(after, storeName(db), limit) as unknown as OwnChange[];
}

/**
 * On a device: rule 3 is decided here only for entries whose first version the hub has not received
 * yet (after the push cursor). For the others, the hub holds every version and lists its verdict
 * in the tombstone's effects, so device and hub never disagree.
 */
export function unpushedOnly(db: Database, pushedThrough: number): RuleThreeJudge {
  // The latest change: an entry that a restore brought back is logged again, to be sent again.
  const seqOf = db.prepare(
    "SELECT MAX(seq) AS seq FROM change_log WHERE kind = 'entry' AND id = ?",
  );
  return (root) => {
    // The hub derives an imported entry from the memory stream, as this store does.
    if (isImportedEntry(db, root)) return false;
    const row = seqOf.get(root) as { seq: number | null } | undefined;
    return row?.seq == null || row.seq > pushedThrough;
  };
}

/** Whether a version of this store should still be sent: forgotten entries never leave it. */
export function shouldSendEntry(db: Database, id: string): boolean {
  return !isEntryForgotten(db, id);
}

/** Most items one recall may hand over (see LAYER_MAX in recall.ts, with room to grow). */
const MAX_RECALL_ITEMS = 100;
const RECALL_LAYERS = ['cognition', 'project', 'sessions', 'prompt'];

function checkCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1e6) {
    invalid(what);
  }
  return value;
}

/** A recall as a device sent it (see docs/architecture.md#recall), or an OriginError. */
export function parseReplicaRecall(value: unknown): RecallRecord {
  if (!isRecord(value)) invalid('recall');
  const id = value.id;
  if (typeof id !== 'string' || !RECALL_ID_RE.test(id)) invalid('recall id');
  const occasion = value.occasion;
  if (!(RECALL_OCCASIONS as readonly unknown[]).includes(occasion)) invalid(`occasion of ${id}`);
  const promptHash = checkOptionalString(value.promptHash, `prompt hash of ${id}`, 64);
  if (promptHash !== null && !/^[0-9a-f]{32}$/.test(promptHash)) invalid(`prompt hash of ${id}`);
  if (!Array.isArray(value.items) || value.items.length > MAX_RECALL_ITEMS)
    invalid(`items of ${id}`);
  const items = value.items.map((item: unknown, i: number): RecallItemRecord => {
    const what = `item ${i + 1} of ${id}`;
    if (!isRecord(item) || item.rank !== i + 1) invalid(what);
    if (!RECALL_LAYERS.includes(item.layer as string)) invalid(what);
    if (item.kind !== 'entry' && item.kind !== 'session') invalid(what);
    const score = item.score ?? null;
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score))) invalid(what);
    return {
      rank: i + 1,
      layer: item.layer as RecallItemRecord['layer'],
      kind: item.kind,
      ref: checkString(item.ref, what, MAX_ID),
      score,
      tokens: checkCount(item.tokens, what),
    };
  });
  return {
    id,
    at: checkTime(value.at, `time of ${id}`),
    origin: checkStoreName(value.origin, `origin of ${id}`),
    source: checkOptionalString(value.source, `agent of ${id}`, 200),
    sessionId: checkOptionalString(value.sessionId, `session of ${id}`, MAX_ID),
    occasion: occasion as RecallOccasion,
    project: checkOptionalString(value.project, `project of ${id}`, MAX_ID),
    cwd: checkOptionalString(value.cwd, `directory of ${id}`, 4096),
    promptHash,
    budget: checkCount(value.budget, `budget of ${id}`),
    tokens: checkCount(value.tokens, `tokens of ${id}`),
    items,
  };
}

/**
 * Store a recall a device made (on a hub). Idempotent by id; the same id with a different body is
 * refused. A recall holds only ids, so it needs nothing else to be here first.
 */
export function receiveRecall(db: Database, r: RecallRecord): 'applied' | 'exists' {
  return transaction(
    db,
    () => {
      const existing = getRecall(db, r.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(r)) {
          throw new ConflictError(`Recall ${r.id} already exists with different content.`);
        }
        return 'exists';
      }
      insertRecall(db, r);
      return 'applied';
    },
    { immediate: true },
  );
}
