import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
 * Codex CLI adapter (format notes: docs/sources.md).
 * Sessions: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, archived ones in
 * `<CODEX_HOME>/archived_sessions/`; cold rollouts may be zstd-compressed (`.jsonl.zst`).
 * Line format: `{ timestamp, ordinal, type, payload }`. Only `session_meta` (cwd, version) and
 * `response_item` lines carry information; `event_msg` lines repeat response items for the UI.
 */
export const CODEX_SOURCE_ID = 'codex';

const ROLLOUT_RE =
  /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;
const TOOL_USE_MAX = 2000;
const TOOL_RESULT_MAX = 4000;
const HEAD_MAX = 8 * 1024 * 1024;

export function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.length > 0 ? env : path.join(os.homedir(), '.codex');
}

export interface CodexAdapterOptions {
  /** Override CODEX_HOME (tests). */
  home?: string;
}

/** Per-rollout facts from its first line (`session_meta`). */
export interface CodexSessionInfo {
  cwd: string | null;
  version: string | null;
}

interface ContentItem {
  type?: string;
  text?: string;
}

interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    role?: string;
    content?: ContentItem[];
    phase?: string;
    name?: string;
    arguments?: string;
    input?: string;
    call_id?: string;
    output?: unknown;
    action?: { command?: string[]; query?: string };
    cwd?: string;
    cli_version?: string;
  };
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): SourceAdapter {
  const home = opts.home ?? codexHome();
  const sessions = new Map<string, CodexSessionInfo>();
  let lastVersion: string | null = null;
  const sessionInfo = (absPath: string): CodexSessionInfo => {
    let info = sessions.get(absPath);
    if (!info) {
      info = readSessionInfo(absPath);
      sessions.set(absPath, info);
    }
    return info;
  };
  return {
    id: CODEX_SOURCE_ID,
    displayName: 'Codex CLI',
    version: () => lastVersion,
    async discover(): Promise<SourceFile[]> {
      const out: SourceFile[] = [];
      for (const dir of ['sessions', 'archived_sessions']) walk(home, path.join(home, dir), out);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    parseLine(line: string, ctx: ParseContext): ParsedLine | null {
      const obj = JSON.parse(line) as CodexLine;
      if (obj.type === 'session_meta') {
        const info = sessionInfoFrom(obj);
        sessions.set(ctx.absPath, info);
        if (info.version) lastVersion = info.version;
        return null;
      }
      return parseRecord(obj, ctx, () => sessionInfo(ctx.absPath));
    },
  };
}

function walk(root: string, dir: string, out: SourceFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(root, abs, out);
    else if (ent.isFile() && ROLLOUT_RE.test(ent.name)) {
      out.push({
        absPath: abs,
        relPath: path.relative(root, abs).split(path.sep).join('/'),
        compression: ent.name.endsWith('.zst') ? 'zstd' : undefined,
      });
    }
  }
}

/** Session id from a rollout file name: `rollout-<time>-<uuid>.jsonl[.zst]` → uuid. */
export function codexSessionIdFromPath(relPath: string): string | null {
  const m = ROLLOUT_RE.exec(path.posix.basename(relPath));
  return m?.[1] ? m[1].toLowerCase() : null;
}

function sessionInfoFrom(obj: CodexLine): CodexSessionInfo {
  return { cwd: obj.payload?.cwd ?? null, version: obj.payload?.cli_version ?? null };
}

/** Read the `session_meta` line of a rollout, for lines ingested in a later sync. */
function readSessionInfo(absPath: string): CodexSessionInfo {
  try {
    const head = readHead(absPath);
    const nl = head.indexOf(0x0a);
    const first = JSON.parse(head.subarray(0, nl < 0 ? head.length : nl).toString('utf8'));
    return first?.type === 'session_meta' ? sessionInfoFrom(first) : { cwd: null, version: null };
  } catch {
    return { cwd: null, version: null };
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * The beginning of a rollout, up to its first newline. Compression is detected by magic bytes, not
 * by the `.zst` name: on a hub, the mirror of a `.jsonl.zst` rollout is plain JSONL with that name.
 */
function readHead(absPath: string): Buffer {
  const fd = fs.openSync(absPath, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < HEAD_MAX) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      const piece = Buffer.from(buf.subarray(0, n));
      if (total === 0 && piece.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
        return zlib.zstdDecompressSync(fs.readFileSync(absPath));
      }
      chunks.push(piece);
      total += n;
      if (piece.includes(0x0a)) break;
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

/** Pure function: parse one rollout line, given its session's info. Exported for tests. */
export function parseCodexLine(
  line: string,
  ctx: ParseContext,
  session: CodexSessionInfo,
): ParsedLine | null {
  const obj = JSON.parse(line) as CodexLine;
  if (obj.type === 'session_meta') return null;
  return parseRecord(obj, ctx, () => session);
}

/** Text wrapped entirely in one tag, e.g. `<environment_context>…</environment_context>`, is injected by Codex. */
const INJECTED_RE = /^\s*<([a-z_]+)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/i;

function parseRecord(
  obj: CodexLine,
  ctx: ParseContext,
  session: () => CodexSessionInfo,
): ParsedLine | null {
  const p = obj.payload;
  if (obj.type !== 'response_item' || !p) return null;
  const sessionId = codexSessionIdFromPath(ctx.relPath);
  if (!sessionId) return null;

  let role: Role;
  let kind: EventKind;
  let text: string;
  const meta: Record<string, unknown> = {};
  switch (p.type) {
    case 'message': {
      if (p.role !== 'user' && p.role !== 'assistant') return null; // developer / system instructions
      role = p.role;
      text = joinContent(p.content);
      kind = role === 'user' && INJECTED_RE.test(text) ? 'meta' : 'message';
      if (p.phase) meta.phase = p.phase;
      break;
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'web_search_call': {
      role = 'assistant';
      kind = 'tool_use';
      const name =
        p.type === 'local_shell_call'
          ? 'shell'
          : p.type === 'web_search_call'
            ? 'web_search'
            : (p.name ?? 'tool');
      const input =
        p.type === 'local_shell_call'
          ? (p.action?.command ?? []).join(' ')
          : p.type === 'web_search_call'
            ? (p.action?.query ?? '')
            : (p.arguments ?? p.input ?? '');
      text = truncate(`${name} ${input}`, TOOL_USE_MAX);
      meta.toolName = name;
      if (p.call_id) meta.callId = p.call_id;
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      role = 'user';
      kind = 'tool_result';
      text = truncate(outputText(p.output), TOOL_RESULT_MAX);
      if (p.call_id) meta.callId = p.call_id;
      break;
    }
    default:
      return null; // reasoning, compaction, tool search, image generation, …
  }
  text = text.trim();
  if (text.length === 0) return null;

  const info = session();
  const ts = Date.parse(obj.timestamp ?? '');
  // `ordinal` is unique per rollout line; older rollouts fall back to the item id or line number.
  const localId = obj.ordinal !== undefined ? `o${obj.ordinal}` : p.id ? p.id : `L${ctx.lineNo}`;
  const event: EventInput = {
    id: `${sessionId}:${localId}`,
    sessionId,
    ts: Number.isFinite(ts) ? ts : Math.round(ctx.fileMtimeMs),
    cwd: info.cwd,
    project: projectFromCwd(info.cwd ?? undefined),
    role,
    kind,
    text,
    agentVersion: info.version,
    meta: Object.keys(meta).length > 0 ? meta : null,
  };
  return { events: [event] };
}

function joinContent(content: ContentItem[] | undefined): string {
  return (content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : c.type === 'input_image' ? '[image]' : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

/** Tool output is a plain string or a list of content items (older versions: `{ content }`). */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return joinContent(output as ContentItem[]);
  if (output && typeof output === 'object' && 'content' in output) {
    return outputText((output as { content: unknown }).content);
  }
  return '';
}
