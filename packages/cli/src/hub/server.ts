import http from 'node:http';
import zlib from 'node:zlib';
import type { AdminHandler } from '@openlinkos/origin-admin';
import {
  appendRemote,
  ConflictError,
  type Database,
  HUB_STORE_NAME,
  initStoreName,
  NAME_RE,
  OriginError,
  parseReplicaEntry,
  parseReplicaRecall,
  parseTombstoneRecord,
  receiveEntry,
  receiveRecall,
  receiveTombstone,
  remoteCursors,
  type SourceAdapter,
  storeName,
  tombstoneFeed,
  verifyToken,
} from '@openlinkos/origin-core';
import { handleMcpHttp } from '@openlinkos/origin-mcp';

/** Decompressed request bodies larger than this are rejected. */
const MAX_BODY = 64 * 1024 * 1024;
/** Most entries or tombstones in one replication request. */
const MAX_RECORDS = 1000;

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
    /** More fields for the JSON error body. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The personal hub: MCP over HTTP for agents, replication for devices, and optionally the admin UI
 * for its owner (see docs/architecture.md).
 */
export function createHubServer(opts: HubOptions): http.Server {
  // A store that starts serving without a name becomes `hub` (see docs/architecture.md#storage).
  initStoreName(opts.db, HUB_STORE_NAME);
  return http.createServer((req, res) => {
    handle(opts, req, res).catch((err: unknown) => {
      const status =
        err instanceof HttpError
          ? err.status
          : err instanceof ConflictError
            ? 409
            : err instanceof OriginError
              ? 400
              : 500;
      if (status === 500) opts.log?.(`hub error: ${(err as Error).stack ?? err}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, {
        error: status === 500 ? 'internal error' : (err as Error).message,
        ...(err instanceof HttpError ? err.extra : {}),
      });
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
      const author = authorFor(req, caller.name);
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      await handleMcpHttp(req, res, body, {
        db: opts.db,
        home: opts.home,
        version: opts.version,
        log: opts.log,
        author,
      });
      return;
    }
    case '/v1/device': {
      requireMethod(req, 'GET');
      sendJson(res, 200, { device: caller.name, hub: storeName(opts.db) });
      return;
    }
    case '/v1/cursors': {
      requireMethod(req, 'GET');
      const device = deviceOf(opts, caller.name, url.searchParams.get('device'));
      sendJson(res, 200, { cursors: remoteCursors(opts.db, device) });
      return;
    }
    case '/v1/ingest': {
      requireMethod(req, 'POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      const device = deviceOf(opts, caller.name, body.device);
      const adapter = opts.adapters.find((a) => a.id === body.source);
      if (!adapter) throw new HttpError(400, `Unknown source: ${String(body.source)}`);
      if (typeof body.data !== 'string') throw new HttpError(400, 'Missing data.');
      const result = appendRemote({ db: opts.db, home: opts.home, log: opts.log }, adapter, {
        device,
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
    case '/v1/entries': {
      requireMethod(req, 'POST');
      const { device, records } = await replicaBody(opts, req, caller.name, 'entries');
      // Validate everything first, then store in order; stop at the first entry that must wait.
      const entries = records.map(parseReplicaEntry);
      checkOrigins(entries, device);
      const growthOrigin = storeName(opts.db);
      let applied = 0;
      for (const e of entries) {
        const r = receiveEntry(opts.db, e, { growthOrigin });
        if (r.status === 'pending') {
          sendJson(res, 200, { applied, pending: { id: e.id, missing: r.missing } });
          return;
        }
        applied++;
      }
      sendJson(res, 200, { applied, pending: null });
      return;
    }
    case '/v1/recalls': {
      requireMethod(req, 'POST');
      const { device, records } = await replicaBody(opts, req, caller.name, 'recalls');
      const recalls = records.map(parseReplicaRecall);
      checkOrigins(recalls, device);
      for (const r of recalls) receiveRecall(opts.db, r);
      sendJson(res, 200, { applied: recalls.length });
      return;
    }
    case '/v1/tombstones': {
      if (req.method === 'POST') {
        const { device, records } = await replicaBody(opts, req, caller.name, 'tombstones');
        const tombstones = records.map(parseTombstoneRecord);
        checkOrigins(tombstones, device);
        const growthOrigin = storeName(opts.db);
        for (const t of tombstones) receiveTombstone(opts.db, t, { growthOrigin });
        sendJson(res, 200, { applied: tombstones.length });
        return;
      }
      requireMethod(req, 'GET');
      const device = deviceOf(opts, caller.name, url.searchParams.get('device'));
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'Invalid "after".');
      sendJson(res, 200, tombstoneFeed(opts.db, { after, device }));
      return;
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
}

/** Refused: a token used for a device other than the one it is named after. */
function wrongDevice(token: string, named: string): HttpError {
  return new HttpError(
    403,
    `This token belongs to device "${token}", not "${named}": a token sends and receives data only for the device it is named after. Connect ${named} with a token named "${named}" (on the hub: origin token create ${named}).`,
    { device: token },
  );
}

/**
 * The device of a replication request: the one its token is named after (see
 * docs/architecture.md#access). A request may name its device, and is refused if it names another.
 * The token's name may not be the hub's own: the hub would take the device's records for its own,
 * and the device would miss the hub's tombstones.
 */
function deviceOf(opts: HubOptions, token: string, named: unknown): string {
  if (named !== undefined && named !== null) {
    if (typeof named !== 'string' || !NAME_RE.test(named)) {
      throw new HttpError(400, 'Invalid device.');
    }
    if (named !== token) throw wrongDevice(token, named);
  }
  if (token === storeName(opts.db)) {
    throw new HttpError(
      403,
      `"${token}" is this hub's own name, so no device can use this token; create a token named after the device.`,
      { device: token },
    );
  }
  return token;
}

/** The device and the records of a replication request. */
async function replicaBody(
  opts: HubOptions,
  req: http.IncomingMessage,
  token: string,
  field: 'entries' | 'tombstones' | 'recalls',
): Promise<{ device: string; records: unknown[] }> {
  const body = await readJson(req);
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Invalid body.');
  const { device, [field]: records } = body as Record<string, unknown>;
  const owner = deviceOf(opts, token, device);
  if (!Array.isArray(records) || records.length > MAX_RECORDS) {
    throw new HttpError(400, `Invalid or too many ${field}.`);
  }
  return { device: owner, records };
}

/** A device sends only what it wrote itself: its records carry its name. */
function checkOrigins(records: Array<{ id: string; origin: string }>, device: string): void {
  for (const r of records) {
    if (r.origin !== device) {
      throw new HttpError(
        403,
        `${r.id} was written by ${r.origin}; the token of ${device} sends only what ${device} wrote.`,
      );
    }
  }
}

/** A request header's first value. */
function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The author of entries written through /mcp: `<agent>@<token>` when the caller names its agent in
 * X-Origin-Client (a device's `origin mcp` does), and the token name otherwise. The device part is
 * always the token's name: a device that also sends X-Origin-Device must send that name, or the
 * request is refused, so that no token writes as another device.
 */
function authorFor(req: http.IncomingMessage, tokenName: string): string {
  const device = header(req, 'x-origin-device');
  if (device !== undefined && device !== tokenName) throw wrongDevice(tokenName, device);
  const client = header(req, 'x-origin-client')
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
