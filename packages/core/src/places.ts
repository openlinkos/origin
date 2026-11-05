import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertStoreCurrent, type Database, transaction } from './db.js';
import { readMirror } from './mirror.js';
import { parentPlaceFact, recordSessionParent } from './parents.js';
import { mirrorRelPath, parseRawPath, remotePath } from './paths.js';
import { refreshThreads } from './threads.js';
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

/** An imported memory file's directory: the brief matches that by directory, not by name. */
function importedHomeSql(entryId: string): string {
  return `EXISTS (
    SELECT 1 FROM imported_entry ie
    JOIN entry_source hs ON hs.entry_id = ie.entry_id
    JOIN event hm ON hm.id = hs.event_id
    WHERE ie.entry_id = ${entryId} AND hm.kind = 'memory' AND hm.cwd IS NOT NULL)`;
}

/**
 * An entry matches a project by the same rule as the brief. The caller binds the project three
 * times, the same value: the entry's own name (unless an imported memory names a directory), a
 * `project_root` of this store that contains that directory, or a cited session whose raw label is
 * the entry's project and whose place is the requested project. A cited session's place alone does
 * not move the entry.
 */
export function entryProjectMatchSql(entryId: string): string {
  return `(
    (lower(en.project) = lower(?) AND NOT ${importedHomeSql(entryId)})
    OR EXISTS (
      SELECT 1 FROM imported_entry ie
      JOIN entry_source hs ON hs.entry_id = ie.entry_id
      JOIN event hm ON hm.id = hs.event_id
      JOIN project_root pr ON pr.device = ''
      WHERE ie.entry_id = ${entryId}
        AND hm.kind = 'memory' AND hm.cwd IS NOT NULL
        AND lower(pr.project) = lower(?)
        AND (
          origin_path(hm.cwd) = pr.path
          OR substr(origin_path(hm.cwd), 1, length(pr.path) + 1) = pr.path || '/'))
    OR (
      NOT ${importedHomeSql(entryId)}
      AND EXISTS (
        SELECT 1 FROM entry_source es
        JOIN event c ON c.id = es.event_id
        JOIN session s ON s.source = c.source AND s.session_id = c.session_id
        JOIN session_place sp ON sp.source = s.source AND sp.session_id = s.session_id
        WHERE es.entry_id = ${entryId}
          AND lower(sp.project) = lower(?)
          AND lower(s.project) = lower(en.project))))`;
}

/**
 * An event is in a project when it has no place and its own label says so, or its session's place
 * says so. Either way the caller binds the project once per branch, twice in all. The unplaced
 * branch can use `event_project`.
 */
export function projectEventSql(alias = 'e'): string {
  // A union, not an OR: the unplaced branch can use `event_project`. The caller binds the project
  // once per branch.
  return `${alias}.seq IN (
    SELECT ${alias}.seq FROM event ${alias}
     WHERE ${alias}.project = ? AND NOT EXISTS (
       SELECT 1 FROM session_place sp
        WHERE sp.source = ${alias}.source AND sp.session_id = ${alias}.session_id)
    UNION ALL
    SELECT ${alias}.seq FROM event ${alias}
      JOIN session_place sp
        ON sp.source = ${alias}.source AND sp.session_id = ${alias}.session_id
     WHERE sp.project = ?)`;
}

/** The generated places mirror, and not a file of that name inside a source. */
export function isPlacesRel(relPath: string): boolean {
  return relPath === PLACES_FILE;
}

/**
 * Origin's places file. A generated file is one. On a hub, a device's file is one when its raw
 * path is exactly `places.jsonl` (`@device:places.jsonl`). A person's file, at the top of a source
 * or nested under it, is not: its raw path is a filesystem path.
 */
export function isOriginPlacesFile(relPath: string, rawPath: string, generated?: boolean): boolean {
  return (
    isPlacesRel(relPath) &&
    (generated === true || parseRawPath(rawPath).originalPath === PLACES_FILE)
  );
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

/** The longest `project_root` path that contains `cwd`, for one device, under `comparePath`. */
export function longestRoot(db: Database, cwd: string, device = ''): RootRow | null {
  if (!hasTable(db, 'project_root')) return null;
  const key = comparePath(cwd);
  const rows = db
    .prepare('SELECT path, project, root, signal FROM project_root WHERE device = ?')
    .all(device) as unknown as RootRow[];
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
 * The first directory at or above `start` that contains `.git`, without following a symlink.
 * Null when there is none. Used when git is there but its work tree cannot be read.
 */
function gitHolder(start: string): string | null {
  let at = path.resolve(start);
  try {
    if (fs.statSync(at).isFile()) at = path.dirname(at);
  } catch {
    return null;
  }
  for (;;) {
    try {
      fs.lstatSync(path.join(at, '.git'));
      return at;
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/** A directory that holds `.git` when the work tree itself cannot be read. Emitted, so a hub agrees. */
function fromHolder(holder: string): PlaceResolution {
  const project = lastSegment(holder);
  const root = comparePath(holder);
  const aliases: PlaceAlias[] = [];
  if (project && root.length > 0) aliases.push({ path: root, project, root, signal: 'git' });
  return { project, root, rootPath: holder, signal: 'git', emitSignal: 'git', aliases };
}

/**
 * The project of a working directory. Does not write. When the path exists and `onDisk` is not
 * false: git, or, when git is there but cannot be read, the directory that holds `.git`, or the
 * last segment. A learned root applies only when the path is gone (or this is a hub). Agent facts
 * apply only then too. `device` selects that device's roots; this store's own are `''`.
 */
export function resolvePlace(
  cwd: string,
  opts: { db?: Database; onDisk?: boolean; agentFacts?: AgentFacts | null; device?: string } = {},
): PlaceResolution {
  const device = opts.device ?? '';
  if (opts.onDisk !== false && exists(cwd)) {
    const git = tryGit(cwd);
    if (git === 'fail') {
      const holder = gitHolder(cwd);
      return holder ? fromHolder(holder) : fromSegment(cwd);
    }
    if (git) return fromGit(git, 'git');
    return fromSegment(cwd);
  }
  if (opts.onDisk !== false && !exists(cwd) && opts.agentFacts) {
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
  if (opts.db) {
    const learned = longestRoot(opts.db, cwd, device);
    if (learned) return fromLearned(learned);
  }
  return fromSegment(cwd);
}

/** Whether `home` lies on a `project_root` alias of `project` for one device. */
export function underProjectAlias(
  db: Database,
  home: string,
  project: string,
  device = '',
): boolean {
  if (!hasTable(db, 'project_root')) return false;
  const key = comparePath(home);
  const rows = db
    .prepare('SELECT path FROM project_root WHERE device = ? AND project = ?')
    .all(device, project) as Array<{ path: string }>;
  return rows.some((row) => key === row.path || key.startsWith(`${row.path}/`));
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`places.jsonl: "${key}" must be a non-empty string`);
  }
  return value;
}

/** A root or place line may record git, agent, or learned. Anything else would lock the session. */
const PLACE_LINE_SIGNALS = new Set(['git', 'agent', 'learned']);

function requirePlaceSignal(obj: Record<string, unknown>): string {
  const signal = requireString(obj, 'signal');
  if (!PLACE_LINE_SIGNALS.has(signal)) {
    throw new Error('places.jsonl: "signal" must be git, agent, or learned');
  }
  return signal;
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
  // Only version 1 is applied. Any other `v` (none, or a future `"v":2`) stays in the mirror
  // byte for byte: skip it and warn. The format that understands it calls `reparsePlaces` again.
  if (obj.v !== 1) {
    const shown =
      typeof obj.v === 'number' || typeof obj.v === 'string' ? String(obj.v) : 'missing';
    return {
      events: [],
      warning: `places.jsonl: version ${shown} is not read by this Origin; the line is kept`,
    };
  }
  if (obj.type === 'parent') {
    const fact = parentPlaceFact(obj);
    return fact ? { events: [], sessionParents: [fact] } : { events: [] };
  }
  if (obj.type === 'root') {
    const fact: ProjectRootFact = {
      path: requireString(obj, 'path'),
      project: requireString(obj, 'project'),
      root: requireString(obj, 'root'),
      signal: requirePlaceSignal(obj),
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
      signal: requirePlaceSignal(obj),
    };
    return { events: [], places: [fact] };
  }
  return { events: [] };
}

function upsertRoot(
  db: Database,
  row: { path: string; project: string; root: string; signal: string },
  seenAt: number,
  device = '',
): void {
  db.prepare(
    `INSERT INTO project_root (device, path, project, root, signal, seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device, path) DO UPDATE SET
       project = excluded.project, root = excluded.root, signal = excluded.signal, seen_at = excluded.seen_at`,
  ).run(device, row.path, row.project, row.root, row.signal, seenAt);
}

/** A place line. Does not replace `explicit` or `manual`. True when the row changed. */
function upsertPlaceLine(
  db: Database,
  source: string,
  sessionId: string,
  project: string,
  root: string | null,
  signal: string,
): boolean {
  return (
    db
      .prepare(
        `INSERT INTO session_place (source, session_id, project, root, signal) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, session_id) DO UPDATE SET
           project = excluded.project, root = excluded.root, signal = excluded.signal
         WHERE session_place.signal NOT IN ('explicit', 'manual')`,
      )
      .run(source, sessionId, project, root, signal).changes > 0
  );
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

/** What applying one places line changed: sessions to thread again, and parent rows filled. */
export interface AppliedPlaces {
  sessions: string[];
  parents: number;
}

/**
 * Apply the roots, places, and parents of one parsed line. No-op until the tables exist. `device`
 * is `''` on this store and the sending device's name on a hub. A parent line fills `session_parent`
 * the same way ingestion does, including a run's group and name on a row an agent line already named.
 */
export function applyPlaceFacts(
  db: Database,
  source: string,
  parsed: ParsedLine,
  seenAt = Date.now(),
  device = '',
): AppliedPlaces {
  if (!hasTable(db, 'session_place')) return { sessions: [], parents: 0 };
  const sessions: string[] = [];
  let parents = 0;
  for (const root of parsed.roots ?? []) upsertRoot(db, root, seenAt, device);
  for (const place of parsed.places ?? []) {
    if (upsertPlaceLine(db, source, place.sessionId, place.project, place.root, place.signal)) {
      sessions.push(place.sessionId);
    }
  }
  if (hasTable(db, 'session_parent')) {
    for (const fact of parsed.sessionParents ?? []) {
      if (recordSessionParent(db, source, fact)) {
        parents += 1;
        sessions.push(fact.sessionId);
      }
    }
  }
  return { sessions, parents };
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
  event_count: number;
}

function sessionsOf(db: Database, source: string): SessionWork[] {
  return db
    .prepare(
      `SELECT s.session_id, s.project, s.cwd, s.event_count, sp.signal AS signal, sp.project AS placed
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

function placesPath(device: string): string {
  return device ? remotePath(device, PLACES_FILE) : PLACES_FILE;
}

function mirrorPlaceLines(db: Database, home: string, source: string, device = ''): string[] {
  const row = db
    .prepare(
      `SELECT id FROM raw_file WHERE source = ? AND path = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(source, placesPath(device)) as { id: number } | undefined;
  if (!row) return [];
  const text = readMirror(db, home, row.id, 0, Number.MAX_SAFE_INTEGER).toString('utf8');
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

/** The key under which the latest line of a session or path is kept. The tip is `\\0`. */
const PLACE_TIP = '\0';

function placeLineKey(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'root' && typeof obj.path === 'string' && obj.path.length > 0) {
    return `root\0${obj.path}`;
  }
  if (obj.type === 'place' && typeof obj.session === 'string' && obj.session.length > 0) {
    return `place\0${obj.session}`;
  }
  if (obj.type === 'parent' && typeof obj.session === 'string' && obj.session.length > 0) {
    return `parent\0${obj.session}`;
  }
  return null;
}

/**
 * Record one mirrored places line as the latest of its key, and always as the tip. A warning is
 * the tip only: its bytes stay, and it does not become the conclusion. No-op without the table.
 */
export function rememberPlaceHead(
  db: Database,
  source: string,
  device: string,
  line: string,
  tipOnly = false,
): void {
  if (!hasTable(db, 'place_head')) return;
  const put = db.prepare(
    `INSERT INTO place_head (source, device, key, line) VALUES (?, ?, ?, ?)
     ON CONFLICT(source, device, key) DO UPDATE SET line = excluded.line`,
  );
  put.run(source, device, PLACE_TIP, line);
  if (tipOnly) return;
  const key = placeLineKey(line);
  if (key) put.run(source, device, key, line);
}

function loadPlaceHead(db: Database, source: string, device: string): Map<string, string> {
  if (!hasTable(db, 'place_head')) return new Map();
  const rows = db
    .prepare('SELECT key, line FROM place_head WHERE source = ? AND device = ?')
    .all(source, device) as Array<{ key: string; line: string }>;
  return new Map(rows.map((row) => [row.key, row.line]));
}

function rescanPlaceHead(
  db: Database,
  home: string,
  source: string,
  device: string,
): Map<string, string> {
  if (hasTable(db, 'place_head')) {
    db.prepare('DELETE FROM place_head WHERE source = ? AND device = ?').run(source, device);
  }
  for (const line of mirrorPlaceLines(db, home, source, device)) {
    rememberPlaceHead(db, source, device, line, Boolean(parsePlaceLine(line).warning));
  }
  return loadPlaceHead(db, source, device);
}

function mirrorHasPlaces(db: Database, source: string, device: string): boolean {
  const row = db
    .prepare(
      `SELECT bytes_ingested AS n FROM raw_file
        WHERE source = ? AND path = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(source, placesPath(device)) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * The latest line of each key. When the mirror has bytes and the head is empty, or `last` is not
 * the tip, the mirror is read once and the head filled again. Must run inside the write lock.
 */
function placeHead(
  db: Database,
  home: string,
  source: string,
  device: string,
  last: string | null,
): Map<string, string> {
  const head = loadPlaceHead(db, source, device);
  const tip = head.get(PLACE_TIP) ?? '';
  const stale =
    (mirrorHasPlaces(db, source, device) && head.size === 0) || (last !== null && tip !== last);
  return stale ? rescanPlaceHead(db, home, source, device) : head;
}

function consideredSessions(
  db: Database,
  source: string,
  touched: ReadonlySet<string> | undefined,
): SessionWork[] {
  return sessionsOf(db, source).filter((row) => {
    if (touched && !touched.has(row.session_id)) return false;
    if (chosenProject(row) || !row.cwd) return false;
    return true;
  });
}

/**
 * The lines a resolution would append now: one root line per alias and one place line per session.
 * Compared later with the latest line of that key, not with every line the file has ever held.
 */
function desiredPlaceLines(
  db: Database,
  sessions: SessionWork[],
  opts: { agentFacts?: (sessionId: string) => AgentFacts | null; device?: string },
): string[] {
  const device = opts.device ?? '';
  const roots = new Map<string, PlaceAlias>();
  const places: string[] = [];
  for (const row of sessions) {
    if (!row.cwd) continue;
    const gone = !exists(row.cwd);
    const place = resolvePlace(row.cwd, {
      db,
      onDisk: true,
      device,
      agentFacts: gone ? (opts.agentFacts?.(row.session_id) ?? null) : null,
    });
    if (!place.emitSignal) continue;
    for (const alias of place.aliases) roots.set(alias.path, alias);
    const line = placeLine(row.session_id, place);
    if (line) places.push(line);
  }
  return [...[...roots.values()].map(rootLine), ...places];
}

function freshPlaceLines(lines: string[], head: Map<string, string>): string[] {
  return lines.filter((line) => {
    const key = placeLineKey(line);
    return key !== null && head.get(key) !== line;
  });
}

/**
 * Lines to append for sessions whose cwd resolves by git, agent, or a learned root. Nothing for a
 * segment fallback, a missing path, or a name the agent chose. `touchedSessions` limits the walk
 * to sessions this sync added or changed; omit it to resolve every session. An empty set resolves
 * nothing. The lines themselves are chosen inside `next`, under the write lock, against the latest
 * line of each session or path, so a conclusion that returns to an earlier project is appended again.
 */
export function placesSourceFile(
  db: Database,
  home: string,
  source: string,
  opts: {
    agentFacts?: (sessionId: string) => AgentFacts | null;
    now?: number;
    touchedSessions?: ReadonlySet<string>;
    device?: string;
  } = {},
): SourceFile | null {
  if (!hasTable(db, 'session_place')) return null;
  if (opts.touchedSessions && opts.touchedSessions.size === 0) return null;
  const device = opts.device ?? '';
  const sessions = consideredSessions(db, source, opts.touchedSessions);
  if (sessions.length === 0) return null;
  if (desiredPlaceLines(db, sessions, opts).length === 0) return null;
  const token = createHash('sha256')
    .update(
      sessions
        .map((s) => `${s.session_id}\0${s.cwd ?? ''}\0${s.project ?? ''}\0${s.event_count}`)
        .join('\n'),
    )
    .digest('hex');
  return {
    absPath: placesPath(device),
    relPath: PLACES_FILE,
    generated: {
      token,
      mtimeMs: opts.now ?? Date.now(),
      next(last, maxBytes) {
        const current = consideredSessions(db, source, opts.touchedSessions);
        const head = placeHead(db, home, source, device, last);
        const pending = freshPlaceLines(desiredPlaceLines(db, current, opts), head);
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
 * parse, and a line whose version this Origin does not know, is skipped and, when `log` is set,
 * logged as a warning. The bytes stay in the mirror. The format that understands an unknown
 * version calls this again in its migration. No-op without the tables.
 */
/**
 * Run `fn` under the write lock. A caller that already holds one (a migration's `underLock`) runs
 * `fn` inside that transaction; starting another fails, and any other failure still throws.
 */
function withWriteLock<T>(db: Database, fn: () => T): T {
  assertStoreCurrent(db);
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    const message = (err as Error).message;
    if (!/transaction/i.test(message)) throw err;
    return fn();
  }
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

interface PlacesMirror {
  id: number;
  source: string;
  path: string;
  generation: number;
  mirror: string;
}

function readPlacesText(db: Database, home: string, id: number): string | null {
  try {
    return readMirror(db, home, id, 0, Number.MAX_SAFE_INTEGER).toString('utf8');
  } catch {
    return null;
  }
}

export interface ReparsedPlaces {
  changed: Array<{ source: string; sessionId: string }>;
  /** Parent rows inserted or filled from places lines. */
  parents: number;
}

export function reparsePlaces(
  db: Database,
  home: string,
  log?: (message: string) => void,
): ReparsedPlaces {
  if (!hasTable(db, 'session_place')) return { changed: [], parents: 0 };
  return withWriteLock(db, () => {
    const changed: Array<{ source: string; sessionId: string }> = [];
    let parents = 0;
    const files = db
      .prepare(
        `SELECT id, source, path, generation, mirror FROM raw_file
          WHERE lines_ingested > 0 ORDER BY id`,
      )
      .all() as unknown as PlacesMirror[];
    const mirrors: PlacesMirror[] = [];
    for (const file of files) {
      if (!isPlacesRel(mirrorRelPath(file))) continue;
      const text = readPlacesText(db, home, file.id);
      if (text === null) continue;
      mirrors.push(file);
      // Warnings are logged from this read. The lines applied are read again, still under the
      // lock, so a line appended while the warning was logged is the one that counts.
      let lineNo = 0;
      for (const raw of text.split('\n')) {
        lineNo++;
        const line = raw.replace(/\r$/, '');
        if (line.length === 0) continue;
        const parsed = parsePlaceLine(line);
        if (parsed.warning) log?.(`warning ${mirrorRelPath(file)}:${lineNo}: ${parsed.warning}`);
      }
    }
    for (const file of mirrors) {
      const text = readPlacesText(db, home, file.id);
      if (text === null) continue;
      const device = parseRawPath(file.path).device ?? '';
      const latest = new Map<string, ReturnType<typeof parsePlaceLine>>();
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.length === 0) continue;
        const parsed = parsePlaceLine(line);
        rememberPlaceHead(db, file.source, device, line, Boolean(parsed.warning));
        if (parsed.warning) continue;
        const key = placeLineKey(line);
        if (key) latest.set(key, parsed);
      }
      for (const parsed of latest.values()) {
        const applied = applyPlaceFacts(db, file.source, parsed, Date.now(), device);
        parents += applied.parents;
        for (const sessionId of applied.sessions) {
          changed.push({ source: file.source, sessionId });
        }
      }
    }
    return { changed, parents };
  });
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
  /** Parent rows filled from mirrored places lines. Zero for a dry run, which does not re-read them. */
  parents: number;
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

/**
 * The report as text. `after` is counted when the report is made, before the returned files are
 * ingested: a caller that ingests them counts it again with `sessionShape` first.
 */
export function reprojectText(report: Omit<ReprojectReport, 'text'>): string {
  const lines = report.moves.map((m) => `${m.from} → ${m.to}  ${m.sessions} sessions`);
  lines.push(`entries still named an old project: ${report.entriesLeft}`);
  lines.push(
    `sessions: ${report.before.top} top-level, ${report.before.children} children → ${report.after.top} top-level, ${report.after.children} children`,
  );
  return lines.join('\n');
}

/** Sessions whose events arrived from another device (`@device:path`). This store does not resolve them. */
function remoteSessionKeys(db: Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.source AS source, e.session_id AS session_id
         FROM event e JOIN raw_file r ON r.id = e.raw_file_id
        WHERE r.path LIKE '@%:%'`,
    )
    .all() as Array<{ source: string; session_id: string }>;
  return new Set(rows.map((row) => `${row.source}\0${row.session_id}`));
}

/**
 * Resolve every session of this store that does not already carry a chosen name. A session replicated
 * from another device keeps that device's conclusion: this disk is not its. `--dry-run` writes
 * nothing, and does not read places lines again. Otherwise the lines already mirrored are applied
 * first, and what still differs is returned as `places.jsonl` to append: the tables change only when
 * those lines are ingested. Does not rename entries. Child counts stay 0 while `session_parent`
 * is absent.
 */
export function reproject(
  db: Database,
  opts: {
    dryRun?: boolean;
    /** Resolve only sessions that have no `session_place` row. A session that has one is left. */
    unplacedOnly?: boolean;
    home?: string;
    agentFacts?: (source: string, sessionId: string) => AgentFacts | null;
    now?: number;
  } = {},
): ReprojectResult {
  const now = opts.now ?? Date.now();
  const before = sessionShape(db);
  const reparsed =
    !opts.dryRun && opts.home ? reparsePlaces(db, opts.home) : { changed: [], parents: 0 };
  const rows = db
    .prepare(
      `SELECT s.source, s.session_id, s.project, s.cwd, s.event_count,
              sp.signal AS signal, sp.project AS placed
         FROM session s
         LEFT JOIN session_place sp ON sp.source = s.source AND sp.session_id = s.session_id
        WHERE s.event_count > 0
        ORDER BY s.source, s.session_id`,
    )
    .all() as unknown as Array<SessionWork & { source: string }>;
  const remote = remoteSessionKeys(db);
  const local = rows.filter((row) => !remote.has(`${row.source}\0${row.session_id}`));
  const work = opts.unplacedOnly ? local.filter((row) => row.signal == null) : local;
  const moves = new Map<string, ProjectMove>();
  for (const row of work) {
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
  const files: Array<{ source: string; file: SourceFile }> = [];
  if (!opts.dryRun && opts.home) {
    const sources = [...new Set(work.map((row) => row.source))];
    for (const source of sources) {
      const touchedSessions = new Set(
        work.filter((row) => row.source === source).map((row) => row.session_id),
      );
      const file = placesSourceFile(db, opts.home, source, {
        now,
        touchedSessions,
        agentFacts: opts.agentFacts ? (id) => opts.agentFacts?.(source, id) ?? null : undefined,
      });
      if (file) files.push({ source, file });
    }
  }
  if (!opts.dryRun && reparsed.changed.length > 0) {
    transaction(db, () => refreshThreads(db, reparsed.changed), { immediate: true });
  }
  const after = opts.dryRun ? before : sessionShape(db);
  const listed = [...moves.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  const body = { moves: listed, entriesLeft, before, after };
  return { report: { ...body, text: reprojectText(body) }, files, parents: reparsed.parents };
}
