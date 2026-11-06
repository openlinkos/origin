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
      ['cursor', 'missing', 'no-hooks', 'watch'],
      ['zcode', 'missing', 'no-hooks', 'watch'],
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
      'cursor',
      'zcode',
      'zcode',
      'grok',
    ]);
    expect(changes.filter((c) => c.what.includes('hooks')).map((c) => c.what)).toEqual([
      `add the recall hooks (SessionStart, UserPromptSubmit) to ${at('.claude', 'settings.json')}`,
      `add the ingest hooks (Stop, SubagentStop, PostCompact) to ${at('.claude', 'settings.json')}`,
      `add the recall hooks (SessionStart, UserPromptSubmit) to ${at('.codex', 'hooks.json')}`,
      `add the ingest hooks (Stop, SubagentStop) to ${at('.codex', 'hooks.json')}`,
      `add the recall hooks (beforeSubmitPrompt) to ${at('.cursor', 'hooks.json')}`,
      `add the recall hooks (SessionStart, UserPromptSubmit) to ${at('.zcode', 'cli', 'config.json')}`,
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
    const zcodeRecall = {
      hooks: [{ type: 'command', command: 'origin recall --hook zcode', timeoutMs: 10000 }],
    };
    // ZCode runs hooks only when they are on, and Origin's are the only ones there.
    expect(json(at('.zcode', 'cli', 'config.json'))).toEqual({
      plugins: [],
      mcp: { servers: { origin: { command: 'origin', args: ['mcp'] } } },
      hooks: {
        enabled: true,
        events: { SessionStart: [zcodeRecall], UserPromptSubmit: [zcodeRecall] },
      },
    });
    expect(json(at('.cursor', 'hooks.json'))).toEqual({
      version: 1,
      hooks: { beforeSubmitPrompt: [{ command: 'origin recall --hook cursor', timeout: 10 }] },
    });
    // Each file it wrote was backed up first.
    expect(fs.existsSync(at('.claude', 'settings.json.origin-backup-20261028-123000'))).toBe(true);

    expect(agentStates(e).map((s) => [s.agent, s.mcp, s.recall, s.ingest])).toEqual([
      ['claude-code', 'registered', 'hooks', 'hooks'],
      // Codex has trusted none of its hooks yet.
      ['codex', 'registered', 'untrusted', 'untrusted'],
      ['cursor', 'registered', 'hooks', 'watch'],
      ['zcode', 'registered', 'hooks', 'watch'],
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
      expect(text).toContain('hooks set up, not trusted yet (/hooks in Codex)');
      expect(text).toMatch(/codex .*not trusted yet/);
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
    expect(json(at('.cursor', 'hooks.json'))).toEqual({ version: 1 });
    // ZCode's hooks go, and the switch Origin turned on with them.
    expect(json(at('.zcode', 'cli', 'config.json'))).toEqual({ plugins: [], mcp: { servers: {} } });
    expect(agentStates(e).every((s) => s.mcp === 'missing' && s.recall !== 'hooks')).toBe(true);
  });

  it("write ZCode's hooks in the shape its strict schema takes, and leave its other hooks off", () => {
    const file = at('.zcode', 'cli', 'config.json');
    const own = { hooks: [{ type: 'command', command: 'notify-send hi', timeoutMs: 5000 }] };
    const config = {
      plugins: { enabledPlugins: { 'demo@market': true } },
      mcp: { servers: {} },
      hooks: { timeoutMs: 30000, events: { Stop: [own] } },
    };
    put(file, JSON.stringify(config, null, 2));
    const e = env();
    const changes = planConnect(e, ['zcode']);
    expect(changes.map((c) => c.what)).toEqual([
      `register the MCP server in ${file}`,
      `add the recall hooks (SessionStart, UserPromptSubmit) to ${file}`,
    ]);
    // Turning the hooks on would run the user's own too: Origin leaves that to them, and says so.
    expect(changes[1]?.afterwards).toBe(
      `ZCode runs no hooks while hooks.enabled is not true in ${file}. Origin left it as it was, since turning it on runs the other hooks there too.`,
    );
    for (const c of changes) applyChange(e, c);
    const written = json(file);
    expect(written.plugins).toEqual(config.plugins);
    expect(written.hooks.enabled).toBeUndefined();
    expect(written.hooks.timeoutMs).toBe(30000);
    expect(written.hooks.events.Stop).toEqual([own]);
    // Only the events and fields ZCode's schema knows; a command hook has no `args` or `timeout`.
    const known = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest'];
    for (const [event, groups] of Object.entries(written.hooks.events)) {
      expect([...known, 'PostToolUse', 'PostToolUseFailure', 'Stop']).toContain(event);
      for (const group of groups as Array<{ hooks: Array<Record<string, unknown>> }>) {
        expect(Object.keys(group)).toEqual(['hooks']);
        for (const hook of group.hooks) {
          expect(Object.keys(hook).sort()).toEqual(['command', 'timeoutMs', 'type']);
          expect(Number.isInteger(hook.timeoutMs) && (hook.timeoutMs as number) > 0).toBe(true);
        }
      }
    }
    expect(written.hooks.events.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'origin recall --hook zcode', timeoutMs: 10000 }] },
    ]);
    expect(agentStates(e).find((s) => s.agent === 'zcode')).toMatchObject({
      recall: 'off',
      ingest: 'watch',
    });
    // Nothing more to do until the user turns them on; then they run.
    expect(planConnect(e, ['zcode'])).toEqual([]);
    put(file, JSON.stringify({ ...written, hooks: { ...written.hooks, enabled: true } }));
    expect(agentStates(e).find((s) => s.agent === 'zcode')?.recall).toBe('hooks');

    // Disconnecting takes Origin's hooks only: the user's and their switch stay.
    for (const c of planDisconnect(e, ['zcode'])) applyChange(e, c);
    expect(json(file)).toEqual({
      ...config,
      hooks: { timeoutMs: 30000, events: { Stop: [own] }, enabled: true },
    });
  });

  it("turn ZCode's hooks on when Origin's are all it has, and again if they were turned off", () => {
    const file = at('.zcode', 'cli', 'config.json');
    put(file, JSON.stringify({ mcp: { servers: {} }, hooks: { enabled: false } }));
    const e = env();
    for (const c of planConnect(e, ['zcode'])) applyChange(e, c);
    expect(json(file).hooks.enabled).toBe(true);
    const off = json(file);
    off.hooks.enabled = false;
    put(file, JSON.stringify(off));
    expect(agentStates(e).find((s) => s.agent === 'zcode')?.recall).toBe('off');
    expect(planConnect(e, ['zcode']).map((c) => c.what)).toEqual([
      `turn on the hooks in ${file} (hooks.enabled)`,
    ]);
    for (const c of planConnect(e, ['zcode'])) applyChange(e, c);
    expect(json(file).hooks.enabled).toBe(true);
    expect(json(file).hooks.events.SessionStart).toHaveLength(1);
  });

  it("add Cursor's hook next to its others, in Cursor's own shape", () => {
    const file = at('.cursor', 'hooks.json');
    const own = { command: './hooks/audit.sh', timeout: 30 };
    put(file, JSON.stringify({ version: 1, hooks: { stop: [own], beforeSubmitPrompt: [own] } }));
    const e = env();
    for (const c of planConnect(e, ['cursor'])) applyChange(e, c);
    expect(json(file)).toEqual({
      version: 1,
      hooks: {
        stop: [own],
        beforeSubmitPrompt: [own, { command: 'origin recall --hook cursor', timeout: 10 }],
      },
    });
    expect(planConnect(e, ['cursor'])).toEqual([]);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      expect(cmdAgents([], e)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(lines.join('\n')).toMatch(
      /cursor .*hooks: a brief with the first prompt, matches with each one after/,
    );
    for (const c of planDisconnect(e, ['cursor'])) applyChange(e, c);
    expect(json(file)).toEqual({ version: 1, hooks: { stop: [own], beforeSubmitPrompt: [own] } });
  });

  it("tell Codex's hooks apart once Codex has trusted any", () => {
    install();
    const e = env();
    for (const c of planConnect(e, ['codex'])) applyChange(e, c);
    expect(agentStates(e)[1]).toMatchObject({ recall: 'untrusted', ingest: 'untrusted' });
    // Codex records a hash for each hook the user trusts; Origin writes none.
    const toml = at('.codex', 'config.toml');
    fs.appendFileSync(
      toml,
      `\n[hooks.state."${at('.codex', 'hooks.json')}:session_start:0:0"]\ntrusted_hash = "sha256:0f"\n`,
    );
    expect(agentStates(e)[1]).toMatchObject({ recall: 'hooks', ingest: 'hooks' });
  });

  it('leave agents that are not installed alone, and change nothing without --yes', () => {
    fs.mkdirSync(at('.cursor'));
    const e = env();
    expect(planConnect(e, ['claude-code', 'cursor']).map((c) => c.agent)).toEqual([
      'cursor',
      'cursor',
    ]);
    expect(cmdAgents(['connect'], e)).toBe(0);
    expect(fs.existsSync(at('.cursor', 'mcp.json'))).toBe(false);
    expect(cmdAgents(['connect', 'cursor', '--yes'], e)).toBe(0);
    expect(json(at('.cursor', 'mcp.json')).mcpServers.origin).toBeDefined();
    expect(cmdAgents(['connect', 'nobody'], e)).toBe(2);
  });
});
