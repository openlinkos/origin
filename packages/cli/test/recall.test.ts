import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Database,
  dbPath,
  initStoreName,
  listRecalls,
  openDatabase,
  openMemoryDatabase,
  planRecall,
  recallScope,
  recordRecall,
  workTree,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookCaller, runByAnother } from '../src/hook-caller.js';
import { hookCall, hookInput, hookOutput, main as recall } from '../src/recall.js';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-recall-'));
  db = openMemoryDatabase();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recall hooks', () => {
  it('scope a recall to the work tree that holds the working directory', () => {
    const repo = path.join(dir, 'acme');
    const sub = path.join(repo, 'packages', 'core');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    expect(workTree(sub)).toBe(repo);
    expect(recallScope(sub)).toEqual({ cwd: sub, root: repo, project: 'acme' });
    // Outside a work tree (unless the temporary directory is in one), the directory itself.
    const plain = path.join(dir, 'notes');
    fs.mkdirSync(plain);
    const root = workTree(plain);
    expect(recallScope(plain)).toEqual({
      cwd: plain,
      root,
      project: path.basename(root ?? plain),
    });
  });

  it('ask for a brief when a session starts and for matches with each prompt', () => {
    const scope = recallScope(dir);
    const start = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'ABC',
      cwd: dir,
    };
    expect(hookInput(db, 'claude-code', start)).toEqual({
      occasion: 'start',
      source: 'claude-code',
      sessionId: 'abc',
      ...scope,
    });
    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'abc', cwd: dir };
    expect(hookInput(db, 'claude-code', { ...prompt, prompt: 'Ship it' })).toMatchObject({
      occasion: 'prompt',
      prompt: 'Ship it',
      sessionId: 'abc',
    });
    expect(hookInput(db, 'claude-code', { ...prompt, prompt: '  ' })).toBeNull();
    // A notice an agent hands in as a prompt is not the user's.
    const notice = '<task-notification>\n<status>completed</status>\n</task-notification>';
    expect(hookInput(db, 'claude-code', { ...prompt, prompt: notice })).toBeNull();
    expect(hookInput(db, 'claude-code', { ...prompt, hook_event_name: 'Stop' })).toBeNull();
    expect(hookInput(db, 'claude-code', { ...start, cwd: undefined })).toBeNull();
  });

  it('give a resumed session no second brief, but a cleared or compacted one a new one', () => {
    const resume = {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: 'abc',
      cwd: dir,
    };
    expect(hookInput(db, 'claude-code', resume)).toMatchObject({ occasion: 'start' });
    recordRecall(
      db,
      planRecall(db, { occasion: 'start', source: 'claude-code', sessionId: 'abc' }),
    );
    expect(hookInput(db, 'claude-code', resume)).toBeNull();
    expect(hookInput(db, 'claude-code', { ...resume, source: 'compact' })).toMatchObject({
      occasion: 'start',
    });
  });

  it('read the events of Codex as those of Claude Code: the same fields', () => {
    const event = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'T-1',
      cwd: dir,
      prompt: 'Ship it',
    };
    expect(hookInput(db, 'codex', event)).toMatchObject({
      occasion: 'prompt',
      source: 'codex',
      sessionId: 't-1',
    });
  });

  it('answer in the form each agent reads', () => {
    const claude = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Origin recall rcl_1: …',
      },
    };
    for (const agent of ['claude-code', 'codex', 'zcode'] as const) {
      expect(JSON.parse(hookOutput(agent, 'UserPromptSubmit', 'Origin recall rcl_1: …'))).toEqual(
        claude,
      );
    }
    // ZCode checks that the answer names the event it asked about.
    expect(JSON.parse(hookOutput('zcode', 'SessionStart', 'x')).hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'x',
    });
    expect(
      JSON.parse(hookOutput('cursor', 'beforeSubmitPrompt', 'Origin recall rcl_1: …')),
    ).toEqual({ additional_context: 'Origin recall rcl_1: …' });
  });

  it("read ZCode's events: Claude Code's fields, or its own camelCase ones", () => {
    const scope = recallScope(dir);
    const start = {
      agentName: 'build',
      cwd: dir,
      hookEventName: 'SessionStart',
      mode: 'build',
      model: 'zai/glm-5',
      sessionId: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
      source: 'startup',
      agent_type: 'build',
      hook_event_name: 'SessionStart',
      permission_mode: 'build',
      session_id: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
      transcript_path: path.join(dir, 'zcode-hook-x', 'transcript.jsonl'),
    };
    expect(hookInput(db, 'zcode', start)).toEqual({
      occasion: 'start',
      source: 'zcode',
      sessionId: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
      ...scope,
    });
    const camel = {
      cwd: dir,
      hookEventName: 'UserPromptSubmit',
      sessionId: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
      prompt: 'Ship it',
      attachmentsSummary: [],
    };
    expect(hookInput(db, 'zcode', camel)).toMatchObject({
      occasion: 'prompt',
      prompt: 'Ship it',
      sessionId: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
    });
    // A sub-agent's session and a workflow step's are no conversation with the user.
    for (const child of [
      'sess_subagent_agent_0a1b2c3d-1111-4222-8333-444455556666',
      'sess_dwf-dwfrun-0a1b2c3d-1111-4222-8333-444455556666-actor_3_1',
    ]) {
      expect(hookCall('zcode', { ...start, sessionId: child, session_id: child })).toBeNull();
      expect(hookInput(db, 'zcode', { ...camel, sessionId: child })).toBeNull();
    }
    // The same ids from Claude Code are just ids.
    expect(
      hookInput(db, 'claude-code', {
        ...start,
        session_id: 'sess_dwf-x',
        hookEventName: undefined,
      }),
    ).toMatchObject({ occasion: 'start', sessionId: 'sess_dwf-x' });
  });

  it("read Cursor's events: the conversation's id, its first workspace root, its prompt", () => {
    const conversation = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const prompt = {
      conversation_id: conversation,
      generation_id: 'b1c2d3e4-0000-4000-8000-000000000001',
      model: 'default',
      hook_event_name: 'beforeSubmitPrompt',
      cursor_version: '3.27.22',
      workspace_roots: [dir, path.join(dir, 'other')],
      user_email: null,
      transcript_path: null,
      prompt: 'Ship it',
      attachments: [],
      composer_mode: 'agent',
    };
    const scope = recallScope(dir);
    // The first prompt of a conversation brings its brief, with the prompt's matches.
    expect(hookInput(db, 'cursor', prompt)).toEqual({
      occasion: 'start',
      source: 'cursor',
      sessionId: conversation,
      prompt: 'Ship it',
      ...scope,
    });
    recordRecall(
      db,
      planRecall(db, { occasion: 'start', source: 'cursor', sessionId: conversation }),
    );
    expect(hookInput(db, 'cursor', prompt)).toMatchObject({
      occasion: 'prompt',
      prompt: 'Ship it',
    });
    // On Windows, a workspace root is the path of its file URI.
    expect(hookCall('cursor', { ...prompt, workspace_roots: ['/c:/code/acme'] })?.cwd).toBe(
      'c:/code/acme',
    );
    expect(hookCall('cursor', { ...prompt, workspace_roots: ['/home/dana/acme'] })?.cwd).toBe(
      '/home/dana/acme',
    );
    // A session starts before Cursor can take what a hook hands over: nothing then.
    expect(
      hookInput(db, 'cursor', {
        ...prompt,
        hook_event_name: 'sessionStart',
        session_id: conversation,
      }),
    ).toBeNull();
    // A sub-agent's conversation, and a window without a folder, get nothing.
    expect(hookCall('cursor', { ...prompt, parent_agent_id: 'parent-1' })).toBeNull();
    expect(hookInput(db, 'cursor', { ...prompt, workspace_roots: [] })).toBeNull();
  });
});

describe('a hook another agent runs', () => {
  const grok = {
    hookEventName: 'session_start',
    hook_event_name: 'SessionStart',
    sessionId: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
    session_id: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
    cwd: '/home/dana/acme',
    workspaceRoot: '/home/dana/acme',
    permissionMode: 'default',
    timestamp: '2026-11-06T10:00:00Z',
  };
  const cursor = {
    conversation_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    hook_event_name: 'beforeSubmitPrompt',
    cursor_version: '3.27.22',
    workspace_roots: ['/home/dana/acme'],
    prompt: 'Ship it',
  };
  const zcode = {
    agentName: 'build',
    hookEventName: 'SessionStart',
    hook_event_name: 'SessionStart',
    sessionId: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
    session_id: 'sess_0a1b2c3d-1111-4222-8333-444455556666',
    cwd: '/home/dana/acme',
  };
  const claude = {
    session_id: '4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b',
    transcript_path: '/home/dana/.claude/projects/-home-dana-acme/4f1c9e2a.jsonl',
    cwd: '/home/dana/acme',
    hook_event_name: 'SessionStart',
    source: 'startup',
  };

  it('is told apart by what only that agent sends', () => {
    expect(hookCaller(grok, {})).toBe('grok');
    // Grok Build sets GROK_HOOK_EVENT on every hook it runs, whatever the event says.
    expect(hookCaller(claude, { GROK_HOOK_EVENT: 'session_start' })).toBe('grok');
    expect(hookCaller(cursor, {})).toBe('cursor');
    // Cursor sends its own events to Claude Code's hooks too.
    expect(hookCaller({ ...cursor, hook_event_name: 'sessionStart' }, {})).toBe('cursor');
    expect(hookCaller(zcode, {})).toBe('zcode');
    expect(hookCaller(claude, {})).toBeNull();
    expect(
      hookCaller({ ...claude, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, {}),
    ).toBeNull();
    expect(hookCaller('not an event', {})).toBeNull();
    expect(runByAnother('claude-code', grok, {})).toBe(true);
    expect(runByAnother('claude-code', cursor, {})).toBe(true);
    expect(runByAnother('cursor', cursor, {})).toBe(false);
    expect(runByAnother('zcode', zcode, {})).toBe(false);
    expect(runByAnother('cursor', cursor, { GROK_HOOK_EVENT: 'user_prompt_submit' })).toBe(true);
    expect(runByAnother('claude-code', claude, {})).toBe(false);
  });
});

describe('origin recall --hook', () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  let out: string[];
  const ENV = ['ORIGIN_HOME', 'ORIGIN_DEVICE', 'GROK_HOOK_EVENT'] as const;

  beforeEach(() => {
    home = path.join(dir, 'home');
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.ORIGIN_HOME = home;
    process.env.ORIGIN_DEVICE = 'laptop';
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const run = (agent: string, event: unknown, env: NodeJS.ProcessEnv = {}) =>
    recall(['recall', '--hook', agent], { stdin: () => JSON.stringify(event), env });

  /** A store with one preference, so that every recall hands something over. */
  function seed(): void {
    const store = openDatabase(dbPath(home));
    try {
      initStoreName(store, 'laptop');
      store
        .prepare(
          `INSERT INTO entry (id, kind, text, confidence, author, project, supersedes, root,
                              valid_from, valid_to, created_at, origin)
           VALUES (?, 'cognition', ?, 0.9, 'user@laptop', NULL, NULL, ?, NULL, NULL, ?, 'laptop')`,
        )
        .run(
          'ent_0f1e2d3c4b5a',
          'Ship small changes, one at a time.',
          'ent_0f1e2d3c4b5a',
          Date.now(),
        );
    } finally {
      store.close();
    }
  }

  const recallsOf = () => {
    const store = openDatabase(dbPath(home));
    try {
      return listRecalls(store, { includeEmpty: true });
    } finally {
      store.close();
    }
  };

  it('records nothing, and opens no store, when another agent runs the hook', async () => {
    const event = {
      hookEventName: 'session_start',
      hook_event_name: 'SessionStart',
      session_id: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
      cwd: dir,
      workspaceRoot: dir,
    };
    expect(await run('claude-code', event)).toBe(0);
    const cursorRun = {
      conversation_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      session_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      hook_event_name: 'sessionStart',
      cursor_version: '3.27.22',
      workspace_roots: [dir],
    };
    expect(await run('claude-code', cursorRun)).toBe(0);
    expect(
      await run('claude-code', {
        ...cursorRun,
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Ship it',
      }),
    ).toBe(0);
    const claudeEvent = {
      session_id: 'abc',
      cwd: dir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    };
    expect(await run('claude-code', claudeEvent, { GROK_HOOK_EVENT: 'session_start' })).toBe(0);
    // Nor for a ZCode workflow step.
    const step = 'sess_dwf-dwfrun-0a1b2c3d-1111-4222-8333-444455556666-actor_1_1';
    expect(
      await run('zcode', {
        agentName: 'zcode-workflow',
        hookEventName: 'SessionStart',
        hook_event_name: 'SessionStart',
        session_id: step,
        cwd: dir,
        source: 'startup',
      }),
    ).toBe(0);
    expect(out).toEqual([]);
    expect(fs.existsSync(dbPath(home))).toBe(false);
  });

  it("records ZCode's and Cursor's recalls under their own names and sessions", async () => {
    seed();
    const session = 'sess_0a1b2c3d-1111-4222-8333-444455556666';
    const zcode = {
      agentName: 'build',
      hookEventName: 'SessionStart',
      hook_event_name: 'SessionStart',
      sessionId: session,
      session_id: session,
      cwd: dir,
      source: 'startup',
    };
    expect(await run('zcode', zcode)).toBe(0);
    const answer = JSON.parse(out[0] as string);
    expect(answer.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(answer.hookSpecificOutput.additionalContext).toContain('Ship small changes');

    const conversation = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const cursor = {
      conversation_id: conversation,
      hook_event_name: 'beforeSubmitPrompt',
      cursor_version: '3.27.22',
      workspace_roots: [dir],
      prompt: 'Ship the release notes',
    };
    expect(await run('cursor', cursor)).toBe(0);
    expect(JSON.parse(out[1] as string).additional_context).toContain('Ship small changes');
    expect(
      recallsOf()
        .map((r) => [r.source, r.sessionId, r.occasion])
        .sort(),
    ).toEqual([
      ['cursor', conversation, 'start'],
      ['zcode', session, 'start'],
    ]);
  });

  it('previews a brief on a project by name, for an agent that works in no directory', async () => {
    seed();
    expect(await recall(['recall', '--project', 'main'], { stdin: () => '' })).toBe(0);
    expect(out[0]).toBe('Preview for any agent, project main; nothing is recorded.');
    const text = out.join('\n');
    expect(text).toContain('(project main)');
    expect(text).toContain('Ship small changes, one at a time.');
    // A preview records nothing.
    expect(recallsOf()).toEqual([]);
  });
});
