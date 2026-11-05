/** Event role. */
export type Role = 'user' | 'assistant' | 'system';

/**
 * Event kind: plain message, tool call, tool result, meta (command echoes etc.), system event, or a
 * version of one of the agent's native memories (a memory file it keeps; see NativeMemory).
 */
export type EventKind = 'message' | 'tool_use' | 'tool_result' | 'meta' | 'system' | 'memory';

/**
 * Who wrote an input (see authors.ts): the owner of this memory, as its source knows; another
 * person, or a person not known to be the owner; an agent, such as a parent agent prompting a
 * sub-agent; or the system, the agent's runtime or a program. Only human-side input has one: a
 * user message or a meta event (role `user`, kind `message` or `meta`).
 */
export type Author = 'owner' | 'person' | 'agent' | 'system';

/**
 * What a session is, when one of its source's lines says so: an agent's session (`child`, a
 * sub-agent or a workflow step, whose prompts an agent wrote) or a program's run (`headless`).
 * Every input of such a session is the agent's or the system's, whatever it says itself.
 */
export type SessionKind = 'child' | 'headless';

/** A line's statement that a session of its source is a child or a headless run (see SessionKind). */
export interface SessionKindFact {
  sessionId: string;
  kind: SessionKind;
  /** The field that says so, a short code (`task_type`, `subagent_spawned`, …). */
  signal: string;
}

/**
 * A line's statement that a session of its source has a parent (see parents.ts). `fromAgent` is
 * the agent's own line; a `parent` line of `places.jsonl` sets it false.
 */
export interface SessionParentFact {
  sessionId: string;
  parentSessionId: string;
  /** The parent's source; the line's own source when omitted. */
  parentSource?: string;
  via: 'subagent' | 'workflow';
  runGroup?: string | null;
  runName?: string | null;
  /** The field that says so (`parent_id`, `subagent_spawned`, `dwf_run`, …). */
  signal: string;
  /** The agent's own line, rather than a `parent` line of `places.jsonl`. Not stored. */
  fromAgent?: boolean;
}

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
  /**
   * Who wrote a human-side input (role `user`, kind `message` or `meta`), as its line shows: ignored
   * on every other event. Without it, ingestion decides by the event's kind and text (see
   * defaultAuthor in authors.ts).
   */
  author?: Author;
  /** The field that decided `author`, a short code for debugging and the docs (`origin.kind`, …). */
  authorSignal?: string;
  /**
   * Who said a human-side input, as its source shows people a name or label (`Alice`, `Speaker 2`,
   * an agent's display name): 1 to 200 characters, never an opaque id. Ignored on other events.
   */
  speaker?: string | null;
  /**
   * The line named `project` itself (`explicit`). Absent when the name is only the last segment of
   * `cwd`. Ingestion records it and will not replace it with a resolved work tree.
   */
  projectSignal?: 'explicit';
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
  /**
   * Who wrote a human-side input, all things considered (its effective author, see authors.ts): the
   * agent's for any input of a child session, the system's for one of a headless run, otherwise the
   * author its line shows. Null on every other event.
   */
  author: Author | null;
  /** The field that decided `author` (see EventInput.authorSignal); null where `author` is. */
  authorSignal: string | null;
  /** Who said a human-side input, as its source named them, or null (see EventInput.speaker). */
  speaker: string | null;
}

/** The result of parsing one raw line. */
export interface ParsedLine {
  events: EventInput[];
  /**
   * Session title carried by this line (e.g. a Claude Code `ai-title` line). The latest title of a
   * session replaces the one before, except that a title the agent generated never replaces one the
   * user gave (`manualTitle`).
   */
  sessionTitle?: string;
  /** Session the sessionTitle belongs to. */
  sessionId?: string;
  /**
   * The user gave the session this title (Claude Code's `/rename`), so a title the agent generates
   * later does not replace it; a later title the user gives does. Only for agents whose logs keep
   * writing generated titles after a rename: where the agent keeps the current title itself, as
   * Grok Build does, every title is simply the latest.
   */
  manualTitle?: boolean;
  /**
   * A version of one of the agent's native memories, read from this line's `memory` event: Origin
   * imports it as an entry (see docs/architecture.md#native-memories).
   */
  memory?: NativeMemory;
  /**
   * Sessions of this source that this line says are an agent's or a program's (see SessionKind):
   * its own, as a ZCode line's `task_type` says, or another, as a Grok Build parent names the
   * sub-agent it spawns. Kept apart from the events' own authors and combined with them when they
   * are read, so that the order lines arrive in does not matter.
   */
  sessionKinds?: SessionKindFact[];
  /**
   * A `places.jsonl` line's roots and places (see places.ts). No message events.
   */
  roots?: ProjectRootFact[];
  places?: SessionPlaceFact[];
  /**
   * Sessions of this source that this line says have a parent (see SessionParentFact): its own, as
   * a ZCode line's `parent_id` says, or another, as a Grok Build parent names the sub-agent it
   * spawns. Kept apart from the events and combined when they are read.
   */
  sessionParents?: SessionParentFact[];
  /**
   * This line was skipped. Ingestion logs it as a warning and keeps the bytes. A `places.jsonl`
   * line that is not the JSON object its type requires sets this and yields nothing, so one bad
   * line does not stop the file, another source, or opening the store.
   */
  warning?: string;
}

/** One `project_root` row a `places.jsonl` `root` line names. */
export interface ProjectRootFact {
  path: string;
  project: string;
  root: string;
  signal: string;
}

/** One `session_place` row a `places.jsonl` `place` line names. */
export interface SessionPlaceFact {
  sessionId: string;
  project: string;
  root: string | null;
  signal: string;
}

/**
 * One version of a native memory, such as one Markdown file of Claude Code's `memory/` directory,
 * as an adapter reads it from a line of a memory stream. Every store that parses the line derives
 * the same entry from it, under an id derived from the event's (see memories.ts).
 */
export interface NativeMemory {
  /** The id of the line's event (as in `events`) the memory is read from. */
  eventId: string;
  /** The id of the event of the memory's previous version, or null for its first. */
  previous: string | null;
  /** When this version was written, or its deletion noticed (epoch ms). */
  at: number;
  /** The memory as of this version; null once it was deleted, or left without content. */
  entry: {
    kind: 'memory' | 'knowledge' | 'cognition';
    text: string;
    confidence: number;
    project: string | null;
  } | null;
}

export interface SourceFile {
  /** The original file; for a generated source, a path that names it (e.g. `<database>#<id>`). */
  absPath: string;
  /** Path relative to the adapter root, `/`-separated; used to name the mirror. */
  relPath: string;
  /** Set for compressed files: Origin ingests and mirrors the decompressed content. */
  compression?: 'zstd';
  /** Set for a source that is not a log file, such as a database: the adapter writes its lines. */
  generated?: GeneratedSource;
}

/**
 * The content of a generated source: lines the adapter writes, which only ever grow (a database row
 * that changes after it was written out is not written again). Origin mirrors and ingests them like
 * the lines of a file.
 */
export interface GeneratedSource {
  /** Differs from the token at the last ingestion whenever there may be new lines. */
  token: string;
  /** When the source last changed (epoch ms), to ingest older sources first. */
  mtimeMs: number;
  /**
   * The lines that follow `last`, the last line written so far (null for none): at least one if
   * there are any, and about `maxBytes` at most. Origin asks again until none are left. Each is one
   * line of text, without a line break.
   */
  next(last: string | null, maxBytes: number): string[];
}

export interface ParseContext {
  /**
   * The original file (for a generated source, the path that names it); on a hub, which has no
   * original, the path of its mirror.
   */
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
  /**
   * Set only for Origin's own `places.jsonl`: a generated file, or a device's file whose raw path
   * is exactly `places.jsonl`. A file a person wrote, even under that name, is an ordinary source.
   */
  generated?: boolean;
}

/** A session source adapter for one agent (Source, see docs/architecture.md). Parsing must be deterministic and LLM-free. */
export interface SourceAdapter {
  /**
   * Stable id: claude-code / codex / cursor / zcode / grok, or the name of a source of one's own,
   * read by the lines adapter (see docs/sources.md#your-own-sources-event-lines).
   */
  id: string;
  displayName: string;
  /** Version of the source agent, if known. */
  version(): string | null;
  /** List the files to ingest now. */
  discover(): Promise<SourceFile[]>;
  /**
   * The file at `absPath` as discover() would list it, with the same absPath, relPath, and
   * compression, so that it gets the same mirror; null when the path is not one of this adapter's
   * files (outside its root, or one discover() skips). Pure: it reads nothing, so the file need not
   * exist. Implemented by adapters whose agents name a session's file in their hooks, so that one
   * file can be ingested on its own (see syncFile in ingest.ts).
   */
  locate?(absPath: string): SourceFile | null;
  /** Parse one line; null means the line yields nothing (still counted). Thrown errors are caught and counted by the ingester. */
  parseLine(line: string, ctx: ParseContext): ParsedLine | null;
}

export interface SessionRow {
  source: string;
  sessionId: string;
  project: string | null;
  cwd: string | null;
  /** The title the agent, or the user through the agent, gave the session; null if none. */
  title: string | null;
  /**
   * For a session without a title, the first prompt its owner wrote in it, cut short (see
   * isOwnerPrompt in authors.ts, promptTitle in prompt.ts): a provisional name, not a title. Null for
   * a session with a title, or without such a prompt (a sub-agent's, say).
   */
  prompt: string | null;
  startedAt: number | null;
  endedAt: number | null;
  eventCount: number;
  /** The thread the session is in with other sessions (see threads.ts), or null. */
  thread: string | null;
}

export interface SyncResult {
  source: string;
  filesSeen: number;
  filesChanged: number;
  linesRead: number;
  eventsAdded: number;
  parseErrors: number;
  /** Lines that yielded events, all of which the store already had. */
  duplicates: number;
  newGenerations: number;
  durationMs: number;
}
