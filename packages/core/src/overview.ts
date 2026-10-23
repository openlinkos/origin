import fs from 'node:fs';
import type { Database } from './db.js';
import { frameBucket, framesPath } from './frames.js';
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
  /**
   * What the raw mirrors take on this store's disk: the open tails, and the sealed frames kept on
   * disk (all of them, unless the store keeps its frames in a bucket).
   */
  mirrorDiskBytes: number;
  /**
   * For a store that keeps its sealed frames in a bucket (see frames.ts): the bucket, and the size
   * of the frames that are no longer on disk. Frames moved without removing their file count as on
   * disk. Null for a store that keeps its frames on disk.
   */
  bucket: { location: string; frameBytes: number } | null;
  /** Free space for the store's directory, or null if the platform cannot tell. */
  freeDiskBytes: number | null;
}

/**
 * Where the raw mirrors' bytes are: on disk, and in the bucket. Without a bucket, every byte stored
 * is on disk. With one, frames sealed before the store used it stay in `<mirror>.zst` until they
 * are moved, so each mirror's frame file is looked at (one stat per mirror, only then).
 */
function mirrorPlacement(
  db: Database,
  home: string,
  storedBytes: number,
): { disk: number; bucket: StoreUsage['bucket'] } {
  const location = frameBucket(db);
  if (location === null) return { disk: storedBytes, bucket: null };
  const rows = db
    .prepare(
      `SELECT r.mirror AS mirror, r.bytes_ingested - COALESCE(c.sealed, 0) AS tail,
              COALESCE(c.frames, 0) AS frames
       FROM raw_file r
       LEFT JOIN (SELECT raw_file_id, SUM(byte_length) AS sealed, SUM(frame_length) AS frames
                  FROM raw_chunk GROUP BY raw_file_id) c ON c.raw_file_id = r.id`,
    )
    .all() as unknown as Array<{ mirror: string; tail: number; frames: number }>;
  let disk = 0;
  let inBucket = 0;
  for (const r of rows) {
    let onDisk = 0;
    if (r.frames > 0) {
      try {
        onDisk = Math.min(fs.statSync(framesPath(home, r.mirror)).size, r.frames);
      } catch {
        // no frame file: every frame of this mirror is in the bucket
      }
    }
    disk += r.tail + onDisk;
    inBucket += r.frames - onDisk;
  }
  return { disk, bucket: { location, frameBytes: inBucket } };
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
  const placement = mirrorPlacement(
    db,
    home,
    mirrors.local.storedBytes + mirrors.remote.storedBytes,
  );
  return {
    databaseBytes: pageCount * pageSize,
    walBytes,
    mirrorBytes: { local: mirrors.local.bytes, remote: mirrors.remote.bytes },
    mirrorStoredBytes: { local: mirrors.local.storedBytes, remote: mirrors.remote.storedBytes },
    mirrorDiskBytes: placement.disk,
    bucket: placement.bucket,
    freeDiskBytes,
  };
}

/** Visible events of one source and project in one time bucket (see eventActivity). */
export interface ActivityCount {
  source: string;
  /** The project of the session the events belong to. */
  project: string | null;
  /** Start of the bucket, epoch ms: a multiple of the bucket size. */
  start: number;
  events: number;
}

/** Activity is counted in buckets of 15 minutes, which every time zone's days are made of. */
export const ACTIVITY_BUCKET_MS = 15 * 60_000;

/**
 * Visible events from `since` (inclusive) to `until` (exclusive), counted per source, project, and
 * bucket of `bucketMs`, for charts of activity by day in any time zone. Cheap on a large store: it
 * reads the sessions active since `since` from the derived session table, and their events in the
 * range from the `(source, session_id, ts)` index alone, never the events themselves (the joins
 * are written to keep SQLite to that plan); forgotten events, found through excluded_event, are
 * then taken off (invariant 2).
 */
export function eventActivity(
  db: Database,
  o: { since: number; until: number; bucketMs?: number },
): ActivityCount[] {
  const size = o.bucketMs ?? ACTIVITY_BUCKET_MS;
  const params = [size, size, o.since, o.since, o.until];
  const all = db
    .prepare(
      `SELECT s.source AS source, s.project AS project, CAST(e.ts / ? AS INTEGER) * ? AS start,
              COUNT(*) AS n
       FROM session s CROSS JOIN event e INDEXED BY event_session
         ON e.source = s.source AND e.session_id = s.session_id
       WHERE s.ended_at >= ? AND e.ts >= ? AND e.ts < ?
       GROUP BY 1, 2, 3`,
    )
    .all(...params) as unknown as Array<{
    source: string;
    project: string | null;
    start: number;
    n: number;
  }>;
  const hidden = db
    .prepare(
      `SELECT s.source AS source, s.project AS project, CAST(e.ts / ? AS INTEGER) * ? AS start,
              COUNT(*) AS n
       FROM excluded_event x CROSS JOIN event e ON e.id = x.event_id
       CROSS JOIN session s ON s.source = e.source AND s.session_id = e.session_id
       WHERE s.ended_at >= ? AND e.ts >= ? AND e.ts < ?
       GROUP BY 1, 2, 3`,
    )
    .all(...params) as unknown as Array<{
    source: string;
    project: string | null;
    start: number;
    n: number;
  }>;
  const key = (r: { source: string; project: string | null; start: number }) =>
    JSON.stringify([r.source, r.project, r.start]);
  const minus = new Map(hidden.map((r) => [key(r), r.n]));
  const out: ActivityCount[] = [];
  for (const r of all) {
    const events = r.n - (minus.get(key(r)) ?? 0);
    if (events > 0) out.push({ source: r.source, project: r.project, start: r.start, events });
  }
  return out;
}

/**
 * Projects with sessions active since `since` (their latest visible event), from the derived
 * session table: how many, and when the latest was active.
 */
export function activeProjects(
  db: Database,
  o: { since: number },
): Array<{ project: string; sessions: number; lastAt: number }> {
  return db
    .prepare(
      `SELECT project, COUNT(*) AS sessions, MAX(ended_at) AS lastAt FROM session
       WHERE project IS NOT NULL AND event_count > 0 AND ended_at >= ?
       GROUP BY project ORDER BY sessions DESC, lastAt DESC`,
    )
    .all(o.since) as unknown as Array<{ project: string; sessions: number; lastAt: number }>;
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
