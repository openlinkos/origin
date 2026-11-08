import { runCoreTests } from './stores.js';

// core/test/entries.test.ts, on PostgreSQL.
await runCoreTests('entries', () => import('../../../core/test/entries.test.js'));
