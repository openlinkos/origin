/** Parse a time bound: relative `7d` `24h` `30m` `2w`, or absolute `YYYY-MM-DD` / ISO. Returns epoch ms. */
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

/**
 * ISO 8601 timestamp in the local time zone, with milliseconds and offset (e.g.
 * `2026-10-19T11:42:00.000+08:00`). Milliseconds keep times from different stores exactly
 * comparable.
 */
export function isoLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
