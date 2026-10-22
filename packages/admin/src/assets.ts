import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root, from src/ (tests) and dist/ (built) alike. */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A file of the OpenLinkOS design system, `@openlinkos/ui`: the copy that `pnpm build` puts in
 * dist/vendor (scripts/vendor.mjs), or, before a build, the installed dev dependency itself.
 */
export function vendorFile(file: string, root = PACKAGE_ROOT): string {
  const built = path.join(root, 'dist', 'vendor', file);
  if (fs.existsSync(built)) return built;
  try {
    const pkg = createRequire(import.meta.url).resolve('@openlinkos/ui/package.json');
    return path.join(path.dirname(pkg), 'dist', file);
  } catch {
    return built;
  }
}

export interface Asset {
  /** Logical name, e.g. `admin.css`. */
  name: string;
  /** Name with a content hash, e.g. `admin.1a2b3c4d5e.css`; the URL is `/admin/assets/<file>`. */
  file: string;
  type: string;
  body: Buffer;
}

const CSS = 'text/css; charset=utf-8';

function sources(root: string) {
  return [
    // The design system's stylesheet, then the few additions of the admin UI.
    { name: 'ui.css', path: vendorFile('ui.css', root), type: CSS },
    { name: 'admin.css', path: path.join(root, 'assets/admin.css'), type: CSS },
    { name: 'favicon.svg', path: path.join(root, 'assets/favicon.svg'), type: 'image/svg+xml' },
    { name: 'logo.svg', path: path.join(root, 'assets/logo.svg'), type: 'image/svg+xml' },
    { name: 'logo-dark.svg', path: path.join(root, 'assets/logo-dark.svg'), type: 'image/svg+xml' },
    // The browser script is compiled by `pnpm build`; pages work without it.
    {
      name: 'admin.js',
      path: path.join(root, 'dist/client/admin.js'),
      type: 'text/javascript; charset=utf-8',
      optional: true,
    },
  ];
}

/** `url(fonts/<name>.woff2)` in the design system's stylesheet. */
const FONT_URL = /url\((["']?)fonts\/([A-Za-z0-9_-]+)\.woff2(["']?)\)/g;

/**
 * The body of an icon symbol: only basic shapes with geometry and fill attributes. Icons come from
 * the design system and are inlined as markup, so anything else (script, event handlers, links,
 * styles) is refused when the icons are loaded.
 */
const SAFE_ICON =
  /^(?:\s*<(?:path|circle|rect|line|polyline|polygon|ellipse)(?:\s+(?:d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|width|height|points|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin)="[^"<>&]*")*\s*\/>)*\s*$/;

/** Static files of the admin UI, loaded once, served under content-hashed names; and the icons. */
export class Assets {
  private readonly byName = new Map<string, Asset>();
  private readonly byFile = new Map<string, Asset>();
  private readonly icons = new Map<string, string>();
  /** The view box shared by every icon. */
  readonly iconViewBox: string;

  constructor(root = PACKAGE_ROOT) {
    for (const src of sources(root)) {
      let body: Buffer;
      try {
        body = fs.readFileSync(src.path);
      } catch (err) {
        if (src.optional) continue;
        throw err;
      }
      if (src.name === 'ui.css') body = this.withFonts(body, root);
      this.add(src.name, src.type, body);
    }

    const icons = JSON.parse(fs.readFileSync(vendorFile('icons.json', root), 'utf8')) as {
      viewBox: string;
      icons: Record<string, string>;
    };
    this.iconViewBox = icons.viewBox;
    for (const [name, body] of Object.entries(icons.icons)) {
      if (!/^[a-z0-9-]+$/.test(name) || !SAFE_ICON.test(body)) {
        throw new Error(`The icon "${name}" of @openlinkos/ui is not plain shapes.`);
      }
      this.icons.set(name, body);
    }
  }

  private add(name: string, type: string, body: Buffer): Asset {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    const ext = path.extname(name);
    const file = `${name.slice(0, -ext.length)}.${hash}${ext}`;
    const asset: Asset = { name, file, type, body };
    this.byName.set(asset.name, asset);
    this.byFile.set(asset.file, asset);
    return asset;
  }

  /**
   * Serve the fonts the stylesheet refers to next to it (`/admin/assets/fonts/…`) under
   * content-hashed names, so they can be cached as immutable, and point the stylesheet at them.
   */
  private withFonts(css: Buffer, root: string): Buffer {
    const text = css.toString('utf8').replace(FONT_URL, (_m, _open, font: string) => {
      const name = `fonts/${font}.woff2`;
      const asset =
        this.byName.get(name) ??
        this.add(name, 'font/woff2', fs.readFileSync(vendorFile(name, root)));
      return `url(${asset.file})`;
    });
    return Buffer.from(text, 'utf8');
  }

  /** The URL of an asset, or null if it is not available (the browser script before a build). */
  url(name: string): string | null {
    const asset = this.byName.get(name);
    return asset ? `/admin/assets/${asset.file}` : null;
  }

  find(file: string): Asset | undefined {
    return this.byFile.get(file);
  }

  /** The shapes of an icon, checked to be plain markup when loaded; undefined if there is none. */
  icon(name: string): string | undefined {
    return this.icons.get(name);
  }
}
