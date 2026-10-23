import { type Database, openMemoryDatabase } from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOriginServer, createReplicaServer, type ReplicaOptions } from '../src/index.js';
import { refreshGate } from '../src/tools.js';

/**
 * Background sync in origin mcp (see docs/architecture.md#mcp-server): new log lines are looked for
 * every minute while the server runs, and synced one last time, within a bound, when the agent
 * leaves. Fake timers drive the minutes; the syncs are stand-ins whose progress the tests control.
 */

let db: Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  db = openMemoryDatabase();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

/** A sync that runs until the test releases it, recording how many run at once. */
function controlledSync() {
  const s = {
    started: 0,
    running: 0,
    most: 0,
    release: () => {},
    fn: () =>
      new Promise<void>((resolve) => {
        s.started++;
        s.running++;
        s.most = Math.max(s.most, s.running);
        s.release = () => {
          s.running--;
          resolve();
        };
      }),
  };
  return s;
}

describe('origin mcp, in the background', () => {
  it('looks for new log lines every minute and ingests only when they changed', async () => {
    let ingests = 0;
    let looks = 0;
    let dirty = false;
    const server = createOriginServer({
      db,
      home: '',
      sync: async () => {
        ingests++;
      },
      changed: async () => {
        looks++;
        return dirty;
      },
    });
    server.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(looks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect([looks, ingests]).toEqual([1, 0]); // nothing new: nothing read
    dirty = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect([looks, ingests]).toEqual([2, 1]);
    // The agent leaves: one last ingestion, and no more looks.
    await server.stop();
    expect(ingests).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(looks).toBe(2);
  });

  it('never runs a background sync alongside another one', async () => {
    const sync = controlledSync();
    const server = createOriginServer({ db, home: '', sync: sync.fn, syncIntervalMs: 10_000 });
    server.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync.started).toBe(1);
    // A read tool while it runs shares it; the next look waits for it to finish.
    const read = server.refresh();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sync.started).toBe(1);
    sync.release();
    await read;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync.started).toBe(2);
    // A read a minute after the last sync needs one: it shares the one in flight.
    let answered = false;
    void server.refresh().then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(false);
    sync.release();
    await vi.advanceTimersByTimeAsync(0);
    expect([answered, sync.started, sync.most]).toEqual([true, 2, 1]);
    const stopping = server.stop();
    await vi.advanceTimersByTimeAsync(0);
    sync.release();
    await stopping;
  });

  it('syncs one last time when the agent leaves, waiting at most closeTimeoutMs', async () => {
    let ingests = 0;
    const server = createOriginServer({
      db,
      home: '',
      sync: () => {
        ingests++;
        return new Promise<void>(() => {}); // never finishes
      },
      closeTimeoutMs: 5_000,
    });
    let stopped = false;
    void server.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect([ingests, stopped]).toEqual([1, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
  });

  it('can be turned off', async () => {
    let looks = 0;
    const server = createOriginServer({
      db,
      home: '',
      sync: async () => {},
      changed: async () => {
        looks++;
        return true;
      },
      watchIntervalMs: 0,
    });
    server.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(looks).toBe(0);
    await server.stop();
  });
});

describe('origin mcp on a connected device, in the background', () => {
  const replica = (over: Partial<ReplicaOptions>) =>
    createReplicaServer({
      db,
      home: '',
      device: 'laptop',
      // Never contacted: the background work syncs through `sync`, not through the hub's /mcp.
      hub: { url: 'http://127.0.0.1:9', token: 'ogn_unused' },
      ...over,
    });

  it('ingests and pushes new log lines, and retries a push that failed', async () => {
    let dirty = true;
    let hubUp = false;
    const calls: string[] = [];
    const server = replica({
      ingest: async () => {
        calls.push('ingest');
      },
      sync: async () => {
        calls.push(hubUp ? 'sync' : 'sync failed');
        if (!hubUp) throw new Error('connect ECONNREFUSED');
      },
      changed: async () => dirty,
    });
    server.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['ingest', 'sync failed']);
    // Nothing new, but the push is still owed: retried until it succeeds, then nothing.
    dirty = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['ingest', 'sync failed', 'sync failed']);
    hubUp = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.at(-1)).toBe('sync');
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls.length).toBe(after);
    // The agent leaves: one last ingestion and push.
    await server.stop();
    expect(calls.slice(after)).toEqual(['ingest', 'sync']);
    await server.close();
  });

  it('bounds the last push when the agent leaves, and never overlaps pushes', async () => {
    const sync = controlledSync();
    const server = replica({ ingest: async () => {}, sync: sync.fn, closeTimeoutMs: 3_000 });
    server.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync.started).toBe(1);
    // The hub hangs: leaving waits 3 s, not for the push in flight and the last one queued after.
    let stopped = false;
    void server.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(sync.most).toBe(1);
    sync.release();
    await server.close();
  });
});

describe('refreshGate', () => {
  it('lets a read skip a refresh in flight when the last one is recent enough', async () => {
    const sync = controlledSync();
    const gate = refreshGate(sync.fn, 10_000);
    const first = gate();
    sync.release();
    await first;
    const background = gate(true);
    let answered = false;
    void gate().then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    // Later, a read that needs a refresh shares the one in flight.
    await vi.advanceTimersByTimeAsync(10_000);
    let shared = false;
    void gate().then(() => {
      shared = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shared).toBe(false);
    sync.release();
    await background;
    await vi.advanceTimersByTimeAsync(0);
    expect([shared, sync.started]).toEqual([true, 2]);
  });
});
