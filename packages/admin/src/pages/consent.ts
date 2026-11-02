import {
  type AuthorizationRequest,
  DEFAULT_GRANT_DAYS,
  type DeviceRequest,
  GRANT_DAYS,
} from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { time } from '../context.js';
import { html } from '../html.js';
import { icon } from '../icons.js';
import { alert, linkButton } from './components.js';
import { brand, csrfField, renderPage } from './layout.js';
import { presetChoice } from './tokens.js';

/** The parameters of an authorization request that the consent form carries back. */
export const AUTHORIZE_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

/** A host and port, as the page names where a browser goes or what a client id points to. */
const hostOf = (url: string) => new URL(url).host;

const isLoopback = (url: string) => {
  const u = new URL(url);
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
};

/**
 * "<client> wants to use your Origin memory": the owner allows the app, choosing its preset (from
 * those it asked for) and for how long, or denies it. The page names where the browser returns,
 * and warns when that is a localhost address, which any app could be listening on; and says
 * whether the app's name comes from a metadata document at its own address, or is only what it
 * registered.
 */
export function consentPage(
  ctx: Ctx,
  o: { request: AuthorizationRequest; params: Record<string, string> },
): void {
  const t = ctx.t;
  const r = o.request;
  const client = r.client.name || t('consent.unnamed');
  renderPage(ctx, 200, {
    title: t('consent.title'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${t('consent.heading', { client })}</h1>
      <p>${t('consent.intro', { client, username: ctx.username ?? '' })}</p>
      <ul class="ol-stack admin-consent-facts">
        <li>${icon(ctx, 'link', 'sm')} ${t('consent.returnsTo', { host: hostOf(r.redirectUri) })}</li>
        <li>${icon(ctx, 'shield-check', 'sm')} ${r.client.document ? t('consent.document', { host: hostOf(r.client.id) }) : t('consent.registered')}</li>
      </ul>
      ${isLoopback(r.redirectUri) ? alert(ctx, 'warning', t('consent.localWarning')) : ''}
      <form method="post" action="/admin/oauth/authorize" class="ol-stack">
        ${csrfField(ctx)}
        ${AUTHORIZE_PARAMS.filter((k) => o.params[k] !== undefined).map(
          (k) => html`<input type="hidden" name="${k}" value="${o.params[k] ?? ''}">`,
        )}
        ${r.presets.length === 1 ? html`<p class="ol-hint">${t('consent.readonlyOnly')}</p>` : ''}
        ${presetChoice(ctx, r.presets, r.presets[0] ?? 'readonly')}
        <div class="ol-field">
          <label class="ol-label" for="days">${t('consent.duration')}</label>
          <select class="ol-select" id="days" name="days">${GRANT_DAYS.map(
            (d) =>
              html`<option value="${d}"${d === DEFAULT_GRANT_DAYS ? html` selected` : ''}>${t('consent.days', { n: d })}</option>`,
          )}</select>
        </div>
        <button type="submit" name="decision" value="allow" class="ol-btn ol-btn-primary ol-btn-lg ol-btn-block">${icon(ctx, 'check')}${t('consent.allow')}</button>
        <button type="submit" name="decision" value="deny" class="ol-btn ol-btn-ghost ol-btn-block">${t('consent.deny')}</button>
      </form>`,
  });
}

/** An authorization request that cannot go back to its app: its client or redirect URI is not valid. */
export function consentErrorPage(ctx: Ctx, status: number, message: string): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('consent.errorTitle'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${t('consent.errorTitle')}</h1>
      ${alert(ctx, 'danger', message)}
      <p>${t('consent.errorHelp')}</p>
      ${linkButton(ctx, { href: '/admin/', label: t('nav.backToOverview'), variant: 'secondary', block: true })}`,
  });
}

/** The code a device shows: entered here, or carried in the link it printed. */
export function activateCodePage(
  ctx: Ctx,
  status: number,
  o: { code?: string; error?: string },
): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('activate.title'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${t('activate.title')}</h1>
      <p>${t('activate.help')}</p>
      ${o.error ? alert(ctx, 'danger', o.error) : ''}
      <form method="get" action="/admin/activate" class="ol-stack">
        <div class="ol-field">
          <label class="ol-label" for="code">${t('activate.code')}</label>
          <input class="ol-input ol-input-lg ol-input-mono" id="code" type="text" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="BCDF-GHJK" value="${o.code ?? ''}" autofocus>
        </div>
        <button type="submit" class="ol-btn ol-btn-primary ol-btn-lg ol-btn-block">${t('activate.continue')}</button>
      </form>`,
  });
}

/** "Connect device <name> to your hub?", with when and from where it asked. */
export function activateConfirmPage(
  ctx: Ctx,
  status: number,
  o: { request: DeviceRequest; error?: string },
): void {
  const t = ctx.t;
  const r = o.request;
  renderPage(ctx, status, {
    title: t('activate.title'),
    bare: true,
    body: html`<h1 class="ol-auth-title">${t('activate.heading', { device: r.device })}</h1>
      <p>${t('activate.intro', { device: r.device })}</p>
      ${o.error ? alert(ctx, 'danger', o.error) : ''}
      <dl class="ol-dl">
        <dt>${t('activate.code')}</dt><dd class="ol-mono">${r.userCode}</dd>
        <dt>${t('activate.asked')}</dt><dd>${time(r.createdAt)}</dd>
        <dt>${t('activate.from')}</dt><dd class="ol-mono">${r.ip ?? '—'}</dd>
        <dt>${t('activate.expires')}</dt><dd>${time(r.expiresAt)}</dd>
      </dl>
      ${r.replaces ? alert(ctx, 'warning', t('activate.replaces', { device: r.device })) : ''}
      <p class="ol-hint">${t('activate.check')}</p>
      <form method="post" action="/admin/activate" class="ol-stack">
        ${csrfField(ctx)}
        <input type="hidden" name="code" value="${r.userCode}">
        <button type="submit" name="decision" value="approve" class="ol-btn ol-btn-primary ol-btn-lg ol-btn-block">${icon(ctx, 'laptop')}${t('activate.approve', { device: r.device })}</button>
        <button type="submit" name="decision" value="deny" class="ol-btn ol-btn-ghost ol-btn-block">${t('activate.deny')}</button>
      </form>`,
  });
}

/** What the owner decided. */
export function activateDonePage(ctx: Ctx, o: { device: string; approved: boolean }): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('activate.title'),
    bare: true,
    body: html`${brand(ctx)}
      <h1 class="ol-auth-title">${o.approved ? t('activate.approved', { device: o.device }) : t('activate.denied', { device: o.device })}</h1>
      ${alert(ctx, o.approved ? 'success' : 'info', o.approved ? t('activate.approvedHelp') : t('activate.deniedHelp'))}
      ${linkButton(ctx, { href: '/admin/tokens', label: t('nav.tokens'), variant: 'secondary', block: true })}`,
  });
}

/** The fields of an authorization request, from a query or a form, for the consent page. */
export function authorizeFields(get: (name: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** The consent page again, as a URL: where to come back after entering the password again. */
export function authorizeUrl(fields: Record<string, string>): string {
  return `/admin/oauth/authorize?${new URLSearchParams(fields).toString()}`;
}
