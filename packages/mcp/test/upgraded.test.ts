import { StoreUpgradedError } from '@openlinkos/origin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/server.js';
import { refreshGate, startWatch } from '../src/tools.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('origin mcp leaves a store a newer Origin upgraded', () => {
  it('exits when a refresh finds the store upgraded', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const gate = refreshGate(async () => {
      throw new StoreUpgradedError();
    }, 0);
    await expect(gate(true)).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits when the background watch finds the store upgraded', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stop = startWatch(10, async () => {
      throw new StoreUpgradedError();
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledWith(1);
    stop();
    vi.useRealTimers();
  });

  it('exits from a tool call instead of answering', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(
      run(() => {
        throw new StoreUpgradedError();
      }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
