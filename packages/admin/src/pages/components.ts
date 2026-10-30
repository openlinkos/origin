/**
 * Building blocks of the admin pages, as markup of the OpenLinkOS design system (`ol-` classes of
 * `@openlinkos/ui`). Every value goes through the escaping `html` template.
 */
import {
  type Entry,
  type EntryKind,
  type EventRow,
  entrySummary,
  type SessionRow,
  TOMBSTONE_ID_RE,
} from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, query, time } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { type IconName, icon } from '../icons.js';
import { kindTag, whenShort } from './workbench.js';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * What a page says before its content, under the heading in the top bar: facts about the object
 * shown (`meta`, separate items), and a description in one or two lines.
 */
export function pageIntro(_ctx: Ctx, o: { description?: HtmlValue; meta?: HtmlValue[] }): SafeHtml {
  const meta = (o.meta ?? []).filter((m) => m !== '' && m !== null && m !== undefined);
  return html`${meta.length > 0 ? html`<ul class="ol-page-meta">${meta.map((m) => html`<li>${m}</li>`)}</ul>` : ''}${o.description ? html`<p class="ol-page-description">${o.description}</p>` : ''}`;
}

/** Whether markup is a framed table, which a panel shows edge to edge. */
const isTable = (v: HtmlValue) =>
  typeof v === 'object' &&
  v !== null &&
  'value' in v &&
  String(v.value).startsWith('<div class="ol-table-wrap">');

/** A region of a page, as a panel: its title and actions, a note, then its content. */
export function section(o: {
  title: HtmlValue;
  description?: HtmlValue;
  actions?: HtmlValue;
  body: HtmlValue;
}): SafeHtml {
  const flush = isTable(o.body);
  return html`<section class="ol-panel">
      <div class="ol-panel-header"><h2 class="ol-panel-title">${o.title}</h2>${o.actions ? html`<div class="admin-panel-aside">${o.actions}</div>` : ''}</div>
      ${flush && !o.description ? o.body : html`<div class="ol-panel-body">${o.description ? html`<p class="admin-note">${o.description}</p>` : ''}${o.body}</div>`}
    </section>`;
}

/** A framed group of related detail, with a titled header. */
export function panel(
  ctx: Ctx,
  o: {
    title: HtmlValue;
    icon?: IconName;
    badge?: HtmlValue;
    body: HtmlValue;
    footer?: HtmlValue;
    danger?: boolean;
    tag?: 'section' | 'aside';
  },
): SafeHtml {
  const inner = html`<div class="ol-panel-header"><h2 class="ol-panel-title">${o.icon ? icon(ctx, o.icon, 'sm') : ''}${o.title}</h2>${o.badge ? html`<div class="admin-panel-aside">${o.badge}</div>` : ''}</div>
      ${isTable(o.body) ? o.body : html`<div class="ol-panel-body">${o.body}</div>`}
      ${o.footer ? html`<div class="ol-panel-footer">${o.footer}</div>` : ''}`;
  const cls = o.danger ? 'ol-panel ol-panel-danger' : 'ol-panel';
  return o.tag === 'aside'
    ? html`<aside class="${cls}">${inner}</aside>`
    : html`<section class="${cls}">${inner}</section>`;
}

const ALERT_ICON: Record<'info' | 'success' | 'warning' | 'danger', IconName> = {
  info: 'info',
  success: 'circle-check',
  warning: 'triangle-alert',
  danger: 'circle-alert',
};

/** A message in the page. Errors are announced at once (`role="alert"`), the rest politely. */
export function alert(
  ctx: Ctx,
  tone: 'info' | 'success' | 'warning' | 'danger',
  message: HtmlValue,
  title?: string,
): SafeHtml {
  return html`<div class="ol-alert ol-alert-${tone}" role="${tone === 'danger' ? 'alert' : 'status'}">${icon(ctx, ALERT_ICON[tone])}<div class="ol-alert-body">${title ? html`<p class="ol-alert-title">${title}</p>` : ''}<p>${message}</p></div></div>`;
}

export function badge(
  text: HtmlValue,
  tone: Tone = 'neutral',
  o: { dot?: boolean; square?: boolean } = {},
): SafeHtml {
  const cls = [
    'ol-badge',
    tone === 'neutral' ? '' : `ol-badge-${tone}`,
    o.square ? 'ol-badge-square' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return html`<span class="${cls}">${o.dot ? html`<span class="ol-dot"></span>` : ''}${text}</span>`;
}

type Variant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'danger-soft' | 'link';

function btnClass(variant: Variant, size?: 'sm' | 'xs', block?: boolean): string {
  return `ol-btn ol-btn-${variant}${size ? ` ol-btn-${size}` : ''}${block ? ' ol-btn-block' : ''}`;
}

/** A link that looks like a button. */
export function linkButton(
  ctx: Ctx,
  o: {
    href: string;
    label: HtmlValue;
    icon?: IconName;
    variant?: Variant;
    size?: 'sm' | 'xs';
    block?: boolean;
  },
): SafeHtml {
  const small = o.size ? 'sm' : undefined;
  return html`<a class="${btnClass(o.variant ?? 'secondary', o.size, o.block)}" href="${o.href}">${o.icon ? icon(ctx, o.icon, small) : ''}${o.label}</a>`;
}

/** A submit button. */
export function submitButton(
  ctx: Ctx,
  o: { label: HtmlValue; icon?: IconName; variant?: Variant; size?: 'sm' | 'xs'; block?: boolean },
): SafeHtml {
  return html`<button type="submit" class="${btnClass(o.variant ?? 'primary', o.size, o.block)}">${o.icon ? icon(ctx, o.icon, o.size ? 'sm' : undefined) : ''}${o.label}</button>`;
}

/** An empty list: what is missing, why, and the one action that fills it. */
export function empty(
  ctx: Ctx,
  o: { icon: IconName; title: string; text?: HtmlValue; action?: HtmlValue },
): SafeHtml {
  return html`<div class="ol-empty">
      <span class="ol-empty-icon">${icon(ctx, o.icon, 'lg')}</span>
      <p class="ol-empty-title">${o.title}</p>
      ${o.text ? html`<p class="ol-empty-text">${o.text}</p>` : ''}
      ${o.action ?? ''}
    </div>`;
}

/** A table in a frame of its own, or edge to edge in a panel; it scrolls sideways when narrow. */
export function tableWrap(head: HtmlValue, rows: HtmlValue, cls = ''): SafeHtml {
  return html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact${cls ? ` ${cls}` : ''}">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/** Newer / older links that keep the current query (lists paged by number). */
export function pager(ctx: Ctx, page: number, more: boolean): SafeHtml {
  if (page === 0 && !more) return html``;
  const t = ctx.t;
  const link = (p: number) => {
    const params = new URLSearchParams(ctx.url.searchParams);
    if (p === 0) params.delete('page');
    else params.set('page', String(p));
    const qs = params.toString();
    return `${ctx.url.pathname}${qs ? `?${qs}` : ''}`;
  };
  const step = (to: number | null, label: string, name: IconName) =>
    to === null
      ? html`<span class="ol-btn ol-btn-secondary ol-btn-icon ol-btn-sm" aria-disabled="true">${icon(ctx, name, 'sm')}</span>`
      : html`<a class="ol-btn ol-btn-secondary ol-btn-icon ol-btn-sm" href="${link(to)}">${icon(ctx, name, 'sm')}<span class="ol-sr-only">${label}</span></a>`;
  return html`<nav class="ol-pager" aria-label="${t('pager.label')}"><span>${t('pager.page', { n: page + 1 })}</span><span class="ol-pager-links">${step(page > 0 ? page - 1 : null, t('pager.previous'), 'chevron-left')}${step(more ? page + 1 : null, t('pager.next'), 'chevron-right')}</span></nav>`;
}

/** `before` parameter for lists paged by a numeric id (the audit log). */
export function beforeParam(ctx: Ctx): number | undefined {
  const n = Number(query(ctx, 'before'));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `before` parameter for the tombstone list, paged by tombstone id. */
export function beforeTombstone(ctx: Ctx): string | undefined {
  const id = query(ctx, 'before');
  return TOMBSTONE_ID_RE.test(id) ? id : undefined;
}

/** Links for id-paged lists (tombstones, audit): back to the newest, and older. */
export function olderLink(ctx: Ctx, lastId: number | string | undefined, more: boolean): SafeHtml {
  const paged = query(ctx, 'before') !== '';
  const older = more && lastId !== undefined;
  if (!paged && !older) return html``;
  const t = ctx.t;
  return html`<nav class="ol-pager" aria-label="${t('pager.label')}"><span></span><span class="ol-pager-links">${
    paged
      ? html`<a class="ol-btn ol-btn-secondary ol-btn-sm" href="${ctx.url.pathname}">${t('pager.newest')}</a>`
      : ''
  }${
    older
      ? html`<a class="ol-btn ol-btn-secondary ol-btn-sm" href="${`${ctx.url.pathname}?before=${lastId}`}">${t('pager.older')}</a>`
      : ''
  }</span></nav>`;
}

/**
 * A copy button for the text of the element with id `target`. Hidden until the browser script
 * wires it; it shows a check mark and the "copied" label for a moment after copying.
 */
export function copyButton(ctx: Ctx, target: string, o: { labelled?: boolean } = {}): SafeHtml {
  const t = ctx.t;
  const icons = html`<span data-copy-icon>${icon(ctx, 'copy', 'sm')}</span><span data-copied-icon hidden>${icon(ctx, 'check', 'sm')}</span>`;
  return o.labelled
    ? html`<button type="button" class="ol-btn ol-btn-secondary ol-btn-sm" data-copy="${target}" data-copied="${t('action.copied')}" hidden>${icons}<span data-copy-label>${t('action.copy')}</span></button>`
    : html`<button type="button" class="ol-btn ol-btn-ghost ol-btn-sm ol-btn-icon ol-copy" data-copy="${target}" data-copied="${t('action.copied')}" aria-label="${t('action.copy')}" title="${t('action.copy')}" hidden>${icons}</button>`;
}

/** A labelled, copyable command block. */
export function snippet(ctx: Ctx, id: string, label: string, code: string): SafeHtml {
  return html`<div class="ol-code">
      <div class="ol-code-label">${icon(ctx, 'terminal', 'sm')}${label}</div>
      <pre id="${id}"><code>${code}</code></pre>
      ${copyButton(ctx, id)}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Sessions

/** Where a session's page is. */
export function sessionHref(
  s: Pick<SessionRow, 'source' | 'sessionId'>,
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return href('session', { source: s.source, id: s.sessionId, ...params });
}

/**
 * A session's name: its title, or else its provisional name (its first prompt), set apart as such,
 * or else "Untitled session".
 */
export function sessionName(ctx: Ctx, s: Pick<SessionRow, 'title' | 'prompt'>, max = 80): SafeHtml {
  if (s.title) return html`${clip(s.title, max)}`;
  if (s.prompt) {
    return html`<span class="admin-provisional" title="${ctx.t('sessions.provisional')}"><span class="ol-sr-only">${ctx.t('sessions.provisional')}: </span>${clip(s.prompt, max)}</span>`;
  }
  return html`<span class="admin-provisional">${ctx.t('sessions.untitled')}</span>`;
}

/**
 * Chips: small, muted notes in a flow of content, such as a command an agent ran or context it
 * injected, with the label in monospace. With a detail, the chip opens to show it, and the extras
 * (a badge, the event's link) go under it.
 */
export function chip(
  ctx: Ctx,
  o: {
    icon: IconName;
    label: HtmlValue;
    detail?: string | null;
    extra?: HtmlValue;
  },
): SafeHtml {
  const head = html`${icon(ctx, o.icon, 'sm')}<span class="ol-chip-label">${o.label}</span>`;
  return o.detail
    ? html`<details class="ol-chip ol-chip-mono"><summary>${head}</summary><pre class="ol-chip-detail">${o.detail}</pre>${o.extra ? html`<div class="ol-chip-foot">${o.extra}</div>` : ''}</details>`
    : html`<span class="ol-chip ol-chip-mono">${head}${o.extra ?? ''}</span>`;
}

/** A small link to an event's page, its provenance included: an icon, with the id as its title. */
export function eventLink(ctx: Ctx, id: string): SafeHtml {
  return html`<a class="ol-quiet-link" href="${href('event', { id })}" title="${id}" aria-label="${ctx.t('event.open', { id })}">${icon(ctx, 'link', 'sm')}</a>`;
}

// ---------------------------------------------------------------------------------------------
// Events and entries

type FeedRole = 'user' | 'assistant' | 'tool' | 'system';

function feedRole(e: Pick<EventRow, 'role' | 'kind'>): FeedRole {
  if (e.kind === 'tool_use' || e.kind === 'tool_result') return 'tool';
  if (e.role === 'system' || e.kind === 'system' || e.kind === 'meta' || e.kind === 'memory') {
    return 'system';
  }
  return e.role;
}

const FEED_ICON: Record<FeedRole, IconName> = {
  user: 'user',
  assistant: 'bot',
  tool: 'wrench',
  system: 'info',
};

/** Who or what an event is: the user, the agent (its source), a tool call or result, … */
export function eventLabel(ctx: Ctx, e: Pick<EventRow, 'role' | 'kind' | 'source'>): string {
  const t = ctx.t;
  if (e.kind === 'tool_use') return t('event.toolUse');
  if (e.kind === 'tool_result') return t('event.toolResult');
  if (e.kind === 'meta') return t('event.meta');
  if (e.kind === 'memory') return t('event.memory');
  if (e.kind === 'system' || e.role === 'system') return t('event.system');
  return e.role === 'user' ? t('event.user') : e.source;
}

/** The kind of an event as a badge, for detail views. */
export function eventTag(ctx: Ctx, e: Pick<EventRow, 'role' | 'kind' | 'source'>): SafeHtml {
  const role = feedRole(e);
  return badge(
    eventLabel(ctx, e),
    role === 'user' ? 'accent' : role === 'assistant' ? 'success' : 'neutral',
  );
}

/** One event in a feed: who, when, its id, and its text (escaped, pre-wrapped). */
export function feedItem(
  ctx: Ctx,
  e: Pick<EventRow, 'id' | 'role' | 'kind' | 'source' | 'ts'>,
  o: { body: HtmlValue; meta?: HtmlValue; extra?: HtmlValue; link?: boolean },
): SafeHtml {
  const role = feedRole(e);
  return html`<li class="ol-feed-item" data-role="${role}">
      <span class="ol-feed-avatar">${icon(ctx, FEED_ICON[role], 'sm')}</span>
      <div>
        <div class="ol-feed-meta"><strong>${eventLabel(ctx, e)}</strong>${time(e.ts)}${o.meta ?? ''}${
          o.link === false
            ? ''
            : html`<a class="ol-mono" href="${href('event', { id: e.id })}">${e.id}</a>`
        }</div>
        ${o.extra ?? ''}
        <div class="ol-feed-body">${o.body}</div>
      </div>
    </li>`;
}

const KIND_TONE: Record<EntryKind, Tone> = {
  memory: 'accent',
  knowledge: 'info',
  cognition: 'success',
};

export function kindBadge(ctx: Ctx, kind: EntryKind): SafeHtml {
  return badge(ctx.t(`kind.${kind}`), KIND_TONE[kind] ?? 'neutral', { square: true });
}

export function statusBadge(ctx: Ctx, status: Entry['status']): SafeHtml {
  if (status === 'active') return html``;
  return badge(ctx.t(`status.${status}`), status === 'forgotten' ? 'danger' : 'neutral');
}

/** Whether an entry's validity has ended: its `valid_to` has passed. */
export function hasEnded(e: Pick<Entry, 'validTo'>): boolean {
  return e.validTo !== null && e.validTo <= Date.now();
}

/** What else to know about an entry at a glance: imported from a memory file, its validity ended. */
export function entryFlags(ctx: Ctx, e: Pick<Entry, 'imported' | 'validTo'>): SafeHtml {
  return html`${e.imported ? badge(ctx.t('flag.imported'), 'neutral') : ''}${hasEnded(e) ? badge(ctx.t('flag.ended'), 'neutral') : ''}`;
}

/**
 * Entries as a table: the text links to the entry, with its id under it; its kind, project,
 * author, confidence, and time; and how often it was recalled, when given.
 */
export function entryTable(
  ctx: Ctx,
  entries: Array<Entry & { recalls?: number }>,
  textMax = 140,
): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const recalls = entries.some((e) => e.recalls !== undefined);
  return html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
    <thead><tr><th>${t('entries.text')}</th><th>${t('entries.kind')}</th><th>${t('filter.project')}</th><th>${t('entries.author')}</th><th class="ol-num">${t('entries.confidence')}</th>${recalls ? html`<th class="ol-num">${t('nav.recalls')}</th>` : ''}<th class="ol-num">${t('tokens.created')}</th></tr></thead>
    <tbody>${entries.map(
      (e) => html`<tr>
      <td class="admin-wide"><a class="admin-cell-title" href="${href('entry', { id: e.id })}">${clip(entrySummary(e.text), textMax)}</a><span class="admin-cell-sub"><span class="ol-mono">${e.id}</span>${statusBadge(ctx, e.status)}${hasEnded(e) ? badge(ctx.t('flag.ended'), 'neutral') : ''}</span></td>
      <td>${kindTag(ctx, e.kind)}</td>
      <td data-label="${t('filter.project')}">${e.project ?? html`<span class="admin-faint">—</span>`}</td>
      <td data-label="${t('entries.author')}">${e.author.replace(/@.*$/, '')}</td>
      <td class="ol-num" data-label="${t('entries.confidence')}">${e.confidence}</td>
      ${recalls ? html`<td class="ol-num" data-label="${t('nav.recalls')}">${e.recalls ? n(e.recalls) : html`<span class="admin-faint">—</span>`}</td>` : ''}
      <td class="ol-num">${whenShort(ctx, e.createdAt)}</td>
    </tr>`,
    )}</tbody></table></div>`;
}
