import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  type AdminSessionInfo,
  type AuditRecord,
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
  type ForgetResult,
  forget,
  getEntry,
  getEvent,
  getSession,
  type IngestHealth,
  ingestHealth,
  isEntryForgotten,
  isEventForgotten,
  listAdminSessions,
  listAudit,
  listDevices,
  listEntries,
  listEvents,
  listProjects,
  listSessions,
  listTokens,
  listTombstones,
  OriginError,
  planForget,
  rawDir,
  rawLocator,
  readRawLine,
  recordAudit,
  remember,
  revokeToken,
  type SearchHit,
  type SessionRow,
  type SourceStats,
  type StoreUsage,
  searchEntries,
  searchEvents,
  stats,
  storeName,
  storeUsage,
  type TokenInfo,
  type TombstoneSummary,
  tombstoneCount,
} from '@openlinkos/origin-core';
import { HttpError } from './http.js';

/** Raw lines are shown truncated to this many characters. */
export const RAW_LINE_MAX = 4000;
/** A device that has sent nothing for this long is flagged on the overview. */
export const STALE_DEVICE_MS = 24 * 3_600_000;
export const PAGE_SIZE = 50;

/** Who is acting, for the audit log. */
export interface Actor {
  /** `owner` once signed in, `anonymous` before. */
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
  sources: SourceStats[];
  devices: DeviceSummary[];
  usage: StoreUsage;
  parseErrors: { last24h: number; last7d: number; bySource7d: IngestHealth[] };
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

export interface Snippets {
  hubUrl: string;
  /** False when no public URL is configured and the URL is a placeholder. */
  known: boolean;
  device: string;
  claude: string;
  codex: string;
  cron: string;
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
    device: `origin hub connect ${hubUrl} --token ${token} --device ${device}\norigin sync`,
    claude: `claude mcp add --scope user --transport http origin ${hubUrl}/mcp --header "Authorization: Bearer ${token}"`,
    codex: `export ORIGIN_TOKEN=${token}\ncodex mcp add origin --url ${hubUrl}/mcp --bearer-token-env-var ORIGIN_TOKEN`,
    cron: '*/10 * * * * origin sync',
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
    },
  ) {}

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

  overview(now: number): Overview {
    const sources = stats(this.db);
    const entries = entryCounts(this.db);
    const devices = this.devices(now);
    const week = ingestHealth(this.db, { since: now - 7 * 86_400_000 });
    const day = ingestHealth(this.db, { since: now - 86_400_000 });
    const sum = (rows: IngestHealth[]) => rows.reduce((n, r) => n + r.parseErrors, 0);
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
      sources,
      devices,
      usage: storeUsage(this.db, this.o.home),
      parseErrors: {
        last24h: sum(day),
        last7d: sum(week),
        bySource7d: week.filter((r) => r.parseErrors > 0),
      },
    };
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

  sessions(filter: { source?: string; project?: string; since?: number; page?: number }): {
    sessions: SessionRow[];
    page: number;
    more: boolean;
  } {
    const page = Math.max(0, filter.page ?? 0);
    const rows = listSessions(this.db, {
      source: filter.source || undefined,
      project: filter.project || undefined,
      since: filter.since,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
    });
    return { sessions: rows.slice(0, PAGE_SIZE), page, more: rows.length > PAGE_SIZE };
  }

  sessionEvents(
    source: unknown,
    id: unknown,
    opts: { tools?: boolean; page?: number } = {},
  ): { session: SessionRow; events: EventRow[]; page: number; more: boolean } {
    const src = checkId(source, 'source');
    const sessionId = checkId(id, 'session id');
    const session = getSession(this.db, src, sessionId);
    if (!session) throw new HttpError(404, `Unknown session ${sessionId}.`);
    const page = Math.max(0, opts.page ?? 0);
    const size = 200;
    const rows = listEvents(this.db, {
      source: src,
      sessionId,
      kinds: opts.tools ? undefined : ['message', 'meta'],
      limit: size + 1,
      offset: page * size,
    });
    return { session, events: rows.slice(0, size), page, more: rows.length > size };
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
    const line = loc ? readRawLine(loc) : null;
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
   * Forget an entry or event (invariant 2). The caller confirms by repeating the id and by sending
   * the digest of the plan it showed; if the plan has changed since, nothing happens (409).
   */
  forget(
    who: Actor,
    input: { id: unknown; digest: unknown; confirm: unknown; reason?: unknown },
  ): ForgetResult {
    const id = checkId(input.id);
    if (typeof input.confirm !== 'string' || input.confirm.trim() !== id) {
      throw new OriginError('To confirm, type the id exactly as shown.');
    }
    const plan = planForget(this.db, id);
    if (plan.entries.length === 0 && plan.events.length === 0) {
      throw new OriginError(`${id} has already been forgotten.`);
    }
    if (input.digest !== planDigest(plan)) {
      throw new HttpError(409, 'What would be forgotten has changed. Review the plan again.');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim().slice(0, 500)
        : undefined;
    const result = forget(this.db, id, reason);
    // Ids and counts only: the audit log must never keep forgotten text.
    this.audit(who, 'forget', id, {
      targetType: result.targetType,
      tombstoneId: result.tombstoneId,
      entries: result.entries.length,
      events: result.events.length,
    });
    return result;
  }

  /** Remember an entry citing one event, as the owner (author `user`). */
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
