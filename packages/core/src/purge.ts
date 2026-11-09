import { createHash, randomBytes } from 'node:crypto';
import { recordAudit } from './audit.js';
import type { Database } from './database.js';
import { transaction } from './db.js';
import { idList, pairList } from './dialect.js';
import { ConflictError, OriginError } from './errors.js';
import { checkReason, IN_EFFECT } from './forgetting.js';
import { BucketFrameStore, frameBucket, frameStore, replayFrameJournals } from './frames.js';
import { storeName } from './identity.js';
import { refreshSession } from './ingest.js';
import { blankMirror, eachMirrorLine, type MirrorBlanking, readMirrorLine } from './mirror.js';
import { assertComplete } from './mode.js';
import { mirrorRelPath, parseRawPath, remotePath } from './paths.js';
import { isOriginPlacesFile, parsePlaceLine } from './places.js';
import {
  continuationLine,
  isSkippedLine,
  type PurgedLookup,
  purgedLookup,
  RECALL_SEQ_FLOOR,
} from './purged.js';
import { type MirroredFile, mirroredLineParser } from './reparse.js';
import { getSetting, setSetting } from './settings.js';
import { refreshThreads, threadIdOf } from './threads.js';
import { NAME_RE } from './tokens.js';
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
    /** What a purge made on another store removed there, in place of the selector's own seeds. */
    private readonly given: PurgeItems | null = null,
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
    if (this.given) {
      this.seedGiven(this.given);
      return;
    }
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

  /**
   * What a hub's purge removed there (see applyHubPurge), as far as this store holds it: the rules
   * then run from these ids as from a selector's, since this store may hold more of a session, or
   * other lines that yield the same events. Ids this store does not hold are passed over.
   */
  private seedGiven(g: PurgeItems): void {
    const d = this.db.dialect;
    for (const r of this.db
      .prepare(`SELECT id FROM event WHERE id IN (${idList(d, 'text')}) ORDER BY id`)
      .all(json(g.events)) as Array<{ id: string }>) {
      this.addEvent(r.id);
    }
    for (const r of this.db
      .prepare(`SELECT DISTINCT root FROM entry WHERE id IN (${idList(d, 'text')}) ORDER BY root`)
      .all(json(g.entries)) as Array<{ root: string }>) {
      this.addChain(r.root);
    }
    const pairs = JSON.stringify(g.sessions);
    for (const r of this.db
      .prepare(
        `SELECT source, session_id FROM session WHERE (source, session_id) IN (${pairList(d)})
         UNION
         SELECT DISTINCT source, session_id FROM event WHERE (source, session_id) IN (${pairList(d)})
         ORDER BY 1, 2`,
      )
      .all(pairs, pairs) as Array<{ source: string; session_id: string }>) {
      this.addSession(key(r.source, r.session_id));
    }
    for (const r of this.db
      .prepare(`SELECT id FROM recall WHERE id IN (${idList(d, 'text')}) ORDER BY id`)
      .all(json(g.recalls)) as Array<{ id: string }>) {
      this.recalls.add(r.id);
    }
    // Files the hub blocked are candidates here: the rules decide whether they are blocked here too.
    const file = this.db.prepare(
      'SELECT id FROM raw_file WHERE source = ? AND path = ? ORDER BY generation',
    );
    for (const [source, path] of g.files) {
      for (const r of file.all(source, path) as Array<{ id: number }>) this.addFile(Number(r.id));
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
      else if (!this.closeStored()) break;
    }
  }

  /** The stored events of sessions that keep some, by session: their raw lines. */
  private readonly stored = new Map<
    string,
    Array<{ id: string; raw_file_id: number; raw_line: number }>
  >();

  /**
   * P0 as the store records it: an event whose raw line is blanked goes too, even if parsing the
   * line again no longer yields its id (as an older adapter's may not). Only sessions that keep
   * events are read; a purged session goes whole. True if it added any.
   */
  private closeStored(): boolean {
    const sessions = new Set<string>();
    for (const e of this.events.values()) {
      if (e.seq === null) continue;
      const k = key(e.source, e.session);
      if (!this.sessions.has(k)) sessions.add(k);
    }
    let added = false;
    for (const k of sessions) {
      let rows = this.stored.get(k);
      if (!rows) {
        const { source, sessionId } = unkey(k);
        rows = this.db
          .prepare(
            'SELECT id, raw_file_id, raw_line FROM event WHERE source = ? AND session_id = ?',
          )
          .all(source, sessionId) as Array<{ id: string; raw_file_id: number; raw_line: number }>;
        this.stored.set(k, rows);
      }
      for (const r of rows) {
        if (this.events.has(r.id)) continue;
        if (!this.lines.get(Number(r.raw_file_id))?.has(Number(r.raw_line))) continue;
        this.addEvent(r.id);
        this.closure.add(r.id);
        added = true;
      }
    }
    return added;
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
  given?: PurgeItems,
): PurgePlan {
  assertComplete(db, 'purge');
  const planner = new Planner(db, home, adapters, selector, parses, given ?? null).run();
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

// --- Apply -----------------------------------------------------------------------------------

/** How a purge was asked for, as the audit log names it, or `hub` for one a hub sent. */
export type PurgeChannel = 'cli' | 'ui' | 'api' | 'hub';

/** What a purge kept but changed: forgets that cover less, recalls that list fewer items. */
export interface PurgeTouched {
  tombstones: string[];
  recalls: string[];
}

/**
 * A purge as a store records it (`purge`): who made it, through what, and why; what it selected;
 * and how much it removed on this store. Ids and numbers, never text.
 */
export interface PurgeRecord {
  seq: number;
  id: string;
  at: number;
  /** The store that made it. */
  origin: string;
  author: string;
  channel: PurgeChannel;
  reason: string;
  selector: PurgeSelector;
  counts: PurgeCounts;
  touched: PurgeTouched;
  /** The highest event seq it deleted: no new event is given a seq at or below it. */
  seqFloor: number | null;
  /** When it came from the hub, for one a hub sent. */
  receivedAt: number | null;
}

export interface PurgeOptions {
  /** Why, as a forget says why: required. */
  reason: string;
  /** Who purges, as `user@<store>`. */
  author: string;
  channel: Exclude<PurgeChannel, 'hub'>;
  /** Who the audit log names, if not the author: the admin UI's owner, say. */
  actor?: string;
  /** The plan the owner saw (planPurge): applied only if the store would still delete just that. */
  plan?: PurgePlan;
  /** The digest of the plan the owner saw, when the plan itself is not at hand. */
  digest?: string;
  /**
   * Blank the lines in the mirrors right after the purge commits (completePurges): the default.
   * With false they wait in purge_pending.
   */
  complete?: boolean;
  /** Stop starting mirrors after this long (see completePurges). */
  budgetMs?: number;
  log?: (message: string) => void;
  now?: number;
}

export interface PurgeResult {
  id: string;
  record: PurgeRecord;
  /** The plan applied, made again under the write lock. */
  plan: PurgePlan;
  /** What blanking the mirrors did, unless it was left for later (`complete: false`). */
  mirrors: PurgeCompletion | null;
  /** Mirrors whose lines are still to be blanked (see completePurges). */
  pending: number;
}

/** The guards a purge's write transaction lifts (see guard_lift in schema.ts). */
const LIFTED = ['event', 'entry', 'entry_source', 'imported_entry', 'recall', 'recall_item'];

/** The search tables of events, and of entries (see schema.ts). */
const EVENT_SEARCH = ['event_fts', 'message_fts', 'event_cjk'];
const ENTRY_SEARCH = ['entry_fts'];

/**
 * While the events a purge deletes are fewer than one in REBUILD_SHARE of the store's, it removes
 * each from the event search tables in place (FTS5 `secure-delete`): on a large index, that costs
 * tens of milliseconds an event (about 15 at 200,000 events, 35 at a million), about what building
 * the tables again costs for two to three thousand events. Beyond, it deletes them as usual and
 * then builds those tables again from the events kept, which takes time in proportion to the
 * store, not to what is deleted. Merging a table whole (`optimize`) would not do: the merged
 * segment can keep the markers of deleted rows, and with them the terms of the text deleted.
 */
const REBUILD_SHARE = 2000;

/**
 * Set the search tables of SQLite to drop what a purge deletes so that none of it stays in their
 * segments; returns how to finish once the rows are deleted (finishSearchDeletes).
 */
function prepareSearchDeletes(db: Database, events: number): SearchDeletes {
  const total = Number(
    (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event').get() as { n: number }).n,
  );
  const rebuild = events > 0 && events * REBUILD_SHARE >= total;
  const before = new Map<string, number>();
  for (const t of [...EVENT_SEARCH, ...ENTRY_SEARCH]) {
    if (!db.hasTable(t)) continue;
    const setting = db.prepare(`SELECT v FROM ${t}_config WHERE k = 'secure-delete'`).get() as
      | { v: number }
      | undefined;
    before.set(t, Number(setting?.v ?? 0));
    const secure = !(rebuild && EVENT_SEARCH.includes(t));
    db.exec(`INSERT INTO ${t} (${t}, rank) VALUES ('secure-delete', ${secure ? 1 : 0})`);
  }
  return { rebuild, before };
}

interface SearchDeletes {
  /** Whether the event search tables are built again rather than deleted from in place. */
  rebuild: boolean;
  /** Each table's `secure-delete` setting before the purge, to put back. */
  before: Map<string, number>;
}

/** Build the event search tables again if so chosen, and put their settings back. */
function finishSearchDeletes(db: Database, s: SearchDeletes): void {
  if (s.rebuild) {
    // As rebuildSearchIndexes does; the CJK index keeps no content to rebuild from.
    db.exec(`INSERT INTO event_fts (event_fts) VALUES ('rebuild');
      INSERT INTO message_fts (message_fts) VALUES ('rebuild');
      INSERT INTO event_cjk (event_cjk) VALUES ('delete-all');
      INSERT INTO event_cjk (rowid, text)
        SELECT seq, t FROM (SELECT seq, origin_cjk(text, kind) AS t FROM event)
        WHERE t IS NOT NULL;`);
  }
  for (const [t, v] of s.before) {
    db.exec(`INSERT INTO ${t} (${t}, rank) VALUES ('secure-delete', ${v})`);
  }
}

const DOOMED_SESSION = 'SELECT source, session_id FROM doomed_session';

/**
 * Purge: delete for good what the selector takes by the rules (see planPurge), record the purge,
 * and queue the mirrors whose lines are to be blanked (see completePurges). The plan is made again
 * inside one write transaction, parsing only what was appended since `opts.plan` was made; if a
 * plan or a digest is given and the store would now delete anything else, it throws a
 * ConflictError and deletes nothing. Throws an OriginError when the plan is refused or empty.
 */
export function purge(
  db: Database,
  home: string,
  adapters: PurgeAdapters,
  selector: PurgeSelector,
  opts: PurgeOptions,
): PurgeResult {
  const reason = checkReason(opts.reason);
  const author = typeof opts.author === 'string' ? opts.author.trim() : '';
  if (!author) throw new OriginError('Say who purges: the author is required.');
  if (!['cli', 'ui', 'api'].includes(opts.channel)) {
    throw new OriginError('Unknown purge channel.');
  }
  const chosen = normalizeSelector(selector);
  if (opts.plan && JSON.stringify(opts.plan.selector) !== JSON.stringify(chosen)) {
    throw new OriginError('The plan given is for another selector.');
  }
  const expected = opts.digest ?? opts.plan?.digest;
  // The slow part, parsing the mirrors, is done before taking the write lock.
  const first = opts.plan ?? makePlan(db, home, adapters, chosen);
  const parses = states.get(first)?.planner.files;
  const now = opts.now ?? Date.now();
  const result = underLock(db, home, adapters, opts, () => {
    const plan = makePlan(db, home, adapters, chosen, parses);
    if (expected !== undefined && expected !== plan.digest) {
      throw new ConflictError(
        'The store has changed since this purge was planned, and it would now delete something else: plan it again.',
      );
    }
    if (plan.refusals.length > 0) throw new OriginError(plan.refusals.join(' '));
    if (emptyPlan(plan)) {
      throw new OriginError('Nothing to purge: the selector takes nothing this store holds.');
    }
    return applyPlan(db, plan, states.get(plan) as PlanState, {
      id: `prg_${randomBytes(6).toString('hex')}`,
      at: now,
      origin: storeName(db),
      author,
      channel: opts.channel,
      reason,
      actor: opts.actor ?? author,
      receivedAt: null,
    });
  });
  return result as PurgeResult;
}

/**
 * Apply a plan made under the write lock (`apply`, which may decline with null), with secure
 * deletes on SQLite; then blank the mirrors it queued, unless `opts.complete` is false.
 */
function underLock(
  db: Database,
  home: string,
  adapters: PurgeAdapters,
  opts: { complete?: boolean; budgetMs?: number; log?: (message: string) => void },
  apply: () => PurgeResult | null,
): PurgeResult | null {
  const sqlite = db.dialect === 'sqlite';
  const secure = sqlite ? pragma(db, 'secure_delete') : null;
  if (sqlite) db.exec('PRAGMA secure_delete = ON');
  let result: PurgeResult | null;
  try {
    result = transaction(db, apply, { immediate: true });
  } finally {
    if (secure !== null) db.exec(`PRAGMA secure_delete = ${secure}`);
  }
  if (result === null) return null;
  if (opts.complete !== false) {
    result.mirrors = completePurges(db, home, adapters, {
      budgetMs: opts.budgetMs,
      log: opts.log,
    });
    result.pending = result.mirrors.pending;
  } else if (sqlite) {
    checkpoint(db);
  }
  return result;
}

function emptyPlan(p: PurgePlan): boolean {
  return (
    p.events.length === 0 &&
    p.entries.length === 0 &&
    p.sessions.length === 0 &&
    p.recalls.length === 0 &&
    p.recallItems.length === 0 &&
    p.files.length === 0
  );
}

function pragma(db: Database, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return Number(row ? Object.values(row)[0] : 0) || 0;
}

/**
 * Move what the WAL holds into the database and empty it, so that no deleted page stays there.
 * Best effort: a reader may hold it back, and the mirrors' completion tries again.
 */
export function checkpoint(db: Database): void {
  if (db.dialect !== 'sqlite') return;
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } catch {
    // A busy store checkpoints later.
  }
}

/** The work tables of a purge: what it deletes, by id, in the transaction that deletes it. */
function workTables(db: Database): void {
  const temp = db.dialect === 'sqlite' ? '' : ' ON COMMIT DELETE ROWS';
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS doomed_event (
  id TEXT PRIMARY KEY, seq BIGINT NOT NULL, listed INTEGER NOT NULL)${temp};
CREATE TEMP TABLE IF NOT EXISTS doomed_entry (id TEXT PRIMARY KEY)${temp};
CREATE TEMP TABLE IF NOT EXISTS doomed_session (
  source TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (source, session_id))${temp};
CREATE TEMP TABLE IF NOT EXISTS doomed_recall (id TEXT PRIMARY KEY, seq BIGINT NOT NULL)${temp};`);
  clearWorkTables(db);
}

function clearWorkTables(db: Database): void {
  db.exec(
    'DELETE FROM doomed_event; DELETE FROM doomed_entry; DELETE FROM doomed_session; DELETE FROM doomed_recall;',
  );
}

/** Who made a purge, and where: what its record says besides what it selected and removed. */
interface PurgeMaker {
  id: string;
  at: number;
  origin: string;
  author: string;
  channel: PurgeChannel;
  reason: string;
  /** Who the audit log names. */
  actor: string;
  receivedAt: number | null;
}

/** Apply a plan made under the write lock: the deletes, then the purge's record. */
function applyPlan(db: Database, plan: PurgePlan, state: PlanState, made: PurgeMaker): PurgeResult {
  const d = db.dialect;
  const id = made.id;
  db.exec(
    `INSERT INTO guard_lift (name) VALUES ${LIFTED.map((n) => `('${n}')`).join(', ')}
       ON CONFLICT DO NOTHING`,
  );
  try {
    if (d === 'sqlite') db.exec('PRAGMA defer_foreign_keys = ON');
    workTables(db);
    try {
      db.prepare(`INSERT INTO doomed_session (source, session_id) ${pairList(d)}`).run(
        JSON.stringify(plan.sessions.map((s) => [s.source, s.sessionId])),
      );
      // Events of a purged session are not listed one by one, except on a hub those a device
      // sent: an entry citing one may arrive from elsewhere, and should find it purged.
      db.prepare(
        `INSERT INTO doomed_event (id, seq, listed)
         SELECT e.id, e.seq, CASE WHEN EXISTS (SELECT 1 FROM doomed_session s
                                     WHERE s.source = e.source AND s.session_id = e.session_id)
                               AND NOT EXISTS (SELECT 1 FROM raw_file f
                                     WHERE f.id = e.raw_file_id AND f.path LIKE '@%')
                             THEN 0 ELSE 1 END
           FROM event e WHERE e.id IN (${idList(d, 'text')})`,
      ).run(JSON.stringify(plan.events));
      db.prepare(
        `INSERT INTO doomed_entry (id) SELECT id FROM entry WHERE id IN (${idList(d, 'text')})`,
      ).run(JSON.stringify(plan.entries));
      db.prepare(
        `INSERT INTO doomed_recall (id, seq)
         SELECT id, seq FROM recall WHERE id IN (${idList(d, 'text')})`,
      ).run(JSON.stringify(plan.recalls));

      const doomed = new Set(plan.sessions.map((s) => key(s.source, s.sessionId)));
      const affected = affectedSessions(db, plan, state, doomed);
      const threadOf = db.prepare(
        'SELECT thread_id FROM session_thread WHERE source = ? AND session_id = ?',
      );
      const threads = new Set<string>();
      for (const k of [...doomed, ...affected.keys()]) {
        const { source, sessionId } = unkey(k);
        const row = threadOf.get(source, sessionId) as { thread_id: string } | undefined;
        if (row) threads.add(row.thread_id);
      }
      const floor = (
        db.prepare('SELECT MAX(seq) AS n FROM doomed_event').get() as { n: number | null }
      ).n;
      const recallFloor = (
        db.prepare('SELECT MAX(seq) AS n FROM doomed_recall').get() as { n: number | null }
      ).n;

      const search = d === 'sqlite' ? prepareSearchDeletes(db, plan.events.length) : null;
      deleteRows(db, plan);
      if (search) finishSearchDeletes(db, search);
      for (const f of plan.files) {
        if (!state.planner.files.get(f.rawFileId)?.places) continue;
        db.prepare('DELETE FROM place_head WHERE source = ? AND device = ?').run(
          f.source,
          parseRawPath(f.path).device ?? '',
        );
      }
      refreshAffected(db, plan, state, affected);
      refreshThreads(db, [...doomed, ...affected.keys()].map(unkey));
      db.exec(`DELETE FROM session_thread WHERE (source, session_id) IN (${DOOMED_SESSION})`);
      // Items naming a thread that is gone with its sessions.
      const touched = new Set(plan.recallItems.map((i) => i.recall));
      let threadItems = 0;
      const gone = [...threads].filter(
        (t) => !db.prepare('SELECT 1 AS one FROM session_thread WHERE thread_id = ?').get(t),
      );
      if (gone.length > 0) {
        const items = db
          .prepare(
            `SELECT recall_id, rank FROM recall_item
              WHERE kind = 'thread' AND ref IN (${idList(d, 'text')})`,
          )
          .all(JSON.stringify(gone)) as Array<{ recall_id: string; rank: number }>;
        const remove = db.prepare('DELETE FROM recall_item WHERE recall_id = ? AND rank = ?');
        for (const i of items) {
          if (remove.run(i.recall_id, i.rank).changes === 0) continue;
          touched.add(i.recall_id);
          threadItems++;
        }
      }

      const counts: PurgeCounts = {
        ...plan.counts,
        recallItems: plan.counts.recallItems + threadItems,
      };
      const touchedOut: PurgeTouched = {
        tombstones: plan.tombstones,
        recalls: [...touched].filter((r) => !plan.recalls.includes(r)).sort(),
      };
      const { seq } = db
        .prepare(
          `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts, touched,
                              seq_floor, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING seq`,
        )
        .get(
          id,
          made.at,
          made.origin,
          made.author,
          made.channel,
          made.reason,
          JSON.stringify(plan.selector),
          JSON.stringify(counts),
          JSON.stringify(touchedOut),
          floor,
          made.receivedAt,
        ) as { seq: number };
      recordPurged(db, id, plan);
      const pending = queueMirrors(db, id, Number(seq), plan);
      if (recallFloor !== null) {
        const known = Number(getSetting(db, RECALL_SEQ_FLOOR) ?? 0);
        if (recallFloor > known) setSetting(db, RECALL_SEQ_FLOOR, String(recallFloor));
      }
      recordAudit(
        db,
        {
          actor: made.actor,
          // A hub's purge came through its replication API.
          channel: made.channel === 'hub' ? 'api' : made.channel,
          action: 'purge',
          target: id,
          detail: { ...counts },
        },
        made.receivedAt ?? made.at,
      );
      const record: PurgeRecord = {
        seq: Number(seq),
        id,
        at: made.at,
        origin: made.origin,
        author: made.author,
        channel: made.channel,
        reason: made.reason,
        selector: plan.selector,
        counts,
        touched: touchedOut,
        seqFloor: floor === null ? null : Number(floor),
        receivedAt: made.receivedAt,
      };
      return { id, record, plan, mirrors: null, pending };
    } finally {
      clearWorkTables(db);
    }
  } finally {
    db.exec('DELETE FROM guard_lift');
  }
}

/**
 * Sessions that stay but lose events, or the line that gave them their title: their counts,
 * times, and titles are derived again. By key, with whether their title is derived again too.
 */
function affectedSessions(
  db: Database,
  plan: PurgePlan,
  state: PlanState,
  doomed: Set<string>,
): Map<string, boolean> {
  const affected = new Map<string, boolean>();
  for (const r of db
    .prepare(
      `SELECT DISTINCT e.source, e.session_id FROM event e JOIN doomed_event d ON d.id = e.id
        WHERE NOT EXISTS (SELECT 1 FROM doomed_session s
                           WHERE s.source = e.source AND s.session_id = e.session_id)`,
    )
    .all() as Array<{ source: string; session_id: string }>) {
    affected.set(key(r.source, r.session_id), false);
  }
  for (const f of plan.files) {
    const parse = state.planner.files.get(f.rawFileId);
    if (!parse) continue;
    for (const [first, count] of f.lines) {
      for (let n = first; n < first + count; n++) {
        const title = parse.lines.get(n)?.title;
        if (!title) continue;
        const k = key(f.source, title.session);
        if (!doomed.has(k)) affected.set(k, true);
      }
    }
  }
  return affected;
}

/**
 * The titles the kept lines give the sessions to title again: per session, the latest, unless the
 * user gave one, in which case the latest the user gave (as reparseTitles derives them).
 */
function titlesAfter(
  plan: PurgePlan,
  state: PlanState,
  affected: Map<string, boolean>,
): Map<string, { title: string; manual: boolean }> {
  const blanked = new Map<number, Array<[number, number]>>();
  for (const f of plan.files) blanked.set(f.rawFileId, f.lines);
  const out = new Map<string, { title: string; manual: boolean }>();
  for (const id of [...state.planner.reached].sort((a, b) => a - b)) {
    const parse = state.planner.files.get(id);
    if (!parse) continue;
    const gone = blanked.get(id) ?? [];
    for (const n of [...parse.lines.keys()].sort((a, b) => a - b)) {
      const t = parse.lines.get(n)?.title;
      if (!t) continue;
      const k = key(parse.file.source, t.session);
      if (!affected.get(k)) continue;
      if (gone.some(([first, count]) => n >= first && n < first + count)) continue;
      const current = out.get(k);
      if (!current || t.manual || !current.manual) out.set(k, { title: t.text, manual: t.manual });
    }
  }
  return out;
}

/** Derive again what stays of the sessions a purge changed. */
function refreshAffected(
  db: Database,
  plan: PurgePlan,
  state: PlanState,
  affected: Map<string, boolean>,
): void {
  const any = db.prepare('SELECT 1 AS one FROM event WHERE source = ? AND session_id = ? LIMIT 1');
  const drop = db.prepare('DELETE FROM session WHERE source = ? AND session_id = ?');
  const retitle = db.prepare(
    'UPDATE session SET title = ?, title_manual = ? WHERE source = ? AND session_id = ?',
  );
  const derived = [...affected.values()].some(Boolean)
    ? titlesAfter(plan, state, affected)
    : new Map<string, { title: string; manual: boolean }>();
  for (const [k, title] of affected) {
    const { source, sessionId } = unkey(k);
    if (!any.get(source, sessionId)) {
      drop.run(source, sessionId);
      continue;
    }
    refreshSession(db, source, sessionId);
    if (title) {
      const t = derived.get(k);
      retitle.run(t?.title ?? null, t?.manual ? 1 : 0, source, sessionId);
    }
  }
}

/** The deletes of a purge, children first, from the work tables. */
function deleteRows(db: Database, plan: PurgePlan): void {
  db.exec(`
DELETE FROM recall_item WHERE kind = 'entry' AND ref IN (SELECT id FROM doomed_entry);
DELETE FROM tombstone_effect WHERE kind = 'entry' AND item IN (SELECT id FROM doomed_entry);
DELETE FROM forgotten_entry WHERE entry_id IN (SELECT id FROM doomed_entry);
DELETE FROM entry_source WHERE entry_id IN (SELECT id FROM doomed_entry);
DELETE FROM imported_entry WHERE entry_id IN (SELECT id FROM doomed_entry);
DELETE FROM entry WHERE id IN (SELECT id FROM doomed_entry);

DELETE FROM recall_item WHERE kind = 'event' AND ref IN (SELECT id FROM doomed_event);
DELETE FROM tombstone_effect WHERE kind = 'event' AND item IN (SELECT id FROM doomed_event);
DELETE FROM excluded_event WHERE event_id IN (SELECT id FROM doomed_event);
DELETE FROM event_author WHERE seq IN (SELECT seq FROM doomed_event);
DELETE FROM session_follow WHERE event_id IN (SELECT id FROM doomed_event);
DELETE FROM proposal_source WHERE event_id IN (SELECT id FROM doomed_event)
   OR proposal_id IN (SELECT id FROM proposal WHERE event_id IN (SELECT id FROM doomed_event));
DELETE FROM proposal WHERE event_id IN (SELECT id FROM doomed_event);
DELETE FROM event WHERE id IN (SELECT id FROM doomed_event);

DELETE FROM session_place WHERE (source, session_id) IN (${DOOMED_SESSION});
DELETE FROM session_kind WHERE (source, session_id) IN (${DOOMED_SESSION});
DELETE FROM session_parent WHERE (source, session_id) IN (${DOOMED_SESSION})
   OR (parent_source, parent_session_id) IN (${DOOMED_SESSION});
DELETE FROM session_follow WHERE (source, session_id) IN (${DOOMED_SESSION})
   OR (target_source, target_session_id) IN (${DOOMED_SESSION});
DELETE FROM recall_item WHERE kind = 'session'
   AND ref IN (SELECT source || ':' || session_id FROM doomed_session);
DELETE FROM recall_item WHERE recall_id IN (SELECT id FROM doomed_recall);
DELETE FROM recall WHERE id IN (SELECT id FROM doomed_recall);
DELETE FROM session WHERE (source, session_id) IN (${DOOMED_SESSION});
`);
  const remove = db.prepare('DELETE FROM recall_item WHERE recall_id = ? AND rank = ?');
  for (const i of plan.recallItems) remove.run(i.recall, i.rank);
}

/** What a purge removed, by id, so that it stays out on arrival (see purged.ts). */
function recordPurged(db: Database, id: string, plan: PurgePlan): void {
  const all = (kind: string, scope: string, ids: string, where = 'true') =>
    db
      .prepare(
        `INSERT INTO purged (kind, scope, id, purge_id)
         SELECT '${kind}', ${scope}, ${ids}, ? FROM doomed_${kind} WHERE ${where}
         ON CONFLICT DO NOTHING`,
      )
      .run(id);
  all('event', "''", 'id', 'listed = 1');
  all('entry', "''", 'id');
  all('session', 'source', 'session_id');
  all('recall', "''", 'id');
  const file = db.prepare(
    `INSERT INTO purged (kind, scope, id, purge_id) VALUES ('file', ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  for (const f of plan.files) if (f.blocked) file.run(f.source, f.path, id);
}

/** Record the lines a purge blanks, and queue their mirrors; returns how many are queued. */
function queueMirrors(db: Database, id: string, seq: number, plan: PurgePlan): number {
  const line = db.prepare(
    'INSERT INTO purge_line (raw_file_id, first_line, line_count, purge_id) VALUES (?, ?, ?, ?)',
  );
  const queue = db.prepare(
    'INSERT INTO purge_pending (raw_file_id, since) VALUES (?, ?) ON CONFLICT DO NOTHING',
  );
  for (const f of plan.files) {
    for (const [first, count] of f.lines) line.run(f.rawFileId, first, count, id);
    queue.run(f.rawFileId, seq);
  }
  return (db.prepare('SELECT COUNT(*) AS n FROM purge_pending').get() as { n: number }).n;
}

// --- Mirrors ---------------------------------------------------------------------------------

/** What completePurges did. */
export interface PurgeCompletion {
  /** Mirrors whose purged lines are all blank now, and the frames and lines that changed. */
  done: number;
  frames: number;
  lines: number;
  /** Mirrors that failed this time, each with why (never content); they stay pending. */
  failed: Array<{ rawFileId: number; mirror: string; error: string }>;
  /** Mirrors still to do: failed, or left past the budget. */
  pending: number;
}

/**
 * Blank the lines purges removed in the mirrors that still hold them (`purge_pending`), one mirror
 * per short write transaction, so that it can stop and go on (see blankMirror): first, under the
 * write lock, a frame replacement a crash interrupted is completed. A mirror that fails (a frame
 * that does not fit its slot, a bucket that cannot be reached) stays pending with its error and the
 * count of attempts, and the others go on. A generated source's last line is replaced with where
 * the source goes on from, which needs its adapter (see SourceAdapter.continuation). Stops
 * starting mirrors after `budgetMs`. Then checkpoints the WAL.
 */
export function completePurges(
  db: Database,
  home: string,
  adapters: PurgeAdapters,
  opts: { budgetMs?: number; log?: (message: string) => void } = {},
): PurgeCompletion {
  const result: PurgeCompletion = { done: 0, frames: 0, lines: 0, failed: [], pending: 0 };
  if (!db.hasTable('purge_pending')) return result;
  const started = Date.now();
  transaction(db, () => replayFrameJournals(home), { immediate: true });
  const adapterOf = adapterLookup(adapters);
  const ids = (
    db.prepare('SELECT raw_file_id FROM purge_pending ORDER BY since, raw_file_id').all() as Array<{
      raw_file_id: number;
    }>
  ).map((r) => Number(r.raw_file_id));
  for (const id of ids) {
    if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs) break;
    try {
      const done = transaction(db, () => completeMirror(db, home, adapterOf, id), {
        immediate: true,
      });
      if (done) {
        result.done++;
        result.frames += done.frames;
        result.lines += done.lines;
      }
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      transaction(
        db,
        () =>
          db
            .prepare(
              'UPDATE purge_pending SET attempts = attempts + 1, error = ? WHERE raw_file_id = ?',
            )
            .run(error, id),
        { immediate: true },
      );
      const mirror =
        (db.prepare('SELECT mirror FROM raw_file WHERE id = ?').get(id) as { mirror: string })
          ?.mirror ?? '';
      result.failed.push({ rawFileId: id, mirror, error });
      opts.log?.(`warning ${mirror}: purged lines not blanked yet: ${error}`);
    }
  }
  result.pending = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM purge_pending').get() as { n: number }).n,
  );
  checkpoint(db);
  return result;
}

/** Blank the purged lines of one mirror, under the write lock; null if it is not pending now. */
function completeMirror(
  db: Database,
  home: string,
  adapterOf: (source: string) => SourceAdapter | null,
  id: number,
): MirrorBlanking | null {
  if (!db.prepare('SELECT 1 AS one FROM purge_pending WHERE raw_file_id = ?').get(id)) return null;
  const bucket = frameBucket(db);
  if (bucket !== null && !(frameStore(home) instanceof BucketFrameStore)) {
    throw new OriginError(
      `This store keeps its sealed frames in ${bucket}: complete its purges where that bucket is configured.`,
    );
  }
  const file = db.prepare(`SELECT ${RAW_FILE_COLUMNS} FROM raw_file WHERE id = ?`).get(id) as
    | RawFile
    | undefined;
  if (!file) {
    db.prepare('DELETE FROM purge_pending WHERE raw_file_id = ?').run(id);
    return null;
  }
  const rows = db
    .prepare(
      `SELECT l.first_line, l.line_count, l.purge_id FROM purge_line l
         JOIN purge p ON p.id = l.purge_id
        WHERE l.raw_file_id = ? ORDER BY p.seq, l.first_line`,
    )
    .all(id) as Array<{ first_line: number; line_count: number; purge_id: string }>;
  const lines = new Set<number>();
  let lastBy: string | null = null;
  for (const r of rows) {
    for (let n = Number(r.first_line); n < Number(r.first_line) + Number(r.line_count); n++) {
      lines.add(n);
    }
    const end = Number(r.first_line) + Number(r.line_count) - 1;
    if (Number(r.first_line) <= file.lines_ingested && end >= file.lines_ingested) {
      lastBy = r.purge_id;
    }
  }
  // A mirror that an earlier version let two files share keeps the lines that an event of either
  // still cites (see Raw mirrors in docs/architecture.md).
  const sharing = db
    .prepare('SELECT id FROM raw_file WHERE lower(mirror) = lower(?) AND id <> ?')
    .all(file.mirror, id) as Array<{ id: number }>;
  if (sharing.length > 0) {
    for (const r of db
      .prepare(
        `SELECT DISTINCT raw_line FROM event WHERE raw_file_id IN (${idList(db.dialect, 'bigint')})`,
      )
      .all(JSON.stringify([id, ...sharing.map((s) => Number(s.id))])) as Array<{
      raw_line: number;
    }>) {
      lines.delete(Number(r.raw_line));
    }
  }
  const relPath = mirrorRelPath(file);
  let continueWith: ((line: string, bytes: number) => string | null) | undefined;
  const local = !file.path.startsWith('@') && !isOriginPlacesFile(relPath, file.path);
  if (local && lastBy !== null && lines.has(file.lines_ingested)) {
    const adapter = adapterOf(file.source);
    if (!adapter) {
      throw new OriginError(
        `Blanking the last line of ${file.mirror} needs the ${file.source} adapter, to go on from it if it is generated.`,
      );
    }
    const by = lastBy;
    continueWith = (line, bytes) => continuationLine(adapter, line, relPath, by, bytes);
  }
  const done = blankMirror(db, home, id, lineRanges(lines), continueWith);
  db.prepare('DELETE FROM purge_pending WHERE raw_file_id = ?').run(id);
  return done;
}

/** A mirror whose purged lines are still to be blanked (see completePurges). */
export interface PendingPurgeMirror {
  rawFileId: number;
  source: string;
  path: string;
  mirror: string;
  /** How often blanking it failed, and why it failed last, never content. */
  attempts: number;
  error: string | null;
  /** The purges whose lines it holds. */
  purges: string[];
}

/** The mirrors whose purged lines are still to be blanked, oldest purge first. */
export function pendingPurgeMirrors(db: Database): PendingPurgeMirror[] {
  if (!db.hasTable('purge_pending')) return [];
  const rows = db
    .prepare(
      `SELECT p.raw_file_id, p.attempts, p.error, f.source, f.path, f.mirror
         FROM purge_pending p JOIN raw_file f ON f.id = p.raw_file_id
        ORDER BY p.since, p.raw_file_id`,
    )
    .all() as Array<{
    raw_file_id: number;
    attempts: number;
    error: string | null;
    source: string;
    path: string;
    mirror: string;
  }>;
  const purgesOf = db.prepare(
    `SELECT DISTINCT l.purge_id, p.seq FROM purge_line l JOIN purge p ON p.id = l.purge_id
      WHERE l.raw_file_id = ? ORDER BY p.seq`,
  );
  return rows.map((r) => ({
    rawFileId: Number(r.raw_file_id),
    source: r.source,
    path: r.path,
    mirror: r.mirror,
    attempts: Number(r.attempts),
    error: r.error,
    purges: (purgesOf.all(r.raw_file_id) as Array<{ purge_id: string }>).map((p) => p.purge_id),
  }));
}

/** The seq of this store's latest purge, or 0 (see backupStore). */
export function latestPurgeSeq(db: Database): number {
  if (!db.hasTable('purge')) return 0;
  return Number(
    (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM purge').get() as { n: number }).n,
  );
}

// --- Records ---------------------------------------------------------------------------------

interface PurgeRow {
  seq: number;
  id: string;
  at: number;
  origin: string;
  author: string;
  channel: PurgeChannel;
  reason: string;
  selector: string;
  counts: string;
  touched: string;
  seq_floor: number | null;
  received_at: number | null;
}

const PURGE_COLUMNS =
  'seq, id, at, origin, author, channel, reason, selector, counts, touched, seq_floor, received_at';

function purgeRecord(r: PurgeRow): PurgeRecord {
  const touched = JSON.parse(r.touched) as Partial<PurgeTouched>;
  return {
    seq: Number(r.seq),
    id: r.id,
    at: Number(r.at),
    origin: r.origin,
    author: r.author,
    channel: r.channel,
    reason: r.reason,
    selector: JSON.parse(r.selector) as PurgeSelector,
    counts: JSON.parse(r.counts) as PurgeCounts,
    touched: { tombstones: touched.tombstones ?? [], recalls: touched.recalls ?? [] },
    seqFloor: r.seq_floor === null ? null : Number(r.seq_floor),
    receivedAt: r.received_at === null ? null : Number(r.received_at),
  };
}

/** The purges of this store, newest first; `before` a seq, to read on. */
export function listPurges(
  db: Database,
  opts: { limit?: number; before?: number } = {},
): PurgeRecord[] {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 500);
  const rows = db
    .prepare(`SELECT ${PURGE_COLUMNS} FROM purge WHERE seq < ? ORDER BY seq DESC LIMIT ?`)
    .all(opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as PurgeRow[];
  return rows.map(purgeRecord);
}

/** A mirror a purge blanks lines of, and whether they are still to be blanked. */
export interface PurgeMirror {
  rawFileId: number;
  source: string;
  path: string;
  generation: number;
  mirror: string;
  lines: Array<[number, number]>;
  /** Its lines are still to be blanked (see completePurges); why not yet, if it failed. */
  pending: boolean;
  error: string | null;
}

/** A purge with what it removed, by id, and its mirrors: never text. */
export interface PurgeDetail extends PurgeRecord {
  removed: {
    events: string[];
    entries: string[];
    sessions: Array<{ source: string; sessionId: string }>;
    recalls: string[];
    /** Files it blocked: their later lines are stored blank. */
    files: Array<{ source: string; path: string }>;
  };
  mirrors: PurgeMirror[];
}

/** A purge, with what it removed by id and its mirrors; null for an unknown id. */
export function getPurge(db: Database, id: string): PurgeDetail | null {
  const row = db.prepare(`SELECT ${PURGE_COLUMNS} FROM purge WHERE id = ?`).get(id) as
    | PurgeRow
    | undefined;
  if (!row) return null;
  const removed: PurgeDetail['removed'] = {
    events: [],
    entries: [],
    sessions: [],
    recalls: [],
    files: [],
  };
  for (const r of db
    .prepare('SELECT kind, scope, id FROM purged WHERE purge_id = ? ORDER BY kind, scope, id')
    .all(id) as Array<{ kind: string; scope: string; id: string }>) {
    if (r.kind === 'event') removed.events.push(r.id);
    else if (r.kind === 'entry') removed.entries.push(r.id);
    else if (r.kind === 'session') removed.sessions.push({ source: r.scope, sessionId: r.id });
    else if (r.kind === 'recall') removed.recalls.push(r.id);
    else if (r.kind === 'file') removed.files.push({ source: r.scope, path: r.id });
  }
  const mirrors = new Map<number, PurgeMirror>();
  for (const r of db
    .prepare(
      `SELECT l.raw_file_id, l.first_line, l.line_count, f.source, f.path, f.generation, f.mirror,
              p.raw_file_id AS pending, p.error
         FROM purge_line l JOIN raw_file f ON f.id = l.raw_file_id
         LEFT JOIN purge_pending p ON p.raw_file_id = l.raw_file_id
        WHERE l.purge_id = ? ORDER BY l.raw_file_id, l.first_line`,
    )
    .all(id) as Array<{
    raw_file_id: number;
    first_line: number;
    line_count: number;
    source: string;
    path: string;
    generation: number;
    mirror: string;
    pending: number | null;
    error: string | null;
  }>) {
    let m = mirrors.get(Number(r.raw_file_id));
    if (!m) {
      m = {
        rawFileId: Number(r.raw_file_id),
        source: r.source,
        path: r.path,
        generation: Number(r.generation),
        mirror: r.mirror,
        lines: [],
        pending: r.pending !== null,
        error: r.error,
      };
      mirrors.set(m.rawFileId, m);
    }
    m.lines.push([Number(r.first_line), Number(r.line_count)]);
  }
  return { ...purgeRecord(row), removed, mirrors: [...mirrors.values()] };
}

// --- From a hub down to its devices ------------------------------------------------------------

/**
 * What a purge removed, by id, as a hub's purge feed sends it down to a device: events, entries
 * (every version), sessions as `[source, id]`, recalls, and the files it blocked, as
 * `[source, path]` with the path as the device knows it.
 */
export interface PurgeItems {
  events: string[];
  entries: string[];
  sessions: Array<[string, string]>;
  recalls: string[];
  files: Array<[string, string]>;
}

/** A purge a hub made, as its feed describes it: who, when, why, and what it selected. */
export interface HubPurgeRecord {
  /** Its seq on the hub: the feed's cursor. */
  seq: number;
  id: string;
  at: number;
  origin: string;
  author: string;
  reason: string;
  selector: PurgeSelector;
}

/** A hub's purge with everything it removed that a device may hold (see applyHubPurge). */
export interface HubPurge extends HubPurgeRecord {
  items: PurgeItems;
}

/**
 * One page of a hub's purge feed (`GET /v1/purges`): one purge, or none after `after`, and at most
 * PURGE_FEED_PAGE of the ids it removed, from `offset`. While `next.offset` is not 0, the next page
 * holds more of the same purge; once it is, the purge is whole, and `next.after` is its seq. `more`
 * says whether to ask again, with `next`.
 */
export interface PurgeFeedPage {
  purge: HubPurgeRecord | null;
  items: PurgeItems;
  more: boolean;
  next: { after: number; offset: number };
}

/** The most ids a page of the purge feed holds. */
export const PURGE_FEED_PAGE = 10_000;

const noItems = (): PurgeItems => ({
  events: [],
  entries: [],
  sessions: [],
  recalls: [],
  files: [],
});

/**
 * The purge feed of a hub for one of its devices (see PurgeFeedPage): the purges this store made,
 * not those it received, in order, each with what it removed, by id. Of the files a purge blocked,
 * only that device's are listed, as the device knows their paths (without `@<device>:`).
 */
export function purgeFeed(
  db: Database,
  opts: { after: number; offset?: number; device: string; limit?: number },
): PurgeFeedPage {
  const after = opts.after;
  const offset = opts.offset ?? 0;
  const limit = Math.min(Math.max(1, opts.limit ?? PURGE_FEED_PAGE), PURGE_FEED_PAGE);
  const none: PurgeFeedPage = {
    purge: null,
    items: noItems(),
    more: false,
    next: { after, offset: 0 },
  };
  if (!db.hasTable('purge')) return none;
  const row = db
    .prepare(
      `SELECT ${PURGE_COLUMNS} FROM purge WHERE seq > ? AND channel <> 'hub' ORDER BY seq LIMIT 1`,
    )
    .get(after) as PurgeRow | undefined;
  if (!row) return none;
  const rows = db
    .prepare(
      `SELECT kind, scope, id FROM purged WHERE purge_id = ?
        ORDER BY kind, scope, id LIMIT ? OFFSET ?`,
    )
    .all(row.id, limit + 1, offset) as Array<{ kind: string; scope: string; id: string }>;
  const partial = rows.length > limit;
  const items = noItems();
  for (const r of rows.slice(0, limit)) {
    if (r.kind === 'event') items.events.push(r.id);
    else if (r.kind === 'entry') items.entries.push(r.id);
    else if (r.kind === 'session') items.sessions.push([r.scope, r.id]);
    else if (r.kind === 'recall') items.recalls.push(r.id);
    else if (r.kind === 'file') {
      const { device, originalPath } = parseRawPath(r.id);
      if (device === opts.device) items.files.push([r.scope, originalPath]);
    }
  }
  const seq = Number(row.seq);
  const later =
    !partial &&
    db.prepare("SELECT 1 AS one FROM purge WHERE seq > ? AND channel <> 'hub' LIMIT 1").get(seq) !==
      undefined;
  return {
    purge: {
      seq,
      id: row.id,
      at: Number(row.at),
      origin: row.origin,
      author: row.author,
      reason: row.reason,
      selector: JSON.parse(row.selector) as PurgeSelector,
    },
    items,
    more: partial || later,
    next: partial ? { after, offset: offset + limit } : { after: seq, offset: 0 },
  };
}

function invalidFeed(what: string): never {
  throw new OriginError(`The hub sent an invalid purge feed: ${what}.`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function feedIds(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > PURGE_FEED_PAGE) invalidFeed(what);
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 4096) invalidFeed(what);
  }
  return value as string[];
}

function feedPairs(value: unknown, what: string): Array<[string, string]> {
  if (!Array.isArray(value) || value.length > PURGE_FEED_PAGE) invalidFeed(what);
  return value.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) invalidFeed(what);
    const [a, b] = feedIds(pair, what) as [string, string];
    return [a, b];
  });
}

function feedCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidFeed(what);
  return value;
}

/** A page of a hub's purge feed as the hub sent it, checked field by field (see purgeFeed). */
export function parsePurgeFeedPage(value: unknown): PurgeFeedPage {
  if (!isObject(value)) invalidFeed('not an object');
  const next = value.next;
  if (!isObject(next)) invalidFeed('next');
  const page: PurgeFeedPage = {
    purge: null,
    items: noItems(),
    more: value.more === true,
    next: { after: feedCount(next.after, 'next'), offset: feedCount(next.offset, 'next') },
  };
  if (value.purge === null || value.purge === undefined) return page;
  const p = value.purge;
  if (!isObject(p)) invalidFeed('purge');
  if (typeof p.id !== 'string' || !PURGE_ID_RE.test(p.id)) invalidFeed('purge id');
  if (typeof p.origin !== 'string' || !NAME_RE.test(p.origin)) invalidFeed(`origin of ${p.id}`);
  if (typeof p.author !== 'string' || p.author.trim().length === 0 || p.author.length > 200) {
    invalidFeed(`author of ${p.id}`);
  }
  let reason: string;
  try {
    reason = checkReason(p.reason);
  } catch {
    invalidFeed(`reason of ${p.id}`);
  }
  const selector = p.selector;
  if (
    !isObject(selector) ||
    typeof selector.kind !== 'string' ||
    JSON.stringify(selector).length > 64 * 1024
  ) {
    invalidFeed(`selector of ${p.id}`);
  }
  const items = value.items;
  if (!isObject(items)) invalidFeed(`items of ${p.id}`);
  page.purge = {
    seq: feedCount(p.seq, `seq of ${p.id}`),
    id: p.id,
    at: feedCount(p.at, `time of ${p.id}`),
    origin: p.origin,
    author: p.author.trim(),
    reason,
    selector: selector as unknown as PurgeSelector,
  };
  page.items = {
    events: feedIds(items.events ?? [], `events of ${p.id}`),
    entries: feedIds(items.entries ?? [], `entries of ${p.id}`),
    sessions: feedPairs(items.sessions ?? [], `sessions of ${p.id}`),
    recalls: feedIds(items.recalls ?? [], `recalls of ${p.id}`),
    files: feedPairs(items.files ?? [], `files of ${p.id}`),
  };
  return page;
}

/** Whether this store holds the purge with this id. */
function hasPurge(db: Database, id: string): boolean {
  return db.prepare('SELECT 1 AS one FROM purge WHERE id = ?').get(id) !== undefined;
}

/**
 * Apply on this device a purge its hub made (see purgeFeed): the rules run here from the ids the
 * hub removed, as far as this store holds them, since it may hold more of a session or other lines
 * that yield the same events; the record keeps the hub's id, origin, author, reason, and selector,
 * this store's counts, the channel `hub`, and when it arrived, even when nothing here was removed.
 * A purge this store holds already is passed over (null). A plan this store refuses (the last line
 * of a generated source it cannot go on from) throws an OriginError and deletes nothing, so that a
 * later sync applies it.
 */
export function applyHubPurge(
  db: Database,
  home: string,
  adapters: PurgeAdapters,
  hub: HubPurge,
  opts: {
    complete?: boolean;
    budgetMs?: number;
    log?: (message: string) => void;
    now?: number;
  } = {},
): PurgeResult | null {
  if (!PURGE_ID_RE.test(hub.id)) throw new OriginError('Invalid purge id.');
  const reason = checkReason(hub.reason);
  if (hasPurge(db, hub.id)) return null;
  const first = makePlan(db, home, adapters, hub.selector, undefined, hub.items);
  const parses = states.get(first)?.planner.files;
  return underLock(db, home, adapters, opts, () => {
    if (hasPurge(db, hub.id)) return null;
    const plan = makePlan(db, home, adapters, hub.selector, parses, hub.items);
    if (plan.refusals.length > 0) {
      throw new OriginError(
        `The hub's purge ${hub.id} cannot be applied here yet: ${plan.refusals.join(' ')}`,
      );
    }
    return applyPlan(db, plan, states.get(plan) as PlanState, {
      id: hub.id,
      at: hub.at,
      origin: hub.origin,
      author: hub.author,
      channel: 'hub',
      reason,
      actor: hub.author,
      receivedAt: opts.now ?? Date.now(),
    });
  });
}
