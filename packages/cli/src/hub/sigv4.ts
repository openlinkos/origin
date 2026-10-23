import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for requests with the Authorization header, as S3 and S3-compatible
 * stores such as MinIO check it. Pure functions of their input: verified against AWS's published
 * test vectors (see test/s3.test.ts), with no network.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Request {
  method: string;
  /** The path as sent, each segment already URI-encoded (see uriEncode), starting with `/`. */
  path: string;
  /** Query parameters, unencoded; empty for S3 object requests. */
  query?: Array<[string, string]>;
  /** Headers to sign, `host` among them; names in any case. */
  headers: Record<string, string>;
  /** The hex SHA-256 of the body (of nothing, for a request without one). */
  payloadHash: string;
}

export interface SigV4Scope {
  region: string;
  service: string;
  /** `YYYYMMDD'T'HHMMSS'Z'`, as in the request's `x-amz-date` header. */
  amzDate: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `YYYYMMDD'T'HHMMSS'Z'` of a time. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * URI-encode as SigV4 needs: every byte of the UTF-8 encoding except the unreserved characters
 * `A-Z a-z 0-9 - _ . ~` as `%XX` with upper-case hex digits.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical request, and the names of the signed headers. */
export function canonicalRequest(req: SigV4Request): { canonical: string; signedHeaders: string } {
  const headers = Object.entries(req.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const query = (req.query ?? [])
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    req.method,
    req.path,
    query,
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    req.payloadHash,
  ].join('\n');
  return { canonical, signedHeaders };
}

/** The string to sign for a canonical request. */
export function stringToSign(scope: SigV4Scope, canonical: string): string {
  return [
    'AWS4-HMAC-SHA256',
    scope.amzDate,
    `${scope.amzDate.slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`,
    sha256Hex(canonical),
  ].join('\n');
}

const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** The value of the Authorization header for a request. */
export function authorization(
  req: SigV4Request,
  credentials: SigV4Credentials,
  scope: SigV4Scope,
): string {
  const { canonical, signedHeaders } = canonicalRequest(req);
  const day = scope.amzDate.slice(0, 8);
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  key = hmac(key, scope.region);
  key = hmac(key, scope.service);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign(scope, canonical)).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${day}/${scope.region}/${scope.service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
