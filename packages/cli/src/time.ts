/** Parse `--since` / `--until`: relative `7d` `24h` `30m` `2w`, or absolute `YYYY-MM-DD` / ISO. Returns epoch ms. */
export function parseTime(input: string | undefined, now = Date.now()): number | undefined {
  if (!input) return undefined;
  const rel = /^(\d+)\s*([mhdw])$/i.exec(input.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? 'd').toLowerCase();
    const ms =
      unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'w' ? 604_800_000 : 86_400_000;
    return now - n * ms;
  }
  const abs = Date.parse(input);
  if (Number.isNaN(abs))
    throw new Error(`Cannot parse time: ${input} (supported: 7d / 24h / 30m / 2w / YYYY-MM-DD)`);
  return abs;
}

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
