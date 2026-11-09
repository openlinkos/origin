import { assertStoreCurrent, type Database, transaction } from './db.js';
import { OriginError } from './errors.js';
import type { MigrationContext } from './migrations.js';
import {
  type AgentFacts,
  type ReprojectReport,
  type ReprojectResult,
  reparsePlaces,
  reproject,
  reprojectText,
  type SessionShape,
  sessionShape,
} from './places.js';
import { type ParentReparse, reparseParents } from './reparse.js';
import { deriveThreads } from './threads.js';
import type { SourceAdapter } from './types.js';

/**
 * Repair sessions an older process wrote after the store was upgraded (see docs/guide/upgrading.md).
 * Parent links already in the mirrors, including a places parent line a hub's upgrade skipped, are
 * read again. A session with no `session_place` row is resolved, and the lines that say so are
 * returned to ingest. A session that already has a place is left, and a session replicated from
 * another device is not resolved here. Then every thread is derived again, from scratch, as a
 * migration derives them, which also mends threads an older Origin derived wrongly. A dry run
 * reports all of it and writes nothing. A second run changes nothing. Does not rename entries.
 */

export interface RepairReport extends Omit<ReprojectReport, 'text'> {
  /** Parent rows inserted or filled. */
  parents: number;
  /** Sessions whose thread deriving every thread again changed: joined, left, or moved. */
  threads: number;
  text: string;
}

export interface RepairResult {
  report: RepairReport;
  /** Generated `places.jsonl` files to ingest. Empty for a dry run. */
  files: ReprojectResult['files'];
}

export interface RepairOptions {
  dryRun?: boolean;
  home: string;
  /** Adapter of a source, as a migration asks for it. Null when this process has none. */
  adapters: (source: string) => SourceAdapter | null;
  agentFacts?: (source: string, sessionId: string) => AgentFacts | null;
  now?: number;
  log?: (message: string) => void;
}

function context(
  db: Database,
  home: string,
  adapters: (source: string) => SourceAdapter | null,
  log: (message: string) => void,
): MigrationContext {
  return {
    db,
    home,
    adapter(source) {
      const found = adapters(source);
      if (!found) {
        throw new OriginError(
          `This step re-reads the store's ${source} mirrors, which needs the ${source} adapter.`,
        );
      }
      return found;
    },
    findAdapter: (source) => adapters(source),
    log,
  };
}

/**
 * The report as text. `after` is counted when the report is made, before the returned files are
 * ingested: a caller that ingests them counts it again with `sessionShape` first.
 */
export function repairText(report: Omit<RepairReport, 'text'>): string {
  return [
    `parent links filled: ${report.parents}`,
    `sessions whose thread changed: ${report.threads}`,
    reprojectText(report),
  ].join('\n');
}

/** `before` is counted before any parent link is filled, so that the report shows what changed. */
function reportOf(
  parents: number,
  threads: number,
  repro: ReprojectResult,
  before: SessionShape,
): RepairReport {
  const body = {
    moves: repro.report.moves,
    entriesLeft: repro.report.entriesLeft,
    before,
    after: repro.report.after,
    parents,
    threads,
  };
  return { ...body, text: repairText(body) };
}

/** Run `fn` in a write transaction that is then rolled back: what a dry run would change. */
function rolledBack<T>(db: Database, fn: () => T): T {
  assertStoreCurrent(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    return fn();
  } finally {
    db.exec('ROLLBACK');
  }
}

/**
 * What re-reading the mirrors would fill, and how many sessions deriving the threads again after
 * that would move, then rolled back. `reparsePlaces` joins this transaction instead of starting its
 * own.
 */
function preview(
  db: Database,
  ctx: MigrationContext,
  home: string,
  log: (message: string) => void,
): { parents: number; threads: number } {
  return rolledBack(db, () => {
    const fromMirrors: ParentReparse = reparseParents(ctx);
    const fromPlaces = reparsePlaces(db, home, log);
    return { parents: fromMirrors.parents + fromPlaces.parents, threads: rederiveThreads(db) };
  });
}

/**
 * Derive every thread again, from scratch (see deriveThreads), and count the sessions whose thread
 * that changed. Must run inside a write transaction.
 */
function rederiveThreads(db: Database): number {
  const threads = () =>
    new Map(
      (
        db.prepare('SELECT source, session_id, thread_id FROM session_thread').all() as Array<{
          source: string;
          session_id: string;
          thread_id: string;
        }>
      ).map((r) => [`${r.source}\n${r.session_id}`, r.thread_id]),
    );
  const before = threads();
  deriveThreads(db);
  const after = threads();
  let changed = 0;
  for (const [k, thread] of before) if (after.get(k) !== thread) changed++;
  for (const k of after.keys()) if (!before.has(k)) changed++;
  return changed;
}

export function repairSessions(db: Database, opts: RepairOptions): RepairResult {
  const log = opts.log ?? (() => {});
  const ctx = context(db, opts.home, opts.adapters, log);
  const before = sessionShape(db);
  const placeOpts = {
    home: opts.home,
    unplacedOnly: true,
    agentFacts: opts.agentFacts,
    now: opts.now,
  };
  if (opts.dryRun) {
    const { parents, threads } = preview(db, ctx, opts.home, log);
    const repro = reproject(db, { ...placeOpts, dryRun: true });
    return { report: reportOf(parents, threads, repro, before), files: [] };
  }
  const fromMirrors = transaction(db, () => reparseParents(ctx), { immediate: true });
  const repro = reproject(db, placeOpts);
  // From scratch, which covers the parent links just filled.
  const threads = transaction(db, () => rederiveThreads(db), { immediate: true });
  return {
    report: reportOf(fromMirrors.parents + repro.parents, threads, repro, before),
    files: repro.files,
  };
}
