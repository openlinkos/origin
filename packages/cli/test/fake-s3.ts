import { Worker } from 'node:worker_threads';
import type { S3Config } from '../src/hub/s3.js';

/** Synthetic credentials of the fake S3 server; nothing real. */
export const CREDENTIALS = {
  accessKeyId: 'AKIDORIGINTEST',
  secretAccessKey: 'origin-test-secret/key+1',
};
export const BUCKET = 'origin-frames';
export const REGION = 'us-east-1';

/** The fake S3 server of fake-s3-worker.mjs, run in a worker thread, and its controls. */
export interface FakeS3 {
  endpoint: URL;
  /** An S3Config for it, with these changes. */
  config(changes?: Partial<S3Config>): S3Config;
  /** Every object, key (in the bucket) and size, in key order. */
  list(): Promise<Array<[string, number]>>;
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer): Promise<void>;
  /** The next `count` requests fail with `status`. */
  fail(count: number, status: number): Promise<void>;
  /** Answer every request this much later. */
  delay(ms: number): Promise<void>;
  counts(): Promise<{ PUT: number; GET: number; other: number }>;
  /** The most requests answered at once since the last call. */
  peak(): Promise<number>;
  /** Why the last request was refused, if one was. */
  rejection(): Promise<string | null>;
  close(): Promise<void>;
}

export async function startFakeS3(): Promise<FakeS3> {
  const worker = new Worker(new URL('./fake-s3-worker.mjs', import.meta.url), {
    workerData: { fakeS3: { bucket: BUCKET, credentials: CREDENTIALS, region: REGION } },
  });
  const port = await new Promise<number>((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m: { ready?: number }) => {
      if (m.ready) resolve(m.ready);
    });
  });
  let nextId = 1;
  const pending = new Map<number, (reply: unknown) => void>();
  worker.on('message', (m: { id?: number; reply?: unknown }) => {
    if (m.id !== undefined) pending.get(m.id)?.(m.reply);
  });
  const call = <T>(op: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((resolve) => {
      const id = nextId++;
      pending.set(id, (reply) => {
        pending.delete(id);
        resolve(reply as T);
      });
      worker.postMessage({ id, op, ...args });
    });
  const endpoint = new URL(`http://127.0.0.1:${port}`);
  return {
    endpoint,
    config: (changes = {}) => ({
      endpoint,
      bucket: BUCKET,
      prefix: 'hub',
      region: REGION,
      ...CREDENTIALS,
      addressing: 'path',
      timeoutMs: 5000,
      ...changes,
    }),
    list: () => call('list'),
    get: async (key) => {
      const data = await call<Uint8Array | null>('get', { key });
      return data ? Buffer.from(data) : null;
    },
    put: (key, data) => call('put', { key, data: new Uint8Array(data) }),
    fail: (count, status) => call('fail', { count, status }),
    delay: (ms) => call('delay', { ms }),
    counts: () => call('counts'),
    peak: () => call('peak'),
    rejection: () => call('rejection'),
    close: async () => {
      await call('close');
      await worker.terminate();
    },
  };
}
