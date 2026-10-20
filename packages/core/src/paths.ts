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
