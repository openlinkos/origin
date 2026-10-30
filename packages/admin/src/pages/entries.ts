import {
  ENTRY_KINDS,
  type Entry,
  type EntryKind,
  type EventRow,
  entrySummary,
  type ForgetResult,
  type RestoreResult,
} from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import {
  type EntryBoard,
  type EntryBoardFilter,
  type EntryDetail,
  type ForgetPlan,
  PAGE_SIZE,
  SESSION_RANGES,
} from '../service.js';
import { eventCard } from './browse.js';
import {
  alert,
  badge,
  empty,
  entryFlags,
  entryTable,
  eventTag,
  hasEnded,
  kindBadge,
  linkButton,
  pageIntro,
  panel,
  sessionHref,
  statusBadge,
  submitButton,
} from './components.js';
import { csrfField, renderPage } from './layout.js';
import { recallTable } from './recalls.js';
import {
  box,
  facetGroup,
  facts,
  filterLayout,
  kindTag,
  linkChips,
  listPager,
  searchField,
  toggled,
  whenShort,
  withParams,
} from './workbench.js';

/** A version of a memory file that deleted it. */
const memoryDeleted = (e: Pick<EventRow, 'kind' | 'meta'>) =>
  e.kind === 'memory' && e.meta?.op === 'delete';

/** The memory file a memory event is a version of. */
function memoryFile(e: Pick<EventRow, 'kind' | 'meta'>): string | null {
  const file = e.meta?.file;
  return e.kind === 'memory' && typeof file === 'string' ? file : null;
}

function kindSelect(ctx: Ctx, id: string, current: string, withAll: boolean): SafeHtml {
  return html`<select class="ol-select" id="${id}" name="kind">${withAll ? html`<option value="">${ctx.t('filter.all')}</option>` : ''}${ENTRY_KINDS.map(
    (k) =>
      html`<option value="${k}"${k === current ? html` selected` : ''}>${ctx.t(`kind.${k}`)}</option>`,
  )}</select>`;
}

/** The projects the rail lists before folding the rest away; the chosen ones always show. */
const RAIL_PROJECTS = 8;

/**
 * Entries, as a workbench list: the filter rail (kinds, projects, authors, origin, recall) on the
 * left, then a text filter, the time ranges, and whether older versions show, and the entries,
 * newest first.
 */
export function entriesPage(ctx: Ctx, b: EntryBoard & { filter: EntryBoardFilter }): void {
  const t = ctx.t;
  const f = b.filter;
  const link = (changes: Record<string, string | string[] | null>) => withParams(ctx, changes);
  const shownProjects = [
    ...b.facets.projects.slice(0, RAIL_PROJECTS),
    ...b.facets.projects.slice(RAIL_PROJECTS).filter((p) => f.projects.includes(p.value)),
  ];
  const facetGroups = html`${facetGroup(ctx, {
    title: t('entries.kind'),
    clear: f.kinds.length > 0 ? link({ kind: null }) : null,
    items: ENTRY_KINDS.map((k) => ({
      label: kindTag(ctx, k),
      count: b.facets.kinds.find((v) => v.value === k)?.count ?? 0,
      checked: f.kinds.includes(k),
      href: link({ kind: toggled(f.kinds, k) }),
    })),
  })}
    ${facetGroup(ctx, {
      title: t('filter.project'),
      clear: f.projects.length > 0 ? link({ project: null }) : null,
      items: shownProjects.map((v) => ({
        label: v.value,
        count: v.count,
        checked: f.projects.includes(v.value),
        href: link({ project: toggled(f.projects, v.value) }),
      })),
      more: b.facets.projects.length - shownProjects.length,
    })}
    ${facetGroup(ctx, {
      title: t('entries.author'),
      clear: f.authors.length > 0 ? link({ author: null }) : null,
      items: b.facets.authors.map((v) => ({
        label: v.value,
        count: v.count,
        checked: f.authors.includes(v.value),
        href: link({ author: toggled(f.authors, v.value) }),
      })),
    })}
    ${facetGroup(ctx, {
      title: t('entries.origin'),
      items: (['imported', 'written'] as const).map((o) => ({
        label: t(`entries.origin.${o}`),
        count: b.facets[o],
        checked: f.origin === o,
        href: link({ origin: f.origin === o ? null : o }),
      })),
    })}
    ${facetGroup(ctx, {
      title: t('nav.recalls'),
      items: [
        {
          label: t('entries.recalled'),
          count: b.facets.recalled,
          checked: f.recalled,
          href: link({ recalled: f.recalled ? null : '1' }),
        },
      ],
    })}`;
  const tags = [
    ...f.kinds.map((k) => ({
      label: t(`kind.${k as EntryKind}`),
      href: link({ kind: toggled(f.kinds, k) }),
    })),
    ...f.projects.map((p) => ({ label: p, href: link({ project: toggled(f.projects, p) }) })),
    ...f.authors.map((a) => ({ label: a, href: link({ author: toggled(f.authors, a) }) })),
    ...(f.origin === 'any'
      ? []
      : [{ label: t(`entries.origin.${f.origin}`), href: link({ origin: null }) }]),
    ...(f.recalled ? [{ label: t('entries.recalled'), href: link({ recalled: null }) }] : []),
  ];
  const rows =
    b.rows.length === 0
      ? tags.length > 0 || f.q !== '' || f.range !== 'all'
        ? empty(ctx, {
            icon: 'book-marked',
            title: t('entries.none'),
            action: linkButton(ctx, {
              href: '/admin/entries',
              label: t('filter.clear'),
              size: 'sm',
            }),
          })
        : empty(ctx, {
            icon: 'book-marked',
            title: t('entries.noneYet'),
            text: t('entries.noneHelp'),
          })
      : entryTable(ctx, b.rows);
  renderPage(ctx, 200, {
    title: t('nav.entries'),
    nav: 'entries',
    count: b.total,
    body: filterLayout(ctx, {
      facets: facetGroups,
      search: searchField(ctx, {
        action: '/admin/entries',
        value: f.q,
        placeholder: t('entries.filterPlaceholder'),
        label: t('entries.text'),
      }),
      ranges: linkChips(
        ctx,
        SESSION_RANGES.map((r) => ({
          label: t(`range.${r}`),
          href: link({ range: r === 'all' ? null : r }),
          current: f.range === r,
          count: b.ranges[r],
        })),
      ),
      tags,
      end: linkChips(ctx, [
        {
          label: t('entries.history'),
          href: link({ history: f.history ? null : '1' }),
          current: f.history,
        },
      ]),
      body: html`${rows}
      ${listPager(ctx, { page: b.page, size: PAGE_SIZE, shown: b.rows.length, total: b.total, more: b.more })}`,
    }),
  });
}

/**
 * An entry: its text, then the events it cites, its versions, and the recalls that handed it over;
 * and on the right, its details.
 */
export function entryPage(ctx: Ctx, d: EntryDetail): void {
  const t = ctx.t;
  const e = d.entry;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const sources = box({
    title: html`${t('entry.sourcesTitle')}<span class="ol-count">${n(d.sources.length)}</span>`,
    aside: t('entry.sourcesHelp'),
    flush: true,
    body: html`<ol class="admin-sources">${d.sources.map((s) => {
      const file = memoryFile(s.event);
      return html`<li>
        <div class="admin-source-head">
          ${eventTag(ctx, s.event)}
          <a href="${sessionHref({ source: s.event.source, sessionId: s.event.sessionId })}">${s.event.project ?? s.event.source}</a>
          ${file ? html`<span class="ol-mono admin-faint">${file}</span>` : ''}
          <a class="admin-source-time" href="${href('event', { id: s.event.id })}" title="${s.event.id}">${time(s.event.ts)}</a>
        </div>
        ${s.quote ? html`<blockquote class="ol-quote">${s.quote}</blockquote>` : ''}
        <div class="admin-source-text">${memoryDeleted(s.event) ? t('event.memoryDeleted') : clip(s.event.text, 600)}</div>
      </li>`;
    })}</ol>`,
  });
  const versions =
    d.history.length > 1
      ? box({
          title: html`${t('entry.historyTitle')}<span class="ol-count">${n(d.history.length)}</span>`,
          flush: true,
          body: html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
      <thead><tr><th>${t('entries.text')}</th><th>${t('entries.author')}</th><th>${t('entry.status')}</th><th class="ol-num">${t('tokens.created')}</th></tr></thead>
      <tbody>${d.history.map(
        (v) => html`<tr${v.id === e.id ? html` aria-selected="true"` : ''}>
        <td class="admin-wide">${v.id === e.id ? html`<span class="admin-cell-title">${clip(v.text, 300)}</span>` : html`<a class="admin-cell-title" href="${href('entry', { id: v.id })}">${clip(v.text, 300)}</a>`}<span class="admin-cell-sub ol-mono">${v.id}</span></td>
        <td>${v.author}</td>
        <td>${v.status === 'active' ? html`<span class="admin-good">${t('status.active')}</span>` : v.concurrent ? badge(t('status.concurrent'), 'neutral') : statusBadge(ctx, v.status)}</td>
        <td class="ol-num">${whenShort(ctx, v.createdAt)}</td>
      </tr>`,
      )}</tbody></table></div>`,
        })
      : '';
  const recalls = box({
    title: html`${t('nav.recalls')}<span class="ol-count">${n(d.recalls.total)}</span>`,
    aside: t('entry.recallsHelp'),
    flush: true,
    body:
      d.recalls.total === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('entry.recallsNone')}</p></div>`
        : html`${recallTable(ctx, d.recalls.latest)}${
            d.recalls.total > d.recalls.latest.length
              ? html`<p class="admin-handed-note">${t('entry.recallsMore', { n: n(d.recalls.total - d.recalls.latest.length) })}</p>`
              : ''
          }`,
  });
  const details = box({
    title: t('entry.details'),
    body: html`<dl class="ol-dl">
      <dt>${t('entries.kind')}</dt><dd>${kindTag(ctx, e.kind)}</dd>
      <dt>${t('entry.status')}</dt><dd>${t(`status.${e.status}`)}</dd>
      <dt>${t('entries.confidence')}</dt><dd>${e.confidence}</dd>
      <dt>${t('entries.author')}</dt><dd>${e.author}</dd>
      <dt>${t('entry.origin')}</dt><dd>${e.origin}</dd>
      <dt>${t('filter.project')}</dt><dd>${e.project ?? '—'}</dd>
      <dt>${t('tokens.created')}</dt><dd>${time(e.createdAt)}</dd>
      ${e.validFrom !== null || e.validTo !== null ? html`<dt>${t('entry.valid')}</dt><dd>${time(e.validFrom)} – ${time(e.validTo)}${hasEnded(e) ? html` ${t('entry.ended')}` : ''}</dd>` : ''}
      <dt>ID</dt><dd class="ol-mono">${e.id}</dd>
    </dl>`,
  });
  renderPage(ctx, 200, {
    title: e.id,
    nav: 'entries',
    crumbs: [{ label: t('nav.entries'), href: '/admin/entries' }],
    heading: clip(entrySummary(e.text), 120),
    badges: html`${kindTag(ctx, e.kind)}${statusBadge(ctx, e.status)}${entryFlags(ctx, e)}`,
    actions: html`${e.status === 'active' ? linkButton(ctx, { href: href('correct', { id: e.id }), label: t('entry.correct'), icon: 'pencil', size: 'sm' }) : ''}${linkButton(ctx, { href: href('forget', { id: e.id }), label: t('entry.forget'), icon: 'eraser', variant: 'danger-soft', size: 'sm' })}`,
    body: html`${facts(ctx, [
      e.project ? { icon: 'folder', value: e.project } : null,
      { icon: 'user', value: e.author },
      { icon: 'clock', value: time(e.createdAt) },
      { label: t('entries.confidence'), value: String(e.confidence) },
      d.recalls.total > 0 ? { label: t('nav.recalls'), value: n(d.recalls.total) } : null,
    ])}
    ${e.imported ? html`<div class="ol-notices">${alert(ctx, 'info', t('entry.imported', { agent: e.author.replace(/@.*$/, '') }))}</div>` : ''}
    ${e.status === 'superseded' && e.supersededBy ? html`<div class="ol-notices">${alert(ctx, 'info', html`${t(e.concurrent ? 'entry.concurrent' : 'entry.supersededBy')} <a class="ol-mono" href="${href('entry', { id: e.supersededBy })}">${e.supersededBy}</a>`)}</div>` : ''}
    <div class="ol-layout-supporting">
      <div class="ol-stack">
        ${box({ title: t('entries.text'), body: html`<div class="admin-entry-text">${e.text}</div>` })}
        ${sources}${versions}${recalls}
      </div>
      <div class="ol-stack">${details}</div>
    </div>`,
  });
}

/** The error of a form, next to its fields. */
function formError(ctx: Ctx, error: string | undefined): SafeHtml {
  return error ? alert(ctx, 'danger', error) : html``;
}

export function correctPage(
  ctx: Ctx,
  status: number,
  o: { entry: Entry; text?: string; kind?: string; confidence?: string; error?: string },
): void {
  const t = ctx.t;
  const e = o.entry;
  renderPage(ctx, status, {
    title: t('correct.title'),
    nav: 'entries',
    crumbs: [
      { label: t('nav.entries'), href: '/admin/entries' },
      { label: e.id, href: href('entry', { id: e.id }) },
    ],
    heading: t('correct.title'),
    body: html`${pageIntro(ctx, { description: t('correct.help') })}
    <div class="ol-grid ol-grid-2">
      <form method="post" action="/admin/correct" class="ol-form">
        ${formError(ctx, o.error)}
        ${csrfField(ctx)}
        <input type="hidden" name="id" value="${e.id}">
        <div class="ol-field">
          <label class="ol-label" for="text">${t('entries.text')}</label>
          <textarea class="ol-textarea" id="text" name="text" rows="5" required maxlength="20000">${o.text ?? e.text}</textarea>
        </div>
        <div class="ol-grid ol-grid-2">
          <div class="ol-field">
            <label class="ol-label" for="kind">${t('entries.kind')}</label>
            ${kindSelect(ctx, 'kind', o.kind ?? e.kind, false)}
          </div>
          <div class="ol-field">
            <label class="ol-label" for="confidence">${t('entries.confidence')}</label>
            <input class="ol-input" type="number" id="confidence" name="confidence" min="0" max="1" step="0.05" value="${o.confidence ?? '1'}">
          </div>
        </div>
        <div class="ol-form-actions">
          ${submitButton(ctx, { label: t('correct.submit') })}
          ${linkButton(ctx, { href: href('entry', { id: e.id }), label: t('action.cancel'), variant: 'ghost' })}
        </div>
      </form>
      ${panel(ctx, {
        tag: 'aside',
        title: t('correct.current'),
        icon: 'book-marked',
        badge: kindBadge(ctx, e.kind),
        body: html`<div class="ol-text-pre">${e.text}</div>`,
      })}
    </div>`,
  });
}

export function rememberPage(
  ctx: Ctx,
  status: number,
  o: {
    event: EventRow;
    kind?: string;
    text?: string;
    quote?: string;
    confidence?: string;
    error?: string;
  },
): void {
  const t = ctx.t;
  const e = o.event;
  renderPage(ctx, status, {
    title: t('remember.title'),
    nav: 'entries',
    crumbs: [
      { label: t('nav.sessions'), href: '/admin/sessions' },
      { label: e.id, href: href('event', { id: e.id }) },
    ],
    heading: t('remember.title'),
    body: html`${pageIntro(ctx, { description: t('remember.help') })}
    <div class="ol-grid ol-grid-2">
      <form method="post" action="/admin/remember" class="ol-form">
        ${formError(ctx, o.error)}
        ${csrfField(ctx)}
        <input type="hidden" name="event" value="${e.id}">
        <div class="ol-field">
          <label class="ol-label" for="kind">${t('entries.kind')}</label>
          ${kindSelect(ctx, 'kind', o.kind ?? 'memory', false)}
          <p class="ol-hint">${t('remember.kinds')}</p>
        </div>
        <div class="ol-field">
          <label class="ol-label" for="text">${t('entries.text')}</label>
          <textarea class="ol-textarea" id="text" name="text" rows="4" required maxlength="20000" placeholder="${t('remember.textPlaceholder')}">${o.text ?? ''}</textarea>
        </div>
        <div class="ol-field">
          <label class="ol-label" for="quote">${t('remember.quote')}</label>
          <input class="ol-input" type="text" id="quote" name="quote" value="${o.quote ?? ''}" maxlength="2000" aria-describedby="quote-hint">
          <p class="ol-hint" id="quote-hint">${t('remember.quoteHelp')}</p>
        </div>
        <div class="ol-field">
          <label class="ol-label" for="confidence">${t('entries.confidence')}</label>
          <input class="ol-input admin-input-short" type="number" id="confidence" name="confidence" min="0" max="1" step="0.05" value="${o.confidence ?? '1'}">
        </div>
        <div class="ol-form-actions">
          ${submitButton(ctx, { label: t('remember.submit'), icon: 'bookmark' })}
          ${linkButton(ctx, { href: href('event', { id: e.id }), label: t('action.cancel'), variant: 'ghost' })}
        </div>
      </form>
      <section>
        <h2 class="ol-section-title admin-heading">${t('remember.source')}</h2>
        ${eventCard(ctx, e)}
      </section>
    </div>`,
  });
}

export function forgetPage(
  ctx: Ctx,
  status: number,
  o: { id: string; plan: ForgetPlan | null; error?: string; reason?: string },
): void {
  const t = ctx.t;
  const plan = o.plan?.plan;
  const nothing = plan !== undefined && plan.entries.length === 0 && plan.events.length === 0;
  const idList = (ids: string[], path: 'entry' | 'event') =>
    html`<ul class="admin-ids">${ids.map((id) => html`<li><a class="ol-mono" href="${href(path, { id })}">${id}</a></li>`)}</ul>`;
  renderPage(ctx, status, {
    title: t('forget.title'),
    nav: 'tombstones',
    heading: html`${t('forget.title')} <span class="ol-mono">${o.id}</span>`,
    body: html`${pageIntro(ctx, { description: t('forget.rules') })}
    ${o.error ? html`<div class="ol-notices">${alert(ctx, 'danger', o.error)}</div>` : ''}
    ${
      !plan
        ? ''
        : nothing
          ? html`<div class="ol-stack">${alert(ctx, 'info', t('forget.already', { id: o.id }))}<div>${linkButton(ctx, { href: '/admin/', label: t('nav.backToOverview') })}</div></div>`
          : panel(ctx, {
              danger: true,
              title: t('forget.summary', {
                entries: plan.entries.length,
                events: plan.events.length,
              }),
              icon: 'triangle-alert',
              body: html`<div class="ol-stack">
        <p>${ctx.mode === 'local' ? t('forget.warningLocal') : t('forget.warning')}</p>
        ${plan.entries.length > 0 ? html`<div><h3 class="ol-heading-sm">${t('forget.entries')}</h3>${idList(plan.entries, 'entry')}</div>` : ''}
        ${plan.events.length > 0 ? html`<div><h3 class="ol-heading-sm">${t('forget.events')}</h3>${idList(plan.events, 'event')}</div>` : ''}
        <form method="post" action="/admin/forget" class="ol-form">
          ${csrfField(ctx)}
          <input type="hidden" name="id" value="${o.id}">
          <input type="hidden" name="digest" value="${o.plan?.digest ?? ''}">
          <div class="ol-field">
            <label class="ol-label" for="reason">${t('forget.reason')}</label>
            <input class="ol-input" type="text" id="reason" name="reason" required maxlength="500" value="${o.reason ?? ''}" autocomplete="off" aria-describedby="reason-hint">
            <p class="ol-hint" id="reason-hint">${t('forget.reasonHelp')}</p>
          </div>
          <div class="ol-form-actions">
            ${submitButton(ctx, { label: t('forget.submit'), icon: 'eraser', variant: 'danger' })}
            ${linkButton(ctx, { href: '/admin/', label: t('action.cancel'), variant: 'ghost' })}
          </div>
        </form>
      </div>`,
            })
    }`,
  });
}

/** Where a forget or a restore goes from here: on a hub, to every device; on `origin ui`, to its hub. */
function propagation(ctx: Ctx): string {
  if (ctx.mode === 'hub') return ctx.t('forget.propagates');
  return ctx.service.hub() ? ctx.t('forget.propagatesLocal') : ctx.t('forget.localOnly');
}

export function forgottenPage(ctx: Ctx, r: ForgetResult): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('forget.doneTitle'),
    nav: 'tombstones',
    heading: t('forget.doneTitle'),
    body: html`${pageIntro(ctx, { description: propagation(ctx) })}
    <div class="ol-stack">
      ${alert(ctx, 'success', t('forget.done', { entries: fmtNumber(r.entries.length, ctx.lang), events: fmtNumber(r.events.length, ctx.lang), tombstone: r.tombstoneId ?? '—' }))}
      <p>${t('forget.restoreHint')}</p>
      <div class="ol-cluster">
        ${r.tombstoneId ? linkButton(ctx, { href: href('tombstone', { id: r.tombstoneId }), label: t('forget.record'), icon: 'eraser' }) : ''}
        ${linkButton(ctx, { href: '/admin/tombstones', label: t('nav.tombstones'), variant: 'ghost' })}
      </div>
    </div>`,
  });
}

/** After a restore: what came back here, and where the restore goes from here. */
export function restoredPage(ctx: Ctx, r: RestoreResult): void {
  const t = ctx.t;
  const ids = (list: string[], path: 'entry' | 'event') =>
    html`<ul class="admin-ids">${list.map((id) => html`<li><a class="ol-mono" href="${href(path, { id })}">${id}</a></li>`)}</ul>`;
  renderPage(ctx, 200, {
    title: t('restore.doneTitle'),
    nav: 'tombstones',
    heading: t('restore.doneTitle'),
    body: html`${pageIntro(ctx, { description: propagation(ctx) })}
    <div class="ol-stack">
      ${alert(ctx, 'success', t('restore.done', { entries: fmtNumber(r.entries.length, ctx.lang), events: fmtNumber(r.events.length, ctx.lang), tombstone: r.tombstoneId }))}
      ${r.entries.length > 0 ? html`<div><h3 class="ol-heading-sm">${t('forget.entries')}</h3>${ids(r.entries, 'entry')}</div>` : ''}
      ${r.events.length > 0 ? html`<div><h3 class="ol-heading-sm">${t('forget.events')}</h3>${ids(r.events, 'event')}</div>` : ''}
      <div class="ol-cluster">
        ${linkButton(ctx, { href: href('tombstone', { id: r.target }), label: t('restore.back'), icon: 'history' })}
        ${linkButton(ctx, { href: '/admin/tombstones', label: t('nav.tombstones'), variant: 'ghost' })}
      </div>
    </div>`,
  });
}
