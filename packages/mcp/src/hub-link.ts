import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type CallToolResult, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isTimeout, type ToolName, within } from './tools.js';

/** Header carrying the name of the agent behind a device, recorded in the entry author. */
export const CLIENT_HEADER = 'X-Origin-Client';
/**
 * Header carrying the device's name. The hub records its token's name as the device; it refuses a
 * request whose header names another device, so a misconfigured device fails visibly.
 */
export const DEVICE_HEADER = 'X-Origin-Device';

/** HTTP header values must be visible ASCII. */
function headerValue(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 100) || 'mcp';
}

/** The hub's answer to a tool call, or why it was not consulted. */
export type HubAnswer =
  | { ok: true; value: unknown }
  | { ok: true; error: string }
  | { ok: false; reason: string };

export interface HubLinkOptions {
  /** The hub's base URL; its MCP endpoint is `<url>/mcp`. */
  url: string;
  /** This device's bearer token. */
  token: string;
  /** This device's name, sent in X-Origin-Device. */
  device: string;
  /** The agent behind this device, sent in X-Origin-Client when the connection opens. */
  agent: () => string;
  version?: string;
  log?: (message: string) => void;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
}

/** A device's MCP connection to its hub's `/mcp`, opened on first use and reopened after a failure. */
export interface HubLink {
  /** Call a tool on the hub, giving up after `ms`. Never throws. */
  ask(name: ToolName, args: unknown, ms: number): Promise<HubAnswer>;
  /** Open the connection ahead of the first call. Never throws; a failure is retried on the next call. */
  warm(): Promise<void>;
  close(): Promise<void>;
}

export function createHubLink(opts: HubLinkOptions): HubLink {
  const endpoint = new URL('/mcp', opts.url);
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;
  const connect = (): Promise<Client> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const c = new Client({ name: 'origin-device', version: opts.version ?? '0.0.0' });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${opts.token}`,
            [CLIENT_HEADER]: headerValue(opts.agent()),
            [DEVICE_HEADER]: headerValue(opts.device),
          },
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

  const unreachable = (err: unknown): string => {
    const message = (err as Error)?.message ?? String(err);
    if ((err instanceof StreamableHTTPError && err.code === 401) || /\b401\b/.test(message)) {
      return `the hub at ${opts.url} rejected the token (HTTP 401); check it with \`origin hub status\``;
    }
    if ((err instanceof StreamableHTTPError && err.code === 403) || /\b403\b/.test(message)) {
      // A hub token works only for the device it is named after (see docs/architecture.md#access).
      return `the hub at ${opts.url} refused this device's token (HTTP 403): it belongs to another device; check it with \`origin hub status\``;
    }
    return `the hub at ${opts.url} is unreachable: ${message}`;
  };

  return {
    async ask(name, args, ms) {
      const started = Date.now();
      try {
        const c = await within(connect(), ms);
        const r = (await c.callTool(
          { name, arguments: args as Record<string, unknown> },
          undefined,
          { timeout: Math.max(1, ms - (Date.now() - started)) },
        )) as CallToolResult;
        const text = r.content?.[0]?.type === 'text' ? r.content[0].text : '';
        if (r.isError) return { ok: true, error: text };
        return { ok: true, value: JSON.parse(text) };
      } catch (err) {
        if (isTimeout(err) || (err instanceof McpError && err.code === -32001)) {
          return { ok: false, reason: `no answer within ${ms / 1000} s` };
        }
        // A JSON-RPC error from the hub is not a transport failure: keep the connection.
        if (err instanceof McpError) return { ok: false, reason: `the hub failed: ${err.message}` };
        await disconnect();
        const reason = unreachable(err);
        opts.log?.(reason);
        return { ok: false, reason };
      }
    },
    async warm() {
      await connect().then(
        () => undefined,
        (err: unknown) => {
          opts.log?.(unreachable(err));
        },
      );
    },
    close: disconnect,
  };
}
