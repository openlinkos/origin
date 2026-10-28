import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminSession } from '@openlinkos/origin-core';
import type { Assets } from './assets.js';
import { html, type SafeHtml } from './html.js';
import type { RequestOrigins } from './http.js';
import type { Lang, Translate } from './i18n/index.js';
import type { IconName } from './icons.js';
import type { Actor, AdminService } from './service.js';
import { HUB_ACTOR, LOCAL_ACTOR } from './sessions.js';

export type Theme = 'auto' | 'light' | 'dark';

/**
 * `hub`: the hub's admin UI, behind the admin password. `local`: `origin ui`, the same pages for
 * a device's own store on 127.0.0.1, signed in with a one-time link and without the hub's pages.
 */
export type AdminMode = 'hub' | 'local';

/** Everything a page or API handler needs for one request. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  now: number;
  mode: AdminMode;
  lang: Lang;
  t: Translate;
  theme: Theme;
  /** The signed-in session; null only on routes that do not require one. */
  session: AdminSession | null;
  /** Parsed form or JSON body of a POST. */
  body: Record<string, unknown>;
  origins: RequestOrigins;
  /** Whether cookies set by this response should be `Secure` (https public origin). */
  secure: boolean;
  service: AdminService;
  assets: Assets;
  /** Icons used by the page so far; the layout inlines their symbols. */
  icons: Set<IconName>;
  version: string;
  ip: string | null;
  userAgent: string | null;
}

/** A query parameter, or ''. */
export function query(ctx: Ctx, name: string): string {
  return ctx.url.searchParams.get(name) ?? '';
}

/** A body field as a string, or ''. */
export function field(ctx: Ctx, name: string): string {
  const v = ctx.body[name];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** A non-negative page number from `?page=`. */
export function pageParam(ctx: Ctx): number {
  const n = Number(query(ctx, 'page'));
  return Number.isInteger(n) && n > 0 && n < 100_000 ? n : 0;
}

export function actorOf(ctx: Ctx): Actor {
  return {
    actor: ctx.session ? (ctx.mode === 'local' ? LOCAL_ACTOR : HUB_ACTOR) : 'anonymous',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM` in the server's time zone; the browser script switches it to local time. */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function time(ts: number | null | undefined): SafeHtml {
  if (ts === null || ts === undefined) return html`<span class="ol-subtle">—</span>`;
  return html`<time datetime="${new Date(ts).toISOString()}">${fmtDateTime(ts)}</time>`;
}

/**
 * The time of day alone, for lists grouped by day (in the server's time zone, as their days are):
 * the browser script leaves it as it is.
 */
export function clock(ts: number): SafeHtml {
  const d = new Date(ts);
  return html`<time datetime="${d.toISOString()}" data-format="time">${pad(d.getHours())}:${pad(d.getMinutes())}</time>`;
}

/**
 * A day as a heading: today, yesterday, or its weekday and date, with the year when it is not
 * this one. `day` is `YYYY-MM-DD` in the server's time zone.
 */
export function dayLabel(ctx: Ctx, day: string, o: { weekday?: boolean } = {}): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date(ctx.now);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  const locale = ctx.lang === 'zh' ? 'zh-CN' : 'en-US';
  const text = new Intl.DateTimeFormat(locale, {
    weekday: o.weekday === false ? undefined : 'long',
    month: o.weekday === false ? 'short' : 'long',
    day: 'numeric',
    year: y === now.getFullYear() ? undefined : 'numeric',
  }).format(date);
  if (o.weekday === false) return text;
  if (days === 0) return `${ctx.t('day.today')} · ${text}`;
  if (days === 1) return `${ctx.t('day.yesterday')} · ${text}`;
  return text;
}

/** A short span of time: seconds under a minute, then as fmtDuration. */
export function fmtSpan(ms: number, t: Translate): string {
  if (ms < 1000) return t('duration.underSecond');
  if (ms < 60_000) return t('duration.seconds', { s: Math.floor(ms / 1000) });
  return fmtDuration(ms, t);
}

/** A duration in a few characters, for narrow columns: 0.4s, 38s, 4m 12s, 2h 5m, 3d 4h. */
export function fmtSpanShort(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 || m >= 10 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** A number in a few characters: 950, 1.2K, 34K, 1.5M. */
export function fmtCompact(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function fmtDuration(ms: number, t: Translate): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return t('duration.days', { d: days, h: hours });
  if (hours > 0) return t('duration.hours', { h: hours, m: minutes % 60 });
  return t('duration.minutes', { m: minutes });
}

export function fmtNumber(n: number, lang: Lang): string {
  return n.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
}

/** Clip long text for lists; the full text is on the detail page. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
