/**
 * The parts the workbench's pages share (see the "workbench" rules in assets/admin.css): the row a
 * page starts with, facts in chips, agents in their colour, the rail of filters a list has on its
 * left, chips and menus of links, the histogram above a list, and the pager below it. Every filter
 * is a link to the same page with one parameter changed, so the pages work without a script.
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

/** An agent: a square in its colour, and its name in plain text. */
export function agentTag(source: string): SafeHtml {
  return html`<span class="admin-tag admin-s${agentSlot(source)}">${source}</span>`;
}

/** The kinds of entries, each with its slot in the chart palette. */
export const KIND_SLOTS: Record<EntryKind, number> = { memory: 1, knowledge: 3, cognition: 4 };

/** A kind of entry: a square in its colour, and its name. */
export function kindTag(ctx: Ctx, kind: EntryKind): SafeHtml {
  return html`<span class="admin-tag admin-s${KIND_SLOTS[kind]}">${ctx.t(`kind.${kind}`)}</span>`;
}

/** The row a page starts with: its title, a count, badges, and its actions. */
export function pageBar(
  ctx: Ctx,
  o: { title: HtmlValue; count?: number; badges?: HtmlValue; actions?: HtmlValue },
): SafeHtml {
  return html`<div class="admin-bar">
    <h1>${o.title}</h1>
    ${o.count === undefined ? '' : html`<span class="admin-bar-count">${fmtNumber(o.count, ctx.lang)}</span>`}
    ${o.badges ?? ''}
    ${o.actions ? html`<div class="admin-bar-actions">${o.actions}</div>` : ''}
  </div>`;
}

/** Facts about a thing, each in its own chip, with an icon or a label. */
export function facts(
  ctx: Ctx,
  items: Array<{ icon?: IconName; label?: string; value: HtmlValue } | null | false>,
): SafeHtml {
  return html`<div class="admin-facts">${items
    .filter((i): i is { icon?: IconName; label?: string; value: HtmlValue } => !!i)
    .map(
      (i) =>
        html`<span class="admin-fact">${i.icon ? icon(ctx, i.icon, 'sm') : ''}${i.label ? html`${i.label} ` : ''}<b>${i.value}</b></span>`,
    )}</div>`;
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

/** A group of the filter rail: its title, a way to clear it, and its values with their counts. */
export function facetGroup(
  ctx: Ctx,
  o: { title: string; clear?: string | null; items: FacetItem[]; more?: number },
): SafeHtml {
  return html`<section class="admin-facet-group">
    <h2 class="admin-facet-head">${o.title}${o.clear ? html`<a href="${o.clear}">${ctx.t('facet.clear')}</a>` : ''}</h2>
    <ul class="admin-facet-list">${o.items.map(
      (i) =>
        html`<li><a class="admin-facet" href="${i.href}" role="checkbox" aria-checked="${i.checked ? 'true' : 'false'}"><span class="admin-check" aria-hidden="true">${icon(ctx, 'check', 'sm')}</span><span class="admin-facet-label">${i.label}</span><span class="admin-facet-n">${fmtNumber(i.count, ctx.lang)}</span></a></li>`,
    )}</ul>
    ${o.more ? html`<span class="admin-facet-more">${ctx.t('facet.more', { n: fmtNumber(o.more, ctx.lang) })}</span>` : ''}
  </section>`;
}

/** Chips of links, one of them current, each with a count if given. */
export function linkChips(
  ctx: Ctx,
  items: Array<{ label: HtmlValue; href: string; current: boolean; count?: number }>,
): SafeHtml {
  return html`<div class="admin-chips">${items.map(
    (i) =>
      html`<a class="admin-chip" href="${i.href}"${i.current ? html` aria-current="true"` : ''}>${i.label}${i.count === undefined ? '' : html`<span class="admin-chip-n">${fmtNumber(i.count, ctx.lang)}</span>`}</a>`,
  )}</div>`;
}

/** A menu of links behind a button-like summary that names the current choice. */
export function linkMenu(
  ctx: Ctx,
  o: {
    label: HtmlValue;
    icon?: IconName;
    items: Array<{ label: string; href: string; current: boolean }>;
  },
): SafeHtml {
  return html`<details class="admin-menu"><summary>${o.icon ? icon(ctx, o.icon, 'sm') : ''}${o.label}</summary>
    <ul class="admin-menu-list">${o.items.map(
      (i) =>
        html`<li><a href="${i.href}"${i.current ? html` aria-current="true"` : ''}>${i.label}</a></li>`,
    )}</ul></details>`;
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
      ? html`<a href="${withPage(ctx, page)}" aria-label="${label}">${icon(ctx, name, 'sm')}</a>`
      : html`<span aria-hidden="true">${icon(ctx, name, 'sm')}</span>`;
  return html`<nav class="admin-pager" aria-label="${t('pager.label')}">
    <span>${t('pager.range', { from: n(from), to: n(from + o.shown - (o.shown === 0 ? 0 : 1)), n: n(o.total) })}</span>
    <span class="admin-pager-links">${link(o.page - 1, t('pager.previous'), 'chevron-left', o.page > 0)}${link(o.page + 1, t('pager.next'), 'chevron-right', o.more)}</span>
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
 * dimmed, with a title per column and labels under the first, middle, and last.
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
  const W = 1000;
  const H = 60;
  const PLOT = 44;
  const step = W / Math.max(1, o.days.length);
  const max = Math.max(
    1,
    ...o.days.map((d) => Object.values(d.bySource).reduce((a, b) => a + b, 0)),
  );
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const labels = new Set([0, Math.floor(o.days.length / 2), o.days.length - 1]);
  const columns = o.days.map((d, i) => {
    const sources = Object.entries(d.bySource).sort(([a], [b]) => agentSlot(a) - agentSlot(b));
    const sum = sources.reduce((a, [, v]) => a + v, 0);
    let top = PLOT;
    const segments = sources.map(([source, v]) => {
      const h = (v / max) * (PLOT - 2);
      top -= h;
      return html`<rect class="admin-s${agentSlot(source)}" x="${r1(i * step + 2)}" y="${r1(top)}" width="${r1(step - 4)}" height="${r1(Math.max(h, 0))}" rx="1.5"/>`;
    });
    const title = `${d.day}: ${o.unit ? o.unit(sum) : ctx.t('hist.sessions', { n: n(sum) })}${sources.map(([s, v]) => `, ${s} ${n(v)}`).join('')}`;
    const out = o.since !== null && d.start < o.since;
    const label = labels.has(i)
      ? html`<text x="${r1(i * step + step / 2)}" y="${H - 2}" text-anchor="${i === 0 ? 'start' : i === o.days.length - 1 ? 'end' : 'middle'}">${i === o.days.length - 1 ? ctx.t('hist.today') : d.day.slice(5).replace('-', '/')}</text>`
      : '';
    return html`<g${out ? html` class="admin-out"` : ''}><title>${title}</title>${segments}</g>${label}`;
  });
  return html`<div class="admin-hist">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label}" focusable="false">${columns}</svg>
    <div class="admin-hist-total"><b>${n(o.total)}</b>${o.caption}</div>
  </div>`;
}

/** A titled box of related things, with a note or links on the right of its head. */
export function box(o: {
  title: HtmlValue;
  aside?: HtmlValue;
  body: HtmlValue;
  /** The body fills the box to its edges, as a table does. */
  flush?: boolean;
  cls?: string;
}): SafeHtml {
  return html`<section class="admin-panel${o.cls ? ` ${o.cls}` : ''}">
    <header class="admin-panel-head"><h2>${o.title}</h2>${o.aside ? html`<div class="admin-panel-head-aside">${o.aside}</div>` : ''}</header>
    ${o.flush ? o.body : html`<div class="admin-panel-body">${o.body}</div>`}
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
  const line = points.join(' ');
  return html`<svg class="admin-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}" focusable="false"><path class="admin-spark-area" d="M0,${H} L${points.join(' L')} L${W},${H} Z"/><polyline class="admin-spark-line" points="${line}" vector-effect="non-scaling-stroke"/></svg>`;
}

/** One bar split into parts, each in its colour slot, as wide as its share of the whole. */
export function splitBar(parts: Array<{ value: number; slot: number }>, label: string): SafeHtml {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  let x = 0;
  const rects = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const w = (p.value / Math.max(1, total)) * 100;
      const rect = html`<rect class="admin-s${p.slot}" x="${Math.round(x * 10) / 10}" width="${Math.max(0.5, Math.round(w * 10) / 10 - 0.6)}" height="6"/>`;
      x += w;
      return rect;
    });
  return html`<svg class="admin-split" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${label}" focusable="false">${rects}</svg>`;
}

/** A part of a whole as a bar: the whole as its track, the part filled. */
export function ratioBar(part: number, whole: number, max: number, label: string): SafeHtml {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const all = max <= 0 ? 0 : (whole / max) * 100;
  const some = max <= 0 ? 0 : (Math.min(part, whole) / max) * 100;
  return html`<svg class="admin-ratio" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label}" focusable="false"><rect class="admin-ratio-track" width="100" height="8" rx="2"/><rect class="admin-ratio-whole" width="${r1(all)}" height="8" rx="2"/><rect class="admin-ratio-part" width="${r1(some)}" height="8" rx="2"/></svg>`;
}
