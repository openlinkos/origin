import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentEnv,
  agentStates,
  applyChange,
  cmdAgents,
  planConnect,
  planDisconnect,
} from '../src/agents.js';

let home: string;
let calls: string[][];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agents-'));
  calls = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const at = (...parts: string[]) => path.join(home, ...parts);
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A machine with its agents, whose `claude` CLI writes ~/.claude.json as the real one does. */
function env(platform: NodeJS.Platform = 'linux'): AgentEnv {
  return {
    home,
    platform,
    has: (command) => command === 'claude',
    run: (command, args) => {
      calls.push([command, ...args]);
      const config = fs.existsSync(at('.claude.json')) ? json(at('.claude.json')) : {};
      config.mcpServers ??= {};
      if (args[1] === 'add') {
        const [cmd, ...rest] = args.slice(args.indexOf('--') + 1);
        config.mcpServers.origin = { type: 'stdio', command: cmd, args: rest, env: {} };
      } else delete config.mcpServers.origin;
      fs.writeFileSync(at('.claude.json'), JSON.stringify(config));
      return { status: 0, output: '' };
    },
    now: () => new Date(Date.UTC(2026, 9, 28, 12, 30)),
  };
}

/** Agents installed, each with settings of its own that Origin must leave as they are. */
function install(): void {
  put(
    at('.claude.json'),
    JSON.stringify({ mcpServers: { other: { command: 'x' } }, numStartups: 3 }),
  );
  put(
    at('.claude', 'settings.json'),
    `${JSON.stringify(
      {
        model: 'opus',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      },
      null,
      2,
    )}\n`,
  );
  put(at('.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  put(at('.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  put(at('.zcode', 'cli', 'config.json'), JSON.stringify({ plugins: [], mcp: { servers: {} } }));
  fs.mkdirSync(at('.grok'));
}

describe('origin agents', () => {
  it("connect each installed agent, once, touching only what is Origin's", () => {
    install();
    const e = env();
    expect(agentStates(e).map((s) => [s.agent, s.mcp, s.recall])).toEqual([
      ['claude-code', 'missing', 'no-hooks'],
      ['codex', 'missing', 'no-hooks'],
      ['cursor', 'missing', 'brief'],
      ['zcode', 'missing', 'brief'],
      ['grok', 'missing', 'brief'],
    ]);
    const changes = planConnect(e, ['claude-code', 'codex', 'cursor', 'zcode', 'grok']);
    // Grok merges Claude Code's servers: registering Claude Code covers it.
    expect(changes.map((c) => c.agent)).toEqual([
      'claude-code',
      'claude-code',
      'codex',
      'codex',
      'cursor',
      'zcode',
      'grok',
    ]);
    for (const c of changes.filter((c) => c.agent !== 'grok')) applyChange(e, c);

    expect(calls).toEqual([
      ['claude', 'mcp', 'add', '--scope', 'user', 'origin', '--', 'origin', 'mcp'],
    ]);
    const settings = json(at('.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }]);
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'origin recall --hook claude-code', timeout: 10 }] },
    ]);
    expect(json(at('.codex', 'hooks.json')).hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'origin recall --hook codex',
    );
    const toml = fs.readFileSync(at('.codex', 'config.toml'), 'utf8');
    expect(toml).toBe(
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.origin]\ncommand = "origin"\nargs = ["mcp"]\n',
    );
    expect(json(at('.cursor', 'mcp.json')).mcpServers).toEqual({
      other: { command: 'x' },
      origin: { command: 'origin', args: ['mcp'] },
    });
    expect(json(at('.zcode', 'cli', 'config.json'))).toEqual({
      plugins: [],
      mcp: { servers: { origin: { command: 'origin', args: ['mcp'] } } },
    });
    // Each file it wrote was backed up first.
    expect(fs.existsSync(at('.claude', 'settings.json.origin-backup-20261028-123000'))).toBe(true);

    expect(agentStates(e).map((s) => [s.agent, s.mcp, s.recall])).toEqual([
      ['claude-code', 'registered', 'hooks'],
      ['codex', 'registered', 'hooks'],
      ['cursor', 'registered', 'brief'],
      ['zcode', 'registered', 'brief'],
      ['grok', 'via-claude-code', 'brief'],
    ]);
    expect(planConnect(e, ['claude-code', 'codex', 'cursor', 'zcode', 'grok'])).toEqual([]);
  });

  it('disconnect them, leaving everything else as it was', () => {
    install();
    const e = env('win32');
    const all = ['claude-code', 'codex', 'cursor', 'zcode', 'grok'];
    for (const c of planConnect(e, all)) applyChange(e, c);
    // On Windows, agents start npm's origin.cmd through cmd.
    expect(json(at('.cursor', 'mcp.json')).mcpServers.origin).toEqual({
      command: 'cmd',
      args: ['/c', 'origin', 'mcp'],
    });
    for (const c of planDisconnect(e, all)) applyChange(e, c);

    expect(calls.at(-1)).toEqual(['claude', 'mcp', 'remove', '--scope', 'user', 'origin']);
    expect(json(at('.claude', 'settings.json'))).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    });
    expect(json(at('.codex', 'hooks.json'))).toEqual({});
    expect(fs.readFileSync(at('.codex', 'config.toml'), 'utf8')).toBe(
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    expect(json(at('.cursor', 'mcp.json')).mcpServers).toEqual({ other: { command: 'x' } });
    expect(agentStates(e).every((s) => s.mcp === 'missing' && s.recall !== 'hooks')).toBe(true);
  });

  it('leave agents that are not installed alone, and change nothing without --yes', () => {
    fs.mkdirSync(at('.cursor'));
    const e = env();
    expect(planConnect(e, ['claude-code', 'cursor']).map((c) => c.agent)).toEqual(['cursor']);
    expect(cmdAgents(['connect'], e)).toBe(0);
    expect(fs.existsSync(at('.cursor', 'mcp.json'))).toBe(false);
    expect(cmdAgents(['connect', 'cursor', '--yes'], e)).toBe(0);
    expect(json(at('.cursor', 'mcp.json')).mcpServers.origin).toBeDefined();
    expect(cmdAgents(['connect', 'nobody'], e)).toBe(2);
  });
});
