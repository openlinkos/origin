import type { Entry, EventRow, SearchHit } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, clock, dayLabel, fmtNumber, fmtSpan, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import type { EventDetail, SessionListRow } from '../service.js';
import { dayKey } from '../turns.js';
import {
  alert,
  empty,
  entryTable,
  eventTag,
  feedItem,
  linkButton,
  pageHeader,
  pager,
  panel,
  section,
  sessionHref,
  sessionName,
  sourceBadge,
} from './components.js';
import { renderPage } from './layout.js';

/** Rows of a list by the day of their time, newest day first, as they come (newest first). */
function byDay<T>(rows: T[], ts: (row: T) => number | null): Array<{ day: string; rows: T[] }> {
  const days: Array<{ day: string; rows: T[] }> = [];
  for (const row of rows) {
    const t = ts(row);
    const day = t === null ? '' : dayKey(t);
    const last = days.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  return days;
}

export function sessionsPage(
  ctx: Ctx,
  o: {
    sessions: SessionListRow[];
    page: number;
    more: boolean;
    sources: string[];
    projects: string[];
    filter: { source: string; project: string; q: string };
  },
): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const option = (value: string, current: string) =>
    html`<option value="${value}"${value === current ? html` selected` : ''}>${value}</option>`;
  const filtered = o.filter.source !== '' || o.filter.project !== '' || o.filter.q !== '';
  const columns = 7;
  renderPage(ctx, 200, {
    title: t('nav.sessions'),
    nav: 'sessions',
    body: html`${pageHeader(ctx, { title: t('sessions.title'), description: t('sessions.help') })}
    <form method="get" action="/admin/sessions" class="ol-toolbar" role="search">
      <div class="ol-field ol-grow">
        <label class="ol-label" for="f-q">${t('filter.name')}</label>
        <div class="ol-search">${icon(ctx, 'search')}<input class="ol-input" type="search" id="f-q" name="q" value="${o.filter.q}" placeholder="${t('filter.namePlaceholder')}" maxlength="200"></div>
      </div>
      <div class="ol-field">
        <label class="ol-label" for="f-source">${t('filter.source')}</label>
        <select class="ol-select" id="f-source" name="source"><option value="">${t('filter.all')}</option>${o.sources.map((s) => option(s, o.filter.source))}</select>
      </div>
      <div class="ol-field">
        <label class="ol-label" for="f-project">${t('filter.project')}</label>
        <select class="ol-select" id="f-project" name="project"><option value="">${t('filter.all')}</option>${o.projects.map((p) => option(p, o.filter.project))}</select>
      </div>
      <button type="submit" class="ol-btn ol-btn-secondary">${icon(ctx, 'filter')}${t('filter.apply')}</button>
      ${filtered ? linkButton(ctx, { href: '/admin/sessions', label: t('filter.clear'), variant: 'ghost' }) : ''}
    </form>
    ${
      o.sessions.length === 0
        ? empty(ctx, {
            icon: 'history',
            title: filtered ? t('sessions.none') : t('overview.noSessions'),
            text: filtered
              ? t('sessions.noneFiltered')
              : ctx.mode === 'local'
                ? t('overview.noDataLocal')
                : t('overview.noData'),
            action: filtered
              ? linkButton(ctx, { href: '/admin/sessions', label: t('filter.clear'), size: 'sm' })
              : ctx.mode === 'local'
                ? ''
                : linkButton(ctx, {
                    href: '/admin/connect',
                    label: t('devices.howToConnect'),
                    icon: 'plug',
                    size: 'sm',
                  }),
          })
        : html`<div class="ol-table-wrap"><table class="ol-table admin-timeline">
      <thead><tr><th class="admin-col-time">${t('sessions.time')}</th><th>${t('sessions.titleColumn')}</th><th>${t('overview.source')}</th><th>${t('filter.project')}</th><th class="ol-num">${t('sessions.duration')}</th><th class="ol-num">${t('sessions.turns')}</th><th class="ol-num">${t('overview.events')}</th></tr></thead>
      ${byDay(o.sessions, (s) => s.endedAt).map(
        (g) => html`<tbody>
        <tr class="ol-table-group"><th colspan="${columns}" scope="rowgroup">${g.day ? dayLabel(ctx, g.day) : '—'}</th></tr>
        ${g.rows.map(
          (s) => html`<tr>
          <td class="ol-nowrap ol-subtle">${s.endedAt === null ? '—' : clock(s.endedAt)}</td>
          <td class="admin-col-name"><a class="ol-cell-title" href="${sessionHref(s)}">${sessionName(ctx, s)}</a></td>
          <td>${sourceBadge(s.source)}</td>
          <td class="ol-nowrap">${s.project ?? html`<span class="ol-subtle">—</span>`}</td>
          <td class="ol-num">${s.startedAt === null || s.endedAt === null ? '—' : fmtSpan(s.endedAt - s.startedAt, t)}</td>
          <td class="ol-num">${s.turns === 0 ? html`<span class="ol-subtle">0</span>` : n(s.turns)}</td>
          <td class="ol-num">${n(s.eventCount)}</td>
        </tr>`,
        )}
      </tbody>`,
      )}
    </table></div>`
    }
    ${pager(ctx, o.page, o.more)}`,
  });
}

export function eventPage(ctx: Ctx, d: EventDetail): void {
  const t = ctx.t;
  const e = d.event;
  const p = d.provenance;
  renderPage(ctx, 200, {
    title: e.id,
    nav: 'sessions',
    crumbs: [
      { label: t('nav.sessions'), href: '/admin/sessions' },
      {
        label: t('event.session'),
        href: href('session', { source: e.source, id: e.sessionId, at: e.id }),
      },
    ],
    body: html`${pageHeader(ctx, {
      title: html`<span class="ol-mono">${e.id}</span>`,
      badges: eventTag(ctx, e),
      meta: [
        html`${icon(ctx, 'clock', 'sm')}${time(e.ts)}`,
        e.project ? html`${icon(ctx, 'folder', 'sm')}${e.project}` : '',
      ],
      actions: html`${linkButton(ctx, { href: href('remember', { event: e.id }), label: t('event.remember'), icon: 'bookmark' })}${linkButton(ctx, { href: href('forget', { id: e.id }), label: t('event.forget'), icon: 'eraser', variant: 'danger-soft' })}`,
    })}
    <div class="ol-grid ol-grid-sidebar ol-section">
      <section>
        <h2 class="ol-sr-only">${t('entries.text')}</h2>
        <ol class="ol-feed">${feedItem(ctx, e, { body: e.text, link: false })}</ol>
      </section>
      ${panel(ctx, {
        tag: 'aside',
        title: t('event.details'),
        icon: 'file-text',
        body: html`<dl class="ol-dl">
          <dt>${t('overview.source')}</dt><dd>${e.source}${e.agentVersion ? html` <span class="ol-subtle">${e.agentVersion}</span>` : ''}</dd>
          <dt>${t('sessions.cwd')}</dt><dd class="ol-mono">${e.cwd ?? '—'}</dd>
          <dt>${t('event.branch')}</dt><dd>${e.gitBranch ?? '—'}</dd>
          <dt>${t('event.session')}</dt><dd><a class="ol-mono" href="${href('session', { source: e.source, id: e.sessionId, at: e.id })}">${e.sessionId}</a></dd>
        </dl>`,
      })}
    </div>
    ${section({
      title: t('event.provenance'),
      description: t('event.provenanceHelp'),
      body: p
        ? html`<div class="ol-stack">
        <dl class="ol-dl">
          <dt>${t('event.device')}</dt><dd>${p.device ? (ctx.mode === 'local' ? p.device : html`<a href="${href('device', { name: p.device })}">${p.device}</a>`) : t('event.thisStore')}</dd>
          <dt>${t('event.originalFile')}</dt><dd class="ol-mono">${p.originalPath}</dd>
          <dt>${t('event.generation')}</dt><dd>${p.generation}</dd>
          <dt>${t('event.mirrorLine')}</dt><dd class="ol-mono">raw/${p.mirror}:${p.line}</dd>
        </dl>
        <form method="get" action="/admin/event-raw" data-raw="${e.id}">
          <input type="hidden" name="id" value="${e.id}">
          <button type="submit" class="ol-btn ol-btn-secondary ol-btn-sm">${icon(ctx, 'file-text', 'sm')}${t('event.showRaw')}</button>
        </form>
        <div class="ol-code ol-code-wrap" hidden><div class="ol-code-label">${icon(ctx, 'file-text', 'sm')}${t('event.rawTitle')}</div><pre id="raw-line"></pre></div>
      </div>`
        : html`<p class="ol-muted ol-text-sm">${t('event.noProvenance')}</p>`,
    })}
    ${section({
      title: t('event.citing'),
      body:
        d.citing.length === 0
          ? empty(ctx, {
              icon: 'bookmark',
              title: t('event.notCitedTitle'),
              text: t('event.notCited'),
              action: linkButton(ctx, {
                href: href('remember', { event: e.id }),
                label: t('event.remember'),
                icon: 'bookmark',
                size: 'sm',
              }),
            })
          : entryTable(ctx, d.citing),
    })}`,
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
    body: html`${pageHeader(ctx, {
      title: t('event.rawTitle'),
      description: html`<span class="ol-mono">${r.id}</span>`,
    })}
    ${
      r.line === null
        ? alert(ctx, 'warning', t('event.rawMissing'))
        : html`<div class="ol-code ol-code-wrap"><pre>${r.line}</pre></div>`
    }
    ${r.truncated ? html`<p class="ol-hint admin-after">${t('event.rawTruncated', { n: fmtNumber(r.length, ctx.lang) })}</p>` : ''}`,
  });
}

function searchEvents(ctx: Ctx, hits: SearchHit[]): SafeHtml {
  const t = ctx.t;
  return html`<ol class="ol-feed">${hits.map((h) =>
    feedItem(ctx, h, {
      body: h.snippet,
      meta: html`<span>${h.project ?? h.source}</span><a href="${href('session', { source: h.source, id: h.sessionId, at: h.id })}">${t('event.session')}</a>`,
    }),
  )}</ol>`;
}

export function searchPage(
  ctx: Ctx,
  o: { query: string; tools: boolean; entries: Entry[]; events: SearchHit[] },
): void {
  const t = ctx.t;
  const nothing = o.entries.length === 0 && o.events.length === 0;
  renderPage(ctx, 200, {
    title: o.query ? t('search.titleFor', { q: o.query }) : t('nav.search'),
    nav: 'search',
    body: html`${pageHeader(ctx, { title: t('nav.search'), description: t('search.help') })}
    <form method="get" action="/admin/search" class="ol-toolbar" role="search">
      <div class="ol-field ol-grow">
        <label class="ol-label ol-sr-only" for="q">${t('nav.search')}</label>
        <div class="ol-search">${icon(ctx, 'search')}<input class="ol-input" type="search" id="q" name="q" value="${o.query}" placeholder="${t('search.placeholder')}" autofocus></div>
      </div>
      <label class="ol-check"><input class="ol-checkbox" type="checkbox" name="tools" value="1"${o.tools ? html` checked` : ''}>${t('search.tools')}</label>
      <button type="submit" class="ol-btn ol-btn-primary">${t('nav.search')}</button>
    </form>
    ${
      !o.query
        ? ''
        : nothing
          ? empty(ctx, {
              icon: 'search',
              title: t('search.nothing'),
              text: o.tools ? t('search.nothingHelp') : t('search.nothingTools'),
            })
          : html`${section({
              title: t('search.entries', { n: o.entries.length }),
              body:
                o.entries.length === 0
                  ? html`<p class="ol-muted ol-text-sm">${t('search.noEntries')}</p>`
                  : entryTable(ctx, o.entries),
            })}
    ${section({
      title: t('search.events', { n: o.events.length }),
      body:
        o.events.length === 0
          ? html`<p class="ol-muted ol-text-sm">${t('search.noEvents')}</p>`
          : searchEvents(ctx, o.events),
    })}`
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
