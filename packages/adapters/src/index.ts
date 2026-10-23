import type { SourceAdapter } from '@openlinkos/origin-core';
import { CLAUDE_CODE_SOURCE_ID, createClaudeCodeAdapter } from './claude-code.js';
import { CODEX_SOURCE_ID, createCodexAdapter } from './codex.js';
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
  createGrokAdapter,
  GROK_SOURCE_ID,
  type GrokAdapterOptions,
  grokCwdFromGroup,
  grokHome,
  grokSessionIdFromPath,
  parseGrokLine,
} from './grok.js';
export { projectFromCwd } from './util.js';
export {
  createZCodeAdapter,
  parseZCodeLine,
  ZCODE_SETTLE_MS,
  ZCODE_SOURCE_ID,
  type ZCodeAdapterOptions,
  zcodeHome,
} from './zcode.js';

/** All implemented adapters (added one at a time, in roadmap order). */
export function allAdapters(): SourceAdapter[] {
  return [
    createClaudeCodeAdapter(),
    createCodexAdapter(),
    createGrokAdapter(),
    createZCodeAdapter(),
  ];
}

export function adapterById(id: string): SourceAdapter | null {
  return allAdapters().find((a) => a.id === id) ?? null;
}

export const KNOWN_SOURCE_IDS = [
  CLAUDE_CODE_SOURCE_ID,
  CODEX_SOURCE_ID,
  GROK_SOURCE_ID,
  ZCODE_SOURCE_ID,
  'cursor',
] as const;
