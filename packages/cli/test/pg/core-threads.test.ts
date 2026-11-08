import { runCoreTests } from './stores.js';

// core/test/threads.test.ts, on PostgreSQL.
await runCoreTests('threads', () => import('../../../core/test/threads.test.js'));
