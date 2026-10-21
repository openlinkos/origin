import type { Ctx } from '../context.js';
import { fmtBytes, fmtDuration, fmtNumber, time } from '../context.js';
import { href, html } from '../html.js';
import type { DeviceDetail, DeviceSummary, Overview, Snippets } from '../service.js';
import { alert, badge, renderPage, snippet } from './layout.js';

function deviceRows(ctx: Ctx, devices: DeviceSummary[]) {
  const t = ctx.t;
  return devices.map(
    (d) => html`<tr>
      <td><a href="${href('device', { name: d.device })}">${d.device}</a></td>
      <td class="num">${fmtNumber(d.files, ctx.lang)}</td>
      <td class="num">${fmtBytes(d.bytes)}</td>
      <td>${time(d.lastUpdateAt)} ${d.stale ? badge(t('devices.stale'), 'warn') : ''}</td>
    </tr>`,
  );
}

function devicesTable(ctx: Ctx, devices: DeviceSummary[]) {
  const t = ctx.t;
  if (devices.length === 0) {
    return html`<p class="muted">${t('devices.none')} <a href="/admin/connect">${t('devices.howToConnect')}</a></p>`;
  }
  return html`<table>
    <thead><tr><th>${t('devices.name')}</th><th class="num">${t('devices.files')}</th><th class="num">${t('devices.bytes')}</th><th>${t('devices.lastPush')}</th></tr></thead>
    <tbody>${deviceRows(ctx, devices)}</tbody>
  </table>`;
}

export function overviewPage(ctx: Ctx, o: Overview): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const stat = (label: string, value: string, link?: string) =>
    html`<div class="stat"><div class="stat-value">${link ? html`<a href="${link}">${value}</a>` : value}</div><div class="stat-label">${label}</div></div>`;
  const stale = o.devices.filter((d) => d.stale);
  renderPage(ctx, 200, {
    title: t('nav.overview'),
    nav: 'overview',
    body: html`<h1>${t('overview.title')}</h1>
    ${stale.length > 0 ? alert('warn', t('overview.staleDevices', { n: stale.length })) : ''}
    ${o.parseErrors.last24h > 0 ? alert('warn', t('overview.parseErrors24h', { n: o.parseErrors.last24h })) : ''}
    <section class="stats">
      ${stat(t('overview.events'), n(o.counts.events), '/admin/sessions')}
      ${stat(t('overview.sessions'), n(o.counts.sessions), '/admin/sessions')}
      ${stat(t('overview.entries'), n(o.counts.entries), '/admin/entries')}
      ${stat(t('overview.devices'), n(o.counts.devices), '/admin/devices')}
      ${stat(t('overview.tokens'), n(o.counts.activeTokens), '/admin/tokens')}
      ${stat(t('overview.tombstones'), n(o.counts.tombstones), '/admin/tombstones')}
    </section>
    <div class="grid">
      <section class="card">
        <h2>${t('overview.devicesTitle')}</h2>
        ${devicesTable(ctx, o.devices)}
      </section>
      <section class="card">
        <h2>${t('overview.sourcesTitle')}</h2>
        ${
          o.sources.length === 0
            ? html`<p class="muted">${t('overview.noData')}</p>`
            : html`<table>
          <thead><tr><th>${t('overview.source')}</th><th class="num">${t('overview.sessions')}</th><th class="num">${t('overview.events')}</th><th>${t('overview.latest')}</th></tr></thead>
          <tbody>${o.sources.map(
            (s) =>
              html`<tr><td>${s.source}</td><td class="num">${n(s.sessions)}</td><td class="num">${n(s.events)}</td><td>${time(s.lastTs)}</td></tr>`,
          )}</tbody>
        </table>`
        }
        <p class="muted small">${t('overview.entriesByKind', { memory: n(o.entries.memory), knowledge: n(o.entries.knowledge), cognition: n(o.entries.cognition) })}</p>
      </section>
      <section class="card">
        <h2>${t('overview.healthTitle')}</h2>
        <dl class="kv">
          <dt>${t('overview.parseErrors')}</dt>
          <dd>${t('overview.parseErrorsValue', { day: n(o.parseErrors.last24h), week: n(o.parseErrors.last7d) })}</dd>
          ${o.parseErrors.bySource7d.map(
            (r) =>
              html`<dt class="sub">${r.source}${r.device ? html` · <a href="${href('device', { name: r.device })}">${r.device}</a>` : html` · ${t('overview.local')}`}</dt><dd>${n(r.parseErrors)}</dd>`,
          )}
          <dt>${t('overview.version')}</dt><dd>${o.version}</dd>
          <dt>${t('overview.uptime')}</dt><dd>${fmtDuration(o.uptimeMs, t)}</dd>
        </dl>
      </section>
      <section class="card">
        <h2>${t('overview.storageTitle')}</h2>
        <dl class="kv">
          <dt>${t('overview.database')}</dt><dd>${fmtBytes(o.usage.databaseBytes)}</dd>
          <dt>${t('overview.wal')}</dt><dd>${fmtBytes(o.usage.walBytes)}</dd>
          <dt>${t('overview.mirrorsLocal')}</dt><dd>${fmtBytes(o.usage.mirrorBytes.local)}</dd>
          <dt>${t('overview.mirrorsRemote')}</dt><dd>${fmtBytes(o.usage.mirrorBytes.remote)}</dd>
          <dt>${t('overview.freeDisk')}</dt><dd>${fmtBytes(o.usage.freeDiskBytes)}</dd>
        </dl>
      </section>
    </div>`,
  });
}

export function devicesPage(ctx: Ctx, devices: DeviceSummary[]): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.devices'),
    nav: 'devices',
    body: html`<h1>${t('nav.devices')}</h1>
    <p class="muted">${t('devices.help')}</p>
    <section class="card">${devicesTable(ctx, devices)}</section>`,
  });
}

export function devicePage(ctx: Ctx, d: DeviceDetail): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  renderPage(ctx, 200, {
    title: d.device.device,
    nav: 'devices',
    body: html`<p class="crumbs"><a href="/admin/devices">${t('nav.devices')}</a></p>
    <h1>${d.device.device} ${d.device.stale ? badge(t('devices.stale'), 'warn') : ''}</h1>
    <div class="grid">
      <section class="card">
        <dl class="kv">
          <dt>${t('devices.lastPush')}</dt><dd>${time(d.device.lastUpdateAt)}</dd>
          <dt>${t('devices.files')}</dt><dd>${n(d.device.files)}</dd>
          <dt>${t('devices.bytes')}</dt><dd>${fmtBytes(d.device.bytes)}</dd>
          <dt>${t('devices.token')}</dt><dd>${
            d.token
              ? html`${d.token.name} · ${d.token.revokedAt === null ? t('tokens.active') : t('tokens.revoked')} · ${t('tokens.lastUsed')} ${time(d.token.lastUsedAt)}`
              : html`<span class="muted">${t('devices.noToken')}</span>`
          }</dd>
        </dl>
      </section>
      <section class="card">
        <h2>${t('devices.health7d')}</h2>
        ${
          d.health.length === 0
            ? html`<p class="muted">${t('devices.noPushes7d')}</p>`
            : html`<table><thead><tr><th>${t('overview.source')}</th><th class="num">${t('devices.pushes')}</th><th class="num">${t('devices.lines')}</th><th class="num">${t('overview.events')}</th><th class="num">${t('overview.parseErrors')}</th></tr></thead>
          <tbody>${d.health.map(
            (h) =>
              html`<tr><td>${h.source}</td><td class="num">${n(h.runs)}</td><td class="num">${n(h.linesRead)}</td><td class="num">${n(h.eventsAdded)}</td><td class="num">${h.parseErrors > 0 ? badge(n(h.parseErrors), 'warn') : '0'}</td></tr>`,
          )}</tbody></table>`
        }
      </section>
    </div>
    <section class="card">
      <h2>${t('devices.filesTitle')}</h2>
      <table>
        <thead><tr><th>${t('overview.source')}</th><th>${t('devices.originalPath')}</th><th class="num">${t('devices.generation')}</th><th class="num">${t('devices.lines')}</th><th class="num">${t('devices.bytes')}</th><th>${t('devices.updated')}</th></tr></thead>
        <tbody>${d.files.map(
          (f) =>
            html`<tr><td>${f.source}</td><td class="path">${f.originalPath}</td><td class="num">${f.generation}</td><td class="num">${n(f.lines)}</td><td class="num">${fmtBytes(f.bytes)}</td><td>${time(f.updatedAt)}</td></tr>`,
        )}</tbody>
      </table>
    </section>`,
  });
}

export function connectPage(ctx: Ctx, s: Snippets): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.connect'),
    nav: 'connect',
    body: html`<h1>${t('connect.title')}</h1>
    <p>${t('connect.intro')} <a href="/admin/tokens/new">${t('connect.createToken')}</a></p>
    ${s.known ? '' : alert('info', t('connect.noPublicUrl'))}
    ${connectSnippetsBlock(ctx, s)}`,
  });
}

export function connectSnippetsBlock(ctx: Ctx, s: Snippets) {
  const t = ctx.t;
  const copy = t('action.copy');
  return html`<section class="card">
      <h2>${t('connect.device')}</h2>
      <p class="muted">${t('connect.deviceHelp')}</p>
      ${snippet('snippet-device', t('connect.deviceLabel'), s.device, copy)}
      ${snippet('snippet-cron', t('connect.cronLabel'), s.cron, copy)}
    </section>
    <section class="card">
      <h2>${t('connect.agents')}</h2>
      <p class="muted">${t('connect.agentsHelp')}</p>
      ${snippet('snippet-claude', 'Claude Code', s.claude, copy)}
      ${snippet('snippet-codex', 'Codex CLI', s.codex, copy)}
    </section>`;
}
