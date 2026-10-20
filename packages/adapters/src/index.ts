import type { SourceAdapter } from '@openlinkos/origin-core';
import { CLAUDE_CODE_SOURCE_ID, createClaudeCodeAdapter } from './claude-code.js';
import { CODEX_SOURCE_ID, createCodexAdapter } from './codex.js';

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
export { projectFromCwd } from './util.js';

/** All implemented adapters (added one at a time, in roadmap order). */
export function allAdapters(): SourceAdapter[] {
  return [createClaudeCodeAdapter(), createCodexAdapter()];
}

export function adapterById(id: string): SourceAdapter | null {
  return allAdapters().find((a) => a.id === id) ?? null;
}

export const KNOWN_SOURCE_IDS = [
  CLAUDE_CODE_SOURCE_ID,
  CODEX_SOURCE_ID,
  'cursor',
  'zcode',
  'grok',
] as const;
