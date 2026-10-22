import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AdminHandler,
  checkAdminExposure,
  createAdminHandler,
} from '@openlinkos/origin-admin';
import {
  type Database,
  prepareAdminCredential,
  recordAudit,
  type ScryptParams,
  type SourceAdapter,
} from '@openlinkos/origin-core';
import { createHubServer } from './server.js';

/** How the hub serves its admin UI (see docs/architecture.md#admin-ui). */
export interface HubAdminOptions {
  /** The https URL (or loopback http URL) browsers, devices, and agents use to reach the hub. */
  publicUrl?: URL | null;
  /** A request header with the client address, set by a trusted proxy. */
  clientIpHeader?: string | null;
  /** ORIGIN_ADMIN_PASSWORD: when set, it is the admin password, ahead of the stored one. */
  envPassword?: string | null;
  /** Serve the UI on its own listener instead of at /admin on the hub's port. */
  listen?: { host: string; port: number } | null;
  /** scrypt parameters for new password hashes, for tests. */
  passwordParams?: ScryptParams;
}

/** The one-time notice for a generated admin password. */
function generatedPasswordNotice(password: string): string {
  return [
    'Generated an admin password for the admin UI (shown only this once):',
    '',
    `    ${password}`,
    '',
    'Sign in with it, then set your own with: origin admin password',
  ].join('\n');
}

export interface StartHubOptions {
  db: Database;
  home: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  adapters: SourceAdapter[];
  version: string;
  log?: (message: string) => void;
  /** Enable the admin UI. */
  admin?: HubAdminOptions | null;
}

export interface RunningHub {
  /** The hub's own address, e.g. `http://127.0.0.1:7077`. */
  url: string;
  /** Where the admin UI answers, or null when it is disabled. */
  adminUrl: string | null;
  close(): Promise<void>;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function urlOf(server: http.Server, host: string): string {
  const { port } = server.address() as AddressInfo;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A listener that serves only the admin UI. */
function createAdminServer(handler: AdminHandler): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://admin');
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      void handler(req, res, url);
      return;
    }
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(303, { Location: '/admin/', 'Content-Length': 0 }).end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
  });
}

/**
 * Start a hub: the HTTP server for agents and devices and, when enabled, the admin UI, either at
 * /admin on the same port or on its own listener. Refuses to expose the admin UI over plain HTTP
 * beyond loopback. With the admin UI enabled, settles the admin password first: ORIGIN_ADMIN_PASSWORD,
 * or the stored one, or a generated one that is logged this once.
 */
export async function startHub(o: StartHubOptions): Promise<RunningHub> {
  let handler: AdminHandler | undefined;
  const separate = o.admin?.listen ?? null;
  if (o.admin) {
    checkAdminExposure(separate ? separate.host : o.host, o.admin.publicUrl ?? null);
    const prepared = await prepareAdminCredential(o.db, {
      envPassword: o.admin.envPassword ?? null,
      params: o.admin.passwordParams,
    });
    if (prepared.generated !== null) {
      recordAudit(o.db, {
        actor: 'hub',
        channel: 'cli',
        action: 'password.generate',
        detail: { sessionsEnded: prepared.sessionsEnded },
      });
      o.log?.(generatedPasswordNotice(prepared.generated));
    } else if (prepared.changed) {
      recordAudit(o.db, {
        actor: 'hub',
        channel: 'cli',
        action: 'password.change',
        detail: { source: prepared.credential.source, sessionsEnded: prepared.sessionsEnded },
      });
    }
    handler = createAdminHandler({
      db: o.db,
      home: o.home,
      version: o.version,
      publicUrl: o.admin.publicUrl ?? null,
      clientIpHeader: o.admin.clientIpHeader ?? null,
      credential: prepared.credential,
      log: o.log,
    });
  }
  const hub = createHubServer({
    db: o.db,
    home: o.home,
    adapters: o.adapters,
    version: o.version,
    log: o.log,
    admin: separate ? undefined : handler,
  });
  await listen(hub, o.port, o.host);
  let adminServer: http.Server | null = null;
  if (handler && separate) {
    adminServer = createAdminServer(handler);
    try {
      await listen(adminServer, separate.port, separate.host);
    } catch (err) {
      await close(hub);
      throw err;
    }
  }
  const url = urlOf(hub, o.host);
  return {
    url,
    adminUrl: handler
      ? `${adminServer && separate ? urlOf(adminServer, separate.host) : url}/admin/`
      : null,
    async close() {
      await Promise.all([close(hub), adminServer ? close(adminServer) : Promise.resolve()]);
    },
  };
}
