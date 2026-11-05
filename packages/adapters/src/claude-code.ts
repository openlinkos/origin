import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EventInput,
  EventKind,
  ParseContext,
  ParsedLine,
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
import { parseWithPlaces } from './places.js';
import { projectFromCwd, relativeUnder, truncate } from './util.js';

/**
 * Claude Code adapter (format notes: docs/sources.md).
 * Sessions: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; subagents in `<sessionId>/subagents/agent-*.jsonl`.
 * Line format: one JSON event per line, `type` ∈ user / assistant / ai-title / custom-title /
 * agent-name / summary / mode / permission-mode / file-history-snapshot / system / …; the messages
 * (user, assistant) and the session's titles (ai-title, custom-title, and summary in older logs)
 * carry information.
 *
 * Each project's memory directory, `<cwd-slug>/memory/`, holds Claude Code's own memories, one
 * Markdown file each with a `MEMORY.md` index: it is written out as a memory stream,
 * `memory/<cwd-slug>.jsonl` (see memory.ts).
 */
export const CLAUDE_CODE_SOURCE_ID = 'claude-code';

/** The path prefix of the memory streams (a project's slug never is `memory`). */
const MEMORY_PREFIX = 'memory/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_USE_MAX = 2000;
const TOOL_RESULT_MAX = 4000;

export function claudeProjectsDir(): string {
  const override = process.env.ORIGIN_CLAUDE_PROJECTS;
  if (override && override.length > 0) return override;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const base = configDir && configDir.length > 0 ? configDir : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

export interface ClaudeCodeAdapterOptions {
  /** Override the projects directory (for tests). */
  projectsDir?: string;
}

export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): SourceAdapter {
  const root = opts.projectsDir ?? claudeProjectsDir();
  let lastVersion: string | null = null;
  return {
    id: CLAUDE_CODE_SOURCE_ID,
    displayName: 'Claude Code',
    version: () => lastVersion,
    async discover(): Promise<SourceFile[]> {
      if (!fs.existsSync(root)) return [];
      const out: SourceFile[] = [];
      walk(root, root, out);
      for (const slug of subdirectories(root)) {
        const dir = path.join(root, slug, 'memory');
        const stream = memoryStream({
          dir,
          relPath: `${MEMORY_PREFIX}${slug}.jsonl`,
          files: () => markdownFiles(dir, ['MEMORY.md']),
          where: () => {
            const cwd = projectCwd(path.join(root, slug));
            return { cwd, project: projectFromCwd(cwd ?? undefined) };
          },
        });
        if (stream) out.push(stream);
      }
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    locate(absPath: string): SourceFile | null {
      // A session log, or a sub-agent's, as walk() lists them: a `.jsonl` file anywhere under the
      // projects directory, but not in a memory/ or tool-results/ directory.
      const rel = relativeUnder(root, absPath);
      if (rel === null || !rel.endsWith('.jsonl')) return null;
      const segments = rel.split('/');
      if (segments.slice(0, -1).some((s) => SKIPPED_DIRS.has(s))) return null;
      return { absPath: path.join(root, ...segments), relPath: rel };
    },
    parseLine(line: string, ctx: ParseContext): ParsedLine | null {
      if (ctx.relPath === 'places.jsonl' || ctx.relPath.endsWith('/places.jsonl')) {
        return parseWithPlaces(line, ctx, () => null);
      }
      if (ctx.relPath.startsWith(MEMORY_PREFIX)) {
        return parseMemoryLine(line, ctx, (_file, content) => readFrontMatterMemory(content));
      }
      const parsed = parseClaudeCodeLine(line, ctx);
      if (parsed) {
        for (const ev of parsed.events) if (ev.agentVersion) lastVersion = ev.agentVersion;
      }
      return parsed;
    },
  };
}

/**
 * memory/ is Claude Code's own memory directory and tool-results/ caches large outputs; neither
 * holds sessions.
 */
const SKIPPED_DIRS = new Set(['memory', 'tool-results']);

function walk(root: string, dir: string, out: SourceFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIPPED_DIRS.has(ent.name)) continue;
      walk(root, abs, out);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push({ absPath: abs, relPath: path.relative(root, abs).split(path.sep).join('/') });
    }
  }
}

/**
 * The working directory of a project's sessions, from the first line that records one in its
 * newest session logs, or null. A project's slug cannot be turned back into its path.
 */
function projectCwd(projectDir: string): string | null {
  let logs: Array<{ file: string; mtimeMs: number }>;
  try {
    logs = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => {
        const file = path.join(projectDir, e.name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 3);
  } catch {
    return null;
  }
  for (const { file } of logs) {
    let head: string;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const line of head.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd.length > 0) return cwd;
      } catch {
        // a line cut short by the 64 KiB read
      }
    }
  }
  return null;
}

/** Derive the session id from the file name: `<uuid>.jsonl` → uuid; subagent files return null (use the in-line sessionId). */
export function sessionIdFromPath(relPath: string): string | null {
  const base = path.posix.basename(relPath, '.jsonl');
  return UUID_RE.test(base) ? base.toLowerCase() : null;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  userType?: string;
  entrypoint?: string;
  promptId?: string;
  /** Who sent a user line (2.1.303): `human`, `task-notification`, `peer`, `coordinator`, … */
  origin?: { kind?: string; name?: unknown };
  /** How a prompt was entered: `typed`, `queued`, `system`, `sdk`, … */
  promptSource?: string;
  /**
   * What an `attachment` line adds to the conversation; a `queued_command` is a prompt sent while
   * the agent was busy, which Claude Code delivers into the turn under way.
   */
  attachment?: {
    type?: string;
    prompt?: string | ContentBlock[];
    origin?: { kind?: string };
    isMeta?: boolean;
  };
  summary?: string;
  aiTitle?: string;
  customTitle?: string;
  leafUuid?: string;
  message?: { role?: string; content?: string | ContentBlock[]; model?: string };
}

/**
 * The lines that title a session, each written many times, the latest being current. Claude Code
 * 2.1 generates `ai-title` lines as the conversation goes on and writes `custom-title` lines for a
 * name the user gives (`/rename`, `--name`), which a later `ai-title` does not replace; older
 * versions wrote `summary` lines. `agent-name` lines name the session in Claude Code's agent view
 * and repeat one of these titles, so they are not read.
 */
const TITLES: Record<string, { field: 'aiTitle' | 'customTitle' | 'summary'; manual: boolean }> = {
  'ai-title': { field: 'aiTitle', manual: false },
  'custom-title': { field: 'customTitle', manual: true },
  summary: { field: 'summary', manual: false },
};

/** Who wrote an input, as an event carries it. */
type InputAuthor = Pick<EventInput, 'author' | 'authorSignal' | 'speaker'>;

/** Whether a log is a sub-agent's: `<session>/subagents/…`. */
const inSubagents = (relPath: string) => relPath.split('/').slice(0, -1).includes('subagents');

/**
 * Who wrote the input of a user line, as Claude Code records it, or null to leave it to its kind
 * and text (older versions record none of this; see docs/sources.md#claude-code):
 * - a sub-agent's thread (`isSidechain`, or a log under `subagents/`): its parent agent wrote its
 *   prompts, whatever else the line says;
 * - a headless run (`entrypoint` `sdk-*`, as `claude -p` and the Agent SDK record it): a program's;
 * - `origin.kind`: `human` the user's; `task-notification` the runtime's; `peer` and `coordinator`
 *   another agent's, named by `origin.name`;
 * - `isCompactSummary`, the summary a compaction writes: the runtime's;
 * - `promptSource` `typed` or `queued`: the user's.
 */
function inputAuthor(obj: ClaudeLine, relPath: string): InputAuthor | null {
  if (obj.isSidechain === true) return { author: 'agent', authorSignal: 'isSidechain' };
  if (inSubagents(relPath)) return { author: 'agent', authorSignal: 'subagents' };
  if (typeof obj.entrypoint === 'string' && obj.entrypoint.startsWith('sdk-')) {
    return { author: 'system', authorSignal: 'entrypoint' };
  }
  switch (obj.origin?.kind) {
    case 'human':
      return { author: 'owner', authorSignal: 'origin.kind' };
    case 'task-notification':
      return { author: 'system', authorSignal: 'origin.kind' };
    case 'peer':
    case 'coordinator': {
      const name = obj.origin.name;
      return {
        author: 'agent',
        authorSignal: 'origin.kind',
        speaker: typeof name === 'string' ? name : null,
      };
    }
  }
  if (obj.isCompactSummary === true) return { author: 'system', authorSignal: 'isCompactSummary' };
  if (obj.promptSource === 'typed' || obj.promptSource === 'queued') {
    return { author: 'owner', authorSignal: 'promptSource' };
  }
  return null;
}

/** Pure function: parse one line. Exported for tests. */
export function parseClaudeCodeLine(line: string, ctx: ParseContext): ParsedLine | null {
  const obj = JSON.parse(line) as ClaudeLine;
  const fileSession = sessionIdFromPath(ctx.relPath);

  const title = obj.type && Object.hasOwn(TITLES, obj.type) ? TITLES[obj.type] : undefined;
  if (title) {
    // A session's titles are in its own log, not in its sub-agents'.
    const text = obj[title.field];
    if (!fileSession || typeof text !== 'string' || text.trim().length === 0) return null;
    const parsed: ParsedLine = {
      events: [],
      sessionTitle: text.trim(),
      sessionId: (obj.sessionId ?? fileSession).toLowerCase(),
    };
    if (title.manual) parsed.manualTitle = true;
    return parsed;
  }
  if (obj.type === 'attachment') return queuedPrompt(obj, ctx, fileSession);
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  if (!obj.uuid || !obj.message) return null;

  const sessionId = (obj.sessionId ?? fileSession ?? '').toLowerCase();
  if (!sessionId) return null;
  const role = obj.type;
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : Number.NaN;
  const base = {
    sessionId,
    parentId: obj.parentUuid ?? null,
    ts: Number.isFinite(ts) ? ts : Math.round(ctx.fileMtimeMs),
    project: projectFromCwd(obj.cwd),
    cwd: obj.cwd ?? null,
    gitBranch: obj.gitBranch ?? null,
    agentVersion: obj.version ?? null,
  };
  const meta: Record<string, unknown> = {};
  if (obj.isSidechain) meta.sidechain = true;
  if (obj.userType) meta.userType = obj.userType;
  if (obj.entrypoint) meta.entrypoint = obj.entrypoint;
  if (obj.message.model) meta.model = obj.message.model;
  if (!fileSession) meta.agentFile = path.posix.basename(ctx.relPath, '.jsonl');

  const events: EventInput[] = [];
  const content = obj.message.content;
  const author = role === 'user' ? inputAuthor(obj, ctx.relPath) : null;
  const pushEvent = (
    suffix: string | null,
    kind: EventKind,
    text: string,
    extra?: Record<string, unknown>,
  ) => {
    const cleaned = text.trim();
    if (cleaned.length === 0) return;
    const m = extra ? { ...meta, ...extra } : meta;
    events.push({
      id: suffix ? `${obj.uuid}#${suffix}` : (obj.uuid as string),
      role,
      kind,
      text: cleaned,
      meta: Object.keys(m).length > 0 ? m : null,
      ...base,
      // Who wrote an input (a tool result has its kind instead).
      ...(author && (kind === 'message' || kind === 'meta') ? author : {}),
    });
  };

  if (typeof content === 'string') {
    pushEvent(null, obj.isMeta ? 'meta' : 'message', content);
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    content.forEach((block, i) => {
      switch (block.type) {
        case 'text':
          if (block.text) textParts.push(block.text);
          break;
        case 'tool_use':
          pushEvent(String(i), 'tool_use', formatToolUse(block), {
            toolName: block.name ?? null,
            toolUseId: block.id ?? null,
          });
          break;
        case 'tool_result':
          pushEvent(
            String(i),
            'tool_result',
            truncate(flattenContent(block.content), TOOL_RESULT_MAX),
            {
              toolUseId: block.tool_use_id ?? null,
              isError: block.is_error === true,
            },
          );
          break;
        case 'image':
          textParts.push('[image]');
          break;
        default:
          // thinking / redacted_thinking / unknown blocks: not turned into events; the original stays in the raw mirror.
          break;
      }
    });
    if (textParts.length > 0)
      pushEvent(null, obj.isMeta ? 'meta' : 'message', textParts.join('\n'));
  }
  return { events };
}

/**
 * The prompt of a `queued_command` attachment the user sent (`origin.kind` `human`) while the agent
 * was busy: a user message of its own, the owner's, under the line's uuid, with its text as
 * written. Claude Code delivers it into the turn under way and writes no user line for it. Queued
 * task notifications, and what a sub-agent is handed this way, are no prompt of the user's, and
 * yield nothing; the raw mirror keeps them.
 */
function queuedPrompt(
  obj: ClaudeLine,
  ctx: ParseContext,
  fileSession: string | null,
): ParsedLine | null {
  const a = obj.attachment;
  if (a?.type !== 'queued_command' || a.origin?.kind !== 'human' || a.isMeta === true) return null;
  if (obj.isSidechain === true || inSubagents(ctx.relPath) || !obj.uuid) return null;
  const sessionId = (obj.sessionId ?? fileSession ?? '').toLowerCase();
  const prompt = a.prompt;
  const text = (
    typeof prompt === 'string'
      ? prompt
      : Array.isArray(prompt)
        ? prompt
            .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
            .filter((s) => s.length > 0)
            .join('\n')
        : ''
  ).trim();
  if (!sessionId || text.length === 0) return null;
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : Number.NaN;
  const meta: Record<string, unknown> = { queued: true };
  if (obj.userType) meta.userType = obj.userType;
  if (obj.entrypoint) meta.entrypoint = obj.entrypoint;
  const headless = typeof obj.entrypoint === 'string' && obj.entrypoint.startsWith('sdk-');
  return {
    events: [
      {
        id: obj.uuid,
        sessionId,
        parentId: obj.parentUuid ?? null,
        ts: Number.isFinite(ts) ? ts : Math.round(ctx.fileMtimeMs),
        project: projectFromCwd(obj.cwd),
        cwd: obj.cwd ?? null,
        gitBranch: obj.gitBranch ?? null,
        agentVersion: obj.version ?? null,
        role: 'user',
        kind: 'message',
        text,
        meta,
        ...(headless
          ? { author: 'system', authorSignal: 'entrypoint' }
          : { author: 'owner', authorSignal: 'queued_command' }),
      },
    ],
  };
}

function formatToolUse(block: ContentBlock): string {
  const name = block.name ?? 'tool';
  let input = '';
  try {
    input = block.input === undefined ? '' : JSON.stringify(block.input);
  } catch {
    input = '[unserializable input]';
  }
  return truncate(`${name} ${input}`, TOOL_USE_MAX);
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: ContentBlock) =>
        c?.type === 'text' && c.text ? c.text : c?.type === 'image' ? '[image]' : '',
      )
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}
