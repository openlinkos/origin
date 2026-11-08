import { runCoreTests } from './stores.js';

// core/test/recall.test.ts, on PostgreSQL.
await runCoreTests('recall', () => import('../../../core/test/recall.test.js'));
