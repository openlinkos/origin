import type { AdminSessionInfo, AuditRecord, TombstoneSummary } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { html } from '../html.js';
import { alert, badge, csrfField, olderLink, renderPage } from './layout.js';

/** Tombstones: ids, counts, reasons, and times; never the forgotten text. */
export function tombstonesPage(
  ctx: Ctx,
  o: { tombstones: TombstoneSummary[]; more: boolean },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.tombstones'),
    nav: 'tombstones',
    body: html`<h1>${t('tombstones.title')}</h1>
    <p class="muted">${t('tombstones.help')}</p>
    <section class="card">
    ${
      o.tombstones.length === 0
        ? html`<p class="muted">${t('tombstones.none')}</p>`
        : html`<table>
      <thead><tr><th>#</th><th>${t('tombstones.time')}</th><th>${t('tombstones.target')}</th><th class="num">${t('tombstones.entries')}</th><th class="num">${t('tombstones.events')}</th><th>${t('tombstones.reason')}</th></tr></thead>
      <tbody>${o.tombstones.map(
        (r) => html`<tr>
          <td class="num">${r.id}</td>
          <td>${time(r.createdAt)}</td>
          <td class="mono">${r.target}</td>
          <td class="num">${fmtNumber(r.entries, ctx.lang)}</td>
          <td class="num">${fmtNumber(r.events, ctx.lang)}</td>
          <td>${r.reason ? clip(r.reason, 200) : html`<span class="muted">—</span>`}</td>
        </tr>`,
      )}</tbody>
    </table>`
    }
    </section>
    ${olderLink(ctx, o.tombstones.at(-1)?.id, o.more)}`,
  });
}

function detailText(detail: AuditRecord['detail']): string {
  if (!detail) return '';
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
}

export function auditPage(ctx: Ctx, o: { records: AuditRecord[]; more: boolean }): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.audit'),
    nav: 'audit',
    body: html`<h1>${t('audit.title')}</h1>
    <p class="muted">${t('audit.help')}</p>
    <section class="card">
    ${
      o.records.length === 0
        ? html`<p class="muted">${t('audit.none')}</p>`
        : html`<table>
      <thead><tr><th>${t('tombstones.time')}</th><th>${t('audit.actor')}</th><th>${t('audit.action')}</th><th>${t('tombstones.target')}</th><th>${t('audit.detail')}</th><th>${t('audit.client')}</th></tr></thead>
      <tbody>${o.records.map(
        (r) => html`<tr>
          <td>${time(r.at)}</td>
          <td>${r.actor} ${badge(r.channel)}</td>
          <td class="mono">${r.action}</td>
          <td class="mono">${r.target ?? ''}</td>
          <td class="mono small">${detailText(r.detail)}</td>
          <td class="small">${r.ip ?? ''}${r.userAgent ? html`<div class="muted" title="${r.userAgent}">${clip(r.userAgent, 40)}</div>` : ''}</td>
        </tr>`,
      )}</tbody>
    </table>`
    }
    </section>
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
    body: html`<h1>${t('signins.title')}</h1>
    <p class="muted">${t('signins.help')}</p>
    ${notice ? alert('ok', notice) : ''}
    <section class="card">
      <table>
        <thead><tr><th>${t('signins.started')}</th><th>${t('signins.lastSeen')}</th><th>${t('audit.client')}</th><th></th></tr></thead>
        <tbody>${sessions.map(
          (s) => html`<tr>
            <td>${time(s.createdAt)}</td>
            <td>${time(s.lastSeenAt)}</td>
            <td class="small">${s.ip ?? ''}${s.userAgent ? html`<div class="muted" title="${s.userAgent}">${clip(s.userAgent, 50)}</div>` : ''}</td>
            <td>${
              s.handle === mine
                ? badge(t('signins.thisSession'), 'ok')
                : html`<form method="post" action="/admin/signins/revoke" class="inline">${csrfField(ctx)}<input type="hidden" name="handle" value="${s.handle}"><button type="submit" class="link danger">${t('signins.revoke')}</button></form>`
            }</td>
          </tr>`,
        )}</tbody>
      </table>
    </section>
    ${
      others > 0
        ? html`<form method="post" action="/admin/signins/revoke" class="inline">${csrfField(ctx)}<button type="submit" class="danger">${t('signins.revokeOthers', { n: others })}</button></form>`
        : ''
    }
    <p class="muted small">${t('signins.cliHint')}</p>`,
  });
}
