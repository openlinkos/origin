import type {
  PurgeCounts,
  PurgeDetail,
  PurgeMirror,
  PurgePlan,
  PurgeRecord,
  PurgeSelector,
  PurgeWarning,
} from '@openlinkos/origin-core';
import { type Ctx, clip, fmtDateTime, fmtNumber, time } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import type { MessageKey } from '../i18n/index.js';
import { purgeHref, selectorQuery } from '../purge.js';
import {
  alert,
  badge,
  empty,
  linkButton,
  olderLink,
  pageIntro,
  panel,
  sessionHref,
  submitButton,
  tableWrap,
} from './components.js';
import { csrfField, docsUrl, here, renderPage } from './layout.js';
import { agentTag, box, facts } from './workbench.js';

/**
 * Purging (see docs/architecture.md#purging): its preview, its records, and the list of them. What
 * these pages show of a purge is ids and counts, never the content it deletes or deleted; ids link
 * to the pages where the owner can look at what is still there.
 */

/** Most ids of one kind a page lists; the rest are counted. */
export const PURGE_IDS_SHOWN = 200;

/** What a purge does not reach, in the order of PURGE_LIMITS in core. */
export const PURGE_LIMIT_KEYS: readonly MessageKey[] = [
  'purge.limit.backups',
  'purge.limit.versions',
  'purge.limit.stores',
  'purge.limit.agents',
  'purge.limit.postgres',
];

/** Line ranges `[first, count]` as text: `2, 5–9, 40`, the first few and an ellipsis. */
export function rangesText(ranges: ReadonlyArray<readonly [number, number]>, max = 12): string {
  const shown = ranges
    .slice(0, max)
    .map(([first, count]) => (count === 1 ? `${first}` : `${first}–${first + count - 1}`));
  return `${shown.join(', ')}${ranges.length > max ? ', …' : ''}`;
}

/** What a selector names, in a few words, with its ids. */
export function selectorSummary(ctx: Ctx, s: PurgeSelector): SafeHtml {
  const t = ctx.t;
  const mono = (v: string) => html`<span class="ol-mono">${v}</span>`;
  switch (s.kind) {
    case 'event':
      return s.ids.length === 1
        ? html`${t('selector.event')} ${mono(s.ids[0] ?? '')}`
        : html`${t('selector.events', { n: fmtNumber(s.ids.length, ctx.lang) })}`;
    case 'session':
      return html`${t('selector.session')} ${mono(`${s.source}:${s.sessionId}`)}${s.keepChildren ? html`, ${t('selector.keepChildren')}` : ''}`;
    case 'entry':
      return html`${t('selector.entry')} ${mono(s.id)}`;
    case 'forgotten':
      return s.tombstone === 'all'
        ? html`${t('selector.forgottenAll')}`
        : html`${t('selector.forgotten')} <a class="ol-mono" href="${href('tombstone', { id: s.tombstone })}">${s.tombstone}</a>`;
    case 'recall':
      return html`${t('selector.recall')} ${mono(s.id)}`;
    case 'lines': {
      const parts: HtmlValue[] = [];
      if (s.from !== undefined) parts.push(t('selector.from', { name: s.from }));
      if (s.path !== undefined) parts.push(mono(s.path));
      if (s.file !== undefined) parts.push(t('selector.file', { id: s.file }));
      if (s.lines) {
        parts.push(
          t('selector.range', {
            range: rangesText([[s.lines.first, s.lines.last - s.lines.first + 1]]),
          }),
        );
      }
      if (s.since !== undefined) parts.push(t('selector.since', { time: fmtDateTime(s.since) }));
      if (s.until !== undefined) parts.push(t('selector.until', { time: fmtDateTime(s.until) }));
      if (s.unparsed) parts.push(t('selector.unparsed'));
      return html`${t('selector.lines', { source: s.source })}${parts.map((p) => html`, ${p}`)}`;
    }
  }
}

/** The way to a purge's preview from the page of what it selects: "Purge…". */
export function purgeButton(ctx: Ctx, s: PurgeSelector): SafeHtml {
  return linkButton(ctx, {
    href: purgeHref(s),
    label: ctx.t('purge.link'),
    icon: 'trash-2',
    variant: 'ghost',
    size: 'sm',
  });
}

/** Where the owner came from, to go back to without purging. */
function backHref(s: PurgeSelector | null): string {
  if (!s) return '/admin/purges';
  switch (s.kind) {
    case 'event':
      return s.ids.length === 1 ? href('event', { id: s.ids[0] }) : '/admin/sessions';
    case 'session':
      return sessionHref({ source: s.source, sessionId: s.sessionId });
    case 'entry':
      return href('entry', { id: s.id });
    case 'forgotten':
      return s.tombstone === 'all' ? '/admin/tombstones' : href('tombstone', { id: s.tombstone });
    case 'recall':
      return href('recall', { id: s.id });
    default:
      return '/admin/purges';
  }
}

/**
 * On `origin ui` connected to a hub: the hub keeps its copy of what it received, and a device's
 * purge never goes up; a link to the same purge on the hub, where ids are the same.
 */
function hubNotice(ctx: Ctx, s: PurgeSelector | null): SafeHtml {
  if (ctx.mode !== 'local') return html``;
  const hub = ctx.service.hub();
  if (!hub) return html``;
  const t = ctx.t;
  // Raw file ids are this store's own, so a selector of lines does not carry over.
  const link =
    s && s.kind !== 'lines'
      ? html` <a href="${`${hub.url.replace(/\/+$/, '')}/admin/purge?${selectorQuery(s)}`}" rel="noreferrer" target="_blank">${t('purge.hubLink')}</a>`
      : '';
  return alert(ctx, 'info', html`${t('purge.hubKeeps', { hub: hub.url })}${link}`);
}

/** A warning of the plan, in the page's language. */
function warningText(ctx: Ctx, w: PurgeWarning): string | null {
  const n = fmtNumber(w.count, ctx.lang);
  switch (w.code) {
    case 'large':
      return ctx.t('purge.warn.large', { n });
    case 'closure':
      return ctx.t('purge.warn.closure', { n: w.count });
    case 'visible':
      return ctx.t('purge.warn.visible', { n: w.count });
    case 'chains':
      return ctx.t('purge.warn.chains', { n: w.count });
    default:
      // The refusals, shown on their own.
      return null;
  }
}

/** The numbers of a purge: what it deletes or deleted, each kind that has any. */
function countList(ctx: Ctx, c: PurgeCounts): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const sub = (text: string) => html`<span class="admin-cell-sub">${text}</span>`;
  const row = (key: MessageKey, value: number, extra?: HtmlValue, always = false) =>
    value > 0 || always ? html`<dt>${t(key)}</dt><dd>${n(value)}${extra ?? ''}</dd>` : '';
  return html`<dl class="ol-dl">
    ${row('purge.count.events', c.events, c.closure > 0 ? sub(t('purge.count.closure', { n: n(c.closure) })) : '', true)}
    ${row('purge.count.entries', c.entries, c.chains > 0 ? sub(t('purge.count.chains', { n: c.chains })) : '', true)}
    ${row('purge.count.sessions', c.sessions)}
    ${row('purge.count.recalls', c.recalls)}
    ${row('purge.count.recallItems', c.recallItems)}
    ${row('purge.count.proposals', c.proposals)}
    ${row('purge.count.tombstones', c.tombstones)}
    ${row('purge.count.lines', c.lines, c.mirrors > 0 ? sub(t('purge.count.mirrors', { n: c.mirrors })) : '')}
    ${row('purge.count.files', c.files)}
  </dl>`;
}

/** A list of ids, each linked where it still has a page, the first PURGE_IDS_SHOWN of them. */
function idList(ctx: Ctx, items: HtmlValue[]): SafeHtml {
  const rest = items.length - PURGE_IDS_SHOWN;
  return html`<ul class="admin-ids">${items.slice(0, PURGE_IDS_SHOWN).map((i) => html`<li>${i}</li>`)}</ul>${
    rest > 0
      ? html`<p class="admin-note">${ctx.t('purge.more', { n: fmtNumber(rest, ctx.lang) })}</p>`
      : ''
  }`;
}

/** A panel of ids of one kind, or nothing when there are none. */
function idBox(ctx: Ctx, title: MessageKey, items: HtmlValue[], aside?: string): HtmlValue {
  if (items.length === 0) return '';
  return box({
    title: html`${ctx.t(title)}<span class="ol-count">${fmtNumber(items.length, ctx.lang)}</span>`,
    aside,
    body: idList(ctx, items),
  });
}

const link = (path: string, id: string, params: Record<string, string> = { id }) =>
  html`<a class="ol-mono" href="${href(path, params)}">${id}</a>`;
const plain = (id: string) => html`<span class="ol-mono">${id}</span>`;

const lastSeparator = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
const fileName = (p: string) => p.slice(lastSeparator(p) + 1);
const folderOf = (p: string) => p.slice(0, Math.max(0, lastSeparator(p)));

/**
 * The mirrors whose lines a purge blanks, by their original file: which lines, and what else
 * happens to each.
 */
function mirrorTable(
  ctx: Ctx,
  files: ReadonlyArray<
    Pick<PurgeMirror, 'source' | 'path' | 'generation' | 'mirror' | 'lines'> & {
      blocked?: boolean;
      continued?: boolean;
      pending?: boolean;
      error?: string | null;
    }
  >,
  o: { status?: boolean } = {},
): SafeHtml {
  const t = ctx.t;
  const rest = files.length - PURGE_IDS_SHOWN;
  const flags = (f: (typeof files)[number]) =>
    html`${f.blocked ? html`<span title="${t('purge.blockedHelp')}">${badge(t('purge.blocked'), 'neutral')}</span>` : ''}${f.continued ? html`<span title="${t('purge.continuedHelp')}">${badge(t('purge.continued'), 'neutral')}</span>` : ''}`;
  const status = (f: (typeof files)[number]) =>
    f.pending
      ? html`${badge(t('purgeRecord.pendingOne'), 'warning', { dot: true })}${f.error ? html`<span class="admin-cell-sub">${f.error}</span>` : ''}`
      : html`<span class="admin-good">${t('purgeRecord.blanked')}</span>`;
  return html`${tableWrap(
    html`<th>${t('purge.file')}</th><th>${t('overview.source')}</th><th class="ol-num">${t('purge.generation')}</th><th>${t('purge.lines')}</th>${o.status ? html`<th>${t('purgeRecord.status')}</th>` : ''}`,
    files.slice(0, PURGE_IDS_SHOWN).map(
      (f) => html`<tr>
        <td class="admin-wide" title="${f.path}"><span class="admin-cell-title ol-mono">${fileName(f.path)}</span><span class="admin-cell-sub ol-mono">${folderOf(f.path)}</span></td>
        <td>${agentTag(f.source)}</td>
        <td class="ol-num" data-label="${t('purge.generation')}">${f.generation}</td>
        <td data-label="${t('purge.lines')}"><span class="ol-mono">${rangesText(f.lines)}</span>${f.blocked || f.continued ? html`<span class="ol-cluster admin-flags">${flags(f)}</span>` : ''}</td>
        ${o.status ? html`<td data-label="${t('purgeRecord.status')}">${status(f)}</td>` : ''}
      </tr>`,
    ),
    'ol-table-stack',
  )}${rest > 0 ? html`<p class="admin-note admin-inset">${t('purge.more', { n: fmtNumber(rest, ctx.lang) })}</p>` : ''}`;
}

/** The ids of a plan, kind by kind, linked to the pages where they can still be seen. */
function planLists(ctx: Ctx, p: PurgePlan): SafeHtml {
  const t = ctx.t;
  return html`${idBox(
    ctx,
    'purge.events',
    p.events.map((id) => link('event', id)),
  )}${idBox(
    ctx,
    'purge.entries',
    p.entries.map((id) => link('entry', id)),
  )}${idBox(
    ctx,
    'purge.sessions',
    p.sessions.map(
      (s) =>
        html`<a class="ol-mono" href="${sessionHref({ source: s.source, sessionId: s.sessionId })}">${s.source}:${s.sessionId}</a>`,
    ),
  )}${idBox(
    ctx,
    'purge.recalls',
    p.recalls.map((id) => link('recall', id)),
  )}${idBox(
    ctx,
    'purge.recallItems',
    p.recallItems.map(
      (i) =>
        html`${link('recall', i.recall)} <span class="admin-faint">${t('purge.recallItem', { rank: i.rank })}</span>`,
    ),
  )}${idBox(
    ctx,
    'purge.proposals',
    p.proposals.map((id) => link('proposal', id)),
  )}${idBox(
    ctx,
    'purge.tombstones',
    p.tombstones.map((id) => link('tombstone', id)),
    t('purge.tombstonesHelp'),
  )}${
    p.files.length === 0
      ? ''
      : box({
          title: html`${t('purge.mirrors')}<span class="ol-count">${fmtNumber(p.files.length, ctx.lang)}</span>`,
          aside: t('purge.mirrorsHelp'),
          flush: true,
          body: mirrorTable(ctx, p.files),
        })
  }`;
}

/** What no purge reaches, said before and after one. */
function limitsBox(ctx: Ctx): SafeHtml {
  return box({
    title: ctx.t('purge.limitsTitle'),
    body: html`<ul class="admin-limits">${PURGE_LIMIT_KEYS.map((k) => html`<li>${ctx.t(k)}</li>`)}</ul>`,
  });
}

function emptyPlan(p: PurgePlan): boolean {
  return (
    p.events.length === 0 &&
    p.entries.length === 0 &&
    p.sessions.length === 0 &&
    p.recalls.length === 0 &&
    p.recallItems.length === 0 &&
    p.files.length === 0
  );
}

export interface PurgeView {
  /** What the owner asked to purge; null when the query named nothing that can be purged. */
  selector: PurgeSelector | null;
  /** What purging it would delete here; null when it cannot be planned. */
  plan: PurgePlan | null;
  /**
   * The admin password was entered within the last 10 minutes, as purging needs on a hub; always
   * true on `origin ui`, which has no password.
   */
  fresh: boolean;
  reason?: string;
  errors?: string[];
}

/** The form that purges: a reason, the word typed, and the plan's digest and selector. */
function purgeForm(ctx: Ctx, o: PurgeView, plan: PurgePlan): SafeHtml {
  const t = ctx.t;
  if (!o.fresh) {
    return html`<div class="ol-stack">
      <p>${t('purge.reauth')}</p>
      <div>${linkButton(ctx, { href: `/admin/reauth?next=${encodeURIComponent(here(ctx))}`, label: t('purge.reauthButton'), icon: 'key-round', variant: 'primary' })}</div>
    </div>`;
  }
  return html`<form method="post" action="/admin/purge" class="ol-form">
    ${csrfField(ctx)}
    <input type="hidden" name="selector" value="${JSON.stringify(plan.selector)}">
    <input type="hidden" name="digest" value="${plan.digest}">
    <div class="ol-field">
      <label class="ol-label" for="reason">${t('purge.reason')}</label>
      <textarea class="ol-textarea" id="reason" name="reason" rows="3" required maxlength="2000" aria-describedby="reason-hint">${o.reason ?? ''}</textarea>
      <p class="ol-hint" id="reason-hint">${t('purge.reasonHelp')}</p>
    </div>
    <div class="ol-field">
      <label class="ol-label" for="confirm">${t('purge.confirm')}</label>
      <input class="ol-input ol-mono" type="text" id="confirm" name="confirm" required pattern="purge" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="confirm-hint">
      <p class="ol-hint" id="confirm-hint">${t('purge.confirmHelp')}</p>
    </div>
    <div class="ol-form-actions">
      ${submitButton(ctx, { label: t('purge.submit'), icon: 'trash-2', variant: 'danger' })}
      ${linkButton(ctx, { href: backHref(o.selector), label: t('action.cancel'), variant: 'ghost' })}
    </div>
  </form>`;
}

/**
 * The preview of a purge: what it would delete here, as ids and counts (never text), the warnings
 * and limits, and the form that applies exactly this plan.
 */
export function purgePage(ctx: Ctx, status: number, o: PurgeView): void {
  const t = ctx.t;
  const plan = o.plan;
  const nothing = plan !== null && emptyPlan(plan);
  const warnings = (plan?.warnings ?? [])
    .map((w) => warningText(ctx, w))
    .filter((w): w is string => w !== null);
  const refusals = plan?.refusals ?? [];
  const refused = refusals.length > 0;
  const notices = [
    ...(o.errors ?? []).map((e) => alert(ctx, 'danger', e)),
    refused ? alert(ctx, 'danger', refusals.join(' '), t('purge.refused')) : '',
    nothing ? alert(ctx, 'info', t('purge.nothing')) : '',
    ...(nothing ? [] : warnings.map((w) => alert(ctx, 'warning', w))),
    hubNotice(ctx, o.selector),
  ].filter((n) => String(n) !== '');
  renderPage(ctx, status, {
    title: t('purge.title'),
    nav: 'tombstones',
    crumbs: [{ label: t('nav.purges'), href: '/admin/purges' }],
    heading: t('purge.title'),
    body: html`${o.selector ? facts(ctx, [{ label: t('purge.selected'), value: selectorSummary(ctx, o.selector) }]) : ''}
    ${pageIntro(ctx, { description: t('purge.rules') })}
    ${notices.length > 0 ? html`<div class="ol-notices">${notices}</div>` : ''}
    ${
      !plan || nothing
        ? ''
        : html`<div class="ol-layout-supporting">
      <div class="ol-stack">
        ${box({ title: t('purge.counts'), body: countList(ctx, plan.counts) })}
        ${planLists(ctx, plan)}
      </div>
      <div class="ol-stack">
        ${panel(ctx, {
          danger: true,
          icon: 'triangle-alert',
          title: t('purge.summary', { events: plan.counts.events, entries: plan.counts.entries }),
          body: html`<div class="ol-stack">
            <p>${ctx.mode === 'local' ? t('purge.warningLocal') : t('purge.warning')}</p>
            ${refused ? '' : purgeForm(ctx, o, plan)}
          </div>`,
        })}
        ${limitsBox(ctx)}
      </div>
    </div>`
    }`,
  });
}

/** How many of a purge's mirrors still hold purged lines, as a tag. */
function mirrorsTag(ctx: Ctx, pending: number, mirrors: number): SafeHtml {
  if (mirrors === 0) return html`<span class="admin-faint">—</span>`;
  return pending > 0
    ? badge(ctx.t('purges.pending', { n: fmtNumber(pending, ctx.lang) }), 'warning', { dot: true })
    : html`<span class="admin-good">${ctx.t('purges.blanked')}</span>`;
}

/** What a purge deleted, in a few words. */
export function deletedCount(ctx: Ctx, c: PurgeCounts): string {
  const n = (v: number) => fmtNumber(v, ctx.lang);
  return ctx.t('purges.deletedCount', {
    events: n(c.events),
    entries: n(c.entries),
    lines: n(c.lines),
  });
}

/** Every purge made or received here: when, where, by whom, why, what it selected, and counts. */
export function purgesPage(
  ctx: Ctx,
  o: { purges: Array<PurgeRecord & { pending: number }>; more: boolean },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.purges'),
    nav: 'tombstones',
    crumbs: [{ label: t('nav.tombstones'), href: '/admin/tombstones' }],
    heading: t('purges.title'),
    body: html`${pageIntro(ctx, { description: t('purges.help') })}
    ${
      o.purges.length === 0
        ? empty(ctx, {
            icon: 'trash-2',
            title: t('purges.none'),
            text: t('purges.noneHelp'),
            action: linkButton(ctx, {
              href: docsUrl(ctx, 'guide/admin#purging'),
              label: t('purges.howItWorks'),
              size: 'sm',
            }),
          })
        : tableWrap(
            html`<th>${t('tombstones.reason')}</th><th>${t('purge.selected')}</th><th>${t('tombstones.origin')}</th><th>${t('purges.deleted')}</th><th>${t('purges.mirrors')}</th><th class="ol-num">${t('tombstones.time')}</th>`,
            o.purges.map(
              (p) => html`<tr>
          <td class="admin-wide"><a class="admin-cell-title" href="${href('purge-record', { id: p.id })}">${clip(p.reason, 200)}</a><span class="admin-cell-sub"><span class="ol-mono">${p.id}</span>${badge(p.channel, 'neutral', { square: true })}</span></td>
          <td data-label="${t('purge.selected')}">${selectorSummary(ctx, p.selector)}</td>
          <td data-label="${t('tombstones.origin')}">${p.origin}<span class="admin-cell-sub">${p.author}</span></td>
          <td data-label="${t('purges.deleted')}">${deletedCount(ctx, p.counts)}</td>
          <td data-label="${t('purges.mirrors')}">${mirrorsTag(ctx, p.pending, p.counts.mirrors)}</td>
          <td class="ol-num">${time(p.at)}</td>
        </tr>`,
            ),
            'ol-table-stack',
          )
    }
    ${olderLink(ctx, o.purges.at(-1)?.seq, o.more)}`,
  });
}

/**
 * One purge: who made it, when, why, and what it selected; what it deleted, by id (those pages are
 * gone); the forgets and recalls it kept but changed; and its mirrors, blanked or still pending.
 */
export function purgeRecordPage(ctx: Ctx, d: PurgeDetail, o: { done?: boolean } = {}): void {
  const t = ctx.t;
  const pending = d.mirrors.filter((m) => m.pending);
  const notices = [
    o.done ? alert(ctx, 'success', t('purgeRecord.done')) : '',
    pending.length > 0
      ? alert(
          ctx,
          'warning',
          html`${t('purgeRecord.pending', { n: pending.length })}${pending
            .filter((m) => m.error)
            .slice(0, 5)
            .map(
              (m) =>
                html`<span class="admin-cell-sub"><span class="ol-mono">raw/${m.mirror}</span>: ${m.error}</span>`,
            )}`,
        )
      : '',
    // A purge the hub sent has been made there already.
    d.channel === 'hub' ? '' : hubNotice(ctx, d.selector),
  ].filter((n) => String(n) !== '');
  const removed = d.removed;
  const touched =
    d.touched.tombstones.length + d.touched.recalls.length === 0
      ? ''
      : box({
          title: t('purgeRecord.touched'),
          aside: t('purgeRecord.touchedHelp'),
          body: html`<div class="ol-stack">${
            d.touched.tombstones.length > 0
              ? html`<div><h3 class="ol-heading-sm">${t('purgeRecord.touchedForgets')}</h3>${idList(
                  ctx,
                  d.touched.tombstones.map((id) => link('tombstone', id)),
                )}</div>`
              : ''
          }${
            d.touched.recalls.length > 0
              ? html`<div><h3 class="ol-heading-sm">${t('purgeRecord.touchedRecalls')}</h3>${idList(
                  ctx,
                  d.touched.recalls.map((id) => link('recall', id)),
                )}</div>`
              : ''
          }</div>`,
        });
  const details = box({
    title: t('tombstone.details'),
    body: html`<dl class="ol-dl">
      <dt>${t('purge.selected')}</dt><dd>${selectorSummary(ctx, d.selector)}</dd>
      <dt>${t('tombstones.reason')}</dt><dd><span class="ol-text-pre">${d.reason}</span></dd>
      <dt>${t('tombstones.time')}</dt><dd>${time(d.at)}</dd>
      <dt>${t('tombstones.origin')}</dt><dd>${d.origin}</dd>
      <dt>${t('tombstones.author')}</dt><dd>${d.author}</dd>
      <dt>${t('purgeRecord.channel')}</dt><dd>${badge(d.channel, 'neutral', { square: true })}</dd>
      ${d.receivedAt !== null ? html`<dt>${t('purgeRecord.received')}</dt><dd>${time(d.receivedAt)}</dd>` : ''}
      <dt>ID</dt><dd class="ol-mono">${d.id}</dd>
    </dl>`,
  });
  renderPage(ctx, 200, {
    title: d.id,
    nav: 'tombstones',
    crumbs: [{ label: t('nav.purges'), href: '/admin/purges' }],
    heading: html`${t('purgeRecord.title')} <span class="ol-mono">${d.id}</span>`,
    badges: html`${badge(d.channel, 'neutral', { square: true })}${pending.length > 0 ? badge(t('purges.pending', { n: pending.length }), 'warning', { dot: true }) : ''}`,
    body: html`${facts(ctx, [
      { icon: 'clock', value: time(d.at) },
      { icon: 'user', value: d.author },
      { label: t('purges.deleted'), value: deletedCount(ctx, d.counts) },
    ])}
    ${pageIntro(ctx, { description: t('purgeRecord.help') })}
    ${notices.length > 0 ? html`<div class="ol-notices">${notices}</div>` : ''}
    <div class="ol-layout-supporting">
      <div class="ol-stack">
        ${box({ title: t('purge.countsDone'), body: countList(ctx, d.counts) })}
        ${idBox(ctx, 'purge.events', removed.events.map(plain))}
        ${idBox(ctx, 'purge.entries', removed.entries.map(plain))}
        ${idBox(
          ctx,
          'purge.sessions',
          removed.sessions.map((s) => plain(`${s.source}:${s.sessionId}`)),
        )}
        ${idBox(ctx, 'purge.recalls', removed.recalls.map(plain))}
        ${idBox(
          ctx,
          'purge.files',
          removed.files.map(
            (f) => html`${plain(f.path)} <span class="admin-faint">${f.source}</span>`,
          ),
          t('purge.blockedHelp'),
        )}
        ${
          d.mirrors.length === 0
            ? ''
            : box({
                title: html`${t('purge.mirrors')}<span class="ol-count">${fmtNumber(d.mirrors.length, ctx.lang)}</span>`,
                aside: t('purge.mirrorsHelp'),
                flush: true,
                body: mirrorTable(ctx, d.mirrors, { status: true }),
              })
        }
        ${touched}
      </div>
      <div class="ol-stack">${details}${limitsBox(ctx)}</div>
    </div>`,
  });
}
