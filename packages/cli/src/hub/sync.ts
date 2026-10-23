import zlib from 'node:zlib';
import {
  applyTombstone,
  type Database,
  exportEntry,
  exportTombstone,
  getSetting,
  localRawFiles,
  type OwnChange,
  ownChanges,
  parseTombstoneRecord,
  type ReplicaEntry,
  readMirrorLines,
  recordedAgentVersion,
  setSetting,
  shouldSendEntry,
  type TombstoneRecord,
  unpushedOnly,
} from '@openlinkos/origin-core';
import type { HubConfig } from './config.js';

/** At most this many bytes per request, unless a single line is longer. */
const CHUNK_BYTES = 1024 * 1024;
/** Changes sent per request. */
const CHANGES_PER_REQUEST = 100;

export interface HubSyncOptions {
  db: Database;
  home: string;
  hub: HubConfig;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export interface HubSyncResult {
  /** Raw mirror files with new bytes, the bytes sent, and the events the hub parsed from them. */
  files: number;
  bytes: number;
  eventsAdded: number;
  /** Entries and tombstones of this device the hub received (again, after an interruption). */
  entriesPushed: number;
  tombstonesPushed: number;
  /** An entry the hub cannot take yet, because what it cites is not there; it is sent again later. */
  waiting: { id: string; missing: string[] } | null;
  /** Tombstones from the hub that changed something here. */
  tombstonesApplied: number;
}

/** Settings keys of a device's cursors for one hub. */
export const pushedKey = (hub: HubConfig) => `hub.pushed:${hub.url}`;
export const pulledKey = (hub: HubConfig) => `hub.pulled:${hub.url}`;
/** When the last sync with this hub finished, in milliseconds, for `origin ui`. */
export const syncedKey = (hub: HubConfig) => `hub.synced:${hub.url}`;

/**
 * Sync this device with its hub (see docs/architecture.md#personal-hub): send the raw mirror bytes
 * the hub does not have yet, then the entries and tombstones written here after the push cursor,
 * then apply the hub's tombstones after the pull cursor (invariant 2, sticky forgetting, across
 * replicas). Each cursor is saved after every successful request, so an interrupted sync resumes
 * where it stopped, and running it again is a no-op.
 */
export async function syncWithHub(opts: HubSyncOptions): Promise<HubSyncResult> {
  const call = hubClient(opts);
  const result: HubSyncResult = {
    files: 0,
    bytes: 0,
    eventsAdded: 0,
    entriesPushed: 0,
    tombstonesPushed: 0,
    waiting: null,
    tombstonesApplied: 0,
  };
  await pushMirrors(opts, call, result);
  await pushChanges(opts, call, result);
  await pullTombstones(opts, call, result);
  setSetting(opts.db, syncedKey(opts.hub), String(Date.now()));
  return result;
}

async function pushMirrors(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  const { cursors } = (await call(
    'GET',
    `/v1/cursors?device=${encodeURIComponent(opts.hub.device)}`,
  )) as { cursors: Array<{ source: string; path: string; generation: number; bytes: number }> };
  const remote = new Map(cursors.map((c) => [`${c.source}\n${c.path}\n${c.generation}`, c.bytes]));

  for (const file of localRawFiles(opts.db)) {
    let offset = remote.get(`${file.source}\n${file.path}\n${file.generation}`) ?? 0;
    if (offset >= file.bytes) continue;
    result.files++;
    let conflicts = 0;
    const agentVersion = recordedAgentVersion(opts.db, file.id);
    while (offset < file.bytes) {
      // Offsets are in the mirror's uncompressed content; the hub compresses what it stores.
      const data = readMirrorLines(opts.db, opts.home, file.id, offset, CHUNK_BYTES);
      if (data.length === 0) throw new Error(`the mirror of ${file.path} ends before its cursor`);
      const body = {
        device: opts.hub.device,
        source: file.source,
        path: file.path,
        relPath: file.relPath,
        generation: file.generation,
        offset,
        mtimeMs: file.updatedAt,
        agentVersion,
        data: data.toString('base64'),
      };
      const reply = (await call('POST', '/v1/ingest', body, [409])) as {
        bytes: number;
        eventsAdded?: number;
      };
      if (reply.eventsAdded === undefined) {
        // Offset mismatch: continue from the hub's cursor.
        if (++conflicts > 3) throw new Error(`hub keeps rejecting ${file.path}`);
        offset = reply.bytes;
        continue;
      }
      result.bytes += reply.bytes - offset;
      result.eventsAdded += reply.eventsAdded;
      offset = reply.bytes;
    }
  }
}

/** Consecutive changes of the same kind, so that each run is one request and order is kept. */
function runs(changes: OwnChange[]): OwnChange[][] {
  const out: OwnChange[][] = [];
  for (const c of changes) {
    const last = out[out.length - 1];
    if (last && last[0]?.kind === c.kind) last.push(c);
    else out.push([c]);
  }
  return out;
}

/**
 * Send the entries and tombstones written here, in the order they were written. Forgotten entries
 * are never sent. When the hub cannot take an entry yet, the cursor stops before it and later
 * entries wait too (they may depend on it), but tombstones keep going out: forgetting must not wait.
 */
export async function pushChanges(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  const key = pushedKey(opts.hub);
  let scanned = Number(getSetting(opts.db, key) ?? '0');
  let blocked = false;
  const advance = (seq: number) => {
    if (!blocked) setSetting(opts.db, key, String(seq));
  };
  for (;;) {
    const changes = ownChanges(opts.db, scanned, CHANGES_PER_REQUEST);
    if (changes.length === 0) break;
    for (const run of runs(changes)) {
      const last = (run[run.length - 1] as OwnChange).seq;
      if (run[0]?.kind === 'tombstone') {
        const tombstones = run
          .map((c) => exportTombstone(opts.db, c.id))
          .filter((t): t is TombstoneRecord => t !== null);
        await call('POST', '/v1/tombstones', { device: opts.hub.device, tombstones });
        result.tombstonesPushed += tombstones.length;
      } else if (!blocked) {
        const sent = run
          .filter((c) => shouldSendEntry(opts.db, c.id))
          .map((c) => ({ seq: c.seq, entry: exportEntry(opts.db, c.id) }))
          .filter((x): x is { seq: number; entry: ReplicaEntry } => x.entry !== null);
        if (sent.length > 0) {
          const reply = (await call('POST', '/v1/entries', {
            device: opts.hub.device,
            entries: sent.map((x) => x.entry),
          })) as { applied: number; pending: { id: string; missing: string[] } | null };
          result.entriesPushed += reply.applied;
          if (reply.pending) {
            const stuck = sent[reply.applied];
            if (!stuck) throw new Error('The hub answered an invalid entry count.');
            advance(stuck.seq - 1);
            blocked = true;
            result.waiting = reply.pending;
            opts.log?.(
              `entry ${reply.pending.id} waits for ${reply.pending.missing.join(', ')} on the hub`,
            );
          }
        }
      }
      advance(last);
      scanned = last;
    }
  }
}

export async function pullTombstones(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  // Rule 3 is left to the hub for entries it already has (see unpushedOnly).
  const judge = unpushedOnly(opts.db, Number(getSetting(opts.db, pushedKey(opts.hub)) ?? '0'));
  const key = pulledKey(opts.hub);
  let after = Number(getSetting(opts.db, key) ?? '0');
  for (;;) {
    const page = (await call(
      'GET',
      `/v1/tombstones?after=${after}&device=${encodeURIComponent(opts.hub.device)}`,
    )) as { tombstones: unknown; next: unknown; more: unknown };
    if (!Array.isArray(page.tombstones) || typeof page.next !== 'number') {
      throw new Error('The hub sent an invalid list of tombstones.');
    }
    for (const value of page.tombstones) {
      const applied = applyTombstone(opts.db, parseTombstoneRecord(value), { judge });
      if (applied.entries + applied.events > 0) result.tombstonesApplied++;
    }
    if (!Number.isSafeInteger(page.next) || page.next < after) {
      throw new Error('The hub sent an invalid tombstone cursor.');
    }
    if (page.next > after) {
      after = page.next;
      setSetting(opts.db, key, String(after));
    }
    if (page.more !== true) break;
  }
}

export type Call = (
  method: string,
  path: string,
  body?: unknown,
  okStatuses?: number[],
) => Promise<unknown>;

/** One request to the hub, with its status and body text. Throws when the hub cannot be reached. */
export type HubRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; text: string }>;

export function hubRequest(opts: HubSyncOptions): HubRequest {
  const doFetch = opts.fetch ?? fetch;
  return async (method, path, body) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.hub.token}` };
    let payload: Buffer | undefined;
    if (body !== undefined) {
      payload = zlib.gzipSync(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Encoding'] = 'gzip';
    }
    let res: Response;
    try {
      res = await doFetch(`${opts.hub.url}${path}`, { method, headers, body: payload });
    } catch (err) {
      throw new Error(`Cannot reach the hub at ${opts.hub.url}: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new Error(`The hub at ${opts.hub.url} rejected the token.`);
    return { status: res.status, text: await res.text() };
  };
}

/** The `error` of a JSON error body, or the body itself. */
export function errorMessage(text: string): string {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text; // not JSON
  }
}

export function hubClient(opts: HubSyncOptions): Call {
  const request = hubRequest(opts);
  return async (method, path, body, okStatuses = []) => {
    const { status, text } = await request(method, path, body);
    if (!(status >= 200 && status < 300) && !okStatuses.includes(status)) {
      throw new Error(`Hub request ${method} ${path} failed (${status}): ${errorMessage(text)}`);
    }
    return JSON.parse(text);
  };
}
