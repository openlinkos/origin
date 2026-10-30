/**
 * A session's page, as a trace: an outline of its turns, the one shown opened into its steps, and
 * that turn in full: the prompt, the recalls made in it, the tool run folded into one line that opens
 * to a row per call, and the agent's last reply as Markdown. Command echoes and injected context are
 * small notes, and each item links to its event's page for provenance.
 */
import { type EventRow, entrySummary } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { fmtNumber, fmtSpan, fmtSpanShort, time } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { type IconName, icon } from '../icons.js';
import { markdown } from '../markdown.js';
import type { SessionTrace, TraceStep, TraceTurn } from '../service.js';
import type { Note, ToolRun, ToolSummary, Turn, TurnItem } from '../turns.js';
import { badge, chip, eventLink, linkButton, sessionHref, sessionName } from './components.js';
import { renderPage } from './layout.js';
import { agentTag, facts, linkChips } from './workbench.js';

/** A prompt longer than this shows its start, and the rest on request. */
const PROMPT_SHOWN = 1200;

const NOTE_ICON: Record<Note['kind'], IconName> = {
  command: 'terminal',
  output: 'file-text',
  notice: 'info',
  context: 'file-text',
  system: 'info',
};

const STATUS_ICON: Record<ToolRun['status'], IconName> = {
  ok: 'circle-check',
  error: 'circle-x',
  pending: 'loader-circle',
};

function subAgentTag(ctx: Ctx, on: boolean): HtmlValue {
  return on ? badge(ctx.t('turn.subAgent'), 'neutral', { square: true }) : '';
}

function noteChip(ctx: Ctx, item: Extract<TurnItem, { type: 'note' }>): SafeHtml {
  return chip(ctx, {
    icon: NOTE_ICON[item.note.kind],
    label: item.note.label,
    detail: item.note.detail,
    extra: html`${subAgentTag(ctx, item.subAgent)}${eventLink(ctx, item.event.id)}`,
  });
}

/** The leading context elements of a prompt (`<ide_opened_file>…`), apart from what was typed. */
function splitPrompt(text: string): { context: string[]; prompt: string } {
  const context: string[] = [];
  let rest = text;
  for (;;) {
    const trimmed = rest.trimStart();
    const open = /^<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>/.exec(trimmed);
    if (!open) break;
    const close = trimmed.indexOf(`</${open[1]}>`, open[0].length);
    if (close < 0) break;
    const end = close + (open[1]?.length ?? 0) + 3;
    context.push(trimmed.slice(0, end));
    rest = trimmed.slice(end);
  }
  return { context, prompt: rest.trim() };
}

function promptBlock(ctx: Ctx, e: EventRow): SafeHtml {
  const { context, prompt } = splitPrompt(e.text);
  const chips = context.map((c) => {
    const tag = /^<([A-Za-z][\w.:-]*)/.exec(c)?.[1] ?? '';
    return chip(ctx, { icon: 'file-text', label: tag, detail: c });
  });
  const long = prompt.length > PROMPT_SHOWN;
  return html`<div class="admin-prompt">
      <span class="admin-turn-avatar" data-role="user">${icon(ctx, 'user', 'sm')}</span>
      <div class="admin-prompt-body">
        ${chips.length > 0 ? html`<div class="ol-cluster">${chips}</div>` : ''}
        <div class="admin-prompt-text">${long ? `${prompt.slice(0, PROMPT_SHOWN)}…` : prompt}</div>
        ${long ? html`<details class="ol-details"><summary>${ctx.t('turn.wholePrompt', { n: fmtNumber(prompt.length, ctx.lang) })}</summary><div class="admin-prompt-text">${prompt}</div></details>` : ''}
      </div>
      ${eventLink(ctx, e.id)}
    </div>`;
}

/** A turn that starts at a command the agent acted on: the command, as a chip, where a prompt goes. */
function commandBlock(ctx: Ctx, e: EventRow, command: string): SafeHtml {
  const label = ctx.t('turn.command');
  return html`<div class="admin-prompt">
      <span class="admin-turn-avatar" data-role="user">${icon(ctx, 'user', 'sm')}</span>
      <div class="admin-prompt-body">
        <span class="ol-chip ol-chip-accent ol-chip-lg ol-chip-mono" title="${label}">${icon(ctx, 'terminal', 'sm')}<span class="ol-sr-only">${label}: </span><span class="ol-chip-label">${command}</span></span>
      </div>
      ${eventLink(ctx, e.id)}
    </div>`;
}

/** The input of a call, pretty-printed when it is JSON. */
function inputText(input: string): string {
  const text = input.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function toolRow(ctx: Ctx, item: Extract<TurnItem, { type: 'tool' }>): SafeHtml {
  const t = ctx.t;
  const tool = item.tool;
  const last = tool.more.at(-1) ?? tool.result;
  const took =
    tool.call && last && last.ts >= tool.call.ts ? fmtSpan(last.ts - tool.call.ts, t) : '';
  const status = t(`turn.status.${tool.status}`);
  return html`<li class="admin-tool" data-status="${tool.status}"${item.subAgent ? html` data-subagent="true"` : ''}>
      <details>
        <summary class="admin-tool-line">
          <span class="admin-tool-status" title="${status}">${icon(ctx, STATUS_ICON[tool.status], 'sm')}<span class="ol-sr-only">${status}</span></span>
          <span class="admin-tool-name">${tool.name}</span>
          <span class="admin-tool-arg">${tool.argument}</span>
          ${item.subAgent ? html`<span class="ol-sr-only">${ctx.t('turn.subAgent')}</span>` : ''}
          ${took ? html`<span class="admin-tool-took">${took}</span>` : ''}
        </summary>
        <div class="admin-tool-body">
          ${
            tool.call
              ? html`<div class="ol-code ol-code-wrap"><div class="ol-code-label">${t('turn.input')}${eventLink(ctx, tool.call.id)}</div><pre>${inputText(tool.input)}</pre></div>`
              : ''
          }
          ${
            tool.result
              ? html`<div class="ol-code ol-code-wrap"><div class="ol-code-label">${t('turn.result')}${eventLink(ctx, tool.result.id)}</div><pre>${tool.result.text}</pre></div>`
              : html`<p class="ol-hint">${t('turn.noResult')}</p>`
          }
          ${tool.more.map((r) => html`<div class="ol-code ol-code-wrap"><div class="ol-code-label">${t('turn.result')}${eventLink(ctx, r.id)}</div><pre>${r.text}</pre></div>`)}
        </div>
      </details>
    </li>`;
}

function messageBlock(ctx: Ctx, e: EventRow, o: { subAgent: boolean; cls: string }): SafeHtml {
  const role = e.role === 'assistant' ? 'assistant' : 'user';
  return html`<div class="${o.cls}"${o.subAgent ? html` data-subagent="true"` : ''}>
      <span class="admin-turn-avatar" data-role="${role}">${icon(ctx, role === 'assistant' ? 'bot' : 'user', 'sm')}</span>
      <div class="admin-message-body">
        ${o.subAgent ? html`<div class="admin-message-meta">${subAgentTag(ctx, true)}</div>` : ''}
        ${markdown(e.text)}
      </div>
      ${eventLink(ctx, e.id)}
    </div>`;
}

function itemBlock(ctx: Ctx, item: TurnItem): SafeHtml {
  if (item.type === 'tool') return toolRow(ctx, item);
  if (item.type === 'note') return html`<li class="admin-step-note">${noteChip(ctx, item)}</li>`;
  return html`<li>${messageBlock(ctx, item.event, { subAgent: item.subAgent, cls: 'admin-step-message' })}</li>`;
}

/** The folded tool run's line: how many calls of which tools, how they went, and the messages. */
function summaryLine(ctx: Ctx, s: ToolSummary): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const names = s.byName.slice(0, 6);
  const others = s.byName.slice(6).reduce((sum, x) => sum + x.count, 0);
  return html`<span class="ol-fold-title">${icon(ctx, 'wrench', 'sm')}${s.calls > 0 ? t('turn.tools', { n: n(s.calls) }) : t('turn.steps')}</span>
    ${
      s.calls > 0
        ? html`<span class="ol-fold-meta ol-mono">${names.map(
            (x) => html`<span>${x.name}<span class="admin-times">×${n(x.count)}</span></span>`,
          )}${others > 0 ? html`<span>${t('turn.otherTools', { n: n(others) })}</span>` : ''}</span>
    <span class="ol-fold-meta">
      <span class="ol-tone-success" title="${t('turn.status.ok')}">${icon(ctx, 'circle-check', 'sm')}${n(s.ok)}<span class="ol-sr-only"> ${t('turn.status.ok')}</span></span>
      ${s.error > 0 ? html`<span class="ol-tone-danger" title="${t('turn.status.error')}">${icon(ctx, 'circle-x', 'sm')}${n(s.error)}<span class="ol-sr-only"> ${t('turn.status.error')}</span></span>` : ''}
      ${s.pending > 0 ? html`<span class="ol-subtle" title="${t('turn.status.pending')}">${icon(ctx, 'loader-circle', 'sm')}${n(s.pending)}<span class="ol-sr-only"> ${t('turn.status.pending')}</span></span>` : ''}
    </span>`
        : ''
    }
    ${s.messages > 0 ? html`<span class="ol-fold-end">${t('turn.messages', { n: n(s.messages) })}</span>` : ''}`;
}

function workBlock(ctx: Ctx, turn: Turn, open: boolean): HtmlValue {
  if (turn.work.length === 0) return '';
  if (turn.tools.calls === 0) {
    // No tools: what the agent said on the way is shown as it is.
    return html`<ol class="admin-work">${turn.work.map((i) => itemBlock(ctx, i))}</ol>`;
  }
  return html`<details class="ol-fold"${open ? html` open` : ''}>
      <summary>${summaryLine(ctx, turn.tools)}</summary>
      <ol class="ol-fold-body admin-work">${turn.work.map((i) => itemBlock(ctx, i))}</ol>
    </details>`;
}

function notes(ctx: Ctx, items: TurnItem[]): HtmlValue {
  const chips = items.map((i) =>
    i.type === 'note'
      ? noteChip(ctx, i)
      : i.type === 'message'
        ? messageBlock(ctx, i.event, { subAgent: i.subAgent, cls: 'admin-step-message' })
        : html`<ol class="admin-work">${toolRow(ctx, i)}</ol>`,
  );
  return chips.length > 0 ? html`<div class="ol-cluster">${chips}</div>` : '';
}

const STEP_ICON: Record<TraceStep['kind'], IconName> = {
  prompt: 'user',
  recall: 'lightbulb',
  tool: 'wrench',
  reply: 'bot',
};

/** A duration as a bar, on a log scale against the longest turn, so short turns still show. */
function durationBar(ms: number, longest: number): SafeHtml {
  const width = longest <= 0 ? 0 : (Math.log1p(ms / 1000) / Math.log1p(longest / 1000)) * 100;
  return html`<svg class="admin-bar-track" viewBox="0 0 100 4" focusable="false" aria-hidden="true"><rect class="admin-bar-fill" width="${Math.max(2, Math.round(width))}" height="4" rx="2"/></svg>`;
}

/** Where a step falls in its turn: a mark for each call, as wide as it took. */
function spanBar(step: TraceStep): SafeHtml {
  return html`<svg class="admin-span-track" viewBox="0 0 100 8" preserveAspectRatio="none" focusable="false" aria-hidden="true">${step.spans.map(
    ([a, b]) =>
      html`<rect class="admin-span admin-span-${step.kind}" x="${Math.min(98.5, Math.round(a * 1000) / 10)}" width="${Math.max(1.5, Math.round((b - a) * 1000) / 10)}" y="1" height="6" rx="1"/>`,
  )}</svg>`;
}

/** The outline's row for a turn, with the steps of the one shown beneath it. */
function outlineRow(ctx: Ctx, o: SessionTrace, t: TraceTurn, longest: number): SafeHtml {
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const tr = ctx.t;
  const current = t.number === o.number;
  const label =
    t.number === 0
      ? html`<span class="admin-faint">${tr('turn.before')}</span>`
      : t.label
        ? t.label
        : html`<span class="admin-faint">—</span>`;
  const steps = current
    ? html`<ol class="admin-steps">${o.steps.map(
        (s) => html`<li class="admin-step">
          <span class="admin-step-name">${icon(ctx, STEP_ICON[s.kind], 'sm')}${s.kind === 'tool' ? s.label : tr(`step.${s.kind}`)}${s.count > 1 ? html`<span class="admin-faint">×${n(s.count)}</span>` : ''}${s.failed > 0 ? html`<span class="admin-bad">${tr('trace.failed', { n: n(s.failed) })}</span>` : ''}</span>
          ${spanBar(s)}
        </li>`,
      )}</ol>`
    : '';
  return html`<li${current ? html` aria-current="true"` : ''}>
    <a class="admin-outline-row" href="${sessionHref(o.session, { turn: t.number, show: o.show === 'all' ? null : o.show })}#detail">
      <span class="admin-outline-n">${t.number === 0 ? '' : n(t.number)}</span>
      <span class="admin-outline-label">${t.recalls > 0 ? html`<span class="admin-recall-dot" title="${tr('trace.recalled', { n: n(t.recalls) })}"></span>` : ''}<span class="admin-outline-text">${label}</span></span>
      <span class="admin-outline-meta">${t.tools > 0 ? html`<span title="${tr('trace.calls', { n: n(t.tools) })}">${icon(ctx, 'wrench', 'sm')}${n(t.tools)}</span>` : ''}${t.failed > 0 ? html`<span class="admin-bad" title="${tr('trace.failed', { n: n(t.failed) })}">${icon(ctx, 'circle-x', 'sm')}${n(t.failed)}</span>` : ''}</span>
      ${durationBar(t.duration, longest)}
      <span class="admin-outline-time" title="${fmtSpan(t.duration, tr)}">${fmtSpanShort(t.duration)}</span>
    </a>
    ${steps}
  </li>`;
}

/** A recall made in the turn: when, how much, and its items as they are now. */
function recallCard(ctx: Ctx, r: SessionTrace['recalls'][number]): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const used = new Set(r.used);
  return html`<section class="admin-recall-card">
    <header>
      ${icon(ctx, 'lightbulb', 'sm')}
      <a class="admin-recall-link" href="${href('recall', { id: r.id })}">${t(`recall.occasion.${r.occasion}`)}</a>
      <span class="admin-faint">${t('trace.recallSize', { n: n(r.items.length), tokens: n(r.tokens), budget: n(r.budget) })}</span>
      ${used.size > 0 ? html`<span class="admin-good">${t('recalls.usedCount', { n: n(used.size) })}</span>` : ''}
    </header>
    <ul>${r.views.map(
      (i) => html`<li>
        <span class="admin-recall-layer">${t(`recall.layer.${i.layer}`)}</span>
        <span class="admin-recall-text">${
          i.gone
            ? html`<span class="admin-faint">${t(`recall.gone.${i.gone}`)}</span>`
            : i.entry
              ? html`<a href="${href('entry', { id: i.entry.id })}">${entrySummary(i.entry.text)}</a>`
              : i.session
                ? html`<a href="${sessionHref(i.session)}">${sessionName(ctx, i.session, 120)}</a>`
                : i.ref
        }</span>
        ${i.score === null ? '' : html`<span class="admin-faint admin-num">${i.score.toFixed(2)}</span>`}
        ${used.has(i.ref) ? html`<span class="admin-good">${t('recall.usedYes')}</span>` : ''}
      </li>`,
    )}</ul>
  </section>`;
}

/** The turn shown: its prompt, its recalls, its work folded into one row, and its reply. */
function turnDetail(ctx: Ctx, o: SessionTrace, open: boolean): SafeHtml {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const turn = o.turn;
  const step = (to: number | null, label: string, name: IconName) =>
    to === null
      ? html`<span class="ol-btn ol-btn-secondary ol-btn-sm" aria-disabled="true">${icon(ctx, name, 'sm')}${label}</span>`
      : html`<a class="ol-btn ol-btn-secondary ol-btn-sm" href="${sessionHref(o.session, { turn: to, show: o.show === 'all' ? null : o.show })}#detail">${icon(ctx, name, 'sm')}${label}</a>`;
  const title =
    o.number === 0
      ? t('turn.before')
      : o.part > 0
        ? t('turn.titlePart', { n: n(o.number), part: n(o.part + 1) })
        : t('turn.title', { n: n(o.number) });
  if (!turn) {
    return html`<section class="admin-trace-detail" id="detail"><p class="admin-muted">${t('sessions.noEvents')}</p></section>`;
  }
  return html`<section class="admin-trace-detail" id="detail" aria-label="${title}">
    <div class="admin-detail-head">
      <h2>${title}</h2>
      <span class="admin-fact">${icon(ctx, 'clock', 'sm')}${time(turn.startedAt)}</span>
      <span class="admin-fact">${icon(ctx, 'timer', 'sm')}${fmtSpan(turn.endedAt - turn.startedAt, t)}</span>
      ${turn.tools.calls > 0 ? html`<span class="admin-fact">${t('trace.calls', { n: n(turn.tools.calls) })}</span>` : ''}
      <span class="admin-detail-nav"><button type="button" class="ol-btn ol-btn-secondary ol-btn-sm ol-sheet-open" popovertarget="turns">${icon(ctx, 'list', 'sm')}${t('trace.turnOf', { n: n(o.number), total: n(o.total) })}</button>${step(o.previous, t('trace.previous'), 'chevron-left')}${step(o.next, t('trace.next'), 'chevron-right')}</span>
    </div>
    ${notes(ctx, turn.lead)}
    ${turn.prompt ? (turn.command !== null ? commandBlock(ctx, turn.prompt, turn.command) : promptBlock(ctx, turn.prompt)) : ''}
    ${o.part === 0 ? o.recalls.map((r) => recallCard(ctx, r)) : ''}
    ${workBlock(ctx, turn, open)}
    ${turn.reply ? messageBlock(ctx, turn.reply, { subAgent: false, cls: 'admin-reply' }) : ''}
    ${notes(ctx, turn.trail)}
    ${
      o.continues
        ? html`<p class="admin-after">${linkButton(ctx, { href: `${sessionHref(o.session, { turn: o.number, part: o.part + 1 })}#detail`, label: t('trace.morePart'), size: 'sm' })}</p>`
        : ''
    }
  </section>`;
}

/**
 * A session as a trace: its facts, an outline of its turns on the left (the one shown opens into
 * its steps, placed in time), and the turn shown on the right.
 */
export function sessionPage(ctx: Ctx, o: SessionTrace & { open: boolean }): void {
  const t = ctx.t;
  const s = o.session;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const longest = Math.max(0, ...o.outline.map((x) => x.duration));
  const show = (value: SessionTrace['show'], label: string, count?: number) => ({
    label,
    href: sessionHref(s, { turn: o.number, show: value === 'all' ? null : value }),
    current: o.show === value,
    count,
  });
  const name = s.title ?? s.prompt ?? t('sessions.untitled');
  renderPage(ctx, 200, {
    title: name,
    nav: 'sessions',
    crumbs: [{ label: t('nav.sessions'), href: '/admin/sessions' }],
    heading: s.title ? s.title : sessionName(ctx, s, 160),
    body: html`${facts(ctx, [
      { value: agentTag(s.source) },
      s.project ? { icon: 'folder', value: s.project } : null,
      { icon: 'clock', value: html`${time(s.startedAt)} – ${time(s.endedAt)}` },
      { label: t('sessions.turns'), value: n(o.total) },
      { label: t('overview.events'), value: n(s.eventCount) },
      { label: t('trace.toolCalls'), value: n(o.totals.tools) },
      o.totals.recalls > 0
        ? {
            label: t('nav.recalls'),
            value: t('trace.recallTotals', { n: n(o.totals.recalls), used: n(o.totals.used) }),
          }
        : null,
    ])}
    <div class="ol-layout-list-detail admin-trace">
      <nav class="ol-sheet admin-trace-outline" id="turns" popover aria-label="${t('trace.outline')}">
        <div class="ol-sheet-head"><h2 class="ol-sheet-title">${t('trace.outline')}</h2><button type="button" class="ol-btn ol-btn-ghost ol-btn-icon ol-btn-sm" popovertarget="turns" popovertargetaction="hide" aria-label="${t('action.close')}">${icon(ctx, 'x', 'sm')}</button></div>
        <div class="admin-trace-tabs">${linkChips(ctx, [
          show('all', t('trace.all')),
          show('recalled', t('trace.withRecalls'), o.totals.withRecalls),
          show('failed', t('trace.withFailures'), o.totals.withFailures),
        ])}</div>
        ${o.earlier !== null ? html`<a class="admin-outline-more" href="${sessionHref(s, { turn: o.earlier, show: o.show === 'all' ? null : o.show })}">${t('trace.earlier')}</a>` : ''}
        <ol class="admin-outline">${o.outline.map((x) => outlineRow(ctx, o, x, longest))}</ol>
        ${o.later !== null ? html`<a class="admin-outline-more" href="${sessionHref(s, { turn: o.later, show: o.show === 'all' ? null : o.show })}">${t('trace.later')}</a>` : ''}
      </nav>
      ${turnDetail(ctx, o, o.open)}
    </div>`,
  });
}
