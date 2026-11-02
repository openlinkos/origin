import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(agentStates(e).map((s) => [s.agent, s.mcp, s.recall, s.ingest])).toEqual([
      ['claude-code', 'missing', 'no-hooks', 'no-hooks'],
      ['codex', 'missing', 'no-hooks', 'no-hooks'],
      ['cursor', 'missing', 'brief', 'watch'],
      ['zcode', 'missing', 'brief', 'watch'],
      ['grok', 'missing', 'brief', 'watch'],
    ]);
    const changes = planConnect(e, ['claude-code', 'codex', 'cursor', 'zcode', 'grok']);
    // Grok merges Claude Code's servers: registering Claude Code covers it.
    expect(changes.map((c) => c.agent)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'codex',
      'codex',
      'codex',
      'cursor',
      'zcode',
      'grok',
    ]);
    expect(changes.filter((c) => c.what.includes('hooks')).map((c) => c.what)).toEqual([
      `add the recall hooks (SessionStart, UserPromptSubmit) to ${at('.claude', 'settings.json')}`,
      `add the ingest hooks (Stop, SubagentStop, PostCompact) to ${at('.claude', 'settings.json')}`,
      `add the recall hooks (SessionStart, UserPromptSubmit) to ${at('.codex', 'hooks.json')}`,
      `add the ingest hooks (Stop, SubagentStop) to ${at('.codex', 'hooks.json')}`,
    ]);
    for (const c of changes.filter((c) => c.agent !== 'grok')) applyChange(e, c);

    expect(calls).toEqual([
      ['claude', 'mcp', 'add', '--scope', 'user', 'origin', '--', 'origin', 'mcp'],
    ]);
    const settings = json(at('.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    const ingest = (agent: string) => ({
      hooks: [
        { type: 'command', command: `origin sync --hook ${agent}`, timeout: 60, async: true },
      ],
    });
    // Ours go next to the user's own hooks, which stay as they were.
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      ingest('claude-code'),
    ]);
    expect(settings.hooks.SubagentStop).toEqual([ingest('claude-code')]);
    expect(settings.hooks.PostCompact).toEqual([ingest('claude-code')]);
    expect(settings.hooks.SessionEnd).toBeUndefined();
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'origin recall --hook claude-code', timeout: 10 }] },
    ]);
    const codexHooks = json(at('.codex', 'hooks.json')).hooks;
    expect(codexHooks.UserPromptSubmit[0].hooks[0].command).toBe('origin recall --hook codex');
    expect(Object.keys(codexHooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
    ]);
    expect(codexHooks.Stop).toEqual([ingest('codex')]);
    expect(codexHooks.SubagentStop).toEqual([ingest('codex')]);
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

    expect(agentStates(e).map((s) => [s.agent, s.mcp, s.recall, s.ingest])).toEqual([
      ['claude-code', 'registered', 'hooks', 'hooks'],
      ['codex', 'registered', 'hooks', 'hooks'],
      ['cursor', 'registered', 'brief', 'watch'],
      ['zcode', 'registered', 'brief', 'watch'],
      ['grok', 'via-claude-code', 'brief', 'watch'],
    ]);
    expect(planConnect(e, ['claude-code', 'codex', 'cursor', 'zcode', 'grok'])).toEqual([]);
  });

  it('adds the ingest hooks to an agent connected before, and only what it lacks', () => {
    install();
    const e = env();
    const recallOnly = {
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'origin recall --hook claude-code', timeout: 10 }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'origin recall --hook claude-code', timeout: 10 }],
          },
        ],
      },
    };
    put(at('.claude', 'settings.json'), JSON.stringify(recallOnly, null, 2));
    expect(agentStates(e)[0]).toMatchObject({ recall: 'hooks', ingest: 'no-hooks' });
    const changes = planConnect(e, ['claude-code']);
    expect(changes.map((c) => c.what)).toEqual([
      'register the MCP server: claude mcp add --scope user origin -- origin mcp',
      `add the ingest hooks (Stop, SubagentStop, PostCompact) to ${at('.claude', 'settings.json')}`,
    ]);
    for (const c of changes) applyChange(e, c);
    expect(agentStates(e)[0]).toMatchObject({ recall: 'hooks', ingest: 'hooks' });

    // One of ours removed by hand, and one respaced: only the missing one comes back.
    const settings = json(at('.claude', 'settings.json'));
    delete settings.hooks.PostCompact;
    settings.hooks.SubagentStop[0].hooks[0].command = 'origin  sync --hook   claude-code';
    put(at('.claude', 'settings.json'), JSON.stringify(settings, null, 2));
    expect(agentStates(e)[0]).toMatchObject({ ingest: 'no-hooks' });
    for (const c of planConnect(e, ['claude-code'])) applyChange(e, c);
    const again = json(at('.claude', 'settings.json'));
    expect(again.hooks.SubagentStop).toHaveLength(1);
    expect(again.hooks.PostCompact).toHaveLength(1);

    // Disconnecting takes every hook of ours, the respaced one too, and leaves the user's.
    for (const c of planDisconnect(e, ['claude-code'])) applyChange(e, c);
    expect(json(at('.claude', 'settings.json'))).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    });
  });

  it('shows how each agent is connected, the hooks that ingest new lines included', () => {
    install();
    const e = env();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      expect(cmdAgents(['connect', 'codex'], e)).toBe(0);
      expect(lines.join('\n')).toContain(
        `codex: add the ingest hooks (Stop, SubagentStop) to ${at('.codex', 'hooks.json')}`,
      );
      expect(cmdAgents(['connect', 'codex', '--yes'], e)).toBe(0);
      expect(lines.join('\n')).toContain(
        'Codex runs new hooks only once you trust them: open /hooks in Codex.',
      );
      lines.length = 0;
      expect(cmdAgents([], e)).toBe(0);
      const text = lines.join('\n');
      expect(text).toContain('New lines');
      expect(text).toMatch(/codex .*hooks: as each turn ends/);
      expect(text).toMatch(/claude-code .*not set up \(origin agents connect\)/);
      expect(text).toMatch(/cursor .*every minute while origin mcp runs/);
    } finally {
      log.mockRestore();
    }
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
