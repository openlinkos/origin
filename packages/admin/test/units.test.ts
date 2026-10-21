import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/assets.js';
import { checkAdminExposure, parseListen, parsePublicUrl } from '../src/config.js';
import { escapeHtml, href, html, raw } from '../src/html.js';
import { safeNext } from '../src/http.js';
import { en } from '../src/i18n/en.js';
import { negotiateLang, translator } from '../src/i18n/index.js';
import { zh } from '../src/i18n/zh.js';
import { LoginLimiter } from '../src/ratelimit.js';

describe('html', () => {
  it('escapes every interpolation', () => {
    const evil = `<img src=x onerror=alert(1)><script>alert("2")</script>'\`&`;
    const out = html`<p title="${evil}">${evil}</p>`.value;
    expect(out).toBe(
      '<p title="&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(&quot;2&quot;)&lt;/script&gt;&#39;&#96;&amp;">&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(&quot;2&quot;)&lt;/script&gt;&#39;&#96;&amp;</p>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
  });

  it('keeps nested templates and raw markup, joins arrays, and drops nullish values', () => {
    const items = ['<a>', 'b'];
    expect(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`.value).toBe(
      '<ul><li>&lt;a&gt;</li><li>b</li></ul>',
    );
    expect(html`${raw('<br>')}${null}${undefined}${false}${0}`.value).toBe('<br>0');
    expect(escapeHtml('"`\'')).toBe('&quot;&#96;&#39;');
  });

  it('builds admin links with encoded parameters', () => {
    expect(href('event', { id: 'claude-code:a#1', tools: true, x: '' })).toBe(
      '/admin/event?id=claude-code%3Aa%231&tools=1',
    );
    expect(href('')).toBe('/admin/');
  });
});

describe('i18n', () => {
  it('has the same keys and parameters in every language', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(params(zh[key]), key).toEqual(params(en[key]));
      expect(zh[key].trim().length, key).toBeGreaterThan(0);
    }
  });

  it('negotiates the language', () => {
    expect(negotiateLang(undefined, undefined)).toBe('en');
    expect(negotiateLang(undefined, 'zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(negotiateLang(undefined, 'en-US,en;q=0.9,zh;q=0.8')).toBe('en');
    expect(negotiateLang(undefined, 'fr-FR,zh-TW;q=0.5')).toBe('zh');
    expect(negotiateLang(undefined, 'fr, de;q=0.5')).toBe('en');
    expect(negotiateLang(undefined, 'en;q=0.1, zh-Hans;q=0.9')).toBe('zh');
    expect(negotiateLang(undefined, 'zh;q=0, en')).toBe('en');
    expect(negotiateLang('en', 'zh-CN')).toBe('en');
    expect(negotiateLang('zh', 'en')).toBe('zh');
    expect(negotiateLang('fr', 'zh')).toBe('zh');
  });

  it('fills parameters', () => {
    expect(translator('en')('auth.tooMany', { min: 3 })).toBe(
      'Too many failed attempts. Try again in 3 min.',
    );
    expect(translator('zh')('auth.tooMany', { min: 3 })).toBe('失败次数过多，请在 3 分钟后重试。');
  });
});

describe('brand', () => {
  it('matches the Origin mark of the installed @openlinkos/vitepress-theme', () => {
    const require = createRequire(import.meta.url);
    const theme = path.dirname(require.resolve('@openlinkos/vitepress-theme/package.json'));
    const brand = path.join(theme, 'dist', 'brand', 'out', 'origin', 'web');
    const read = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    for (const file of ['favicon.svg', 'logo.svg', 'logo-dark.svg']) {
      expect(read(path.join(PACKAGE_ROOT, 'assets', file)), file).toBe(
        read(path.join(brand, file)),
      );
    }
    const css = read(path.join(PACKAGE_ROOT, 'assets', 'admin.css'));
    const brands = JSON.parse(read(path.join(theme, 'dist', 'brand', 'brands.json'))) as Record<
      string,
      { colors: { mark: { light: string; dark: string } } }
    >;
    expect(css).toContain(`--accent: ${brands.origin?.colors.mark.light}`);
    expect(css).toContain(`--accent: ${brands.origin?.colors.mark.dark}`);
  });
});

describe('exposure', () => {
  it('allows loopback listeners, https public URLs, and loopback http public URLs', () => {
    expect(() => checkAdminExposure('127.0.0.1', null)).not.toThrow();
    expect(() => checkAdminExposure('::1', null)).not.toThrow();
    expect(() => checkAdminExposure('localhost', null)).not.toThrow();
    expect(() =>
      checkAdminExposure('0.0.0.0', parsePublicUrl('https://hub.example.com')),
    ).not.toThrow();
    expect(() =>
      checkAdminExposure('0.0.0.0', parsePublicUrl('http://localhost:7077')),
    ).not.toThrow();
  });

  it('refuses plain http beyond loopback, and explains why', () => {
    expect(() => checkAdminExposure('0.0.0.0', null)).toThrow(/not a loopback address.*https/s);
    expect(() => checkAdminExposure('192.168.1.5', null)).toThrow(/--admin-listen/);
    expect(() => checkAdminExposure('0.0.0.0', parsePublicUrl('http://hub.example.com'))).toThrow(
      /unencrypted/,
    );
    expect(() => checkAdminExposure('127.0.0.1', parsePublicUrl('http://hub.example.com'))).toThrow(
      /unencrypted/,
    );
  });

  it('parses public URLs and listen addresses', () => {
    expect(parsePublicUrl('')).toBeNull();
    expect(parsePublicUrl('https://hub.example.com/')?.origin).toBe('https://hub.example.com');
    expect(() => parsePublicUrl('https://hub.example.com/origin')).toThrow(/without a path/);
    expect(() => parsePublicUrl('ftp://hub.example.com')).toThrow();
    expect(() => parsePublicUrl('not a url')).toThrow();
    expect(parseListen('127.0.0.1:7078')).toEqual({ host: '127.0.0.1', port: 7078 });
    expect(parseListen('[::1]:7078')).toEqual({ host: '::1', port: 7078 });
    expect(() => parseListen('7078')).toThrow();
    expect(() => parseListen('127.0.0.1:99999')).toThrow();
  });

  it('keeps redirects inside the admin UI', () => {
    expect(safeNext('/admin/entries?kind=memory')).toBe('/admin/entries?kind=memory');
    expect(safeNext('https://evil.example/')).toBe('/admin/');
    expect(safeNext('//evil.example')).toBe('/admin/');
    expect(safeNext('/admin//evil.example')).toBe('/admin/');
    expect(safeNext('/admin/\\evil')).toBe('/admin/');
    expect(safeNext('/administrator')).toBe('/admin/');
    expect(safeNext('/admin/api/overview')).toBe('/admin/');
  });
});

describe('login limiter', () => {
  it('blocks a client after 10 failures and everyone after 100, within 10 minutes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 10; i++) {
      expect(l.check('a', i).ok).toBe(true);
      l.fail('a', i);
    }
    const blocked = l.check('a', 100);
    expect(blocked).toMatchObject({ ok: false, firstBlock: true });
    expect(l.check('a', 200)).toMatchObject({ ok: false, firstBlock: false });
    expect(l.check('b', 200).ok).toBe(true);
    expect(l.check('a', 10 * 60_000 + 10).ok).toBe(true);

    const g = new LoginLimiter();
    for (let i = 0; i < 100; i++) g.fail(`c${i % 20}`, i);
    expect(g.check('fresh', 1000)).toMatchObject({ ok: false });
  });
});
