import { entrySummary, RECALL_OCCASIONS } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import {
  PAGE_SIZE,
  type RecallBoard,
  type RecallBoardFilter,
  type RecallDetail,
  type RecallItemView,
  type RecallView,
  SESSION_RANGES,
} from '../service.js';
import { badge, copyButton, linkButton, sessionHref, sessionName } from './components.js';
import { docsUrl, renderPage } from './layout.js';
import {
  agentTag,
  box,
  facetGroup,
  facts,
  histogram,
  kindTag,
  linkChips,
  listPager,
  pageBar,
  splitBar,
  toggled,
  whenShort,
  withParams,
} from './workbench.js';

/**
 * Recalls (see docs/architecture.md#recall): what agents were handed unasked, each with what it
 * handed over and whether the session used it. A recall keeps only ids: what an item is, and the
 * text it was handed as, are read from the store when it is shown.
 */

/** Each layer of a recall in its colour slot; the header and headings in their own. */
const LAYER_SLOTS = { header: 9, cognition: 4, project: 1, sessions: 6, prompt: 2 } as const;

/** When a recall was made, as a tag. */
function occasionTag(ctx: Ctx, r: Pick<RecallView, 'occasion'>): SafeHtml {
  return html`<span class="admin-occasion">${ctx.t(`recall.occasion.${r.occasion}`)}</span>`;
}

/** How many items a recall handed over, and how many of them the session used. */
function usedCell(ctx: Ctx, r: RecallView): SafeHtml {
  const n = (v: number) => fmtNumber(v, ctx.lang);
  if (r.items.length === 0) return html`<span class="admin-faint">—</span>`;
  return r.used.length > 0
    ? html`<span class="admin-good">${n(r.used.length)}</span>`
    : html`<span class="admin-faint">0</span>`;
}

/** Recalls as a table, newest first: when, what for, which session, and how much was used. */
export function recallTable(
  ctx: Ctx,
  recalls: Array<RecallView & { sessionRow?: RecallDetail['sessionRow'] }>,
): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  return html`<table class="admin-table">
    <thead><tr><th>${t('tombstones.time')}</th><th>${t('recalls.occasion')}</th><th>${t('recalls.session')}</th><th>${t('facet.agent')}</th><th>${t('filter.project')}</th><th class="admin-r">${t('recalls.items')}</th><th class="admin-r">${t('recall.used')}</th><th class="admin-r">${t('recalls.tokens')}</th></tr></thead>
    <tbody>${recalls.map(
      (r) => html`<tr>
      <td><a class="admin-cell-title" href="${href('recall', { id: r.id })}" title="${r.id}">${whenShort(ctx, r.at)}</a></td>
      <td>${occasionTag(ctx, r)}</td>
      <td class="admin-wide">${
        r.sessionRow
          ? html`<a class="admin-cell-title" href="${sessionHref(r.sessionRow)}">${sessionName(ctx, r.sessionRow, 100)}</a>`
          : r.session
            ? html`<span class="admin-faint ol-mono">${clip(r.session.sessionId, 13)}</span>`
            : html`<span class="admin-faint">—</span>`
      }</td>
      <td>${r.source ? agentTag(r.source) : html`<span class="admin-faint">—</span>`}</td>
      <td>${r.project ?? html`<span class="admin-faint">—</span>`}</td>
      <td class="admin-r">${r.items.length === 0 ? html`<span class="admin-faint">${t('recalls.nothing')}</span>` : n(r.items.length)}</td>
      <td class="admin-r">${usedCell(ctx, r)}</td>
      <td class="admin-r">${r.items.length === 0 ? html`<span class="admin-faint">—</span>` : n(r.tokens)}</td>
    </tr>`,
    )}</tbody></table>`;
}

/**
 * Recalls, as a workbench list: the filter rail (agents, occasions, devices, whether anything was
 * handed over) on the left, then the time ranges, the histogram of the last 30 days, and the
 * recalls, newest first.
 */
export function recallsPage(ctx: Ctx, b: RecallBoard & { filter: RecallBoardFilter }): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const f = b.filter;
  const link = (changes: Record<string, string | string[] | null>) => withParams(ctx, changes);
  const rail = html`<aside class="admin-facets" aria-label="${t('facet.label')}">
    ${facetGroup(ctx, {
      title: t('facet.agent'),
      clear: f.agents.length > 0 ? link({ agent: null }) : null,
      items: b.facets.agents.map((v) => ({
        label: agentTag(v.value),
        count: v.count,
        checked: f.agents.includes(v.value),
        href: link({ agent: toggled(f.agents, v.value) }),
      })),
    })}
    ${facetGroup(ctx, {
      title: t('recalls.occasion'),
      clear: f.occasions.length > 0 ? link({ occasion: null }) : null,
      items: RECALL_OCCASIONS.map((o) => ({
        label: t(`recall.occasion.${o}`),
        count: b.facets.occasions.find((v) => v.value === o)?.count ?? 0,
        checked: f.occasions.includes(o),
        href: link({ occasion: toggled(f.occasions, o) }),
      })),
    })}
    ${facetGroup(ctx, {
      title: t('recalls.handed'),
      items: (['some', 'none'] as const).map((h) => ({
        label: t(`recalls.handed.${h}`),
        count: b.facets[h],
        checked: f.handed === h,
        href: link({ handed: f.handed === h ? 'any' : h === 'some' ? null : h }),
      })),
    })}
    ${
      b.facets.devices.length > 1 || f.devices.length > 0
        ? facetGroup(ctx, {
            title: t('recalls.device'),
            clear: f.devices.length > 0 ? link({ device: null }) : null,
            items: b.facets.devices.map((v) => ({
              label: v.value,
              count: v.count,
              checked: f.devices.includes(v.value),
              href: link({ device: toggled(f.devices, v.value) }),
            })),
          })
        : ''
    }
  </aside>`;
  const toolbar = html`<div class="admin-toolbar">
    ${linkChips(
      ctx,
      SESSION_RANGES.map((r) => ({
        label: t(`range.${r}`),
        href: link({ range: r === '30d' ? null : r }),
        current: f.range === r,
        count: b.ranges[r],
      })),
    )}
    <div class="admin-toolbar-end"><a class="admin-faint" href="${docsUrl(ctx, 'guide/recall')}" rel="noreferrer">${t('recalls.howItWorks')}</a></div>
  </div>`;
  const filtered =
    f.agents.length + f.occasions.length + f.devices.length > 0 || f.handed !== 'some';
  const rows =
    b.rows.length === 0
      ? html`<div class="admin-table-empty">${
          filtered || f.range !== 'all'
            ? html`<p>${t('recalls.none')}</p>${linkButton(ctx, { href: '/admin/recalls?range=all', label: t('filter.clear'), size: 'sm' })}`
            : html`<p>${t('recalls.noneYet')}</p><p class="admin-note">${t('recalls.noneHelp')}</p>`
        }</div>`
      : recallTable(ctx, b.rows);
  renderPage(ctx, 200, {
    title: t('nav.recalls'),
    nav: 'recalls',
    body: html`${pageBar(ctx, { title: t('nav.recalls'), count: b.total })}
    <div class="admin-board">
      ${rail}
      <section class="admin-board-main">
        ${toolbar}
        ${histogram(ctx, {
          days: b.histogram,
          since: b.since,
          label: t('recalls.hist'),
          total: b.histogram.reduce(
            (sum, d) => sum + Object.values(d.bySource).reduce((a, v) => a + v, 0),
            0,
          ),
          caption: t('recalls.histCaption'),
          unit: (v) => t('recalls.histCount', { n: n(v) }),
        })}
        ${rows}
        ${listPager(ctx, { page: b.page, size: PAGE_SIZE, shown: b.rows.length, total: b.total, more: b.more })}
      </section>
    </div>`,
  });
}

/** What an item is now: an entry's summary or a session's name, linked, or why it is not shown. */
function itemCell(ctx: Ctx, i: RecallItemView): SafeHtml {
  const t = ctx.t;
  if (i.gone) {
    return html`<span class="admin-faint">${t(`recall.gone.${i.gone}`)}</span><span class="admin-cell-sub ol-mono">${i.ref}</span>`;
  }
  if (i.entry) {
    const e = i.entry;
    return html`<a class="admin-cell-title" href="${href('entry', { id: e.id })}">${entrySummary(e.text)}</a>
      <span class="admin-cell-sub">${kindTag(ctx, e.kind)} <span class="ol-mono">${e.id}</span>${e.status === 'superseded' ? html` ${badge(t('status.superseded'), 'neutral')}` : ''}</span>`;
  }
  const s = i.session;
  if (!s) return html`<span class="ol-mono">${i.ref}</span>`;
  return html`<a class="admin-cell-title" href="${sessionHref(s)}">${sessionName(ctx, s, 120)}</a>
    <span class="admin-cell-sub">${agentTag(s.source)} ${whenShort(ctx, s.endedAt)}</span>`;
}

/**
 * One recall: what it was for, what the agent was handed as text (rebuilt from the store now), each
 * item with why it came and whether it was used; and on the right, how much was used, its details,
 * and the other recalls of its session.
 */
export function recallPage(ctx: Ctx, d: RecallDetail): void {
  const t = ctx.t;
  const r = d.recall;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const used = d.items.filter((i) => i.used).length;
  const layers = (['cognition', 'project', 'sessions', 'prompt'] as const)
    .map((layer) => ({
      layer,
      tokens: r.items.filter((i) => i.layer === layer).reduce((sum, i) => sum + i.tokens, 0),
    }))
    .filter((l) => l.tokens > 0);
  const header = Math.max(0, r.tokens - layers.reduce((sum, l) => sum + l.tokens, 0));
  const budget = html`<div class="admin-budget">
    <div class="admin-budget-head"><span>${t('recall.budget')}</span><span><b>${n(r.tokens)}</b> / ${n(r.budget)} token</span></div>
    ${splitBar(
      [
        { value: header, slot: LAYER_SLOTS.header },
        ...layers.map((l) => ({ value: l.tokens, slot: LAYER_SLOTS[l.layer] })),
        { value: Math.max(0, r.budget - r.tokens), slot: 0 },
      ],
      t('recall.tokensOf', { n: n(r.tokens), budget: n(r.budget) }),
    )}
    <div class="admin-budget-legend">${
      r.items.length === 0
        ? ''
        : html`<span class="admin-tag admin-s${LAYER_SLOTS.header}">${t('recall.header')}</span>${layers.map(
            (l) =>
              html`<span class="admin-tag admin-s${LAYER_SLOTS[l.layer]}">${t(`recall.layer.${l.layer}`)}</span>`,
          )}`
    }</div>
  </div>`;

  const handed = box({
    title: html`${icon(ctx, 'file-text', 'sm')}${t('recall.handed')}`,
    aside: d.handed.text
      ? html`<span>${t('recall.rebuilt')}</span>${copyButton(ctx, 'handed', { labelled: true })}`
      : '',
    flush: true,
    body: d.handed.text
      ? html`<pre class="admin-handed" id="handed">${d.handed.text}</pre>${
          d.handed.missing.length > 0
            ? html`<p class="admin-handed-note">${t('recall.missingNote', { n: n(d.handed.missing.length) })}</p>`
            : ''
        }`
      : html`<div class="admin-panel-body"><p class="admin-muted">${r.items.length === 0 ? t('recall.nothing') : t('recall.missingNote', { n: n(d.handed.missing.length) })}</p></div>`,
  });

  const prompt =
    r.occasion === 'prompt'
      ? box({
          title: t('recall.prompt'),
          aside: d.prompt
            ? html`<a href="${href('event', { id: d.prompt.id })}">${time(d.prompt.ts)}</a>`
            : '',
          body: d.prompt
            ? html`<p class="admin-prompt-line">${clip(d.prompt.text, 600)}</p>`
            : html`<p class="admin-muted">${t('recall.promptMissing')}</p>`,
        })
      : '';

  const items = box({
    title: html`${t('recall.itemsTitle')}<span class="admin-bar-count">${n(r.items.length)}</span>`,
    aside: t('recall.usedHelp'),
    flush: true,
    body:
      d.items.length === 0
        ? html`<div class="admin-panel-body"><p class="admin-muted">${t('recall.nothing')}</p></div>`
        : html`<table class="admin-table">
      <thead><tr><th class="admin-r">#</th><th>${t('recall.layer')}</th><th>${t('recall.item')}</th><th class="admin-r">${t('recall.score')}</th><th class="admin-r">token</th><th>${t('recall.used')}</th></tr></thead>
      <tbody>${d.items.map(
        (i) => html`<tr>
        <td class="admin-r">${n(i.rank)}</td>
        <td>${t(`recall.layer.${i.layer}`)}</td>
        <td class="admin-wide">${itemCell(ctx, i)}</td>
        <td class="admin-r">${i.score === null ? html`<span class="admin-faint">—</span>` : i.score.toFixed(2)}</td>
        <td class="admin-r">${n(i.tokens)}</td>
        <td>${i.used ? html`<span class="admin-good">${icon(ctx, 'check', 'sm')}${t('recall.usedYes')}</span>` : html`<span class="admin-faint">${t('recall.notUsed')}</span>`}</td>
      </tr>`,
      )}</tbody></table>`,
  });

  const effect = box({
    title: t('recall.effect'),
    body: html`<p class="admin-effect"><b>${n(used)}</b> ${t('recall.usedOf', { n: n(d.items.length) })}</p>
      ${
        d.items.length > 0
          ? html`<svg class="admin-effect-bar" viewBox="0 0 ${d.items.length * 10} 4" preserveAspectRatio="none" role="img" aria-label="${t('recall.usedOf', { n: n(d.items.length) })}" focusable="false">${d.items.map(
              (i, k) =>
                html`<rect class="${i.used ? 'admin-effect-used' : 'admin-ratio-track'}" x="${k * 10}" width="8.5" height="4" rx="1"/>`,
            )}</svg>`
          : ''
      }`,
  });

  const details = box({
    title: t('entry.details'),
    body: html`<dl class="admin-kv">
      <dt>${t('recall.title')}</dt><dd class="ol-mono">${r.id}</dd>
      <dt>${t('recalls.occasion')}</dt><dd>${t(`recall.occasion.${r.occasion}`)}</dd>
      <dt>${t('tombstones.time')}</dt><dd>${time(r.at)}</dd>
      ${r.cwd ? html`<dt>${t('recall.cwd')}</dt><dd class="ol-mono ol-break">${r.cwd}</dd>` : ''}
      <dt>${t('filter.project')}</dt><dd>${r.project ?? '—'}</dd>
      <dt>${t('recalls.device')}</dt><dd>${r.origin}</dd>
      <dt>${t('recall.tokens')}</dt><dd>${t('recall.tokensOf', { n: n(r.tokens), budget: n(r.budget) })}</dd>
    </dl>`,
  });

  const others =
    d.others.length === 0
      ? ''
      : box({
          title: t('recall.others'),
          flush: true,
          body: html`<ul class="admin-rows">${d.others.map(
            (o) => html`<li>
              ${occasionTag(ctx, o)}
              <a class="admin-cell-title" href="${href('recall', { id: o.id })}">${
                o.items.length === 0
                  ? t('recalls.nothing')
                  : t('recall.marker', { n: n(o.items.length), used: n(o.used.length) })
              }</a>
              <span class="admin-rows-end">${whenShort(ctx, o.at)}</span>
            </li>`,
          )}</ul>`,
        });

  const s = d.sessionRow;
  const sessionFact: HtmlValue = s
    ? html`<a href="${sessionHref(s)}">${sessionName(ctx, s, 60)}</a>`
    : r.session
      ? html`<span class="ol-mono">${clip(r.session.sessionId, 13)}</span>`
      : '';
  renderPage(ctx, 200, {
    title: r.id,
    nav: 'recalls',
    crumbs: [{ label: t('nav.recalls'), href: '/admin/recalls' }],
    body: html`<div class="admin-recall-top">
      <div>
        ${pageBar(ctx, { title: t(`recall.heading.${r.occasion}`), badges: occasionTag(ctx, r) })}
        ${facts(ctx, [
          r.source ? { value: agentTag(r.source) } : null,
          r.project ? { icon: 'folder', value: r.project } : null,
          { icon: 'clock', value: time(r.at) },
          { icon: 'laptop', value: r.origin },
          sessionFact ? { icon: 'history', value: sessionFact } : null,
        ])}
      </div>
      ${budget}
    </div>
    <div class="admin-detail-grid">
      <div class="admin-dash-stack">${prompt}${handed}${items}</div>
      <div class="admin-dash-stack">${effect}${details}${others}</div>
    </div>`,
  });
}
