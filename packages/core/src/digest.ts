import { ownerPromptSql } from './authors.js';
import type { Database } from './db.js';
import { json, jsonIsOne } from './dialect.js';
import { type Entry, getEntry, isEntryId } from './entries.js';
import { OriginError } from './errors.js';
import { isRestoreTarget } from './forgetting.js';
import { displayTitle, getSessionParent, isFoldedChild } from './parents.js';
import { entryProjectMatchSql } from './places.js';
import { promptTitle } from './prompt.js';
import { countProposals, listProposals, type Proposal } from './proposals.js';
import { getSession, sessionKey, VISIBLE_EVENT } from './store.js';
import type { SessionRow } from './types.js';

/**
 * The digest of a day (see docs/architecture.md#daily-digest): what happened in the store on one
 * calendar day, built from the store alone, with no model call. The sessions active that day, with
 * their child sessions folded in; the owner's prompts, the tools called, and the files edited; the
 * entries written, the entries proposed, and the forgets made. Nothing forgotten is shown, and a
 * forget is listed by id only.
 */

/** Most sessions, and most entries, proposals, and forgets, a digest lists by default. */
export const DIGEST_LIMIT = 50;
/** The largest `limit` a digest accepts. */
export const DIGEST_LIMIT_MAX = 200;
/** How many of a session's prompts of the day a digest shows, and at most how long each. */
export const DIGEST_PROMPTS = 5;
export const DIGEST_PROMPT_CHARS = 200;
/** How many tools, and how many files, a digest names for one session. */
export const DIGEST_TOOLS = 20;
export const DIGEST_FILES = 20;

// ---------------------------------------------------------------------------------------------
// Days in a time zone

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new OriginError(
        `Unknown time zone: ${timeZone} (use an IANA name, such as Europe/Berlin).`,
      );
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** The time zone this process runs in, as an IANA name. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(ms: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const n = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour'),
    minute: n('minute'),
    second: n('second'),
  };
}

/** Minutes east of UTC in a time zone at an instant. */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - (ms - (((ms % 1000) + 1000) % 1000))) / 60_000);
}

/**
 * The first instant of a calendar day in a time zone: its midnight, or, where a change of offset
 * skips midnight, the instant of the change.
 */
function dayStart(year: number, month: number, day: number, timeZone: string): number {
  const midnight = Date.UTC(year, month - 1, day);
  const a = midnight - offsetAt(midnight, timeZone) * 60_000;
  const b = midnight - offsetAt(a, timeZone) * 60_000;
  const c = midnight - offsetAt(b, timeZone) * 60_000;
  const onDay = (t: number) => {
    const w = wallClock(t, timeZone);
    return w.year === year && w.month === month && w.day === day;
  };
  return [a, b, c].filter(onDay).sort((x, y) => x - y)[0] ?? b;
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/**
 * ISO 8601 timestamp in a time zone, with milliseconds and offset (as isoLocal, for a zone other
 * than this process's).
 */
export function isoIn(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  const off = offsetAt(ms, timeZone);
  const sign = off >= 0 ? '+' : '-';
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(
    ((ms % 1000) + 1000) % 1000,
    3,
  )}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** A calendar day in a time zone, as the instants it spans. */
export interface DigestDay {
  /** `YYYY-MM-DD`. */
  day: string;
  /** The IANA name of the time zone the day is in. */
  timeZone: string;
  /** Its first instant, epoch ms (inclusive). */
  from: number;
  /** The first instant of the next day, epoch ms (exclusive). */
  until: number;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A day (`YYYY-MM-DD`, today by default) in a time zone (this process's by default). The day is
 * 23 or 25 hours long when the zone changes its offset in it.
 */
export function digestDay(day?: string, timeZone?: string, now = Date.now()): DigestDay {
  const zone = timeZone?.trim() || localTimeZone();
  const canonical = formatter(zone).resolvedOptions().timeZone;
  let year: number;
  let month: number;
  let date: number;
  if (day === undefined || day.trim() === '') {
    ({ year, month, day: date } = wallClock(now, zone));
  } else {
    const m = DAY_RE.exec(day.trim());
    const check = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (
      !m ||
      !check ||
      check.getUTCFullYear() !== Number(m[1]) ||
      check.getUTCMonth() !== Number(m[2]) - 1 ||
      check.getUTCDate() !== Number(m[3])
    ) {
      throw new OriginError(`Not a day: ${day} (use YYYY-MM-DD).`);
    }
    year = Number(m[1]);
    month = Number(m[2]);
    date = Number(m[3]);
  }
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return {
    day: `${year}-${pad(month)}-${pad(date)}`,
    timeZone: canonical,
    from: dayStart(year, month, date, zone),
    until: dayStart(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), zone),
  };
}

// ---------------------------------------------------------------------------------------------
// Files edited

/** What an adapter appends to a text it cut short (see truncate in the adapters). */
const CUT = /…\[\+\d+ chars\]$/;

/** A string field of a call's JSON input, read with a pattern: the input may be cut short. */
function field(name: string): (input: string) => string[] {
  const re = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  return (input) => {
    const m = re.exec(input);
    if (!m) return [];
    try {
      const value = JSON.parse(`"${m[1]}"`) as string;
      return value.trim() ? [value.trim()] : [];
    } catch {
      return [];
    }
  };
}

/** JSON string escapes, undone without parsing (the text may be cut short). */
function unescapeJson(text: string): string {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_, c: string) =>
    c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : (simple[c] ?? c),
  );
}

/**
 * The files of an `apply_patch` call: its `*** Add File:`, `*** Update File:`, `*** Delete File:`,
 * and `*** Move to:` lines. The patch is the raw input of a custom tool call, or a JSON string in a
 * function call's arguments. A line the 2,000-character cut ends in is left out.
 */
function patchFiles(input: string): string[] {
  const cut = CUT.exec(input);
  let text = cut ? input.slice(0, cut.index) : input;
  if (text.trimStart().startsWith('{')) text = unescapeJson(text);
  const lines = text.split('\n');
  if (cut) lines.pop();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m =
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
    if (m?.[1]?.trim()) out.push(m[1].trim());
  }
  return out;
}

/**
 * The tools that edit files, per source, and how to read the paths from a call's event text
 * (`<tool> <input>`, at most 2,000 characters). See docs/sources.md#files-edited. Other sources,
 * and other tools (shell commands included), count as tool calls only.
 */
const FILE_EDITS: Record<string, Record<string, (input: string) => string[]>> = {
  'claude-code': {
    Edit: field('file_path'),
    MultiEdit: field('file_path'),
    Write: field('file_path'),
    NotebookEdit: field('notebook_path'),
  },
  codex: { apply_patch: patchFiles },
  grok: { search_replace: field('file_path') },
  cursor: { StrReplace: field('path') },
};

const EDIT_TOOLS = [...new Set(Object.values(FILE_EDITS).flatMap((t) => Object.keys(t)))];

/**
 * The files a tool call edits, as written in its input, or none when the source's tool is not one
 * that edits files (see FILE_EDITS).
 */
export function editedFiles(source: string, tool: string, text: string): string[] {
  const read = FILE_EDITS[source]?.[tool];
  if (!read) return [];
  const input = text.startsWith(`${tool} `) ? text.slice(tool.length + 1) : text;
  return read(input);
}

/** A path relative to `cwd` when it is under it, with `/` separators; otherwise as written. */
function relativeTo(file: string, cwd: string | null): string {
  const p = file.replace(/\\/g, '/');
  if (!cwd) return p;
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!base) return p;
  const fold = (s: string) => (/^[A-Za-z]:\//.test(s) || s.startsWith('//') ? s.toLowerCase() : s);
  return fold(p).startsWith(`${fold(base)}/`) ? p.slice(base.length + 1) : p;
}

// ---------------------------------------------------------------------------------------------
// The digest

export interface DigestOptions {
  /** `YYYY-MM-DD`; today by default. */
  day?: string;
  /** An IANA time zone name; this process's by default. */
  timeZone?: string;
  /** Only sessions whose resolved project this is, and the entries and proposals of it. */
  project?: string;
  /** Only sessions of this agent, and the entries and proposals made from them. */
  source?: string;
  /** Most sessions, and most entries, proposals, and forgets (DIGEST_LIMIT; at most DIGEST_LIMIT_MAX). */
  limit?: number;
  /** epoch ms: what "today" is. */
  now?: number;
}

/** A prompt the owner wrote that day. */
export interface DigestPrompt {
  id: string;
  ts: number;
  /** Its text as a prompt reads (see promptTitle), at most DIGEST_PROMPT_CHARS characters. */
  text: string;
}

/**
 * A top-level session active that day. Its events, times, tools, and files include those of its
 * child sessions active that day; its prompts are its own (a child's are an agent's).
 */
export interface DigestSession {
  source: string;
  sessionId: string;
  /** Its resolved project. */
  project: string | null;
  thread: string | null;
  /** Its title as shown (see displayTitle), or null. */
  title: string | null;
  /** Without a title, its first prompt (on any day), as a timeline shows it. */
  prompt: string | null;
  /** Its first and last event that day, epoch ms. */
  first: number;
  last: number;
  /** Its events that day. */
  events: number;
  /** The owner's prompts that day, in order: the first DIGEST_PROMPTS. */
  prompts: DigestPrompt[];
  /** How many prompts the owner wrote in it that day. */
  promptCount: number;
  /** Calls that day by tool, most first: at most DIGEST_TOOLS. */
  tools: Array<{ name: string; calls: number }>;
  /** Tool calls that day, of every tool. */
  toolCalls: number;
  /** The files its edit calls changed that day, most edited first: at most DIGEST_FILES. */
  files: string[];
  /** How many files in all. */
  fileCount: number;
  /** Its child sessions active that day, at any depth, and their distinct workflow names. */
  children: number;
  workflows: string[];
}

/** Sessions, their events, and the owner's prompts in them. */
export interface DigestCounts {
  sessions: number;
  events: number;
  prompts: number;
}

/** A forget or a restore made that day, by id: never its reason, never what it hides. */
export interface DigestForget {
  id: string;
  kind: 'forget' | 'restore';
  target: string;
  /** What it targets: an entry, an event, a proposal (rejecting it), or, for a restore, a forget. */
  targetKind: 'entry' | 'event' | 'proposal' | 'forget';
  at: number;
}

export interface Digest extends DigestDay {
  totals: DigestCounts & {
    /** Distinct named projects, and distinct agents. */
    projects: number;
    agents: number;
    /** Child sessions active that day, folded into the sessions. */
    children: number;
  };
  /** By resolved project (null for sessions without one), most events first. */
  projects: Array<DigestCounts & { project: string | null }>;
  /** By agent, most events first. */
  agents: Array<DigestCounts & { source: string }>;
  /** Most recent activity first. */
  sessions: DigestSession[];
  /** How many sessions the limit left out. */
  moreSessions: number;
  /** Versions written that day, corrections included, that are not forgotten: newest first. */
  entries: Entry[];
  moreEntries: number;
  /** Proposals made that day that are shown (pending or accepted): newest first. */
  proposals: Proposal[];
  moreProposals: number;
  /** Forgets and restores made that day, whatever the filter: newest first. */
  forgets: DigestForget[];
  moreForgets: number;
}

/** The top-level session a session's activity is counted under (see TOP_LEVEL_SESSION). */
function topFinder(db: Database): (source: string, sessionId: string) => [string, string] {
  const memo = new Map<string, [string, string]>();
  return (source, sessionId) => {
    const k = sessionKey(source, sessionId);
    const known = memo.get(k);
    if (known) return known;
    let top: [string, string] = [source, sessionId];
    if (isFoldedChild(db, source, sessionId)) {
      // Folded: its chain of parents ends at a visible session with no parent.
      const seen = new Set([k]);
      for (let depth = 0; depth < 32; depth++) {
        const parent = getSessionParent(db, top[0], top[1]);
        if (!parent) break;
        const pk = sessionKey(parent.parentSource, parent.parentSessionId);
        if (seen.has(pk)) break;
        seen.add(pk);
        top = [parent.parentSource, parent.parentSessionId];
      }
    }
    memo.set(k, top);
    return top;
  };
}

interface Group {
  source: string;
  sessionId: string;
  row: SessionRow | null;
  first: number;
  last: number;
  events: number;
  children: Array<[string, string]>;
  prompts: DigestPrompt[];
  promptCount: number;
  tools: Map<string, number>;
  toolCalls: number;
  files: Map<string, number>;
}

function limitOf(limit: number | undefined): number {
  if (limit === undefined) return DIGEST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new OriginError(`The limit must be a whole number from 1 to ${DIGEST_LIMIT_MAX}.`);
  }
  return Math.min(limit, DIGEST_LIMIT_MAX);
}

const byCount = <T extends { events: number; sessions: number }>(
  a: T,
  b: T,
  name: (x: T) => string,
): number => b.events - a.events || b.sessions - a.sessions || (name(a) < name(b) ? -1 : 1);

/** The digest of one day (see the top of this file). */
export function digest(db: Database, opts: DigestOptions = {}): Digest {
  const day = digestDay(opts.day, opts.timeZone, opts.now);
  const limit = limitOf(opts.limit);
  const { from, until } = day;

  // The sessions with events that day, each counted under its top-level session.
  const active = db
    .prepare(
      `SELECT e.source, e.session_id, COUNT(*) AS events, MIN(e.ts) AS first, MAX(e.ts) AS last
         FROM event e
        WHERE e.ts >= ? AND e.ts < ? AND e.kind <> 'memory' AND ${VISIBLE_EVENT}
        GROUP BY e.source, e.session_id`,
    )
    .all(from, until) as unknown as Array<{
    source: string;
    session_id: string;
    events: number;
    first: number;
    last: number;
  }>;
  const topOf = topFinder(db);
  const groups = new Map<string, Group>();
  /** The group each active session counts under. */
  const member = new Map<string, Group>();
  for (const r of active) {
    const [source, sessionId] = topOf(r.source, r.session_id);
    const k = sessionKey(source, sessionId);
    let g = groups.get(k);
    if (!g) {
      g = {
        source,
        sessionId,
        row: null,
        first: r.first,
        last: r.last,
        events: 0,
        children: [],
        prompts: [],
        promptCount: 0,
        tools: new Map(),
        toolCalls: 0,
        files: new Map(),
      };
      groups.set(k, g);
    }
    g.events += r.events;
    g.first = Math.min(g.first, r.first);
    g.last = Math.max(g.last, r.last);
    const own = sessionKey(r.source, r.session_id);
    if (own !== k) g.children.push([r.source, r.session_id]);
    member.set(own, g);
  }

  // The filters apply to the top-level session: its children come with it.
  for (const [k, g] of groups) {
    g.row = getSession(db, g.source, g.sessionId);
    const project = g.row?.project ?? null;
    if (
      (opts.source !== undefined && g.source !== opts.source) ||
      (opts.project !== undefined && project !== opts.project)
    ) {
      groups.delete(k);
    }
  }
  const groupOf = (source: string, sessionId: string) => {
    const g = member.get(sessionKey(source, sessionId));
    return g && groups.get(sessionKey(g.source, g.sessionId)) === g ? g : undefined;
  };

  // The owner's prompts: in the owner's conversations only, never in a child or a headless run.
  const prompts = db
    .prepare(
      `SELECT e.id, e.source, e.session_id, e.ts, e.text FROM event e
        WHERE e.ts >= ? AND e.ts < ? AND ${ownerPromptSql(db.dialect)} AND ${VISIBLE_EVENT}
          AND NOT EXISTS (SELECT 1 FROM session_kind k
                           WHERE k.source = e.source AND k.session_id = e.session_id)
          AND NOT EXISTS (SELECT 1 FROM session_parent p
                           WHERE p.source = e.source AND p.session_id = e.session_id)
        ORDER BY e.ts, e.seq`,
    )
    .all(from, until) as unknown as Array<{
    id: string;
    source: string;
    session_id: string;
    ts: number;
    text: string;
  }>;
  for (const p of prompts) {
    const g = groupOf(p.source, p.session_id);
    if (!g || g.source !== p.source || g.sessionId !== p.session_id) continue;
    g.promptCount++;
    if (g.prompts.length < DIGEST_PROMPTS) {
      g.prompts.push({
        id: p.id,
        ts: p.ts,
        text: promptTitle(p.text, DIGEST_PROMPT_CHARS) ?? '',
      });
    }
  }

  // Tool calls, by the name the adapter recorded.
  const d = db.dialect;
  const call = `COALESCE(${json(d, 'e.meta', 'toolUseId')}, ${json(d, 'e.meta', 'callId')})`;
  const tools = db
    .prepare(
      `SELECT e.source, e.session_id, ${json(d, 'e.meta', 'toolName')} AS name, COUNT(*) AS calls
         FROM event e
        WHERE e.ts >= ? AND e.ts < ? AND e.kind = 'tool_use' AND ${VISIBLE_EVENT}
        GROUP BY 1, 2, 3`,
    )
    .all(from, until) as unknown as Array<{
    source: string;
    session_id: string;
    name: string | null;
    calls: number;
  }>;
  for (const t of tools) {
    const g = groupOf(t.source, t.session_id);
    if (!g) continue;
    g.toolCalls += t.calls;
    if (typeof t.name === 'string' && t.name) {
      g.tools.set(t.name, (g.tools.get(t.name) ?? 0) + t.calls);
    }
  }

  // Files edited: the calls of the tools that edit files, less those whose result says they failed.
  const failed = new Set(
    (
      db
        .prepare(
          `SELECT e.source, e.session_id,
                  ${call} AS call
             FROM event e
            WHERE e.ts >= ? AND e.ts < ? AND e.kind = 'tool_result' AND ${VISIBLE_EVENT}
              AND (${jsonIsOne(d, 'e.meta', 'isError')}
                   OR ${json(d, 'e.meta', 'status')} IS NOT NULL)`,
        )
        .all(from, until) as unknown as Array<{
        source: string;
        session_id: string;
        call: string | null;
      }>
    )
      .filter((r) => r.call !== null)
      .map((r) => `${sessionKey(r.source, r.session_id)}\n${r.call}`),
  );
  const edits = db
    .prepare(
      `SELECT e.source, e.session_id, e.text, ${json(d, 'e.meta', 'toolName')} AS name,
              ${call} AS call,
              COALESCE(e.cwd, (SELECT s.cwd FROM session s
                                WHERE s.source = e.source AND s.session_id = e.session_id)) AS cwd
         FROM event e
        WHERE e.ts >= ? AND e.ts < ? AND e.kind = 'tool_use' AND ${VISIBLE_EVENT}
          AND ${json(d, 'e.meta', 'toolName')} IN (${EDIT_TOOLS.map(() => '?').join(', ')})
        ORDER BY e.ts, e.seq`,
    )
    .all(from, until, ...EDIT_TOOLS) as unknown as Array<{
    source: string;
    session_id: string;
    text: string;
    name: string;
    call: string | null;
    cwd: string | null;
  }>;
  for (const e of edits) {
    const g = groupOf(e.source, e.session_id);
    if (!g) continue;
    if (e.call !== null && failed.has(`${sessionKey(e.source, e.session_id)}\n${e.call}`)) continue;
    for (const file of editedFiles(e.source, e.name, e.text)) {
      const path = relativeTo(file, e.cwd);
      g.files.set(path, (g.files.get(path) ?? 0) + 1);
    }
  }

  // Totals, by project, and by agent, over every session the filters keep.
  const all = [...groups.values()];
  const tally = <K>(key: (g: Group) => K) => {
    const out = new Map<K, DigestCounts>();
    for (const g of all) {
      const k = key(g);
      const c = out.get(k) ?? { sessions: 0, events: 0, prompts: 0 };
      c.sessions++;
      c.events += g.events;
      c.prompts += g.promptCount;
      out.set(k, c);
    }
    return out;
  };
  const projects = [...tally((g) => g.row?.project ?? null)]
    .map(([project, c]) => ({ project, ...c }))
    .sort((a, b) => byCount(a, b, (x) => x.project ?? '\uffff'));
  const agents = [...tally((g) => g.source)]
    .map(([source, c]) => ({ source, ...c }))
    .sort((a, b) => byCount(a, b, (x) => x.source));

  all.sort(
    (a, b) =>
      b.last - a.last ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : a.sessionId < b.sessionId ? -1 : 1),
  );
  const sessions = all.slice(0, limit).map((g): DigestSession => {
    const workflows = new Set<string>();
    for (const [source, sessionId] of g.children) {
      const name = getSessionParent(db, source, sessionId)?.runName;
      if (name) workflows.add(name);
    }
    const files = [...g.files].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return {
      source: g.source,
      sessionId: g.sessionId,
      project: g.row?.project ?? null,
      thread: g.row?.thread ?? null,
      title: displayTitle(g.row?.title ?? null, getSessionParent(db, g.source, g.sessionId)),
      prompt: g.row?.prompt ?? null,
      first: g.first,
      last: g.last,
      events: g.events,
      prompts: g.prompts,
      promptCount: g.promptCount,
      tools: [...g.tools]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, DIGEST_TOOLS)
        .map(([name, calls]) => ({ name, calls })),
      toolCalls: g.toolCalls,
      files: files.slice(0, DIGEST_FILES).map(([path]) => path),
      fileCount: files.length,
      children: g.children.length,
      workflows: [...workflows].sort(),
    };
  });

  const entries = entriesOf(db, from, until, opts);
  const proposalFilter = {
    since: from,
    until: until - 1,
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
  };
  const proposals = listProposals(db, { ...proposalFilter, limit });
  const forgets = forgetsOf(db, from, until);

  return {
    ...day,
    totals: {
      sessions: all.length,
      events: all.reduce((n, g) => n + g.events, 0),
      prompts: all.reduce((n, g) => n + g.promptCount, 0),
      projects: projects.filter((p) => p.project !== null).length,
      agents: agents.length,
      children: all.reduce((n, g) => n + g.children.length, 0),
    },
    projects,
    agents,
    sessions,
    moreSessions: all.length - sessions.length,
    entries: entries.slice(0, limit),
    moreEntries: Math.max(0, entries.length - limit),
    proposals,
    moreProposals: Math.max(0, countProposals(db, proposalFilter) - proposals.length),
    forgets: forgets.slice(0, limit),
    moreForgets: Math.max(0, forgets.length - limit),
  };
}

/**
 * The versions written that day that are not forgotten, newest first. With a project, those of
 * the project by the rule the brief uses; with a source, those citing a visible event of that agent.
 */
function entriesOf(
  db: Database,
  from: number,
  until: number,
  opts: Pick<DigestOptions, 'project' | 'source'>,
): Entry[] {
  const where = [
    'en.created_at >= ?',
    'en.created_at < ?',
    'NOT EXISTS (SELECT 1 FROM forgotten_entry fe WHERE fe.entry_id = en.id)',
  ];
  const params: unknown[] = [from, until];
  if (opts.project !== undefined) {
    where.push(entryProjectMatchSql('en.id'));
    params.push(opts.project, opts.project, opts.project);
  }
  if (opts.source !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM entry_source s JOIN event c ON c.id = s.event_id
      WHERE s.entry_id = en.id AND c.source = ?
        AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = c.id))`);
    params.push(opts.source);
  }
  const ids = db
    .prepare(
      `SELECT en.id FROM entry en WHERE ${where.join(' AND ')}
        ORDER BY en.created_at DESC, en.id DESC`,
    )
    .all(...(params as never[])) as unknown as Array<{ id: string }>;
  return ids.map((r) => getEntry(db, r.id)).filter((e): e is Entry => e !== null);
}

/** The forgets and restores made that day, newest first, by id. */
function forgetsOf(db: Database, from: number, until: number): DigestForget[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.target, t.created_at,
              EXISTS (SELECT 1 FROM proposal p WHERE p.event_id = t.target) AS proposal
         FROM tombstone t
        WHERE t.created_at >= ? AND t.created_at < ?
        ORDER BY t.created_at DESC, t.rowid DESC`,
    )
    .all(from, until) as unknown as Array<{
    id: string;
    target: string;
    created_at: number;
    proposal: number;
  }>;
  return rows.map((r) => {
    const restore = isRestoreTarget(r.target);
    return {
      id: r.id,
      kind: restore ? 'restore' : 'forget',
      target: r.target,
      targetKind: restore
        ? 'forget'
        : isEntryId(r.target)
          ? 'entry'
          : r.proposal
            ? 'proposal'
            : 'event',
      at: r.created_at,
    };
  });
}
