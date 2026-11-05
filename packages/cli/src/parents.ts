import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  type Database,
  getSession,
  getSessionParent,
  isRelay,
  parsePlaceLine,
  readMirror,
  type SourceAdapter,
  syncSource,
} from '@openlinkos/origin-core';

/**
 * `origin sessions parents` (see docs/guide/cli.md). Read-only against a ZCode database and a Grok
 * sessions directory: append `parent` lines to each source's `places.jsonl` for a workflow run's
 * group and name, and for a Grok parent that is only in `summary.json`, when the mirror does not
 * already say so. A dry run prints the counts and writes nothing. It never writes those homes.
 */

const PLACES = 'places.jsonl';

export interface ParentsOptions {
  dryRun: boolean;
  /** The ZCode sqlite file. The caller resolves the default; this never looks one up. */
  zcodeDb: string;
  /** The Grok home. The caller resolves the default; this never looks one up. */
  grokHome: string;
}

interface ParentLine {
  session: string;
  parent: string;
  via: 'subagent' | 'workflow';
  signal: string;
  group?: string;
  name?: string;
}

/** One `parent` line, with no line break. Keys follow the places.jsonl format. */
function parentLine(fields: ParentLine): string {
  const line: Record<string, string | number> = {
    v: 1,
    type: 'parent',
    session: fields.session,
    parent: fields.parent,
    via: fields.via,
  };
  if (fields.group) line.group = fields.group;
  if (fields.name) line.name = fields.name;
  line.signal = fields.signal;
  return JSON.stringify(line);
}

/** A value safe to put on one generated line: non-empty, not huge, and without a line break. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (value.includes('\n') || value.includes('\r')) return null;
  return value;
}

/** Lines already in this source's `places.jsonl` mirror, so a re-run appends none of them. */
function mirroredLines(db: Database, home: string, source: string): Set<string> {
  const raw = db
    .prepare(
      `SELECT id, bytes_ingested AS bytes FROM raw_file
        WHERE source = ? AND path = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(source, PLACES) as { id: number; bytes: number } | undefined;
  if (!raw || raw.bytes <= 0) return new Set();
  const text = readMirror(db, home, raw.id, 0, raw.bytes).toString('utf8');
  return new Set(text.split('\n').filter((line) => line.length > 0));
}

/** A ZCode database opened read-only. `mode=ro` does not create the file. */
function openReadOnly(file: string): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'ro');
  return new DatabaseSync(url.href);
}

/**
 * The root of a `resumed_from` chain: the run whose `resumed_from` is null. Undefined when the
 * chain does not reach one, so the line omits `group`.
 */
function runRoot(
  step: { get: (id: string) => unknown },
  id: string,
  resumedFrom: string | null,
): string | undefined {
  if (resumedFrom === null) return id;
  const seen = new Set<string>([id]);
  let from: string | null = resumedFrom;
  while (from && !seen.has(from)) {
    seen.add(from);
    const row = step.get(from) as { id?: unknown; resumed_from?: unknown } | undefined;
    if (!row || typeof row.id !== 'string' || row.id.length === 0) return undefined;
    const next = clean(row.resumed_from);
    if (next === null) return row.id;
    from = next;
  }
  return undefined;
}

type ZCodeRead = { lines: string[] } | { skip: 'missing' | 'empty' | 'unreadable' };

/**
 * Parent lines a ZCode database can add. Only a session Origin already has, or one that already
 * has a parent row. An existing parent id is kept. A line is emitted to fill a missing group or
 * name, or a parent the mirror has not recorded yet.
 */
function zcodeLines(origin: Database, file: string, have: Set<string>): ZCodeRead {
  if (!fs.existsSync(file)) return { skip: 'missing' };
  let db: DatabaseSync;
  try {
    db = openReadOnly(file);
  } catch {
    return { skip: 'unreadable' };
  }
  try {
    const table = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!table('dwf_run') || !table('dwf_actor')) return { skip: 'empty' };
    const actors = db
      .prepare(
        `SELECT a.session_id AS session_id, r.id AS run_id, r.name AS name,
                r.resumed_from AS resumed_from
           FROM dwf_actor a JOIN dwf_run r ON r.id = a.run_id
          WHERE a.session_id IS NOT NULL AND a.session_id <> ''
          ORDER BY a.id`,
      )
      .all() as Array<{
      session_id: string;
      run_id: string;
      name: string | null;
      resumed_from: string | null;
    }>;
    const parentOf = table('session')
      ? db.prepare('SELECT parent_id, task_type FROM session WHERE id = ?')
      : null;
    const resumedOf = db.prepare('SELECT id, resumed_from FROM dwf_run WHERE id = ?');
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const actor of actors) {
      const sessionId = clean(actor.session_id);
      const runId = clean(actor.run_id);
      if (!sessionId || !runId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      const line = zcodeLine(origin, parentOf, resumedOf, {
        sessionId,
        runId,
        name: clean(actor.name),
        resumedFrom: clean(actor.resumed_from),
      });
      if (line && !have.has(line)) lines.push(line);
    }
    lines.sort();
    return { lines };
  } catch {
    return { skip: 'unreadable' };
  } finally {
    db.close();
  }
}

function zcodeLine(
  origin: Database,
  parentOf: { get: (id: string) => unknown } | null,
  resumedOf: { get: (id: string) => unknown },
  actor: { sessionId: string; runId: string; name: string | null; resumedFrom: string | null },
): string | null {
  const existing = getSessionParent(origin, 'zcode', actor.sessionId);
  const stored = getSession(origin, 'zcode', actor.sessionId);
  if (!existing && !stored) return null;
  const row = parentOf?.get(actor.sessionId) as
    | { parent_id?: unknown; task_type?: unknown }
    | undefined;
  const fromSession = clean(row?.parent_id);
  const parentId = existing?.parentSessionId ?? fromSession;
  if (!parentId || parentId === actor.sessionId) return null;
  const group = runRoot(resumedOf, actor.runId, actor.resumedFrom) ?? null;
  const name = actor.name;
  const fillGroup = group !== null && existing?.runGroup == null;
  const fillName = name !== null && existing?.runName == null;
  if (existing && !fillGroup && !fillName) return null;
  const via = existing?.via ?? (row?.task_type === 'subagent_child' ? 'subagent' : 'workflow');
  return parentLine({
    session: actor.sessionId,
    parent: parentId,
    via,
    signal: 'dwf_run',
    ...(fillGroup && group ? { group } : {}),
    ...(fillName && name ? { name } : {}),
  });
}

type GrokRead = { lines: string[] } | { skip: 'missing' | 'unreadable' };

/**
 * Parents named only by a Grok session's `summary.json` (`parent_session_id`). The child must
 * already be a session in the store, and must not already have a parent row.
 */
function grokLines(origin: Database, home: string, have: Set<string>): GrokRead {
  const sessions = path.join(home, 'sessions');
  if (!fs.existsSync(sessions)) return { skip: 'missing' };
  let groups: string[];
  try {
    groups = fs.readdirSync(sessions);
  } catch {
    return { skip: 'unreadable' };
  }
  const lines: string[] = [];
  for (const group of groups) {
    const dir = path.join(sessions, group);
    let ids: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      ids = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const sessionId = clean(id);
      if (!sessionId) continue;
      const summary = path.join(dir, id, 'summary.json');
      let text: string;
      try {
        if (!fs.statSync(summary).isFile()) continue;
        text = fs.readFileSync(summary, 'utf8');
      } catch {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const parent = clean((value as { parent_session_id?: unknown }).parent_session_id);
      if (!parent || parent === sessionId) continue;
      if (getSessionParent(origin, 'grok', sessionId)) continue;
      if (!getSession(origin, 'grok', sessionId)) continue;
      const line = parentLine({
        session: sessionId,
        parent,
        via: 'subagent',
        signal: 'parent_session_id',
      });
      if (!have.has(line)) lines.push(line);
    }
  }
  lines.sort();
  return { lines };
}

/**
 * Append `lines` to one source's `places.jsonl` through the generated-source path, so the mirror
 * is what a push sends. `next` returns only lines after the cursor.
 */
async function appendPlaces(
  ctx: { db: Database; home: string },
  source: string,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const token = createHash('sha256').update(lines.join('\n')).digest('hex');
  const adapter: SourceAdapter = {
    id: source,
    displayName: source,
    version: () => null,
    async discover() {
      return [
        {
          absPath: PLACES,
          relPath: PLACES,
          generated: {
            token,
            mtimeMs: Date.now(),
            next(last, maxBytes) {
              const at = last === null ? -1 : lines.indexOf(last);
              const rest = lines.slice(at >= 0 ? at + 1 : 0);
              const out: string[] = [];
              let bytes = 0;
              for (const line of rest) {
                if (out.length > 0 && bytes + line.length + 1 > maxBytes) break;
                out.push(line);
                bytes += line.length + 1;
              }
              return out;
            },
          },
        },
      ];
    },
    parseLine: (line) => parsePlaceLine(line),
  };
  await syncSource({ db: ctx.db, home: ctx.home }, adapter);
}

function report(
  label: string,
  read: { lines: string[] } | { skip: string },
  dryRun: boolean,
): void {
  if ('skip' in read) {
    if (read.skip === 'missing') {
      console.log(
        label === 'ZCode'
          ? 'ZCode database not found; skipped.'
          : 'Grok sessions directory not found; skipped.',
      );
      return;
    }
    if (read.skip === 'empty') {
      console.log('ZCode database has no workflow tables; skipped.');
      return;
    }
    console.log(
      label === 'ZCode'
        ? 'ZCode database could not be read; skipped.'
        : 'Grok sessions directory could not be read; skipped.',
    );
    return;
  }
  const n = read.lines.length;
  const verb = dryRun ? 'would append' : 'appended';
  console.log(`${label}: ${verb} ${n} parent ${n === 1 ? 'line' : 'lines'}.`);
}

/** Fill parent lines and return the process exit code. */
export async function backfillParents(
  ctx: { db: Database; home: string },
  opts: ParentsOptions,
): Promise<number> {
  if (isRelay(ctx.db)) {
    console.error(
      'This store is a relay: it keeps no sessions of its own. Run origin sessions parents on the hub.',
    );
    return 1;
  }
  const zcodeHave = mirroredLines(ctx.db, ctx.home, 'zcode');
  const grokHave = mirroredLines(ctx.db, ctx.home, 'grok');
  const zcode = zcodeLines(ctx.db, opts.zcodeDb, zcodeHave);
  const grok = grokLines(ctx.db, opts.grokHome, grokHave);
  report('ZCode', zcode, opts.dryRun);
  report('Grok', grok, opts.dryRun);
  if (!opts.dryRun) {
    if ('lines' in zcode) await appendPlaces(ctx, 'zcode', zcode.lines);
    if ('lines' in grok) await appendPlaces(ctx, 'grok', grok.lines);
  }
  return 0;
}
