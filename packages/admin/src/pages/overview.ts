import type { Ctx } from '../context.js';
import { clip, fmtBytes, fmtCompact, fmtDuration, fmtNumber, time } from '../context.js';
import { type HtmlValue, href, html, type SafeHtml } from '../html.js';
import { type IconName, icon } from '../icons.js';
import {
  ACTIVITY_DAYS,
  type ActivityDay,
  type DeviceDetail,
  type DeviceSummary,
  type HubLink,
  type Overview,
  type Snippets,
} from '../service.js';
import { stackedColumns } from './chart.js';
import {
  alert,
  badge,
  empty,
  linkButton,
  pageIntro,
  section,
  sessionHref,
  sessionName,
  snippet,
  tableWrap,
} from './components.js';
import { docsUrl, renderPage } from './layout.js';
import {
  agentSlot,
  agentTag,
  box,
  KIND_SLOTS,
  kindTag,
  listPager,
  ratioBar,
  sparkline,
  splitBar,
  whenShort,
} from './workbench.js';

function deviceStatus(ctx: Ctx, d: Pick<DeviceSummary, 'stale'>): SafeHtml {
  return d.stale
    ? badge(ctx.t('devices.stale'), 'warning', { dot: true })
    : badge(ctx.t('devices.active'), 'success', { dot: true });
}

function devicesTable(ctx: Ctx, devices: DeviceSummary[]): SafeHtml {
  const t = ctx.t;
  if (devices.length === 0) {
    return empty(ctx, {
      icon: 'laptop',
      title: t('devices.noneTitle'),
      text: t('devices.none'),
      action: linkButton(ctx, {
        href: '/admin/connect',
        label: t('devices.howToConnect'),
        icon: 'plug',
        size: 'sm',
      }),
    });
  }
  return html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
    <thead><tr><th>${t('devices.name')}</th><th>${t('devices.lastPush')}</th><th class="ol-num">${t('devices.files')}</th><th class="ol-num">${t('devices.bytes')}</th><th>${t('devices.status')}</th></tr></thead>
    <tbody>${devices.map(
      (d) => html`<tr>
      <td class="admin-wide"><a class="admin-cell-title" href="${href('device', { name: d.device })}">${d.device}</a></td>
      <td data-label="${t('devices.lastPush')}">${time(d.lastUpdateAt)}</td>
      <td class="ol-num" data-label="${t('devices.files')}">${fmtNumber(d.files, ctx.lang)}</td>
      <td class="ol-num" data-label="${t('devices.bytes')}">${fmtBytes(d.bytes)}</td>
      <td>${deviceStatus(ctx, d)}</td>
    </tr>`,
    )}</tbody></table></div>`;
}

/**
 * `origin ui`: the hub this device is connected to, and when it last synced. Writes made here are
 * synced in the background, so the box also says whether that is running or failed.
 */
function hubBox(ctx: Ctx, hub: HubLink | null): SafeHtml {
  const t = ctx.t;
  if (!hub) {
    return box({
      title: t('hub.title'),
      aside: badge(t('hub.notConnected')),
      body: html`<p class="admin-muted">${t('hub.none')}</p>
        <p class="admin-note"><a href="${docsUrl(ctx, 'guide/hub')}" rel="noreferrer">${t('hub.howTo')}</a></p>`,
    });
  }
  return box({
    title: t('hub.title'),
    aside: hub.syncing
      ? badge(t('hub.syncing'), 'info', { dot: true })
      : hub.lastError
        ? badge(t('hub.notSynced'), 'warning', { dot: true })
        : badge(t('hub.connected'), 'success', { dot: true }),
    body: html`${hub.lastError ? alert(ctx, 'warning', t('hub.syncFailed', { error: hub.lastError })) : ''}
      <dl class="ol-dl">
        <dt>${t('hub.url')}</dt><dd class="ol-mono ol-break">${hub.url}</dd>
        <dt>${t('hub.device')}</dt><dd>${hub.device}</dd>
        <dt>${t('hub.lastSync')}</dt><dd>${hub.lastSyncAt === null ? t('hub.never') : time(hub.lastSyncAt)}</dd>
      </dl>
      <p class="admin-note">${t('hub.writes')}</p>`,
  });
}

/** A figure at the top of the overview: a total, a picture of the last 30 days, and a line about them. */
function kpi(
  ctx: Ctx,
  o: {
    href: string;
    icon: IconName;
    label: string;
    value: HtmlValue;
    figure?: HtmlValue;
    /** The figure goes under the value, across the card, as a bar does. */
    wide?: boolean;
    meta: HtmlValue;
    tone?: 'warning';
  },
): SafeHtml {
  const value = html`<span class="ol-stat-value">${o.value}</span>`;
  return html`<a class="ol-stat" href="${o.href}">
    <span class="ol-stat-label"><span class="ol-stat-icon${o.tone ? ` ol-tone-${o.tone}` : ''}">${icon(ctx, o.icon, 'sm')}</span>${o.label}</span>
    ${o.figure && !o.wide ? html`<span class="ol-stat-row">${value}${o.figure}</span>` : html`${value}${o.figure ?? ''}`}
    <span class="ol-stat-meta">${o.meta}</span>
  </a>`;
}

/**
 * The overview, as a dashboard: totals with the last 30 days under each, the activity by agent, how
 * recalls went, recent sessions, busy projects, the agents and the store's state, then the latest
 * entries and forgets. On a hub, its devices too.
 */
export function overviewPage(ctx: Ctx, o: Overview): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  // `origin ui` shows this device's own store: no devices, tokens, or connection commands.
  const local = ctx.mode === 'local';
  const stale = local ? [] : o.devices.filter((d) => d.stale);
  const healthy = stale.length === 0 && o.parseErrors.last24h === 0;
  const remoteMirrors = o.usage.mirrorBytes.remote > 0 || o.usage.mirrorStoredBytes.remote > 0;
  // On `origin ui` a device's name is plain text: there are no device pages.
  const deviceName = (name: string) =>
    local ? html`${name}` : html`<a href="${href('device', { name })}">${name}</a>`;
  const events30 = o.activity.reduce((sum, d) => sum + d.events, 0);
  const sessions30 = o.sessionDays.reduce((sum, v) => sum + v, 0);
  const r = o.recalls;
  const busiest = o.activity.reduce<ActivityDay | null>(
    (best, d) => (best === null || d.events > best.events ? d : best),
    null,
  );
  const summary = t('overview.activitySummary', {
    n: n(events30),
    days: ACTIVITY_DAYS,
    day: busiest?.day ?? '—',
    max: n(busiest?.events ?? 0),
  });
  const kinds = ['memory', 'knowledge', 'cognition'] as const;

  const kpis = html`<section class="ol-stats" aria-label="${t('overview.countsTitle')}">
    ${kpi(ctx, {
      href: '/admin/sessions',
      icon: 'message-square',
      label: t('overview.events'),
      value: n(o.counts.events),
      figure: sparkline(
        o.activity.map((d) => d.events),
        summary,
      ),
      meta: t('overview.in30', { n: n(events30) }),
    })}
    ${kpi(ctx, {
      href: '/admin/sessions',
      icon: 'history',
      label: t('overview.sessions'),
      value: n(o.counts.sessions),
      figure: sparkline(o.sessionDays, t('overview.active30', { n: n(sessions30) })),
      meta: t('overview.active30', { n: n(sessions30) }),
    })}
    ${kpi(ctx, {
      href: '/admin/entries',
      icon: 'book-marked',
      label: t('overview.entries'),
      value: n(o.counts.entries),
      wide: true,
      figure: splitBar(
        kinds.map((k) => ({ value: o.entries[k], slot: KIND_SLOTS[k] })),
        t('overview.entriesMeta', {
          memory: n(o.entries.memory),
          knowledge: n(o.entries.knowledge),
          cognition: n(o.entries.cognition),
        }),
      ),
      meta: html`<span class="ol-legend">${kinds.map((k) => html`<span class="ol-legend-item">${kindTag(ctx, k)}<span class="ol-legend-value">${n(o.entries[k])}</span></span>`)}</span>`,
    })}
    ${kpi(ctx, {
      href: '/admin/recalls',
      icon: 'lightbulb',
      label: t('nav.recalls'),
      value: n(r.recalls),
      wide: true,
      figure: ratioBar(
        r.used,
        r.recalls,
        r.recalls,
        t('overview.recallsOccasion', { used: n(r.used), n: n(r.recalls) }),
      ),
      meta: t('overview.recallsMeta', { used: n(r.used), items: n(r.items) }),
    })}
    ${
      local
        ? ''
        : kpi(ctx, {
            href: '/admin/devices',
            icon: 'laptop',
            label: t('overview.devices'),
            value: n(o.counts.devices),
            meta:
              stale.length > 0
                ? t('overview.devicesStale', { n: n(stale.length) })
                : t('overview.devicesMeta', { n: n(o.counts.activeTokens) }),
            tone: stale.length > 0 ? 'warning' : undefined,
          })
    }
  </section>`;

  const agents = o.sources
    .filter((s) => o.activity.some((d) => (d.bySource[s.source] ?? 0) > 0))
    .sort((a, b) => agentSlot(a.source) - agentSlot(b.source));
  const activity = box({
    title: t('overview.activity'),
    aside: t('overview.activityAside'),
    body:
      events30 === 0
        ? html`<p class="admin-muted">${t('overview.activityNone', { days: ACTIVITY_DAYS })}</p>`
        : stackedColumns(ctx, {
            id: 'activity',
            title: t('overview.activityTitle', { days: ACTIVITY_DAYS }),
            summary,
            series: agents.map((s) => ({
              key: s.source,
              label: s.source,
              slot: agentSlot(s.source),
            })),
            columns: o.activity.map((d) => ({
              label: d.day.slice(5).replace('-', '/'),
              name: d.day,
              values: d.bySource,
            })),
            labelEvery: 7,
            columnHeading: t('overview.day'),
            totalHeading: t('overview.total'),
            tableLabel: t('overview.activityTable'),
            hint: false,
          }),
  });

  const most = Math.max(1, ...r.byOccasion.map((x) => x.recalls));
  const recalls = box({
    title: t('nav.recalls'),
    aside: t('overview.recallsAside'),
    flush: true,
    body:
      r.recalls === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('overview.recallsNone')}</p>
          <p class="admin-note"><a href="${docsUrl(ctx, 'guide/recall')}" rel="noreferrer">${t('recalls.howItWorks')}</a></p></div>`
        : html`<ul class="admin-meters">${r.byOccasion.map(
            (x) => html`<li>
              <a href="${href('recalls', { occasion: x.occasion })}">${t(`recall.occasion.${x.occasion}`)}</a>
              ${ratioBar(x.used, x.recalls, most, t('overview.recallsOccasion', { used: n(x.used), n: n(x.recalls) }))}
              <span class="admin-meter-value"><b>${n(x.used)}</b> / ${n(x.recalls)}</span>
            </li>`,
          )}</ul>
          <div class="admin-figures">
            <div><b>${Math.round((r.used / r.recalls) * 100)}%</b><span>${t('overview.recallRate')}</span></div>
            <div><b>${(r.items / r.recalls).toFixed(1)}</b><span>${t('overview.recallItems')}</span></div>
            <div><b>${n(Math.round(r.tokens / r.recalls))}</b><span>${t('overview.recallTokens')}</span></div>
          </div>`,
  });

  const recent = box({
    title: t('overview.recentTitle'),
    aside: html`<a href="/admin/sessions">${t('overview.allSessions')}</a>`,
    flush: true,
    body:
      o.recent.length === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('overview.noSessions')}</p></div>`
        : html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
      <thead><tr><th>${t('sessions.titleColumn')}</th><th>${t('facet.agent')}</th><th>${t('filter.project')}</th><th class="ol-num">${t('overview.events')}</th><th class="ol-num">${t('sessions.lastActive')}</th></tr></thead>
      <tbody>${o.recent.map(
        (s) => html`<tr>
        <td class="admin-wide"><a class="admin-cell-title" href="${sessionHref(s)}">${sessionName(ctx, s, 90)}</a></td>
        <td>${agentTag(s.source)}</td>
        <td data-label="${t('filter.project')}">${s.project ?? html`<span class="admin-faint">—</span>`}</td>
        <td class="ol-num" data-label="${t('overview.events')}">${n(s.eventCount)}</td>
        <td class="ol-num">${whenShort(ctx, s.endedAt)}</td>
      </tr>`,
      )}</tbody></table></div>`,
  });

  const top = o.projects[0]?.events ?? 0;
  const projects = box({
    title: t('overview.projects'),
    aside: t('overview.projectsAside'),
    flush: true,
    body:
      o.projects.length === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('overview.projectsNone', { days: ACTIVITY_DAYS })}</p></div>`
        : html`<ul class="admin-meters">${o.projects.map(
            (p) => html`<li>
              <a href="${href('sessions', { project: p.project })}" title="${t('overview.projectSessions', { n: n(p.sessions) })}">${p.project}</a>
              ${ratioBar(0, p.events, top, t('overview.projectEvents', { n: n(p.events) }))}
              <span class="admin-meter-value">${fmtCompact(p.events, ctx.lang)}</span>
            </li>`,
          )}</ul>`,
  });

  const sources = box({
    title: t('overview.sourcesTitle'),
    flush: true,
    body:
      o.sources.length === 0
        ? html`<div class="ol-panel-body">${empty(ctx, {
            icon: 'history',
            title: t('overview.noSessions'),
            text: local ? t('overview.noDataLocal') : t('overview.noData'),
            action: local
              ? ''
              : linkButton(ctx, {
                  href: '/admin/connect',
                  label: t('devices.howToConnect'),
                  icon: 'plug',
                  size: 'sm',
                }),
          })}</div>`
        : html`<div class="ol-table-wrap"><table class="ol-table ol-table-compact ol-table-stack">
      <thead><tr><th>${t('overview.source')}</th><th>${t('overview.agentVersion')}</th><th class="ol-num">${t('overview.latest')}</th><th class="ol-num">${t('overview.lastIngest')}</th><th class="ol-num">${t('overview.sessions')}</th><th class="ol-num">${t('overview.events')}</th><th class="ol-num">${t('overview.parseErrors7d')}</th></tr></thead>
      <tbody>${o.sources.map(
        (s) => html`<tr>
        <td class="admin-wide"><a class="admin-cell-title" href="${href('sessions', { agent: s.source })}">${agentTag(s.source)}</a></td>
        <td data-label="${t('overview.agentVersion')}">${s.agentVersion ? html`<span class="ol-mono">${s.agentVersion}</span>` : html`<span class="admin-faint">—</span>`}</td>
        <td class="ol-num" data-label="${t('overview.latest')}">${whenShort(ctx, s.lastTs)}</td>
        <td class="ol-num" data-label="${t('overview.lastIngest')}">${whenShort(ctx, s.lastSyncAt)}</td>
        <td class="ol-num" data-label="${t('overview.sessions')}">${n(s.sessions)}</td>
        <td class="ol-num" data-label="${t('overview.events')}">${n(s.events)}</td>
        <td class="ol-num" data-label="${t('overview.parseErrors7d')}">${s.parseErrors7d > 0 ? html`<span class="admin-bad">${n(s.parseErrors7d)}</span>` : html`<span class="admin-faint">0</span>`}</td>
      </tr>`,
      )}</tbody></table></div>`,
  });

  const status = box({
    title: t('overview.healthTitle'),
    aside: healthy
      ? badge(t('overview.healthOk'), 'success', { dot: true })
      : badge(t('overview.healthCheck'), 'warning', { dot: true }),
    body: html`<dl class="ol-dl">
      <dt>${t('overview.parseErrors')}</dt>
      <dd>${t('overview.parseErrorsValue', { day: n(o.parseErrors.last24h), week: n(o.parseErrors.last7d) })}</dd>
      ${o.parseErrors.bySource7d.map(
        (e) =>
          html`<dt class="ol-dl-sub">${e.source} ${e.device ? deviceName(e.device) : html`<span class="admin-faint">${t('overview.local')}</span>`}</dt><dd>${n(e.parseErrors)}</dd>`,
      )}
      <dt>${t('overview.version')}</dt><dd>${o.version}</dd>
      <dt>${t('overview.uptime')}</dt><dd>${fmtDuration(o.uptimeMs, t)}</dd>
    </dl>`,
  });

  const storage = box({
    title: t('overview.storageTitle'),
    body: html`<dl class="ol-dl">
      <dt>${t('overview.database')}</dt><dd>${fmtBytes(o.usage.databaseBytes)}</dd>
      <dt class="ol-dl-sub">${t('overview.wal')}</dt><dd>${fmtBytes(o.usage.walBytes)}</dd>
      <dt>${t('overview.mirrorsDisk')}</dt><dd>${fmtBytes(o.usage.mirrorDiskBytes)}</dd>
      ${
        o.usage.bucket
          ? html`<dt>${t('overview.mirrorsBucket')}</dt><dd>${fmtBytes(o.usage.bucket.frameBytes)}<span class="admin-cell-sub ol-mono">${o.usage.bucket.location}</span></dd>`
          : ''
      }
      <dt>${t('overview.mirrorsLocal')}</dt><dd>${t('overview.mirrorSize', { stored: fmtBytes(o.usage.mirrorStoredBytes.local), size: fmtBytes(o.usage.mirrorBytes.local) })}</dd>
      ${
        local && !remoteMirrors
          ? ''
          : html`<dt>${t('overview.mirrorsRemote')}</dt><dd>${t('overview.mirrorSize', { stored: fmtBytes(o.usage.mirrorStoredBytes.remote), size: fmtBytes(o.usage.mirrorBytes.remote) })}</dd>`
      }
      <dt>${t('overview.freeDisk')}</dt><dd>${fmtBytes(o.usage.freeDiskBytes)}</dd>
    </dl>`,
  });

  const entries = box({
    title: t('overview.latestEntries'),
    aside: html`<a href="/admin/entries">${t('overview.allEntries')}</a>`,
    flush: true,
    body:
      o.latestEntries.length === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('entries.noneYet')}</p></div>`
        : html`<ul class="admin-rows">${o.latestEntries.map(
            (e) => html`<li>
              ${kindTag(ctx, e.kind)}
              <a class="admin-cell-title" href="${href('entry', { id: e.id })}">${clip(e.text, 160)}</a>
              <span class="admin-rows-end">${whenShort(ctx, e.createdAt)}</span>
            </li>`,
          )}</ul>`,
  });

  const forgets = box({
    title: t('overview.latestTombstones'),
    aside: html`<a href="/admin/tombstones">${t('overview.allTombstones')}</a>`,
    flush: true,
    body:
      o.latestTombstones.length === 0
        ? html`<div class="ol-panel-body"><p class="admin-muted">${t('tombstones.none')}</p></div>`
        : html`<ul class="admin-rows">${o.latestTombstones.map(
            (x) => html`<li>
              ${
                x.kind === 'restore'
                  ? html`<span class="admin-good">${t('tombstones.kind.restore')}</span>`
                  : html`<span class="admin-bad">${t('tombstones.kind.forget')}</span>`
              }
              <a class="admin-cell-title" href="${href('tombstone', { id: x.id })}">${x.reason ? clip(x.reason, 120) : html`<span class="ol-mono">${x.target}</span>`}</a>
              ${
                x.kind === 'forget'
                  ? html`<span class="admin-rows-end">${t('tombstones.coversCount', { entries: n(x.entries), events: n(x.events) })}${x.inEffect ? '' : html`, ${t('tombstones.restored')}`}</span>`
                  : ''
              }
              <span class="admin-rows-end">${whenShort(ctx, x.createdAt)}</span>
            </li>`,
          )}</ul>`,
  });

  renderPage(ctx, 200, {
    title: t('nav.overview'),
    nav: 'overview',
    heading: t('overview.title'),
    actions: local
      ? ''
      : html`${linkButton(ctx, { href: '/admin/connect', label: t('nav.connect'), icon: 'plug', size: 'sm' })}${linkButton(ctx, { href: '/admin/tokens/new', label: t('tokens.create'), icon: 'plus', variant: 'primary', size: 'sm' })}`,
    body: html`${
      stale.length > 0 || o.parseErrors.last24h > 0
        ? html`<div class="ol-notices">
      ${stale.length > 0 ? alert(ctx, 'warning', t('overview.staleDevices', { n: stale.length })) : ''}
      ${o.parseErrors.last24h > 0 ? alert(ctx, 'warning', t('overview.parseErrors24h', { n: o.parseErrors.last24h })) : ''}
    </div>`
        : ''
    }
    ${kpis}
    <div class="ol-layout-dashboard">
      <div class="ol-stack">${activity}${recent}${sources}${
        local
          ? ''
          : box({
              title: t('overview.devicesTitle'),
              aside:
                o.devices.length > 0
                  ? html`<a href="/admin/devices">${t('overview.allDevices')}</a>`
                  : '',
              flush: true,
              body: devicesTable(ctx, o.devices),
            })
      }${entries}</div>
      <div class="ol-stack">${recalls}${projects}${local ? hubBox(ctx, o.hub) : ''}${status}${storage}${forgets}</div>
    </div>`,
  });
}

export function devicesPage(ctx: Ctx, devices: DeviceSummary[]): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.devices'),
    nav: 'devices',
    heading: t('nav.devices'),
    actions: linkButton(ctx, {
      href: '/admin/connect',
      label: t('devices.howToConnect'),
      icon: 'plug',
      variant: 'primary',
    }),
    body: html`${pageIntro(ctx, { description: t('devices.help') })}
    ${devicesTable(ctx, devices)}`,
  });
}

/** The last part of a path, and what comes before it, whichever the separator. */
const lastSeparator = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
const fileName = (p: string) => p.slice(lastSeparator(p) + 1);
const folderOf = (p: string) => p.slice(0, Math.max(0, lastSeparator(p)));

/** A device's files a page lists, the most recently updated first. */
const DEVICE_FILES = 50;

/**
 * A device: how its pushes went in the last 7 days and its details, then the files it mirrored,
 * the most recently updated first, a page at a time (a device can have thousands).
 */
export function devicePage(ctx: Ctx, d: DeviceDetail): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  const page = Math.max(0, Number.parseInt(ctx.url.searchParams.get('page') ?? '0', 10) || 0);
  const files = [...d.files].sort((x, y) => y.updatedAt - x.updatedAt);
  const shown = files.slice(page * DEVICE_FILES, (page + 1) * DEVICE_FILES);
  renderPage(ctx, 200, {
    title: d.device.device,
    nav: 'devices',
    crumbs: [{ label: t('nav.devices'), href: '/admin/devices' }],
    heading: d.device.device,
    badges: deviceStatus(ctx, d.device),
    body: html`${pageIntro(ctx, { description: t('devices.help') })}
    <div class="ol-layout-supporting">
      <div class="ol-stack">
        ${section({
          title: t('devices.health7d'),
          body:
            d.health.length === 0
              ? html`<p class="admin-muted">${t('devices.noPushes7d')}</p>`
              : tableWrap(
                  html`<th>${t('overview.source')}</th><th class="ol-num">${t('devices.pushes')}</th><th class="ol-num">${t('devices.lines')}</th><th class="ol-num">${t('overview.events')}</th><th class="ol-num">${t('overview.parseErrors')}</th>`,
                  d.health.map(
                    (h) =>
                      html`<tr><td>${agentTag(h.source)}</td><td class="ol-num" data-label="${t('devices.pushes')}">${n(h.runs)}</td><td class="ol-num" data-label="${t('devices.lines')}">${n(h.linesRead)}</td><td class="ol-num" data-label="${t('overview.events')}">${n(h.eventsAdded)}</td><td class="ol-num" data-label="${t('overview.parseErrors')}">${h.parseErrors > 0 ? badge(n(h.parseErrors), 'warning') : '0'}</td></tr>`,
                  ),
                  'ol-table-stack',
                ),
        })}
        ${box({
          title: html`${t('devices.filesTitle')}<span class="ol-count">${n(files.length)}</span>`,
          flush: true,
          body: html`${tableWrap(
            html`<th>${t('devices.originalPath')}</th><th>${t('overview.source')}</th><th class="ol-num">${t('devices.generation')}</th><th class="ol-num">${t('devices.lines')}</th><th class="ol-num">${t('devices.bytes')}</th><th class="ol-num">${t('devices.updated')}</th>`,
            shown.map(
              (f) =>
                html`<tr><td class="admin-wide" title="${f.originalPath}"><span class="admin-cell-title ol-mono">${fileName(f.originalPath)}</span><span class="admin-cell-sub ol-mono">${folderOf(f.originalPath)}</span></td><td>${agentTag(f.source)}</td><td class="ol-num" data-label="${t('devices.generation')}">${f.generation}</td><td class="ol-num" data-label="${t('devices.lines')}">${n(f.lines)}</td><td class="ol-num" data-label="${t('devices.bytes')}">${fmtBytes(f.bytes)}</td><td class="ol-num">${whenShort(ctx, f.updatedAt)}</td></tr>`,
            ),
            'ol-table-stack',
          )}${listPager(ctx, { page, size: DEVICE_FILES, shown: shown.length, total: files.length, more: (page + 1) * DEVICE_FILES < files.length })}`,
        })}
      </div>
      <div class="ol-stack">
        ${box({
          title: t('devices.details'),
          body: html`<dl class="ol-dl">
            <dt>${t('devices.lastPush')}</dt><dd>${time(d.device.lastUpdateAt)}</dd>
            <dt>${t('devices.files')}</dt><dd>${n(d.device.files)}</dd>
            <dt>${t('devices.bytes')}</dt><dd>${fmtBytes(d.device.bytes)}</dd>
            <dt>${t('devices.token')}</dt><dd>${
              d.token
                ? html`${d.token.name} ${d.token.revokedAt === null ? badge(t('tokens.active'), 'success', { dot: true }) : badge(t('tokens.revoked'))}<span class="admin-cell-sub">${t('tokens.lastUsed')} ${time(d.token.lastUsedAt)}</span>`
                : html`<span class="admin-faint">${t('devices.noToken')}</span>`
            }</dd>
          </dl>`,
        })}
      </div>
    </div>`,
  });
}

export function connectPage(ctx: Ctx, s: Snippets): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.connect'),
    nav: 'connect',
    heading: t('connect.title'),
    actions: linkButton(ctx, {
      href: '/admin/tokens/new',
      label: t('connect.createToken'),
      icon: 'plus',
      variant: 'primary',
    }),
    body: html`${pageIntro(ctx, { description: t('connect.intro') })}
    ${s.known ? '' : alert(ctx, 'info', t('connect.noPublicUrl'))}
    ${connectSnippetsBlock(ctx, s)}`,
  });
}

export function connectSnippetsBlock(ctx: Ctx, s: Snippets): SafeHtml {
  const t = ctx.t;
  return html`${section({
    title: t('connect.device'),
    description: t('connect.deviceHelp'),
    body: html`<div class="ol-stack">
        ${snippet(ctx, 'snippet-device', t('connect.deviceLabel'), s.device)}
      </div>`,
  })}
    ${section({
      title: t('connect.agents'),
      description: t('connect.agentsHelp'),
      body: html`<div class="ol-stack">
        ${snippet(ctx, 'snippet-claude', 'Claude Code', s.claude)}
        ${snippet(ctx, 'snippet-codex', 'Codex CLI', s.codex)}
      </div>`,
    })}`;
}
