#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { adapterById, allAdapters, KNOWN_SOURCE_IDS } from '@openlinkos/origin-adapters';
import { parseListen, parsePublicUrl } from '@openlinkos/origin-admin';
import {
  backupStore,
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
  forget,
  generateAdminPassword,
  getEntry,
  getEvent,
  HUB_STORE_NAME,
  initStoreName,
  isEntryForgotten,
  isEntryId,
  isEventForgotten,
  isStoreNameFixed,
  listAdminSessions,
  listAudit,
  listDevices,
  listEntries,
  listEvents,
  listProjects,
  listSessions,
  listTokens,
  NAME_RE,
  OriginError,
  openDatabase,
  originHome,
  parseTime,
  planForget,
  rawLocator,
  readRawLine,
  recordAudit,
  revokeToken,
  searchEntries,
  searchEvents,
  setAdminPassword,
  setStoreName,
  stats,
  storeName,
  syncSource,
} from '@openlinkos/origin-core';
import { serveReplica, serveStdio } from '@openlinkos/origin-mcp';
import { count, oneLine, table } from './format.js';
import {
  type HubConfig,
  normalizeHubUrl,
  readHubConfig,
  removeHubConfig,
  writeHubConfig,
} from './hub/config.js';
import { checkHub } from './hub/connect.js';
import { type HubAdminOptions, startHub } from './hub/serve.js';
import { type HubSyncResult, syncWithHub } from './hub/sync.js';
import { readNewPassword } from './password.js';
import { fmtDate, fmtDateTime, fmtDuration, fmtTime } from './time.js';

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
  origin forget    <id> [--reason <text>] [--yes]        Forget an entry or event for good (needs --yes)
  origin projects                                        Known project names
  origin backup    <dir>                                 Back up the database and raw mirrors into <dir> (incremental)
  origin mcp                                             Run the MCP server over stdio (forwards to the hub when connected)

Personal hub:
  origin serve     [--host 127.0.0.1] [--port 7077]      Run this store as a personal hub (MCP over HTTP)
                   [--admin | --admin-listen <host:port>] [--public-url <url>]   Also serve the admin UI
  origin token     create <name> | list | revoke <name>  Manage the hub's access tokens (run on the hub)
  origin admin     password [--generate]                 Set the admin UI password; signs out every session (run on the hub)
  origin admin     sessions [--revoke-all] | audit [--limit 50]       Admin UI sessions and the audit log
  origin hub       connect <url> --token <token> [--device <name>] | status | disconnect
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
const NAMED_COMMANDS = new Set(['sync', 'push', 'mcp', 'correct', 'forget', 'hub']);

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
  const db = openDatabase(dbPath(home));
  const ctx: Ctx = { db, home };
  try {
    nameStore(db, command);
    switch (command) {
      case 'sync':
        return await cmdSync(ctx, rest);
      case 'status':
        return cmdStatus(ctx);
      case 'timeline':
        return cmdTimeline(ctx, rest);
      case 'search':
        return cmdSearch(ctx, rest);
      case 'show':
        return cmdShow(ctx, rest);
      case 'entries':
        return cmdEntries(ctx, rest);
      case 'correct':
        return await cmdCorrect(ctx, rest);
      case 'forget':
        return await cmdForget(ctx, rest);
      case 'projects':
        return cmdProjects(ctx);
      case 'backup':
        return await cmdBackup(ctx, rest);
      case 'mcp':
        return await cmdMcp(ctx);
      case 'serve':
        return await cmdServe(ctx, rest);
      case 'token':
        return cmdToken(ctx, rest);
      case 'admin':
        return await cmdAdmin(ctx, rest);
      case 'hub':
        return await cmdHub(ctx, rest);
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

function cmdStatus(ctx: Ctx): number {
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
        String(r.events),
        fmtDate(r.firstTs),
        fmtDateTime(r.lastTs),
        r.lastSyncAt ? `${fmtDateTime(r.lastSyncAt)} (+${r.lastSyncEventsAdded ?? 0})` : '—',
      ]),
      ['source', 'files', 'sessions', 'events', 'first', 'latest event', 'last sync'],
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
  if (hub) console.log(`\nConnected to hub ${hub.url} as ${hub.device}.`);
  return 0;
}

function cmdTimeline(ctx: Ctx, args: string[]): number {
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
  if (values.session) {
    const events = listEvents(ctx.db, {
      sessionId: values.session,
      source: values.source,
      kinds: values.all ? undefined : ['message', 'meta'],
      limit: limit ?? 500,
    });
    if (events.length === 0) {
      console.log('No matching events.');
      return 0;
    }
    const first = events[0];
    console.log(
      `Session ${values.session}  source ${first?.source}  project ${first?.project ?? '—'}  cwd ${first?.cwd ?? '—'}\n`,
    );
    for (const e of events) {
      const tag = e.kind === 'message' ? e.role : `${e.role}/${e.kind}`;
      console.log(`[${fmtDateTime(e.ts)}] ${tag.padEnd(20)} ${oneLine(e.text, 160)}`);
      console.log(`    ↳ ${e.id}`);
    }
    return 0;
  }
  const since = parseTime(values.since ?? '7d');
  const until = parseTime(values.until);
  const sessions = listSessions(ctx.db, {
    since,
    until,
    source: values.source,
    project: values.project,
    limit: limit ?? 50,
  });
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
    console.log(
      `  ${fmtTime(s.startedAt)}–${fmtTime(s.endedAt)}  ${s.source.padEnd(11)} ${(s.project ?? '—').padEnd(24)} ${String(s.eventCount).padStart(5)} events  ${oneLine(s.title ?? '', 60)}`,
    );
    console.log(`           ↳ ${s.sessionId}`);
  }
  console.log(`\n${count(sessions.length, 'session')}. View one: origin timeline --session <id>`);
  return 0;
}

function printEntryLine(e: Entry): void {
  const tags = [e.kind, `conf ${e.confidence}`, e.project, e.status === 'active' ? null : e.status]
    .filter(Boolean)
    .join(', ');
  console.log(`[${fmtDateTime(e.createdAt)}] ${tags}\n    ${oneLine(e.text, 200)}\n    ↳ ${e.id}`);
}

function cmdSearch(ctx: Ctx, args: string[]): number {
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
  const entries = searchEntries(ctx.db, query, { project: values.project, limit });
  const hits = searchEvents(ctx.db, query, {
    since: parseTime(values.since),
    until: parseTime(values.until),
    source: values.source,
    project: values.project,
    kinds: values.all ? undefined : ['message'],
    order: values.recent ? 'recent' : 'relevance',
    limit,
  });
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

function cmdShow(ctx: Ctx, args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error('Usage: origin show <id>');
    return 2;
  }
  if (isEntryId(id)) return showEntry(ctx, id);
  const e = getEvent(ctx.db, id);
  if (!e) return notFound(ctx, id);
  const loc = rawLocator(ctx.db, ctx.home, e);
  console.log(`Event    ${e.id}`);
  console.log(`Time     ${fmtDateTime(e.ts)}  (${new Date(e.ts).toISOString()})`);
  console.log(`Source   ${e.source}  session ${e.sessionId}  version ${e.agentVersion ?? '—'}`);
  console.log(`Project  ${e.project ?? '—'}  cwd ${e.cwd ?? '—'}  branch ${e.gitBranch ?? '—'}`);
  console.log(`Role     ${e.role}/${e.kind}${e.meta ? `  meta ${JSON.stringify(e.meta)}` : ''}`);
  console.log('\nText:\n');
  console.log(e.text);
  if (loc) {
    console.log('\nRaw locator:');
    console.log(`  original  ${loc.originalPath} (generation ${loc.generation})`);
    console.log(`  mirror    ${loc.mirrorPath}:${loc.line}`);
    const raw = readRawLine(ctx.db, ctx.home, loc);
    if (raw) console.log(`\nOriginal line:\n${oneLine(raw, 600)}`);
  }
  return 0;
}

function showEntry(ctx: Ctx, id: string): number {
  const e = getEntry(ctx.db, id);
  if (!e) return notFound(ctx, id);
  const history = entryHistory(ctx.db, id).map((v) => (v.id === id ? `${v.id} (this)` : v.id));
  console.log(`Entry       ${e.id}  ${e.kind}, ${e.status}`);
  console.log(
    `Created     ${fmtDateTime(e.createdAt)} by ${e.author}  confidence ${e.confidence}  project ${e.project ?? '—'}`,
  );
  if (e.validFrom !== null || e.validTo !== null) {
    console.log(`Valid       ${fmtDateTime(e.validFrom)} → ${fmtDateTime(e.validTo)}`);
  }
  if (e.status === 'superseded') {
    const why = e.concurrent ? ', after a concurrent correction' : '';
    console.log(`Current     ${e.supersededBy}${why}`);
  }
  if (history.length > 1) console.log(`History     ${history.join(', ')}`);
  console.log(`\n${e.text}\n\nSources:`);
  for (const s of entrySources(ctx.db, id)) {
    console.log(
      `  [${fmtDateTime(s.event.ts)}] ${s.event.source} ${s.event.project ?? '—'} ${s.event.role}/${s.event.kind}`,
    );
    console.log(`      ${oneLine(s.quote ? `“${s.quote}”` : s.event.text, 200)}`);
    console.log(`      ↳ ${s.eventId}`);
  }
  return 0;
}

function parseKind(value: string | undefined): EntryKind | undefined {
  if (value === undefined) return undefined;
  if (!(ENTRY_KINDS as readonly string[]).includes(value)) {
    throw new OriginError(`Unknown kind "${value}"; expected ${ENTRY_KINDS.join(', ')}.`);
  }
  return value as EntryKind;
}

function cmdEntries(ctx: Ctx, args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: 'string' },
      project: { type: 'string' },
      history: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
  });
  const entries = listEntries(ctx.db, {
    kind: parseKind(values.kind),
    project: values.project,
    includeSuperseded: values.history,
    limit: values.limit ? Number(values.limit) : 50,
  });
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
  const e = correct(ctx.db, id, {
    text,
    author: `user@${storeName(ctx.db)}`,
    kind: parseKind(values.kind),
    confidence: values.confidence === undefined ? 1 : Number(values.confidence),
  });
  console.log(`Corrected ${id} → ${e.id}`);
  await syncAfterChange(ctx);
  return 0;
}

async function cmdForget(ctx: Ctx, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false } },
  });
  const id = positionals[0];
  if (!id) {
    console.error('Usage: origin forget <id> [--reason <text>] [--yes]');
    return 2;
  }
  const plan = planForget(ctx.db, id);
  if (plan.entries.length === 0 && plan.events.length === 0) {
    console.log(`${id} has already been forgotten.`);
    return 0;
  }
  const summary = `${count(plan.entries.length, 'entry', 'entries')} and ${count(plan.events.length, 'event')}`;
  if (!values.yes) {
    console.log(`This will forget ${summary}:`);
    for (const e of plan.entries) console.log(`  ${e}`);
    for (const e of plan.events) console.log(`  ${e}`);
    console.log('\nForgetting cannot be undone. Re-run with --yes to confirm.');
    return 1;
  }
  const done = forget(ctx.db, id, values.reason);
  console.log(`Forgot ${summary} (tombstone ${done.tombstoneId}).`);
  await syncAfterChange(ctx);
  return 0;
}

function cmdProjects(ctx: Ctx): number {
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
  if (hub) {
    // Answer from this device's store, merged with the hub's answers; sync up after writes.
    await serveReplica({
      db: ctx.db,
      home: ctx.home,
      device,
      hub: { url: hub.url, token: hub.token },
      version: VERSION,
      log,
      ingest: () => syncAll(ctx),
      sync: async () => {
        await syncWithHub({ db: ctx.db, home: ctx.home, hub });
      },
      hubTimeoutMs: hubTimeoutMs(),
    });
    return 0;
  }
  await serveStdio({
    db: ctx.db,
    home: ctx.home,
    device,
    version: VERSION,
    sync: () => syncAll(ctx),
    log,
  });
  return 0;
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
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OriginError(`Invalid port: ${values.port}`);
  }
  const admin = adminOptions(values);
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

async function cmdHub(ctx: Ctx, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'connect') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { token: { type: 'string' }, device: { type: 'string' } },
    });
    const url = positionals[0];
    if (!url || !values.token) {
      console.error('Usage: origin hub connect <url> --token <token> [--device <name>]');
      return 2;
    }
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
    writeHubConfig(ctx.home, hub);
    console.log(
      `Connected to ${hub.url} as ${hub.device}. Run "origin sync" to send this device's sessions and entries.`,
    );
    return 0;
  }
  if (action === 'status') {
    const hub = hubOf(ctx);
    if (!hub) {
      console.log('Not connected to a hub. Connect with: origin hub connect <url> --token <token>');
      return 0;
    }
    console.log(`Hub     ${hub.url}\nDevice  ${hub.device}`);
    await checkHub(hub, { renamable: !isStoreNameFixed(ctx.db) });
    console.log('Status  reachable, token accepted for this device');
    return 0;
  }
  if (action === 'disconnect') {
    console.log(
      removeHubConfig(ctx.home) ? 'Disconnected from the hub.' : 'Not connected to a hub.',
    );
    return 0;
  }
  console.error(
    'Usage: origin hub connect <url> --token <token> [--device <name>] | status | disconnect',
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
