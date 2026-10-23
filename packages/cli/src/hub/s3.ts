import { createHash } from 'node:crypto';
import type { ObjectStore } from '@openlinkos/origin-core';
import { amzDate, authorization, EMPTY_SHA256, sha256Hex, uriEncode } from './sigv4.js';
import { type HttpClient, SyncHttp, SyncHttpError, type SyncResponse } from './sync-http.js';

/**
 * An S3-compatible bucket (MinIO, or any store that speaks the S3 API) as the object store of a
 * hub's sealed frames (see docs/guide/hub.md#keep-raw-mirrors-in-a-bucket). Requests are signed
 * with AWS Signature Version 4 and sent synchronously (see sync-http.ts); only PUT and GET of
 * single objects are used, and objects are never deleted.
 */

export interface S3Config {
  /** `http(s)://host[:port]`, without a path. */
  endpoint: URL;
  bucket: string;
  /** Prepended to every key with a `/`; empty for none. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `path`: `<endpoint>/<bucket>/<key>` (MinIO's default); `virtual`: `<bucket>.<host>/<key>`. */
  addressing: 'path' | 'virtual';
  /** How long one request may take. */
  timeoutMs: number;
}

/**
 * A request to the bucket that failed. Not an OriginError: a frame that could not be reached must
 * never be taken for a frame that is missing.
 */
export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

/** The location a store records for a bucket and prefix (see useObjectStore). */
export function bucketLocation(bucket: string, prefix: string): string {
  return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
}

/** Statuses worth one more try: the store is busy or briefly unavailable. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The key the hub writes and reads back when it starts, to check the bucket and its credentials. */
export const PROBE_KEY = '.origin-check';
const PROBE_BODY = Buffer.from(
  'Origin keeps the sealed frames of its raw mirrors under this prefix.\n',
);

export class S3ObjectStore implements ObjectStore {
  readonly location: string;
  private readonly http: HttpClient;
  private readonly now: () => Date;
  private readonly retryDelaysMs: number[];

  constructor(
    readonly config: S3Config,
    opts: { http?: HttpClient; now?: () => Date; retryDelaysMs?: number[] } = {},
  ) {
    this.location = bucketLocation(config.bucket, config.prefix);
    this.http = opts.http ?? new SyncHttp(config.timeoutMs);
    this.now = opts.now ?? (() => new Date());
    this.retryDelaysMs = opts.retryDelaysMs ?? [200, 1000];
  }

  put(key: string, data: Buffer): void {
    const res = this.send('PUT', key, data);
    if (res.status !== 200) throw this.failure('PUT', key, res);
  }

  get(key: string): Buffer | null {
    const res = this.send('GET', key);
    if (res.status === 200) return res.body;
    // A missing object is null; a missing bucket is an error, never a missing frame.
    if (res.status === 404 && errorCode(res) !== 'NoSuchBucket') return null;
    throw this.failure('GET', key, res);
  }

  /** Write a small object and read it back: the bucket exists and the credentials may do both. */
  probe(): void {
    try {
      this.put(PROBE_KEY, PROBE_BODY);
      const back = this.get(PROBE_KEY);
      if (!back?.equals(PROBE_BODY)) {
        throw new ObjectStoreError(`${this.location} did not return what was written to it.`);
      }
    } catch (err) {
      throw new ObjectStoreError(
        `Cannot use ${this.location} at ${this.config.endpoint.origin} for sealed frames: ${(err as Error).message}`,
      );
    }
  }

  close(): void {
    this.http.close();
  }

  /** Send a signed request, trying again while the store is briefly unavailable. */
  private send(method: 'PUT' | 'GET', key: string, body?: Buffer): SyncResponse {
    for (let attempt = 0; ; attempt++) {
      const delay = this.retryDelaysMs[attempt];
      let res: SyncResponse;
      try {
        res = this.http.request(this.sign(method, key, body));
      } catch (err) {
        // A timeout has waited long enough already; other network errors get another try.
        const timedOut = err instanceof SyncHttpError && err.timedOut;
        if (timedOut || delay === undefined) {
          throw new ObjectStoreError(
            `S3 ${method} ${this.location}/${key} failed: ${(err as Error).message}`,
          );
        }
        sleep(delay);
        continue;
      }
      if (!RETRY_STATUSES.has(res.status) || delay === undefined) return res;
      sleep(delay);
    }
  }

  private sign(method: 'PUT' | 'GET', key: string, body?: Buffer) {
    const { endpoint, bucket, prefix, addressing } = this.config;
    const fullKey = prefix ? `${prefix}/${key}` : key;
    const encodedKey = fullKey.split('/').map(uriEncode).join('/');
    const host = addressing === 'virtual' ? `${bucket}.${endpoint.host}` : endpoint.host;
    const path = addressing === 'virtual' ? `/${encodedKey}` : `/${bucket}/${encodedKey}`;
    const date = amzDate(this.now());
    const headers: Record<string, string> = {
      host,
      'x-amz-date': date,
      'x-amz-content-sha256': body ? sha256Hex(body) : EMPTY_SHA256,
    };
    if (body) headers['content-md5'] = createHash('md5').update(body).digest('base64');
    const auth = authorization(
      { method, path, headers, payloadHash: headers['x-amz-content-sha256'] as string },
      { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      { region: this.config.region, service: 's3', amzDate: date },
    );
    // fetch sets Host from the URL itself, the same value as signed.
    const { host: _host, ...sent } = headers;
    return {
      method,
      url: `${endpoint.protocol}//${host}${path}`,
      headers: { ...sent, authorization: auth },
      body,
    };
  }

  private failure(method: string, key: string, res: SyncResponse): ObjectStoreError {
    const code = errorCode(res);
    const message = /<Message>([^<]*)<\/Message>/.exec(res.body.toString('utf8'))?.[1];
    return new ObjectStoreError(
      `S3 ${method} ${this.location}/${key} failed: ${res.status}${code ? ` ${code}` : ''}${message ? ` (${message})` : ''}`,
    );
  }
}

/** The `<Code>` of an S3 error response, if any. Nothing else of the body is ever shown. */
function errorCode(res: SyncResponse): string | null {
  return /<Code>([^<]*)<\/Code>/.exec(res.body.toString('utf8'))?.[1] ?? null;
}

function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
