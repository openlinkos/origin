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
import { projectFromCwd, truncate } from './util.js';

/**
 * Claude Code adapter (format notes: docs/sources.md).
 * Sessions: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; subagents in `<sessionId>/subagents/agent-*.jsonl`.
 * Line format: one JSON event per line, `type` ∈ user / assistant / ai-title / custom-title /
 * agent-name / summary / mode / permission-mode / file-history-snapshot / system / …; the messages
 * (user, assistant) and the session's titles (ai-title, custom-title, and summary in older logs)
 * carry information.
 */
export const CLAUDE_CODE_SOURCE_ID = 'claude-code';

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
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    parseLine(line: string, ctx: ParseContext): ParsedLine | null {
      const parsed = parseClaudeCodeLine(line, ctx);
      if (parsed) {
        for (const ev of parsed.events) if (ev.agentVersion) lastVersion = ev.agentVersion;
      }
      return parsed;
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
    if (ent.isDirectory()) {
      // memory/ is Claude Code's own memory dir and tool-results/ caches large outputs; neither holds sessions.
      if (ent.name === 'memory' || ent.name === 'tool-results') continue;
      walk(root, abs, out);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push({ absPath: abs, relPath: path.relative(root, abs).split(path.sep).join('/') });
    }
  }
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
  userType?: string;
  entrypoint?: string;
  promptId?: string;
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
