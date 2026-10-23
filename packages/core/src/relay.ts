import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { readRange } from './frames.js';
import {
  type Content,
  completeLines,
  logSync,
  oldestFirst,
  TRANSACTION_BYTES,
  tailHash,
} from './ingest.js';
import { assertRelay } from './mode.js';
import { getSetting, setSetting } from './settings.js';
import type { SourceAdapter, SourceFile, SyncResult } from './types.js';

/**
 * Relay mode (see docs/architecture.md#relays). A relay keeps no raw mirrors and no events: it reads
 * the new complete lines of each source straight from the agent's own file (decompressed, or as its
 * adapter generates them) and sends them to its hub, which mirrors and parses them as it does the
 * mirrors a device pushes, so event ids are the same everywhere. All a relay keeps of a source file
 * is one cursor, in `setting`: how much of which generation the hub has acknowledged, a hash of the
 * last 4 KB of it to tell a rewrite, and for a generated source its token and the last line sent,
 * from which its adapter goes on. A cursor moves only once the hub holds the bytes.
 *
 * There is no network code here: the hub is reached through the RelayHub the caller passes in.
 */

/** Where the hub stands with one source file, as far as this relay knows. */
export interface RelayCursor {
  /** The generation of the file the hub is receiving: 1 at first, and the next one after a rewrite. */
  generation: number;
  /** Bytes of that generation's content the hub has acknowledged. */
  bytes: number;
  /**
   * SHA-256 of the last 4 KB acknowledged. For a generated source, its token once nothing was left
   * to send, and empty while lines may remain (as a generated source keeps it in raw_file).
   */
  tail: string;
  /** For a generated source: the last line the hub acknowledged, from which its adapter goes on. */
  last: string | null;
  /** When the cursor last changed (epoch ms). */
  at: number;
  /** For a compressed file: every complete line of its content as of `at` has been acknowledged. */
  done: boolean;
}

const CURSOR_PREFIX = 'relay.cursor:';

/** Source ids contain no `:`, so a source and a path make a unique key. */
const cursorKey = (source: string, path: string) => `${CURSOR_PREFIX}${source}:${path}`;

function parseCursor(value: unknown): RelayCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Record<string, unknown>;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (
    !count(c.generation) ||
    (c.generation as number) < 1 ||
    !count(c.bytes) ||
    typeof c.tail !== 'string' ||
    (c.last !== null && typeof c.last !== 'string') ||
    !count(c.at) ||
    typeof c.done !== 'boolean'
  ) {
    return null;
  }
  return c as unknown as RelayCursor;
}

/** The cursor of one source file of this relay, or null if it has none (or an unreadable one). */
export function relayCursor(db: Database, source: string, path: string): RelayCursor | null {
  const value = getSetting(db, cursorKey(source, path));
  if (value === null) return null;
  try {
    return parseCursor(JSON.parse(value));
  } catch {
    return null;
  }
}

export function saveRelayCursor(
  db: Database,
  source: string,
  path: string,
  cursor: RelayCursor,
): void {
  const { generation, bytes, tail, last, at, done } = cursor;
  setSetting(
    db,
    cursorKey(source, path),
    JSON.stringify({ generation, bytes, tail, last, at, done }),
  );
}

function sameCursor(a: RelayCursor, b: RelayCursor | null): boolean {
  return (
    b !== null &&
    a.generation === b.generation &&
    a.bytes === b.bytes &&
    a.tail === b.tail &&
    a.last === b.last &&
    a.at === b.at &&
    a.done === b.done
  );
}

/** One source file as a relay sends it: where the hub stands, and what follows. */
interface RelayFile {
  /** Where the hub stands, as far as this relay knows; the caller moves it on as the hub acknowledges. */
  cursor: RelayCursor;
  /** The source's modification time, sent along as the time of lines that carry none. */
  readonly mtimeMs: number;
  /**
   * The complete lines after `cursor`, at most `maxBytes` (or one longer line), and the cursor once
   * the hub has them; null when there are none.
   */
  next(maxBytes: number): { data: Buffer; cursor: RelayCursor } | null;
  /** Go on from `bytes` of the cursor's generation, where the hub says it stands; false if this file cannot. */
  align(bytes: number): boolean;
  /** The cursor once nothing is left to send: with a generated source's token, a compressed file marked done. */
  settled(): RelayCursor;
  /** Bytes not acknowledged by the hub yet (a trailing partial line included). */
  pending(): number;
}

/**
 * Open a source file to relay it, from its stored cursor and, unless `hub` is null (as offline, for
 * `origin status`), from where the hub stands: `hub` maps each generation of the file the hub holds
 * to its size there. Null when there is nothing to send: the file is gone, or unchanged since its
 * cursor and the hub holds all of it.
 */
function openRelayFile(
  file: SourceFile,
  stored: RelayCursor | null,
  hub: Map<number, number> | null,
  log?: (message: string) => void,
): RelayFile | null {
  const now = Date.now();
  const fresh = (generation: number): RelayCursor => ({
    generation,
    bytes: 0,
    tail: '',
    last: null,
    at: now,
    done: false,
  });
  const agrees = (c: RelayCursor) => hub === null || (hub.get(c.generation) ?? 0) === c.bytes;
  const newest = Math.max(0, ...(hub?.keys() ?? []));
  // Where to start when this relay has no cursor: the hub's newest generation of the file, if any.
  const initial = () => fresh(Math.max(1, newest));
  // When the hub holds bytes this file cannot go on from, the file takes a generation of its own.
  const beyond = (c: RelayCursor) => fresh(Math.max(c.generation, newest) + 1);

  if (file.generated) {
    const source = file.generated;
    if (stored && stored.tail === source.token && agrees(stored)) return null;
    /** The cursor at `bytes`, found by asking the adapter for lines from `from`; null if no line ends there. */
    const forward = (from: RelayCursor, bytes: number): RelayCursor | null => {
      let pos = bytes >= from.bytes ? from : fresh(from.generation);
      while (pos.bytes < bytes) {
        const lines = source.next(pos.last, TRANSACTION_BYTES);
        if (lines.length === 0) return null;
        let size = pos.bytes;
        for (const line of lines) {
          size += Buffer.byteLength(line) + 1;
          if (size >= bytes) {
            if (size > bytes) return null;
            return { ...pos, bytes, tail: '', last: line, at: Date.now() };
          }
        }
        pos = { ...pos, bytes: size, tail: '', last: lines[lines.length - 1] as string };
      }
      return pos;
    };
    let cursor = stored ?? initial();
    if (!agrees(cursor)) {
      cursor = forward(cursor, hub?.get(cursor.generation) ?? 0) ?? beyond(cursor);
    }
    const rf: RelayFile = {
      cursor,
      mtimeMs: source.mtimeMs,
      next(maxBytes) {
        const lines = source.next(rf.cursor.last, maxBytes);
        if (lines.length === 0) return null;
        if (lines.some((line) => line.includes('\n'))) {
          throw new OriginError('A generated line contains a line break.');
        }
        const data = Buffer.from(`${lines.join('\n')}\n`);
        return {
          data,
          cursor: {
            ...rf.cursor,
            bytes: rf.cursor.bytes + data.length,
            tail: '',
            last: lines[lines.length - 1] as string,
            at: Date.now(),
          },
        };
      },
      align(bytes) {
        const aligned = forward(rf.cursor, bytes);
        if (aligned) rf.cursor = aligned;
        return aligned !== null;
      },
      settled: () => ({ ...rf.cursor, tail: source.token, at: Date.now() }),
      pending() {
        let size = 0;
        let last = rf.cursor.last;
        for (;;) {
          const lines = source.next(last, TRANSACTION_BYTES);
          if (lines.length === 0) return size;
          for (const line of lines) size += Buffer.byteLength(line) + 1;
          last = lines[lines.length - 1] as string;
        }
      },
    };
    return rf;
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(file.absPath);
  } catch {
    return null; // deleted since discovery
  }
  // Compressed files are written once: skip one whose every line the hub has, unless it changed.
  if (file.compression && stored?.done && st.mtimeMs <= stored.at && agrees(stored)) return null;
  let content: Content;
  if (file.compression) {
    const data = zlib.zstdDecompressSync(fs.readFileSync(file.absPath));
    content = { size: data.length, mtimeMs: st.mtimeMs, read: (a, b) => data.subarray(a, b) };
  } else {
    content = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      read: (a, b) => readRange(file.absPath, a, b),
    };
  }
  const endsLine = (bytes: number) =>
    bytes === 0 || (bytes <= content.size && content.read(bytes - 1, bytes)[0] === 0x0a);
  const at = (generation: number, bytes: number): RelayCursor => ({
    generation,
    bytes,
    tail: tailHash(content, bytes),
    last: null,
    at: Date.now(),
    done: false,
  });

  let cursor: RelayCursor;
  if (!stored) cursor = initial();
  else if (
    content.size < stored.bytes ||
    (stored.bytes > 0 && tailHash(content, stored.bytes) !== stored.tail)
  ) {
    // Rewritten rather than appended to: the hub keeps the old generation and receives a new one.
    log?.(`rewrite detected, new generation: ${file.relPath}`);
    cursor = fresh(stored.generation + 1);
  } else cursor = stored;
  if (!agrees(cursor)) {
    // The hub holds more or less of this generation than this relay knew (a lost answer, another
    // process, a hub restored from a backup): go on from there if this file has a line ending there.
    const bytes = hub?.get(cursor.generation) ?? 0;
    cursor = endsLine(bytes) ? at(cursor.generation, bytes) : beyond(cursor);
  }
  if (!file.compression && cursor === stored && content.size === stored.bytes) return null;

  const rf: RelayFile = {
    cursor,
    mtimeMs: st.mtimeMs,
    next(maxBytes) {
      const start = rf.cursor.bytes;
      if (start >= content.size) return null;
      const data = completeLines(content, start, Math.min(content.size, start + maxBytes));
      if (!data) return null;
      return { data, cursor: at(rf.cursor.generation, start + data.length) };
    },
    align(bytes) {
      if (!endsLine(bytes)) return false;
      rf.cursor = at(rf.cursor.generation, bytes);
      return true;
    },
    settled: () =>
      file.compression
        ? {
            ...rf.cursor,
            done: completeLines(content, rf.cursor.bytes, content.size) === null,
            at: Date.now(),
          }
        : rf.cursor,
    pending: () => Math.max(0, content.size - rf.cursor.bytes),
  };
  return rf;
}

/** A piece of a source file for the hub's `/v1/ingest`: complete lines at `offset` of `generation`. */
export interface RelayChunk {
  source: string;
  /** The original file (for a generated source, the path that names it). */
  path: string;
  /** Path relative to the adapter root, `/`-separated. */
  relPath: string;
  generation: number;
  offset: number;
  data: Buffer;
  mtimeMs: number;
  agentVersion: string | null;
}

/** What the hub made of a chunk. */
export type RelayAnswer =
  /** Stored and parsed: the hub now holds `bytes` of the generation. */
  | {
      status: 'accepted';
      bytes: number;
      linesRead: number;
      eventsAdded: number;
      parseErrors: number;
    }
  /** Not at the hub's cursor, which is `bytes`. */
  | { status: 'conflict'; bytes: number }
  /** Refused for this file (an invalid chunk, one too large): the relay goes on with the others. */
  | { status: 'refused'; reason: string };

/** The hub, as a relay reaches it. */
export interface RelayHub {
  /** The size of each generation the hub holds of this device's file `path` of `source`. */
  holds(source: string, path: string): Map<number, number>;
  /** Send one chunk. Throws when the hub cannot be reached or refuses the relay as a whole. */
  send(chunk: RelayChunk): Promise<RelayAnswer>;
}

export interface RelayResult extends SyncResult {
  /** Bytes the hub acknowledged in this run. */
  bytes: number;
  /** Files that could not be sent, each with why; their cursors did not move. */
  failed: Array<{ path: string; reason: string }>;
}

export interface RelayContext {
  db: Database;
  log?: (message: string) => void;
  /** Most bytes per chunk, unless one line is longer (default 1 MiB). */
  chunkBytes?: number;
}

/**
 * Relay one source: send the hub the complete lines of each of its files that the hub does not
 * hold yet, read straight from the files, oldest file first (see docs/architecture.md#relays).
 * Each cursor is saved as soon as the hub acknowledges a chunk, so an interrupted run resumes where
 * it stopped, and running again sends nothing. A chunk the hub rejects for its offset is sent again
 * from where the hub stands, if the file has a line ending there.
 */
export async function relaySource(
  ctx: RelayContext,
  adapter: SourceAdapter,
  hub: RelayHub,
): Promise<RelayResult> {
  assertRelay(ctx.db);
  const startedAt = Date.now();
  const result: RelayResult = {
    source: adapter.id,
    filesSeen: 0,
    filesChanged: 0,
    linesRead: 0,
    eventsAdded: 0,
    parseErrors: 0,
    newGenerations: 0,
    durationMs: 0,
    bytes: 0,
    failed: [],
  };
  const files = oldestFirst(await adapter.discover());
  result.filesSeen = files.length;
  const agentVersion = adapter.version();
  const chunkBytes = ctx.chunkBytes ?? TRANSACTION_BYTES;
  const fail = (file: SourceFile, reason: string) => {
    result.failed.push({ path: file.absPath, reason });
    ctx.log?.(`not relayed: ${file.relPath}: ${reason}`);
  };

  // Most files have not changed; between them, let an MCP server answer tool calls now and then.
  let ranSince = Date.now();
  for (const file of files) {
    if (Date.now() - ranSince >= 20) {
      await new Promise((resolve) => setImmediate(resolve));
      ranSince = Date.now();
    }
    const stored = relayCursor(ctx.db, adapter.id, file.absPath);
    let rf: RelayFile | null;
    try {
      rf = openRelayFile(file, stored, hub.holds(adapter.id, file.absPath), ctx.log);
    } catch (err) {
      fail(file, (err as Error).message);
      continue;
    }
    if (!rf) continue;
    const relPath = file.relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    let sent = false;
    let conflicts = 0;
    let complete = true;
    for (;;) {
      let piece: ReturnType<RelayFile['next']>;
      try {
        piece = rf.next(chunkBytes);
      } catch (err) {
        fail(file, (err as Error).message);
        complete = false;
        break;
      }
      if (!piece) break;
      const { generation, bytes: offset } = rf.cursor;
      const answer = await hub.send({
        source: adapter.id,
        path: file.absPath,
        relPath,
        generation,
        offset,
        data: piece.data,
        mtimeMs: rf.mtimeMs,
        agentVersion,
      });
      if (answer.status === 'refused') {
        fail(file, answer.reason);
        complete = false;
        break;
      }
      if (answer.status === 'conflict') {
        // Another process sent these lines first, or the hub holds more or less of the file than
        // this relay knew: go on from where the hub stands.
        let aligned = false;
        try {
          aligned = ++conflicts <= 3 && rf.align(answer.bytes);
        } catch {
          aligned = false;
        }
        if (!aligned) {
          fail(
            file,
            `the hub holds ${answer.bytes} bytes of generation ${generation}, and this file cannot go on from there`,
          );
          complete = false;
          break;
        }
        saveRelayCursor(ctx.db, adapter.id, file.absPath, rf.cursor);
        continue;
      }
      if (stored && generation > stored.generation && !sent) result.newGenerations++;
      rf.cursor = piece.cursor;
      saveRelayCursor(ctx.db, adapter.id, file.absPath, rf.cursor);
      sent = true;
      result.bytes += piece.data.length;
      result.linesRead += answer.linesRead;
      result.eventsAdded += answer.eventsAdded;
      result.parseErrors += answer.parseErrors;
    }
    if (complete) {
      const settled = rf.settled();
      if (!sameCursor(settled, stored)) saveRelayCursor(ctx.db, adapter.id, file.absPath, settled);
    }
    if (sent) result.filesChanged++;
  }

  result.durationMs = Date.now() - startedAt;
  logSync(ctx.db, {
    source: adapter.id,
    startedAt,
    filesSeen: result.filesSeen,
    filesChanged: result.filesChanged,
    stats: result,
    note: [
      'relay',
      result.newGenerations > 0 ? `new generations: ${result.newGenerations}` : null,
      result.failed.length > 0 ? `failed: ${result.failed.length}` : null,
    ]
      .filter(Boolean)
      .join('; '),
  });
  return result;
}

/** What a relay has not sent of one source yet, as far as its cursors tell, without the hub. */
export interface RelayPending {
  source: string;
  files: number;
  pendingFiles: number;
  /** Bytes not acknowledged by the hub, a trailing partial line included. */
  pendingBytes: number;
}

export async function relayPending(db: Database, adapter: SourceAdapter): Promise<RelayPending> {
  const pending: RelayPending = { source: adapter.id, files: 0, pendingFiles: 0, pendingBytes: 0 };
  for (const file of await adapter.discover()) {
    pending.files++;
    let bytes = 0;
    try {
      bytes = openRelayFile(file, relayCursor(db, adapter.id, file.absPath), null)?.pending() ?? 0;
    } catch {
      bytes = 0; // unreadable now; a sync reports it
    }
    if (bytes > 0) {
      pending.pendingFiles++;
      pending.pendingBytes += bytes;
    }
  }
  return pending;
}

/** The last time each source was relayed, from the sync log. */
export function lastRelayed(
  db: Database,
  source: string,
): { at: number; eventsAdded: number } | null {
  const row = db
    .prepare(
      `SELECT finished_at, events_added FROM sync_log
       WHERE source = ? AND note LIKE 'relay%' ORDER BY id DESC LIMIT 1`,
    )
    .get(source) as { finished_at: number; events_added: number } | undefined;
  return row ? { at: row.finished_at, eventsAdded: row.events_added } : null;
}
