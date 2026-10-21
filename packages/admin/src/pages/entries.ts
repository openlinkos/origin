import { ENTRY_KINDS, type Entry, type EventRow, type ForgetResult } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import type { EntryDetail, ForgetPlan } from '../service.js';
import { eventTag } from './browse.js';
import { alert, badge, csrfField, pager, renderPage } from './layout.js';

function kindSelect(ctx: Ctx, current: string, withAll: boolean): SafeHtml {
  return html`<select name="kind">${withAll ? html`<option value="">${ctx.t('filter.all')}</option>` : ''}${ENTRY_KINDS.map(
    (k) =>
      html`<option value="${k}"${k === current ? html` selected` : ''}>${ctx.t(`kind.${k}`)}</option>`,
  )}</select>`;
}

export function entriesPage(
  ctx: Ctx,
  o: {
    entries: Entry[];
    page: number;
    more: boolean;
    projects: string[];
    filter: { kind: string; project: string; history: boolean };
  },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.entries'),
    nav: 'entries',
    body: html`<h1>${t('entries.title')}</h1>
    <p class="muted">${t('entries.help')}</p>
    <form method="get" action="/admin/entries" class="filters">
      <label>${t('entries.kind')} ${kindSelect(ctx, o.filter.kind, true)}</label>
      <label>${t('filter.project')}
        <select name="project"><option value="">${t('filter.all')}</option>${o.projects.map(
          (p) =>
            html`<option value="${p}"${p === o.filter.project ? html` selected` : ''}>${p}</option>`,
        )}</select>
      </label>
      <label class="check"><input type="checkbox" name="history" value="1"${o.filter.history ? html` checked` : ''}> ${t('entries.history')}</label>
      <button type="submit">${t('filter.apply')}</button>
    </form>
    <section class="card">
    ${
      o.entries.length === 0
        ? html`<p class="muted">${t('entries.none')}</p>`
        : html`<table>
      <thead><tr><th>${t('tokens.created')}</th><th>${t('entries.kind')}</th><th>${t('entries.text')}</th><th class="num">${t('entries.confidence')}</th><th>${t('entries.author')}</th></tr></thead>
      <tbody>${o.entries.map(
        (e) => html`<tr>
          <td>${time(e.createdAt)}</td>
          <td>${badge(t(`kind.${e.kind}`), e.kind)} ${e.status === 'active' ? '' : badge(t(`status.${e.status}`))}</td>
          <td><a href="${href('entry', { id: e.id })}">${clip(e.text, 140)}</a></td>
          <td class="num">${e.confidence}</td>
          <td>${e.author}</td>
        </tr>`,
      )}</tbody>
    </table>`
    }
    </section>
    ${pager(ctx, o.page, o.more)}`,
  });
}

export function entryPage(ctx: Ctx, d: EntryDetail): void {
  const t = ctx.t;
  const e = d.entry;
  renderPage(ctx, 200, {
    title: e.id,
    nav: 'entries',
    body: html`<p class="crumbs"><a href="/admin/entries">${t('nav.entries')}</a></p>
    <h1 class="mono">${e.id}</h1>
    <div class="actions">
      ${e.status === 'active' ? html`<a class="button" href="${href('correct', { id: e.id })}">${t('entry.correct')}</a>` : ''}
      <a class="button danger" href="${href('forget', { id: e.id })}">${t('entry.forget')}</a>
    </div>
    ${e.status === 'superseded' && e.supersededBy ? alert('info', html`${t('entry.supersededBy')} <a class="mono" href="${href('entry', { id: e.supersededBy })}">${e.supersededBy}</a>`) : ''}
    <dl class="kv inline">
      <dt>${t('entries.kind')}</dt><dd>${badge(t(`kind.${e.kind}`), e.kind)}</dd>
      <dt>${t('entry.status')}</dt><dd>${t(`status.${e.status}`)}</dd>
      <dt>${t('entries.confidence')}</dt><dd>${e.confidence}</dd>
      <dt>${t('entries.author')}</dt><dd>${e.author}</dd>
      <dt>${t('filter.project')}</dt><dd>${e.project ?? '—'}</dd>
      <dt>${t('tokens.created')}</dt><dd>${time(e.createdAt)}</dd>
      ${e.validFrom !== null || e.validTo !== null ? html`<dt>${t('entry.valid')}</dt><dd>${time(e.validFrom)} – ${time(e.validTo)}</dd>` : ''}
    </dl>
    <section class="card"><div class="text">${e.text}</div></section>
    <section class="card">
      <h2>${t('entry.sources', { n: d.sources.length })}</h2>
      <ol class="events">${d.sources.map(
        (s) => html`<li class="event ${s.event.role}">
        <div class="event-head">${eventTag(s.event)} ${time(s.event.ts)} · ${s.event.source} · ${s.event.project ?? '—'}
          <a class="mono small" href="${href('event', { id: s.eventId })}">${s.eventId}</a></div>
        ${s.quote ? html`<blockquote>${s.quote}</blockquote>` : ''}
        <div class="text">${clip(s.event.text, 600)}</div>
      </li>`,
      )}</ol>
    </section>
    ${
      d.history.length > 1
        ? html`<section class="card">
      <h2>${t('entry.historyTitle')}</h2>
      <ol class="history">${d.history.map(
        (
          v,
        ) => html`<li>${v.id === e.id ? html`<strong class="mono">${v.id}</strong>` : html`<a class="mono" href="${href('entry', { id: v.id })}">${v.id}</a>`}
          · ${time(v.createdAt)} · ${v.author} · ${t(`status.${v.status}`)}
          <div class="text small">${clip(v.text, 300)}</div></li>`,
      )}</ol>
    </section>`
        : ''
    }`,
  });
}

export function correctPage(
  ctx: Ctx,
  status: number,
  o: { entry: Entry; text?: string; kind?: string; confidence?: string; error?: string },
): void {
  const t = ctx.t;
  const e = o.entry;
  renderPage(ctx, status, {
    title: t('correct.title'),
    nav: 'entries',
    body: html`<p class="crumbs"><a href="${href('entry', { id: e.id })}">${e.id}</a></p>
    <h1>${t('correct.title')}</h1>
    <p class="muted">${t('correct.help')}</p>
    <section class="card"><div class="text">${e.text}</div></section>
    ${o.error ? alert('error', o.error) : ''}
    <form method="post" action="/admin/correct" class="stack card">
      ${csrfField(ctx)}
      <input type="hidden" name="id" value="${e.id}">
      <label>${t('entries.text')}<textarea name="text" rows="5" required maxlength="20000">${o.text ?? e.text}</textarea></label>
      <div class="row">
        <label>${t('entries.kind')} ${kindSelect(ctx, o.kind ?? e.kind, false)}</label>
        <label>${t('entries.confidence')} <input type="number" name="confidence" min="0" max="1" step="0.05" value="${o.confidence ?? '1'}"></label>
      </div>
      <button type="submit" class="primary">${t('correct.submit')}</button>
    </form>`,
  });
}

export function rememberPage(
  ctx: Ctx,
  status: number,
  o: {
    event: EventRow;
    kind?: string;
    text?: string;
    quote?: string;
    confidence?: string;
    error?: string;
  },
): void {
  const t = ctx.t;
  const e = o.event;
  renderPage(ctx, status, {
    title: t('remember.title'),
    nav: 'entries',
    body: html`<p class="crumbs"><a href="${href('event', { id: e.id })}">${e.id}</a></p>
    <h1>${t('remember.title')}</h1>
    <p class="muted">${t('remember.help')}</p>
    <section class="card">
      <div class="event-head">${eventTag(e)} ${time(e.ts)} · ${e.source} · ${e.project ?? '—'}</div>
      <div class="text">${clip(e.text, 2000)}</div>
    </section>
    ${o.error ? alert('error', o.error) : ''}
    <form method="post" action="/admin/remember" class="stack card">
      ${csrfField(ctx)}
      <input type="hidden" name="event" value="${e.id}">
      <label>${t('entries.kind')} ${kindSelect(ctx, o.kind ?? 'memory', false)}</label>
      <p class="muted small">${t('remember.kinds')}</p>
      <label>${t('entries.text')}<textarea name="text" rows="4" required maxlength="20000" placeholder="${t('remember.textPlaceholder')}">${o.text ?? ''}</textarea></label>
      <label>${t('remember.quote')}<input type="text" name="quote" value="${o.quote ?? ''}" maxlength="2000"></label>
      <p class="muted small">${t('remember.quoteHelp')}</p>
      <label>${t('entries.confidence')} <input type="number" name="confidence" min="0" max="1" step="0.05" value="${o.confidence ?? '1'}"></label>
      <button type="submit" class="primary">${t('remember.submit')}</button>
    </form>`,
  });
}

export function forgetPage(
  ctx: Ctx,
  status: number,
  o: { id: string; plan: ForgetPlan | null; error?: string; reason?: string },
): void {
  const t = ctx.t;
  const plan = o.plan?.plan;
  const nothing = plan !== undefined && plan.entries.length === 0 && plan.events.length === 0;
  renderPage(ctx, status, {
    title: t('forget.title'),
    nav: 'entries',
    body: html`<h1>${t('forget.title')}</h1>
    ${o.error ? alert('error', o.error) : ''}
    ${
      !plan
        ? ''
        : nothing
          ? alert('info', t('forget.already', { id: o.id }))
          : html`${alert('warn', t('forget.warning'))}
    <section class="card">
      <h2>${t('forget.summary', { entries: plan.entries.length, events: plan.events.length })}</h2>
      <p class="muted">${t('forget.rules')}</p>
      ${
        plan.entries.length > 0
          ? html`<h3>${t('forget.entries')}</h3><ul class="ids">${plan.entries.map(
              (id) => html`<li><a class="mono" href="${href('entry', { id })}">${id}</a></li>`,
            )}</ul>`
          : ''
      }
      ${
        plan.events.length > 0
          ? html`<h3>${t('forget.events')}</h3><ul class="ids">${plan.events.map(
              (id) => html`<li><a class="mono" href="${href('event', { id })}">${id}</a></li>`,
            )}</ul>`
          : ''
      }
    </section>
    <form method="post" action="/admin/forget" class="stack card" data-confirm="${o.id}">
      ${csrfField(ctx)}
      <input type="hidden" name="id" value="${o.id}">
      <input type="hidden" name="digest" value="${o.plan?.digest ?? ''}">
      <label>${t('forget.reason')}<input type="text" name="reason" maxlength="500" value="${o.reason ?? ''}" autocomplete="off"></label>
      <p class="muted small">${t('forget.reasonHelp')}</p>
      <label>${t('forget.confirmLabel')} <code class="mono">${o.id}</code>
        <input type="text" name="confirm" required autocomplete="off" spellcheck="false">
      </label>
      <button type="submit" class="danger">${t('forget.submit')}</button>
    </form>`
    }
    <p><a href="/admin/">${t('action.cancel')}</a></p>`,
  });
}

export function forgottenPage(ctx: Ctx, r: ForgetResult): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('forget.doneTitle'),
    nav: 'tombstones',
    body: html`<h1>${t('forget.doneTitle')}</h1>
    ${alert('ok', t('forget.done', { entries: fmtNumber(r.entries.length, ctx.lang), events: fmtNumber(r.events.length, ctx.lang), tombstone: r.tombstoneId ?? '—' }))}
    <p>${t('forget.propagates')}</p>
    <p><a href="/admin/tombstones">${t('nav.tombstones')}</a> · <a href="/admin/">${t('nav.backToOverview')}</a></p>`,
  });
}
