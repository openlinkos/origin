import type { Ctx } from '../context.js';
import { clip, dayLabel, fmtBytes, fmtDuration, fmtNumber, time } from '../context.js';
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
import { SERIES_SLOTS, shareBar, stackedColumns } from './chart.js';
import {
  alert,
  badge,
  empty,
  entryFlags,
  kindBadge,
  linkButton,
  pageHeader,
  panel,
  section,
  sessionHref,
  sessionName,
  snippet,
  sourceBadge,
  tableWrap,
} from './components.js';
import { docsUrl, renderPage } from './layout.js';

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
  return tableWrap(
    html`<th>${t('devices.name')}</th><th>${t('devices.lastPush')}</th><th class="ol-num">${t('devices.files')}</th><th class="ol-num">${t('devices.bytes')}</th><th>${t('devices.status')}</th>`,
    devices.map(
      (d) => html`<tr>
      <td><a class="ol-cell-title" href="${href('device', { name: d.device })}">${d.device}</a></td>
      <td class="ol-nowrap">${time(d.lastUpdateAt)}</td>
      <td class="ol-num">${fmtNumber(d.files, ctx.lang)}</td>
      <td class="ol-num">${fmtBytes(d.bytes)}</td>
      <td>${deviceStatus(ctx, d)}</td>
    </tr>`,
    ),
  );
}

/**
 * `origin ui`: the hub this device is connected to, and when it last synced. Writes made here are
 * synced in the background, so the panel also says whether that is running or failed.
 */
function hubPanel(ctx: Ctx, hub: HubLink | null): SafeHtml {
  const t = ctx.t;
  if (!hub) {
    return panel(ctx, {
      tag: 'aside',
      title: t('hub.title'),
      icon: 'plug',
      badge: badge(t('hub.notConnected')),
      body: html`<p class="ol-muted ol-text-sm">${t('hub.none')}</p>`,
      footer: html`<a href="${docsUrl(ctx, 'guide/hub')}" rel="noreferrer">${t('hub.howTo')}</a>`,
    });
  }
  return panel(ctx, {
    tag: 'aside',
    title: t('hub.title'),
    icon: 'plug',
    badge: hub.syncing
      ? badge(t('hub.syncing'), 'info', { dot: true })
      : hub.lastError
        ? badge(t('hub.notSynced'), 'warning', { dot: true })
        : badge(t('hub.connected'), 'success', { dot: true }),
    body: html`<div class="ol-stack">
      ${hub.lastError ? alert(ctx, 'warning', t('hub.syncFailed', { error: hub.lastError })) : ''}
      <dl class="ol-dl">
        <dt>${t('hub.url')}</dt><dd class="ol-mono ol-break">${hub.url}</dd>
        <dt>${t('hub.device')}</dt><dd>${hub.device}</dd>
        <dt>${t('hub.lastSync')}</dt><dd>${hub.lastSyncAt === null ? t('hub.never') : time(hub.lastSyncAt)}</dd>
      </dl>
      <p class="ol-hint">${t('hub.writes')}</p>
    </div>`,
  });
}

export function overviewPage(ctx: Ctx, o: Overview): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  // `origin ui` shows this device's own store: no devices, tokens, or connection commands.
  const local = ctx.mode === 'local';
  const stale = local ? [] : o.devices.filter((d) => d.stale);
  const latest = o.sources.reduce<number | null>(
    (max, s) => (s.lastTs !== null && (max === null || s.lastTs > max) ? s.lastTs : max),
    null,
  );
  const healthy = stale.length === 0 && o.parseErrors.last24h === 0;
  const remoteMirrors = o.usage.mirrorBytes.remote > 0 || o.usage.mirrorStoredBytes.remote > 0;
  const stat = (
    path: string,
    label: string,
    iconName: IconName,
    value: number,
    meta: HtmlValue,
    tone?: 'warning',
  ) =>
    html`<a class="ol-stat" href="${path}"><span class="ol-stat-label"><span class="${tone ? `ol-stat-icon ol-tone-${tone}` : 'ol-stat-icon'}">${icon(ctx, iconName, 'sm')}</span>${label}</span><span class="ol-stat-value">${n(value)}</span><span class="ol-stat-meta">${meta}</span></a>`;
  // Every source keeps its colour on the page: the chart's series, and the swatches in the tables.
  const slots = new Map(o.sources.map((s, i) => [s.source, Math.min(i + 1, SERIES_SLOTS)]));
  const swatch = (source: string) =>
    html`<span class="ol-swatch ol-series-${slots.get(source) ?? SERIES_SLOTS}" aria-hidden="true"></span>`;
  // On `origin ui` a device's name is plain text: there are no device pages.
  const deviceName = (name: string) =>
    local ? html`${name}` : html`<a href="${href('device', { name })}">${name}</a>`;

  const noData = empty(ctx, {
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
  });

  const activityTotal = o.activity.reduce((sum, d) => sum + d.events, 0);
  const busiest = o.activity.reduce<ActivityDay | null>(
    (best, d) => (best === null || d.events > best.events ? d : best),
    null,
  );
  const activity = section({
    title: t('overview.activityTitle', { days: ACTIVITY_DAYS }),
    description: t('overview.activityHelp'),
    body:
      activityTotal === 0
        ? html`<p class="ol-muted ol-text-sm">${t('overview.activityNone', { days: ACTIVITY_DAYS })}</p>`
        : stackedColumns(ctx, {
            id: 'activity',
            title: t('overview.activityTitle', { days: ACTIVITY_DAYS }),
            summary: t('overview.activitySummary', {
              n: n(activityTotal),
              days: ACTIVITY_DAYS,
              day: busiest ? dayLabel(ctx, busiest.day, { weekday: false }) : '—',
              max: n(busiest?.events ?? 0),
            }),
            series: o.sources
              .filter((s) => o.activity.some((d) => (d.bySource[s.source] ?? 0) > 0))
              .map((s) => ({
                key: s.source,
                label: s.source,
                slot: slots.get(s.source) ?? SERIES_SLOTS,
              })),
            columns: o.activity.map((d) => ({
              label: dayLabel(ctx, d.day, { weekday: false }),
              name: dayLabel(ctx, d.day, { weekday: false }),
              values: d.bySource,
            })),
            labelEvery: 7,
            columnHeading: t('overview.day'),
            totalHeading: t('overview.total'),
            tableLabel: t('overview.activityTable'),
          }),
  });

  const recent = section({
    title: t('overview.recentTitle'),
    actions: linkButton(ctx, {
      href: '/admin/sessions',
      label: t('overview.allSessions'),
      variant: 'ghost',
      size: 'sm',
    }),
    body:
      o.recent.length === 0
        ? html`<p class="ol-muted ol-text-sm">${t('overview.noSessions')}</p>`
        : html`<ul class="ol-list">${o.recent.map(
            (s) => html`<li>
          <a class="ol-list-title" href="${sessionHref(s)}">${sessionName(ctx, s, 90)}</a>
          <span class="ol-list-meta">${sourceBadge(s.source)}${s.project ? html`<span>${s.project}</span>` : ''}${time(s.endedAt)}</span>
        </li>`,
          )}</ul>`,
  });

  const topProject = o.projects[0]?.events ?? 0;
  const projects = section({
    title: t('overview.projectsTitle', { days: ACTIVITY_DAYS }),
    body:
      o.projects.length === 0
        ? html`<p class="ol-muted ol-text-sm">${t('overview.projectsNone', { days: ACTIVITY_DAYS })}</p>`
        : html`<ul class="ol-list">${o.projects.map(
            (p) => html`<li>
          <span class="ol-list-row"><a class="ol-list-title" href="${href('sessions', { project: p.project })}">${p.project}</a><span class="ol-list-value">${t('overview.projectEvents', { n: n(p.events) })}</span></span>
          ${shareBar(p.events, topProject, t('overview.projectEvents', { n: n(p.events) }))}
          <span class="ol-list-meta"><span>${t('overview.projectSessions', { n: n(p.sessions) })}</span>${time(p.lastAt)}</span>
        </li>`,
          )}</ul>`,
  });

  const sources = section({
    title: t('overview.sourcesTitle'),
    description: local ? t('overview.sourcesHelpLocal') : t('overview.sourcesHelp'),
    body:
      o.sources.length === 0
        ? noData
        : tableWrap(
            html`<th>${t('overview.source')}</th><th>${t('overview.agentVersion')}</th><th>${t('overview.latest')}</th><th>${t('overview.lastIngest')}</th><th class="ol-num">${t('overview.sessions')}</th><th class="ol-num">${t('overview.events')}</th><th class="ol-num">${t('overview.parseErrors7d')}</th>`,
            o.sources.map(
              (s) =>
                html`<tr>
              <td class="ol-nowrap"><span class="ol-legend-item">${swatch(s.source)}<a class="ol-cell-title" href="${href('sessions', { source: s.source })}">${s.source}</a></span></td>
              <td class="ol-nowrap">${s.agentVersion ? html`<span class="ol-mono">${s.agentVersion}</span>` : html`<span class="ol-subtle">—</span>`}</td>
              <td class="ol-nowrap">${time(s.lastTs)}</td>
              <td class="ol-nowrap">${time(s.lastSyncAt)}</td>
              <td class="ol-num">${n(s.sessions)}</td>
              <td class="ol-num">${n(s.events)}</td>
              <td class="ol-num">${s.parseErrors7d > 0 ? badge(n(s.parseErrors7d), 'warning') : html`<span class="ol-subtle">0</span>`}</td>
            </tr>`,
            ),
          ),
  });

  const entries = section({
    title: t('overview.latestEntries'),
    actions: linkButton(ctx, {
      href: '/admin/entries',
      label: t('overview.allEntries'),
      variant: 'ghost',
      size: 'sm',
    }),
    body:
      o.latestEntries.length === 0
        ? html`<p class="ol-muted ol-text-sm">${t('entries.noneYet')}</p>`
        : html`<ul class="ol-list">${o.latestEntries.map(
            (e) => html`<li>
          <a class="ol-list-title" href="${href('entry', { id: e.id })}">${clip(e.text, 120)}</a>
          <span class="ol-list-meta">${kindBadge(ctx, e.kind)}${entryFlags(ctx, e)}<span>${e.author}</span>${time(e.createdAt)}</span>
        </li>`,
          )}</ul>`,
  });

  const forgets = section({
    title: t('overview.latestTombstones'),
    actions: linkButton(ctx, {
      href: '/admin/tombstones',
      label: t('overview.allTombstones'),
      variant: 'ghost',
      size: 'sm',
    }),
    body:
      o.latestTombstones.length === 0
        ? html`<p class="ol-muted ol-text-sm">${t('tombstones.none')}</p>`
        : html`<ul class="ol-list">${o.latestTombstones.map(
            (r) => html`<li>
          <span class="ol-list-row">${
            r.kind === 'restore'
              ? badge(t('tombstones.kind.restore'), 'success', { square: true })
              : badge(t('tombstones.kind.forget'), 'danger', { square: true })
          }<a class="ol-list-title ol-mono" href="${href('tombstone', { id: r.id })}">${r.target}</a></span>
          <span class="ol-list-meta">${
            r.kind === 'forget'
              ? html`<span>${t('tombstones.coversCount', { entries: n(r.entries), events: n(r.events) })}</span>${r.inEffect ? '' : html`<span>${t('tombstones.restored')}</span>`}`
              : ''
          }${r.reason ? html`<span class="ol-truncate">${clip(r.reason, 80)}</span>` : ''}${time(r.createdAt)}</span>
        </li>`,
          )}</ul>`,
  });

  const storage = panel(ctx, {
    tag: 'aside',
    title: t('overview.storageTitle'),
    icon: 'database',
    body: html`<dl class="ol-dl">
            <dt>${t('overview.database')}</dt><dd>${fmtBytes(o.usage.databaseBytes)}</dd>
            <dt class="ol-dl-sub">${t('overview.wal')}</dt><dd>${fmtBytes(o.usage.walBytes)}</dd>
            <dt>${t('overview.mirrorsDisk')}</dt><dd>${fmtBytes(o.usage.mirrorDiskBytes)}</dd>
            ${
              o.usage.bucket
                ? html`<dt>${t('overview.mirrorsBucket')}</dt><dd>${fmtBytes(o.usage.bucket.frameBytes)}<span class="ol-cell-sub ol-mono ol-break">${o.usage.bucket.location}</span></dd>`
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

  const health = panel(ctx, {
    tag: 'aside',
    title: t('overview.healthTitle'),
    icon: 'activity',
    badge: healthy
      ? badge(t('overview.healthOk'), 'success')
      : badge(t('overview.healthCheck'), 'warning'),
    body: html`<dl class="ol-dl">
            <dt>${t('overview.parseErrors')}</dt>
            <dd>${t('overview.parseErrorsValue', { day: n(o.parseErrors.last24h), week: n(o.parseErrors.last7d) })}</dd>
            ${o.parseErrors.bySource7d.map(
              (r) =>
                html`<dt class="ol-dl-sub">${r.source} ${r.device ? deviceName(r.device) : html`<span class="ol-subtle">${t('overview.local')}</span>`}</dt><dd>${n(r.parseErrors)}</dd>`,
            )}
            <dt>${t('overview.version')}</dt><dd>${o.version}</dd>
            <dt>${t('overview.uptime')}</dt><dd>${fmtDuration(o.uptimeMs, t)}</dd>
          </dl>`,
  });

  renderPage(ctx, 200, {
    title: t('nav.overview'),
    nav: 'overview',
    body: html`${pageHeader(ctx, {
      title: t('overview.title'),
      description: local ? t('overview.descriptionLocal') : t('overview.description'),
      actions: local
        ? ''
        : html`${linkButton(ctx, { href: '/admin/connect', label: t('nav.connect'), icon: 'plug' })}${linkButton(ctx, { href: '/admin/tokens/new', label: t('tokens.create'), icon: 'plus', variant: 'primary' })}`,
    })}
    ${
      stale.length > 0 || o.parseErrors.last24h > 0
        ? html`<div class="ol-notices">
      ${stale.length > 0 ? alert(ctx, 'warning', t('overview.staleDevices', { n: stale.length })) : ''}
      ${o.parseErrors.last24h > 0 ? alert(ctx, 'warning', t('overview.parseErrors24h', { n: o.parseErrors.last24h })) : ''}
    </div>`
        : ''
    }
    <section class="ol-section">
      <h2 class="ol-sr-only">${t('overview.countsTitle')}</h2>
      <div class="ol-stats">
        ${stat('/admin/sessions', t('overview.events'), 'message-square', o.counts.events, t('overview.eventsMeta', { n: n(o.sources.length) }))}
        ${stat('/admin/sessions', t('overview.sessions'), 'history', o.counts.sessions, latest === null ? t('overview.noSessions') : html`${t('overview.latestActivity')} ${time(latest)}`)}
        ${stat('/admin/entries', t('overview.entries'), 'book-marked', o.counts.entries, t('overview.entriesMeta', { memory: n(o.entries.memory), knowledge: n(o.entries.knowledge), cognition: n(o.entries.cognition) }))}
        ${local ? '' : stat('/admin/devices', t('overview.devices'), 'laptop', o.counts.devices, t('overview.devicesMeta', { n: n(o.counts.activeTokens) }), stale.length > 0 ? 'warning' : undefined)}
        ${stat('/admin/tombstones', t('overview.tombstones'), 'eraser', o.counts.tombstones, t('overview.tombstonesMeta'))}
      </div>
    </section>
    <div class="ol-grid ol-grid-sidebar ol-section">
      <div class="admin-main-column">
        ${o.sources.length === 0 ? sources : activity}
        ${o.sources.length === 0 ? '' : html`<div class="ol-grid ol-grid-2 ol-section">${recent}${projects}</div>`}
        ${o.sources.length === 0 ? '' : sources}
        ${
          local
            ? ''
            : section({
                title: t('overview.devicesTitle'),
                description: t('devices.help'),
                actions:
                  o.devices.length > 0
                    ? linkButton(ctx, {
                        href: '/admin/devices',
                        label: t('overview.allDevices'),
                        variant: 'ghost',
                        size: 'sm',
                      })
                    : '',
                body: devicesTable(ctx, o.devices),
              })
        }
        <div class="ol-grid ol-grid-2 ol-section">${entries}${forgets}</div>
      </div>
      <div class="ol-grid">
        ${local ? hubPanel(ctx, o.hub) : ''}
        ${health}
        ${storage}
      </div>
    </div>`,
  });
}

export function devicesPage(ctx: Ctx, devices: DeviceSummary[]): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.devices'),
    nav: 'devices',
    body: html`${pageHeader(ctx, {
      title: t('nav.devices'),
      description: t('devices.help'),
      actions: linkButton(ctx, {
        href: '/admin/connect',
        label: t('devices.howToConnect'),
        icon: 'plug',
        variant: 'primary',
      }),
    })}
    ${devicesTable(ctx, devices)}`,
  });
}

export function devicePage(ctx: Ctx, d: DeviceDetail): void {
  const t = ctx.t;
  const n = (v: number) => fmtNumber(v, ctx.lang);
  renderPage(ctx, 200, {
    title: d.device.device,
    nav: 'devices',
    crumbs: [{ label: t('nav.devices'), href: '/admin/devices' }],
    body: html`${pageHeader(ctx, {
      title: d.device.device,
      badges: deviceStatus(ctx, d.device),
      description: t('devices.help'),
    })}
    <div class="ol-grid ol-grid-sidebar ol-section">
      ${section({
        title: t('devices.health7d'),
        body:
          d.health.length === 0
            ? html`<p class="ol-muted ol-text-sm">${t('devices.noPushes7d')}</p>`
            : tableWrap(
                html`<th>${t('overview.source')}</th><th class="ol-num">${t('devices.pushes')}</th><th class="ol-num">${t('devices.lines')}</th><th class="ol-num">${t('overview.events')}</th><th class="ol-num">${t('overview.parseErrors')}</th>`,
                d.health.map(
                  (h) =>
                    html`<tr><td class="ol-cell-title">${h.source}</td><td class="ol-num">${n(h.runs)}</td><td class="ol-num">${n(h.linesRead)}</td><td class="ol-num">${n(h.eventsAdded)}</td><td class="ol-num">${h.parseErrors > 0 ? badge(n(h.parseErrors), 'warning') : '0'}</td></tr>`,
                ),
              ),
      })}
      ${panel(ctx, {
        tag: 'aside',
        title: t('devices.details'),
        icon: 'laptop',
        body: html`<dl class="ol-dl">
          <dt>${t('devices.lastPush')}</dt><dd>${time(d.device.lastUpdateAt)}</dd>
          <dt>${t('devices.files')}</dt><dd>${n(d.device.files)}</dd>
          <dt>${t('devices.bytes')}</dt><dd>${fmtBytes(d.device.bytes)}</dd>
          <dt>${t('devices.token')}</dt><dd>${
            d.token
              ? html`${d.token.name} ${d.token.revokedAt === null ? badge(t('tokens.active'), 'success', { dot: true }) : badge(t('tokens.revoked'))}<span class="ol-cell-sub">${t('tokens.lastUsed')} ${time(d.token.lastUsedAt)}</span>`
              : html`<span class="ol-subtle">${t('devices.noToken')}</span>`
          }</dd>
        </dl>`,
      })}
    </div>
    ${section({
      title: t('devices.filesTitle'),
      body: tableWrap(
        html`<th>${t('overview.source')}</th><th>${t('devices.originalPath')}</th><th class="ol-num">${t('devices.generation')}</th><th class="ol-num">${t('devices.lines')}</th><th class="ol-num">${t('devices.bytes')}</th><th>${t('devices.updated')}</th>`,
        d.files.map(
          (f) =>
            html`<tr><td class="ol-nowrap">${f.source}</td><td class="ol-mono ol-break">${f.originalPath}</td><td class="ol-num">${f.generation}</td><td class="ol-num">${n(f.lines)}</td><td class="ol-num">${fmtBytes(f.bytes)}</td><td class="ol-nowrap">${time(f.updatedAt)}</td></tr>`,
        ),
      ),
    })}`,
  });
}

export function connectPage(ctx: Ctx, s: Snippets): void {
  const t = ctx.t;
  renderPage(ctx, 200, {
    title: t('nav.connect'),
    nav: 'connect',
    body: html`${pageHeader(ctx, {
      title: t('connect.title'),
      description: t('connect.intro'),
      actions: linkButton(ctx, {
        href: '/admin/tokens/new',
        label: t('connect.createToken'),
        icon: 'plus',
        variant: 'primary',
      }),
    })}
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
