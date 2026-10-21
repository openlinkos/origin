import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root, from src/ (tests) and dist/ (built) alike. */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Asset {
  /** Logical name, e.g. `admin.css`. */
  name: string;
  /** Name with a content hash, e.g. `admin.1a2b3c4d5e.css`; the URL is `/admin/assets/<file>`. */
  file: string;
  type: string;
  body: Buffer;
}

const SOURCES: Array<{ name: string; path: string; type: string; optional?: boolean }> = [
  { name: 'admin.css', path: 'assets/admin.css', type: 'text/css; charset=utf-8' },
  { name: 'favicon.svg', path: 'assets/favicon.svg', type: 'image/svg+xml' },
  { name: 'logo.svg', path: 'assets/logo.svg', type: 'image/svg+xml' },
  { name: 'logo-dark.svg', path: 'assets/logo-dark.svg', type: 'image/svg+xml' },
  // The browser script is compiled by `pnpm build`; pages work without it.
  {
    name: 'admin.js',
    path: 'dist/client/admin.js',
    type: 'text/javascript; charset=utf-8',
    optional: true,
  },
];

/** Static files of the admin UI, loaded once, served under content-hashed names. */
export class Assets {
  private readonly byName = new Map<string, Asset>();
  private readonly byFile = new Map<string, Asset>();

  constructor(root = PACKAGE_ROOT) {
    for (const src of SOURCES) {
      let body: Buffer;
      try {
        body = fs.readFileSync(path.join(root, src.path));
      } catch (err) {
        if (src.optional) continue;
        throw err;
      }
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
      const ext = path.extname(src.name);
      const asset: Asset = {
        name: src.name,
        file: `${src.name.slice(0, -ext.length)}.${hash}${ext}`,
        type: src.type,
        body,
      };
      this.byName.set(asset.name, asset);
      this.byFile.set(asset.file, asset);
    }
  }

  /** The URL of an asset, or null if it is not available (the browser script before a build). */
  url(name: string): string | null {
    const asset = this.byName.get(name);
    return asset ? `/admin/assets/${asset.file}` : null;
  }

  find(file: string): Asset | undefined {
    return this.byFile.get(file);
  }
}
