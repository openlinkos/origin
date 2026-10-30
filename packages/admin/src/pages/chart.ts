/**
 * A stacked column chart, drawn on the server as SVG with the design system's chart classes: no
 * script, no inline style. Series take their colour from classes (`ol-series-<slot>`, the design
 * system's chart palette), in a fixed order that keeps neighbouring segments apart for colour-blind
 * readers too. Each column carries a `<title>` with its numbers (the browser shows it on hover), the
 * chart a title and a summary for assistive technology, and a table with every number follows it,
 * folded.
 */
import type { Ctx } from '../context.js';
import { fmtCompact, fmtNumber } from '../context.js';
import { type HtmlValue, html, type SafeHtml } from '../html.js';

/** The chart palette has this many slots; more series than that share the last one. */
export const SERIES_SLOTS = 8;

export interface ChartSeries {
  key: string;
  label: string;
  /** Its colour, 1 to SERIES_SLOTS: fixed for the thing it stands for, whatever else is shown. */
  slot: number;
}

export interface ChartColumn {
  /** Under the column, for some columns only (every `labelEvery`, and the last). */
  label: string;
  /** The column's name in its title and in the table. */
  name: string;
  values: Record<string, number>;
}

/** Units per column of the plot, and its height: the plot stretches to its box (a fluid chart). */
const STEP = 24;
const H = 100;
const GAP = 1.5;
const RADIUS = 2;

/** A round number at least `n`, whose half is round too: 1, 2, 3, 4, 5, 6, 8, or 10 times a power of ten. */
export function niceCeil(n: number): number {
  if (n <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A bar segment with its top corners rounded, square where it meets the one below. */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h, w / 2);
  return `M${r1(x)} ${r1(y + h)}V${r1(y + r)}Q${r1(x)} ${r1(y)} ${r1(x + r)} ${r1(y)}H${r1(x + w - r)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + r)}V${r1(y + h)}Z`;
}

export function stackedColumns(
  ctx: Ctx,
  o: {
    id: string;
    title: string;
    summary: string;
    series: ChartSeries[];
    columns: ChartColumn[];
    labelEvery: number;
    /** The table's first heading. */
    columnHeading: string;
    totalHeading: string;
    tableLabel: string;
    /** Show the summary under the legend too, not only to assistive technology. */
    hint?: boolean;
  },
): SafeHtml {
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const slot = (k: number) => Math.min(Math.max(1, o.series[k]?.slot ?? k + 1), SERIES_SLOTS);
  const totals = o.columns.map((c) => o.series.reduce((sum, s) => sum + (c.values[s.key] ?? 0), 0));
  const max = niceCeil(Math.max(0, ...totals));
  const W = Math.max(1, o.columns.length) * STEP;
  const barW = STEP * 0.62;
  const y = (v: number) => H - (v / max) * H;
  const ticks = [max, max / 2, 0];

  const grid = ticks.map(
    (v) => html`<line class="ol-chart-grid" x1="0" x2="${W}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`,
  );

  const columns = o.columns.map((c, i) => {
    const x = i * STEP + (STEP - barW) / 2;
    const parts = o.series
      .map((s, k) => ({ s, k, v: c.values[s.key] ?? 0 }))
      .filter((p) => p.v > 0);
    let base = 0;
    const segments: HtmlValue[] = parts.map((p, j) => {
      const bottom = y(base);
      base += p.v;
      const top = y(base);
      const last = j === parts.length - 1;
      // A gap the colour of the surface parts each segment from the one above it.
      const h = Math.max(0.5, bottom - top - (last ? 0 : GAP));
      const cls = `ol-chart-bar ol-series-${slot(p.k)}`;
      return last
        ? html`<path class="${cls}" d="${topRounded(x, bottom - h, barW, h)}"/>`
        : html`<rect class="${cls}" x="${r1(x)}" y="${r1(bottom - h)}" width="${r1(barW)}" height="${r1(h)}"/>`;
    });
    const tip = [
      `${c.name}: ${n(totals[i] ?? 0)}`,
      ...parts.map((p) => `${p.s.label} ${n(p.v)}`),
    ].join('\n');
    return html`<g class="ol-chart-col"><title>${tip}</title><rect class="ol-chart-hit" x="${i * STEP}" y="0" width="${STEP}" height="${H}"/>${segments}</g>`;
  });
  // Labels under every labelEvery-th column, counted from the last, as text beside the plot.
  const labels = o.columns.map((c, i) =>
    i % o.labelEvery === (o.columns.length - 1) % o.labelEvery
      ? html`<span>${c.label}</span>`
      : html`<span></span>`,
  );

  const legend = o.series.map((s, k) => {
    const total = o.columns.reduce((sum, c) => sum + (c.values[s.key] ?? 0), 0);
    return html`<li><span class="ol-swatch ol-series-${slot(k)}" aria-hidden="true"></span><span>${s.label}</span><span class="ol-legend-value">${n(total)}</span></li>`;
  });

  return html`<figure class="ol-chart">
      <div class="ol-chart-plot">
        <div class="ol-chart-y" aria-hidden="true">${ticks.map((v) => html`<span>${fmtCompact(v, ctx.lang)}</span>`)}</div>
        <svg class="ol-chart-svg ol-chart-fluid" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-labelledby="${o.id}-title ${o.id}-desc" focusable="false">
          <title id="${o.id}-title">${o.title}</title>
          <desc id="${o.id}-desc">${o.summary}</desc>
          ${grid}
          ${columns}
          <line class="ol-chart-axis" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
        </svg>
        <div class="ol-chart-x" aria-hidden="true">${labels}</div>
      </div>
      <figcaption class="ol-chart-caption">
        <ul class="ol-legend">${legend}</ul>
        ${o.hint === false ? '' : html`<p class="ol-hint">${o.summary}</p>`}
      </figcaption>
      <details class="ol-details ol-chart-table">
        <summary>${o.tableLabel}</summary>
        <div class="ol-table-wrap"><table class="ol-table ol-table-compact">
          <thead><tr><th>${o.columnHeading}</th>${o.series.map((s) => html`<th class="ol-num">${s.label}</th>`)}<th class="ol-num">${o.totalHeading}</th></tr></thead>
          <tbody>${o.columns.map(
            (c, i) =>
              html`<tr><td class="ol-nowrap">${c.name}</td>${o.series.map((s) => html`<td class="ol-num">${n(c.values[s.key] ?? 0)}</td>`)}<td class="ol-num">${n(totals[i] ?? 0)}</td></tr>`,
          )}</tbody>
        </table></div>
      </details>
    </figure>`;
}
