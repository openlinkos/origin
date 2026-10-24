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
import {
  markdownFiles,
  memoryStream,
  parseMemoryLine,
  readFrontMatterMemory,
  subdirectories,
} from './memory.js';
import { projectFromCwd, truncate } from './util.js';

/**
 * ZCode adapter (format notes: docs/sources.md).
 * Sessions live in one SQLite database, `~/.zcode/cli/db/db.sqlite`: tables `session`, `message`
 * (ordered by `sequence` within a session), and `part` (ordered by `sequence` within a message),
 * with JSON in their `data` columns. Rows change in place while a reply streams, and again long
 * after (compaction marks old tool output), so each session is a generated source: every message
 * is written out once, when it has settled, as one line holding its row, its parts' rows, and some
 * of its session's columns, all as stored.
 *
 * ZCode's memories, one Markdown file each with a `MEMORY.md` index, are in
 * `~/.zcode/cli/memories/projects/<name>/memory/`: each directory is written out as a memory
 * stream, `memory/<name>.jsonl` (see memory.ts).
 */
export const ZCODE_SOURCE_ID = 'zcode';

const MEMORY_PREFIX = 'memory/';

const TOOL_USE_MAX = 2000;
const TOOL_RESULT_MAX = 4000;
/** A message still unfinished this long after its last change will not change any more. */
export const ZCODE_SETTLE_MS = 60 * 60 * 1000;
/** How long the database stays open after its last use, so that a sync opens it once. */
const KEEP_OPEN_MS = 2000;

export function zcodeHome(): string {
  return path.join(os.homedir(), '.zcode');
}

export interface ZCodeAdapterOptions {
  /** Override the ZCode home directory (tests). */
  home?: string;
  /** The current time (tests). */
  now?: () => number;
  /** How long the database stays open after its last use, in ms (tests: 0, closed at once). */
  keepOpenMs?: number;
}

type Row = Record<string, unknown> & { data: string };

/** One line of a session's generated content. */
interface ZCodeLine {
  session: {
    id: string;
    parent_id?: string | null;
    directory?: string | null;
    title?: string | null;
    version?: string | null;
    task_type?: string | null;
  };
  message: Row & { id: string; sequence: number; time_created: number; time_updated: number };
  parts: Array<Row & { sequence: number; time_created?: number }>;
}

interface MessageData {
  role?: string;
  error?: unknown;
  time?: { created?: number; completed?: number };
  path?: { cwd?: string };
  semantics?: { transcriptVisibility?: string };
}

interface PartData {
  type?: string;
  text?: string;
  synthetic?: boolean;
  mime?: string;
  filename?: string;
  tool?: string;
  callID?: string;
  time?: { start?: number; end?: number };
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: number; end?: number };
  };
}

interface SessionState {
  id: string;
  messages: number;
  maxSequence: number;
  lastUpdated: number;
}

export function createZCodeAdapter(opts: ZCodeAdapterOptions = {}): SourceAdapter {
  const home = opts.home ?? zcodeHome();
  const dbPath = path.join(home, 'cli', 'db', 'db.sqlite');
  const now = opts.now ?? Date.now;
  const keepOpenMs = opts.keepOpenMs ?? KEEP_OPEN_MS;
  let lastVersion: string | null = null;

  // One read-only connection, closed shortly after its last use: a sync asks about every session
  // in turn, and an open handle should not linger between syncs.
  let db: DatabaseSync | null = null;
  let closeTimer: NodeJS.Timeout | null = null;
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
    if (!db) db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
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

  const next = (sessionId: string, last: string | null, maxBytes: number): string[] =>
    withDb((db) => {
      const after = last === null ? -1 : (JSON.parse(last) as ZCodeLine).message.sequence;
      const session = db
        .prepare(
          'SELECT id, parent_id, directory, title, version, task_type FROM session WHERE id = ?',
        )
        .get(sessionId) as ZCodeLine['session'] | undefined;
      if (!session) return [];
      const messages = db
        .prepare('SELECT * FROM message WHERE session_id = ? AND sequence > ? ORDER BY sequence')
        .all(sessionId, after) as unknown as ZCodeLine['message'][];
      const parts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY sequence');
      const out: string[] = [];
      let bytes = 0;
      for (const [i, message] of messages.entries()) {
        const rows = parts.all(message.id) as unknown as ZCodeLine['parts'];
        if (!settled(message, rows, i < messages.length - 1, now())) break;
        const line = JSON.stringify({ session, message, parts: rows } satisfies ZCodeLine);
        if (out.length > 0 && bytes + line.length > maxBytes) break;
        out.push(line);
        bytes += line.length + 1;
      }
      return out;
    });

  return {
    id: ZCODE_SOURCE_ID,
    displayName: 'ZCode',
    version: () => lastVersion,
    async discover(): Promise<SourceFile[]> {
      const out: SourceFile[] = memoryStreams();
      const sorted = () => out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      if (!fs.existsSync(dbPath)) return sorted();
      let sessions: SessionState[];
      try {
        sessions = withDb((db) => {
          const latest = db
            .prepare('SELECT version FROM session ORDER BY time_updated DESC LIMIT 1')
            .get() as { version?: string } | undefined;
          lastVersion = latest?.version || null;
          return db
            .prepare(
              `SELECT session_id AS id, COUNT(*) AS messages, MAX(sequence) AS maxSequence,
                      MAX(time_updated) AS lastUpdated
                 FROM message GROUP BY session_id`,
            )
            .all() as unknown as SessionState[];
        });
      } catch {
        return sorted(); // not a ZCode database this adapter knows
      }
      const t = now();
      for (const s of sessions) {
        out.push({
          absPath: `${dbPath}#${s.id}`,
          relPath: `sessions/${s.id}.jsonl`,
          generated: {
            // New messages, a message that changed, or one that has now settled by waiting.
            token: `${s.messages}:${s.maxSequence}:${s.lastUpdated}:${t - s.lastUpdated > ZCODE_SETTLE_MS ? 'idle' : 'active'}`,
            mtimeMs: s.lastUpdated,
            next: (last: string | null, maxBytes: number) => next(s.id, last, maxBytes),
          },
        });
      }
      return sorted();
    },
    parseLine: (line, ctx) =>
      ctx.relPath.startsWith(MEMORY_PREFIX)
        ? parseMemoryLine(line, ctx, (_file, content) => readFrontMatterMemory(content))
        : parseZCodeLine(line, ctx),
  };

  /** The memory directory of each project, `memories/projects/<name>/memory/`, as a stream. */
  function memoryStreams(): SourceFile[] {
    const projects = path.join(home, 'cli', 'memories', 'projects');
    const out: SourceFile[] = [];
    for (const name of subdirectories(projects)) {
      const dir = path.join(projects, name, 'memory');
      const stream = memoryStream({
        dir,
        relPath: `${MEMORY_PREFIX}${name}.jsonl`,
        files: () => markdownFiles(dir, ['MEMORY.md']),
        where: () => {
          const cwd = memoryCwd(name);
          return { cwd, project: projectFromCwd(cwd ?? undefined) ?? memoryProject(name) };
        },
      });
      if (stream) out.push(stream);
    }
    return out;
  }

  /**
   * The working directory a project's memory directory is named after: `<name>-<hash>`, where the
   * hash is the first 16 hex digits of the SHA-256 of the lowercased directory. Found among the
   * sessions' directories, or null.
   */
  function memoryCwd(name: string): string | null {
    const hash = /-([0-9a-f]{16})$/.exec(name)?.[1];
    if (!hash || !fs.existsSync(dbPath)) return null;
    try {
      const dirs = withDb(
        (db) =>
          db
            .prepare('SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL')
            .all() as unknown as Array<{ directory: string }>,
      );
      const match = dirs.find(
        (d) =>
          createHash('sha256').update(d.directory.toLowerCase()).digest('hex').slice(0, 16) ===
          hash,
      );
      return match?.directory ?? null;
    } catch {
      return null;
    }
  }
}

/** A project's name from its memory directory's, `<name>-<hash>`, when its directory is unknown. */
function memoryProject(name: string): string | null {
  return name.replace(/-[0-9a-f]{16}$/, '') || null;
}

/**
 * Whether a message will not change any more, so that it can be written out: a user message once
 * its parts are there, a reply once it has completed or failed, and any message once the session
 * has moved past it or it has not changed for an hour.
 */
function settled(
  message: ZCodeLine['message'],
  parts: ZCodeLine['parts'],
  hasLater: boolean,
  now: number,
): boolean {
  if (now - message.time_updated > ZCODE_SETTLE_MS) return true;
  const data = JSON.parse(message.data) as MessageData;
  if (data.role === 'assistant') return Boolean(data.time?.completed || data.error);
  return parts.length > 0 || hasLater;
}

/** Pure function: parse one generated line (a message with its parts). Exported for tests. */
export function parseZCodeLine(line: string, _ctx?: ParseContext): ParsedLine | null {
  const { session, message, parts } = JSON.parse(line) as ZCodeLine;
  const data = JSON.parse(message.data) as MessageData;
  const sessionId = session.id;
  const role: Role = data.role === 'assistant' ? 'assistant' : 'user';
  // Reminders, notifications, and summaries ZCode adds for the model are hidden from the transcript.
  const hidden = data.semantics?.transcriptVisibility === 'hidden';
  const cwd = data.path?.cwd ?? session.directory ?? null;
  const base = {
    sessionId,
    cwd,
    project: projectFromCwd(cwd ?? undefined),
    agentVersion: session.version ?? null,
  };
  const fallbackTs = message.time_created;

  const events: EventInput[] = [];
  const push = (
    id: string,
    ts: number | undefined,
    r: Role,
    kind: EventKind,
    text: string,
    meta: Record<string, unknown> | null = null,
  ) => {
    const t = text.trim();
    if (t.length === 0) return;
    events.push({
      ...base,
      id,
      ts: typeof ts === 'number' ? ts : fallbackTs,
      role: r,
      kind,
      text: t,
      meta,
    });
  };
  for (const part of parts) {
    const p = JSON.parse(part.data) as PartData;
    const id = `${sessionId}:${message.sequence}.${part.sequence}`;
    const ts = p.time?.start ?? p.state?.time?.start ?? part.time_created;
    switch (p.type) {
      case 'text':
        push(id, ts, role, hidden || p.synthetic ? 'meta' : 'message', p.text ?? '');
        break;
      case 'file':
        push(
          id,
          ts,
          role,
          'message',
          `[${p.mime?.startsWith('image/') ? 'image' : 'file'}${p.filename ? ` ${p.filename}` : ''}]`,
        );
        break;
      case 'tool': {
        const name = p.tool ?? 'tool';
        const meta: Record<string, unknown> = { toolName: name };
        if (p.callID) meta.callId = p.callID;
        push(
          id,
          ts,
          'assistant',
          'tool_use',
          truncate(`${name} ${inputText(p.state?.input)}`, TOOL_USE_MAX),
          meta,
        );
        const out = p.state?.status === 'error' ? p.state.error : p.state?.output;
        const result: Record<string, unknown> = p.callID ? { callId: p.callID } : {};
        if (p.state?.status && p.state.status !== 'completed') result.status = p.state.status;
        push(
          `${id}#1`,
          p.state?.time?.end ?? ts,
          'user',
          'tool_result',
          truncate(outputText(out), TOOL_RESULT_MAX),
          Object.keys(result).length > 0 ? result : null,
        );
        break;
      }
      default:
        break; // reasoning, step markers, timeline notices, compaction, …
    }
  }
  const title =
    typeof session.title === 'string' && session.title.length > 0 ? session.title : undefined;
  return { events, sessionTitle: title, sessionId };
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && Object.keys(input).length > 0)
    return JSON.stringify(input);
  return '';
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}
