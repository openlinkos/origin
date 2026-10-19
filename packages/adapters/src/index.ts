import type { SourceAdapter } from '@openlinkos/origin-core';
import { CLAUDE_CODE_SOURCE_ID, createClaudeCodeAdapter } from './claude-code.js';

export {
  CLAUDE_CODE_SOURCE_ID,
  claudeProjectsDir,
  createClaudeCodeAdapter,
  parseClaudeCodeLine,
  projectFromCwd,
  sessionIdFromPath,
} from './claude-code.js';

/** All implemented adapters (added one at a time, in roadmap order). */
export function allAdapters(): SourceAdapter[] {
  return [createClaudeCodeAdapter()];
}

export function adapterById(id: string): SourceAdapter | null {
  return allAdapters().find((a) => a.id === id) ?? null;
}

export const KNOWN_SOURCE_IDS = [
  CLAUDE_CODE_SOURCE_ID,
  'codex',
  'cursor',
  'zcode',
  'grok',
] as const;
