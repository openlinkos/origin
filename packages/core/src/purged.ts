import type { Database, Statement } from './database.js';
import { mirrorState, readMirror } from './mirror.js';
import type { SourceAdapter } from './types.js';

/**
 * What purges removed, looked up wherever data arrives, so that none of it comes back: from a
 * source file synced again, a device's push, an entry or a recall a device sends, or a parse of the
 * lines already mirrored (see the `purged` table in schema.ts). A store without a purge answers
 * every lookup without a query beyond the first.
 *
 * Ids are as the store keeps them: an event's full id (`<source>:<id>`), an entry's, a recall's; a
 * session by its source and id; a file by its source and its path as `raw_file.path` records it on
 * this store (its own path for this store's files, `@<device>:<path>` for a device's on a hub).
 */

/** The lookups of one operation, such as a write transaction (see purgedLookup). */
export interface PurgedLookup {
  /** Whether the store holds a purge. Without one, every lookup below answers null. */
  readonly any: boolean;
  /** The purge that removed the event, or null. */
  event(id: string): string | null;
  entry(id: string): string | null;
  session(source: string, sessionId: string): string | null;
  recall(id: string): string | null;
  /** The purge that blocked the file, whose lines are never ingested again, or null. */
  file(source: string, path: string): string | null;
}

const NONE: PurgedLookup = {
  any: false,
  event: () => null,
  entry: () => null,
  session: () => null,
  recall: () => null,
  file: () => null,
};

/** Stores known to have the purge tables (version 12): a table, once there, stays. */
const hasTables = new WeakSet<Database>();

function purgeTables(db: Database): boolean {
  if (hasTables.has(db)) return true;
  // A migration before version 12 parses mirrored lines before the tables exist.
  if (!db.hasTable('purge')) return false;
  hasTables.add(db);
  return true;
}

/**
 * The lookups of what purges removed, for one operation: whether the store holds a purge is read
 * once, here, so take a new lookup for each transaction (a purge commits in its own).
 */
export function purgedLookup(db: Database): PurgedLookup {
  if (!purgeTables(db)) return NONE;
  if (db.prepare('SELECT 1 AS one FROM purge LIMIT 1').get() === undefined) return NONE;
  let find: Statement | null = null;
  const get = (kind: string, scope: string, id: string): string | null => {
    find ??= db.prepare('SELECT purge_id FROM purged WHERE kind = ? AND scope = ? AND id = ?');
    const row = find.get(kind, scope, id) as { purge_id: string } | undefined;
    return row?.purge_id ?? null;
  };
  return {
    any: true,
    event: (id) => get('event', '', id),
    entry: (id) => get('entry', '', id),
    session: (source, sessionId) => get('session', source, sessionId),
    recall: (id) => get('recall', '', id),
    file: (source, path) => get('file', source, path),
  };
}

/**
 * The setting that keeps the highest `recall.seq` a purge deleted, which both engines would otherwise
 * give out again (a recall's number is one past the highest there is): a device sends its hub the
 * recalls after the last seq it sent, and would skip a new recall under an old number (see
 * insertRecall).
 */
export const RECALL_SEQ_FLOOR = 'purge.recall_seq_floor';

/** Whether a purge removed the event, entry, or recall with this id: one query. */
export function isPurgedId(db: Database, id: string): boolean {
  if (!purgeTables(db)) return false;
  return (
    db
      .prepare(
        "SELECT 1 AS one FROM purged WHERE kind IN ('event', 'entry', 'recall') AND scope = '' AND id = ?",
      )
      .get(id) !== undefined
  );
}

/** Whether a purge removed the session: one query. */
export function isPurgedSession(db: Database, source: string, sessionId: string): boolean {
  if (!purgeTables(db)) return false;
  return (
    db
      .prepare("SELECT 1 AS one FROM purged WHERE kind = 'session' AND scope = ? AND id = ?")
      .get(source, sessionId) !== undefined
  );
}

/**
 * How a line a purge replaced in a generated mirror begins: a JSON object whose first key is
 * `origin_purged`, with the purge's id and what the adapter needs to go on after it (see
 * SourceAdapter.continuation), padded with spaces to the length of the line it replaced.
 */
export const PURGED_MARKER = '{"origin_purged":';

/**
 * Whether a parse skips a mirrored line: one that holds nothing but white space, as a line a purge
 * blanked does, or one that a purge replaced (PURGED_MARKER).
 */
export function isSkippedLine(line: string): boolean {
  const text = line.trim();
  return text.length === 0 || text.startsWith(PURGED_MARKER);
}

/**
 * The line that takes the place of `line`, the last line of a generated mirror, when purge
 * `purgeId` removes it: PURGED_MARKER with the purge's id, then what the adapter's next() reads of
 * the line (SourceAdapter.continuation), padded with spaces to `bytes`, the length of the line it
 * replaces. Null when the adapter has no continuation for the line or it does not fit; the line is
 * then blanked, and the stream does not go on from it (see generatedContent in ingest.ts).
 */
export function continuationLine(
  adapter: SourceAdapter,
  line: string,
  relPath: string,
  purgeId: string,
  bytes: number = Buffer.byteLength(line),
): string | null {
  let fields: Record<string, unknown> | null | undefined;
  try {
    fields = adapter.continuation?.(line, { relPath });
  } catch {
    return null;
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const rest = Object.entries(fields).filter(([key]) => key !== 'origin_purged');
  const text = JSON.stringify({ origin_purged: purgeId, ...Object.fromEntries(rest) });
  const size = Buffer.byteLength(text);
  return size <= bytes ? text + ' '.repeat(bytes - size) : null;
}

/** Blank bytes in place: each becomes a space, except a line break, so line numbers stay. */
export function blankBytes(bytes: Buffer, start = 0, end = bytes.length): void {
  for (let i = start; i < end; i++) {
    if (bytes[i] !== 0x0a) bytes[i] = 0x20;
  }
}

/**
 * Complete lines of a mirror's content from `offset`, as a device pushes them to its hub, with the
 * lines a purge blanked (`purge_line`) blanked here too, whether or not the mirror holds them
 * blanked yet. Returns `data` itself when nothing in it is purged.
 */
export function withPurgedLinesBlanked(
  db: Database,
  home: string,
  rawFileId: number,
  offset: number,
  data: Buffer,
): Buffer {
  if (data.length === 0 || !purgedLookup(db).any) return data;
  const ranges = db
    .prepare('SELECT first_line, line_count FROM purge_line WHERE raw_file_id = ?')
    .all(rawFileId) as Array<{ first_line: number; line_count: number }>;
  if (ranges.length === 0) return data;
  let lineNo = lineAt(db, home, rawFileId, offset);
  const purged = (n: number) =>
    ranges.some((r) => n >= r.first_line && n < r.first_line + r.line_count);
  let out: Buffer | null = null;
  let start = 0;
  while (start < data.length) {
    const nl = data.indexOf(0x0a, start);
    const end = nl < 0 ? data.length : nl;
    if (purged(lineNo)) {
      out ??= Buffer.from(data);
      blankBytes(out, start, end);
    }
    lineNo++;
    start = end + 1;
  }
  return out ?? data;
}

/** The number of the line that starts at `offset` of a mirror's content. */
function lineAt(db: Database, home: string, rawFileId: number, offset: number): number {
  const st = mirrorState(db, rawFileId);
  if (!st) return 1;
  let line = st.sealedLines + 1;
  let from = st.sealedBytes;
  if (offset < st.sealedBytes) {
    const frame = db
      .prepare(
        `SELECT first_line, byte_offset FROM raw_chunk
          WHERE raw_file_id = ? AND byte_offset <= ? ORDER BY byte_offset DESC LIMIT 1`,
      )
      .get(rawFileId, offset) as { first_line: number; byte_offset: number } | undefined;
    line = frame?.first_line ?? 1;
    from = frame?.byte_offset ?? 0;
  }
  const before = readMirror(db, home, rawFileId, from, offset);
  for (let i = before.indexOf(0x0a); i >= 0; i = before.indexOf(0x0a, i + 1)) line++;
  return line;
}
