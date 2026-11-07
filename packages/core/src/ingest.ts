import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { authorWriter, recordSessionKind } from './authors.js';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { OriginError } from './errors.js';
import { readRange } from './frames.js';
import { storeName } from './identity.js';
import { importMemory } from './memories.js';
import {
  appendMirror,
  FRAME_BYTES,
  IDLE_SEAL_MS,
  type MirrorState,
  mirrorState,
  readMirror,
  readMirrorLine,
  sealIdleMirrors,
  settleMirror,
} from './mirror.js';
import { assertComplete } from './mode.js';
import { recordSessionParent } from './parents.js';
import { distinctRelPath, mirrorRelPath, parseRawPath, rawDir, remotePath } from './paths.js';
import {
  applyPlaceFacts,
  isOriginPlacesFile,
  parsePlaceLine,
  placesSourceFile,
  recordExplicitPlace,
  rememberPlaceHead,
} from './places.js';
import { deriveProposal } from './proposals.js';
import { blankBytes, isSkippedLine, type PurgedLookup, purgedLookup } from './purged.js';
import { deriveFollow, refreshThreads } from './threads.js';
import { NAME_RE } from './tokens.js';
import type {
  EventInput,
  GeneratedSource,
  ParsedLine,
  SessionParentFact,
  SourceAdapter,
  SourceFile,
  SyncResult,
} from './types.js';

const TAIL_WINDOW = 4096;

interface RawFileRow {
  id: number;
  source: string;
  path: string;
  generation: number;
  mirror: string;
  bytes_ingested: number;
  lines_ingested: number;
  tail_hash: string;
  updated_at: number;
}

const RAW_COLUMNS =
  'id, source, path, generation, mirror, bytes_ingested, lines_ingested, tail_hash, updated_at';

export interface IngestContext {
  db: Database;
  /**
   * ORIGIN_HOME; mirrors are written to `<home>/raw/<source>/...`, and on a hub, files replicated
   * from devices to `<home>/raw/devices/<device>/<source>/...`.
   */
  home: string;
  log?: (message: string) => void;
  /**
   * Called for each line that yields nothing because it is not valid, with the file's path, the
   * line's number in it, and why: the hub tells a writer of event lines the first few.
   */
  onParseError?: (path: string, line: number, reason: string) => void;
  /** Size at which a mirror's open tail is sealed into zstd frames (default FRAME_BYTES; tests). */
  frameBytes?: number;
  /**
   * Sessions whose events, title, or place changed during this sync. A places file is built only
   * for these. The caller that sets it owns the set; syncSource uses one of its own.
   */
  touchedSessions?: Set<string>;
}

/** Counters shared by local syncs and remote appends. */
export interface AppendStats {
  linesRead: number;
  eventsAdded: number;
  parseErrors: number;
  /** Lines that yielded events, all of which the store already had: lines sent again. */
  duplicates: number;
  /**
   * Lines mirrored blank because a purge removed what they hold, or blocked their file (see
   * purged.ts); present only when there were any.
   */
  purged?: number;
}

/**
 * Ingest one source: discover files → read newly appended bytes → mirror to raw → parse
 * deterministically → append events to the store.
 * Idempotent: re-running never inserts duplicate events. When a source file is rewritten (not
 * appended to), a new generation is opened and the old mirror is kept (invariant 3, append-only,
 * see docs/architecture.md).
 */
export async function syncSource(ctx: IngestContext, adapter: SourceAdapter): Promise<SyncResult> {
  // A relay sends its agents' logs to its hub instead (see relay.ts); it mirrors nothing itself.
  assertComplete(ctx.db, "ingest its agents' logs");
  const startedAt = Date.now();
  const result = emptySyncResult(adapter.id);
  const files = oldestFirst(await adapter.discover());
  result.filesSeen = files.length;
  const agentVersion = adapter.version();
  const breathe = breather();
  // Only sessions this sync added or changed are resolved. The set is not left on the caller's ctx.
  const touchedSessions = new Set<string>();
  const scoped: IngestContext = { ...ctx, touchedSessions };

  for (const file of files) {
    await breathe();
    if (await ingestSourceFile(scoped, adapter, file, agentVersion, result, breathe)) {
      result.filesChanged++;
    }
  }
  // A resolved work tree, appended as places.jsonl. Event counts stay out of this result, so a
  // sync that only mirrored events still reports those. A bad line's warning is kept: one broken
  // places line must show up, and must not be the only record of it. A missing path appends nothing.
  // Nothing new this sync: no git walks and no read of the places mirror.
  const places = placesSourceFile(ctx.db, ctx.home, adapter.id, { touchedSessions });
  if (places) {
    const placesResult = emptySyncResult(adapter.id);
    await ingestSourceFile(scoped, adapter, places, agentVersion, placesResult, breathe);
    result.parseErrors += placesResult.parseErrors;
  }
  // Files that stopped growing an hour ago are likely finished: store their last lines compressed.
  sealIdleMirrors(ctx.db, ctx.home, {
    before: Date.now() - IDLE_SEAL_MS,
    remote: false,
    source: adapter.id,
    frameBytes: ctx.frameBytes,
  });

  result.durationMs = Date.now() - startedAt;
  logSync(ctx.db, {
    source: adapter.id,
    startedAt,
    filesSeen: result.filesSeen,
    filesChanged: result.filesChanged,
    stats: result,
    note: result.newGenerations > 0 ? `new generations: ${result.newGenerations}` : null,
  });
  return result;
}

/**
 * Append one generated `places.jsonl`. Its counts are not merged into a sync: callers that only
 * want the mirror use this after `reproject`.
 */
export async function ingestPlacesFile(
  ctx: IngestContext,
  source: string,
  file: SourceFile,
): Promise<void> {
  const adapter: SourceAdapter = {
    id: source,
    displayName: source,
    version: () => null,
    async discover() {
      return [];
    },
    parseLine: (line) => parsePlaceLine(line),
  };
  await ingestSourceFile(ctx, adapter, file, null, emptySyncResult(source), breather());
}

/**
 * Ingest one file of a source, as syncSource ingests each file it discovers: the file the adapter
 * locates at `absPath` (see SourceAdapter.locate), read from its cursor, its new complete lines
 * mirrored and parsed, with rewrite detection, sealing, titles, native memories, threads, and
 * session aggregates, in the same bounded write transactions. An agent's hook calls it with the
 * transcript it names, so that a session's new lines arrive without a scan of every source (see
 * docs/architecture.md#live-ingestion). A path the adapter does not locate, or that is not a file
 * now, is ingested as nothing (`filesSeen` 0). Sealing the tails of idle mirrors is left to
 * syncSource, and a sync_log row is recorded only when lines were read.
 */
export async function syncFile(
  ctx: IngestContext,
  adapter: SourceAdapter,
  absPath: string,
): Promise<SyncResult> {
  assertComplete(ctx.db, "ingest its agents' logs");
  const startedAt = Date.now();
  const result = emptySyncResult(adapter.id);
  // The hook path resolves the sessions this file touched, the same way a full sync does. The next
  // sync sees the file unchanged and would otherwise leave the session without a project.
  const touchedSessions = new Set<string>();
  const scoped: IngestContext = { ...ctx, touchedSessions };
  const file = adapter.locate?.(absPath) ?? null;
  const agentVersion = adapter.version();
  if (file && !file.generated && isFile(file.absPath)) {
    result.filesSeen = 1;
    if (await ingestSourceFile(scoped, adapter, file, agentVersion, result, breather())) {
      result.filesChanged = 1;
    }
  }
  const places = placesSourceFile(ctx.db, ctx.home, adapter.id, { touchedSessions });
  if (places) {
    const placesResult = emptySyncResult(adapter.id);
    await ingestSourceFile(scoped, adapter, places, agentVersion, placesResult, breather());
    result.parseErrors += placesResult.parseErrors;
  }
  result.durationMs = Date.now() - startedAt;
  if (result.linesRead > 0) {
    logSync(ctx.db, {
      source: adapter.id,
      startedAt,
      filesSeen: result.filesSeen,
      filesChanged: result.filesChanged,
      stats: result,
      note: result.newGenerations > 0 ? `new generations: ${result.newGenerations}` : null,
    });
  }
  return result;
}

export function emptySyncResult(source: string): SyncResult {
  return {
    source,
    filesSeen: 0,
    filesChanged: 0,
    linesRead: 0,
    eventsAdded: 0,
    parseErrors: 0,
    duplicates: 0,
    newGenerations: 0,
    durationMs: 0,
  };
}

/** Whether a path is a regular file now (following links), as discover() lists them. */
export function isFile(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Ingest the new complete lines of one file, if it changed since its last ingestion; returns
 * whether anything was ingested (or a new generation opened). Adds its counts to `result`.
 */
async function ingestSourceFile(
  ctx: IngestContext,
  adapter: SourceAdapter,
  file: SourceFile,
  agentVersion: string | null,
  result: SyncResult,
  breathe: () => Promise<void>,
): Promise<boolean> {
  // Most files have not changed since the last sync; that needs no write lock.
  if (isUnchanged(ctx, adapter.id, file)) return false;
  // New lines go in write transactions of at most TRANSACTION_BYTES each, so that other processes
  // (the CLI, one MCP server per agent session, agents' hooks) never wait long for the lock, even
  // during a large import. The cursor is re-read under the lock, so concurrent syncs never ingest
  // the same bytes twice.
  let changed = false;
  for (;;) {
    await breathe();
    const step = transaction(ctx.db, () => ingestFile(ctx, adapter, file, agentVersion, result), {
      immediate: true,
    });
    if (step.sealed !== null) settleMirror(ctx.db, ctx.home, step.sealed);
    if (step.status !== 'none') changed = true;
    if (step.status !== 'more') break;
  }
  return changed;
}

/** A sync lets other work run at least this often (see syncSource). */
const YIELD_EVERY_MS = 20;

/**
 * Between write transactions, let the process do other work now and then: an MCP server keeps
 * answering tool calls while it ingests in the background.
 */
function breather(): () => Promise<void> {
  let ranSince = Date.now();
  return async () => {
    if (Date.now() - ranSince < YIELD_EVERY_MS) return;
    await new Promise((resolve) => setImmediate(resolve));
    ranSince = Date.now();
  };
}

/**
 * What the adapters' files look like now, as one digest of each file's path, size, and
 * modification time. It reads no file contents, so comparing it with the one taken before the
 * last sync tells cheaply whether there may be anything new to ingest.
 */
export async function fingerprintSources(adapters: SourceAdapter[]): Promise<string> {
  const hash = createHash('sha256');
  for (const adapter of adapters) {
    const files = (await adapter.discover()).sort((a, b) => a.absPath.localeCompare(b.absPath));
    for (const file of files) {
      let state = 'missing';
      if (file.generated) state = `generated:${file.generated.token}`;
      else {
        try {
          const st = fs.statSync(file.absPath);
          state = `${st.size}:${st.mtimeMs}`;
        } catch {
          // deleted since discovery
        }
      }
      hash.update(`${adapter.id}\0${file.absPath}\0${state}\n`);
    }
  }
  return hash.digest('hex');
}

/**
 * Files oldest first, by modification time, so that the order events arrive in follows time as far
 * as possible: a first sync ingests old sessions before new ones, which keeps newest-first queries
 * short (see event_block in schema.ts).
 */
export function oldestFirst(files: SourceFile[]): SourceFile[] {
  const mtime = new Map<SourceFile, number>();
  for (const f of files) {
    if (f.generated) {
      mtime.set(f, f.generated.mtimeMs);
      continue;
    }
    try {
      mtime.set(f, fs.statSync(f.absPath).mtimeMs);
    } catch {
      mtime.set(f, Number.POSITIVE_INFINITY); // deleted since discovery
    }
  }
  return [...files].sort((a, b) => (mtime.get(a) as number) - (mtime.get(b) as number));
}

/**
 * New complete lines of a file are ingested in transactions of at most this many bytes (or one
 * longer line). Compressed files are ingested whole: they are written once, and are recognized as
 * unchanged by their modification time only once they have been ingested completely.
 */
export const TRANSACTION_BYTES = 1024 * 1024;

/**
 * Whether a file is known and unchanged since its last ingestion, checked without the write lock:
 * the same size and tail for a plain file, no newer modification for a compressed one. Anything
 * else is looked at again under the lock.
 */
function isUnchanged(ctx: IngestContext, source: string, file: SourceFile): boolean {
  if (isBlocked(ctx.db, source, file.absPath)) return true;
  const raw = latestRawFile(ctx.db, source, file.absPath);
  if (!raw) return false;
  // A generated source keeps its token where a file keeps the hash of its tail.
  if (file.generated) return raw.tail_hash === file.generated.token;
  let st: fs.Stats;
  try {
    st = fs.statSync(file.absPath);
  } catch {
    return true; // deleted since discovery: nothing to ingest
  }
  if (file.compression) return st.mtimeMs <= raw.updated_at;
  return st.size === raw.bytes_ingested && tailMatches(fileContent(file.absPath), raw);
}

/**
 * Whether a purge blocked the file: it is never read again, a generated source never asked for
 * more, whatever it holds now.
 */
function isBlocked(db: Database, source: string, absPath: string): boolean {
  const purged = purgedLookup(db);
  return purged.any && purged.file(source, absPath) !== null;
}

/** What one ingestion step did, and the raw file whose mirror it sealed frames for, if any. */
interface Step {
  status: 'none' | 'more' | 'done';
  sealed: number | null;
}

const NOTHING: Step = { status: 'none', sealed: null };

/**
 * Ingest the next newly appended complete lines of one file, at most TRANSACTION_BYTES of them:
 * `none` if there were none, `more` if complete lines may remain, `done` otherwise. Must run inside
 * a write transaction.
 */
function ingestFile(
  ctx: IngestContext,
  adapter: SourceAdapter,
  file: SourceFile,
  agentVersion: string | null,
  result: SyncResult,
): Step {
  // Checked again under the lock: a purge may have blocked the file since it was found changed.
  if (isBlocked(ctx.db, adapter.id, file.absPath)) return NOTHING;
  let raw = latestRawFile(ctx.db, adapter.id, file.absPath);
  const content = openContent(ctx, file, raw);
  if (!content) return NOTHING;
  // Generated content only grows, by construction, so it is never rewritten. A file whose mirror
  // another file shares, as an earlier version let two files with one name do, goes on in a mirror
  // of its own rather than write into the other's (see Raw mirrors in docs/architecture.md).
  const rewritten =
    raw && !file.generated && (content.size < raw.bytes_ingested || !tailMatches(content, raw));
  const shared = raw !== null && sharesMirror(ctx.db, raw);
  if (raw && (rewritten || shared)) {
    ctx.log?.(
      `${rewritten ? 'rewrite detected' : 'mirror shared with another file'}, new generation: ${file.relPath}`,
    );
    const generation = raw.generation + 1;
    raw = createRawFile(
      ctx.db,
      adapter.id,
      file.absPath,
      newMirror(ctx.db, [adapter.id], file.relPath, generation, file.absPath),
      generation,
    );
    result.newGenerations++;
  }
  if (!raw) {
    raw = createRawFile(
      ctx.db,
      adapter.id,
      file.absPath,
      newMirror(ctx.db, [adapter.id], file.relPath, 1, file.absPath),
      1,
    );
  }
  if (content.size === raw.bytes_ingested) {
    // Nothing new: keep the token, so that the source is not asked again until it changes.
    if (file.generated && raw.tail_hash !== file.generated.token) {
      ctx.db
        .prepare('UPDATE raw_file SET tail_hash = ? WHERE id = ?')
        .run(file.generated.token, raw.id);
    }
    return NOTHING;
  }

  const start = raw.bytes_ingested;
  const end =
    file.compression || file.generated
      ? content.size
      : Math.min(content.size, start + TRANSACTION_BYTES);
  const chunk = completeLines(content, start, end);
  if (!chunk) return NOTHING; // no complete line yet

  const sealed = appendLines(
    ctx,
    adapter,
    raw,
    chunk,
    {
      absPath: file.absPath,
      relPath: file.relPath,
      fileMtimeMs: content.mtimeMs,
      agentVersion,
      generated: file.generated !== undefined,
    },
    file.generated
      ? content.more
        ? ''
        : file.generated.token
      : tailHash(content, start + chunk.length),
    result,
  );
  return {
    status: start + chunk.length < content.size || content.more ? 'more' : 'done',
    sealed: sealed ? raw.id : null,
  };
}

/**
 * The complete lines of `content` from `start` (before its size), read up to `end`, or further for
 * a line longer than that, which is taken whole; null if no line is complete yet.
 */
export function completeLines(content: Content, start: number, end: number): Buffer | null {
  let to = end;
  let chunk = content.read(start, to);
  let lastNl = chunk.lastIndexOf(0x0a);
  while (lastNl < 0 && to < content.size) {
    // A line longer than the bound: read on until it ends, and take it whole.
    to = Math.min(content.size, start + (to - start) * 2);
    chunk = content.read(start, to);
    lastNl = chunk.lastIndexOf(0x0a);
  }
  return lastNl < 0 ? null : chunk.subarray(0, lastNl + 1);
}

/**
 * Parse complete lines of a raw file, insert their events, derive the entries of the native
 * memories they carry, refresh the touched sessions, append the lines to the file's mirror, and
 * advance the cursor, whose tail hash after these lines is `newTailHash`. Shared by local syncs and
 * hub appends; must run inside a write transaction. Returns whether frames of the mirror were
 * sealed (see appendMirror).
 */
function appendLines(
  ctx: IngestContext,
  adapter: SourceAdapter,
  raw: RawFileRow,
  chunk: Buffer,
  parse: {
    absPath: string;
    relPath: string;
    fileMtimeMs: number;
    agentVersion: string | null;
    /** On a hub, the device that sent the file; unset for this store's own files. */
    device?: string;
    /** This chunk is Origin's generated places file, not a file a person wrote. */
    generated?: boolean;
  },
  newTailHash: string,
  stats: AppendStats,
): boolean {
  // Lines ingested before these, read from the mirror (an adapter may need a file's first line).
  const readLine = (n: number) =>
    n >= 1 && n <= raw.lines_ingested ? readMirrorLine(ctx.db, ctx.home, raw.id, n) : null;
  const lines = chunk.toString('utf8').split('\n');
  lines.pop(); // trailing empty string
  const baseLine = raw.lines_ingested;
  const touchedSessions = new Set<string>();
  // What a purge removed stays out: a line that holds any of it, or any line of a file a purge
  // blocked, is mirrored as spaces of the same length, so that byte offsets and line numbers stay
  // those of the source file and of a device's cursor, and nothing is read from it.
  const purged = purgedLookup(ctx.db);
  const blocked = purged.any ? purged.file(adapter.id, raw.path) : null;
  let mirrored = chunk;
  const blank = (start: number, end: number) => {
    if (mirrored === chunk) mirrored = Buffer.from(chunk);
    blankBytes(mirrored, start, end);
    stats.purged = (stats.purged ?? 0) + 1;
  };
  // Where the line being parsed starts and ends in `chunk` (line breaks are single bytes).
  let lineStart = 0;
  let lineEnd = -1;
  const insert = eventInserter(ctx.db, adapter.id, raw.id, parse.agentVersion, purged);
  // The latest title wins, except that a generated one never replaces one the user gave.
  const setTitle = ctx.db.prepare(
    `INSERT INTO session (source, session_id, title, title_manual) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, session_id) DO UPDATE
         SET title = excluded.title, title_manual = excluded.title_manual
         WHERE excluded.title_manual >= session.title_manual`,
  );
  for (let i = 0; i < lines.length; i++) {
    const lineNo = baseLine + i + 1;
    lineStart = lineEnd + 1;
    lineEnd = chunk.indexOf(0x0a, lineStart);
    let line = lines[i] ?? '';
    if (line.endsWith('\r')) line = line.slice(0, -1);
    // Origin's places file: generated locally, or a device file whose raw path is `places.jsonl`
    // (`@device:places.jsonl` on a hub). A person's file of that name is parsed by the adapter.
    const originPlaces = isOriginPlacesFile(parse.relPath, raw.path, parse.generated);
    // A blank line, or one a purge replaced: nothing to read. A places line of spaces is still the
    // file's latest, which its generator compares with the last line it wrote (see places.ts).
    if (isSkippedLine(line)) {
      if (originPlaces && line.length > 0) {
        rememberPlaceHead(ctx.db, adapter.id, parse.device ?? '', line, true);
      }
      continue;
    }
    stats.linesRead++;
    if (blocked !== null) {
      blank(lineStart, lineEnd);
      continue;
    }
    let parsed: ReturnType<SourceAdapter['parseLine']>;
    try {
      // places.jsonl is parsed here, so a source whose adapter does not know the file still
      // applies it. The adapter's own parseLine stays free of git.
      parsed = originPlaces
        ? parsePlaceLine(line)
        : adapter.parseLine(line, {
            absPath: parse.absPath,
            relPath: parse.relPath,
            lineNo,
            fileMtimeMs: parse.fileMtimeMs,
            readLine,
            generated: false,
          });
    } catch (err) {
      stats.parseErrors++;
      ctx.log?.(`parse error ${parse.relPath}:${lineNo}: ${(err as Error).message}`);
      ctx.onParseError?.(parse.relPath, lineNo, (err as Error).message);
      continue;
    }
    if (!parsed) continue;
    if (purged.any && removedBy(purged, adapter.id, parsed, originPlaces) !== null) {
      blank(lineStart, lineEnd);
      if (originPlaces) {
        const spaces = ' '.repeat(lineEnd - lineStart);
        rememberPlaceHead(ctx.db, adapter.id, parse.device ?? '', spaces, true);
      }
      continue;
    }
    // A places line that is not the object its type requires. The bytes stay; the line changes
    // nothing, and it is recorded as the tip only so a later line is still the latest.
    if (originPlaces) {
      rememberPlaceHead(ctx.db, adapter.id, parse.device ?? '', line, Boolean(parsed.warning));
    }
    if (parsed.warning) {
      stats.parseErrors++;
      ctx.log?.(`warning ${parse.relPath}:${lineNo}: ${parsed.warning}`);
      ctx.onParseError?.(parse.relPath, lineNo, parsed.warning);
      continue;
    }
    const added = insert(lineNo, parsed.events);
    if (parsed.events.length > 0 && added.length === 0) stats.duplicates++;
    for (const ev of added) {
      stats.eventsAdded++;
      // A memory event belongs to no conversation: it is counted in no session.
      if (ev.kind !== 'memory') touchedSessions.add(ev.sessionId);
      // The result of `follow` links its session to the one it continues (see threads.ts), and the
      // result of `propose` holds a proposal (see proposals.ts).
      const stored = { ...ev, id: `${adapter.id}:${ev.id}`, source: adapter.id };
      deriveFollow(ctx.db, stored, purged);
      deriveProposal(ctx.db, stored, purged);
    }
    if (parsed.memory) {
      try {
        const growthOrigin = storeName(ctx.db);
        importMemory(
          ctx.db,
          { source: adapter.id, device: parse.device ?? growthOrigin, growthOrigin, purged },
          parsed.memory,
        );
      } catch (err) {
        if (!(err instanceof OriginError)) throw err;
        stats.parseErrors++;
        ctx.log?.(`memory not imported ${parse.relPath}:${lineNo}: ${err.message}`);
        ctx.onParseError?.(parse.relPath, lineNo, err.message);
      }
    }
    if (parsed.sessionTitle && parsed.sessionId) {
      setTitle.run(adapter.id, parsed.sessionId, parsed.sessionTitle, parsed.manualTitle ? 1 : 0);
      touchedSessions.add(parsed.sessionId);
    }
    // A session this line says is an agent's or a program's: whose its inputs are changes, and with
    // it whether it is the owner's conversation, so its threads are looked at again.
    // Facts about other sessions than the line's own: none about a session a purge removed.
    for (const fact of parsed.sessionKinds ?? []) {
      if (purged.any && purged.session(adapter.id, fact.sessionId) !== null) continue;
      if (recordSessionKind(ctx.db, adapter.id, fact)) touchedSessions.add(fact.sessionId);
    }
    if (originPlaces) {
      const applied = applyPlaceFacts(
        ctx.db,
        adapter.id,
        parsed,
        Date.now(),
        parse.device ?? '',
        purged,
      );
      for (const sessionId of applied.sessions) touchedSessions.add(sessionId);
    }
    for (const ev of parsed.events) {
      if (ev.projectSignal === 'explicit' && ev.project) {
        recordExplicitPlace(ctx.db, adapter.id, ev.sessionId, ev.project);
      }
    }
    // A session this line says has a parent: it joins that session's thread, and leaves a
    // top-level list. A parent carried by a places line counts only from Origin's places file.
    // An agent's own line (fromAgent) still counts from the session file.
    for (const fact of parsed.sessionParents ?? []) {
      if (!originPlaces && !fact.fromAgent) continue;
      if (purged.any && parentRemovedBy(purged, adapter.id, fact) !== null) continue;
      if (recordSessionParent(ctx.db, adapter.id, fact)) touchedSessions.add(fact.sessionId);
    }
  }
  if (ctx.touchedSessions) {
    for (const sessionId of touchedSessions) ctx.touchedSessions.add(sessionId);
  }
  for (const sessionId of touchedSessions) refreshSession(ctx.db, adapter.id, sessionId);
  refreshThreads(
    ctx.db,
    [...touchedSessions].map((sessionId) => ({ source: adapter.id, sessionId })),
  );
  const st = mirrorState(ctx.db, raw.id) as MirrorState;
  const sealed = appendMirror(ctx.db, ctx.home, st, mirrored, ctx.frameBytes ?? FRAME_BYTES);
  ctx.db
    .prepare(
      `UPDATE raw_file SET bytes_ingested = ?, lines_ingested = ?, tail_hash = ?, updated_at = ?
         WHERE id = ?`,
    )
    .run(
      raw.bytes_ingested + chunk.length,
      baseLine + lines.length,
      newTailHash,
      Date.now(),
      raw.id,
    );
  return sealed;
}

/**
 * The purge that removed what a parsed line holds, if any: one of its events, by id or by session,
 * or the session it titles; for a places line, a session it places, or the child or the parent a
 * parent line names. Such a line is mirrored blank (see appendLines).
 */
function removedBy(
  purged: PurgedLookup,
  source: string,
  parsed: ParsedLine,
  placesLine: boolean,
): string | null {
  for (const ev of parsed.events) {
    const by = purged.event(`${source}:${ev.id}`) ?? purged.session(source, ev.sessionId);
    if (by !== null) return by;
  }
  if (parsed.sessionTitle && parsed.sessionId) {
    const by = purged.session(source, parsed.sessionId);
    if (by !== null) return by;
  }
  if (!placesLine) return null;
  for (const place of parsed.places ?? []) {
    const by = purged.session(source, place.sessionId);
    if (by !== null) return by;
  }
  for (const fact of parsed.sessionParents ?? []) {
    const by = parentRemovedBy(purged, source, fact);
    if (by !== null) return by;
  }
  return null;
}

/** The purge that removed the child or the parent session a parent fact names, if any. */
function parentRemovedBy(
  purged: PurgedLookup,
  source: string,
  fact: SessionParentFact,
): string | null {
  return (
    purged.session(source, fact.sessionId) ??
    purged.session(fact.parentSource ?? source, fact.parentSessionId)
  );
}

/** The columns of an event a line yields, in the order eventInserter binds them. */
const EVENT_COLUMNS = `id, source, session_id, parent_id, ts, project, cwd, git_branch, role, kind,
  text, raw_file_id, raw_line, agent_version, meta`;

/**
 * The `seq` of the next event once a store holds a purge: after the last event, and after every
 * event a purge deleted (`purge.seq_floor`), so that no number a changes cursor may have passed is
 * given out again (see changesSince).
 */
const NEXT_SEQ_AFTER_PURGES = `(SELECT COALESCE(MAX(n), 0) + 1 FROM (
    SELECT MAX(seq) AS n FROM event UNION ALL SELECT MAX(seq_floor) AS n FROM purge) AS f)`;

/**
 * Inserts the events parsed from a line of a raw file, keeping those already stored (event ids are
 * stable, so ingesting a line again adds nothing) and leaving out those a purge removed, by id or
 * by session; returns the events it added. Must run inside a write transaction, which `purged`
 * belongs to.
 */
export function eventInserter(
  db: Database,
  source: string,
  rawFileId: number,
  agentVersion: string | null,
  purged: PurgedLookup = purgedLookup(db),
): (lineNo: number, events: EventInput[]) => EventInput[] {
  const insert = db.prepare(
    purged.any
      ? `INSERT INTO event (seq, ${EVENT_COLUMNS})
           VALUES (${NEXT_SEQ_AFTER_PURGES}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING
           RETURNING seq`
      : `INSERT INTO event (${EVENT_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING
           RETURNING seq`,
  );
  // Who wrote an input is kept with it, derived from the same line (see authors.ts).
  const keepAuthor = authorWriter(db);
  return (lineNo, events) =>
    events.filter((ev) => {
      if (!storable(ev)) return false;
      if (
        purged.any &&
        (purged.event(`${source}:${ev.id}`) !== null ||
          purged.session(source, ev.sessionId) !== null)
      ) {
        return false;
      }
      const done = insert.get(
        `${source}:${ev.id}`,
        source,
        ev.sessionId,
        ev.parentId ?? null,
        ev.ts,
        ev.project ?? null,
        ev.cwd ?? null,
        ev.gitBranch ?? null,
        ev.role,
        ev.kind,
        ev.text,
        rawFileId,
        lineNo,
        ev.agentVersion ?? agentVersion ?? null,
        ev.meta ? JSON.stringify(ev.meta) : null,
      ) as { seq: number } | undefined;
      if (!done) return false;
      keepAuthor(done.seq, ev);
      return true;
    });
}

/**
 * Whether an event has every value its row requires. One with a null session, role, kind, text, or
 * time, or a time that is NaN (which SQLite stores as NULL), is passed over, as INSERT OR IGNORE
 * did before. A value that cannot be bound at all (undefined) still fails the line.
 */
function storable(ev: EventInput): boolean {
  return (
    ev.sessionId !== null &&
    ev.ts !== null &&
    !Number.isNaN(ev.ts) &&
    ev.role !== null &&
    ev.kind !== null &&
    ev.text !== null
  );
}

/** A chunk of a device's raw mirror, replicated to a hub (see docs/architecture.md#personal-hub). */
export interface RemoteChunk {
  device: string;
  source: string;
  /** Original absolute path of the file on the device. */
  path: string;
  /** Path relative to the adapter root, `/`-separated. */
  relPath: string;
  /** The device's generation of this file. */
  generation: number;
  /** Byte offset in that generation where `data` starts. */
  offset: number;
  /** Empty, or complete lines ending with `\n`. */
  data: Buffer;
  mtimeMs?: number;
  agentVersion?: string | null;
}

export type AppendResult =
  | ({ ok: true; bytes: number } & AppendStats)
  | { ok: false; bytes: number };

/**
 * Append a device's chunk to the hub's mirror of that file and parse it with the same adapter, so
 * provenance (invariant 1) holds on the hub and event ids match the device's. A chunk that does not
 * start at the hub's cursor is rejected with that cursor, so the device can resume from there.
 */
export function appendRemote(
  ctx: IngestContext,
  adapter: SourceAdapter,
  chunk: RemoteChunk,
): AppendResult {
  const relPath = validateChunk(adapter, chunk);
  let sealed: number | null = null;
  const result = transaction(
    ctx.db,
    (): AppendResult => {
      const key = remotePath(chunk.device, chunk.path);
      let raw = rawFileAt(ctx.db, chunk.source, key, chunk.generation);
      if (!raw) {
        if (chunk.offset !== 0) return { ok: false, bytes: 0 };
        if (chunk.data.length === 0) {
          return {
            ok: true,
            bytes: 0,
            linesRead: 0,
            eventsAdded: 0,
            parseErrors: 0,
            duplicates: 0,
          };
        }
        const mirror = newMirror(
          ctx.db,
          ['devices', chunk.device, chunk.source],
          relPath,
          chunk.generation,
          key,
        );
        raw = createRawFile(ctx.db, chunk.source, key, mirror, chunk.generation);
      }
      if (chunk.offset !== raw.bytes_ingested) return { ok: false, bytes: raw.bytes_ingested };
      const stats: AppendStats = { linesRead: 0, eventsAdded: 0, parseErrors: 0, duplicates: 0 };
      if (chunk.data.length > 0) {
        const startedAt = Date.now();
        const mtime = chunk.mtimeMs;
        const sealedFrames = appendLines(
          ctx,
          adapter,
          raw,
          chunk.data,
          {
            // The original file is on the device; adapters read earlier lines through readLine.
            absPath: path.join(rawDir(ctx.home), raw.mirror),
            relPath,
            fileMtimeMs: typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : startedAt,
            agentVersion: chunk.agentVersion ?? null,
            device: chunk.device,
          },
          mirrorTailHash(ctx, raw, chunk.data),
          stats,
        );
        if (sealedFrames) sealed = raw.id;
        logSync(ctx.db, {
          source: adapter.id,
          startedAt,
          filesSeen: 1,
          filesChanged: 1,
          stats,
          note: `device ${chunk.device}`,
        });
      }
      return { ok: true, bytes: raw.bytes_ingested + chunk.data.length, ...stats };
    },
    { immediate: true },
  );
  if (sealed !== null) settleMirror(ctx.db, ctx.home, sealed);
  return result;
}

/** A file of a device on a hub, and lines to append to it (see appendRemoteLines). */
export interface RemoteLines {
  device: string;
  source: string;
  /** The file's path, which keys it on the hub as `@<device>:<path>`. */
  path: string;
  /** Path relative to the adapter root, `/`-separated, naming its mirror. */
  relPath: string;
  /** Complete lines, each ending with a line break. */
  data: Buffer;
}

/** How often appendRemoteLines tries a piece again when another append moved the cursor first. */
const APPEND_ATTEMPTS = 3;

/**
 * Append lines to the end of a device's file on a hub, as if the device had pushed them at the
 * hub's cursor: the lines a writer without a device appends to a source of its own over HTTP (see
 * docs/architecture.md#http-interface). Each piece of at most TRANSACTION_BYTES of lines (or one
 * longer line) goes through appendRemote, at the latest generation the hub holds of the file, the
 * first for a new one, so that the hub mirrors, parses, seals, and counts it as it does what devices
 * push. Lines whose events the store already has are mirrored all the same, and count as
 * duplicates, so that sending them again is safe. Returns the counts and the file's size after it.
 */
export function appendRemoteLines(
  ctx: IngestContext,
  adapter: SourceAdapter,
  file: RemoteLines,
): AppendStats & { bytes: number } {
  if (file.data.length > 0 && file.data[file.data.length - 1] !== 0x0a) {
    throw new OriginError('Lines must end with a line break.');
  }
  const total: AppendStats & { bytes: number } = {
    bytes: 0,
    linesRead: 0,
    eventsAdded: 0,
    parseErrors: 0,
    duplicates: 0,
  };
  const key = remotePath(file.device, file.path);
  let start = 0;
  while (start < file.data.length) {
    const nl = file.data.lastIndexOf(
      0x0a,
      Math.min(file.data.length, start + TRANSACTION_BYTES) - 1,
    );
    // A line longer than a transaction is taken whole.
    const end = (nl >= start ? nl : file.data.indexOf(0x0a, start)) + 1;
    const data = file.data.subarray(start, end);
    let appended: AppendResult | null = null;
    for (let attempt = 0; attempt < APPEND_ATTEMPTS && !appended?.ok; attempt++) {
      const raw = latestRawFile(ctx.db, file.source, key);
      appended = appendRemote(ctx, adapter, {
        device: file.device,
        source: file.source,
        path: file.path,
        relPath: file.relPath,
        generation: raw?.generation ?? 1,
        offset: raw?.bytes_ingested ?? 0,
        data,
        mtimeMs: Date.now(),
        agentVersion: null,
      });
    }
    if (!appended?.ok) {
      throw new OriginError(`Other appends to ${file.path} kept moving its end; try again.`);
    }
    total.bytes = appended.bytes;
    total.linesRead += appended.linesRead;
    total.eventsAdded += appended.eventsAdded;
    total.parseErrors += appended.parseErrors;
    total.duplicates += appended.duplicates;
    if (appended.purged) total.purged = (total.purged ?? 0) + appended.purged;
    start = end;
  }
  return total;
}

/** The tail hash of a mirror once `data` is appended to it: of its last TAIL_WINDOW bytes. */
function mirrorTailHash(ctx: IngestContext, raw: RawFileRow, data: Buffer): string {
  const window = Math.min(TAIL_WINDOW, raw.bytes_ingested + data.length);
  const fromData = Math.min(window, data.length);
  const before = window - fromData;
  const hash = createHash('sha256');
  if (before > 0) {
    hash.update(
      readMirror(ctx.db, ctx.home, raw.id, raw.bytes_ingested - before, raw.bytes_ingested),
    );
  }
  return hash.update(data.subarray(data.length - fromData)).digest('hex');
}

/**
 * Reject anything that could escape the device's mirror directory or break the append-only
 * mirror. Returns the `/`-separated relPath.
 */
function validateChunk(adapter: SourceAdapter, chunk: RemoteChunk): string {
  if (typeof chunk.device !== 'string' || !NAME_RE.test(chunk.device)) {
    throw new OriginError(`Invalid device name "${chunk.device}".`);
  }
  if (chunk.source !== adapter.id) {
    throw new OriginError(`Chunk source "${chunk.source}" does not match adapter "${adapter.id}".`);
  }
  if (!Number.isInteger(chunk.generation) || chunk.generation < 1) {
    throw new OriginError(`Invalid generation ${chunk.generation}.`);
  }
  if (!Number.isInteger(chunk.offset) || chunk.offset < 0) {
    throw new OriginError(`Invalid offset ${chunk.offset}.`);
  }
  if (typeof chunk.path !== 'string' || chunk.path.length === 0 || chunk.path.includes('\0')) {
    throw new OriginError('Invalid original path.');
  }
  const relPath = typeof chunk.relPath === 'string' ? chunk.relPath.replace(/\\/g, '/') : '';
  if (
    relPath.length === 0 ||
    relPath.includes('\0') ||
    relPath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relPath) ||
    relPath.split('/').some((segment) => segment === '..')
  ) {
    throw new OriginError(`Invalid relative path "${chunk.relPath}".`);
  }
  if (!Buffer.isBuffer(chunk.data)) throw new OriginError('Chunk data must be bytes.');
  if (chunk.data.length > 0 && chunk.data[chunk.data.length - 1] !== 0x0a) {
    throw new OriginError('Chunk data must end with a complete line.');
  }
  return relPath;
}

/**
 * The hub's byte cursor for every file replicated from `device`, or with `file`, for each
 * generation of that one file (its source, and its original path on the device).
 */
export function remoteCursors(
  db: Database,
  device: string,
  file?: { source: string; path: string },
): Array<{ source: string; path: string; generation: number; bytes: number }> {
  const prefix = remotePath(device, '');
  const sql = file
    ? `SELECT source, path, generation, bytes_ingested FROM raw_file
       WHERE source = ? AND path = ? ORDER BY generation`
    : `SELECT source, path, generation, bytes_ingested FROM raw_file
       WHERE substr(path, 1, ?) = ? ORDER BY source, path, generation`;
  const params = file ? [file.source, remotePath(device, file.path)] : [prefix.length, prefix];
  const rows = db.prepare(sql).all(...params) as unknown as Array<{
    source: string;
    path: string;
    generation: number;
    bytes_ingested: number;
  }>;
  return rows.map((r) => ({
    source: r.source,
    path: r.path.slice(prefix.length),
    generation: r.generation,
    bytes: r.bytes_ingested,
  }));
}

/**
 * This store's own (not replicated) raw files, as a device pushes them to its hub: least recently
 * updated first, so that the hub receives a device's history roughly in the order it happened; or
 * with `file`, the generations of that one file (its source and original path), oldest first.
 * Their content is read with readMirror (see mirror.ts).
 */
export function localRawFiles(
  db: Database,
  file?: { source: string; path: string },
): Array<{
  id: number;
  source: string;
  path: string;
  relPath: string;
  generation: number;
  bytes: number;
  updatedAt: number;
}> {
  const sql = file
    ? `SELECT ${RAW_COLUMNS} FROM raw_file
       WHERE source = ? AND path = ? AND substr(path, 1, 1) <> '@' ORDER BY generation`
    : `SELECT ${RAW_COLUMNS} FROM raw_file WHERE substr(path, 1, 1) <> '@'
       ORDER BY updated_at, source, path, generation`;
  const params = file ? [file.source, file.path] : [];
  const rows = db.prepare(sql).all(...params) as unknown as RawFileRow[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    path: r.path,
    relPath: mirrorRelPath(r),
    generation: r.generation,
    bytes: r.bytes_ingested,
    updatedAt: r.updated_at,
  }));
}

/** Devices that have replicated files to this store. */
export function listDevices(
  db: Database,
): Array<{ device: string; files: number; bytes: number; lastUpdateAt: number }> {
  const rows = db
    .prepare("SELECT path, bytes_ingested, updated_at FROM raw_file WHERE substr(path, 1, 1) = '@'")
    .all() as unknown as Array<{ path: string; bytes_ingested: number; updated_at: number }>;
  const devices = new Map<
    string,
    { device: string; files: number; bytes: number; lastUpdateAt: number }
  >();
  for (const r of rows) {
    const { device } = parseRawPath(r.path);
    if (!device) continue;
    const d = devices.get(device) ?? { device, files: 0, bytes: 0, lastUpdateAt: 0 };
    d.files++;
    d.bytes += r.bytes_ingested;
    d.lastUpdateAt = Math.max(d.lastUpdateAt, r.updated_at);
    devices.set(device, d);
  }
  return [...devices.values()].sort((a, b) => a.device.localeCompare(b.device));
}

/** The bytes of a source file as Origin ingests and mirrors them: decompressed when needed. */
export interface Content {
  size: number;
  mtimeMs: number;
  read(start: number, end: number): Buffer;
  /** Generated content only: the adapter may have more lines than it wrote this time. */
  more?: boolean;
}

function fileContent(file: string): Content {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs, read: (a, b) => readRange(file, a, b) };
}

function openContent(ctx: IngestContext, file: SourceFile, raw: RawFileRow | null): Content | null {
  if (file.generated) return generatedContent(ctx, file, raw);
  let st: fs.Stats;
  try {
    st = fs.statSync(file.absPath);
  } catch {
    return null; // deleted between discovery and read
  }
  if (!file.compression) {
    return { size: st.size, mtimeMs: st.mtimeMs, read: (a, b) => readRange(file.absPath, a, b) };
  }
  // Compressed files are written once; skip them if unchanged since they were last ingested.
  if (raw && st.mtimeMs <= raw.updated_at) return null;
  const data = zlib.zstdDecompressSync(fs.readFileSync(file.absPath));
  return { size: data.length, mtimeMs: st.mtimeMs, read: (a, b) => data.subarray(a, b) };
}

/**
 * The next lines of a generated source, after those already ingested, as content that continues
 * the mirror. Nothing below `bytes_ingested` is ever read from it, since generated content is not
 * checked for a rewrite. A mirror that does not end with a newline — a line left half-written —
 * is closed with one before the new lines, and that newline is part of the bytes a hub parses.
 */
function generatedContent(ctx: IngestContext, file: SourceFile, raw: RawFileRow | null): Content {
  const source = file.generated as GeneratedSource;
  const start = raw?.bytes_ingested ?? 0;
  const last =
    raw && raw.lines_ingested > 0
      ? readMirrorLine(ctx.db, ctx.home, raw.id, raw.lines_ingested)
      : null;
  const lines = source.next(last, TRANSACTION_BYTES);
  if (lines.some((line) => line.includes('\n'))) {
    throw new OriginError('A generated line contains a line break.');
  }
  let body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  if (body.length > 0 && start > 0 && raw) {
    const prev = readMirror(ctx.db, ctx.home, raw.id, start - 1, start);
    if (prev.length === 1 && prev[0] !== 0x0a) {
      body = `\n${body}`;
      ctx.log?.(`warning ${file.relPath}: closed a line that did not end with a newline`);
    }
  }
  const data = Buffer.from(body);
  return {
    size: start + data.length,
    mtimeMs: source.mtimeMs,
    read: (a, b) => data.subarray(a - start, b - start),
    // Asked again until it has nothing more: a batch may have been cut at maxBytes.
    more: lines.length > 0,
  };
}

/**
 * A session's branch, as an SQL query of the event `e` given the session's source and id as
 * conditions (`match`): the git branch most of its visible events record, the latest of those that
 * tie, or null. Memory events are part of no session.
 */
export const sessionBranchQuery = (match: string) => `SELECT e.git_branch FROM event e
  WHERE ${match} AND e.kind <> 'memory' AND e.git_branch IS NOT NULL AND e.git_branch <> ''
    AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)
  GROUP BY e.git_branch ORDER BY COUNT(*) DESC, MAX(e.ts) DESC, e.git_branch DESC LIMIT 1`;

/**
 * Recompute a session's aggregate row from its visible (not forgotten) events: its times, its count,
 * its project and directory, and its branch (see sessionBranchQuery). The session table is derived
 * and can be rebuilt from event at any time. Threads follow (see refreshThreads).
 */
export function refreshSession(db: Database, source: string, sessionId: string): void {
  // Memory events are the versions of an agent's memory files, not part of a conversation.
  const visible =
    "source = ? AND session_id = ? AND kind <> 'memory' AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)";
  const agg = db
    .prepare(
      `SELECT MIN(ts) AS started, MAX(ts) AS ended, COUNT(*) AS n FROM event e WHERE ${visible}`,
    )
    .get(source, sessionId) as { started: number | null; ended: number | null; n: number };
  const first = (column: 'project' | 'cwd'): string | null => {
    const row = db
      .prepare(
        `SELECT ${column} AS v FROM event e WHERE ${visible} AND ${column} IS NOT NULL ORDER BY ts LIMIT 1`,
      )
      .get(source, sessionId) as { v: string } | undefined;
    return row?.v ?? null;
  };
  const branch = db
    .prepare(sessionBranchQuery('e.source = ? AND e.session_id = ?'))
    .get(source, sessionId) as { git_branch: string } | undefined;
  db.prepare(
    `INSERT INTO session (source, session_id, project, cwd, started_at, ended_at, event_count,
                          git_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, session_id) DO UPDATE SET
       project = COALESCE(excluded.project, session.project),
       cwd = COALESCE(excluded.cwd, session.cwd),
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       event_count = excluded.event_count,
       git_branch = excluded.git_branch`,
  ).run(
    source,
    sessionId,
    first('project'),
    first('cwd'),
    agg.started,
    agg.ended,
    agg.n,
    branch?.git_branch ?? null,
  );
}

export function logSync(
  db: Database,
  run: {
    source: string;
    startedAt: number;
    filesSeen: number;
    filesChanged: number;
    stats: AppendStats;
    note: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO sync_log (source, started_at, finished_at, files_seen, files_changed, lines_read,
                           events_added, parse_errors, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.source,
    run.startedAt,
    Date.now(),
    run.filesSeen,
    run.filesChanged,
    run.stats.linesRead,
    run.stats.eventsAdded,
    run.stats.parseErrors,
    run.note,
  );
}

function latestRawFile(db: Database, source: string, absPath: string): RawFileRow | null {
  const row = db
    .prepare(
      `SELECT ${RAW_COLUMNS} FROM raw_file WHERE source = ? AND path = ?
       ORDER BY generation DESC LIMIT 1`,
    )
    .get(source, absPath) as RawFileRow | undefined;
  return row ?? null;
}

/** Whether a raw file has the mirror `mirror`, compared without case as file systems may. */
function mirrorTaken(db: Database, mirror: string): boolean {
  return (
    db.prepare('SELECT 1 FROM raw_file WHERE lower(mirror) = lower(?) LIMIT 1').get(mirror) !==
    undefined
  );
}

/** Whether another raw file has this one's mirror, as an earlier version let two files have. */
function sharesMirror(db: Database, raw: RawFileRow): boolean {
  return (
    db
      .prepare('SELECT 1 FROM raw_file WHERE lower(mirror) = lower(?) AND id <> ? LIMIT 1')
      .get(raw.mirror, raw.id) !== undefined
  );
}

/**
 * The mirror of a new raw file, relative to raw/: `<parts>/<relPath>[.g<generation>]`, or, when
 * another raw file already has that name (compared without case, as file systems may), the same
 * with the file's mark before its extension, derived from its raw_file path `rawPath` (see
 * distinctRelPath), so that two files with one relative path, such as an agent's directory before
 * and after it moved, or a device's own source and lines appended to the hub under its token,
 * never write into one mirror (invariant 3). mirrorRelPath gives back the relative path.
 */
function newMirror(
  db: Database,
  parts: string[],
  relPath: string,
  generation: number,
  rawPath: string,
): string {
  const named = (rel: string) => {
    const safe = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    return path.join(...parts, generation === 1 ? safe : `${safe}.g${generation}`);
  };
  const usual = named(relPath);
  if (!mirrorTaken(db, usual)) return usual;
  const own = named(distinctRelPath(relPath.replace(/\\/g, '/'), rawPath));
  if (!mirrorTaken(db, own)) return own;
  throw new OriginError(
    `No mirror name is free for ${rawPath}: both ${usual} and ${own} are taken.`,
  );
}

function rawFileAt(
  db: Database,
  source: string,
  rawPath: string,
  generation: number,
): RawFileRow | null {
  const row = db
    .prepare(`SELECT ${RAW_COLUMNS} FROM raw_file WHERE source = ? AND path = ? AND generation = ?`)
    .get(source, rawPath, generation) as RawFileRow | undefined;
  return row ?? null;
}

function createRawFile(
  db: Database,
  source: string,
  rawPath: string,
  mirror: string,
  generation: number,
): RawFileRow {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO raw_file (source, path, generation, mirror, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(source, rawPath, generation, mirror, now, now) as { id: number };
  return {
    id: info.id,
    source,
    path: rawPath,
    generation,
    mirror,
    bytes_ingested: 0,
    lines_ingested: 0,
    tail_hash: '',
    updated_at: now,
  };
}

export function tailHash(content: Content, bytesIngested: number): string {
  if (bytesIngested <= 0) return '';
  const len = Math.min(TAIL_WINDOW, bytesIngested);
  const buf = content.read(bytesIngested - len, bytesIngested);
  return createHash('sha256').update(buf).digest('hex');
}

function tailMatches(content: Content, raw: RawFileRow): boolean {
  if (raw.bytes_ingested === 0) return true;
  try {
    return tailHash(content, raw.bytes_ingested) === raw.tail_hash;
  } catch {
    return false;
  }
}

/** Shared by tests and adapters: validate the minimum required fields of an event input. */
export function assertEventInput(ev: EventInput): void {
  if (!ev.id || !ev.sessionId || !Number.isFinite(ev.ts) || typeof ev.text !== 'string') {
    throw new Error(`invalid event: ${JSON.stringify(ev).slice(0, 200)}`);
  }
}
