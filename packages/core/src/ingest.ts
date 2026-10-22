import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { OriginError } from './errors.js';
import { parseRawPath, rawDir, remotePath } from './paths.js';
import { NAME_RE } from './tokens.js';
import type { EventInput, SourceAdapter, SourceFile, SyncResult } from './types.js';

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
}

/** Counters shared by local syncs and remote appends. */
interface AppendStats {
  linesRead: number;
  eventsAdded: number;
  parseErrors: number;
}

/**
 * Ingest one source: discover files → read newly appended bytes → mirror to raw → parse
 * deterministically → append events to the store.
 * Idempotent: re-running never inserts duplicate events. When a source file is rewritten (not
 * appended to), a new generation is opened and the old mirror is kept (invariant 3, append-only,
 * see docs/architecture.md).
 */
export async function syncSource(ctx: IngestContext, adapter: SourceAdapter): Promise<SyncResult> {
  const startedAt = Date.now();
  const result: SyncResult = {
    source: adapter.id,
    filesSeen: 0,
    filesChanged: 0,
    linesRead: 0,
    eventsAdded: 0,
    parseErrors: 0,
    newGenerations: 0,
    durationMs: 0,
  };
  const files = oldestFirst(await adapter.discover());
  result.filesSeen = files.length;
  const agentVersion = adapter.version();

  for (const file of files) {
    // One write transaction per file: the cursor is re-read under the lock, so concurrent syncs
    // (the CLI and one MCP server per agent session) never ingest the same bytes twice.
    const changed = transaction(
      ctx.db,
      () => ingestFile(ctx, adapter, file, agentVersion, result),
      { immediate: true },
    );
    if (changed) result.filesChanged++;
  }

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
 * Files oldest first, by modification time, so that the order events arrive in follows time as far
 * as possible: a first sync ingests old sessions before new ones, which keeps newest-first queries
 * short (see event_block in schema.ts).
 */
function oldestFirst(files: SourceFile[]): SourceFile[] {
  const mtime = new Map<SourceFile, number>();
  for (const f of files) {
    try {
      mtime.set(f, fs.statSync(f.absPath).mtimeMs);
    } catch {
      mtime.set(f, Number.POSITIVE_INFINITY); // deleted since discovery
    }
  }
  return [...files].sort((a, b) => (mtime.get(a) as number) - (mtime.get(b) as number));
}

/** Ingest the newly appended complete lines of one file. Must run inside a write transaction. */
function ingestFile(
  ctx: IngestContext,
  adapter: SourceAdapter,
  file: SourceFile,
  agentVersion: string | null,
  result: SyncResult,
): boolean {
  let raw = latestRawFile(ctx.db, adapter.id, file.absPath);
  const content = openContent(ctx, file, raw);
  if (!content) return false;
  if (raw && (content.size < raw.bytes_ingested || !tailMatches(content, raw))) {
    ctx.log?.(`rewrite detected, new generation: ${file.relPath}`);
    const generation = raw.generation + 1;
    raw = createRawFile(
      ctx.db,
      adapter.id,
      file.absPath,
      localMirror(adapter.id, file.relPath, generation),
      generation,
    );
    result.newGenerations++;
  }
  if (!raw) {
    raw = createRawFile(
      ctx.db,
      adapter.id,
      file.absPath,
      localMirror(adapter.id, file.relPath, 1),
      1,
    );
  }
  if (content.size === raw.bytes_ingested) return false;

  const delta = content.read(raw.bytes_ingested, content.size);
  const lastNl = delta.lastIndexOf(0x0a);
  if (lastNl < 0) return false; // no complete line yet
  const chunk = delta.subarray(0, lastNl + 1);

  appendLines(
    ctx,
    adapter,
    raw,
    chunk,
    { absPath: file.absPath, relPath: file.relPath, fileMtimeMs: content.mtimeMs, agentVersion },
    (bytes) => tailHash(content, bytes),
    result,
  );
  return true;
}

/**
 * Append complete lines to a raw file's mirror, parse them, insert events, refresh the touched
 * sessions, and advance the cursor. Shared by local syncs and hub appends; must run inside a write
 * transaction.
 */
function appendLines(
  ctx: IngestContext,
  adapter: SourceAdapter,
  raw: RawFileRow,
  chunk: Buffer,
  parse: { absPath: string; relPath: string; fileMtimeMs: number; agentVersion: string | null },
  tail: (bytesIngested: number) => string,
  stats: AppendStats,
): void {
  const mirrorAbs = path.join(rawDir(ctx.home), raw.mirror);
  fs.mkdirSync(path.dirname(mirrorAbs), { recursive: true });
  alignMirror(mirrorAbs, raw.bytes_ingested);
  fs.appendFileSync(mirrorAbs, chunk);

  const lines = chunk.toString('utf8').split('\n');
  lines.pop(); // trailing empty string
  const baseLine = raw.lines_ingested;
  const touchedSessions = new Set<string>();

  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO event
         (id, source, session_id, parent_id, ts, project, cwd, git_branch, role, kind, text,
          raw_file_id, raw_line, agent_version, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setTitle = ctx.db.prepare(
    `INSERT INTO session (source, session_id, title) VALUES (?, ?, ?)
       ON CONFLICT (source, session_id) DO UPDATE SET title = excluded.title`,
  );
  for (let i = 0; i < lines.length; i++) {
    const lineNo = baseLine + i + 1;
    let line = lines[i] ?? '';
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    stats.linesRead++;
    let parsed: ReturnType<SourceAdapter['parseLine']>;
    try {
      parsed = adapter.parseLine(line, {
        absPath: parse.absPath,
        relPath: parse.relPath,
        lineNo,
        fileMtimeMs: parse.fileMtimeMs,
      });
    } catch (err) {
      stats.parseErrors++;
      ctx.log?.(`parse error ${parse.relPath}:${lineNo}: ${(err as Error).message}`);
      continue;
    }
    if (!parsed) continue;
    for (const ev of parsed.events) {
      const info = insert.run(
        `${adapter.id}:${ev.id}`,
        adapter.id,
        ev.sessionId,
        ev.parentId ?? null,
        ev.ts,
        ev.project ?? null,
        ev.cwd ?? null,
        ev.gitBranch ?? null,
        ev.role,
        ev.kind,
        ev.text,
        raw.id,
        lineNo,
        ev.agentVersion ?? parse.agentVersion ?? null,
        ev.meta ? JSON.stringify(ev.meta) : null,
      );
      if (info.changes > 0) {
        stats.eventsAdded++;
        touchedSessions.add(ev.sessionId);
      }
    }
    if (parsed.sessionTitle && parsed.sessionId) {
      setTitle.run(adapter.id, parsed.sessionId, parsed.sessionTitle);
      touchedSessions.add(parsed.sessionId);
    }
  }
  for (const sessionId of touchedSessions) refreshSession(ctx.db, adapter.id, sessionId);
  const newBytes = raw.bytes_ingested + chunk.length;
  ctx.db
    .prepare(
      `UPDATE raw_file SET bytes_ingested = ?, lines_ingested = ?, tail_hash = ?, updated_at = ?
         WHERE id = ?`,
    )
    .run(newBytes, baseLine + lines.length, tail(newBytes), Date.now(), raw.id);
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
  | { ok: true; bytes: number; linesRead: number; eventsAdded: number; parseErrors: number }
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
  return transaction(
    ctx.db,
    (): AppendResult => {
      const key = remotePath(chunk.device, chunk.path);
      let raw = rawFileAt(ctx.db, chunk.source, key, chunk.generation);
      if (!raw) {
        if (chunk.offset !== 0) return { ok: false, bytes: 0 };
        if (chunk.data.length === 0) {
          return { ok: true, bytes: 0, linesRead: 0, eventsAdded: 0, parseErrors: 0 };
        }
        const rel = chunk.generation === 1 ? relPath : `${relPath}.g${chunk.generation}`;
        raw = createRawFile(
          ctx.db,
          chunk.source,
          key,
          path.join('devices', chunk.device, chunk.source, rel),
          chunk.generation,
        );
      }
      if (chunk.offset !== raw.bytes_ingested) return { ok: false, bytes: raw.bytes_ingested };
      const stats: AppendStats = { linesRead: 0, eventsAdded: 0, parseErrors: 0 };
      if (chunk.data.length > 0) {
        const startedAt = Date.now();
        const mirrorAbs = path.join(rawDir(ctx.home), raw.mirror);
        const mtime = chunk.mtimeMs;
        appendLines(
          ctx,
          adapter,
          raw,
          chunk.data,
          {
            absPath: mirrorAbs,
            relPath,
            fileMtimeMs: typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : startedAt,
            agentVersion: chunk.agentVersion ?? null,
          },
          (bytes) => tailHash(fileContent(mirrorAbs), bytes),
          stats,
        );
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

/** The hub's byte cursor for every file replicated from `device`. */
export function remoteCursors(
  db: Database,
  device: string,
): Array<{ source: string; path: string; generation: number; bytes: number }> {
  const prefix = remotePath(device, '');
  const rows = db
    .prepare(
      `SELECT source, path, generation, bytes_ingested FROM raw_file
       WHERE substr(path, 1, ?) = ? ORDER BY source, path, generation`,
    )
    .all(prefix.length, prefix) as unknown as Array<{
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
 * updated first, so that the hub receives a device's history roughly in the order it happened.
 */
export function localRawFiles(
  db: Database,
  home: string,
): Array<{
  source: string;
  path: string;
  relPath: string;
  generation: number;
  mirrorPath: string;
  bytes: number;
  updatedAt: number;
}> {
  const rows = db
    .prepare(
      `SELECT ${RAW_COLUMNS} FROM raw_file WHERE substr(path, 1, 1) <> '@'
       ORDER BY updated_at, source, path, generation`,
    )
    .all() as unknown as RawFileRow[];
  return rows.map((r) => {
    // The mirror is `<source>/<relPath>[.g<generation>]` (see localMirror).
    let rel = r.mirror.replace(/\\/g, '/');
    if (rel.startsWith(`${r.source}/`)) rel = rel.slice(r.source.length + 1);
    const suffix = `.g${r.generation}`;
    if (r.generation > 1 && rel.endsWith(suffix)) rel = rel.slice(0, -suffix.length);
    return {
      source: r.source,
      path: r.path,
      relPath: rel,
      generation: r.generation,
      mirrorPath: path.join(rawDir(home), r.mirror),
      bytes: r.bytes_ingested,
      updatedAt: r.updated_at,
    };
  });
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
interface Content {
  size: number;
  mtimeMs: number;
  read(start: number, end: number): Buffer;
}

function fileContent(file: string): Content {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs, read: (a, b) => readRange(file, a, b) };
}

function openContent(ctx: IngestContext, file: SourceFile, raw: RawFileRow | null): Content | null {
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
  if (typeof zlib.zstdDecompressSync !== 'function') {
    ctx.log?.(`skipped ${file.relPath}: this Node.js version cannot read zstd`);
    return null;
  }
  const data = zlib.zstdDecompressSync(fs.readFileSync(file.absPath));
  return { size: data.length, mtimeMs: st.mtimeMs, read: (a, b) => data.subarray(a, b) };
}

/**
 * A mirror holds exactly the ingested bytes of its generation. Bytes past the cursor were appended
 * by a sync that never committed, so they are dropped before appending again.
 */
function alignMirror(mirror: string, bytesIngested: number): void {
  let size: number;
  try {
    size = fs.statSync(mirror).size;
  } catch {
    return;
  }
  if (size > bytesIngested) fs.truncateSync(mirror, bytesIngested);
}

/**
 * Recompute a session's aggregate row from its visible (not forgotten) events. The session table is
 * derived and can be rebuilt from event at any time.
 */
export function refreshSession(db: Database, source: string, sessionId: string): void {
  const visible =
    'source = ? AND session_id = ? AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)';
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
  db.prepare(
    `INSERT INTO session (source, session_id, project, cwd, started_at, ended_at, event_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, session_id) DO UPDATE SET
       project = COALESCE(excluded.project, session.project),
       cwd = COALESCE(excluded.cwd, session.cwd),
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       event_count = excluded.event_count`,
  ).run(source, sessionId, first('project'), first('cwd'), agg.started, agg.ended, agg.n);
}

function logSync(
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

/** Mirror of a local file, relative to raw/: `<source>/<relPath>[.g<generation>]`. */
function localMirror(source: string, relPath: string, generation: number): string {
  const safeRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return path.join(source, generation === 1 ? safeRel : `${safeRel}.g${generation}`);
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
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(source, rawPath, generation, mirror, now, now);
  return {
    id: Number(info.lastInsertRowid),
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

function readRange(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return off === buf.length ? buf : buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

function tailHash(content: Content, bytesIngested: number): string {
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
