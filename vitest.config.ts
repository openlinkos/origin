import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const onPostgres = (process.env.ORIGIN_TEST_DATABASE_URL ?? '') !== '';

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
    // With ORIGIN_TEST_DATABASE_URL set, the stores are in PostgreSQL (see test/pg-global.ts).
    globalSetup: ['./test/pg-global.ts'],
    setupFiles: ['./test/pg-setup.ts'],
    // Most tests run real SQLite, file IO, and loopback HTTP; CI runners, Windows ones especially,
    // are several times slower than a workstation and vary from run to run. On PostgreSQL, each
    // statement is a round trip to a server every test file shares.
    testTimeout: onPostgres ? 120_000 : 30_000,
    hookTimeout: onPostgres ? 120_000 : 30_000,
  },
});
