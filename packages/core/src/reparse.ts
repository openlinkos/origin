import path from 'node:path';
import { authorWriter, hasAuthor, recordSessionKind } from './authors.js';
import type { Database } from './database.js';
import { OriginError } from './errors.js';
import { coverEventArrival } from './forgetting.js';
import { storeName } from './identity.js';
import { eventInserter, refreshSession } from './ingest.js';
import { importMemory } from './memories.js';
import type { MigrationContext } from './migrations.js';
import { readMirrorLine, scanMirrorLines } from './mirror.js';
import { recordSessionParent } from './parents.js';
import { mirrorRelPath, parseRawPath, rawDir } from './paths.js';
import { isOriginPlacesFile } from './places.js';
import { deriveProposal } from './proposals.js';
import { isSkippedLine, type PurgedLookup, purgedLookup } from './purged.js';
import { PULL_TOMBSTONES_AGAIN, setSetting } from './settings.js';
import { recordedAgentVersion } from './store.js';
import { deriveFollow } from './threads.js';
import type { EventInput, ParsedLine, SourceAdapter } from './types.js';

/**
 * Parsing lines that are already mirrored again, for data migrations: when an adapter learns to
 * read something from lines it used to skip, the lines ingested before are not parsed again by a
 * sync, which only reads what follows its cursor.
 */

/** A mirrored raw file, as the loops that parse its lines again read it. */
export interface MirroredFile {
  id: number;
  source: string;
  path: string;
  generation: number;
  mirror: string;
  updated_at: number;
}

type RawFileRecord = MirroredFile;

/**
 * Parses the mirrored lines of raw file `f` with its source's adapter, as ingestion parsed them:
 * with the file's relative path, its original path (a device's file is not on a hub, so there its
 * mirror stands in for it, as at ingestion), and earlier lines read from the mirror. The parser
 * throws whatever the adapter throws. Shared by every loop that parses mirrored lines again: the
 * data migrations here, and a purge's plan (see purge.ts).
 */
export function mirroredLineParser(
  db: Database,
  home: string,
  adapter: SourceAdapter,
  f: MirroredFile,
): (line: string, lineNo: number) => ParsedLine | null {
  const relPath = mirrorRelPath(f);
  const absPath = f.path.startsWith('@') ? path.join(rawDir(home), f.mirror) : f.path;
  const readLine = (n: number) => readMirrorLine(db, home, f.id, n);
  return (line, lineNo) =>
    adapter.parseLine(line, { absPath, relPath, lineNo, fileMtimeMs: f.updated_at, readLine });
}

/**
 * Each mirrored line of a source that contains one of `needles`, parsed by the source's adapter as
 * ingestion would parse it: every raw file of the source, this store's own and, on a hub, every
 * device's, oldest first, and its lines in order. Lines the adapter cannot parse are counted and
 * skipped; a mirror whose data is missing is reported and skipped; a frame that cannot be reached
 * (a hub's bucket) throws, so that the migration runs again later. Blank lines, lines a purge
 * replaced, and files a purge blocked are skipped; `purged` is what purges removed.
 */
function reparse(
  ctx: MigrationContext,
  source: string,
  needles: string[],
  fn: (parsed: ParsedLine, purged: PurgedLookup) => void,
): void {
  const files = ctx.db
    .prepare(
      'SELECT id, source, path, generation, mirror, updated_at FROM raw_file WHERE source = ? ORDER BY id',
    )
    .all(source) as unknown as RawFileRecord[];
  if (files.length === 0) return;
  const adapter = ctx.adapter(source);
  const purged = purgedLookup(ctx.db);
  let errors = 0;
  for (const f of files) {
    if (blockedFile(purged, f)) continue;
    const parse = mirroredLineParser(ctx.db, ctx.home, adapter, f);
    try {
      scanMirrorLines(ctx.db, ctx.home, f.id, needles, (line, lineNo) => {
        if (isSkippedLine(line)) return;
        let parsed: ParsedLine | null;
        try {
          parsed = parse(line, lineNo);
        } catch {
          errors++;
          return;
        }
        if (parsed) fn(parsed, purged);
      });
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      ctx.log(`Skipped the mirror ${f.mirror}: ${err.message}`);
    }
  }
  if (errors > 0) ctx.log(`${errors} mirrored ${source} lines could not be parsed; skipped.`);
}

/** Whether a purge blocked a raw file, whose lines are never read again. */
function blockedFile(purged: PurgedLookup, f: RawFileRecord): boolean {
  return purged.any && purged.file(f.source, f.path) !== null;
}

/**
 * Set the titles of a source's sessions from its mirrored lines that contain one of `needles`, as
 * ingestion with its adapter now would: per session, the latest title, unless the user gave one,
 * in which case the latest the user gave. Sessions none of these lines titles keep their title, and
 * a session a purge removed gets none.
 */
export function reparseTitles(ctx: MigrationContext, source: string, needles: string[]): void {
  const titles = new Map<string, { title: string; manual: boolean }>();
  reparse(ctx, source, needles, (parsed, purged) => {
    if (!parsed.sessionTitle || !parsed.sessionId) return;
    if (purged.any && purged.session(source, parsed.sessionId) !== null) return;
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
  const purged = purgedLookup(ctx.db);
  let events = 0;
  let errors = 0;
  for (const f of files) {
    if (blockedFile(purged, f)) continue;
    const device = parseRawPath(f.path).device ?? hub;
    const insert = eventInserter(ctx.db, source, f.id, recordedAgentVersion(ctx.db, f.id), purged);
    const parse = mirroredLineParser(ctx.db, ctx.home, adapter, f);
    try {
      // Every line: an empty needle is found in each.
      scanMirrorLines(ctx.db, ctx.home, f.id, [''], (line, lineNo) => {
        if (isSkippedLine(line)) return;
        let parsed: ParsedLine | null;
        try {
          parsed = parse(line, lineNo);
        } catch {
          errors++;
          return;
        }
        if (!parsed) return;
        events += insert(lineNo, parsed.events).length;
        if (!parsed.memory) return;
        try {
          importMemory(ctx.db, { source, device, growthOrigin: hub, purged }, parsed.memory);
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

/**
 * What a line must contain for a parent to be read from it. ZCode writes `parent_id` on every
 * session line (null when it has none). A `parent` line of `places.jsonl` carries `"type":"parent"`.
 * Other lines of Claude Code and Cursor hold no parent.
 */
const PARENT_NEEDLES: Record<string, string[]> = {
  zcode: ['"parent_id"', '"type":"parent"'],
  grok: ['"subagent_spawned"', '"type":"parent"'],
  codex: ['"parent_thread_id"', '"type":"parent"'],
  'claude-code': ['"type":"parent"'],
  cursor: ['"type":"parent"'],
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
  const purged = purgedLookup(db);
  // Looked up once an event is added: a store without a name gets one when it needs it.
  let growthOrigin: string | null = null;
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
    if (blockedFile(purged, f)) continue;
    const parse = mirroredLineParser(db, ctx.home, adapter, f);
    // Made when a line first yields an event the store lacks, which is rare: finding the version
    // the file's events record reads the events table.
    let inserter: ReturnType<typeof eventInserter> | null | undefined;
    const insert = (lineNo: number, ev: EventInput): boolean => {
      if (inserter === undefined) {
        inserter =
          shared.get(f.mirror, f.id) === undefined
            ? eventInserter(db, f.source, f.id, recordedAgentVersion(db, f.id), purged)
            : null;
      }
      return inserter !== null && inserter(lineNo, [ev]).length > 0;
    };
    try {
      scanMirrorLines(db, ctx.home, f.id, AUTHOR_NEEDLES[f.source] ?? [''], (line, lineNo) => {
        if (isSkippedLine(line)) return;
        let parsed: ParsedLine | null;
        try {
          parsed = parse(line, lineNo);
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
          if (!insert(lineNo, ev)) continue;
          counts.added++;
          if (ev.kind !== 'memory') {
            touched.set(`${f.source}\n${ev.sessionId}`, {
              source: f.source,
              sessionId: ev.sessionId,
            });
          }
          const event = { ...ev, id, source: f.source };
          deriveFollow(db, event, purged);
          deriveProposal(db, event, purged);
          // A hub that read the line first may have forgotten its event already (invariant 2).
          growthOrigin ??= storeName(db);
          coverEventArrival(db, id, growthOrigin);
        }
        for (const fact of parsed.sessionKinds ?? []) {
          if (purged.any && purged.session(f.source, fact.sessionId) !== null) continue;
          if (recordSessionKind(db, f.source, fact)) counts.kinds++;
        }
      });
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      ctx.log(`Skipped the mirror ${f.mirror}: ${err.message}`);
    }
  }
  for (const s of touched.values()) refreshSession(db, s.source, s.sessionId);
  // A device that dropped its hub's forget of one of these events, which it did not have then,
  // pulls the hub's tombstones again.
  if (counts.added > 0) setSetting(db, PULL_TOMBSTONES_AGAIN, String(Date.now()));
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

/**
 * Derive parent sessions from the raw mirrors (see parents.ts), as ingestion with the adapters now
 * would. Only lines that can name a parent are parsed (PARENT_NEEDLES). A `places.jsonl` mirror is
 * not one of them: its parent lines are applied by `reparsePlaces`, and an agent's adapter cannot
 * parse them. A run's group is recorded only when the line already carries it; this reads no
 * agent's database and no session directory. The built-in sources' adapters are required. Threads
 * are left to the caller. Must run inside a write transaction. Returns the rows that changed.
 */
export interface ParentReparse {
  parents: number;
  sessions: Array<{ source: string; sessionId: string }>;
}

export function reparseParents(ctx: MigrationContext): ParentReparse {
  const { db } = ctx;
  const files = db
    .prepare(
      `SELECT id, source, path, generation, mirror, updated_at FROM raw_file
        WHERE lines_ingested > 0 ORDER BY id`,
    )
    .all() as unknown as RawFileRecord[];
  const todo = files.filter((f) => {
    const rel = mirrorRelPath(f);
    if (MEMORY_STREAM_SOURCES.has(f.source) && rel.startsWith('memory/')) return false;
    // Parent lines of places.jsonl are not agent events. reparsePlaces applies them.
    return !isOriginPlacesFile(rel, f.path);
  });
  if (todo.length === 0) return { parents: 0, sessions: [] };
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
  const skipped = new Set<string>();
  const sessions: Array<{ source: string; sessionId: string }> = [];
  const purged = purgedLookup(db);
  let parents = 0;
  let errors = 0;
  const started = Date.now();
  let told = started;
  for (const [i, f] of todo.entries()) {
    if (Date.now() - told >= PROGRESS_MS) {
      told = Date.now();
      ctx.log(`Reading parent sessions: ${i} of ${todo.length} archived files…`);
    }
    const adapter = adapterOf(f.source);
    if (!adapter) {
      skipped.add(f.source);
      continue;
    }
    if (blockedFile(purged, f)) continue;
    const relPath = mirrorRelPath(f);
    const parse = mirroredLineParser(db, ctx.home, adapter, f);
    try {
      scanMirrorLines(
        db,
        ctx.home,
        f.id,
        PARENT_NEEDLES[f.source] ?? ['"type":"parent"'],
        (line, lineNo) => {
          if (isSkippedLine(line)) return;
          let parsed: ParsedLine | null;
          try {
            parsed = parse(line, lineNo);
          } catch {
            errors++;
            return;
          }
          if (!parsed) return;
          if (parsed.warning) {
            errors++;
            ctx.log(`warning ${relPath}:${lineNo}: ${parsed.warning}`);
            return;
          }
          for (const fact of parsed.sessionParents ?? []) {
            if (
              purged.any &&
              (purged.session(f.source, fact.sessionId) !== null ||
                purged.session(fact.parentSource ?? f.source, fact.parentSessionId) !== null)
            ) {
              continue;
            }
            if (recordSessionParent(db, f.source, fact)) {
              parents++;
              sessions.push({ source: f.source, sessionId: fact.sessionId });
            }
          }
        },
      );
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      ctx.log(`Skipped the mirror ${f.mirror}: ${err.message}`);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  ctx.log(`Read ${parents} parent sessions from ${todo.length} archived files in ${seconds} s.`);
  if (skipped.size > 0) {
    ctx.log(`No adapter for ${[...skipped].sort().join(', ')}: their parent lines were not read.`);
  }
  if (errors > 0) ctx.log(`${errors} mirrored lines could not be parsed; skipped.`);
  return { parents, sessions };
}
