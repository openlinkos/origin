import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolResult, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  type Database,
  entryHistory,
  getEntry,
  isEntryForgotten,
  isoLocal,
  OriginError,
} from '@openlinkos/origin-core';
import {
  correctIn,
  forgetIn,
  type GetResult,
  getById,
  isForgotten,
  isKnown,
  rememberIn,
  type SearchResult,
  type SourceView,
  searchStore,
  sourcesOf,
  type TimelineResult,
  timelineOf,
} from './local.js';
import { type LocalFacts, mergeGet, mergeSearch, mergeSources, mergeTimeline } from './merge.js';
import { agentName, run } from './server.js';
import {
  CLOSE_TIMEOUT_MS,
  INSTRUCTIONS,
  isTimeout,
  onDisconnect,
  refreshGate,
  registerOriginTools,
  startWatch,
  type ToolArgs,
  type ToolHandlers,
  type ToolName,
  toolError,
  toolResult,
  upTo,
  WATCH_INTERVAL_MS,
  within,
} from './tools.js';

export interface ReplicaOptions {
  db: Database;
  home: string;
  /** This device's name, the store's: entries are written by `<agent>@<device>`. */
  device: string;
  /** The hub: base URL (its MCP endpoint is `<url>/mcp`) and this device's bearer token. */
  hub: { url: string; token: string };
  /** Local ingestion of all sources, injected by the CLI. */
  ingest?: () => Promise<void>;
  /** Replication with the hub (raw mirrors, entries, and tombstones up; tombstones down). */
  sync?: () => Promise<void>;
  /** Minimum time between refreshes triggered by read tools (default 10 s); writes always refresh. */
  syncIntervalMs?: number;
  /**
   * How often to look for new log lines while serving, in the background, and ingest and sync
   * them (default 60 s; 0 turns it off). See start().
   */
  watchIntervalMs?: number;
  /** Whether the logs changed since the last ingestion, cheaply; without it, every look ingests. */
  changed?: () => Promise<boolean>;
  /** How long the last ingestion and sync on disconnect may take (default 5 s). See stop(). */
  closeTimeoutMs?: number;
  /** How long a tool waits for the hub before answering from this device alone (default 2 s). */
  hubTimeoutMs?: number;
  /** How long a write that only the hub can do waits for it (default 15 s). */
  writeTimeoutMs?: number;
  version?: string;
  /** Diagnostics. Never write to stdout: it carries the protocol. */
  log?: (message: string) => void;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
}

export interface ReplicaServer {
  mcp: McpServer;
  /** Ingest local sources and sync with the hub; `force` ignores the minimum interval. */
  refresh(force?: boolean): Promise<void>;
  /**
   * Open the hub connection ahead of the first read, so it does not spend its timeout on the TLS
   * handshake and MCP initialization. Call it once the agent has initialized: the connection
   * carries the agent's name. Never throws; a failure is retried on the next read.
   */
  warm(): Promise<void>;
  /**
   * Look for new log lines every watchIntervalMs in the background: when the logs changed, ingest
   * them and sync with the hub; when they did not, retry a sync with the hub that failed.
   */
  start(): void;
  /**
   * Stop looking, then ingest and sync with the hub one last time, waiting at most closeTimeoutMs
   * (the agent is leaving). Never throws.
   */
  stop(): Promise<void>;
  /** Disconnect from the hub. */
  close(): Promise<void>;
}

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
type HubAnswer =
  | { ok: true; value: unknown }
  | { ok: true; error: string }
  | { ok: false; reason: string };

/**
 * The stdio MCP server of a device connected to a hub (see docs/architecture.md#mcp-server). It
 * serves the seven tools from the device's own store, as without a hub, and completes read tools
 * with the hub's answers: both are asked at once, the results are merged and labelled `local` or
 * `hub`, and a hub that does not answer in time is left out with a note. Writes land in the local
 * store and are then synced up; `correct` and `forget` of something only the hub has are done on
 * the hub.
 */
export function createReplicaServer(opts: ReplicaOptions): ReplicaServer {
  const { db, home } = opts;
  const interval = opts.syncIntervalMs ?? 10_000;
  const hubTimeout = opts.hubTimeoutMs ?? 2_000;
  const writeTimeout = opts.writeTimeoutMs ?? 15_000;
  const ingest = refreshGate(opts.ingest, interval, opts.log, 'ingest');
  // Whether a sync with the hub has started and not succeeded since: the next look retries it.
  let syncOwed = false;
  const syncWithHub = opts.sync;
  const sync = refreshGate(
    syncWithHub &&
      (async () => {
        syncOwed = true;
        await syncWithHub();
        syncOwed = false;
      }),
    interval,
    opts.log,
    'hub sync',
  );
  let unwatch = () => {};
  const mcp = new McpServer(
    { name: 'origin', version: opts.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const endpoint = new URL('/mcp', opts.hub.url);

  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;
  const connect = (): Promise<Client> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const c = new Client({ name: 'origin-device', version: opts.version ?? '0.0.0' });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${opts.hub.token}`,
            [CLIENT_HEADER]: headerValue(agentName(mcp)),
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
      return `the hub at ${opts.hub.url} rejected the token (HTTP 401); check it with \`origin hub status\``;
    }
    if ((err instanceof StreamableHTTPError && err.code === 403) || /\b403\b/.test(message)) {
      // A hub token works only for the device it is named after (see docs/architecture.md#access).
      return `the hub at ${opts.hub.url} refused this device's token (HTTP 403): it belongs to another device; check it with \`origin hub status\``;
    }
    return `the hub at ${opts.hub.url} is unreachable: ${message}`;
  };

  /** Ask the hub, giving up after `ms`. Never throws. */
  const askHub = async (name: ToolName, args: unknown, ms: number): Promise<HubAnswer> => {
    const started = Date.now();
    try {
      const c = await within(connect(), ms);
      const r = (await c.callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
        timeout: Math.max(1, ms - (Date.now() - started)),
      })) as CallToolResult;
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
  };

  const facts: LocalFacts = {
    known: (id) => isKnown(db, id),
    forgotten: (id) => isForgotten(db, id),
    entryStatus: (id) => {
      if (isEntryForgotten(db, id)) return 'forgotten';
      return getEntry(db, id)?.status ?? null;
    },
    versions: (root) =>
      entryHistory(db, root).map((v) => ({
        id: v.id,
        supersedes: v.supersedes,
        author: v.author,
        created: isoLocal(v.createdAt),
        status: v.status,
      })),
  };

  /** A tool result, with a second note when the hub was not consulted. */
  const answer = (value: unknown, hub: HubAnswer): CallToolResult => {
    const result = toolResult(value);
    if (!hub.ok) {
      result.content.push({
        type: 'text',
        text: `Note: the Origin hub was not consulted (${hub.reason}); these results come from this device only.`,
      });
    }
    return result;
  };

  /**
   * A read tool: ask the hub at once; meanwhile ingest local sources and give the sync with the hub
   * until the deadline (so tombstones pulled from it apply here first); then query the local store
   * and merge.
   */
  const read = async <T>(
    name: ToolName,
    args: unknown,
    local: () => T,
    merge: (mine: T | null, theirs: unknown | null, hub: HubAnswer) => CallToolResult,
  ): Promise<CallToolResult> => {
    const deadline = Date.now() + hubTimeout;
    const fromHub = askHub(name, args, hubTimeout);
    await ingest();
    await upTo(sync(), deadline);
    let mine: T | null = null;
    let localError: Error | null = null;
    try {
      mine = local();
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      localError = err;
    }
    const hub = await fromHub;
    if (localError && !(hub.ok && 'value' in hub)) {
      // Neither store can answer: the hub's own error is the more complete one.
      if (hub.ok) return toolError(hub.error);
      return toolError(`${localError.message} (The Origin hub was not consulted: ${hub.reason}.)`);
    }
    return merge(mine, hub.ok && 'value' in hub ? hub.value : null, hub);
  };

  /** After a local write: sync it up, waiting for the hub no longer than the read timeout. */
  const afterWrite = async () => {
    await upTo(sync(true), Date.now() + hubTimeout);
  };

  /** A write only the hub can do, because this device does not have `id`. */
  const onHub = async (name: ToolName, args: unknown, id: string): Promise<CallToolResult> => {
    // Push first, so that the hub has what the call cites.
    await upTo(sync(true), Date.now() + writeTimeout);
    const hub = await askHub(name, args, writeTimeout);
    if (!hub.ok) {
      return toolError(
        `${id} is not in this device's store, and ${hub.reason}. Try again when the hub is reachable.`,
      );
    }
    if ('error' in hub) return toolError(hub.error);
    await afterWrite(); // pull what the hub just forgot
    return toolResult({ ...(hub.value as object), origin: 'hub' });
  };

  const handlers: ToolHandlers = {
    search: (args) =>
      run(() =>
        read<SearchResult>(
          'search',
          args,
          () => searchStore(db, args),
          (mine, theirs, hub) =>
            answer(
              mergeSearch(
                mine ?? { entries: [], events: [] },
                theirs as SearchResult | null,
                facts,
                {
                  ranked: Boolean(args.query?.trim()),
                  limit: args.limit,
                },
              ),
              hub,
            ),
        ),
      ),
    timeline: (args) =>
      run(() =>
        read<TimelineResult>(
          'timeline',
          args,
          () => timelineOf(db, args),
          (mine, theirs, hub) =>
            answer(
              mergeTimeline(
                mine ?? (args.session ? { session: args.session, events: [] } : { sessions: [] }),
                theirs as TimelineResult | null,
                facts,
                args.limit,
              ),
              hub,
            ),
        ),
      ),
    get: (args) =>
      run(async () => {
        if (isForgotten(db, args.id)) return toolError(`${args.id} has been forgotten.`);
        return read<GetResult>(
          'get',
          args,
          () => getById(db, args.id),
          (mine, theirs, hub) => {
            const merged = mergeGet(mine, theirs as GetResult | null, facts);
            return merged ? answer(merged, hub) : toolError(`${args.id} has been forgotten.`);
          },
        );
      }),
    sources: (args) =>
      run(async () => {
        if (isForgotten(db, args.id)) return toolError(`${args.id} has been forgotten.`);
        return read<SourceView[]>(
          'sources',
          args,
          () => sourcesOf(db, home, args.id),
          (mine, theirs, hub) =>
            answer(mergeSources(mine, theirs as SourceView[] | null, facts) ?? [], hub),
        );
      }),
    remember: (args: ToolArgs<'remember'>) =>
      run(async () => {
        await ingest(true); // the cited lines may have just been written
        const result = rememberIn(db, args, `${agentName(mcp)}@${opts.device}`);
        await afterWrite();
        return toolResult({ ...result, entry: { ...result.entry, origin: 'local' } });
      }),
    correct: (args) =>
      run(async () => {
        await ingest(true);
        if (!isKnown(db, args.id)) return onHub('correct', args, args.id);
        const result = correctIn(db, args, `${agentName(mcp)}@${opts.device}`);
        await afterWrite();
        return toolResult({ ...result, entry: { ...result.entry, origin: 'local' } });
      }),
    forget: (args) =>
      run(async () => {
        if (!isKnown(db, args.id)) return onHub('forget', args, args.id);
        const result = forgetIn(db, args);
        await afterWrite();
        return toolResult(result);
      }),
  };
  registerOriginTools(mcp, handlers);

  return {
    mcp,
    refresh: async (force = false) => {
      await ingest(force);
      await sync(force);
    },
    warm: async () => {
      await connect().then(
        () => undefined,
        (err: unknown) => {
          opts.log?.(unreachable(err));
        },
      );
    },
    start: () => {
      unwatch();
      unwatch = startWatch(
        opts.watchIntervalMs ?? WATCH_INTERVAL_MS,
        async () => {
          if (!opts.changed || (await opts.changed())) {
            await ingest(true);
            await sync(true);
          } else if (syncOwed) {
            await sync(true);
          }
        },
        opts.log,
      );
    },
    stop: async () => {
      unwatch();
      const last = (async () => {
        await ingest(true);
        await sync(true);
      })();
      await upTo(last, Date.now() + (opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS));
    },
    close: disconnect,
  };
}

/**
 * Serve a connected device over stdio until the client disconnects; meanwhile, look for new log
 * lines in the background, and sync one last time when the agent leaves.
 */
export async function serveReplica(opts: ReplicaOptions): Promise<void> {
  const server = createReplicaServer(opts);
  const closed = new Promise<void>((resolve) => {
    server.mcp.server.onclose = () => resolve();
  });
  // Connect to the hub as soon as the agent has introduced itself, before its first read.
  server.mcp.server.oninitialized = () => void server.warm();
  await server.mcp.connect(new StdioServerTransport());
  onDisconnect(() => void server.mcp.close());
  void server.refresh(true);
  server.start();
  await closed;
  await server.stop();
  await server.close();
}
