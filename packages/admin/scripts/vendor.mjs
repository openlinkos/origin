// Copy what the admin UI serves from the OpenLinkOS design system (@openlinkos/ui, a dev
// dependency) into dist/vendor: the stylesheet, its fonts, and the icons. The built package then
// carries them itself and needs the design system neither at runtime nor from a CDN.
// src/assets.ts reads these files.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['ui.css', 'icons.json', 'LICENSE-lucide.txt'];

const root = fileURLToPath(new URL('..', import.meta.url));
const ui = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@openlinkos/ui/package.json')),
  'dist',
);
const out = path.join(root, 'dist', 'vendor');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of FILES) fs.copyFileSync(path.join(ui, file), path.join(out, file));
// The fonts ui.css refers to (url(fonts/…)), with their licence.
if (fs.existsSync(path.join(ui, 'fonts'))) {
  fs.cpSync(path.join(ui, 'fonts'), path.join(out, 'fonts'), { recursive: true });
}
