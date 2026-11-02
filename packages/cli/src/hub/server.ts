import http from 'node:http';
import zlib from 'node:zlib';
import {
  BUILT_IN_SOURCE_IDS,
  isLinesSourceId,
  LINES_SOURCE_RULE,
} from '@openlinkos/origin-adapters';
import {
  type AdminHandler,
  createLandingHandler,
  type LandingHandler,
} from '@openlinkos/origin-admin';
import {
  appendRemote,
  appendRemoteLines,
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
import { hubAdapters } from '../sources.js';

/** Decompressed request bodies larger than this are rejected. */
const MAX_BODY = 64 * 1024 * 1024;
/** Most entries or tombstones in one replication request. */
const MAX_RECORDS = 1000;
/** Most bytes of event lines in one request to /v1/sources/<name>/lines, decompressed. */
export const MAX_LINES_BODY = 8 * 1024 * 1024;
/** The media types of a body of event lines. */
const LINES_TYPES = ['application/x-ndjson', 'text/plain'];
/** Longest path of a file of event lines appended on the hub. */
const LINES_PATH_MAX = 200;
/** A part of such a path: letters, digits, `.`, `_`, and `-`, from a letter or digit, not ending in a dot. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
/** Names Windows keeps for devices, with or without an extension, which no file may take there. */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
/** Where a client refused for want of a token can read how tokens work. */
export const HUB_GUIDE_URL = 'https://origin.openlinkos.com/guide/hub';

export interface HubOptions {
  db: Database;
  home: string;
  /**
   * Adapters used to parse pushed raw mirrors, by source id. A source that is not among them, and
   * whose name can name a source of one's own, is parsed as event lines (see sources.ts).
   */
  adapters: SourceAdapter[];
  version: string;
  log?: (message: string) => void;
  /**
   * The admin UI, mounted at /admin when enabled (see docs/architecture.md#admin-ui). It has its own
   * sign-in; bearer tokens are never checked there, and its sessions are never accepted elsewhere.
   */
  admin?: AdminHandler;
  /**
   * Credit Origin on the public landing page at `/`, with links to its site and source; on unless
   * set to false (ORIGIN_POWERED_BY=off). The admin UI keeps its links either way.
   */
  poweredBy?: boolean;
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
  const adapterFor = hubAdapters(opts.adapters, opts.home);
  const landing = createLandingHandler({
    admin: opts.admin !== undefined,
    poweredBy: opts.poweredBy ?? true,
  });
  return http.createServer((req, res) => {
    handle(opts, adapterFor, landing, req, res).catch((err: unknown) => {
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
  adapterFor: (source: string) => SourceAdapter | null,
  landing: LandingHandler,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://hub');
  if (url.pathname === '/healthz') {
    requireMethod(req, 'GET', 'HEAD');
    sendJson(res, 200, { ok: true, version: opts.version });
    return;
  }
  // The public landing page, robots.txt, and the page's files: no token, and nothing of the store.
  if (landing(req, res, url)) return;
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
    sendJson(res, 401, { error: 'Missing or invalid token.', docs: HUB_GUIDE_URL });
    return;
  }

  const lines = SOURCE_LINES_RE.exec(url.pathname);
  if (lines) {
    await appendSourceLines(opts, adapterFor, req, res, url, caller.name, lines[1] as string);
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
      // With a source and a path, only the generations of that one file (an agent's hook pushing it).
      const source = url.searchParams.get('source');
      const file = url.searchParams.get('path');
      sendJson(res, 200, {
        cursors: remoteCursors(
          opts.db,
          device,
          source && file ? { source, path: file } : undefined,
        ),
      });
      return;
    }
    case '/v1/ingest': {
      requireMethod(req, 'POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      const device = deviceOf(opts, caller.name, body.device);
      const adapter = typeof body.source === 'string' ? adapterFor(body.source) : null;
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

/** The path of the endpoint that appends event lines to a source of one's own. */
const SOURCE_LINES_RE = /^\/v1\/sources\/([^/]*)\/lines$/;

/**
 * `POST /v1/sources/<name>/lines?path=<file>`: append event lines to file `path` of the source
 * `<name>`, as sent by the token's device, for a writer without a device of its own (see
 * docs/architecture.md#http-interface). The body's lines go to the end of the hub's mirror of that
 * file, through the same ingestion as the mirrors devices push (appendRemoteLines); a last line
 * without a line break ends with the body. Lines whose events the hub already has are mirrored but
 * add nothing, so a writer may send again what it is unsure arrived.
 */
async function appendSourceLines(
  opts: HubOptions,
  adapterFor: (source: string) => SourceAdapter | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string,
  name: string,
): Promise<void> {
  requireMethod(req, 'POST');
  if (BUILT_IN_SOURCE_IDS.includes(name)) {
    throw new HttpError(
      400,
      `${name} is a built-in source, whose logs its agent writes; append event lines to a source of your own.`,
    );
  }
  if (!isLinesSourceId(name)) {
    throw new HttpError(400, `Invalid source name "${name}": ${LINES_SOURCE_RULE}.`);
  }
  const file = linesPath(url.searchParams.get('path'));
  const device = deviceOf(opts, token, url.searchParams.get('device'));
  const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!LINES_TYPES.includes(type)) {
    throw new HttpError(415, `Send event lines as ${LINES_TYPES.join(' or ')}.`);
  }
  let data = await readBody(req, MAX_LINES_BODY);
  if (data.length > 0 && data[data.length - 1] !== 0x0a) data = Buffer.concat([data, NEWLINE]);
  const adapter = adapterFor(name) as SourceAdapter;
  const r = appendRemoteLines({ db: opts.db, home: opts.home, log: opts.log }, adapter, {
    device,
    source: name,
    path: file,
    relPath: file,
    data,
  });
  sendJson(res, 200, {
    lines: r.linesRead,
    events: r.eventsAdded,
    duplicates: r.duplicates,
    parse_errors: r.parseErrors,
  });
}

const NEWLINE = Buffer.from('\n');

/**
 * The path of a file of event lines appended on the hub: relative, `/`-separated parts of letters,
 * digits, `.`, `_`, and `-` that file systems everywhere take as they are, ending in `.jsonl`, at
 * most LINES_PATH_MAX characters.
 */
function linesPath(value: string | null): string {
  const rule = `"path" must be a relative path of at most ${LINES_PATH_MAX} characters, /-separated, ending in .jsonl, each part of letters, digits, ., _, and - starting with a letter or digit`;
  if (!value) throw new HttpError(400, `Missing "path": ${rule}.`);
  const segments = value.split('/');
  if (
    value.length > LINES_PATH_MAX ||
    !value.endsWith('.jsonl') ||
    segments.some((seg) => !PATH_SEGMENT_RE.test(seg) || DEVICE_NAME_RE.test(seg))
  ) {
    throw new HttpError(400, `Invalid "path" ${JSON.stringify(value)}: ${rule}.`);
  }
  return value;
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

/** A request's body, decompressed when it is gzip-encoded; 413 beyond `max` bytes either way. */
async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] !== 'gzip') return raw;
  try {
    return zlib.gunzipSync(raw, { maxOutputLength: max });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new HttpError(413, 'Request body too large.');
    }
    throw new HttpError(400, 'Invalid gzip body.');
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req, MAX_BODY);
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
