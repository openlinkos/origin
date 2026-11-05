import { assertStoreCurrent, type Database, transaction } from './db.js';
import { OriginError } from './errors.js';
import type { MigrationContext } from './migrations.js';
import {
  type AgentFacts,
  type ReprojectReport,
  type ReprojectResult,
  reparsePlaces,
  reproject,
} from './places.js';
import { type ParentReparse, reparseParents } from './reparse.js';
import { refreshThreads } from './threads.js';
import type { SourceAdapter } from './types.js';

/**
 * Repair sessions an older process wrote after the store was upgraded (see docs/guide/upgrading.md).
 * Parent links already in the mirrors, including a places parent line a hub's upgrade skipped, are
 * read again. A session with no `session_place` row is resolved, and the lines that say so are
 * returned to ingest. A session that already has a place is left, and a session replicated from
 * another device is not resolved here. A dry run reports both and writes nothing. A second run
 * changes nothing. Does not rename entries.
 */

export interface RepairReport extends Omit<ReprojectReport, 'text'> {
  /** Parent rows inserted or filled. */
  parents: number;
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

function reportOf(parents: number, repro: ReprojectResult): RepairReport {
  return {
    moves: repro.report.moves,
    entriesLeft: repro.report.entriesLeft,
    before: repro.report.before,
    after: repro.report.after,
    parents,
    text: [`parent links filled: ${parents}`, repro.report.text].join('\n'),
  };
}

/**
 * What re-reading the mirrors would fill, then rolled back. `reparsePlaces` joins this transaction
 * instead of starting its own.
 */
function previewParents(
  db: Database,
  ctx: MigrationContext,
  home: string,
  log: (message: string) => void,
): number {
  assertStoreCurrent(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const fromMirrors: ParentReparse = reparseParents(ctx);
    const fromPlaces = reparsePlaces(db, home, log);
    db.exec('ROLLBACK');
    return fromMirrors.parents + fromPlaces.parents;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function repairSessions(db: Database, opts: RepairOptions): RepairResult {
  const log = opts.log ?? (() => {});
  const ctx = context(db, opts.home, opts.adapters, log);
  const placeOpts = {
    home: opts.home,
    unplacedOnly: true,
    agentFacts: opts.agentFacts,
    now: opts.now,
  };
  if (opts.dryRun) {
    const parents = previewParents(db, ctx, opts.home, log);
    const repro = reproject(db, { ...placeOpts, dryRun: true });
    return { report: reportOf(parents, repro), files: [] };
  }
  const fromMirrors = transaction(db, () => reparseParents(ctx), { immediate: true });
  const repro = reproject(db, placeOpts);
  if (fromMirrors.sessions.length > 0) {
    transaction(db, () => refreshThreads(db, fromMirrors.sessions), { immediate: true });
  }
  return {
    report: reportOf(fromMirrors.parents + repro.parents, repro),
    files: repro.files,
  };
}
