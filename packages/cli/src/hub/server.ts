import http from 'node:http';
import zlib from 'node:zlib';
import type { AdminHandler } from '@openlinkos/origin-admin';
import {
  appendRemote,
  type Database,
  NAME_RE,
  OriginError,
  remoteCursors,
  type SourceAdapter,
  tombstonesAfter,
  verifyToken,
} from '@openlinkos/origin-core';
import { handleMcpHttp } from '@openlinkos/origin-mcp';

/** Decompressed request bodies larger than this are rejected. */
const MAX_BODY = 64 * 1024 * 1024;

export interface HubOptions {
  db: Database;
  home: string;
  /** Adapters used to parse pushed raw mirrors, by source id. */
  adapters: SourceAdapter[];
  version: string;
  log?: (message: string) => void;
  /**
   * The admin UI, mounted at /admin when enabled (see docs/architecture.md#admin-ui). It has its own
   * sign-in; bearer tokens are never checked there, and its sessions are never accepted elsewhere.
   */
  admin?: AdminHandler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The personal hub: MCP over HTTP for agents, replication for devices, and optionally the admin UI
 * for its owner (see docs/architecture.md).
 */
export function createHubServer(opts: HubOptions): http.Server {
  return http.createServer((req, res) => {
    handle(opts, req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof OriginError ? 400 : 500;
      if (status === 500) opts.log?.(`hub error: ${(err as Error).stack ?? err}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
    });
  });
}

async function handle(
  opts: HubOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://hub');
  if (url.pathname === '/healthz') {
    requireMethod(req, 'GET', 'HEAD');
    sendJson(res, 200, { ok: true, version: opts.version });
    return;
  }
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    // Routed before bearer authentication: /admin accepts only its own session, never a token.
    if (!opts.admin) throw new HttpError(404, 'Not found.');
    await opts.admin(req, res, url);
    return;
  }

  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const caller = token ? verifyToken(opts.db, token) : null;
  if (!caller) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(res, 401, { error: 'Missing or invalid token.' });
    return;
  }

  switch (url.pathname) {
    case '/mcp': {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      await handleMcpHttp(req, res, body, {
        db: opts.db,
        home: opts.home,
        version: opts.version,
        log: opts.log,
        author: authorFor(req, caller.name),
      });
      return;
    }
    case '/v1/cursors': {
      requireMethod(req, 'GET');
      const device = url.searchParams.get('device') ?? '';
      if (!NAME_RE.test(device)) throw new HttpError(400, 'Invalid or missing device.');
      sendJson(res, 200, { cursors: remoteCursors(opts.db, device) });
      return;
    }
    case '/v1/ingest': {
      requireMethod(req, 'POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      const adapter = opts.adapters.find((a) => a.id === body.source);
      if (!adapter) throw new HttpError(400, `Unknown source: ${String(body.source)}`);
      if (typeof body.data !== 'string') throw new HttpError(400, 'Missing data.');
      const result = appendRemote({ db: opts.db, home: opts.home, log: opts.log }, adapter, {
        device: String(body.device ?? ''),
        source: adapter.id,
        path: String(body.path ?? ''),
        relPath: String(body.relPath ?? ''),
        generation: Number(body.generation),
        offset: Number(body.offset),
        data: Buffer.from(body.data, 'base64'),
        mtimeMs: typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined,
        agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : null,
      });
      if (result.ok) sendJson(res, 200, result);
      else sendJson(res, 409, { bytes: result.bytes });
      return;
    }
    case '/v1/tombstones': {
      requireMethod(req, 'GET');
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'Invalid "after".');
      sendJson(res, 200, { tombstones: tombstonesAfter(opts.db, after) });
      return;
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
}

/** `<agent>@<token>` when a forwarding proxy names the agent, else the token name. */
function authorFor(req: http.IncomingMessage, tokenName: string): string {
  const header = req.headers['x-origin-client'];
  const client = (Array.isArray(header) ? header[0] : header)
    ?.replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 64);
  return client ? `${client}@${tokenName}` : tokenName;
}

function requireMethod(req: http.IncomingMessage, ...methods: string[]): void {
  if (!methods.includes(req.method ?? '')) throw new HttpError(405, 'Method not allowed.');
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  let raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'gzip') {
    try {
      raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_BODY });
    } catch {
      throw new HttpError(400, 'Invalid gzip body.');
    }
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
