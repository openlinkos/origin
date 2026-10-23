import fs from 'node:fs';
import {
  type Database,
  frameBucket,
  type ObjectStore,
  OriginError,
  useObjectStore,
} from '@openlinkos/origin-core';
import { bucketLocation, ObjectStoreError, type S3Config, S3ObjectStore } from './s3.js';

/**
 * Where a hub keeps the sealed frames of its raw mirrors (see docs/guide/hub.md): on its disk, or
 * in an S3-compatible bucket configured with flags of `origin serve` and `origin raw upload`, or
 * the environment. Secrets come only from the environment, or from files it names (`*_FILE`, for
 * Kubernetes Secrets), never from flags, and never appear in a message.
 */

/** The flags of `origin serve` and `origin raw upload`, for parseArgs. */
export const BUCKET_OPTIONS = {
  'raw-s3-endpoint': { type: 'string' },
  'raw-s3-bucket': { type: 'string' },
  'raw-s3-prefix': { type: 'string' },
  'raw-s3-region': { type: 'string' },
  'raw-s3-addressing': { type: 'string' },
} as const;

export type BucketFlags = { [K in keyof typeof BUCKET_OPTIONS]?: string };

type Env = Record<string, string | undefined>;

/** The environment variable of each setting, next to its flag. */
const ENV = {
  endpoint: 'ORIGIN_RAW_S3_ENDPOINT',
  bucket: 'ORIGIN_RAW_S3_BUCKET',
  prefix: 'ORIGIN_RAW_S3_PREFIX',
  region: 'ORIGIN_RAW_S3_REGION',
  addressing: 'ORIGIN_RAW_S3_ADDRESSING',
  accessKeyId: 'ORIGIN_RAW_S3_ACCESS_KEY_ID',
  secretAccessKey: 'ORIGIN_RAW_S3_SECRET_ACCESS_KEY',
  timeoutMs: 'ORIGIN_RAW_S3_TIMEOUT_MS',
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;

/** Bucket names as S3 allows them (lower case, digits, dots, and hyphens; 3 to 63 characters). */
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * The bucket configured by flags and the environment (flags first), or null if there is none.
 * Throws an OriginError for an incomplete or invalid configuration.
 */
export function bucketConfig(flags: BucketFlags, env: Env): S3Config | null {
  const value = (flag: keyof BucketFlags, name: string) => {
    const v = (flags[flag] ?? env[name])?.trim();
    return v ? v : undefined;
  };
  const endpoint = value('raw-s3-endpoint', ENV.endpoint);
  const bucket = value('raw-s3-bucket', ENV.bucket);
  if (endpoint === undefined && bucket === undefined) {
    const stray = Object.values(ENV).find((name) => env[name] || env[`${name}_FILE`]);
    if (stray) {
      throw new OriginError(
        `${stray} is set, but no bucket is: set ${ENV.endpoint} and ${ENV.bucket} too, or unset it.`,
      );
    }
    return null;
  }
  if (endpoint === undefined || bucket === undefined) {
    throw new OriginError(
      `A bucket for sealed frames needs both ${ENV.endpoint} (--raw-s3-endpoint) and ${ENV.bucket} (--raw-s3-bucket).`,
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OriginError(`${ENV.endpoint} must be a URL such as http://minio:9000.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginError(`${ENV.endpoint} must be an http or https URL.`);
  }
  if (url.username || url.password) {
    throw new OriginError(
      `${ENV.endpoint} must not hold credentials; set ${ENV.accessKeyId} and ${ENV.secretAccessKey} instead.`,
    );
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new OriginError(
      `${ENV.endpoint} must be the store's address alone, such as http://minio:9000; put the bucket in ${ENV.bucket} and the path in ${ENV.prefix}.`,
    );
  }
  if (!BUCKET_RE.test(bucket)) throw new OriginError(`Invalid bucket name "${bucket}".`);
  const prefix = (value('raw-s3-prefix', ENV.prefix) ?? '').replace(/^\/+|\/+$/g, '');
  if (prefix !== '' && prefix.split('/').some((s) => !segmentOk(s))) {
    throw new OriginError(
      `Invalid ${ENV.prefix} "${prefix}": use segments separated by single slashes, without "." or "..".`,
    );
  }
  const addressing = value('raw-s3-addressing', ENV.addressing) ?? 'path';
  if (addressing !== 'path' && addressing !== 'virtual') {
    throw new OriginError(`${ENV.addressing} must be "path" or "virtual", not "${addressing}".`);
  }
  const timeout = env[ENV.timeoutMs]?.trim();
  const timeoutMs = timeout ? Number(timeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new OriginError(
      `${ENV.timeoutMs} must be a number of milliseconds from 1000 to 600000, not "${timeout}".`,
    );
  }
  return {
    endpoint: url,
    bucket,
    prefix,
    region: value('raw-s3-region', ENV.region) ?? 'us-east-1',
    accessKeyId: secret(env, ENV.accessKeyId),
    secretAccessKey: secret(env, ENV.secretAccessKey),
    addressing,
    timeoutMs,
  };
}

function segmentOk(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..';
}

/** A credential from `name`, or from the file `name_FILE` names. Its value is never shown. */
function secret(env: Env, name: string): string {
  const direct = env[name];
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) throw new OriginError(`Set ${name} or ${name}_FILE, not both.`);
  let value = direct;
  if (file) {
    try {
      value = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new OriginError(
        `Cannot read ${name}_FILE (${file}): ${(err as NodeJS.ErrnoException).code ?? 'error'}.`,
      );
    }
  }
  value = value?.trim();
  if (!value) {
    throw new OriginError(`A bucket for sealed frames needs ${name} (or ${name}_FILE).`);
  }
  return value;
}

/** Stands in for a store's bucket in a process that was not given it: every use fails clearly. */
function unconfigured(location: string): ObjectStore {
  const fail = (): never => {
    throw new ObjectStoreError(
      `This store keeps its sealed frames in ${location}; set ${ENV.endpoint}, ${ENV.bucket}, and its credentials to reach them.`,
    );
  };
  return { location, put: fail, get: fail };
}

/**
 * Set up where the store at `home` keeps its sealed frames, in this process:
 *
 * - `serve` and `upload` (`origin serve`, `origin raw upload`) take the bucket from flags and the
 *   environment, check it by writing and reading back one small object, and refuse to go on
 *   without the bucket the store records. Without either, `serve` keeps frames on disk.
 * - Any other command takes the bucket from the environment only if the store records one; if it
 *   is not configured, frames in the bucket cannot be read, and sealing fails, with a message that
 *   says so.
 *
 * Returns the bucket, or null when frames stay on disk.
 */
export function setUpFrames(
  db: Database,
  home: string,
  opts: { command: 'serve' | 'upload' | 'other'; flags?: BucketFlags; env: Env },
): S3ObjectStore | null {
  const recorded = frameBucket(db);
  if (opts.command === 'other' && recorded === null) return null;
  const config = bucketConfig(opts.command === 'other' ? {} : (opts.flags ?? {}), opts.env);
  if (!config) {
    if (recorded !== null && opts.command !== 'other') {
      throw new OriginError(
        `This store keeps its sealed frames in ${recorded}; configure that bucket with ${ENV.endpoint}, ${ENV.bucket}, ${ENV.prefix}, and its credentials.`,
      );
    }
    if (opts.command === 'upload') {
      throw new OriginError(
        `No bucket is configured: set ${ENV.endpoint}, ${ENV.bucket}, and its credentials.`,
      );
    }
    if (recorded !== null) useObjectStore(db, home, unconfigured(recorded));
    return null;
  }
  const location = bucketLocation(config.bucket, config.prefix);
  if (recorded !== null && recorded !== location) {
    throw new OriginError(
      `This store keeps its sealed frames in ${recorded}, not ${location}; configure that bucket.`,
    );
  }
  const objects = new S3ObjectStore(config);
  if (opts.command !== 'other') objects.probe();
  useObjectStore(db, home, objects);
  return objects;
}
