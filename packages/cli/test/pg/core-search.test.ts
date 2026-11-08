import { runCoreTests } from './stores.js';

// core/test/search.test.ts, on PostgreSQL.
await runCoreTests('search', () => import('../../../core/test/search.test.js'));
