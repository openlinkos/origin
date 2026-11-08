import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin, { agentNames, hasConversationAccess, registerOrigin } from '../src/index.js';
import { agentCtx, fakeApi, MemorySink, T, tmpDir, user } from './fake.js';

let state: string;
beforeEach(() => {
  state = tmpDir('origin-openclaw-reg-');
});
afterEach(() => {
  fs.rmSync(state, { recursive: true, force: true });
});

const dirConfig = () => ({ dir: path.join(state, 'sources', 'openclaw') });

describe('register', () => {
  it('is the default export OpenClaw loads, under the manifest id', () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
    );
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.id).toBe('origin');
    expect(typeof plugin.register).toBe('function');
    expect(plugin.name).toBeTruthy();
    expect(plugin.description).toBeTruthy();
  });

  it('registers agent_end with conversation access, and the message hooks always', () => {
    const { api, hooks, logs } = fakeApi({ pluginConfig: dirConfig(), stateDir: state });
    plugin.register(api);
    expect([...hooks.keys()].sort()).toEqual([
      'after_tool_call',
      'agent_end',
      'before_compaction',
      'gateway_start',
      'gateway_stop',
      'message_received',
      'message_sent',
      'session_end',
    ]);
    expect(logs.filter((l) => l.level === 'info')).toHaveLength(1);
    expect(logs[0]!.message).toMatch(
      /^origin: recording every agent \(user runs\) into .*openclaw, from agent_end$/,
    );
  });

  it('assembles turns from the message hooks without conversation access', () => {
    const { api, hooks, logs } = fakeApi({
      pluginConfig: { ...dirConfig(), includeTools: false },
      stateDir: state,
      conversationAccess: false,
    });
    const rec = registerOrigin(api);
    expect(rec?.turns).toBe('messages');
    expect([...hooks.keys()].sort()).toEqual([
      'gateway_start',
      'gateway_stop',
      'message_received',
      'message_sent',
      'session_end',
    ]);
    expect(logs[0]!.message).toContain('allowConversationAccess');
  });

  it('reads conversation access as OpenClaw does', () => {
    const cfg = (hooks: unknown, id = 'origin') => ({ plugins: { entries: { [id]: { hooks } } } });
    expect(hasConversationAccess(cfg({ allowConversationAccess: true }), 'origin')).toBe(true);
    expect(hasConversationAccess(cfg({ allowConversationAccess: 'true' }), 'origin')).toBe(false);
    expect(hasConversationAccess(cfg({}), 'origin')).toBe(false);
    expect(hasConversationAccess(cfg({ allowConversationAccess: true }, 'Origin'), 'origin')).toBe(
      true,
    );
    expect(hasConversationAccess(cfg({ allowConversationAccess: true }, 'other'), 'origin')).toBe(
      false,
    );
    expect(hasConversationAccess(undefined, 'origin')).toBe(false);
  });

  it("reads the agents' names from the Gateway's config, as OpenClaw lists them", () => {
    expect(
      agentNames({
        agents: {
          list: [
            { id: 'Main', name: 'Ops Lead', identity: { name: 'Not this one' } },
            { id: 'xiaowen', identity: { name: 'Xiaowen' } },
            { id: 'bare' },
            { id: 'main', name: 'A second main' },
            { name: 'No id' },
            null,
          ],
        },
      }),
    ).toEqual(
      new Map([
        ['main', 'Ops Lead'],
        ['xiaowen', 'Xiaowen'],
      ]),
    );
    // `agents.entries`, keyed by id, is read in place of `agents.list`.
    expect(
      agentNames({
        agents: { entries: { scout: { name: 'Scout' } }, list: [{ id: 'other', name: 'Other' }] },
      }),
    ).toEqual(new Map([['scout', 'Scout']]));
    expect(agentNames({ agents: { entries: null, list: [{ id: 'a', name: 'A' }] } })).toEqual(
      new Map(),
    );
    expect(agentNames(undefined)).toEqual(new Map());
    expect(agentNames({ agents: { list: 'main' } })).toEqual(new Map());
  });

  it('names the agent behind a routed input after its name in the config', async () => {
    const sink = new MemorySink();
    const { api, hooks } = fakeApi({
      pluginConfig: dirConfig(),
      stateDir: state,
      config: {
        agents: { list: [{ id: 'xiaowen', name: 'Xiaowen' }] },
        plugins: { entries: { origin: { hooks: { allowConversationAccess: true } } } },
      },
    });
    const rec = registerOrigin(api, { sink });
    const routed = user('The report is ready.', T, {
      provenance: {
        kind: 'inter_session',
        sourceSessionKey: 'agent:xiaowen:main',
        sourceTool: 'sessions_send',
      },
    });
    await hooks.get('agent_end')!({ messages: [routed], success: true }, agentCtx());
    await rec!.idle();
    expect(sink.lines()[0]).toMatchObject({ author: 'agent', speaker: 'Xiaowen' });
  });

  it.each([
    [{}, 'set "dir"'],
    [{ dir: '/x', hub: 'https://hub.example.com' }, 'not both'],
    [{ hub: 'https://hub.example.com' }, 'set "token"'],
    [{ hub: 'https://hub.example.com', tokenEnv: 'NOT_SET_ANYWHERE' }, 'NOT_SET_ANYWHERE'],
    [
      {
        hub: 'https://hub.example.com',
        token: { source: 'exec', provider: 'onepassword', id: 'op://OpenClaw/hub/credential' },
      },
      'did not resolve',
    ],
    [{ hub: 'ftp://hub.example.com', token: 't' }, 'http or https'],
    [{ hub: 'https://user:pw@hub.example.com', token: 't' }, 'credentials'],
    [{ hub: 'https://hub.example.com', token: 't', tokenEnv: 'X' }, 'not both'],
    [{ dir: '/x', token: 't' }, 'go with "hub"'],
    [{ dir: '/x', source: 'codex' }, 'cannot name a source'],
    [{ dir: '/x', source: 'Open Claw' }, 'cannot name a source'],
    [{ dir: '/x', projectBy: 'repo' }, '"projectBy"'],
    [{ dir: '/x', timeoutMs: 10 }, '"timeoutMs"'],
    [{ dir: '/x', agents: [] }, '"agents"'],
    [{ dir: '/x', triggers: 'user' }, '"triggers"'],
    [{ dir: '/x', includeTools: 'yes' }, '"includeTools"'],
    [{ hub: 'https://hub.example.com', token: 't', tools: 'on' }, '"tools"'],
    [{ hub: 'https://hub.example.com', token: 't', tools: 'everyone' }, 'owner-turns'],
    [{ hub: 'https://hub.example.com', token: 't', tools: 1 }, '"tools"'],
    [{ dir: '/x', hubUrl: 'typo' }, 'unknown config key hubUrl'],
  ])('registers nothing and says why, once, for %j', (pluginConfig, message) => {
    const { api, hooks, tools, logs } = fakeApi({ pluginConfig, stateDir: state });
    plugin.register(api);
    expect(hooks.size).toBe(0);
    expect(tools.size).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe('error');
    expect(logs[0]!.message).toContain('not recording');
    expect(logs[0]!.message).toContain(message);
  });

  it('records nothing in loads other than the Gateway own', () => {
    for (const mode of ['discovery', 'cli-metadata', 'setup-only', 'tool-discovery']) {
      const { api, hooks, tools, logs } = fakeApi({
        pluginConfig: dirConfig(),
        registrationMode: mode,
      });
      plugin.register(api);
      expect(hooks.size).toBe(0);
      expect(tools.size).toBe(0);
      expect(logs).toEqual([]);
    }
  });

  it('accepts every option the manifest declares', () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
    );
    const all: Record<string, unknown> = {
      source: 'openclaw-us',
      hub: 'https://hub.example.com/',
      token: 'ogn_x',
      agents: ['main', 'xiaowen'],
      triggers: ['user', 'cron'],
      projectBy: 'channel',
      project: 'ops',
      includeTools: false,
      reconcileOnEnd: true,
      tools: 'owner-private',
      spoolDir: path.join(state, 'spool-here'),
      timeoutMs: 3000,
    };
    const declared = Object.keys(manifest.configSchema.properties).sort();
    expect([...Object.keys(all), 'dir', 'tokenEnv'].sort()).toEqual(declared);
    expect(Object.keys(manifest.uiHints).sort()).toEqual(declared);
    expect(manifest.configContracts.secretInputs.paths).toEqual([
      { path: 'token', expected: 'string' },
    ]);
    const { api } = fakeApi({ pluginConfig: all, stateDir: state });
    const rec = registerOrigin(api);
    expect(rec?.config).toMatchObject({
      source: 'openclaw-us',
      target: { kind: 'hub', url: 'https://hub.example.com', token: 'ogn_x' },
      agents: ['main', 'xiaowen'],
      triggers: ['user', 'cron'],
      projectBy: 'channel',
      project: 'ops',
      includeTools: false,
      reconcileOnEnd: true,
      tools: 'owner-private',
      stateDir: path.join(state, 'spool-here'),
      timeoutMs: 3000,
    });
  });

  it('warns, and still records, when Origin would ignore the directory for its name', () => {
    const { api, hooks, logs } = fakeApi({
      pluginConfig: { dir: path.join(state, 'sources', 'OpenClaw') },
      stateDir: state,
    });
    plugin.register(api);
    expect(hooks.size).toBeGreaterThan(0);
    expect(logs.find((l) => l.level === 'warn')?.message).toContain('ignores OpenClaw');
  });

  it('keeps its state under OpenClaw state directory by default', () => {
    const { api } = fakeApi({ pluginConfig: dirConfig(), stateDir: state });
    expect(registerOrigin(api)?.config.stateDir).toBe(path.join(state, 'origin-openclaw'));
  });

  it('never throws into OpenClaw, whatever a hook is handed', async () => {
    const { api, hooks } = fakeApi({ pluginConfig: dirConfig(), stateDir: state });
    plugin.register(api);
    for (const [name, handler] of hooks) {
      for (const [event, ctx] of [
        [undefined, undefined],
        [null, null],
        [42, 'x'],
        [{ messages: 'not a list' }, { sessionKey: 7 }],
        [{ messages: [null, { role: 'assistant', content: 5 }] }, { sessionKey: 'agent:a:b' }],
        [
          {},
          {
            sessionKey: 'agent:a:b',
            endedTranscript: { available: true, readTail: () => Promise.reject(new Error('gone')) },
          },
        ],
      ] as Array<[unknown, unknown]>) {
        await expect(Promise.resolve(handler(event, ctx)), name).resolves.toBeUndefined();
      }
    }
  });

  it('uses console.error when the host gives no logger', () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      const { api } = fakeApi({ pluginConfig: {} });
      api.logger = undefined;
      plugin.register(api);
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^\[origin\] not recording/);
  });
});
