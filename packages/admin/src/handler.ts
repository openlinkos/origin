import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createAdminSession,
  type Database,
  endAdminSession,
  getAdminSession,
  isAdminSessionFresh,
  markAdminSessionFresh,
  OriginError,
  verifyAdminKey,
} from '@openlinkos/origin-core';
import { Assets } from './assets.js';
import { actorOf, type Ctx, field, pageParam, query, type Theme } from './context.js';
import {
  appendCookie,
  CSP,
  checkSameOrigin,
  clientIp as clientIpOf,
  HttpError,
  PLAIN_SESSION_COOKIE,
  parseBody,
  parseCookies,
  readBody,
  redirect,
  rejectCrossSite,
  requestOrigins,
  SECURE_SESSION_COOKIE,
  SVG_CSP,
  safeEqual,
  safeNext,
  securityHeaders,
  sendJson,
  sendText,
  serializeCookie,
  sessionCookie,
} from './http.js';
import { negotiateLang, translator } from './i18n/index.js';
import { errorPage, loginPage, reauthPage } from './pages/auth.js';
import { eventPage, eventRawPage, searchPage, sessionPage, sessionsPage } from './pages/browse.js';
import {
  correctPage,
  entriesPage,
  entryPage,
  forgetPage,
  forgottenPage,
  rememberPage,
} from './pages/entries.js';
import { beforeParam, here } from './pages/layout.js';
import { connectPage, devicePage, devicesPage, overviewPage } from './pages/overview.js';
import { auditPage, signinsPage, tombstonesPage } from './pages/records.js';
import { newTokenPage, revokeTokenPage, tokenCreatedPage, tokensPage } from './pages/tokens.js';
import { type LimiterOptions, LOGIN_LIMITS, LoginLimiter } from './ratelimit.js';
import { AdminService } from './service.js';

export interface AdminOptions {
  db: Database;
  home: string;
  version: string;
  /**
   * The URL browsers use to reach the admin UI (and devices and agents the hub): an https origin,
   * or http on a loopback host. Without it, the UI answers only on loopback connections.
   */
  publicUrl?: URL | null;
  /** A request header with the client address, set by a trusted proxy. Ignored unless configured. */
  clientIpHeader?: string | null;
  /** SHA-256 hashes of admin keys configured in the environment (ORIGIN_ADMIN_KEY_SHA256). */
  envKeyHashes?: readonly string[];
  /** When the hub started, for the uptime shown on the overview. */
  startedAt?: number;
  log?: (message: string) => void;
  /** Clock and limits, for tests. */
  now?: () => number;
  loginLimits?: LimiterOptions;
}

/** Handles every request under /admin. Never throws; the caller routes /admin and /admin/* to it. */
export type AdminHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

interface State {
  db: Database;
  publicUrl: URL | null;
  clientIpHeader: string | null;
  envKeyHashes: readonly string[];
  version: string;
  service: AdminService;
  assets: Assets;
  limiter: LoginLimiter;
  log: (message: string) => void;
  now: () => number;
}

/**
 * `none`: no session needed. `session`: signed in. `fresh`: signed in, and the key entered within
 * the last 10 minutes (token create and revoke, forget, revoking sessions).
 */
export type RouteAuth = 'none' | 'session' | 'fresh';

interface Route {
  method: 'GET' | 'POST';
  path: string;
  auth: RouteAuth;
  run: (ctx: Ctx, s: State) => Promise<void> | void;
  /** For fresh POSTs from pages: the page to return to after re-authenticating. */
  back?: (ctx: Ctx) => string;
}

const LANG_COOKIE = 'origin-admin-lang';
const THEME_COOKIE = 'origin-admin-theme';
const YEAR = 365 * 86_400;

function json(ctx: Ctx, status: number, value: unknown): void {
  sendJson(ctx.res, status, value);
}

const flag = (v: unknown) => v === '1' || v === 'true' || v === true;

// ---------------------------------------------------------------------------------------------
// Authentication

type KeyCheck =
  | { ok: true; name: string }
  | { ok: false; status: 401 | 429; message: string; retryAfterSec?: number };

/**
 * Check an admin key, subject to the failure limit. Failures are written to the audit log once
 * per window and client (the first failure, then the block), not once per attempt.
 */
function checkKey(ctx: Ctx, s: State, key: unknown, mode: 'login' | 'reauth'): KeyCheck {
  const client = ctx.ip ?? 'unknown';
  const limit = s.limiter.check(client, ctx.now);
  if (!limit.ok) {
    if (limit.firstBlock) {
      s.service.recordAuth(actorOf(ctx), `${mode}.blocked`, { retryAfterSec: limit.retryAfterSec });
    }
    ctx.res.setHeader('Retry-After', String(limit.retryAfterSec));
    return {
      ok: false,
      status: 429,
      retryAfterSec: limit.retryAfterSec,
      message: ctx.t('auth.tooMany', { min: Math.ceil(limit.retryAfterSec / 60) }),
    };
  }
  const verified =
    typeof key === 'string' && key.length <= 256
      ? verifyAdminKey(s.db, key.trim(), { envHashes: s.envKeyHashes, now: ctx.now })
      : null;
  if (!verified || (mode === 'reauth' && verified.name !== ctx.session?.keyName)) {
    const failures = s.limiter.fail(client, ctx.now);
    if (failures === 1) s.service.recordAuth(actorOf(ctx), `${mode}.failed`, { failures });
    return { ok: false, status: 401, message: ctx.t('auth.badKey') };
  }
  return { ok: true, name: verified.name };
}

/** Start a new session (never reusing one presented with the request) and set its cookie. */
function startSession(ctx: Ctx, s: State, keyName: string): string {
  if (ctx.session) endAdminSession(s.db, ctx.session.idHash, ctx.now);
  const { id, session } = createAdminSession(
    s.db,
    { keyName, ip: ctx.ip, userAgent: ctx.userAgent },
    ctx.now,
  );
  appendCookie(ctx.res, sessionCookie(id, ctx.secure));
  ctx.session = session;
  s.service.recordAuth(actorOf(ctx), 'login');
  return session.csrf;
}

function endSession(ctx: Ctx, s: State): void {
  if (ctx.session) {
    s.service.recordAuth(actorOf(ctx), 'logout');
    endAdminSession(s.db, ctx.session.idHash, ctx.now);
  }
  appendCookie(ctx.res, sessionCookie('', true, 0));
  appendCookie(ctx.res, sessionCookie('', false, 0));
  ctx.session = null;
}

function setPref(ctx: Ctx, name: string, value: string | null): void {
  appendCookie(
    ctx.res,
    serializeCookie(name, value ?? '', {
      path: '/admin',
      maxAge: value === null ? 0 : YEAR,
      secure: ctx.secure,
      httpOnly: true,
      sameSite: 'Lax',
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Pages

const page = (
  method: 'GET' | 'POST',
  path: string,
  auth: RouteAuth,
  run: Route['run'],
  back?: Route['back'],
): Route => ({
  method,
  path: `/admin${path}`,
  auth,
  run,
  back,
});

const PAGES: Route[] = [
  page('GET', '/', 'session', (ctx) => overviewPage(ctx, ctx.service.overview(ctx.now))),

  page('GET', '/login', 'none', (ctx) => {
    const next = safeNext(query(ctx, 'next'));
    if (ctx.session) return redirect(ctx.res, next);
    loginPage(ctx, 200, { next });
  }),
  page('POST', '/login', 'none', (ctx, s) => {
    const next = safeNext(field(ctx, 'next'));
    const r = checkKey(ctx, s, ctx.body.key, 'login');
    if (!r.ok) return loginPage(ctx, r.status, { next, error: r.message });
    startSession(ctx, s, r.name);
    redirect(ctx.res, next);
  }),
  page('POST', '/logout', 'session', (ctx, s) => {
    endSession(ctx, s);
    redirect(ctx.res, '/admin/login');
  }),
  page('GET', '/reauth', 'session', (ctx) =>
    reauthPage(ctx, 200, { next: safeNext(query(ctx, 'next')) }),
  ),
  page('POST', '/reauth', 'session', (ctx, s) => {
    const next = safeNext(field(ctx, 'next'));
    const r = checkKey(ctx, s, ctx.body.key, 'reauth');
    if (!r.ok) return reauthPage(ctx, r.status, { next, error: r.message });
    markAdminSessionFresh(s.db, ctx.session?.idHash ?? '', ctx.now);
    s.service.recordAuth(actorOf(ctx), 'reauth');
    redirect(ctx.res, next);
  }),
  page('POST', '/prefs', 'none', (ctx) => {
    const lang = field(ctx, 'lang');
    if (lang === 'en' || lang === 'zh') setPref(ctx, LANG_COOKIE, lang);
    const theme = field(ctx, 'theme');
    if (theme === 'light' || theme === 'dark') setPref(ctx, THEME_COOKIE, theme);
    if (theme === 'auto') setPref(ctx, THEME_COOKIE, null);
    redirect(ctx.res, safeNext(field(ctx, 'next')));
  }),

  page('GET', '/devices', 'session', (ctx) => devicesPage(ctx, ctx.service.devices(ctx.now))),
  page('GET', '/device', 'session', (ctx) =>
    devicePage(ctx, ctx.service.device(query(ctx, 'name'), ctx.now)),
  ),
  page('GET', '/connect', 'session', (ctx) => connectPage(ctx, ctx.service.connect())),

  page('GET', '/tokens', 'session', (ctx) => {
    const revoked = query(ctx, 'revoked');
    tokensPage(
      ctx,
      ctx.service.tokens(),
      revoked ? ctx.t('tokens.revokedNotice', { name: revoked }) : undefined,
    );
  }),
  page('GET', '/tokens/new', 'fresh', (ctx) => newTokenPage(ctx, 200, {})),
  page(
    'POST',
    '/tokens',
    'fresh',
    (ctx) => {
      try {
        tokenCreatedPage(ctx, ctx.service.createToken(actorOf(ctx), ctx.body.name));
      } catch (err) {
        if (!(err instanceof OriginError)) throw err;
        newTokenPage(ctx, 400, { name: field(ctx, 'name'), error: err.message });
      }
    },
    () => '/admin/tokens/new',
  ),
  page('GET', '/tokens/revoke', 'fresh', (ctx) =>
    revokeTokenPage(ctx, 200, { name: query(ctx, 'name') }),
  ),
  page(
    'POST',
    '/tokens/revoke',
    'fresh',
    (ctx) => {
      const name = field(ctx, 'name');
      try {
        ctx.service.revokeToken(actorOf(ctx), name);
      } catch (err) {
        if (!(err instanceof OriginError)) throw err;
        return revokeTokenPage(ctx, 400, { name, error: err.message });
      }
      redirect(ctx.res, `/admin/tokens?revoked=${encodeURIComponent(name)}`);
    },
    () => '/admin/tokens',
  ),

  page('GET', '/sessions', 'session', (ctx) => {
    const filter = { source: query(ctx, 'source'), project: query(ctx, 'project') };
    const r = ctx.service.sessions({ ...filter, page: pageParam(ctx) });
    sessionsPage(ctx, {
      ...r,
      sources: ctx.service.sources(),
      projects: ctx.service.projects().map((p) => p.project),
      filter,
    });
  }),
  page('GET', '/session', 'session', (ctx) => {
    const tools = flag(query(ctx, 'tools'));
    const r = ctx.service.sessionEvents(query(ctx, 'source'), query(ctx, 'id'), {
      tools,
      page: pageParam(ctx),
    });
    sessionPage(ctx, { ...r, tools });
  }),
  page('GET', '/event', 'session', (ctx) => eventPage(ctx, ctx.service.event(query(ctx, 'id')))),
  page('GET', '/event-raw', 'session', (ctx) =>
    eventRawPage(ctx, ctx.service.eventRaw(query(ctx, 'id'))),
  ),
  page('GET', '/search', 'session', (ctx) => {
    const tools = flag(query(ctx, 'tools'));
    searchPage(ctx, { ...ctx.service.search(query(ctx, 'q'), { tools }), tools });
  }),

  page('GET', '/entries', 'session', (ctx) => {
    const filter = {
      kind: query(ctx, 'kind'),
      project: query(ctx, 'project'),
      history: flag(query(ctx, 'history')),
    };
    const r = ctx.service.entries({ ...filter, page: pageParam(ctx) });
    entriesPage(ctx, { ...r, projects: ctx.service.projects().map((p) => p.project), filter });
  }),
  page('GET', '/entry', 'session', (ctx) => entryPage(ctx, ctx.service.entry(query(ctx, 'id')))),
  page('GET', '/correct', 'session', (ctx) =>
    correctPage(ctx, 200, { entry: ctx.service.entry(query(ctx, 'id')).entry }),
  ),
  page('POST', '/correct', 'session', (ctx) => {
    const id = field(ctx, 'id');
    try {
      const entry = ctx.service.correct(actorOf(ctx), {
        id,
        text: ctx.body.text,
        kind: ctx.body.kind,
        confidence: ctx.body.confidence,
      });
      redirect(ctx.res, `/admin/entry?id=${encodeURIComponent(entry.id)}`);
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      correctPage(ctx, 400, {
        entry: ctx.service.entry(id).entry,
        text: field(ctx, 'text'),
        kind: field(ctx, 'kind'),
        confidence: field(ctx, 'confidence'),
        error: err.message,
      });
    }
  }),
  page('GET', '/remember', 'session', (ctx) =>
    rememberPage(ctx, 200, { event: ctx.service.event(query(ctx, 'event')).event }),
  ),
  page('POST', '/remember', 'session', (ctx) => {
    const eventId = field(ctx, 'event');
    try {
      const entry = ctx.service.remember(actorOf(ctx), {
        eventId,
        kind: ctx.body.kind,
        text: ctx.body.text,
        confidence: ctx.body.confidence,
        quote: ctx.body.quote,
      });
      redirect(ctx.res, `/admin/entry?id=${encodeURIComponent(entry.id)}`);
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      rememberPage(ctx, 400, {
        event: ctx.service.event(eventId).event,
        kind: field(ctx, 'kind'),
        text: field(ctx, 'text'),
        quote: field(ctx, 'quote'),
        confidence: field(ctx, 'confidence'),
        error: err.message,
      });
    }
  }),
  page('GET', '/forget', 'fresh', (ctx) => {
    const id = query(ctx, 'id');
    forgetPage(ctx, 200, { id, plan: ctx.service.forgetPlan(id) });
  }),
  page(
    'POST',
    '/forget',
    'fresh',
    (ctx) => {
      const id = field(ctx, 'id');
      try {
        const result = ctx.service.forget(actorOf(ctx), {
          id,
          digest: ctx.body.digest,
          confirm: ctx.body.confirm,
          reason: ctx.body.reason,
        });
        forgottenPage(ctx, result);
      } catch (err) {
        const status =
          err instanceof HttpError && err.status === 409
            ? 409
            : err instanceof OriginError
              ? 400
              : 0;
        if (status === 0) throw err;
        forgetPage(ctx, status, {
          id,
          plan: ctx.service.forgetPlan(id),
          reason: field(ctx, 'reason'),
          error: (err as Error).message,
        });
      }
    },
    (ctx) => `/admin/forget?id=${encodeURIComponent(field(ctx, 'id'))}`,
  ),

  page('GET', '/tombstones', 'session', (ctx) =>
    tombstonesPage(ctx, ctx.service.tombstones(beforeParam(ctx))),
  ),
  page('GET', '/audit', 'session', (ctx) => auditPage(ctx, ctx.service.auditLog(beforeParam(ctx)))),
  page('GET', '/signins', 'session', (ctx) => {
    const n = Number(query(ctx, 'revoked'));
    signinsPage(
      ctx,
      ctx.service.adminSessions(ctx.now),
      Number.isInteger(n) && query(ctx, 'revoked') !== ''
        ? ctx.t('signins.revokedNotice', { n })
        : undefined,
    );
  }),
  page(
    'POST',
    '/signins/revoke',
    'fresh',
    (ctx) => {
      const n = ctx.service.revokeSessions(
        actorOf(ctx),
        { handle: ctx.body.handle, currentIdHash: ctx.session?.idHash ?? '' },
        ctx.now,
      );
      redirect(ctx.res, `/admin/signins?revoked=${n}`);
    },
    () => '/admin/signins',
  ),
];

// ---------------------------------------------------------------------------------------------
// JSON API: the same service as the pages. Ids go in query parameters (they contain ':' and '#').

const api = (method: 'GET' | 'POST', name: string, auth: RouteAuth, run: Route['run']): Route => ({
  method,
  path: `/admin/api/${name}`,
  auth,
  run,
});

const API: Route[] = [
  api('GET', 'session', 'none', (ctx) =>
    json(
      ctx,
      200,
      ctx.session
        ? {
            signedIn: true,
            key: ctx.session.keyName,
            fresh: isAdminSessionFresh(ctx.session, ctx.now),
            csrf: ctx.session.csrf,
          }
        : { signedIn: false },
    ),
  ),
  api('POST', 'login', 'none', (ctx, s) => {
    const r = checkKey(ctx, s, ctx.body.key, 'login');
    if (!r.ok) return json(ctx, r.status, { error: r.message, retryAfterSec: r.retryAfterSec });
    const csrf = startSession(ctx, s, r.name);
    json(ctx, 200, { signedIn: true, key: r.name, fresh: true, csrf });
  }),
  api('POST', 'logout', 'session', (ctx, s) => {
    endSession(ctx, s);
    json(ctx, 200, { signedIn: false });
  }),
  api('POST', 'reauth', 'session', (ctx, s) => {
    const r = checkKey(ctx, s, ctx.body.key, 'reauth');
    if (!r.ok) return json(ctx, r.status, { error: r.message, retryAfterSec: r.retryAfterSec });
    markAdminSessionFresh(s.db, ctx.session?.idHash ?? '', ctx.now);
    s.service.recordAuth(actorOf(ctx), 'reauth');
    json(ctx, 200, { fresh: true });
  }),

  api('GET', 'overview', 'session', (ctx) => json(ctx, 200, ctx.service.overview(ctx.now))),
  api('GET', 'devices', 'session', (ctx) =>
    json(ctx, 200, { devices: ctx.service.devices(ctx.now) }),
  ),
  api('GET', 'device', 'session', (ctx) =>
    json(ctx, 200, ctx.service.device(query(ctx, 'name'), ctx.now)),
  ),
  api('GET', 'tokens', 'session', (ctx) => json(ctx, 200, { tokens: ctx.service.tokens() })),
  api('POST', 'tokens', 'fresh', (ctx) =>
    json(ctx, 201, ctx.service.createToken(actorOf(ctx), ctx.body.name)),
  ),
  api('POST', 'token-revoke', 'fresh', (ctx) => {
    ctx.service.revokeToken(actorOf(ctx), ctx.body.name);
    json(ctx, 200, { revoked: ctx.body.name });
  }),
  api('GET', 'projects', 'session', (ctx) => json(ctx, 200, { projects: ctx.service.projects() })),
  api('GET', 'sessions', 'session', (ctx) =>
    json(
      ctx,
      200,
      ctx.service.sessions({
        source: query(ctx, 'source'),
        project: query(ctx, 'project'),
        page: pageParam(ctx),
      }),
    ),
  ),
  api('GET', 'session-events', 'session', (ctx) =>
    json(
      ctx,
      200,
      ctx.service.sessionEvents(query(ctx, 'source'), query(ctx, 'id'), {
        tools: flag(query(ctx, 'tools')),
        page: pageParam(ctx),
      }),
    ),
  ),
  api('GET', 'event', 'session', (ctx) => json(ctx, 200, ctx.service.event(query(ctx, 'id')))),
  api('GET', 'event-raw', 'session', (ctx) =>
    json(ctx, 200, ctx.service.eventRaw(query(ctx, 'id'))),
  ),
  api('GET', 'search', 'session', (ctx) =>
    json(
      ctx,
      200,
      ctx.service.search(query(ctx, 'q'), {
        tools: flag(query(ctx, 'tools')),
        scope: query(ctx, 'scope'),
      }),
    ),
  ),
  api('GET', 'entries', 'session', (ctx) =>
    json(
      ctx,
      200,
      ctx.service.entries({
        kind: query(ctx, 'kind'),
        project: query(ctx, 'project'),
        history: flag(query(ctx, 'history')),
        page: pageParam(ctx),
      }),
    ),
  ),
  api('POST', 'entries', 'session', (ctx) =>
    json(ctx, 201, {
      entry: ctx.service.remember(actorOf(ctx), {
        eventId: ctx.body.eventId,
        kind: ctx.body.kind,
        text: ctx.body.text,
        confidence: ctx.body.confidence,
        quote: ctx.body.quote,
      }),
    }),
  ),
  api('GET', 'entry', 'session', (ctx) => json(ctx, 200, ctx.service.entry(query(ctx, 'id')))),
  api('POST', 'correct', 'session', (ctx) =>
    json(ctx, 201, {
      entry: ctx.service.correct(actorOf(ctx), {
        id: ctx.body.id,
        text: ctx.body.text,
        kind: ctx.body.kind,
        confidence: ctx.body.confidence,
      }),
    }),
  ),
  api('GET', 'forget-plan', 'session', (ctx) =>
    json(ctx, 200, ctx.service.forgetPlan(query(ctx, 'id'))),
  ),
  api('POST', 'forget', 'fresh', (ctx) => {
    const r = ctx.service.forget(actorOf(ctx), {
      id: ctx.body.id,
      digest: ctx.body.digest,
      confirm: ctx.body.confirm,
      reason: ctx.body.reason,
    });
    json(ctx, 200, {
      target: r.target,
      targetType: r.targetType,
      tombstoneId: r.tombstoneId,
      entries: r.entries.length,
      events: r.events.length,
    });
  }),
  api('GET', 'tombstones', 'session', (ctx) =>
    json(ctx, 200, ctx.service.tombstones(beforeParam(ctx))),
  ),
  api('GET', 'audit', 'session', (ctx) => json(ctx, 200, ctx.service.auditLog(beforeParam(ctx)))),
  api('GET', 'connect', 'session', (ctx) => json(ctx, 200, ctx.service.connect())),
  api('GET', 'admin-sessions', 'session', (ctx) =>
    json(ctx, 200, {
      current: ctx.session?.handle,
      sessions: ctx.service.adminSessions(ctx.now),
    }),
  ),
  api('POST', 'sessions-revoke', 'fresh', (ctx) =>
    json(ctx, 200, {
      revoked: ctx.service.revokeSessions(
        actorOf(ctx),
        { handle: ctx.body.handle, currentIdHash: ctx.session?.idHash ?? '' },
        ctx.now,
      ),
    }),
  ),
];

const ROUTES = [...PAGES, ...API];

/**
 * Every route of the admin UI: only GET and POST, and every write is a POST. This list is the
 * whole surface; tests pin the writes so that nothing beyond them (editing or deleting events,
 * mirrors, entries, or tombstones; un-forgetting; creating admin keys) can appear unnoticed.
 */
export const ADMIN_ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST';
  path: string;
  auth: RouteAuth;
}> = ROUTES.map(({ method, path, auth }) => ({ method, path, auth }));

// ---------------------------------------------------------------------------------------------
// Dispatch

function sessionFrom(req: IncomingMessage, s: State, now: number) {
  const cookies = parseCookies(req.headers.cookie);
  for (const name of [SECURE_SESSION_COOKIE, PLAIN_SESSION_COOKIE]) {
    const value = cookies.get(name);
    if (!value) continue;
    const session = getAdminSession(s.db, value, { envHashes: s.envKeyHashes, now });
    if (session) return session;
  }
  return null;
}

async function dispatch(
  s: State,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctxRef: { ctx?: Ctx },
): Promise<void> {
  const origins = requestOrigins(req, s.publicUrl);
  for (const [k, v] of Object.entries(securityHeaders(s.publicUrl?.protocol === 'https:'))) {
    res.setHeader(k, v);
  }
  if (origins.public === null && origins.local === null) {
    // No public URL: answer only loopback connections addressed to a loopback name, which also
    // defeats DNS rebinding.
    sendText(
      res,
      421,
      'The admin UI answers only on loopback addresses unless a public URL is configured.',
    );
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const lang = negotiateLang(cookies.get(LANG_COOKIE), req.headers['accept-language']);
  const themeCookie = cookies.get(THEME_COOKIE);
  const theme: Theme = themeCookie === 'light' || themeCookie === 'dark' ? themeCookie : 'auto';
  const now = s.now();
  const ctx: Ctx = {
    req,
    res,
    url,
    now,
    lang,
    t: translator(lang),
    theme,
    session: null,
    body: {},
    origins,
    secure: origins.publicSecure && origins.local === null,
    service: s.service,
    assets: s.assets,
    version: s.version,
    ip: clientIpOf(req, s.clientIpHeader),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
  ctxRef.ctx = ctx;

  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    throw new HttpError(405, 'Method not allowed.');
  }
  if (url.pathname === '/admin') return redirect(res, '/admin/');

  if (url.pathname.startsWith('/admin/assets/')) {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, 'Method not allowed.');
    }
    const asset = s.assets.find(url.pathname.slice('/admin/assets/'.length));
    if (!asset) throw new HttpError(404, 'Not found.');
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...(asset.type.startsWith('image/svg')
        ? { 'Content-Security-Policy': SVG_CSP }
        : { 'Content-Security-Policy': CSP }),
    });
    res.end(asset.body);
    return;
  }

  const route = ROUTES.find((r) => r.path === url.pathname && r.method === method);
  if (!route) {
    const allowed = ROUTES.filter((r) => r.path === url.pathname).map((r) => r.method);
    if (allowed.length > 0) {
      res.setHeader('Allow', allowed.join(', '));
      throw new HttpError(405, 'Method not allowed.');
    }
    throw new HttpError(404, 'Not found.');
  }
  const isApi = url.pathname.startsWith('/admin/api/');

  if (method === 'POST') {
    ctx.secure = checkSameOrigin(req, origins).secure;
    ctx.body = parseBody(req, await readBody(req));
  } else if (isApi) {
    rejectCrossSite(req);
  }

  ctx.session = sessionFrom(req, s, now);
  if (route.auth !== 'none') {
    if (!ctx.session) {
      if (isApi) throw new HttpError(401, 'Sign in first.');
      return redirect(
        res,
        method === 'GET' ? `/admin/login?next=${encodeURIComponent(here(ctx))}` : '/admin/login',
      );
    }
    if (method === 'POST') {
      const header = req.headers['x-csrf-token'];
      const token = typeof header === 'string' ? header : ctx.body._csrf;
      if (typeof token !== 'string' || !safeEqual(token, ctx.session.csrf)) {
        throw new HttpError(403, 'Missing or invalid CSRF token. Reload the page and try again.');
      }
    }
    if (route.auth === 'fresh' && !isAdminSessionFresh(ctx.session, now)) {
      if (isApi) {
        throw new HttpError(403, 'Enter your admin key again (POST /admin/api/reauth).', {
          reauth: true,
        });
      }
      const back = method === 'GET' ? here(ctx) : (route.back?.(ctx) ?? '/admin/');
      return redirect(res, `/admin/reauth?next=${encodeURIComponent(safeNext(back))}`);
    }
  }
  await route.run(ctx, s);
}

export function createAdminHandler(options: AdminOptions): AdminHandler {
  const now = options.now ?? Date.now;
  const publicUrl = options.publicUrl ?? null;
  const state: State = {
    db: options.db,
    publicUrl,
    clientIpHeader: options.clientIpHeader?.trim() || null,
    envKeyHashes: options.envKeyHashes ?? [],
    version: options.version,
    service: new AdminService({
      db: options.db,
      home: options.home,
      version: options.version,
      startedAt: options.startedAt ?? now(),
      publicUrl,
      envKeyHashes: options.envKeyHashes ?? [],
    }),
    assets: new Assets(),
    limiter: new LoginLimiter(options.loginLimits ?? LOGIN_LIMITS),
    log: options.log ?? (() => {}),
    now,
  };
  return async (req, res, url) => {
    const ref: { ctx?: Ctx } = {};
    try {
      await dispatch(state, req, res, url, ref);
    } catch (err) {
      const known = err instanceof HttpError || err instanceof OriginError;
      const status = err instanceof HttpError ? err.status : err instanceof OriginError ? 400 : 500;
      if (!known) state.log(`admin error: ${(err as Error)?.stack ?? String(err)}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = known ? (err as Error).message : 'Internal error.';
      const extra = err instanceof HttpError ? err.extra : {};
      if (url.pathname.startsWith('/admin/api/') || !ref.ctx) {
        sendJson(res, status, { error: message, ...extra });
        return;
      }
      try {
        errorPage(ref.ctx, status, message);
      } catch {
        sendText(res, status, message);
      }
    }
  };
}
