import { OriginError } from '@openlinkos/origin-core';
import { isLoopbackHostname } from './http.js';

/**
 * Parse the public URL the admin UI (and the hub) is reached at. It must be an origin: http or
 * https, no credentials, path, query, or fragment.
 */
export function parsePublicUrl(value: string | undefined | null): URL | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new OriginError(`Invalid public URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OriginError(
      `The public URL must start with https:// (or http:// on loopback): ${value}`,
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new OriginError(
      `The public URL must be an origin such as https://hub.example.com, without a path: ${value}`,
    );
  }
  return url;
}

/** Whether a listen address only accepts connections from this machine. */
export function isLoopbackListen(host: string): boolean {
  return isLoopbackHostname(host);
}

/**
 * Refuse configurations that would expose the admin UI over plain HTTP. On a loopback address the
 * UI is reachable only from this machine (directly, or through an SSH tunnel or a port-forward).
 * On any other address it must sit behind TLS, declared with an https public URL; an http public
 * URL is accepted only for a loopback host, such as a container port published on 127.0.0.1.
 */
export function checkAdminExposure(listenHost: string, publicUrl: URL | null): void {
  if (publicUrl && publicUrl.protocol === 'http:' && !isLoopbackHostname(publicUrl.hostname)) {
    throw new OriginError(
      `Refusing to serve the admin UI at ${publicUrl.origin}: the admin password and session cookies would travel ` +
        'unencrypted. Put the hub behind TLS and pass an https:// URL with --public-url ' +
        '(or ORIGIN_PUBLIC_URL), or reach the admin UI over a private loopback listener with ' +
        '--admin-listen 127.0.0.1:7078.',
    );
  }
  if (isLoopbackListen(listenHost) || publicUrl) return;
  throw new OriginError(
    `Refusing to serve the admin UI on ${listenHost}, which is not a loopback address, without TLS. ` +
      'Either put the hub behind a TLS proxy or CDN and pass its https:// URL with --public-url ' +
      '(or ORIGIN_PUBLIC_URL), or serve the admin UI on a private loopback listener with ' +
      '--admin-listen 127.0.0.1:7078 and reach it through an SSH tunnel or kubectl port-forward.',
  );
}

/** Parse `host:port` (IPv6 hosts in brackets). */
export function parseListen(value: string): { host: string; port: number } {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(value.trim());
  const port = m ? Number(m[2]) : Number.NaN;
  if (!m || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OriginError(`Invalid listen address "${value}": use host:port, e.g. 127.0.0.1:7078.`);
  }
  const host = (m[1] ?? '').replace(/^\[|\]$/g, '');
  return { host, port };
}
