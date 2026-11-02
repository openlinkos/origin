import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What OpenClaw needs of the published package (its plugin manifest and package metadata, see
 * https://docs.openclaw.ai/plugins/manifest): checked here, since a mistake would show only when
 * OpenClaw installs it.
 */
const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('openclaw.plugin.json'));
const built = fs.existsSync(new URL('../dist/index.js', import.meta.url));

describe('the OpenClaw plugin package', () => {
  it('declares its built entry and the OpenClaw versions it was checked against', () => {
    expect(pkg.name).toBe('@openlinkos/origin-openclaw');
    expect(pkg.type).toBe('module');
    expect(pkg.openclaw.extensions).toEqual(['./dist/index.js']);
    expect(pkg.openclaw.compat).toEqual({
      pluginApi: '>=2026.10.6',
      minGatewayVersion: '2026.10.6',
    });
    expect(pkg.openclaw.install.minHostVersion).toBe('>=2026.10.6');
    // OpenClaw is the host, never installed with the plugin: an optional peer, no dependencies.
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ openclaw: '>=2026.10.6' });
    expect(pkg.peerDependenciesMeta).toEqual({ openclaw: { optional: true } });
    // src/index.ts compiles to the declared entry.
    const tsconfig = JSON.parse(read('tsconfig.json'));
    expect(tsconfig.compilerOptions).toMatchObject({ rootDir: 'src', outDir: 'dist' });
    expect(fs.existsSync(new URL('../src/index.ts', import.meta.url))).toBe(true);
  });

  it('has the manifest OpenClaw reads before it loads the plugin', () => {
    expect(manifest.id).toBe('origin');
    expect(manifest.activation).toEqual({ onStartup: true });
    expect(manifest.configSchema.type).toBe('object');
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'openclaw.plugin.json']));
  });

  it.skipIf(!built)('packs the manifest and the built code, and nothing else of the source', () => {
    // pnpm packs what the release publishes (.github/workflows/release.yml).
    const out = execSync('pnpm pack --dry-run --json', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const { files } = JSON.parse(out) as { files: Array<{ path: string }> };
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        'openclaw.plugin.json',
        'package.json',
        'README.md',
        'dist/index.js',
        'dist/index.d.ts',
      ]),
    );
    expect(paths.filter((p) => !p.startsWith('dist/'))).toEqual([
      'LICENSE',
      'README.md',
      'openclaw.plugin.json',
      'package.json',
    ]);
    expect(
      paths.some(
        (p) =>
          p.endsWith('.map') ||
          p.endsWith('.tsbuildinfo') ||
          (p.endsWith('.ts') && !p.endsWith('.d.ts')),
      ),
    ).toBe(false);
  });
});
