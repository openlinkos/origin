import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOriginServer, type OriginServerOptions } from './server.js';

export interface McpHttpOptions extends Omit<OriginServerOptions, 'author'> {
  /** Author recorded on entries written by this request, e.g. `claude-code@laptop`. */
  author: string;
}

/**
 * Serve one MCP Streamable HTTP request, statelessly: a fresh server and transport per request,
 * JSON responses (no SSE), so it works behind any reverse proxy or CDN. The caller authenticates
 * the request and passes the already-parsed JSON body.
 */
export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  opts: McpHttpOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this endpoint is stateless.' },
        id: null,
      }),
    );
    return;
  }
  const { author, ...rest } = opts;
  const server = createOriginServer({ ...rest, author: () => author });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.mcp.close();
  });
  await server.mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}
