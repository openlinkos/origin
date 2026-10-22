import type {
  EntryResult,
  EntryView,
  Found,
  GetResult,
  SearchResult,
  SessionView,
  SourceOfEntry,
  SourceView,
  TimelineResult,
  VersionView,
} from './local.js';

/**
 * Merging a device's answers with its hub's (see docs/architecture.md#mcp-server). Results are
 * de-duplicated by id and labelled with where they were found: `local` when this device has them,
 * `hub` otherwise. What the device has forgotten is never shown, whatever the hub says, and the
 * versions of an entry from both sides are resolved as every store resolves them: the version with
 * the greatest (created_at, id) is current.
 */

/** What the device's own store knows. */
export interface LocalFacts {
  /** Whether this store has an entry or event with this id (visible or not). */
  known(id: string): boolean;
  /** Whether this store has forgotten the entry or excluded the event. */
  forgotten(id: string): boolean;
  /** The status here of an entry this store has, or null. */
  entryStatus(id: string): string | null;
  /** The versions this store has of the entry with this root (none if it has none). */
  versions(root: string): VersionView[];
}

function key(v: { created: string; id: string }): [number, string] {
  return [Date.parse(v.created), v.id];
}

/** Whether version `a` comes after `b` in the order that picks the current version. */
export function isNewer(
  a: { created: string; id: string },
  b: { created: string; id: string },
): boolean {
  const [ta, ia] = key(a);
  const [tb, ib] = key(b);
  return ta > tb || (ta === tb && ia > ib);
}

function labelled<T extends { origin?: Found }>(item: T, facts: LocalFacts, id: string): T {
  return { ...item, origin: facts.known(id) ? 'local' : 'hub' };
}

/** Alternate two ranked lists, keeping each one's order. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i] as T);
    if (i < b.length) out.push(b[i] as T);
  }
  return out;
}

/** Union by id; the first list wins. */
function union<T>(first: T[], second: T[], id: (x: T) => string): T[] {
  const seen = new Set(first.map(id));
  return [...first, ...second.filter((x) => !seen.has(id(x)))];
}

export function mergeSearch(
  local: SearchResult,
  hub: SearchResult | null,
  facts: LocalFacts,
  opts: { ranked: boolean; limit: number },
): SearchResult {
  const localIds = new Set(local.entries.map((e) => e.id));
  const fromHub = (hub?.entries ?? []).filter(
    (e) =>
      !localIds.has(e.id) &&
      !facts.forgotten(e.id) &&
      // The device holds a newer version of an entry the hub has not heard of yet.
      (facts.entryStatus(e.id) === null || facts.entryStatus(e.id) === 'active'),
  );
  const candidates = opts.ranked
    ? interleave(local.entries, fromHub)
    : [...local.entries, ...fromHub].sort((a, b) => (isNewer(a, b) ? -1 : 1));
  // One result per entry: its current version, at the best rank any of its versions had.
  const winners = new Map<string, EntryView>();
  for (const e of candidates) {
    const best = winners.get(e.root);
    if (!best || isNewer(e, best)) winners.set(e.root, e);
  }
  const entries: EntryView[] = [];
  const emitted = new Set<string>();
  for (const e of candidates) {
    if (emitted.has(e.root)) continue;
    emitted.add(e.root);
    const w = winners.get(e.root) as EntryView;
    entries.push(labelled(w, facts, w.id));
  }

  const theirs = hub?.events ?? [];
  const events = dedupe(
    opts.ranked ? interleave(local.events, theirs) : [...local.events, ...theirs],
    (e) => e.id,
  )
    .filter((e) => !facts.forgotten(e.id))
    .map((e) => labelled(e, facts, e.id));
  return { entries: entries.slice(0, opts.limit), events: events.slice(0, opts.limit) };
}

function dedupe<T>(items: T[], id: (x: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = id(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const endedAt = (s: SessionView) => (s.ended === null ? 0 : Date.parse(s.ended));

export function mergeTimeline(
  local: TimelineResult,
  hub: TimelineResult | null,
  facts: LocalFacts,
  limit: number,
): TimelineResult {
  if ('sessions' in local) {
    const theirs = hub && 'sessions' in hub ? hub.sessions : [];
    const sessionKey = (s: SessionView) => `${s.source}\n${s.session}`;
    const mine = new Set(local.sessions.map(sessionKey));
    const sessions = union(local.sessions, theirs, sessionKey)
      .map((s) => ({ ...s, origin: (mine.has(sessionKey(s)) ? 'local' : 'hub') as Found }))
      .sort((a, b) => endedAt(b) - endedAt(a));
    return { sessions: sessions.slice(0, limit) };
  }
  const theirs = hub && 'events' in hub ? hub.events : [];
  const events = union(local.events, theirs, (e) => e.id)
    .filter((e) => !facts.forgotten(e.id))
    .map((e) => labelled(e, facts, e.id))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.id < b.id ? -1 : 1));
  return { session: local.session, events: events.slice(0, limit) };
}

/**
 * Status of every version and of `entry`, computed over the merged history: the version with the
 * greatest (created_at, id) is active; the others are superseded, and a superseded version that
 * nothing corrects lost to a concurrent correction.
 */
function resolveVersions(entry: EntryView, history: VersionView[]): Omit<EntryResult, 'sources'> {
  const versions = [...history].sort((a, b) => (isNewer(a, b) ? 1 : -1));
  const current = versions[versions.length - 1];
  if (!current) return { entry, history };
  const corrected = new Set(versions.map((v) => v.supersedes).filter((s) => s !== null));
  const active = current.id === entry.id;
  return {
    entry: {
      ...entry,
      status: active ? 'active' : 'superseded',
      superseded_by: active ? null : current.id,
      concurrent: !active && !corrected.has(entry.id),
    },
    history: versions.map((v) => ({ ...v, status: v.id === current.id ? 'active' : 'superseded' })),
  };
}

function isEntryResult(r: GetResult): r is EntryResult {
  return 'entry' in r;
}

/**
 * `get` on a device: its own answer when it has the id, completed by the hub's (other versions of
 * the entry, written on the hub or on other devices); the hub's answer otherwise. Null when
 * neither has it.
 */
export function mergeGet(
  local: GetResult | null,
  hub: GetResult | null,
  facts: LocalFacts,
): GetResult | null {
  if (local && !isEntryResult(local)) return { ...local, origin: 'local' };
  if (!local && hub && !isEntryResult(hub)) {
    return facts.forgotten(hub.id) ? null : { ...hub, origin: 'hub' };
  }
  const mine = local && isEntryResult(local) ? local : null;
  const theirs = hub && isEntryResult(hub) ? hub : null;
  const base = mine ?? theirs;
  if (!base) return null;
  const history = union(
    union(mine?.history ?? [], facts.versions(base.entry.root), (v) => v.id),
    theirs?.history ?? [],
    (v) => v.id,
  ).filter((v) => !facts.forgotten(v.id));
  const sources = union<SourceOfEntry>(mine?.sources ?? [], theirs?.sources ?? [], (s) => s.id)
    .filter((s) => !facts.forgotten(s.id))
    .map((s) => labelled(s, facts, s.id));
  return {
    ...resolveVersions(base.entry, history),
    sources,
    origin: mine ? 'local' : 'hub',
  };
}

/** `sources` on a device: its own lines first (with its own file paths), then the hub's. */
export function mergeSources(
  local: SourceView[] | null,
  hub: SourceView[] | null,
  facts: LocalFacts,
): SourceView[] | null {
  if (!local && !hub) return null;
  return union(local ?? [], hub ?? [], (s) => s.event_id)
    .filter((s) => !facts.forgotten(s.event_id))
    .map((s) => labelled(s, facts, s.event_id));
}
