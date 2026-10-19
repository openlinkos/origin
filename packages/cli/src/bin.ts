#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { adapterById, allAdapters, KNOWN_SOURCE_IDS } from '@openlinkos/origin-adapters';
import {
  type Database,
  dbPath,
  getEvent,
  listEvents,
  listProjects,
  listSessions,
  openDatabase,
  originHome,
  rawLocator,
  readRawLine,
  searchEvents,
  stats,
  syncSource,
} from '@openlinkos/origin-core';
import { oneLine, table } from './format.js';
import { fmtDate, fmtDateTime, fmtDuration, fmtTime, parseTime } from './time.js';

const USAGE = `origin — local-first, cross-agent personal memory

Usage:
  origin sync      [--source <id>] [--verbose]          Ingest local agent sessions (idempotent, safe to re-run)
  origin status                                          Per-source session/event counts and last sync
  origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
  origin timeline  --session <id> [--all]                Events of one session (tool events hidden unless --all)
  origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--limit 20]
  origin show      <event-id>                            Show an event, its raw locator, and the original line
  origin projects                                        Known project names

Time values: 7d / 24h / 30m / 2w or YYYY-MM-DD. Data directory: $ORIGIN_HOME or ~/.origin
Source ids: ${KNOWN_SOURCE_IDS.join(' · ')} (implemented: ${allAdapters()
  .map((a) => a.id)
  .join(', ')})`;

interface Ctx {
  db: Database;
  home: string;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  const home = originHome();
  const db = openDatabase(dbPath(home));
  const ctx: Ctx = { db, home };
  try {
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
      case 'projects':
        return cmdProjects(ctx);
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        return 2;
    }
  } finally {
    db.close();
  }
}

async function cmdSync(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { source: { type: 'string' }, verbose: { type: 'boolean', default: false } },
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
  return 0;
}

function cmdStatus(ctx: Ctx): number {
  const s = stats(ctx.db);
  if (s.length === 0) {
    console.log(`No data yet. Run: origin sync\nData directory: ${ctx.home}`);
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
  console.log(`\nData directory: ${ctx.home}`);
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
  console.log(`\n${sessions.length} session(s). View one: origin timeline --session <id>`);
  return 0;
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
    },
  });
  const query = positionals.join(' ').trim();
  if (!query) {
    console.error('Usage: origin search <query>');
    return 2;
  }
  const hits = searchEvents(ctx.db, query, {
    since: parseTime(values.since),
    until: parseTime(values.until),
    source: values.source,
    project: values.project,
    limit: values.limit ? Number(values.limit) : 20,
  });
  if (hits.length === 0) {
    console.log('No hits.');
    return 0;
  }
  for (const h of hits) {
    console.log(
      `[${fmtDateTime(h.ts)}] ${h.source} ${h.project ?? '—'} ${h.role}/${h.kind}\n    ${oneLine(h.snippet, 200)}\n    ↳ ${h.id}`,
    );
  }
  console.log(`\n${hits.length} hit(s). View the original: origin show <event-id>`);
  return 0;
}

function cmdShow(ctx: Ctx, args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error('Usage: origin show <event-id>');
    return 2;
  }
  const e = getEvent(ctx.db, id);
  if (!e) {
    console.log(`Event not found: ${id}`);
    return 1;
  }
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
    const raw = readRawLine(loc);
    if (raw) console.log(`\nOriginal line:\n${oneLine(raw, 600)}`);
  }
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
