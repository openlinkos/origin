import { entrySummary, type Proposal, type RejectedProposal } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { clip, fmtDateTime, fmtNumber, time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import {
  PAGE_SIZE,
  PROPOSAL_STATUSES,
  type ProposalBoard,
  type ProposalBoardFilter,
  type ProposalDetail,
} from '../service.js';
import {
  alert,
  badge,
  empty,
  eventTag,
  linkButton,
  pageIntro,
  sessionHref,
  sessionName,
  submitButton,
} from './components.js';
import { csrfField, docsUrl, renderPage } from './layout.js';
import {
  box,
  facetGroup,
  facts,
  filterLayout,
  kindTag,
  linkChips,
  listPager,
  toggled,
  whenShort,
  withParams,
} from './workbench.js';

/**
 * Proposals (see docs/architecture.md#proposals): the entries agents proposed, for the owner to
 * accept or reject. The list shows those pending first; a proposal's page shows what it proposes,
 * the events it cites, and the two forms that decide it. Rejected proposals are listed by id and
 * reason only: their text shows on the page of the forget that rejected them.
 */

/** A proposal's status, as a badge. */
function statusTag(ctx: Ctx, status: 'pending' | 'accepted' | 'rejected'): SafeHtml {
  if (status === 'pending')
    return badge(ctx.t('proposals.status.pending'), 'warning', { dot: true });
  if (status === 'accepted') return badge(ctx.t('proposals.status.accepted'), 'success');
  return badge(ctx.t('proposals.status.rejected'), 'neutral');
}

const projectOf = (p: Proposal) => p.project ?? p.sessionProject;

function shownRow(ctx: Ctx, p: Proposal): SafeHtml {
  const t = ctx.t;
  return html`<tr>
    <td class="admin-wide"><a class="admin-cell-title" href="${href('proposal', { id: p.id })}">${clip(entrySummary(p.text), 140)}</a><span class="admin-cell-sub"><span class="ol-mono">${p.id}</span>${statusTag(ctx, p.status)}</span></td>
    <td>${kindTag(ctx, p.kind)}</td>
    <td data-label="${t('filter.project')}">${projectOf(p) ?? html`<span class="admin-faint">—</span>`}</td>
    <td data-label="${t('proposals.agent')}">${p.source}</td>
    <td class="ol-num" data-label="${t('entries.confidence')}">${p.confidence}</td>
    <td class="ol-num">${whenShort(ctx, p.at)}</td>
  </tr>`;
}

function rejectedRow(ctx: Ctx, r: RejectedProposal): SafeHtml {
  const t = ctx.t;
  return html`<tr>
    <td class="admin-wide"><span class="admin-cell-title">${r.reason ? clip(r.reason, 140) : html`<span class="admin-faint">—</span>`}</span><span class="admin-cell-sub"><span class="ol-mono">${r.id}</span>${statusTag(ctx, 'rejected')}<a class="ol-mono" href="${href('tombstone', { id: r.forget })}">${r.forget}</a></span></td>
    <td><span class="admin-faint">—</span></td>
    <td data-label="${t('filter.project')}"><span class="admin-faint">—</span></td>
    <td data-label="${t('proposals.agent')}">${r.source}</td>
    <td class="ol-num" data-label="${t('entries.confidence')}"><span class="admin-faint">—</span></td>
    <td class="ol-num">${whenShort(ctx, r.rejectedAt)}</td>
  </tr>`;
}

/** The Proposals page: the projects on the left, the statuses above; the proposals, pending first. */
export function proposalsPage(ctx: Ctx, b: ProposalBoard & { filter: ProposalBoardFilter }): void {
  const t = ctx.t;
  const f = b.filter;
  const link = (changes: Record<string, string | string[] | null>) => withParams(ctx, changes);
  const facets = html`${facetGroup(ctx, {
    title: t('filter.project'),
    clear: f.projects.length > 0 ? link({ project: null }) : null,
    items: b.projects.map((v) => ({
      label: v.value,
      count: v.count,
      checked: f.projects.includes(v.value),
      href: link({ project: toggled(f.projects, v.value) }),
    })),
  })}`;
  const tags = f.projects.map((p) => ({
    label: p,
    href: link({ project: toggled(f.projects, p) }),
  }));
  const rows =
    b.rows.length === 0
      ? empty(ctx, {
          icon: 'inbox',
          title: f.status === 'pending' ? t('proposals.nonePending') : t('proposals.none'),
          text: t('proposals.noneHelp'),
          action: linkButton(ctx, {
            href: docsUrl(ctx, 'guide/concepts#proposals'),
            label: t('proposals.howItWorks'),
            size: 'sm',
          }),
        })
      : html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
    <thead><tr><th>${t('entries.text')}</th><th>${t('entries.kind')}</th><th>${t('filter.project')}</th><th>${t('proposals.agent')}</th><th class="ol-num">${t('entries.confidence')}</th><th class="ol-num">${t('proposals.when')}</th></tr></thead>
    <tbody>${b.rows.map((r) => (r.rejected ? rejectedRow(ctx, r.proposal) : shownRow(ctx, r.proposal)))}</tbody></table></div>`;
  renderPage(ctx, 200, {
    title: t('nav.proposals'),
    nav: 'proposals',
    count: b.total,
    body: html`${pageIntro(ctx, { description: t('proposals.help') })}
    ${filterLayout(ctx, {
      facets,
      ranges: linkChips(
        ctx,
        PROPOSAL_STATUSES.map((s) => ({
          label: t(`proposals.status.${s}`),
          href: link({ status: s === 'pending' ? null : s }),
          current: f.status === s,
          count:
            s === 'all' ? b.counts.pending + b.counts.accepted + b.counts.rejected : b.counts[s],
        })),
      ),
      tags,
      body: html`${rows}
      ${listPager(ctx, { page: b.page, size: PAGE_SIZE, shown: b.rows.length, total: b.total, more: b.more })}`,
    })}`,
  });
}

/** A proposal's page: what it proposes and rests on, and, while it is pending, accept and reject. */
export function proposalPage(
  ctx: Ctx,
  status: number,
  d: ProposalDetail,
  o: { error?: string; reason?: string } = {},
): void {
  const t = ctx.t;
  const crumbs = [{ label: t('nav.proposals'), href: '/admin/proposals' }];
  if (d.state === 'rejected') {
    const r = d.rejected;
    renderPage(ctx, status, {
      title: r.id,
      nav: 'proposals',
      crumbs,
      heading: html`<span class="ol-mono">${r.id}</span>`,
      badges: statusTag(ctx, 'rejected'),
      body: html`<div class="ol-notices">${alert(
        ctx,
        'info',
        html`${t('proposal.rejectedNotice', { when: fmtDateTime(r.rejectedAt), author: r.author ?? '—' })} <a class="ol-mono" href="${href('tombstone', { id: r.forget })}">${r.forget}</a>`,
      )}</div>
      ${box({ title: t('tombstones.reason'), body: html`<p>${r.reason ?? '—'}</p>` })}`,
    });
    return;
  }
  const { proposal: p, session, sources, missing, entry } = d.card;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const sourceList = box({
    title: html`${t('entry.sourcesTitle')}<span class="ol-count">${n(sources.length)}</span>`,
    aside: t('proposal.sourcesHelp'),
    flush: true,
    body: html`<ol class="admin-sources">${sources.map(
      (s) => html`<li>
        <div class="admin-source-head">
          ${eventTag(ctx, s.event)}
          <a href="${sessionHref({ source: s.event.source, sessionId: s.event.sessionId })}">${s.event.project ?? s.event.source}</a>
          <a class="admin-source-time" href="${href('event', { id: s.event.id })}" title="${s.event.id}">${time(s.event.ts)}</a>
        </div>
        ${s.quote ? html`<blockquote class="ol-quote">${s.quote}</blockquote>` : ''}
        <div class="admin-source-text">${clip(s.event.text, 600)}</div>
      </li>`,
    )}</ol>`,
  });
  const details = box({
    title: t('entry.details'),
    body: html`<dl class="ol-dl">
      <dt>${t('entries.kind')}</dt><dd>${kindTag(ctx, p.kind)}</dd>
      <dt>${t('proposals.status')}</dt><dd>${t(`proposals.status.${p.status}`)}</dd>
      <dt>${t('entries.confidence')}</dt><dd>${p.confidence}</dd>
      <dt>${t('filter.project')}</dt><dd>${p.project ?? (p.sessionProject ? t('proposal.sessionProject', { project: p.sessionProject }) : '—')}</dd>
      ${p.validFrom !== null || p.validTo !== null ? html`<dt>${t('entry.valid')}</dt><dd>${time(p.validFrom)} – ${time(p.validTo)}</dd>` : ''}
      <dt>${t('proposals.agent')}</dt><dd>${p.source}</dd>
      <dt>${t('proposals.when')}</dt><dd>${time(p.at)}</dd>
      <dt>${t('proposal.session')}</dt><dd>${session ? html`<a href="${sessionHref(session)}">${sessionName(ctx, session, 60)}</a>` : html`<span class="ol-mono">${p.sessionId}</span>`}</dd>
      <dt>${t('proposal.event')}</dt><dd><a class="ol-mono" href="${href('event', { id: p.eventId })}">${p.eventId}</a></dd>
      <dt>ID</dt><dd class="ol-mono">${p.id}</dd>
    </dl>`,
  });
  const decide =
    p.status === 'accepted'
      ? ''
      : box({
          title: t('proposal.decide'),
          body: html`<div class="ol-stack">
        <form method="post" action="/admin/proposal/accept" class="ol-form">
          ${csrfField(ctx)}
          <input type="hidden" name="id" value="${p.id}">
          <p class="ol-hint">${t('proposal.acceptHelp')}</p>
          <div class="ol-form-actions">${submitButton(ctx, { label: t('proposal.accept'), icon: 'check' })}</div>
        </form>
        <form method="post" action="/admin/proposal/reject" class="ol-form">
          ${csrfField(ctx)}
          <input type="hidden" name="id" value="${p.id}">
          <div class="ol-field">
            <label class="ol-label" for="reason">${t('forget.reason')}</label>
            <input class="ol-input" type="text" id="reason" name="reason" required maxlength="500" value="${o.reason ?? ''}" autocomplete="off" aria-describedby="reason-hint">
            <p class="ol-hint" id="reason-hint">${t('proposal.rejectHelp')}</p>
          </div>
          <div class="ol-form-actions">${submitButton(ctx, { label: t('proposal.reject'), icon: 'x', variant: 'danger-soft' })}</div>
        </form>
      </div>`,
        });
  renderPage(ctx, status, {
    title: p.id,
    nav: 'proposals',
    crumbs,
    heading: clip(entrySummary(p.text), 120),
    badges: html`${kindTag(ctx, p.kind)}${statusTag(ctx, p.status)}`,
    body: html`${facts(ctx, [
      projectOf(p) ? { icon: 'folder', value: projectOf(p) as string } : null,
      { icon: 'bot', value: p.source },
      { icon: 'clock', value: time(p.at) },
      { label: t('entries.confidence'), value: String(p.confidence) },
    ])}
    ${o.error ? html`<div class="ol-notices">${alert(ctx, 'danger', o.error)}</div>` : ''}
    ${entry ? html`<div class="ol-notices">${alert(ctx, 'success', html`${t('proposal.acceptedAs')} <a class="ol-mono" href="${href('entry', { id: entry.id })}">${entry.id}</a>`)}</div>` : ''}
    ${missing > 0 ? html`<div class="ol-notices">${alert(ctx, 'warning', t('proposal.missing', { n: missing }))}</div>` : ''}
    <div class="ol-layout-supporting">
      <div class="ol-stack">
        ${box({ title: t('entries.text'), body: html`<div class="admin-entry-text">${p.text}</div>` })}
        ${p.note ? box({ title: t('proposal.note'), body: html`<p>${p.note}</p>` }) : ''}
        ${sourceList}
      </div>
      <div class="ol-stack">${decide}${details}</div>
    </div>`,
  });
}
