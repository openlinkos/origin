import path from 'node:path';
import { OriginError } from './errors.js';
import { storeName } from './identity.js';
import { eventInserter } from './ingest.js';
import { importMemory } from './memories.js';
import type { MigrationContext } from './migrations.js';
import { readMirrorLine, scanMirrorLines } from './mirror.js';
import { mirrorRelPath, parseRawPath, rawDir } from './paths.js';
import { recordedAgentVersion } from './store.js';
import type { ParsedLine } from './types.js';

/**
 * Parsing lines that are already mirrored again, for data migrations: when an adapter learns to
 * read something from lines it used to skip, the lines ingested before are not parsed again by a
 * sync, which only reads what follows its cursor.
 */

interface RawFileRecord {
  id: number;
  source: string;
  path: string;
  generation: number;
  mirror: string;
  updated_at: number;
}

/**
 * Each mirrored line of a source that contains one of `needles`, parsed by the source's adapter as
 * ingestion would parse it: every raw file of the source, this store's own and, on a hub, every
 * device's, oldest first, and its lines in order. Lines the adapter cannot parse are counted and
 * skipped; a mirror whose data is missing is reported and skipped; a frame that cannot be reached
 * (a hub's bucket) throws, so that the migration runs again later.
 */
function reparse(
  ctx: MigrationContext,
  source: string,
  needles: string[],
  fn: (parsed: ParsedLine) => void,
): void {
  const files = ctx.db
    .prepare(
      'SELECT id, source, path, generation, mirror, updated_at FROM raw_file WHERE source = ? ORDER BY id',
    )
    .all(source) as unknown as RawFileRecord[];
  if (files.length === 0) return;
  const adapter = ctx.adapter(source);
  let errors = 0;
  for (const f of files) {
    const relPath = mirrorRelPath(f);
    // A device's file is not on the hub: as at ingestion, its mirror stands in for it.
    const absPath = f.path.startsWith('@') ? path.join(rawDir(ctx.home), f.mirror) : f.path;
    const readLine = (n: number) => readMirrorLine(ctx.db, ctx.home, f.id, n);
    try {
      scanMirrorLines(ctx.db, ctx.home, f.id, needles, (line, lineNo) => {
        let parsed: ParsedLine | null;
        try {
          parsed = adapter.parseLine(line, {
            absPath,
            relPath,
            lineNo,
            fileMtimeMs: f.updated_at,
            readLine,
          });
        } catch {
          errors++;
          return;
        }
        if (parsed) fn(parsed);
      });
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      ctx.log(`Skipped the mirror ${f.mirror}: ${err.message}`);
    }
  }
  if (errors > 0) ctx.log(`${errors} mirrored ${source} lines could not be parsed; skipped.`);
}

/**
 * Set the titles of a source's sessions from its mirrored lines that contain one of `needles`, as
 * ingestion with its adapter now would: per session, the latest title, unless the user gave one,
 * in which case the latest the user gave. Sessions none of these lines titles keep their title.
 */
export function reparseTitles(ctx: MigrationContext, source: string, needles: string[]): void {
  const titles = new Map<string, { title: string; manual: boolean }>();
  reparse(ctx, source, needles, (parsed) => {
    if (!parsed.sessionTitle || !parsed.sessionId) return;
    const manual = parsed.manualTitle === true;
    const current = titles.get(parsed.sessionId);
    if (!current || manual || !current.manual) {
      titles.set(parsed.sessionId, { title: parsed.sessionTitle, manual });
    }
  });
  const set = ctx.db.prepare(
    `INSERT INTO session (source, session_id, title, title_manual) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, session_id) DO UPDATE
         SET title = excluded.title, title_manual = excluded.title_manual`,
  );
  for (const [sessionId, t] of titles) set.run(source, sessionId, t.title, t.manual ? 1 : 0);
  if (titles.size > 0) ctx.log(`Set the titles of ${titles.size} ${source} sessions.`);
}

/**
 * Store the events, and derive the entries, of the memory streams of a source (see memories.ts)
 * mirrored by a version that did not read them: a hub upgraded after a device that sent it its
 * memory streams has their lines, but no events or entries from them. Every such mirror is parsed
 * as ingestion would parse it; what is stored already stays as it is.
 */
export function reparseMemories(ctx: MigrationContext, source: string): void {
  const files = (
    ctx.db
      .prepare(
        'SELECT id, source, path, generation, mirror, updated_at FROM raw_file WHERE source = ? ORDER BY id',
      )
      .all(source) as unknown as RawFileRecord[]
  ).filter((f) => mirrorRelPath(f).startsWith('memory/'));
  if (files.length === 0) return;
  const adapter = ctx.adapter(source);
  const hub = storeName(ctx.db);
  let events = 0;
  let errors = 0;
  for (const f of files) {
    const relPath = mirrorRelPath(f);
    const absPath = f.path.startsWith('@') ? path.join(rawDir(ctx.home), f.mirror) : f.path;
    const device = parseRawPath(f.path).device ?? hub;
    const insert = eventInserter(ctx.db, source, f.id, recordedAgentVersion(ctx.db, f.id));
    const readLine = (n: number) => readMirrorLine(ctx.db, ctx.home, f.id, n);
    try {
      // Every line: an empty needle is found in each.
      scanMirrorLines(ctx.db, ctx.home, f.id, [''], (line, lineNo) => {
        if (line.trim().length === 0) return;
        let parsed: ParsedLine | null;
        try {
          parsed = adapter.parseLine(line, {
            absPath,
            relPath,
            lineNo,
            fileMtimeMs: f.updated_at,
            readLine,
          });
        } catch {
          errors++;
          return;
        }
        if (!parsed) return;
        events += insert(lineNo, parsed.events).length;
        if (!parsed.memory) return;
        try {
          importMemory(ctx.db, { source, device, growthOrigin: hub }, parsed.memory);
        } catch (err) {
          if (!(err instanceof OriginError)) throw err;
          errors++;
        }
      });
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      ctx.log(`Skipped the mirror ${f.mirror}: ${err.message}`);
    }
  }
  if (events > 0) ctx.log(`Read ${events} versions of ${source} memories mirrored before.`);
  if (errors > 0) ctx.log(`${errors} mirrored ${source} memory lines could not be read; skipped.`);
}
