import type { Ctx } from '../context.js';
import { html } from '../html.js';
import { alert, csrfField, renderPage } from './layout.js';

export function loginPage(ctx: Ctx, status: number, o: { next: string; error?: string }): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('auth.signIn'),
    bare: true,
    body: html`<section class="card narrow">
      <h1>${t('auth.signInTitle')}</h1>
      <p class="muted">${t('auth.signInHelp')}</p>
      ${o.error ? alert('error', o.error) : ''}
      <form method="post" action="/admin/login" class="stack">
        <input type="hidden" name="next" value="${o.next}">
        <input type="text" name="username" value="origin-admin" autocomplete="username" hidden>
        <label>${t('auth.password')}
          <input type="password" name="password" required autocomplete="current-password" spellcheck="false" autofocus>
        </label>
        <button type="submit" class="primary">${t('auth.signIn')}</button>
      </form>
      <p class="muted small">${t('auth.passwordHint')}</p>
      <pre><code>origin admin password</code></pre>
    </section>`,
  });
}

export function reauthPage(ctx: Ctx, status: number, o: { next: string; error?: string }): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('auth.reauth'),
    bare: true,
    body: html`<section class="card narrow">
      <h1>${t('auth.reauthTitle')}</h1>
      <p class="muted">${t('auth.reauthHelp')}</p>
      ${o.error ? alert('error', o.error) : ''}
      <form method="post" action="/admin/reauth" class="stack">
        ${csrfField(ctx)}
        <input type="hidden" name="next" value="${o.next}">
        <input type="text" name="username" value="origin-admin" autocomplete="username" hidden>
        <label>${t('auth.password')}
          <input type="password" name="password" required autocomplete="current-password" spellcheck="false" autofocus>
        </label>
        <button type="submit" class="primary">${t('auth.confirm')}</button>
      </form>
      <p><a href="/admin/">${t('action.cancel')}</a></p>
    </section>`,
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
  renderPage(ctx, status, {
    title,
    bare: ctx.session === null,
    body: html`<section class="card narrow">
      <h1>${title}</h1>
      ${alert(status >= 500 ? 'error' : 'warn', message)}
      <p><a href="/admin/">${t('nav.backToOverview')}</a></p>
    </section>`,
  });
}
