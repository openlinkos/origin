import fs from 'node:fs';
import type { Database } from './db.js';
import { mirrorUsage } from './mirror.js';
import { dbPath, remotePath } from './paths.js';

/** Disk usage of a store (see docs/architecture.md#storage). */
export interface StoreUsage {
  /** The SQLite database file: page count × page size. */
  databaseBytes: number;
  /** The write-ahead log next to it. */
  walBytes: number;
  /** Raw mirror bytes ingested (uncompressed): this store's own files, and files replicated from devices. */
  mirrorBytes: { local: number; remote: number };
  /** What those mirrors take on disk, compressed (see mirror.ts). */
  mirrorStoredBytes: { local: number; remote: number };
  /** Free space for the store's directory, or null if the platform cannot tell. */
  freeDiskBytes: number | null;
}

export function storeUsage(db: Database, home: string): StoreUsage {
  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  let walBytes = 0;
  try {
    walBytes = fs.statSync(`${dbPath(home)}-wal`).size;
  } catch {
    // no WAL file (in-memory database, or checkpointed and removed)
  }
  const mirrors = mirrorUsage(db);
  let freeDiskBytes: number | null = null;
  try {
    const s = fs.statfsSync(home);
    freeDiskBytes = s.bavail * s.bsize;
  } catch {
    // unsupported, or the directory does not exist yet
  }
  return {
    databaseBytes: pageCount * pageSize,
    walBytes,
    mirrorBytes: { local: mirrors.local.bytes, remote: mirrors.remote.bytes },
    mirrorStoredBytes: { local: mirrors.local.storedBytes, remote: mirrors.remote.storedBytes },
    freeDiskBytes,
  };
}

/** Ingestion results per source and device over a period, from the sync log. */
export interface IngestHealth {
  source: string;
  /** The device a hub received the lines from; null for this store's own syncs. */
  device: string | null;
  runs: number;
  linesRead: number;
  eventsAdded: number;
  parseErrors: number;
  lastAt: number | null;
}

/** Sync log totals since `since` (epoch ms), grouped by source and device. */
export function ingestHealth(
  db: Database,
  opts: { since: number; device?: string },
): IngestHealth[] {
  const params: Array<string | number> = [opts.since];
  let where = 'finished_at >= ?';
  if (opts.device !== undefined) {
    where += " AND note = 'device ' || ?";
    params.push(opts.device);
  }
  // Hub appends record `device <name>` as their note (see appendRemote).
  const rows = db
    .prepare(
      `SELECT source,
              CASE WHEN note LIKE 'device %' THEN substr(note, 8) ELSE NULL END AS device,
              COUNT(*) AS runs, SUM(lines_read) AS lines_read, SUM(events_added) AS events_added,
              SUM(parse_errors) AS parse_errors, MAX(finished_at) AS last_at
       FROM sync_log WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .all(...params) as unknown as Array<{
    source: string;
    device: string | null;
    runs: number;
    lines_read: number;
    events_added: number;
    parse_errors: number;
    last_at: number | null;
  }>;
  return rows.map((r) => ({
    source: r.source,
    device: r.device,
    runs: r.runs,
    linesRead: r.lines_read,
    eventsAdded: r.events_added,
    parseErrors: r.parse_errors,
    lastAt: r.last_at,
  }));
}

/** A file a device has replicated to this hub. */
export interface DeviceFile {
  source: string;
  /** The file's path on the device. */
  originalPath: string;
  generation: number;
  bytes: number;
  lines: number;
  firstSeenAt: number;
  updatedAt: number;
}

/** Files replicated from `device`, most recently updated first. */
export function deviceFiles(db: Database, device: string): DeviceFile[] {
  const prefix = remotePath(device, '');
  const rows = db
    .prepare(
      `SELECT source, path, generation, bytes_ingested, lines_ingested, first_seen_at, updated_at
       FROM raw_file WHERE substr(path, 1, ?) = ? ORDER BY updated_at DESC, path, generation`,
    )
    .all(prefix.length, prefix) as unknown as Array<{
    source: string;
    path: string;
    generation: number;
    bytes_ingested: number;
    lines_ingested: number;
    first_seen_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    source: r.source,
    originalPath: r.path.slice(prefix.length),
    generation: r.generation,
    bytes: r.bytes_ingested,
    lines: r.lines_ingested,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
  }));
}
