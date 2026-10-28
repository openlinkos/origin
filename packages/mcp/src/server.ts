import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from '@openlinkos/origin-core';
import {
  briefIn,
  correctIn,
  forgetIn,
  getById,
  rememberIn,
  searchStore,
  sourcesOf,
  timelineOf,
} from './local.js';
import {
  CLOSE_TIMEOUT_MS,
  INSTRUCTIONS,
  onDisconnect,
  refreshGate,
  registerOriginTools,
  startWatch,
  type ToolHandlers,
  toolError,
  toolResult,
  upTo,
  WATCH_INTERVAL_MS,
} from './tools.js';

export interface OriginServerOptions {
  db: Database;
  home: string;
  /** Incremental ingestion of all sources; injected so that this package depends only on core. */
  sync?: () => Promise<void>;
  /** Minimum time between syncs triggered by read tools (default 10 s). */
  syncIntervalMs?: number;
  /**
   * How often to look for new log lines while serving, in the background, and ingest them
   * (default 60 s; 0 turns it off). See start().
   */
  watchIntervalMs?: number;
  /** Whether the logs changed since the last ingestion, cheaply; without it, every look ingests. */
  changed?: () => Promise<boolean>;
  /** How long the last ingestion on disconnect may take (default 5 s). See stop(). */
  closeTimeoutMs?: number;
  version?: string;
  /** Diagnostics. Never write to stdout: it carries the protocol. */
  log?: (message: string) => void;
  /**
   * The device this server runs on (the store's name): entries are written by `<agent>@<device>`.
   * Ignored when `author` is given.
   */
  device?: string;
  /** Author recorded on entries; defaults to `<agent>@<device>`, the agent being the MCP client. */
  author?: () => string;
  /**
   * The directory this server runs in, on the agent's machine: `brief` is for it unless the agent
   * says otherwise, and finds its work tree on disk. A hub has none (see briefIn).
   */
  cwd?: string;
}

export interface OriginServer {
  mcp: McpServer;
  /** Bring the archive up to date; `force` ignores the minimum interval. */
  refresh(force?: boolean): Promise<void>;
  /** Look for new log lines every watchIntervalMs in the background, and ingest them. */
  start(): void;
  /** Stop looking, and ingest one last time, waiting at most closeTimeoutMs. Never throws. */
  stop(): Promise<void>;
}

/** Run a tool body; caller errors (bad ids, bad input) come back as tool errors, not crashes. */
export async function run(
  body: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    return toolError((err as Error).message);
  }
}

/** The name of the connected agent, from its MCP client info. */
export function agentName(mcp: McpServer): string {
  return mcp.server.getClientVersion()?.name ?? 'mcp';
}

/** Tool implementations against a local store. */
function localHandlers(
  db: Database,
  home: string,
  refresh: (force?: boolean) => Promise<void>,
  author: () => string,
  here: string | null,
): ToolHandlers {
  return {
    brief: (args) =>
      run(async () => {
        await refresh();
        return toolResult(briefIn(db, args, author(), here));
      }),
    search: (args) =>
      run(async () => {
        await refresh();
        return toolResult(searchStore(db, args));
      }),
    timeline: (args) =>
      run(async () => {
        await refresh();
        return toolResult(timelineOf(db, args));
      }),
    get: (args) => run(() => toolResult(getById(db, args.id))),
    sources: (args) => run(() => toolResult(sourcesOf(db, home, args.id))),
    remember: (args) =>
      run(async () => {
        await refresh(true); // the cited lines may have just been written
        return toolResult(rememberIn(db, args, author()));
      }),
    correct: (args) =>
      run(async () => {
        await refresh(true);
        return toolResult(correctIn(db, args, author()));
      }),
    forget: (args) => run(() => toolResult(forgetIn(db, args, author()))),
  };
}

export function createOriginServer(opts: OriginServerOptions): OriginServer {
  const refresh = refreshGate(opts.sync, opts.syncIntervalMs ?? 10_000, opts.log);
  const mcp = new McpServer(
    { name: 'origin', version: opts.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const author =
    opts.author ?? (() => (opts.device ? `${agentName(mcp)}@${opts.device}` : agentName(mcp)));
  registerOriginTools(mcp, localHandlers(opts.db, opts.home, refresh, author, opts.cwd ?? null));
  let unwatch = () => {};
  return {
    mcp,
    refresh,
    start: () => {
      unwatch();
      unwatch = startWatch(
        opts.watchIntervalMs ?? WATCH_INTERVAL_MS,
        async () => {
          if (!opts.changed || (await opts.changed())) await refresh(true);
        },
        opts.log,
      );
    },
    stop: async () => {
      unwatch();
      await upTo(refresh(true), Date.now() + (opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS));
    },
  };
}

/**
 * Serve over stdio until the client disconnects; meanwhile, look for new log lines in the
 * background, and ingest one last time when the agent leaves.
 */
export async function serveStdio(opts: OriginServerOptions): Promise<void> {
  const server = createOriginServer({ ...opts, cwd: opts.cwd ?? process.cwd() });
  const closed = new Promise<void>((resolve) => {
    server.mcp.server.onclose = () => resolve();
  });
  await server.mcp.connect(new StdioServerTransport());
  onDisconnect(() => void server.mcp.close());
  void server.refresh(true);
  server.start();
  await closed;
  await server.stop();
}
