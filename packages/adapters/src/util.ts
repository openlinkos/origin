import path from 'node:path';

/** Project name = last segment of cwd; handles both Windows and POSIX separators. */
export function projectFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  return last ?? null;
}

/** Truncate long tool input or output, noting how much was cut. */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

/**
 * The `/`-separated path of `absPath` relative to `root`, or null when it is not below `root`
 * (outside it, on another drive, or `root` itself). Compares paths only; reads nothing.
 */
export function relativeUnder(root: string, absPath: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  if (rel === '' || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  if (segments[0] === '..') return null;
  return segments.join('/');
}
