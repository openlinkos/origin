import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The release workflow publishes these five together; it only finds out on npm what is wrong with a
// manifest, so check here what npm would refuse or publish wrongly.
const DIRS = ['core', 'adapters', 'mcp', 'admin', 'cli'];

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const manifests = DIRS.map((dir) => ({ dir, pkg: JSON.parse(read(`../../${dir}/package.json`)) }));
const names = new Set(manifests.map(({ pkg }) => pkg.name));

describe('published packages', () => {
  it.each(manifests)('packages/$dir can be published', ({ dir, pkg }) => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toMatchObject({ access: 'public', provenance: true });
    expect(pkg.repository).toMatchObject({
      url: 'git+https://github.com/openlinkos/origin.git',
      directory: `packages/${dir}`,
    });
    expect(pkg.license).toBe('MIT');
    expect(pkg.files).toContain('dist');
    for (const [name, range] of Object.entries({ ...pkg.dependencies })) {
      expect(range, name).toEqual(
        names.has(name) ? 'workspace:*' : expect.stringMatching(/^\d+\.\d+\.\d+$/),
      );
    }
  });

  it('share one version, which has a section in CHANGELOG.md', () => {
    const versions = new Set(manifests.map(({ pkg }) => pkg.version));
    expect(versions.size).toBe(1);
    const [version] = versions;
    expect(read('../../../CHANGELOG.md')).toContain(`## [${version}] - `);
  });
});
