import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { exitWhenWritten } from '../src/exit.js';

/** A stream whose reader takes each write after `ms`, as a pipe does once it is full. */
function slowPipe(ms: number): { stream: Writable; taken: number[] } {
  const taken: number[] = [];
  const stream = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _enc, cb) {
      setTimeout(() => {
        taken.push(chunk.length);
        cb();
      }, ms);
    },
  });
  return { stream, taken };
}

describe('exitWhenWritten', () => {
  it('ends the process only once every stream has written all it was given', async () => {
    const out = slowPipe(5);
    const err = slowPipe(1);
    out.stream.write(Buffer.alloc(200_000));
    out.stream.write(Buffer.alloc(100_000));
    err.stream.write('a failure\n');
    const exit = vi.fn();
    exitWhenWritten(3, [out.stream, err.stream], exit);
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(3);
    expect(out.taken.reduce((a, b) => a + b, 0)).toBe(300_000);
  });

  it('ends the process when a reader has gone', async () => {
    const gone = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const exit = vi.fn();
    exitWhenWritten(0, [gone, slowPipe(1).stream], exit);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
