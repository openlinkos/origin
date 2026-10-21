import type { TokenInfo } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { time } from '../context.js';
import { href, html } from '../html.js';
import type { Snippets } from '../service.js';
import { alert, badge, csrfField, renderPage } from './layout.js';
import { connectSnippetsBlock } from './overview.js';

export function tokensPage(ctx: Ctx, tokens: TokenInfo[], notice?: string): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.tokens'),
    nav: 'tokens',
    body: html`<h1>${t('tokens.title')}</h1>
    <p class="muted">${t('tokens.help')}</p>
    ${notice ? alert('ok', notice) : ''}
    <p><a class="button primary" href="/admin/tokens/new">${t('tokens.create')}</a></p>
    <section class="card">
    ${
      tokens.length === 0
        ? html`<p class="muted">${t('tokens.none')}</p>`
        : html`<table>
      <thead><tr><th>${t('tokens.name')}</th><th>${t('tokens.created')}</th><th>${t('tokens.lastUsed')}</th><th>${t('tokens.status')}</th><th></th></tr></thead>
      <tbody>${tokens.map(
        (tok) => html`<tr>
          <td>${tok.name}</td>
          <td>${time(tok.createdAt)}</td>
          <td>${time(tok.lastUsedAt)}</td>
          <td>${tok.revokedAt === null ? badge(t('tokens.active'), 'ok') : html`${badge(t('tokens.revoked'))} ${time(tok.revokedAt)}`}</td>
          <td>${tok.revokedAt === null ? html`<a href="${href('tokens/revoke', { name: tok.name })}">${t('tokens.revoke')}</a>` : ''}</td>
        </tr>`,
      )}</tbody>
    </table>`
    }
    </section>`,
  });
}

export function newTokenPage(ctx: Ctx, status: number, o: { name?: string; error?: string }): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('tokens.create'),
    nav: 'tokens',
    body: html`<p class="crumbs"><a href="/admin/tokens">${t('nav.tokens')}</a></p>
    <h1>${t('tokens.create')}</h1>
    <section class="card narrow">
      <p class="muted">${t('tokens.createHelp')}</p>
      ${o.error ? alert('error', o.error) : ''}
      <form method="post" action="/admin/tokens" class="stack">
        ${csrfField(ctx)}
        <label>${t('tokens.name')}
          <input type="text" name="name" required pattern="[a-z0-9][a-z0-9._\\-]{0,62}" maxlength="63" value="${o.name ?? ''}" autocomplete="off" spellcheck="false" placeholder="laptop">
        </label>
        <p class="muted small">${t('tokens.nameHelp')}</p>
        <button type="submit" class="primary">${t('tokens.createButton')}</button>
      </form>
    </section>`,
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
    body: html`<p class="crumbs"><a href="/admin/tokens">${t('nav.tokens')}</a></p>
    <h1>${t('tokens.createdTitle')}</h1>
    ${alert('warn', t('tokens.shownOnce', { name: o.name }))}
    <section class="card">
      <div class="snippet">
        <div class="snippet-head"><span>${t('tokens.token')}</span><button type="button" class="copy" data-copy="token-value" hidden>${t('action.copy')}</button></div>
        <pre id="token-value" class="secret"><code>${o.token}</code></pre>
      </div>
    </section>
    ${o.snippets.known ? '' : alert('info', t('connect.noPublicUrl'))}
    ${connectSnippetsBlock(ctx, o.snippets)}
    <p><a href="/admin/tokens">${t('tokens.done')}</a></p>`,
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
    body: html`<p class="crumbs"><a href="/admin/tokens">${t('nav.tokens')}</a></p>
    <h1>${t('tokens.revokeTitle')}</h1>
    <section class="card narrow">
      ${o.error ? alert('error', o.error) : ''}
      <p>${t('tokens.revokeHelp', { name: o.name })}</p>
      <form method="post" action="/admin/tokens/revoke" class="stack">
        ${csrfField(ctx)}
        <input type="hidden" name="name" value="${o.name}">
        <button type="submit" class="danger">${t('tokens.revokeButton', { name: o.name })}</button>
      </form>
      <p><a href="/admin/tokens">${t('action.cancel')}</a></p>
    </section>`,
  });
}
