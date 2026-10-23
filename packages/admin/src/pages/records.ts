import type { AdminSessionInfo, AuditRecord, TombstoneSummary } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import type { TombstoneDetail } from '../service.js';
import {
  alert,
  badge,
  empty,
  feedItem,
  kindBadge,
  linkButton,
  olderLink,
  pageHeader,
  panel,
  section,
  submitButton,
  tableWrap,
} from './components.js';
import { csrfField, docsUrl, renderPage } from './layout.js';

/** A forget or a restore, as a badge. */
function kindTag(ctx: Ctx, t: TombstoneSummary): SafeHtml {
  return t.kind === 'restore'
    ? badge(ctx.t('tombstones.kind.restore'), 'success', { square: true })
    : badge(ctx.t('tombstones.kind.forget'), 'danger', { square: true });
}

/** Whether a forget is in effect, or which restore lifted it. */
function statusTag(ctx: Ctx, t: TombstoneSummary): SafeHtml {
  if (t.kind === 'restore') return html`<span class="ol-subtle">—</span>`;
  if (t.inEffect) return badge(ctx.t('tombstones.inEffect'), 'warning', { dot: true });
  return html`${badge(ctx.t('tombstones.restored'), 'neutral')}${t.restoredBy.map(
    (id) =>
      html`<span class="ol-cell-sub"><a class="ol-mono" href="${href('tombstone', { id })}">${id}</a></span>`,
  )}`;
}

function covers(ctx: Ctx, t: TombstoneSummary): SafeHtml {
  if (t.kind === 'restore') return html`<span class="ol-subtle">—</span>`;
  return html`${ctx.t('tombstones.coversCount', { entries: fmtNumber(t.entries, ctx.lang), events: fmtNumber(t.events, ctx.lang) })}`;
}

/** What a tombstone targets: a forget's entry or event id, or the forget a restore lifts. */
function targetCell(t: TombstoneSummary): SafeHtml {
  return t.kind === 'restore'
    ? html`<a class="ol-mono" href="${href('tombstone', { id: t.target })}">${t.target}</a>`
    : html`<span class="ol-mono">${t.target}</span>`;
}

/**
 * Forgets and restores: each record with its time, origin, author, reason, and what it covers.
 * The hidden text is on each forget's own page.
 */
export function tombstonesPage(
  ctx: Ctx,
  o: { tombstones: TombstoneSummary[]; more: boolean },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.tombstones'),
    nav: 'tombstones',
    body: html`${pageHeader(ctx, { title: t('tombstones.title'), description: t('tombstones.help') })}
    ${
      o.tombstones.length === 0
        ? empty(ctx, {
            icon: 'eraser',
            title: t('tombstones.none'),
            text: t('tombstones.noneHelp'),
            action: linkButton(ctx, {
              href: docsUrl(ctx, 'guide/privacy#forgetting'),
              label: t('tombstones.howItWorks'),
              size: 'sm',
            }),
          })
        : tableWrap(
            html`<th>${t('tombstones.time')}</th><th>${t('tombstones.record')}</th><th>${t('tombstones.target')}</th><th>${t('tombstones.origin')}</th><th>${t('tombstones.covers')}</th><th>${t('tombstones.status')}</th><th>${t('tombstones.reason')}</th>`,
            o.tombstones.map(
              (r) => html`<tr>
          <td class="ol-nowrap">${time(r.createdAt)}</td>
          <td class="ol-nowrap"><span class="ol-cluster">${kindTag(ctx, r)}<a class="ol-mono" href="${href('tombstone', { id: r.id })}">${r.id}</a></span></td>
          <td>${targetCell(r)}</td>
          <td class="ol-nowrap">${r.origin}${r.author ? html`<span class="ol-cell-sub">${r.author}</span>` : ''}</td>
          <td class="ol-nowrap">${covers(ctx, r)}</td>
          <td>${statusTag(ctx, r)}</td>
          <td>${r.reason ? clip(r.reason, 200) : html`<span class="ol-subtle">—</span>`}</td>
        </tr>`,
            ),
          )
    }
    ${olderLink(ctx, o.tombstones.at(-1)?.id, o.more)}`,
  });
}

/** What a forget in effect hides here: its entries and the session events, text included. */
function hiddenSection(ctx: Ctx, d: TombstoneDetail): SafeHtml {
  const t = ctx.t;
  const h = d.hidden;
  if (!h) return html``;
  const more = (shown: number, all: number) =>
    all > shown
      ? html`<p class="ol-hint">${t('tombstone.more', { n: fmtNumber(all - shown, ctx.lang) })}</p>`
      : '';
  const entries =
    h.entryCount === 0
      ? ''
      : html`<div class="ol-stack"><h3 class="ol-heading-sm">${t('tombstone.hiddenEntries', { n: fmtNumber(h.entryCount, ctx.lang) })}</h3>
        <ul class="ol-stack">${h.entries.map(
          (e) => html`<li class="ol-panel"><div class="ol-panel-body ol-stack">
            <span class="ol-cluster">${kindBadge(ctx, e.kind)}<span class="ol-mono">${e.id}</span><span>${e.author}</span>${time(e.createdAt)}</span>
            <div class="ol-text-pre">${e.text}</div>
          </div></li>`,
        )}</ul>${more(h.entries.length, h.entryCount)}</div>`;
  const events =
    h.eventCount === 0
      ? ''
      : html`<div class="ol-stack"><h3 class="ol-heading-sm">${t('tombstone.hiddenEvents', { n: fmtNumber(h.eventCount, ctx.lang) })}</h3>
        <ol class="ol-feed">${h.events.map((e) =>
          feedItem(ctx, e, {
            body: clip(e.text, 4000),
            meta: html`<span>${e.project ?? e.source}</span><span class="ol-mono">${e.sessionId}</span><span class="ol-mono">${e.id}</span>`,
            link: false,
          }),
        )}</ol>${more(h.events.length, h.eventCount)}</div>`;
  return section({
    title: t('tombstone.hiddenTitle'),
    description: t('tombstone.hiddenHelp'),
    body:
      h.entryCount + h.eventCount === 0
        ? html`<p class="ol-subtle">${t('tombstone.nothingHidden')}</p>`
        : html`<div class="ol-stack">${entries}${events}</div>`,
  });
}

/** The form that restores a forget in effect, with what it would bring back. */
function restoreForm(ctx: Ctx, d: TombstoneDetail, o: { reason?: string }): SafeHtml {
  const t = ctx.t;
  const plan = d.restorePlan;
  if (!plan) return html``;
  return panel(ctx, {
    title: t('restore.title'),
    icon: 'history',
    body: html`<div class="ol-stack">
      <p>${t('restore.plan', { entries: fmtNumber(plan.entries.length, ctx.lang), events: fmtNumber(plan.events.length, ctx.lang) })}</p>
      <form method="post" action="/admin/restore" class="ol-form">
        ${csrfField(ctx)}
        <input type="hidden" name="id" value="${d.tombstone.id}">
        <div class="ol-field">
          <label class="ol-label" for="reason">${t('restore.reason')}</label>
          <input class="ol-input" type="text" id="reason" name="reason" required maxlength="500" value="${o.reason ?? ''}" autocomplete="off" aria-describedby="reason-hint">
          <p class="ol-hint" id="reason-hint">${t('restore.reasonHelp')}</p>
        </div>
        <div class="ol-form-actions">
          ${submitButton(ctx, { label: t('restore.submit'), icon: 'history' })}
        </div>
      </form>
    </div>`,
  });
}

/**
 * One forget or restore. For a forget in effect, the owner sees what it hides, text included, and
 * can restore it; nothing else in the UI shows hidden text.
 */
export function tombstonePage(
  ctx: Ctx,
  status: number,
  o: { detail: TombstoneDetail; error?: string; reason?: string },
): void {
  const t = ctx.t;
  const d = o.detail;
  const r = d.tombstone;
  const isForget = r.kind === 'forget';
  const notice = isForget
    ? r.inEffect
      ? ''
      : alert(ctx, 'info', t('tombstone.restoredNotice'))
    : d.forget
      ? ''
      : alert(ctx, 'info', t('tombstone.unknownForget'));
  renderPage(ctx, status, {
    title: r.id,
    nav: 'tombstones',
    crumbs: [{ label: t('nav.tombstones'), href: '/admin/tombstones' }],
    body: html`${pageHeader(ctx, {
      title: html`${isForget ? t('tombstone.forgetTitle') : t('tombstone.restoreTitle')} <span class="ol-mono">${r.id}</span>`,
      badges: html`${kindTag(ctx, r)}${isForget ? statusTag(ctx, { ...r, restoredBy: [] }) : ''}`,
      description: isForget ? t('tombstone.forgetHelp') : t('tombstone.restoreHelp'),
    })}
    ${o.error ? html`<div class="ol-notices">${alert(ctx, 'danger', o.error)}</div>` : ''}
    ${notice ? html`<div class="ol-notices">${notice}</div>` : ''}
    <div class="ol-grid ol-grid-sidebar ol-section">
      ${panel(ctx, {
        title: t('tombstone.details'),
        icon: isForget ? 'eraser' : 'history',
        body: html`<dl class="ol-dl">
          <dt>${t('tombstones.target')}</dt><dd>${targetCell(r)}</dd>
          <dt>${t('tombstones.reason')}</dt><dd>${r.reason ? html`<span class="ol-text-pre">${r.reason}</span>` : html`<span class="ol-subtle">—</span>`}</dd>
          <dt>${t('tombstones.time')}</dt><dd>${time(r.createdAt)}</dd>
          <dt>${t('tombstones.origin')}</dt><dd>${r.origin}</dd>
          <dt>${t('tombstones.author')}</dt><dd>${r.author ?? html`<span class="ol-subtle">—</span>`}</dd>
          ${isForget ? html`<dt>${t('tombstones.covers')}</dt><dd>${covers(ctx, r)}</dd>` : ''}
          ${isForget && d.restores.length > 0 ? html`<dt>${t('tombstone.restores')}</dt><dd>${d.restores.map((x) => html`<span class="ol-cell-sub"><a class="ol-mono" href="${href('tombstone', { id: x.id })}">${x.id}</a> ${time(x.createdAt)} · ${x.reason ?? '—'}</span>`)}</dd>` : ''}
          ${!isForget && d.forget ? html`<dt>${t('tombstone.liftsForget')}</dt><dd><span class="ol-mono">${d.forget.target}</span>${d.forget.reason ? html`<span class="ol-cell-sub">${d.forget.reason}</span>` : ''}</dd>` : ''}
        </dl>`,
      })}
      ${restoreForm(ctx, d, { reason: o.reason })}
    </div>
    ${hiddenSection(ctx, d)}
    ${linkButton(ctx, { href: '/admin/tombstones', label: t('nav.tombstones'), variant: 'ghost', icon: 'eraser' })}`,
  });
}

function detailText(detail: AuditRecord['detail']): string {
  if (!detail) return '';
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
}

/** A client: its address, and its user agent shortened (the full one in the tooltip). */
function client(ip: string | null, userAgent: string | null, max: number) {
  return html`${ip ?? ''}${userAgent ? html`<span class="ol-cell-sub" title="${userAgent}">${clip(userAgent, max)}</span>` : ''}`;
}

export function auditPage(ctx: Ctx, o: { records: AuditRecord[]; more: boolean }): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.audit'),
    nav: 'audit',
    body: html`${pageHeader(ctx, { title: t('audit.title'), description: t('audit.help') })}
    ${
      o.records.length === 0
        ? empty(ctx, { icon: 'scroll-text', title: t('audit.none'), text: t('audit.noneHelp') })
        : tableWrap(
            html`<th>${t('tombstones.time')}</th><th>${t('audit.actor')}</th><th>${t('audit.action')}</th><th>${t('tombstones.target')}</th><th>${t('audit.detail')}</th><th>${t('audit.client')}</th>`,
            o.records.map(
              (r) => html`<tr>
          <td class="ol-nowrap">${time(r.at)}</td>
          <td class="ol-nowrap">${r.actor} ${badge(r.channel, 'neutral', { square: true })}</td>
          <td class="ol-mono">${r.action}</td>
          <td class="ol-mono">${r.target ?? ''}</td>
          <td class="ol-mono ol-text-xs">${detailText(r.detail)}</td>
          <td>${client(r.ip, r.userAgent, 40)}</td>
        </tr>`,
            ),
            'ol-table-compact',
          )
    }
    ${olderLink(ctx, o.records.at(-1)?.id, o.more)}`,
  });
}

export function signinsPage(ctx: Ctx, sessions: AdminSessionInfo[], notice?: string): void {
  const t = ctx.t;
  const mine = ctx.session?.handle;
  const others = sessions.filter((s) => s.handle !== mine).length;
  renderPage(ctx, 200, {
    title: t('nav.signins'),
    nav: 'signins',
    body: html`${pageHeader(ctx, {
      title: t('signins.title'),
      description: t('signins.help'),
      actions:
        others > 0
          ? html`<form method="post" action="/admin/signins/revoke">${csrfField(ctx)}<button type="submit" class="ol-btn ol-btn-danger-soft">${icon(ctx, 'log-out')}${t('signins.revokeOthers', { n: others })}</button></form>`
          : '',
    })}
    ${notice ? html`<div class="ol-notices">${alert(ctx, 'success', notice)}</div>` : ''}
    ${tableWrap(
      html`<th>${t('signins.started')}</th><th>${t('signins.lastSeen')}</th><th>${t('audit.client')}</th><th class="ol-actions"><span class="ol-sr-only">${t('tokens.actions')}</span></th>`,
      sessions.map(
        (s) => html`<tr${s.handle === mine ? html` aria-selected="true"` : ''}>
            <td class="ol-nowrap">${time(s.createdAt)}</td>
            <td class="ol-nowrap">${time(s.lastSeenAt)}</td>
            <td>${client(s.ip, s.userAgent, 60)}</td>
            <td class="ol-actions">${
              s.handle === mine
                ? badge(t('signins.thisSession'), 'success', { dot: true })
                : html`<form method="post" action="/admin/signins/revoke">${csrfField(ctx)}<input type="hidden" name="handle" value="${s.handle}"><button type="submit" class="ol-btn ol-btn-danger-soft ol-btn-sm">${t('signins.revoke')}</button></form>`
            }</td>
          </tr>`,
      ),
    )}
    <p class="ol-hint admin-after">${t('signins.cliHint')}</p>`,
  });
}
