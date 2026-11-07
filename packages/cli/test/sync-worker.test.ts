import { afterEach, describe, expect, it } from 'vitest';
import { SyncWorker, SyncWorkerError, type SyncWorkerOptions } from '../src/sync-worker.js';

/**
 * A handler that counts its calls (so a test can tell a new worker from the same one) and does
 * what the request asks: echo, throw, crash, exit, spin, sleep, or move large data.
 */
const HANDLER = `(() => {
  let calls = 0;
  return async (request, { data, transfer }) => {
    calls++;
    switch (request.op) {
      case 'echo':
        return { calls, value: request.value, data };
      case 'throw':
        throw Object.assign(new TypeError('bad request'), { code: '42P01', detail: 'no table', at: 3, nested: { a: 1 } });
      case 'reject':
        return Promise.reject(new Error('rejected later'));
      case 'throw a string':
        throw 'plain text';
      case 'crash':
        setTimeout(() => { throw new Error('boom'); }, 0);
        return new Promise(() => {});
      case 'crash later':
        setTimeout(() => { throw new Error('boom later'); }, 10);
        return calls;
      case 'exit':
        process.exit(3);
      case 'spin':
        for (;;) {}
      case 'sleep':
        await new Promise((resolve) => setTimeout(resolve, request.ms));
        return calls;
      case 'bytes': {
        const out = new Uint8Array(request.size);
        for (let i = 0; i < out.length; i += 4096) out[i] = (i / 4096) & 0xff;
        transfer.push(out.buffer);
        return out;
      }
      case 'sum': {
        let sum = 0;
        for (let i = 0; i < request.bytes.length; i += 4096) sum += request.bytes[i];
        return { length: request.bytes.length, sum };
      }
      case 'text':
        return 'x'.repeat(request.size);
    }
    throw new Error('unknown op ' + request.op);
  };
})()`;

const workers: SyncWorker[] = [];
const worker = (opts: Partial<SyncWorkerOptions> = {}) => {
  const w = new SyncWorker({ source: HANDLER, ...opts });
  workers.push(w);
  return w;
};
afterEach(() => {
  for (const w of workers.splice(0)) w.close();
});

/** The error a call throws, and how long it took. */
function failure(fn: () => unknown): { error: unknown; ms: number } {
  const started = performance.now();
  try {
    fn();
  } catch (error) {
    return { error, ms: performance.now() - started };
  }
  throw new Error('expected the call to fail');
}

describe('a synchronous worker', () => {
  it('answers calls, keeping its state between them', () => {
    const w = worker({ data: { greeting: 'hello' } });
    expect(w.call({ op: 'echo', value: [1, 'two', { three: 3n }] })).toEqual({
      calls: 1,
      value: [1, 'two', { three: 3n }],
      data: { greeting: 'hello' },
    });
    expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(2);
    expect(w.call({ op: 'sleep', ms: 50 })).toBe(3);
  });

  it('throws what the handler throws, and goes on with the same worker', () => {
    const w = worker();
    w.call({ op: 'echo' });
    const { error } = failure(() => w.call({ op: 'throw' }));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyncWorkerError);
    expect(error).toMatchObject({
      name: 'TypeError',
      message: 'bad request',
      code: '42P01',
      detail: 'no table',
      at: 3,
    });
    // Properties that are not primitives stay behind.
    expect((error as { nested?: unknown }).nested).toBeUndefined();
    expect(() => w.call({ op: 'reject' })).toThrow('rejected later');
    expect(() => w.call({ op: 'throw a string' })).toThrow('plain text');
    expect(() => w.call({ op: 'nothing' })).toThrow('unknown op nothing');
    expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(6);
  });

  it('fails a call at once when the worker dies, and starts a new one', () => {
    const w = worker();
    expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(1);
    for (const op of ['crash', 'exit']) {
      const { error, ms } = failure(() => w.call({ op }));
      expect(error).toBeInstanceOf(SyncWorkerError);
      expect((error as SyncWorkerError).reason).toBe('died');
      expect((error as Error).message).toMatch(
        op === 'crash' ? /the worker failed: boom/ : /exited with code 3/,
      );
      // Well before any heartbeat could be missed.
      expect(ms).toBeLessThan(5_000);
      expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(1);
    }
  });

  it('replaces a worker that died between calls', () => {
    const w = worker();
    expect(w.call({ op: 'crash later' })).toBe(1);
    // Wait without letting the event loop run, so this thread hears nothing of the exit.
    const until = Date.now() + 300;
    while (Date.now() < until) {}
    expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(1);
  });

  it('fails when the handler cannot be loaded', () => {
    for (const source of ['require("origin-no-such-module")', 'async (request) => {']) {
      const { error, ms } = failure(() => worker({ source }).call({ op: 'echo' }));
      expect(error).toBeInstanceOf(SyncWorkerError);
      expect((error as SyncWorkerError).reason).toBe('died');
      expect((error as Error).message).toMatch(
        /the worker failed: .*(Cannot find module|Unexpected)/,
      );
      expect(ms).toBeLessThan(5_000);
    }
  });

  it('takes a worker whose heartbeat stops for dead', () => {
    const w = worker({ heartbeatMs: 50, stallMs: 1_500 });
    expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(1);
    const { error, ms } = failure(() => w.call({ op: 'spin' }));
    expect(error).toBeInstanceOf(SyncWorkerError);
    expect((error as SyncWorkerError).reason).toBe('stalled');
    expect((error as Error).message).toMatch(/no heartbeat for 1500 ms/);
    expect(ms).toBeGreaterThanOrEqual(1_400);
    expect(ms).toBeLessThan(10_000);
    // The spinning worker was stopped; a new one answers.
    expect(w.call<{ calls: number }>({ op: 'echo' }).calls).toBe(1);
  });

  it('gives up on a call that takes longer than allowed', () => {
    const w = worker();
    expect(w.call({ op: 'sleep', ms: 0 })).toBe(1);
    const { error, ms } = failure(() => w.call({ op: 'sleep', ms: 5_000 }, { timeoutMs: 300 }));
    expect(error).toBeInstanceOf(SyncWorkerError);
    expect((error as SyncWorkerError).reason).toBe('timeout');
    expect((error as Error).message).toBe('no answer from the worker within 300 ms');
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(3_000);
    expect(w.call({ op: 'sleep', ms: 0 }, { timeoutMs: 15_000 })).toBe(1);
  });

  it('moves large messages both ways', () => {
    const w = worker();
    const size = 64 * 1024 * 1024;
    const bytes = w.call<Uint8Array>({ op: 'bytes', size });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(size);
    expect(bytes[4096 * 255]).toBe(255);
    expect(bytes[4096 * 256]).toBe(0);
    expect(bytes[size - 1]).toBe(0);

    const sent = new Uint8Array(size).fill(1);
    expect(w.call({ op: 'sum', bytes: sent }, { transfer: [sent.buffer] })).toEqual({
      length: size,
      sum: size / 4096,
    });
    // Moved, not copied.
    expect(sent.length).toBe(0);

    expect(w.call<string>({ op: 'text', size: 32 * 1024 * 1024 }).length).toBe(32 * 1024 * 1024);
  });
});
