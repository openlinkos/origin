import { ENTRY_KINDS, type Entry, type EventRow, type ForgetResult } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import type { EntryDetail, ForgetPlan } from '../service.js';
import { eventCard } from './browse.js';
import {
  alert,
  badge,
  empty,
  entryTable,
  feedItem,
  kindBadge,
  linkButton,
  pageHeader,
  pager,
  panel,
  section,
  statusBadge,
  submitButton,
  tableWrap,
} from './components.js';
import { csrfField, renderPage } from './layout.js';

function kindSelect(ctx: Ctx, id: string, current: string, withAll: boolean): SafeHtml {
  return html`<select class="ol-select" id="${id}" name="kind">${withAll ? html`<option value="">${ctx.t('filter.all')}</option>` : ''}${ENTRY_KINDS.map(
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
  const filtered = o.filter.kind !== '' || o.filter.project !== '' || o.filter.history;
  renderPage(ctx, 200, {
    title: t('nav.entries'),
    nav: 'entries',
    body: html`${pageHeader(ctx, { title: t('entries.title'), description: t('entries.help') })}
    <form method="get" action="/admin/entries" class="ol-toolbar">
      <div class="ol-field">
        <label class="ol-label" for="f-kind">${t('entries.kind')}</label>
        ${kindSelect(ctx, 'f-kind', o.filter.kind, true)}
      </div>
      <div class="ol-field">
        <label class="ol-label" for="f-project">${t('filter.project')}</label>
        <select class="ol-select" id="f-project" name="project"><option value="">${t('filter.all')}</option>${o.projects.map(
          (p) =>
            html`<option value="${p}"${p === o.filter.project ? html` selected` : ''}>${p}</option>`,
        )}</select>
      </div>
      <label class="ol-check admin-toolbar-check"><input class="ol-checkbox" type="checkbox" name="history" value="1"${o.filter.history ? html` checked` : ''}>${t('entries.history')}</label>
      <button type="submit" class="ol-btn ol-btn-secondary">${icon(ctx, 'filter')}${t('filter.apply')}</button>
    </form>
    ${
      o.entries.length === 0
        ? empty(ctx, {
            icon: 'book-marked',
            title: filtered ? t('entries.none') : t('entries.noneYet'),
            text: filtered ? t('sessions.noneFiltered') : t('entries.noneHelp'),
            action: filtered
              ? linkButton(ctx, { href: '/admin/entries', label: t('filter.clear'), size: 'sm' })
              : linkButton(ctx, {
                  href: '/admin/sessions',
                  label: t('entries.browseTimeline'),
                  icon: 'history',
                  size: 'sm',
                }),
          })
        : entryTable(ctx, o.entries)
    }
    ${pager(ctx, o.page, o.more)}`,
  });
}

export function entryPage(ctx: Ctx, d: EntryDetail): void {
  const t = ctx.t;
  const e = d.entry;
  renderPage(ctx, 200, {
    title: e.id,
    nav: 'entries',
    crumbs: [{ label: t('nav.entries'), href: '/admin/entries' }],
    body: html`${pageHeader(ctx, {
      title: html`<span class="ol-mono">${e.id}</span>`,
      badges: html`${kindBadge(ctx, e.kind)}${statusBadge(ctx, e.status)}`,
      actions: html`${e.status === 'active' ? linkButton(ctx, { href: href('correct', { id: e.id }), label: t('entry.correct'), icon: 'pencil' }) : ''}${linkButton(ctx, { href: href('forget', { id: e.id }), label: t('entry.forget'), icon: 'eraser', variant: 'danger-soft' })}`,
    })}
    ${e.status === 'superseded' && e.supersededBy ? html`<div class="admin-notices">${alert(ctx, 'info', html`${t('entry.supersededBy')} <a class="ol-mono" href="${href('entry', { id: e.supersededBy })}">${e.supersededBy}</a>`)}</div>` : ''}
    <div class="ol-grid ol-grid-sidebar ol-section">
      <section class="ol-panel">
        <h2 class="ol-sr-only">${t('entries.text')}</h2>
        <div class="ol-panel-body admin-text">${e.text}</div>
      </section>
      ${panel(ctx, {
        tag: 'aside',
        title: t('entry.details'),
        icon: 'book-marked',
        body: html`<dl class="ol-dl">
          <dt>${t('entries.kind')}</dt><dd>${kindBadge(ctx, e.kind)}</dd>
          <dt>${t('entry.status')}</dt><dd>${t(`status.${e.status}`)}</dd>
          <dt>${t('entries.confidence')}</dt><dd>${e.confidence}</dd>
          <dt>${t('entries.author')}</dt><dd>${e.author}</dd>
          <dt>${t('filter.project')}</dt><dd>${e.project ?? '—'}</dd>
          <dt>${t('tokens.created')}</dt><dd>${time(e.createdAt)}</dd>
          ${e.validFrom !== null || e.validTo !== null ? html`<dt>${t('entry.valid')}</dt><dd>${time(e.validFrom)} – ${time(e.validTo)}</dd>` : ''}
        </dl>`,
      })}
    </div>
    ${section({
      title: t('entry.sources', { n: d.sources.length }),
      description: t('entry.sourcesHelp'),
      body: html`<ol class="ol-feed">${d.sources.map((s) =>
        feedItem(ctx, s.event, {
          body: clip(s.event.text, 600),
          meta: html`<span>${s.event.project ?? s.event.source}</span>`,
          extra: s.quote ? html`<blockquote class="admin-quote">${s.quote}</blockquote>` : '',
        }),
      )}</ol>`,
    })}
    ${
      d.history.length > 1
        ? section({
            title: t('entry.historyTitle'),
            body: tableWrap(
              html`<th>${t('entries.text')}</th><th>${t('entries.author')}</th><th>${t('entry.status')}</th><th>${t('tokens.created')}</th>`,
              d.history.map(
                (v) => html`<tr${v.id === e.id ? html` aria-selected="true"` : ''}>
            <td>${v.id === e.id ? html`<span class="ol-cell-title">${clip(v.text, 300)}</span>` : html`<a class="ol-cell-title" href="${href('entry', { id: v.id })}">${clip(v.text, 300)}</a>`}<span class="ol-cell-sub ol-mono">${v.id}</span></td>
            <td>${v.author}</td>
            <td>${v.status === 'active' ? badge(t('status.active'), 'success', { dot: true }) : statusBadge(ctx, v.status)}</td>
            <td class="ol-nowrap">${time(v.createdAt)}</td>
          </tr>`,
              ),
            ),
          })
        : ''
    }`,
  });
}

/** The error of a form, next to its fields. */
function formError(ctx: Ctx, error: string | undefined): SafeHtml {
  return error ? alert(ctx, 'danger', error) : html``;
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
    crumbs: [
      { label: t('nav.entries'), href: '/admin/entries' },
      { label: e.id, href: href('entry', { id: e.id }) },
    ],
    body: html`${pageHeader(ctx, { title: t('correct.title'), description: t('correct.help') })}
    <div class="ol-grid ol-grid-2">
      <form method="post" action="/admin/correct" class="ol-form">
        ${formError(ctx, o.error)}
        ${csrfField(ctx)}
        <input type="hidden" name="id" value="${e.id}">
        <div class="ol-field">
          <label class="ol-label" for="text">${t('entries.text')}</label>
          <textarea class="ol-textarea" id="text" name="text" rows="5" required maxlength="20000">${o.text ?? e.text}</textarea>
        </div>
        <div class="ol-grid ol-grid-2">
          <div class="ol-field">
            <label class="ol-label" for="kind">${t('entries.kind')}</label>
            ${kindSelect(ctx, 'kind', o.kind ?? e.kind, false)}
          </div>
          <div class="ol-field">
            <label class="ol-label" for="confidence">${t('entries.confidence')}</label>
            <input class="ol-input" type="number" id="confidence" name="confidence" min="0" max="1" step="0.05" value="${o.confidence ?? '1'}">
          </div>
        </div>
        <div class="ol-form-actions">
          ${submitButton(ctx, { label: t('correct.submit') })}
          ${linkButton(ctx, { href: href('entry', { id: e.id }), label: t('action.cancel'), variant: 'ghost' })}
        </div>
      </form>
      ${panel(ctx, {
        tag: 'aside',
        title: t('correct.current'),
        icon: 'book-marked',
        badge: kindBadge(ctx, e.kind),
        body: html`<div class="admin-text">${e.text}</div>`,
      })}
    </div>`,
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
    crumbs: [
      { label: t('nav.sessions'), href: '/admin/sessions' },
      { label: e.id, href: href('event', { id: e.id }) },
    ],
    body: html`${pageHeader(ctx, { title: t('remember.title'), description: t('remember.help') })}
    <div class="ol-grid ol-grid-2">
      <form method="post" action="/admin/remember" class="ol-form">
        ${formError(ctx, o.error)}
        ${csrfField(ctx)}
        <input type="hidden" name="event" value="${e.id}">
        <div class="ol-field">
          <label class="ol-label" for="kind">${t('entries.kind')}</label>
          ${kindSelect(ctx, 'kind', o.kind ?? 'memory', false)}
          <p class="ol-hint">${t('remember.kinds')}</p>
        </div>
        <div class="ol-field">
          <label class="ol-label" for="text">${t('entries.text')}</label>
          <textarea class="ol-textarea" id="text" name="text" rows="4" required maxlength="20000" placeholder="${t('remember.textPlaceholder')}">${o.text ?? ''}</textarea>
        </div>
        <div class="ol-field">
          <label class="ol-label" for="quote">${t('remember.quote')}</label>
          <input class="ol-input" type="text" id="quote" name="quote" value="${o.quote ?? ''}" maxlength="2000" aria-describedby="quote-hint">
          <p class="ol-hint" id="quote-hint">${t('remember.quoteHelp')}</p>
        </div>
        <div class="ol-field">
          <label class="ol-label" for="confidence">${t('entries.confidence')}</label>
          <input class="ol-input admin-input-short" type="number" id="confidence" name="confidence" min="0" max="1" step="0.05" value="${o.confidence ?? '1'}">
        </div>
        <div class="ol-form-actions">
          ${submitButton(ctx, { label: t('remember.submit'), icon: 'bookmark' })}
          ${linkButton(ctx, { href: href('event', { id: e.id }), label: t('action.cancel'), variant: 'ghost' })}
        </div>
      </form>
      <section>
        <h2 class="ol-section-title admin-heading">${t('remember.source')}</h2>
        ${eventCard(ctx, e)}
      </section>
    </div>`,
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
  const idList = (ids: string[], path: 'entry' | 'event') =>
    html`<ul class="admin-ids">${ids.map((id) => html`<li><a class="ol-mono" href="${href(path, { id })}">${id}</a></li>`)}</ul>`;
  renderPage(ctx, status, {
    title: t('forget.title'),
    nav: 'tombstones',
    body: html`${pageHeader(ctx, {
      title: html`${t('forget.title')} <span class="ol-mono">${o.id}</span>`,
      description: t('forget.rules'),
    })}
    ${o.error ? html`<div class="admin-notices">${alert(ctx, 'danger', o.error)}</div>` : ''}
    ${
      !plan
        ? ''
        : nothing
          ? html`<div class="ol-stack">${alert(ctx, 'info', t('forget.already', { id: o.id }))}<div>${linkButton(ctx, { href: '/admin/', label: t('nav.backToOverview') })}</div></div>`
          : panel(ctx, {
              danger: true,
              title: t('forget.summary', {
                entries: plan.entries.length,
                events: plan.events.length,
              }),
              icon: 'triangle-alert',
              body: html`<div class="ol-stack">
        <p>${t('forget.warning')}</p>
        ${plan.entries.length > 0 ? html`<div><h3 class="ol-heading-sm">${t('forget.entries')}</h3>${idList(plan.entries, 'entry')}</div>` : ''}
        ${plan.events.length > 0 ? html`<div><h3 class="ol-heading-sm">${t('forget.events')}</h3>${idList(plan.events, 'event')}</div>` : ''}
        <form method="post" action="/admin/forget" class="ol-form" data-confirm="${o.id}">
          ${csrfField(ctx)}
          <input type="hidden" name="id" value="${o.id}">
          <input type="hidden" name="digest" value="${o.plan?.digest ?? ''}">
          <div class="ol-field">
            <label class="ol-label" for="reason">${t('forget.reason')}</label>
            <input class="ol-input" type="text" id="reason" name="reason" maxlength="500" value="${o.reason ?? ''}" autocomplete="off" aria-describedby="reason-hint">
            <p class="ol-hint" id="reason-hint">${t('forget.reasonHelp')}</p>
          </div>
          <div class="ol-field">
            <label class="ol-label" for="confirm">${t('forget.confirmLabel')} <code>${o.id}</code></label>
            <input class="ol-input ol-input-mono" type="text" id="confirm" name="confirm" required autocomplete="off" spellcheck="false">
          </div>
          <div class="ol-form-actions">
            ${submitButton(ctx, { label: t('forget.submit'), icon: 'eraser', variant: 'danger' })}
            ${linkButton(ctx, { href: '/admin/', label: t('action.cancel'), variant: 'ghost' })}
          </div>
        </form>
      </div>`,
            })
    }`,
  });
}

export function forgottenPage(ctx: Ctx, r: ForgetResult): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('forget.doneTitle'),
    nav: 'tombstones',
    body: html`${pageHeader(ctx, { title: t('forget.doneTitle'), description: t('forget.propagates') })}
    <div class="ol-stack">
      ${alert(ctx, 'success', t('forget.done', { entries: fmtNumber(r.entries.length, ctx.lang), events: fmtNumber(r.events.length, ctx.lang), tombstone: r.tombstoneId ?? '—' }))}
      <div class="ol-cluster">
        ${linkButton(ctx, { href: '/admin/tombstones', label: t('nav.tombstones'), icon: 'eraser' })}
        ${linkButton(ctx, { href: '/admin/', label: t('nav.backToOverview'), variant: 'ghost' })}
      </div>
    </div>`,
  });
}
