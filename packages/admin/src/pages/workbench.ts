/**
 * The parts the workbench's pages share, as markup of the design system's workbench (see
 * workbench.css and filter.css in @openlinkos/ui): facts about a thing, agents and kinds in their
 * colour, the filters of a list and its filter bar, chips and menus of links, the histogram above
 * a list and the pager below it, panels, and small charts. Every filter is a link to the same page
 * with one parameter changed, so the pages work without a script.
 */
import type { EntryKind } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { fmtNumber } from '../context.js';
import { type HtmlValue, html, type SafeHtml } from '../html.js';
import { type IconName, icon } from '../icons.js';

/** The agents Origin reads, each with its slot in the chart palette, kept apart for colour-blind readers too. */
const AGENT_SLOTS: Record<string, number> = {
  'claude-code': 1,
  grok: 2,
  codex: 3,
  zcode: 5,
  cursor: 6,
};

/** An agent's slot in the chart palette: its own for the agents Origin reads, a shared one otherwise. */
export function agentSlot(source: string): number {
  return AGENT_SLOTS[source] ?? 7;
}

/** A name with a swatch in its series' colour. */
function swatched(slot: number, text: HtmlValue): SafeHtml {
  return html`<span class="ol-legend-item ol-series-${slot}"><span class="ol-swatch" aria-hidden="true"></span>${text}</span>`;
}

/** An agent: a square in its colour, and its name in plain text. */
export function agentTag(source: string): SafeHtml {
  return swatched(agentSlot(source), source);
}

/** The kinds of entries, each with its slot in the chart palette. */
export const KIND_SLOTS: Record<EntryKind, number> = { memory: 1, knowledge: 3, cognition: 4 };

/** A kind of entry: a square in its colour, and its name. */
export function kindTag(ctx: Ctx, kind: EntryKind): SafeHtml {
  return swatched(KIND_SLOTS[kind], ctx.t(`kind.${kind}`));
}

export type Fact = { icon?: IconName; label?: string; value: HtmlValue } | null | false;

/** Facts about the thing a page shows, each with an icon or a label: the line under its title. */
export function facts(ctx: Ctx, items: Fact[]): SafeHtml {
  return html`<ul class="ol-page-meta">${items
    .filter((i): i is Exclude<Fact, null | false> => !!i)
    .map(
      (i) =>
        html`<li>${i.icon ? icon(ctx, i.icon, 'sm') : ''}${i.label ? html`<span>${i.label}</span>` : ''}<b>${i.value}</b></li>`,
    )}</ul>`;
}

/** The values of a repeated query parameter. */
export function queryAll(ctx: Ctx, name: string): string[] {
  return ctx.url.searchParams.getAll(name).filter((v) => v !== '');
}

/**
 * The current page with some parameters changed: a value set, a list of values, or none (removed).
 * The page goes back to the first, since what it shows changes.
 */
export function withParams(ctx: Ctx, changes: Record<string, string | string[] | null>): string {
  const params = new URLSearchParams(ctx.url.searchParams);
  params.delete('page');
  for (const [name, value] of Object.entries(changes)) {
    params.delete(name);
    if (value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(name, v);
  }
  const qs = params.toString();
  return qs ? `${ctx.url.pathname}?${qs}` : ctx.url.pathname;
}

/** A list with a value added, or removed if it holds it. */
export function toggled(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

export interface FacetItem {
  label: HtmlValue;
  count: number;
  checked: boolean;
  href: string;
}

/** A group of a list's filters: its title, a way to clear it, and its values with their counts. */
export function facetGroup(
  ctx: Ctx,
  o: { title: string; clear?: string | null; items: FacetItem[]; more?: number },
): SafeHtml {
  return html`<section class="ol-facet-group">
    <h2 class="ol-facet-head">${o.title}${o.clear ? html`<a href="${o.clear}">${ctx.t('facet.clear')}</a>` : ''}</h2>
    <ul class="ol-facet-list">${o.items.map(
      (i) =>
        html`<li><a class="ol-facet" href="${i.href}"${i.checked ? html` aria-current="true"` : ''}><span class="ol-facet-check" aria-hidden="true">${icon(ctx, 'check', 'sm')}</span><span class="ol-facet-label">${i.label}</span><span class="ol-facet-count">${fmtNumber(i.count, ctx.lang)}</span></a></li>`,
    )}</ul>
    ${o.more ? html`<span class="ol-facet-more">${ctx.t('facet.more', { n: fmtNumber(o.more, ctx.lang) })}</span>` : ''}
  </section>`;
}

/**
 * The filters of a list, written once: beside the list where there is room, in a sheet that the
 * filter bar's button opens where there is not (the design system's .ol-layout-filters).
 */
export function facetPane(ctx: Ctx, groups: HtmlValue): SafeHtml {
  const t = ctx.t;
  return html`<aside class="ol-sheet ol-facets" id="filters" popover aria-label="${t('facet.label')}">
    <div class="ol-sheet-head"><h2 class="ol-sheet-title">${t('facet.label')}</h2><button type="button" class="ol-btn ol-btn-ghost ol-btn-icon ol-btn-sm" popovertarget="filters" popovertargetaction="hide" aria-label="${t('action.close')}">${icon(ctx, 'x', 'sm')}</button></div>
    ${groups}
  </aside>`;
}

/** The filter bar's button that opens the filters in their sheet, with how many are on. */
export function facetButton(ctx: Ctx, on: number): SafeHtml {
  return html`<button type="button" class="ol-btn ol-btn-secondary ol-btn-sm ol-sheet-open" popovertarget="filters">${icon(ctx, 'list-filter', 'sm')}${ctx.t('facet.label')}${on > 0 ? html`<span class="ol-count">${fmtNumber(on, ctx.lang)}</span>` : ''}</button>`;
}

/** Filters that are on, as tags that each remove theirs. */
export function filterTags(ctx: Ctx, tags: Array<{ label: HtmlValue; href: string }>): SafeHtml {
  return html`${tags.map(
    (g) =>
      html`<a class="ol-filter-tag" href="${g.href}" title="${ctx.t('facet.remove')}"><span>${g.label}</span>${icon(ctx, 'x', 'sm')}</a>`,
  )}`;
}

/** Chips of links, one of them current, each with a count if given. */
export function linkChips(
  ctx: Ctx,
  items: Array<{ label: HtmlValue; href: string; current: boolean; count?: number }>,
): SafeHtml {
  return html`<div class="ol-cluster">${items.map(
    (i) =>
      html`<a class="ol-chip" href="${i.href}"${i.current ? html` aria-current="true"` : ''}>${i.label}${i.count === undefined ? '' : html`<span class="ol-count">${fmtNumber(i.count, ctx.lang)}</span>`}</a>`,
  )}</div>`;
}

/** A menu of links behind a button that names the current choice. */
export function linkMenu(
  ctx: Ctx,
  o: {
    id: string;
    label: HtmlValue;
    icon?: IconName;
    items: Array<{ label: string; href: string; current: boolean }>;
  },
): SafeHtml {
  return html`<button type="button" class="ol-btn ol-btn-ghost ol-btn-sm" popovertarget="${o.id}">${o.icon ? icon(ctx, o.icon, 'sm') : ''}${o.label}</button>
    <div class="ol-menu ol-menu-end" id="${o.id}" popover>${o.items.map(
      (i) =>
        html`<a class="ol-menu-item" href="${i.href}"${i.current ? html` aria-current="true"` : ''}>${i.label}</a>`,
    )}</div>`;
}

/** Below a list: which rows these are, and links to the pages before and after. */
export function listPager(
  ctx: Ctx,
  o: { page: number; size: number; shown: number; total: number; more: boolean },
): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const from = o.shown === 0 ? 0 : o.page * o.size + 1;
  const link = (page: number, label: string, name: IconName, on: boolean) =>
    on
      ? html`<a class="ol-btn ol-btn-secondary ol-btn-icon ol-btn-sm" href="${withPage(ctx, page)}">${icon(ctx, name, 'sm')}<span class="ol-sr-only">${label}</span></a>`
      : html`<span class="ol-btn ol-btn-secondary ol-btn-icon ol-btn-sm" aria-disabled="true">${icon(ctx, name, 'sm')}</span>`;
  return html`<nav class="ol-pager" aria-label="${t('pager.label')}">
    <span>${t('pager.range', { from: n(from), to: n(from + o.shown - (o.shown === 0 ? 0 : 1)), n: n(o.total) })}</span>
    <span class="ol-pager-links">${link(o.page - 1, t('pager.previous'), 'chevron-left', o.page > 0)}${link(o.page + 1, t('pager.next'), 'chevron-right', o.more)}</span>
  </nav>`;
}

function withPage(ctx: Ctx, page: number): string {
  const params = new URLSearchParams(ctx.url.searchParams);
  if (page > 0) params.set('page', String(page));
  else params.delete('page');
  const qs = params.toString();
  return qs ? `${ctx.url.pathname}?${qs}` : ctx.url.pathname;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** When, briefly: the time today, yesterday and its time, or the date. */
export function whenShort(ctx: Ctx, ts: number | null): string {
  if (ts === null) return '—';
  const d = new Date(ts);
  const today = new Date(ctx.now);
  today.setHours(0, 0, 0, 0);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ts >= today.getTime()) return clock;
  if (ts >= today.getTime() - 86_400_000) return ctx.t('when.yesterday', { time: clock });
  if (d.getFullYear() === today.getFullYear()) {
    return ctx.t('when.date', { month: d.getMonth() + 1, day: d.getDate() });
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A histogram: one column per day, stacked by agent in their colours, the days outside the range
 * dimmed, with a title per column. A fluid chart of the design system: the plot stretches to the
 * list's width, and its labels, under the first, middle, and last day, are text beside it.
 */
export function histogram(
  ctx: Ctx,
  o: {
    days: Array<{ day: string; start: number; bySource: Record<string, number> }>;
    since: number | null;
    label: string;
    total: number;
    caption: string;
    /** A column's count in its title; sessions unless said otherwise. */
    unit?: (n: number) => string;
  },
): SafeHtml {
  const STEP = 10;
  const H = 40;
  const max = Math.max(
    1,
    ...o.days.map((d) => Object.values(d.bySource).reduce((a, b) => a + b, 0)),
  );
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const labelled = new Set([0, Math.floor(o.days.length / 2), o.days.length - 1]);
  const columns = o.days.map((d, i) => {
    const sources = Object.entries(d.bySource).sort(([a], [b]) => agentSlot(a) - agentSlot(b));
    const sum = sources.reduce((a, [, v]) => a + v, 0);
    let top = H;
    const segments = sources.map(([source, v]) => {
      const h = (v / max) * (H - 1);
      top -= h;
      return html`<rect class="ol-chart-bar ol-series-${agentSlot(source)}" x="${i * STEP + 1.5}" y="${r1(top)}" width="${STEP - 3}" height="${r1(Math.max(h, 0))}"/>`;
    });
    const title = `${d.day}: ${o.unit ? o.unit(sum) : ctx.t('hist.sessions', { n: n(sum) })}${sources.map(([s, v]) => `, ${s} ${n(v)}`).join('')}`;
    const out = o.since !== null && d.start < o.since;
    return html`<g${out ? html` class="admin-out"` : ''}><title>${title}</title>${segments}</g>`;
  });
  const labels = o.days.map((d, i) =>
    labelled.has(i)
      ? html`<span>${i === o.days.length - 1 ? ctx.t('hist.today') : d.day.slice(5).replace('-', '/')}</span>`
      : html`<span></span>`,
  );
  return html`<div class="admin-hist">
    <div class="ol-chart-plot ol-chart-plot-sm">
      <svg class="ol-chart-svg ol-chart-fluid" viewBox="0 0 ${o.days.length * STEP} ${H}" preserveAspectRatio="none" role="img" aria-label="${o.label}" focusable="false">${columns}</svg>
      <div class="ol-chart-x" aria-hidden="true">${labels}</div>
    </div>
    <div class="admin-hist-total"><b>${n(o.total)}</b>${o.caption}</div>
  </div>`;
}

/** A panel of related things: its title, a note or links on the right of its head, and its body. */
export function box(o: {
  title: HtmlValue;
  aside?: HtmlValue;
  body: HtmlValue;
  /** The body fills the panel to its edges, as a table or a list does. */
  flush?: boolean;
}): SafeHtml {
  return html`<section class="ol-panel">
    <div class="ol-panel-header"><h2 class="ol-panel-title">${o.title}</h2>${o.aside ? html`<div class="admin-panel-aside">${o.aside}</div>` : ''}</div>
    ${o.flush ? o.body : html`<div class="ol-panel-body">${o.body}</div>`}
  </section>`;
}

/** A line of values over time, with the area under it, scaled to the box it is drawn in. */
export function sparkline(values: number[], label: string): SafeHtml {
  const W = 120;
  const H = 32;
  const max = Math.max(1, ...values);
  const step = W / Math.max(1, values.length - 1);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const points = values.map((v, i) => `${r1(i * step)},${r1(H - 2 - (v / max) * (H - 4))}`);
  return html`<svg class="ol-sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}" focusable="false"><path class="ol-sparkline-area" d="M0,${H} L${points.join(' L')} L${W},${H} Z"/><polyline class="ol-sparkline-line" points="${points.join(' ')}"/></svg>`;
}

/**
 * One bar split into parts, each in its series (or neutral), as wide as its share of the whole: of
 * their sum, or of `whole` when given, which leaves the rest of the bar empty.
 */
export function splitBar(
  parts: Array<{ value: number; slot: number | 'neutral' }>,
  label: string,
  whole?: number,
): SafeHtml {
  const total = whole ?? parts.reduce((sum, p) => sum + p.value, 0);
  let x = 0;
  const rects = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const w = (p.value / Math.max(1, total)) * 100;
      const cls = p.slot === 'neutral' ? 'admin-neutral' : `ol-series-${p.slot}`;
      const rect = html`<rect class="${cls}" x="${Math.round(x * 10) / 10}" width="${Math.max(0.5, Math.round(w * 10) / 10 - 0.6)}" height="6"/>`;
      x += w;
      return rect;
    });
  return html`<svg class="ol-stackbar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${label}" focusable="false">${rects}</svg>`;
}

/** A part of a whole as a bar: the largest whole of a list as its track, the whole, and the part. */
export function ratioBar(part: number, whole: number, max: number, label: string): SafeHtml {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const all = max <= 0 ? 0 : (whole / max) * 100;
  const some = max <= 0 ? 0 : (Math.min(part, whole) / max) * 100;
  return html`<svg class="ol-ratio" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label}" focusable="false"><rect class="ol-ratio-track" width="100" height="8" rx="2"/><rect class="ol-ratio-whole" width="${r1(all)}" height="8" rx="2"/><rect class="ol-ratio-part" width="${r1(some)}" height="8" rx="2"/></svg>`;
}

/** A field that filters a list by words, keeping the list's other filters. */
export function searchField(
  ctx: Ctx,
  o: { action: string; value: string; placeholder: string; label: string },
): SafeHtml {
  const kept = [...ctx.url.searchParams].filter(([k]) => k !== 'q' && k !== 'page');
  return html`<form class="ol-search" method="get" action="${o.action}" role="search">${kept.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${icon(ctx, 'search', 'sm')}<input class="ol-input ol-input-sm" type="search" name="q" value="${o.value}" placeholder="${o.placeholder}" maxlength="200" aria-label="${o.label}"></form>`;
}

/**
 * A list with its filters (the design system's .ol-layout-filters): the filters on the left, or in
 * a sheet on narrow screens; then the filter bar, with the filters that are on as tags that remove
 * them, so that what is filtered shows at every width; then the list.
 */
export function filterLayout(
  ctx: Ctx,
  o: {
    facets: HtmlValue;
    search?: HtmlValue;
    ranges?: HtmlValue;
    tags: Array<{ label: HtmlValue; href: string }>;
    end?: HtmlValue;
    body: HtmlValue;
  },
): SafeHtml {
  return html`<div class="ol-layout-filters">
    ${facetPane(ctx, o.facets)}
    <section class="ol-layout-main">
      <div class="ol-filterbar">${o.search ?? ''}${o.ranges ?? ''}${filterTags(ctx, o.tags)}<div class="ol-filterbar-end">${o.end ?? ''}${facetButton(ctx, o.tags.length)}</div></div>
      ${o.body}
    </section>
  </div>`;
}
