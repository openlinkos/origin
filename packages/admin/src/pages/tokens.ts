import { type GrantInfo, PRESETS, type Preset, type TokenInfo } from '@openlinkos/origin-core';
import type { Ctx } from '../context.js';
import { time } from '../context.js';
import { href, html, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import type { Access, AgentSnippets } from '../service.js';
import {
  alert,
  badge,
  copyButton,
  empty,
  linkButton,
  pageIntro,
  panel,
  section,
  snippet,
  submitButton,
  tableWrap,
} from './components.js';
import { csrfField, renderPage } from './layout.js';

/** A token's or a grant's state: active, revoked (and when), or expired. */
function state(ctx: Ctx, revokedAt: number | null, label?: string, expired = false): SafeHtml {
  const t = ctx.t;
  if (revokedAt !== null) {
    return html`${badge(label ?? t('tokens.revoked'))}<span class="ol-cell-sub">${time(revokedAt)}</span>`;
  }
  if (expired) return badge(t('tokens.expired'));
  return badge(t('tokens.active'), 'success', { dot: true });
}

export function presetBadge(ctx: Ctx, preset: Preset): SafeHtml {
  return preset === 'readonly'
    ? badge(ctx.t('preset.readonly'), 'info')
    : badge(ctx.t('preset.readwrite'), 'accent');
}

const revokeLink = (ctx: Ctx, path: string, params: Record<string, string>) =>
  html`<a class="ol-btn ol-btn-danger-soft ol-btn-sm" href="${href(path, params)}">${icon(ctx, 'ban', 'sm')}${ctx.t('tokens.revoke')}</a>`;

/**
 * Devices and agents: everything that reaches the hub for its owner (see
 * docs/architecture.md#access). Devices with their tokens and what they last sent; agents with a
 * token and its preset; agents signed in by OAuth, with their preset and when they expire. Each
 * can be revoked; nothing can be shown again.
 */
export function tokensPage(ctx: Ctx, a: Access, notice?: string): void {
  const t = ctx.t;
  const devices = a.devices.length
    ? tableWrap(
        html`<th>${t('tokens.name')}</th><th>${t('tokens.status')}</th><th>${t('devices.lastPush')}</th><th>${t('tokens.lastUsed')}</th><th>${t('tokens.created')}</th><th class="ol-actions"><span class="ol-sr-only">${t('tokens.actions')}</span></th>`,
        a.devices.map(
          (d) => html`<tr>
          <td>${d.data ? html`<a class="ol-cell-title" href="${href('device', { name: d.name })}">${d.name}</a>` : html`<span class="ol-cell-title">${d.name}</span>`}</td>
          <td>${d.token ? state(ctx, d.token.revokedAt) : html`<span class="ol-subtle">${t('devices.noToken')}</span>`}</td>
          <td class="ol-nowrap" data-label="${t('devices.lastPush')}">${time(d.data?.lastUpdateAt ?? null)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.lastUsed')}">${time(d.token?.lastUsedAt ?? null)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.created')}">${time(d.token?.createdAt ?? null)}</td>
          <td class="ol-actions">${d.token && d.token.revokedAt === null ? revokeLink(ctx, 'tokens/revoke', { name: d.name }) : ''}</td>
        </tr>`,
        ),
        'ol-table-stack',
      )
    : empty(ctx, {
        icon: 'laptop',
        title: t('tokens.noDevices'),
        text: t('tokens.noDevicesHelp'),
        action: linkButton(ctx, {
          href: '/admin/connect',
          label: t('tokens.connectDevice'),
          icon: 'plug',
          size: 'sm',
        }),
      });
  const agents = a.agents.length
    ? tableWrap(
        html`<th>${t('tokens.name')}</th><th>${t('tokens.preset')}</th><th>${t('tokens.status')}</th><th>${t('tokens.lastUsed')}</th><th>${t('tokens.created')}</th><th class="ol-actions"><span class="ol-sr-only">${t('tokens.actions')}</span></th>`,
        a.agents.map(
          (tok: TokenInfo) => html`<tr>
          <td><span class="ol-cell-title">${tok.name}</span></td>
          <td>${presetBadge(ctx, tok.preset)}</td>
          <td>${state(ctx, tok.revokedAt)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.lastUsed')}">${time(tok.lastUsedAt)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.created')}">${time(tok.createdAt)}</td>
          <td class="ol-actions">${tok.revokedAt === null ? revokeLink(ctx, 'tokens/revoke', { name: tok.name }) : ''}</td>
        </tr>`,
        ),
        'ol-table-stack',
      )
    : empty(ctx, {
        icon: 'bot',
        title: t('tokens.noAgents'),
        text: t('tokens.noAgentsHelp'),
        action: linkButton(ctx, {
          href: '/admin/tokens/new',
          label: t('tokens.create'),
          icon: 'plus',
          size: 'sm',
        }),
      });
  const grants = a.grants.length
    ? tableWrap(
        html`<th>${t('tokens.agent')}</th><th>${t('tokens.preset')}</th><th>${t('tokens.status')}</th><th>${t('tokens.lastUsed')}</th><th>${t('tokens.signedIn')}</th><th>${t('tokens.expires')}</th><th class="ol-actions"><span class="ol-sr-only">${t('tokens.actions')}</span></th>`,
        a.grants.map(
          (g) => html`<tr>
          <td><span class="ol-cell-title">${g.name}</span><span class="ol-cell-sub">${g.clientName || t('consent.unnamed')}</span></td>
          <td>${presetBadge(ctx, g.preset)}</td>
          <td>${state(ctx, g.revokedAt, g.revokedBy ? t(`grants.by.${g.revokedBy as 'owner' | 'client' | 'reuse'}`) : undefined, !g.active)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.lastUsed')}">${time(g.lastUsedAt)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.signedIn')}">${time(g.createdAt)}</td>
          <td class="ol-nowrap" data-label="${t('tokens.expires')}">${time(g.expiresAt)}</td>
          <td class="ol-actions">${g.active ? revokeLink(ctx, 'grants/revoke', { id: g.id }) : ''}</td>
        </tr>`,
        ),
        'ol-table-stack',
      )
    : empty(ctx, { icon: 'shield-check', title: t('tokens.noApps'), text: t('tokens.noAppsHelp') });
  renderPage(ctx, 200, {
    title: t('nav.tokens'),
    nav: 'tokens',
    heading: t('tokens.title'),
    actions: html`${linkButton(ctx, { href: '/admin/connect', label: t('tokens.connectDevice'), icon: 'plug' })}${linkButton(
      ctx,
      { href: '/admin/tokens/new', label: t('tokens.create'), icon: 'plus', variant: 'primary' },
    )}`,
    body: html`${pageIntro(ctx, { description: t('tokens.help') })}
    ${notice ? html`<div class="ol-notices">${alert(ctx, 'success', notice)}</div>` : ''}
    <div class="ol-stack">
      ${section({
        title: t('tokens.devices'),
        description: t('tokens.devicesHelp'),
        actions: html`<a href="/admin/devices">${t('tokens.deviceData')}</a>`,
        body: devices,
      })}
      ${section({ title: t('tokens.apps'), description: t('tokens.appsHelp'), body: grants })}
      ${section({ title: t('tokens.agents'), description: t('tokens.agentsHelp'), body: agents })}
    </div>`,
  });
}

/** The choice of a preset, as radio buttons with what each allows. */
export function presetChoice(ctx: Ctx, presets: readonly Preset[], chosen: Preset): SafeHtml {
  const t = ctx.t;
  return html`<fieldset class="ol-fieldset">
    <legend>${t('tokens.preset')}</legend>
    ${presets.map(
      (p) =>
        html`<label class="ol-check"><input class="ol-radio" type="radio" name="preset" value="${p}"${p === chosen ? html` checked` : ''}><span><span class="ol-cell-title">${t(`preset.${p}`)}</span><span class="ol-cell-sub">${t(`preset.${p}Help`)}</span></span></label>`,
    )}
  </fieldset>`;
}

export function newTokenPage(
  ctx: Ctx,
  status: number,
  o: { name?: string; preset?: Preset; error?: string },
): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('tokens.create'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('tokens.create'),
    body: html`${pageIntro(ctx, { description: t('tokens.createHelp') })}
    <form method="post" action="/admin/tokens" class="ol-form">
      ${csrfField(ctx)}
      <div class="ol-field">
        <label class="ol-label" for="name">${t('tokens.name')}</label>
        <input class="ol-input ol-input-mono" type="text" id="name" name="name" required pattern="[a-z0-9][a-z0-9._\\-]{0,62}" maxlength="63" value="${o.name ?? ''}" autocomplete="off" spellcheck="false" placeholder="ci" aria-describedby="name-hint${o.error ? ' name-error' : ''}"${o.error ? html` aria-invalid="true"` : ''}>
        <p class="ol-hint" id="name-hint">${t('tokens.nameHelp')}</p>
        ${o.error ? html`<p class="ol-field-error" id="name-error" role="alert">${icon(ctx, 'circle-alert', 'sm')}${o.error}</p>` : ''}
      </div>
      ${presetChoice(ctx, PRESETS, o.preset ?? 'readwrite')}
      <div class="ol-form-actions">
        ${submitButton(ctx, { label: t('tokens.createButton'), icon: 'plus' })}
        ${linkButton(ctx, { href: '/admin/tokens', label: t('action.cancel'), variant: 'ghost' })}
      </div>
    </form>`,
  });
}

/** The commands that use an agent's token, each ready to copy. */
function agentSnippetsBlock(ctx: Ctx, s: AgentSnippets): SafeHtml {
  const t = ctx.t;
  return section({
    title: t('tokens.useIt'),
    description: t('tokens.useItHelp'),
    body: html`<div class="ol-stack">
        ${snippet(ctx, 'snippet-claude', 'Claude Code', s.claude)}
        ${snippet(ctx, 'snippet-codex', 'Codex CLI', s.codex)}
        ${s.lines ? snippet(ctx, 'snippet-lines', t('tokens.linesLabel'), s.lines) : ''}
      </div>`,
  });
}

export function tokenCreatedPage(
  ctx: Ctx,
  o: { name: string; preset: Preset; token: string; snippets: AgentSnippets },
): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('tokens.createdTitle'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('tokens.createdTitle'),
    badges: presetBadge(ctx, o.preset),
    actions: linkButton(ctx, {
      href: '/admin/tokens',
      label: t('tokens.done'),
      icon: 'check',
      variant: 'primary',
    }),
    body: html`<section class="ol-section ol-stack">
      ${alert(ctx, 'warning', t('tokens.shownOnce', { name: o.name }))}
      <div class="ol-field">
        <span class="ol-label">${t('tokens.token')}</span>
        <code class="ol-secret" id="token-value">${o.token}</code>
      </div>
      <div>${copyButton(ctx, 'token-value', { labelled: true })}</div>
    </section>
    ${o.snippets.known ? '' : html`<div class="ol-section">${alert(ctx, 'info', t('connect.noPublicUrl'))}</div>`}
    ${agentSnippetsBlock(ctx, o.snippets)}`,
  });
}

export function revokeTokenPage(
  ctx: Ctx,
  status: number,
  o: { name: string; device?: boolean; error?: string },
): void {
  const t = ctx.t;
  renderPage(ctx, status, {
    title: t('tokens.revokeTitle'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('tokens.revokeTitle'),
    body: html`${panel(ctx, {
      danger: true,
      title: t('tokens.revokeButton', { name: o.name }),
      icon: 'triangle-alert',
      body: html`<div class="ol-stack">
        ${o.error ? alert(ctx, 'danger', o.error) : ''}
        <p>${o.device ? t('tokens.revokeDeviceHelp', { name: o.name }) : t('tokens.revokeHelp', { name: o.name })}</p>
        <form method="post" action="/admin/tokens/revoke" class="ol-form-actions">
          ${csrfField(ctx)}
          <input type="hidden" name="name" value="${o.name}">
          ${submitButton(ctx, { label: t('tokens.revokeButton', { name: o.name }), icon: 'ban', variant: 'danger' })}
          ${linkButton(ctx, { href: '/admin/tokens', label: t('action.cancel'), variant: 'ghost' })}
        </form>
      </div>`,
    })}`,
  });
}

export function revokeGrantPage(
  ctx: Ctx,
  status: number,
  o: { grant: GrantInfo; error?: string },
): void {
  const t = ctx.t;
  const g = o.grant;
  renderPage(ctx, status, {
    title: t('grants.revokeTitle'),
    nav: 'tokens',
    crumbs: [{ label: t('nav.tokens'), href: '/admin/tokens' }],
    heading: t('grants.revokeTitle'),
    body: html`${panel(ctx, {
      danger: true,
      title: t('grants.revokeButton', { name: g.name }),
      icon: 'triangle-alert',
      body: html`<div class="ol-stack">
        ${o.error ? alert(ctx, 'danger', o.error) : ''}
        <p>${t('grants.revokeHelp', { name: g.name, client: g.clientName || t('consent.unnamed') })}</p>
        <form method="post" action="/admin/grants/revoke" class="ol-form-actions">
          ${csrfField(ctx)}
          <input type="hidden" name="id" value="${g.id}">
          ${submitButton(ctx, { label: t('grants.revokeButton', { name: g.name }), icon: 'ban', variant: 'danger' })}
          ${linkButton(ctx, { href: '/admin/tokens', label: t('action.cancel'), variant: 'ghost' })}
        </form>
      </div>`,
    })}`,
  });
}
