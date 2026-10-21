import type { Entry, EventRow, SearchHit, SessionRow } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import type { EventDetail } from '../service.js';
import { alert, badge, pager, renderPage } from './layout.js';

const KIND_CLASS: Record<string, string> = {
  message: '',
  meta: 'muted',
  tool_use: 'tool',
  tool_result: 'tool',
  system: 'muted',
};

export function eventTag(e: Pick<EventRow, 'role' | 'kind'>): SafeHtml {
  return badge(e.kind === 'message' ? e.role : `${e.role}/${e.kind}`, KIND_CLASS[e.kind] ?? '');
}

function sessionLink(s: Pick<SessionRow, 'source' | 'sessionId'>, label: string): SafeHtml {
  return html`<a href="${href('session', { source: s.source, id: s.sessionId })}">${label}</a>`;
}

export function sessionsPage(
  ctx: Ctx,
  o: {
    sessions: SessionRow[];
    page: number;
    more: boolean;
    sources: string[];
    projects: string[];
    filter: { source: string; project: string };
  },
): void {
  const t = ctx.t;
  const option = (value: string, current: string) =>
    html`<option value="${value}"${value === current ? html` selected` : ''}>${value}</option>`;
  renderPage(ctx, 200, {
    title: t('nav.sessions'),
    nav: 'sessions',
    body: html`<h1>${t('sessions.title')}</h1>
    <form method="get" action="/admin/sessions" class="filters">
      <label>${t('filter.source')}
        <select name="source"><option value="">${t('filter.all')}</option>${o.sources.map((s) => option(s, o.filter.source))}</select>
      </label>
      <label>${t('filter.project')}
        <select name="project"><option value="">${t('filter.all')}</option>${o.projects.map((p) => option(p, o.filter.project))}</select>
      </label>
      <button type="submit">${t('filter.apply')}</button>
    </form>
    <section class="card">
    ${
      o.sessions.length === 0
        ? html`<p class="muted">${t('sessions.none')}</p>`
        : html`<table>
      <thead><tr><th>${t('sessions.ended')}</th><th>${t('overview.source')}</th><th>${t('filter.project')}</th><th>${t('sessions.titleColumn')}</th><th class="num">${t('overview.events')}</th></tr></thead>
      <tbody>${o.sessions.map(
        (s) => html`<tr>
          <td>${time(s.endedAt)}</td>
          <td>${s.source}</td>
          <td>${s.project ?? '—'}</td>
          <td>${sessionLink(s, s.title ? clip(s.title, 80) : s.sessionId)}</td>
          <td class="num">${fmtNumber(s.eventCount, ctx.lang)}</td>
        </tr>`,
      )}</tbody>
    </table>`
    }
    </section>
    ${pager(ctx, o.page, o.more)}`,
  });
}

export function sessionPage(
  ctx: Ctx,
  o: { session: SessionRow; events: EventRow[]; page: number; more: boolean; tools: boolean },
): void {
  const t = ctx.t;
  const s = o.session;
  const toggle = href('session', { source: s.source, id: s.sessionId, tools: !o.tools });
  renderPage(ctx, 200, {
    title: s.title ?? s.sessionId,
    nav: 'sessions',
    body: html`<p class="crumbs"><a href="/admin/sessions">${t('nav.sessions')}</a></p>
    <h1>${s.title ?? t('sessions.untitled')}</h1>
    <dl class="kv inline">
      <dt>${t('overview.source')}</dt><dd>${s.source}</dd>
      <dt>${t('sessions.id')}</dt><dd class="mono">${s.sessionId}</dd>
      <dt>${t('filter.project')}</dt><dd>${s.project ?? '—'}</dd>
      <dt>cwd</dt><dd class="path">${s.cwd ?? '—'}</dd>
      <dt>${t('sessions.time')}</dt><dd>${time(s.startedAt)} – ${time(s.endedAt)}</dd>
      <dt>${t('overview.events')}</dt><dd>${fmtNumber(s.eventCount, ctx.lang)}</dd>
    </dl>
    <p><a href="${toggle}">${o.tools ? t('sessions.hideTools') : t('sessions.showTools')}</a></p>
    <ol class="events">
    ${o.events.map(
      (e) => html`<li class="event ${e.role}">
        <div class="event-head">${eventTag(e)} ${time(e.ts)} <a class="mono small" href="${href('event', { id: e.id })}">${e.id}</a></div>
        <div class="text">${clip(e.text, 2000)}</div>
      </li>`,
    )}
    </ol>
    ${o.events.length === 0 ? html`<p class="muted">${t('sessions.noEvents')}</p>` : ''}
    ${pager(ctx, o.page, o.more)}`,
  });
}

export function entryLine(ctx: Ctx, e: Entry): SafeHtml {
  const t = ctx.t;
  return html`<li class="entry">
    <div class="event-head">${badge(t(`kind.${e.kind}`), e.kind)} ${e.status === 'active' ? '' : badge(t(`status.${e.status}`))} ${time(e.createdAt)} · ${e.author}${e.project ? html` · ${e.project}` : ''}
      <a class="mono small" href="${href('entry', { id: e.id })}">${e.id}</a></div>
    <div class="text">${clip(e.text, 600)}</div>
  </li>`;
}

export function eventPage(ctx: Ctx, d: EventDetail): void {
  const t = ctx.t;
  const e = d.event;
  const p = d.provenance;
  renderPage(ctx, 200, {
    title: e.id,
    nav: 'sessions',
    body: html`<p class="crumbs"><a href="${href('session', { source: e.source, id: e.sessionId })}">${t('event.session')}</a></p>
    <h1 class="mono">${e.id}</h1>
    <div class="actions">
      <a class="button" href="${href('remember', { event: e.id })}">${t('event.remember')}</a>
      <a class="button danger" href="${href('forget', { id: e.id })}">${t('event.forget')}</a>
    </div>
    <dl class="kv inline">
      <dt>${t('sessions.time')}</dt><dd>${time(e.ts)}</dd>
      <dt>${t('event.kind')}</dt><dd>${eventTag(e)}</dd>
      <dt>${t('overview.source')}</dt><dd>${e.source} ${e.agentVersion ? html`<span class="muted">${e.agentVersion}</span>` : ''}</dd>
      <dt>${t('filter.project')}</dt><dd>${e.project ?? '—'}</dd>
      <dt>cwd</dt><dd class="path">${e.cwd ?? '—'}</dd>
      <dt>${t('event.branch')}</dt><dd>${e.gitBranch ?? '—'}</dd>
    </dl>
    <section class="card"><div class="text">${e.text}</div></section>
    <section class="card">
      <h2>${t('event.provenance')}</h2>
      ${
        p
          ? html`<ol class="chain">
        <li><span class="chain-label">${t('event.device')}</span> ${p.device ? html`<a href="${href('device', { name: p.device })}">${p.device}</a>` : t('event.thisStore')}</li>
        <li><span class="chain-label">${t('event.originalFile')}</span> <span class="path">${p.originalPath}</span></li>
        <li><span class="chain-label">${t('event.generation')}</span> ${p.generation}</li>
        <li><span class="chain-label">${t('event.mirrorLine')}</span> <span class="path">raw/${p.mirror}:${p.line}</span></li>
      </ol>
      <form method="get" action="/admin/event-raw" class="raw-form" data-raw="${e.id}">
        <input type="hidden" name="id" value="${e.id}">
        <button type="submit">${t('event.showRaw')}</button>
      </form>
      <pre class="raw" id="raw-line" hidden></pre>`
          : html`<p class="muted">${t('event.noProvenance')}</p>`
      }
    </section>
    <section class="card">
      <h2>${t('event.citing')}</h2>
      ${
        d.citing.length === 0
          ? html`<p class="muted">${t('event.notCited')}</p>`
          : html`<ul class="entries">${d.citing.map((en) => entryLine(ctx, en))}</ul>`
      }
    </section>`,
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
    body: html`<p class="crumbs"><a href="${href('event', { id: r.id })}">${r.id}</a></p>
    <h1>${t('event.rawTitle')}</h1>
    ${r.line === null ? alert('warn', t('event.rawMissing')) : html`<pre class="raw">${r.line}</pre>`}
    ${r.truncated ? html`<p class="muted small">${t('event.rawTruncated', { n: fmtNumber(r.length, ctx.lang) })}</p>` : ''}`,
  });
}

export function searchPage(
  ctx: Ctx,
  o: { query: string; tools: boolean; entries: Entry[]; events: SearchHit[] },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: o.query ? t('search.titleFor', { q: o.query }) : t('nav.search'),
    nav: 'search',
    body: html`<h1>${t('nav.search')}</h1>
    <form method="get" action="/admin/search" class="filters">
      <input type="search" name="q" value="${o.query}" placeholder="${t('search.placeholder')}" autofocus>
      <label class="check"><input type="checkbox" name="tools" value="1"${o.tools ? html` checked` : ''}> ${t('search.tools')}</label>
      <button type="submit" class="primary">${t('nav.search')}</button>
    </form>
    ${
      o.query
        ? html`<section class="card">
      <h2>${t('search.entries', { n: o.entries.length })}</h2>
      ${o.entries.length === 0 ? html`<p class="muted">${t('search.noEntries')}</p>` : html`<ul class="entries">${o.entries.map((e) => entryLine(ctx, e))}</ul>`}
    </section>
    <section class="card">
      <h2>${t('search.events', { n: o.events.length })}</h2>
      ${
        o.events.length === 0
          ? html`<p class="muted">${t('search.noEvents')}</p>`
          : html`<ol class="events">${o.events.map(
              (h) => html`<li class="event ${h.role}">
          <div class="event-head">${eventTag(h)} ${time(h.ts)} · ${h.source} · ${h.project ?? '—'}
            <a class="mono small" href="${href('event', { id: h.id })}">${h.id}</a>
            · <a class="small" href="${href('session', { source: h.source, id: h.sessionId })}">${t('event.session')}</a></div>
          <div class="text">${h.snippet}</div>
        </li>`,
            )}</ol>`
      }
    </section>`
        : ''
    }`,
  });
}
