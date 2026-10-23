import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  type Database,
  initStoreName,
  makeRelay,
  openDatabase,
  type RelayPending,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relayWithHub } from '../src/hub/relay.js';
import {
  agentRetention,
  CLAUDE_CODE_CLEANUP_DAYS,
  RetentionWatch,
  retentionWarning,
  retentionWarnings,
} from '../src/hub/retention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23, 12);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-retention-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Claude Code's settings in a config directory of the test's own. */
const claudeSettings = (settings: unknown) => {
  fs.writeFileSync(
    path.join(tmp, 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings),
  );
  return { CLAUDE_CONFIG_DIR: tmp };
};

const pending = (source: string, oldestDaysAgo: number | null): RelayPending => ({
  source,
  files: 3,
  pendingFiles: oldestDaysAgo === null ? 0 : 2,
  pendingBytes: oldestDaysAgo === null ? 0 : 1234,
  oldestPendingMtimeMs: oldestDaysAgo === null ? null : NOW - oldestDaysAgo * DAY,
});

describe("agents' retention", () => {
  it("reads Claude Code's cleanupPeriodDays, or takes its default", () => {
    expect(agentRetention('claude-code', { CLAUDE_CONFIG_DIR: tmp })).toEqual({
      days: CLAUDE_CODE_CLEANUP_DAYS,
      basis: 'cleanupPeriodDays, by default',
    });
    expect(agentRetention('claude-code', claudeSettings({ cleanupPeriodDays: 10 }))).toEqual({
      days: 10,
      basis: `cleanupPeriodDays in ${path.join(tmp, 'settings.json')}`,
    });
    // Values Claude Code does not accept, and settings it cannot read, leave the default.
    for (const settings of [
      { cleanupPeriodDays: 0 },
      { cleanupPeriodDays: '7' },
      '{not json',
      {},
    ]) {
      expect(agentRetention('claude-code', claudeSettings(settings))?.days).toBe(30);
    }
  });

  it('knows no retention for the other agents', () => {
    for (const source of ['codex', 'cursor', 'grok', 'zcode']) {
      expect(agentRetention(source, { CLAUDE_CONFIG_DIR: tmp })).toBeNull();
    }
  });
});

describe('warnings before agents delete unsent logs', () => {
  const warn = (source: string, oldest: number | null, lastSyncDaysAgo: number | null, env = {}) =>
    retentionWarning(
      {
        agent: source === 'claude-code' ? 'Claude Code' : 'Codex',
        pending: pending(source, oldest),
        lastSyncAt: lastSyncDaysAgo === null ? null : NOW - lastSyncDaysAgo * DAY,
      },
      { now: NOW, env: { CLAUDE_CONFIG_DIR: tmp, ...env } },
    );

  it('warns a week before Claude Code deletes a session the hub does not have', () => {
    expect(warn('claude-code', null, null)).toBeNull();
    expect(warn('claude-code', 22, 1)).toBeNull();
    expect(warn('claude-code', 24, 1)).toBe(
      'Claude Code sessions not sent to the hub yet were last written 24 days ago, and Claude Code deletes them after 30 days (cleanupPeriodDays, by default); this relay keeps no copy of what it has not sent. Send them with origin sync within 6 days.',
    );
    expect(warn('claude-code', 30.5, 0)).toMatch(
      /last written 30 days ago, .* They may be deleted at any time: send them with origin sync as soon as the hub can be reached\.$/,
    );
  });

  it('warns at half of a shorter cleanupPeriodDays', () => {
    const env = claudeSettings({ cleanupPeriodDays: 4 });
    expect(warn('claude-code', 1.9, null, env)).toBeNull();
    expect(warn('claude-code', 2.5, null, env)).toMatch(
      /deletes them after 4 days \(cleanupPeriodDays in .*settings\.json\); .* within 1 day\.$/,
    );
    expect(warn('claude-code', 3.9, null, env)).toMatch(/within 2 hours\.$/);
  });

  it('warns for other agents only after a week with nothing sent', () => {
    expect(warn('codex', 6, null)).toBeNull();
    expect(warn('codex', 8, null)).toBe(
      'Codex sessions not sent to the hub yet were last written 8 days ago, and they have never been sent to the hub; this relay keeps no copy of what it has not sent, so if Codex deletes its old logs, they are lost. Send them with origin sync once the hub can be reached.',
    );
    // A recent sync reached the hub: whatever is left waits for a reason the sync reported.
    expect(warn('codex', 30, 2)).toBeNull();
    expect(warn('codex', 30, 9)).toMatch(/and this relay last reached the hub 9 days ago;/);
  });

  it('looks at most once an hour while syncs fail, and again after one succeeds', async () => {
    let now = NOW;
    let looks = 0;
    const logged: string[] = [];
    const watch = new RetentionWatch(
      async () => {
        looks++;
        return ['first', 'second'];
      },
      (m) => logged.push(m),
      () => now,
    );
    await watch.check();
    expect(watch.current).toBe('first second');
    expect(logged).toEqual(['warning: first', 'warning: second']);
    now += 30 * 60_000;
    await watch.check();
    expect(looks).toBe(1);
    now += 30 * 60_000;
    await watch.check();
    expect(looks).toBe(2);
    watch.reset();
    expect(watch.current).toBeNull();
    await watch.check();
    expect(looks).toBe(3);
    // A look that fails is only skipped.
    const broken = new RetentionWatch(
      async () => {
        throw new Error('unreadable');
      },
      () => {},
    );
    await expect(broken.check()).resolves.toBeUndefined();
    expect(broken.current).toBeNull();
  });
});

describe('a relay whose hub cannot be reached', () => {
  let db: Database;
  let projects: string;
  beforeEach(() => {
    db = openDatabase(path.join(tmp, 'relay', 'origin.db'));
    initStoreName(db, 'laptop');
    makeRelay(db);
    projects = path.join(tmp, 'projects');
    fs.cpSync(
      fileURLToPath(new URL('../../adapters/test/fixtures/claude-code/', import.meta.url)),
      projects,
      { recursive: true },
    );
    // Written just now, whatever the checkout's times.
    for (const f of fs.readdirSync(projects, { recursive: true, encoding: 'utf8' })) {
      const file = path.join(projects, f);
      if (fs.statSync(file).isFile()) fs.utimesSync(file, new Date(), new Date());
    }
  });
  afterEach(() => db.close());

  it('warns of the Claude Code sessions it could not send before they are deleted', async () => {
    const adapter = createClaudeCodeAdapter({ projectsDir: projects });
    const offline: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const hub = { url: 'http://127.0.0.1:1', token: 'ogn_test', device: 'laptop' };
    await expect(
      relayWithHub({ db, home: path.join(tmp, 'relay'), hub, adapters: [adapter], fetch: offline }),
    ).rejects.toThrow(/Cannot reach the hub/);
    const env = { CLAUDE_CONFIG_DIR: tmp };
    // Written just now: nothing at risk yet.
    expect(await retentionWarnings(db, [adapter], { env })).toEqual([]);
    // Unchanged for 25 days, as Claude Code goes by: less than a week of its 30 days is left.
    const later = await retentionWarnings(db, [adapter], { env, now: Date.now() + 25 * DAY });
    expect(later).toHaveLength(1);
    expect(later[0]).toMatch(
      /^Claude Code sessions not sent to the hub yet were last written 25 days ago, .* within 4 days\.$/,
    );
  });
});
