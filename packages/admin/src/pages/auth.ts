import type { Ctx } from '../context.js';
import { html } from '../html.js';
import { SIGN_IN_LINK_MS } from '../sessions.js';
import { alert, linkButton, pageIntro } from './components.js';
import { brand, csrfField, openSourceNote, renderPage } from './layout.js';

/** The password field and the submit button of the sign-in and re-authentication forms. */
function passwordField(ctx: Ctx, autofocus: boolean) {
  return html`<div class="ol-field">
          <label class="ol-label" for="password">${ctx.t('auth.password')}</label>
          <input class="ol-input ol-input-lg" id="password" type="password" name="password" required autocomplete="current-password" spellcheck="false"${autofocus ? html` autofocus` : ''}>
        </div>`;
}

const submit = (label: string) =>
  html`<button type="submit" class="ol-btn ol-btn-primary ol-btn-lg ol-btn-block">${label}</button>`;

/**
 * The hub's sign-in: the owner's username and the admin password. A hub without a username yet (a
 * new one, or one upgraded from a version without usernames) asks the owner to choose one, with
 * the password they already have.
 */
export function loginPage(
  ctx: Ctx,
  status: number,
  o: { next: string; error?: string; choose: boolean; username?: string },
): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('auth.signIn'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${o.choose ? t('auth.chooseTitle') : t('auth.signIn')}</h1>
      <p>${o.choose ? t('auth.chooseHelp') : t('auth.signInHelp')}</p>
      ${o.error ? alert(ctx, 'danger', o.error) : ''}
      <form method="post" action="/admin/login" class="ol-stack">
        <input type="hidden" name="next" value="${o.next}">
        <div class="ol-field">
          <label class="ol-label" for="username">${t('auth.username')}</label>
          <input class="ol-input ol-input-lg" id="username" type="text" name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value="${o.username ?? ''}"${o.choose ? html` pattern="[a-z0-9._\\-]{2,32}" aria-describedby="username-hint"` : ''} autofocus>
          ${o.choose ? html`<p class="ol-hint" id="username-hint">${t('auth.usernameHint')}</p>` : ''}
        </div>
        ${passwordField(ctx, false)}
        ${submit(o.choose ? t('auth.chooseTitle') : t('auth.signIn'))}
      </form>
      <details class="ol-details">
        <summary>${t('auth.forgot')}</summary>
        <p class="ol-hint">${t('auth.passwordHint')}</p>
        <div class="ol-code"><pre><code>origin admin password
origin admin username</code></pre></div>
      </details>
      ${openSourceNote(ctx)}`,
  });
}

/**
 * `origin ui` signed out: there is no password, only the one-time link that `origin ui` prints and
 * opens. This page explains where to find it, and why a link did not work.
 */
export function localLoginPage(ctx: Ctx, status: number, o: { error?: string }): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('auth.signIn'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${t('auth.signIn')}</h1>
      ${o.error ? alert(ctx, 'danger', o.error) : ''}
      <p>${t('local.signInHelp')}</p>
      <p class="ol-hint">${t('local.newLink', { min: SIGN_IN_LINK_MS / 60_000 })}</p>
      <div class="ol-code"><pre><code>origin ui</code></pre></div>
      ${openSourceNote(ctx)}`,
  });
}

export function reauthPage(ctx: Ctx, status: number, o: { next: string; error?: string }): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('auth.reauth'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${t('auth.reauthTitle')}</h1>
      <p>${t('auth.reauthHelp')}</p>
      ${o.error ? alert(ctx, 'danger', o.error) : ''}
      <form method="post" action="/admin/reauth" class="ol-stack">
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${o.next}">
        <input type="text" name="username" value="${ctx.username ?? ''}" autocomplete="username" hidden>
        ${passwordField(ctx, true)}
        ${submit(t('auth.confirm'))}
        ${linkButton(ctx, { href: '/admin/', label: t('action.cancel'), variant: 'ghost', block: true })}
      </form>`,
  });
}

export function errorPage(ctx: Ctx, status: number, message: string): void {
  const t = ctx.t;
  const title =
    status === 404
      ? t('error.notFound')
      : status === 410
        ? t('error.gone')
        : status === 403
          ? t('error.forbidden')
          : status === 429
            ? t('error.tooMany')
            : status >= 500
              ? t('error.internal')
              : t('error.badRequest');
  // Icons a failed page had recorded are not needed any more.
  ctx.icons.clear();
  const tone = status >= 500 ? 'danger' : 'warning';
  if (ctx.session === null) {
    // Signed out: a card on its own, without the brand panel.
    renderPage(ctx, status, {
      title,
      body: html`${brand(ctx)}
      <h1 class="ol-auth-title">${title}</h1>
      <p>${t('error.status', { status })}</p>
      ${alert(ctx, tone, message)}
      ${linkButton(ctx, { href: '/admin/', label: t('auth.signIn'), icon: 'log-in', variant: 'secondary', block: true })}`,
    });
    return;
  }
  renderPage(ctx, status, {
    title,
    heading: title,
    body: html`${pageIntro(ctx, { description: t('error.status', { status }) })}
    <div class="ol-stack">
      ${alert(ctx, tone, message)}
      <div>${linkButton(ctx, { href: '/admin/', label: t('nav.backToOverview'), icon: 'layout-dashboard' })}</div>
    </div>`,
  });
}
