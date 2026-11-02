import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  getSession,
  isOwnerPrompt,
  listEvents,
  openDatabase,
  planRecall,
  rebuildAuthorship,
  sessionPrompts,
  sessionTurnStarts,
  syncSource,
  threadIdOf,
  threadLastPrompt,
} from '../src/index.js';
import { latestPrompts } from '../src/recall.js';
import { isOwnerConversation } from '../src/store.js';
import { fakeAdapter } from './helpers.js';

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-owner-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CWD = '/work/acme';
const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 20);
let n = 0;

/** One line of the fake source; ids are unique within a test. */
function say(
  session: string,
  text: string,
  o: Record<string, unknown> = {},
): Record<string, unknown> {
  n++;
  return {
    id: `e${n}`,
    session,
    ts: T + n * 1000,
    role: 'user',
    text,
    cwd: CWD,
    project: 'acme',
    ...o,
  };
}
const reply = (session: string, text: string, o: Record<string, unknown> = {}) =>
  say(session, text, { role: 'assistant', ...o });

async function ingest(file: string, ...lines: Array<Record<string, unknown>>): Promise<void> {
  fs.appendFileSync(path.join(logs, file), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  await syncSource({ db, home }, fakeAdapter(logs));
}

describe("the owner's prompts", () => {
  it('are the messages whose effective author is the owner and that read as prompts', () => {
    const input = (author: string | null, text = 'Fix the build.', kind = 'message') =>
      isOwnerPrompt({ role: 'user', kind, text, author: author as never });
    expect(input('owner')).toBe(true);
    expect(input('owner', '<command-name>/clear</command-name>')).toBe(false);
    expect(input('owner', '[Request interrupted by user]')).toBe(false);
    expect(input('owner', 'Fix the build.', 'meta')).toBe(false);
    for (const other of ['person', 'agent', 'system', null]) expect(input(other)).toBe(false);
  });

  it('name a session without a title, start its turns, and leave other input to notes', async () => {
    await ingest(
      'a.jsonl',
      // A teammate's message first, then the owner's prompt, a compaction summary, a command.
      say('s1', 'Can you look at the flaky test?', { author: 'person', speaker: 'Sam' }),
      say('s1', 'Retry the upload with backoff.', { author: 'owner', signal: 'typed' }),
      reply('s1', 'Done.'),
      say('s1', 'This session is being continued from a previous conversation.', {
        author: 'system',
        signal: 'isCompactSummary',
      }),
      say('s1', '<command-name>/review</command-name><command-args>PR 12</command-args>', {
        author: 'system',
      }),
      reply('s1', 'Reviewing.', { kind: 'tool_use' }),
      // A sub-agent's prompt in the same session.
      say('s1', 'List the packages.', { author: 'agent', signal: 'isSidechain' }),
      say('s1', '<command-name>/agents</command-name>', { author: 'agent' }),
      reply('s1', 'Listed.'),
    );
    expect(getSession(db, 'fake', 's1')?.prompt).toBe('Retry the upload with backoff.');
    expect(sessionPrompts(db, 'fake', 's1').map((p) => [p.prompt, p.author])).toEqual([
      ['Retry the upload with backoff.', 'owner'],
    ]);
    expect(sessionTurnStarts(db, 'fake', 's1').map((t) => [t.prompt, t.command, t.author])).toEqual(
      [
        ['Retry the upload with backoff.', false, 'owner'],
        ['/review PR 12', true, 'system'],
      ],
    );
    expect(isOwnerConversation(db, 'fake', 's1')).toBe(true);
  });

  it("make no name, turn, or conversation of the owner's in a child session or a headless run", async () => {
    await ingest(
      'b.jsonl',
      say('kid', 'Explore the repo.'),
      reply('kid', 'Explored.'),
      say('run', 'Summarize the day.'),
      reply('run', 'Summary.'),
      { kinds: [{ session: 'kid', kind: 'child', signal: 'task_type' }] },
      { kinds: [{ session: 'run', kind: 'headless', signal: 'entrypoint' }] },
    );
    for (const s of ['kid', 'run']) {
      expect(getSession(db, 'fake', s)?.prompt).toBeNull();
      expect(sessionTurnStarts(db, 'fake', s)).toEqual([]);
      expect(isOwnerConversation(db, 'fake', s)).toBe(false);
    }
    expect(listEvents(db, { sessionId: 'kid' })[0]).toMatchObject({
      author: 'agent',
      authorSignal: 'task_type',
    });
  });

  it("are recall's background words: the owner's latest prompts, and nothing else", async () => {
    await ingest(
      'c.jsonl',
      say('s1', 'Deploy the staging cluster.', { author: 'owner' }),
      say('s1', 'Staging is down again, staging staging.', { author: 'person' }),
      say('s1', 'Run the staging checks.', { author: 'agent' }),
      say('s1', '<task-notification>staging done</task-notification>', { author: 'system' }),
      say('s2', 'Ship the staging build.'),
      reply('s2', 'Shipped staging.'),
    );
    // The last message, without an author from its line, reads as the owner's by its text.
    expect(latestPrompts(db)).toEqual(['Ship the staging build.', 'Deploy the staging cluster.']);
  });
});

describe("the owner's conversations", () => {
  it('are the only sessions a brief lists', async () => {
    const now = T + DAY;
    await ingest(
      'd.jsonl',
      say('mine', 'Add retries to the upload client.', { author: 'owner' }),
      reply('mine', 'Added.'),
      say('kid', 'Look for the upload client.', { author: 'owner' }),
      reply('kid', 'Found it.'),
      { kinds: [{ session: 'kid', kind: 'child', signal: 'subagent_spawned' }] },
      say('run', 'Nightly check.'),
      reply('run', 'All green.'),
      { kinds: [{ session: 'run', kind: 'headless', signal: 'entrypoint' }] },
      say('chat', 'Who is on call?', { author: 'person', speaker: 'Sam' }),
      reply('chat', 'Dana is.'),
    );
    const plan = planRecall(db, {
      occasion: 'start',
      cwd: CWD,
      root: CWD,
      project: 'acme',
      now,
    });
    expect(plan.items.filter((i) => i.layer === 'sessions').map((i) => i.ref)).toEqual([
      'fake:mine',
    ]);
  });

  it('are the only sessions that join a thread by their branch, whenever a line says what a session is', async () => {
    const branch = { branch: 'retry-fix' };
    await ingest(
      'e.jsonl',
      say('one', 'Start the retry work.', { author: 'owner', ...branch }),
      reply('one', 'Started.', branch),
      say('two', 'Go on with the retries.', { author: 'owner', ...branch }),
      reply('two', 'Going on.', branch),
      say('bot', 'Review the retry branch.', branch),
      reply('bot', 'Reviewed.', branch),
    );
    const thread = threadIdOf('fake', 'one');
    expect(getSession(db, 'fake', 'bot')?.thread).toBe(thread);
    // A later line says the third was a headless run: it leaves the thread.
    await ingest('f.jsonl', {
      kinds: [{ session: 'bot', kind: 'headless', signal: 'entrypoint' }],
    });
    expect(getSession(db, 'fake', 'one')?.thread).toBe(thread);
    expect(getSession(db, 'fake', 'two')?.thread).toBe(thread);
    expect(getSession(db, 'fake', 'bot')?.thread).toBeNull();
    expect(threadLastPrompt(db, thread)?.prompt).toBe('Go on with the retries.');
    // Rebuilt from the mirrors, the same.
    rebuildAuthorship(db, { home, adapters: [fakeAdapter(logs)] });
    expect(['one', 'two', 'bot'].map((s) => getSession(db, 'fake', s)?.thread)).toEqual([
      thread,
      thread,
      null,
    ]);
  });
});
