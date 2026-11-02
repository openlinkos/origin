import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { ClientResolver } from '@openlinkos/origin-admin';
import {
  type Database,
  getClient,
  type OAuthClient,
  OAuthError,
  saveClientDocument,
} from '@openlinkos/origin-core';

/**
 * Client ID metadata documents (draft-ietf-oauth-client-id-metadata-document): an MCP client such
 * as Codex names itself by the https URL of a JSON document that says its name and redirect URIs,
 * and the hub fetches it before the owner is asked (see docs/architecture.md#access). Fetching an
 * address an unknown client gave is a server-side request: so only https, only public addresses
 * (checked on every address the name resolves to, and connected to as checked, so that DNS cannot
 * point elsewhere in between), a few redirects to the same kind of address, a short timeout, a small
 * body, and a cache in the store that honours the document's Cache-Control within bounds.
 */
export interface ClientMetadataOptions {
  /** The whole fetch, redirects included (default 5 s). */
  timeoutMs?: number;
  /** The largest document (default 5 KiB, as the draft suggests). */
  maxBytes?: number;
  maxRedirects?: number;
  /** Accept loopback and private addresses: tests only. */
  allowPrivate?: boolean;
  /** Certificates to trust besides the system's: tests only. */
  ca?: string | Buffer;
  userAgent?: string;
  now?: () => number;
}

const TIMEOUT_MS = 5000;
const MAX_BYTES = 5 * 1024;
const MAX_REDIRECTS = 3;
/** A document is kept at least this long (the consent page reads it twice), and at most a day. */
const MIN_CACHE_MS = 5 * 60_000;
const MAX_CACHE_MS = 86_400_000;
const DEFAULT_CACHE_MS = 3_600_000;

/**
 * Addresses that are not on the public internet: loopback, private, link-local, shared (CGNAT,
 * which overlay networks such as Tailscale use), documentation, multicast, and reserved. Not the
 * benchmarking ranges (198.18.0.0/15, 2001:2::/48): proxies with fake-IP DNS (Clash, sing-box, and
 * the like) answer every name with one of them, and connect to the real address themselves.
 */
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(address, prefix, 'ipv6');
}

/** The IPv4 address of a NAT64 address in 64:ff9b::/96, or null. */
function embeddedIpv4(address: string): string | null {
  const nat = new net.BlockList();
  nat.addSubnet('64:ff9b::', 96, 'ipv6');
  if (!nat.check(address, 'ipv6')) return null;
  const sa = new net.SocketAddress({ address, family: 'ipv6' });
  const groups = expandIpv6(sa.address);
  const hi = Number.parseInt(groups[6] ?? '0', 16);
  const lo = Number.parseInt(groups[7] ?? '0', 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** The eight groups of an IPv6 address, `::` expanded. */
function expandIpv6(address: string): string[] {
  const [head = '', tail = ''] = address.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  if (b.length > 0 && b[b.length - 1]?.includes('.')) {
    const [x = 0, y = 0, z = 0, w = 0] = (b.pop() as string).split('.').map(Number);
    b.push(((x << 8) | y).toString(16), ((z << 8) | w).toString(16));
  }
  if (!address.includes('::')) return a;
  return [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
}

/** Whether an address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return !BLOCKED.check(mapped, 'ipv4');
    // NAT64 (RFC 6052): an IPv4 address in the last 32 bits, which is what counts.
    const nat64 = embeddedIpv4(address);
    if (nat64) return !BLOCKED.check(nat64, 'ipv4');
    return !BLOCKED.check(address, 'ipv6');
  }
  return !BLOCKED.check(address, 'ipv4');
}

/**
 * A `lookup` for the connection that resolves the name once, refuses it unless every address is
 * public, and hands the connection the addresses it checked.
 */
function checkedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0 || (!allowPrivate && list.some((a) => !isPublicAddress(a.address)))) {
        const refused = Object.assign(new Error(`${hostname} is not a public address`), {
          code: 'EADDRNOTPUBLIC',
        });
        return callback(refused, '', 0);
      }
      if ((options as dns.LookupOptions).all) {
        return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      }
      const first = list[0] as dns.LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

/** How long to keep a document, from its Cache-Control, within bounds. */
export function cacheMs(cacheControl: string | undefined): number {
  const directives = (cacheControl ?? '').toLowerCase();
  if (/(^|,)\s*(no-store|no-cache)\s*(,|$)/.test(directives)) return MIN_CACHE_MS;
  const age = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/.exec(directives)?.[1];
  const ms = age === undefined ? DEFAULT_CACHE_MS : Number(age) * 1000;
  return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, ms));
}

class FetchError extends Error {}

/** GET a document over https, by the rules above; its body and how long to keep it. */
export async function fetchClientDocument(
  url: string,
  opts: ClientMetadataOptions = {},
): Promise<{ body: string; maxAgeMs: number }> {
  const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS);
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:') throw new FetchError('only https addresses are fetched');
    const r = await get(current, deadline, maxBytes, opts);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (hop >= (opts.maxRedirects ?? MAX_REDIRECTS)) throw new FetchError('too many redirects');
      current = new URL(r.location, current);
      continue;
    }
    if (r.status !== 200) throw new FetchError(`it answered ${r.status}`);
    return { body: r.body, maxAgeMs: cacheMs(r.cacheControl) };
  }
}

function get(
  url: URL,
  deadline: number,
  maxBytes: number,
  opts: ClientMetadataOptions,
): Promise<{ status: number; location?: string; cacheControl?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError('it took too long'));
    const req = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: checkedLookup(opts.allowPrivate === true),
        ca: opts.ca,
        headers: {
          Accept: 'application/json',
          'User-Agent': opts.userAgent ?? 'Origin hub (client metadata)',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          resolve({ status, location: res.headers.location, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(new FetchError(`the document is larger than ${maxBytes} bytes`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (size > maxBytes) return;
          resolve({
            status,
            cacheControl: res.headers['cache-control'],
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new FetchError('it took too long')), remaining);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/**
 * The CLI's ClientResolver for the hub: the store's copy of a client's metadata document while it
 * is fresh, else the document fetched again, checked by core (its `client_id` must be its URL, and
 * so on), and kept. A fetch already under way for the same id is shared.
 */
export function createClientResolver(
  db: Database,
  opts: ClientMetadataOptions = {},
): ClientResolver {
  const now = opts.now ?? Date.now;
  const pending = new Map<string, Promise<OAuthClient>>();
  return (clientId) => {
    const cached = getClient(db, clientId);
    if (cached?.document && cached.expiresAt !== null && cached.expiresAt > now()) {
      return Promise.resolve(cached);
    }
    const inFlight = pending.get(clientId);
    if (inFlight) return inFlight;
    const fetching = (async () => {
      let fetched: { body: string; maxAgeMs: number };
      try {
        fetched = await fetchClientDocument(clientId, opts);
      } catch (err) {
        const reason =
          err instanceof FetchError
            ? err.message
            : (err as { code?: string }).code === 'EADDRNOTPUBLIC'
              ? 'it is not on a public address'
              : (err as Error).message;
        throw new OAuthError(
          'invalid_client',
          `Could not read the app's description at ${clientId}: ${reason}.`,
        );
      }
      let doc: unknown;
      try {
        doc = JSON.parse(fetched.body);
      } catch {
        throw new OAuthError('invalid_client', `The app's description at ${clientId} is not JSON.`);
      }
      const at = now();
      return saveClientDocument(db, clientId, doc, { now: at, expiresAt: at + fetched.maxAgeMs });
    })();
    pending.set(clientId, fetching);
    return fetching.finally(() => pending.delete(clientId));
  };
}
