import { randomBytes } from 'node:crypto';
import {
  type Author,
  changesSince,
  childSessions,
  correct,
  type Database,
  describeProposal,
  describeSession,
  describeThread,
  digest,
  displayTitle,
  type Entry,
  type EventRow,
  encodeFeedCursor,
  entryHistory,
  entrySources,
  eventContext,
  findSession,
  firstLine,
  followTarget,
  forget,
  getEntry,
  getEvent,
  getRecall,
  getSession,
  getSessionParent,
  hasAuthor,
  isEntryForgotten,
  isEntryId,
  isEventForgotten,
  isoIn,
  isoLocal,
  isProposalId,
  listEntries,
  listSessions,
  NEIGHBOUR_MAX,
  OriginError,
  type Proposal,
  type ProposalJson,
  parseFeedCursor,
  parseTime,
  planRecall,
  prepareProposal,
  proposalError,
  proposalJson,
  type RecallItemKind,
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
  sessionFold,
  sessionKey,
  sessionNames,
  stubText,
  type TurnStart,
  usedRefs,
} from '@openlinkos/origin-core';
import type { ToolArgs } from './tools.js';

/**
 * The twelve tools against one store, returning plain JSON values (see docs/architecture.md#mcp-server).
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

/**
 * Who wrote an input that the user did not (see authors.ts in core): `person`, `agent`, or
 * `system`, and the speaker its source named, when it named one. The user's own messages, and
 * events that are no input, carry neither, so results read as they always have for them.
 */
export interface WrittenBy {
  by?: 'person' | 'agent' | 'system';
  speaker?: string;
}

export interface EventView extends WrittenBy {
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
  /** `<source>:<session id>` of the session's parent, when it has one. */
  parent?: string;
  /** The parent's title, as it is shown (absent when `parent` is). */
  parent_title?: string | null;
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
  /** The thread the session is in with others, or null (absent from older hubs). */
  thread?: string | null;
  /**
   * How many child sessions this one has. On a timeline, which lists top-level sessions unless
   * `include_children` is set (absent from older hubs).
   */
  children?: number;
  /** Distinct workflow names among those children (absent from older hubs). */
  workflows?: string[];
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
export interface EventStub extends WrittenBy {
  id: string;
  time: string;
  role: string;
  kind: string;
  text: string;
}

/** Where a turn of a session starts: its prompt, or the command the agent acted on. */
export interface PromptStub extends WrittenBy {
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

/** One child of a session, as `get` lists it: one line, grouped by `group`. */
export interface SessionChild {
  /** The workflow run's group, or null when the child is not in one. */
  group: string | null;
  via: string;
  source: string;
  session: string;
  /** The name it is shown under (see displayTitle). */
  title: string | null;
}

/** A session as a card: what it is, and what is next to it (see sessionResult). */
export interface SessionResult extends Omit<SessionView, 'thread' | 'children'> {
  cwd: string | null;
  turns: number;
  prompts: PromptStub[];
  /** How many turns follow those in `prompts`. */
  more_prompts: number;
  /** The thread it is in with other sessions, and how many sessions it has (absent from older hubs). */
  thread?: { id: string; sessions: number } | null;
  entries: EntryStub[];
  recalls: RecallStub[];
  before: SessionView | null;
  after: SessionView | null;
  /** The session this one is a child of, when it has a parent. */
  parent?: { source: string; session: string; title: string | null };
  /** Its children, one line each, ordered so one run group stays together. */
  children?: SessionChild[];
}

/** A thread as a card: what it is, its sessions, and what was written from them (see threadResult). */
export interface ThreadResult {
  thread: string;
  project: string | null;
  /** Its root's title, or the root's first prompt. */
  title: string | null;
  started: string | null;
  ended: string | null;
  /** Its first sessions, oldest first. */
  sessions: SessionView[];
  /** How many sessions follow those. */
  more_sessions: number;
  agents: string[];
  branches: string[];
  entries: EntryStub[];
  /** The latest prompt of its most recent session that has one. */
  last_prompt: (EventStub & { session: string }) | null;
  origin?: Found;
}

/** One item a recall handed over. */
export interface RecallItemView {
  rank: number;
  layer: string;
  kind: RecallItemKind;
  /** An entry id, a thread id, an event id (a past message), or a session id, with its `source`. */
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

/**
 * A proposal, as a card: what it proposes, where it stands, the events it cites, the session that
 * made it, and the entry it became once accepted (see proposalResult). Its id is under `id`, never
 * under `proposal`: only the result of `propose` holds `"proposal": "prp_…"`, which ingestion reads.
 */
export interface ProposalResult {
  id: string;
  status: 'pending' | 'accepted';
  kind: string;
  text: string;
  confidence: number;
  /** The project it names, or null; it belongs to its session's project then. */
  project: string | null;
  valid_from: string | null;
  valid_to: string | null;
  note: string | null;
  /** When it was proposed, and by which agent. */
  time: string;
  agent: string;
  /** The session that made it, and the tool result it was read from. */
  session: SessionView | null;
  event: string;
  /** The events it cites, with their quotes and sessions. */
  sources: Array<EventStub & { quote: string | null; session: string }>;
  /** How many of the events it cites this store does not have (yet). */
  missing_sources: number;
  /** The entry it became, once accepted: its current version. */
  accepted_as: EntryStub | null;
  origin?: Found;
}

/** A proposal in one line, as `changes` lists it: `get` opens it. */
export interface ProposalStub {
  id: string;
  kind: string;
  text: string;
  status: 'pending' | 'accepted';
  time: string;
  /** The session that made it, and the tool result it was read from. */
  session: string;
  event: string;
  /** The project it belongs to: the one it names, or its session's. */
  project: string | null;
}

export type GetResult =
  | EntryResult
  | EventResult
  | SessionResult
  | ThreadResult
  | RecallResult
  | ProposalResult;

export function isEntryResult(r: GetResult): r is EntryResult {
  return 'entry' in r;
}

export function isThreadResult(r: GetResult): r is ThreadResult {
  return 'more_sessions' in r;
}

export function isSessionResult(r: GetResult): r is SessionResult {
  return 'turns' in r;
}

export function isRecallResult(r: GetResult): r is RecallResult {
  return 'occasion' in r && 'items' in r;
}

export function isProposalResult(r: GetResult): r is ProposalResult {
  return 'accepted_as' in r;
}

export function isEventResult(r: GetResult): r is EventResult {
  return (
    !isEntryResult(r) &&
    !isSessionResult(r) &&
    !isThreadResult(r) &&
    !isRecallResult(r) &&
    !isProposalResult(r)
  );
}

/** What changed since a cursor (see changesIn). */
export interface ChangesResult {
  /** The sessions of the events, with their threads, and whether each started in the range (`new`). */
  sessions: Array<SessionView & { new: boolean }>;
  events: Array<EventStub & { session: string; origin?: Found }>;
  entries: Array<EntryStub & { supersedes: string | null; origin?: Found }>;
  /** Forgets and restores, by id: what a forget hid is never shown. */
  forgets: Array<{ id: string; target: string; at: string }>;
  /** The entries proposed in the range, pending or accepted (absent from older hubs). */
  proposals?: Array<ProposalStub & { origin?: Found }>;
  /** The cursor to pass as `after` to read on. */
  next: string;
  more: boolean;
}

/** A prompt the user wrote that day, cut short. */
export interface DigestPromptView {
  id: string;
  time: string;
  text: string;
}

/**
 * A top-level session active that day (see digestOf). The fields named in the digest's
 * `children_included_in` include the activity of its child sessions that day.
 */
export interface DigestSessionView {
  /** `<source>:<session id>`, which `get` opens. */
  id: string;
  source: string;
  session: string;
  project: string | null;
  thread: string | null;
  title: string | null;
  /** Without a title, its first prompt, as on a timeline. */
  prompt: string | null;
  /** Its first and last event that day. */
  first: string;
  last: string;
  events: number;
  /** The user's first prompts that day, and how many more they wrote. */
  prompts: DigestPromptView[];
  more_prompts: number;
  /** Calls that day by tool, most first, and the calls of every tool. */
  tools: Record<string, number>;
  tool_calls: number;
  /** The files its edit calls changed that day, most edited first, and how many more. */
  files: string[];
  more_files: number;
  /** Its child sessions active that day, and their workflow names. */
  children: number;
  workflows: string[];
  origin?: Found;
}

export interface DigestCountsView {
  sessions: number;
  events: number;
  prompts: number;
}

/** The digest of one day (see digestOf). */
export interface DigestResult {
  day: string;
  time_zone: string;
  /** The day's first instant, and the next day's first: every time in it is in its zone. */
  from: string;
  until: string;
  totals: DigestCountsView & { projects: number; agents: number; children: number };
  projects: Array<DigestCountsView & { project: string | null }>;
  agents: Array<DigestCountsView & { source: string }>;
  sessions: DigestSessionView[];
  more_sessions: number;
  /** The session fields that include their child sessions' activity. */
  children_included_in: string[];
  /** Versions written that day, newest first; `supersedes` names the version a correction replaced. */
  entries: Array<
    EntryStub & {
      project: string | null;
      author: string;
      supersedes: string | null;
      imported: boolean;
      origin?: Found;
    }
  >;
  more_entries: number;
  proposals: Array<ProposalStub & { origin?: Found }>;
  more_proposals: number;
  /** Forgets and restores made that day, by id only. */
  forgets: Array<{
    id: string;
    kind: 'forget' | 'restore';
    target: string;
    target_kind: 'entry' | 'event' | 'proposal' | 'forget';
    at: string;
  }>;
  more_forgets: number;
  /** On a device connected to a hub: whose digest it is. */
  origin?: Found;
}

/** What `follow` hands back, which the agent's log records and ingestion reads (see threads.ts). */
export interface FollowResult {
  link: string;
  /** The session the caller continues: the one named, or a thread's root, as `<source>:<id>`. */
  follows: string;
  /** The target's thread, or null while it is in none. */
  thread: string | null;
  note: string | null;
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

/** `{ by, speaker }` for an input the user did not write, else nothing (see WrittenBy). */
export function writtenBy(e: {
  role: string;
  kind: string;
  author?: Author | null;
  speaker?: string | null;
}): WrittenBy {
  if (!hasAuthor(e) || !e.author || e.author === 'owner') return {};
  return e.speaker ? { by: e.author, speaker: e.speaker } : { by: e.author };
}

export function eventView(e: EventRow, maxText: number): EventView {
  return {
    id: e.id,
    time: isoLocal(e.ts),
    source: e.source,
    project: e.project,
    session: e.sessionId,
    role: e.role,
    ...writtenBy(e),
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

export function eventStub(
  e: Pick<EventRow, 'id' | 'ts' | 'role' | 'kind' | 'text'> &
    Partial<Pick<EventRow, 'author' | 'speaker'>>,
): EventStub {
  return {
    id: e.id,
    time: isoLocal(e.ts),
    role: e.role,
    ...writtenBy(e),
    kind: e.kind,
    text: stubText(e.text),
  };
}

/** Where a turn starts (a prompt, or a command), as an event stub. */
const promptStub = (p: Omit<TurnStart, 'seq' | 'command'>): EventStub =>
  eventStub({ ...p, role: 'user', kind: 'message', text: p.prompt });

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
    thread: s.thread,
  };
}

/** A session as it is shown: the display title, and, on a list, its child count and workflows. */
function shownSession(db: Database, s: SessionRow, fold: boolean): SessionView {
  const parent = getSessionParent(db, s.source, s.sessionId);
  const view = sessionView(s);
  view.title = displayTitle(s.title, parent);
  if (fold) {
    const counted = sessionFold(db, s.source, s.sessionId);
    view.children = counted.children;
    view.workflows = counted.workflows;
  }
  return view;
}

/** The title a session is shown under, or null when the store has no such session. */
function shownTitle(db: Database, source: string, sessionId: string): string | null {
  const row = getSession(db, source, sessionId);
  if (!row) return null;
  return displayTitle(row.title, getSessionParent(db, source, sessionId));
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
  if (isProposalId(id)) throw proposalError(db, id);
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
    events: events.map((h) => {
      const parent = getSessionParent(db, h.source, h.sessionId);
      return {
        ...eventView(h, 400),
        snippet: h.snippet,
        session_title: names.get(sessionKey(h.source, h.sessionId)) ?? null,
        ...(parent
          ? {
              parent: `${parent.parentSource}:${parent.parentSessionId}`,
              parent_title: shownTitle(db, parent.parentSource, parent.parentSessionId),
            }
          : {}),
      };
    }),
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
      title: displayTitle(session.title, getSessionParent(db, session.source, session.sessionId)),
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
    topLevel: !args.include_children,
  });
  return { sessions: sessions.map((s) => shownSession(db, s, true)) };
}

/** An event's text is read in pages of this many UTF-16 code units. */
export const EVENT_PAGE = 20_000;

/**
 * Open any id (see docs/architecture.md, "Reading along references"): an entry, a recall, an
 * event, a session, or a thread, each with what is next to it. `source` picks the session when two sources
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
    case 'proposal':
      return proposalResult(db, opened.id);
    case 'event':
      return eventResult(db, opened.id, args.offset ?? 0);
    case 'session':
      return sessionResult(db, opened.session);
    case 'thread':
      return threadResult(db, opened.id);
  }
}

/** A thread's card: its sessions, agents, branches, the entries written from it, its last prompt. */
export function threadResult(db: Database, id: string): ThreadResult {
  const card = describeThread(db, id);
  if (!card) throw new OriginError(`Unknown thread ${id}.`);
  const last = card.lastPrompt;
  return {
    thread: card.id,
    project: card.project,
    title: card.title,
    started: card.startedAt === null ? null : isoLocal(card.startedAt),
    ended: card.endedAt === null ? null : isoLocal(card.endedAt),
    sessions: card.sessions.map(sessionView),
    more_sessions: Math.max(0, card.count - card.sessions.length),
    agents: card.agents,
    branches: card.branches,
    entries: card.entries.map(entryStub),
    last_prompt: last && { ...promptStub(last), session: last.sessionId },
  };
}

/**
 * What changed since a cursor (see docs/architecture.md#change-feed): sessions, events, and entries
 * as stubs, forgets by id, and the cursor to read on with. A session is given by its id or as
 * `<source>:<session id>`.
 */
export function changesIn(db: Database, args: ToolArgs<'changes'>): ChangesResult {
  const after = args.after ? parseFeedCursor(args.after) : null;
  let session: { source: string; sessionId: string } | undefined;
  if (args.session) {
    const opened = resolveId(db, args.session);
    if (opened?.kind !== 'session') throw new OriginError(`Unknown session ${args.session}.`);
    session = { source: opened.session.source, sessionId: opened.session.sessionId };
  }
  const feed = changesSince(db, {
    after,
    project: args.project,
    thread: args.thread,
    session,
    includeTools: args.include_tools,
    limit: args.limit,
  });
  return {
    sessions: feed.sessions.map((s) => ({ ...shownSession(db, s.session, true), new: s.started })),
    events: feed.events.map((e) => ({ ...eventStub(e), session: e.sessionId })),
    entries: feed.entries.map((e) => ({ ...entryStub(e), supersedes: e.supersedes })),
    forgets: feed.forgets.map((f) => ({ id: f.id, target: f.target, at: isoLocal(f.at) })),
    proposals: feed.proposals.map(proposalStub),
    next: encodeFeedCursor(feed.next),
    more: feed.more,
  };
}

/** The session fields of a digest that include the activity of child sessions. */
export const DIGEST_WITH_CHILDREN = ['events', 'first', 'last', 'tools', 'tool_calls', 'files'];

/**
 * The digest of one day (see docs/architecture.md#daily-digest), its times in the day's zone:
 * sessions, entries, proposals, and forgets as stubs, forgets by id only.
 */
export function digestOf(db: Database, args: ToolArgs<'digest'>): DigestResult {
  const d = digest(db, {
    day: args.day,
    timeZone: args.time_zone,
    project: args.project,
    source: args.source,
    limit: args.limit,
  });
  const time = (ms: number) => isoIn(ms, d.timeZone);
  return {
    day: d.day,
    time_zone: d.timeZone,
    from: time(d.from),
    until: time(d.until),
    totals: d.totals,
    projects: d.projects,
    agents: d.agents,
    sessions: d.sessions.map((s) => ({
      id: `${s.source}:${s.sessionId}`,
      source: s.source,
      session: s.sessionId,
      project: s.project,
      thread: s.thread,
      title: s.title,
      prompt: s.prompt,
      first: time(s.first),
      last: time(s.last),
      events: s.events,
      prompts: s.prompts.map((p) => ({ id: p.id, time: time(p.ts), text: p.text })),
      more_prompts: s.promptCount - s.prompts.length,
      tools: Object.fromEntries(s.tools.map((t) => [t.name, t.calls])),
      tool_calls: s.toolCalls,
      files: s.files,
      more_files: s.fileCount - s.files.length,
      children: s.children,
      workflows: s.workflows,
    })),
    more_sessions: d.moreSessions,
    children_included_in: DIGEST_WITH_CHILDREN,
    entries: d.entries.map((e) => ({
      ...entryStub(e),
      created: time(e.createdAt),
      project: e.project,
      author: e.author,
      supersedes: e.supersedes,
      imported: e.imported,
    })),
    more_entries: d.moreEntries,
    proposals: d.proposals.map((p) => ({ ...proposalStub(p), time: time(p.at) })),
    more_proposals: d.moreProposals,
    forgets: d.forgets.map((f) => ({
      id: f.id,
      kind: f.kind,
      target: f.target,
      target_kind: f.targetKind,
      at: time(f.at),
    })),
    more_forgets: d.moreForgets,
  };
}

/**
 * Which device's `project_root` rows to read. This store's own roots are `''`. A hub (`here` null)
 * uses the device named by the caller.
 */
export function placeDevice(here: string | null, named = ''): string {
  return here !== null ? '' : named;
}

/** The scope `follow` checks against: the project of `cwd`, or of the directory the server runs in. */
export function followScope(
  args: ToolArgs<'follow'>,
  here: string | null,
  db?: Database,
  device?: string,
) {
  const dir = args.cwd?.trim() || here;
  if (!dir) {
    throw new OriginError(
      'Pass `cwd`, your working directory: the hub cannot tell which project you work in.',
    );
  }
  return recallScope(dir, { onDisk: here !== null, db, device: placeDevice(here, device) });
}

/**
 * `follow`: check what the calling session continues (a session or thread of the project it works
 * in), and hand back the link for its log; ingestion derives the link from that result, on every
 * store (see docs/architecture.md#threads). Nothing is written here. Null when this store does not
 * know the id, so that a connected device can ask its hub.
 */
export function followIn(
  db: Database,
  args: ToolArgs<'follow'>,
  here: string | null,
  device?: string,
): FollowResult | null {
  const scope = followScope(args, here, db, device);
  const target = followTarget(db, args.id, {
    project: scope.project ?? null,
    root: scope.root ?? null,
    cwd: scope.cwd ?? null,
  });
  if (!target) return null;
  return {
    link: `lnk_${randomBytes(6).toString('hex')}`,
    follows: `${target.session.source}:${target.session.sessionId}`,
    thread: target.thread,
    note: args.note?.trim() || null,
  };
}

/** `follow` against one store: an id it does not know is an error. */
export function followHere(
  db: Database,
  args: ToolArgs<'follow'>,
  here: string | null,
  device?: string,
): FollowResult {
  const result = followIn(db, args, here, device);
  if (!result) {
    if (isForgotten(db, args.id)) throw new OriginError(`${args.id} has been forgotten.`);
    throw new OriginError(`Unknown session or thread ${args.id}.`);
  }
  return result;
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
  result.turn = ctx.turn && { number: ctx.turn.number, prompt: promptStub(ctx.turn.start) };
  result.replies_to = ctx.repliesTo && eventStub(ctx.repliesTo);
  result.around = { before: ctx.before.map(eventStub), after: ctx.after.map(eventStub) };
  result.cited_by = ctx.citedBy.map(entryStub);
  return result;
}

/** A session's card: what it is, its turns, the entries written from it, its recalls, its neighbours. */
export function sessionResult(db: Database, session: SessionRow): SessionResult {
  const card = describeSession(db, session);
  const view = shownSession(db, session, false);
  const parent = getSessionParent(db, session.source, session.sessionId);
  const children = childSessions(db, session.source, session.sessionId).map((c) => ({
    group: c.runGroup,
    via: c.via,
    source: c.source,
    session: c.sessionId,
    title: displayTitle(getSession(db, c.source, c.sessionId)?.title ?? null, c),
  }));
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
      ...writtenBy({ role: 'user', kind: 'message', author: p.author, speaker: p.speaker }),
      text: p.prompt,
    })),
    more_prompts: card.morePrompts,
    thread: card.thread,
    entries: card.entries.map(entryStub),
    recalls: card.recalls.map(({ recall, items }) => ({
      id: recall.id,
      occasion: recall.occasion,
      time: isoLocal(recall.at),
      items,
    })),
    before: card.before && shownSession(db, card.before, false),
    after: card.after && shownSession(db, card.after, false),
    ...(parent
      ? {
          parent: {
            source: parent.parentSource,
            session: parent.parentSessionId,
            title: shownTitle(db, parent.parentSource, parent.parentSessionId),
          },
        }
      : {}),
    ...(children.length > 0 ? { children } : {}),
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
    // A session's item names the session and its source; the others name what they are.
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

/**
 * `propose`: check a proposal as `remember` checks an entry, and hand it back whole, for the
 * agent's log; ingestion derives the proposal from that result, on every store (see
 * docs/architecture.md#proposals). Nothing is written here.
 */
export function proposeIn(db: Database, args: ToolArgs<'propose'>): ProposalJson {
  return proposalJson(
    prepareProposal(db, {
      kind: args.kind,
      text: args.text,
      confidence: args.confidence,
      project: args.project ?? null,
      validFrom: optionalTime(args.valid_from) ?? null,
      validTo: optionalTime(args.valid_to) ?? null,
      note: args.note ?? null,
      sources: args.sources.map((s) => ({ eventId: s.event_id, quote: s.quote })),
    }),
  );
}

/** A proposal in one line (see ProposalStub). */
export function proposalStub(p: Proposal): ProposalStub {
  return {
    id: p.id,
    kind: p.kind,
    text: stubText(firstLine(p.text)),
    status: p.status,
    time: isoLocal(p.at),
    session: p.sessionId,
    event: p.eventId,
    project: p.project ?? p.sessionProject,
  };
}

/** A proposal's card: its fields, status, sources, session, and the entry it became. */
export function proposalResult(db: Database, id: string): ProposalResult {
  const card = describeProposal(db, id);
  if (!card) throw proposalError(db, id);
  const p = card.proposal;
  return {
    id: p.id,
    status: p.status,
    kind: p.kind,
    text: p.text,
    confidence: p.confidence,
    project: p.project,
    valid_from: p.validFrom === null ? null : isoLocal(p.validFrom),
    valid_to: p.validTo === null ? null : isoLocal(p.validTo),
    note: p.note,
    time: isoLocal(p.at),
    agent: p.source,
    session: card.session && sessionView(card.session),
    event: p.eventId,
    sources: card.sources.map((s) => ({
      ...eventStub(s.event),
      quote: s.quote,
      session: s.event.sessionId,
    })),
    missing_sources: card.missing,
    accepted_as: card.entry && entryStub(card.entry),
  };
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
 *
 * An agent that works in no directory, such as an OpenClaw agent, names its `project`: the brief is
 * then for that name alone, with no directory, and what is matched by directory (a session's `cwd`,
 * an imported memory's) is matched by name. With `cwd` too, `project` names the project and `cwd`
 * its directory. The server's own directory is the default only when neither is given.
 */
export function briefIn(
  db: Database,
  args: ToolArgs<'brief'>,
  author: string,
  here: string | null,
): BriefResult {
  const project = args.project?.trim() || null;
  const dir = args.cwd?.trim() || (project ? null : here);
  if (!dir && !project) {
    throw new OriginError(
      'Pass `cwd`, your working directory, or `project`, the project you work for: the hub cannot tell where you work.',
    );
  }
  const at = author.lastIndexOf('@');
  const named = at < 0 ? '' : author.slice(at + 1);
  const device = placeDevice(here, named);
  const scope = dir
    ? recallScope(dir, { onDisk: here !== null, db, device })
    : { cwd: null, root: null, project: null };
  const plan = planRecall(db, {
    occasion: 'request',
    source: sourceOfAgent(at < 0 ? author : author.slice(0, at)),
    prompt: args.about ?? null,
    onDisk: here !== null,
    device,
    ...scope,
    ...(project ? { project } : {}),
  });
  const recall = recordRecall(db, plan, { origin: at < 0 ? undefined : named });
  const where = plan.project ? `project ${plan.project}` : 'this directory';
  return {
    recall,
    text:
      recallText(plan, recall) ||
      `Origin recall ${recall}: the user's memory holds nothing for ${where} yet.`,
  };
}
