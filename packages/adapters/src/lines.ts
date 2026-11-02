import fs from 'node:fs';
import path from 'node:path';
import {
  AUTHORS,
  type Author,
  type EventInput,
  type EventKind,
  type ParsedLine,
  type Role,
  type SourceAdapter,
  type SourceFile,
  SPEAKER_MAX,
} from '@openlinkos/origin-core';
import { CLAUDE_CODE_SOURCE_ID } from './claude-code.js';
import { CODEX_SOURCE_ID } from './codex.js';
import { CURSOR_SOURCE_ID } from './cursor.js';
import { GROK_SOURCE_ID } from './grok.js';
import { projectFromCwd, relativeUnder } from './util.js';
import { ZCODE_SOURCE_ID } from './zcode.js';

/**
 * Event lines: the format of the sources a person brings themselves (format notes:
 * docs/sources.md#your-own-sources-event-lines). A file of event lines is UTF-8 JSONL, one event per
 * line, appended to by whatever writes it: a script, a bot, a pipeline. One adapter reads every such
 * source, each under its own id: on a device, a directory `$ORIGIN_HOME/sources/<id>/` and the
 * `.jsonl` files below it; on a hub, the lines its devices push and those appended to it over HTTP.
 * Parsing is pure: a line is one event, its id `<source>:<id>`, and a line that is not a valid
 * event is a parse error.
 */

/** The ids of the built-in sources, which no source of one's own may take. */
export const BUILT_IN_SOURCE_IDS: readonly string[] = [
  CLAUDE_CODE_SOURCE_ID,
  CODEX_SOURCE_ID,
  CURSOR_SOURCE_ID,
  GROK_SOURCE_ID,
  ZCODE_SOURCE_ID,
];

/**
 * Words no source of one's own may take: `devices` names the mirrors a hub keeps of its devices'
 * files (`raw/devices/…`), and the others are words people and tools use for no source in particular.
 */
export const RESERVED_SOURCE_NAMES: readonly string[] = [
  'origin',
  'hub',
  'local',
  'all',
  'devices',
];

/** A source of one's own is named by its directory: 2 to 32 lowercase letters, digits, and hyphens. */
export const LINES_SOURCE_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Whether `name` can name a source of one's own: well formed, not built in, and not reserved. */
export function isLinesSourceId(name: string): boolean {
  return (
    LINES_SOURCE_RE.test(name) &&
    !BUILT_IN_SOURCE_IDS.includes(name) &&
    !RESERVED_SOURCE_NAMES.includes(name)
  );
}

/** Why a directory under `sources/` names no source, for the warning that it is ignored. */
export const LINES_SOURCE_RULE =
  'a source is named by its directory: 2 to 32 lowercase letters, digits, and hyphens, starting with a letter, other than a built-in source (claude-code, codex, cursor, grok, zcode) and origin, hub, local, all, and devices';

export interface LinesAdapterOptions {
  /** The source's id, which events carry (`<id>:<line id>`). */
  id: string;
  /** The directory whose `.jsonl` files it reads, `$ORIGIN_HOME/sources/<id>` on a device. */
  dir: string;
}

/** Longest `id`, `session`, and `parent`, in characters. */
const ID_MAX = 200;
/** Longest version read from a source's VERSION file. */
const VERSION_MAX = 100;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** ISO 8601 date and time with an offset (`Z` or `±hh:mm`), to the minute, the second, or a fraction. */
const ISO_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-](\d{2}):?(\d{2}))$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The latest time a Date can hold, in epoch ms. */
const TIME_MAX = 8.64e15;
const ROLES: readonly Role[] = ['user', 'assistant', 'system'];
const KINDS: readonly EventKind[] = ['message', 'tool_use', 'tool_result', 'meta', 'system'];

/** The adapter of one source of one's own, whose files are the event lines under `dir`. */
export function createLinesAdapter(opts: LinesAdapterOptions): SourceAdapter {
  if (!isLinesSourceId(opts.id)) {
    throw new Error(`"${opts.id}" cannot name a source: ${LINES_SOURCE_RULE}.`);
  }
  const root = opts.dir;
  return {
    id: opts.id,
    displayName: opts.id,
    version: () => readVersion(root),
    async discover(): Promise<SourceFile[]> {
      const found: Array<SourceFile & { mtimeMs: number }> = [];
      walk(root, root, found);
      // Oldest first, as a sync ingests them, so that arrival order follows time.
      found.sort((a, b) => a.mtimeMs - b.mtimeMs || a.relPath.localeCompare(b.relPath));
      return found.map(({ absPath, relPath }) => ({ absPath, relPath }));
    },
    locate(absPath: string): SourceFile | null {
      // A file as walk() lists it: a `.jsonl` file below the directory, none of its parts hidden.
      const rel = relativeUnder(root, absPath);
      if (rel === null || !rel.endsWith('.jsonl')) return null;
      const segments = rel.split('/');
      if (segments.some((s) => s.startsWith('.'))) return null;
      return { absPath: path.join(root, ...segments), relPath: rel };
    },
    parseLine: (line: string) => parseEventLine(line),
  };
}

/** The `.jsonl` files below `dir`, with their modification times; hidden files and directories are skipped. */
function walk(root: string, dir: string, out: Array<SourceFile & { mtimeMs: number }>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(root, abs, out);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(abs).mtimeMs;
      } catch {
        continue; // gone since it was listed
      }
      const relPath = path.relative(root, abs).split(path.sep).join('/');
      out.push({ absPath: abs, relPath, mtimeMs });
    }
  }
}

/**
 * The version of whatever writes the source, from the first line of a `VERSION` file in its
 * directory, if there is one; events record it as the agent version.
 */
function readVersion(dir: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8');
  } catch {
    return null;
  }
  const first = (text.split(/\r?\n/, 1)[0] ?? '').trim();
  return first.length > 0 && first.length <= VERSION_MAX && !CONTROL_RE.test(first) ? first : null;
}

/**
 * The sources of one's own under `sourcesDir` (`$ORIGIN_HOME/sources`): one lines adapter for each
 * directory whose name can name a source, in name order, and the names of the directories that
 * cannot, which are ignored. Hidden entries and files are passed over.
 */
export function linesSources(sourcesDir: string): { adapters: SourceAdapter[]; ignored: string[] } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return { adapters: [], ignored: [] };
  }
  const adapters: SourceAdapter[] = [];
  const ignored: string[] = [];
  for (const ent of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (ent.name.startsWith('.')) continue;
    const dir = path.join(sourcesDir, ent.name);
    if (!isDirectory(ent, dir)) continue;
    if (isLinesSourceId(ent.name)) adapters.push(createLinesAdapter({ id: ent.name, dir }));
    else ignored.push(ent.name);
  }
  return { adapters, ignored };
}

/** A directory, or a link to one: a source's directory may live elsewhere. */
function isDirectory(ent: fs.Dirent, abs: string): boolean {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** Refuse a line, saying what is wrong with it. */
const fail = (message: string): never => {
  throw new Error(message);
};

/** A required string of 1 to ID_MAX characters, without control characters. */
function idField(obj: Record<string, unknown>, name: string): string {
  const v = obj[name];
  if (typeof v !== 'string') return fail(`"${name}" must be a string`);
  if (v.length === 0 || v.length > ID_MAX) {
    return fail(`"${name}" must have 1 to ${ID_MAX} characters`);
  }
  if (CONTROL_RE.test(v)) return fail(`"${name}" must not contain control characters`);
  return v;
}

/** An optional string: absent, null, or empty is none. */
function optionalString(obj: Record<string, unknown>, name: string): string | null {
  const v = obj[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return fail(`"${name}" must be a string`);
  return v.length > 0 ? v : null;
}

/** An event's time: ISO 8601 with an offset, or epoch milliseconds. */
function timeField(v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > TIME_MAX) return fail('"time" is out of range');
    return Math.round(v);
  }
  if (typeof v !== 'string') {
    return fail('"time" must be ISO 8601 with an offset, or epoch milliseconds');
  }
  const ms = isoTime(v);
  if (!Number.isFinite(ms)) {
    return fail('"time" must be ISO 8601 with an offset, such as 2026-11-02T09:30:00Z');
  }
  return ms;
}

/**
 * The epoch milliseconds of an ISO 8601 time with an offset, or NaN unless it names a real moment:
 * Date.parse alone rolls a day past the end of its month over into the next, and takes 24:00.
 */
function isoTime(v: string): number {
  const m = ISO_TIME_RE.exec(v);
  if (!m) return Number.NaN;
  const n = (i: number) => (m[i] === undefined ? 0 : Number(m[i]));
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = [
    n(1),
    n(2),
    n(3),
    n(4),
    n(5),
    n(6),
    n(7),
    n(8),
  ];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 && leap ? 29 : (MONTH_DAYS[month - 1] ?? 0);
  const valid =
    day >= 1 &&
    day <= days &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHours <= 23 &&
    offsetMinutes <= 59;
  return valid ? Date.parse(v) : Number.NaN;
}

/**
 * Parse one event line (see docs/sources.md#your-own-sources-event-lines): pure and deterministic.
 * Throws on a line that is not a JSON object or not a valid event, which ingestion counts as a parse
 * error; fields it does not know are left in the mirror.
 */
export function parseEventLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return fail('not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('not a JSON object');
  }
  const obj = value as Record<string, unknown>;
  const id = idField(obj, 'id');
  const session = idField(obj, 'session');
  const ts = timeField(obj.time);
  const role = obj.role;
  if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
    return fail(`"role" must be one of ${ROLES.join(', ')}`);
  }
  const kind = obj.kind;
  if (kind === 'memory') {
    return fail('"kind" memory is reserved for the memory files agents keep for themselves');
  }
  if (typeof kind !== 'string' || !KINDS.includes(kind as EventKind)) {
    return fail(`"kind" must be one of ${KINDS.join(', ')}`);
  }
  if (typeof obj.text !== 'string') return fail('"text" must be a string');
  const cwd = optionalString(obj, 'cwd');
  const project = optionalString(obj, 'project') ?? projectFromCwd(cwd ?? undefined);
  const branch = optionalString(obj, 'branch');
  const parent = obj.parent === undefined || obj.parent === null ? null : idField(obj, 'parent');
  const meta = obj.meta;
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    return fail('"meta" must be an object');
  }
  const title = optionalString(obj, 'title')?.trim() || null;
  const titleBy = obj.title_by;
  if (titleBy !== undefined && titleBy !== null && titleBy !== 'user' && titleBy !== 'agent') {
    return fail('"title_by" must be user or agent');
  }
  const author = optionalString(obj, 'author');
  if (author !== null) {
    if (!AUTHORS.includes(author as Author)) {
      return fail(`"author" must be one of ${AUTHORS.join(', ')}`);
    }
    if (role !== 'user') return fail('"author" is only for lines whose "role" is user');
  }
  const speaker = optionalString(obj, 'speaker');
  if (speaker !== null && (speaker.length > SPEAKER_MAX || CONTROL_RE.test(speaker))) {
    return fail(`"speaker" must have 1 to ${SPEAKER_MAX} characters, without control characters`);
  }

  const event: EventInput = {
    id,
    sessionId: session,
    parentId: parent,
    ts,
    project,
    cwd,
    gitBranch: branch,
    role: role as Role,
    kind: kind as EventKind,
    text: obj.text,
    meta:
      meta && Object.keys(meta as Record<string, unknown>).length > 0
        ? (meta as Record<string, unknown>)
        : null,
  };
  // Who wrote an input: the line says so, or else a message is a person's, not known to be the
  // owner's, and a meta event the system's. A source states `owner` itself.
  if (role === 'user' && (kind === 'message' || kind === 'meta')) {
    event.author = (author as Author | null) ?? (kind === 'message' ? 'person' : 'system');
    event.authorSignal = author !== null ? 'author' : 'default';
    if (speaker !== null) event.speaker = speaker;
  }
  const parsed: ParsedLine = { events: [event] };
  if (title) {
    parsed.sessionTitle = title;
    parsed.sessionId = session;
    if (titleBy === 'user') parsed.manualTitle = true;
  }
  return parsed;
}
