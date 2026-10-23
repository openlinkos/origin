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
 * `tool_call_update` line with `rawOutput`. The other files of a session (`chat_history.jsonl`, which
 * repeats the conversation without timestamps, `summary.json`, …) are not read.
 */
export const GROK_SOURCE_ID = 'grok';

const UPDATES = 'updates.jsonl';
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
          const abs = path.join(sessions, group, session, UPDATES);
          if (isFile(abs))
            out.push({ absPath: abs, relPath: `sessions/${group}/${session}/${UPDATES}` });
        }
      }
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    parseLine: (line, ctx) => parseGrokLine(line, ctx),
  };
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
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
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

/** Session id and directory group from `sessions/<group>/<session-id>/updates.jsonl`. */
function sessionPath(relPath: string): { group: string; sessionId: string } | null {
  const parts = relPath.split('/');
  if (parts.length !== 4 || parts[0] !== 'sessions' || parts[3] !== UPDATES) return null;
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
