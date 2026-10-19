import os from 'node:os';
import path from 'node:path';

/** User data root: `ORIGIN_HOME` or `~/.origin` (invariant 4, local-first, see docs/architecture.md). */
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
