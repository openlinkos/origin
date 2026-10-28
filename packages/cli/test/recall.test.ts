import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Database,
  openMemoryDatabase,
  planRecall,
  recallScope,
  recordRecall,
  workTree,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookInput, hookOutput } from '../src/recall.js';

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

  it('answer in the form Claude Code reads', () => {
    expect(JSON.parse(hookOutput('UserPromptSubmit', 'Origin recall rcl_1: …'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Origin recall rcl_1: …',
      },
    });
  });
});
