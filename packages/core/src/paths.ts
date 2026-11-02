import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** User data root: `ORIGIN_HOME` or `~/.origin` (invariant 4, your data on your machines, see docs/architecture.md). */
export function originHome(): string {
  const env = process.env.ORIGIN_HOME;
  return env && env.length > 0 ? env : path.join(os.homedir(), '.origin');
}

export function dbPath(home: string = originHome()): string {
  return path.join(home, 'origin.db');
}

export function rawDir(home: string = originHome()): string {
  return path.join(home, 'raw');
}

/**
 * Where a person's own sources are, one directory each, named after the source: `<home>/sources`
 * (see docs/sources.md#your-own-sources-event-lines).
 */
export function sourcesDir(home: string = originHome()): string {
  return path.join(home, 'sources');
}

/**
 * raw_file path of a file replicated from a device to a hub: `@<device>:<original path>`. Local
 * paths never start with `@`, and device names cannot contain `:`.
 */
export function remotePath(device: string, originalPath: string): string {
  return `@${device}:${originalPath}`;
}

/** Split a raw_file path into its device (null for local files) and the original path. */
export function parseRawPath(rawPath: string): { device: string | null; originalPath: string } {
  if (!rawPath.startsWith('@')) return { device: null, originalPath: rawPath };
  const colon = rawPath.indexOf(':');
  if (colon < 0) return { device: null, originalPath: rawPath };
  return { device: rawPath.slice(1, colon), originalPath: rawPath.slice(colon + 1) };
}

/**
 * What sets a raw file's mirror apart when its usual name is another file's (see ingest.ts):
 * `.~` and the first 12 hex digits of the SHA-256 of its raw_file path, the original path on this
 * store or `@<device>:<path>` on a hub, so that the same file always gets the same name.
 */
function mirrorMark(rawPath: string): string {
  return `.~${createHash('sha256').update(rawPath).digest('hex').slice(0, 12)}`;
}

/**
 * The relative path of a file whose mirror would have another file's name, as its mirror is named:
 * with the file's mark (see mirrorMark) before the extension of its last part, such as
 * `proj/s1.~3f9a1c2b4d5e.jsonl`, or at its end if it has none.
 */
export function distinctRelPath(relPath: string, rawPath: string): string {
  const mark = mirrorMark(rawPath);
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  return dot > slash + 1
    ? `${relPath.slice(0, dot)}${mark}${relPath.slice(dot)}`
    : `${relPath}${mark}`;
}

/**
 * The path, relative to its adapter's root, that a raw file's mirror is named after: the mirror is
 * `<source>/<relPath>[.g<generation>]` for this store's own files, and
 * `devices/<device>/<source>/<relPath>[.g<generation>]` for a device's on a hub (see ingest.ts),
 * with the file's mark in the relative path if it was given a name of its own (see
 * distinctRelPath), which this removes.
 */
export function mirrorRelPath(r: {
  source: string;
  path: string;
  generation: number;
  mirror: string;
}): string {
  let rel = r.mirror.replace(/\\/g, '/');
  if (r.path.startsWith('@')) rel = rel.replace(/^devices\/[^/]+\//, '');
  if (rel.startsWith(`${r.source}/`)) rel = rel.slice(r.source.length + 1);
  const suffix = `.g${r.generation}`;
  if (r.generation > 1 && rel.endsWith(suffix)) rel = rel.slice(0, -suffix.length);
  const mark = mirrorMark(r.path);
  const at = rel.lastIndexOf(mark);
  if (at > rel.lastIndexOf('/')) rel = rel.slice(0, at) + rel.slice(at + mark.length);
  return rel;
}
