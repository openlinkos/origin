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
  /** The document title, and the page's heading unless `heading` says otherwise. */
  title: string;
  /** The page's heading (its h1, in the top bar), when it is more than its title. */
  heading?: HtmlValue;
  /** A count after the heading, such as how many rows a list has. */
  count?: number;
  /** Badges after the heading, such as a kind or a status. */
  badges?: HtmlValue;
  /** The page's actions, at the end of the top bar; at most one of them primary. */
  actions?: HtmlValue;
  nav?: NavKey;
  /** The pages above this one, after its group in the sidebar. */
  crumbs?: Crumb[];
  body: HtmlValue;
  /** Sign-in and re-authentication: the form beside the brand panel, without navigation. */
  bare?: boolean;
}

/**
 * The pages above this one: its group in the sidebar, then the pages it belongs to; the host is
 * left to the address bar. The page itself is the heading after it.
 */
function breadcrumb(ctx: Ctx, o: PageOptions): HtmlValue {
  const group = NAV.find((g) => g.items.some((i) => i.key === o.nav))?.label;
  const items = [
    ...(group ? [html`<li>${ctx.t(group)}</li>`] : []),
    ...(o.crumbs ?? []).map(
      (c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}</li>`,
    ),
  ];
  if (items.length === 0) return '';
  return html`<nav aria-label="${ctx.t('nav.breadcrumb')}"><ol class="ol-breadcrumb">${items}</ol></nav>`;
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

/** How the store stands, at the foot of the sidebar: on a device, its hub; on a hub, its devices. */
function storeStatus(ctx: Ctx): SafeHtml {
  const t = ctx.t;
  const status = (tone: 'success' | 'warning' | 'off', text: string, link?: string) => {
    const inner = html`<span class="ol-dot"></span><span>${text}</span>`;
    const cls = `ol-sidebar-status${tone === 'off' ? '' : ` ol-status-${tone}`}`;
    return link
      ? html`<a class="${cls}" href="${link}" title="${text}">${inner}</a>`
      : html`<div class="${cls}" title="${text}">${inner}</div>`;
  };
  if (ctx.mode === 'hub') {
    const devices = ctx.service.devices(ctx.now);
    const stale = devices.some((d) => d.stale);
    return status(
      stale ? 'warning' : 'success',
      t('side.devices', { n: devices.length }),
      '/admin/devices',
    );
  }
  const hub = ctx.service.hub();
  if (!hub) return status('off', t('side.noHub'));
  if (hub.syncing) return status('success', t('side.syncing'));
  if (hub.lastError) return status('warning', `${t('side.syncFailed')}: ${hub.lastError}`);
  return status(
    'success',
    hub.lastSyncAt === null
      ? t('side.notSynced')
      : t('side.synced', { ago: ago(ctx, hub.lastSyncAt) }),
  );
}

/** The admin UI of this device's hub, when it has one. */
function hubUrl(ctx: Ctx): string | null {
  if (ctx.mode === 'hub') return null;
  const hub = ctx.service.hub();
  return hub ? `${hub.url.replace(/\/+$/, '')}/admin/` : null;
}

/** Where this store is: this device, with a way to its hub. */
function storeSwitch(ctx: Ctx): HtmlValue {
  const url = hubUrl(ctx);
  if (!url) return '';
  return html`<div class="admin-seg"><span aria-current="true">${icon(ctx, 'laptop')}${ctx.t('top.local')}</span><a href="${url}" rel="noreferrer" target="_blank">${icon(ctx, 'server')}${ctx.t('top.hub')}</a></div>`;
}

/**
 * The menu at the foot of the sidebar: the colour theme, the language, the hub, the documentation,
 * and signing out. Each choice is a small POST form, so it works without a script.
 */
function prefsMenu(ctx: Ctx): SafeHtml {
  const t = ctx.t;
  const url = hubUrl(ctx);
  return html`<button class="ol-sidebar-account" type="button" popovertarget="prefs" title="${t('prefs.label')}">
      ${icon(ctx, 'settings')}
      <span class="ol-sidebar-account-text"><span class="ol-sidebar-account-name">${t('prefs.label')}</span><span class="ol-sidebar-account-meta">Origin ${ctx.version}</span></span>
      ${icon(ctx, 'chevrons-up-down', 'sm')}
    </button>
    <div class="ol-menu ol-menu-above" id="prefs" popover>
      <div class="ol-menu-label">${t('prefs.theme')}</div>
      <form method="post" action="/admin/prefs"><input type="hidden" name="next" value="${here(ctx)}">${THEMES.map(
        (th) =>
          html`<button type="submit" class="ol-menu-item" name="theme" value="${th.value}"${ctx.theme === th.value ? html` aria-current="true"` : ''}>${icon(ctx, th.icon, 'sm')}${t(th.label)}</button>`,
      )}</form>
      <hr class="ol-menu-separator">
      <div class="ol-menu-label">${t('prefs.language')}</div>
      <form method="post" action="/admin/prefs"><input type="hidden" name="next" value="${here(ctx)}">${(
        ['en', 'zh'] as const
      ).map(
        (l) =>
          html`<button type="submit" class="ol-menu-item" name="lang" value="${l}" lang="${HTML_LANG[l]}"${ctx.lang === l ? html` aria-current="true"` : ''}>${l === 'en' ? 'English' : '简体中文'}</button>`,
      )}</form>
      <hr class="ol-menu-separator">
      ${url ? html`<a class="ol-menu-item" href="${url}" rel="noreferrer" target="_blank">${icon(ctx, 'server', 'sm')}${t('top.openHub')}</a>` : ''}
      <a class="ol-menu-item" href="${docsUrl(ctx)}" rel="noreferrer">${icon(ctx, 'book-open', 'sm')}${t('app.docs')}</a>
      <hr class="ol-menu-separator">
      <form method="post" action="/admin/logout">${csrfField(ctx)}<button type="submit" class="ol-menu-item">${icon(ctx, 'log-out', 'sm')}${t('auth.signOut')}</button></form>
    </div>`;
}

/**
 * The app: the design system's workbench. The sidebar (the sections, how the store stands, and the
 * preferences) is a rail of icons on medium screens and a sheet on narrow ones; the top bar heads
 * the page with its breadcrumb, its heading, and its actions, then search and the store.
 */
function appShell(ctx: Ctx, o: PageOptions): SafeHtml {
  const t = ctx.t;
  const counts = ctx.service.navCounts();
  const count = (key: NavKey) =>
    key === 'sessions' || key === 'recalls' || key === 'entries' ? counts[key] : null;
  return html`<a class="ol-skip-link" href="#main">${t('nav.skip')}</a>
<div class="ol-app ol-app-workbench">
  <aside class="ol-sidebar" id="nav" popover aria-label="${t('nav.label')}">
    <div class="ol-sidebar-head"><a class="ol-brand" href="/admin/" aria-label="Origin">${logo(ctx, 20)}<span>Origin</span></a><span class="ol-brand-tag">${ctx.mode === 'local' ? t('app.local') : t('app.hub')}</span></div>
    <nav class="ol-nav" aria-label="${t('nav.label')}">
      ${navFor(ctx).map(
        (group) =>
          html`<div class="ol-nav-group">${group.label ? html`<div class="ol-nav-label">${t(group.label)}</div>` : ''}${group.items.map(
            (n) => {
              const c = count(n.key);
              return html`<a class="ol-nav-item" href="${href(n.path)}" title="${t(n.label)}"${n.key === o.nav ? html` aria-current="page"` : ''}>${icon(ctx, n.icon)}<span class="ol-nav-text">${t(n.label)}</span>${c === null ? '' : html`<span class="ol-nav-count">${fmtNumber(c, ctx.lang)}</span>`}</a>`;
            },
          )}</div>`,
      )}
    </nav>
    <div class="ol-sidebar-foot">${storeStatus(ctx)}${prefsMenu(ctx)}</div>
  </aside>
  <div class="ol-main">
    <header class="ol-topbar">
      <button class="ol-btn ol-btn-ghost ol-btn-icon ol-btn-sm ol-nav-open" type="button" popovertarget="nav" aria-label="${t('nav.menu')}">${icon(ctx, 'menu')}</button>
      ${breadcrumb(ctx, o)}
      <h1 class="ol-topbar-title"><span class="ol-topbar-title-text">${o.heading ?? o.title}</span>${o.count === undefined ? '' : html`<span class="ol-topbar-count">${fmtNumber(o.count, ctx.lang)}</span>`}${o.badges ?? ''}</h1>
      <div class="ol-topbar-actions">
        ${o.actions ?? ''}
        ${
          o.nav === 'search'
            ? ''
            : html`<form class="ol-search" method="get" action="/admin/search" role="search">${icon(ctx, 'search', 'sm')}<input class="ol-input ol-input-sm" type="search" name="q" placeholder="${t('search.quick')}" aria-label="${t('nav.search')}"></form>
        <a class="ol-btn ol-btn-ghost ol-btn-icon ol-btn-sm ol-topbar-search-link" href="/admin/search">${icon(ctx, 'search')}<span class="ol-sr-only">${t('nav.search')}</span></a>`
        }
        ${storeSwitch(ctx)}
      </div>
    </header>
    <main class="ol-content" id="main" tabindex="-1">
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
