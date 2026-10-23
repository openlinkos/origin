import path from 'node:path';
import { OriginError } from './errors.js';
import type { MigrationContext } from './migrations.js';
import { readMirrorLine, scanMirrorLines } from './mirror.js';
import { mirrorRelPath, rawDir } from './paths.js';
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
