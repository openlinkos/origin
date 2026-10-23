import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  type AdminSessionInfo,
  type AuditRecord,
  activeProjects,
  createToken as coreCreateToken,
  correct,
  type Database,
  type DeviceFile,
  deviceFiles,
  ENTRY_KINDS,
  type Entry,
  type EntryKind,
  type EntrySource,
  type EventRow,
  endAdminSessions,
  entriesCiting,
  entryCounts,
  entryHistory,
  entrySources,
  eventActivity,
  type ForgetResult,
  forget,
  getEntry,
  getEvent,
  getSession,
  getTombstone,
  type HiddenContent,
  hiddenContent,
  type IngestHealth,
  ingestHealth,
  isEntryForgotten,
  isEventForgotten,
  latestAgentVersions,
  listAdminSessions,
  listAudit,
  listDevices,
  listEntries,
  listEvents,
  listProjects,
  listSessionEvents,
  listSessions,
  listTokens,
  listTombstones,
  OriginError,
  planForget,
  planRestore,
  type RestorePlan,
  type RestoreResult,
  rawDir,
  rawLocator,
  readRawLine,
  recordAudit,
  remember,
  restore,
  revokeToken,
  type SearchHit,
  type SessionRow,
  type SourceStats,
  type StoreUsage,
  searchEntries,
  searchEvents,
  sessionTurnStarts,
  stats,
  storeName,
  storeUsage,
  type TokenInfo,
  type TombstoneSummary,
  type TurnStart,
  tombstoneCount,
} from '@openlinkos/origin-core';
import { HttpError } from './http.js';
import { dayIndex, dayKey, groupTurns, type SessionDay, type Turn } from './turns.js';

/** Raw lines are shown truncated to this many characters. */
export const RAW_LINE_MAX = 4000;
/** A device that has sent nothing for this long is flagged on the overview. */
export const STALE_DEVICE_MS = 24 * 3_600_000;
export const PAGE_SIZE = 50;
/** At most this many hidden entries, and as many hidden events, on a forget's page. */
export const HIDDEN_LIMIT = 200;
/** A session's page shows this many turns, */
export const TURNS_PER_PAGE = 20;
/**
 * … and at most this many events: a page stops before the turn that would pass it, and a turn
 * longer than that is shown in parts.
 */
export const TURN_EVENT_BUDGET = 1500;
/** The overview's chart covers this many days, today included. */
export const ACTIVITY_DAYS = 30;
/** Storage on disk is measured again after this long (it stats every mirror with a bucket). */
const STORAGE_TTL_MS = 60_000;

/** Who is acting, for the audit log. */
export interface Actor {
  /** `owner` once signed in to a hub, `local` in `origin ui`, `anonymous` before. */
  actor: string;
  ip: string | null;
  userAgent: string | null;
}

export interface DeviceSummary {
  device: string;
  files: number;
  bytes: number;
  lastUpdateAt: number;
  stale: boolean;
}

/**
 * The hub a device is connected to, as `origin ui` shows it. The CLI reads it from the device's
 * hub connection; the admin package never talks to a hub itself.
 */
export interface HubLink {
  url: string;
  /** This device's name on the hub (the store's name). */
  device: string;
  /** When this device last finished a sync with the hub, from any process; null if never. */
  lastSyncAt: number | null;
  /** Whether `origin ui` is syncing with the hub right now. */
  syncing: boolean;
  /** Why the last sync `origin ui` started failed, or null. */
  lastError: string | null;
}

/** A source on the overview: its totals, with its agent's latest version and recent parse errors. */
export interface SourceOverview extends SourceStats {
  agentVersion: string | null;
  parseErrors7d: number;
}

/** One day of the overview's chart: visible events per source. */
export interface ActivityDay {
  /** `YYYY-MM-DD`, in the server's time zone. */
  day: string;
  /** Local midnight that starts it. */
  start: number;
  events: number;
  bySource: Record<string, number>;
}

/** A session in a list: with the number of its turns (its prompts). */
export interface SessionListRow extends SessionRow {
  turns: number;
}

export interface Overview {
  version: string;
  uptimeMs: number;
  counts: {
    events: number;
    sessions: number;
    entries: number;
    tombstones: number;
    devices: number;
    activeTokens: number;
  };
  entries: Record<EntryKind, number>;
  sources: SourceOverview[];
  devices: DeviceSummary[];
  usage: StoreUsage;
  parseErrors: { last24h: number; last7d: number; bySource7d: IngestHealth[] };
  /** For `origin ui`: the hub this device is connected to, or null. Always null on a hub. */
  hub: HubLink | null;
  /** Visible events per day over the last ACTIVITY_DAYS days, oldest first. */
  activity: ActivityDay[];
  /** The most recently active sessions. */
  recent: SessionRow[];
  /** Projects by their events over the last ACTIVITY_DAYS days, busiest first. */
  projects: Array<{ project: string; events: number; sessions: number; lastAt: number }>;
  latestEntries: Entry[];
  /** The latest forgets and restores (ids, reasons, and counts; never what they hide). */
  latestTombstones: TombstoneSummary[];
}

/** A page of a session's turns (see AdminService.sessionTurns). */
export interface SessionTurns {
  session: SessionRow;
  /** How many turns the session has: its prompts, and what came before the first, if anything. */
  total: number;
  /** Whether events precede the first prompt (turn 0). */
  preamble: boolean;
  /** The first turn of the page, and for a turn shown in parts, the part. */
  turn: number;
  part: number;
  turns: Turn[];
  /** The last turn on the page goes on in the next part. */
  continues: boolean;
  next: { turn: number; part: number } | null;
  previous: { turn: number; part: number } | null;
  days: SessionDay[];
}

export interface Provenance {
  source: string;
  device: string | null;
  originalPath: string;
  generation: number;
  /** The mirror file, relative to the store's raw/ directory. */
  mirror: string;
  line: number;
}

export interface EventDetail {
  event: EventRow;
  provenance: Provenance | null;
  citing: Entry[];
}

export interface EntryDetail {
  entry: Entry;
  sources: EntrySource[];
  history: Entry[];
}

export interface ForgetPlan {
  plan: ForgetResult;
  /** Digest of the plan: forgetting is refused if the plan changed after it was shown. */
  digest: string;
}

/** A forget or a restore, for its page. */
export interface TombstoneDetail {
  tombstone: TombstoneSummary;
  /** For a forget in effect: what it hides here, text included (shown to the owner only). */
  hidden: HiddenContent | null;
  /** For a forget in effect: what restoring it would bring back here. */
  restorePlan: RestorePlan | null;
  /** For a forget: the restores that lifted it. */
  restores: TombstoneSummary[];
  /** For a restore: the forget it lifts, if this store has it. */
  forget: TombstoneSummary | null;
}

export interface Snippets {
  hubUrl: string;
  /** False when no public URL is configured and the URL is a placeholder. */
  known: boolean;
  device: string;
  claude: string;
  codex: string;
}

/** Ids are opaque, but bounded: they go into queries, never into SQL. */
function checkId(id: unknown, what = 'id'): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
    throw new HttpError(400, `Missing or invalid ${what}.`);
  }
  return id;
}

function parseKind(value: unknown): EntryKind | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (ENTRY_KINDS as readonly string[]).includes(value)) {
    return value as EntryKind;
  }
  throw new OriginError(`Unknown kind "${String(value)}"; expected ${ENTRY_KINDS.join(', ')}.`);
}

function parseConfidence(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1)
    throw new OriginError('Confidence must be between 0 and 1.');
  return n;
}

function text(value: unknown, what: string, max = 20_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OriginError(`${what} is empty.`);
  }
  if (value.length > max) throw new OriginError(`${what} is longer than ${max} characters.`);
  return value;
}

/** The digest of a forget plan: what will be forgotten, independent of order. */
export function planDigest(plan: ForgetResult): string {
  const canonical = JSON.stringify({
    target: plan.target,
    type: plan.targetType,
    entries: [...plan.entries].sort(),
    events: [...plan.events].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Copy-paste commands to connect a device or an agent. */
export function connectSnippets(
  publicUrl: URL | null,
  token = '<token>',
  device = '<device-name>',
): Snippets {
  const hubUrl = publicUrl ? publicUrl.origin : 'https://hub.example.com';
  return {
    hubUrl,
    known: publicUrl !== null,
    device: `npm install -g @openlinkos/origin\norigin hub connect ${hubUrl} --token ${token} --device ${device}\norigin sync`,
    claude: `claude mcp add --scope user --transport http origin ${hubUrl}/mcp --header "Authorization: Bearer ${token}"`,
    codex: `export ORIGIN_TOKEN=${token}\ncodex mcp add origin --url ${hubUrl}/mcp --bearer-token-env-var ORIGIN_TOKEN`,
  };
}

/**
 * Every read and write of the admin UI, shared by its pages and its JSON API. Writes go through
 * the same core operations as the CLI and MCP (invariant 5, single entry point) and are recorded
 * in the audit log with ids and counts only.
 */
export class AdminService {
  constructor(
    private readonly o: {
      db: Database;
      home: string;
      version: string;
      startedAt: number;
      publicUrl: URL | null;
      /** For `origin ui`: the hub this device is connected to, if any. */
      hub?: () => HubLink | null;
      /**
       * The hub's own store: restores log again the forgets whose coverage changes, so that the
       * devices receive them.
       */
      hubStore?: boolean;
      /** Called after an entry is written, or a forget or restore (`origin ui` then syncs). */
      afterWrite?: () => void;
    },
  ) {}

  /** The hub this device is connected to (`origin ui` only), or null. */
  hub(): HubLink | null {
    return this.o.hub?.() ?? null;
  }

  /** The write has been made; what follows it (a background sync) must not make it look failed. */
  private written(): void {
    try {
      this.o.afterWrite?.();
    } catch {
      // The callback reports its own failures.
    }
  }

  private get db(): Database {
    return this.o.db;
  }

  private audit(
    who: Actor,
    action: string,
    target: string | null,
    detail: Record<string, string | number | boolean | null | string[]> | null,
  ): void {
    recordAudit(this.db, {
      actor: who.actor,
      channel: 'ui',
      action,
      target,
      detail,
      ip: who.ip,
      userAgent: who.userAgent,
    });
  }

  private storage: { at: number; usage: StoreUsage } | null = null;

  /**
   * Disk usage of the store. With a bucket, measuring it stats every mirror's frame file, so it is
   * measured at most once a minute; without one, it is read from the database every time.
   */
  private usage(now: number): StoreUsage {
    if (this.storage && now - this.storage.at < STORAGE_TTL_MS) return this.storage.usage;
    const usage = storeUsage(this.db, this.o.home);
    this.storage = usage.bucket ? { at: now, usage } : null;
    return usage;
  }

  overview(now: number): Overview {
    const sources = stats(this.db);
    const entries = entryCounts(this.db);
    const devices = this.devices(now);
    const week = ingestHealth(this.db, { since: now - 7 * 86_400_000 });
    const day = ingestHealth(this.db, { since: now - 86_400_000 });
    const sum = (rows: IngestHealth[]) => rows.reduce((n, r) => n + r.parseErrors, 0);
    const versions = latestAgentVersions(this.db);
    const errors = new Map<string, number>();
    for (const r of week) errors.set(r.source, (errors.get(r.source) ?? 0) + r.parseErrors);
    const activity = this.activity(now, sources);
    return {
      version: this.o.version,
      uptimeMs: now - this.o.startedAt,
      counts: {
        events: sources.reduce((n, s) => n + s.events, 0),
        sessions: sources.reduce((n, s) => n + s.sessions, 0),
        entries: entries.memory + entries.knowledge + entries.cognition,
        tombstones: tombstoneCount(this.db),
        devices: devices.length,
        activeTokens: listTokens(this.db).filter((t) => t.revokedAt === null).length,
      },
      entries,
      sources: sources.map((s) => ({
        ...s,
        agentVersion: versions.get(s.source) ?? null,
        parseErrors7d: errors.get(s.source) ?? 0,
      })),
      devices,
      usage: this.usage(now),
      parseErrors: {
        last24h: sum(day),
        last7d: sum(week),
        bySource7d: week.filter((r) => r.parseErrors > 0),
      },
      hub: this.hub(),
      activity: activity.days,
      recent: listSessions(this.db, { limit: 6 }),
      projects: activity.projects,
      latestEntries: listEntries(this.db, { limit: 5 }),
      latestTombstones: listTombstones(this.db, { limit: 5 }),
    };
  }

  private activityCache: {
    key: string;
    value: { days: ActivityDay[]; projects: Overview['projects'] };
  } | null = null;

  /**
   * Events per day over the last ACTIVITY_DAYS days, by source, and the busiest projects then.
   * Days are those of the server's time zone, like the times the pages show. Counting reads an
   * index entry per event of those days, so the result is kept while the day and every source's
   * visible totals stay the same, which an arriving or forgotten event changes.
   */
  private activity(
    now: number,
    sources: SourceStats[],
  ): { days: ActivityDay[]; projects: Overview['projects'] } {
    const key = JSON.stringify([
      dayKey(now),
      sources.map((s) => [s.source, s.sessions, s.events, s.firstTs, s.lastTs]),
    ]);
    if (this.activityCache?.key === key) return this.activityCache.value;
    const value = this.countActivity(now);
    this.activityCache = { key, value };
    return value;
  }

  private countActivity(now: number): { days: ActivityDay[]; projects: Overview['projects'] } {
    const today = new Date(now);
    const days: ActivityDay[] = [];
    for (let k = ACTIVITY_DAYS - 1; k >= 0; k--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - k);
      days.push({ day: dayKey(d.getTime()), start: d.getTime(), events: 0, bySource: {} });
    }
    const since = days[0]?.start ?? now;
    const byDay = new Map(days.map((d) => [d.day, d]));
    const byProject = new Map<string, number>();
    for (const r of eventActivity(this.db, { since, until: now + 1 })) {
      const d = byDay.get(dayKey(r.start));
      if (d) {
        d.events += r.events;
        d.bySource[r.source] = (d.bySource[r.source] ?? 0) + r.events;
      }
      if (r.project !== null) byProject.set(r.project, (byProject.get(r.project) ?? 0) + r.events);
    }
    const projects = activeProjects(this.db, { since })
      .map((p) => ({ ...p, events: byProject.get(p.project) ?? 0 }))
      .sort((a, b) => b.events - a.events || b.sessions - a.sessions || b.lastAt - a.lastAt)
      .slice(0, 6);
    return { days, projects };
  }

  devices(now: number): DeviceSummary[] {
    return listDevices(this.db).map((d) => ({
      ...d,
      stale: now - d.lastUpdateAt > STALE_DEVICE_MS,
    }));
  }

  device(
    name: unknown,
    now: number,
  ): {
    device: DeviceSummary;
    files: DeviceFile[];
    health: IngestHealth[];
    token: TokenInfo | null;
  } {
    const id = checkId(name, 'device');
    const device = this.devices(now).find((d) => d.device === id);
    if (!device) throw new HttpError(404, `Unknown device ${id}.`);
    return {
      device,
      files: deviceFiles(this.db, id),
      health: ingestHealth(this.db, { since: now - 7 * 86_400_000, device: id }),
      token: listTokens(this.db).find((t) => t.name === id) ?? null,
    };
  }

  tokens(): TokenInfo[] {
    return listTokens(this.db);
  }

  /** Create a hub token. It is returned once and never shown again. */
  createToken(who: Actor, name: unknown): { name: string; token: string; snippets: Snippets } {
    const tokenName = typeof name === 'string' ? name.trim() : '';
    const token = coreCreateToken(this.db, tokenName);
    this.audit(who, 'token.create', tokenName, null);
    return {
      name: tokenName,
      token,
      snippets: connectSnippets(this.o.publicUrl, token, tokenName),
    };
  }

  revokeToken(who: Actor, name: unknown): void {
    const tokenName = checkId(name, 'token name');
    if (!revokeToken(this.db, tokenName)) {
      throw new OriginError(`No active token named ${tokenName}.`);
    }
    this.audit(who, 'token.revoke', tokenName, null);
  }

  projects(): Array<{ project: string; sessions: number; events: number }> {
    return listProjects(this.db, 200);
  }

  sources(): string[] {
    return stats(this.db).map((s) => s.source);
  }

  sessions(filter: {
    source?: string;
    project?: string;
    q?: string;
    since?: number;
    page?: number;
  }): {
    sessions: SessionListRow[];
    page: number;
    more: boolean;
  } {
    const page = Math.max(0, filter.page ?? 0);
    const rows = listSessions(this.db, {
      source: filter.source || undefined,
      project: filter.project || undefined,
      match: filter.q?.trim().slice(0, 200) || undefined,
      since: filter.since,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
    });
    return {
      sessions: rows.slice(0, PAGE_SIZE).map((s) => ({
        ...s,
        turns: sessionTurnStarts(this.db, s.source, s.sessionId).length,
      })),
      page,
      more: rows.length > PAGE_SIZE,
    };
  }

  private session(source: unknown, id: unknown): SessionRow {
    const src = checkId(source, 'source');
    const sessionId = checkId(id, 'session id');
    const session = getSession(this.db, src, sessionId);
    if (!session) throw new HttpError(404, `Unknown session ${sessionId}.`);
    return session;
  }

  sessionEvents(
    source: unknown,
    id: unknown,
    opts: { tools?: boolean; page?: number } = {},
  ): { session: SessionRow; events: EventRow[]; page: number; more: boolean } {
    const session = this.session(source, id);
    const page = Math.max(0, opts.page ?? 0);
    const size = 200;
    const rows = listEvents(this.db, {
      source: session.source,
      sessionId: session.sessionId,
      kinds: opts.tools ? undefined : ['message', 'meta'],
      limit: size + 1,
      offset: page * size,
    });
    return { session, events: rows.slice(0, size), page, more: rows.length > size };
  }

  /**
   * A page of a session by turns: TURNS_PER_PAGE turns from `turn` on, or fewer if they hold more
   * than TURN_EVENT_BUDGET events; a single turn longer than that comes in parts. The turns are
   * found from the session's prompts alone (see sessionPrompts), and only the events of the turns
   * on the page are read.
   */
  sessionTurns(
    source: unknown,
    id: unknown,
    opts: { turn?: number; part?: number; at?: string } = {},
  ): SessionTurns {
    const session = this.session(source, id);
    const key = { source: session.source, sessionId: session.sessionId };
    // Where turns start: the prompts, and the commands the agent acted on.
    const prompts: TurnStart[] = sessionTurnStarts(this.db, key.source, key.sessionId);
    const first = prompts[0];
    const preamble = first
      ? listSessionEvents(this.db, { ...key, to: first, limit: 1 }).length > 0
      : session.eventCount > 0;
    const lowest = preamble ? 0 : 1;
    const highest = Math.max(lowest, prompts.length);
    // `at`: the turn that holds an event of this session, by its time.
    const at = opts.at && opts.turn === undefined ? getEvent(this.db, opts.at) : null;
    const atTurn =
      at && at.source === key.source && at.sessionId === key.sessionId
        ? prompts.filter((p) => p.ts <= at.ts).length
        : undefined;
    const turn = Math.min(Math.max(opts.turn ?? atTurn ?? lowest, lowest), highest);
    const part = turn === opts.turn ? Math.max(0, opts.part ?? 0) : 0;
    const from = turn === 0 ? null : (prompts[turn - 1] ?? null);
    const base = {
      session,
      total: prompts.length + (preamble ? 1 : 0),
      preamble,
      turn,
      part,
      days: dayIndex(prompts),
    };

    if (part > 0) {
      const rows = listSessionEvents(this.db, {
        ...key,
        from,
        to: prompts[turn] ?? null,
        limit: TURN_EVENT_BUDGET + 1,
        offset: part * TURN_EVENT_BUDGET,
      });
      const continues = rows.length > TURN_EVENT_BUDGET;
      return {
        ...base,
        turns: groupTurns(rows.slice(0, TURN_EVENT_BUDGET), [], turn + 1),
        continues,
        next: continues
          ? { turn, part: part + 1 }
          : turn < prompts.length
            ? { turn: turn + 1, part: 0 }
            : null,
        previous: { turn, part: part - 1 },
      };
    }

    const end = turn + TURNS_PER_PAGE; // the first turn of the next page
    const rows = listSessionEvents(this.db, {
      ...key,
      from,
      to: end <= prompts.length ? (prompts[end - 1] ?? null) : null,
      limit: TURN_EVENT_BUDGET + 1,
    });
    const firstNumber = Math.max(turn, 1);
    let turns = groupTurns(
      rows.slice(0, TURN_EVENT_BUDGET),
      prompts.slice(firstNumber - 1, end - 1),
      firstNumber,
    );
    let continues = false;
    let next: SessionTurns['next'] = end <= prompts.length ? { turn: end, part: 0 } : null;
    if (rows.length > TURN_EVENT_BUDGET) {
      const cut = turns.at(-1);
      if (cut && turns.length > 1) {
        // The last turn does not fit: the next page starts with it.
        turns = turns.slice(0, -1);
        next = { turn: cut.number, part: 0 };
      } else {
        continues = true;
        next = { turn, part: 1 };
      }
    }
    return {
      ...base,
      turns,
      continues,
      next,
      previous: turn > lowest ? { turn: Math.max(lowest, turn - TURNS_PER_PAGE), part: 0 } : null,
    };
  }

  private visibleEvent(id: unknown): EventRow {
    const eventId = checkId(id, 'event id');
    const event = getEvent(this.db, eventId);
    if (event) return event;
    // Forgotten events are reported as gone, with nothing about their content.
    if (isEventForgotten(this.db, eventId)) {
      throw new HttpError(410, `${eventId} has been forgotten.`);
    }
    throw new HttpError(404, `Unknown event ${eventId}.`);
  }

  event(id: unknown): EventDetail {
    const event = this.visibleEvent(id);
    const loc = rawLocator(this.db, this.o.home, event);
    return {
      event,
      provenance: loc
        ? {
            source: loc.source,
            device: loc.device,
            originalPath: loc.originalPath,
            generation: loc.generation,
            mirror: path.relative(rawDir(this.o.home), loc.mirrorPath).split(path.sep).join('/'),
            line: loc.line,
          }
        : null,
      citing: entriesCiting(this.db, event.id),
    };
  }

  /** The original line of a visible event (invariant 1), truncated. */
  eventRaw(id: unknown): { id: string; line: string | null; truncated: boolean; length: number } {
    const event = this.visibleEvent(id);
    const loc = rawLocator(this.db, this.o.home, event);
    const line = loc ? readRawLine(this.db, this.o.home, loc) : null;
    if (line === null) return { id: event.id, line: null, truncated: false, length: 0 };
    return {
      id: event.id,
      line: line.length > RAW_LINE_MAX ? line.slice(0, RAW_LINE_MAX) : line,
      truncated: line.length > RAW_LINE_MAX,
      length: line.length,
    };
  }

  search(
    query: unknown,
    opts: { tools?: boolean; scope?: string } = {},
  ): { query: string; entries: Entry[]; events: SearchHit[] } {
    const q = typeof query === 'string' ? query.trim().slice(0, 500) : '';
    if (q.length === 0) return { query: q, entries: [], events: [] };
    const entries = opts.scope === 'events' ? [] : searchEntries(this.db, q, { limit: 30 });
    const events =
      opts.scope === 'entries'
        ? []
        : searchEvents(this.db, q, { kinds: opts.tools ? undefined : ['message'], limit: 50 });
    return { query: q, entries, events };
  }

  entries(filter: { kind?: unknown; project?: string; history?: boolean; page?: number }): {
    entries: Entry[];
    page: number;
    more: boolean;
  } {
    const page = Math.max(0, filter.page ?? 0);
    const rows = listEntries(this.db, {
      kind: parseKind(filter.kind),
      project: filter.project || undefined,
      includeSuperseded: filter.history === true,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
    });
    return { entries: rows.slice(0, PAGE_SIZE), page, more: rows.length > PAGE_SIZE };
  }

  entry(id: unknown): EntryDetail {
    const entryId = checkId(id, 'entry id');
    const entry = getEntry(this.db, entryId);
    if (!entry) {
      if (isEntryForgotten(this.db, entryId)) {
        throw new HttpError(410, `${entryId} has been forgotten.`);
      }
      throw new HttpError(404, `Unknown entry ${entryId}.`);
    }
    return {
      entry,
      sources: entrySources(this.db, entryId),
      history: entryHistory(this.db, entryId),
    };
  }

  forgetPlan(id: unknown): ForgetPlan {
    const plan = planForget(this.db, checkId(id));
    return { plan, digest: planDigest(plan) };
  }

  /**
   * Forget an entry or event (invariant 2), with the owner's reason. The caller sends the digest of
   * the plan it showed; if the plan has changed since, nothing happens (409). A forget can be
   * restored, so one confirmation is enough.
   */
  forget(who: Actor, input: { id: unknown; digest: unknown; reason?: unknown }): ForgetResult {
    const id = checkId(input.id);
    const reason = typeof input.reason === 'string' ? input.reason : '';
    const plan = planForget(this.db, id);
    if (plan.entries.length === 0 && plan.events.length === 0) {
      throw new OriginError(`${id} has already been forgotten.`);
    }
    if (input.digest !== planDigest(plan)) {
      throw new HttpError(409, 'What would be forgotten has changed. Review the plan again.');
    }
    const result = forget(this.db, id, { reason, author: `user@${storeName(this.db)}` });
    // Ids and counts only: the audit log never keeps text, the reason included.
    this.audit(who, 'forget', id, {
      targetType: result.targetType,
      tombstoneId: result.tombstoneId,
      entries: result.entries.length,
      events: result.events.length,
    });
    this.written();
    return result;
  }

  /** A forget or a restore; for a forget in effect, what it hides and what restoring brings back. */
  tombstone(id: unknown): TombstoneDetail {
    const tombstoneId = checkId(id, 'tombstone id');
    const t = getTombstone(this.db, tombstoneId);
    if (!t) throw new HttpError(404, `Unknown tombstone ${tombstoneId}.`);
    const live = t.kind === 'forget' && t.inEffect;
    return {
      tombstone: t,
      hidden: live ? hiddenContent(this.db, t.id, { limit: HIDDEN_LIMIT }) : null,
      restorePlan: live ? planRestore(this.db, t.id) : null,
      restores: t.restoredBy
        .map((r) => getTombstone(this.db, r))
        .filter((r): r is TombstoneSummary => r !== null),
      forget: t.kind === 'restore' ? getTombstone(this.db, t.target) : null,
    };
  }

  /**
   * Restore a forget, with the owner's reason: what it hid comes back, except what another forget
   * in effect covers, here and on every store the restore reaches. On a hub, forgets whose coverage
   * changes are logged again, so that every device follows.
   */
  restore(who: Actor, input: { id: unknown; reason?: unknown }): RestoreResult {
    const id = checkId(input.id, 'tombstone id');
    const result = restore(
      this.db,
      id,
      {
        reason: typeof input.reason === 'string' ? input.reason : '',
        author: `user@${storeName(this.db)}`,
      },
      Date.now(),
      { growthOrigin: this.o.hubStore ? storeName(this.db) : undefined },
    );
    this.audit(who, 'restore', id, {
      tombstoneId: result.tombstoneId,
      entries: result.entries.length,
      events: result.events.length,
    });
    this.written();
    return result;
  }

  /** Remember an entry citing one event, as the owner (author `user@<store>`). */
  remember(
    who: Actor,
    input: {
      eventId: unknown;
      kind: unknown;
      text: unknown;
      confidence?: unknown;
      quote?: unknown;
    },
  ): Entry {
    const event = this.visibleEvent(input.eventId);
    const kind = parseKind(input.kind);
    if (!kind) throw new OriginError(`Choose a kind: ${ENTRY_KINDS.join(', ')}.`);
    const quote = typeof input.quote === 'string' && input.quote.trim() ? input.quote : undefined;
    const entry = remember(this.db, {
      kind,
      text: text(input.text, 'Entry text'),
      confidence: parseConfidence(input.confidence),
      author: `user@${storeName(this.db)}`,
      project: event.project,
      sources: [{ eventId: event.id, quote }],
    });
    this.audit(who, 'entry.remember', entry.id, { source: event.id, kind });
    this.written();
    return entry;
  }

  /** Supersede an entry with a corrected version, as `origin correct` does. */
  correct(
    who: Actor,
    input: { id: unknown; text: unknown; kind?: unknown; confidence?: unknown },
  ): Entry {
    const id = checkId(input.id, 'entry id');
    const entry = correct(this.db, id, {
      text: text(input.text, 'Entry text'),
      author: `user@${storeName(this.db)}`,
      kind: parseKind(input.kind),
      confidence: parseConfidence(input.confidence),
    });
    this.audit(who, 'entry.correct', id, { newId: entry.id });
    this.written();
    return entry;
  }

  tombstones(before?: string): { tombstones: TombstoneSummary[]; more: boolean } {
    const rows = listTombstones(this.db, { limit: PAGE_SIZE + 1, before });
    return { tombstones: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
  }

  auditLog(beforeId?: number): { records: AuditRecord[]; more: boolean } {
    const rows = listAudit(this.db, { limit: PAGE_SIZE + 1, beforeId });
    return { records: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
  }

  connect(): Snippets {
    return connectSnippets(this.o.publicUrl);
  }

  adminSessions(now: number): AdminSessionInfo[] {
    return listAdminSessions(this.db, { now });
  }

  /** End other admin sessions: one by handle, or all but the caller's. */
  revokeSessions(
    who: Actor,
    input: { handle?: unknown; currentIdHash: string },
    now: number,
  ): number {
    const handle = typeof input.handle === 'string' && input.handle ? input.handle : undefined;
    const count = endAdminSessions(
      this.db,
      handle
        ? { handle, exceptIdHash: input.currentIdHash }
        : { exceptIdHash: input.currentIdHash },
      now,
    );
    this.audit(who, 'sessions.revoke', handle ?? 'others', { count });
    return count;
  }

  /** Record an authentication event (sign-in, sign-out, re-authentication, failures). */
  recordAuth(who: Actor, action: string, detail: Record<string, number> | null = null): void {
    this.audit(who, action, null, detail);
  }
}

export type DeviceDetail = ReturnType<AdminService['device']>;
