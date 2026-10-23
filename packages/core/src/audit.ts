import type { Database } from './db.js';

/**
 * The audit log: an append-only record of administrative actions from the admin UI and the CLI
 * (see docs/architecture.md#admin-ui). Triggers reject every UPDATE and DELETE. Details hold ids
 * and counts only, never entry or event text, so that hidden content stays hidden (invariant 2).
 */
export type AuditChannel = 'ui' | 'cli';

/** Ids, names, counts, and flags. Never the text of an entry or event. */
export type AuditDetail = Record<string, string | number | boolean | null | ReadonlyArray<string>>;

export interface AuditInput {
  /**
   * `owner` for the hub's admin UI, `local` for `origin ui`, `anonymous` before sign-in, `cli` for
   * the command line, `hub` at startup.
   */
  actor: string;
  channel: AuditChannel;
  /** A dotted action name, e.g. `token.create`, `forget`, `login.failed`. */
  action: string;
  /** The id or name acted on. */
  target?: string | null;
  detail?: AuditDetail | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditRecord {
  id: number;
  at: number;
  actor: string;
  channel: AuditChannel;
  action: string;
  target: string | null;
  detail: AuditDetail | null;
  ip: string | null;
  userAgent: string | null;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Append an audit record; returns its id. */
export function recordAudit(db: Database, input: AuditInput, now = Date.now()): number {
  const info = db
    .prepare(
      `INSERT INTO audit_log (at, actor, channel, action, target, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now,
      clip(input.actor, 128) ?? 'unknown',
      input.channel,
      clip(input.action, 64) ?? 'unknown',
      clip(input.target, 256),
      input.detail ? JSON.stringify(input.detail) : null,
      clip(input.ip, 64),
      clip(input.userAgent, 256),
    );
  return Number(info.lastInsertRowid);
}

/** Audit records, newest first. `beforeId` pages backwards. */
export function listAudit(
  db: Database,
  opts: { limit?: number; beforeId?: number; action?: string } = {},
): AuditRecord[] {
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (opts.beforeId !== undefined) {
    parts.push('id < ?');
    params.push(opts.beforeId);
  }
  if (opts.action !== undefined) {
    parts.push('action = ?');
    params.push(opts.action);
  }
  params.push(opts.limit ?? 100);
  const rows = db
    .prepare(
      `SELECT id, at, actor, channel, action, target, detail, ip, user_agent FROM audit_log
       ${parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as unknown as Array<{
    id: number;
    at: number;
    actor: string;
    channel: AuditChannel;
    action: string;
    target: string | null;
    detail: string | null;
    ip: string | null;
    user_agent: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    channel: r.channel,
    action: r.action,
    target: r.target,
    detail: r.detail ? (JSON.parse(r.detail) as AuditDetail) : null,
    ip: r.ip,
    userAgent: r.user_agent,
  }));
}
