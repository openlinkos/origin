import type { Ctx } from '../context.js';
import { query } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { sendHtml } from '../http.js';
import { HTML_LANG, type MessageKey } from '../i18n/index.js';

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

const NAV: Array<{ key: NavKey; path: string; label: MessageKey }> = [
  { key: 'overview', path: '', label: 'nav.overview' },
  { key: 'sessions', path: 'sessions', label: 'nav.sessions' },
  { key: 'search', path: 'search', label: 'nav.search' },
  { key: 'entries', path: 'entries', label: 'nav.entries' },
  { key: 'devices', path: 'devices', label: 'nav.devices' },
  { key: 'tokens', path: 'tokens', label: 'nav.tokens' },
  { key: 'connect', path: 'connect', label: 'nav.connect' },
  { key: 'tombstones', path: 'tombstones', label: 'nav.tombstones' },
  { key: 'audit', path: 'audit', label: 'nav.audit' },
  { key: 'signins', path: 'signins', label: 'nav.signins' },
];

/** The current path and query, for `next` parameters. */
export function here(ctx: Ctx): string {
  return `${ctx.url.pathname}${ctx.url.search}`;
}

export function csrfField(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.session?.csrf ?? ''}">`;
}

function logo(ctx: Ctx): SafeHtml {
  const light = ctx.assets.url('logo.svg');
  const dark = ctx.assets.url('logo-dark.svg');
  if (ctx.theme === 'dark') return html`<img src="${dark}" alt="" width="28" height="28">`;
  if (ctx.theme === 'light') return html`<img src="${light}" alt="" width="28" height="28">`;
  return html`<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}"><img src="${light}" alt="" width="28" height="28"></picture>`;
}

/** Language and theme switches: small POST forms, so they work without the script. */
function prefs(ctx: Ctx): SafeHtml {
  const t = ctx.t;
  const next = here(ctx);
  const otherLang = ctx.lang === 'en' ? 'zh' : 'en';
  const nextTheme = ctx.theme === 'auto' ? 'light' : ctx.theme === 'light' ? 'dark' : 'auto';
  const themeLabel: Record<string, MessageKey> = {
    auto: 'theme.auto',
    light: 'theme.light',
    dark: 'theme.dark',
  };
  return html`<form method="post" action="/admin/prefs" class="inline">
      <input type="hidden" name="lang" value="${otherLang}">
      <input type="hidden" name="next" value="${next}">
      <button type="submit" class="link" lang="${otherLang === 'zh' ? 'zh-CN' : 'en'}">${t('prefs.switchLanguage')}</button>
    </form>
    <form method="post" action="/admin/prefs" class="inline">
      <input type="hidden" name="theme" value="${nextTheme}">
      <input type="hidden" name="next" value="${next}">
      <button type="submit" class="link" title="${t('prefs.theme')}">${t(themeLabel[ctx.theme] ?? 'theme.auto')}</button>
    </form>`;
}

export interface PageOptions {
  title: string;
  nav?: NavKey;
  body: HtmlValue;
  /** Login and re-authentication: no navigation. */
  bare?: boolean;
}

export function layout(ctx: Ctx, o: PageOptions): SafeHtml {
  const t = ctx.t;
  const script = ctx.assets.url('admin.js');
  const signedIn = ctx.session !== null && !o.bare;
  return html`<!doctype html>
<html lang="${HTML_LANG[ctx.lang]}"${ctx.theme === 'auto' ? '' : html` data-theme="${ctx.theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="${ctx.theme === 'auto' ? 'light dark' : ctx.theme}">
<title>${o.title} · ${t('app.title')}</title>
<link rel="icon" href="${ctx.assets.url('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${ctx.assets.url('admin.css')}">
${script ? html`<script type="module" src="${script}"></script>` : ''}
</head>
<body${o.bare ? html` class="bare"` : ''}>
<header class="top">
  <a class="brand" href="/admin/">${logo(ctx)}<span class="word">Origin</span><span class="tag">${t('app.admin')}</span></a>
  <div class="tools">
    ${prefs(ctx)}
    ${
      signedIn
        ? html`<form method="post" action="/admin/logout" class="inline">${csrfField(ctx)}<button type="submit" class="link">${t('auth.signOut')}</button></form>`
        : ''
    }
  </div>
</header>
${
  signedIn
    ? html`<nav class="nav" aria-label="${t('nav.label')}">${NAV.map(
        (n) =>
          html`<a href="${href(n.path)}"${n.key === o.nav ? html` aria-current="page"` : ''}>${t(n.label)}</a>`,
      )}</nav>`
    : ''
}
<main>
${o.body}
</main>
<footer class="foot">Origin ${ctx.version} · <a href="https://origin.openlinkos.com/guide/admin" rel="noreferrer">${t('app.docs')}</a></footer>
</body>
</html>
`;
}

export function renderPage(ctx: Ctx, status: number, o: PageOptions): void {
  sendHtml(ctx.res, status, layout(ctx, o));
}

export function alert(kind: 'error' | 'ok' | 'warn' | 'info', message: HtmlValue): SafeHtml {
  return html`<div class="alert ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${message}</div>`;
}

export function badge(text: string, kind = ''): SafeHtml {
  return html`<span class="badge ${kind}">${text}</span>`;
}

/** Previous / next links that keep the current query. */
export function pager(ctx: Ctx, page: number, more: boolean): SafeHtml {
  if (page === 0 && !more) return html``;
  const link = (p: number) => {
    const params = new URLSearchParams(ctx.url.searchParams);
    if (p === 0) params.delete('page');
    else params.set('page', String(p));
    const qs = params.toString();
    return `${ctx.url.pathname}${qs ? `?${qs}` : ''}`;
  };
  return html`<nav class="pager">
    ${page > 0 ? html`<a href="${link(page - 1)}">${ctx.t('pager.previous')}</a>` : ''}
    ${more ? html`<a href="${link(page + 1)}">${ctx.t('pager.next')}</a>` : ''}
  </nav>`;
}

/** "Older" link for id-paged lists (tombstones, audit). */
export function olderLink(ctx: Ctx, lastId: number | undefined, more: boolean): SafeHtml {
  if (!more || lastId === undefined) return html``;
  return html`<nav class="pager"><a href="${`${ctx.url.pathname}?before=${lastId}`}">${ctx.t('pager.older')}</a></nav>`;
}

/** A copyable command block. */
export function snippet(id: string, label: string, code: string, copyLabel: string): SafeHtml {
  return html`<div class="snippet">
    <div class="snippet-head"><span>${label}</span><button type="button" class="copy" data-copy="${id}" hidden>${copyLabel}</button></div>
    <pre id="${id}"><code>${code}</code></pre>
  </div>`;
}

/** `before` parameter for id-paged lists. */
export function beforeParam(ctx: Ctx): number | undefined {
  const n = Number(query(ctx, 'before'));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
