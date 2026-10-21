import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { SafeHtml } from './html.js';

/** Admin request bodies larger than this are rejected with 413. */
export const MAX_BODY = 64 * 1024;

/** An error with an HTTP status whose message is safe to show. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The Content-Security-Policy of every admin response (SVG images get a narrower variant). */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

/**
 * SVG images carry their colours in an embedded <style> element, which the page policy would
 * block. They are served with their own policy that allows inline styles and nothing else, and are
 * sandboxed, so opening one directly can run nothing.
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Headers set on every response under /admin. */
export function securityHeaders(https: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-store, private',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    // Not no-referrer: with it, browsers send Origin: null on same-origin form posts (Fetch
    // standard), which would defeat the Origin check. same-origin still never sends a referrer
    // to another origin.
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=()',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

export function sendHtml(res: ServerResponse, status: number, body: SafeHtml): void {
  const text = body.value;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 303 See Other to a path inside the admin UI. */
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Content-Length': 0 });
  res.end();
}

/**
 * A redirect target from a `next` parameter: a path inside the admin UI, or the overview. Absolute
 * URLs, protocol-relative paths, and backslashes are refused (no open redirects).
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string') return '/admin/';
  if (!/^\/admin(\/|$|\?)/.test(next)) return '/admin/';
  if (/[\\\s]/.test(next) || next.includes('//')) return '/admin/';
  if (next.startsWith('/admin/api/') || next.startsWith('/admin/assets/')) return '/admin/';
  return next;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

export interface CookieOptions {
  path: string;
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax';
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${value}`, `Path=${o.path}`, `SameSite=${o.sameSite}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  if (o.secure) parts.push('Secure');
  if (o.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/** Add a Set-Cookie header without replacing earlier ones. */
export function appendCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev === undefined ? [] : [String(prev)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

/**
 * The session cookie. Behind an https public URL it is `__Host-origin-admin` (Secure, whole host,
 * SameSite=Lax); on plain http, which is only allowed on loopback, it is `origin-admin`, limited
 * to /admin with SameSite=Strict.
 */
export const SECURE_SESSION_COOKIE = '__Host-origin-admin';
export const PLAIN_SESSION_COOKIE = 'origin-admin';

export function sessionCookie(value: string, secure: boolean, maxAge?: number): string {
  return secure
    ? serializeCookie(SECURE_SESSION_COOKIE, value, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        maxAge,
      })
    : serializeCookie(PLAIN_SESSION_COOKIE, value, {
        path: '/admin',
        secure: false,
        httpOnly: true,
        sameSite: 'Strict',
        maxAge,
      });
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Host names that always resolve to this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || isLoopbackAddress(h);
}

/** The host name of a Host header value (`name:port`, `[v6]:port`). */
export function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  const colon = host.lastIndexOf(':');
  return colon < 0 ? host : host.slice(0, colon);
}

/** Where a request may come from, for the Origin check and the cookie flavour. */
export interface RequestOrigins {
  /** The public origin, from --public-url. */
  public: string | null;
  publicSecure: boolean;
  /** `http://<Host>` for a loopback connection addressed to a loopback name (a tunnel or port-forward). */
  local: string | null;
}

export function requestOrigins(req: IncomingMessage, publicUrl: URL | null): RequestOrigins {
  const host = (req.headers.host ?? '').toLowerCase();
  const local =
    host.length > 0 &&
    /^[a-z0-9.\-[\]:]+$/.test(host) &&
    isLoopbackAddress(req.socket.localAddress) &&
    isLoopbackHostname(hostnameOf(host))
      ? `http://${host}`
      : null;
  return {
    public: publicUrl ? publicUrl.origin : null,
    publicSecure: publicUrl?.protocol === 'https:',
    local,
  };
}

/** Reject requests a browser marks as cross-site. */
export function rejectCrossSite(req: IncomingMessage): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
}

/**
 * Cross-site request checks for every POST: reject `Sec-Fetch-Site: cross-site`, and require an
 * Origin header equal to an allowed origin. Returns whether the request came from the https
 * public origin, which decides the cookie flavour.
 */
export function checkSameOrigin(
  req: IncomingMessage,
  origins: RequestOrigins,
): { secure: boolean } {
  rejectCrossSite(req);
  const origin = req.headers.origin;
  if (origin === undefined) throw new HttpError(403, 'Missing Origin header.');
  if (origins.public !== null && origin === origins.public) {
    return { secure: origins.publicSecure };
  }
  if (origins.local !== null && origin === origins.local) return { secure: false };
  throw new HttpError(403, 'Origin not allowed.');
}

/** The client address: from the configured proxy header, else the peer address. */
export function clientIp(req: IncomingMessage, header: string | null): string | null {
  if (header) {
    const value = req.headers[header.toLowerCase()];
    const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
    if (first && isIP(first)) return first;
    return null;
  }
  const addr = req.socket.remoteAddress;
  if (!addr) return null;
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** Read a request body of at most MAX_BODY bytes. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    req.resume();
    throw new HttpError(413, 'Request body too large.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a form or JSON body into fields. */
export function parseBody(req: IncomingMessage, body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'Compressed request bodies are not accepted.');
  }
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(body.toString('utf8'))) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  }
  if (type === 'application/json') {
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON body.');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'The JSON body must be an object.');
    }
    return value as Record<string, unknown>;
  }
  throw new HttpError(415, 'Use a form or a JSON body.');
}
