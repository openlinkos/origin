import { type Ctx, fmtNumber } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { sendHtml } from '../http.js';
import { HTML_LANG, type MessageKey } from '../i18n/index.js';
import { type IconName, icon, iconSprite } from '../icons.js';

export type NavKey =
  | 'overview'
  | 'sessions'
  | 'search'
  | 'entries'
  | 'recalls'
  | 'devices'
  | 'tokens'
  | 'connect'
  | 'tombstones'
  | 'audit'
  | 'signins';

interface NavItem {
  key: NavKey;
  path: string;
  label: MessageKey;
  icon: IconName;
  /** A page of the hub only, not of `origin ui`. */
  hubOnly?: boolean;
}

/** The sidebar of a mode: `origin ui` has no devices, tokens, connection commands, or sign-ins. */
function navFor(ctx: Ctx): typeof NAV {
  if (ctx.mode === 'hub') return NAV;
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.hubOnly) })).filter(
    (g) => g.items.length > 0,
  );
}

/** The sidebar: the memory first, then the settings. Search is in the top bar. */
const NAV: Array<{ label?: MessageKey; items: NavItem[] }> = [
  {
    items: [
      { key: 'overview', path: '', label: 'nav.overview', icon: 'layout-dashboard' },
      { key: 'sessions', path: 'sessions', label: 'nav.sessions', icon: 'history' },
      { key: 'recalls', path: 'recalls', label: 'nav.recalls', icon: 'lightbulb' },
      { key: 'entries', path: 'entries', label: 'nav.entries', icon: 'book-marked' },
    ],
  },
  {
    label: 'nav.groupSettings',
    items: [
      { key: 'devices', path: 'devices', label: 'nav.devices', icon: 'laptop', hubOnly: true },
      { key: 'tokens', path: 'tokens', label: 'nav.tokens', icon: 'key-round', hubOnly: true },
      { key: 'connect', path: 'connect', label: 'nav.connect', icon: 'plug', hubOnly: true },
      { key: 'tombstones', path: 'tombstones', label: 'nav.tombstones', icon: 'eraser' },
      { key: 'audit', path: 'audit', label: 'nav.audit', icon: 'scroll-text' },
      {
        key: 'signins',
        path: 'signins',
        label: 'nav.signins',
        icon: 'monitor-check',
        hubOnly: true,
      },
    ],
  },
];

const THEMES: Array<{ value: Ctx['theme']; label: MessageKey; icon: IconName }> = [
  { value: 'auto', label: 'theme.auto', icon: 'sun-moon' },
  { value: 'light', label: 'theme.light', icon: 'sun' },
  { value: 'dark', label: 'theme.dark', icon: 'moon' },
];

/** The current path and query, for `next` parameters. */
export function here(ctx: Ctx): string {
  return `${ctx.url.pathname}${ctx.url.search}`;
}

export function csrfField(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.session?.csrf ?? ''}">`;
}

export function docsUrl(ctx: Ctx, page = 'guide/admin'): string {
  return `https://origin.openlinkos.com/${ctx.lang === 'zh' ? 'zh/' : ''}${page}`;
}

function logo(ctx: Ctx, size: number): SafeHtml {
  const light = ctx.assets.url('logo.svg');
  const dark = ctx.assets.url('logo-dark.svg');
  if (ctx.theme === 'dark')
    return html`<img src="${dark}" alt="" width="${size}" height="${size}">`;
  if (ctx.theme === 'light') {
    return html`<img src="${light}" alt="" width="${size}" height="${size}">`;
  }
  return html`<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}"><img src="${light}" alt="" width="${size}" height="${size}"></picture>`;
}

/** The language switch: a small POST form, so it works without the script. */
function languageForm(ctx: Ctx, buttonClass: string): SafeHtml {
  const other = ctx.lang === 'en' ? 'zh' : 'en';
  return html`<form method="post" action="/admin/prefs">
      <input type="hidden" name="lang" value="${other}">
      <input type="hidden" name="next" value="${here(ctx)}">
      <button type="submit" class="${buttonClass}" lang="${HTML_LANG[other]}">${icon(ctx, 'languages', 'sm')}${ctx.t('prefs.switchLanguage')}</button>
    </form>`;
}

/** The theme switch: one POST button per choice, the current one pressed. */
function themeForm(ctx: Ctx, compact: boolean): SafeHtml {
  const t = ctx.t;
  return html`<form method="post" action="/admin/prefs">
      <input type="hidden" name="next" value="${here(ctx)}">
      <fieldset class="ol-segmented${compact ? '' : ' ol-segmented-block'}">
        <legend class="ol-sr-only">${t('prefs.theme')}</legend>
        ${THEMES.map(
          (th) =>
            html`<button type="submit" name="theme" value="${th.value}" aria-pressed="${ctx.theme === th.value ? 'true' : 'false'}" title="${t(th.label)}"${compact ? html` aria-label="${t(th.label)}"` : ''}>${icon(ctx, th.icon, 'sm')}${compact ? '' : t(th.label)}</button>`,
        )}
      </fieldset>
    </form>`;
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface PageOptions {
  /** The document title and the last breadcrumb. */
  title: string;
  nav?: NavKey;
  /** Breadcrumbs between the hub and this page. */
  crumbs?: Crumb[];
  body: HtmlValue;
  /** Sign-in and re-authentication: the form beside the brand panel, without navigation. */
  bare?: boolean;
}

/**
 * The page's place: its group in the sidebar, the pages above it, then the page; the host is left to
 * the address bar.
 */
function breadcrumb(ctx: Ctx, o: PageOptions): SafeHtml {
  const group = NAV.find((g) => g.items.some((i) => i.key === o.nav))?.label;
  return html`<nav aria-label="${ctx.t('nav.breadcrumb')}"><ol class="admin-crumbs">
      ${group ? html`<li>${ctx.t(group)}</li>` : ''}
      ${(o.crumbs ?? []).map((c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}</li>`)}
      <li><span aria-current="page">${o.title}</span></li>
    </ol></nav>`;
}

/** How long ago, in words: just now, minutes, hours, or days. */
export function ago(ctx: Ctx, ts: number): string {
  const minutes = Math.max(0, Math.floor((ctx.now - ts) / 60_000));
  if (minutes < 1) return ctx.t('ago.now');
  if (minutes < 60) return ctx.t('ago.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ctx.t('ago.hours', { n: hours });
  return ctx.t('ago.days', { n: Math.floor(hours / 24) });
}

/** The sidebar's foot: on a device, its hub; on a hub, its devices. */
function storeStatus(ctx: Ctx): SafeHtml {
  const t = ctx.t;
  if (ctx.mode === 'hub') {
    const devices = ctx.service.devices(ctx.now);
    const stale = devices.some((d) => d.stale);
    return html`<a class="admin-side-row" href="/admin/devices"><span class="admin-dot${stale ? ' admin-dot-warn' : ''}"></span>${t('side.devices', { n: devices.length })}</a>`;
  }
  const hub = ctx.service.hub();
  if (!hub)
    return html`<div class="admin-side-row"><span class="admin-dot admin-dot-off"></span>${t('side.noHub')}</div>`;
  if (hub.syncing)
    return html`<div class="admin-side-row"><span class="admin-dot"></span>${t('side.syncing')}</div>`;
  if (hub.lastError) {
    return html`<div class="admin-side-row" title="${hub.lastError}"><span class="admin-dot admin-dot-warn"></span>${t('side.syncFailed')}</div>`;
  }
  return html`<div class="admin-side-row"><span class="admin-dot"></span>${
    hub.lastSyncAt === null
      ? t('side.notSynced')
      : t('side.synced', { ago: ago(ctx, hub.lastSyncAt) })
  }</div>`;
}

/** Where this store is: this device, with a way to its hub, or the hub. */
function storeSwitch(ctx: Ctx): HtmlValue {
  if (ctx.mode === 'hub') return '';
  const hub = ctx.service.hub();
  if (!hub) return '';
  return html`<div class="admin-seg"><span aria-current="true">${icon(ctx, 'laptop')}${ctx.t('top.local')}</span><a href="${`${hub.url.replace(/\/+$/, '')}/admin/`}" rel="noreferrer" target="_blank">${icon(ctx, 'server')}${ctx.t('top.hub')}</a></div>`;
}

function appShell(ctx: Ctx, o: PageOptions): SafeHtml {
  const t = ctx.t;
  const counts = ctx.service.navCounts();
  const count = (key: NavKey) =>
    key === 'sessions' || key === 'recalls' || key === 'entries' ? counts[key] : null;
  return html`<a class="ol-skip-link" href="#main">${t('nav.skip')}</a>
<div class="admin-app">
  <aside class="admin-side">
    <a class="admin-brand" href="/admin/">${logo(ctx, 20)}<span>Origin</span><span class="admin-brand-tag">${ctx.mode === 'local' ? t('app.local') : t('app.hub')}</span></a>
    <nav class="admin-nav" aria-label="${t('nav.label')}">
      ${navFor(ctx).map(
        (
          group,
        ) => html`${group.label ? html`<div class="admin-nav-label">${t(group.label)}</div>` : ''}
        ${group.items.map((n) => {
          const c = count(n.key);
          return html`<a href="${href(n.path)}"${n.key === o.nav ? html` aria-current="page"` : ''}>${icon(ctx, n.icon)}${t(n.label)}${c === null ? '' : html`<span class="admin-nav-count">${fmtNumber(c, ctx.lang)}</span>`}</a>`;
        })}`,
      )}
    </nav>
    <div class="admin-side-foot">
      ${storeStatus(ctx)}
      <div class="admin-side-row">${themeForm(ctx, true)}${languageForm(ctx, 'ol-btn ol-btn-ghost ol-btn-sm')}</div>
      <div class="admin-side-row"><form method="post" action="/admin/logout">${csrfField(ctx)}<button type="submit" class="ol-btn ol-btn-ghost ol-btn-sm">${icon(ctx, 'log-out', 'sm')}${t('auth.signOut')}</button></form><a class="admin-faint" href="${docsUrl(ctx)}" rel="noreferrer">Origin ${ctx.version}</a></div>
    </div>
  </aside>
  <div class="admin-main">
    <header class="admin-top">
      ${breadcrumb(ctx, o)}
      <div class="admin-top-tools">
        ${
          o.nav === 'search'
            ? ''
            : html`<form class="admin-search" method="get" action="/admin/search" role="search">
          ${icon(ctx, 'search', 'sm')}
          <input type="search" name="q" placeholder="${t('search.quick')}" aria-label="${t('nav.search')}">
          <kbd class="admin-kbd">/</kbd>
        </form>`
        }
        ${storeSwitch(ctx)}
      </div>
    </header>
    <main class="admin-page" id="main" tabindex="-1">
${o.body}
    </main>
  </div>
</div>`;
}

/**
 * Pages outside the app: sign-in and re-authentication beside the brand panel, and a framed card on
 * its own for error pages when signed out.
 */
function authShell(ctx: Ctx, o: PageOptions): SafeHtml {
  const t = ctx.t;
  // The brand panel is dark in both themes, so it takes the mark drawn for dark backgrounds.
  const aside = html`<aside class="ol-auth-aside">
    <div class="ol-auth-rings" aria-hidden="true"></div>
    <a class="ol-auth-brand" href="/admin/"><img src="${ctx.assets.url('logo-dark.svg')}" alt="" width="24" height="24"><span>Origin</span></a>
    <p class="ol-auth-statement">${t('auth.statement')}</p>
  </aside>`;
  return html`<main class="ol-auth" id="main">
  ${o.bare ? aside : ''}
  <div class="ol-auth-body">
    <div class="ol-auth-card">
${o.body}
    </div>
    <div class="ol-auth-foot">
      <span>Origin ${ctx.version}</span>
      ${languageForm(ctx, 'ol-btn ol-btn-link')}
      <a href="${docsUrl(ctx)}" rel="noreferrer">${t('app.docs')}</a>
      ${themeForm(ctx, true)}
    </div>
  </div>
</main>`;
}

export function layout(ctx: Ctx, o: PageOptions): SafeHtml {
  const t = ctx.t;
  const script = ctx.assets.url('admin.js');
  const body = o.bare || ctx.session === null ? authShell(ctx, o) : appShell(ctx, o);
  // The symbols come last, once the page has recorded every icon it uses.
  const sprite = iconSprite(ctx);
  return html`<!doctype html>
<html lang="${HTML_LANG[ctx.lang]}"${ctx.theme === 'auto' ? '' : html` data-theme="${ctx.theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="${ctx.theme === 'auto' ? 'light dark' : ctx.theme}">
<title>${o.title} – ${t('app.title')}</title>
<link rel="icon" href="${ctx.assets.url('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${ctx.assets.url('ui.css')}">
<link rel="stylesheet" href="${ctx.assets.url('admin.css')}">
${script ? html`<script type="module" src="${script}"></script>` : ''}
</head>
<body data-brand="origin">
${sprite}
${body}
</body>
</html>
`;
}

export function renderPage(ctx: Ctx, status: number, o: PageOptions): void {
  sendHtml(ctx.res, status, layout(ctx, o));
}

/** The brand, for a card shown without the brand panel. */
export function brand(ctx: Ctx): SafeHtml {
  return html`<a class="ol-brand" href="/admin/">${logo(ctx, 22)}<span>Origin</span></a>`;
}
