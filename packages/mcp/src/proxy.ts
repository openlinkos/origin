import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolResult, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  INSTRUCTIONS,
  refreshGate,
  registerOriginTools,
  TOOL_NAMES,
  type ToolHandlers,
  type ToolName,
  toolError,
  WRITE_TOOLS,
} from './tools.js';

export interface ProxyOptions {
  /** Hub base URL; the MCP endpoint is `<url>/mcp`. */
  url: string;
  /** Bearer token issued by the hub (`origin token create`). */
  token: string;
  /** Local sync and push, injected by the CLI. Runs before tool calls (see `syncIntervalMs`). */
  refresh?: () => Promise<void>;
  /** Minimum time between refreshes triggered by read tools (default 10 s); writes always refresh. */
  syncIntervalMs?: number;
  version?: string;
  /** Diagnostics. Never write to stdout: it carries the protocol. */
  log?: (message: string) => void;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
}

export interface ProxyServer {
  mcp: McpServer;
  /** Run the refresh gate; `force` ignores the minimum interval. */
  refresh(force?: boolean): Promise<void>;
  /** Disconnect from the hub. */
  close(): Promise<void>;
}

/** Header carrying the name of the agent behind a forwarding proxy, recorded as entry author. */
export const CLIENT_HEADER = 'X-Origin-Client';

/** HTTP header values must be visible ASCII. */
function headerValue(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 100) || 'mcp';
}

/**
 * A stdio MCP server for a device connected to a hub: same tools, each call refreshes local
 * archives (sync and push) and is then forwarded to the hub unchanged.
 */
export function createProxyServer(opts: ProxyOptions): ProxyServer {
  const endpoint = new URL('/mcp', opts.url);
  const refresh = refreshGate(opts.refresh, opts.syncIntervalMs ?? 10_000, opts.log);
  const mcp = new McpServer(
    { name: 'origin', version: opts.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );

  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  const connect = (): Promise<Client> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const agent = mcp.server.getClientVersion()?.name ?? 'mcp';
      const c = new Client({ name: 'origin-proxy', version: opts.version ?? '0.0.0' });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${opts.token}`, [CLIENT_HEADER]: headerValue(agent) },
        },
        fetch: opts.fetch,
      });
      await c.connect(transport);
      client = c;
      return c;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const disconnect = async (): Promise<void> => {
    const c = client;
    client = null;
    await c?.close().catch(() => {});
  };

  const describe = (err: unknown): string => {
    const message = (err as Error)?.message ?? String(err);
    if ((err instanceof StreamableHTTPError && err.code === 401) || /\b401\b/.test(message)) {
      return `Origin hub at ${opts.url} rejected the token (HTTP 401). Check it with \`origin hub status\`.`;
    }
    return `Origin hub unreachable at ${opts.url}: ${message}`;
  };

  const forward =
    (name: ToolName) =>
    async (args: unknown): Promise<CallToolResult> => {
      await refresh(WRITE_TOOLS.has(name));
      try {
        const c = await connect();
        return (await c.callTool({
          name,
          arguments: args as Record<string, unknown>,
        })) as CallToolResult;
      } catch (err) {
        // A JSON-RPC error from the hub is not a transport failure: keep the connection.
        if (err instanceof McpError) return toolError(`Origin hub error: ${err.message}`);
        await disconnect();
        opts.log?.(describe(err));
        return toolError(describe(err));
      }
    };

  const handlers = Object.fromEntries(
    TOOL_NAMES.map((name) => [name, forward(name)]),
  ) as unknown as ToolHandlers;
  registerOriginTools(mcp, handlers);

  return { mcp, refresh, close: disconnect };
}

/** Serve the forwarding proxy over stdio until the client disconnects. */
export async function serveStdioProxy(opts: ProxyOptions): Promise<void> {
  const proxy = createProxyServer(opts);
  const closed = new Promise<void>((resolve) => {
    proxy.mcp.server.onclose = () => resolve();
  });
  await proxy.mcp.connect(new StdioServerTransport());
  process.stdin.once('end', () => void proxy.mcp.close());
  void proxy.refresh(true);
  await closed;
  await proxy.close();
}
