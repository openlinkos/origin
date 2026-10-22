import type { Ctx } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { sendHtml } from '../http.js';
import { HTML_LANG, type MessageKey } from '../i18n/index.js';
import { type IconName, icon, iconSprite } from '../icons.js';

export type NavKey =
  | 'overview'
  | 'sessions'
  | 'search'
  | 'entries'
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
}

/** The sidebar: groups of pages named by task. */
const NAV: Array<{ label?: MessageKey; items: NavItem[] }> = [
  { items: [{ key: 'overview', path: '', label: 'nav.overview', icon: 'layout-dashboard' }] },
  {
    label: 'nav.groupMemory',
    items: [
      { key: 'sessions', path: 'sessions', label: 'nav.sessions', icon: 'history' },
      { key: 'search', path: 'search', label: 'nav.search', icon: 'search' },
      { key: 'entries', path: 'entries', label: 'nav.entries', icon: 'book-marked' },
    ],
  },
  {
    label: 'nav.groupConnect',
    items: [
      { key: 'devices', path: 'devices', label: 'nav.devices', icon: 'laptop' },
      { key: 'tokens', path: 'tokens', label: 'nav.tokens', icon: 'key-round' },
      { key: 'connect', path: 'connect', label: 'nav.connect', icon: 'plug' },
    ],
  },
  {
    label: 'nav.groupSecurity',
    items: [
      { key: 'tombstones', path: 'tombstones', label: 'nav.tombstones', icon: 'eraser' },
      { key: 'audit', path: 'audit', label: 'nav.audit', icon: 'scroll-text' },
      { key: 'signins', path: 'signins', label: 'nav.signins', icon: 'monitor-check' },
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

/** The host the browser reached the hub on: the loopback name of a tunnel, or the public URL. */
export function hubHost(ctx: Ctx): string {
  const origin = ctx.origins.local ?? ctx.origins.public;
  if (!origin) return 'Origin';
  try {
    return new URL(origin).host;
  } catch {
    return 'Origin';
  }
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

function breadcrumb(ctx: Ctx, o: PageOptions): SafeHtml {
  const crumbs = o.crumbs ?? [];
  return html`<nav class="admin-crumbs" aria-label="${ctx.t('nav.breadcrumb')}"><ol class="ol-breadcrumb">
      <li><a href="/admin/">${hubHost(ctx)}</a></li>
      ${crumbs.map((c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}</li>`)}
      <li><span aria-current="page">${o.title}</span></li>
    </ol></nav>`;
}

function appShell(ctx: Ctx, o: PageOptions): SafeHtml {
  const t = ctx.t;
  return html`<a class="ol-skip-link" href="#main">${t('nav.skip')}</a>
<div class="ol-app">
  <aside class="ol-sidebar">
    <input type="checkbox" id="nav-toggle" class="ol-nav-toggle">
    <div class="ol-sidebar-head">
      <a class="ol-brand" href="/admin/">${logo(ctx, 22)}<span>Origin</span></a>
      <span class="ol-brand-tag">${t('app.admin')}</span>
      <label for="nav-toggle" class="ol-btn ol-btn-ghost ol-btn-icon ol-nav-toggle-button">${icon(ctx, 'menu')}<span class="ol-sr-only">${t('nav.menu')}</span></label>
    </div>
    <nav class="ol-nav" aria-label="${t('nav.label')}">
      ${NAV.map(
        (group) => html`<div class="ol-nav-group">
        ${group.label ? html`<div class="ol-nav-label">${t(group.label)}</div>` : ''}
        ${group.items.map(
          (n) =>
            html`<a class="ol-nav-item" href="${href(n.path)}"${n.key === o.nav ? html` aria-current="page"` : ''}>${icon(ctx, n.icon)}${t(n.label)}</a>`,
        )}
      </div>`,
      )}
    </nav>
    <div class="ol-sidebar-foot">
      ${themeForm(ctx, false)}
      <div class="ol-cluster">
        ${languageForm(ctx, 'ol-btn ol-btn-ghost ol-btn-sm')}
        <form method="post" action="/admin/logout">${csrfField(ctx)}<button type="submit" class="ol-btn ol-btn-ghost ol-btn-sm">${icon(ctx, 'log-out', 'sm')}${t('auth.signOut')}</button></form>
      </div>
    </div>
  </aside>
  <div class="ol-main">
    <header class="ol-topbar">
      ${breadcrumb(ctx, o)}
      ${
        o.nav === 'search'
          ? ''
          : html`<div class="ol-topbar-actions">
        <form class="ol-search" method="get" action="/admin/search" role="search">
          ${icon(ctx, 'search')}
          <input class="ol-input" type="search" name="q" placeholder="${t('search.quick')}" aria-label="${t('nav.search')}">
        </form>
      </div>`
      }
    </header>
    <main class="ol-content" id="main" tabindex="-1">
${o.body}
    </main>
    <footer class="ol-footer"><span>Origin ${ctx.version}</span><a href="${docsUrl(ctx)}" rel="noreferrer">${t('app.docs')}</a></footer>
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
    <p class="ol-auth-meta">${hubHost(ctx)}</p>
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
