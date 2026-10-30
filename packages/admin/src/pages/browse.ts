import type { Entry, EventRow, SearchHit } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, fmtSpan, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import {
  type EventDetail,
  PAGE_SIZE,
  SESSION_RANGES,
  SESSION_SORTS,
  type SessionBoard,
  type SessionBoardFilter,
} from '../service.js';
import {
  alert,
  empty,
  entryTable,
  eventLabel,
  eventTag,
  feedItem,
  linkButton,
  sessionHref,
  sessionName,
} from './components.js';
import { renderPage } from './layout.js';
import {
  agentTag,
  box,
  facetGroup,
  facts,
  filterLayout,
  histogram,
  linkChips,
  linkMenu,
  listPager,
  searchField,
  toggled,
  whenShort,
  withParams,
} from './workbench.js';

/** The projects the filters list before folding the rest away; the chosen ones always show. */
const RAIL_PROJECTS = 8;

/**
 * Sessions, as a list with filters (agents, projects, recall, names), a filter field, the time
 * ranges, and the sort; then the histogram of the last 30 days, and the sessions, newest first
 * unless sorted otherwise. Every filter is a link or a GET form.
 */
export function sessionsPage(ctx: Ctx, b: SessionBoard & { filter: SessionBoardFilter }): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const f = b.filter;
  const link = (changes: Record<string, string | string[] | null>) => withParams(ctx, changes);
  const shownProjects = [
    ...b.facets.projects.slice(0, RAIL_PROJECTS),
    ...b.facets.projects.slice(RAIL_PROJECTS).filter((p) => f.projects.includes(p.value)),
  ];
  const facetGroups = html`${facetGroup(ctx, {
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
      title: t('filter.project'),
      clear: f.projects.length > 0 ? link({ project: null }) : null,
      items: shownProjects.map((v) => ({
        label: v.value,
        count: v.count,
        checked: f.projects.includes(v.value),
        href: link({ project: toggled(f.projects, v.value) }),
      })),
      more: b.facets.projects.length - shownProjects.length,
    })}
    ${facetGroup(ctx, {
      title: t('nav.recalls'),
      items: [
        {
          label: t('facet.recalled'),
          count: b.facets.recalled,
          checked: f.recalled,
          href: link({ recalled: f.recalled ? null : '1' }),
        },
      ],
    })}
    ${facetGroup(ctx, {
      title: t('facet.name'),
      items: (['titled', 'provisional'] as const).map((name) => ({
        label: t(`facet.${name}`),
        count: b.facets[name],
        checked: f.name === name,
        href: link({ name: f.name === name ? null : name }),
      })),
    })}`;
  const tags = [
    ...f.agents.map((a) => ({ label: a, href: link({ agent: toggled(f.agents, a) }) })),
    ...f.projects.map((p) => ({ label: p, href: link({ project: toggled(f.projects, p) }) })),
    ...(f.recalled ? [{ label: t('facet.recalled'), href: link({ recalled: null }) }] : []),
    ...(f.name !== 'any' ? [{ label: t(`facet.${f.name}`), href: link({ name: null }) }] : []),
  ];
  const filtered = tags.length > 0 || f.q !== '';
  const rows =
    b.rows.length === 0
      ? filtered || f.range !== 'all'
        ? empty(ctx, {
            icon: 'history',
            title: t('sessions.none'),
            action: linkButton(ctx, {
              href: '/admin/sessions?range=all',
              label: t('filter.clear'),
              size: 'sm',
            }),
          })
        : empty(ctx, {
            icon: 'history',
            title: t('overview.noSessions'),
            text: ctx.mode === 'local' ? t('overview.noDataLocal') : t('overview.noData'),
          })
      : html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
      <thead><tr><th>${t('sessions.titleColumn')}</th><th>${t('facet.agent')}</th><th>${t('filter.project')}</th><th class="ol-num">${t('sessions.turns')}</th><th class="ol-num">${t('overview.events')}</th><th class="ol-num">${t('sessions.duration')}</th><th class="ol-num">${t('nav.recalls')}</th><th class="ol-num">${t('sessions.lastActive')}</th></tr></thead>
      <tbody>${b.rows.map(
        (s) => html`<tr>
        <td class="admin-wide"><a class="admin-cell-title" href="${sessionHref(s)}">${sessionName(ctx, s, 120)}</a></td>
        <td>${agentTag(s.source)}</td>
        <td data-label="${t('filter.project')}">${s.project ?? html`<span class="admin-faint">—</span>`}</td>
        <td class="ol-num" data-label="${t('sessions.turns')}">${n(s.turns)}</td>
        <td class="ol-num" data-label="${t('overview.events')}">${n(s.eventCount)}</td>
        <td class="ol-num" data-label="${t('sessions.duration')}">${s.startedAt === null || s.endedAt === null ? '—' : fmtSpan(s.endedAt - s.startedAt, t)}</td>
        <td class="ol-num" data-label="${t('nav.recalls')}">${s.recalls === 0 ? html`<span class="admin-faint">—</span>` : n(s.recalls)}</td>
        <td class="ol-num">${whenShort(ctx, s.endedAt)}</td>
      </tr>`,
      )}</tbody></table></div>`;
  renderPage(ctx, 200, {
    title: t('nav.sessions'),
    nav: 'sessions',
    count: b.total,
    body: filterLayout(ctx, {
      facets: facetGroups,
      search: searchField(ctx, {
        action: '/admin/sessions',
        value: f.q,
        placeholder: t('filter.namePlaceholder'),
        label: t('filter.name'),
      }),
      ranges: linkChips(
        ctx,
        SESSION_RANGES.map((r) => ({
          label: t(`range.${r}`),
          href: link({ range: r === '30d' ? null : r }),
          current: f.range === r,
          count: b.ranges[r],
        })),
      ),
      tags,
      end: linkMenu(ctx, {
        id: 'sort',
        label: t(`sort.${f.sort}`),
        icon: 'chevron-down',
        items: SESSION_SORTS.map((s) => ({
          label: t(`sort.${s}`),
          href: link({ sort: s === 'recent' ? null : s }),
          current: f.sort === s,
        })),
      }),
      body: html`${histogram(ctx, {
        days: b.histogram,
        since: b.since,
        label: t('hist.label'),
        total: b.histogram.reduce(
          (sum, d) => sum + Object.values(d.bySource).reduce((a, v) => a + v, 0),
          0,
        ),
        caption: t('hist.caption'),
      })}
      ${rows}
      ${listPager(ctx, { page: b.page, size: PAGE_SIZE, shown: b.rows.length, total: b.total, more: b.more })}`,
    }),
  });
}

/**
 * An event: its text on the left, with the entries that cite it; and on the right, where it is
 * from: its session and agent, and the line of the agent's log it was read from.
 */
export function eventPage(ctx: Ctx, d: EventDetail): void {
  const t = ctx.t;
  const e = d.event;
  const p = d.provenance;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const session = href('session', { source: e.source, id: e.sessionId, at: e.id });
  const details = box({
    title: t('event.details'),
    body: html`<dl class="ol-dl">
      <dt>${t('overview.source')}</dt><dd>${agentTag(e.source)}${e.agentVersion ? html` <span class="admin-faint ol-mono">${e.agentVersion}</span>` : ''}</dd>
      <dt>${t('event.session')}</dt><dd><a class="ol-mono" href="${session}">${clip(e.sessionId, 24)}</a></dd>
      <dt>${t('sessions.cwd')}</dt><dd class="ol-mono ol-break">${e.cwd ?? '—'}</dd>
      <dt>${t('event.branch')}</dt><dd>${e.gitBranch ?? '—'}</dd>
    </dl>`,
  });
  const provenance = box({
    title: t('event.provenance'),
    aside: t('event.provenanceHelp'),
    body: p
      ? html`<dl class="ol-dl">
        <dt>${t('event.device')}</dt><dd>${p.device ? (ctx.mode === 'local' ? p.device : html`<a href="${href('device', { name: p.device })}">${p.device}</a>`) : t('event.thisStore')}</dd>
        <dt>${t('event.originalFile')}</dt><dd class="ol-mono ol-break">${p.originalPath}</dd>
        <dt>${t('event.generation')}</dt><dd>${p.generation}</dd>
        <dt>${t('event.mirrorLine')}</dt><dd class="ol-mono ol-break">raw/${p.mirror}:${p.line}</dd>
      </dl>
      <form class="admin-after" method="get" action="/admin/event-raw" data-raw="${e.id}">
        <input type="hidden" name="id" value="${e.id}">
        <button type="submit" class="ol-btn ol-btn-secondary ol-btn-sm">${icon(ctx, 'file-text', 'sm')}${t('event.showRaw')}</button>
      </form>
      <div class="ol-code ol-code-wrap admin-after" hidden><div class="ol-code-label">${icon(ctx, 'file-text', 'sm')}${t('event.rawTitle')}</div><pre id="raw-line"></pre></div>`
      : html`<p class="admin-muted">${t('event.noProvenance')}</p>`,
  });
  const citing = box({
    title: html`${t('event.citing')}<span class="ol-count">${n(d.citing.length)}</span>`,
    flush: true,
    body:
      d.citing.length === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('event.notCited')}</p></div>`
        : entryTable(ctx, d.citing),
  });
  renderPage(ctx, 200, {
    title: e.id,
    nav: 'sessions',
    crumbs: [
      { label: t('nav.sessions'), href: '/admin/sessions' },
      { label: t('event.session'), href: session },
    ],
    heading: eventLabel(ctx, e),
    actions: html`${linkButton(ctx, { href: href('remember', { event: e.id }), label: t('event.remember'), icon: 'bookmark', size: 'sm' })}${linkButton(ctx, { href: href('forget', { id: e.id }), label: t('event.forget'), icon: 'eraser', variant: 'danger-soft', size: 'sm' })}`,
    body: html`    ${facts(ctx, [
      { icon: 'clock', value: time(e.ts) },
      e.project ? { icon: 'folder', value: e.project } : null,
      { value: html`<span class="ol-mono">${e.id}</span>` },
    ])}
    <div class="ol-layout-supporting">
      <div class="ol-stack">
        ${box({ title: t('entries.text'), body: html`<div class="admin-entry-text">${e.text}</div>` })}
        ${citing}
      </div>
      <div class="ol-stack">${details}${provenance}</div>
    </div>`,
  });
}

export function eventRawPage(
  ctx: Ctx,
  r: { id: string; line: string | null; truncated: boolean; length: number },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('event.rawTitle'),
    nav: 'sessions',
    crumbs: [
      { label: t('nav.sessions'), href: '/admin/sessions' },
      { label: r.id, href: href('event', { id: r.id }) },
    ],
    body: html`${facts(ctx, [{ value: html`<span class="ol-mono">${r.id}</span>` }])}
    ${
      r.line === null
        ? alert(ctx, 'warning', t('event.rawMissing'))
        : html`<div class="ol-code ol-code-wrap"><pre>${r.line}</pre></div>`
    }
    ${r.truncated ? html`<p class="admin-note">${t('event.rawTruncated', { n: fmtNumber(r.length, ctx.lang) })}</p>` : ''}`,
  });
}

/** Events that matched, one row each: who, where, when, and the words around the match. */
function searchEvents(ctx: Ctx, hits: SearchHit[]): SafeHtml {
  const t = ctx.t;
  return html`<ol class="admin-sources">${hits.map(
    (h) => html`<li>
      <div class="admin-source-head">
        ${agentTag(h.source)}
        ${eventLabel(ctx, h) === h.source ? '' : eventTag(ctx, h)}
        ${h.project ? html`<span class="admin-faint">${h.project}</span>` : ''}
        <a href="${href('session', { source: h.source, id: h.sessionId, at: h.id })}">${t('event.session')}</a>
        <a class="admin-source-time" href="${href('event', { id: h.id })}" title="${h.id}">${time(h.ts)}</a>
      </div>
      <div class="admin-hit-text">${h.snippet}</div>
    </li>`,
  )}</ol>`;
}

/** Search: one field for entries and events alike, each in its own box. */
export function searchPage(
  ctx: Ctx,
  o: { query: string; tools: boolean; entries: Entry[]; events: SearchHit[] },
): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const nothing = o.entries.length === 0 && o.events.length === 0;
  renderPage(ctx, 200, {
    title: o.query ? t('search.titleFor', { q: o.query }) : t('nav.search'),
    nav: 'search',
    heading: t('nav.search'),
    body: html`<form method="get" action="/admin/search" class="admin-search-bar" role="search">
      <div class="ol-search admin-search-wide">${icon(ctx, 'search', 'sm')}<input class="ol-input" type="search" id="q" name="q" value="${o.query}" placeholder="${t('search.placeholder')}" aria-label="${t('nav.search')}" autofocus></div>
      <label class="ol-check"><input class="ol-checkbox" type="checkbox" name="tools" value="1"${o.tools ? html` checked` : ''}>${t('search.tools')}</label>
      <button type="submit" class="ol-btn ol-btn-primary ol-btn-sm">${t('nav.search')}</button>
    </form>
    ${
      !o.query
        ? html`<p class="ol-page-description">${t('search.help')}</p>`
        : nothing
          ? empty(ctx, {
              icon: 'search',
              title: t('search.nothing'),
              text: o.tools ? t('search.nothingHelp') : t('search.nothingTools'),
            })
          : html`<div class="ol-stack">
      ${box({
        title: html`${t('nav.entries')}<span class="ol-count">${n(o.entries.length)}</span>`,
        flush: true,
        body:
          o.entries.length === 0
            ? html`<div class="ol-panel-body"><p class="admin-muted">${t('search.noEntries')}</p></div>`
            : entryTable(ctx, o.entries),
      })}
      ${box({
        title: html`${t('search.eventsTitle')}<span class="ol-count">${n(o.events.length)}</span>`,
        flush: true,
        body:
          o.events.length === 0
            ? html`<div class="ol-panel-body"><p class="admin-muted">${t('search.noEvents')}</p></div>`
            : searchEvents(ctx, o.events),
      })}
    </div>`
    }`,
  });
}

/** An event as a short card, for the forms that start from one. */
export function eventCard(ctx: Ctx, e: EventRow): SafeHtml {
  return html`<ol class="ol-feed">${feedItem(ctx, e, {
    body: clip(e.text, 2000),
    meta: html`<span>${e.project ?? e.source}</span>`,
  })}</ol>`;
}
