import { createHash } from 'node:crypto';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { isOwnerConversation, type SessionPrompt, sessionPrompts } from './store.js';

/**
 * Threads (see docs/architecture.md#threads): the sessions of one piece of work, as the person sees
 * it, across sessions and agents. A thread is a set of sessions that two deterministic rules join,
 * transitively:
 *
 * - R1, follow. An agent declared, with the MCP tool `follow`, that its session continues another.
 *   The tool writes nothing itself: its result, which the agent's log records as a tool result,
 *   carries a link (`"link": "lnk_…"`) and the session it continues (`"follows": "<source>:<id>"`).
 *   Ingestion derives a row of session_follow from each such event, the same on every store that
 *   parses the line. A link counts while its event is visible (invariant 2).
 * - R2, branch. The owner's conversations (see isOwnerConversation in store.ts) of the same project
 *   on the same git branch, other than a default branch (DEFAULT_BRANCHES), whose times are at most
 *   BRANCH_GAP_MS apart (from the end of one to the start of the next). A sub-agent's session or a
 *   headless run on the branch is no piece of the owner's work by itself, and joins none this way.
 * - A child (see session_parent, or a session_kind of `child`) joins its parent's thread when that
 *   parent is already in one. It never becomes the root, and a parent with only its children is
 *   not a thread: children never create one.
 *
 * Only sessions with visible events take part. A group of one session is no thread. A thread's id
 * is derived from its root, the member that started first among those that are not children (ties
 * by source, then session id), so every store that holds the same members gives it the same id; it
 * changes only when an earlier session joins, as when older logs arrive later. session_thread holds
 * the members of every thread; it is kept up to date as sessions change (refreshThreads) and can be
 * rebuilt (rebuildThreads).
 */

export const THREAD_ID_RE = /^thr_[0-9a-f]{12}$/;

export function isThreadId(id: string): boolean {
  return id.startsWith('thr_');
}

/**
 * Branches that hold every kind of work rather than one piece of it, and a detached head: sessions
 * on them are joined by follow links only.
 */
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set([
  'main',
  'master',
  'trunk',
  'develop',
  'dev',
  'head',
]);

/** Sessions of one branch further apart than this, end to start, are separate pieces of work. */
export const BRANCH_GAP_MS = 30 * 86_400_000;

/** Whether a branch joins the sessions on it into a thread (R2): set, and not a default branch. */
export function isWorkBranch(branch: string | null | undefined): branch is string {
  if (!branch) return false;
  const name = branch.trim().toLowerCase();
  return name !== '' && !DEFAULT_BRANCHES.has(name);
}

/** The id of the thread whose root is this session: `thr_` and 12 hex characters of a SHA-256. */
export function threadIdOf(source: string, sessionId: string): string {
  const digest = createHash('sha256').update(`${source}:${sessionId}`).digest('hex');
  return `thr_${digest.slice(0, 12)}`;
}

/** Link ids, as `follow` makes them: `lnk_` and random hex. */
export const LINK_ID_RE = /^lnk_[0-9a-f]{12}$/;

/** A follow link as a tool result carries it. */
export interface FollowLink {
  link: string;
  /** The session it continues. */
  source: string;
  sessionId: string;
}

const LINK_RE = /"link":\s*"(lnk_[0-9a-f]{12})"/;
const FOLLOWS_RE = /"follows":\s*"([a-z][a-z0-9-]*):([^"\\\s]{1,512})"/;

/**
 * The follow link a tool result carries, or null: the result of `follow`, which names its link and
 * the session it continues. The same text quoted inside another result (a search that found it,
 * say) has its quotes escaped, so it is not taken for one.
 */
export function followLink(text: string): FollowLink | null {
  if (!text.includes('"lnk_')) return null;
  const link = LINK_RE.exec(text)?.[1];
  const follows = FOLLOWS_RE.exec(text);
  if (!link || !follows) return null;
  return { link, source: follows[1] as string, sessionId: follows[2] as string };
}

/** What deriveFollow reads of an event. */
export interface FollowEvent {
  /** The event's full id, `<source>:…`. */
  id: string;
  source: string;
  sessionId: string;
  kind: string;
  text: string;
}

/**
 * Record the follow link an event carries, if it is a tool result that carries one (R1); a session
 * that follows itself links nothing. Returns whether it did. Must run inside a write transaction.
 */
export function deriveFollow(db: Database, ev: FollowEvent): boolean {
  if (ev.kind !== 'tool_result') return false;
  const link = followLink(ev.text);
  if (!link || (link.source === ev.source && link.sessionId === ev.sessionId)) return false;
  db.prepare(
    `INSERT OR IGNORE INTO session_follow
       (source, session_id, link_id, target_source, target_session_id, event_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ev.source, ev.sessionId, link.link, link.source, link.sessionId, ev.id);
  return true;
}

/** A session, as thread membership sees it. */
interface Node {
  source: string;
  session_id: string;
  project: string | null;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
}

const NODE_COLUMNS = 'source, session_id, project, git_branch, started_at, ended_at';
/** Sessions with visible events: only they take part. */
const VISIBLE_SESSION = 'event_count > 0 AND started_at IS NOT NULL';

const keyOf = (source: string, sessionId: string) => `${source}\n${sessionId}`;

/**
 * Whether a session takes part in R2, its branch's runs: the owner's conversation (see
 * isOwnerConversation), looked up once per session.
 */
function branchMember(db: Database): (n: Node) => boolean {
  const known = new Map<string, boolean>();
  return (n) => {
    const k = keyOf(n.source, n.session_id);
    let owner = known.get(k);
    if (owner === undefined) {
      owner = isOwnerConversation(db, n.source, n.session_id);
      known.set(k, owner);
    }
    return owner;
  };
}

/** Union-find over session keys. */
class Groups {
  private readonly parent = new Map<string, string>();
  find(k: string): string {
    let root = k;
    for (let p = this.parent.get(root); p !== undefined && p !== root; p = this.parent.get(root)) {
      root = p;
    }
    // Path compression.
    for (let at = k; at !== root; ) {
      const next = this.parent.get(at) ?? root;
      this.parent.set(at, root);
      at = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * A child session: it has a parent, or a line says it is a child. Never a thread's root.
 * session_kind arrives in version 8 and session_parent in version 10; a migration that derives
 * threads before then omits the table it does not have.
 */
function childSession(db: Database): (source: string, sessionId: string) => boolean {
  const parent = hasTable(db, 'session_parent');
  const kind = hasTable(db, 'session_kind');
  if (!parent && !kind) return () => false;
  const parts: string[] = [];
  if (parent) {
    parts.push('EXISTS (SELECT 1 FROM session_parent p WHERE p.source = ? AND p.session_id = ?)');
  }
  if (kind) {
    parts.push(
      "EXISTS (SELECT 1 FROM session_kind k WHERE k.source = ? AND k.session_id = ? AND k.kind = 'child')",
    );
  }
  const stmt = db.prepare(`SELECT 1 WHERE ${parts.join(' OR ')}`);
  const known = new Map<string, boolean>();
  return (source, sessionId) => {
    const k = keyOf(source, sessionId);
    let child = known.get(k);
    if (child === undefined) {
      child =
        stmt.get(
          ...(parent && kind ? [source, sessionId, source, sessionId] : [source, sessionId]),
        ) !== undefined;
      known.set(k, child);
    }
    return child;
  };
}

/** Whether this connection has the table. A later migration on the same connection may create it. */
function hasTable(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Attach the children of sessions that are already in a thread (a component of two or more) to
 * that thread, and their children in turn, when the child has visible events and is not already
 * in a thread of its own. A parent and its children alone stay apart: nothing here starts a thread.
 */
function attachChildren(db: Database, nodes: Map<string, Node>, groups: Groups): void {
  // Version 10 creates session_parent. Earlier derivations have no parent rows to attach.
  if (!hasTable(db, 'session_parent')) return;
  const sizes = new Map<string, number>();
  for (const k of nodes.keys()) {
    const root = groups.find(k);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  const anchored = new Set<string>();
  for (const k of nodes.keys()) {
    if ((sizes.get(groups.find(k)) ?? 0) >= 2) anchored.add(k);
  }
  const childrenOf = db.prepare(
    `SELECT source, session_id FROM session_parent
      WHERE parent_source = ? AND parent_session_id = ?
      ORDER BY source, session_id`,
  );
  const load = db.prepare(
    `SELECT ${NODE_COLUMNS} FROM session WHERE source = ? AND session_id = ? AND ${VISIBLE_SESSION}`,
  );
  const queue = [...anchored].sort();
  const seen = new Set<string>(anchored);
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i] as string;
    const at = k.indexOf('\n');
    const source = k.slice(0, at);
    const sessionId = k.slice(at + 1);
    for (const c of childrenOf.all(source, sessionId) as Array<{
      source: string;
      session_id: string;
    }>) {
      const ck = keyOf(c.source, c.session_id);
      if (seen.has(ck)) continue;
      seen.add(ck);
      const node = nodes.get(ck) ?? (load.get(c.source, c.session_id) as Node | undefined);
      if (!node) continue;
      nodes.set(ck, node);
      groups.union(k, ck);
      queue.push(ck);
    }
  }
}

/** Which session comes first, for a thread's root: by start, then source, then session id. */
function earlier(a: Node, b: Node): boolean {
  if (a.started_at !== b.started_at) return a.started_at < b.started_at;
  if (a.source !== b.source) return a.source < b.source;
  return a.session_id < b.session_id;
}

/**
 * The sessions of one project and work branch, cut into runs whose sessions are at most
 * BRANCH_GAP_MS apart (R2), each run as a list of session keys.
 */
function branchRuns(sessions: Node[]): string[][] {
  const sorted = [...sessions].sort((a, b) => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0));
  const runs: string[][] = [];
  let run: string[] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const s of sorted) {
    if (run.length > 0 && s.started_at - end > BRANCH_GAP_MS) {
      runs.push(run);
      run = [];
      end = Number.NEGATIVE_INFINITY;
    }
    run.push(keyOf(s.source, s.session_id));
    end = Math.max(end, s.ended_at);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** A follow link counts while its event is visible (invariant 2). */
const VISIBLE_LINK = 'NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = f.event_id)';

/**
 * Write the threads of the components `groups` forms over `nodes`, after removing the rows of every
 * session in `affected`: a component of two or more sessions is a thread, under the id of its root.
 * The root is the earliest member that is not a child. A component whose members are all children
 * is not a thread.
 */
function writeThreads(
  db: Database,
  affected: Iterable<string>,
  nodes: Map<string, Node>,
  groups: Groups,
): void {
  const remove = db.prepare('DELETE FROM session_thread WHERE source = ? AND session_id = ?');
  for (const k of affected) {
    const at = k.indexOf('\n');
    remove.run(k.slice(0, at), k.slice(at + 1));
  }
  const components = new Map<string, Node[]>();
  for (const [k, node] of nodes) {
    const root = groups.find(k);
    const list = components.get(root);
    if (list) list.push(node);
    else components.set(root, [node]);
  }
  const child = childSession(db);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO session_thread (source, session_id, thread_id) VALUES (?, ?, ?)',
  );
  for (const members of components.values()) {
    if (members.length < 2) continue;
    let root: Node | null = null;
    for (const m of members) {
      if (child(m.source, m.session_id)) continue;
      if (!root || earlier(m, root)) root = m;
    }
    if (!root) continue;
    const id = threadIdOf(root.source, root.session_id);
    for (const m of members) insert.run(m.source, m.session_id, id);
  }
}

/**
 * Bring the threads of these sessions up to date, after their events, branch, or links changed:
 * the threads they were in and the ones they are in now are computed again, from session and
 * session_follow, by following both rules from them. Other threads cannot have changed, since a
 * link or a branch run changes only with one of its sessions. Must run inside a write transaction.
 */
export function refreshThreads(
  db: Database,
  sessions: Iterable<{ source: string; sessionId: string }>,
): void {
  const q = {
    node: db.prepare(
      `SELECT ${NODE_COLUMNS} FROM session WHERE source = ? AND session_id = ? AND ${VISIBLE_SESSION}`,
    ),
    threadOf: db.prepare(
      'SELECT thread_id FROM session_thread WHERE source = ? AND session_id = ?',
    ),
    members: db.prepare('SELECT source, session_id FROM session_thread WHERE thread_id = ?'),
    branch: db.prepare(
      `SELECT ${NODE_COLUMNS} FROM session
        WHERE project = ? AND git_branch = ? AND ${VISIBLE_SESSION}`,
    ),
    follows: db.prepare(
      `SELECT f.target_source AS source, f.target_session_id AS session_id FROM session_follow f
        WHERE f.source = ? AND f.session_id = ? AND ${VISIBLE_LINK}
       UNION
       SELECT f.source, f.session_id FROM session_follow f
        WHERE f.target_source = ? AND f.target_session_id = ? AND ${VISIBLE_LINK}`,
    ),
    parent: hasTable(db, 'session_parent')
      ? db.prepare(
          'SELECT parent_source, parent_session_id FROM session_parent WHERE source = ? AND session_id = ?',
        )
      : null,
    children: hasTable(db, 'session_parent')
      ? db.prepare(
          'SELECT source, session_id FROM session_parent WHERE parent_source = ? AND parent_session_id = ?',
        )
      : null,
  };
  const expand = (source: string, sessionId: string) => {
    if (!q.parent || !q.children) return;
    const parent = q.parent.get(source, sessionId) as
      | { parent_source: string; parent_session_id: string }
      | undefined;
    if (parent) visit(parent.parent_source, parent.parent_session_id);
    for (const c of q.children.all(source, sessionId) as Array<{
      source: string;
      session_id: string;
    }>) {
      visit(c.source, c.session_id);
    }
  };
  const seen = new Set<string>();
  const pending: Array<[string, string]> = [];
  const visit = (source: string, sessionId: string) => {
    const k = keyOf(source, sessionId);
    if (seen.has(k)) return;
    seen.add(k);
    pending.push([source, sessionId]);
  };
  for (const s of sessions) {
    visit(s.source, s.sessionId);
    const old = q.threadOf.get(s.source, s.sessionId) as { thread_id: string } | undefined;
    if (!old) continue;
    for (const m of q.members.all(old.thread_id) as Array<{ source: string; session_id: string }>)
      visit(m.source, m.session_id);
  }
  if (pending.length === 0) return;

  const nodes = new Map<string, Node>();
  const groups = new Groups();
  const runs = new Map<string, Map<string, string[]>>(); // by project and branch: each key's run
  const member = branchMember(db);
  const load = (source: string, sessionId: string): Node | null => {
    const k = keyOf(source, sessionId);
    const known = nodes.get(k);
    if (known) return known;
    const node = q.node.get(source, sessionId) as Node | undefined;
    if (!node) return null;
    nodes.set(k, node);
    return node;
  };
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [source, sessionId] = next;
    // A child leaves its parent's thread with the parent, and a parent takes its children with it.
    expand(source, sessionId);
    const node = load(source, sessionId);
    if (!node) continue; // no visible events: in no thread
    const k = keyOf(source, sessionId);
    groups.find(k);
    if (node.project !== null && isWorkBranch(node.git_branch) && member(node)) {
      const branchKey = `${node.project}\n${node.git_branch}`;
      let byKey = runs.get(branchKey);
      if (!byKey) {
        byKey = new Map();
        const all = (q.branch.all(node.project, node.git_branch) as unknown as Node[]).filter(
          member,
        );
        for (const run of branchRuns(all)) for (const key of run) byKey.set(key, run);
        runs.set(branchKey, byKey);
      }
      for (const key of byKey.get(k) ?? []) {
        if (key === k) continue;
        const at = key.indexOf('\n');
        const other = load(key.slice(0, at), key.slice(at + 1));
        if (!other) continue;
        groups.union(k, key);
        visit(other.source, other.session_id);
      }
    }
    for (const f of q.follows.all(source, sessionId, source, sessionId) as Array<{
      source: string;
      session_id: string;
    }>) {
      const other = load(f.source, f.session_id);
      if (!other) continue; // a session this store does not have, or whose events were forgotten
      groups.union(k, keyOf(f.source, f.session_id));
      visit(f.source, f.session_id);
    }
  }
  attachChildren(db, nodes, groups);
  writeThreads(db, seen, nodes, groups);
}

/**
 * Derive every follow link from the events, and every thread from the sessions and the links, from
 * scratch: what refreshThreads keeps up to date as it goes. Must run inside a write transaction (see
 * rebuildThreads). `anySession` lets R2 join every session on a branch, as migration 5 did before
 * the store knew who wrote what (version 8 derives the threads again by the rule).
 */
export function deriveThreads(db: Database, opts: { anySession?: boolean } = {}): void {
  db.exec('DELETE FROM session_follow');
  // Through the search index: only tool results that contain a link id are read.
  const candidates = db
    .prepare(
      `SELECT e.id, e.source, e.session_id AS sessionId, e.kind, e.text
         FROM event_fts f JOIN event e ON e.seq = f.rowid
        WHERE event_fts MATCH '"lnk" AND "nk_"' AND e.kind = 'tool_result'`,
    )
    .all() as unknown as FollowEvent[];
  for (const ev of candidates) deriveFollow(db, ev);

  const nodes = new Map<string, Node>();
  for (const n of db
    .prepare(`SELECT ${NODE_COLUMNS} FROM session WHERE ${VISIBLE_SESSION}`)
    .all() as unknown as Node[]) {
    nodes.set(keyOf(n.source, n.session_id), n);
  }
  const groups = new Groups();
  const byBranch = new Map<string, Node[]>();
  const member = opts.anySession ? () => true : branchMember(db);
  for (const n of nodes.values()) {
    if (n.project === null || !isWorkBranch(n.git_branch) || !member(n)) continue;
    const k = `${n.project}\n${n.git_branch}`;
    const list = byBranch.get(k);
    if (list) list.push(n);
    else byBranch.set(k, [n]);
  }
  for (const sessions of byBranch.values()) {
    for (const run of branchRuns(sessions)) {
      for (const k of run.slice(1)) groups.union(run[0] as string, k);
    }
  }
  const links = db
    .prepare(
      `SELECT f.source, f.session_id, f.target_source, f.target_session_id
         FROM session_follow f WHERE ${VISIBLE_LINK}`,
    )
    .all() as unknown as Array<{
    source: string;
    session_id: string;
    target_source: string;
    target_session_id: string;
  }>;
  for (const l of links) {
    const a = keyOf(l.source, l.session_id);
    const b = keyOf(l.target_source, l.target_session_id);
    if (nodes.has(a) && nodes.has(b)) groups.union(a, b);
  }
  attachChildren(db, nodes, groups);
  db.exec('DELETE FROM session_thread');
  writeThreads(db, [], nodes, groups);
}

/** Rebuild the follow links and the threads from the events and sessions (see deriveThreads). */
export function rebuildThreads(db: Database): void {
  transaction(db, () => deriveThreads(db), { immediate: true });
}

/** The thread a session is in, or null. */
export function threadOf(db: Database, source: string, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT t.thread_id FROM session_thread t JOIN session s
          ON s.source = t.source AND s.session_id = t.session_id
        WHERE t.source = ? AND t.session_id = ? AND s.event_count > 0`,
    )
    .get(source, sessionId) as { thread_id: string } | undefined;
  return row?.thread_id ?? null;
}

/** What a thread is, from its members: how many, when, which agents, which work branches. */
export interface ThreadSummary {
  id: string;
  sessions: number;
  startedAt: number | null;
  endedAt: number | null;
  /** The sources of its sessions, by name. */
  agents: string[];
  /** The work branches its sessions were on (see isWorkBranch), by name. */
  branches: string[];
}

/** A thread's summary, or null for a thread with no visible sessions (an unknown id). */
export function threadSummary(db: Database, id: string): ThreadSummary | null {
  const rows = db
    .prepare(
      `SELECT s.source, s.git_branch, s.started_at, s.ended_at FROM session_thread t
         JOIN session s ON s.source = t.source AND s.session_id = t.session_id
        WHERE t.thread_id = ? AND s.event_count > 0`,
    )
    .all(id) as unknown as Array<{
    source: string;
    git_branch: string | null;
    started_at: number | null;
    ended_at: number | null;
  }>;
  if (rows.length === 0) return null;
  const agents = new Set<string>();
  const branches = new Set<string>();
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  for (const r of rows) {
    agents.add(r.source);
    if (isWorkBranch(r.git_branch)) branches.add(r.git_branch);
    if (r.started_at !== null && (startedAt === null || r.started_at < startedAt))
      startedAt = r.started_at;
    if (r.ended_at !== null && (endedAt === null || r.ended_at > endedAt)) endedAt = r.ended_at;
  }
  return {
    id,
    sessions: rows.length,
    startedAt,
    endedAt,
    agents: [...agents].sort(),
    branches: [...branches].sort(),
  };
}

/** A thread's latest prompt, with the session it is in. */
export type ThreadPrompt = SessionPrompt & { source: string; sessionId: string };

/** How many of a thread's latest sessions are looked at for its last prompt. */
const LAST_PROMPT_SESSIONS = 5;

/** The latest prompt of a thread: of its most recent session that has one . */
export function threadLastPrompt(
  db: Database,
  id: string,
  opts: { until?: number } = {},
): ThreadPrompt | null {
  const latest = db
    .prepare(
      `SELECT s.source, s.session_id FROM session_thread t
         JOIN session s ON s.source = t.source AND s.session_id = t.session_id
        WHERE t.thread_id = ? AND s.event_count > 0 AND s.started_at <= ?
        ORDER BY s.ended_at DESC, s.source, s.session_id LIMIT ?`,
    )
    .all(id, opts.until ?? Number.MAX_SAFE_INTEGER, LAST_PROMPT_SESSIONS) as unknown as Array<{
    source: string;
    session_id: string;
  }>;
  for (const s of latest) {
    const prompts = sessionPrompts(db, s.source, s.session_id);
    const last = (
      opts.until === undefined ? prompts : prompts.filter((p) => p.ts <= (opts.until as number))
    ).at(-1);
    if (last) return { ...last, source: s.source, sessionId: s.session_id };
  }
  return null;
}
