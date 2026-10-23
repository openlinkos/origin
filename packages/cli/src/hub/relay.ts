import {
  type RelayAnswer,
  type RelayHub,
  type RelayResult,
  relaySource,
  type SourceAdapter,
} from '@openlinkos/origin-core';
import {
  errorMessage,
  type HubSyncOptions,
  type HubSyncResult,
  hubClient,
  hubRequest,
  pullTombstones,
  pushChanges,
  recordHubSync,
} from './sync.js';

export interface RelaySyncOptions extends HubSyncOptions {
  /** The sources to relay. */
  adapters: SourceAdapter[];
}

export interface RelaySyncResult extends HubSyncResult {
  /** What was sent of each source. */
  sources: RelayResult[];
  /** Files that could not be sent this time; their cursors did not move. */
  failed: Array<{ source: string; path: string; reason: string }>;
}

/**
 * Sync a relay with its hub (see docs/architecture.md#relays): send the hub the complete lines of
 * every agent log that it does not hold yet, read straight from the logs, through the same
 * `/v1/ingest` a device pushes its mirrors with; then replicate entries and tombstones as a device
 * does. A relay writes none of its own, and the hub's tombstones find nothing to hide in it, so
 * those two steps only keep the replication cursors moving. Nothing moves while the hub cannot be
 * reached: the lines stay in the agents' logs until the next sync. When it finished, or why it
 * failed, is recorded as for a device (lastHubSync).
 */
export async function relayWithHub(opts: RelaySyncOptions): Promise<RelaySyncResult> {
  return recordHubSync(opts.db, opts.hub, () => relay(opts));
}

async function relay(opts: RelaySyncOptions): Promise<RelaySyncResult> {
  const call = hubClient(opts);
  const request = hubRequest(opts);
  const result: RelaySyncResult = {
    files: 0,
    bytes: 0,
    eventsAdded: 0,
    entriesPushed: 0,
    tombstonesPushed: 0,
    waiting: null,
    tombstonesApplied: 0,
    sources: [],
    failed: [],
  };
  const { cursors } = (await call(
    'GET',
    `/v1/cursors?device=${encodeURIComponent(opts.hub.device)}`,
  )) as { cursors: Array<{ source: string; path: string; generation: number; bytes: number }> };
  const held = new Map<string, Map<number, number>>();
  for (const c of cursors) {
    const key = `${c.source}\n${c.path}`;
    const generations = held.get(key) ?? new Map<number, number>();
    generations.set(c.generation, c.bytes);
    held.set(key, generations);
  }
  const hub: RelayHub = {
    holds: (source, path) => held.get(`${source}\n${path}`) ?? new Map(),
    async send(chunk): Promise<RelayAnswer> {
      // Offsets are in the file's content, uncompressed; the request is gzip-encoded on the way.
      const { status, text } = await request('POST', '/v1/ingest', {
        device: opts.hub.device,
        source: chunk.source,
        path: chunk.path,
        relPath: chunk.relPath,
        generation: chunk.generation,
        offset: chunk.offset,
        mtimeMs: chunk.mtimeMs,
        agentVersion: chunk.agentVersion,
        data: chunk.data.toString('base64'),
      });
      if (status === 200) {
        const r = JSON.parse(text) as {
          bytes: number;
          linesRead?: number;
          eventsAdded?: number;
          parseErrors?: number;
        };
        if (r.bytes !== chunk.offset + chunk.data.length) {
          throw new Error(`The hub acknowledged ${r.bytes} bytes of ${chunk.path}, not the chunk.`);
        }
        return {
          status: 'accepted',
          bytes: r.bytes,
          linesRead: r.linesRead ?? 0,
          eventsAdded: r.eventsAdded ?? 0,
          parseErrors: r.parseErrors ?? 0,
        };
      }
      if (status === 409) {
        const bytes = (JSON.parse(text) as { bytes?: unknown }).bytes;
        if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
          throw new Error('The hub sent an invalid cursor.');
        }
        return { status: 'conflict', bytes };
      }
      // The hub refuses this chunk (invalid, or too large): the other files still go.
      if (status === 400 || status === 413) {
        return {
          status: 'refused',
          reason: `the hub refused it (${status}): ${errorMessage(text)}`,
        };
      }
      throw new Error(`Hub request POST /v1/ingest failed (${status}): ${errorMessage(text)}`);
    },
  };

  for (const adapter of opts.adapters) {
    const r = await relaySource({ db: opts.db, log: opts.log }, adapter, hub);
    result.sources.push(r);
    result.files += r.filesChanged;
    result.bytes += r.bytes;
    result.eventsAdded += r.eventsAdded;
    for (const f of r.failed) result.failed.push({ source: adapter.id, ...f });
  }
  await pushChanges(opts, call, result);
  await pullTombstones(opts, call, result);
  return result;
}
