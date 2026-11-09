import fs from 'node:fs';
import path from 'node:path';
import {
  correct,
  createToken,
  type Database,
  forget,
  initStoreName,
  parsePlaceLine,
  planRecall,
  purge,
  rebuildThreads,
  recordAudit,
  recordRecall,
  remember,
  restore,
  syncSource,
  transaction,
} from '../src/index.js';
import { applyPlaceFacts, rememberPlaceHead } from '../src/places.js';
import { fakeAdapter } from './helpers.js';

/**
 * A store with a little of everything a copy must carry (see store-copy.ts): sessions in two
 * places, on a work branch (a thread of two sessions) and with a child session; messages in English
 * and Chinese, one with a NUL; tool calls; entries, one corrected and one forgotten, an event
 * forgotten and brought back; recalls; a session and an event purged; an audit row; a token.
 */
export const RICH_T0 = Date.UTC(2026, 9, 1, 9);

/** Tables the rich store fills, each with a row or more. */
export const RICH_TABLES = [
  'session_thread',
  'session_place',
  'project_root',
  'place_head',
  'session_parent',
  'entry',
  'tombstone',
  'forgotten_entry',
  'change_log',
  'recall',
  'recall_item',
  'purge',
  'purged',
  'audit_log',
  'api_token',
];

interface Line {
  id?: string;
  session: string;
  ts: number;
  role?: 'user' | 'assistant';
  text?: string;
  kind?: string;
  project?: string;
  cwd?: string;
  branch?: string;
  meta?: Record<string, unknown>;
  parents?: Array<{ session: string; parent: string; via?: 'subagent' | 'workflow' }>;
}

const MIN = 60_000;

function write(logs: string, file: string, lines: Line[]): void {
  fs.appendFileSync(
    path.join(logs, file),
    lines.map((l) => `${JSON.stringify({ role: 'user', project: 'demo', ...l })}\n`).join(''),
  );
}

/** Fill the store at `db` (whose ORIGIN_HOME is `home`) from fake logs written under `logs`. */
export async function buildRichStore(db: Database, home: string, logs: string): Promise<void> {
  fs.mkdirSync(logs, { recursive: true });
  initStoreName(db, 'laptop');
  const t = (m: number) => RICH_T0 + m * MIN;
  const at = { cwd: '/work/demo/packages/core', branch: 'feat/store-copy' };
  write(logs, 'a.jsonl', [
    { id: 'a1', session: 's1', ts: t(0), text: 'Copy the store between engines', ...at },
    {
      id: 'a2',
      session: 's1',
      ts: t(1),
      role: 'assistant',
      text: 'The copy keeps every key: sequence numbers, rowids, audit ids.',
      ...at,
    },
    {
      id: 'a3',
      session: 's1',
      ts: t(2),
      role: 'assistant',
      kind: 'tool_use',
      text: 'grep -rn copyStore packages',
      meta: { toolName: 'Bash' },
      ...at,
    },
    {
      id: 'a4',
      session: 's1',
      ts: t(3),
      text: '把仓库迁移到另一个数据库，然后检查搜索结果',
      ...at,
    },
    {
      id: 'a5',
      session: 's1',
      ts: t(4),
      role: 'assistant',
      text: 'A line with a NUL\u0000in it, which PostgreSQL text cannot hold.',
      ...at,
    },
  ]);
  write(logs, 'b.jsonl', [
    {
      id: 'b1',
      session: 's2',
      ts: t(60),
      text: 'Continue the store copy: verify the digests',
      ...at,
    },
    {
      id: 'b2',
      session: 's2',
      ts: t(61),
      role: 'assistant',
      text: 'Digests match for every table; 数据库 searches agree.',
      ...at,
    },
  ]);
  write(logs, 'c.jsonl', [
    {
      session: 's3',
      ts: t(62),
      parents: [{ session: 's3', parent: 's2', via: 'subagent' }],
    },
    {
      id: 'c1',
      session: 's3',
      ts: t(62),
      text: 'Subagent: count the rows of each table',
      ...at,
    },
  ]);
  write(logs, 'd.jsonl', [
    {
      id: 'd1',
      session: 's4',
      ts: t(120),
      text: 'Notes on the deploy pipeline of the site',
      cwd: '/work/site',
      project: 'site',
      branch: 'main',
    },
    {
      id: 'd2',
      session: 's4',
      ts: t(121),
      role: 'assistant',
      text: 'The site is built by the workflow and published as an image.',
      cwd: '/work/site',
      project: 'site',
      branch: 'main',
    },
  ]);
  write(logs, 'e.jsonl', [
    {
      id: 'e1',
      session: 's5',
      ts: t(180),
      text: 'A secret pasted by mistake: hunter2',
      cwd: '/work/site',
      project: 'site',
    },
    {
      id: 'e2',
      session: 's5',
      ts: t(181),
      role: 'assistant',
      text: 'Noted; that line should be purged.',
      cwd: '/work/site',
      project: 'site',
    },
  ]);
  const adapter = fakeAdapter(logs);
  await syncSource({ db, home }, adapter);
  // Where the sessions were, as a device's places lines say (see places.ts).
  const places = [
    { v: 1, type: 'root', path: '/work/demo', project: 'demo', root: '/work/demo', signal: 'git' },
    { v: 1, type: 'place', session: 's1', project: 'demo', root: '/work/demo', signal: 'git' },
    { v: 1, type: 'place', session: 's5', project: 'site', root: null, signal: 'agent' },
  ].map((o) => JSON.stringify(o));
  transaction(
    db,
    () => {
      for (const l of places) applyPlaceFacts(db, 'fake', parsePlaceLine(l), t(5));
      rememberPlaceHead(db, 'fake', '', places.at(-1) ?? '');
    },
    { immediate: true },
  );
  rebuildThreads(db);

  const kept = remember(
    db,
    {
      kind: 'knowledge',
      text: 'A store moves between SQLite and PostgreSQL with origin db move.',
      confidence: 0.9,
      author: 'claude-code@laptop',
      sources: [{ eventId: 'fake:a2' }],
      project: 'demo',
    },
    t(10),
  );
  correct(
    db,
    kept.id,
    {
      text: 'A store moves between SQLite and PostgreSQL with origin db move, the hub stopped.',
      author: 'user@laptop',
    },
    t(11),
  );
  const dropped = remember(
    db,
    {
      kind: 'cognition',
      text: 'Prefer tabs.',
      confidence: 0.5,
      author: 'codex@laptop',
      sources: [{ eventId: 'fake:b2' }],
    },
    t(12),
  );
  forget(db, dropped.id, { reason: 'not true', author: 'user@laptop' }, t(13));
  const hidden = forget(db, 'fake:d2', { reason: 'off topic', author: 'user@laptop' }, t(14));
  restore(
    db,
    hidden.tombstoneId ?? '',
    { reason: 'on topic after all', author: 'user@laptop' },
    t(15),
  );

  for (const prompt of [undefined, 'copy the store into postgres']) {
    const plan = planRecall(db, {
      occasion: prompt ? 'prompt' : 'start',
      source: 'fake',
      sessionId: 's2',
      cwd: at.cwd,
      root: '/work/demo',
      project: 'demo',
      prompt,
      now: t(70),
      onDisk: false,
    });
    recordRecall(db, plan);
  }

  recordAudit(
    db,
    { actor: 'cli', channel: 'cli', action: 'token.create', target: 'laptop' },
    t(200),
  );
  createToken(db, 'laptop', t(200));

  const by = { reason: 'pasted a secret', author: 'user@laptop', channel: 'cli' as const };
  purge(db, home, [adapter], { kind: 'event', ids: ['fake:e1'] }, by);
  purge(db, home, [adapter], { kind: 'session', source: 'fake', sessionId: 's4' }, by);
}
