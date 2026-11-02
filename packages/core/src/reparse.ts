import path from 'node:path';
import { authorWriter, hasAuthor, recordSessionKind } from './authors.js';
import { OriginError } from './errors.js';
import { storeName } from './identity.js';
import { eventInserter, refreshSession } from './ingest.js';
import { importMemory } from './memories.js';
import type { MigrationContext } from './migrations.js';
import { readMirrorLine, scanMirrorLines } from './mirror.js';
import { mirrorRelPath, parseRawPath, rawDir } from './paths.js';
import { deriveProposal } from './proposals.js';
import { recordedAgentVersion } from './store.js';
import { deriveFollow } from './threads.js';
import type { ParsedLine, SourceAdapter } from './types.js';

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

/** Origin's own sources: a store whose mirrors of them are parsed again needs their adapters. */
const BUILT_IN_SOURCES = new Set(['claude-code', 'codex', 'cursor', 'zcode', 'grok']);

/** The sources whose `memory/` mirrors are memory streams, which hold no input. */
const MEMORY_STREAM_SOURCES = new Set(['claude-code', 'zcode', 'grok']);

/**
 * What a line must contain for authorship to be read from it, by source: the names under which its
 * inputs, the notices of the sub-agents it spawns, and the kinds of its sessions are written. Other
 * lines hold none of them, so they are not parsed. Every line of other sources is parsed (ZCode and
 * Cursor write a session's facts on each of its lines, and a person's own sources are small).
 */
const AUTHOR_NEEDLES: Record<string, string[]> = {
  'claude-code': ['"user"', '"queued_command"'],
  codex: ['"user"', '"session_meta"'],
  grok: ['"user_message_chunk"', '"subagent_spawned"', '"session_kind"'],
};

/** How often a long reparse says how far it is. */
const PROGRESS_MS = 5_000;

/**
 * Derive who wrote each input from the raw mirrors (see authors.ts), as ingestion with the adapters
 * now would: every mirror of every source the store has an adapter for, on a device and on a hub
 * alike (a hub's mirrors of its devices' files, `@<device>:<path>`, read through its frame store),
 * oldest first. Only lines that can hold an input or a session's kind are parsed (AUTHOR_NEEDLES).
 *
 * - An input keeps the author its own line gives it now: the line it was stored from, as its raw
 *   locator says, so that an event a line repeats is read from its own.
 * - A session a line says is a child or a headless run is recorded.
 * - An event a line yields that the store does not have, as one an adapter has learnt to read, is
 *   stored as ingestion would store it, with its author, and its session aggregated again; a mirror
 *   that an earlier version let two files share is not added to (see Raw mirrors in
 *   docs/architecture.md).
 *
 * The built-in sources' adapters are required (the migration fails without them, and runs again
 * once the store is opened with them); a source of one's own without an adapter keeps the default
 * author (see defaultAuthor). Threads are left to the caller. Must run inside a write transaction.
 */
export function reparseAuthorship(ctx: MigrationContext): void {
  const { db } = ctx;
  const files = db
    .prepare(
      // A mirror without lines has nothing to read, and needs no adapter.
      `SELECT id, source, path, generation, mirror, updated_at FROM raw_file
        WHERE lines_ingested > 0 ORDER BY id`,
    )
    .all() as unknown as RawFileRecord[];
  const todo = files.filter(
    (f) => !(MEMORY_STREAM_SOURCES.has(f.source) && mirrorRelPath(f).startsWith('memory/')),
  );
  if (todo.length === 0) return;
  const adapters = new Map<string, SourceAdapter | null>();
  const adapterOf = (source: string): SourceAdapter | null => {
    if (!adapters.has(source)) {
      adapters.set(
        source,
        BUILT_IN_SOURCES.has(source) ? ctx.adapter(source) : ctx.findAdapter(source),
      );
    }
    return adapters.get(source) ?? null;
  };
  const stored = db.prepare('SELECT seq, raw_file_id, raw_line FROM event WHERE id = ?');
  const shared = db.prepare(
    'SELECT 1 FROM raw_file WHERE lower(mirror) = lower(?) AND id <> ? LIMIT 1',
  );
  const keepAuthor = authorWriter(db);
  const touched = new Map<string, { source: string; sessionId: string }>();
  const skipped = new Set<string>();
  const counts = { inputs: 0, added: 0, kinds: 0, errors: 0 };
  const started = Date.now();
  let told = started;
  for (const [i, f] of todo.entries()) {
    if (Date.now() - told >= PROGRESS_MS) {
      told = Date.now();
      ctx.log(`Reading who wrote each input: ${i} of ${todo.length} archived files…`);
    }
    const adapter = adapterOf(f.source);
    if (!adapter) {
      skipped.add(f.source);
      continue;
    }
    const relPath = mirrorRelPath(f);
    // A device's file is not on the hub: as at ingestion, its mirror stands in for it.
    const absPath = f.path.startsWith('@') ? path.join(rawDir(ctx.home), f.mirror) : f.path;
    const readLine = (n: number) => readMirrorLine(db, ctx.home, f.id, n);
    const insert =
      shared.get(f.mirror, f.id) === undefined
        ? eventInserter(db, f.source, f.id, recordedAgentVersion(db, f.id))
        : null;
    try {
      scanMirrorLines(db, ctx.home, f.id, AUTHOR_NEEDLES[f.source] ?? [''], (line, lineNo) => {
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
          counts.errors++;
          return;
        }
        if (!parsed) return;
        for (const ev of parsed.events) {
          const id = `${f.source}:${ev.id}`;
          const row = stored.get(id) as
            | { seq: number; raw_file_id: number; raw_line: number }
            | undefined;
          if (row) {
            if (row.raw_file_id === f.id && row.raw_line === lineNo && hasAuthor(ev)) {
              keepAuthor(row.seq, ev);
              counts.inputs++;
            }
            continue;
          }
          if (!insert || insert(lineNo, [ev]).length === 0) continue;
          counts.added++;
          if (ev.kind !== 'memory') {
            touched.set(`${f.source}\n${ev.sessionId}`, {
              source: f.source,
              sessionId: ev.sessionId,
            });
          }
          const event = { ...ev, id, source: f.source };
          deriveFollow(db, event);
          deriveProposal(db, event);
        }
        for (const fact of parsed.sessionKinds ?? []) {
          if (recordSessionKind(db, f.source, fact)) counts.kinds++;
        }
      });
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      ctx.log(`Skipped the mirror ${f.mirror}: ${err.message}`);
    }
  }
  for (const s of touched.values()) refreshSession(db, s.source, s.sessionId);
  const seconds = Math.round((Date.now() - started) / 1000);
  ctx.log(
    `Read who wrote ${counts.inputs + counts.added} inputs (${counts.added} of them new events) and ${counts.kinds} kinds of session from ${todo.length} archived files in ${seconds} s.`,
  );
  if (skipped.size > 0) {
    ctx.log(
      `No adapter for ${[...skipped].sort().join(', ')}: their inputs keep the author their kind and text give them.`,
    );
  }
  if (counts.errors > 0) ctx.log(`${counts.errors} mirrored lines could not be parsed; skipped.`);
}
