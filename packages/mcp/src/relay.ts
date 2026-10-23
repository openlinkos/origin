import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHubLink } from './hub-link.js';
import { agentName, run } from './server.js';
import {
  CLOSE_TIMEOUT_MS,
  INSTRUCTIONS,
  onDisconnect,
  refreshGate,
  registerOriginTools,
  startWatch,
  TOOL_NAMES,
  type ToolHandlers,
  type ToolName,
  toolError,
  toolResult,
  upTo,
  WATCH_INTERVAL_MS,
} from './tools.js';

export interface RelayServerOptions {
  /**
   * This device's name, the store's. The hub records `<agent>@<device>` as the author of what this
   * device's agents write through it.
   */
  device: string;
  /** The hub: base URL (its MCP endpoint is `<url>/mcp`) and this device's bearer token. */
  hub: { url: string; token: string };
  /** Send the agents' new log lines to the hub, and replicate with it; injected by the CLI. */
  sync?: () => Promise<void>;
  /** Minimum time between syncs triggered by read tools (default 10 s); writes always sync. */
  syncIntervalMs?: number;
  /** How often to look for new log lines in the background (default 60 s; 0 turns it off). */
  watchIntervalMs?: number;
  /** Whether the logs changed since the last sync, cheaply; without it, every look syncs. */
  changed?: () => Promise<boolean>;
  /** How long the last sync on disconnect may take (default 5 s). */
  closeTimeoutMs?: number;
  /** How long a read waits for new log lines to reach the hub before asking it (default 2 s). */
  hubTimeoutMs?: number;
  /**
   * How long a tool waits for the hub's answer, and a write for its lines to reach the hub first
   * (default 15 s). A relay has no answer of its own to fall back on.
   */
  answerTimeoutMs?: number;
  version?: string;
  /** Diagnostics. Never write to stdout: it carries the protocol. */
  log?: (message: string) => void;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
}

export interface RelayServer {
  mcp: McpServer;
  /** Send new log lines to the hub; `force` ignores the minimum interval. */
  refresh(force?: boolean): Promise<void>;
  /** Open the hub connection ahead of the first call, once the agent has initialized. Never throws. */
  warm(): Promise<void>;
  /** Look for new log lines every watchIntervalMs in the background and send them. */
  start(): void;
  /** Stop looking, and send new lines one last time, waiting at most closeTimeoutMs. Never throws. */
  stop(): Promise<void>;
  /** Disconnect from the hub. */
  close(): Promise<void>;
}

const WRITES: ReadonlySet<ToolName> = new Set(['remember', 'correct', 'forget']);

/**
 * The stdio MCP server of a relay (see docs/architecture.md#relays). A relay keeps no memory of its
 * own, so every tool is the hub's: it first sends the hub the agents' new log lines (so that an
 * agent can find, and cite, what was said a moment ago), then forwards the call to the hub's `/mcp`
 * and returns the hub's answer as it is. The hub validates and writes, and records the author as
 * `<agent>@<device>`. When the hub cannot be reached, every tool fails with a message saying so.
 */
export function createRelayServer(opts: RelayServerOptions): RelayServer {
  const interval = opts.syncIntervalMs ?? 10_000;
  const sendTimeout = opts.hubTimeoutMs ?? 2_000;
  const answerTimeout = opts.answerTimeoutMs ?? 15_000;
  // Whether a sync has started and not succeeded since: the next look retries it.
  let syncOwed = false;
  const relay = opts.sync;
  const sync = refreshGate(
    relay &&
      (async () => {
        syncOwed = true;
        await relay();
        syncOwed = false;
      }),
    interval,
    opts.log,
    'relay to the hub',
  );
  let unwatch = () => {};
  const mcp = new McpServer(
    { name: 'origin', version: opts.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const hub = createHubLink({
    url: opts.hub.url,
    token: opts.hub.token,
    device: opts.device,
    agent: () => agentName(mcp),
    version: opts.version,
    log: opts.log,
    fetch: opts.fetch,
  });

  const unavailable = (name: ToolName, reason: string): string =>
    WRITES.has(name)
      ? `This device is an Origin relay: it keeps no memory of its own, so \`${name}\` is done on its hub, but ${reason}. Nothing was changed; try again once the hub is reachable.`
      : `This device is an Origin relay: it keeps no memory of its own and answers only through its hub, but ${reason}. Try again once the hub is reachable; until then, new sessions wait in the agents' own logs.`;

  const forward = (name: ToolName) => (args: unknown) =>
    run(async (): Promise<CallToolResult> => {
      if (WRITES.has(name)) {
        // The hub must hold what the call cites, such as a line written a moment ago.
        await upTo(sync(true), Date.now() + answerTimeout);
      } else {
        await upTo(sync(), Date.now() + sendTimeout);
      }
      const answer = await hub.ask(name, args, answerTimeout);
      if (!answer.ok) return toolError(unavailable(name, answer.reason));
      if ('error' in answer) return toolError(answer.error);
      return toolResult(answer.value);
    });

  const handlers = Object.fromEntries(
    TOOL_NAMES.map((name) => [name, forward(name)]),
  ) as unknown as ToolHandlers;
  registerOriginTools(mcp, handlers);

  return {
    mcp,
    refresh: (force = false) => sync(force),
    warm: hub.warm,
    start: () => {
      unwatch();
      unwatch = startWatch(
        opts.watchIntervalMs ?? WATCH_INTERVAL_MS,
        async () => {
          if (!opts.changed || (await opts.changed()) || syncOwed) await sync(true);
        },
        opts.log,
      );
    },
    stop: async () => {
      unwatch();
      await upTo(sync(true), Date.now() + (opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS));
    },
    close: hub.close,
  };
}

/**
 * Serve a relay over stdio until the client disconnects; meanwhile, send new log lines to the hub
 * in the background, and once more when the agent leaves.
 */
export async function serveRelay(opts: RelayServerOptions): Promise<void> {
  const server = createRelayServer(opts);
  const closed = new Promise<void>((resolve) => {
    server.mcp.server.onclose = () => resolve();
  });
  server.mcp.server.oninitialized = () => void server.warm();
  await server.mcp.connect(new StdioServerTransport());
  onDisconnect(() => void server.mcp.close());
  void server.refresh(true);
  server.start();
  await closed;
  await server.stop();
  await server.close();
}
