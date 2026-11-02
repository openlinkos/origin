import {
  correct,
  type Database,
  describeSession,
  type Entry,
  type EventRow,
  entryHistory,
  entrySources,
  eventContext,
  findSession,
  firstLine,
  forget,
  getEntry,
  getEvent,
  getRecall,
  getSession,
  isEntryForgotten,
  isEntryId,
  isEventForgotten,
  isoLocal,
  listEntries,
  listSessions,
  NEIGHBOUR_MAX,
  OriginError,
  parseTime,
  planRecall,
  type RecallItemRecord,
  rawLocator,
  readRawLine,
  readSession,
  rebuildRecall,
  recallScope,
  recallSession,
  recallText,
  recordRecall,
  relatedEntries,
  remember,
  resolveId,
  type SessionRow,
  searchEntries,
  searchEvents,
  sessionKey,
  sessionNames,
  stubText,
  usedRefs,
} from '@openlinkos/origin-core';
import type { ToolArgs } from './tools.js';

/**
 * The eight tools against one store, returning plain JSON values (see docs/architecture.md#mcp-server).
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
  /** The title of the event's session, or its first prompt (absent from older hubs). */
  session_title?: string | null;
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

/** The events of one session, a page at a time (see timelineOf). */
export interface SessionEvents {
  session: string;
  /** The session's title and first prompt, as in SessionView (absent from older hubs). */
  title?: string | null;
  prompt?: string | null;
  events: EventView[];
  /** How many visible events of the range asked for follow the last one (absent from older hubs). */
  more?: number;
}

export type TimelineResult = { sessions: SessionView[] } | SessionEvents;

/**
 * Stubs: what a card shows of its neighbours, one line each, by id (see
 * docs/architecture.md#reading-along-references). `get` opens any of them.
 */

/** An entry in one line: its first line, cut short. */
export interface EntryStub {
  id: string;
  kind: string;
  text: string;
  created: string;
}

/** An event in one line: its text on one line, cut short. */
export interface EventStub {
  id: string;
  time: string;
  role: string;
  kind: string;
  text: string;
}

/** Where a turn of a session starts: its prompt, or the command the agent acted on. */
export interface PromptStub {
  turn: number;
  id: string;
  time: string;
  text: string;
}

/** A recall a session was handed, in one line: `get` opens it. */
export interface RecallStub {
  id: string;
  occasion: string;
  time: string;
  /** How many of its items are still visible. */
  items: number;
}

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
  /** The title of the event's session, or its first prompt (absent from older hubs). */
  session_title?: string | null;
}

export interface EntryResult {
  entry: EntryView;
  sources: SourceOfEntry[];
  /** Every version of the entry, oldest first, forks included. */
  history: VersionView[];
  /**
   * Other current entries that cite an event this one cites, or another event of a session it
   * cites (a memory file's version is no session), newest first (absent from older hubs).
   */
  related?: EntryStub[];
  origin?: Found;
}

export interface EventResult extends EventView {
  cwd: string | null;
  git_branch: string | null;
  agent_version: string | null;
  /** The fields below are absent from older hubs. */
  session_title?: string | null;
  /** Where `text` starts in the event's text, in UTF-16 code units, and the length of all of it. */
  offset?: number;
  total_chars?: number;
  /** The offset of the next page of the text, or null when this page reaches its end. */
  next_offset?: number | null;
  /**
   * What is next to the event, on its first page only (offset 0): its turn and that turn's
   * prompt, the event it follows, the events around it, and the current entries that cite it.
   */
  turn?: { number: number; prompt: EventStub } | null;
  replies_to?: EventStub | null;
  around?: { before: EventStub[]; after: EventStub[] };
  cited_by?: EntryStub[];
}

/** A session as a card: what it is, and what is next to it (see sessionResult). */
export interface SessionResult extends SessionView {
  cwd: string | null;
  turns: number;
  prompts: PromptStub[];
  /** How many turns follow those in `prompts`. */
  more_prompts: number;
  entries: EntryStub[];
  recalls: RecallStub[];
  before: SessionView | null;
  after: SessionView | null;
}

/** One item a recall handed over. */
export interface RecallItemView {
  rank: number;
  layer: string;
  kind: 'entry' | 'session';
  /** An entry id, or a session id, with the session's `source`. */
  id: string;
  source?: string;
  score: number | null;
  /** Whether the session went on to use it; null while the recall's session is not known. */
  used: boolean | null;
}

/** A recall, and the text it handed over as the store rebuilds it now (see recallResult). */
export interface RecallResult {
  id: string;
  time: string;
  occasion: string;
  agent: string | null;
  session: string | null;
  device: string;
  project: string | null;
  directory: string | null;
  budget: number;
  tokens: number;
  items: RecallItemView[];
  text: string;
  origin?: Found;
}

export type GetResult = EntryResult | EventResult | SessionResult | RecallResult;

export function isEntryResult(r: GetResult): r is EntryResult {
  return 'entry' in r;
}

export function isSessionResult(r: GetResult): r is SessionResult {
  return 'turns' in r;
}

export function isRecallResult(r: GetResult): r is RecallResult {
  return 'occasion' in r && 'items' in r;
}

export function isEventResult(r: GetResult): r is EventResult {
  return !isEntryResult(r) && !isSessionResult(r) && !isRecallResult(r);
}

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

export function entryStub(e: Entry): EntryStub {
  return {
    id: e.id,
    kind: e.kind,
    text: stubText(firstLine(e.text)),
    created: isoLocal(e.createdAt),
  };
}

export function eventStub(e: Pick<EventRow, 'id' | 'ts' | 'role' | 'kind' | 'text'>): EventStub {
  return { id: e.id, time: isoLocal(e.ts), role: e.role, kind: e.kind, text: stubText(e.text) };
}

export function sessionView(s: SessionRow): SessionView {
  return {
    session: s.sessionId,
    source: s.source,
    project: s.project,
    title: s.title,
    prompt: s.prompt,
    started: s.startedAt === null ? null : isoLocal(s.startedAt),
    ended: s.endedAt === null ? null : isoLocal(s.endedAt),
    events: s.eventCount,
  };
}

/** A session's name: its title, or its first prompt. */
const nameOf = (s: SessionRow | null): string | null => (s ? (s.title ?? s.prompt) : null);

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
  // Each hit names its session; the names of the page's sessions are looked up together.
  const names = sessionNames(db, events);
  return {
    entries: entries.map(entryView),
    events: events.map((h) => ({
      ...eventView(h, 400),
      snippet: h.snippet,
      session_title: names.get(sessionKey(h.source, h.sessionId)) ?? null,
    })),
  };
}

export function timelineOf(db: Database, args: ToolArgs<'timeline'>): TimelineResult {
  if (args.session) {
    const session = findSession(db, args.session, args.source);
    if (!session) return { session: args.session, title: null, prompt: null, events: [], more: 0 };
    const page = readSession(db, {
      source: session.source,
      sessionId: session.sessionId,
      kinds: args.include_tools ? undefined : ['message'],
      turn: args.turn,
      after: args.after,
      limit: args.limit,
    });
    return {
      session: args.session,
      title: session.title,
      prompt: session.prompt,
      events: page.events.map((e) => eventView(e, 1000)),
      more: page.more,
    };
  }
  const sessions = listSessions(db, {
    since: parseTime(args.since ?? '7d'),
    until: optionalTime(args.until),
    source: args.source,
    project: args.project,
    limit: args.limit,
  });
  return { sessions: sessions.map(sessionView) };
}

/** An event's text is read in pages of this many UTF-16 code units. */
export const EVENT_PAGE = 20_000;

/**
 * Open any id (see docs/architecture.md, "Reading along references"): an entry, a recall, an
 * event, or a session, each with what is next to it. `source` picks the session when two sources
 * have one of that id; `offset` is where an event's text starts, to read a long one in pages.
 */
export function getById(
  db: Database,
  args: { id: string; source?: string; offset?: number },
): GetResult {
  const opened = resolveId(db, args.id, args.source);
  if (!opened) missing(db, args.id);
  switch (opened.kind) {
    case 'entry':
      return entryResult(db, opened.id);
    case 'recall':
      return recallResult(db, opened.id);
    case 'event':
      return eventResult(db, opened.id, args.offset ?? 0);
    case 'session':
      return sessionResult(db, opened.session);
    case 'thread':
      // Threads open as cards once the MCP tools know them; until then, as before, an unknown id.
      return missing(db, args.id);
  }
}

function entryResult(db: Database, id: string): EntryResult {
  const entry = getEntry(db, id);
  if (!entry) missing(db, id);
  const sources = entrySources(db, entry.id);
  const names = sessionNames(
    db,
    sources.map((s) => s.event),
  );
  return {
    entry: entryView(entry),
    sources: sources.map((s) => ({
      quote: s.quote,
      ...eventView(s.event, 500),
      session_title: names.get(sessionKey(s.event.source, s.event.sessionId)) ?? null,
    })),
    history: entryHistory(db, entry.id).map((v) => ({
      id: v.id,
      supersedes: v.supersedes,
      author: v.author,
      created: isoLocal(v.createdAt),
      status: v.status,
    })),
    related: relatedEntries(db, entry.id, NEIGHBOUR_MAX).map(entryStub),
  };
}

function eventResult(db: Database, id: string, offset: number): EventResult {
  const event = getEvent(db, id);
  if (!event) missing(db, id);
  const total = event.text.length;
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(start + EVENT_PAGE, total);
  const result: EventResult = {
    ...eventView(event, EVENT_PAGE),
    text: clip(event.text.slice(start), EVENT_PAGE),
    cwd: event.cwd,
    git_branch: event.gitBranch,
    agent_version: event.agentVersion,
    session_title: null,
    offset: start,
    total_chars: total,
    next_offset: end < total ? end : null,
  };
  // Later pages of a long text carry only the text: its neighbours came with the first.
  if (start > 0) {
    result.session_title = nameOf(getSession(db, event.source, event.sessionId));
    return result;
  }
  const ctx = eventContext(db, event);
  result.session_title = nameOf(ctx.session);
  result.turn = ctx.turn && {
    number: ctx.turn.number,
    prompt: eventStub({
      id: ctx.turn.start.id,
      ts: ctx.turn.start.ts,
      role: 'user',
      kind: 'message',
      text: ctx.turn.start.prompt,
    }),
  };
  result.replies_to = ctx.repliesTo && eventStub(ctx.repliesTo);
  result.around = { before: ctx.before.map(eventStub), after: ctx.after.map(eventStub) };
  result.cited_by = ctx.citedBy.map(entryStub);
  return result;
}

/** A session's card: what it is, its turns, the entries written from it, its recalls, its neighbours. */
export function sessionResult(db: Database, session: SessionRow): SessionResult {
  const card = describeSession(db, session);
  const view = sessionView(session);
  return {
    session: view.session,
    source: view.source,
    project: view.project,
    cwd: session.cwd,
    title: view.title,
    prompt: view.prompt,
    started: view.started,
    ended: view.ended,
    events: view.events,
    turns: card.turns,
    prompts: card.prompts.map((p) => ({
      turn: p.turn,
      id: p.id,
      time: isoLocal(p.ts),
      text: p.prompt,
    })),
    more_prompts: card.morePrompts,
    entries: card.entries.map(entryStub),
    recalls: card.recalls.map(({ recall, items }) => ({
      id: recall.id,
      occasion: recall.occasion,
      time: isoLocal(recall.at),
      items,
    })),
    before: card.before && sessionView(card.before),
    after: card.after && sessionView(card.after),
  };
}

/**
 * A recall: what it was made for, its items, whether its session went on to use each, and the text
 * it handed over, rebuilt from the store as it is now. What was forgotten since is left out of both
 * (invariant 2), so a rank may be missing from the items.
 */
function recallResult(db: Database, id: string): RecallResult {
  const recall = getRecall(db, id);
  if (!recall) missing(db, id);
  const rebuilt = rebuildRecall(db, recall);
  const session = recallSession(db, recall);
  const used = session ? usedRefs(db, recall) : null;
  const item = (i: RecallItemRecord): RecallItemView => {
    const at = i.kind === 'session' ? i.ref.indexOf(':') : -1;
    return {
      rank: i.rank,
      layer: i.layer,
      kind: i.kind,
      id: at < 0 ? i.ref : i.ref.slice(at + 1),
      ...(at < 0 ? {} : { source: i.ref.slice(0, at) }),
      score: i.score,
      used: used ? used.has(i.ref) : null,
    };
  };
  return {
    id: recall.id,
    time: isoLocal(recall.at),
    occasion: recall.occasion,
    agent: recall.source,
    session: session?.sessionId ?? null,
    device: recall.origin,
    project: recall.project,
    directory: recall.cwd,
    budget: recall.budget,
    tokens: recall.tokens,
    items: recall.items.filter((i) => rebuilt.lines.has(i.ref)).map(item),
    text: rebuilt.text,
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

export interface BriefResult {
  /** The recall's id: what it handed over is recorded (see docs/architecture.md#recall). */
  recall: string;
  /** One line per item, as an agent's hook is handed them. */
  text: string;
}

/** The agents Origin reads, by source id. */
const AGENT_SOURCES = ['claude-code', 'codex', 'cursor', 'grok', 'zcode'];
/** What MCP clients add to an agent's name, such as `codex-mcp-client`. */
const CLIENT_SUFFIX = /[-_ ](?:mcp[-_ ]client|client|cli|vscode|desktop|app)$/;

/** The source id of the agent behind an MCP client's name, or the name itself. */
export function sourceOfAgent(name: string): string {
  const base = name.toLowerCase().replace(CLIENT_SUFFIX, '');
  return AGENT_SOURCES.includes(base) ? base : name;
}

/**
 * The brief an agent asks for, recorded as a recall made for its device. `here` is the directory
 * the server runs in on the agent's machine, whose disk it can read; a hub has none, and takes the
 * agent's `cwd` as it is. `author` is `<agent>@<device>`.
 */
export function briefIn(
  db: Database,
  args: ToolArgs<'brief'>,
  author: string,
  here: string | null,
): BriefResult {
  const dir = args.cwd?.trim() || here;
  if (!dir) {
    throw new OriginError(
      'Pass `cwd`, your working directory: the hub cannot tell where you work.',
    );
  }
  const at = author.lastIndexOf('@');
  const plan = planRecall(db, {
    occasion: 'request',
    source: sourceOfAgent(at < 0 ? author : author.slice(0, at)),
    prompt: args.about ?? null,
    ...recallScope(dir, { onDisk: here !== null }),
  });
  const recall = recordRecall(db, plan, { origin: at < 0 ? undefined : author.slice(at + 1) });
  const where = plan.project ? `project ${plan.project}` : 'this directory';
  return {
    recall,
    text:
      recallText(plan, recall) ||
      `Origin recall ${recall}: the user's memory holds nothing for ${where} yet.`,
  };
}
