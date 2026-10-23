import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
 * Cursor adapter (format notes: docs/sources.md). Two kinds of sessions:
 * - CLI transcripts, `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`: one
 *   `{ role, message: { content } }` object per line, without ids or timestamps except the
 *   `<timestamp>` a user message embeds.
 * - Editor conversations, in the key-value table `cursorDiskKV` of the editor's global
 *   `state.vscdb` (SQLite): `composerData:<conversation>` and one `bubbleId:<conversation>:<bubble>`
 *   per message, rewritten in place. Each conversation is a generated source: every message it
 *   shows is written out once it has settled, in creation order, as one line holding its key and
 *   value as stored and some of its conversation's fields. Nothing else in the database is read.
 */
export const CURSOR_SOURCE_ID = 'cursor';

const TOOL_USE_MAX = 2000;
const TOOL_RESULT_MAX = 4000;
/** A message still being generated this long after its conversation last changed will not change. */
export const CURSOR_SETTLE_MS = 60 * 60 * 1000;
const KEEP_OPEN_MS = 2000;

export function cursorHome(): string {
  return path.join(os.homedir(), '.cursor');
}

/** The editor's `User` directory, where `globalStorage/state.vscdb` lives. */
export function cursorUserDir(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'Cursor',
      'User',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'Cursor',
    'User',
  );
}

export interface CursorAdapterOptions {
  /** Override `~/.cursor` (tests). */
  home?: string;
  /** Override the editor's `User` directory (tests). */
  userDir?: string;
  /** The current time (tests). */
  now?: () => number;
  /** How long the editor database stays open after its last use, in ms (tests: 0). */
  keepOpenMs?: number;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** The user timestamp in force after a transcript's line `through`, as parsed in this process. */
interface UserTime {
  through: number;
  ts: number | null;
}

interface TranscriptLine {
  role?: string;
  type?: string;
  message?: { content?: Block[] | string };
}

/** The fields of a conversation that each written-out message carries. */
interface Conversation {
  composerId: string;
  name?: string | null;
  createdAt?: number | null;
  lastUpdatedAt?: number | null;
  workspaceIdentifier?: { id?: string; uri?: { fsPath?: string } } | null;
}

interface EditorLine {
  conversation: Conversation;
  key: string;
  value: string;
}

interface Bubble {
  bubbleId?: string;
  type?: number;
  text?: string;
  createdAt?: string;
  startedAtMs?: number;
  toolFormerData?: {
    name?: string;
    params?: unknown;
    rawArgs?: unknown;
    result?: unknown;
    status?: string;
    error?: unknown;
    toolCallId?: string;
  };
}

export function createCursorAdapter(opts: CursorAdapterOptions = {}): SourceAdapter {
  const home = opts.home ?? cursorHome();
  const vscdb = path.join(opts.userDir ?? cursorUserDir(), 'globalStorage', 'state.vscdb');
  const now = opts.now ?? Date.now;
  const keepOpenMs = opts.keepOpenMs ?? KEEP_OPEN_MS;
  // For each transcript, the last line parsed and the user timestamp in force after it.
  const userTimes = new Map<string, UserTime>();

  let db: DatabaseSync | null = null;
  let closeTimer: NodeJS.Timeout | null = null;
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
    if (!db) db = new DatabaseSync(vscdb, { readOnly: true, timeout: 5000 });
    if (closeTimer) clearTimeout(closeTimer);
    const close = () => {
      db?.close();
      db = null;
    };
    try {
      return fn(db);
    } finally {
      if (keepOpenMs <= 0) close();
      else {
        closeTimer = setTimeout(close, keepOpenMs);
        closeTimer.unref();
      }
    }
  };

  const conversations = (): Conversation[] =>
    withDb((db) =>
      (
        db
          .prepare(
            "SELECT value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'",
          )
          .all() as Array<{ value: unknown }>
      )
        .map((r) => JSON.parse(text(r.value)) as Conversation & Record<string, unknown>)
        .filter((c) => typeof c.composerId === 'string'),
    );

  const bubbles = (
    db: DatabaseSync,
    id: string,
  ): Array<{ key: string; value: string; bubble: Bubble }> =>
    (
      db
        .prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?')
        .all(`bubbleId:${id}:`, `bubbleId:${id};`) as Array<{ key: string; value: unknown }>
    )
      .filter((r) => r.value !== null)
      .map((r) => {
        const value = text(r.value);
        return { key: r.key, value, bubble: JSON.parse(value) as Bubble };
      })
      .sort((a, b) => compareBubbles(a.bubble, b.bubble));

  const next = (id: string, last: string | null, maxBytes: number): string[] =>
    withDb((db) => {
      const row = db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${id}`) as { value: unknown } | undefined;
      if (!row) return [];
      const full = JSON.parse(text(row.value)) as Conversation & {
        status?: string;
        generatingBubbleIds?: string[];
        fullConversationHeadersOnly?: Array<{ bubbleId?: string }>;
      };
      const conversation: Conversation = {
        composerId: id,
        name: full.name ?? null,
        createdAt: full.createdAt ?? null,
        lastUpdatedAt: full.lastUpdatedAt ?? null,
        workspaceIdentifier: full.workspaceIdentifier ?? null,
      };
      const after = last === null ? null : (JSON.parse(JSON.parse(last).value) as Bubble);
      const quiet = now() - (full.lastUpdatedAt ?? full.createdAt ?? 0) > CURSOR_SETTLE_MS;
      const generating = new Set(full.generatingBubbleIds ?? []);
      // The conversation as Cursor shows it: the messages in its header list. Others are mostly
      // copies of those, kept by the editor.
      const shown = new Set((full.fullConversationHeadersOnly ?? []).map((h) => h.bubbleId));
      const all = bubbles(db, id).filter((b) => shown.size === 0 || shown.has(b.bubble.bubbleId));
      const out: string[] = [];
      let bytes = 0;
      for (const [i, b] of all.entries()) {
        if (after && compareBubbles(b.bubble, after) <= 0) continue;
        const inProgress =
          generating.has(b.bubble.bubbleId ?? '') ||
          (full.status === 'generating' && i === all.length - 1);
        if (inProgress && !quiet) break;
        const line = JSON.stringify({
          conversation,
          key: b.key,
          value: b.value,
        } satisfies EditorLine);
        if (out.length > 0 && bytes + line.length > maxBytes) break;
        out.push(line);
        bytes += line.length + 1;
      }
      return out;
    });

  return {
    id: CURSOR_SOURCE_ID,
    displayName: 'Cursor',
    version: () => editorVersion(),
    async discover(): Promise<SourceFile[]> {
      const transcripts: SourceFile[] = [];
      walkTranscripts(home, path.join(home, 'projects'), transcripts);
      const out: SourceFile[] = [];
      if (fs.existsSync(vscdb)) {
        try {
          const t = now();
          for (const c of conversations()) {
            const count = withDb(
              (db) =>
                (
                  db
                    .prepare('SELECT COUNT(*) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?')
                    .get(`bubbleId:${c.composerId}:`, `bubbleId:${c.composerId};`) as { n: number }
                ).n,
            );
            if (count === 0) continue;
            const changed = c.lastUpdatedAt ?? c.createdAt ?? 0;
            const quiet = t - changed > CURSOR_SETTLE_MS ? 'quiet' : 'active';
            out.push({
              absPath: `${vscdb}#${c.composerId}`,
              relPath: `editor/${c.composerId}.jsonl`,
              generated: {
                token: `${count}:${changed}:${quiet}`,
                mtimeMs: changed,
                next: (last, maxBytes) => next(c.composerId, last, maxBytes),
              },
            });
          }
        } catch {
          // not an editor database this adapter knows
        }
      }
      // The editor's agent writes a transcript of its conversations too; the editor's own record,
      // with tool results and exact times, is the one kept.
      const inEditor = new Set(out.map((f) => path.posix.basename(f.relPath, '.jsonl')));
      for (const t of transcripts) {
        if (!inEditor.has(cursorSessionIdFromPath(t.relPath) ?? '')) out.push(t);
      }
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    parseLine(line: string, ctx: ParseContext): ParsedLine | null {
      if (ctx.relPath.startsWith('editor/')) return parseCursorEditorLine(line);
      return parseTranscript(line, ctx, userTimes);
    },
  };
}

function walkTranscripts(root: string, dir: string, out: SourceFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (ent.isDirectory()) {
      // Only a project's transcripts: projects/<slug>/agent-transcripts/...
      const parts = rel.split('/');
      if (parts.length < 3 || parts[2] === 'agent-transcripts') walkTranscripts(root, abs, out);
    } else if (
      ent.isFile() &&
      ent.name.endsWith('.jsonl') &&
      rel.split('/')[2] === 'agent-transcripts'
    ) {
      out.push({ absPath: abs, relPath: rel });
    }
  }
}

/** Values are stored as text or as blobs of UTF-8. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString('utf8');
}

function compareBubbles(a: Bubble, b: Bubble): number {
  const ta = a.createdAt ?? '';
  const tb = b.createdAt ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = a.bubbleId ?? '';
  const ib = b.bubbleId ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function editorVersion(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.LOCALAPPDATA ?? '',
            'Programs',
            'cursor',
            'resources',
            'app',
            'package.json',
          ),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Cursor.app/Contents/Resources/app/package.json']
        : [
            '/usr/share/cursor/resources/app/package.json',
            '/opt/Cursor/resources/app/package.json',
          ];
  for (const file of candidates) {
    try {
      const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch {
      // not installed there
    }
  }
  return null;
}

/** Pure function: parse one written-out editor message. Exported for tests. */
export function parseCursorEditorLine(line: string): ParsedLine | null {
  const { conversation, value } = JSON.parse(line) as EditorLine;
  const b = JSON.parse(value) as Bubble;
  const sessionId = conversation.composerId;
  const cwd = conversation.workspaceIdentifier?.uri?.fsPath ?? null;
  const created = Date.parse(b.createdAt ?? '');
  const ts = Number.isFinite(created) ? created : (b.startedAtMs ?? conversation.createdAt ?? 0);
  const base = {
    sessionId,
    ts,
    cwd,
    project: projectFromCwd(cwd ?? undefined),
    agentVersion: null,
  };
  const role: Role = b.type === 1 ? 'user' : 'assistant';
  const id = `${sessionId}:${b.bubbleId ?? 'unknown'}`;
  const events: EventInput[] = [];
  const push = (
    eid: string,
    r: Role,
    kind: EventKind,
    t: string,
    meta: Record<string, unknown> | null,
  ) => {
    const trimmed = t.trim();
    if (trimmed.length > 0) events.push({ ...base, id: eid, role: r, kind, text: trimmed, meta });
  };
  push(id, role, 'message', b.text ?? '', null);
  const tool = b.toolFormerData;
  if (tool?.name) {
    const meta: Record<string, unknown> = { toolName: tool.name };
    if (tool.toolCallId) meta.callId = tool.toolCallId;
    push(
      `${id}#1`,
      'assistant',
      'tool_use',
      truncate(`${tool.name} ${valueText(tool.params ?? tool.rawArgs)}`, TOOL_USE_MAX),
      meta,
    );
    const result: Record<string, unknown> = tool.toolCallId ? { callId: tool.toolCallId } : {};
    if (tool.status && tool.status !== 'completed') result.status = tool.status;
    push(
      `${id}#2`,
      'user',
      'tool_result',
      truncate(valueText(tool.error ?? tool.result), TOOL_RESULT_MAX),
      Object.keys(result).length > 0 ? result : null,
    );
  }
  const title =
    typeof conversation.name === 'string' && conversation.name.length > 0
      ? conversation.name
      : undefined;
  return { events, sessionTitle: title, sessionId };
}

/** Session id from a transcript path: `.../agent-transcripts/<uuid>/<uuid>.jsonl` → uuid. */
export function cursorSessionIdFromPath(relPath: string): string | null {
  const base = path.posix.basename(relPath);
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : null;
}

const TIMESTAMP_RE =
  /<timestamp>\s*\w+,\s*(\w{3})\w*\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)\s*<\/timestamp>/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The time a user message embeds, e.g. `<timestamp>Saturday, Sep 20, 2026, 10:12 AM (UTC+8)</timestamp>`. */
export function cursorTimestamp(text: string): number | null {
  const m = TIMESTAMP_RE.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf((m[1] ?? '').toLowerCase());
  if (month < 0) return null;
  let hour = Number(m[4]) % 12;
  if ((m[6] ?? '').toUpperCase() === 'PM') hour += 12;
  const offsetHours = Number(m[7]);
  const offsetMinutes = Math.sign(offsetHours || 1) * Number(m[8] ?? 0);
  const utc = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]));
  return utc - (offsetHours * 60 + offsetMinutes) * 60_000;
}

function parseTranscript(
  line: string,
  ctx: ParseContext,
  userTimes: Map<string, UserTime>,
): ParsedLine | null {
  const inForce = timeBefore(ctx, userTimes);
  const obj = JSON.parse(line) as TranscriptLine;
  userTimes.set(ctx.absPath, { through: ctx.lineNo, ts: inForce });
  if (obj.role !== 'user' && obj.role !== 'assistant') return null; // turn_ended and others
  const sessionId = cursorSessionIdFromPath(ctx.relPath);
  if (!sessionId) return null;
  const blocks = Array.isArray(obj.message?.content)
    ? obj.message.content
    : [{ type: 'text', text: obj.message?.content ?? '' }];
  const joined = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');

  let ts: number;
  if (obj.role === 'user') {
    const own = cursorTimestamp(joined);
    if (own !== null) userTimes.set(ctx.absPath, { through: ctx.lineNo, ts: own });
    ts = own ?? inForce ?? Math.round(ctx.fileMtimeMs);
  } else {
    ts = inForce ?? Math.round(ctx.fileMtimeMs);
  }
  // Lines carry no ids; the line number and a digest of the line keep ids stable across syncs and
  // distinct if the transcript is rewritten.
  const id = `${sessionId}:L${ctx.lineNo}-${createHash('sha256').update(line).digest('hex').slice(0, 8)}`;
  const slug = ctx.relPath.split('/')[1] ?? null;
  const base = { sessionId, ts, cwd: null, project: slug, agentVersion: null };
  const events: EventInput[] = [];
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(joined)?.[1];
  const message = (obj.role === 'user' && query !== undefined ? query : joined).trim();
  if (message.length > 0) {
    events.push({ ...base, id, role: obj.role, kind: 'message', text: message, meta: null });
  }
  for (const [i, b] of blocks.entries()) {
    if (b.type !== 'tool_use') continue;
    const name = b.name ?? 'tool';
    events.push({
      ...base,
      id: `${id}#${i}`,
      role: 'assistant',
      kind: 'tool_use',
      text: truncate(`${name} ${valueText(b.input)}`, TOOL_USE_MAX),
      meta: { toolName: name },
    });
  }
  return { events };
}

/**
 * The timestamp of the nearest user message before this line: known if this process parsed the
 * line just before, else found by reading back through the lines ingested before (another process
 * may have ingested some of them).
 */
function timeBefore(ctx: ParseContext, userTimes: Map<string, UserTime>): number | null {
  const seen = userTimes.get(ctx.absPath);
  if (seen && seen.through === ctx.lineNo - 1) return seen.ts;
  for (let n = ctx.lineNo - 1; n >= 1; n--) {
    const earlier = ctx.readLine?.(n);
    if (typeof earlier !== 'string') break;
    try {
      const o = JSON.parse(earlier) as TranscriptLine;
      if (o.role !== 'user') continue;
      const content = o.message?.content;
      const t = cursorTimestamp(
        Array.isArray(content) ? content.map((b) => b.text ?? '').join('\n') : (content ?? ''),
      );
      if (t !== null) return t;
    } catch {
      // an unreadable line: keep looking
    }
  }
  return null;
}

function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && Object.keys(v).length === 0) return '';
  return JSON.stringify(v);
}
