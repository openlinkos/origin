import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Assets, PACKAGE_ROOT, vendorFile } from '../src/assets.js';
import { checkAdminExposure, parseListen, parsePublicUrl } from '../src/config.js';
import { escapeHtml, href, html, raw } from '../src/html.js';
import { safeNext } from '../src/http.js';
import { en } from '../src/i18n/en.js';
import { negotiateLang, translator } from '../src/i18n/index.js';
import { zh } from '../src/i18n/zh.js';
import { ICON_NAMES } from '../src/icons.js';
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

  it('makes English words agree with their counts', () => {
    const t = translator('en');
    expect(t('forget.summary', { entries: 1, events: 1 })).toBe(
      'This will forget 1 entry and 1 event',
    );
    expect(t('forget.summary', { entries: 2, events: 0 })).toBe(
      'This will forget 2 entries and 0 events',
    );
    expect(t('overview.staleDevices', { n: 1 })).toMatch(/^1 device has sent/);
    expect(translator('zh')('forget.summary', { entries: 1, events: 2 })).toBe(
      '将遗忘 1 个条目和 2 个事件',
    );
  });

  it('leaves no English count without its plural form', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toMatch(/\(s\)/);
      for (const m of text.matchAll(/\{(n|count|entries|events)\} ([a-z]+s)\b/g)) {
        // A count followed by a plural noun must use {n|one|other}.
        expect(['n characters'], `${key}: ${m[0]}`).toContain(`${m[1]} ${m[2]}`);
      }
    }
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
    // The pages take their accent from the design system's Origin brand (data-brand="origin").
    const kit = read(vendorFile('ui.css'));
    const origin = /\[data-brand="origin"\]\s*\{([^}]*)\}/.exec(kit)?.[1] ?? '';
    const brands = JSON.parse(read(path.join(theme, 'dist', 'brand', 'brands.json'))) as Record<
      string,
      { colors: { mark: { light: string; dark: string } } }
    >;
    const mark = brands.origin?.colors.mark;
    expect(origin).toContain(
      `--ol-palette-accent-mark: light-dark(${mark?.light}, ${mark?.dark});`,
    );
  });

  it('adds to the design system with its tokens only, never literal colours', () => {
    const css = fs.readFileSync(path.join(PACKAGE_ROOT, 'assets', 'admin.css'), 'utf8');
    const all = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // The one exception: the chart palette, eight categorical colours the kit does not have yet,
    // each a light and a dark value, in one block and nowhere else.
    const palette = /^body \{([^}]*)\}/m.exec(all)?.[1] ?? '';
    const slots = palette.match(/--admin-series-\d: light-dark\([^;]*\);/g) ?? [];
    expect(slots).toHaveLength(8);
    expect(palette.replace(/--admin-series-\d: light-dark\([^;]*\);/g, '').trim()).toBe('');
    const rules = all.replace(/^body \{[^}]*\}/m, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/i);
    expect(rules).not.toMatch(/@import|url\(/i);
    expect(rules).toContain('var(--ol-');
  });
});

describe('assets', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A package root with the given design system files, next to the admin's own assets. */
  function fakeRoot(vendor: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-admin-assets-'));
    roots.push(root);
    fs.cpSync(path.join(PACKAGE_ROOT, 'assets'), path.join(root, 'assets'), { recursive: true });
    for (const [file, body] of Object.entries(vendor)) {
      fs.mkdirSync(path.dirname(path.join(root, 'dist', 'vendor', file)), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist', 'vendor', file), body);
    }
    return root;
  }

  it('has every icon the pages use in the design system', () => {
    const assets = new Assets();
    expect(assets.iconViewBox).toBe('0 0 24 24');
    for (const name of ICON_NAMES)
      expect(assets.icon(name), name).toMatch(
        /^<(path|circle|rect|line|polyline|polygon|ellipse) /,
      );
  });

  it('refuses icons that are more than plain shapes', () => {
    const icons = (body: string) =>
      JSON.stringify({ lucide: '0', viewBox: '0 0 24 24', icons: { search: body } });
    const ok = fakeRoot({ 'ui.css': '', 'icons.json': icons('<circle cx="11" r="8" />') });
    expect(new Assets(ok).icon('search')).toBe('<circle cx="11" r="8" />');
    for (const bad of [
      '<script>alert(1)</script>',
      '<path d="M0" onload="alert(1)" />',
      '<image href="https://evil.example/x.png" />',
      '<path d="M0" /><foreignObject></foreignObject>',
      '<path style="fill:red" />',
      '<path d="M0" ></path>',
    ]) {
      expect(() => new Assets(fakeRoot({ 'ui.css': '', 'icons.json': icons(bad) })), bad).toThrow(
        /not plain shapes/,
      );
    }
  });

  it('serves the fonts of the stylesheet under hashed names next to it', () => {
    const root = fakeRoot({
      'ui.css': '@font-face{src:url(fonts/Geist-Variable.woff2)format("woff2")}',
      'icons.json': JSON.stringify({ viewBox: '0 0 24 24', icons: {} }),
      'fonts/Geist-Variable.woff2': 'wOF2 font bytes',
    });
    const assets = new Assets(root);
    const cssUrl = assets.url('ui.css') ?? '';
    const css = assets.find(cssUrl.slice('/admin/assets/'.length))?.body.toString('utf8') ?? '';
    const font = /url\((fonts\/Geist-Variable\.[0-9a-f]{10}\.woff2)\)/.exec(css)?.[1] ?? '';
    expect(font).not.toBe('');
    // Relative to /admin/assets/ui.<hash>.css, the URL is /admin/assets/fonts/….
    expect(assets.find(font)).toMatchObject({
      type: 'font/woff2',
      name: 'fonts/Geist-Variable.woff2',
    });
    expect(assets.find(font)?.body.toString()).toBe('wOF2 font bytes');
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
