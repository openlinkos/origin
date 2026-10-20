import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ENTRY_KINDS } from '@openlinkos/origin-core';
import { z } from 'zod';

/** Guidance sent to agents in the MCP `initialize` response. */
export const INSTRUCTIONS = `Origin is the user's local, cross-agent memory: an append-only archive of their sessions with AI coding agents, plus durable entries — memory (what happened), knowledge (stable facts), and cognition (the user's preferences, methods, goals, and boundaries).

- To answer questions about past work, decisions, or reasons, use \`search\` and \`timeline\`, then \`get\` or \`sources\` to read the original text. Cite entry and event ids.
- When you learn something that will matter in future sessions — a decision and its reason, a stable fact, a preference of the user — save it with \`remember\`, citing the events it comes from: event ids from search/timeline, or an exact quote from this conversation.
- If an entry is wrong or outdated, use \`correct\`. Use \`forget\` only when the user explicitly asks; it cannot be undone.
- Time arguments accept relative values (30m, 24h, 7d, 2w) or dates (YYYY-MM-DD).`;

const time = z
  .string()
  .optional()
  .describe('Relative (30m, 24h, 7d, 2w) or absolute (YYYY-MM-DD, ISO 8601) time');

const sourceInput = z
  .object({
    event_id: z.string().optional().describe('Id of the event to cite'),
    quote: z
      .string()
      .optional()
      .describe('Exact text from the event; alone, it finds the most recent message containing it'),
  })
  .describe('An event id, an exact quote, or both');

interface ToolSpec {
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** The seven tools, defined once and shared by the local servers and the forwarding proxy. */
export const TOOL_SPECS = {
  search: {
    title: 'Search memory',
    description:
      'Full-text search over entries and archived session events, best match first. Without a query, lists the most recent entries.',
    inputSchema: {
      query: z.string().optional().describe('Words or phrases to find (any language)'),
      scope: z.enum(['all', 'entries', 'events']).default('all'),
      kind: z.enum(ENTRY_KINDS).optional().describe('Only entries of this kind'),
      since: time,
      until: time,
      source: z.string().optional().describe('Agent id, e.g. claude-code'),
      project: z.string().optional(),
      include_tools: z.boolean().default(false).describe('Also match tool calls and tool results'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  },
  timeline: {
    title: 'Timeline',
    description:
      'Sessions in a time range (newest first), or the events of one session in order when `session` is given.',
    inputSchema: {
      since: time.describe('Start of the range (default 7d)'),
      until: time,
      source: z.string().optional(),
      project: z.string().optional(),
      session: z.string().optional().describe('Session id: list its events instead'),
      include_tools: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: readOnly,
  },
  get: {
    title: 'Get entry or event',
    description:
      'Fetch an entry (with its sources and version history) or an event (full text) by id.',
    inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
    annotations: readOnly,
  },
  sources: {
    title: 'Original sources',
    description:
      'Expand an entry or event to the original log lines it comes from, with file paths and line numbers.',
    inputSchema: { id: z.string().describe('Entry id (ent_…) or event id (source:…)') },
    annotations: readOnly,
  },
  remember: {
    title: 'Remember',
    description:
      'Save a durable entry that cites the events it comes from. memory = what happened (a decision and why); knowledge = a stable fact; cognition = the user’s preferences, methods, goals, or boundaries.',
    inputSchema: {
      kind: z.enum(ENTRY_KINDS),
      text: z.string().min(1).describe('One self-contained statement'),
      sources: z.array(sourceInput).min(1),
      confidence: z.number().min(0).max(1).describe('How sure you are, 0–1'),
      project: z.string().optional().describe('Project the entry belongs to, if any'),
      valid_from: time,
      valid_to: time,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  correct: {
    title: 'Correct an entry',
    description:
      'Replace an entry with a corrected version. The old version is kept as history and no longer returned; its sources carry over.',
    inputSchema: {
      id: z.string().describe('Entry id (ent_…)'),
      text: z.string().min(1),
      kind: z.enum(ENTRY_KINDS).optional(),
      confidence: z.number().min(0).max(1).optional(),
      sources: z.array(sourceInput).optional().describe('Additional sources'),
      valid_from: time,
      valid_to: time,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  forget: {
    title: 'Forget',
    description:
      'Permanently forget an entry (every version, and the events it cites) or an event (and every entry that cites it). Only on the user’s explicit request; cannot be undone.',
    inputSchema: {
      id: z.string().describe('Entry id (ent_…) or event id (source:…)'),
      reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
} satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_SPECS;

export const TOOL_NAMES = Object.keys(TOOL_SPECS) as ToolName[];

/** Validated arguments of a tool, after defaults are applied. */
export type ToolArgs<N extends ToolName> = z.output<
  z.ZodObject<(typeof TOOL_SPECS)[N]['inputSchema']>
>;

export type ToolHandlers = { [N in ToolName]: (args: ToolArgs<N>) => Promise<CallToolResult> };

/** Tools that write; they always refresh first so that they can cite what was just said. */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set(['remember', 'correct']);

export function registerOriginTools(mcp: McpServer, handlers: ToolHandlers): void {
  for (const name of TOOL_NAMES) {
    const handler = handlers[name] as (args: unknown) => Promise<CallToolResult>;
    mcp.registerTool(
      name,
      TOOL_SPECS[name] as ToolSpec,
      ((args: unknown) => handler(args)) as never,
    );
  }
}

export function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Coalesce refreshes: at most one in flight, and reads skip it when the last one finished less
 * than `intervalMs` ago. Failures are logged, never thrown.
 */
export function refreshGate(
  fn: (() => Promise<void>) | undefined,
  intervalMs: number,
  log?: (message: string) => void,
): (force?: boolean) => Promise<void> {
  let last = 0;
  let inflight: Promise<void> | null = null;
  return async (force = false) => {
    if (!fn) return;
    if (inflight) return inflight;
    if (!force && Date.now() - last < intervalMs) return;
    inflight = fn()
      .catch((err: unknown) => log?.(`sync failed: ${(err as Error).message}`))
      .finally(() => {
        last = Date.now();
        inflight = null;
      });
    return inflight;
  };
}
