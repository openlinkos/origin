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

/** How many children a session has, and the distinct workflow names among them. */
export function sessionFold(
  db: Database,
  source: string,
  sessionId: string,
): { children: number; workflows: string[] } {
  const rows = db
    .prepare(
      `SELECT run_name FROM session_parent WHERE parent_source = ? AND parent_session_id = ?`,
    )
    .all(source, sessionId) as Array<{ run_name: string | null }>;
  const workflows = [
    ...new Set(rows.map((r) => r.run_name).filter((n): n is string => n !== null)),
  ].sort();
  return { children: rows.length, workflows };
}

/** A session's children, ordered so one run stays together. */
export function childSessions(db: Database, source: string, sessionId: string): SessionParentRow[] {
  const rows = db
    .prepare(
      `SELECT source, session_id, parent_source, parent_session_id, via, run_group, run_name, signal
         FROM session_parent WHERE parent_source = ? AND parent_session_id = ?
        ORDER BY COALESCE(run_group, ''), source, session_id`,
    )
    .all(source, sessionId) as Array<{
    source: string;
    session_id: string;
    parent_source: string;
    parent_session_id: string;
    via: ParentVia;
    run_group: string | null;
    run_name: string | null;
    signal: string;
  }>;
  return rows.map((row) => ({
    source: row.source,
    sessionId: row.session_id,
    parentSource: row.parent_source,
    parentSessionId: row.parent_session_id,
    via: row.via,
    runGroup: row.run_group,
    runName: row.run_name,
    signal: row.signal,
  }));
}

/**
 * Whether a session is folded out of a top-level list: it has a parent, or a line says it is a
 * child and names no parent.
 */
export function isFoldedChild(db: Database, source: string, sessionId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM session_parent p WHERE p.source = ? AND p.session_id = ?)
         OR EXISTS (
           SELECT 1 FROM session_kind k
            WHERE k.source = ? AND k.session_id = ? AND k.kind = 'child')`,
      )
      .get(source, sessionId, source, sessionId) !== undefined
  );
}

/**
 * Sessions with no parent row and no child kind, as a condition on the `session` table. A timeline
 * lists these unless it is asked for children too.
 */
export const TOP_LEVEL_SESSION = `NOT EXISTS (
  SELECT 1 FROM session_parent p WHERE p.source = session.source AND p.session_id = session.session_id)
AND NOT EXISTS (
  SELECT 1 FROM session_kind k
   WHERE k.source = session.source AND k.session_id = session.session_id AND k.kind = 'child')`;

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
