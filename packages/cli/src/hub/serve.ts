import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AdminHandler,
  checkAdminExposure,
  createAdminHandler,
  createOAuthServer,
  type OAuthServer,
} from '@openlinkos/origin-admin';
import {
  completePurges,
  type Database,
  IDLE_SEAL_MS,
  OriginError,
  pendingPurgeMirrors,
  prepareAdminCredential,
  recordAudit,
  type ScryptParams,
  type SourceAdapter,
  sealIdleMirrors,
} from '@openlinkos/origin-core';
import { hubAdapters } from '../sources.js';
import { type ClientMetadataOptions, createClientResolver } from './client-metadata.js';
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
  /** How client metadata documents are fetched, for tests (see client-metadata.ts). */
  clientMetadata?: ClientMetadataOptions;
}

/**
 * ORIGIN_POWERED_BY: whether the hub's landing page credits Origin, with links to its site and
 * source. On unless set to `off` (or `0`, `false`, `no`), for a hub its owner presents under their
 * own name; the admin UI keeps its links either way.
 */
export function poweredByEnv(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (['', '1', 'on', 'true', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  throw new OriginError(`ORIGIN_POWERED_BY must be "on" or "off", not "${value}".`);
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
  /** Credit Origin on the public landing page (ORIGIN_POWERED_BY); on by default. */
  poweredBy?: boolean;
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

/** A listener that serves only the admin UI (`--admin-listen`, and `origin ui`). */
export function createAdminServer(handler: AdminHandler): http.Server {
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
  let oauth: OAuthServer | undefined;
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
    // Agents and devices sign in by browser only where the owner approves them: at /admin on the
    // hub's own port. With the UI on a listener of its own, the hub offers no OAuth.
    const resolveClient = separate
      ? null
      : createClientResolver(o.db, {
          userAgent: `Origin/${o.version} (hub; client metadata)`,
          ...o.admin.clientMetadata,
        });
    handler = createAdminHandler({
      db: o.db,
      home: o.home,
      version: o.version,
      publicUrl: o.admin.publicUrl ?? null,
      clientIpHeader: o.admin.clientIpHeader ?? null,
      credential: prepared.credential,
      oauth: resolveClient ? { resolveClient } : null,
      adapters: hubAdapters(o.adapters, o.home),
      log: o.log,
    });
    if (resolveClient) {
      oauth = createOAuthServer({
        db: o.db,
        publicUrl: o.admin.publicUrl ?? null,
        clientIpHeader: o.admin.clientIpHeader ?? null,
        resolveClient,
        log: o.log,
      });
    }
  }
  const hub = createHubServer({
    db: o.db,
    home: o.home,
    adapters: o.adapters,
    version: o.version,
    log: o.log,
    admin: separate ? undefined : handler,
    oauth,
    poweredBy: o.poweredBy,
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
  // Devices' files that stopped growing are stored compressed to the end (see mirror.ts).
  const sealing = setInterval(() => {
    try {
      sealIdleMirrors(o.db, o.home, { before: Date.now() - IDLE_SEAL_MS, remote: true });
    } catch (err) {
      o.log?.(`sealing idle mirrors failed: ${(err as Error).message}`);
    }
  }, IDLE_SEAL_CHECK_MS);
  sealing.unref();
  // Purged lines a purge left in the mirrors, as after a crash or a bucket that could not be
  // reached, are blanked now and then each minute, a few seconds at a time (see completePurges).
  const blanking = purgeCompleter(o);
  blanking();
  const purging = setInterval(blanking, PURGE_CHECK_MS);
  purging.unref();
  return {
    url,
    adminUrl: handler
      ? `${adminServer && separate ? urlOf(adminServer, separate.host) : url}/admin/`
      : null,
    async close() {
      clearInterval(sealing);
      clearInterval(purging);
      await Promise.all([close(hub), adminServer ? close(adminServer) : Promise.resolve()]);
    },
  };
}

/** How often the hub looks for mirrors that stopped growing. */
const IDLE_SEAL_CHECK_MS = 10 * 60_000;
/** How often the hub looks for purged lines still to blank, and how long it spends at a time. */
const PURGE_CHECK_MS = 60_000;
const PURGE_BUDGET_MS = 5_000;

/**
 * Blank the lines purges left in the hub's mirrors, if there are any. A mirror that keeps failing
 * is tried each time, and its error logged once.
 */
function purgeCompleter(o: StartHubOptions): () => void {
  const adapters = hubAdapters(o.adapters, o.home);
  const said = new Set<string>();
  const log = (message: string) => {
    if (said.has(message)) return;
    said.add(message);
    o.log?.(message);
  };
  return () => {
    try {
      if (pendingPurgeMirrors(o.db).length === 0) return;
      completePurges(o.db, o.home, adapters, { budgetMs: PURGE_BUDGET_MS, log });
    } catch (err) {
      log(`blanking purged lines failed: ${(err as Error).message}`);
    }
  };
}
