/**
 * A session's page: its turns, one card each. A card shows the prompt, the tool run folded into
 * one line that opens to a row per call, and the agent's last reply as Markdown. Command echoes and
 * injected context are small notes, and each item links to its event's page for provenance.
 */
import type { EventRow } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { dayLabel, fmtNumber, fmtSpan, time } from '../context.js';
import { type HtmlValue, html, type SafeHtml } from '../html.js';
import { type IconName, icon } from '../icons.js';
import { markdown } from '../markdown.js';
import type { SessionTurns } from '../service.js';
import type { Note, ToolRun, ToolSummary, Turn, TurnItem } from '../turns.js';
import {
  badge,
  chip,
  eventLink,
  pageHeader,
  sessionHref,
  sessionName,
  sourceBadge,
} from './components.js';
import { renderPage } from './layout.js';
import { recallMarker } from './recalls.js';

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

function turnCard(
  ctx: Ctx,
  turn: Turn,
  o: { open: boolean; part: number; recalls: SessionTurns['recalls'] },
): SafeHtml {
  const recalls = o.part > 0 ? [] : o.recalls.filter((r) => r.turn === turn.number);
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const title =
    turn.number === 0
      ? t('turn.before')
      : o.part > 0
        ? t('turn.titlePart', { n: n(turn.number), part: n(o.part + 1) })
        : t('turn.title', { n: n(turn.number) });
  return html`<li class="ol-card admin-turn" id="turn-${turn.number}">
      <div class="admin-turn-head">
        <h2 class="admin-turn-title"><a href="#turn-${turn.number}">${title}</a></h2>
        <span class="admin-turn-meta">
          ${time(turn.startedAt)}
          <span class="admin-sep" aria-hidden="true">·</span><span title="${t('turn.durationHelp')}">${fmtSpan(turn.endedAt - turn.startedAt, t)}</span>
          <span class="admin-sep" aria-hidden="true">·</span><span>${t('sessions.eventCount', { n: n(turn.events) })}</span>
        </span>
      </div>
      ${recalls.length > 0 ? html`<div class="ol-cluster" aria-label="${t('recalls.inTurn')}">${recalls.map((r) => recallMarker(ctx, r))}</div>` : ''}
      ${turn.prompt ? (turn.command !== null ? commandBlock(ctx, turn.prompt, turn.command) : promptBlock(ctx, turn.prompt)) : ''}
      ${notes(ctx, turn.lead)}
      ${workBlock(ctx, turn, o.open)}
      ${turn.reply ? messageBlock(ctx, turn.reply, { subAgent: false, cls: 'admin-reply' }) : ''}
      ${notes(ctx, turn.trail)}
    </li>`;
}

export function sessionPage(ctx: Ctx, o: SessionTurns & { open: boolean }): void {
  const t = ctx.t;
  const s = o.session;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const name = s.title ?? s.prompt ?? t('sessions.untitled');
  const link = (to: { turn: number; part: number }, anchor = '') =>
    `${sessionHref(s, { turn: to.turn, part: to.part || null, tools: o.open })}${anchor}`;
  const shown = o.turns.filter((x) => x.number > 0);
  const firstShown = shown[0]?.number;
  const lastShown = shown.at(-1)?.number;
  const prompts = o.total - (o.preamble ? 1 : 0);
  // A link without href is not focusable; aria-disabled dims it.
  const step = (to: SessionTurns['next'], label: string) =>
    to === null
      ? html`<a class="ol-btn ol-btn-secondary ol-btn-sm" aria-disabled="true">${label}</a>`
      : html`<a class="ol-btn ol-btn-secondary ol-btn-sm" href="${link(to)}">${label}</a>`;
  const pagerNav =
    o.previous === null && o.next === null
      ? ''
      : html`<nav class="ol-pager" aria-label="${t('pager.label')}"><span>${
          firstShown === undefined
            ? ''
            : t('turns.range', {
                from: n(firstShown),
                to: n(lastShown ?? firstShown),
                n: n(prompts),
              })
        }</span><span class="ol-pager-links">${step(o.previous, t('turns.earlier'))}${step(o.next, t('turns.later'))}</span></nav>`;
  const view = (open: boolean, label: string) =>
    html`<a href="${sessionHref(s, { turn: o.turn, part: o.part || null, tools: open })}"${o.open === open ? html` aria-current="true"` : ''}>${label}</a>`;
  renderPage(ctx, 200, {
    title: name,
    nav: 'sessions',
    crumbs: [{ label: t('nav.sessions'), href: '/admin/sessions' }],
    body: html`${pageHeader(ctx, {
      title: s.title ? s.title : sessionName(ctx, s, 200),
      meta: [
        sourceBadge(s.source),
        s.project ? html`${icon(ctx, 'folder', 'sm')}${s.project}` : '',
        html`${icon(ctx, 'clock', 'sm')}${time(s.startedAt)} – ${time(s.endedAt)}`,
        html`${icon(ctx, 'list', 'sm')}${t('sessions.turnCount', { n: n(prompts) })}`,
        html`${icon(ctx, 'message-square', 'sm')}${t('sessions.eventCount', { n: n(s.eventCount) })}`,
      ],
    })}
    <details class="ol-details admin-session-ids">
      <summary>${t('sessions.details')}</summary>
      <dl class="ol-dl">
        <dt>${t('sessions.id')}</dt><dd class="ol-mono">${s.sessionId}</dd>
        <dt>${t('sessions.cwd')}</dt><dd class="ol-mono">${s.cwd ?? '—'}</dd>
      </dl>
    </details>
    <div class="admin-session-bar">
      ${
        o.days.length > 1
          ? html`<nav class="admin-days" aria-label="${t('turns.days')}">${icon(ctx, 'calendar', 'sm')}<ol class="ol-cluster">${o.days.map(
              (d) =>
                // A day is current when some of its turns are on this page.
                html`<li><a class="ol-chip" href="${link({ turn: d.turn, part: 0 }, `#turn-${d.turn}`)}"${firstShown !== undefined && d.turn <= (lastShown ?? firstShown) && d.turn + d.turns - 1 >= firstShown ? html` aria-current="true"` : ''}>${dayLabel(ctx, d.day, { weekday: false })}<span class="admin-times">${n(d.turns)}</span></a></li>`,
            )}</ol></nav>`
          : html`<span></span>`
      }
      <div class="ol-segmented" role="group" aria-label="${t('turns.view')}">
        ${view(false, t('turns.folded'))}${view(true, t('turns.expanded'))}
      </div>
    </div>
    ${pagerNav}
    ${
      o.turns.length === 0
        ? html`<p class="ol-muted ol-text-sm">${t('sessions.noEvents')}</p>`
        : html`<ol class="admin-turns">${o.turns.map((turn) => turnCard(ctx, turn, { open: o.open, part: o.part, recalls: o.recalls }))}</ol>`
    }
    ${o.continues ? html`<p class="ol-hint admin-after">${t('turns.continues')}</p>` : ''}
    ${pagerNav}`,
  });
}
