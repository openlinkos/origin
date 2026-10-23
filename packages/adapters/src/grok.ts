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
 */
export const GROK_SOURCE_ID = 'grok';

const UPDATES = 'updates.jsonl';
const SUMMARY = 'summary.json';
/** The name of the generated stream of a session's titles, next to its update stream. */
const TITLES = 'title.jsonl';
/** The fields of `summary.json` a title line holds, as stored. */
const TITLE_FIELDS = [
  'info',
  'generated_title',
  'session_summary',
  'title_is_manual',
  'updated_at',
];
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
  _meta?: { 'x.ai/tool'?: { name?: string }; hideFromScrollback?: boolean };
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
          if (!isFile(abs)) continue; // an internal planning agent's: no conversation
          out.push({ absPath: abs, relPath: `sessions/${group}/${session}/${UPDATES}` });
          const summary = path.join(dir, SUMMARY);
          const st = stat(summary);
          if (st) {
            out.push({
              absPath: summary,
              relPath: `sessions/${group}/${session}/${TITLES}`,
              generated: {
                // summary.json is rewritten every turn; its title changes far less often.
                token: `${st.size}:${st.mtimeMs}`,
                mtimeMs: st.mtimeMs,
                next: (last) => titleLines(summary, last),
              },
            });
          }
        }
      }
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    parseLine: (line, ctx) =>
      ctx.relPath.endsWith(`/${TITLES}`) ? parseGrokTitleLine(line, ctx) : parseGrokLine(line, ctx),
  };
}

/**
 * The title lines that follow `last`, the last one written out: one holding the title fields of
 * `summary.json` if its title is not that of `last`, else none. Grok rewrites the file in place; one
 * that cannot be read now is read again once it changes.
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
  if (title === null) return [];
  if (last !== null) {
    try {
      if (displayTitle(JSON.parse(last) as Record<string, unknown>) === title) return [];
    } catch {
      // an unreadable last line: write the title out again
    }
  }
  return [JSON.stringify(fields)];
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
 * a manual one included, so the latest line's title is the session's. Exported for tests.
 */
export function parseGrokTitleLine(line: string, ctx: ParseContext): ParsedLine | null {
  const where = sessionPath(ctx.relPath, TITLES);
  if (!where) return null;
  const title = displayTitle(JSON.parse(line) as Record<string, unknown>);
  return title === null ? null : { events: [], sessionTitle: title, sessionId: where.sessionId };
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
  const meta: Record<string, unknown> = {};
  switch (u.sessionUpdate) {
    case 'user_message_chunk':
      role = 'user';
      text = contentText(u.content);
      // Prompts Grok sends on its own (goal follow-ups, wake-ups) are hidden from the transcript.
      kind = u._meta?.hideFromScrollback ? 'meta' : 'message';
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
  };
  return { events: [event] };
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
