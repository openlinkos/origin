import fs from 'node:fs';
import path from 'node:path';
import { createLinesAdapter } from '@openlinkos/origin-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerOrigin } from '../src/index.js';
import { agentCtx, assistant, fakeApi, firstTurn, SESSION, T, tmpDir, user } from './fake.js';

let root: string;
let sources: string;
let state: string;
beforeEach(() => {
  root = tmpDir('origin-openclaw-dir-');
  sources = path.join(root, 'origin', 'sources', 'openclaw');
  state = path.join(root, 'openclaw-state');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function start(pluginConfig: Record<string, unknown> = {}) {
  const fake = fakeApi({ pluginConfig: { dir: sources, ...pluginConfig }, stateDir: state });
  const rec = registerOrigin(fake.api, { now: () => T + 60_000 });
  if (!rec) throw new Error(JSON.stringify(fake.logs));
  return { ...fake, rec };
}

const filesUnder = (dir: string): string[] =>
  fs.existsSync(dir)
    ? (fs.readdirSync(dir, { recursive: true }) as string[])
        .map((f) => f.split(path.sep).join('/'))
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
    : [];

describe('delivery to a directory', () => {
  it('appends each turn to the session file, which Origin reads as the source', async () => {
    const { hooks, rec } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    const [file, ...others] = filesUnder(sources);
    expect(others).toEqual([]);
    expect(file).toMatch(
      /^xiaohan\/2026\/11\/agent-xiaohan-telegram-direct-42-[0-9a-f]{10}\.jsonl$/,
    );
    const abs = path.join(sources, ...file!.split('/'));
    expect(fs.readFileSync(abs, 'utf8').split('\n')).toHaveLength(6);

    const next = [
      ...firstTurn(),
      user('And now?', T + 20_000),
      assistant([{ type: 'text', text: 'Running.' }], T + 21_000),
    ];
    await hooks.get('agent_end')!({ messages: next, success: true }, agentCtx({ runId: 'run-2' }));
    await rec.idle();
    const text = fs.readFileSync(abs, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(7);

    // Origin's own adapter for the directory finds the file and reads every line.
    const adapter = createLinesAdapter({ id: 'openclaw', dir: sources });
    const listed = await adapter.discover();
    expect(listed.map((f) => f.relPath)).toEqual([file]);
    const plugin = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(adapter.version()).toBe(`OpenClaw 2026.10.6 (origin-openclaw ${plugin.version})`);
    const events = text
      .trimEnd()
      .split('\n')
      .flatMap(
        (line, i) =>
          adapter.parseLine(line, {
            absPath: abs,
            relPath: file!,
            lineNo: i + 1,
            fileMtimeMs: 0,
            readLine: () => null,
          })?.events ?? [],
      );
    expect(events).toHaveLength(7);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set([SESSION]));
  });

  it('starts on a line of its own after a line cut short', async () => {
    const { hooks, rec } = start();
    await hooks.get('agent_end')!({ messages: firstTurn().slice(0, 1), success: true }, agentCtx());
    await rec.idle();
    const [file] = filesUnder(sources);
    const abs = path.join(sources, ...file!.split('/'));
    fs.appendFileSync(abs, '{"id":"half');
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    const lines = fs.readFileSync(abs, 'utf8').trimEnd().split('\n');
    expect(lines[1]).toBe('{"id":"half');
    expect(lines.slice(2).map((l) => JSON.parse(l).role)).toEqual([
      'assistant',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('keeps sessions and agents apart, in their months', async () => {
    const { hooks, rec } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await hooks.get('agent_end')!(
      { messages: [user('Hi from main.', Date.parse('2026-12-01T00:00:01Z'))], success: true },
      agentCtx({ agentId: 'main', sessionKey: 'agent:main:main' }),
    );
    await rec.idle();
    const files = filesUnder(sources);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^main\/2026\/12\/agent-main-main-[0-9a-f]{10}\.jsonl$/);
    expect(files[1]).toMatch(/^xiaohan\/2026\/11\//);
    // Nothing is written outside the source's directory, and the state stays apart.
    expect(fs.readdirSync(path.join(root, 'origin', 'sources'))).toEqual(['openclaw']);
    expect(fs.existsSync(path.join(state, 'origin-openclaw', 'sent'))).toBe(true);
  });

  it('spools a turn it cannot write, and writes it with the next one', async () => {
    // A file where the agent's directory should be makes the first write fail.
    fs.mkdirSync(sources, { recursive: true });
    fs.writeFileSync(path.join(sources, 'xiaohan'), 'not a directory');
    const { hooks, rec, logs } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    const spool = path.join(state, 'origin-openclaw', 'spool');
    expect(fs.readdirSync(spool)).toHaveLength(1);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('cannot deliver'))).toBe(true);

    fs.rmSync(path.join(sources, 'xiaohan'));
    await hooks.get('agent_end')!(
      { messages: [...firstTurn(), user('Still there?', T + 30_000)], success: true },
      agentCtx(),
    );
    await rec.idle();
    expect(fs.readdirSync(spool)).toEqual([]);
    const [file] = filesUnder(sources);
    const lines = fs
      .readFileSync(path.join(sources, ...file!.split('/')), 'utf8')
      .trimEnd()
      .split('\n');
    expect(lines.map((l) => JSON.parse(l).text).at(-1)).toBe('Still there?');
    expect(lines).toHaveLength(6);
    expect(logs.some((l) => l.level === 'info' && l.message.includes('again'))).toBe(true);
  });
});
