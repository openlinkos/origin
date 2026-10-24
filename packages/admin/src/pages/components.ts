/**
 * Building blocks of the admin pages, as markup of the OpenLinkOS design system (`ol-` classes of
 * `@openlinkos/ui`). Every value goes through the escaping `html` template.
 */
import {
  type Entry,
  type EntryKind,
  type EventRow,
  type SessionRow,
  TOMBSTONE_ID_RE,
} from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, query, time } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { type IconName, icon } from '../icons.js';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * The head of a page: its title (with badges after it, if any), a description, facts about the
 * object shown (`meta`, separate items), and at most one primary action among `actions`.
 */
export function pageHeader(
  _ctx: Ctx,
  o: {
    title: HtmlValue;
    badges?: HtmlValue;
    description?: HtmlValue;
    meta?: HtmlValue[];
    actions?: HtmlValue;
  },
): SafeHtml {
  const meta = (o.meta ?? []).filter((m) => m !== '' && m !== null && m !== undefined);
  return html`<div class="ol-page-header">
      <div class="ol-page-heading">
        <h1 class="ol-page-title">${o.badges ? html`<span class="ol-title-row">${o.title}${o.badges}</span>` : o.title}</h1>
        ${o.description ? html`<p class="ol-page-description">${o.description}</p>` : ''}
        ${meta.length > 0 ? html`<ul class="ol-page-meta">${meta.map((m) => html`<li>${m}</li>`)}</ul>` : ''}
      </div>
      ${o.actions ? html`<div class="ol-page-actions">${o.actions}</div>` : ''}
    </div>`;
}

/** A region of a page: a heading with an optional description and actions, then its content. */
export function section(o: {
  title: HtmlValue;
  description?: HtmlValue;
  actions?: HtmlValue;
  body: HtmlValue;
}): SafeHtml {
  return html`<section class="ol-section">
      <div class="ol-section-header">
        <h2 class="ol-section-title">${o.title}</h2>
        ${o.description ? html`<p class="ol-section-description">${o.description}</p>` : ''}
        ${o.actions ? html`<div class="ol-section-actions">${o.actions}</div>` : ''}
      </div>
      ${o.body}
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
  const inner = html`<div class="ol-panel-header"><h2 class="ol-panel-title">${o.icon ? icon(ctx, o.icon) : ''}${o.title}</h2>${o.badge ?? ''}</div>
      <div class="ol-panel-body">${o.body}</div>
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

export function tableWrap(head: HtmlValue, rows: HtmlValue, cls = ''): SafeHtml {
  return html`<div class="ol-table-wrap"><table class="ol-table${cls ? ` ${cls}` : ''}">
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
  // A link without href is not focusable; aria-disabled dims it.
  const step = (to: number | null, label: string) =>
    to === null
      ? html`<a class="ol-btn ol-btn-secondary ol-btn-sm" aria-disabled="true">${label}</a>`
      : html`<a class="ol-btn ol-btn-secondary ol-btn-sm" href="${link(to)}">${label}</a>`;
  const prev = step(page > 0 ? page - 1 : null, t('pager.previous'));
  const next = step(more ? page + 1 : null, t('pager.next'));
  return html`<nav class="ol-pager" aria-label="${t('pager.label')}"><span>${t('pager.page', { n: page + 1 })}</span><span class="ol-pager-links">${prev}${next}</span></nav>`;
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

/** The agent a session or event comes from, as a small tag that never wraps. */
export function sourceBadge(source: string): SafeHtml {
  return html`<span class="ol-badge ol-badge-outline ol-badge-mono">${source}</span>`;
}

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
  if (e.role === 'system' || e.kind === 'system' || e.kind === 'meta') return 'system';
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

/** Entries as a table: the text links to the entry; kind, status, confidence, author, time. */
export function entryTable(ctx: Ctx, entries: Entry[], textMax = 140): SafeHtml {
  const t = ctx.t;
  return tableWrap(
    html`<th>${t('entries.text')}</th><th>${t('entries.kind')}</th><th class="ol-num">${t('entries.confidence')}</th><th>${t('entries.author')}</th><th>${t('tokens.created')}</th>`,
    entries.map(
      (e) => html`<tr>
        <td><a class="ol-cell-title" href="${href('entry', { id: e.id })}">${clip(e.text, textMax)}</a><span class="ol-cell-sub ol-mono">${e.id}</span></td>
        <td><span class="ol-cluster">${kindBadge(ctx, e.kind)}${statusBadge(ctx, e.status)}</span></td>
        <td class="ol-num">${e.confidence}</td>
        <td>${e.author}</td>
        <td class="ol-nowrap">${time(e.createdAt)}</td>
      </tr>`,
    ),
  );
}
