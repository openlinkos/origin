import { entrySummary } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import type { RecallDetail, RecallItemView, RecallView } from '../service.js';
import {
  badge,
  empty,
  kindBadge,
  linkButton,
  pageHeader,
  pager,
  panel,
  section,
  sessionHref,
  sessionName,
  sourceBadge,
  tableWrap,
} from './components.js';
import { docsUrl, renderPage } from './layout.js';

/**
 * Recalls (see docs/architecture.md#recall): what agents were handed unasked, each with what it
 * handed over and whether the session used it. A recall keeps only ids: what an item is, is read
 * from the store when it is shown.
 */

/** When a recall was made, as a badge. */
function occasionTag(ctx: Ctx, r: Pick<RecallView, 'occasion'>): SafeHtml {
  return badge(ctx.t(`recall.occasion.${r.occasion}`), 'neutral', { square: true });
}

/** The session a recall was made for, linked, or a dash. */
function sessionCell(r: RecallView): SafeHtml {
  if (!r.session) return html`<span class="ol-subtle">—</span>`;
  return html`<a class="ol-mono" href="${sessionHref(r.session)}" title="${r.session.sessionId}">${clip(r.session.sessionId, 13)}</a>`;
}

/** How many items a recall handed over, and how many of them the session used. */
function itemsCell(ctx: Ctx, r: RecallView): SafeHtml {
  const n = (v: number) => fmtNumber(v, ctx.lang);
  if (r.items.length === 0) return html`<span class="ol-subtle">${ctx.t('recalls.nothing')}</span>`;
  return html`${n(r.items.length)}${
    r.used.length > 0
      ? html`<span class="ol-cell-sub">${ctx.t('recalls.usedCount', { n: n(r.used.length) })}</span>`
      : ''
  }`;
}

/** Recalls as a table, newest first. */
export function recallTable(ctx: Ctx, recalls: RecallView[]): SafeHtml {
  const t = ctx.t;
  return tableWrap(
    html`<th>${t('tombstones.time')}</th><th>${t('recalls.recall')}</th><th>${t('recalls.agent')}</th><th>${t('filter.project')}</th><th>${t('recalls.items')}</th><th>${t('recalls.session')}</th><th>${t('recalls.device')}</th>`,
    recalls.map(
      (r) => html`<tr>
        <td class="ol-nowrap">${time(r.at)}</td>
        <td class="ol-nowrap"><span class="ol-cluster">${occasionTag(ctx, r)}<a class="ol-mono" href="${href('recall', { id: r.id })}">${r.id}</a></span></td>
        <td class="ol-nowrap">${r.source ? sourceBadge(r.source) : html`<span class="ol-subtle">—</span>`}</td>
        <td>${r.project ?? html`<span class="ol-subtle">—</span>`}</td>
        <td class="ol-nowrap">${itemsCell(ctx, r)}</td>
        <td class="ol-nowrap">${sessionCell(r)}</td>
        <td class="ol-nowrap">${r.origin}</td>
      </tr>`,
    ),
  );
}

function select(
  ctx: Ctx,
  o: { id: string; name: string; label: string; values: string[]; current: string },
): SafeHtml {
  return html`<div class="ol-field">
    <label class="ol-label" for="${o.id}">${o.label}</label>
    <select class="ol-select" id="${o.id}" name="${o.name}"><option value="">${ctx.t('filter.all')}</option>${o.values.map(
      (v) => html`<option value="${v}"${v === o.current ? html` selected` : ''}>${v}</option>`,
    )}</select>
  </div>`;
}

export function recallsPage(
  ctx: Ctx,
  o: {
    recalls: RecallView[];
    page: number;
    more: boolean;
    devices: string[];
    agents: string[];
    filter: { device: string; agent: string; all: boolean };
  },
): void {
  const t = ctx.t;
  const filtered = o.filter.device !== '' || o.filter.agent !== '' || o.filter.all;
  renderPage(ctx, 200, {
    title: t('nav.recalls'),
    nav: 'recalls',
    body: html`${pageHeader(ctx, { title: t('recalls.title'), description: t('recalls.help') })}
    <form method="get" action="/admin/recalls" class="ol-toolbar">
      ${o.devices.length > 1 ? select(ctx, { id: 'f-device', name: 'device', label: t('recalls.device'), values: o.devices, current: o.filter.device }) : ''}
      ${select(ctx, { id: 'f-agent', name: 'agent', label: t('recalls.agent'), values: o.agents, current: o.filter.agent })}
      <label class="ol-check"><input class="ol-checkbox" type="checkbox" name="all" value="1"${o.filter.all ? html` checked` : ''}>${t('recalls.all')}</label>
      <button type="submit" class="ol-btn ol-btn-secondary">${icon(ctx, 'filter')}${t('filter.apply')}</button>
    </form>
    ${
      o.recalls.length === 0
        ? empty(ctx, {
            icon: 'lightbulb',
            title: filtered ? t('recalls.none') : t('recalls.noneYet'),
            text: filtered ? t('sessions.noneFiltered') : t('recalls.noneHelp'),
            action: filtered
              ? linkButton(ctx, { href: '/admin/recalls', label: t('filter.clear'), size: 'sm' })
              : linkButton(ctx, {
                  href: docsUrl(ctx, 'guide/recall'),
                  label: t('recalls.howItWorks'),
                  size: 'sm',
                }),
          })
        : recallTable(ctx, o.recalls)
    }
    ${pager(ctx, o.page, o.more)}`,
  });
}

/** What an item is now: an entry's summary or a session's name, linked, or why it is not shown. */
function itemBody(ctx: Ctx, i: RecallItemView): SafeHtml {
  const t = ctx.t;
  if (i.gone) {
    return html`<span class="ol-mono">${i.ref}</span> <span class="ol-subtle">${t(`recall.gone.${i.gone}`)}</span>`;
  }
  if (i.entry) {
    const e = i.entry;
    return html`<span class="ol-cluster">${kindBadge(ctx, e.kind)}<a class="ol-mono" href="${href('entry', { id: e.id })}">${e.id}</a>${e.status === 'superseded' ? badge(t('status.superseded'), 'neutral') : ''}</span>
      <span class="ol-cell-sub">${entrySummary(e.text)}</span>`;
  }
  const s = i.session;
  if (!s) return html`<span class="ol-mono">${i.ref}</span>`;
  return html`<span class="ol-cluster">${sourceBadge(s.source)}<a href="${sessionHref(s)}">${sessionName(ctx, s, 120)}</a></span>
    <span class="ol-cell-sub">${time(s.endedAt)}</span>`;
}

/** One recall: when, for whom, the prompt it answered, and each item, used or not. */
export function recallPage(ctx: Ctx, d: RecallDetail): void {
  const t = ctx.t;
  const r = d.recall;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  renderPage(ctx, 200, {
    title: r.id,
    nav: 'recalls',
    crumbs: [{ label: t('nav.recalls'), href: '/admin/recalls' }],
    body: html`${pageHeader(ctx, {
      title: html`${t('recall.title')} <span class="ol-mono">${r.id}</span>`,
      badges: occasionTag(ctx, r),
      description: t(`recall.help.${r.occasion}`),
    })}
    <div class="ol-grid ol-grid-sidebar ol-section">
      ${section({
        title: t('recall.items', { n: n(r.items.length) }),
        description: t('recall.itemsHelp'),
        body:
          r.items.length === 0
            ? html`<p class="ol-subtle">${t('recall.nothing')}</p>`
            : tableWrap(
                html`<th>#</th><th>${t('recall.layer')}</th><th>${t('recall.item')}</th><th>${t('recall.score')}</th><th>${t('recall.used')}</th>`,
                d.items.map(
                  (i) => html`<tr>
            <td class="ol-nowrap">${n(i.rank)}</td>
            <td class="ol-nowrap">${t(`recall.layer.${i.layer}`)}</td>
            <td>${itemBody(ctx, i)}</td>
            <td class="ol-nowrap">${i.score === null ? html`<span class="ol-subtle">—</span>` : i.score.toFixed(2)}</td>
            <td class="ol-nowrap">${i.used ? badge(t('recall.usedYes'), 'success', { dot: true }) : html`<span class="ol-subtle">—</span>`}</td>
          </tr>`,
                ),
              ),
      })}
      ${panel(ctx, {
        tag: 'aside',
        title: t('entry.details'),
        icon: 'lightbulb',
        body: html`<dl class="ol-dl">
          <dt>${t('tombstones.time')}</dt><dd>${time(r.at)}</dd>
          <dt>${t('recalls.agent')}</dt><dd>${r.source ?? '—'}</dd>
          <dt>${t('recalls.session')}</dt><dd>${sessionCell(r)}</dd>
          <dt>${t('filter.project')}</dt><dd>${r.project ?? '—'}${r.cwd ? html`<span class="ol-cell-sub ol-mono">${r.cwd}</span>` : ''}</dd>
          <dt>${t('recalls.device')}</dt><dd>${r.origin}</dd>
          <dt>${t('recall.tokens')}</dt><dd>${t('recall.tokensOf', { n: n(r.tokens), budget: n(r.budget) })}</dd>
          ${
            r.occasion === 'prompt'
              ? html`<dt>${t('recall.prompt')}</dt><dd>${
                  d.prompt
                    ? html`<a href="${href('event', { id: d.prompt.id })}">${clip(d.prompt.text, 200)}</a>`
                    : html`<span class="ol-subtle">${t('recall.promptMissing')}</span>`
                }</dd>`
              : ''
          }
        </dl>`,
      })}
    </div>
    ${linkButton(ctx, { href: '/admin/recalls', label: t('nav.recalls'), variant: 'ghost', icon: 'lightbulb' })}`,
  });
}

/** A recall made in a turn of a session, as a chip linking to it. */
export function recallMarker(ctx: Ctx, r: RecallView): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const what =
    r.items.length === 0
      ? t('recalls.nothing')
      : t('recall.marker', { n: n(r.items.length), used: n(r.used.length) });
  return html`<a class="ol-chip ol-chip-mono" href="${href('recall', { id: r.id })}">${icon(ctx, 'lightbulb', 'sm')}<span class="ol-chip-label">${t(`recall.occasion.${r.occasion}`)} · ${what}</span></a>`;
}
