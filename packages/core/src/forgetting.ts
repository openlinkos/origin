import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { chainOf, currentOf, rootOf, sourcesOf } from './entries.js';
import { ConflictError, OriginError } from './errors.js';
import { storeName } from './identity.js';
import { refreshSession } from './ingest.js';
import { isRelay } from './mode.js';

/**
 * Forgetting (invariant 2, recorded forgetting; see docs/architecture.md#forgetting). A tombstone
 * records one operation under a global id, with its reason and, when known, its author. A forget
 * targets an entry or an event and hides it, with its cascade, on every store; a restore targets a
 * forget's tombstone id and lifts it. A forget is in effect while no restore targets it. Tombstones
 * only accumulate, so every store converges on the same records whatever order they arrive in.
 *
 * What each forget covers is recorded per store in tombstone_effect, several forgets per item: by
 * the rules from its target (`direct`), as its hub listed it (`listed`, on a device), as a device
 * reported it (`reported`, on a hub), and by rule 3 (`cascade`). An entry or event is hidden while a
 * forget in effect covers it: forgotten_entry and excluded_event hold what is hidden, which every
 * query filters on, each with one forget in effect that covers it.
 */

export interface ForgetInput {
  /** Why: required, kept with the tombstone and sent to every store. */
  reason: string;
  /** Who: `<agent>@<device>` for an agent, `user@<device>` for the owner; null when unknown. */
  author?: string | null;
}

export interface ForgetResult {
  target: string;
  targetType: 'entry' | 'event';
  /** Entries newly hidden (every version of each affected entry). */
  entries: string[];
  /** Events newly hidden. */
  events: string[];
  /** Null when there was nothing left to hide. */
  tombstoneId: string | null;
}

/** What restoring a forget brings back on this store. */
export interface RestorePlan {
  /** The forget's tombstone id. */
  target: string;
  /** Entries and events visible again: what it hid that no other forget in effect covers. */
  entries: string[];
  events: string[];
}

export interface RestoreResult extends RestorePlan {
  /** The restore's own tombstone id. */
  tombstoneId: string;
}

/** A tombstone as stores exchange it: what it targets, and what it covers on the sending store. */
export interface TombstoneRecord {
  id: string;
  /** For a forget, an entry or event id; for a restore, the forget's tombstone id. */
  target: string;
  /** Required for tombstones written now; null on some written by Origin 0.1. */
  reason: string | null;
  createdAt: number;
  /** The store that created it: a device's name, or the hub's. */
  origin: string;
  /** Who made it, when known (`<agent>@<device>`, `user@<device>`). */
  author?: string | null;
  /** Entries this forget covers on the sending store (none for a restore). */
  entries: string[];
  /** Events this forget covers on the sending store (none for a restore). */
  events: string[];
}

/** Tombstone ids: `tmb_` and random hex, unique across stores. */
export const TOMBSTONE_ID_RE = /^tmb_[0-9a-f]{12,32}$/;

/** Longest reason accepted. */
export const MAX_REASON = 2000;

function newTombstoneId(): string {
  return `tmb_${randomBytes(6).toString('hex')}`;
}

/** Whether a tombstone with this target is a restore: its target is another tombstone. */
export function isRestoreTarget(target: string): boolean {
  return target.startsWith('tmb_');
}

/** A reason, trimmed: required and at most MAX_REASON characters. */
export function checkReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) throw new OriginError('A reason is required: say why, so that the record explains it.');
  if (r.length > MAX_REASON) {
    throw new OriginError(`The reason is too long (at most ${MAX_REASON} characters).`);
  }
  return r;
}

/** Whether rule 3 may be decided here for the chain with this root (see applyTombstone). */
export type RuleThreeJudge = (root: string) => boolean;

type How = 'direct' | 'listed' | 'reported' | 'cascade';

interface Items {
  entries: Set<string>;
  events: Set<string>;
}

const noItems = (): Items => ({ entries: new Set(), events: new Set() });
const size = (i: Items) => i.entries.size + i.events.size;

/** `t` is a forget in effect: not a restore, and no restore targets it. */
export const IN_EFFECT = `t.target NOT LIKE 'tmb\\_%' ESCAPE '\\'
  AND NOT EXISTS (SELECT 1 FROM tombstone r WHERE r.target = t.id)`;

/** Roots of the entries that cite any of these events. */
function citingRoots(db: Database, events: Iterable<string>): Set<string> {
  const all = [...events];
  const roots = new Set<string>();
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT DISTINCT en.root FROM entry_source s JOIN entry en ON en.id = s.entry_id
         WHERE s.event_id IN (${batch.map(() => '?').join(',')})`,
      )
      .all(...batch) as unknown as Array<{ root: string }>;
    for (const r of rows) roots.add(r.root);
  }
  return roots;
}

/** Statements used throughout one operation. */
function statements(db: Database) {
  return {
    entryExists: db.prepare('SELECT 1 FROM entry WHERE id = ?'),
    eventExists: db.prepare('SELECT 1 FROM event WHERE id = ?'),
    forgottenBy: db.prepare('SELECT tombstone_id AS t FROM forgotten_entry WHERE entry_id = ?'),
    excludedBy: db.prepare('SELECT tombstone_id AS t FROM excluded_event WHERE event_id = ?'),
    hideEntry: db.prepare(
      'INSERT OR IGNORE INTO forgotten_entry (entry_id, tombstone_id) VALUES (?, ?)',
    ),
    hideEvent: db.prepare(
      'INSERT OR IGNORE INTO excluded_event (event_id, tombstone_id) VALUES (?, ?)',
    ),
    addRow: db.prepare(
      'INSERT OR IGNORE INTO tombstone_effect (tombstone_id, kind, item, how) VALUES (?, ?, ?, ?)',
    ),
    sessionOf: db.prepare('SELECT source, session_id FROM event WHERE id = ?'),
  };
}
type Statements = ReturnType<typeof statements>;

const attribution = (stmt: Statements['forgottenBy'], id: string): string | undefined =>
  (stmt.get(id) as { t: string } | undefined)?.t;

/** Sessions whose visible events changed, re-aggregated once at the end (see refreshSession). */
class Sessions {
  private readonly seen = new Map<string, { source: string; sessionId: string }>();
  constructor(
    private readonly db: Database,
    private readonly q: Statements,
  ) {}
  add(eventId: string): void {
    const s = this.q.sessionOf.get(eventId) as { source: string; session_id: string } | undefined;
    if (s)
      this.seen.set(`${s.source}\n${s.session_id}`, { source: s.source, sessionId: s.session_id });
  }
  refresh(): void {
    for (const s of this.seen.values()) refreshSession(this.db, s.source, s.sessionId);
  }
}

/**
 * What the rules give from a target, on this store's data:
 *
 * 1. Forgetting an entry covers every version of it (its whole chain, forks included) and every
 *    event those versions cite.
 * 2. Forgetting an event covers it and every entry that cites it, as in rule 1.
 *
 * Rule 3 (an entry whose current version is left with no visible source is hidden too, every
 * version of it, which hides no further events) depends on what else is hidden; see applyForget.
 */
function rulesFrom(
  db: Database,
  q: Statements,
  target: string,
): { type: 'entry' | 'event' | null; items: Items } {
  const items = noItems();
  const addChain = (root: string | null) => {
    if (!root) return;
    const versions = chainOf(db, root);
    for (const v of versions) items.entries.add(v);
    for (const s of sourcesOf(db, versions)) items.events.add(s);
  };
  if (q.entryExists.get(target)) {
    addChain(rootOf(db, target));
    return { type: 'entry', items };
  }
  if (q.eventExists.get(target)) {
    items.events.add(target);
    for (const root of citingRoots(db, [target])) addChain(root);
    return { type: 'event', items };
  }
  return { type: null, items };
}

/** The ids another store listed that this store holds; a listed entry takes its whole chain. */
function expandListed(
  db: Database,
  q: Statements,
  listed: { entries: string[]; events: string[] },
): Items {
  const items = noItems();
  for (const id of new Set(listed.entries)) {
    if (items.entries.has(id) || !q.entryExists.get(id)) continue;
    const root = rootOf(db, id);
    if (root) for (const v of chainOf(db, root)) items.entries.add(v);
  }
  for (const id of new Set(listed.events)) if (q.eventExists.get(id)) items.events.add(id);
  return items;
}

function addRows(q: Statements, tombstoneId: string, how: How, items: Items): number {
  let n = 0;
  for (const e of items.entries) n += Number(q.addRow.run(tombstoneId, 'entry', e, how).changes);
  for (const e of items.events) n += Number(q.addRow.run(tombstoneId, 'event', e, how).changes);
  return n;
}

/** The rows of a tombstone, of the given kinds of coverage (all when omitted). */
function rowsOf(db: Database, tombstoneId: string, how?: How[]): Items {
  const filter = how ? `AND how IN (${how.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT DISTINCT kind, item FROM tombstone_effect WHERE tombstone_id = ? ${filter}
       ORDER BY kind, item`,
    )
    .all(tombstoneId, ...(how ?? [])) as unknown as Array<{ kind: string; item: string }>;
  const items = noItems();
  for (const r of rows) (r.kind === 'entry' ? items.entries : items.events).add(r.item);
  return items;
}

function isInEffect(db: Database, id: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM tombstone t WHERE t.id = ? AND ${IN_EFFECT}`).get(id) !== undefined
  );
}

/** The restores of a forget, oldest first. */
function restoresOf(db: Database, id: string): string[] {
  return (
    db
      .prepare('SELECT id FROM tombstone WHERE target = ? ORDER BY created_at, id')
      .all(id) as unknown as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Log a tombstone or an entry again, so that replication sends it again (see replication.ts). */
function relog(db: Database, kind: 'entry' | 'tombstone', id: string, origin: string): void {
  db.prepare('INSERT INTO change_log (kind, id, origin, at) VALUES (?, ?, ?, ?)').run(
    kind,
    id,
    origin,
    Date.now(),
  );
}

interface ForgetApplied {
  /** Entries and events newly hidden here. */
  entries: string[];
  events: string[];
  /** Whether the forget's coverage here gained rows. */
  grown: boolean;
  /** When a list from the hub replaced a longer one: what that brought back. */
  lifted: Lifted | null;
}

/**
 * Record what a forget covers here, and hide it if the forget is in effect. Must run inside a write
 * transaction. `list` is what another store listed for it: from a hub, it replaces the hub's last
 * list (the hub decides rule 3 for the entries it has, and may withdraw a verdict after a restore);
 * from a device, it adds to what the device reported before. Rule 3 is checked for every chain that
 * cites an event the forget covers, against everything hidden here; `judge` limits it to the chains
 * this store may decide for.
 */
function applyForget(
  db: Database,
  q: Statements,
  t: { id: string; target: string },
  o: {
    judge?: RuleThreeJudge;
    list?: { how: 'listed' | 'reported'; entries: string[]; events: string[] };
  } = {},
): ForgetApplied {
  let grown = addRows(q, t.id, 'direct', rulesFrom(db, q, t.target).items) > 0;
  let dropped: Items | null = null;
  if (o.list) {
    const expanded = expandListed(db, q, o.list);
    if (o.list.how === 'listed') {
      const old = rowsOf(db, t.id, ['listed']);
      dropped = noItems();
      for (const e of old.entries) if (!expanded.entries.has(e)) dropped.entries.add(e);
      for (const e of old.events) if (!expanded.events.has(e)) dropped.events.add(e);
      const remove = db.prepare(
        "DELETE FROM tombstone_effect WHERE tombstone_id = ? AND kind = ? AND item = ? AND how = 'listed'",
      );
      for (const e of dropped.entries) remove.run(t.id, 'entry', e);
      for (const e of dropped.events) remove.run(t.id, 'event', e);
    }
    if (addRows(q, t.id, o.list.how, expanded) > 0) grown = true;
  }

  const hidden = { entries: [] as string[], events: [] as string[] };
  if (isInEffect(db, t.id)) {
    const cover = rowsOf(db, t.id);
    const sessions = new Sessions(db, q);
    for (const e of cover.events) {
      if (Number(q.hideEvent.run(e, t.id).changes) > 0) {
        hidden.events.push(e);
        sessions.add(e);
      }
    }
    for (const e of cover.entries) {
      if (Number(q.hideEntry.run(e, t.id).changes) > 0) hidden.entries.push(e);
    }
    // Rule 3: chains whose current version has no visible source left.
    const excluded = (e: string) => attribution(q.excludedBy, e) !== undefined;
    for (const root of citingRoots(db, cover.events)) {
      if (cover.entries.has(root)) continue;
      if (o.judge && !o.judge(root)) continue;
      const current = currentOf(db, root);
      const sources = current ? sourcesOf(db, [current]) : [];
      if (sources.length === 0 || !sources.every(excluded)) continue;
      const versions = new Set(chainOf(db, root));
      if (addRows(q, t.id, 'cascade', { entries: versions, events: new Set() }) > 0) grown = true;
      for (const v of versions) {
        if (Number(q.hideEntry.run(v, t.id).changes) > 0) hidden.entries.push(v);
      }
    }
    sessions.refresh();
  }
  const lifted = dropped && size(dropped) > 0 ? lift(db, q, dropped) : null;
  return { ...hidden, grown, lifted };
}

interface Lifted {
  /** Entries and events visible again. */
  entries: string[];
  events: string[];
  /** Forgets in effect whose coverage here changed (on a hub, they are logged again). */
  changed: Set<string>;
}

/**
 * Decide again whether these entries and events, and the chains that cite events that become
 * visible, stay hidden, now that a forget no longer covers them (it was restored, or its hub
 * withdrew them from its list). An event stays hidden while a forget in effect covers it. A chain
 * stays hidden while a forget in effect covers it by its rules or its hub's list, or by rule 3: its
 * current version has no visible source, and the chain is then covered by every forget in effect
 * that covers one of those sources. A device's reported entries are such verdicts too, and are
 * decided here again. So a restore brings back what the forget hid, except what other forgets in
 * effect cover, and leaves this store as if the forget had never been made.
 *
 * `without` is a forget treated as out of effect, and `dryRun` writes nothing (for planRestore).
 * Must run inside a write transaction unless `dryRun`.
 */
function lift(
  db: Database,
  q: Statements,
  candidates: Items,
  o: { without?: string; dryRun?: boolean } = {},
): Lifted {
  const without = o.without ?? '';
  const coveringAny = db.prepare(
    `SELECT DISTINCT t.id, t.created_at FROM tombstone_effect x
     JOIN tombstone t ON t.id = x.tombstone_id
     WHERE x.item = ? AND x.kind = ? AND t.id <> ? AND ${IN_EFFECT}
     ORDER BY t.created_at, t.id`,
  );
  const coveringSticky = db.prepare(
    `SELECT DISTINCT t.id, t.created_at FROM tombstone_effect x
     JOIN tombstone t ON t.id = x.tombstone_id
     WHERE x.item = ? AND x.kind = ? AND x.how IN ('direct', 'listed') AND t.id <> ? AND ${IN_EFFECT}
     ORDER BY t.created_at, t.id`,
  );
  /** Forgets in effect that cover an item, oldest first; `sticky`: by their rules or hub's list. */
  const covering = (kind: 'entry' | 'event', item: string, sticky: boolean): string[] =>
    (
      (sticky ? coveringSticky : coveringAny).all(item, kind, without) as unknown as Array<{
        id: string;
      }>
    ).map((r) => r.id);
  const createdAt = db.prepare('SELECT created_at FROM tombstone WHERE id = ?');
  const earliest = (ids: Iterable<string>): string => {
    const rows = [...ids].map((id) => ({
      id,
      at: (createdAt.get(id) as { created_at: number }).created_at,
    }));
    rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return (rows[0] as { id: string }).id;
  };

  // Events: only forgets cover them (rule 3 hides no events), so they are decided first.
  const visibleEvents = new Set<string>();
  const eventAttribution = new Map<string, string>();
  for (const e of candidates.events) {
    const by = attribution(q.excludedBy, e);
    if (by === undefined) continue;
    const covers = covering('event', e, false);
    if (covers.length === 0) visibleEvents.add(e);
    else if (!covers.includes(by)) eventAttribution.set(e, covers[0] as string);
  }
  const hiddenAfter = (e: string) =>
    !visibleEvents.has(e) && attribution(q.excludedBy, e) !== undefined;

  // Chains: those of the candidate entries, and those that cite an event now visible.
  const roots = new Set<string>();
  for (const e of candidates.entries) {
    const root = rootOf(db, e);
    if (root) roots.add(root);
  }
  for (const root of citingRoots(db, visibleEvents)) roots.add(root);

  const verdictRows = db.prepare(
    `SELECT DISTINCT tombstone_id AS t FROM tombstone_effect
     WHERE kind = 'entry' AND item = ? AND how IN ('cascade', 'reported')`,
  );
  const visibleEntries: string[] = [];
  const entryAttribution = new Map<string, string>();
  const verdicts: Array<{ versions: string[]; forgets: string[] }> = [];
  const changed = new Set<string>();
  for (const root of roots) {
    const versions = chainOf(db, root);
    if (!versions.some((v) => attribution(q.forgottenBy, v) !== undefined)) continue;
    const sticky = new Set<string>();
    for (const v of versions) for (const f of covering('entry', v, true)) sticky.add(f);
    const current = currentOf(db, root);
    const sources = current ? sourcesOf(db, [current]) : [];
    const cascade = new Set<string>();
    if (sources.length > 0 && sources.every(hiddenAfter)) {
      for (const s of sources) for (const f of covering('event', s, false)) cascade.add(f);
    }
    // Rule 3 verdicts on this chain, before and after; a forget whose coverage changes is noted.
    const before = new Set<string>();
    for (const v of versions) {
      for (const r of verdictRows.all(v) as unknown as Array<{ t: string }>) before.add(r.t);
    }
    for (const f of before) if (!cascade.has(f) && !sticky.has(f) && f !== without) changed.add(f);
    for (const f of cascade) if (!before.has(f) && !sticky.has(f)) changed.add(f);
    verdicts.push({ versions, forgets: [...cascade] });
    const covers = new Set([...sticky, ...cascade]);
    for (const v of versions) {
      const by = attribution(q.forgottenBy, v);
      if (covers.size === 0) {
        if (by !== undefined) visibleEntries.push(v);
      } else if (by === undefined || !covers.has(by)) {
        entryAttribution.set(v, earliest(covers));
      }
    }
  }
  // Forgets that are no longer in effect are not reported as changed.
  for (const f of changed) if (!isInEffect(db, f)) changed.delete(f);

  if (!o.dryRun) {
    const sessions = new Sessions(db, q);
    const showEvent = db.prepare('DELETE FROM excluded_event WHERE event_id = ?');
    const moveEvent = db.prepare('UPDATE excluded_event SET tombstone_id = ? WHERE event_id = ?');
    for (const e of visibleEvents) {
      showEvent.run(e);
      sessions.add(e);
    }
    for (const [e, t] of eventAttribution) moveEvent.run(t, e);
    const dropVerdict = db.prepare(
      "DELETE FROM tombstone_effect WHERE kind = 'entry' AND item = ? AND how IN ('cascade', 'reported')",
    );
    for (const v of verdicts) {
      for (const e of v.versions) dropVerdict.run(e);
      for (const f of v.forgets) {
        addRows(q, f, 'cascade', { entries: new Set(v.versions), events: new Set() });
      }
    }
    const showEntry = db.prepare('DELETE FROM forgotten_entry WHERE entry_id = ?');
    const moveEntry = db.prepare(
      `INSERT INTO forgotten_entry (entry_id, tombstone_id) VALUES (?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET tombstone_id = excluded.tombstone_id`,
    );
    for (const e of visibleEntries) showEntry.run(e);
    for (const [e, t] of entryAttribution) moveEntry.run(e, t);
    sessions.refresh();
    // This store's own entries that are visible again are sent to its hub again: one that was
    // hidden before it was pushed never left this store.
    const me = storeName(db);
    const own = db.prepare('SELECT origin, created_at FROM entry WHERE id = ?');
    const mine = visibleEntries
      .map((id) => ({ id, ...(own.get(id) as { origin: string; created_at: number }) }))
      .filter((e) => e.origin === me)
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const e of mine) relog(db, 'entry', e.id, me);
  }
  return { entries: visibleEntries, events: [...visibleEvents], changed };
}

/** What `forget` would hide, without doing it. */
function plan(db: Database, q: Statements, id: string): ForgetResult {
  const { type, items } = rulesFrom(db, q, id);
  if (type === null) throw new OriginError(`Unknown entry or event ${id}.`);
  const excluded = (e: string) => attribution(q.excludedBy, e) !== undefined;
  const forgotten = (e: string) => attribution(q.forgottenBy, e) !== undefined;
  const entries = new Set([...items.entries].filter((e) => !forgotten(e)));
  const events = [...items.events].filter((e) => !excluded(e));
  const gone = (e: string) => items.events.has(e) || excluded(e);
  for (const root of citingRoots(db, items.events)) {
    if (items.entries.has(root) || forgotten(root)) continue;
    const current = currentOf(db, root);
    const sources = current ? sourcesOf(db, [current]) : [];
    if (sources.length > 0 && sources.every(gone)) {
      for (const v of chainOf(db, root)) if (!forgotten(v)) entries.add(v);
    }
  }
  return { target: id, targetType: type, entries: [...entries], events, tombstoneId: null };
}

/** What `forget` would hide, without doing it. */
export function planForget(db: Database, id: string): ForgetResult {
  return plan(db, statements(db), id);
}

function insertTombstone(
  db: Database,
  t: { id: string; target: string; reason: string | null; createdAt: number; origin: string },
  author: string | null,
): void {
  db.prepare(
    'INSERT INTO tombstone (id, target, reason, created_at, origin) VALUES (?, ?, ?, ?, ?)',
  ).run(t.id, t.target, t.reason, t.createdAt, t.origin);
  db.prepare('INSERT OR IGNORE INTO tombstone_meta (tombstone_id, author) VALUES (?, ?)').run(
    t.id,
    author,
  );
}

/** Record an author learned later (a tombstone first received without one). */
function noteAuthor(db: Database, id: string, author: string | null | undefined): void {
  db.prepare('INSERT OR IGNORE INTO tombstone_meta (tombstone_id, author) VALUES (?, ?)').run(
    id,
    author ?? null,
  );
  if (author) {
    db.prepare(
      'UPDATE tombstone_meta SET author = ? WHERE tombstone_id = ? AND author IS NULL',
    ).run(author, id);
  }
}

/**
 * Forget an entry or an event (invariant 2, recorded forgetting). What it hides leaves every query
 * at once, and hidden events cannot be cited. It is a record, with its reason and author: the owner
 * can restore it (see restore), and nothing else brings it back. Raw mirrors are kept on disk but
 * never shown. Records nothing when everything it would hide is hidden already.
 */
export function forget(
  db: Database,
  id: string,
  input: ForgetInput,
  now = Date.now(),
): ForgetResult {
  const reason = checkReason(input.reason);
  return transaction(
    db,
    () => {
      const q = statements(db);
      const result = plan(db, q, id);
      if (result.entries.length === 0 && result.events.length === 0) return result;
      const tombstoneId = newTombstoneId();
      insertTombstone(
        db,
        { id: tombstoneId, target: id, reason, createdAt: now, origin: storeName(db) },
        input.author ?? null,
      );
      applyForget(db, q, { id: tombstoneId, target: id });
      return { ...result, tombstoneId };
    },
    { immediate: true },
  );
}

/** Refuse unless `id` is a forget in effect here. */
function checkRestorable(db: Database, id: string): void {
  const row = db.prepare('SELECT target FROM tombstone WHERE id = ?').get(id) as
    | { target: string }
    | undefined;
  if (!row) throw new OriginError(`Unknown forget ${id}.`);
  if (isRestoreTarget(row.target)) {
    throw new OriginError(
      `${id} is a restore, and only a forget can be restored. To hide what it brought back, forget the entry or event again.`,
    );
  }
  const by = restoresOf(db, id);
  if (by.length > 0) throw new OriginError(`${id} has already been restored (${by[0]}).`);
}

/** What `restore` would bring back here, without doing it. */
export function planRestore(db: Database, forgetId: string): RestorePlan {
  checkRestorable(db, forgetId);
  const q = statements(db);
  const r = lift(db, q, rowsOf(db, forgetId), { without: forgetId, dryRun: true });
  return { target: forgetId, entries: r.entries, events: r.events };
}

export interface RestoreOptions {
  /**
   * On a hub: the hub's name, under which forgets whose coverage changes are logged again, so that
   * every device receives them.
   */
  growthOrigin?: string;
}

/**
 * Restore a forget: record a tombstone whose target is the forget's id, which lifts it here and on
 * every store it reaches. What the forget hid comes back, except what another forget in effect
 * covers; nothing is deleted from the record. Only the owner restores (the CLI and the admin UI;
 * agents cannot). To hide the target again, forget it again.
 */
export function restore(
  db: Database,
  forgetId: string,
  input: ForgetInput,
  now = Date.now(),
  opts: RestoreOptions = {},
): RestoreResult {
  const reason = checkReason(input.reason);
  return transaction(
    db,
    () => {
      checkRestorable(db, forgetId);
      const q = statements(db);
      const tombstoneId = newTombstoneId();
      insertTombstone(
        db,
        { id: tombstoneId, target: forgetId, reason, createdAt: now, origin: storeName(db) },
        input.author ?? null,
      );
      const lifted = lift(db, q, rowsOf(db, forgetId));
      if (opts.growthOrigin) {
        for (const f of lifted.changed) relog(db, 'tombstone', f, opts.growthOrigin);
      }
      return { tombstoneId, target: forgetId, entries: lifted.entries, events: lifted.events };
    },
    { immediate: true },
  );
}

export interface ApplyOptions {
  /** Record the tombstone even when it covers nothing here (a hub keeps every tombstone). */
  keep?: boolean;
  /** Limit rule 3 to some chains (a device leaves chains its hub already has to the hub). */
  judge?: RuleThreeJudge;
  /**
   * On a hub: when a forget's coverage here changes beyond what its sender listed, append a change
   * under this origin so that every device, the sender included, receives it again.
   */
  growthOrigin?: string;
  /**
   * Who sent the tombstone. `hub` (the default, on a device): its lists are the hub's verdicts and
   * replace the last ones. `device` (on a hub): what the device covered adds to what it reported.
   */
  from?: 'hub' | 'device';
}

export interface ApplyResult {
  /** Entries newly hidden here. */
  entries: number;
  /** Events newly hidden here. */
  events: number;
  /** Entries and events visible again here (a restore, or a list that shrank). */
  restored: { entries: number; events: number };
}

const NOTHING: ApplyResult = { entries: 0, events: 0, restored: { entries: 0, events: 0 } };

/** Apply a tombstone from another store, or re-apply one of ours. Must run inside a write transaction. */
export function applyTombstoneInTransaction(
  db: Database,
  t: TombstoneRecord,
  opts: ApplyOptions = {},
): ApplyResult {
  // A relay keeps no tombstones: it holds nothing they could hide.
  if (isRelay(db)) return NOTHING;
  const existing = db
    .prepare('SELECT target, reason, created_at, origin FROM tombstone WHERE id = ?')
    .get(t.id) as
    | { target: string; reason: string | null; created_at: number; origin: string }
    | undefined;
  if (
    existing &&
    (existing.target !== t.target ||
      existing.reason !== t.reason ||
      existing.created_at !== t.createdAt ||
      existing.origin !== t.origin)
  ) {
    throw new ConflictError(`Tombstone ${t.id} already exists with different content.`);
  }
  const q = statements(db);
  return isRestoreTarget(t.target)
    ? applyRestore(db, q, t, !!existing, opts)
    : applyForgetRecord(db, q, t, !!existing, opts);
}

function applyRestore(
  db: Database,
  q: Statements,
  t: TombstoneRecord,
  existing: boolean,
  opts: ApplyOptions,
): ApplyResult {
  const target = db.prepare('SELECT target FROM tombstone WHERE id = ?').get(t.target) as
    | { target: string }
    | undefined;
  if (!existing) {
    // A device keeps the restores of forgets it holds; its hub sends a restore again after a
    // forget that arrives later, so the order of arrival does not matter.
    if (!target && !opts.keep) return NOTHING;
    insertTombstone(db, t, t.author ?? null);
  } else {
    noteAuthor(db, t.id, t.author);
  }
  // A restore whose forget is unknown here waits for it; one that targets a restore does nothing.
  if (!target || isRestoreTarget(target.target)) return NOTHING;
  // The first restore lifts the forget. Applying one again, or a second restore of the same forget,
  // changes nothing, unless the forget still hides something (a restore a store kept before it
  // could apply restores).
  const attributed =
    db.prepare('SELECT 1 FROM forgotten_entry WHERE tombstone_id = ? LIMIT 1').get(t.target) ??
    db.prepare('SELECT 1 FROM excluded_event WHERE tombstone_id = ? LIMIT 1').get(t.target);
  if (!attributed && (existing || restoresOf(db, t.target).length > 1)) return NOTHING;
  const lifted = lift(db, q, rowsOf(db, t.target));
  if (opts.growthOrigin) {
    for (const f of lifted.changed) relog(db, 'tombstone', f, opts.growthOrigin);
  }
  return {
    entries: 0,
    events: 0,
    restored: { entries: lifted.entries.length, events: lifted.events.length },
  };
}

function applyForgetRecord(
  db: Database,
  q: Statements,
  t: TombstoneRecord,
  existing: boolean,
  opts: ApplyOptions,
): ApplyResult {
  db.exec('SAVEPOINT apply_tombstone');
  try {
    if (!existing) insertTombstone(db, t, t.author ?? null);
    else noteAuthor(db, t.id, t.author);
    const applied = applyForget(db, q, t, {
      judge: opts.judge,
      list: {
        how: opts.from === 'device' ? 'reported' : 'listed',
        entries: t.entries,
        events: t.events,
      },
    });
    if (!existing && !opts.keep && size(rowsOf(db, t.id)) === 0) {
      // A device does not keep a forget that covers nothing it holds.
      db.exec('ROLLBACK TO apply_tombstone');
      db.exec('RELEASE apply_tombstone');
      return NOTHING;
    }
    db.exec('RELEASE apply_tombstone');
    if (opts.growthOrigin) {
      const listed = new Set([...t.entries, ...t.events]);
      const now = exportTombstone(db, t.id) as TombstoneRecord;
      if (applied.grown && [...now.entries, ...now.events].some((id) => !listed.has(id))) {
        relog(db, 'tombstone', t.id, opts.growthOrigin);
      }
      for (const f of applied.lifted?.changed ?? []) {
        if (f !== t.id) relog(db, 'tombstone', f, opts.growthOrigin);
      }
      // A restore that arrived before this forget is sent again after it.
      if (!existing)
        for (const r of restoresOf(db, t.id)) relog(db, 'tombstone', r, opts.growthOrigin);
    }
    return {
      entries: applied.entries.length,
      events: applied.events.length,
      restored: {
        entries: applied.lifted?.entries.length ?? 0,
        events: applied.lifted?.events.length ?? 0,
      },
    };
  } catch (err) {
    db.exec('ROLLBACK TO apply_tombstone');
    db.exec('RELEASE apply_tombstone');
    throw err;
  }
}

/**
 * Apply a tombstone created on another store (invariant 2: forgetting reaches every replica). The
 * tombstone keeps its id, origin, reason, and author. A forget covers here what the rules give
 * from its target and what its sender listed, as far as this store knows those ids, and hides it
 * unless a restore of it is known; a restore lifts its forget. Without `keep`, a forget that
 * covers nothing here, and a restore of a forget unknown here, are not recorded. Re-applying
 * changes nothing.
 */
export function applyTombstone(
  db: Database,
  t: TombstoneRecord,
  opts: ApplyOptions = {},
): ApplyResult {
  return transaction(db, () => applyTombstoneInTransaction(db, t, opts), { immediate: true });
}

/**
 * Cover a version that just arrived (on a hub, pushed by a device) by the forgets in effect that
 * concern it: those that cover another version of its chain, which takes it as a whole, or one of
 * the events it cites. Forgets whose coverage grows are logged again under `growthOrigin`. Must run
 * inside a write transaction, after the version is inserted.
 */
export function coverArrival(db: Database, entryId: string, growthOrigin: string): void {
  const root = rootOf(db, entryId);
  if (!root) return;
  const concerned = db
    .prepare(
      `SELECT t.id, t.target FROM tombstone t WHERE ${IN_EFFECT} AND t.id IN (
         SELECT x.tombstone_id FROM tombstone_effect x JOIN entry en ON en.id = x.item
         WHERE x.kind = 'entry' AND en.root = ? AND en.id <> ?
         UNION
         SELECT x.tombstone_id FROM tombstone_effect x JOIN entry_source s ON s.event_id = x.item
         WHERE x.kind = 'event' AND s.entry_id = ?)
       ORDER BY t.created_at, t.id`,
    )
    .all(root, entryId, entryId) as unknown as Array<{ id: string; target: string }>;
  const q = statements(db);
  const hows = db.prepare(
    `SELECT DISTINCT x.how FROM tombstone_effect x JOIN entry en ON en.id = x.item
     WHERE x.tombstone_id = ? AND x.kind = 'entry' AND en.root = ? AND en.id <> ?`,
  );
  for (const t of concerned) {
    // A chain is covered as a whole: the new version joins it, however the forget covers it.
    let grown = false;
    for (const r of hows.all(t.id, root, entryId) as unknown as Array<{ how: How }>) {
      if (Number(q.addRow.run(t.id, 'entry', entryId, r.how).changes) > 0) grown = true;
    }
    const applied = applyForget(db, q, t);
    if (grown || applied.grown) relog(db, 'tombstone', t.id, growthOrigin);
  }
}

/** A tombstone of this store with what it covers here, as it is sent to other stores. */
export function exportTombstone(db: Database, id: string): TombstoneRecord | null {
  const row = db
    .prepare(
      `SELECT t.id, t.target, t.reason, t.created_at, t.origin, m.author FROM tombstone t
       LEFT JOIN tombstone_meta m ON m.tombstone_id = t.id WHERE t.id = ?`,
    )
    .get(id) as
    | {
        id: string;
        target: string;
        reason: string | null;
        created_at: number;
        origin: string;
        author: string | null;
      }
    | undefined;
  if (!row) return null;
  const items = isRestoreTarget(row.target) ? noItems() : rowsOf(db, id);
  return {
    id: row.id,
    target: row.target,
    reason: row.reason,
    createdAt: row.created_at,
    origin: row.origin,
    ...(row.author ? { author: row.author } : {}),
    entries: [...items.entries],
    events: [...items.events],
  };
}
