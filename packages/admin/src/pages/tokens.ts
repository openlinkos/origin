import type { TokenInfo } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { time } from '../context.js';
import { href, html } from '../html.js';
import { icon } from '../icons.js';
import type { Snippets } from '../service.js';
import {
  alert,
  badge,
  copyButton,
  empty,
  linkButton,
  pageIntro,
  panel,
  submitButton,
  tableWrap,
} from './components.js';
import { csrfField, renderPage } from './layout.js';
import { connectSnippetsBlock } from './overview.js';

export function tokensPage(ctx: Ctx, tokens: TokenInfo[], notice?: string): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.tokens'),
    nav: 'tokens',
    heading: t('tokens.title'),
    actions: linkButton(ctx, {
      href: '/admin/tokens/new',
      label: t('tokens.create'),
      icon: 'plus',
      variant: 'primary',
    }),
    body: html`${pageIntro(ctx, { description: t('tokens.help') })}
    ${notice ? html`<div class="ol-notices">${alert(ctx, 'success', notice)}</div>` : ''}
    ${
      tokens.length === 0
        ? empty(ctx, {
            icon: 'key-round',
            title: t('tokens.none'),
            text: t('tokens.noneHelp'),
            action: linkButton(ctx, {
              href: '/admin/tokens/new',
              label: t('tokens.create'),
              icon: 'plus',
              size: 'sm',
            }),
          })
        : tableWrap(
            html`<th>${t('tokens.name')}</th><th>${t('tokens.status')}</th><th>${t('tokens.created')}</th><th>${t('tokens.lastUsed')}</th><th class="ol-actions"><span class="ol-sr-only">${t('tokens.actions')}</span></th>`,
            tokens.map(
              (tok) => html`<tr>
          <td><span class="ol-cell-title">${tok.name}</span></td>
          <td>${tok.revokedAt === null ? badge(t('tokens.active'), 'success', { dot: true }) : html`${badge(t('tokens.revoked'))}<span class="ol-cell-sub">${time(tok.revokedAt)}</span>`}</td>
          <td class="ol-nowrap">${time(tok.createdAt)}</td>
          <td class="ol-nowrap">${time(tok.lastUsedAt)}</td>
          <td class="ol-actions">${tok.revokedAt === null ? html`<a class="ol-btn ol-btn-danger-soft ol-btn-sm" href="${href('tokens/revoke', { name: tok.name })}">${icon(ctx, 'ban', 'sm')}${t('tokens.revoke')}</a>` : ''}</td>
        </tr>`,
            ),
          )
    }`,
  });
}

export function newTokenPage(ctx: Ctx, status: number, o: { name?: string; error?: string }): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('tokens.create'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('tokens.create'),
    body: html`${pageIntro(ctx, { description: t('tokens.createHelp') })}
    <form method="post" action="/admin/tokens" class="ol-form">
      ${csrfField(ctx)}
      <div class="ol-field">
        <label class="ol-label" for="name">${t('tokens.name')}</label>
        <input class="ol-input ol-input-mono" type="text" id="name" name="name" required pattern="[a-z0-9][a-z0-9._\\-]{0,62}" maxlength="63" value="${o.name ?? ''}" autocomplete="off" spellcheck="false" placeholder="laptop" aria-describedby="name-hint${o.error ? ' name-error' : ''}"${o.error ? html` aria-invalid="true"` : ''}>
        <p class="ol-hint" id="name-hint">${t('tokens.nameHelp')}</p>
        ${o.error ? html`<p class="ol-field-error" id="name-error" role="alert">${icon(ctx, 'circle-alert', 'sm')}${o.error}</p>` : ''}
      </div>
      <div class="ol-form-actions">
        ${submitButton(ctx, { label: t('tokens.createButton'), icon: 'plus' })}
        ${linkButton(ctx, { href: '/admin/tokens', label: t('action.cancel'), variant: 'ghost' })}
      </div>
    </form>`,
  });
}

export function tokenCreatedPage(
  ctx: Ctx,
  o: { name: string; token: string; snippets: Snippets },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('tokens.createdTitle'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('tokens.createdTitle'),
    actions: linkButton(ctx, {
      href: '/admin/tokens',
      label: t('tokens.done'),
      icon: 'check',
      variant: 'primary',
    }),
    body: html`<section class="ol-section ol-stack">
      ${alert(ctx, 'warning', t('tokens.shownOnce', { name: o.name }))}
      <div class="ol-field">
        <span class="ol-label">${t('tokens.token')}</span>
        <code class="ol-secret" id="token-value">${o.token}</code>
      </div>
      <div>${copyButton(ctx, 'token-value', { labelled: true })}</div>
    </section>
    ${o.snippets.known ? '' : html`<div class="ol-section">${alert(ctx, 'info', t('connect.noPublicUrl'))}</div>`}
    ${connectSnippetsBlock(ctx, o.snippets)}`,
  });
}

export function revokeTokenPage(
  ctx: Ctx,
  status: number,
  o: { name: string; error?: string },
): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('tokens.revokeTitle'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('tokens.revokeTitle'),
    body: html`${panel(ctx, {
      danger: true,
      title: t('tokens.revokeButton', { name: o.name }),
      icon: 'triangle-alert',
      body: html`<div class="ol-stack">
        ${o.error ? alert(ctx, 'danger', o.error) : ''}
        <p>${t('tokens.revokeHelp', { name: o.name })}</p>
        <form method="post" action="/admin/tokens/revoke" class="ol-form-actions">
          ${csrfField(ctx)}
          <input type="hidden" name="name" value="${o.name}">
          ${submitButton(ctx, { label: t('tokens.revokeButton', { name: o.name }), icon: 'ban', variant: 'danger' })}
          ${linkButton(ctx, { href: '/admin/tokens', label: t('action.cancel'), variant: 'ghost' })}
        </form>
      </div>`,
    })}`,
  });
}
