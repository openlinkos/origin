import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EventInput,
  EventKind,
  ParseContext,
  ParsedLine,
  Role,
  SourceAdapter,
  SourceFile,
} from '@openlinkos/origin-core';
import {
  frontMatter,
  type MemoryContent,
  markdownFiles,
  memoryContinuation,
  memoryStream,
  parseMemoryLine,
  readFrontMatterMemory,
  readPlainMemory,
} from './memory.js';
import { parseWithPlaces } from './places.js';
import { projectFromCwd, truncate } from './util.js';

/**
 * Grok Build adapter (format notes: docs/sources.md).
 * Sessions: `<GROK_HOME>/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl`, an ACP session-update
 * stream with one `{ method, params: { sessionId, update, _meta }, timestamp }` object per line. On
 * disk each message chunk holds a whole message; a tool call is a `tool_call` line and its result a
 * `tool_call_update` line with `rawOutput`.
 *
 * A session's title is in its `summary.json`, which Grok rewrites in place: each session's title is
 * a generated source (`<session-id>/title.jsonl`) that writes out the title fields of `summary.json`,
 * as stored, as one line whenever the title changes. The other files of a session
 * (`chat_history.jsonl`, which repeats the conversation without timestamps, …) are not read.
 *
 * Grok's memory directories are written out as memory streams, `memory/…` (see memoryStreams).
 */
export const GROK_SOURCE_ID = 'grok';

const UPDATES = 'updates.jsonl';
const SUMMARY = 'summary.json';
/** The path prefix of the memory streams (the sessions' is `sessions/`). */
const MEMORY_PREFIX = 'memory/';
/** Where version 2 keeps the observations it has not consolidated into topics yet. */
const INBOX = 'observations/_inbox';
/** The name of the generated stream of a session's titles, next to its update stream. */
const TITLES = 'title.jsonl';
/**
 * The fields of `summary.json` a title line holds, as stored: the title, and what kind of session it
 * is (`session_kind`, set for a sub-agent's and a headless run's), so that a sub-agent is known as
 * one even when its parent's log is gone.
 */
const TITLE_FIELDS = [
  'info',
  'generated_title',
  'session_summary',
  'title_is_manual',
  'updated_at',
  'session_kind',
];
/**
 * Leads the token of a title stream: a stream written before its lines held `session_kind` has
 * another token, so it is read once more, and the session kind written out if the title line
 * lacked it.
 */
const TITLE_TOKEN = 'k1';
/** The `session_kind`s of a sub-agent's session: its parent agent wrote its prompts. */
const CHILD_KINDS = new Set(['subagent', 'subagent_fork', 'subagent_resume']);
const TOOL_USE_MAX = 2000;
const TOOL_RESULT_MAX = 4000;

export function grokHome(): string {
  const env = process.env.GROK_HOME;
  return env && env.length > 0 ? env : path.join(os.homedir(), '.grok');
}

export interface GrokAdapterOptions {
  /** Override GROK_HOME (tests). */
  home?: string;
}

interface Content {
  type?: string;
  text?: string;
  content?: Content;
  path?: string;
  newText?: string;
}

interface GrokUpdate {
  sessionUpdate?: string;
  content?: Content | Content[];
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** A `subagent_spawned` notice's sub-agent, a session of its own, and the session that spawned it. */
  child_session_id?: unknown;
  parent_session_id?: unknown;
  _meta?: {
    'x.ai/tool'?: { name?: string };
    hideFromScrollback?: boolean;
    /** A prompt's place among the session's prompts. */
    promptIndex?: unknown;
    /** A message the user sent while a turn ran. */
    interjection?: unknown;
    /** A turn Grok's host started, not the user. */
    hostTurn?: unknown;
  };
}

interface GrokLine {
  /** Seconds since the epoch. */
  timestamp?: number;
  params?: {
    update?: GrokUpdate;
    _meta?: { eventId?: string; agentTimestampMs?: number };
  };
}

export function createGrokAdapter(opts: GrokAdapterOptions = {}): SourceAdapter {
  const home = opts.home ?? grokHome();
  return {
    id: GROK_SOURCE_ID,
    displayName: 'Grok Build',
    // Lines carry no version, so events get the installed one (recorded with each sync).
    version: () => readVersion(home),
    async discover(): Promise<SourceFile[]> {
      const out: SourceFile[] = [];
      const sessions = path.join(home, 'sessions');
      for (const group of subdirectories(sessions)) {
        for (const session of subdirectories(path.join(sessions, group))) {
          const dir = path.join(sessions, group, session);
          const abs = path.join(dir, UPDATES);
          if (!isFile(abs)) continue; // a session that never held a conversation
          out.push({ absPath: abs, relPath: `sessions/${group}/${session}/${UPDATES}` });
          const summary = path.join(dir, SUMMARY);
          const st = stat(summary);
          if (st) {
            out.push({
              absPath: summary,
              relPath: `sessions/${group}/${session}/${TITLES}`,
              generated: {
                // summary.json is rewritten every turn; its title changes far less often.
                token: `${TITLE_TOKEN}:${st.size}:${st.mtimeMs}`,
                mtimeMs: st.mtimeMs,
                next: (last) => titleLines(summary, last),
              },
            });
          }
        }
      }
      out.push(...memoryStreams(home));
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    parseLine: (line, ctx) =>
      parseWithPlaces(line, ctx, (row, parsed) => {
        if (parsed.relPath.startsWith(MEMORY_PREFIX)) {
          return parseMemoryLine(row, parsed, readGrokMemory);
        }
        return parsed.relPath.endsWith(`/${TITLES}`)
          ? parseGrokTitleLine(row, parsed)
          : parseGrokLine(row, parsed);
      }),
    continuation(line, ctx) {
      if (ctx.relPath.startsWith(MEMORY_PREFIX)) return memoryContinuation(line);
      if (!ctx.relPath.endsWith(`/${TITLES}`)) return null;
      const fields = JSON.parse(line) as Record<string, unknown>;
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
      return titleContinuation(fields);
    },
  };
}

/**
 * Grok Build's memory directories, as memory streams (see memory.ts):
 * - `memory-v2/global/` and `memory-v2/workspaces/<name>-<hash>/`: the consolidated topics,
 *   `topics/*.md`, and the observations not consolidated yet, `observations/_inbox/*.md`, which
 *   Grok moves to `archive/` once their content is in a topic (`memory/v2/<dir>.jsonl`);
 * - `memory/MEMORY.md` and `memory/<name>-<hash>/MEMORY.md`, of earlier versions
 *   (`memory/v1/<dir>.jsonl`).
 * Each directory's `MEMORY.md` of version 2 is an index Grok generates, and is not read.
 */
function memoryStreams(home: string): SourceFile[] {
  const out: SourceFile[] = [];
  const add = (stream: SourceFile | null) => {
    if (stream) out.push(stream);
  };
  const v2 = path.join(home, 'memory-v2');
  const v2Dirs: Array<[string, string, string | null]> = [
    ['global', path.join(v2, 'global'), null],
    ...subdirectories(path.join(v2, 'workspaces')).map((name): [string, string, string | null] => [
      `workspaces/${name}`,
      path.join(v2, 'workspaces', name),
      name,
    ]),
  ];
  for (const [key, dir, workspace] of v2Dirs) {
    add(
      memoryStream({
        dir,
        relPath: `${MEMORY_PREFIX}v2/${key}.jsonl`,
        files: () => [
          ...markdownFiles(path.join(dir, 'topics')).map((n) => `topics/${n}`),
          ...markdownFiles(path.join(dir, INBOX)).map((n) => `${INBOX}/${n}`),
        ],
        where: () => (workspace ? workspaceWhere(workspace, workspaceCwd(home, dir)) : NOWHERE),
      }),
    );
  }
  const v1 = path.join(home, 'memory');
  const v1Dirs: Array<[string, string, string | null]> = [
    ['global', v1, null],
    ...subdirectories(v1).map((name): [string, string, string | null] => [
      name,
      path.join(v1, name),
      name,
    ]),
  ];
  for (const [key, dir, workspace] of v1Dirs) {
    add(
      memoryStream({
        dir,
        relPath: `${MEMORY_PREFIX}v1/${key}.jsonl`,
        files: () => (isFile(path.join(dir, 'MEMORY.md')) ? ['MEMORY.md'] : []),
        where: () => (workspace ? workspaceWhere(workspace, indexCwd(dir)) : NOWHERE),
      }),
    );
  }
  return out;
}

const NOWHERE = { project: null, cwd: null };

/** A workspace's project: its working directory's, or its directory's name, `<name>-<hash>`. */
function workspaceWhere(name: string, cwd: string | null) {
  return {
    cwd,
    project: projectFromCwd(cwd ?? undefined) ?? (name.replace(/-[0-9a-f]{8}$/, '') || null),
  };
}

/**
 * A version 2 workspace's working directory: that of the session an observation of it was
 * captured from (its `session_id`), found among the sessions' directories, or null.
 */
function workspaceCwd(home: string, dir: string): string | null {
  const observations = [
    ...markdownFiles(path.join(dir, INBOX)).map((n) => path.join(dir, INBOX, n)),
    ...subdirectories(path.join(dir, 'archive')).flatMap((d) =>
      markdownFiles(path.join(dir, 'archive', d)).map((n) => path.join(dir, 'archive', d, n)),
    ),
  ];
  const sessions = path.join(home, 'sessions');
  const groups = subdirectories(sessions);
  for (const file of observations.slice(0, 5)) {
    let session: unknown;
    try {
      session = frontMatter(fs.readFileSync(file, 'utf8')).data.session_id;
    } catch {
      continue;
    }
    if (typeof session !== 'string' || !/^[\w-]+$/.test(session)) continue;
    const group = groups.find((g) => fs.existsSync(path.join(sessions, g, session)));
    if (group) return grokCwdFromGroup(group);
  }
  return null;
}

/** A version 1 workspace's working directory, from its index's heading, or null. */
function indexCwd(dir: string): string | null {
  try {
    const first = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').split(/\r?\n/, 1)[0] ?? '';
    const cwd = /^#\s+Project Memory\s+[—-]\s+(.+)$/.exec(first)?.[1]?.trim();
    return cwd && /^(?:[A-Za-z]:[\\/]|\/)/.test(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

/** Observations are captured by a model and not consolidated yet: less sure than a topic. */
const OBSERVATION_CONFIDENCE = 0.7;

/** The memory in a version of one of Grok's memory files. */
function readGrokMemory(file: string, content: string): MemoryContent {
  if (file.startsWith(`${INBOX}/`)) return readFrontMatterMemory(content, OBSERVATION_CONFIDENCE);
  return readPlainMemory(content, 'knowledge');
}

/**
 * The title lines that follow `last`, the last one written out: one holding the title fields of
 * `summary.json` if its title, or the kind of session it says it is, is not that of `last`, else
 * none. Grok rewrites the file in place; one that cannot be read now is read again once it changes.
 */
function titleLines(summary: string, last: string | null): string[] {
  let stored: unknown;
  try {
    stored = JSON.parse(fs.readFileSync(summary, 'utf8'));
  } catch {
    return [];
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return [];
  const record = stored as Record<string, unknown>;
  const fields = Object.fromEntries(
    TITLE_FIELDS.filter((k) => Object.hasOwn(record, k)).map((k) => [k, record[k]]),
  );
  const title = displayTitle(fields);
  const kind = sessionKind(fields);
  if (title === null && kind === null) return [];
  if (last !== null) {
    try {
      const before = JSON.parse(last) as Record<string, unknown>;
      // A line a purge replaced holds the digest of the title it removed (see titleContinuation).
      const same =
        typeof before.origin_purged === 'string'
          ? before.title_digest === titleDigest(title)
          : displayTitle(before) === title;
      if (same && sessionKind(before) === kind) return [];
    } catch {
      // an unreadable last line: write the title out again
    }
  }
  return [JSON.stringify(fields)];
}

/**
 * What titleLines reads of a title line, for the line that takes its place when a purge removes it
 * (see SourceAdapter.continuation): the kind of session, and the digest of the title rather than
 * the title, which the purge removed. So the stream writes a title out again only once it changes.
 */
function titleContinuation(fields: Record<string, unknown>): Record<string, unknown> {
  const kind = sessionKind(fields);
  return {
    title_digest: titleDigest(displayTitle(fields)),
    ...(kind ? { session_kind: kind } : {}),
  };
}

/** The first 16 hex digits of the SHA-256 of a title, or null for none. */
function titleDigest(title: string | null): string | null {
  return title === null ? null : createHash('sha256').update(title).digest('hex').slice(0, 16);
}

/** The kind of session a title line says it is (`session_kind`), or null for none. */
function sessionKind(fields: Record<string, unknown>): string | null {
  const v = fields.session_kind;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The title Grok shows for a session: `generated_title`, which holds the generated title or the one
 * given with `/rename` (`title_is_manual`), else `session_summary`; null if both are blank.
 */
function displayTitle(fields: Record<string, unknown>): string | null {
  for (const key of ['generated_title', 'session_summary']) {
    const v = fields[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Pure function: parse one line of a session's title stream. Grok keeps the current title itself,
 * a manual one included, so the latest line's title is the session's. A line whose `session_kind`
 * is a sub-agent's (`subagent`, `subagent_fork`, `subagent_resume`) makes the session a child, and
 * `headless` a headless run. Exported for tests.
 */
export function parseGrokTitleLine(line: string, ctx: ParseContext): ParsedLine | null {
  const where = sessionPath(ctx.relPath, TITLES);
  if (!where) return null;
  const fields = JSON.parse(line) as Record<string, unknown>;
  const title = displayTitle(fields);
  const kind = sessionKind(fields);
  const parsed: ParsedLine = { events: [] };
  if (title !== null) {
    parsed.sessionTitle = title;
    parsed.sessionId = where.sessionId;
  }
  if (kind !== null && (CHILD_KINDS.has(kind) || kind === 'headless')) {
    parsed.sessionKinds = [
      {
        sessionId: where.sessionId,
        kind: kind === 'headless' ? 'headless' : 'child',
        signal: 'session_kind',
      },
    ];
  }
  return parsed.sessionTitle || parsed.sessionKinds ? parsed : null;
}

function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  return stat(p) !== null;
}

/** A file's size and modification time, or null if there is no such file. */
function stat(p: string): fs.Stats | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function readVersion(home: string): string | null {
  try {
    const v = (
      JSON.parse(fs.readFileSync(path.join(home, 'version.json'), 'utf8')) as { version?: unknown }
    ).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Session id and directory group from `sessions/<group>/<session-id>/<name>`. */
function sessionPath(relPath: string, name = UPDATES): { group: string; sessionId: string } | null {
  const parts = relPath.split('/');
  if (parts.length !== 4 || parts[0] !== 'sessions' || parts[3] !== name) return null;
  return parts[1] && parts[2] ? { group: parts[1], sessionId: parts[2] } : null;
}

export function grokSessionIdFromPath(relPath: string): string | null {
  return sessionPath(relPath)?.sessionId ?? null;
}

/**
 * The working directory a session group is named after: Grok URL-encodes it. A group whose encoded
 * name would be too long is named by a slug and a hash instead, with the path in a `.cwd` file that
 * a hub never sees, so its sessions have no cwd.
 */
export function grokCwdFromGroup(group: string): string | null {
  let cwd: string;
  try {
    cwd = decodeURIComponent(group);
  } catch {
    return null;
  }
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(cwd) ? cwd : null;
}

/** Pure function: parse one line of `updates.jsonl`. Exported for tests. */
export function parseGrokLine(line: string, ctx: ParseContext): ParsedLine | null {
  const obj = JSON.parse(line) as GrokLine;
  const u = obj.params?.update;
  const where = sessionPath(ctx.relPath);
  if (!u || !where) return null;

  let role: Role;
  let kind: EventKind;
  let text: string;
  let author: Partial<EventInput> = {};
  const meta: Record<string, unknown> = {};
  switch (u.sessionUpdate) {
    case 'subagent_spawned': {
      // A sub-agent runs as a session of its own, whose prompts this session's agent writes.
      // The notice names its parent; a title line's session_kind does not.
      const child = u.child_session_id;
      if (typeof child !== 'string' || child.length === 0) return null;
      const parent = u.parent_session_id;
      const named =
        typeof parent === 'string' && parent.length > 0 && parent !== child
          ? [
              {
                sessionId: child,
                parentSessionId: parent,
                via: 'subagent' as const,
                signal: 'subagent_spawned',
                fromAgent: true,
              },
            ]
          : undefined;
      return {
        events: [],
        sessionKinds: [{ sessionId: child, kind: 'child', signal: 'subagent_spawned' }],
        ...(named ? { sessionParents: named } : {}),
      };
    }
    case 'user_message_chunk':
      role = 'user';
      text = contentText(u.content);
      // Prompts Grok sends on its own (goal follow-ups, wake-ups) are hidden from the transcript.
      kind = u._meta?.hideFromScrollback ? 'meta' : 'message';
      author = userAuthor(u._meta);
      break;
    case 'agent_message_chunk':
      role = 'assistant';
      kind = 'message';
      text = contentText(u.content);
      break;
    case 'tool_call': {
      role = 'assistant';
      kind = 'tool_use';
      const name = u._meta?.['x.ai/tool']?.name ?? (u.kind === 'search' ? 'web_search' : 'tool');
      text = truncate(`${name} ${inputText(u.rawInput) || (u.title ?? '')}`, TOOL_USE_MAX);
      meta.toolName = name;
      if (u.toolCallId) meta.callId = u.toolCallId;
      break;
    }
    case 'tool_call_update':
      // Updates without an output only refine the call (its kind, title, or locations).
      if (u.rawOutput === undefined) return null;
      role = 'user';
      kind = 'tool_result';
      text = truncate(resultText(u), TOOL_RESULT_MAX);
      if (u.toolCallId) meta.callId = u.toolCallId;
      if (u.status && u.status !== 'completed') meta.status = u.status;
      break;
    default:
      return null; // thoughts, plans, turn and task bookkeeping, goals, sub-agent notices, …
  }
  text = text.trim();
  if (text.length === 0) return null;

  const m = obj.params?._meta;
  const ts =
    typeof m?.agentTimestampMs === 'number'
      ? m.agentTimestampMs
      : typeof obj.timestamp === 'number'
        ? Math.round(obj.timestamp * 1000)
        : Math.round(ctx.fileMtimeMs);
  const cwd = grokCwdFromGroup(where.group);
  const event: EventInput = {
    id: `${where.sessionId}:${localId(m?.eventId, where.sessionId, ctx.lineNo)}`,
    sessionId: where.sessionId,
    ts,
    cwd,
    project: projectFromCwd(cwd ?? undefined),
    role,
    kind,
    text,
    agentVersion: null,
    meta: Object.keys(meta).length > 0 ? meta : null,
    ...author,
  };
  return { events: [event] };
}

/**
 * Who wrote a user message, as Grok marks it, in this order: one it hides from the transcript
 * (`hideFromScrollback`) Grok sent on its own, though it numbers it among the prompts too; one its
 * host started (`hostTurn`) is the system's; a numbered prompt (`promptIndex`) or a message sent
 * while a turn ran (`interjection`) is the user's. A sub-agent's prompts are numbered as well: its
 * session's kind decides those (see parseGrokTitleLine and `subagent_spawned`).
 */
function userAuthor(m: GrokUpdate['_meta']): Partial<EventInput> {
  if (m?.hideFromScrollback) return { author: 'system', authorSignal: 'hideFromScrollback' };
  if (m?.hostTurn) return { author: 'system', authorSignal: 'hostTurn' };
  if (m?.promptIndex !== undefined) return { author: 'owner', authorSignal: 'promptIndex' };
  if (m?.interjection) return { author: 'owner', authorSignal: 'interjection' };
  return {};
}

/**
 * An update's id within its session. Grok numbers most updates `<session-id>-<n>`, which becomes
 * `e<n>`; other ids are kept, and lines without one fall back to their line number.
 */
function localId(eventId: string | undefined, sessionId: string, lineNo: number): string {
  if (typeof eventId !== 'string' || eventId.length === 0) return `L${lineNo}`;
  const n = eventId.startsWith(`${sessionId}-`) ? eventId.slice(sessionId.length + 1) : '';
  return /^\d+$/.test(n) ? `e${n}` : eventId;
}

function contentText(content: Content | Content[] | undefined): string {
  const items = Array.isArray(content) ? content : content ? [content] : [];
  return items
    .map((c) => (typeof c.text === 'string' ? c.text : c.type === 'image' ? '[image]' : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && Object.keys(input).length > 0)
    return JSON.stringify(input);
  return '';
}

/** What the tool returned, as Grok shows it (text, images, diffs), or else its raw output. */
function resultText(u: GrokUpdate): string {
  const items = Array.isArray(u.content) ? u.content : [];
  const parts = items.map((c) => {
    if (c.type === 'content') return c.content ? contentText(c.content) : '';
    if (c.type === 'diff')
      return [c.path, c.newText].filter((s) => typeof s === 'string').join('\n');
    return typeof c.text === 'string' ? c.text : '';
  });
  const shown = parts.filter((s) => s.length > 0).join('\n');
  if (shown.length > 0) return shown;
  return typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput ?? '');
}
