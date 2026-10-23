/** Event role. */
export type Role = 'user' | 'assistant' | 'system';

/** Event kind: plain message, tool call, tool result, meta (command echoes etc.), system event. */
export type EventKind = 'message' | 'tool_use' | 'tool_result' | 'meta' | 'system';

/** An event produced by an adapter (not yet stored; no source or raw locator). */
export interface EventInput {
  /** Stable id, unique within the source (usually the source's own message uuid; block-level events append `#i`). */
  id: string;
  sessionId: string;
  parentId?: string | null;
  /** epoch ms. */
  ts: number;
  project?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  role: Role;
  kind: EventKind;
  text: string;
  agentVersion?: string | null;
  meta?: Record<string, unknown> | null;
}

/** A stored event row. */
export interface EventRow {
  id: string;
  source: string;
  sessionId: string;
  parentId: string | null;
  ts: number;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  role: Role;
  kind: EventKind;
  text: string;
  rawFileId: number;
  rawLine: number;
  agentVersion: string | null;
  meta: Record<string, unknown> | null;
}

/** The result of parsing one raw line. */
export interface ParsedLine {
  events: EventInput[];
  /** Session title carried by this line (e.g. a Claude Code summary line). */
  sessionTitle?: string;
  /** Session the sessionTitle belongs to; defaults to the session id derived from the file. */
  sessionId?: string;
}

export interface SourceFile {
  absPath: string;
  /** Path relative to the adapter root, `/`-separated; used to name the mirror. */
  relPath: string;
  /** Set for compressed files: Origin ingests and mirrors the decompressed content. */
  compression?: 'zstd';
}

export interface ParseContext {
  /** The original file; on a hub, which has no original, the path of its mirror. */
  absPath: string;
  relPath: string;
  /** 1-based line number (in the mirror, equal to the line number in this generation of the source file). */
  lineNo: number;
  /** Source file mtime (epoch ms), the fallback for lines without a timestamp. */
  fileMtimeMs: number;
  /**
   * An earlier line of this generation of the file (1-based), as ingested, or null. Adapters that
   * need, say, a file's first line read it here rather than from `absPath`, which on a hub is not a
   * readable file.
   */
  readLine?: (lineNo: number) => string | null;
}

/** A session source adapter for one agent (Source, see docs/architecture.md). Parsing must be deterministic and LLM-free. */
export interface SourceAdapter {
  /** Stable id: claude-code / codex / cursor / zcode / grok. */
  id: string;
  displayName: string;
  /** Version of the source agent, if known. */
  version(): string | null;
  /** List the files to ingest now. */
  discover(): Promise<SourceFile[]>;
  /** Parse one line; null means the line yields nothing (still counted). Thrown errors are caught and counted by the ingester. */
  parseLine(line: string, ctx: ParseContext): ParsedLine | null;
}

export interface SessionRow {
  source: string;
  sessionId: string;
  project: string | null;
  cwd: string | null;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  eventCount: number;
}

export interface SyncResult {
  source: string;
  filesSeen: number;
  filesChanged: number;
  linesRead: number;
  eventsAdded: number;
  parseErrors: number;
  newGenerations: number;
  durationMs: number;
}
