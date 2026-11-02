import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLandingHandler, type LandingOptions } from '../src/index.js';
import { pageProblems, request } from './helpers.js';

let servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  servers = [];
});

/** The landing page alone, as the hub mounts it: whatever it does not answer is a 418 here. */
async function serve(o: Partial<LandingOptions> = {}): Promise<string> {
  const landing = createLandingHandler({ admin: true, poweredBy: true, ...o });
  const server = http.createServer((req, res) => {
    if (!landing(req, res, new URL(req.url ?? '/', 'http://hub'))) res.writeHead(418).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

/** What a browser sends when it opens a page. */
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

describe('the landing page', () => {
  it('says what the hub is, offers to sign in, and credits Origin, in English', async () => {
    const base = await serve();
    const res = await request(`${base}/`, { headers: { Accept: BROWSER } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('<html lang="en">');
    expect(res.text).toContain('<title>Origin hub</title>');
    // The mark and the name, in the site look of the design system.
    expect(res.text).toMatch(
      /<header class="ol-site-header">\s*<a class="ol-brand" href="\/"><picture><source media="\(prefers-color-scheme: dark\)" srcset="\/assets\/logo-dark\.[0-9a-f]{10}\.svg"><img src="\/assets\/logo\.[0-9a-f]{10}\.svg"/,
    );
    expect(res.text).toContain('<span>Origin</span>');
    expect(res.text).toContain('<div class="ol-hero-rings" aria-hidden="true"></div>');
    expect(res.text).toContain(
      '<p class="ol-hero-lead">A personal Origin hub: it keeps the memory of one person&#39;s AI agents across their devices.</p>',
    );
    expect(res.text).toMatch(
      /<a class="ol-btn ol-btn-primary ol-btn-lg" href="\/admin\/"><svg class="ol-icon" aria-hidden="true"><use href="#i-log-in"\/><\/svg>Sign in<\/a>/,
    );
    expect(res.text).toContain('<footer class="ol-site-footer">');
    expect(res.text).toContain('<p>Powered by Origin, open source</p>');
    expect(res.text).toContain(
      '<a href="https://origin.openlinkos.com/" rel="noreferrer">Documentation</a><a href="https://github.com/openlinkos/origin" rel="noreferrer">GitHub</a>',
    );
    // Within the admin UI's rules for markup; robots.txt keeps crawlers away from the whole hub.
    expect(res.text).not.toContain('noindex');
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(pageProblems(res.text)).toEqual([]);
    expect(res.text).not.toContain('<script');
  });

  it('follows Accept-Language as the admin UI does', async () => {
    const base = await serve();
    const zh = await request(`${base}/`, {
      headers: { Accept: BROWSER, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    expect(zh.text).toContain('<html lang="zh-CN">');
    expect(zh.text).toContain('<title>Origin 中枢</title>');
    expect(zh.text).toContain(
      '<p class="ol-hero-lead">个人 Origin 中枢：在一个人的各台设备之间，保存其 AI Agent 的记忆。</p>',
    );
    expect(zh.text).toContain('登录</a>');
    expect(zh.text).toContain('<p>由开源的 Origin 驱动</p>');
    expect(zh.text).toContain(
      '<a href="https://origin.openlinkos.com/zh/" rel="noreferrer">文档</a>',
    );
    expect(pageProblems(zh.text)).toEqual([]);
    const en = await request(`${base}/`, { headers: { 'Accept-Language': 'fr, en;q=0.5' } });
    expect(en.text).toContain('<html lang="en">');
  });

  it('offers no sign-in without the admin UI, and no credit when it is turned off', async () => {
    const plain = await request(`${await serve({ admin: false })}/`);
    expect(plain.text).not.toContain('/admin');
    expect(plain.text).not.toContain('i-log-in');
    expect(plain.text).toContain('Powered by Origin, open source');
    expect(pageProblems(plain.text)).toEqual([]);

    const white = await request(`${await serve({ poweredBy: false })}/`);
    expect(white.text).not.toContain('Powered by');
    expect(white.text).not.toContain('ol-site-footer');
    expect(white.text).not.toContain('github.com');
    expect(white.text).not.toContain('openlinkos.com');
    // The page itself stays: what the hub is, and the way to sign in.
    expect(white.text).toContain('A personal Origin hub');
    expect(white.text).toContain('href="/admin/"');
    expect(pageProblems(white.text)).toEqual([]);
  });

  it('answers a client that asks for JSON with JSON', async () => {
    const base = await serve();
    for (const accept of ['application/json', 'application/json, */*;q=0.5']) {
      const res = await request(`${base}/`, { headers: { Accept: accept } });
      expect(res.status, accept).toBe(200);
      expect(res.headers['content-type'], accept).toBe('application/json; charset=utf-8');
      expect(res.json(), accept).toEqual({
        service: 'origin',
        docs: 'https://origin.openlinkos.com/',
      });
    }
    // A browser, or a client that says nothing, gets the page.
    for (const accept of [BROWSER, 'text/html, application/json', '*/*', '']) {
      const res = await request(`${base}/`, { headers: accept ? { Accept: accept } : {} });
      expect(res.headers['content-type'], accept).toBe('text/html; charset=utf-8');
    }
  });

  it('carries the CSP and the guard headers of the admin UI, and is never stored', async () => {
    const base = await serve();
    for (const accept of [BROWSER, 'application/json']) {
      const res = await request(`${base}/`, { headers: { Accept: accept } });
      expect(res.headers['content-security-policy']).toBe(CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.vary).toBe('Accept, Accept-Language');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers HEAD without a body, and refuses other methods', async () => {
    const base = await serve();
    const head = await request(`${base}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
    expect(head.text).toBe('');
    for (const p of ['/', '/robots.txt']) {
      const post = await request(`${base}${p}`, { method: 'POST', body: '{}' });
      expect(post.status, p).toBe(405);
      expect(post.headers.allow, p).toBe('GET, HEAD');
    }
  });

  it('serves its own files under /assets/, hashed and immutable', async () => {
    const base = await serve();
    const page = await request(`${base}/`);
    const css = /href="(\/assets\/ui\.[0-9a-f]{10}\.css)"/.exec(page.text)?.[1];
    const favicon = /href="(\/assets\/favicon\.[0-9a-f]{10}\.svg)"/.exec(page.text)?.[1];
    expect(css && favicon).toBeTruthy();
    const sheet = await request(`${base}${css}`);
    expect(sheet.status).toBe(200);
    expect(sheet.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(sheet.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(sheet.headers['content-security-policy']).toBe(CSP);
    // The stylesheet's fonts are next to it.
    const font = /url\((fonts\/Geist-Variable\.[0-9a-f]{10}\.woff2)\)/.exec(sheet.text)?.[1];
    expect(font).toBeTruthy();
    expect((await request(`${base}/assets/${font}`)).headers['content-type']).toBe('font/woff2');
    const svg = await request(`${base}${favicon}`);
    expect(svg.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    // Only what the page uses, and nothing by its plain name or outside the files.
    for (const p of [
      '/assets/ui.css',
      '/assets/fonts/Geist-Variable.woff2',
      '/assets/admin.css',
      '/assets/',
      '/assets/x',
    ]) {
      expect((await request(`${base}${p}`)).status, p).toBe(404);
    }
    expect(page.text).not.toContain('admin.');
  });

  it('asks crawlers to stay away: a personal hub is not for search results', async () => {
    const base = await serve();
    const res = await request(`${base}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toBe('User-agent: *\nDisallow: /\n');
  });

  it('leaves every other path alone', async () => {
    const base = await serve();
    for (const p of ['/healthz', '/mcp', '/v1/device', '/admin/', '/index.html', '/assetsx']) {
      expect((await request(`${base}${p}`)).status, p).toBe(418);
    }
  });
});
