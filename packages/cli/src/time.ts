const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
}
