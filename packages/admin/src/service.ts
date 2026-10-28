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
  getRecall,
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
  listRecalls,
  listSessionEvents,
  listSessions,
  listTokens,
  listTombstones,
  OriginError,
  planForget,
  planRestore,
  RECALL_OCCASIONS,
  type RecallItemRecord,
  type RecallOccasion,
  type RecallRecord,
  type RestorePlan,
  type RestoreResult,
  rawDir,
  rawLocator,
  readRawLine,
  rebuildRecall,
  recallFacets,
  recallPrompt,
  recallSession,
  recallsWith,
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
  sessionRecalls,
  sessionTurnStarts,
  stats,
  storeName,
  storeUsage,
  type TokenInfo,
  type TombstoneSummary,
  type TurnStart,
  tombstoneCount,
  usedRefs,
} from '@openlinkos/origin-core';
import { HttpError } from './http.js';
import { dayIndex, dayKey, groupTurns, resultStatus, type SessionDay, type Turn } from './turns.js';

/** Raw lines are shown truncated to this many characters. */
export const RAW_LINE_MAX = 4000;
/** A device that has sent nothing for this long is flagged on the overview. */
export const STALE_DEVICE_MS = 24 * 3_600_000;
export const PAGE_SIZE = 50;
/** At most this many hidden entries, and as many hidden events, on a forget's page. */
export const HIDDEN_LIMIT = 200;
/** A session's page shows this many turns, */
export const TURNS_PER_PAGE = 20;
/** The latest recalls of an entry shown on its page. */
export const ENTRY_RECALLS = 10;
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

/** The overview's counts of the last ACTIVITY_DAYS days. */
interface Activity {
  days: ActivityDay[];
  projects: Overview['projects'];
  /** Sessions per day, by their last activity. */
  sessions: number[];
}

/** A session in a list: with the number of its turns (its prompts). */
export interface SessionListRow extends SessionRow {
  turns: number;
}

/** The time ranges of the sessions page, by the last activity of a session. */
export const SESSION_RANGES = ['today', '7d', '30d', 'all'] as const;
export type SessionRange = (typeof SESSION_RANGES)[number];
export const SESSION_SORTS = ['recent', 'events', 'duration'] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];

export interface SessionBoardFilter {
  agents: string[];
  projects: string[];
  range: SessionRange;
  /** Words of a session's title or first prompt. */
  q: string;
  /** Only sessions that were handed something (see docs/architecture.md#recall). */
  recalled: boolean;
  /** Sessions with a title, or those named by their first prompt. */
  name: 'any' | 'titled' | 'provisional';
  sort: SessionSort;
  page: number;
}

/** A value of a filter, and how many sessions choosing it would give. */
export interface FacetValue {
  value: string;
  count: number;
}

export interface SessionBoardRow extends SessionListRow {
  /** How many recalls handed this session something. */
  recalls: number;
}

/** A day of the sessions histogram: sessions by agent, each on the day of its last activity. */
export interface BoardDay {
  day: string;
  /** Local midnight that starts it. */
  start: number;
  bySource: Record<string, number>;
}

export interface SessionBoard {
  rows: SessionBoardRow[];
  total: number;
  page: number;
  more: boolean;
  facets: {
    agents: FacetValue[];
    projects: FacetValue[];
    recalled: number;
    titled: number;
    provisional: number;
  };
  ranges: Record<SessionRange, number>;
  /** The last 30 days, under every filter but the range. */
  histogram: BoardDay[];
  /** Where the range starts (local midnight), or null for all time. */
  since: number | null;
}

/** Which turns a session's outline lists: all, those with recalls, or those with failed calls. */
export const TRACE_SHOWS = ['all', 'recalled', 'failed'] as const;
export type TraceShow = (typeof TRACE_SHOWS)[number];

/** The turns the outline lists around the one shown. */
export const OUTLINE_TURNS = 200;

/** A turn in a session's outline, from its start and the session's tool events and recalls. */
export interface TraceTurn {
  number: number;
  /** What it starts with: its prompt or command, cut short; null before the first prompt. */
  label: string | null;
  command: boolean;
  startedAt: number;
  /** Until the next turn starts, or the session's last event. */
  duration: number;
  tools: number;
  failed: number;
  recalls: number;
}

/**
 * A step of the turn shown: its prompt, its recalls, the calls of one tool, or its reply, with
 * where each falls in the turn, as pairs of fractions from its start (0) to its end (1).
 */
export interface TraceStep {
  kind: 'prompt' | 'recall' | 'tool' | 'reply';
  /** The tool's name, for a tool. */
  label: string;
  count: number;
  failed: number;
  spans: Array<[number, number]>;
  /** For a tool, the time from its calls to their results, summed. */
  took: number;
}

export interface SessionTrace {
  session: SessionRow;
  /** The turns listed, around the one shown. */
  outline: TraceTurn[];
  /** The turns just before and after the outline, when it does not list them all. */
  earlier: number | null;
  later: number | null;
  /** How many turns start at a prompt. */
  total: number;
  preamble: boolean;
  number: number;
  part: number;
  continues: boolean;
  turn: Turn | null;
  steps: TraceStep[];
  /** The recalls made in the turn shown, each with its items as they are now. */
  recalls: Array<RecallView & { turn: number; views: RecallItemView[] }>;
  previous: number | null;
  next: number | null;
  show: TraceShow;
  totals: {
    tools: number;
    recalls: number;
    /** Items the session went on to use, over its recalls. */
    used: number;
    withRecalls: number;
    withFailures: number;
  };
}

/** The steps of a turn, each placed in it: prompt, recalls, the calls of each tool, reply. */
function traceSteps(turn: Turn, recalls: ReadonlyArray<{ at: number }>): TraceStep[] {
  const t0 = turn.startedAt;
  const span = Math.max(1, turn.endedAt - t0);
  const at = (ts: number) => Math.min(1, Math.max(0, (ts - t0) / span));
  const point = (ts: number): [number, number] => [at(ts), at(ts)];
  const steps: TraceStep[] = [];
  if (turn.prompt) {
    steps.push({
      kind: 'prompt',
      label: '',
      count: 1,
      failed: 0,
      spans: [point(turn.prompt.ts)],
      took: 0,
    });
  }
  if (recalls.length > 0) {
    steps.push({
      kind: 'recall',
      label: '',
      count: recalls.length,
      failed: 0,
      spans: recalls.map((r) => point(r.at)),
      took: 0,
    });
  }
  const byTool = new Map<string, TraceStep>();
  for (const item of [...turn.lead, ...turn.work, ...turn.trail]) {
    if (item.type !== 'tool') continue;
    const run = item.tool;
    const start = run.call?.ts ?? run.result?.ts;
    if (start === undefined) continue;
    const stop = run.result?.ts ?? start;
    let step = byTool.get(run.name);
    if (!step) {
      step = { kind: 'tool', label: run.name, count: 0, failed: 0, spans: [], took: 0 };
      byTool.set(run.name, step);
    }
    step.count++;
    if (run.status === 'error') step.failed++;
    step.spans.push([at(start), at(stop)]);
    step.took += Math.max(0, stop - start);
  }
  steps.push(...byTool.values());
  if (turn.reply) {
    steps.push({
      kind: 'reply',
      label: '',
      count: 1,
      failed: 0,
      spans: [point(turn.reply.ts)],
      took: 0,
    });
  }
  return steps;
}

/** What the sidebar counts. */
export interface NavCounts {
  sessions: number;
  recalls: number;
  entries: number;
}

interface BoardSession {
  source: string;
  session_id: string;
  project: string | null;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  event_count: number;
}

/** Local midnight that starts a range, or null for all time. */
export function rangeStart(range: SessionRange, now: number): number | null {
  if (range === 'all') return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (range === 'today' ? 0 : range === '7d' ? 6 : 29));
  return d.getTime();
}

/** The last 30 days, oldest first, each with its sessions by agent. */
function boardHistogram(
  rows: ReadonlyArray<Pick<BoardSession, 'source' | 'ended_at'>>,
  now: number,
): BoardDay[] {
  const first = rangeStart('30d', now) as number;
  const days: BoardDay[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    days.push({ day: dayKey(d.getTime()), start: d.getTime(), bySource: {} });
  }
  const index = new Map(days.map((d, i) => [d.day, i]));
  for (const r of rows) {
    const i = r.ended_at === null ? undefined : index.get(dayKey(r.ended_at));
    if (i === undefined) continue;
    const by = (days[i] as BoardDay).bySource;
    by[r.source] = (by[r.source] ?? 0) + 1;
  }
  return days;
}

/** The overview's recalls: those of the last ACTIVITY_DAYS days that handed something over. */
export interface RecallSummary {
  recalls: number;
  /** Recalls whose session went on to use any of what they handed over. */
  used: number;
  items: number;
  tokens: number;
  byOccasion: Array<{ occasion: RecallOccasion; recalls: number; used: number }>;
  /** Recalls per day, oldest first, the days of the activity chart. */
  days: number[];
}

/** The most recalls the overview reads to sum up; the rest of the period is left out. */
const SUMMARY_RECALLS = 500;

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
  /** Sessions per day by their last activity, the same days. */
  sessionDays: number[];
  recalls: RecallSummary;
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
  /** The recalls made for the session, each with the turn it was made in (0: before the first). */
  recalls: Array<RecallView & { turn: number }>;
}

/** A recall (see docs/architecture.md#recall), with its session and what that session used. */
export interface RecallView extends RecallRecord {
  /** The session it was made for, when known: a hook's, or found from its id (see recallSession). */
  session: { source: string; sessionId: string } | null;
  /** The refs of its items that the session went on to use, as the archive shows so far. */
  used: string[];
}

/** An item of a recall, with what it is now on this store. */
export interface RecallItemView extends RecallItemRecord {
  used: boolean;
  /** The entry, current or not, unless it was forgotten or is not on this store. */
  entry: Entry | null;
  session: SessionRow | null;
  /** Why the item cannot be shown, if it cannot: forgotten here, or unknown to this store. */
  gone: 'forgotten' | 'missing' | null;
}

export interface RecallDetail {
  recall: RecallView;
  /** The prompt it answered, once archived, unless forgotten (prompt recalls only). */
  prompt: EventRow | null;
  items: RecallItemView[];
  /** The session it was made for, when this store has it. */
  sessionRow: SessionRow | null;
  /** What it handed over, rebuilt from the store as it is now (see rebuildRecall). */
  handed: { text: string; missing: string[] };
  /** The other recalls of its session, oldest first. */
  others: RecallView[];
}

/** What the recalls page shows: by agent, occasion, device, time range, and whether it handed anything. */
export interface RecallBoardFilter {
  agents: string[];
  occasions: string[];
  devices: string[];
  range: SessionRange;
  handed: 'some' | 'none' | 'any';
  page: number;
}

export interface RecallRow extends RecallView {
  sessionRow: SessionRow | null;
}

export interface RecallBoard {
  rows: RecallRow[];
  /** Recalls passing the filter. */
  total: number;
  page: number;
  more: boolean;
  ranges: Record<SessionRange, number>;
  facets: {
    agents: FacetValue[];
    occasions: FacetValue[];
    devices: FacetValue[];
    /** Recalls that handed something over, and those that handed nothing. */
    some: number;
    none: number;
  };
  /** The last 30 days, each with its recalls by agent. */
  histogram: BoardDay[];
  since: number | null;
}

/** The other recalls of a session shown on a recall's page. */
const SESSION_RECALLS = 20;

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

/** What the entries page shows: by kind, project, author, origin, recall, time, and text. */
export interface EntryBoardFilter {
  kinds: string[];
  projects: string[];
  /** The agents (or people) that wrote them: an author up to its `@`. */
  authors: string[];
  origin: 'any' | 'imported' | 'written';
  recalled: boolean;
  /** Superseded versions and ended entries too. */
  history: boolean;
  range: SessionRange;
  q: string;
  page: number;
}

export interface EntryBoardRow extends Entry {
  /** The recalls that handed it over. */
  recalls: number;
}

export interface EntryBoard {
  rows: EntryBoardRow[];
  total: number;
  page: number;
  more: boolean;
  ranges: Record<SessionRange, number>;
  facets: {
    kinds: FacetValue[];
    projects: FacetValue[];
    authors: FacetValue[];
    imported: number;
    written: number;
    recalled: number;
  };
}

/** Who wrote an entry, for the entries page: its author up to the `@` of its store. */
export const authorOf = (e: Pick<Entry, 'author'>) => e.author.replace(/@.*$/, '');

export interface EntryDetail {
  entry: Entry;
  sources: EntrySource[];
  history: Entry[];
  /** How often agents were handed the entry (any version), and the latest of those recalls. */
  recalls: { total: number; latest: RecallRow[] };
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
      sessionDays: activity.sessions,
      recalls: this.recallSummary(now, activity.days),
      recent: listSessions(this.db, { limit: 8 }),
      projects: activity.projects,
      latestEntries: listEntries(this.db, { limit: 5 }),
      latestTombstones: listTombstones(this.db, { limit: 5 }),
    };
  }

  private activityCache: { key: string; value: Activity } | null = null;
  private recallCache: { key: string; value: RecallSummary } | null = null;

  /**
   * Events per day over the last ACTIVITY_DAYS days, by source, and the busiest projects then.
   * Days are those of the server's time zone, like the times the pages show. Counting reads an
   * index entry per event of those days, so the result is kept while the day and every source's
   * visible totals stay the same, which an arriving or forgotten event changes.
   */
  private activity(now: number, sources: SourceStats[]): Activity {
    const key = JSON.stringify([
      dayKey(now),
      sources.map((s) => [s.source, s.sessions, s.events, s.firstTs, s.lastTs]),
    ]);
    if (this.activityCache?.key === key) return this.activityCache.value;
    const value = this.countActivity(now);
    this.activityCache = { key, value };
    return value;
  }

  private countActivity(now: number): Activity {
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
    const ended = this.db
      .prepare('SELECT source, ended_at FROM session WHERE event_count > 0 AND ended_at >= ?')
      .all(since) as unknown as Array<{ source: string; ended_at: number }>;
    const position = new Map(days.map((d, i) => [d.day, i]));
    const sessions = days.map(() => 0);
    for (const r of ended) {
      const i = position.get(dayKey(r.ended_at));
      if (i !== undefined) sessions[i] = (sessions[i] ?? 0) + 1;
    }
    return { days, projects, sessions };
  }

  /**
   * The recalls of the chart's days, summed up: how many, by occasion, how many the session went on
   * to use, and per day. Telling what was used reads the session after each recall, so the result
   * is kept while the day, the recalls, and every source's visible totals stay the same.
   */
  private recallSummary(now: number, days: ActivityDay[]): RecallSummary {
    const since = days[0]?.start ?? now;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM recall WHERE at >= ?').get(since) as {
      n: number;
    };
    const key = JSON.stringify([dayKey(now), count.n, this.activityCache?.key ?? '']);
    if (this.recallCache?.key === key) return this.recallCache.value;
    const rows = listRecalls(this.db, { since, limit: SUMMARY_RECALLS });
    const byOccasion = new Map(
      RECALL_OCCASIONS.map((o) => [o, { occasion: o, recalls: 0, used: 0 }]),
    );
    const index = new Map(days.map((d, i) => [d.day, i]));
    const value: RecallSummary = {
      recalls: rows.length,
      used: 0,
      items: 0,
      tokens: 0,
      byOccasion: [...byOccasion.values()],
      days: days.map(() => 0),
    };
    for (const r of rows) {
      const used = usedRefs(this.db, r).size > 0;
      const o = byOccasion.get(r.occasion);
      if (o) {
        o.recalls++;
        if (used) o.used++;
      }
      if (used) value.used++;
      value.items += r.items.length;
      value.tokens += r.tokens;
      const i = index.get(dayKey(r.at));
      if (i !== undefined) value.days[i] = (value.days[i] ?? 0) + 1;
    }
    this.recallCache = { key, value };
    return value;
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

  /**
   * A session as a trace (see pages/session.ts): every turn in an outline, with what it started
   * with, how long it took, its tool calls, failures, and recalls, counted from the session's tool
   * events and recalls alone; and one turn in full, the one asked for, by default the latest, with
   * its steps: its prompt, the recalls made in it, its tool calls grouped by tool, and its reply,
   * each with where it falls in the turn. A turn longer than the budget is shown in parts.
   */
  sessionTrace(
    source: unknown,
    id: unknown,
    opts: { turn?: number; part?: number; at?: string; show?: TraceShow } = {},
  ): SessionTrace {
    const session = this.session(source, id);
    const key = { source: session.source, sessionId: session.sessionId };
    const prompts: TurnStart[] = sessionTurnStarts(this.db, key.source, key.sessionId);
    const first = prompts[0];
    const preamble = first
      ? listSessionEvents(this.db, { ...key, to: first, limit: 1 }).length > 0
      : session.eventCount > 0;
    const lowest = preamble ? 0 : 1;
    const highest = Math.max(lowest, prompts.length);
    const turnOf = (ts: number) => prompts.filter((p) => p.ts <= ts).length;

    // Counted per turn from the session's tool events, without reading their text.
    const tools = new Map<number, { calls: number; failed: number }>();
    const counts = (n: number) => {
      const c = tools.get(n) ?? { calls: 0, failed: 0 };
      tools.set(n, c);
      return c;
    };
    const toolRows = this.db
      .prepare(
        `SELECT e.kind, e.ts, e.meta FROM event e
         WHERE e.source = ? AND e.session_id = ? AND e.kind IN ('tool_use', 'tool_result')
           AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)`,
      )
      .iterate(key.source, key.sessionId) as Iterable<{
      kind: string;
      ts: number;
      meta: string | null;
    }>;
    let toolCalls = 0;
    for (const r of toolRows) {
      const c = counts(turnOf(r.ts));
      if (r.kind === 'tool_use') {
        c.calls++;
        toolCalls++;
      } else if (r.meta && resultStatus({ meta: JSON.parse(r.meta) } as EventRow) === 'error') {
        c.failed++;
      }
    }
    const recalls = this.recallTurns(session, prompts, preamble);
    const recallsIn = (n: number) => recalls.filter((r) => r.turn === n && r.items.length > 0);
    const end = session.endedAt ?? session.startedAt ?? 0;
    const outlineAll: TraceTurn[] = [];
    for (let n = lowest; n <= prompts.length; n++) {
      const start = n === 0 ? (session.startedAt ?? 0) : (prompts[n - 1] as TurnStart).ts;
      const next = prompts[n]?.ts ?? end;
      const p = n === 0 ? null : (prompts[n - 1] as TurnStart);
      const c = tools.get(n) ?? { calls: 0, failed: 0 };
      outlineAll.push({
        number: n,
        label: p ? p.prompt : null,
        command: !!p?.command,
        startedAt: start,
        duration: Math.max(0, next - start),
        tools: c.calls,
        failed: c.failed,
        recalls: recallsIn(n).length,
      });
    }

    const at = opts.at && opts.turn === undefined ? getEvent(this.db, opts.at) : null;
    const atTurn =
      at && at.source === key.source && at.sessionId === key.sessionId ? turnOf(at.ts) : undefined;
    const number = Math.min(Math.max(opts.turn ?? atTurn ?? highest, lowest), highest);
    const part = number === opts.turn ? Math.max(0, opts.part ?? 0) : 0;
    const from = number === 0 ? null : (prompts[number - 1] ?? null);
    const rows = listSessionEvents(this.db, {
      ...key,
      from,
      to: prompts[number] ?? null,
      limit: TURN_EVENT_BUDGET + 1,
      offset: part * TURN_EVENT_BUDGET,
    });
    const continues = rows.length > TURN_EVENT_BUDGET;
    const shown = rows.slice(0, TURN_EVENT_BUDGET);
    const turn =
      part > 0
        ? (groupTurns(shown, [], number + 1)[0] ?? null)
        : (groupTurns(shown, from ? [from] : [], Math.max(number, 1))[0] ?? null);

    const show = opts.show ?? 'all';
    const listed = outlineAll.filter(
      (t) =>
        show === 'all' ||
        t.number === number ||
        (show === 'recalled' ? t.recalls > 0 : t.failed > 0),
    );
    const at0 = Math.max(0, listed.findIndex((t) => t.number === number) - OUTLINE_TURNS / 2);
    const window = listed.slice(at0, at0 + OUTLINE_TURNS);
    const turnRecalls = recallsIn(number);
    return {
      session,
      outline: window,
      earlier: at0 > 0 ? (listed[at0 - 1]?.number ?? null) : null,
      later:
        at0 + OUTLINE_TURNS < listed.length ? (listed[at0 + OUTLINE_TURNS]?.number ?? null) : null,
      total: prompts.length,
      preamble,
      number,
      part,
      continues,
      turn,
      steps: turn ? traceSteps(turn, turnRecalls) : [],
      recalls: turnRecalls.map((r) => ({ ...r, views: this.recall(r.id).items })),
      previous: number > lowest ? number - 1 : null,
      next: number < highest ? number + 1 : null,
      show,
      totals: {
        tools: toolCalls,
        recalls: recalls.filter((r) => r.items.length > 0).length,
        used: recalls.reduce((sum, r) => sum + r.used.length, 0),
        withRecalls: outlineAll.filter((t) => t.recalls > 0).length,
        withFailures: outlineAll.filter((t) => t.failed > 0).length,
      },
    };
  }

  /** The counts the sidebar shows next to its pages. */
  navCounts(): NavCounts {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const entries = entryCounts(this.db);
    return {
      sessions: one('SELECT COUNT(*) AS n FROM session WHERE event_count > 0'),
      recalls: one(
        'SELECT COUNT(*) AS n FROM recall r WHERE EXISTS (SELECT 1 FROM recall_item i WHERE i.recall_id = r.id)',
      ),
      entries: entries.memory + entries.knowledge + entries.cognition,
    };
  }

  /**
   * The sessions page (see pages/browse.ts): a page of sessions under the filters; for each filter,
   * the counts of its values under the other filters, so that it shows what choosing one would
   * give; the count of each time range; and the last 30 days of sessions by agent, for the
   * histogram. Sessions are few enough to filter in memory; the names of untitled sessions are read
   * for the rows shown, and for a name filter.
   */
  sessionBoard(f: SessionBoardFilter, now: number): SessionBoard {
    const all = (
      this.db
        .prepare(
          `SELECT source, session_id, project, title, started_at, ended_at, event_count
           FROM session WHERE event_count > 0`,
        )
        .all() as unknown as BoardSession[]
    ).map((r) => ({ ...r, key: `${r.source}:${r.session_id}` }));
    const recalls = new Map(
      (
        this.db
          .prepare(
            `SELECT r.source || ':' || r.session_id AS key, COUNT(*) AS n FROM recall r
             WHERE r.session_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM recall_item i WHERE i.recall_id = r.id)
             GROUP BY 1`,
          )
          .all() as unknown as Array<{ key: string; n: number }>
      ).map((r) => [r.key, r.n]),
    );
    const named = f.q
      ? new Set(
          listSessions(this.db, { match: f.q, limit: Number.MAX_SAFE_INTEGER }).map(
            (s) => `${s.source}:${s.sessionId}`,
          ),
        )
      : null;
    const since = rangeStart(f.range, now);
    type Row = (typeof all)[number];
    const tests = {
      agent: (r: Row) => f.agents.length === 0 || f.agents.includes(r.source),
      project: (r: Row) =>
        f.projects.length === 0 || (r.project !== null && f.projects.includes(r.project)),
      recall: (r: Row) => !f.recalled || recalls.has(r.key),
      name: (r: Row) => f.name === 'any' || (f.name === 'titled') === (r.title !== null),
      range: (r: Row) => since === null || (r.ended_at ?? 0) >= since,
      q: (r: Row) => named === null || named.has(r.key),
    };
    const passing = (skip?: keyof typeof tests) =>
      all.filter((r) =>
        (Object.keys(tests) as Array<keyof typeof tests>).every((k) => k === skip || tests[k](r)),
      );
    const counted = (rows: Row[], value: (r: Row) => string | null): FacetValue[] => {
      const n = new Map<string, number>();
      for (const r of rows) {
        const v = value(r);
        if (v !== null) n.set(v, (n.get(v) ?? 0) + 1);
      }
      return [...n]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
    };
    const span = (r: Row) => (r.ended_at ?? 0) - (r.started_at ?? 0);
    const matching = passing().sort((a, b) =>
      f.sort === 'events'
        ? b.event_count - a.event_count
        : f.sort === 'duration'
          ? span(b) - span(a)
          : (b.ended_at ?? 0) - (a.ended_at ?? 0),
    );
    const page = Math.max(0, f.page);
    const ranged = passing('range');
    const inRange = (range: SessionRange) => {
      const start = rangeStart(range, now);
      return ranged.filter((r) => start === null || (r.ended_at ?? 0) >= start).length;
    };
    const byName = passing('name');
    return {
      rows: matching.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((r) => ({
        ...(getSession(this.db, r.source, r.session_id) as SessionRow),
        turns: sessionTurnStarts(this.db, r.source, r.session_id).length,
        recalls: recalls.get(r.key) ?? 0,
      })),
      total: matching.length,
      page,
      more: matching.length > (page + 1) * PAGE_SIZE,
      facets: {
        agents: counted(passing('agent'), (r) => r.source),
        projects: counted(passing('project'), (r) => r.project),
        recalled: passing('recall').filter((r) => recalls.has(r.key)).length,
        titled: byName.filter((r) => r.title !== null).length,
        provisional: byName.filter((r) => r.title === null).length,
      },
      ranges: {
        today: inRange('today'),
        '7d': inRange('7d'),
        '30d': inRange('30d'),
        all: inRange('all'),
      },
      histogram: boardHistogram(ranged, now),
      since,
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
      recalls: this.recallTurns(session, prompts, preamble),
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

  /**
   * The recalls of a session, each in its turn: a prompt's in the turn of that prompt, found by its
   * hash, others by their time; one before the first prompt in the turn before it, or the first.
   */
  private recallTurns(
    session: SessionRow,
    prompts: TurnStart[],
    preamble: boolean,
  ): Array<RecallView & { turn: number }> {
    return sessionRecalls(this.db, session.source, session.sessionId).map((r) => {
      const ts = (r.occasion === 'prompt' ? recallPrompt(this.db, r)?.ts : undefined) ?? r.at;
      const turn = prompts.filter((p) => p.ts <= ts).length;
      return { ...this.recallView(r), turn: turn === 0 && !preamble ? 1 : turn };
    });
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

  /**
   * Entries, as a workbench list (see pages/entries.ts): those passing the filter, newest first,
   * with facet counts, the counts of each time range, and how often each was recalled. Entries are
   * few next to events, so they are filtered in memory.
   */
  entryBoard(f: EntryBoardFilter, now: number): EntryBoard {
    const all = listEntries(this.db, {
      includeSuperseded: f.history,
      includeEnded: f.history,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const recalled = new Map(
      (
        this.db
          .prepare(
            `SELECT ref, COUNT(DISTINCT recall_id) AS n FROM recall_item WHERE kind = 'entry' GROUP BY ref`,
          )
          .all() as unknown as Array<{ ref: string; n: number }>
      ).map((r) => [r.ref, r.n]),
    );
    const q = f.q.toLowerCase();
    const since = rangeStart(f.range, now);
    const tests = {
      kind: (e: Entry) => f.kinds.length === 0 || f.kinds.includes(e.kind),
      project: (e: Entry) =>
        f.projects.length === 0 || (e.project !== null && f.projects.includes(e.project)),
      author: (e: Entry) => f.authors.length === 0 || f.authors.includes(authorOf(e)),
      origin: (e: Entry) => f.origin === 'any' || (f.origin === 'imported') === e.imported,
      recalled: (e: Entry) => !f.recalled || recalled.has(e.id),
      range: (e: Entry) => since === null || e.createdAt >= since,
      q: (e: Entry) => q === '' || e.text.toLowerCase().includes(q) || e.id === f.q,
    };
    type Test = keyof typeof tests;
    const passing = (skip?: Test, extra?: (e: Entry) => boolean) =>
      all.filter(
        (e) =>
          (Object.keys(tests) as Test[]).every((k) => k === skip || tests[k](e)) &&
          (!extra || extra(e)),
      );
    const counted = (rows: Entry[], value: (e: Entry) => string | null): FacetValue[] => {
      const n = new Map<string, number>();
      for (const e of rows) {
        const v = value(e);
        if (v !== null) n.set(v, (n.get(v) ?? 0) + 1);
      }
      return [...n]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
    };
    const matching = passing();
    const page = Math.max(0, f.page);
    const shown = matching.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const byOrigin = passing('origin');
    return {
      rows: shown.map((e) => ({ ...e, recalls: recalled.get(e.id) ?? 0 })),
      total: matching.length,
      page,
      more: (page + 1) * PAGE_SIZE < matching.length,
      ranges: Object.fromEntries(
        SESSION_RANGES.map((r) => {
          const start = rangeStart(r, now);
          return [r, passing('range', (e) => start === null || e.createdAt >= start).length];
        }),
      ) as Record<SessionRange, number>,
      facets: {
        kinds: counted(passing('kind'), (e) => e.kind),
        projects: counted(passing('project'), (e) => e.project),
        authors: counted(passing('author'), authorOf),
        imported: byOrigin.filter((e) => e.imported).length,
        written: byOrigin.filter((e) => !e.imported).length,
        recalled: passing('recalled').filter((e) => recalled.has(e.id)).length,
      },
    };
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
    const history = entryHistory(this.db, entryId);
    const versions = new Set(history.map((v) => v.id));
    const handed = recallsWith(this.db, [...versions], ENTRY_RECALLS);
    return {
      entry,
      sources: entrySources(this.db, entryId),
      history,
      recalls: {
        total: handed.total,
        latest: handed.recalls.map((r) => this.recallRow(r, versions)),
      },
    };
  }

  /** A recall as a list shows it: with its session's name, when this store has the session. */
  private recallRow(r: RecallRecord, only?: ReadonlySet<string>): RecallRow {
    const view = this.recallView(r, only);
    return {
      ...view,
      sessionRow: view.session
        ? getSession(this.db, view.session.source, view.session.sessionId)
        : null,
    };
  }

  private recallView(r: RecallRecord, only?: ReadonlySet<string>): RecallView {
    return {
      ...r,
      session: recallSession(this.db, r),
      used: [...usedRefs(this.db, r, only)],
    };
  }

  /**
   * Recalls, as a workbench list (see pages/recalls.ts): those passing the filter, newest first,
   * with facet counts, the counts of each time range, and the last 30 days by agent. Filtering and
   * counting read the recall table alone; only the recalls of the page are read in full, with what
   * their sessions went on to use.
   */
  recallBoard(f: RecallBoardFilter, now: number): RecallBoard {
    type Dim = 'agent' | 'occasion' | 'device' | 'range' | 'handed';
    const where = (skip: Dim | null, range = f.range) => {
      const parts: string[] = [];
      const params: Array<string | number> = [];
      const among = (column: string, values: readonly string[]) => {
        parts.push(`${column} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      };
      if (skip !== 'agent' && f.agents.length > 0) among('r.source', f.agents);
      if (skip !== 'occasion' && f.occasions.length > 0) among('r.occasion', f.occasions);
      if (skip !== 'device' && f.devices.length > 0) among('r.origin', f.devices);
      const since = skip === 'range' ? null : rangeStart(range, now);
      if (since !== null) {
        parts.push('r.at >= ?');
        params.push(since);
      }
      if (skip !== 'handed' && f.handed !== 'any') {
        parts.push(
          `${f.handed === 'none' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM recall_item i WHERE i.recall_id = r.id)`,
        );
      }
      return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params };
    };
    const facet = (column: string, dim: Dim): FacetValue[] => {
      const w = where(dim);
      return (
        this.db
          .prepare(
            `SELECT ${column} AS value, COUNT(*) AS count FROM recall r ${w.sql}
             GROUP BY 1 HAVING value IS NOT NULL ORDER BY count DESC, value`,
          )
          .all(...w.params) as unknown as FacetValue[]
      ).map((v) => ({ value: String(v.value), count: v.count }));
    };
    const handed = where('handed');
    const split = this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM recall_item i WHERE i.recall_id = r.id) AS some, COUNT(*) AS n
         FROM recall r ${handed.sql} GROUP BY 1`,
      )
      .all(...handed.params) as unknown as Array<{ some: number; n: number }>;
    const ranges = Object.fromEntries(
      SESSION_RANGES.map((range) => {
        const w = where(null, range);
        const row = this.db
          .prepare(`SELECT COUNT(*) AS n FROM recall r ${w.sql}`)
          .get(...w.params) as { n: number };
        return [range, row.n];
      }),
    ) as Record<SessionRange, number>;
    const month = where('range');
    const since = rangeStart('30d', now) as number;
    const recent = this.db
      .prepare(
        `SELECT r.source, r.at FROM recall r ${month.sql}${month.sql ? ' AND' : ' WHERE'} r.at >= ?`,
      )
      .all(...month.params, since) as unknown as Array<{ source: string | null; at: number }>;
    const page = Math.max(0, f.page);
    const w = where(null);
    const ids = this.db
      .prepare(`SELECT r.id FROM recall r ${w.sql} ORDER BY r.at DESC, r.seq DESC LIMIT ? OFFSET ?`)
      .all(...w.params, PAGE_SIZE + 1, page * PAGE_SIZE) as unknown as Array<{ id: string }>;
    const rows = ids
      .slice(0, PAGE_SIZE)
      .map((r) => getRecall(this.db, r.id))
      .filter((r): r is RecallRecord => r !== null)
      .map((r) => this.recallRow(r));
    return {
      rows,
      total: ranges[f.range],
      page,
      more: ids.length > PAGE_SIZE,
      ranges,
      facets: {
        agents: facet('r.source', 'agent'),
        occasions: facet('r.occasion', 'occasion'),
        devices: facet('r.origin', 'device'),
        some: split.find((s) => s.some === 1)?.n ?? 0,
        none: split.find((s) => s.some === 0)?.n ?? 0,
      },
      histogram: boardHistogram(
        recent.map((r) => ({ source: r.source ?? '—', ended_at: r.at })),
        now,
      ),
      since: rangeStart(f.range, now),
    };
  }

  /** Recalls, newest first; those that handed nothing over only when asked. */
  recalls(filter: { device?: string; agent?: string; all?: boolean; page?: number }): {
    recalls: RecallView[];
    page: number;
    more: boolean;
    devices: string[];
    agents: string[];
  } {
    const page = Math.max(0, filter.page ?? 0);
    const rows = listRecalls(this.db, {
      origin: filter.device || undefined,
      source: filter.agent || undefined,
      includeEmpty: filter.all === true,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
    });
    return {
      recalls: rows.slice(0, PAGE_SIZE).map((r) => this.recallView(r)),
      page,
      more: rows.length > PAGE_SIZE,
      ...recallFacets(this.db),
    };
  }

  /** One recall, each item with what it is now: what was handed over is read, never stored. */
  recall(id: unknown): RecallDetail {
    const recallId = checkId(id, 'recall id');
    const r = getRecall(this.db, recallId);
    if (!r) throw new HttpError(404, `Unknown recall ${recallId}.`);
    const view = this.recallView(r);
    const used = new Set(view.used);
    return {
      recall: view,
      prompt: r.occasion === 'prompt' ? recallPrompt(this.db, r) : null,
      items: r.items.map((item) => {
        let entry: Entry | null = null;
        let session: SessionRow | null = null;
        let gone: RecallItemView['gone'] = null;
        if (item.kind === 'entry') {
          entry = getEntry(this.db, item.ref);
          if (!entry) gone = isEntryForgotten(this.db, item.ref) ? 'forgotten' : 'missing';
        } else {
          const at = item.ref.indexOf(':');
          session = getSession(this.db, item.ref.slice(0, at), item.ref.slice(at + 1));
          if (!session) gone = 'missing';
        }
        return { ...item, used: used.has(item.ref), entry, session, gone };
      }),
      sessionRow: view.session
        ? getSession(this.db, view.session.source, view.session.sessionId)
        : null,
      handed: (({ text, missing }) => ({ text, missing }))(rebuildRecall(this.db, r)),
      others: view.session
        ? listRecalls(this.db, {
            source: view.session.source,
            sessionId: view.session.sessionId,
            includeEmpty: true,
            limit: SESSION_RECALLS,
          })
            .filter((o) => o.id !== r.id)
            .map((o) => this.recallView(o))
            .sort((a, b) => a.at - b.at)
        : [],
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
