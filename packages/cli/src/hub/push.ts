import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  applyRemoteTombstone,
  type Database,
  getSetting,
  localRawFiles,
  setSetting,
  type TombstoneRecord,
} from '@openlinkos/origin-core';
import type { HubConfig } from './config.js';

/** At most this many bytes per request, unless a single line is longer. */
const CHUNK_BYTES = 1024 * 1024;

export interface PushOptions {
  db: Database;
  home: string;
  hub: HubConfig;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export interface PushResult {
  files: number;
  bytes: number;
  eventsAdded: number;
  tombstonesApplied: number;
}

/**
 * Replicate this device to its hub: send the raw mirror bytes the hub does not have yet, then apply
 * the hub's new tombstones locally (invariant 2, sticky forgetting, across replicas).
 */
export async function pushToHub(opts: PushOptions): Promise<PushResult> {
  const call = hubClient(opts);
  const result: PushResult = { files: 0, bytes: 0, eventsAdded: 0, tombstonesApplied: 0 };

  const { cursors } = (await call(
    'GET',
    `/v1/cursors?device=${encodeURIComponent(opts.hub.device)}`,
  )) as { cursors: Array<{ source: string; path: string; generation: number; bytes: number }> };
  const remote = new Map(cursors.map((c) => [`${c.source}\n${c.path}\n${c.generation}`, c.bytes]));

  for (const file of localRawFiles(opts.db, opts.home)) {
    let offset = remote.get(`${file.source}\n${file.path}\n${file.generation}`) ?? 0;
    if (offset >= file.bytes) continue;
    result.files++;
    const fd = fs.openSync(file.mirrorPath, 'r');
    try {
      let conflicts = 0;
      while (offset < file.bytes) {
        const data = readLines(fd, offset, file.bytes);
        const body = {
          device: opts.hub.device,
          source: file.source,
          path: file.path,
          relPath: file.relPath,
          generation: file.generation,
          offset,
          mtimeMs: file.updatedAt,
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
    } finally {
      fs.closeSync(fd);
    }
  }

  const key = `hub.tombstones:${opts.hub.url}`;
  let after = Number(getSetting(opts.db, key) ?? '0');
  for (;;) {
    const { tombstones } = (await call('GET', `/v1/tombstones?after=${after}`)) as {
      tombstones: TombstoneRecord[];
    };
    if (tombstones.length === 0) break;
    for (const t of tombstones) {
      const applied = applyRemoteTombstone(opts.db, t, 'hub');
      if (applied.entries + applied.events > 0) result.tombstonesApplied++;
      after = t.id;
    }
    setSetting(opts.db, key, String(after));
  }
  return result;
}

/** Complete lines starting at `offset`: up to CHUNK_BYTES, or one longer line. */
function readLines(fd: number, offset: number, end: number): Buffer {
  let size = Math.min(CHUNK_BYTES, end - offset);
  for (;;) {
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, offset);
    const chunk = buf.subarray(0, n);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl >= 0) return chunk.subarray(0, lastNl + 1);
    if (offset + n >= end) throw new Error('mirror does not end with a newline');
    size = Math.min(size * 2, end - offset);
  }
}

type Call = (
  method: string,
  path: string,
  body?: unknown,
  okStatuses?: number[],
) => Promise<unknown>;

function hubClient(opts: PushOptions): Call {
  const doFetch = opts.fetch ?? fetch;
  return async (method, path, body, okStatuses = []) => {
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
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // not JSON
      }
      throw new Error(`Hub request ${method} ${path} failed (${res.status}): ${message}`);
    }
    return JSON.parse(text);
  };
}
