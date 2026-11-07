import { createHash } from 'node:crypto';
import type { Database } from './database.js';
import { idList, pairList } from './dialect.js';
import { OriginError } from './errors.js';
import { IN_EFFECT } from './forgetting.js';
import { eachMirrorLine, readMirrorLine } from './mirror.js';
import { assertComplete } from './mode.js';
import { mirrorRelPath, remotePath } from './paths.js';
import { isOriginPlacesFile, parsePlaceLine } from './places.js';
import { continuationLine, isSkippedLine, type PurgedLookup, purgedLookup } from './purged.js';
import { type MirroredFile, mirroredLineParser } from './reparse.js';
import { threadIdOf } from './threads.js';
import type { ParsedLine, SourceAdapter } from './types.js';

/**
 * Purging (see docs/architecture.md): the owner's physical deletion of what a forget only hides.
 * A purge runs in three phases:
 *
 * 1. **Plan** (planPurge): reads only, outside any write transaction. It resolves a selector to
 *    events, entries, sessions, recalls, and mirror lines, and applies the rules below until no
 *    set grows. Its preview holds ids and counts, never text, and a digest of what it deletes.
 * 2. **Apply** (purge): one write transaction that deletes the rows, records the purge, and
 *    queues the mirrors whose lines it blanks.
 * 3. **Mirrors** (completePurges): blanks those lines in place, one mirror per short write
 *    transaction, resumable.
 *
 * The rules, applied until nothing changes:
 *
 * - P0, line closure. A purged event takes its whole raw line, and with it every other event that
 *   line yields, and every other line that yields any of them: a duplicate in a later generation
 *   of the same file, or one a hub stored because a writer sent it again. The candidate mirrors are
 *   parsed again with their sources' adapters to find them.
 * - P1, entries. An entry takes its whole chain (every version, forks included). A version derived
 *   from a native memory also takes its memory event, whose line holds the entry's text.
 * - P2, events. An event takes every chain that cites it: an entry never loses a source in place.
 * - P3, sessions. A session takes its events, its child sessions unless they are kept, its recalls,
 *   and the lines of its files that hold anything of it. A file whose every generation holds
 *   nothing of a session that stays is blocked: its later lines are stored blank.
 * - P4, proposals. A proposal whose event is purged goes; one whose cited events are all purged has
 *   lost its provenance, so its event is purged too.
 * - P5, forgotten. What a forget in effect covers, or everything hidden, goes by the rules above.
 * - P6, recall items. Items of recalls that stay are removed where they name what is purged.
 */

/** What a purge selects (one selector per purge): ids, a source, a path, times; never text. */
export type PurgeSelector =
  /** Events, with the lines they come from (P0). */
  | { kind: 'event'; ids: string[] }
  /** A session and, unless `keepChildren`, its child sessions (P3). */
  | { kind: 'session'; source: string; sessionId: string; keepChildren?: boolean }
  /** An entry's whole chain (P1). */
  | { kind: 'entry'; id: string }
  /** What a forget in effect covers on this store, or with `all`, everything hidden here (P5). */
  | { kind: 'forgotten'; tombstone: string }
  /**
   * Mirror lines of a source: of the files a device sent (`from`, the `@<name>:` of a hub's paths),
   * of a file by its path or its raw file id, a range of a file's lines, the lines that yield
   * events between two times (`since` inclusive, `until` exclusive, epoch ms), or the lines that
   * count as parse errors (`unparsed`, with `file` or `from` only). The filters given all apply.
   */
  | {
      kind: 'lines';
      source: string;
      from?: string;
      path?: string;
      file?: number;
      lines?: { first: number; last: number };
      since?: number;
      until?: number;
      unparsed?: boolean;
    }
  /** A recall and its items. */
  | { kind: 'recall'; id: string };

/** The adapters of the sources whose mirrors a purge parses: a list, or a lookup by source id. */
export type PurgeAdapters = SourceAdapter[] | ((source: string) => SourceAdapter | null);

/** A mirror whose lines a purge blanks. */
export interface PurgeFile {
  rawFileId: number;
  source: string;
  /** Its raw file's path: the original path, or `@<device>:<path>` on a hub. */
  path: string;
  generation: number;
  mirror: string;
  /** The lines blanked, as `[first, count]` ranges in order. */
  lines: Array<[number, number]>;
  /** It holds nothing of a session that stays: blocked, its later lines are stored blank. */
  blocked: boolean;
  /**
   * Its last line, of a generated source, is replaced with where the source goes on from (see
   * SourceAdapter.continuation) rather than blanked.
   */
  continued: boolean;
}

/** What a purge removes, or removed, on a store: numbers only. */
export interface PurgeCounts {
  /** Events deleted, and of those, the ones added because they share a raw line (P0). */
  events: number;
  closure: number;
  /** Entry versions deleted, and the chains they make up. */
  entries: number;
  chains: number;
  /** Sessions purged, and recalls deleted. */
  sessions: number;
  recalls: number;
  /** Items removed from recalls that stay (P6). */
  recallItems: number;
  /** Proposals deleted (P4). */
  proposals: number;
  /** Forgets that cover less, since some of what they covered is purged. */
  tombstones: number;
  /** Mirrors whose lines are blanked, those lines, and the files blocked. */
  mirrors: number;
  lines: number;
  files: number;
}

/** Something the owner should know before a purge: a code, a message, and how many it concerns. */
export interface PurgeWarning {
  code: 'large' | 'closure' | 'visible' | 'chains' | 'no-continuation';
  message: string;
  count: number;
}

/**
 * What a purge would remove (planPurge): ids and counts, never text. `digest` stands for what it
 * deletes: give it to `purge` to apply exactly this plan, or to have it refused if the store has
 * changed what it would delete.
 */
export interface PurgePlan {
  selector: PurgeSelector;
  digest: string;
  /** The events it deletes, and those of them added by line closure (P0). */
  events: string[];
  closure: string[];
  /** The entry versions it deletes, whole chains, and the roots of those chains. */
  entries: string[];
  chains: string[];
  sessions: Array<{ source: string; sessionId: string }>;
  recalls: string[];
  /** Items it removes from recalls that stay (P6). */
  recallItems: Array<{ recall: string; rank: number }>;
  proposals: string[];
  /** Forgets that cover what it deletes: they stay, covering less. */
  tombstones: string[];
  files: PurgeFile[];
  counts: PurgeCounts;
  warnings: PurgeWarning[];
  /** Why it cannot be applied as it is; `purge` refuses while there is any. */
  refusals: string[];
  /** What a purge never reaches. */
  limits: readonly string[];
}

/** Above this many events, the preview suggests smaller selectors: one transaction holds them all. */
export const PURGE_EVENTS_WARN = 200_000;

/** Purge ids: `prg_` and random hex, unique across stores. */
export const PURGE_ID_RE = /^prg_[0-9a-f]{12}$/;

/** What a purge does not reach. */
export const PURGE_LIMITS: readonly string[] = [
  'Backups made before the purge keep what it deletes; a later origin backup into the same directory copies the purged mirrors again.',
  'A bucket that keeps old versions of objects keeps the frames as they were.',
  "Stores the purge has not reached keep their copies: a device's purge stays on that device, and a hub's reaches its devices as they sync.",
  "Agents' own files (their session logs and memory files) are not touched: what an agent writes again arrives as new data, with new ids.",
  'In PostgreSQL, the write-ahead log, its archives, and dead rows keep deleted data until they are recycled or vacuumed.',
];

/** A raw file, as the plan reads it. */
interface RawFile extends MirroredFile {
  lines_ingested: number;
}

/** What one mirrored line holds, as the plan needs it: ids, sessions, and times. */
interface LineFacts {
  /** Its events: full id, session, and time. */
  events: Array<{ id: string; session: string; ts: number }>;
  /**
   * The sessions whose purge takes the line, as ingestion blanks a line on arrival (see removedBy
   * in ingest.ts): those of its events and the one it titles, and for a places line the sessions
   * it places and the child and parent a parent line names.
   */
  sessions: string[];
  /** The title it gives a session, to derive the title again from the lines that stay. */
  title: { session: string; text: string; manual: boolean } | null;
  /** It counts as a parse error: the adapter threw, or warned. */
  error: boolean;
}

/** A parsed candidate mirror: the facts of each line that is not blank, up to `parsedTo`. */
interface FileParse {
  file: RawFile;
  places: boolean;
  parsedTo: number;
  lines: Map<number, LineFacts>;
}

/** The columns of a stored event the plan reads. */
const EVENT_COLUMNS = 'id, seq, source, session_id, raw_file_id, raw_line';
interface EventRow {
  id: string;
  seq: number;
  source: string;
  session_id: string;
  raw_file_id: number;
  raw_line: number;
}

/** What a doomed event is known as. */
interface EventFacts {
  source: string;
  session: string;
  /** Its seq and raw file when it is stored; a line may yield events the store does not have. */
  seq: number | null;
  rawFileId: number | null;
}

const key = (source: string, sessionId: string) => `${source}\n${sessionId}`;
const unkey = (k: string) => {
  const at = k.indexOf('\n');
  return { source: k.slice(0, at), sessionId: k.slice(at + 1) };
};
const json = (values: Iterable<string | number>) => JSON.stringify([...values]);
const RAW_FILE_COLUMNS = 'id, source, path, generation, mirror, updated_at, lines_ingested';

/** A purge id of the length real ones have, to check that a continuation fits before there is one. */
const PLACEHOLDER_ID = 'prg_000000000000';

/** Session ids shorter than this are not looked for in file paths (see takeSessions). */
const PATH_MATCH_MIN = 8;

/** The adapter of a source, or null if none was given. */
export function adapterLookup(adapters: PurgeAdapters): (source: string) => SourceAdapter | null {
  if (typeof adapters === 'function') return (source) => adapters(source) ?? null;
  const byId = new Map(adapters.map((a) => [a.id, a]));
  return (source) => byId.get(source) ?? null;
}

/** Ranges `[first, count]` of a set of line numbers, in order. */
export function lineRanges(lines: Iterable<number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && last[0] + last[1] === n) last[1]++;
    else out.push([n, 1]);
  }
  return out;
}

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

/**
 * The work of one plan: the sets that grow until the rules add nothing, and the mirrors parsed to
 * find the lines that hold what they name. The parses are kept (`files`), so that applying the
 * plan, which plans again under the write lock, parses only the lines appended since.
 */
class Planner {
  readonly events = new Map<string, EventFacts>();
  /** Events added by line closure (P0): neither selected nor of a purged session. */
  readonly closure = new Set<string>();
  readonly chains = new Set<string>();
  readonly entries = new Set<string>();
  readonly sessions = new Set<string>();
  readonly recalls = new Set<string>();
  /** Lines to blank, by raw file. */
  readonly lines = new Map<number, Set<number>>();
  /** The raw files this plan reached, each parsed and indexed. */
  readonly reached = new Set<number>();
  /** Where each event id and session key is yielded, by raw file and line. */
  private readonly byEvent = new Map<string, Array<[number, number]>>();
  private readonly bySession = new Map<string, Array<[number, number]>>();
  private readonly queue = {
    events: [] as string[],
    roots: [] as string[],
    sessions: [] as string[],
    files: [] as number[],
  };
  private readonly adapter: (source: string) => SourceAdapter | null;
  private readonly purged: PurgedLookup;

  constructor(
    private readonly db: Database,
    private readonly home: string,
    adapters: PurgeAdapters,
    readonly selector: PurgeSelector,
    /** Parses of mirrors, kept from an earlier plan of the same purge. */
    readonly files: Map<number, FileParse> = new Map(),
  ) {
    this.adapter = adapterLookup(adapters);
    this.purged = purgedLookup(db);
  }

  /** Resolve the selector, then apply the rules until no set grows. */
  run(): this {
    this.seed();
    this.settle();
    return this;
  }

  adapterOf(source: string): SourceAdapter | null {
    return this.adapter(source);
  }

  // --- Seeds -----------------------------------------------------------------------------------

  private seed(): void {
    const s = this.selector;
    const d = this.db.dialect;
    switch (s.kind) {
      case 'event': {
        const ids = [...new Set(s.ids)];
        if (ids.length === 0) throw new OriginError('Name at least one event to purge.');
        const known = new Set(
          (
            this.db
              .prepare(`SELECT id FROM event WHERE id IN (${idList(d, 'text')})`)
              .all(json(ids)) as Array<{ id: string }>
          ).map((r) => r.id),
        );
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw new OriginError(`Unknown event ${unknown.slice(0, 5).join(', ')}.`);
        }
        for (const id of ids) this.addEvent(id);
        break;
      }
      case 'session': {
        const known =
          this.db
            .prepare('SELECT 1 AS one FROM session WHERE source = ? AND session_id = ?')
            .get(s.source, s.sessionId) ??
          this.db
            .prepare('SELECT 1 AS one FROM event WHERE source = ? AND session_id = ? LIMIT 1')
            .get(s.source, s.sessionId);
        if (!known) throw new OriginError(`Unknown session ${s.source}:${s.sessionId}.`);
        this.addSession(key(s.source, s.sessionId));
        break;
      }
      case 'entry': {
        const row = this.db.prepare('SELECT root FROM entry WHERE id = ?').get(s.id) as
          | { root: string }
          | undefined;
        if (!row) throw new OriginError(`Unknown entry ${s.id}.`);
        this.addChain(row.root);
        break;
      }
      case 'forgotten':
        this.seedForgotten(s.tombstone);
        break;
      case 'lines':
        this.seedLines(s);
        break;
      case 'recall':
        if (!this.db.prepare('SELECT 1 AS one FROM recall WHERE id = ?').get(s.id)) {
          throw new OriginError(`Unknown recall ${s.id}.`);
        }
        this.recalls.add(s.id);
        break;
      default:
        throw new OriginError('Unknown kind of purge selector.');
    }
  }

  /** P5: what a forget in effect covers here, in any of its ways, or everything hidden here. */
  private seedForgotten(tombstone: string): void {
    let entries: string[];
    let events: string[];
    if (tombstone === 'all') {
      entries = (
        this.db.prepare('SELECT entry_id FROM forgotten_entry').all() as Array<{ entry_id: string }>
      ).map((r) => r.entry_id);
      events = (
        this.db.prepare('SELECT event_id FROM excluded_event').all() as Array<{ event_id: string }>
      ).map((r) => r.event_id);
    } else {
      const t = this.db.prepare('SELECT target FROM tombstone WHERE id = ?').get(tombstone) as
        | { target: string }
        | undefined;
      if (!t) throw new OriginError(`Unknown forget ${tombstone}.`);
      if (t.target.startsWith('tmb_')) {
        throw new OriginError(
          `${tombstone} is a restore; only what a forget covers can be purged.`,
        );
      }
      const inEffect = this.db
        .prepare(`SELECT 1 AS one FROM tombstone t WHERE t.id = ? AND ${IN_EFFECT}`)
        .get(tombstone);
      if (!inEffect) {
        throw new OriginError(
          `${tombstone} has been restored, so what it covered is visible again; purge that by its ids.`,
        );
      }
      const rows = this.db
        .prepare('SELECT DISTINCT kind, item FROM tombstone_effect WHERE tombstone_id = ?')
        .all(tombstone) as Array<{ kind: string; item: string }>;
      entries = rows.filter((r) => r.kind === 'entry').map((r) => r.item);
      events = rows.filter((r) => r.kind === 'event').map((r) => r.item);
    }
    const d = this.db.dialect;
    for (const r of this.db
      .prepare(`SELECT DISTINCT root FROM entry WHERE id IN (${idList(d, 'text')})`)
      .all(json(entries)) as Array<{ root: string }>) {
      this.addChain(r.root);
    }
    for (const r of this.db
      .prepare(`SELECT id FROM event WHERE id IN (${idList(d, 'text')})`)
      .all(json(events)) as Array<{ id: string }>) {
      this.addEvent(r.id);
    }
  }

  /** Lines of a source's mirrors, as the `lines` selector names them. */
  private seedLines(s: Extract<PurgeSelector, { kind: 'lines' }>): void {
    if (!s.source) throw new OriginError('Name the source whose lines to purge.');
    if (s.lines && s.file === undefined) {
      throw new OriginError('A range of lines needs the raw file it is in (--file).');
    }
    if (
      s.lines &&
      !(Number.isInteger(s.lines.first) && s.lines.first >= 1 && s.lines.last >= s.lines.first)
    ) {
      throw new OriginError('A range of lines goes from its first line, 1 or more, to its last.');
    }
    if (s.unparsed && s.file === undefined && s.from === undefined) {
      throw new OriginError(
        'Unparsed lines are purged only of one raw file (--file) or of what one device or writer sent (--from).',
      );
    }
    const where = ['source = ?'];
    const params: Array<string | number> = [s.source];
    if (s.from !== undefined) {
      const prefix = remotePath(s.from, '');
      where.push('substr(path, 1, ?) = ?');
      params.push(prefix.length, prefix);
    }
    if (s.path !== undefined) {
      where.push('path = ?');
      params.push(s.from !== undefined ? remotePath(s.from, s.path) : s.path);
    }
    if (s.file !== undefined) {
      where.push('id = ?');
      params.push(s.file);
    }
    const files = this.db
      .prepare(`SELECT id FROM raw_file WHERE ${where.join(' AND ')} ORDER BY id`)
      .all(...params) as Array<{ id: number }>;
    if (files.length === 0) throw new OriginError(`No mirrored file of ${s.source} matches.`);
    const timed = s.since !== undefined || s.until !== undefined;
    const inTime = (ts: number) =>
      (s.since === undefined || ts >= s.since) && (s.until === undefined || ts < s.until);
    for (const { id } of files) {
      this.addFile(id);
      const parse = this.parse(id);
      if (!parse) continue;
      for (const [n, facts] of parse.lines) {
        if (s.lines && (n < s.lines.first || n > s.lines.last)) continue;
        if (s.unparsed && !facts.error) continue;
        if (timed && !facts.events.some((e) => inTime(e.ts))) continue;
        this.addLine(id, n, false);
      }
    }
  }

  // --- The sets ------------------------------------------------------------------------------

  private addEvent(id: string, facts?: { source: string; session: string }): boolean {
    if (this.events.has(id)) return false;
    this.events.set(id, {
      source: facts?.source ?? '',
      session: facts?.session ?? '',
      seq: null,
      rawFileId: null,
    });
    this.queue.events.push(id);
    return true;
  }

  private addChain(root: string): void {
    if (this.chains.has(root)) return;
    this.chains.add(root);
    this.queue.roots.push(root);
  }

  private addSession(k: string): void {
    if (this.sessions.has(k)) return;
    this.sessions.add(k);
    this.queue.sessions.push(k);
  }

  /** A raw file whose lines may hold what is purged: parsed, with its other generations. */
  private addFile(id: number): void {
    if (this.reached.has(id)) return;
    this.reached.add(id);
    this.queue.files.push(id);
  }

  /** Blank line `n` of raw file `id`, and purge every event it yields (P0). */
  private addLine(id: number, n: number, closure = true): void {
    let set = this.lines.get(id);
    if (!set) {
      set = new Set();
      this.lines.set(id, set);
    }
    if (set.has(n)) return;
    set.add(n);
    this.closeLine(id, n, closure);
  }

  /** Purge every event a blanked line yields, once its file is parsed (P0). */
  private closeLine(id: number, n: number, closure: boolean): void {
    const parse = this.files.get(id);
    const facts = parse?.lines.get(n);
    if (!parse || !facts || !this.indexed.has(id)) return;
    const source = parse.file.source;
    for (const ev of facts.events) {
      const added = this.addEvent(ev.id, { source, session: ev.session });
      if (added && closure) this.closure.add(ev.id);
    }
  }

  // --- The rules -----------------------------------------------------------------------------

  /** Apply the rules until every queue is empty. */
  private settle(): void {
    for (;;) {
      if (this.queue.sessions.length > 0) this.takeSessions(this.queue.sessions.splice(0));
      else if (this.queue.roots.length > 0) this.takeChains(this.queue.roots.splice(0));
      else if (this.queue.events.length > 0) this.takeEvents(this.queue.events.splice(0));
      else if (this.queue.files.length > 0) this.takeFiles(this.queue.files.splice(0));
      else break;
    }
  }

  /** P3: a session's children, events, recalls, and the files that may hold its lines. */
  private takeSessions(keys: string[]): void {
    const d = this.db.dialect;
    const pairs = JSON.stringify(
      keys.map((k) => {
        const { source, sessionId } = unkey(k);
        return [source, sessionId];
      }),
    );
    const s = this.selector;
    if (!(s.kind === 'session' && s.keepChildren)) {
      for (const c of this.db
        .prepare(
          `SELECT source, session_id FROM session_parent
            WHERE (parent_source, parent_session_id) IN (${pairList(d)})`,
        )
        .all(pairs) as Array<{ source: string; session_id: string }>) {
        this.addSession(key(c.source, c.session_id));
      }
    }
    for (const e of this.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM event WHERE (source, session_id) IN (${pairList(d)})`)
      .all(pairs) as unknown as EventRow[]) {
      this.known(e);
    }
    for (const r of this.db
      .prepare(`SELECT id FROM recall WHERE (source, session_id) IN (${pairList(d)})`)
      .all(pairs) as Array<{ id: string }>) {
      this.recalls.add(r.id);
    }
    const sources = new Set<string>();
    // A file named after the session, such as a title stream, which yields no events of it.
    const named = this.db.prepare(
      'SELECT id FROM raw_file WHERE source = ? AND instr(path, ?) > 0 ORDER BY id',
    );
    for (const k of keys) {
      const { source, sessionId } = unkey(k);
      sources.add(source);
      if (sessionId.length >= PATH_MATCH_MIN) {
        for (const r of named.all(source, sessionId) as Array<{ id: number }>) this.addFile(r.id);
      }
      for (const [id, n] of this.bySession.get(k) ?? []) this.addLine(id, n);
    }
    // Origin's places files, which place the sessions of the source on this store or a device.
    const places = this.db.prepare(
      `SELECT id FROM raw_file WHERE source = ?
          AND (path = 'places.jsonl' OR path LIKE '@%:places.jsonl') ORDER BY id`,
    );
    for (const source of sources) {
      for (const r of places.all(source) as Array<{ id: number }>) this.addFile(r.id);
    }
  }

  /** Purge a stored event with its own line; its mirror is a candidate. */
  private known(e: EventRow): void {
    this.addEvent(e.id);
    const facts = this.events.get(e.id) as EventFacts;
    if (facts.seq !== null) return;
    facts.source = e.source;
    facts.session = e.session_id;
    facts.seq = e.seq;
    facts.rawFileId = e.raw_file_id;
    this.addLine(e.raw_file_id, e.raw_line);
    this.addFile(e.raw_file_id);
  }

  /** P1: every version of a chain; a version derived from a native memory takes its event. */
  private takeChains(roots: string[]): void {
    const d = this.db.dialect;
    const versions = (
      this.db
        .prepare(`SELECT id FROM entry WHERE root IN (${idList(d, 'text')})`)
        .all(json(roots)) as Array<{ id: string }>
    ).map((r) => r.id);
    for (const v of versions) this.entries.add(v);
    for (const r of this.db
      .prepare(
        `SELECT s.event_id FROM entry_source s JOIN imported_entry i ON i.entry_id = s.entry_id
          WHERE s.entry_id IN (${idList(d, 'text')})`,
      )
      .all(json(versions)) as Array<{ event_id: string }>) {
      this.addEvent(r.event_id);
    }
  }

  /** P0, P2, and P4 for events newly purged. */
  private takeEvents(ids: string[]): void {
    const d = this.db.dialect;
    const list = json(ids);
    const unknown = ids.filter((id) => this.events.get(id)?.seq === null);
    if (unknown.length > 0) {
      for (const e of this.db
        .prepare(`SELECT ${EVENT_COLUMNS} FROM event WHERE id IN (${idList(d, 'text')})`)
        .all(json(unknown)) as unknown as EventRow[]) {
        this.known(e);
      }
    }
    for (const id of ids) for (const [f, n] of this.byEvent.get(id) ?? []) this.addLine(f, n);
    // P2: every chain that cites one.
    for (const r of this.db
      .prepare(
        `SELECT DISTINCT en.root FROM entry_source s JOIN entry en ON en.id = s.entry_id
          WHERE s.event_id IN (${idList(d, 'text')})`,
      )
      .all(list) as Array<{ root: string }>) {
      this.addChain(r.root);
    }
    // P4: a proposal whose cited events are all purged loses its own event.
    const citing = this.db
      .prepare(
        `SELECT DISTINCT p.id, p.event_id FROM proposal p
           JOIN proposal_source s ON s.proposal_id = p.id
          WHERE s.event_id IN (${idList(d, 'text')})`,
      )
      .all(list) as Array<{ id: string; event_id: string }>;
    const cites = this.db.prepare('SELECT event_id FROM proposal_source WHERE proposal_id = ?');
    for (const p of citing) {
      if (this.events.has(p.event_id)) continue;
      const cited = (cites.all(p.id) as Array<{ event_id: string }>).map((r) => r.event_id);
      if (cited.every((e) => this.events.has(e) || this.purged.event(e) !== null)) {
        this.addEvent(p.event_id);
      }
    }
  }

  /** P0: parse the candidate mirrors, with every generation of their files. */
  private takeFiles(ids: number[]): void {
    const d = this.db.dialect;
    for (const r of this.db
      .prepare(
        `SELECT g.id FROM raw_file f JOIN raw_file g ON g.source = f.source AND g.path = f.path
          WHERE f.id IN (${idList(d, 'bigint')}) ORDER BY g.id`,
      )
      .all(json(ids)) as Array<{ id: number }>) {
      this.addFile(r.id);
    }
    for (const id of ids) this.parse(id);
  }

  // --- Parsing -------------------------------------------------------------------------------

  /** Parses and indexes each file once per plan. */
  private readonly indexed = new Set<number>();

  /**
   * Parse a candidate mirror, or the lines appended to it since an earlier plan parsed it; index
   * its lines, and blank those that hold what is purged by now. Null for an unknown raw file.
   */
  private parse(id: number): FileParse | null {
    const known = this.files.get(id);
    if (known && this.indexed.has(id)) return known;
    const file = this.db.prepare(`SELECT ${RAW_FILE_COLUMNS} FROM raw_file WHERE id = ?`).get(id) as
      | RawFile
      | undefined;
    if (!file) return null;
    const parse: FileParse = known ?? {
      file,
      places: isOriginPlacesFile(mirrorRelPath(file), file.path),
      parsedTo: 0,
      lines: new Map(),
    };
    parse.file = file;
    this.files.set(id, parse);
    if (file.lines_ingested > parse.parsedTo) {
      const read = this.reader(parse);
      eachMirrorLine(this.db, this.home, id, parse.parsedTo + 1, (line, n) => {
        if (!isSkippedLine(line)) parse.lines.set(n, read(line, n));
      });
      parse.parsedTo = file.lines_ingested;
    }
    this.indexed.add(id);
    for (const [n, facts] of parse.lines) {
      for (const ev of facts.events) push(this.byEvent, ev.id, [id, n] as [number, number]);
      for (const s of facts.sessions) push(this.bySession, s, [id, n] as [number, number]);
      if (
        facts.events.some((e) => this.events.has(e.id)) ||
        facts.sessions.some((s) => this.sessions.has(s))
      ) {
        this.addLine(id, n);
      }
    }
    // Lines blanked before the file was parsed: the lines of events the store holds.
    for (const n of this.lines.get(id) ?? []) this.closeLine(id, n, true);
    return parse;
  }

  /** What a line of a file holds: through Origin's places parser, or the source's adapter. */
  private reader(parse: FileParse): (line: string, n: number) => LineFacts {
    const f = parse.file;
    let parseLine: (line: string, n: number) => ParsedLine | null;
    if (parse.places) parseLine = (line) => parsePlaceLine(line);
    else {
      const adapter = this.adapter(f.source);
      if (!adapter) {
        throw new OriginError(
          `A purge reads the ${f.source} mirrors again, which needs the ${f.source} adapter: purge with the origin command.`,
        );
      }
      parseLine = mirroredLineParser(this.db, this.home, adapter, f);
    }
    return (line, n) => {
      const facts: LineFacts = { events: [], sessions: [], title: null, error: false };
      let parsed: ParsedLine | null;
      try {
        parsed = parseLine(line, n);
      } catch {
        facts.error = true;
        return facts;
      }
      if (!parsed) return facts;
      if (parsed.warning) {
        facts.error = true;
        return facts;
      }
      const sessions = new Set<string>();
      for (const ev of parsed.events) {
        facts.events.push({ id: `${f.source}:${ev.id}`, session: ev.sessionId, ts: ev.ts });
        sessions.add(key(f.source, ev.sessionId));
      }
      if (parsed.sessionTitle && parsed.sessionId) {
        facts.title = {
          session: parsed.sessionId,
          text: parsed.sessionTitle,
          manual: parsed.manualTitle === true,
        };
        sessions.add(key(f.source, parsed.sessionId));
      }
      if (parse.places) {
        for (const p of parsed.places ?? []) sessions.add(key(f.source, p.sessionId));
        for (const p of parsed.sessionParents ?? []) {
          sessions.add(key(f.source, p.sessionId));
          sessions.add(key(p.parentSource ?? f.source, p.parentSessionId));
        }
      }
      facts.sessions = [...sessions];
      return facts;
    };
  }

  // --- After the rules -----------------------------------------------------------------------

  /**
   * The raw files to block: every generation of a file (other than Origin's places) holds nothing
   * of a session that stays (P3). Their every line is blanked. Only once sessions are purged.
   */
  blockedFiles(): Set<number> {
    const blocked = new Set<number>();
    if (this.sessions.size === 0) return blocked;
    const byPath = new Map<string, FileParse[]>();
    for (const id of this.reached) {
      const parse = this.files.get(id);
      if (parse) push(byPath, `${parse.file.source}\n${parse.file.path}`, parse);
    }
    const named = (path: string) =>
      [...this.sessions].some((k) => {
        const { sessionId } = unkey(k);
        return sessionId.length >= PATH_MATCH_MIN && path.includes(sessionId);
      });
    for (const parses of byPath.values()) {
      let any = false;
      const whole = parses.every((p) => {
        if (p.places) return false;
        // A generated stream goes on with whatever sessions come next, unless it is the session's.
        if (this.generated(p) && !named(p.file.path)) return false;
        for (const facts of p.lines.values()) {
          if (facts.events.length === 0 && facts.title === null) continue;
          const sessions = facts.events.map((e) => key(p.file.source, e.session));
          if (facts.title) sessions.push(key(p.file.source, facts.title.session));
          if (!sessions.every((s) => this.sessions.has(s))) return false;
          any = true;
        }
        return true;
      });
      if (!whole || !any) continue;
      for (const p of parses) {
        blocked.add(p.file.id);
        for (let n = 1; n <= p.file.lines_ingested; n++) this.addLine(p.file.id, n);
      }
    }
    return blocked;
  }

  /**
   * Whether a parsed file is a generated source's: its adapter says what next() reads of its last
   * line that is not blank (see SourceAdapter.continuation).
   */
  private generated(p: FileParse): boolean {
    const adapter = p.places ? null : this.adapter(p.file.source);
    if (!adapter?.continuation || p.lines.size === 0) return false;
    let last = 0;
    for (const n of p.lines.keys()) if (n > last) last = n;
    const line = readMirrorLine(this.db, this.home, p.file.id, last);
    if (line === null) return false;
    try {
      const fields = adapter.continuation(line, { relPath: mirrorRelPath(p.file) });
      return typeof fields === 'object' && fields !== null;
    } catch {
      return false;
    }
  }

  /**
   * Whether the last line of a raw file, if it is blanked, is that of a generated source of this
   * store, which goes on from it (see SourceAdapter.continuation): its replacement, or a refusal
   * when the source cannot go on from one. Null when the line is simply blanked.
   */
  continuation(id: number): { line: string } | { refusal: string } | null {
    const parse = this.files.get(id);
    if (!parse) return null;
    const f = parse.file;
    if (f.path.startsWith('@') || parse.places || !this.lines.get(id)?.has(f.lines_ingested)) {
      return null;
    }
    const line = readMirrorLine(this.db, this.home, id, f.lines_ingested);
    if (line === null || isSkippedLine(line)) return null;
    const adapter = this.adapter(f.source);
    const relPath = mirrorRelPath(f);
    let fields: unknown = null;
    try {
      fields = adapter?.continuation?.(line, { relPath }) ?? null;
    } catch {
      fields = null;
    }
    // Only a generated source's adapter says what its next() reads of a line.
    if (typeof fields !== 'object' || fields === null || !adapter) return null;
    const replaced = continuationLine(adapter, line, relPath, PLACEHOLDER_ID);
    if (replaced !== null) return { line: replaced };
    return {
      refusal: `The last line of ${f.mirror} is purged, and the ${f.source} adapter has no shorter line to go on from: blanking it would end that source. Purge fewer lines of it, or after it has written more.`,
    };
  }
}

/** The plan of a purge, with what applying it reuses: the parses of its mirrors. */
interface PlanState {
  planner: Planner;
  blocked: Set<number>;
  continued: Map<number, string>;
}

const states = new WeakMap<PurgePlan, PlanState>();

/** Run the rules, and describe what they give as a plan. */
function makePlan(
  db: Database,
  home: string,
  adapters: PurgeAdapters,
  selector: PurgeSelector,
  parses?: Map<number, FileParse>,
): PurgePlan {
  assertComplete(db, 'purge');
  const planner = new Planner(db, home, adapters, selector, parses).run();
  const blocked = planner.blockedFiles();
  const continued = new Map<number, string>();
  const refusals: string[] = [];
  for (const id of planner.lines.keys()) {
    if (blocked.has(id)) continue;
    const c = planner.continuation(id);
    if (c && 'refusal' in c) refusals.push(c.refusal);
    else if (c) continued.set(id, c.line);
  }

  const d = db.dialect;
  const stored = [...planner.events].filter(([, e]) => e.seq !== null).map(([id]) => id);
  const allEvents = json(planner.events.keys());
  const entries = json(planner.entries);
  const doomed = [...planner.sessions].map(unkey);
  const sessionRefs = json(doomed.map((s) => `${s.source}:${s.sessionId}`));
  // A thread's id is its root session's: a thread rooted at a purged session is gone.
  const threadRefs = json(doomed.map((s) => threadIdOf(s.source, s.sessionId)));
  const recallItems = (
    db
      .prepare(
        `SELECT recall_id, rank FROM recall_item
          WHERE recall_id NOT IN (${idList(d, 'text')})
            AND ((kind = 'entry' AND ref IN (${idList(d, 'text')}))
              OR (kind = 'event' AND ref IN (${idList(d, 'text')}))
              OR (kind = 'session' AND ref IN (${idList(d, 'text')}))
              OR (kind = 'thread' AND ref IN (${idList(d, 'text')})))
          ORDER BY recall_id, rank`,
      )
      .all(json(planner.recalls), entries, allEvents, sessionRefs, threadRefs) as Array<{
      recall_id: string;
      rank: number;
    }>
  ).map((r) => ({ recall: r.recall_id, rank: r.rank }));
  const tombstones = (
    db
      .prepare(
        `SELECT DISTINCT tombstone_id FROM tombstone_effect
          WHERE (kind = 'entry' AND item IN (${idList(d, 'text')}))
             OR (kind = 'event' AND item IN (${idList(d, 'text')}))
          ORDER BY tombstone_id`,
      )
      .all(entries, allEvents) as Array<{ tombstone_id: string }>
  ).map((r) => r.tombstone_id);
  const proposals = (
    db
      .prepare(`SELECT id FROM proposal WHERE event_id IN (${idList(d, 'text')}) ORDER BY id`)
      .all(allEvents) as Array<{ id: string }>
  ).map((r) => r.id);

  const files: PurgeFile[] = [];
  for (const [id, lines] of [...planner.lines].sort(([a], [b]) => a - b)) {
    const f = planner.files.get(id)?.file;
    if (!f || lines.size === 0) continue;
    files.push({
      rawFileId: id,
      source: f.source,
      path: f.path,
      generation: f.generation,
      mirror: f.mirror,
      lines: lineRanges([...lines].filter((n) => n >= 1 && n <= f.lines_ingested)),
      blocked: blocked.has(id),
      continued: continued.has(id),
    });
  }
  const sorted = (values: Iterable<string>) => [...values].sort();
  const events = sorted(stored);
  // Events of a purged session are its own, whichever way the plan reached them.
  const closure = events.filter((id) => {
    const e = planner.events.get(id) as EventFacts;
    return planner.closure.has(id) && !planner.sessions.has(key(e.source, e.session));
  });
  const sessions = sorted(planner.sessions).map(unkey);
  const plan: Omit<PurgePlan, 'digest' | 'counts' | 'warnings'> = {
    selector,
    events,
    closure,
    entries: sorted(planner.entries),
    chains: sorted(planner.chains),
    sessions,
    recalls: sorted(planner.recalls),
    recallItems,
    proposals,
    tombstones,
    files,
    refusals,
    limits: PURGE_LIMITS,
  };
  const counts: PurgeCounts = {
    events: events.length,
    closure: closure.length,
    entries: plan.entries.length,
    chains: plan.chains.length,
    sessions: sessions.length,
    recalls: plan.recalls.length,
    recallItems: recallItems.length,
    proposals: proposals.length,
    tombstones: tombstones.length,
    mirrors: files.length,
    lines: files.reduce((n, f) => n + f.lines.reduce((m, [, c]) => m + c, 0), 0),
    files: new Set(files.filter((f) => f.blocked).map((f) => `${f.source}\n${f.path}`)).size,
  };
  const warnings = planWarnings(db, plan, counts);
  const full: PurgePlan = { ...plan, digest: planDigest(plan), counts, warnings };
  states.set(full, { planner, blocked, continued });
  return full;
}

/** What the owner should know about a plan before applying it. */
function planWarnings(
  db: Database,
  plan: Omit<PurgePlan, 'digest' | 'counts' | 'warnings'>,
  counts: PurgeCounts,
): PurgeWarning[] {
  const warnings: PurgeWarning[] = [];
  if (counts.events > PURGE_EVENTS_WARN) {
    warnings.push({
      code: 'large',
      count: counts.events,
      message: `This purge deletes ${counts.events} events in one transaction, which blocks other writes until it is done; consider smaller selectors.`,
    });
  }
  if (plan.closure.length > 0) {
    warnings.push({
      code: 'closure',
      count: plan.closure.length,
      message: `${plan.closure.length} events are added because they share a raw line with what was selected.`,
    });
  }
  if (plan.selector.kind === 'forgotten' && plan.events.length > 0) {
    const visible = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM event e WHERE e.id IN (${idList(db.dialect, 'text')})
              AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)`,
        )
        .get(JSON.stringify(plan.events)) as { n: number }
    ).n;
    if (visible > 0) {
      warnings.push({
        code: 'visible',
        count: visible,
        message: `${visible} events that are not forgotten are purged too: they share a raw line with forgotten ones, or a proposal lost every source.`,
      });
    }
  }
  if (plan.selector.kind !== 'entry' && plan.chains.length > 0) {
    warnings.push({
      code: 'chains',
      count: plan.chains.length,
      message: `${plan.chains.length} entries cite what is purged and are deleted whole, every version; to keep what one says, first remember a new entry that cites events that stay.`,
    });
  }
  if (plan.refusals.length > 0) {
    warnings.push({
      code: 'no-continuation',
      count: plan.refusals.length,
      message: plan.refusals.join(' '),
    });
  }
  return warnings;
}

/** A digest of what a plan deletes: the same plan has the same digest, on any store. */
function planDigest(plan: Omit<PurgePlan, 'digest' | 'counts' | 'warnings'>): string {
  const what = {
    v: 1,
    selector: plan.selector,
    events: plan.events,
    entries: plan.entries,
    sessions: plan.sessions.map((s) => [s.source, s.sessionId]),
    recalls: plan.recalls,
    recallItems: plan.recallItems.map((i) => [i.recall, i.rank]),
    files: plan.files.map((f) => [f.rawFileId, f.lines, f.blocked, f.continued]),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 32)}`;
}

/**
 * What a purge with this selector would remove on this store, and what it would blank in the raw
 * mirrors: ids and counts, never text (see PurgePlan). Reads only; it parses the mirrors that may
 * hold what is purged again, which needs the adapters of their sources. Throws an OriginError for
 * a selector that names nothing this store holds.
 */
export function planPurge(
  db: Database,
  home: string,
  adapters: PurgeAdapters,
  selector: PurgeSelector,
): PurgePlan {
  return makePlan(db, home, adapters, normalizeSelector(selector));
}

/** A selector as a purge records it: only the fields its kind has, checked. */
function normalizeSelector(s: PurgeSelector): PurgeSelector {
  const text = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 4096) {
      throw new OriginError(`Invalid ${what}.`);
    }
    return v;
  };
  const time = (v: unknown, what: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new OriginError(`Invalid ${what}.`);
    return v;
  };
  switch (s?.kind) {
    case 'event':
      if (!Array.isArray(s.ids)) throw new OriginError('Invalid event ids.');
      return { kind: 'event', ids: s.ids.map((id) => text(id, 'event id')) };
    case 'session':
      return {
        kind: 'session',
        source: text(s.source, 'source'),
        sessionId: text(s.sessionId, 'session id'),
        ...(s.keepChildren ? { keepChildren: true } : {}),
      };
    case 'entry':
      return { kind: 'entry', id: text(s.id, 'entry id') };
    case 'forgotten':
      return { kind: 'forgotten', tombstone: text(s.tombstone, 'forget id') };
    case 'recall':
      return { kind: 'recall', id: text(s.id, 'recall id') };
    case 'lines': {
      const out: Extract<PurgeSelector, { kind: 'lines' }> = {
        kind: 'lines',
        source: text(s.source, 'source'),
      };
      if (s.from !== undefined) out.from = text(s.from, 'device or writer');
      if (s.path !== undefined) out.path = text(s.path, 'path');
      if (s.file !== undefined) {
        if (!Number.isSafeInteger(s.file) || s.file < 1)
          throw new OriginError('Invalid raw file id.');
        out.file = s.file;
      }
      if (s.lines !== undefined) {
        const first = time(s.lines?.first, 'first line');
        const last = time(s.lines?.last, 'last line');
        if (first === undefined || last === undefined)
          throw new OriginError('Invalid range of lines.');
        out.lines = { first, last };
      }
      const since = time(s.since, 'time');
      const until = time(s.until, 'time');
      if (since !== undefined) out.since = since;
      if (until !== undefined) out.until = until;
      if (s.unparsed) out.unparsed = true;
      return out;
    }
    default:
      throw new OriginError('Unknown kind of purge selector.');
  }
}
