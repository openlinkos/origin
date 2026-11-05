import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Database, transaction } from './db.js';
import { readMirror } from './mirror.js';
import { parentPlaceFact } from './parents.js';
import { mirrorRelPath } from './paths.js';
import type { ParsedLine, ProjectRootFact, SessionPlaceFact, SourceFile } from './types.js';

/**
 * Where a session's project name comes from. `explicit` and `manual` are never replaced by a
 * resolution. `segment` is the last part of `cwd` and is not stored. `learned` is a `project_root`
 * row already on this store; a line that says so uses the row's own signal (`git` or `agent`).
 */
export type PlaceSignal = 'git' | 'agent' | 'learned' | 'segment' | 'explicit' | 'manual';

/** Facts an agent recorded about a session whose directory is gone. Core does not know the homes. */
export interface AgentFacts {
  gitRoot?: string | null;
  project?: string | null;
}

export interface PlaceAlias {
  path: string;
  project: string;
  root: string;
  signal: 'git' | 'agent';
}

/** What `resolvePlace` decided. It writes nothing: recall stays read-only. */
export interface PlaceResolution {
  project: string | null;
  /** `comparePath` of the main work tree, or null when there is none. */
  root: string | null;
  /** The main work tree as a path on this machine, when step 2 or an agent git root found one. */
  rootPath: string | null;
  signal: PlaceSignal;
  /** Signal to write. A learned row keeps the signal it was stored with. */
  emitSignal: 'git' | 'agent' | null;
  aliases: PlaceAlias[];
}

const PLACES_FILE = 'places.jsonl';

/** The resolved project of a session: `session_place` when it has one, else the stored label. */
export function resolvedProjectSql(source: string, session: string, fallback: string): string {
  return `COALESCE((SELECT sp.project FROM session_place sp WHERE sp.source = ${source} AND sp.session_id = ${session}), ${fallback})`;
}

/**
 * An entry matches a project when it is named that, or when a session it cites resolves to that.
 * The caller binds the project twice.
 */
export function entryProjectMatchSql(entryId: string): string {
  return `(en.project = ? OR EXISTS (
    SELECT 1 FROM entry_source es
    JOIN event c ON c.id = es.event_id
    JOIN session_place sp ON sp.source = c.source AND sp.session_id = c.session_id
    WHERE es.entry_id = ${entryId} AND sp.project = ?))`;
}

/** A mirror path that carries place lines. */
export function isPlacesRel(relPath: string): boolean {
  return relPath === PLACES_FILE || relPath.endsWith(`/${PLACES_FILE}`);
}

/**
 * A path for comparison. Slashes are `/`, trailing slashes are gone. Only a Windows drive or a UNC
 * path is lowercased. A POSIX path keeps its case, and so does a project name (this never sees one).
 */
export function comparePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('//')) s = s.toLowerCase();
  return s;
}

/** The last segment of a path, in the casing it was written, or null when there is none. */
export function lastSegment(p: string): string | null {
  const parts = p.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1) ?? null;
}

function hasTable(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function stripPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `core.bare` is true. Null when the config cannot be read (the git step fails). Missing is not bare. */
function coreBare(gitDir: string): boolean | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[([^\]]+)\]/.exec(line);
    if (section) {
      const name = section[1] ?? '';
      inCore = (name.split(/\s+/)[0] ?? '').toLowerCase() === 'core';
      continue;
    }
    if (!inCore) continue;
    const bare = /^bare\s*=\s*(.*)$/i.exec(line);
    if (bare?.[1] && /^(true|yes|on|1)$/i.test(bare[1].trim())) return true;
  }
  return false;
}

interface GitHit {
  rootPath: string;
  realRoot: string;
  caller: string;
  realStart: string;
  linked: string | null;
}

/** The git work tree of `start`, or `fail` when git is there but cannot be trusted, or null. */
function tryGit(start: string): GitHit | 'fail' | null {
  const caller = path.resolve(start);
  if (!exists(caller)) return null;
  let realStart: string;
  try {
    realStart = stripPrefix(fs.realpathSync.native(caller));
  } catch {
    return 'fail';
  }
  let at = caller;
  try {
    if (fs.statSync(caller).isFile()) at = path.dirname(caller);
  } catch {
    return 'fail';
  }
  for (;;) {
    const git = path.join(at, '.git');
    let st: fs.Stats;
    try {
      st = fs.lstatSync(git);
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
      continue;
    }
    if (st.isSymbolicLink()) return 'fail';
    if (st.isDirectory()) {
      const bare = coreBare(git);
      if (bare === null || bare) return 'fail';
      return { rootPath: at, realRoot: realOf(at), caller, realStart, linked: null };
    }
    if (!st.isFile()) return 'fail';
    const gitDir = readGitdir(git, at);
    if (gitDir === null) return 'fail';
    const norm = gitDir.replace(/\\/g, '/');
    if (norm.includes('/.git/modules/') && !norm.includes('/.git/worktrees/')) {
      return { rootPath: at, realRoot: realOf(at), caller, realStart, linked: null };
    }
    const common = readCommondir(gitDir);
    if (common === 'fail') return 'fail';
    if (path.basename(common) !== '.git') return 'fail';
    const bare = coreBare(common);
    if (bare === null || bare) return 'fail';
    const main = path.dirname(common);
    return { rootPath: main, realRoot: realOf(main), caller, realStart, linked: at };
  }
}

function realOf(dir: string): string {
  try {
    return stripPrefix(fs.realpathSync.native(dir));
  } catch {
    return dir;
  }
}

function readGitdir(gitFile: string, holder: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(gitFile, 'utf8');
  } catch {
    return null;
  }
  const found = /^gitdir:\s*(.+?)\s*$/im.exec(text);
  const raw = found?.[1];
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(holder, raw);
}

function readCommondir(gitDir: string): string | 'fail' {
  let text: string;
  try {
    text = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? gitDir : 'fail';
  }
  const rel = text.trim();
  if (rel.length === 0) return 'fail';
  return path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel);
}

function fromGit(hit: GitHit, signal: 'git' | 'agent'): PlaceResolution {
  const project = lastSegment(hit.realRoot) ?? lastSegment(hit.rootPath);
  const root = comparePath(hit.realRoot);
  const aliases: PlaceAlias[] = [];
  const add = (p: string) => {
    const key = comparePath(p);
    if (key.length === 0 || aliases.some((a) => a.path === key)) return;
    if (!project) return;
    aliases.push({ path: key, project, root, signal });
  };
  add(hit.realRoot);
  add(hit.rootPath);
  if (hit.linked) add(hit.linked);
  if (comparePath(hit.caller) !== comparePath(hit.realStart)) add(hit.caller);
  return { project, root, rootPath: hit.rootPath, signal, emitSignal: signal, aliases };
}

interface RootRow {
  path: string;
  project: string;
  root: string;
  signal: string;
}

/** The longest `project_root` path that contains `cwd`, under `comparePath`. */
export function longestRoot(db: Database, cwd: string): RootRow | null {
  if (!hasTable(db, 'project_root')) return null;
  const key = comparePath(cwd);
  const rows = db
    .prepare('SELECT path, project, root, signal FROM project_root')
    .all() as unknown as RootRow[];
  let best: RootRow | null = null;
  for (const row of rows) {
    if (key !== row.path && !key.startsWith(`${row.path}/`)) continue;
    if (!best || row.path.length > best.path.length) best = row;
  }
  return best;
}

function fromLearned(row: RootRow): PlaceResolution {
  const emitSignal = row.signal === 'agent' ? 'agent' : row.signal === 'git' ? 'git' : null;
  return {
    project: row.project,
    root: row.root,
    rootPath: null,
    signal: 'learned',
    emitSignal,
    aliases: emitSignal
      ? [{ path: row.path, project: row.project, root: row.root, signal: emitSignal }]
      : [],
  };
}

function fromSegment(cwd: string): PlaceResolution {
  return {
    project: lastSegment(cwd),
    root: null,
    rootPath: null,
    signal: 'segment',
    emitSignal: null,
    aliases: [],
  };
}

/**
 * The project of a working directory. Does not write. Git only when the path exists and `onDisk`
 * is not false. Agent facts only when the path is gone. Then the longest learned root, then the
 * last segment of `cwd`.
 */
export function resolvePlace(
  cwd: string,
  opts: { db?: Database; onDisk?: boolean; agentFacts?: AgentFacts | null } = {},
): PlaceResolution {
  if (opts.onDisk !== false) {
    if (exists(cwd)) {
      const git = tryGit(cwd);
      if (git === 'fail') {
        // A bare repo, a symlink, or an unreadable git dir: do not ask the agent.
      } else if (git) {
        return fromGit(git, 'git');
      }
    } else if (opts.agentFacts) {
      const facts = opts.agentFacts;
      if (facts.gitRoot && exists(facts.gitRoot)) {
        const git = tryGit(facts.gitRoot);
        if (git && git !== 'fail') return fromGit(git, 'agent');
      }
      if (facts.project) {
        return {
          project: facts.project,
          root: null,
          rootPath: null,
          signal: 'agent',
          emitSignal: 'agent',
          aliases: [],
        };
      }
    }
  }
  if (opts.db) {
    const learned = longestRoot(opts.db, cwd);
    if (learned) return fromLearned(learned);
  }
  return fromSegment(cwd);
}

/** Whether `home` lies on a `project_root` alias of `project`. */
export function underProjectAlias(db: Database, home: string, project: string): boolean {
  if (!hasTable(db, 'project_root')) return false;
  const key = comparePath(home);
  const rows = db.prepare('SELECT path FROM project_root WHERE project = ?').all(project) as Array<{
    path: string;
  }>;
  return rows.some((row) => key === row.path || key.startsWith(`${row.path}/`));
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`places.jsonl: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * One line of `places.jsonl`. A `root` or `place` line is a project fact, a complete `parent`
 * line is a parent fact (`fromAgent: false`), and an incomplete parent records nothing. A line
 * that is not the JSON object its type requires sets `warning` and yields nothing: it is skipped,
 * not thrown, so one bad line cannot stop a sync or an upgrade. No message events.
 */
export function parsePlaceLine(line: string): ParsedLine {
  try {
    return parsePlaceObject(line);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'places.jsonl: not JSON';
    return { events: [], warning: message };
  }
}

function parsePlaceObject(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('places.jsonl: not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('places.jsonl: not a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.v !== 1) throw new Error('places.jsonl: "v" must be 1');
  if (obj.type === 'parent') {
    const fact = parentPlaceFact(obj);
    return fact ? { events: [], sessionParents: [fact] } : { events: [] };
  }
  if (obj.type === 'root') {
    const fact: ProjectRootFact = {
      path: requireString(obj, 'path'),
      project: requireString(obj, 'project'),
      root: requireString(obj, 'root'),
      signal: requireString(obj, 'signal'),
    };
    return { events: [], roots: [fact] };
  }
  if (obj.type === 'place') {
    if (obj.root !== null && typeof obj.root !== 'string') {
      throw new Error('places.jsonl: "root" must be a string or null');
    }
    const fact: SessionPlaceFact = {
      sessionId: requireString(obj, 'session'),
      project: requireString(obj, 'project'),
      root: obj.root === null ? null : obj.root,
      signal: requireString(obj, 'signal'),
    };
    return { events: [], places: [fact] };
  }
  return { events: [] };
}

function upsertRoot(
  db: Database,
  row: { path: string; project: string; root: string; signal: string },
  seenAt: number,
): void {
  db.prepare(
    `INSERT INTO project_root (path, project, root, signal, seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       project = excluded.project, root = excluded.root, signal = excluded.signal, seen_at = excluded.seen_at`,
  ).run(row.path, row.project, row.root, row.signal, seenAt);
}

/** A place line. Does not replace `explicit` or `manual`. */
function upsertPlaceLine(
  db: Database,
  source: string,
  sessionId: string,
  project: string,
  root: string | null,
  signal: string,
): void {
  db.prepare(
    `INSERT INTO session_place (source, session_id, project, root, signal) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, session_id) DO UPDATE SET
       project = excluded.project, root = excluded.root, signal = excluded.signal
     WHERE session_place.signal NOT IN ('explicit', 'manual')`,
  ).run(source, sessionId, project, root, signal);
}

/** The line named the project. Replaces a resolution, and not a `manual` row. */
export function recordExplicitPlace(
  db: Database,
  source: string,
  sessionId: string,
  project: string,
): void {
  if (!hasTable(db, 'session_place')) return;
  db.prepare(
    `INSERT INTO session_place (source, session_id, project, root, signal) VALUES (?, ?, ?, NULL, 'explicit')
     ON CONFLICT(source, session_id) DO UPDATE SET
       project = excluded.project, root = excluded.root, signal = excluded.signal
     WHERE session_place.signal <> 'manual'`,
  ).run(source, sessionId, project);
}

/** Apply the roots and places of one parsed line. No-op until the tables exist. */
export function applyPlaceFacts(
  db: Database,
  source: string,
  parsed: ParsedLine,
  seenAt = Date.now(),
): void {
  if (!hasTable(db, 'session_place')) return;
  for (const root of parsed.roots ?? []) upsertRoot(db, root, seenAt);
  for (const place of parsed.places ?? []) {
    upsertPlaceLine(db, source, place.sessionId, place.project, place.root, place.signal);
  }
}

export function rootLine(row: PlaceAlias): string {
  return JSON.stringify({
    v: 1,
    type: 'root',
    path: row.path,
    project: row.project,
    root: row.root,
    signal: row.signal,
  });
}

export function placeLine(session: string, place: PlaceResolution): string | null {
  if (!place.emitSignal || !place.project) return null;
  return JSON.stringify({
    v: 1,
    type: 'place',
    session,
    project: place.project,
    root: place.root,
    signal: place.emitSignal,
  });
}

interface SessionWork {
  session_id: string;
  project: string | null;
  cwd: string | null;
  signal: string | null;
  placed: string | null;
}

function sessionsOf(db: Database, source: string): SessionWork[] {
  return db
    .prepare(
      `SELECT s.session_id, s.project, s.cwd, sp.signal AS signal, sp.project AS placed
         FROM session s
         LEFT JOIN session_place sp ON sp.source = s.source AND sp.session_id = s.session_id
        WHERE s.source = ? AND s.event_count > 0`,
    )
    .all(source) as unknown as SessionWork[];
}

/**
 * The stored name is one the agent chose: an `explicit` or `manual` row, or, with no row yet, a
 * project that is not the last segment of `cwd`. Reproject leaves those. A null cwd with a project
 * is left too.
 */
export function chosenProject(row: {
  project: string | null;
  cwd: string | null;
  signal: string | null;
}): boolean {
  if (row.signal === 'explicit' || row.signal === 'manual') return true;
  if (row.signal) return false;
  if (!row.cwd) return row.project !== null;
  return row.project !== null && row.project !== lastSegment(row.cwd);
}

function mirrorPlaceLines(db: Database, home: string, source: string): string[] {
  const row = db
    .prepare(
      `SELECT id FROM raw_file WHERE source = ? AND path = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(source, PLACES_FILE) as { id: number } | undefined;
  if (!row) return [];
  const text = readMirror(db, home, row.id, 0, Number.MAX_SAFE_INTEGER).toString('utf8');
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

/**
 * Lines not already mirrored for sessions whose cwd resolves by git, agent, or a learned root.
 * Nothing for a segment fallback, a missing path, or a name the agent chose. Reads only.
 */
export function placesSourceFile(
  db: Database,
  home: string,
  source: string,
  opts: {
    agentFacts?: (sessionId: string) => AgentFacts | null;
    now?: number;
  } = {},
): SourceFile | null {
  if (!hasTable(db, 'session_place')) return null;
  const have = new Set(mirrorPlaceLines(db, home, source));
  const roots = new Map<string, PlaceAlias>();
  const places: string[] = [];
  for (const row of sessionsOf(db, source)) {
    if (chosenProject(row)) continue;
    if (!row.cwd) continue;
    const gone = !exists(row.cwd);
    const place = resolvePlace(row.cwd, {
      db,
      onDisk: true,
      agentFacts: gone ? (opts.agentFacts?.(row.session_id) ?? null) : null,
    });
    if (!place.emitSignal) continue;
    for (const alias of place.aliases) roots.set(alias.path, alias);
    const line = placeLine(row.session_id, place);
    if (line && !have.has(line)) places.push(line);
  }
  const fresh = [...roots.values()].map(rootLine).filter((line) => !have.has(line));
  const lines = [...fresh, ...places];
  if (lines.length === 0) return null;
  const pending = [...lines];
  const token = createHash('sha256')
    .update(`${[...have, ...lines].join('\n')}\n`)
    .digest('hex');
  return {
    absPath: PLACES_FILE,
    relPath: PLACES_FILE,
    generated: {
      token,
      mtimeMs: opts.now ?? Date.now(),
      next(_last, maxBytes) {
        const out: string[] = [];
        let bytes = 0;
        while (pending.length > 0) {
          const line = pending[0] as string;
          const size = Buffer.byteLength(line) + 1;
          if (out.length > 0 && bytes + size > maxBytes) break;
          pending.shift();
          out.push(line);
          bytes += size;
        }
        return out;
      },
    },
  };
}

/**
 * Apply `places.jsonl` mirrors again, so a rebuild agrees with the bytes. A line that does not
 * parse is skipped and, when `log` is set, logged as a warning. No-op without the tables.
 */
export function reparsePlaces(db: Database, home: string, log?: (message: string) => void): void {
  if (!hasTable(db, 'session_place')) return;
  const files = db
    .prepare(
      `SELECT id, source, path, generation, mirror FROM raw_file WHERE lines_ingested > 0 ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    source: string;
    path: string;
    generation: number;
    mirror: string;
  }>;
  for (const file of files) {
    if (!isPlacesRel(mirrorRelPath(file))) continue;
    let text = '';
    try {
      text = readMirror(db, home, file.id, 0, Number.MAX_SAFE_INTEGER).toString('utf8');
    } catch {
      continue;
    }
    let lineNo = 0;
    for (const raw of text.split('\n')) {
      lineNo++;
      const line = raw.replace(/\r$/, '');
      if (line.length === 0) continue;
      const parsed = parsePlaceLine(line);
      if (parsed.warning) {
        log?.(`warning ${mirrorRelPath(file)}:${lineNo}: ${parsed.warning}`);
        continue;
      }
      applyPlaceFacts(db, file.source, parsed);
    }
  }
}

export interface ProjectMove {
  from: string;
  to: string;
  sessions: number;
}

export interface SessionShape {
  top: number;
  children: number;
}

export interface ReprojectReport {
  moves: ProjectMove[];
  entriesLeft: number;
  before: SessionShape;
  after: SessionShape;
  text: string;
}

export interface ReprojectResult {
  report: ReprojectReport;
  /** Generated `places.jsonl` files to ingest. Empty for a dry run. */
  files: Array<{ source: string; file: SourceFile }>;
}

/** Sessions with events, and how many of them a `session_parent` row names. Zero children without that table. */
export function sessionShape(db: Database): SessionShape {
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM session WHERE event_count > 0').get() as { n: number }
  ).n;
  if (!hasTable(db, 'session_parent')) return { top: total, children: 0 };
  const children = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM session s
          WHERE s.event_count > 0 AND EXISTS (
            SELECT 1 FROM session_parent p WHERE p.source = s.source AND p.session_id = s.session_id)`,
      )
      .get() as { n: number }
  ).n;
  return { top: total - children, children };
}

function reportText(report: Omit<ReprojectReport, 'text'>): string {
  const lines = report.moves.map((m) => `${m.from} → ${m.to}  ${m.sessions} sessions`);
  lines.push(`entries still named an old project: ${report.entriesLeft}`);
  lines.push(
    `sessions: ${report.before.top} top-level, ${report.before.children} children → ${report.after.top} top-level, ${report.after.children} children`,
  );
  return lines.join('\n');
}

/**
 * Resolve every session that does not already carry a chosen name. `--dry-run` writes nothing.
 * Otherwise upserts rows and returns the `places.jsonl` files still to append. Does not rename
 * entries. Child counts stay 0 while `session_parent` is absent.
 */
export function reproject(
  db: Database,
  opts: {
    dryRun?: boolean;
    home?: string;
    agentFacts?: (source: string, sessionId: string) => AgentFacts | null;
    now?: number;
  } = {},
): ReprojectResult {
  const now = opts.now ?? Date.now();
  const before = sessionShape(db);
  const rows = db
    .prepare(
      `SELECT s.source, s.session_id, s.project, s.cwd, sp.signal AS signal, sp.project AS placed
         FROM session s
         LEFT JOIN session_place sp ON sp.source = s.source AND sp.session_id = s.session_id
        WHERE s.event_count > 0
        ORDER BY s.source, s.session_id`,
    )
    .all() as unknown as Array<SessionWork & { source: string }>;
  const moves = new Map<string, ProjectMove>();
  const writes: Array<{ source: string; sessionId: string; place: PlaceResolution }> = [];
  for (const row of rows) {
    if (chosenProject(row)) continue;
    if (!row.cwd) continue;
    const gone = !exists(row.cwd);
    const place = resolvePlace(row.cwd, {
      db,
      onDisk: true,
      agentFacts: gone ? (opts.agentFacts?.(row.source, row.session_id) ?? null) : null,
    });
    if (!place.emitSignal || !place.project) continue;
    const current = row.placed ?? row.project;
    if (current !== null && current !== place.project) {
      const key = `${current}\0${place.project}`;
      const move = moves.get(key) ?? { from: current, to: place.project, sessions: 0 };
      move.sessions += 1;
      moves.set(key, move);
    }
    writes.push({ source: row.source, sessionId: row.session_id, place });
  }
  const names = [...new Set([...moves.values()].map((m) => m.from))];
  const entriesLeft =
    names.length === 0
      ? 0
      : (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM entry en
                WHERE en.project IN (${names.map(() => '?').join(', ')})
                  AND NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = en.id)`,
            )
            .get(...names) as { n: number }
        ).n;
  if (!opts.dryRun) {
    transaction(
      db,
      () => {
        for (const write of writes) {
          for (const alias of write.place.aliases) upsertRoot(db, alias, now);
          if (!write.place.project || !write.place.emitSignal) continue;
          upsertPlaceLine(
            db,
            write.source,
            write.sessionId,
            write.place.project,
            write.place.root,
            write.place.emitSignal,
          );
        }
      },
      { immediate: true },
    );
  }
  const files: Array<{ source: string; file: SourceFile }> = [];
  if (!opts.dryRun && opts.home) {
    const sources = [...new Set(writes.map((w) => w.source))];
    for (const source of sources) {
      const file = placesSourceFile(db, opts.home, source, {
        now,
        agentFacts: opts.agentFacts ? (id) => opts.agentFacts?.(source, id) ?? null : undefined,
      });
      if (file) files.push({ source, file });
    }
  }
  const after = opts.dryRun ? before : sessionShape(db);
  const listed = [...moves.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  const body = { moves: listed, entriesLeft, before, after };
  return { report: { ...body, text: reportText(body) }, files };
}
