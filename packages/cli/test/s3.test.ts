import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  appendRemote,
  backupStore,
  bucketFrameStore,
  createToken,
  type Database,
  frameBucket,
  frameKey,
  getEvent,
  IDLE_SEAL_MS,
  listSessions,
  openDatabase,
  rawLocator,
  readRawLine,
  releaseObjectStore,
  sealIdleMirrors,
  syncSource,
  uploadFrames,
  useObjectStore,
} from '@openlinkos/origin-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { frameStoreContract } from '../../core/test/frame-contract.js';
import { fakeAdapter, line, mirrorText } from '../../core/test/helpers.js';
import { downgradeToV1 } from '../../core/test/legacy.js';
import { bucketConfig, bucketFlags, setUpFrames } from '../src/hub/bucket.js';
import { ObjectStoreError, PROBE_KEY, S3ObjectStore } from '../src/hub/s3.js';
import { createHubServer } from '../src/hub/server.js';
import {
  amzDate,
  authorization,
  canonicalRequest,
  EMPTY_SHA256,
  sha256Hex,
  stringToSign,
  uriEncode,
} from '../src/hub/sigv4.js';
import { syncWithHub } from '../src/hub/sync.js';
import { SyncHttp, SyncHttpError, type SyncRequest } from '../src/hub/sync-http.js';
import { BUCKET, CREDENTIALS, type FakeS3, startFakeS3 } from './fake-s3.js';
// @ts-expect-error: plain JavaScript, run in a worker by fake-s3.ts
import { verifySignature } from './fake-s3-worker.mjs';

let fake: FakeS3;
beforeAll(async () => {
  fake = await startFakeS3();
});
afterAll(async () => {
  await fake.close();
});

const dirs: string[] = [];
const temp = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `origin-s3-${name}-`));
  dirs.push(dir);
  return dir;
};
const stores: S3ObjectStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const dir of dirs.splice(0)) {
    releaseObjectStore(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
let prefixes = 0;
/** An S3 object store over the fake server, under a prefix of its own. */
const s3 = (changes: Parameters<FakeS3['config']>[0] = {}) => {
  const store = new S3ObjectStore(fake.config({ prefix: `t${++prefixes}`, ...changes }), {
    retryDelaysMs: [0, 0],
  });
  stores.push(store);
  return store;
};

describe('AWS Signature Version 4', () => {
  // AWS's published test suite (aws-sig-v4-test-suite): its credentials, region, and service.
  const suite = {
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    },
    scope: { region: 'us-east-1', service: 'service', amzDate: '20150830T123600Z' },
  };
  const headers = { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' };
  const credential = 'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request';

  it('signs get-vanilla', () => {
    const req = { method: 'GET', path: '/', headers, payloadHash: EMPTY_SHA256 };
    const { canonical } = canonicalRequest(req);
    expect(canonical).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(stringToSign(suite.scope, canonical)).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n'),
    );
    expect(authorization(req, suite.credentials, suite.scope)).toBe(
      `AWS4-HMAC-SHA256 ${credential}, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`,
    );
  });

  it('signs get-vanilla-query-order-key-case', () => {
    const req = {
      method: 'GET',
      path: '/',
      query: [
        ['Param2', 'value2'],
        ['Param1', 'value1'],
      ] as Array<[string, string]>,
      headers,
      payloadHash: EMPTY_SHA256,
    };
    expect(canonicalRequest(req).canonical.split('\n')[2]).toBe('Param1=value1&Param2=value2');
    expect(authorization(req, suite.credentials, suite.scope)).toMatch(
      /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/,
    );
  });

  it('signs post-x-www-form-urlencoded', () => {
    const payloadHash = sha256Hex('Param1=value1');
    expect(payloadHash).toBe('9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e');
    const req = {
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      payloadHash,
    };
    expect(authorization(req, suite.credentials, suite.scope)).toBe(
      `AWS4-HMAC-SHA256 ${credential}, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a`,
    );
  });

  it('signs get-utf8, encoding the path', () => {
    const req = { method: 'GET', path: `/${uriEncode('ሴ')}`, headers, payloadHash: EMPTY_SHA256 };
    expect(req.path).toBe('/%E1%88%B4');
    expect(authorization(req, suite.credentials, suite.scope)).toMatch(
      /Signature=8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85$/,
    );
  });

  // The examples of Amazon S3's documentation for the Authorization header.
  const s3Example = {
    credentials: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    scope: { region: 'us-east-1', service: 's3', amzDate: '20130524T000000Z' },
  };

  it("signs S3's GET Object example", () => {
    const req = {
      method: 'GET',
      path: '/test.txt',
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        Range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY_SHA256,
    };
    expect(authorization(req, s3Example.credentials, s3Example.scope)).toMatch(
      /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    );
  });

  it("signs S3's PUT Object example, encoding the key", () => {
    const payloadHash = sha256Hex('Welcome to Amazon S3.');
    const req = {
      method: 'PUT',
      path: `/${uriEncode('test$file.text')}`,
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        Host: 'examplebucket.s3.amazonaws.com',
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': payloadHash,
      },
      payloadHash,
    };
    expect(req.path).toBe('/test%24file.text');
    expect(authorization(req, s3Example.credentials, s3Example.scope)).toMatch(
      /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/,
    );
  });

  it('formats request times and encodes reserved characters', () => {
    expect(amzDate(new Date('2026-10-23T08:09:10.123Z'))).toBe('20261023T080910Z');
    expect(uriEncode("a b+c/d!'()*~._-")).toBe('a%20b%2Bc%2Fd%21%27%28%29%2A~._-');
  });
});

describe('synchronous HTTP bridge', () => {
  const get = (url: string): SyncRequest => ({ method: 'GET', url, headers: {} });

  it('returns a response while the calling thread waits', () => {
    const client = new SyncHttp(5000);
    try {
      // Unsigned: the fake server answers, and refuses it.
      const res = client.request(get(`${fake.endpoint.origin}/${BUCKET}/x`));
      expect(res.status).toBe(403);
      expect(res.body.toString('utf8')).toContain('<Code>SignatureDoesNotMatch</Code>');
      expect(res.headers['content-type']).toBe('application/xml');
    } finally {
      client.close();
    }
  });

  it('surfaces network errors', () => {
    const client = new SyncHttp(5000);
    try {
      let error: unknown;
      try {
        // Port 1 on loopback: nothing listens there.
        client.request(get('http://127.0.0.1:1/'));
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SyncHttpError);
      expect((error as SyncHttpError).timedOut).toBe(false);
      expect((error as Error).message).toMatch(/fetch failed|ECONNREFUSED/);
    } finally {
      client.close();
    }
  });

  it('times out a request that takes too long, and goes on with the next', async () => {
    const client = new SyncHttp(5000);
    try {
      await fake.delay(1500);
      const started = Date.now();
      expect(() => client.request(get(`${fake.endpoint.origin}/${BUCKET}/x`), 300)).toThrow(
        /timed out/,
      );
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(waited).toBeLessThan(1400);
      await fake.delay(0);
      expect(client.request(get(`${fake.endpoint.origin}/${BUCKET}/y`)).status).toBe(403);
    } finally {
      await fake.delay(0);
      client.close();
    }
  });

  it('starts a new worker when one does not answer in time', async () => {
    // The caller gives up before the worker's own timeout: the worker is replaced.
    const client = new SyncHttp(5000, { graceMs: -900 });
    try {
      await fake.delay(800);
      expect(() => client.request(get(`${fake.endpoint.origin}/${BUCKET}/x`), 1000)).toThrow(
        /no answer from the worker/,
      );
      await fake.delay(0);
      // The new worker has to start first, which can take more than a second on a slow machine;
      // what matters here is that it answers.
      const res = client.request(get(`${fake.endpoint.origin}/${BUCKET}/y`), 15_000);
      expect(res.status).toBe(403);
    } finally {
      await fake.delay(0);
      client.close();
    }
  });

  it('adds little to each request', () => {
    const store = s3();
    const frame = Buffer.alloc(256 * 1024, 7);
    store.put('measure', frame);
    const started = performance.now();
    const n = 50;
    for (let i = 0; i < n; i++) expect(store.get('measure')?.length).toBe(frame.length);
    // A loopback round trip of a 256 KiB frame through the worker; generous for slow machines.
    expect((performance.now() - started) / n).toBeLessThan(50);
  });
});

describe('S3 object store', () => {
  it('writes and reads objects, and finds none where there is none', async () => {
    const store = s3();
    const data = Buffer.from('a sealed frame');
    store.put('claude-code/a.jsonl.zst/000000000000', data);
    expect(store.get('claude-code/a.jsonl.zst/000000000000')).toEqual(data);
    expect(store.get('claude-code/a.jsonl.zst/000000000099')).toBeNull();
    expect(await fake.get(`${store.config.prefix}/claude-code/a.jsonl.zst/000000000000`)).toEqual(
      data,
    );
  });

  it('encodes keys with spaces, CJK, and reserved characters', async () => {
    const store = s3();
    const key = frameKey(path.join('devices', 'laptop', 'codex', '项目 (a)+b&c=d', 'x!*.jsonl'), 5);
    store.put(key, Buffer.from('x'));
    expect(store.get(key)?.toString()).toBe('x');
    expect(await fake.list()).toContainEqual([`${store.config.prefix}/${key}`, 1]);
  });

  it('refuses a wrong secret without showing it', async () => {
    const store = s3({ secretAccessKey: 'not-the-secret-123' });
    let error: unknown;
    try {
      store.put('k', Buffer.from('x'));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect((error as Error).message).toMatch(/403 SignatureDoesNotMatch/);
    expect((error as Error).message).not.toContain('not-the-secret-123');
    expect(await fake.rejection()).toMatch(/signature does not match/);
  });

  it('tells a missing bucket from a missing object', () => {
    const store = s3({ bucket: 'no-such-bucket' });
    expect(() => store.get('k')).toThrow(/404 NoSuchBucket/);
  });

  it('tries again while the store is busy, and then gives up', async () => {
    const store = s3();
    await fake.fail(2, 503);
    store.put('busy', Buffer.from('x'));
    expect(store.get('busy')?.toString()).toBe('x');
    await fake.fail(3, 503);
    expect(() => store.get('busy')).toThrow(/503 SlowDown/);
  });

  it('writes and reads without blocking too, with the same tries and errors', async () => {
    const store = s3();
    const data = Buffer.from('a sealed frame, sent without blocking');
    await store.putAsync('claude-code/b.jsonl.zst/000000000000', data);
    expect(await store.getAsync('claude-code/b.jsonl.zst/000000000000')).toEqual(data);
    expect(store.get('claude-code/b.jsonl.zst/000000000000')).toEqual(data);
    expect(await store.getAsync('claude-code/b.jsonl.zst/000000000099')).toBeNull();
    await fake.fail(2, 503);
    expect(await store.getAsync('claude-code/b.jsonl.zst/000000000000')).toEqual(data);
    await fake.fail(3, 503);
    await expect(store.getAsync('claude-code/b.jsonl.zst/000000000000')).rejects.toThrow(
      /503 SlowDown/,
    );
    await expect(s3({ bucket: 'no-such-bucket' }).getAsync('k')).rejects.toThrow(
      /404 NoSuchBucket/,
    );
    await expect(s3({ secretAccessKey: 'not-the-secret-123' }).putAsync('k', data)).rejects.toThrow(
      ObjectStoreError,
    );
    const unreachable = s3({ endpoint: new URL('http://127.0.0.1:1') });
    await expect(unreachable.getAsync('k')).rejects.toThrow(/S3 GET .* failed: fetch failed/);
  });

  it('addresses a virtual-hosted bucket, signed for its host name', () => {
    const sent: SyncRequest[] = [];
    const answer = (req: SyncRequest) => {
      sent.push(req);
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    };
    const store = new S3ObjectStore(
      fake.config({ addressing: 'virtual', endpoint: new URL('https://s3.example.test') }),
      { http: { request: answer, requestAsync: async (req) => answer(req), close: () => {} } },
    );
    store.put('a b/c.zst/000000000000', Buffer.from('frame'));
    const req = sent[0] as SyncRequest;
    const url = new URL(req.url);
    expect(url.host).toBe(`${BUCKET}.s3.example.test`);
    expect(url.pathname).toBe('/hub/a%20b/c.zst/000000000000');
    const headers = Object.fromEntries(
      Object.entries({ ...req.headers, host: url.host }).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(
      verifySignature(
        { method: 'PUT', path: url.pathname, query: '', headers, body: Buffer.from('frame') },
        CREDENTIALS,
        'us-east-1',
      ),
    ).toBeNull();
  });

  it('checks the bucket by writing and reading back one object', async () => {
    const store = s3();
    store.probe();
    expect(await fake.list()).toContainEqual([`${store.config.prefix}/${PROBE_KEY}`, 69]);
    expect(() => s3({ accessKeyId: 'AKIDUNKNOWN' }).probe()).toThrow(
      /Cannot use s3:\/\/origin-frames\/t\d+ at http:\/\/127\.0\.0\.1:\d+ for sealed frames: .*403/,
    );
  });
});

describe('frame store contract: S3', () => {
  frameStoreContract(
    () => {
      const home = temp('contract');
      return { store: bucketFrameStore(home, s3()), home };
    },
    { detectsLoss: false },
  );
});

describe('a store with an S3 bucket', () => {
  const FRAME = 300;
  let home: string;
  let src: string;
  let db: Database;
  let objects: S3ObjectStore;
  const file = () => path.join(src, 'z.jsonl');
  const ctx = () => ({ db, home, frameBytes: FRAME });
  const lineN = (i: number) =>
    line(`z${i}`, 'z', 1000 + i, 'user', `line ${i} ${'·'.repeat(i % 9)}`);
  const write = (from: number, to: number) => {
    let text = '';
    for (let i = from; i < to; i++) text += lineN(i);
    fs.appendFileSync(file(), text);
  };
  const rawFileOf = () => getEvent(db, 'fake:z0')!.rawFileId;
  const mirrorBase = () => rawLocator(db, home, getEvent(db, 'fake:z0')!)!.mirrorPath;
  const mirrorName = () => path.relative(path.join(home, 'raw'), mirrorBase());
  const chunks = () =>
    db
      .prepare(
        'SELECT frame_offset, frame_length FROM raw_chunk WHERE raw_file_id = ? ORDER BY first_line',
      )
      .all(rawFileOf()) as unknown as Array<{ frame_offset: number; frame_length: number }>;
  const inBucket = async () =>
    (await fake.list())
      .filter(([k]) => k.startsWith(`${objects.config.prefix}/`) && !k.endsWith(PROBE_KEY))
      .map(([k, n]) => [k.slice(objects.config.prefix.length + 1), n]);
  /** Every line, read back as another process would, from the bucket and with nothing cached. */
  const expectIntact = (count: number) => {
    useObjectStore(db, home, objects, { cacheBytes: 0 });
    expect(mirrorText(db, home, rawFileOf())).toBe(fs.readFileSync(file(), 'utf8'));
    for (let i = 0; i < count; i++) {
      const e = getEvent(db, `fake:z${i}`)!;
      expect(readRawLine(db, home, rawLocator(db, home, e)!)).toBe(lineN(i).trim());
    }
    useObjectStore(db, home, objects);
  };

  beforeEach(() => {
    home = temp('home');
    src = temp('src');
    db = openDatabase(path.join(home, 'origin.db'));
    objects = s3();
  });
  afterEach(() => db.close());

  it('seals frames into the bucket and reads them back', async () => {
    useObjectStore(db, home, objects);
    for (let n = 0; n < 15; n += 3) {
      write(n, n + 3);
      await syncSource(ctx(), fakeAdapter(src));
    }
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(false);
    expect(await inBucket()).toEqual(
      chunks().map((c) => [frameKey(mirrorName(), c.frame_offset), c.frame_length]),
    );
    expectIntact(15);
  });

  it('seals the tails of files that stopped growing into the bucket', async () => {
    useObjectStore(db, home, objects);
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    expect(await inBucket()).toEqual([]);
    expect(sealIdleMirrors(db, home, { before: Date.now() + IDLE_SEAL_MS, remote: false })).toBe(1);
    expect(await inBucket()).toEqual([[frameKey(mirrorName(), 0), chunks()[0]?.frame_length]]);
    expect(fs.statSync(`${mirrorBase()}.tail`).size).toBe(0);
    expectIntact(2);
  });

  it('recovers from a crash after uploading a frame, before the transaction commits', async () => {
    useObjectStore(db, home, objects);
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    write(2, 8);
    const exec = db.exec.bind(db);
    db.exec = (s: string) => {
      if (s === 'COMMIT') throw new Error('simulated crash');
      return exec(s);
    };
    try {
      await expect(syncSource(ctx(), fakeAdapter(src))).rejects.toThrow('simulated crash');
    } finally {
      db.exec = exec;
    }
    // Uploaded, but nothing records it.
    const key = `${objects.config.prefix}/${frameKey(mirrorName(), 0)}`;
    const uncommitted = await fake.get(key);
    expect(uncommitted).not.toBeNull();
    expect(chunks()).toEqual([]);
    expect(getEvent(db, 'fake:z2')).toBeNull();
    // The next seal puts a different frame under the same key; no line is lost or doubled.
    write(8, 9);
    await syncSource({ db, home, frameBytes: FRAME / 2 }, fakeAdapter(src));
    const replaced = await fake.get(key);
    expect(replaced?.equals(uncommitted as Buffer)).toBe(false);
    expect(replaced?.length).toBe(chunks()[0]?.frame_length);
    expect(mirrorText(db, home, rawFileOf())).toBe(fs.readFileSync(file(), 'utf8'));
    expectIntact(9);
  });

  it('fails a seal it cannot upload, and seals again later', async () => {
    useObjectStore(db, home, objects);
    write(0, 2);
    await syncSource(ctx(), fakeAdapter(src));
    write(2, 8);
    await fake.fail(3, 503);
    await expect(syncSource(ctx(), fakeAdapter(src))).rejects.toThrow(ObjectStoreError);
    expect(getEvent(db, 'fake:z2')).toBeNull();
    await syncSource(ctx(), fakeAdapter(src));
    expectIntact(8);
  });

  it('moves the frames still on disk, verifies them, and removes them only when asked', async () => {
    write(0, 12);
    await syncSource(ctx(), fakeAdapter(src));
    const onDisk = fs.statSync(`${mirrorBase()}.zst`).size;
    useObjectStore(db, home, objects);
    write(12, 24);
    await syncSource(ctx(), fakeAdapter(src));
    const first = await uploadFrames(db, home);
    expect(first.uploaded).toBeGreaterThan(0);
    expect(first.removable).toEqual([{ mirror: mirrorName(), bytes: onDisk }]);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(true);
    expect(await inBucket()).toEqual(
      chunks().map((c) => [frameKey(mirrorName(), c.frame_offset), c.frame_length]),
    );
    const puts = (await fake.counts()).PUT;
    expect(await uploadFrames(db, home, { remove: true })).toMatchObject({
      uploaded: 0,
      removed: 1,
    });
    expect((await fake.counts()).PUT).toBe(puts);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(false);
    expectIntact(24);
  });

  it('uploads again a frame the bucket holds wrongly, before it may be removed', async () => {
    write(0, 12);
    await syncSource(ctx(), fakeAdapter(src));
    useObjectStore(db, home, objects);
    const key = `${objects.config.prefix}/${frameKey(mirrorName(), 0)}`;
    await fake.put(key, Buffer.from('not the frame'));
    expect((await uploadFrames(db, home)).uploaded).toBe(chunks().length);
    expect((await fake.get(key))?.length).toBe(chunks()[0]?.frame_length);
  });

  it('moves frames over several requests at once, never more than asked', async () => {
    write(0, 40);
    await syncSource(ctx(), fakeAdapter(src));
    const frames = chunks().length;
    expect(frames).toBeGreaterThan(8);
    useObjectStore(db, home, objects);
    await fake.delay(15);
    try {
      await fake.peak();
      const r = await uploadFrames(db, home, { concurrency: 4, remove: true });
      expect(await fake.peak()).toBe(4);
      expect(r).toMatchObject({ frames, uploaded: frames, removed: 1, failed: [], stopped: null });
    } finally {
      await fake.delay(0);
    }
    expect(await inBucket()).toEqual(
      chunks().map((c) => [frameKey(mirrorName(), c.frame_offset), c.frame_length]),
    );
    expectIntact(40);
  });

  it('stops when the bucket keeps failing, keeps the file, and goes on the next time', async () => {
    write(0, 12);
    await syncSource(ctx(), fakeAdapter(src));
    useObjectStore(db, home, objects);
    // Every try of the first request: it fails, and no other frame is started.
    await fake.fail(3, 503);
    const r = await uploadFrames(db, home, { concurrency: 1, remove: true });
    expect(r.stopped).toMatch(/503 SlowDown/);
    expect(r).toMatchObject({ frames: 0, uploaded: 0, removed: 0 });
    expect(r.failed).toEqual([
      { mirror: mirrorName(), key: frameKey(mirrorName(), 0), reason: r.stopped },
    ]);
    expect(fs.existsSync(`${mirrorBase()}.zst`)).toBe(true);
    const again = await uploadFrames(db, home, { remove: true });
    expect(again).toMatchObject({ uploaded: chunks().length, removed: 1, stopped: null });
    expectIntact(12);
  });

  it('backs up frames from the bucket', async () => {
    useObjectStore(db, home, objects);
    write(0, 20);
    await syncSource(ctx(), fakeAdapter(src));
    const target = path.join(temp('backup'), 'b');
    const r = await backupStore(db, home, target);
    const framesSize = chunks().reduce((n, c) => n + c.frame_length, 0);
    const tail = `${mirrorBase()}.tail`;
    expect(r.mirrorBytesCopied).toBe(
      framesSize + (fs.existsSync(tail) ? fs.statSync(tail).size : 0),
    );
    const copy = openDatabase(path.join(target, 'origin.db'));
    try {
      expect(frameBucket(copy)).toBeNull();
      expect(mirrorText(copy, target, rawFileOf())).toBe(fs.readFileSync(file(), 'utf8'));
    } finally {
      copy.close();
    }
  });
});

describe('bucket configuration', () => {
  const env = (vars: Record<string, string> = {}) => ({
    ORIGIN_RAW_S3_ENDPOINT: fake.endpoint.origin,
    ORIGIN_RAW_S3_BUCKET: BUCKET,
    ORIGIN_RAW_S3_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
    ORIGIN_RAW_S3_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
    ...vars,
  });

  it('is off unless an endpoint and a bucket are set', () => {
    expect(bucketConfig({}, {})).toBeNull();
    expect(() => bucketConfig({}, { ORIGIN_RAW_S3_REGION: 'eu-west-1' })).toThrow(
      /ORIGIN_RAW_S3_REGION is set, but no bucket is/,
    );
    expect(() => bucketConfig({}, { ORIGIN_RAW_S3_BUCKET: BUCKET })).toThrow(/needs both/);
  });

  it('reads flags first, then the environment, with defaults', () => {
    const config = bucketConfig(
      { 'raw-s3-bucket': 'other-bucket', 'raw-s3-prefix': '/hub/raw/' },
      env({ ORIGIN_RAW_S3_ADDRESSING: 'virtual' }),
    );
    expect(config).toMatchObject({
      bucket: 'other-bucket',
      prefix: 'hub/raw',
      region: 'us-east-1',
      addressing: 'virtual',
      timeoutMs: 30_000,
      ...CREDENTIALS,
    });
    expect(config?.endpoint.origin).toBe(fake.endpoint.origin);
  });

  it('reads credentials from files, as mounted from a Kubernetes Secret', () => {
    const dir = temp('secret');
    fs.writeFileSync(path.join(dir, 'id'), `${CREDENTIALS.accessKeyId}\n`);
    fs.writeFileSync(path.join(dir, 'secret'), `${CREDENTIALS.secretAccessKey}\n`);
    const config = bucketConfig(
      {},
      {
        ORIGIN_RAW_S3_ENDPOINT: 'https://minio.example.test',
        ORIGIN_RAW_S3_BUCKET: BUCKET,
        ORIGIN_RAW_S3_ACCESS_KEY_ID_FILE: path.join(dir, 'id'),
        ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'secret'),
      },
    );
    expect(config).toMatchObject(CREDENTIALS);
    expect(() =>
      bucketConfig({}, env({ ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'secret') })),
    ).toThrow(
      /Set ORIGIN_RAW_S3_SECRET_ACCESS_KEY or ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE, not both/,
    );
    expect(() =>
      bucketConfig(
        {},
        {
          ...env(),
          ORIGIN_RAW_S3_SECRET_ACCESS_KEY: '',
          ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'missing'),
        },
      ),
    ).toThrow(/Cannot read ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE .*ENOENT/);
  });

  it('refuses invalid settings, never showing a secret', () => {
    const messages: string[] = [];
    for (const vars of [
      { ORIGIN_RAW_S3_ENDPOINT: 'minio:9000' },
      { ORIGIN_RAW_S3_ENDPOINT: 'ftp://minio' },
      { ORIGIN_RAW_S3_ENDPOINT: 'http://user:pass@minio:9000' },
      { ORIGIN_RAW_S3_ENDPOINT: 'http://minio:9000/bucket' },
      { ORIGIN_RAW_S3_BUCKET: 'Not_A_Bucket' },
      { ORIGIN_RAW_S3_PREFIX: 'a/../b' },
      { ORIGIN_RAW_S3_ADDRESSING: 'dns' },
      { ORIGIN_RAW_S3_TIMEOUT_MS: '5' },
      { ORIGIN_RAW_S3_SECRET_ACCESS_KEY: '  ' },
    ]) {
      try {
        bucketConfig({}, env(vars));
        messages.push('(accepted)');
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(messages).not.toContain('(accepted)');
    for (const m of messages) expect(m).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it('serves with the bucket the store records, and only with it', async () => {
    const home = temp('serve');
    const db = openDatabase(path.join(home, 'origin.db'));
    try {
      expect(setUpFrames(db, home, { command: 'serve', env: {} })).toBeNull();
      expect(frameBucket(db)).toBeNull();
      const prefix = `serve${++prefixes}`;
      const objects = setUpFrames(db, home, {
        command: 'serve',
        flags: { 'raw-s3-prefix': prefix },
        env: env(),
      });
      stores.push(objects as S3ObjectStore);
      expect(frameBucket(db)).toBe(`s3://${BUCKET}/${prefix}`);
      expect(await fake.list()).toContainEqual([`${prefix}/${PROBE_KEY}`, 69]);
      // Without it, or with another, the hub refuses to start.
      expect(() => setUpFrames(db, home, { command: 'serve', env: {} })).toThrow(
        /keeps its sealed frames in s3:\/\/origin-frames\/serve\d+; configure that bucket/,
      );
      const puts = (await fake.counts()).PUT;
      expect(() =>
        setUpFrames(db, home, { command: 'serve', flags: { 'raw-s3-prefix': 'x' }, env: env() }),
      ).toThrow(/not s3:\/\/origin-frames\/x/);
      expect((await fake.counts()).PUT).toBe(puts); // refused before writing anything there
      expect(() => setUpFrames(db, home, { command: 'upload', env: {} })).toThrow(
        /configure that bucket/,
      );
    } finally {
      db.close();
    }
  });

  it('gives other commands the bucket from the environment, or a clear error', async () => {
    const home = temp('other');
    const src = temp('other-src');
    const db = openDatabase(path.join(home, 'origin.db'));
    try {
      // A store without a bucket ignores the environment.
      expect(setUpFrames(db, home, { command: 'other', env: env() })).toBeNull();
      expect(frameBucket(db)).toBeNull();
      const prefix = `other${++prefixes}`;
      const objects = setUpFrames(db, home, {
        command: 'serve',
        flags: { 'raw-s3-prefix': prefix },
        env: env(),
      }) as S3ObjectStore;
      stores.push(objects);
      fs.writeFileSync(
        path.join(src, 'a.jsonl'),
        Array.from({ length: 30 }, (_, i) => line(`a${i}`, 's', i, 'user', `line ${i}`)).join(''),
      );
      await syncSource({ db, home, frameBytes: 300 }, fakeAdapter(src));
      const e = getEvent(db, 'fake:a1')!;
      // A command run where the bucket is configured reads from it.
      releaseObjectStore(home);
      const again = setUpFrames(db, home, {
        command: 'other',
        env: env({ ORIGIN_RAW_S3_PREFIX: prefix }),
      });
      stores.push(again as S3ObjectStore);
      expect(readRawLine(db, home, rawLocator(db, home, e)!)).toContain('line 1');
      // Where it is not, reading a frame says what to set.
      setUpFrames(db, home, { command: 'other', env: {} });
      expect(() => readRawLine(db, home, rawLocator(db, home, e)!)).toThrow(
        /keeps its sealed frames in s3:\/\/origin-frames\/other\d+; set ORIGIN_RAW_S3_ENDPOINT/,
      );
    } finally {
      db.close();
    }
  });
});

describe('a hub with an S3 bucket', () => {
  const fixtures = fileURLToPath(
    new URL('../../adapters/test/fixtures/claude-code/', import.meta.url),
  );
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  it("keeps the sealed frames of devices' mirrors in the bucket", async () => {
    const hubHome = temp('hub');
    const deviceHome = temp('device');
    const hubDb = openDatabase(path.join(hubHome, 'origin.db'));
    const deviceDb = openDatabase(path.join(deviceHome, 'origin.db'));
    try {
      const objects = s3();
      useObjectStore(hubDb, hubHome, objects);
      const token = createToken(hubDb, 'laptop');
      server = createHubServer({
        db: hubDb,
        home: hubHome,
        adapters: [createClaudeCodeAdapter({ projectsDir: path.join(hubHome, 'unused') })],
        version: 'test',
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const hub = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        token,
        device: 'laptop',
      };
      await syncSource(
        { db: deviceDb, home: deviceHome },
        createClaudeCodeAdapter({ projectsDir: fixtures }),
      );
      expect(await syncWithHub({ db: deviceDb, home: deviceHome, hub })).toMatchObject({
        files: 1,
        eventsAdded: 6,
      });
      // The hub's check for files that stopped growing seals the device's tail into the bucket.
      expect(
        sealIdleMirrors(hubDb, hubHome, { before: Date.now() + IDLE_SEAL_MS, remote: true }),
      ).toBe(1);
      const keys = (await fake.list()).map(([k]) => k);
      expect(
        keys.filter((k) => k.startsWith(`${objects.config.prefix}/devices/laptop/`)),
      ).toHaveLength(1);
      expect(fs.readdirSync(path.join(hubHome, 'raw'), { recursive: true })).not.toContainEqual(
        expect.stringMatching(/\.zst$/),
      );
      const id = 'claude-code:22222222-2222-4222-8222-222222222222';
      const onHub = getEvent(hubDb, id)!;
      useObjectStore(hubDb, hubHome, objects, { cacheBytes: 0 });
      expect(readRawLine(hubDb, hubHome, rawLocator(hubDb, hubHome, onHub)!)).toBe(
        readRawLine(
          deviceDb,
          deviceHome,
          rawLocator(deviceDb, deviceHome, getEvent(deviceDb, id)!)!,
        ),
      );
    } finally {
      hubDb.close();
      deviceDb.close();
    }
  });

  it('reads the frames in its bucket when an upgrade parses mirrored lines again', async () => {
    const hubHome = temp('upgrade');
    const hubFile = path.join(hubHome, 'origin.db');
    const hubDb = openDatabase(hubFile);
    const objects = s3();
    useObjectStore(hubDb, hubHome, objects);
    const adapters = [createClaudeCodeAdapter({ projectsDir: path.join(hubHome, 'unused') })];
    const content = fs.readFileSync(
      path.join(fixtures, 'D--demo-project/0f1e2d3c-4b5a-4697-8877-665544332211.jsonl'),
    );
    appendRemote({ db: hubDb, home: hubHome, frameBytes: 300 }, adapters[0]!, {
      device: 'laptop',
      source: 'claude-code',
      path: '/home/me/.claude/projects/D--demo-project/0f1e2d3c-4b5a-4697-8877-665544332211.jsonl',
      relPath: 'D--demo-project/0f1e2d3c-4b5a-4697-8877-665544332211.jsonl',
      generation: 1,
      offset: 0,
      data: content,
    });
    sealIdleMirrors(hubDb, hubHome, { before: Date.now() + IDLE_SEAL_MS, remote: true });
    hubDb.close();
    releaseObjectStore(hubHome);
    // Every line, the summary line that titles the session included, is in the bucket only.
    expect(fs.readdirSync(path.join(hubHome, 'raw'), { recursive: true })).not.toContainEqual(
      expect.stringMatching(/\.zst$/),
    );
    downgradeToV1(hubFile);

    const env = {
      ORIGIN_RAW_S3_ENDPOINT: fake.endpoint.origin,
      ORIGIN_RAW_S3_BUCKET: BUCKET,
      ORIGIN_RAW_S3_PREFIX: objects.config.prefix,
      ORIGIN_RAW_S3_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
      ORIGIN_RAW_S3_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
    };
    const open = (vars: Record<string, string>) =>
      openDatabase(hubFile, {
        adapters,
        beforeMigrate: (db) => {
          const store = setUpFrames(db, hubHome, { command: 'other', env: vars });
          if (store) stores.push(store);
        },
      });
    // Without the bucket, the migration cannot read the lines, says what to set, and waits.
    expect(() => open({})).toThrow(
      /upgraded to version 3 .*keeps its sealed frames in s3:\/\/origin-frames\/.*ORIGIN_RAW_S3_ENDPOINT/,
    );
    const upgraded = open(env);
    expect(listSessions(upgraded)).toMatchObject([{ title: 'Check repository status' }]);
    upgraded.close();
  });
});

describe('bucket flags', () => {
  it('are read from the arguments of serve and raw upload, and of no other command', () => {
    const args = ['--port', '7077', '--raw-s3-bucket', 'frames', '--admin', '--raw-s3-prefix=hub'];
    expect(bucketFlags('serve', args)).toEqual({
      'raw-s3-bucket': 'frames',
      'raw-s3-prefix': 'hub',
    });
    expect(bucketFlags('raw', ['upload', '--raw-s3-endpoint', 'http://minio:9000'])).toEqual({
      'raw-s3-endpoint': 'http://minio:9000',
    });
    expect(bucketFlags('status', args)).toEqual({});
  });
});
