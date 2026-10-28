import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdminCredential,
  type Database,
  OriginError,
  verifyAdminPassword,
} from '@openlinkos/origin-core';
import { Assets } from './assets.js';
import {
  type AdminMode,
  actorOf,
  type Ctx,
  field,
  pageParam,
  query,
  type Theme,
} from './context.js';
import {
  appendCookie,
  CSP,
  checkSameOrigin,
  clientIp as clientIpOf,
  HttpError,
  LOCAL_SESSION_COOKIE,
  localHosts,
  localRequestOrigins,
  localSessionCookie,
  PLAIN_SESSION_COOKIE,
  parseBody,
  parseCookies,
  type RequestOrigins,
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
import { errorPage, localLoginPage, loginPage, reauthPage } from './pages/auth.js';
import { eventPage, eventRawPage, searchPage, sessionsPage } from './pages/browse.js';
import { beforeParam, beforeTombstone } from './pages/components.js';
import {
  correctPage,
  entriesPage,
  entryPage,
  forgetPage,
  forgottenPage,
  rememberPage,
  restoredPage,
} from './pages/entries.js';
import { here } from './pages/layout.js';
import { connectPage, devicePage, devicesPage, overviewPage } from './pages/overview.js';
import { recallPage, recallsPage } from './pages/recalls.js';
import { auditPage, signinsPage, tombstonePage, tombstonesPage } from './pages/records.js';
import { sessionPage } from './pages/session.js';
import { newTokenPage, revokeTokenPage, tokenCreatedPage, tokensPage } from './pages/tokens.js';
import { queryAll } from './pages/workbench.js';
import { CheckQueue, type LimiterOptions, LOGIN_LIMITS, LoginLimiter } from './ratelimit.js';
import {
  AdminService,
  type EntryBoardFilter,
  type HubLink,
  type RecallBoardFilter,
  SESSION_RANGES,
  SESSION_SORTS,
  type SessionBoardFilter,
  TRACE_SHOWS,
} from './service.js';
import { MemorySessions, type SessionStore, SignInLink, storedSessions } from './sessions.js';

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
  /**
   * What sign-in checks the admin password against: ORIGIN_ADMIN_PASSWORD (as a hash) or the stored
   * password, as settled by prepareAdminCredential when the hub starts. Defaults to the stored one.
   */
  credential?: AdminCredential;
  /** When the hub started, for the uptime shown on the overview. */
  startedAt?: number;
  log?: (message: string) => void;
  /** Clock and limits, for tests. */
  now?: () => number;
  loginLimits?: LimiterOptions;
}

/** Handles every request under /admin. Never throws; the caller routes /admin and /admin/* to it. */
export type AdminHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/**
 * `origin ui`: the admin UI for a device's own store, on 127.0.0.1 (see
 * docs/architecture.md#admin-ui). There is no password: the owner signs in with a one-time link
 * that the CLI prints and opens.
 */
export interface LocalAdminOptions {
  db: Database;
  home: string;
  version: string;
  /** The port `origin ui` listens on: requests must name it, with 127.0.0.1 or localhost, as Host. */
  port: number;
  /** The hub this device is connected to, for the overview; null when it is not connected. */
  hub?: () => HubLink | null;
  /** Called after an entry is written or something is forgotten, for a sync with the hub. */
  afterWrite?: () => void;
  /** Messages for the terminal of `origin ui`: sign-ins, and errors. */
  log?: (message: string) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export interface LocalAdmin {
  handler: AdminHandler;
  /**
   * Issue the one-time sign-in link: a path with a new secret, which works once, within
   * SIGN_IN_LINK_MS. An earlier link stops working.
   */
  signInPath(): string;
}

interface State {
  mode: AdminMode;
  db: Database;
  publicUrl: URL | null;
  clientIpHeader: string | null;
  credential: AdminCredential;
  version: string;
  service: AdminService;
  sessions: SessionStore;
  /** `origin ui` only: the Host values it answers to, and its sign-in link. */
  local: { hosts: ReadonlySet<string>; link: SignInLink; failureLoggedAt: number | null } | null;
  assets: Assets;
  limiter: LoginLimiter;
  checks: CheckQueue;
  log: (message: string) => void;
  now: () => number;
}

/**
 * `none`: no session needed. `session`: signed in. `fresh`: signed in, and the password entered
 * within the last 10 minutes (token create and revoke, revoking sessions).
 */
export type RouteAuth = 'none' | 'session' | 'fresh';

interface Route {
  method: 'GET' | 'POST';
  path: string;
  auth: RouteAuth;
  run: (ctx: Ctx, s: State) => Promise<void> | void;
  /** For fresh POSTs from pages: the page to return to after re-authenticating. */
  back?: (ctx: Ctx) => string;
  /** The modes that have this route; both when absent. */
  modes?: readonly AdminMode[];
}

const HUB: readonly AdminMode[] = ['hub'];
const LOCAL: readonly AdminMode[] = ['local'];

const LANG_COOKIE = 'origin-admin-lang';
const THEME_COOKIE = 'origin-admin-theme';
const YEAR = 365 * 86_400;

function json(ctx: Ctx, status: number, value: unknown): void {
  sendJson(ctx.res, status, value);
}

const flag = (v: unknown) => v === '1' || v === 'true' || v === true;

/** A turn or part number from the query, or undefined. */
function turnParam(ctx: Ctx, name: 'turn' | 'part'): number | undefined {
  const value = query(ctx, name);
  const n = Number(value);
  return value !== '' && Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : undefined;
}

/** One of a few values of a query parameter, or the default. */
function choice<T extends string>(ctx: Ctx, name: string, values: readonly T[], fallback: T): T {
  const v = query(ctx, name);
  return (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** The filters of the sessions page, from its query. */
function sessionFilter(ctx: Ctx): SessionBoardFilter {
  return {
    agents: [...queryAll(ctx, 'agent'), ...queryAll(ctx, 'source')]
      .slice(0, 20)
      .map((v) => v.slice(0, 64)),
    projects: queryAll(ctx, 'project')
      .slice(0, 50)
      .map((v) => v.slice(0, 200)),
    range: choice(ctx, 'range', SESSION_RANGES, '30d'),
    q: query(ctx, 'q').trim().slice(0, 200),
    recalled: flag(query(ctx, 'recalled')),
    name: choice(ctx, 'name', ['any', 'titled', 'provisional'] as const, 'any'),
    sort: choice(ctx, 'sort', SESSION_SORTS, 'recent'),
    page: pageParam(ctx),
  };
}

function entryFilter(ctx: Ctx): EntryBoardFilter {
  const few = (name: string, max: number) =>
    queryAll(ctx, name)
      .slice(0, max)
      .map((v) => v.slice(0, 200));
  return {
    kinds: few('kind', 3),
    projects: few('project', 50),
    authors: few('author', 20),
    origin: choice(ctx, 'origin', ['any', 'imported', 'written'] as const, 'any'),
    recalled: flag(query(ctx, 'recalled')),
    history: flag(query(ctx, 'history')),
    range: choice(ctx, 'range', SESSION_RANGES, 'all'),
    q: query(ctx, 'q').trim().slice(0, 200),
    page: pageParam(ctx),
  };
}

function recallFilter(ctx: Ctx): RecallBoardFilter {
  const few = (name: string) =>
    queryAll(ctx, name)
      .slice(0, 20)
      .map((v) => v.slice(0, 64));
  return {
    agents: few('agent'),
    occasions: few('occasion'),
    devices: few('device'),
    range: choice(ctx, 'range', SESSION_RANGES, '30d'),
    handed: flag(query(ctx, 'all'))
      ? 'any'
      : choice(ctx, 'handed', ['some', 'none', 'any'] as const, 'some'),
    page: pageParam(ctx),
  };
}

const turnOptions = (ctx: Ctx) => ({
  turn: turnParam(ctx, 'turn'),
  part: turnParam(ctx, 'part'),
  at: query(ctx, 'at').slice(0, 512) || undefined,
});

// ---------------------------------------------------------------------------------------------
// Authentication

type PasswordCheck =
  | { ok: true }
  | { ok: false; status: 401 | 429; message: string; retryAfterSec?: number };

/** Seconds a client is told to wait when too many checks are already queued. */
const BUSY_RETRY_SEC = 5;

/**
 * Check the admin password, one check at a time and subject to the failure limit. Failures are
 * written to the audit log once per window and client (the first failure, then the block), not
 * once per attempt.
 */
async function checkPassword(
  ctx: Ctx,
  s: State,
  password: unknown,
  mode: 'login' | 'reauth',
): Promise<PasswordCheck> {
  const client = ctx.ip ?? 'unknown';
  const queued = s.checks.run(async (): Promise<PasswordCheck> => {
    const limit = s.limiter.check(client, ctx.now);
    if (!limit.ok) {
      if (limit.firstBlock) {
        s.service.recordAuth(actorOf(ctx), `${mode}.blocked`, {
          retryAfterSec: limit.retryAfterSec,
        });
      }
      return {
        ok: false,
        status: 429,
        retryAfterSec: limit.retryAfterSec,
        message: ctx.t('auth.tooMany', { min: Math.ceil(limit.retryAfterSec / 60) }),
      };
    }
    if (!(await verifyAdminPassword(s.db, s.credential, password))) {
      const failures = s.limiter.fail(client, ctx.now);
      if (failures === 1) s.service.recordAuth(actorOf(ctx), `${mode}.failed`, { failures });
      return { ok: false, status: 401, message: ctx.t('auth.badPassword') };
    }
    return { ok: true };
  });
  const result: PasswordCheck = (await queued) ?? {
    ok: false,
    status: 429,
    retryAfterSec: BUSY_RETRY_SEC,
    message: ctx.t('auth.busy'),
  };
  if (!result.ok && result.retryAfterSec !== undefined) {
    ctx.res.setHeader('Retry-After', String(result.retryAfterSec));
  }
  return result;
}

/** Start a new session (never reusing one presented with the request) and set its cookie. */
function startSession(ctx: Ctx, s: State): string {
  if (ctx.session) s.sessions.end(ctx.session, ctx.now);
  const { id, session } = s.sessions.create({ ip: ctx.ip, userAgent: ctx.userAgent }, ctx.now);
  appendCookie(
    ctx.res,
    s.mode === 'local' ? localSessionCookie(id) : sessionCookie(id, ctx.secure),
  );
  ctx.session = session;
  s.service.recordAuth(actorOf(ctx), 'login');
  return session.csrf;
}

function endSession(ctx: Ctx, s: State): void {
  if (ctx.session) {
    s.service.recordAuth(actorOf(ctx), 'logout');
    s.sessions.end(ctx.session, ctx.now);
  }
  if (s.mode === 'local') {
    appendCookie(ctx.res, localSessionCookie('', 0));
  } else {
    appendCookie(ctx.res, sessionCookie('', true, 0));
    appendCookie(ctx.res, sessionCookie('', false, 0));
  }
  ctx.session = null;
}

/** Failed sign-in links are written to the audit log at most once per this window. */
const LINK_FAILURE_LOG_MS = 10 * 60_000;

/**
 * `origin ui`: exchange the one-time secret of the sign-in link for a session, then redirect to a
 * clean URL, so that the secret stays neither in the address bar nor in a referrer. The secret is
 * the only credential and is long and random, so there is nothing to rate-limit; failures are
 * recorded once per window, so that requests cannot flood the append-only audit log.
 */
function redeemLink(ctx: Ctx, s: State): void {
  const local = s.local;
  if (!local) throw new HttpError(404, 'Not found.');
  const next = safeNext(query(ctx, 'next'));
  const secret = ctx.url.searchParams.get('secret');
  if (secret === null) {
    if (ctx.session) redirect(ctx.res, next);
    else localLoginPage(ctx, 200, {});
    return;
  }
  const result = local.link.redeem(secret, ctx.now);
  if (result === 'ok') {
    startSession(ctx, s);
    s.log('Signed in. The sign-in link no longer works.');
    redirect(ctx.res, next);
    return;
  }
  // Opening the link again in a browser that is already signed in is harmless.
  if (result === 'used' && ctx.session) {
    redirect(ctx.res, next);
    return;
  }
  if (result === 'used') {
    s.log(
      'The sign-in link was opened again after it had been used. If you did not sign in yourself, stop origin ui.',
    );
  }
  if (local.failureLoggedAt === null || ctx.now - local.failureLoggedAt >= LINK_FAILURE_LOG_MS) {
    local.failureLoggedAt = ctx.now;
    s.service.recordAuth(actorOf(ctx), 'login.failed', { [result]: 1 });
  }
  localLoginPage(ctx, 401, { error: ctx.t(`local.link.${result}`) });
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
  modes?: readonly AdminMode[],
): Route => ({
  method,
  path: `/admin${path}`,
  auth,
  run,
  back,
  modes,
});

/** A page of the hub's admin UI only. */
const hubPage = (
  method: 'GET' | 'POST',
  path: string,
  auth: RouteAuth,
  run: Route['run'],
  back?: Route['back'],
): Route => page(method, path, auth, run, back, HUB);

const PAGES: Route[] = [
  page('GET', '/', 'session', (ctx) => overviewPage(ctx, ctx.service.overview(ctx.now))),

  hubPage('GET', '/login', 'none', (ctx) => {
    const next = safeNext(query(ctx, 'next'));
    if (ctx.session) return redirect(ctx.res, next);
    loginPage(ctx, 200, { next });
  }),
  page('GET', '/login', 'none', redeemLink, undefined, LOCAL),
  hubPage('POST', '/login', 'none', async (ctx, s) => {
    const next = safeNext(field(ctx, 'next'));
    const r = await checkPassword(ctx, s, ctx.body.password, 'login');
    if (!r.ok) return loginPage(ctx, r.status, { next, error: r.message });
    startSession(ctx, s);
    redirect(ctx.res, next);
  }),
  page('POST', '/logout', 'session', (ctx, s) => {
    endSession(ctx, s);
    redirect(ctx.res, '/admin/login');
  }),
  hubPage('GET', '/reauth', 'session', (ctx) =>
    reauthPage(ctx, 200, { next: safeNext(query(ctx, 'next')) }),
  ),
  hubPage('POST', '/reauth', 'session', async (ctx, s) => {
    const next = safeNext(field(ctx, 'next'));
    const r = await checkPassword(ctx, s, ctx.body.password, 'reauth');
    if (!r.ok) return reauthPage(ctx, r.status, { next, error: r.message });
    if (ctx.session) s.sessions.markFresh(ctx.session, ctx.now);
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

  hubPage('GET', '/devices', 'session', (ctx) => devicesPage(ctx, ctx.service.devices(ctx.now))),
  hubPage('GET', '/device', 'session', (ctx) =>
    devicePage(ctx, ctx.service.device(query(ctx, 'name'), ctx.now)),
  ),
  hubPage('GET', '/connect', 'session', (ctx) => connectPage(ctx, ctx.service.connect())),

  hubPage('GET', '/tokens', 'session', (ctx) => {
    const revoked = query(ctx, 'revoked');
    tokensPage(
      ctx,
      ctx.service.tokens(),
      revoked ? ctx.t('tokens.revokedNotice', { name: revoked }) : undefined,
    );
  }),
  hubPage('GET', '/tokens/new', 'fresh', (ctx) => newTokenPage(ctx, 200, {})),
  hubPage(
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
  hubPage('GET', '/tokens/revoke', 'fresh', (ctx) =>
    revokeTokenPage(ctx, 200, { name: query(ctx, 'name') }),
  ),
  hubPage(
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
    const filter = sessionFilter(ctx);
    sessionsPage(ctx, { ...ctx.service.sessionBoard(filter, ctx.now), filter });
  }),
  page('GET', '/session', 'session', (ctx) => {
    const r = ctx.service.sessionTrace(query(ctx, 'source'), query(ctx, 'id'), {
      ...turnOptions(ctx),
      show: choice(ctx, 'show', TRACE_SHOWS, 'all'),
    });
    sessionPage(ctx, { ...r, open: flag(query(ctx, 'tools')) });
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
    const filter = entryFilter(ctx);
    entriesPage(ctx, { ...ctx.service.entryBoard(filter, ctx.now), filter });
  }),
  page('GET', '/entry', 'session', (ctx) => entryPage(ctx, ctx.service.entry(query(ctx, 'id')))),
  page('GET', '/recalls', 'session', (ctx) => {
    const filter = recallFilter(ctx);
    recallsPage(ctx, { ...ctx.service.recallBoard(filter, ctx.now), filter });
  }),
  page('GET', '/recall', 'session', (ctx) => recallPage(ctx, ctx.service.recall(query(ctx, 'id')))),
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
  page('GET', '/forget', 'session', (ctx) => {
    const id = query(ctx, 'id');
    forgetPage(ctx, 200, { id, plan: ctx.service.forgetPlan(id) });
  }),
  page('POST', '/forget', 'session', (ctx) => {
    const id = field(ctx, 'id');
    try {
      const result = ctx.service.forget(actorOf(ctx), {
        id,
        digest: ctx.body.digest,
        reason: ctx.body.reason,
      });
      forgottenPage(ctx, result);
    } catch (err) {
      const status =
        err instanceof HttpError && err.status === 409 ? 409 : err instanceof OriginError ? 400 : 0;
      if (status === 0) throw err;
      forgetPage(ctx, status, {
        id,
        plan: ctx.service.forgetPlan(id),
        reason: field(ctx, 'reason'),
        error: (err as Error).message,
      });
    }
  }),

  page('GET', '/tombstones', 'session', (ctx) =>
    tombstonesPage(ctx, ctx.service.tombstones(beforeTombstone(ctx))),
  ),
  page('GET', '/tombstone', 'session', (ctx) =>
    tombstonePage(ctx, 200, { detail: ctx.service.tombstone(query(ctx, 'id')) }),
  ),
  page('POST', '/restore', 'session', (ctx) => {
    const id = field(ctx, 'id');
    try {
      restoredPage(ctx, ctx.service.restore(actorOf(ctx), { id, reason: ctx.body.reason }));
    } catch (err) {
      if (!(err instanceof OriginError)) throw err;
      tombstonePage(ctx, 400, {
        detail: ctx.service.tombstone(id),
        reason: field(ctx, 'reason'),
        error: err.message,
      });
    }
  }),
  page('GET', '/audit', 'session', (ctx) => auditPage(ctx, ctx.service.auditLog(beforeParam(ctx)))),
  hubPage('GET', '/signins', 'session', (ctx) => {
    const n = Number(query(ctx, 'revoked'));
    signinsPage(
      ctx,
      ctx.service.adminSessions(ctx.now),
      Number.isInteger(n) && query(ctx, 'revoked') !== ''
        ? ctx.t('signins.revokedNotice', { n })
        : undefined,
    );
  }),
  hubPage(
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

const api = (
  method: 'GET' | 'POST',
  name: string,
  auth: RouteAuth,
  run: Route['run'],
  modes?: readonly AdminMode[],
): Route => ({
  method,
  path: `/admin/api/${name}`,
  auth,
  run,
  modes,
});

/** A JSON call of the hub's admin UI only. */
const hubApi = (method: 'GET' | 'POST', name: string, auth: RouteAuth, run: Route['run']): Route =>
  api(method, name, auth, run, HUB);

const API: Route[] = [
  api('GET', 'session', 'none', (ctx, s) =>
    json(
      ctx,
      200,
      ctx.session
        ? {
            signedIn: true,
            fresh: s.sessions.isFresh(ctx.session, ctx.now),
            csrf: ctx.session.csrf,
          }
        : { signedIn: false },
    ),
  ),
  hubApi('POST', 'login', 'none', async (ctx, s) => {
    const r = await checkPassword(ctx, s, ctx.body.password, 'login');
    if (!r.ok) return json(ctx, r.status, { error: r.message, retryAfterSec: r.retryAfterSec });
    const csrf = startSession(ctx, s);
    json(ctx, 200, { signedIn: true, fresh: true, csrf });
  }),
  api('POST', 'logout', 'session', (ctx, s) => {
    endSession(ctx, s);
    json(ctx, 200, { signedIn: false });
  }),
  hubApi('POST', 'reauth', 'session', async (ctx, s) => {
    const r = await checkPassword(ctx, s, ctx.body.password, 'reauth');
    if (!r.ok) return json(ctx, r.status, { error: r.message, retryAfterSec: r.retryAfterSec });
    if (ctx.session) s.sessions.markFresh(ctx.session, ctx.now);
    s.service.recordAuth(actorOf(ctx), 'reauth');
    json(ctx, 200, { fresh: true });
  }),

  api('GET', 'overview', 'session', (ctx) => json(ctx, 200, ctx.service.overview(ctx.now))),
  hubApi('GET', 'devices', 'session', (ctx) =>
    json(ctx, 200, { devices: ctx.service.devices(ctx.now) }),
  ),
  hubApi('GET', 'device', 'session', (ctx) =>
    json(ctx, 200, ctx.service.device(query(ctx, 'name'), ctx.now)),
  ),
  hubApi('GET', 'tokens', 'session', (ctx) => json(ctx, 200, { tokens: ctx.service.tokens() })),
  hubApi('POST', 'tokens', 'fresh', (ctx) =>
    json(ctx, 201, ctx.service.createToken(actorOf(ctx), ctx.body.name)),
  ),
  hubApi('POST', 'token-revoke', 'fresh', (ctx) => {
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
        q: query(ctx, 'q'),
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
  api('GET', 'session-turns', 'session', (ctx) =>
    json(
      ctx,
      200,
      ctx.service.sessionTurns(query(ctx, 'source'), query(ctx, 'id'), turnOptions(ctx)),
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
  api('GET', 'recalls', 'session', (ctx) =>
    json(
      ctx,
      200,
      ctx.service.recalls({
        device: query(ctx, 'device'),
        agent: query(ctx, 'agent'),
        all: flag(query(ctx, 'all')),
        page: pageParam(ctx),
      }),
    ),
  ),
  api('GET', 'recall', 'session', (ctx) => json(ctx, 200, ctx.service.recall(query(ctx, 'id')))),
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
  api('POST', 'forget', 'session', (ctx) => {
    const r = ctx.service.forget(actorOf(ctx), {
      id: ctx.body.id,
      digest: ctx.body.digest,
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
    json(ctx, 200, ctx.service.tombstones(beforeTombstone(ctx))),
  ),
  api('GET', 'tombstone', 'session', (ctx) =>
    json(ctx, 200, ctx.service.tombstone(query(ctx, 'id'))),
  ),
  api('POST', 'restore', 'session', (ctx) => {
    const r = ctx.service.restore(actorOf(ctx), { id: ctx.body.id, reason: ctx.body.reason });
    json(ctx, 200, {
      tombstoneId: r.tombstoneId,
      target: r.target,
      entries: r.entries.length,
      events: r.events.length,
    });
  }),
  api('GET', 'audit', 'session', (ctx) => json(ctx, 200, ctx.service.auditLog(beforeParam(ctx)))),
  hubApi('GET', 'connect', 'session', (ctx) => json(ctx, 200, ctx.service.connect())),
  hubApi('GET', 'admin-sessions', 'session', (ctx) =>
    json(ctx, 200, {
      current: ctx.session?.handle,
      sessions: ctx.service.adminSessions(ctx.now),
    }),
  ),
  hubApi('POST', 'sessions-revoke', 'fresh', (ctx) =>
    json(ctx, 200, {
      revoked: ctx.service.revokeSessions(
        actorOf(ctx),
        { handle: ctx.body.handle, currentIdHash: ctx.session?.idHash ?? '' },
        ctx.now,
      ),
    }),
  ),
];

/**
 * The routes of a mode. `origin ui` has no password to enter again, so its sensitive routes need
 * only its session (they are `fresh` on a hub).
 */
function routesFor(mode: AdminMode): Route[] {
  return [...PAGES, ...API]
    .filter((r) => r.modes === undefined || r.modes.includes(mode))
    .map((r): Route => (mode === 'local' && r.auth === 'fresh' ? { ...r, auth: 'session' } : r));
}

const ROUTES: Record<AdminMode, Route[]> = { hub: routesFor('hub'), local: routesFor('local') };

type RouteList = ReadonlyArray<{ method: 'GET' | 'POST'; path: string; auth: RouteAuth }>;
const routeList = (routes: Route[]): RouteList =>
  routes.map(({ method, path, auth }) => ({ method, path, auth }));

/**
 * Every route of the hub's admin UI: only GET and POST, and every write is a POST. This list is the
 * whole surface; tests pin the writes so that nothing beyond them (editing or deleting events,
 * mirrors, entries, or tombstones; changing the admin password) can appear unnoticed. Restoring a
 * forget is a write of its own: it adds a tombstone and deletes nothing.
 */
export const ADMIN_ROUTES: RouteList = routeList(ROUTES.hub);

/**
 * Every route of `origin ui`: the hub's, without the password (sign-in and re-authentication),
 * tokens, devices, connection commands, and admin sessions. Tests pin its writes too.
 */
export const LOCAL_ROUTES: RouteList = routeList(ROUTES.local);

// ---------------------------------------------------------------------------------------------
// Dispatch

function sessionFrom(req: IncomingMessage, s: State, origins: RequestOrigins, now: number) {
  const cookies = parseCookies(req.headers.cookie);
  // `origin ui` reads only its own cookie. Behind an https public URL, the plain cookie counts only
  // on a loopback tunnel: a sibling subdomain can plant an ordinary cookie for this host (session
  // fixation), but not a __Host- one.
  const names =
    s.mode === 'local'
      ? [LOCAL_SESSION_COOKIE]
      : origins.publicSecure && origins.local === null
        ? [SECURE_SESSION_COOKIE]
        : [SECURE_SESSION_COOKIE, PLAIN_SESSION_COOKIE];
  for (const name of names) {
    const value = cookies.get(name);
    if (!value) continue;
    const session = s.sessions.get(value, now);
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
  const origins = s.local
    ? localRequestOrigins(req, s.local.hosts)
    : requestOrigins(req, s.publicUrl);
  for (const [k, v] of Object.entries(securityHeaders(s.publicUrl?.protocol === 'https:'))) {
    res.setHeader(k, v);
  }
  if (origins.public === null && origins.local === null) {
    // No public URL: answer only loopback connections addressed to a loopback name, which also
    // defeats DNS rebinding. `origin ui` answers only to its own Host values.
    sendText(
      res,
      421,
      s.local
        ? `origin ui answers only at ${[...s.local.hosts].map((h) => `http://${h}`).join(' and ')}.`
        : 'The admin UI answers only on loopback addresses unless a public URL is configured.',
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
    mode: s.mode,
    lang,
    t: translator(lang),
    theme,
    session: null,
    body: {},
    origins,
    secure: origins.publicSecure && origins.local === null,
    service: s.service,
    assets: s.assets,
    icons: new Set(),
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

  const routes = ROUTES[s.mode];
  const route = routes.find((r) => r.path === url.pathname && r.method === method);
  if (!route) {
    const allowed = routes.filter((r) => r.path === url.pathname).map((r) => r.method);
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

  ctx.session = sessionFrom(req, s, origins, now);
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
    if (route.auth === 'fresh' && !s.sessions.isFresh(ctx.session, now)) {
      if (isApi) {
        throw new HttpError(403, 'Enter the admin password again (POST /admin/api/reauth).', {
          reauth: true,
        });
      }
      const back = method === 'GET' ? here(ctx) : (route.back?.(ctx) ?? '/admin/');
      return redirect(res, `/admin/reauth?next=${encodeURIComponent(safeNext(back))}`);
    }
  }
  await route.run(ctx, s);
}

/** The hub's admin UI. */
export function createAdminHandler(options: AdminOptions): AdminHandler {
  const now = options.now ?? Date.now;
  const publicUrl = options.publicUrl ?? null;
  return handlerFor({
    mode: 'hub',
    db: options.db,
    publicUrl,
    clientIpHeader: options.clientIpHeader?.trim() || null,
    credential: options.credential ?? { source: 'stored' },
    version: options.version,
    service: new AdminService({
      db: options.db,
      home: options.home,
      version: options.version,
      startedAt: options.startedAt ?? now(),
      publicUrl,
      hubStore: true,
    }),
    sessions: storedSessions(options.db),
    local: null,
    assets: new Assets(),
    limiter: new LoginLimiter(options.loginLimits ?? LOGIN_LIMITS),
    checks: new CheckQueue(),
    log: options.log ?? (() => {}),
    now,
  });
}

/**
 * `origin ui`: the admin UI for the local store. Its sessions and its sign-in link live in this
 * process only (see sessions.ts), and it answers only to 127.0.0.1 and localhost on `port`.
 */
export function createLocalAdmin(options: LocalAdminOptions): LocalAdmin {
  const now = options.now ?? Date.now;
  const link = new SignInLink();
  const handler = handlerFor({
    mode: 'local',
    db: options.db,
    publicUrl: null,
    clientIpHeader: null,
    // Never checked: `origin ui` has no password routes.
    credential: { source: 'stored' },
    version: options.version,
    service: new AdminService({
      db: options.db,
      home: options.home,
      version: options.version,
      startedAt: now(),
      publicUrl: null,
      hub: options.hub,
      afterWrite: options.afterWrite,
    }),
    sessions: new MemorySessions(),
    local: { hosts: localHosts(options.port), link, failureLoggedAt: null },
    assets: new Assets(),
    limiter: new LoginLimiter(LOGIN_LIMITS),
    checks: new CheckQueue(),
    log: options.log ?? (() => {}),
    now,
  });
  return {
    handler,
    signInPath: () => `/admin/login?secret=${link.issue(now())}`,
  };
}

function handlerFor(state: State): AdminHandler {
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
