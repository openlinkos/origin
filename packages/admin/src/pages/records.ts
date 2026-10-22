import type { AdminSessionInfo, AuditRecord, TombstoneSummary } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { html } from '../html.js';
import { icon } from '../icons.js';
import { alert, badge, empty, linkButton, olderLink, pageHeader, tableWrap } from './components.js';
import { csrfField, docsUrl, renderPage } from './layout.js';

/** Tombstones: ids, counts, reasons, and times; never the forgotten text. */
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
            html`<th class="ol-num">#</th><th>${t('tombstones.time')}</th><th>${t('tombstones.target')}</th><th class="ol-num">${t('tombstones.entries')}</th><th class="ol-num">${t('tombstones.events')}</th><th>${t('tombstones.reason')}</th>`,
            o.tombstones.map(
              (r) => html`<tr>
          <td class="ol-num">${r.id}</td>
          <td class="ol-nowrap">${time(r.createdAt)}</td>
          <td class="ol-mono">${r.target}</td>
          <td class="ol-num">${fmtNumber(r.entries, ctx.lang)}</td>
          <td class="ol-num">${fmtNumber(r.events, ctx.lang)}</td>
          <td>${r.reason ? clip(r.reason, 200) : html`<span class="ol-subtle">—</span>`}</td>
        </tr>`,
            ),
          )
    }
    ${olderLink(ctx, o.tombstones.at(-1)?.id, o.more)}`,
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
