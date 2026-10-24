import {
  correct,
  type Database,
  type Entry,
  type EventRow,
  entryHistory,
  entrySources,
  forget,
  getEntry,
  getEvent,
  isEntryForgotten,
  isEntryId,
  isEventForgotten,
  isoLocal,
  listEntries,
  listEvents,
  listSessions,
  OriginError,
  parseTime,
  rawLocator,
  readRawLine,
  remember,
  searchEntries,
  searchEvents,
} from '@openlinkos/origin-core';
import type { ToolArgs } from './tools.js';

/**
 * The seven tools against one store, returning plain JSON values (see docs/architecture.md#mcp-server).
 * Caller errors (bad input, unknown or forgotten ids) are thrown as OriginError. The servers wrap
 * these: the local ones as they are, a connected device's merged with its hub's answers.
 */

/** Where a result was found, on a device connected to a hub. */
export type Found = 'local' | 'hub';

export interface EntryView {
  id: string;
  kind: string;
  text: string;
  confidence: number;
  status: string;
  /** Superseded by a concurrent correction rather than a correction of this version. */
  concurrent: boolean;
  project: string | null;
  author: string;
  created: string;
  valid_from: string | null;
  valid_to: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  /** The first version of the entry; all its versions share it. */
  root: string;
  /**
   * Derived from an agent's own memory file, which a later version of the file supersedes (absent
   * from hubs older than 0.3).
   */
  imported?: boolean;
  origin?: Found;
}

export interface EventView {
  id: string;
  time: string;
  source: string;
  project: string | null;
  session: string;
  role: string;
  kind: string;
  text: string;
  origin?: Found;
}

export interface SearchHitView extends EventView {
  snippet: string;
}

export interface SearchResult {
  entries: EntryView[];
  events: SearchHitView[];
}

export interface SessionView {
  session: string;
  source: string;
  project: string | null;
  title: string | null;
  /**
   * For a session without a title, its first prompt, cut short: a provisional name. A hub of an
   * earlier version leaves it out.
   */
  prompt?: string | null;
  started: string | null;
  ended: string | null;
  events: number;
  origin?: Found;
}

export type TimelineResult = { sessions: SessionView[] } | { session: string; events: EventView[] };

/** One version in an entry's history: enough to tell the chain's shape and its current version. */
export interface VersionView {
  id: string;
  supersedes: string | null;
  author: string;
  created: string;
  status: string;
}

export interface SourceOfEntry extends EventView {
  quote: string | null;
}

export interface EntryResult {
  entry: EntryView;
  sources: SourceOfEntry[];
  /** Every version of the entry, oldest first, forks included. */
  history: VersionView[];
  origin?: Found;
}

export interface EventResult extends EventView {
  cwd: string | null;
  git_branch: string | null;
  agent_version: string | null;
}

export type GetResult = EntryResult | EventResult;

export interface SourceView {
  event_id: string;
  time: string;
  quote: string | null;
  original_file: string | null;
  mirror_file: string | null;
  line: number | null;
  raw: string | null;
  origin?: Found;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

export function eventView(e: EventRow, maxText: number): EventView {
  return {
    id: e.id,
    time: isoLocal(e.ts),
    source: e.source,
    project: e.project,
    session: e.sessionId,
    role: e.role,
    kind: e.kind,
    text: clip(e.text, maxText),
  };
}

export function entryView(e: Entry): EntryView {
  return {
    id: e.id,
    kind: e.kind,
    text: e.text,
    confidence: e.confidence,
    status: e.status,
    concurrent: e.concurrent,
    project: e.project,
    author: e.author,
    created: isoLocal(e.createdAt),
    valid_from: e.validFrom === null ? null : isoLocal(e.validFrom),
    valid_to: e.validTo === null ? null : isoLocal(e.validTo),
    supersedes: e.supersedes,
    superseded_by: e.supersededBy,
    root: e.root,
    imported: e.imported,
  };
}

const optionalTime = (v: string | undefined) => (v === undefined ? undefined : parseTime(v));

/** Whether an id is an entry or event of this store that has been forgotten. */
export function isForgotten(db: Database, id: string): boolean {
  return isEntryForgotten(db, id) || isEventForgotten(db, id);
}

/** Whether an entry or event with this id is in this store, visible or not. */
export function isKnown(db: Database, id: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM entry WHERE id = ? UNION ALL SELECT 1 FROM event WHERE id = ?')
      .get(id, id) !== undefined
  );
}

function missing(db: Database, id: string): never {
  throw new OriginError(
    isForgotten(db, id) ? `${id} has been forgotten.` : `Unknown entry or event ${id}.`,
  );
}

export function searchStore(db: Database, args: ToolArgs<'search'>): SearchResult {
  const since = optionalTime(args.since);
  const until = optionalTime(args.until);
  const query = args.query?.trim() ?? '';
  const entryFilter = { kind: args.kind, project: args.project, since, until, limit: args.limit };
  const entries =
    args.scope === 'events'
      ? []
      : query
        ? searchEntries(db, query, entryFilter)
        : listEntries(db, entryFilter);
  const events =
    args.scope === 'entries' || !query
      ? []
      : searchEvents(db, query, {
          since,
          until,
          source: args.source,
          project: args.project,
          kinds: args.include_tools ? undefined : ['message'],
          limit: args.limit,
        });
  return {
    entries: entries.map(entryView),
    events: events.map((h) => ({ ...eventView(h, 400), snippet: h.snippet })),
  };
}

export function timelineOf(db: Database, args: ToolArgs<'timeline'>): TimelineResult {
  if (args.session) {
    const events = listEvents(db, {
      sessionId: args.session,
      source: args.source,
      kinds: args.include_tools ? undefined : ['message'],
      limit: args.limit,
    });
    return { session: args.session, events: events.map((e) => eventView(e, 1000)) };
  }
  const sessions = listSessions(db, {
    since: parseTime(args.since ?? '7d'),
    until: optionalTime(args.until),
    source: args.source,
    project: args.project,
    limit: args.limit,
  });
  return {
    sessions: sessions.map((s) => ({
      session: s.sessionId,
      source: s.source,
      project: s.project,
      title: s.title,
      prompt: s.prompt,
      started: s.startedAt === null ? null : isoLocal(s.startedAt),
      ended: s.endedAt === null ? null : isoLocal(s.endedAt),
      events: s.eventCount,
    })),
  };
}

export function getById(db: Database, id: string): GetResult {
  if (isEntryId(id)) {
    const entry = getEntry(db, id);
    if (!entry) missing(db, id);
    return {
      entry: entryView(entry),
      sources: entrySources(db, entry.id).map((s) => ({
        quote: s.quote,
        ...eventView(s.event, 500),
      })),
      history: entryHistory(db, entry.id).map((v) => ({
        id: v.id,
        supersedes: v.supersedes,
        author: v.author,
        created: isoLocal(v.createdAt),
        status: v.status,
      })),
    };
  }
  const event = getEvent(db, id);
  if (!event) missing(db, id);
  return {
    ...eventView(event, 20_000),
    cwd: event.cwd,
    git_branch: event.gitBranch,
    agent_version: event.agentVersion,
  };
}

export function sourcesOf(db: Database, home: string, id: string): SourceView[] {
  let cited: Array<{ quote: string | null; event: EventRow }>;
  if (isEntryId(id)) {
    if (!getEntry(db, id)) missing(db, id);
    cited = entrySources(db, id);
  } else {
    const event = getEvent(db, id);
    if (!event) missing(db, id);
    cited = [{ quote: null, event }];
  }
  return cited.map(({ quote, event }) => {
    const loc = rawLocator(db, home, event);
    const raw = loc ? readRawLine(db, home, loc) : null;
    return {
      event_id: event.id,
      time: isoLocal(event.ts),
      quote,
      original_file: loc?.originalPath ?? null,
      mirror_file: loc?.mirrorPath ?? null,
      line: loc?.line ?? null,
      raw: raw === null ? null : clip(raw, 4000),
    };
  });
}

export function rememberIn(db: Database, args: ToolArgs<'remember'>, author: string) {
  const entry = remember(db, {
    kind: args.kind,
    text: args.text,
    confidence: args.confidence,
    author,
    project: args.project ?? null,
    validFrom: optionalTime(args.valid_from) ?? null,
    validTo: optionalTime(args.valid_to) ?? null,
    sources: args.sources.map((s) => ({ eventId: s.event_id, quote: s.quote })),
  });
  return { entry: entryView(entry) };
}

export function correctIn(db: Database, args: ToolArgs<'correct'>, author: string) {
  const entry = correct(db, args.id, {
    text: args.text,
    author,
    kind: args.kind,
    confidence: args.confidence,
    validFrom: optionalTime(args.valid_from),
    validTo: optionalTime(args.valid_to),
    sources: args.sources?.map((s) => ({ eventId: s.event_id, quote: s.quote })),
  });
  return { entry: entryView(entry) };
}

export function forgetIn(db: Database, args: ToolArgs<'forget'>, author: string) {
  const r = forget(db, args.id, { reason: args.reason, author });
  return {
    tombstone: r.tombstoneId,
    forgotten_entries: r.entries,
    excluded_events: r.events.length,
  };
}
