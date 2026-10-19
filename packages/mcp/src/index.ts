/**
 * Origin MCP server (see docs/architecture.md).
 * Placeholder for now: exports the planned tool list; the server itself is not implemented yet.
 */
export const ORIGIN_MCP_TOOLS = [
  'search',
  'timeline',
  'get',
  'sources',
  'remember',
  'correct',
  'forget',
] as const;

export type OriginMcpTool = (typeof ORIGIN_MCP_TOOLS)[number];
