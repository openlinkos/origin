// A fake S3 server for tests: node:http in a worker thread (the thread under test blocks while it
// waits for a response, so the server cannot share it), objects in memory, and every request
// checked for the shape the hub sends: a path-style or virtual-hosted URL, the payload hash, the
// Content-MD5 of a PUT, and an AWS Signature Version 4 that this file computes on its own.
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * Check a request's Authorization header against the secret, as S3 does. `path` and `query` are as
 * received (already encoded), `headers` with lower-case names. Returns null, or what is wrong.
 */
export function verifySignature({ method, path, query, headers, body }, credentials, region) {
  const auth = headers.authorization ?? '';
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!m) return 'malformed Authorization header';
  const [, accessKeyId, day, scopeRegion, signedHeaders, signature] = m;
  if (accessKeyId !== credentials.accessKeyId) return 'unknown access key';
  if (scopeRegion !== region) return `wrong region ${scopeRegion}`;
  const date = headers['x-amz-date'] ?? '';
  if (!/^\d{8}T\d{6}Z$/.test(date) || date.slice(0, 8) !== day) return 'bad x-amz-date';
  const payloadHash = headers['x-amz-content-sha256'];
  if (payloadHash !== sha256(body)) return 'x-amz-content-sha256 does not match the body';
  const names = signedHeaders.split(';');
  for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) {
    if (!names.includes(required)) return `${required} is not signed`;
  }
  if (body.length > 0 && !names.includes('content-md5')) return 'content-md5 is not signed';
  const canonicalQuery = [...new URLSearchParams(query)]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    method,
    path,
    canonicalQuery,
    ...names.map((n) => `${n}:${String(headers[n] ?? '').trim()}`),
    '',
    signedHeaders,
    payloadHash,
  ].join('\n');
  const toSign = [
    'AWS4-HMAC-SHA256',
    date,
    `${day}/${region}/s3/aws4_request`,
    sha256(canonical),
  ].join('\n');
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  key = hmac(hmac(hmac(key, region), 's3'), 'aws4_request');
  const expected = createHmac('sha256', key).update(toSign).digest('hex');
  return expected === signature ? null : 'signature does not match';
}

function errorXml(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

function serve({ bucket, credentials, region }) {
  const objects = new Map();
  const counts = { PUT: 0, GET: 0, other: 0 };
  const failures = [];
  let delayMs = 0;
  let lastRejection = null;
  // Requests being answered, and the most at once since `peak` was last asked.
  let inFlight = 0;
  let peak = 0;

  const server = http.createServer((req, res) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    res.on('close', () => inFlight--);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, payload, headers = {}) => {
        const write = () => {
          res.writeHead(status, { 'Content-Length': payload.length, ...headers });
          res.end(payload);
        };
        if (delayMs > 0) setTimeout(write, delayMs);
        else write();
      };
      const reject = (status, code, message) => {
        lastRejection = `${code}: ${message}`;
        send(status, Buffer.from(errorXml(code, message)), { 'Content-Type': 'application/xml' });
      };
      counts[req.method === 'PUT' || req.method === 'GET' ? req.method : 'other']++;
      const failure = failures.shift();
      if (failure) return reject(failure, 'SlowDown', 'Please reduce your request rate.');

      const [rawPath, query = ''] = (req.url ?? '/').split('?');
      const host = req.headers.host ?? '';
      // Path style: /<bucket>/<key>; virtual-hosted: Host <bucket>.<host>, path /<key>.
      let target = '';
      let rawKey = '';
      if (host.startsWith(`${bucket}.`)) {
        target = bucket;
        rawKey = rawPath.slice(1);
      } else {
        const slash = rawPath.indexOf('/', 1);
        target = decodeURIComponent(rawPath.slice(1, slash < 0 ? undefined : slash));
        rawKey = slash < 0 ? '' : rawPath.slice(slash + 1);
      }
      const problem = verifySignature(
        { method: req.method, path: rawPath, query, headers: req.headers, body },
        credentials,
        region,
      );
      if (problem) return reject(403, 'SignatureDoesNotMatch', problem);
      if (target !== bucket) return reject(404, 'NoSuchBucket', 'The bucket does not exist.');
      const key = rawKey.split('/').map(decodeURIComponent).join('/');
      if (!key) return reject(400, 'InvalidRequest', 'No key.');
      if (req.method === 'PUT') {
        const md5 = createHash('md5').update(body).digest('base64');
        if (req.headers['content-md5'] !== md5) return reject(400, 'BadDigest', 'Content-MD5');
        objects.set(key, body);
        return send(200, Buffer.alloc(0), {
          ETag: `"${createHash('md5').update(body).digest('hex')}"`,
        });
      }
      if (req.method === 'GET') {
        const data = objects.get(key);
        if (!data) return reject(404, 'NoSuchKey', 'The specified key does not exist.');
        return send(200, data, { 'Content-Type': 'application/octet-stream' });
      }
      return reject(405, 'MethodNotAllowed', req.method);
    });
  });

  parentPort.on('message', ({ id, op, ...args }) => {
    let reply = null;
    if (op === 'list') reply = [...objects].map(([k, v]) => [k, v.length]).sort();
    else if (op === 'get') reply = objects.get(args.key) ?? null;
    else if (op === 'put') objects.set(args.key, Buffer.from(args.data));
    else if (op === 'fail') failures.push(...Array(args.count).fill(args.status));
    else if (op === 'delay') delayMs = args.ms;
    else if (op === 'counts') reply = { ...counts };
    else if (op === 'peak') {
      reply = peak;
      peak = inFlight;
    } else if (op === 'rejection') reply = lastRejection;
    else if (op === 'close') {
      server.closeAllConnections();
      server.close(() => parentPort.postMessage({ id, reply: null }));
      return;
    }
    parentPort.postMessage({ id, reply });
  });
  server.listen(0, '127.0.0.1', () => parentPort.postMessage({ ready: server.address().port }));
}

if (!isMainThread && workerData?.fakeS3) serve(workerData.fakeS3);
