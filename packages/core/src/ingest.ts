import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { rawDir } from './paths.js';
import type { EventInput, SourceAdapter, SyncResult } from './types.js';

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
}

export interface IngestContext {
  db: Database;
  /** ORIGIN_HOME; mirrors are written to `<home>/raw/<source>/...`. */
  home: string;
  log?: (message: string) => void;
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
  const files = await adapter.discover();
  result.filesSeen = files.length;
  const agentVersion = adapter.version();

  for (const file of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file.absPath);
    } catch {
      continue; // deleted between discovery and read
    }
    let raw = latestRawFile(ctx.db, adapter.id, file.absPath);
    if (raw && (st.size < raw.bytes_ingested || !tailMatches(file.absPath, raw))) {
      ctx.log?.(`rewrite detected, new generation: ${file.relPath}`);
      raw = createRawFile(ctx, adapter.id, file, raw.generation + 1);
      result.newGenerations++;
    }
    if (!raw) raw = createRawFile(ctx, adapter.id, file, 1);
    if (st.size === raw.bytes_ingested) continue;

    const delta = readRange(file.absPath, raw.bytes_ingested, st.size);
    const lastNl = delta.lastIndexOf(0x0a);
    if (lastNl < 0) continue; // no complete line yet
    const chunk = delta.subarray(0, lastNl + 1);

    const mirrorAbs = path.join(rawDir(ctx.home), raw.mirror);
    fs.mkdirSync(path.dirname(mirrorAbs), { recursive: true });
    fs.appendFileSync(mirrorAbs, chunk);

    const lines = chunk.toString('utf8').split('\n');
    lines.pop(); // trailing empty string
    const rawId = raw.id;
    const baseLine = raw.lines_ingested;
    const fileMtimeMs = st.mtimeMs;
    const touchedSessions = new Set<string>();

    transaction(ctx.db, () => {
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
        result.linesRead++;
        let parsed: ReturnType<SourceAdapter['parseLine']>;
        try {
          parsed = adapter.parseLine(line, {
            absPath: file.absPath,
            relPath: file.relPath,
            lineNo,
            fileMtimeMs,
          });
        } catch (err) {
          result.parseErrors++;
          ctx.log?.(`parse error ${file.relPath}:${lineNo}: ${(err as Error).message}`);
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
            rawId,
            lineNo,
            ev.agentVersion ?? agentVersion ?? null,
            ev.meta ? JSON.stringify(ev.meta) : null,
          );
          if (info.changes > 0) {
            result.eventsAdded++;
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
        .run(
          newBytes,
          baseLine + lines.length,
          tailHash(file.absPath, newBytes),
          Date.now(),
          rawId,
        );
    });
    result.filesChanged++;
  }

  result.durationMs = Date.now() - startedAt;
  ctx.db
    .prepare(
      `INSERT INTO sync_log (source, started_at, finished_at, files_seen, files_changed, lines_read,
                             events_added, parse_errors, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      adapter.id,
      startedAt,
      Date.now(),
      result.filesSeen,
      result.filesChanged,
      result.linesRead,
      result.eventsAdded,
      result.parseErrors,
      result.newGenerations > 0 ? `new generations: ${result.newGenerations}` : null,
    );
  return result;
}

/** Recompute a session's aggregate row (the session table is derived and can be rebuilt from event). */
export function refreshSession(db: Database, source: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO session (source, session_id, project, cwd, started_at, ended_at, event_count)
     SELECT source, session_id,
            (SELECT project FROM event e2 WHERE e2.source = e.source AND e2.session_id = e.session_id
               AND e2.project IS NOT NULL ORDER BY ts LIMIT 1),
            (SELECT cwd FROM event e3 WHERE e3.source = e.source AND e3.session_id = e.session_id
               AND e3.cwd IS NOT NULL ORDER BY ts LIMIT 1),
            MIN(ts), MAX(ts), COUNT(*)
     FROM event e WHERE source = ? AND session_id = ?
     GROUP BY source, session_id
     ON CONFLICT (source, session_id) DO UPDATE SET
       project = COALESCE(excluded.project, session.project),
       cwd = COALESCE(excluded.cwd, session.cwd),
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       event_count = excluded.event_count`,
  ).run(source, sessionId);
}

function latestRawFile(db: Database, source: string, absPath: string): RawFileRow | null {
  const row = db
    .prepare(
      `SELECT id, source, path, generation, mirror, bytes_ingested, lines_ingested, tail_hash
       FROM raw_file WHERE source = ? AND path = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(source, absPath) as RawFileRow | undefined;
  return row ?? null;
}

function createRawFile(
  ctx: IngestContext,
  source: string,
  file: { absPath: string; relPath: string },
  generation: number,
): RawFileRow {
  const safeRel = file.relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const mirror = path.join(source, generation === 1 ? safeRel : `${safeRel}.g${generation}`);
  const now = Date.now();
  const info = ctx.db
    .prepare(
      `INSERT INTO raw_file (source, path, generation, mirror, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(source, file.absPath, generation, mirror, now, now);
  return {
    id: Number(info.lastInsertRowid),
    source,
    path: file.absPath,
    generation,
    mirror,
    bytes_ingested: 0,
    lines_ingested: 0,
    tail_hash: '',
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

function tailHash(file: string, bytesIngested: number): string {
  if (bytesIngested <= 0) return '';
  const len = Math.min(TAIL_WINDOW, bytesIngested);
  const buf = readRange(file, bytesIngested - len, bytesIngested);
  return createHash('sha256').update(buf).digest('hex');
}

function tailMatches(file: string, raw: RawFileRow): boolean {
  if (raw.bytes_ingested === 0) return true;
  try {
    return tailHash(file, raw.bytes_ingested) === raw.tail_hash;
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
