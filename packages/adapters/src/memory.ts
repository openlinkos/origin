import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GeneratedSource,
  NativeMemory,
  ParseContext,
  ParsedLine,
} from '@openlinkos/origin-core';
import { IMPORTED_CONFIDENCE } from '@openlinkos/origin-core';

/**
 * Native memories (format notes: docs/sources.md#native-memories): the memory files an agent keeps
 * for itself, such as the Markdown files of Claude Code's `memory/` directories. The agent rewrites
 * and deletes them in place, so each memory directory is written out as a generated source, a
 * memory stream: one line for every version of one of its files, holding the whole file, and one
 * line when a file is deleted. Every line also holds the directory's state after it, the latest
 * line of each file and the hash of its content, from which the next lines are written: the
 * adapter keeps no state of its own. Origin derives an entry version from each line (see
 * memories.ts in core).
 */

/** Files larger than this are not memories (a memory is a short note); they are left out. */
export const MEMORY_FILE_MAX = 256 * 1024;

/** One line of a memory stream. */
export interface MemoryLine {
  /** The event's id: a hash chained from the file's previous line, so the same on every store. */
  id: string;
  /** The id of the file's previous line, or null for its first. */
  prev: string | null;
  /** The file, relative to the directory, `/`-separated. */
  file: string;
  op: 'write' | 'delete';
  /** The file's modification time for a write; for a delete, when it was noticed (epoch ms). */
  at: number;
  /** The whole file, for a write. */
  content?: string;
  project: string | null;
  cwd: string | null;
  /** The directory after this line: per file, its latest line's id and its content's hash (null once deleted). */
  state: Record<string, [string, string | null]>;
}

/** A memory directory of an agent, written out as a memory stream. */
export interface MemoryDir {
  /** The directory. */
  dir: string;
  /**
   * The stream's path relative to the adapter's root (naming its mirror), such as
   * `memory/<project-slug>.jsonl`. It also seeds the ids of the stream's events.
   */
  relPath: string;
  /** The memory files of the directory now, relative to it and `/`-separated. */
  files(): string[];
  /** The project and working directory the memories belong to, if known. */
  where(): { project: string | null; cwd: string | null };
}

const hash = (s: string, length: number) =>
  createHash('sha256').update(s).digest('hex').slice(0, length);

interface FileState {
  size: number;
  mtimeMs: number;
}

function statFiles(m: MemoryDir): Map<string, FileState> {
  const out = new Map<string, FileState>();
  for (const file of m.files()) {
    try {
      const st = fs.statSync(path.join(m.dir, file));
      if (st.isFile() && st.size <= MEMORY_FILE_MAX) {
        out.set(file, { size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      // deleted since it was listed
    }
  }
  return out;
}

/** The memory stream of a directory, or null if there is no such directory. */
export function memoryStream(
  m: MemoryDir,
  now: () => number = Date.now,
): {
  absPath: string;
  relPath: string;
  generated: GeneratedSource;
} | null {
  try {
    if (!fs.statSync(m.dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const files = statFiles(m);
  let mtimeMs = 0;
  const digest = createHash('sha256');
  for (const [file, st] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    digest.update(`${file}\0${st.size}\0${st.mtimeMs}\n`);
    mtimeMs = Math.max(mtimeMs, st.mtimeMs);
  }
  return {
    absPath: m.dir,
    relPath: m.relPath,
    generated: {
      token: digest.digest('hex').slice(0, 32),
      mtimeMs,
      next: (last, maxBytes) => memoryLines(m, last, maxBytes, now()),
    },
  };
}

/**
 * The lines that follow `last`, the stream's last line (null for none): a write for every memory
 * file that is new or whose content changed since, oldest first, then a delete for every file
 * that is gone, about `maxBytes` of them at most. A file that cannot be read is left as it was.
 */
export function memoryLines(
  m: MemoryDir,
  last: string | null,
  maxBytes: number,
  now: number,
): string[] {
  const state: MemoryLine['state'] = last ? { ...(JSON.parse(last) as MemoryLine).state } : {};
  const files = statFiles(m);
  const out: string[] = [];
  let bytes = 0;
  let where: { project: string | null; cwd: string | null } | null = null;
  /** Write a line, with the directory's state after it, unless it would pass `maxBytes`. */
  const push = (
    line: Omit<MemoryLine, 'project' | 'cwd' | 'state'>,
    after: [string, string | null],
  ) => {
    where ??= m.where();
    const next = { ...state, [line.file]: after };
    const text = JSON.stringify({ ...line, ...where, state: next } satisfies MemoryLine);
    if (out.length > 0 && bytes + text.length > maxBytes) return false;
    state[line.file] = after;
    out.push(text);
    bytes += text.length + 1;
    return true;
  };
  const ordered = [...files].sort(([a, x], [b, y]) => x.mtimeMs - y.mtimeMs || (a < b ? -1 : 1));
  for (const [file, st] of ordered) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(m.dir, file), 'utf8');
    } catch {
      continue;
    }
    const sha = hash(content, 16);
    const before = state[file];
    if (before && before[1] === sha) continue;
    const prev = before?.[0] ?? null;
    const id = hash(`${prev ?? `${m.relPath}/${file}`}\0write\0${sha}`, 24);
    if (!push({ id, prev, file, op: 'write', at: Math.round(st.mtimeMs), content }, [id, sha])) {
      return out;
    }
  }
  for (const [file, [prev, sha]] of Object.entries(state)) {
    if (sha === null || files.has(file) || fs.existsSync(path.join(m.dir, file))) continue;
    const id = hash(`${prev}\0delete`, 24);
    if (!push({ id, prev, file, op: 'delete', at: now }, [id, null])) return out;
  }
  return out;
}

/** What an adapter reads from one version of a memory file, or null if it holds no memory. */
export type MemoryContent = Omit<NonNullable<NativeMemory['entry']>, 'project'> | null;

/** Reads the memory in one version of a file of a memory directory. */
export type MemoryReader = (file: string, content: string) => MemoryContent;

/**
 * Parse one line of a memory stream: its event, of kind `memory`, and the version of the memory it
 * carries, read from the file by `read`. The event belongs to no conversation: its session id
 * names the stream.
 */
export function parseMemoryLine(line: string, ctx: ParseContext, read: MemoryReader): ParsedLine {
  const m = JSON.parse(line) as MemoryLine;
  if (typeof m.id !== 'string' || typeof m.file !== 'string' || !Number.isFinite(m.at)) {
    throw new Error('not a memory stream line');
  }
  const eventId = `memory:${m.id}`;
  const deleted = m.op === 'delete';
  const content = deleted ? null : (m.content ?? '');
  const entry = content === null ? null : read(m.file, content);
  return {
    events: [
      {
        id: eventId,
        sessionId: ctx.relPath.replace(/\.jsonl$/, ''),
        ts: m.at,
        project: m.project ?? null,
        cwd: m.cwd ?? null,
        role: 'assistant',
        kind: 'memory',
        text: content ?? '',
        meta: { file: m.file, op: m.op },
      },
    ],
    memory: {
      eventId,
      previous: m.prev ? `memory:${m.prev}` : null,
      at: m.at,
      entry: entry ? { ...entry, project: m.project ?? null } : null,
    },
  };
}

/** Front matter of a Markdown file: `key: value` lines, and one level of nested keys. */
export type FrontMatter = Record<string, string | Record<string, string>>;

/** Split a Markdown file into its YAML front matter (a simple subset) and its body. */
export function frontMatter(content: string): { data: FrontMatter; body: string } {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: FrontMatter = {};
  let parent: Record<string, string> | null = null;
  for (const raw of (match[1] ?? '').split('\n')) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith('#')) continue;
    const kv = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, indent = '', key = '', value = ''] = kv;
    if (indent.length > 0) {
      if (parent) parent[key] = unquote(value);
      continue;
    }
    if (value.length === 0) {
      parent = {};
      data[key] = parent;
    } else {
      parent = null;
      data[key] = unquote(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The kind of entry for a memory's type, as Claude Code, ZCode, and Grok Build name them: what the
 * user is like or asked for is cognition, what happened in a project is memory, and the rest is
 * knowledge.
 */
export function memoryKind(type: string | undefined): 'memory' | 'knowledge' | 'cognition' {
  switch (type?.trim().toLowerCase()) {
    case 'user':
    case 'feedback':
      return 'cognition';
    case 'project':
      return 'memory';
    default:
      return 'knowledge';
  }
}

function field(data: FrontMatter, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The entry of a memory file with front matter, as Claude Code and ZCode write them: `name`,
 * `description`, and the type, at the top level or under `metadata`. Its text is the description,
 * then the body.
 */
export function readFrontMatterMemory(
  content: string,
  confidence = IMPORTED_CONFIDENCE,
): MemoryContent {
  const { data, body } = frontMatter(content);
  const metadata = typeof data.metadata === 'object' ? data.metadata : {};
  const type = field(data, 'type') ?? (metadata.type || undefined);
  const description = field(data, 'description');
  const text = [description, body.trim()].filter((s) => s && s.length > 0).join('\n\n');
  if (text.length === 0) return null;
  return { kind: memoryKind(type), text, confidence };
}

/** The entry of a Markdown memory file without front matter: its text, HTML comments left out. */
export function readPlainMemory(
  content: string,
  kind: 'memory' | 'knowledge' | 'cognition',
  confidence = IMPORTED_CONFIDENCE,
): MemoryContent {
  const text = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Headings and notes alone, as in a template, hold no memory.
  const substance = text.split('\n').some((l) => l.trim().length > 0 && !/^\s*(#|>)/.test(l));
  return substance ? { kind, text, confidence } : null;
}

/** The names of a directory's subdirectories, or none if it cannot be read. */
export function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The Markdown files directly in a directory, but for `except`, sorted by name. */
export function markdownFiles(dir: string, except: string[] = []): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !except.includes(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
