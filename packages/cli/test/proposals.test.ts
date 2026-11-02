import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  dbPath,
  entrySources,
  getProposal,
  initStoreName,
  listEntries,
  openDatabase,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const fixtures = fileURLToPath(new URL('../../adapters/test/fixtures/', import.meta.url));
const RUN = 'c0ffee00-0000-4000-8000-000000000001';
const PROPOSAL = 'prp_0000000000c1';
/** The user's message in the fixture session, which the proposal cites. */
const CITED = 'claude-code:22222222-2222-4222-8222-222222222222';

let tmp: string;
let home: string;
let projects: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];
const ENV = ['ORIGIN_HOME', 'ORIGIN_CLAUDE_PROJECTS', 'ORIGIN_DEVICE', 'ORIGIN_HUB_URL'] as const;

/** What `propose` returned, as Claude Code's transcript records an MCP tool's result. */
function proposeResult(): string {
  return JSON.stringify(
    {
      proposal: PROPOSAL,
      kind: 'knowledge',
      text: 'The demo project is checked with git status before each change.',
      confidence: 0.6,
      project: 'project',
      valid_from: null,
      valid_to: null,
      note: 'Inferred from one session.',
      sources: [{ event_id: CITED, quote: '检查一下仓库的状态' }],
    },
    null,
    2,
  );
}

/** A Claude Code line of the run's session. */
const runLine = (uuid: string, at: string, message: unknown, type = 'user') =>
  `${JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type,
    message,
    uuid,
    timestamp: at,
    cwd: 'D:\\demo\\project',
    sessionId: RUN,
    version: '2.1.303',
    gitBranch: 'master',
  })}\n`;

const toolResult = (id: string, content: unknown) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-proposals-'));
  home = path.join(tmp, 'home');
  projects = path.join(tmp, 'projects');
  fs.cpSync(path.join(fixtures, 'claude-code'), projects, { recursive: true });
  const result = proposeResult();
  fs.writeFileSync(
    path.join(projects, 'D--demo-project', `${RUN}.jsonl`),
    runLine('c0ffee00-0000-4000-8000-0000000000a1', '2026-10-19T05:00:00Z', {
      role: 'user',
      content: 'Consolidate the day.',
    }) +
      // The result of `propose`, as an MCP tool's result: a list of text blocks.
      runLine(
        'c0ffee00-0000-4000-8000-0000000000a2',
        '2026-10-19T05:00:05Z',
        toolResult('toolu_p1', [{ type: 'text', text: result }]),
      ) +
      // A later result that quotes it, escaped: a `get` of that event.
      runLine(
        'c0ffee00-0000-4000-8000-0000000000a3',
        '2026-10-19T05:00:09Z',
        toolResult('toolu_p2', [{ type: 'text', text: JSON.stringify({ id: 'x', text: result }) }]),
      ) +
      // A later shell output that prints it again, verbatim: a copy, not the proposal's own.
      runLine(
        'c0ffee00-0000-4000-8000-0000000000a4',
        '2026-10-19T05:00:12Z',
        toolResult('toolu_p3', `$ cat result.json\n${result}`),
      ),
  );
  const db = openDatabase(dbPath(home));
  initStoreName(db, 'laptop');
  await syncSource({ db, home }, createClaudeCodeAdapter({ projectsDir: projects }));
  db.close();
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ORIGIN_HOME = home;
  process.env.ORIGIN_CLAUDE_PROJECTS = projects;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const store = <T>(fn: (db: ReturnType<typeof openDatabase>) => T): T => {
  const db = openDatabase(dbPath(home));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

describe('a proposal in a Claude Code transcript', () => {
  it('is derived from the result of propose, not from the copies that quote it', () => {
    expect(store((db) => getProposal(db, PROPOSAL))).toMatchObject({
      source: 'claude-code',
      sessionId: RUN,
      eventId: 'claude-code:c0ffee00-0000-4000-8000-0000000000a2#0',
      sources: [{ eventId: CITED, quote: '检查一下仓库的状态' }],
      status: 'pending',
    });
  });
});

describe('origin proposals, show, accept, and reject', () => {
  it('list what waits for review, and show a proposal with its sources', async () => {
    expect(await main(['proposals'])).toBe(0);
    const listed = out.join('\n');
    expect(listed).toContain(PROPOSAL);
    expect(listed).toContain('pending');
    expect(listed).toContain('1 proposal pending');
    out.length = 0;
    expect(await main(['proposals', '--project', 'elsewhere'])).toBe(0);
    expect(out.join('\n')).toBe('No proposals wait for review.');
    expect(await main(['proposals', '--status', 'maybe'])).toBe(2);

    out.length = 0;
    expect(await main(['show', PROPOSAL])).toBe(0);
    const shown = out.join('\n');
    expect(shown).toContain(`Proposal    ${PROPOSAL}  knowledge, pending`);
    expect(shown).toContain('The demo project is checked with git status before each change.');
    expect(shown).toContain('“检查一下仓库的状态”');
    expect(shown).toContain(`↳ ${CITED}`);
    expect(shown).toContain(`origin accept ${PROPOSAL}`);
  });

  it('accept a proposal only with --yes, as an entry of the user citing it', async () => {
    expect(await main(['accept', PROPOSAL])).toBe(1);
    expect(out.join('\n')).toContain('Re-run with --yes to accept.');
    expect(store((db) => listEntries(db))).toEqual([]);

    out.length = 0;
    expect(await main(['accept', PROPOSAL, '--yes'])).toBe(0);
    const [entry] = store((db) => listEntries(db));
    expect(entry).toMatchObject({
      kind: 'knowledge',
      author: 'user@laptop',
      project: 'project',
      text: 'The demo project is checked with git status before each change.',
    });
    expect(out.join('\n')).toContain(`Accepted ${PROPOSAL} as ${entry?.id}.`);
    expect(store((db) => entrySources(db, entry?.id as string).map((s) => s.eventId))).toEqual([
      CITED,
      'claude-code:c0ffee00-0000-4000-8000-0000000000a2#0',
    ]);
    out.length = 0;
    expect(await main(['accept', PROPOSAL, '--yes'])).toBe(0);
    expect(out.join('\n')).toContain('was already accepted');
    out.length = 0;
    expect(await main(['proposals', '--status', 'accepted'])).toBe(0);
    expect(out.join('\n')).toContain(`accepted (${entry?.id})`);
    expect(await main(['reject', PROPOSAL, '--reason', 'no', '--yes'])).toBe(1);
    expect(err.join('\n')).toContain('correct or forget that entry instead');
  });

  it('reject a proposal only with a reason and --yes, as a forget that a restore lifts', async () => {
    expect(await main(['reject', PROPOSAL, '--yes'])).toBe(2);
    expect(err.join('\n')).toContain('A reason is required');
    expect(await main(['reject', PROPOSAL, '--reason', 'Not a rule we keep.'])).toBe(1);
    expect(out.join('\n')).toContain('Re-run with --yes to confirm.');
    expect(store((db) => getProposal(db, PROPOSAL))?.status).toBe('pending');

    out.length = 0;
    expect(await main(['reject', PROPOSAL, '--reason', 'Not a rule we keep.', '--yes'])).toBe(0);
    const tombstone = /tombstone (tmb_[0-9a-f]+)/.exec(out.join('\n'))?.[1] as string;
    expect(tombstone).toMatch(/^tmb_/);
    expect(store((db) => getProposal(db, PROPOSAL))).toBeNull();

    out.length = 0;
    expect(await main(['proposals'])).toBe(0);
    expect(out.join('\n')).toBe('No proposals wait for review.');
    out.length = 0;
    expect(await main(['proposals', '--status', 'rejected'])).toBe(0);
    const rejected = out.join('\n');
    expect(rejected).toContain(PROPOSAL);
    expect(rejected).toContain('Not a rule we keep.');
    // Never the text it proposed, which is hidden now.
    expect(rejected).not.toContain('git status before each change');
    out.length = 0;
    expect(await main(['show', PROPOSAL])).toBe(1);
    expect(out.join('\n')).toContain(`was rejected on`);
    expect(out.join('\n')).toContain(`origin restore ${tombstone}`);

    expect(await main(['restore', tombstone, '--reason', 'Reconsidered.', '--yes'])).toBe(0);
    expect(store((db) => getProposal(db, PROPOSAL))?.status).toBe('pending');
  });

  it('say what they cannot do with an id they do not know', async () => {
    expect(await main(['accept', 'prp_000000000000', '--yes'])).toBe(1);
    expect(err.join('\n')).toContain('Unknown proposal prp_000000000000.');
    expect(await main(['show', 'prp_000000000000'])).toBe(1);
    expect(out.join('\n')).toContain('Unknown proposal prp_000000000000.');
  });
});
