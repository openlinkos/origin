import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Database,
  lastRelayed,
  type RelayPending,
  relayPending,
  type SourceAdapter,
} from '@openlinkos/origin-core';

/**
 * Warnings for a relay whose agents may delete logs it has not sent yet (see
 * docs/architecture.md#relays). A relay keeps no copy: until the hub holds a session, the agent's
 * log is the only one, and some agents delete old logs. Claude Code deletes a session's log once it
 * has not been written for `cleanupPeriodDays` (30 by default); for agents whose retention is not
 * known, a relay warns once lines have waited a week with no sync that reached the hub.
 */

const DAY_MS = 86_400_000;

/** Claude Code's `cleanupPeriodDays` when its settings do not set one. */
export const CLAUDE_CODE_CLEANUP_DAYS = 30;
/** Warn this long before an agent's retention runs out (at half of it, for a shorter one). */
const WARN_BEFORE_MS = 7 * DAY_MS;
/** For an agent with no known retention: warn once lines waited this long with no sync. */
export const UNKNOWN_RETENTION_WARN_MS = 7 * DAY_MS;

type Env = Record<string, string | undefined>;

/** How long an agent keeps a log that is no longer written, if it is known to delete old logs. */
export interface Retention {
  days: number;
  /** Where the number comes from, for messages. */
  basis: string;
}

/**
 * The retention of a source's agent, or null if it is not known to delete old logs. Claude Code's
 * is `cleanupPeriodDays` in `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`, or 30 days.
 */
export function agentRetention(source: string, env: Env = process.env): Retention | null {
  if (source !== 'claude-code') return null;
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(dir, 'settings.json');
  let days: unknown;
  try {
    days = (JSON.parse(fs.readFileSync(file, 'utf8')) as { cleanupPeriodDays?: unknown })
      .cleanupPeriodDays;
  } catch {
    days = undefined; // no settings, or unreadable ones: Claude Code's default
  }
  if (typeof days === 'number' && Number.isFinite(days) && days >= 1) {
    return { days, basis: `cleanupPeriodDays in ${file}` };
  }
  return { days: CLAUDE_CODE_CLEANUP_DAYS, basis: 'cleanupPeriodDays, by default' };
}

/** What a relay knows of one source: what it has not sent, and when it last reached the hub. */
export interface PendingSource {
  /** The agent's name, such as Claude Code. */
  agent: string;
  pending: RelayPending;
  /** When this source was last relayed to the hub, or null if never. */
  lastSyncAt: number | null;
}

/** "3 days", "1 day", or "5 hours". */
function span(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** The warning for one source, or null if its oldest unsent log is not at risk yet. */
export function retentionWarning(
  s: PendingSource,
  opts: { now?: number; env?: Env } = {},
): string | null {
  const oldest = s.pending.oldestPendingMtimeMs;
  if (oldest === null) return null;
  const now = opts.now ?? Date.now();
  const age = now - oldest;
  const retention = agentRetention(s.pending.source, opts.env);
  const noCopy = 'this relay keeps no copy of what it has not sent';
  if (retention) {
    const limit = retention.days * DAY_MS;
    if (age < limit - Math.min(WARN_BEFORE_MS, limit / 2)) return null;
    const waiting = `${s.agent} sessions not sent to the hub yet were last written ${span(age)} ago, and ${s.agent} deletes them after ${retention.days} days (${retention.basis}); ${noCopy}.`;
    return age >= limit
      ? `${waiting} They may be deleted at any time: send them with origin sync as soon as the hub can be reached.`
      : `${waiting} Send them with origin sync within ${span(limit - age)}.`;
  }
  // No known retention: only once lines have waited, and nothing reached the hub, for a while.
  const since = s.lastSyncAt === null ? null : now - s.lastSyncAt;
  if (age < UNKNOWN_RETENTION_WARN_MS || (since !== null && since < UNKNOWN_RETENTION_WARN_MS)) {
    return null;
  }
  const reached =
    s.lastSyncAt === null
      ? 'they have never been sent to the hub'
      : `this relay last reached the hub ${span(since as number)} ago`;
  return `${s.agent} sessions not sent to the hub yet were last written ${span(age)} ago, and ${reached}; ${noCopy}, so if ${s.agent} deletes its old logs, they are lost. Send them with origin sync once the hub can be reached.`;
}

/** What a relay has not sent of each source, and when it last reached the hub. */
export async function pendingSources(
  db: Database,
  adapters: SourceAdapter[],
): Promise<PendingSource[]> {
  const sources: PendingSource[] = [];
  for (const adapter of adapters) {
    sources.push({
      agent: adapter.displayName,
      pending: await relayPending(db, adapter),
      lastSyncAt: lastRelayed(db, adapter.id)?.at ?? null,
    });
  }
  return sources;
}

/** The warnings for every source of a relay whose oldest unsent log is at risk. */
export async function retentionWarnings(
  db: Database,
  adapters: SourceAdapter[],
  opts: { now?: number; env?: Env } = {},
): Promise<string[]> {
  return (await pendingSources(db, adapters))
    .map((s) => retentionWarning(s, opts))
    .filter((w): w is string => w !== null);
}

/** How often `origin mcp` on a relay looks again. */
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * For `origin mcp` on a relay: after a sync that failed, look at most once an hour for logs at
 * risk, log each warning, and keep them for the tools' errors (the agent sees those; it may not
 * see the log).
 */
export class RetentionWatch {
  private checkedAt: number | null = null;
  private running = false;
  /** The warnings found by the last look, joined; null if there were none. */
  current: string | null = null;

  constructor(
    private readonly look: () => Promise<string[]>,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** After a sync that reached the hub: forget the last look, so that the next failure looks again. */
  reset(): void {
    this.checkedAt = null;
    this.current = null;
  }

  /** Look again unless the last look was less than an hour ago. Never throws. */
  async check(): Promise<void> {
    if (this.running) return;
    if (this.checkedAt !== null && this.now() - this.checkedAt < CHECK_EVERY_MS) return;
    this.running = true;
    try {
      const warnings = await this.look();
      this.checkedAt = this.now();
      this.current = warnings.length > 0 ? warnings.join(' ') : null;
      for (const w of warnings) this.log(`warning: ${w}`);
    } catch {
      // A look that fails is tried again after the next sync.
    } finally {
      this.running = false;
    }
  }
}
