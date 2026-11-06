/**
 * Which agent runs a hook. Agents run hooks written for other agents: Grok Build and Cursor run the
 * hooks of `~/.claude/settings.json`, and Grok Build those of `~/.cursor/hooks.json` too, and hand
 * them events of their own, whose context they do not read the way Claude Code does. Origin's hooks
 * (`origin recall --hook`, `origin sync --hook`) act only for the agent they were written for, so
 * that nothing is recorded under another agent's name, or for a session nobody was handed anything
 * in. Loaded by both hooks (see bin.ts): it must load nothing else.
 */

/** A hook's input: its event on standard input, and its environment. */
export interface HookIO {
  /** The hook's event, as the agent writes it on standard input. */
  stdin(): string;
  /** The hook's environment; the process's own by default. */
  env?: NodeJS.ProcessEnv;
}

/** Agents known to run hooks written for another agent, and how a hook knows it is theirs. */
export type HookCaller = 'grok' | 'cursor' | 'zcode';

const has = (o: Record<string, unknown>, key: string) => o[key] !== undefined && o[key] !== null;

/**
 * The agent that runs this hook, from what only that agent puts in its events or environment; null
 * when nothing names one, as for Claude Code and Codex, which mark their events with nothing of
 * their own. The evidence, checked against each agent's documentation and code:
 *
 * - Grok Build sets `GROK_HOOK_EVENT` for every hook it runs, and sends camelCase fields beside
 *   Claude's (`hookEventName`, `workspaceRoot`).
 * - Cursor sends `cursor_version` with every event, its own hooks' and Claude Code's alike.
 * - ZCode sends camelCase fields beside Claude's (`hookEventName`, `agentName`).
 */
export function hookCaller(
  event: unknown,
  env: NodeJS.ProcessEnv = process.env,
): HookCaller | null {
  if (env.GROK_HOOK_EVENT) return 'grok';
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  if (has(e, 'hookEventName') && has(e, 'workspaceRoot')) return 'grok';
  if (typeof e.cursor_version === 'string') return 'cursor';
  if (has(e, 'hookEventName') && has(e, 'agentName')) return 'zcode';
  return null;
}

/** Whether a hook written for `agent` was run by another agent, and must do nothing. */
export function runByAnother(agent: string, event: unknown, env?: NodeJS.ProcessEnv): boolean {
  const caller = hookCaller(event, env);
  return caller !== null && caller !== agent;
}
