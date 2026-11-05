import type { Database } from './db.js';
import type { SessionParentFact } from './types.js';

export type { SessionParentFact };

/**
 * Parent sessions (see docs/architecture.md#parent-sessions). A child session is one an agent ran
 * for another: a sub-agent, or a step of a workflow. The link is derived from the lines, the same
 * on every store, and kept in session_parent. `session.title` stays the title the agent stored;
 * a workflow step is shown under its run's name only when it is read (see displayTitle).
 *
 * A line of an agent names the parent (`fromAgent`). A `parent` line of `places.jsonl` fills a
 * parent the agent's own lines do not carry, or a run's group and name, and does not replace a
 * parent the agent's line already named.
 */

export type ParentVia = 'subagent' | 'workflow';

/** A row of session_parent. */
export interface SessionParentRow {
  source: string;
  sessionId: string;
  parentSource: string;
  parentSessionId: string;
  via: ParentVia;
  runGroup: string | null;
  runName: string | null;
  signal: string;
}

/**
 * Signals an agent's own line uses. A `parent` line does not replace a parent recorded under one
 * of these; `parent_session_id` (a parent known only from a summary) is not one of them.
 */
const AGENT_SIGNALS = new Set(['parent_id', 'subagent_spawned', 'parent_thread_id', 'dwf_run']);

const VIAS = new Set<ParentVia>(['subagent', 'workflow']);

/** The token a workflow step's stored title carries: `actor#N@M`. */
const ACTOR_TITLE = /actor#(\d+)@(\d+)/;

const nonempty = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null;

/**
 * Keep a line's statement that a session of `source` has a parent; returns whether the row
 * changed. A parent the agent's own line named is kept when a `parent` line names another, and a
 * run's group and name are filled only where the row has none. Must run inside a write transaction.
 */
export function recordSessionParent(
  db: Database,
  source: string,
  fact: SessionParentFact,
): boolean {
  const sessionId = nonempty(fact.sessionId);
  const parentId = nonempty(fact.parentSessionId);
  const parentSource = nonempty(fact.parentSource) ?? source;
  const signal = nonempty(fact.signal);
  if (!sessionId || !parentId || !signal || !VIAS.has(fact.via)) return false;
  if (parentSource === source && parentId === sessionId) return false;
  const group = nonempty(fact.runGroup);
  const name = nonempty(fact.runName);
  const existing = db
    .prepare(
      `SELECT parent_source, parent_session_id, via, run_group, run_name, signal
         FROM session_parent WHERE source = ? AND session_id = ?`,
    )
    .get(source, sessionId) as
    | {
        parent_source: string;
        parent_session_id: string;
        via: ParentVia;
        run_group: string | null;
        run_name: string | null;
        signal: string;
      }
    | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO session_parent
         (source, session_id, parent_source, parent_session_id, via, run_group, run_name, signal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(source, sessionId, parentSource, parentId, fact.via, group, name, signal);
    return true;
  }
  const sameParent =
    existing.parent_source === parentSource && existing.parent_session_id === parentId;
  const replace = !sameParent && (fact.fromAgent === true || !AGENT_SIGNALS.has(existing.signal));
  const next = {
    parent_source: replace ? parentSource : existing.parent_source,
    parent_session_id: replace ? parentId : existing.parent_session_id,
    via: replace ? fact.via : existing.via,
    signal: replace ? signal : existing.signal,
    run_group: existing.run_group ?? group,
    run_name: existing.run_name ?? name,
  };
  if (
    next.parent_source === existing.parent_source &&
    next.parent_session_id === existing.parent_session_id &&
    next.via === existing.via &&
    next.signal === existing.signal &&
    next.run_group === existing.run_group &&
    next.run_name === existing.run_name
  ) {
    return false;
  }
  db.prepare(
    `UPDATE session_parent
        SET parent_source = ?, parent_session_id = ?, via = ?, run_group = ?, run_name = ?, signal = ?
      WHERE source = ? AND session_id = ?`,
  ).run(
    next.parent_source,
    next.parent_session_id,
    next.via,
    next.run_group,
    next.run_name,
    next.signal,
    source,
    sessionId,
  );
  return true;
}

/** The parent of a session, or null. */
export function getSessionParent(
  db: Database,
  source: string,
  sessionId: string,
): SessionParentRow | null {
  const row = db
    .prepare(
      `SELECT source, session_id, parent_source, parent_session_id, via, run_group, run_name, signal
         FROM session_parent WHERE source = ? AND session_id = ?`,
    )
    .get(source, sessionId) as
    | {
        source: string;
        session_id: string;
        parent_source: string;
        parent_session_id: string;
        via: ParentVia;
        run_group: string | null;
        run_name: string | null;
        signal: string;
      }
    | undefined;
  if (!row) return null;
  return {
    source: row.source,
    sessionId: row.session_id,
    parentSource: row.parent_source,
    parentSessionId: row.parent_session_id,
    via: row.via,
    runGroup: row.run_group,
    runName: row.run_name,
    signal: row.signal,
  };
}

/** A session counts when it has a visible event that is not a memory. Forgotten sessions do not. */
function visibleSession(source: string, session: string): string {
  return `EXISTS (
    SELECT 1 FROM event e
     WHERE e.source = ${source} AND e.session_id = ${session}
       AND e.kind <> 'memory'
       AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id))`;
}

/**
 * Visible children hung under the nearest visible ancestor. A forgotten session in the middle is
 * skipped: the child keeps its own via and run, and the parent columns are that ancestor.
 */
const HANGING_CHILD = `WITH RECURSIVE hang(
  source, session_id, via, run_group, run_name, signal, anc_source, anc_id, seen, depth
) AS (
  SELECT p.source, p.session_id, p.via, p.run_group, p.run_name, p.signal,
         p.parent_source, p.parent_session_id,
         char(31) || p.source || char(31) || p.session_id || char(31), 1
    FROM session_parent p
   WHERE ${visibleSession('p.source', 'p.session_id')}
  UNION ALL
  SELECT hang.source, hang.session_id, hang.via, hang.run_group, hang.run_name, hang.signal,
         p.parent_source, p.parent_session_id,
         hang.seen || hang.anc_source || char(31) || hang.anc_id || char(31), hang.depth + 1
    FROM hang
    JOIN session_parent p ON p.source = hang.anc_source AND p.session_id = hang.anc_id
   WHERE hang.depth < 32
     AND instr(hang.seen, char(31) || hang.anc_source || char(31) || hang.anc_id || char(31)) = 0
     AND NOT ${visibleSession('hang.anc_source', 'hang.anc_id')}
)
SELECT hang.source, hang.session_id, hang.via, hang.run_group, hang.run_name, hang.signal
  FROM hang
 WHERE hang.anc_source = ? AND hang.anc_id = ? AND ${visibleSession('hang.anc_source', 'hang.anc_id')}
 ORDER BY COALESCE(hang.run_group, ''), hang.source, hang.session_id`;

interface HangRow {
  source: string;
  session_id: string;
  via: ParentVia;
  run_group: string | null;
  run_name: string | null;
  signal: string;
}

function hangingUnder(db: Database, source: string, sessionId: string): HangRow[] {
  return db.prepare(HANGING_CHILD).all(source, sessionId) as unknown as HangRow[];
}

/** How many children a session has, and the distinct workflow names among them. */
export function sessionFold(
  db: Database,
  source: string,
  sessionId: string,
): { children: number; workflows: string[] } {
  const rows = hangingUnder(db, source, sessionId);
  const workflows = [
    ...new Set(rows.map((r) => r.run_name).filter((n): n is string => n !== null)),
  ].sort();
  return { children: rows.length, workflows };
}

/** A session's children, ordered so one run stays together. A hidden parent is skipped. */
export function childSessions(db: Database, source: string, sessionId: string): SessionParentRow[] {
  return hangingUnder(db, source, sessionId).map((row) => ({
    source: row.source,
    sessionId: row.session_id,
    parentSource: source,
    parentSessionId: sessionId,
    via: row.via,
    runGroup: row.run_group,
    runName: row.run_name,
    signal: row.signal,
  }));
}

/**
 * Whether a session is folded out of a top-level list: a parent chain from it ends at a visible
 * parent, and the chain is not a cycle.
 */
export function isFoldedChild(db: Database, source: string, sessionId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM session WHERE source = ? AND session_id = ? AND NOT (${TOP_LEVEL_SESSION})`,
      )
      .get(source, sessionId) !== undefined
  );
}

/**
 * Sessions that are not folded under a visible parent, as a condition on the `session` table.
 * A child is folded only when walking its parents reaches one that has a visible, non-memory
 * event and no further parent. A missing parent, a forgotten parent, a child kind with no parent
 * row, and a cycle (nothing in it is such an end) all stay listed.
 */
export const TOP_LEVEL_SESSION = `NOT EXISTS (
  WITH RECURSIVE chain(source, session_id, seen, depth) AS (
    SELECT p.parent_source, p.parent_session_id,
           char(31) || session.source || char(31) || session.session_id || char(31)
             || p.parent_source || char(31) || p.parent_session_id || char(31),
           1
      FROM session_parent p
     WHERE p.source = session.source AND p.session_id = session.session_id
    UNION ALL
    SELECT p.parent_source, p.parent_session_id,
           chain.seen || p.parent_source || char(31) || p.parent_session_id || char(31),
           chain.depth + 1
      FROM chain
      JOIN session_parent p ON p.source = chain.source AND p.session_id = chain.session_id
     WHERE chain.depth < 32
       AND instr(chain.seen, char(31) || p.parent_source || char(31) || p.parent_session_id || char(31)) = 0
  )
  SELECT 1 FROM chain
   WHERE NOT EXISTS (
           SELECT 1 FROM session_parent p
            WHERE p.source = chain.source AND p.session_id = chain.session_id)
     AND EXISTS (
           SELECT 1 FROM event e
            WHERE e.source = chain.source AND e.session_id = chain.session_id
              AND e.kind <> 'memory'
              AND NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)))`;

/**
 * The name a workflow child is shown under: `{run_name} · actor#N@M` when the run has a name and
 * the stored title contains `actor#N@M`. The stored title is unchanged.
 */
export function displayTitle(
  title: string | null,
  parent: { via: string; runName: string | null } | null,
): string | null {
  if (title === null || parent?.via !== 'workflow' || !parent.runName) return title;
  const actor = ACTOR_TITLE.exec(title);
  return actor ? `${parent.runName} · actor#${actor[1]}@${actor[2]}` : title;
}

/**
 * A `places.jsonl` `parent` object, or null when session, parent, via, or signal is missing.
 * Not a parse error: the caller still returns `{ events: [] }`.
 */
export function parentPlaceFact(obj: Record<string, unknown>): SessionParentFact | null {
  const sessionId = nonempty(obj.session);
  const parentSessionId = nonempty(obj.parent);
  const signal = nonempty(obj.signal);
  if (!sessionId || !parentSessionId || !signal) return null;
  if (obj.via !== 'subagent' && obj.via !== 'workflow') return null;
  return {
    sessionId,
    parentSessionId,
    via: obj.via,
    runGroup: nonempty(obj.group),
    runName: nonempty(obj.name),
    signal,
    fromAgent: false,
  };
}
