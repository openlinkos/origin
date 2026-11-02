import type { IncomingMessage, ServerResponse } from 'node:http';
import { Assets, PACKAGE_ROOT } from './assets.js';
import { html } from './html.js';
import { pageHeaders, SVG_CSP } from './http.js';
import { HTML_LANG, type Lang, negotiateLang, translator } from './i18n/index.js';
import { type IconHost, icon, iconSprite } from './icons.js';
import { docsHref, SITE_URL, SOURCE_URL } from './project.js';

/**
 * The hub's public landing page (see docs/architecture.md#http-interface): what a browser shows at
 * the hub's address, without a sign-in. It says what the hub is, offers to sign in to the admin UI
 * when that is mounted at /admin, and credits Origin, the open-source project, unless the hub's
 * owner turned that off. It shows nothing from the store.
 */
export interface LandingOptions {
  /** Whether the admin UI answers at /admin on the same listener: the page offers to sign in. */
  admin: boolean;
  /** "Powered by Origin, open source", with links to its site and source; on unless turned off. */
  poweredBy: boolean;
}

/**
 * Answers `/`, `/robots.txt`, and the page's files under `/assets/`, without authentication, and
 * returns true; returns false for every other path, which it leaves alone.
 */
export type LandingHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

/** What `/` answers a client that asks for JSON. */
export const LANDING_JSON = { service: 'origin', docs: SITE_URL } as const;

/**
 * Crawlers may read the landing page and the files it needs to render, and nothing else: every
 * other path is an API behind a token, or the admin UI.
 */
export const ROBOTS_TXT = 'User-agent: *\nAllow: /$\nAllow: /assets/\nDisallow: /\n';

/** The files of the landing page: the design system's stylesheet (with its fonts) and the marks. */
const FILES = ['ui.css', 'favicon.svg', 'logo.svg', 'logo-dark.svg'];

const JSON_TYPE = 'application/json; charset=utf-8';

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  res.writeHead(status, {
    ...pageHeaders(),
    'Cache-Control': 'no-store',
    ...headers,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Whether a request asks for JSON rather than a page: application/json, and not text/html. */
function wantsJson(accept: string | undefined): boolean {
  const types = (accept ?? '').split(',').map((part) => part.split(';')[0]?.trim().toLowerCase());
  return types.includes('application/json') && !types.includes('text/html');
}

function landingPage(o: LandingOptions, assets: Assets, lang: Lang): string {
  const t = translator(lang);
  const host: IconHost = { icons: new Set(), assets };
  const light = assets.url('logo.svg');
  const dark = assets.url('logo-dark.svg');
  const body = html`<a class="ol-skip-link" href="#main">${t('nav.skip')}</a>
<header class="ol-site-header">
  <a class="ol-brand" href="/"><picture><source media="(prefers-color-scheme: dark)" srcset="${dark}"><img src="${light}" alt="" width="22" height="22"></picture><span>Origin</span></a>
</header>
<main id="main" tabindex="-1">
  <section class="ol-hero" aria-labelledby="hero-title">
    <div class="ol-hero-rings" aria-hidden="true"></div>
    <div class="ol-hero-body">
      <h1 class="ol-hero-title" id="hero-title">Origin</h1>
      <p class="ol-hero-lead">${t('landing.lead')}</p>
      ${o.admin ? html`<div class="ol-hero-actions"><a class="ol-btn ol-btn-primary ol-btn-lg" href="/admin/">${icon(host, 'log-in')}${t('auth.signIn')}</a></div>` : ''}
    </div>
  </section>
</main>
${
  o.poweredBy
    ? html`<footer class="ol-site-footer">
  <p>${t('landing.poweredBy')}</p>
  <nav class="ol-site-footer-links" aria-label="${t('app.project')}"><a href="${docsHref(lang)}" rel="noreferrer">${t('app.docs')}</a><a href="${SOURCE_URL}" rel="noreferrer">${t('app.source')}</a></nav>
</footer>`
    : ''
}`;
  // The symbols come last, once the page has recorded every icon it uses.
  return html`<!doctype html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${t('landing.lead')}">
<title>${t('landing.title')}</title>
<link rel="icon" href="${assets.url('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${assets.url('ui.css')}">
</head>
<body data-brand="origin">
${iconSprite(host)}
${body}
</body>
</html>
`.value;
}

/** The landing page, robots.txt, and the page's files (see LandingHandler). */
export function createLandingHandler(o: LandingOptions): LandingHandler {
  const assets = new Assets(PACKAGE_ROOT, { base: '/assets/', only: FILES });
  return (req, res, url) => {
    const path = url.pathname;
    const isAsset = path.startsWith('/assets/');
    if (path !== '/' && path !== '/robots.txt' && !isAsset) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(
        res,
        405,
        { 'Content-Type': JSON_TYPE, Allow: 'GET, HEAD' },
        JSON.stringify({ error: 'Method not allowed.' }),
      );
      return true;
    }
    if (isAsset) {
      const asset = assets.find(path.slice('/assets/'.length));
      if (!asset) {
        send(res, 404, { 'Content-Type': JSON_TYPE }, JSON.stringify({ error: 'Not found.' }));
        return true;
      }
      send(
        res,
        200,
        {
          'Content-Type': asset.type,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...(asset.type.startsWith('image/svg') ? { 'Content-Security-Policy': SVG_CSP } : {}),
        },
        asset.body,
      );
      return true;
    }
    if (path === '/robots.txt') {
      send(
        res,
        200,
        { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
        ROBOTS_TXT,
      );
      return true;
    }
    // The page differs by language, and is JSON for a client that asks for it.
    const vary = { Vary: 'Accept, Accept-Language' };
    if (wantsJson(req.headers.accept)) {
      send(res, 200, { 'Content-Type': JSON_TYPE, ...vary }, JSON.stringify(LANDING_JSON));
      return true;
    }
    const lang = negotiateLang(undefined, req.headers['accept-language']);
    send(
      res,
      200,
      { 'Content-Type': 'text/html; charset=utf-8', ...vary },
      landingPage(o, assets, lang),
    );
    return true;
  };
}
