/** Collapse to a single line and truncate, for table output. */
export function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Simple left-aligned table. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths: number[] = [];
  for (const r of all) {
    r.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(c));
    });
  }
  const line = (r: string[]) =>
    r
      .map((c, i) => padEnd(c, widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  return out.join('\n');
}

/** Count CJK characters as width 2 so mixed CJK/Latin text stays aligned. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x1100 && isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function padEnd(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** `1 entry`, `2 entries`. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
