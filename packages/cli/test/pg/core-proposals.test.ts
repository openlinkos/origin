import { runCoreTests } from './stores.js';

// core/test/proposals.test.ts, on PostgreSQL.
await runCoreTests('proposals', () => import('../../../core/test/proposals.test.js'));
