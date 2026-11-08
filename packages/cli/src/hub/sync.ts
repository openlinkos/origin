import zlib from 'node:zlib';
import {
  applyHubPurge,
  applyTombstone,
  type Database,
  exportEntry,
  exportTombstone,
  getSetting,
  type HubPurge,
  localRawFiles,
  type OwnChange,
  ownChanges,
  ownRecalls,
  PULL_TOMBSTONES_AGAIN,
  type PurgeAdapters,
  parsePurgeFeedPage,
  parseTombstoneRecord,
  type ReplicaEntry,
  readMirrorLines,
  recordedAgentVersion,
  setSetting,
  shouldSendEntry,
  type TombstoneRecord,
  unpushedOnly,
  withPurgedLinesBlanked,
} from '@openlinkos/origin-core';
import { storeAdapters } from '../sources.js';
import type { HubConfig } from './config.js';

/** At most this many bytes per request, unless a single line is longer. */
const CHUNK_BYTES = 1024 * 1024;
/** Changes sent per request. */
const CHANGES_PER_REQUEST = 100;
/** Recalls sent per request. */
const RECALLS_PER_REQUEST = 200;

export interface HubSyncOptions {
  db: Database;
  home: string;
  hub: HubConfig;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** The adapters that re-plan a hub's purges here; the store's own sources by default. */
  adapters?: PurgeAdapters;
}

export interface HubSyncResult {
  /** Raw mirror files with new bytes, the bytes sent, and the events the hub parsed from them. */
  files: number;
  bytes: number;
  eventsAdded: number;
  /**
   * Files the hub refused (400 or 413), such as those of a source of one's own that a hub of an
   * earlier version does not know: they are sent again by the next sync, and the others still go.
   */
  refused: Array<{ source: string; path: string; reason: string }>;
  /** Entries and tombstones of this device the hub received (again, after an interruption). */
  entriesPushed: number;
  tombstonesPushed: number;
  /** An entry the hub cannot take yet, because what it cites is not there; it is sent again later. */
  waiting: { id: string; missing: string[] } | null;
  /** Tombstones from the hub that changed something here. */
  tombstonesApplied: number;
  /** Recalls made here that the hub received; null if the hub does not keep recalls yet. */
  recallsPushed: number | null;
  /** The hub's purges applied here (see pullPurges). */
  purgesApplied: number;
  /**
   * A purge of the hub that could not be applied here, and why: it and the purges after it wait for
   * the next sync, and the rest of this one goes on.
   */
  purgeError: { id: string; error: string } | null;
}

/** Settings keys of a device's cursors for one hub. */
export const pushedKey = (hub: HubConfig) => `hub.pushed:${hub.url}`;
export const pulledKey = (hub: HubConfig) => `hub.pulled:${hub.url}`;
/** When this device last pulled every tombstone of a hub again (see PULL_TOMBSTONES_AGAIN). */
export const pulledAgainKey = (hub: HubConfig) => `hub.pulled-again:${hub.url}`;
/** How far a device has sent its recalls to a hub: a sequence number of its recall table. */
export const recallsKey = (hub: HubConfig) => `hub.recalls:${hub.url}`;
/** The seq of the last purge of a hub that this device applied (see pullPurges). */
export const purgesKey = (hub: HubConfig) => `hub.purges_after:${hub.url}`;
/** When the last sync with this hub finished, in milliseconds, for `origin ui` and `origin status`. */
export const syncedKey = (hub: HubConfig) => `hub.synced:${hub.url}`;
/** The last sync with this hub that failed: `{ at, error }`, as JSON. */
export const syncFailedKey = (hub: HubConfig) => `hub.sync-failed:${hub.url}`;

/** How the syncs of this device with a hub went lately, from any process. */
export interface LastHubSync {
  /** When the last sync finished, or null if none has. */
  at: number | null;
  /** The last sync that failed, if it failed after the last one finished: when, and why. */
  failure: { at: number; error: string } | null;
}

export function lastHubSync(db: Database, hub: HubConfig): LastHubSync {
  const synced = Number(getSetting(db, syncedKey(hub)));
  const at = Number.isFinite(synced) && synced > 0 ? synced : null;
  let failure: LastHubSync['failure'] = null;
  try {
    const f = JSON.parse(getSetting(db, syncFailedKey(hub)) ?? 'null') as unknown;
    if (
      typeof f === 'object' &&
      f !== null &&
      typeof (f as { at?: unknown }).at === 'number' &&
      typeof (f as { error?: unknown }).error === 'string'
    ) {
      failure = f as { at: number; error: string };
    }
  } catch {
    failure = null; // unreadable: as if none were recorded
  }
  return { at, failure: failure && (at === null || failure.at > at) ? failure : null };
}

/** Longest error kept for `origin status`. */
const MAX_ERROR_CHARS = 500;

/**
 * Run one sync with the hub, recording when it finished or, if it failed, when and why (see
 * lastHubSync). Recording a failure must not hide it: a store that cannot be written is ignored.
 */
export async function recordHubSync<T>(
  db: Database,
  hub: HubConfig,
  sync: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await sync();
  } catch (err) {
    try {
      const error = (err as Error).message.slice(0, MAX_ERROR_CHARS);
      setSetting(db, syncFailedKey(hub), JSON.stringify({ at: Date.now(), error }));
    } catch {
      // The store cannot be written: the error itself is what matters.
    }
    throw err;
  }
  setSetting(db, syncedKey(hub), String(Date.now()));
  return result;
}

/**
 * Sync this device with its hub (see docs/architecture.md#personal-hub): apply the hub's purges
 * after their cursor, so that nothing they removed is sent up again; send the raw mirror bytes the
 * hub does not have yet, then the entries and tombstones written here after the push cursor, then
 * apply the hub's tombstones after the pull cursor (invariant 2, recorded forgetting, across
 * replicas), then send the recalls made here after their cursor. Each cursor is saved after every
 * successful request, so an interrupted sync resumes where it stopped, and running it again is a
 * no-op. When it finished, or why it failed, is recorded (lastHubSync).
 */
export async function syncWithHub(opts: HubSyncOptions): Promise<HubSyncResult> {
  return recordHubSync(opts.db, opts.hub, async () => {
    const call = hubClient(opts);
    const result: HubSyncResult = {
      files: 0,
      bytes: 0,
      eventsAdded: 0,
      refused: [],
      entriesPushed: 0,
      tombstonesPushed: 0,
      waiting: null,
      tombstonesApplied: 0,
      recallsPushed: 0,
      purgesApplied: 0,
      purgeError: null,
    };
    await pullPurges(opts, call, result);
    await pushMirrors(opts, call, result);
    await pushChanges(opts, call, result);
    await pullTombstones(opts, call, result);
    await pushRecalls(opts, call, result);
    return result;
  });
}

/** The hub's byte cursor of one generation of one of this device's files. */
export interface HubCursor {
  source: string;
  path: string;
  generation: number;
  bytes: number;
}

/**
 * The hub's cursors of this device's files, or with `file`, of the generations of that one file.
 * A hub from before the filter answers with every file's: they are filtered here too.
 */
export async function hubCursors(
  call: Call,
  device: string,
  file?: { source: string; path: string },
): Promise<HubCursor[]> {
  const query = file
    ? `&source=${encodeURIComponent(file.source)}&path=${encodeURIComponent(file.path)}`
    : '';
  const { cursors } = (await call(
    'GET',
    `/v1/cursors?device=${encodeURIComponent(device)}${query}`,
  )) as { cursors: HubCursor[] };
  return file ? cursors.filter((c) => c.source === file.source && c.path === file.path) : cursors;
}

/**
 * What pushing mirrors sent: files with new bytes, the bytes, and the events the hub parsed; and
 * the files it refused.
 */
type PushCounts = Pick<HubSyncResult, 'files' | 'bytes' | 'eventsAdded' | 'refused'>;

async function pushMirrors(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  const cursors = await hubCursors(call, opts.hub.device);
  const remote = new Map(cursors.map((c) => [`${c.source}\n${c.path}\n${c.generation}`, c.bytes]));
  for (const file of localRawFiles(opts.db)) {
    const offset = remote.get(`${file.source}\n${file.path}\n${file.generation}`) ?? 0;
    await pushRawFile(opts, call, file, offset, result);
  }
}

/**
 * Push the new bytes of this store's mirror of one source file, every generation of it the hub
 * lacks bytes of, as a sync pushes each mirror. An agent's hook calls it right after it ingested
 * the file (see docs/architecture.md#live-ingestion); the entries, tombstones, and recalls written
 * here wait for the next sync.
 */
export async function pushFile(
  opts: HubSyncOptions,
  file: { source: string; path: string },
): Promise<PushCounts> {
  const call = hubClient(opts);
  const result: PushCounts = { files: 0, bytes: 0, eventsAdded: 0, refused: [] };
  const cursors = await hubCursors(call, opts.hub.device, file);
  const remote = new Map(cursors.map((c) => [c.generation, c.bytes]));
  for (const raw of localRawFiles(opts.db, file)) {
    await pushRawFile(opts, call, raw, remote.get(raw.generation) ?? 0, result);
  }
  return result;
}

/**
 * Push one mirror from `offset`, the hub's cursor, to its end, resuming where the hub stands. A file
 * the hub refuses outright (400, 413) is noted in `result.refused` and left for the next sync, as a
 * relay does, so that the other files, and then the entries and tombstones, still go.
 */
async function pushRawFile(
  opts: HubSyncOptions,
  call: Call,
  file: ReturnType<typeof localRawFiles>[number],
  from: number,
  result: PushCounts,
): Promise<void> {
  let offset = from;
  if (offset >= file.bytes) return;
  result.files++;
  let conflicts = 0;
  const agentVersion = recordedAgentVersion(opts.db, file.id);
  while (offset < file.bytes) {
    // Offsets are in the mirror's uncompressed content; the hub compresses what it stores. A line
    // a purge here removed goes blank, at its length, even before the purge has blanked the mirror.
    const data = withPurgedLinesBlanked(
      opts.db,
      opts.home,
      file.id,
      offset,
      readMirrorLines(opts.db, opts.home, file.id, offset, CHUNK_BYTES),
    );
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
    const reply = (await call('POST', '/v1/ingest', body, [400, 409, 413])) as {
      bytes: number;
      eventsAdded?: number;
      error?: unknown;
    };
    if (typeof reply.error === 'string') {
      result.refused.push({ source: file.source, path: file.path, reason: reply.error });
      opts.log?.(`the hub refused ${file.path} (${file.source}): ${reply.error}`);
      if (offset === from) result.files--; // nothing of it was sent
      return;
    }
    if (reply.eventsAdded === undefined) {
      // Offset mismatch: continue from the hub's cursor. Another process pushing the same file
      // moves it on; only a hub that answers without moving on, again and again, is an error.
      if (reply.bytes <= offset && ++conflicts > 3) {
        throw new Error(`hub keeps rejecting ${file.path}`);
      }
      offset = reply.bytes;
      continue;
    }
    result.bytes += reply.bytes - offset;
    result.eventsAdded += reply.eventsAdded;
    offset = reply.bytes;
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
 * Send the entries and tombstones (forgets and restores) written here, in the order they were
 * written. Forgotten entries are never sent; one a restore brings back is logged again, and goes
 * then. When the hub cannot take an entry yet, the cursor stops before it and later entries wait
 * too (they may depend on it), but tombstones keep going out: forgetting must not wait.
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
        // Forgets and restores this device made; a hub's forget it logged again stays here.
        const tombstones = run
          .map((c) => exportTombstone(opts.db, c.id))
          .filter((t): t is TombstoneRecord => t !== null && t.origin === opts.hub.device);
        if (tombstones.length > 0) {
          await call('POST', '/v1/tombstones', { device: opts.hub.device, tombstones });
        }
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

/**
 * The error of a hub that gives no purges: one from before purges, which has no `/v1/purges` (404),
 * or one that gives none to this token, an agent's (403). Null for a page of the feed.
 */
const noPurges = (reply: unknown): string | null =>
  typeof reply === 'object' &&
  reply !== null &&
  typeof (reply as { error?: unknown }).error === 'string' &&
  !('next' in reply)
    ? (reply as { error: string }).error
    : null;

/**
 * Apply the purges the hub made, oldest first, after this device's cursor (see applyHubPurge and
 * docs/architecture.md#purging): each comes in pages of ids and is applied whole, re-planned here
 * from what this device holds, and the cursor moves past it once it is. One that cannot be applied
 * here is left, with the cursor before it, in `result.purgeError`, and the rest of the sync goes
 * on; the next sync tries it again. A hub from before purges answers 404, and a hub gives a store
 * connected with an agent's token no purges (403): there is nothing to pull.
 */
export async function pullPurges(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  const key = purgesKey(opts.hub);
  const saved = Number(getSetting(opts.db, key) ?? '0');
  let after = Number.isSafeInteger(saved) && saved > 0 ? saved : 0;
  let offset = 0;
  let whole: HubPurge | null = null;
  let adapters: PurgeAdapters | null = null;
  for (;;) {
    const reply = await call(
      'GET',
      `/v1/purges?after=${after}&offset=${offset}&device=${encodeURIComponent(opts.hub.device)}`,
      undefined,
      [403, 404],
    );
    const none = offset === 0 ? noPurges(reply) : null;
    if (none !== null) {
      opts.log?.(`no purges from the hub: ${none}`);
      return;
    }
    const page = parsePurgeFeedPage(reply);
    const p = page.purge;
    if (p === null) {
      if (whole !== null) throw new Error(`The hub's purge ${whole.id} ended part way.`);
      return;
    }
    if (p.seq <= after || (whole !== null && whole.id !== p.id)) {
      throw new Error('The hub sent an invalid purge cursor.');
    }
    if (whole === null) whole = { ...p, items: page.items };
    else {
      for (const k of ['events', 'entries', 'sessions', 'recalls', 'files'] as const) {
        (whole.items[k] as unknown[]).push(...page.items[k]);
      }
    }
    if (page.next.offset !== 0) {
      // More of the same purge: its ids come in pages.
      if (page.next.after !== after || page.next.offset <= offset || !page.more) {
        throw new Error('The hub sent an invalid purge cursor.');
      }
      offset = page.next.offset;
      continue;
    }
    if (page.next.after !== p.seq) throw new Error('The hub sent an invalid purge cursor.');
    try {
      adapters ??= opts.adapters ?? storeAdapters(opts.home);
      if (applyHubPurge(opts.db, opts.home, adapters, whole, { log: opts.log })) {
        result.purgesApplied++;
      }
    } catch (err) {
      result.purgeError = { id: whole.id, error: (err as Error).message };
      opts.log?.(`the hub's purge ${whole.id} was not applied here: ${(err as Error).message}`);
      return;
    }
    after = p.seq;
    setSetting(opts.db, key, String(after));
    offset = 0;
    whole = null;
    if (!page.more) return;
  }
}

export async function pullTombstones(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  // Rule 3 is left to the hub for entries it already has (see unpushedOnly).
  const judge = unpushedOnly(opts.db, Number(getSetting(opts.db, pushedKey(opts.hub)) ?? '0'));
  const key = pulledKey(opts.hub);
  // The store holds events now that it did not when it pulled some forgets, which then covered
  // nothing here and were not kept: every tombstone is pulled again, once.
  const again = getSetting(opts.db, PULL_TOMBSTONES_AGAIN);
  const fromStart = again !== null && getSetting(opts.db, pulledAgainKey(opts.hub)) !== again;
  let after = fromStart ? 0 : Number(getSetting(opts.db, key) ?? '0');
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
      const changed =
        applied.entries + applied.events + applied.restored.entries + applied.restored.events;
      if (changed > 0) result.tombstonesApplied++;
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
  if (fromStart) setSetting(opts.db, pulledAgainKey(opts.hub), again);
}

/**
 * Send the recalls made here (see docs/architecture.md#recall), oldest first. A hub from before
 * recalls answers 404: they wait here, cursor and all, until it is upgraded.
 */
export async function pushRecalls(opts: HubSyncOptions, call: Call, result: HubSyncResult) {
  const key = recallsKey(opts.hub);
  let after = Number(getSetting(opts.db, key) ?? '0');
  for (;;) {
    const page = ownRecalls(opts.db, after, RECALLS_PER_REQUEST);
    if (page.length === 0) break;
    const reply = (await call(
      'POST',
      '/v1/recalls',
      { device: opts.hub.device, recalls: page.map((p) => p.recall) },
      [404],
    )) as { applied?: unknown };
    if (typeof reply.applied !== 'number') {
      result.recallsPushed = null;
      return;
    }
    result.recallsPushed = (result.recallsPushed ?? 0) + page.length;
    after = page[page.length - 1]?.seq ?? after;
    setSetting(opts.db, key, String(after));
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
    const ok = status >= 200 && status < 300;
    if (!ok && !okStatuses.includes(status)) {
      throw new Error(`Hub request ${method} ${path} failed (${status}): ${errorMessage(text)}`);
    }
    if (ok) return JSON.parse(text);
    try {
      return JSON.parse(text);
    } catch {
      // Not the hub's answer, such as a proxy's page for a body it found too large.
      return { error: `${status} ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`.trim() };
    }
  };
}
