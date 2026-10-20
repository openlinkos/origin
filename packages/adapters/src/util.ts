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
