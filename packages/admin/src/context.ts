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
