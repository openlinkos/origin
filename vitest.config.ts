import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@openlinkos/origin-core': here('./packages/core/src/index.ts'),
      '@openlinkos/origin-adapters': here('./packages/adapters/src/index.ts'),
      '@openlinkos/origin-mcp': here('./packages/mcp/src/index.ts'),
      '@openlinkos/origin-admin': here('./packages/admin/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Most tests run real SQLite, file IO, and loopback HTTP; CI runners, Windows ones especially,
    // are several times slower than a workstation and vary from run to run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
