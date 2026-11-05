import { isPlacesRel, parsePlaceLine, type SourceAdapter } from '@openlinkos/origin-core';
import { CLAUDE_CODE_SOURCE_ID, createClaudeCodeAdapter } from './claude-code.js';
import { CODEX_SOURCE_ID, createCodexAdapter } from './codex.js';
import { CURSOR_SOURCE_ID, createCursorAdapter } from './cursor.js';
import { createGrokAdapter, GROK_SOURCE_ID } from './grok.js';
import { createZCodeAdapter, ZCODE_SOURCE_ID } from './zcode.js';

export {
  CLAUDE_CODE_SOURCE_ID,
  claudeProjectsDir,
  createClaudeCodeAdapter,
  parseClaudeCodeLine,
  sessionIdFromPath,
} from './claude-code.js';
export {
  CODEX_SOURCE_ID,
  type CodexAdapterOptions,
  type CodexSessionInfo,
  codexHome,
  codexSessionIdFromPath,
  createCodexAdapter,
  parseCodexLine,
} from './codex.js';
export {
  CURSOR_SETTLE_MS,
  CURSOR_SOURCE_ID,
  type CursorAdapterOptions,
  createCursorAdapter,
  cursorHome,
  cursorSessionIdFromPath,
  cursorTimestamp,
  cursorUserDir,
  parseCursorEditorLine,
} from './cursor.js';
export {
  createGrokAdapter,
  GROK_SOURCE_ID,
  type GrokAdapterOptions,
  grokCwdFromGroup,
  grokHome,
  grokSessionIdFromPath,
  parseGrokLine,
  parseGrokTitleLine,
} from './grok.js';
export {
  BUILT_IN_SOURCE_IDS,
  createLinesAdapter,
  isLinesSourceId,
  LINES_SOURCE_RE,
  LINES_SOURCE_RULE,
  type LinesAdapterOptions,
  linesSources,
  parseEventLine,
  RESERVED_SOURCE_NAMES,
} from './lines.js';
export { projectFromCwd } from './util.js';
export {
  createZCodeAdapter,
  parseZCodeLine,
  ZCODE_SETTLE_MS,
  ZCODE_SOURCE_ID,
  type ZCodeAdapterOptions,
  zcodeHome,
} from './zcode.js';

/**
 * The built-in adapters, one per agent Origin reads. A person's own sources, read with the lines
 * adapter, are listed by linesSources.
 */
/** `places.jsonl` is parsed by core. An adapter's own `parseLine` stays free of git. */
function withPlaces(adapter: SourceAdapter): SourceAdapter {
  return {
    ...adapter,
    parseLine(line, ctx) {
      if (isPlacesRel(ctx.relPath)) return parsePlaceLine(line);
      return adapter.parseLine(line, ctx);
    },
  };
}

export function allAdapters(): SourceAdapter[] {
  return [
    createClaudeCodeAdapter(),
    createCodexAdapter(),
    createGrokAdapter(),
    createZCodeAdapter(),
    createCursorAdapter(),
  ].map(withPlaces);
}

/** A built-in adapter by its id. */
export function adapterById(id: string): SourceAdapter | null {
  return allAdapters().find((a) => a.id === id) ?? null;
}

export const KNOWN_SOURCE_IDS = [
  CLAUDE_CODE_SOURCE_ID,
  CODEX_SOURCE_ID,
  GROK_SOURCE_ID,
  ZCODE_SOURCE_ID,
  CURSOR_SOURCE_ID,
] as const;
