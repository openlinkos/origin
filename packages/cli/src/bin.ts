#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { adapterById, allAdapters, KNOWN_SOURCE_IDS } from '@openlinkos/origin-adapters';
import { parseListen, parsePublicUrl, SIGN_IN_LINK_MS } from '@openlinkos/origin-admin';
import {
  assertComplete,
  backupStore,
  checkRelayable,
  correct,
  createToken,
  type Database,
  dbPath,
  defaultStoreName,
  ENTRY_KINDS,
  type Entry,
  type EntryKind,
  endAdminSessions,
  entryCounts,
  entryHistory,
  entrySources,
  fingerprintSources,
  generateAdminPassword,
  getEntry,
  getEvent,
  HUB_STORE_NAME,
  initStoreName,
  isEntryForgotten,
  isEntryId,
  isEventForgotten,
  isRelay,
  isStoreNameFixed,
  lastRelayed,
  listAdminSessions,
  listAudit,
  listDevices,
  listEntries,
  listEvents,
  listProjects,
  listSessions,
  listTokens,
  makeRelay,
  NAME_RE,
  OriginError,
  openDatabase,
  originHome,
  parseTime,
  rawLocator,
  readRawLine,
  recordAudit,
  relayPending,
  revokeToken,
  type SessionRow,
  type SourceAdapter,
  searchEntries,
  searchEvents,
  setAdminPassword,
  setStoreName,
  stats,
  storeName,
  syncSource,
  UPLOAD_CONCURRENCY,
  uploadFrames,
} from '@openlinkos/origin-core';
import {
  type EntryResult,
  type EntryView,
  type EventResult,
  type EventView,
  type GetResult,
  type SearchResult,
  type SessionView,
  type SourceView,
  serveRelay,
  serveReplica,
  serveStdio,
  type TimelineResult,
  WATCH_INTERVAL_MS,
} from '@openlinkos/origin-mcp';
import { cmdForget, cmdForgotten, cmdRestore, type ForgettingCtx } from './forgetting.js';
import { count, oneLine, table } from './format.js';
import { BUCKET_OPTIONS, bucketFlags, setUpFrames } from './hub/bucket.js';
import {
  type HubConfig,
  normalizeHubUrl,
  readHubConfig,
  removeHubConfig,
  writeHubConfig,
} from './hub/config.js';
import { checkHub } from './hub/connect.js';
import { type RelaySyncResult, relayWithHub } from './hub/relay.js';
import { askHub } from './hub/remote.js';
import { RetentionWatch, retentionWarning, retentionWarnings } from './hub/retention.js';
import { type HubAdminOptions, startHub } from './hub/serve.js';
import { type HubSyncResult, lastHubSync, syncWithHub } from './hub/sync.js';
import { readNewPassword } from './password.js';
import { fmtDate, fmtDateTime, fmtDuration, fmtTime } from './time.js';
import { onEnter, openInBrowser, startLocalUi, UI_PORT, writeSignInFile } from './ui.js';

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const USAGE = `origin — local-first, cross-agent personal memory

Usage:
  origin sync      [--source <id>] [--verbose] [--local] Ingest local agent sessions, then sync with the hub if connected
  origin status                                          Per-source counts, entries, and last sync
  origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
  origin timeline  --session <id> [--all]                Events of one session (tool events hidden unless --all)
  origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
  origin show      <id>                                  Show an entry or an event, with its original source
  origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
  origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
  origin forget    <id> --reason <text> [--yes]          Hide an entry or event on every store, as a record (needs --yes)
  origin forgotten [--limit 50]                          Forgets and restores, newest first, with their reasons
  origin restore   <tombstone-id> --reason <text> [--yes]  Bring back what a forget hid (needs --yes)
  origin projects                                        Known project names
  origin backup    <dir>                                 Back up the database and raw mirrors into <dir> (incremental)
  origin mcp                                             Run the MCP server over stdio (forwards to the hub when connected)
  origin ui        [--port 7079] [--no-open]             Browse and curate this store in your browser, on 127.0.0.1

Personal hub:
  origin serve     [--host 127.0.0.1] [--port 7077]      Run this store as a personal hub (MCP over HTTP)
                   [--admin | --admin-listen <host:port>] [--public-url <url>]   Also serve the admin UI
                   [--raw-s3-endpoint <url> --raw-s3-bucket <name> [--raw-s3-prefix <p>]]   Keep sealed frames in a bucket
  origin raw       upload [--remove] [--concurrency 8]    Move sealed frames still on the hub's disk to its bucket (run on the hub)
  origin token     create <name> | list | revoke <name>  Manage the hub's access tokens (run on the hub)
  origin admin     password [--generate]                 Set the admin UI password; signs out every session (run on the hub)
  origin admin     sessions [--revoke-all] | audit [--limit 50]       Admin UI sessions and the audit log
  origin hub       connect <url> --token <token> [--device <name>] [--relay] | status | disconnect
  origin push                                            Same as origin sync (kept for existing schedules)

Entry kinds: ${ENTRY_KINDS.join(' · ')}. Time values: 7d / 24h / 30m / 2w or YYYY-MM-DD.
Data directory: $ORIGIN_HOME or ~/.origin
Source ids: ${KNOWN_SOURCE_IDS.join(' · ')} (implemented: ${allAdapters()
  .map((a) => a.id)
  .join(', ')})`;

interface Ctx {
  db: Database;
  home: string;
}

/** Commands that may write entries or tombstones, or talk to a hub, and so need the store named. */
const NAMED_COMMANDS = new Set([
  'sync',
  'push',
  'mcp',
  'correct',
  'forget',
  'restore',
  'hub',
  'ui',
]);

/**
 * Name the store the first time it is needed (see docs/architecture.md#storage): a hub's store is
 * `hub`, any other takes ORIGIN_DEVICE or the host name. A named store keeps its name.
 */
function nameStore(db: Database, command: string): void {
  if (command === 'serve') initStoreName(db, HUB_STORE_NAME);
  else if (NAMED_COMMANDS.has(command)) {
    initStoreName(db, process.env.ORIGIN_DEVICE || defaultStoreName());
  }
}

/** The hub this device is connected to, under the store's name. */
function hubOf(ctx: Ctx): HubConfig | null {
  const saved = readHubConfig(ctx.home);
  return saved ? { ...saved, device: storeName(ctx.db) } : null;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }
  const home = originHome();
  // Opening the store upgrades an older one. A migration may parse mirrored lines again, with the
  // adapters, and read their sealed frames, which a hub may keep in a bucket.
  const db = openDatabase(dbPath(home), {
    adapters: allAdapters(),
    beforeMigrate: (db) =>
      void setUpFrames(db, home, {
        command: 'other',
        flags: bucketFlags(command, rest),
        env: process.env,
      }),
    log: (m) => console.error(m),
  });
  const ctx: Ctx = { db, home };
  try {
    nameStore(db, command);
    // A hub may keep its sealed frames in a bucket; serve and raw set that up with their flags.
    if (command !== 'serve' && command !== 'raw') {
      setUpFrames(db, home, { command: 'other', env: process.env });
    }
    switch (command) {
      case 'sync':
        return await cmdSync(ctx, rest);
      case 'status':
        return await cmdStatus(ctx);
      case 'timeline':
        return await cmdTimeline(ctx, rest);
      case 'search':
        return await cmdSearch(ctx, rest);
      case 'show':
        return await cmdShow(ctx, rest);
      case 'entries':
        return await cmdEntries(ctx, rest);
      case 'correct':
        return await cmdCorrect(ctx, rest);
      case 'forget':
        return await cmdForget(forgettingCtx(ctx), rest);
      case 'forgotten':
        return cmdForgotten(forgettingCtx(ctx), rest);
      case 'restore':
        return await cmdRestore(forgettingCtx(ctx), rest);
      case 'projects':
        return cmdProjects(ctx);
      case 'backup':
        return await cmdBackup(ctx, rest);
      case 'mcp':
        return await cmdMcp(ctx);
      case 'ui':
        return await cmdUi(ctx, rest);
      case 'serve':
        return await cmdServe(ctx, rest);
      case 'token':
        return cmdToken(ctx, rest);
      case 'admin':
        return await cmdAdmin(ctx, rest);
      case 'hub':
        return await cmdHub(ctx, rest);
      case 'raw':
        return await cmdRaw(ctx, rest);
      case 'push':
        return await cmdSync(ctx, rest);
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof OriginError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    db.close();
  }
}

async function syncAll(ctx: Ctx): Promise<void> {
  for (const adapter of allAdapters()) await syncSource({ db: ctx.db, home: ctx.home }, adapter);
}

/** One line about a sync with the hub. */
function describeHubSync(hub: HubConfig, r: HubSyncResult): string {
  const lines = [
    `Hub ${hub.url} (as ${hub.device}): sent ${count(r.files, 'file')} (${fmtBytes(r.bytes)}, ${count(r.eventsAdded, 'new event')}), ${count(r.entriesPushed, 'entry', 'entries')}, and ${count(r.tombstonesPushed, 'tombstone')}; applied ${count(r.tombstonesApplied, 'tombstone')} from the hub.`,
  ];
  if (r.waiting) {
    lines.push(
      `Entry ${r.waiting.id} waits until the hub has ${r.waiting.missing.join(', ')}; it is sent again on the next sync.`,
    );
  }
  return lines.join('\n');
}

/**
 * After a local change on a connected device, sync with the hub. A hub that cannot be reached
 * leaves the change local; the next sync sends it.
 */
async function syncAfterChange(ctx: Ctx): Promise<void> {
  const hub = hubOf(ctx);
  if (!hub) return;
  try {
    await syncWithHub({ db: ctx.db, home: ctx.home, hub });
  } catch (err) {
    console.error(`Saved here; not synced with the hub yet: ${(err as Error).message}`);
  }
}

async function cmdSync(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
    },
  });
  const adapters = values.source ? [adapterById(values.source)] : allAdapters();
  if (adapters.some((a) => a === null)) {
    console.error(
      `Source not implemented: ${values.source} (implemented: ${allAdapters()
        .map((a) => a.id)
        .join(', ')})`,
    );
    return 2;
  }
  if (isRelay(ctx.db)) return relaySync(ctx, adapters as SourceAdapter[], values);
  const rows: string[][] = [];
  for (const adapter of adapters as NonNullable<(typeof adapters)[number]>[]) {
    const r = await syncSource(
      {
        db: ctx.db,
        home: ctx.home,
        log: values.verbose ? (m) => console.error(`  ${m}`) : undefined,
      },
      adapter,
    );
    rows.push([
      adapter.id,
      String(r.filesSeen),
      String(r.filesChanged),
      String(r.linesRead),
      String(r.eventsAdded),
      String(r.parseErrors),
      String(r.newGenerations),
      fmtDuration(r.durationMs),
    ]);
  }
  console.log(
    table(rows, [
      'source',
      'files',
      'changed',
      'lines',
      'new events',
      'parse errors',
      'new gens',
      'time',
    ]),
  );
  const hub = values.local ? null : hubOf(ctx);
  if (!hub) return 0;
  try {
    const r = await syncWithHub({
      db: ctx.db,
      home: ctx.home,
      hub,
      log: values.verbose ? (m) => console.error(`  ${m}`) : undefined,
    });
    console.log(`\n${describeHubSync(hub, r)}`);
    return 0;
  } catch (err) {
    console.error(`\nNot synced with the hub: ${(err as Error).message}`);
    return 1;
  }
}

/** What a relay says when it has no hub to send to or to ask. */
const RELAY_UNCONNECTED =
  "This store is a relay and is not connected to a hub: it keeps no sessions of its own, and its agents' sessions wait in their own logs. Connect it with: origin hub connect <url> --token <token> --relay";

/** The hub of a relay, which can do nothing without one. */
function relayHub(ctx: Ctx): HubConfig {
  const hub = hubOf(ctx);
  if (!hub) throw new OriginError(RELAY_UNCONNECTED);
  return hub;
}

/**
 * `origin sync` on a relay (see docs/architecture.md#relays): send the agents' new log lines to the
 * hub, straight from the logs. The counts of lines, events, and parse errors are the hub's.
 */
async function relaySync(
  ctx: Ctx,
  adapters: SourceAdapter[],
  values: { verbose: boolean; local: boolean },
): Promise<number> {
  if (values.local) {
    console.error('This store is a relay: it ingests nothing here, so --local has nothing to do.');
    return 2;
  }
  const hub = relayHub(ctx);
  let r: RelaySyncResult;
  try {
    r = await relayWithHub({
      db: ctx.db,
      home: ctx.home,
      hub,
      adapters,
      log: values.verbose ? (m) => console.error(`  ${m}`) : undefined,
    });
  } catch (err) {
    console.error(
      `Not sent to the hub: ${(err as Error).message}\nWhat was not sent waits in the agents' own logs until the next sync.`,
    );
    await warnOfCleanup(ctx, adapters);
    return 1;
  }
  console.log(
    table(
      r.sources.map((s) => [
        s.source,
        String(s.filesSeen),
        String(s.filesChanged),
        String(s.linesRead),
        String(s.eventsAdded),
        String(s.parseErrors),
        String(s.newGenerations),
        fmtDuration(s.durationMs),
      ]),
      ['source', 'files', 'sent', 'lines', 'new events', 'parse errors', 'new gens', 'time'],
    ),
  );
  console.log(
    `\nRelayed to hub ${hub.url} (as ${hub.device}): sent ${count(r.files, 'file')} (${fmtBytes(r.bytes)}, ${count(r.eventsAdded, 'new event')}).`,
  );
  for (const f of r.failed) console.error(`Not sent: ${f.path} (${f.source}): ${f.reason}`);
  if (r.failed.length > 0) await warnOfCleanup(ctx, adapters);
  return r.failed.length > 0 ? 1 : 0;
}

/** On a relay that could not send everything: warn of unsent logs their agents may soon delete. */
async function warnOfCleanup(ctx: Ctx, adapters: SourceAdapter[]): Promise<void> {
  try {
    for (const w of await retentionWarnings(ctx.db, adapters)) console.error(`\nWarning: ${w}`);
  } catch {
    // Only a warning: what failed has been said already.
  }
}

async function cmdStatus(ctx: Ctx): Promise<number> {
  if (isRelay(ctx.db)) return relayStatus(ctx);
  const s = stats(ctx.db);
  const counts = entryCounts(ctx.db);
  const entries = `Entries: ${ENTRY_KINDS.map((k) => `${counts[k]} ${k}`).join(', ')}`;
  if (s.length === 0) {
    console.log(`No data yet. Run: origin sync\n${entries}\nData directory: ${ctx.home}`);
    return 0;
  }
  console.log(
    table(
      s.map((r) => [
        r.source,
        String(r.files),
        String(r.sessions),
        String(r.titled),
        String(r.events),
        fmtDate(r.firstTs),
        fmtDateTime(r.lastTs),
        r.lastSyncAt ? `${fmtDateTime(r.lastSyncAt)} (+${r.lastSyncEventsAdded ?? 0})` : '—',
      ]),
      ['source', 'files', 'sessions', 'titled', 'events', 'first', 'latest event', 'last sync'],
    ),
  );
  console.log(`\n${entries}\nData directory: ${ctx.home}`);
  const devices = listDevices(ctx.db);
  if (devices.length > 0) {
    console.log(
      `\nDevices pushing to this hub:\n${table(
        devices.map((d) => [d.device, String(d.files), fmtDateTime(d.lastUpdateAt)]),
        ['device', 'files', 'last push'],
      )}`,
    );
  }
  const hub = hubOf(ctx);
  if (hub) {
    console.log(`\nConnected to hub ${hub.url} as ${hub.device}.`);
    printLastSync(ctx, hub);
  }
  return 0;
}

/** When this device last synced with its hub, and why the last sync failed if it did since. */
function lastSync(ctx: Ctx, hub: HubConfig): { synced: string; failed: string | null } {
  const last = lastHubSync(ctx.db, hub);
  return {
    synced: last.at === null ? 'never' : fmtDateTime(last.at),
    failed: last.failure && `${fmtDateTime(last.failure.at)}: ${last.failure.error}`,
  };
}

function printLastSync(ctx: Ctx, hub: HubConfig): void {
  const last = lastSync(ctx, hub);
  console.log(`Last sync with the hub: ${last.synced}.`);
  if (last.failed) console.log(`Last sync failed ${last.failed}`);
}

/** `origin status` on a relay: what is still to send, per source, from the relay's cursors. */
async function relayStatus(ctx: Ctx): Promise<number> {
  const hub = hubOf(ctx);
  console.log(
    hub
      ? `Relay of hub ${hub.url}, as ${hub.device}: this store keeps no sessions or entries of its own, and sends its agents' sessions to the hub.`
      : RELAY_UNCONNECTED,
  );
  const rows: string[][] = [];
  const warnings: string[] = [];
  for (const adapter of allAdapters()) {
    const p = await relayPending(ctx.db, adapter);
    if (p.files === 0) continue;
    const last = lastRelayed(ctx.db, adapter.id);
    rows.push([
      adapter.id,
      String(p.files),
      String(p.pendingFiles),
      fmtBytes(p.pendingBytes),
      last ? `${fmtDateTime(last.at)} (+${last.eventsAdded})` : '—',
    ]);
    const lastSyncAt = last?.at ?? null;
    const warning = retentionWarning({ agent: adapter.displayName, pending: p, lastSyncAt });
    if (warning) warnings.push(warning);
  }
  console.log(
    rows.length === 0
      ? '\nNo agent sessions on this machine yet.'
      : `\n${table(rows, ['source', 'files', 'pending files', 'pending', 'last sync'])}`,
  );
  for (const w of warnings) console.log(`\nWarning: ${w}`);
  if (hub) {
    console.log('');
    printLastSync(ctx, hub);
  }
  console.log(`\nData directory: ${ctx.home}`);
  return 0;
}

/** A session as the CLI lists it, from this store or from the hub. */
type ShownSession = Pick<
  SessionRow,
  'sessionId' | 'source' | 'project' | 'title' | 'prompt' | 'startedAt' | 'endedAt' | 'eventCount'
>;

/** An event as the CLI lists it. `cwd` is undefined when the hub's answer does not carry it. */
interface ShownEvent {
  id: string;
  ts: number;
  source: string;
  project: string | null;
  role: string;
  kind: string;
  text: string;
  cwd?: string | null;
}

/** An entry as the CLI lists it. */
type ShownEntry = Pick<
  Entry,
  'id' | 'createdAt' | 'confidence' | 'project' | 'text' | 'validTo' | 'imported'
> & {
  kind: string;
  status: string;
};

const parseIso = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

const fromSessionView = (v: SessionView): ShownSession => ({
  sessionId: v.session,
  source: v.source,
  project: v.project,
  title: v.title,
  prompt: v.prompt ?? null,
  startedAt: parseIso(v.started),
  endedAt: parseIso(v.ended),
  eventCount: v.events,
});

const fromEventView = (v: EventView): ShownEvent => ({
  id: v.id,
  ts: Date.parse(v.time),
  source: v.source,
  project: v.project,
  role: v.role,
  kind: v.kind,
  text: v.text,
});

const fromEntryView = (v: EntryView): ShownEntry => ({
  id: v.id,
  createdAt: Date.parse(v.created),
  kind: v.kind,
  confidence: v.confidence,
  project: v.project,
  status: v.status,
  text: v.text,
  validTo: parseIso(v.valid_to),
  imported: v.imported === true,
});

/** The most a hub's tool returns at once (see TOOL_SPECS in the MCP package). */
const hubLimit = (limit: number | undefined, max: number) =>
  limit === undefined ? undefined : Math.min(limit, max);

function printSessionEvents(sessionId: string, events: ShownEvent[]): number {
  if (events.length === 0) {
    console.log('No matching events.');
    return 0;
  }
  const first = events[0];
  const cwd = first?.cwd === undefined ? '' : `  cwd ${first.cwd ?? '—'}`;
  console.log(
    `Session ${sessionId}  source ${first?.source}  project ${first?.project ?? '—'}${cwd}\n`,
  );
  for (const e of events) {
    const tag = e.kind === 'message' ? e.role : `${e.role}/${e.kind}`;
    console.log(`[${fmtDateTime(e.ts)}] ${tag.padEnd(20)} ${oneLine(e.text, 160)}`);
    console.log(`    ↳ ${e.id}`);
  }
  return 0;
}

function printSessions(sessions: ShownSession[]): number {
  if (sessions.length === 0) {
    console.log('No sessions in this time range. Try --since 30d, or run origin sync first.');
    return 0;
  }
  let day = '';
  for (const s of sessions) {
    const d = fmtDate(s.startedAt);
    if (d !== day) {
      day = d;
      console.log(`\n${day}`);
    }
    // A session without a title is named by its first prompt, in quotes: the user's words.
    const name = s.title ?? (s.prompt ? `“${s.prompt}”` : '');
    console.log(
      `  ${fmtTime(s.startedAt)}–${fmtTime(s.endedAt)}  ${s.source.padEnd(11)} ${(s.project ?? '—').padEnd(24)} ${String(s.eventCount).padStart(5)} events  ${oneLine(name, 60)}`,
    );
    console.log(`           ↳ ${s.sessionId}`);
  }
  console.log(`\n${count(sessions.length, 'session')}. View one: origin timeline --session <id>`);
  return 0;
}

async function cmdTimeline(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      source: { type: 'string' },
      project: { type: 'string' },
      session: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });
  const limit = values.limit ? Number(values.limit) : undefined;
  if (isRelay(ctx.db)) {
    const r = (await askHub(relayHub(ctx), 'timeline', {
      since: values.since,
      until: values.until,
      source: values.source,
      project: values.project,
      session: values.session,
      include_tools: values.all,
      limit: hubLimit(limit ?? (values.session ? 500 : 50), 500),
    })) as TimelineResult;
    if ('events' in r) return printSessionEvents(r.session, r.events.map(fromEventView));
    return printSessions(r.sessions.map(fromSessionView));
  }
  if (values.session) {
    const events = listEvents(ctx.db, {
      sessionId: values.session,
      source: values.source,
      kinds: values.all ? undefined : ['message', 'meta'],
      limit: limit ?? 500,
    });
    return printSessionEvents(values.session, events);
  }
  const since = parseTime(values.since ?? '7d');
  const until = parseTime(values.until);
  return printSessions(
    listSessions(ctx.db, {
      since,
      until,
      source: values.source,
      project: values.project,
      limit: limit ?? 50,
    }),
  );
}

/** Whether an entry's validity has ended: its `valid_to` has passed. */
const hasEnded = (e: Pick<Entry, 'validTo'>) => e.validTo !== null && e.validTo <= Date.now();

function printEntryLine(e: ShownEntry): void {
  const tags = [
    e.kind,
    `conf ${e.confidence}`,
    e.project,
    e.status === 'active' ? null : e.status,
    e.imported ? 'imported' : null,
    hasEnded(e) ? `ended ${fmtDateTime(e.validTo)}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(`[${fmtDateTime(e.createdAt)}] ${tags}\n    ${oneLine(e.text, 200)}\n    ↳ ${e.id}`);
}

async function cmdSearch(ctx: Ctx, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      source: { type: 'string' },
      project: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean', default: false },
      recent: { type: 'boolean', default: false },
    },
  });
  const query = positionals.join(' ').trim();
  if (!query) {
    console.error('Usage: origin search <query>');
    return 2;
  }
  const limit = values.limit ? Number(values.limit) : 20;
  let entries: ShownEntry[];
  let hits: Array<ShownEvent & { snippet: string }>;
  if (isRelay(ctx.db)) {
    if (values.recent) {
      console.error('On a relay, the hub ranks the matches by relevance; --recent does not apply.');
    }
    const r = (await askHub(relayHub(ctx), 'search', {
      query,
      since: values.since,
      until: values.until,
      source: values.source,
      project: values.project,
      include_tools: values.all,
      limit: hubLimit(limit, 100),
    })) as SearchResult;
    entries = r.entries.map(fromEntryView);
    hits = r.events.map((h) => ({ ...fromEventView(h), snippet: h.snippet }));
  } else {
    entries = searchEntries(ctx.db, query, { project: values.project, limit });
    hits = searchEvents(ctx.db, query, {
      since: parseTime(values.since),
      until: parseTime(values.until),
      source: values.source,
      project: values.project,
      kinds: values.all ? undefined : ['message'],
      order: values.recent ? 'recent' : 'relevance',
      limit,
    });
  }
  if (entries.length === 0 && hits.length === 0) {
    console.log('No hits.');
    return 0;
  }
  if (entries.length > 0) {
    console.log('Entries:');
    for (const e of entries) printEntryLine(e);
    if (hits.length > 0) console.log('\nEvents:');
  }
  for (const h of hits) {
    console.log(
      `[${fmtDateTime(h.ts)}] ${h.source} ${h.project ?? '—'} ${h.role}/${h.kind}\n    ${oneLine(h.snippet, 200)}\n    ↳ ${h.id}`,
    );
  }
  console.log(
    `\n${count(entries.length, 'entry', 'entries')}, ${count(hits.length, 'event')}. Details: origin show <id>`,
  );
  return 0;
}

function notFound(ctx: Ctx, id: string): number {
  const forgotten = isEntryForgotten(ctx.db, id) || isEventForgotten(ctx.db, id);
  console.log(forgotten ? `${id} has been forgotten.` : `Not found: ${id}`);
  return 1;
}

/** An event in full, as `origin show` prints it. */
interface ShownEventDetail extends ShownEvent {
  sessionId: string;
  agentVersion: string | null;
  gitBranch: string | null;
  meta?: Record<string, unknown> | null;
}

/** Where an event's line is: `mirror` names the mirror and line, as they are to be shown. */
interface ShownLocator {
  original: string;
  generation?: number;
  mirror: string;
}

function printEvent(e: ShownEventDetail, loc: ShownLocator | null, raw: string | null): void {
  console.log(`Event    ${e.id}`);
  console.log(`Time     ${fmtDateTime(e.ts)}  (${new Date(e.ts).toISOString()})`);
  console.log(`Source   ${e.source}  session ${e.sessionId}  version ${e.agentVersion ?? '—'}`);
  console.log(`Project  ${e.project ?? '—'}  cwd ${e.cwd ?? '—'}  branch ${e.gitBranch ?? '—'}`);
  console.log(`Role     ${e.role}/${e.kind}${e.meta ? `  meta ${JSON.stringify(e.meta)}` : ''}`);
  console.log('\nText:\n');
  console.log(e.text);
  if (loc) {
    const generation = loc.generation === undefined ? '' : ` (generation ${loc.generation})`;
    console.log('\nRaw locator:');
    console.log(`  original  ${loc.original}${generation}`);
    console.log(`  mirror    ${loc.mirror}`);
    if (raw) console.log(`\nOriginal line:\n${oneLine(raw, 600)}`);
  }
}

/** An entry in full, as `origin show` prints it. */
type ShownEntryDetail = ShownEntry &
  Pick<Entry, 'author' | 'validFrom' | 'validTo' | 'supersededBy' | 'concurrent'>;

/** A source of an entry, as `origin show` prints it. */
type ShownSource = Pick<ShownEvent, 'ts' | 'source' | 'project' | 'role' | 'kind' | 'text'> & {
  eventId: string;
  quote: string | null;
};

function printEntry(e: ShownEntryDetail, history: string[], sources: ShownSource[]): void {
  console.log(`Entry       ${e.id}  ${e.kind}, ${e.status}`);
  console.log(
    `Created     ${fmtDateTime(e.createdAt)} by ${e.author}  confidence ${e.confidence}  project ${e.project ?? '—'}`,
  );
  if (e.validFrom !== null || e.validTo !== null) {
    const ended = hasEnded(e) ? ' (ended)' : '';
    console.log(`Valid       ${fmtDateTime(e.validFrom)} → ${fmtDateTime(e.validTo)}${ended}`);
  }
  if (e.imported) {
    const agent = e.author.replace(/@.*$/, '');
    console.log(
      `Imported    from ${agent}'s own memory file; its next version replaces this entry`,
    );
  }
  if (e.status === 'superseded') {
    const why = e.concurrent ? ', after a concurrent correction' : '';
    console.log(`Current     ${e.supersededBy}${why}`);
  }
  if (history.length > 1) {
    console.log(`History     ${history.map((v) => (v === e.id ? `${v} (this)` : v)).join(', ')}`);
  }
  console.log(`\n${e.text}\n\nSources:`);
  for (const s of sources) {
    console.log(`  [${fmtDateTime(s.ts)}] ${s.source} ${s.project ?? '—'} ${s.role}/${s.kind}`);
    console.log(`      ${oneLine(s.quote ? `“${s.quote}”` : s.text, 200)}`);
    console.log(`      ↳ ${s.eventId}`);
  }
}

async function cmdShow(ctx: Ctx, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error('Usage: origin show <id>');
    return 2;
  }
  if (isRelay(ctx.db)) return showFromHub(relayHub(ctx), id);
  if (isEntryId(id)) return showEntry(ctx, id);
  const e = getEvent(ctx.db, id);
  if (!e) return notFound(ctx, id);
  const loc = rawLocator(ctx.db, ctx.home, e);
  printEvent(
    e,
    loc && {
      original: loc.originalPath,
      generation: loc.generation,
      mirror: `${loc.mirrorPath}:${loc.line}`,
    },
    loc ? readRawLine(ctx.db, ctx.home, loc) : null,
  );
  return 0;
}

function showEntry(ctx: Ctx, id: string): number {
  const e = getEntry(ctx.db, id);
  if (!e) return notFound(ctx, id);
  printEntry(
    e,
    entryHistory(ctx.db, id).map((v) => v.id),
    entrySources(ctx.db, id).map((s) => ({ ...s.event, eventId: s.eventId, quote: s.quote })),
  );
  return 0;
}

/** `origin show` on a relay: the entry or event as the hub has it, with its line on the hub. */
async function showFromHub(hub: HubConfig, id: string): Promise<number> {
  const r = (await askHub(hub, 'get', { id })) as GetResult;
  if ('entry' in r) {
    const { entry: v, history, sources } = r as EntryResult;
    printEntry(
      {
        ...fromEntryView(v),
        author: v.author,
        validFrom: parseIso(v.valid_from),
        validTo: parseIso(v.valid_to),
        supersededBy: v.superseded_by,
        concurrent: v.concurrent,
      },
      history.map((h) => h.id),
      sources.map((s) => ({ ...fromEventView(s), eventId: s.id, quote: s.quote })),
    );
    return 0;
  }
  const e = r as EventResult;
  const [line] = (await askHub(hub, 'sources', { id })) as SourceView[];
  printEvent(
    {
      ...fromEventView(e),
      cwd: e.cwd,
      sessionId: e.session,
      agentVersion: e.agent_version,
      gitBranch: e.git_branch,
    },
    line?.original_file && line.mirror_file && line.line !== null
      ? { original: line.original_file, mirror: `${line.mirror_file}:${line.line} on the hub` }
      : null,
    line?.raw ?? null,
  );
  return 0;
}

function parseKind(value: string | undefined): EntryKind | undefined {
  if (value === undefined) return undefined;
  if (!(ENTRY_KINDS as readonly string[]).includes(value)) {
    throw new OriginError(`Unknown kind "${value}"; expected ${ENTRY_KINDS.join(', ')}.`);
  }
  return value as EntryKind;
}

async function cmdEntries(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: 'string' },
      project: { type: 'string' },
      history: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
  });
  const limit = values.limit ? Number(values.limit) : 50;
  let entries: ShownEntry[];
  if (isRelay(ctx.db)) {
    if (values.history) {
      throw new OriginError(
        'On a relay, entries come from the hub, current versions only; see the versions of one entry with origin show <id>.',
      );
    }
    const r = (await askHub(relayHub(ctx), 'search', {
      scope: 'entries',
      kind: parseKind(values.kind),
      project: values.project,
      limit: hubLimit(limit, 100),
    })) as SearchResult;
    entries = r.entries.map(fromEntryView);
  } else {
    entries = listEntries(ctx.db, {
      kind: parseKind(values.kind),
      project: values.project,
      includeSuperseded: values.history,
      limit,
    });
  }
  if (entries.length === 0) {
    console.log('No entries yet. Agents create them through the MCP server (origin mcp).');
    return 0;
  }
  for (const e of entries) printEntryLine(e);
  console.log(`\n${count(entries.length, 'entry', 'entries')}. Details: origin show <id>`);
  return 0;
}

async function cmdCorrect(ctx: Ctx, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { kind: { type: 'string' }, confidence: { type: 'string' } },
  });
  const [id, ...words] = positionals;
  const text = words.join(' ').trim();
  if (!id || !text) {
    console.error('Usage: origin correct <entry-id> <text>');
    return 2;
  }
  const kind = parseKind(values.kind);
  const confidence = values.confidence === undefined ? 1 : Number(values.confidence);
  if (isRelay(ctx.db)) {
    // A relay has no entries: the correction is made on the hub, as user@<device>.
    const r = (await askHub(relayHub(ctx), 'correct', { id, text, kind, confidence })) as {
      entry: EntryView;
    };
    console.log(`Corrected ${id} → ${r.entry.id} on the hub`);
    return 0;
  }
  const e = correct(ctx.db, id, { text, author: `user@${storeName(ctx.db)}`, kind, confidence });
  console.log(`Corrected ${id} → ${e.id}`);
  await syncAfterChange(ctx);
  return 0;
}

/** What `origin forget`, `forgotten`, and `restore` need from this command line. */
function forgettingCtx(ctx: Ctx): ForgettingCtx {
  return {
    db: ctx.db,
    hub: () => hubOf(ctx),
    relayHub: () => relayHub(ctx),
    afterChange: () => syncAfterChange(ctx),
  };
}

function cmdProjects(ctx: Ctx): number {
  if (isRelay(ctx.db)) {
    throw new OriginError(
      'This store is a relay and keeps no sessions of its own; run origin projects on the hub, or open its admin UI.',
    );
  }
  const rows = listProjects(ctx.db);
  if (rows.length === 0) {
    console.log('No projects yet.');
    return 0;
  }
  console.log(
    table(
      rows.map((r) => [r.project, String(r.sessions), String(r.events)]),
      ['project', 'sessions', 'events'],
    ),
  );
  return 0;
}

async function cmdBackup(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target || positionals.length > 1) {
    console.error('Usage: origin backup <dir>');
    return 2;
  }
  const r = await backupStore(ctx.db, ctx.home, target);
  console.log(
    `Backed up the database (${fmtBytes(r.databaseBytes)}) and ${count(r.mirrorFiles, 'mirror file')} (${fmtBytes(r.mirrorBytesCopied)} new) to ${target}.`,
  );
  return 0;
}

async function cmdMcp(ctx: Ctx): Promise<number> {
  const log = (m: string) => console.error(`origin: ${m}`);
  const hub = hubOf(ctx);
  const device = storeName(ctx.db);
  const watchIntervalMs = watchInterval();
  // What the log files looked like when they were last ingested: the background checks compare it
  // with what they look like now, without reading them (see fingerprintSources).
  const adapters = allAdapters();
  let ingested: string | null = null;
  const fingerprint = () => fingerprintSources(adapters).catch(() => null);
  const ingest = async () => {
    const before = await fingerprint();
    await syncAll(ctx);
    ingested = before;
  };
  const changed = async () => {
    const now = await fingerprint();
    return now === null || now !== ingested;
  };
  if (isRelay(ctx.db)) {
    // Every tool is the hub's; the agents' new log lines go to the hub first (see relay.ts).
    if (!hub) throw new OriginError(RELAY_UNCONNECTED);
    // While the hub cannot be reached, warn of unsent logs that their agents may soon delete.
    const cleanup = new RetentionWatch(() => retentionWarnings(ctx.db, adapters), log);
    await serveRelay({
      device,
      hub: { url: hub.url, token: hub.token },
      version: VERSION,
      log,
      sync: async () => {
        const before = await fingerprint();
        try {
          await relayWithHub({ db: ctx.db, home: ctx.home, hub, adapters, log });
        } catch (err) {
          void cleanup.check();
          throw err;
        }
        cleanup.reset();
        ingested = before;
      },
      warning: () => cleanup.current,
      changed,
      hubTimeoutMs: hubTimeoutMs(),
      watchIntervalMs,
    });
    return 0;
  }
  if (hub) {
    // Answer from this device's store, merged with the hub's answers; sync up after writes.
    await serveReplica({
      db: ctx.db,
      home: ctx.home,
      device,
      hub: { url: hub.url, token: hub.token },
      version: VERSION,
      log,
      ingest,
      changed,
      sync: async () => {
        await syncWithHub({ db: ctx.db, home: ctx.home, hub });
      },
      hubTimeoutMs: hubTimeoutMs(),
      watchIntervalMs,
    });
    return 0;
  }
  await serveStdio({
    db: ctx.db,
    home: ctx.home,
    device,
    version: VERSION,
    sync: ingest,
    changed,
    log,
    watchIntervalMs,
  });
  return 0;
}

/**
 * The admin UI for this store, on 127.0.0.1 (see docs/architecture.md#admin-ui): prints a one-time
 * sign-in link and opens it in the default browser, ingests this machine's agents in the background,
 * then serves until Ctrl+C. Enter, in a terminal, issues a new link.
 */
async function cmdUi(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: String(UI_PORT) },
      'no-open': { type: 'boolean', default: false },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OriginError(`Invalid port: ${values.port}`);
  }
  if (isRelay(ctx.db)) {
    throw new OriginError(
      'This store is a relay and keeps no sessions of its own; open the admin UI of its hub instead.',
    );
  }
  const log = (m: string) => console.error(m);
  const ui = await startLocalUi({
    db: ctx.db,
    home: ctx.home,
    version: VERSION,
    port,
    hub: () => hubOf(ctx),
    ingest: allAdapters(),
    log,
  });
  const minutes = SIGN_IN_LINK_MS / 60_000;
  // Enter is read only from a terminal, never from a pipe or a file (see onEnter).
  const interactive = process.stdin.isTTY === true;
  console.log(`Origin UI for ${ctx.home} at ${ui.url}`);
  console.log(
    `\nSign in with this link. It works once, within ${minutes} minutes; ${interactive ? 'press Enter here' : 'run origin ui again'} for a new one.\n\n    ${ui.signInUrl}\n`,
  );
  const hub = hubOf(ctx);
  if (hub) {
    console.log(
      `Connected to hub ${hub.url} as ${hub.device}: entries and forget operations made here are synced to it.`,
    );
  }
  console.log(
    "Ingesting this machine's agent sessions in the background, as origin sync --local does; the UI shows them as they arrive.",
  );
  void ui.ingested.then((r) => {
    if (r) {
      console.log(
        `Ingested ${count(r.eventsAdded, 'new event')} from ${count(r.filesChanged, 'changed file')} in ${fmtDuration(r.durationMs)}${r.parseErrors > 0 ? `, with ${count(r.parseErrors, 'parse error')}` : ''}.`,
      );
    }
  });
  console.log(
    interactive ? 'Press Enter for a new sign-in link, Ctrl+C to stop.' : 'Press Ctrl+C to stop.',
  );
  const file = values['no-open'] ? null : writeSignInFile(ui.signInUrl);
  if (file) openInBrowser(file.file, log);
  const stopListening = onEnter(process.stdin, () => {
    const link = ui.newSignInUrl();
    console.log(
      `\nA new sign-in link; the previous one no longer works. It works once, within ${minutes} minutes.\n\n    ${link}\n`,
    );
    if (file) {
      file.update(link);
      openInBrowser(file.file, log);
    }
  });
  try {
    await new Promise<void>((resolve) => {
      const stop = () => void ui.close().then(resolve);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    stopListening();
    file?.remove();
  }
  return 0;
}

/** How often `origin mcp` looks for new log lines: ORIGIN_WATCH_INTERVAL_MS, default 60 s, 0 off. */
function watchInterval(): number {
  const value = process.env.ORIGIN_WATCH_INTERVAL_MS;
  if (value === undefined || value === '') return WATCH_INTERVAL_MS;
  const ms = Number(value);
  if (!Number.isInteger(ms) || (ms !== 0 && (ms < 1000 || ms > 86_400_000))) {
    throw new OriginError(
      `ORIGIN_WATCH_INTERVAL_MS must be 0 (off) or a number of milliseconds from 1000, not "${value}".`,
    );
  }
  return ms;
}

/** How long `origin mcp` waits for the hub: ORIGIN_HUB_TIMEOUT_MS, default 2000. */
function hubTimeoutMs(): number {
  const value = process.env.ORIGIN_HUB_TIMEOUT_MS;
  if (value === undefined || value === '') return 2000;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 100 || ms > 600_000) {
    throw new OriginError(
      `ORIGIN_HUB_TIMEOUT_MS must be a number of milliseconds, not "${value}".`,
    );
  }
  return ms;
}

/** `on` / `off` (and the usual spellings) from an environment variable. */
function envSwitch(name: string): boolean {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (['', '0', 'off', 'false', 'no'].includes(value)) return false;
  if (['1', 'on', 'true', 'yes'].includes(value)) return true;
  throw new OriginError(`${name} must be "on" or "off", not "${process.env[name]}".`);
}

/**
 * How to serve the admin UI: flags first, then the environment (ORIGIN_ADMIN, ORIGIN_ADMIN_LISTEN,
 * ORIGIN_PUBLIC_URL, ORIGIN_CLIENT_IP_HEADER, ORIGIN_ADMIN_PASSWORD). Null when it is off.
 */
function adminOptions(values: {
  admin?: boolean;
  'admin-listen'?: string;
  'public-url'?: string;
}): HubAdminOptions | null {
  const fromFlags = values.admin === true || values['admin-listen'] !== undefined;
  const mounted = fromFlags ? values.admin === true : envSwitch('ORIGIN_ADMIN');
  const listen = fromFlags ? values['admin-listen'] : process.env.ORIGIN_ADMIN_LISTEN || undefined;
  if (mounted && listen) {
    throw new OriginError(
      'Serve the admin UI either at /admin on the hub (--admin, ORIGIN_ADMIN=on) or on its own listener (--admin-listen, ORIGIN_ADMIN_LISTEN), not both.',
    );
  }
  if (!mounted && !listen) return null;
  return {
    publicUrl: parsePublicUrl(values['public-url'] ?? process.env.ORIGIN_PUBLIC_URL),
    clientIpHeader: process.env.ORIGIN_CLIENT_IP_HEADER?.trim() || null,
    envPassword: process.env.ORIGIN_ADMIN_PASSWORD || null,
    listen: listen ? parseListen(listen) : null,
  };
}

async function cmdServe(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '7077' },
      admin: { type: 'boolean' },
      'admin-listen': { type: 'string' },
      'public-url': { type: 'string' },
      ...BUCKET_OPTIONS,
    },
  });
  assertComplete(ctx.db, 'serve as a hub');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OriginError(`Invalid port: ${values.port}`);
  }
  const admin = adminOptions(values);
  const bucket = setUpFrames(ctx.db, ctx.home, {
    command: 'serve',
    flags: values,
    env: process.env,
  });
  const hub = await startHub({
    db: ctx.db,
    home: ctx.home,
    host: values.host,
    port,
    adapters: allAdapters(),
    version: VERSION,
    log: (m) => console.error(m),
    admin,
  });
  console.log(`Origin hub listening on ${hub.url} (data: ${ctx.home})`);
  if (bucket) {
    console.log(`Sealed frames go to ${bucket.location} at ${bucket.config.endpoint.origin}`);
  }
  if (listTokens(ctx.db).every((t) => t.revokedAt !== null)) {
    console.log('No active tokens yet. Create one with: origin token create <name>');
  }
  if (hub.adminUrl) {
    const where =
      admin?.publicUrl && !admin.listen ? `${admin.publicUrl.origin}/admin/` : hub.adminUrl;
    console.log(`Admin UI at ${where}`);
  }
  await new Promise<void>((resolve) => {
    const stop = () => void hub.close().then(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/** Record an administrative action taken from the command line (ids and counts only). */
function auditCli(
  ctx: Ctx,
  action: string,
  target: string | null,
  detail?: Record<string, number | boolean>,
) {
  recordAudit(ctx.db, { actor: 'cli', channel: 'cli', action, target, detail: detail ?? null });
}

function cmdToken(ctx: Ctx, args: string[]): number {
  const [action, name] = args;
  if (action === 'create' && name) {
    const token = createToken(ctx.db, name);
    auditCli(ctx, 'token.create', name);
    console.log(
      `Token for ${name} (shown once, store it safely):\n\n  ${token}\n\nA device uses it only under its name: origin hub connect <url> --token <token> --device ${name}`,
    );
    return 0;
  }
  if (action === 'revoke' && name) {
    if (!revokeToken(ctx.db, name)) {
      console.error(`No active token named ${name}.`);
      return 1;
    }
    auditCli(ctx, 'token.revoke', name);
    console.log(`Revoked ${name}.`);
    return 0;
  }
  if (action === 'list') {
    const tokens = listTokens(ctx.db);
    if (tokens.length === 0) {
      console.log('No tokens yet. Create one with: origin token create <name>');
      return 0;
    }
    console.log(
      table(
        tokens.map((t) => [
          t.name,
          fmtDateTime(t.createdAt),
          fmtDateTime(t.lastUsedAt),
          t.revokedAt === null ? 'active' : `revoked ${fmtDate(t.revokedAt)}`,
        ]),
        ['name', 'created', 'last used', 'status'],
      ),
    );
    return 0;
  }
  console.error('Usage: origin token create <name> | list | revoke <name>');
  return 2;
}

const ADMIN_USAGE = `Usage:
  origin admin password               Set the admin UI password: asked twice on a terminal, or one line on stdin
  origin admin password --generate    Generate a random password and print it once
  origin admin sessions [--revoke-all]
  origin admin audit [--limit 50]

Setting a password replaces the old one and signs out every admin session.`;

async function cmdAdmin(ctx: Ctx, args: string[]): Promise<number> {
  const [area, ...rest] = args;
  if (area === 'password') {
    const { values } = parseArgs({
      args: rest,
      options: { generate: { type: 'boolean', default: false } },
    });
    if (process.env.ORIGIN_ADMIN_PASSWORD) {
      console.error(
        'Note: ORIGIN_ADMIN_PASSWORD is set. On a hub started with it, that variable is the admin password and takes precedence over the one set here.',
      );
    }
    const generated = values.generate === true;
    const password = generated ? generateAdminPassword() : await readNewPassword();
    const ended = await setAdminPassword(ctx.db, password);
    auditCli(ctx, 'password.set', null, { generated, sessionsEnded: ended });
    if (generated) {
      console.log(
        `New admin password (shown only this once; keep it in a password manager):\n\n  ${password}\n`,
      );
    }
    console.log(`Admin password set. Signed out ${count(ended, 'admin session')}.`);
    return 0;
  }
  if (area === 'sessions') {
    const { values } = parseArgs({
      args: rest,
      options: { 'revoke-all': { type: 'boolean', default: false } },
    });
    if (values['revoke-all']) {
      const n = endAdminSessions(ctx.db);
      auditCli(ctx, 'sessions.revoke', 'all', { count: n });
      console.log(`Ended ${count(n, 'admin session')}.`);
      return 0;
    }
    const sessions = listAdminSessions(ctx.db);
    if (sessions.length === 0) {
      console.log('No open admin sessions.');
      return 0;
    }
    console.log(
      table(
        sessions.map((s) => [
          fmtDateTime(s.createdAt),
          fmtDateTime(s.lastSeenAt),
          s.ip ?? '—',
          oneLine(s.userAgent ?? '—', 40),
        ]),
        ['signed in', 'last active', 'client', 'user agent'],
      ),
    );
    return 0;
  }
  if (area === 'audit') {
    const { values } = parseArgs({ args: rest, options: { limit: { type: 'string' } } });
    const limit = values.limit === undefined ? 50 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new OriginError(`Invalid limit: ${values.limit}`);
    }
    const records = listAudit(ctx.db, { limit });
    if (records.length === 0) {
      console.log('The audit log is empty.');
      return 0;
    }
    console.log(
      table(
        records.map((r) => [
          fmtDateTime(r.at),
          r.actor,
          r.channel,
          r.action,
          r.target ?? '',
          r.detail
            ? Object.entries(r.detail)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')
            : '',
          r.ip ?? '',
        ]),
        ['time', 'actor', 'channel', 'action', 'target', 'detail', 'client'],
      ),
    );
    return 0;
  }
  console.error(ADMIN_USAGE);
  return 2;
}

/**
 * `origin raw upload`: move the sealed frames a hub still keeps on disk to its bucket, verifying
 * each, several at a time, and with --remove delete the `.zst` files whose frames are all verified
 * there.
 */
async function cmdRaw(ctx: Ctx, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action !== 'upload') {
    console.error(
      'Usage: origin raw upload [--remove] [--concurrency 8] [--raw-s3-endpoint <url> --raw-s3-bucket <name> …]',
    );
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      remove: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: String(UPLOAD_CONCURRENCY) },
      ...BUCKET_OPTIONS,
    },
  });
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new OriginError(
      `--concurrency must be a number from 1 to 64, not "${values.concurrency}".`,
    );
  }
  const bucket = setUpFrames(ctx.db, ctx.home, {
    command: 'upload',
    flags: values,
    env: process.env,
  }) as NonNullable<ReturnType<typeof setUpFrames>>;
  let shownAt: number | null = null;
  const r = await uploadFrames(ctx.db, ctx.home, {
    remove: values.remove,
    concurrency,
    log: (m) => console.error(m),
    progress: (p) => {
      const now = Date.now();
      if (shownAt === null) {
        shownAt = now;
        if (p.total > 0) {
          console.error(
            `Moving ${count(p.total, 'sealed frame')} (${fmtBytes(p.totalBytes)}) to ${bucket.location}, ${concurrency} at a time.`,
          );
        }
      } else if (now - shownAt >= 5000 && p.frames + p.failed < p.total) {
        shownAt = now;
        console.error(
          `${p.frames} of ${p.total} frames verified, ${p.uploaded} uploaded (${fmtBytes(p.uploadedBytes)})`,
        );
      }
    },
  });
  const removableBytes = r.removable.reduce((n, f) => n + f.bytes, 0);
  console.log(
    `Verified ${count(r.frames, 'sealed frame')} of ${count(r.mirrors, 'mirror')} in ${bucket.location}; uploaded ${count(r.uploaded, 'frame')} (${fmtBytes(r.uploadedBytes)}).`,
  );
  for (const f of r.failed.slice(0, 10)) console.error(`Not verified: ${f.key}: ${f.reason}`);
  if (r.failed.length > 10) console.error(`… and ${r.failed.length - 10} more.`);
  if (r.failed.length > 0) {
    console.error('The .zst files that hold these frames are kept.');
  }
  if (r.stopped !== null) {
    console.error(
      'Stopped early: the next frames would fail the same way. Once that is fixed, run it again; frames already in the bucket are only verified.',
    );
  }
  if (values.remove) {
    console.log(
      `Removed ${count(r.removed, 'local .zst file')}${r.removed < r.removable.length ? ` of ${r.removable.length}` : ''}.`,
    );
  } else if (r.removable.length > 0) {
    console.log(
      `Local .zst files holding only frames verified in the bucket: ${r.removable.length} (${fmtBytes(removableBytes)}). Run again with --remove to remove them.`,
    );
  }
  return r.mirrors > r.removable.length ? 1 : 0;
}

async function cmdHub(ctx: Ctx, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'connect') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        token: { type: 'string' },
        device: { type: 'string' },
        relay: { type: 'boolean', default: false },
      },
    });
    const url = positionals[0];
    if (!url || !values.token) {
      console.error('Usage: origin hub connect <url> --token <token> [--device <name>] [--relay]');
      return 2;
    }
    // A relay keeps nothing but cursors, so only an empty store becomes one (see core's mode.ts).
    if (values.relay) checkRelayable(ctx.db);
    // The device is known to its hub by the store's name, and its token must be named after it
    // (see docs/architecture.md#access). --device names a store that has not written anything yet.
    const current = storeName(ctx.db);
    const device = values.device ?? current;
    if (device !== current) {
      if (!NAME_RE.test(device)) throw new OriginError(`Invalid device name "${device}".`);
      if (isStoreNameFixed(ctx.db)) {
        throw new OriginError(
          `This store is named "${current}" and keeps that name, because it has written entries or tombstones under it; it cannot connect as "${device}".`,
        );
      }
    }
    const hub = { url: normalizeHubUrl(url), token: values.token, device };
    await checkHub(hub, { renamable: !isStoreNameFixed(ctx.db) });
    if (device !== current) setStoreName(ctx.db, device);
    if (values.relay) makeRelay(ctx.db);
    writeHubConfig(ctx.home, hub);
    console.log(
      isRelay(ctx.db)
        ? `Connected to ${hub.url} as ${hub.device}, as a relay: this store keeps no sessions or entries of its own, and agents' tools are answered by the hub. Run "origin sync" to send this device's sessions to the hub straight from the agents' logs; origin mcp also sends them while agents run.`
        : `Connected to ${hub.url} as ${hub.device}. Run "origin sync" to send this device's sessions and entries.`,
    );
    return 0;
  }
  if (action === 'status') {
    const hub = hubOf(ctx);
    if (!hub) {
      console.log('Not connected to a hub. Connect with: origin hub connect <url> --token <token>');
      return 0;
    }
    console.log(`Hub         ${hub.url}\nDevice      ${hub.device}`);
    if (isRelay(ctx.db))
      console.log('Mode        relay: keeps no sessions here, sends them to the hub');
    const last = lastSync(ctx, hub);
    console.log(`Last sync   ${last.synced}`);
    if (last.failed) console.log(`Last error  ${last.failed}`);
    await checkHub(hub, { renamable: !isStoreNameFixed(ctx.db) });
    console.log('Status      reachable, token accepted for this device');
    return 0;
  }
  if (action === 'disconnect') {
    console.log(
      removeHubConfig(ctx.home) ? 'Disconnected from the hub.' : 'Not connected to a hub.',
    );
    if (isRelay(ctx.db)) {
      console.log(
        "This store is still a relay: until it is connected again, its agents' sessions wait in their own logs, and nothing answers their tools.",
      );
    }
    return 0;
  }
  console.error(
    'Usage: origin hub connect <url> --token <token> [--device <name>] [--relay] | status | disconnect',
  );
  return 2;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
