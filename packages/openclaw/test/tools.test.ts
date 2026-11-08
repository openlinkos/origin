import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS_MODES, type ToolsMode } from '../src/config.js';
import { callHubTool, PROTOCOL_VERSION } from '../src/hub-mcp.js';
import plugin, { registerOrigin } from '../src/index.js';
import { ORIGIN_TOOLS, offeredIn, TOOL_NAMES } from '../src/tools.js';
import type { AgentTool } from '../src/types.js';
import { agentCtx, fakeApi, tmpDir } from './fake.js';

/** Synthetic only: no real hub, token, or agent. */
const TOKEN = 'ogn_tools_test_secret';

interface Call {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/**
 * A stand-in for the hub's `/mcp` (stateless Streamable HTTP, JSON answers): by default, a tool's
 * result whose text echoes the tool's name and arguments.
 */
class FakeMcpHub {
  readonly calls: Call[] = [];
  respond: (c: Call) => { status?: number; body?: unknown; raw?: string; delayMs?: number } = (
    c,
  ) => {
    const params = c.body.params as { name: string; arguments: unknown };
    return {
      body: {
        jsonrpc: '2.0',
        id: c.body.id,
        result: {
          content: [
            { type: 'text', text: JSON.stringify({ tool: params.name, args: params.arguments }) },
          ],
        },
      },
    };
  };
  private server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // left empty
      }
      const call: Call = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      this.calls.push(call);
      const out = this.respond(call);
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(out.raw ?? JSON.stringify(out.body ?? {}));
      }, out.delayMs ?? 0);
    });
  });
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The arguments of each tool call, by the hub's name of the tool. */
  args(): Array<[string, unknown]> {
    return this.calls.map((c) => {
      const p = c.body.params as { name: string; arguments: unknown };
      return [p.name, p.arguments];
    });
  }
}

let hub: FakeMcpHub;
let state: string;
beforeEach(async () => {
  hub = new FakeMcpHub();
  await hub.start();
  state = tmpDir('origin-openclaw-tools-');
});
afterEach(async () => {
  await hub.stop();
  fs.rmSync(state, { recursive: true, force: true });
});

const manifest = JSON.parse(
  fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
);

function start(
  pluginConfig: Record<string, unknown> = {},
  more: Parameters<typeof fakeApi>[0] = {},
) {
  const fake = fakeApi({
    pluginConfig: { hub: hub.url, token: TOKEN, ...pluginConfig },
    stateDir: state,
    ...more,
  });
  registerOrigin(fake.api);
  /** The tool a turn with this tool context gets, or null when it gets none. */
  const tool = (name: string, ctx: unknown = owner()): AgentTool | null => {
    const registered = fake.tools.get(name);
    if (!registered) throw new Error(`${name} is not registered`);
    return registered.factory.create(ctx);
  };
  return { ...fake, tool };
}

/**
 * A version 2 tool context, as OpenClaw 2026.10.6 gives one for a turn it resolved as the owner's
 * own (synthetic): the run's fields, `memoryAudience`, and the guards, which pass.
 */
function owner(over: Record<string, unknown> = {}, agentId = 'xiaohan'): Record<string, unknown> {
  return {
    ...agentCtx(),
    messageChannel: 'telegram',
    memoryAudience: { kind: 'owner-private', agentId },
    assertInvocationCurrent: () => undefined,
    assertMemoryAudienceCurrent: () => undefined,
    ...over,
  };
}

/** Synthetic Discord ids: the owner, someone else, a guild channel, and a thread in it. */
const OWNER_ID = '100000000000000001';
const OTHER_ID = '100000000000000002';
const CHANNEL_KEY = 'agent:xiaohan:discord:channel:300000000000000001';
const THREAD_KEY = `${CHANNEL_KEY}:thread:300000000000000002`;

/**
 * A version 2 tool context, as OpenClaw 2026.10.6 gives one for a turn the owner started in a
 * Discord guild channel with memory-core in the memory slot (synthetic): the run's fields, the
 * sender, and the invocation guard; no memory audience, whose fields OpenClaw sets undefined.
 */
function channelTurn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'xiaohan',
    sessionKey: CHANNEL_KEY,
    sessionId: 'sess-3',
    messageChannel: 'discord',
    agentAccountId: 'default',
    nativeChannelId: '300000000000000001',
    deliveryContext: { channel: 'discord', to: 'channel:300000000000000001', accountId: 'default' },
    requesterSenderId: OWNER_ID,
    senderIsOwner: true,
    memoryAudience: undefined,
    assertMemoryAudienceCurrent: undefined,
    assertInvocationCurrent: () => undefined,
    ...over,
  };
}

/** The same in a thread of that channel. */
const threadTurn = (over: Record<string, unknown> = {}) =>
  channelTurn({
    sessionKey: THREAD_KEY,
    nativeChannelId: '300000000000000002',
    deliveryContext: {
      channel: 'discord',
      to: 'channel:300000000000000002',
      accountId: 'default',
      threadId: '300000000000000002',
    },
    ...over,
  });

/** Run a tool as OpenClaw does, with the call's id first. */
const run = (tool: AgentTool | null, params: unknown, signal?: AbortSignal) => {
  if (!tool) throw new Error('no tool for this run');
  return tool.execute('call_1', params, signal);
};

describe('registration', () => {
  it('registers the five read tools the manifest declares, each as a versioned factory under its name', () => {
    const { tools, hooks, logs } = start();
    expect(TOOL_NAMES).toEqual([
      'origin_brief',
      'origin_search',
      'origin_get',
      'origin_timeline',
      'origin_digest',
    ]);
    expect([...tools.keys()]).toEqual(TOOL_NAMES);
    expect(manifest.contracts.tools).toEqual(TOOL_NAMES);
    expect(Object.keys(manifest.toolMetadata)).toEqual(TOOL_NAMES);
    for (const { factory, opts } of tools.values()) {
      expect(factory.contextVersion).toBe(2);
      expect(opts?.optional).toBeUndefined();
    }
    // The recorder is there too.
    expect(hooks.has('agent_end')).toBe(true);
    expect(logs.filter((l) => l.level === 'info').map((l) => l.message)).toEqual([
      expect.stringMatching(/^origin: recording every agent/),
      `origin: giving every agent Origin's read tools from ${hub.url}, in every turn the owner starts: origin_brief, origin_search, origin_get, origin_timeline, origin_digest`,
    ]);
    expect(
      start({ tools: 'owner-private' }).logs.find((l) => l.message.includes('giving'))?.message,
    ).toBe(
      `origin: giving every agent Origin's read tools from ${hub.url}, in the turns OpenClaw resolves as the owner's private memory audience: origin_brief, origin_search, origin_get, origin_timeline, origin_digest`,
    );
  });

  it('gives each tool a name, label, description, and an object schema', () => {
    const { tool } = start();
    for (const spec of ORIGIN_TOOLS) {
      const t = tool(spec.name);
      expect(t).toMatchObject({ name: spec.name, label: expect.any(String) });
      expect(t?.description.length).toBeGreaterThan(40);
      expect(t?.parameters).toMatchObject({ type: 'object', properties: expect.any(Object) });
      expect(typeof t?.execute).toBe('function');
    }
    expect(tool('origin_brief')?.description).toMatch(/when you start a task/);
    expect(Object.keys(tool('origin_brief')?.parameters.properties as object)).toEqual([
      'project',
      'about',
    ]);
    for (const name of ['origin_brief', 'origin_search', 'origin_timeline']) {
      expect(tool(name)?.description).toContain('`origin_get`');
    }
  });

  it('registers no tools with a directory, or with tools set to off (or false, as 0.6.0 took it)', () => {
    const dir = start({ hub: undefined, token: undefined, dir: path.join(state, 'openclaw') });
    expect(dir.tools.size).toBe(0);
    expect(dir.hooks.size).toBeGreaterThan(0);
    for (const tools of ['off', false]) {
      const off = start({ tools });
      expect(off.tools.size).toBe(0);
      expect(off.hooks.has('agent_end')).toBe(true);
      expect(off.logs.some((l) => l.message.includes('read tools'))).toBe(false);
    }
    // With a directory, whatever `tools` says.
    const dirOn = start({
      hub: undefined,
      token: undefined,
      dir: path.join(state, 'openclaw'),
      tools: 'owner-turns',
    });
    expect(dirOn.tools.size).toBe(0);
  });

  it('takes the gate from tools: owner-turns by default, and for true, as 0.6.0 took it', () => {
    for (const tools of [undefined, null, true, 'owner-turns', ' owner-turns ']) {
      const { tool } = start({ tools });
      expect(tool('origin_search', channelTurn())?.name).toBe('origin_search');
      expect(tool('origin_search', owner())?.name).toBe('origin_search');
    }
    const strict = start({ tools: 'owner-private' });
    expect(strict.tool('origin_search', channelTurn())).toBeNull();
    expect(strict.tool('origin_search', owner())?.name).toBe('origin_search');
  });

  it("declares in the manifest's schema the settings of tools the plugin takes", () => {
    expect(manifest.configSchema.properties.tools).toEqual({
      anyOf: [{ type: 'string', enum: [...TOOLS_MODES] }, { type: 'boolean' }],
      default: 'owner-turns',
    });
    expect(TOOLS_MODES[0]).toBe('owner-turns');
    expect(manifest.uiHints.tools.help).toContain('owner-turns');
  });

  it('still records, and says so once, on a host that cannot register tools', () => {
    const { hooks, logs } = start({}, { registerTool: false });
    expect(hooks.has('agent_end')).toBe(true);
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'origin: this OpenClaw cannot register tools: its agents get no Origin tools',
    ]);
  });

  it('registers the tools alone, quietly, in a load to list or run tools', () => {
    const { tools, hooks, logs } = start({}, { registrationMode: 'tool-discovery' });
    expect([...tools.keys()]).toEqual(TOOL_NAMES);
    expect(hooks.size).toBe(0);
    expect(logs).toEqual([]);
    const bad = fakeApi({ pluginConfig: { hub: 'nope' }, registrationMode: 'tool-discovery' });
    plugin.register(bad.api);
    expect(bad.tools.size).toBe(0);
    expect(bad.logs).toEqual([]);
  });

  it('serves only the agents the plugin records, by the agent of the memory audience', () => {
    const { tool } = start({ agents: ['xiaohan'] });
    expect(tool('origin_search', owner())).not.toBeNull();
    expect(tool('origin_search', owner({}, 'other'))).toBeNull();
    // The audience's agent comes first.
    expect(tool('origin_search', owner({ agentId: 'other' }))).not.toBeNull();
    expect(tool('origin_search', owner({ agentId: 'xiaohan' }, 'other'))).toBeNull();
    // An audience that names no agent: the run's, or its session key's, or none.
    const anonymous = { kind: 'owner-private' };
    expect(
      tool('origin_search', owner({ agentId: undefined, memoryAudience: anonymous })),
    ).not.toBeNull();
    expect(
      tool('origin_search', owner({ agentId: 'other', memoryAudience: anonymous })),
    ).toBeNull();
    expect(
      tool('origin_search', {
        assertInvocationCurrent: () => undefined,
        memoryAudience: anonymous,
        sessionKey: 'agent:xiaohan:telegram:direct:42',
      }),
    ).not.toBeNull();
    expect(
      tool('origin_search', {
        assertInvocationCurrent: () => undefined,
        memoryAudience: anonymous,
      }),
    ).toBeNull();
    // Without `agents`, every agent.
    expect(start().tool('origin_search', owner({}, 'other'))).not.toBeNull();
  });
});

describe("only in the owner's turns", () => {
  const conversation = {
    kind: 'conversation',
    agentId: 'xiaohan',
    sessionKey: 'agent:xiaohan:telegram:group:7',
    sessionId: 'sess-2',
  };
  /** A run nobody sent, in the shape OpenClaw 2026.10.6 gives its tools (synthetic). */
  const cron = channelTurn({
    sessionKey: 'agent:xiaohan:cron:nightly-digest',
    messageChannel: undefined,
    nativeChannelId: undefined,
    deliveryContext: undefined,
    requesterSenderId: undefined,
    senderIsOwner: false,
  });
  const heartbeat = channelTurn({
    sessionKey: 'agent:xiaohan:main',
    nativeChannelId: undefined,
    requesterSenderId: undefined,
    // A heartbeat's `From` may match an owner entry: OpenClaw names no sender all the same.
    senderIsOwner: true,
  });
  const cli = channelTurn({
    sessionKey: 'agent:xiaohan:main',
    messageChannel: undefined,
    nativeChannelId: undefined,
    deliveryContext: undefined,
    requesterSenderId: undefined,
    // `openclaw agent` runs as the owner, with no sender.
    senderIsOwner: true,
    oneShotCliRun: true,
  });
  // Queued messages of several senders, run as one: OpenClaw clears the sender.
  const batch = channelTurn({ requesterSenderId: undefined, senderIsOwner: false });

  it('offers every tool in a turn OpenClaw resolved as the owner-private audience, with either gate', () => {
    for (const tools of ['owner-turns', 'owner-private']) {
      const { tool } = start({ tools });
      for (const name of TOOL_NAMES) {
        expect(tool(name, owner())?.name).toBe(name);
        // Whatever the sender fields say: the audience is OpenClaw's proof.
        expect(tool(name, owner({ senderIsOwner: false }))?.name).toBe(name);
      }
    }
  });

  it('offers every tool in a turn the owner started in a Discord guild channel, a thread, or a direct chat', () => {
    const { tool } = start();
    const direct = owner({
      memoryAudience: undefined,
      assertMemoryAudienceCurrent: undefined,
      requesterSenderId: OWNER_ID,
      senderIsOwner: true,
    });
    for (const name of TOOL_NAMES) {
      expect(tool(name, channelTurn())?.name).toBe(name);
      expect(tool(name, threadTurn())?.name).toBe(name);
      expect(tool(name, direct)?.name).toBe(name);
    }
  });

  it('offers none in the same turns started by someone else', () => {
    const { tool } = start();
    for (const name of TOOL_NAMES) {
      for (const turn of [channelTurn, threadTurn]) {
        expect(tool(name, turn({ requesterSenderId: OTHER_ID, senderIsOwner: false }))).toBeNull();
        expect(
          tool(name, turn({ requesterSenderId: OTHER_ID, senderIsOwner: undefined })),
        ).toBeNull();
        expect(
          tool(
            name,
            turn({
              requesterSenderId: OTHER_ID,
              senderIsOwner: false,
              memoryAudience: conversation,
            }),
          ),
        ).toBeNull();
      }
    }
  });

  it('offers none in a cron, heartbeat, or openclaw agent run, or a batch of several senders', () => {
    const { tool, logs } = start();
    for (const name of TOOL_NAMES) {
      for (const ctx of [cron, heartbeat, cli, batch]) expect(tool(name, ctx)).toBeNull();
      // A cron job made by the owner names the owner, but OpenClaw does not take the run for theirs.
      expect(tool(name, { ...cron, requesterSenderId: OWNER_ID })).toBeNull();
    }
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('offers none when the sender is the owner but OpenClaw names no sender, or a fact is not of its type', () => {
    const { tool } = start();
    for (const name of TOOL_NAMES) {
      for (const requesterSenderId of [undefined, null, '', '   ', 42, { id: OWNER_ID }]) {
        expect(tool(name, channelTurn({ requesterSenderId }))).toBeNull();
      }
      for (const senderIsOwner of [undefined, null, 'true', 1, {}]) {
        expect(tool(name, channelTurn({ senderIsOwner }))).toBeNull();
      }
      // Fields of the older shapes are not the sender's.
      expect(
        tool(name, channelTurn({ requesterSenderId: undefined, senderId: OWNER_ID })),
      ).toBeNull();
    }
  });

  it("with a memory audience, offers them to the owner only when it is bound to the turn's own session", () => {
    const { tool } = start();
    const audience = { ...conversation, sessionKey: CHANNEL_KEY };
    for (const name of TOOL_NAMES) {
      expect(tool(name, channelTurn({ memoryAudience: audience }))?.name).toBe(name);
      // Another session's audience, such as the channel's in a turn of its thread.
      expect(tool(name, threadTurn({ memoryAudience: audience }))).toBeNull();
      expect(tool(name, owner({ memoryAudience: conversation, senderIsOwner: true }))).toBeNull();
      expect(
        tool(
          name,
          owner({ memoryAudience: conversation, senderIsOwner: true, requesterSenderId: OWNER_ID }),
        ),
      ).toBeNull();
      // An audience that names no session, or is not one.
      expect(tool(name, channelTurn({ memoryAudience: { kind: 'conversation' } }))).toBeNull();
      expect(tool(name, channelTurn({ memoryAudience: { kind: 'owner' } }))).toBeNull();
      expect(tool(name, channelTurn({ memoryAudience: 'owner-private' }))).toBeNull();
      expect(tool(name, channelTurn({ memoryAudience: CHANNEL_KEY }))).toBeNull();
      // A turn that names no session.
      expect(
        tool(
          name,
          channelTurn({ sessionKey: undefined, memoryAudience: { kind: 'conversation' } }),
        ),
      ).toBeNull();
    }
  });

  it("with tools set to owner-private, offers none in the owner's channel, thread, or direct turns OpenClaw resolved no private audience for", () => {
    const { tool } = start({ tools: 'owner-private' });
    for (const name of TOOL_NAMES) {
      expect(tool(name, channelTurn())).toBeNull();
      expect(tool(name, threadTurn())).toBeNull();
      expect(
        tool(name, channelTurn({ memoryAudience: { ...conversation, sessionKey: CHANNEL_KEY } })),
      ).toBeNull();
      expect(
        tool(
          name,
          owner({ memoryAudience: undefined, requesterSenderId: OWNER_ID, senderIsOwner: true }),
        ),
      ).toBeNull();
      expect(tool(name, owner())?.name).toBe(name);
    }
  });

  it('decides by the gate alone (offeredIn)', () => {
    const cases: Array<[Record<string, unknown>, Record<ToolsMode, boolean>]> = [
      [owner(), { 'owner-turns': true, 'owner-private': true, off: false }],
      [channelTurn(), { 'owner-turns': true, 'owner-private': false, off: false }],
      [threadTurn(), { 'owner-turns': true, 'owner-private': false, off: false }],
      [
        channelTurn({ senderIsOwner: false }),
        { 'owner-turns': false, 'owner-private': false, off: false },
      ],
      [cron, { 'owner-turns': false, 'owner-private': false, off: false }],
      [heartbeat, { 'owner-turns': false, 'owner-private': false, off: false }],
      [cli, { 'owner-turns': false, 'owner-private': false, off: false }],
      [batch, { 'owner-turns': false, 'owner-private': false, off: false }],
      [{}, { 'owner-turns': false, 'owner-private': false, off: false }],
    ];
    for (const [ctx, expected] of cases) {
      for (const mode of TOOLS_MODES) expect(offeredIn(mode, ctx), mode).toBe(expected[mode]);
    }
  });

  it("serves only the agents the plugin records, by the turn's agent or its session key", () => {
    const { tool } = start({ agents: ['xiaohan'] });
    expect(tool('origin_search', channelTurn())).not.toBeNull();
    expect(tool('origin_search', threadTurn({ agentId: undefined }))).not.toBeNull();
    expect(tool('origin_search', channelTurn({ agentId: 'other' }))).toBeNull();
    expect(
      tool(
        'origin_search',
        channelTurn({
          agentId: undefined,
          sessionKey: 'agent:other:discord:channel:300000000000000001',
        }),
      ),
    ).toBeNull();
    expect(
      tool('origin_search', channelTurn({ agentId: undefined, sessionKey: undefined })),
    ).toBeNull();
  });

  it('offers none without a context, or with one that lacks the invocation guard, and says so once', () => {
    const { tool, tools, logs } = start();
    for (const name of TOOL_NAMES) {
      expect(tools.get(name)?.factory.create(undefined)).toBeNull();
      expect(tool(name, null)).toBeNull();
      expect(tool(name, 'agent:xiaohan:main')).toBeNull();
      // A context of an older version: the run's fields, the owner's sender, even an audience, but no guard.
      expect(
        tool(name, { ...agentCtx(), senderIsOwner: true, requesterSenderId: OWNER_ID }),
      ).toBeNull();
      expect(tool(name, channelTurn({ assertInvocationCurrent: undefined }))).toBeNull();
      expect(tool(name, owner({ assertInvocationCurrent: undefined }))).toBeNull();
    }
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      "origin: the read tools need OpenClaw's invocation guard, and this OpenClaw built a tool without it: its agents get no Origin tools",
    ]);
  });

  it("checks the invocation guard alone, before and after the call, in an owner's turn without an audience", async () => {
    const order: string[] = [];
    hub.respond = (c) => {
      order.push('hub');
      return {
        body: {
          jsonrpc: '2.0',
          id: c.body.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      };
    };
    const ctx = channelTurn({ assertInvocationCurrent: () => order.push('invocation') });
    await run(start().tool('origin_search', ctx), {});
    expect(order).toEqual(['invocation', 'hub', 'invocation']);

    // With an audience bound to the turn, its guard too.
    order.length = 0;
    const bound = channelTurn({
      memoryAudience: { ...conversation, sessionKey: CHANNEL_KEY },
      assertInvocationCurrent: () => order.push('invocation'),
      assertMemoryAudienceCurrent: () => order.push('audience'),
    });
    await run(start().tool('origin_search', bound), {});
    expect(order).toEqual(['invocation', 'audience', 'hub', 'invocation', 'audience']);
  });

  it('withholds the answer when the invocation guard throws after the call, in a channel turn', async () => {
    let live = true;
    const ctx = threadTurn({
      assertInvocationCurrent: () => {
        if (!live) throw new Error('the tool invocation is no longer current');
      },
    });
    hub.respond = (c) => {
      live = false;
      return {
        body: {
          jsonrpc: '2.0',
          id: c.body.id,
          result: {
            content: [{ type: 'text', text: 'the owner keeps the spare key in the shed' }],
          },
        },
      };
    };
    const err = await run(start().tool('origin_get', ctx), { id: 'ent_1' }).catch((e: Error) => e);
    expect(hub.calls).toHaveLength(1);
    expect((err as Error).message).toBe(
      "this turn may no longer read the owner's memory in Origin: the tool invocation is no longer current",
    );
    expect((err as Error).message).not.toContain('shed');
  });

  it("briefs on the agent's project in a channel turn, or on the channel's with projectBy channel", async () => {
    await run(start().tool('origin_brief', channelTurn()), {});
    await run(start().tool('origin_brief', threadTurn({ agentId: undefined })), {});
    await run(start({ projectBy: 'channel' }).tool('origin_brief', channelTurn()), {});
    expect(hub.args()).toEqual([
      ['brief', { project: 'xiaohan' }],
      ['brief', { project: 'xiaohan' }],
      ['brief', { project: 'discord' }],
    ]);
  });

  it('checks both guards right before the call and before releasing the answer', async () => {
    const order: string[] = [];
    const ctx = owner({
      assertInvocationCurrent: () => order.push('invocation'),
      assertMemoryAudienceCurrent: () => order.push('audience'),
    });
    hub.respond = (c) => {
      order.push('hub');
      return {
        body: {
          jsonrpc: '2.0',
          id: c.body.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      };
    };
    await run(start().tool('origin_search', ctx), {});
    expect(order).toEqual(['invocation', 'audience', 'hub', 'invocation', 'audience']);
  });

  it.each([
    ['assertInvocationCurrent', 'the tool invocation is no longer current'],
    ['assertMemoryAudienceCurrent', 'the session changed incarnation'],
  ])('withholds the answer when %s throws after the call', async (guard, reason) => {
    let live = true;
    const ctx = owner({
      [guard]: () => {
        if (!live) throw new Error(reason);
      },
    });
    const secret = 'the owner said the vault code is in drawer 3';
    hub.respond = (c) => {
      live = false;
      return {
        body: {
          jsonrpc: '2.0',
          id: c.body.id,
          result: { content: [{ type: 'text', text: secret }] },
        },
      };
    };
    const { tool } = start();
    const err = await run(tool('origin_brief', ctx), {}).catch((e: Error) => e);
    expect(hub.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `this turn may no longer read the owner's memory in Origin: ${reason}`,
    );
    expect(JSON.stringify(err)).not.toContain('drawer');
    expect((err as Error).stack ?? '').not.toContain('drawer');

    // The hub's error is withheld too.
    live = true;
    hub.respond = (c) => {
      live = false;
      return {
        body: {
          jsonrpc: '2.0',
          id: c.body.id,
          result: { content: [{ type: 'text', text: secret }], isError: true },
        },
      };
    };
    const refused = await run(tool('origin_get', ctx), { id: 'ent_1' }).catch((e: Error) => e);
    expect((refused as Error).message).not.toContain('drawer');
    expect((refused as Error).message).toContain('may no longer read');
  });

  it('calls no hub when a guard already throws', async () => {
    const ctx = owner({
      assertMemoryAudienceCurrent: () => {
        throw new Error('revoked');
      },
    });
    await expect(run(start().tool('origin_search', ctx), {})).rejects.toThrow(
      "this turn may no longer read the owner's memory in Origin: revoked",
    );
    expect(hub.calls).toEqual([]);
  });

  it('registers no tools on an OpenClaw older than 2026.10.6, and says so once', () => {
    const old = start({}, { version: '2026.9.30' });
    expect(old.tools.size).toBe(0);
    expect(old.hooks.has('agent_end')).toBe(true);
    expect(old.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'origin: the read tools need OpenClaw 2026.10.6 or later, and this one is 2026.9.30: its agents get no Origin tools',
    ]);
    expect(old.logs.some((l) => l.message.includes('giving'))).toBe(false);
    // A later one, a pre-release of the first, or one that does not say: the tools, still gated.
    for (const version of ['2026.10.9', '2027.1.2', '2026.10.6-beta.1', null, 'dev']) {
      const host = start({}, { version });
      expect([...host.tools.keys()]).toEqual(TOOL_NAMES);
      expect(host.tool('origin_search', agentCtx())).toBeNull();
      expect(host.tool('origin_search', channelTurn({ senderIsOwner: false }))).toBeNull();
    }
  });
});

describe('origin_brief', () => {
  it("briefs on the agent's project by default, as the recorder files its sessions", async () => {
    const { tool } = start();
    const result = await run(tool('origin_brief'), {});
    expect(hub.args()).toEqual([['brief', { project: 'xiaohan' }]]);
    expect(result).toEqual({
      content: [
        { type: 'text', text: JSON.stringify({ tool: 'brief', args: { project: 'xiaohan' } }) },
      ],
      details: { ok: true },
    });
  });

  it('follows projectBy and project, and the agent may name another project and what it is about', async () => {
    const anonymous = { kind: 'owner-private' };
    const bare = { assertInvocationCurrent: () => undefined, memoryAudience: anonymous };
    await run(start({ projectBy: 'channel' }).tool('origin_brief'), {});
    await run(
      start({ projectBy: 'channel' }).tool('origin_brief', owner({ messageChannel: 'feishu' })),
      {},
    );
    await run(
      start({ projectBy: 'channel' }).tool('origin_brief', { ...bare, agentId: 'xiaohan' }),
      {
        about: '  the deploy lock ',
      },
    );
    await run(start({ project: 'ops' }).tool('origin_brief'), {});
    // The agent of the memory audience, else the run's, else its session key's.
    await run(start().tool('origin_brief', owner({ agentId: 'other' }, 'scout')), {});
    await run(start().tool('origin_brief', { ...bare, agentId: 'reader' }), {});
    await run(start().tool('origin_brief', { ...bare, sessionKey: 'agent:scout:main' }), {});
    await run(start().tool('origin_brief'), {
      project: 'demo-app',
      about: 'the release',
      cwd: '/srv/elsewhere',
    });
    expect(hub.args()).toEqual([
      ['brief', { project: 'telegram' }],
      ['brief', { project: 'feishu' }],
      ['brief', { project: 'xiaohan', about: 'the deploy lock' }],
      ['brief', { project: 'ops' }],
      ['brief', { project: 'scout' }],
      ['brief', { project: 'reader' }],
      ['brief', { project: 'scout' }],
      ['brief', { project: 'demo-app', about: 'the release' }],
    ]);
  });

  it('asks for a project when the run does not say which agent it is', async () => {
    const { tool } = start();
    const bare = {
      assertInvocationCurrent: () => undefined,
      memoryAudience: { kind: 'owner-private' },
    };
    await expect(run(tool('origin_brief', bare), { about: 'x' })).rejects.toThrow(/pass `project`/);
    await run(tool('origin_brief', bare), { project: 'named' });
    expect(hub.args()).toEqual([['brief', { project: 'named' }]]);
  });
});

describe('forwarding to the hub', () => {
  it('posts one JSON-RPC tools/call to /mcp with the token, and passes the other tools their parameters', async () => {
    const { tool } = start({ source: 'openclaw-us' });
    const params = { query: 'migration lock', scope: 'events', limit: 5 };
    const result = await run(tool('origin_search'), params);
    expect(hub.calls).toHaveLength(1);
    const [call] = hub.calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toBe('/mcp');
    expect(call!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call!.headers['content-type']).toBe('application/json');
    expect(call!.headers.accept).toBe('application/json, text/event-stream');
    expect(call!.headers['mcp-protocol-version']).toBe(PROTOCOL_VERSION);
    expect(call!.headers['x-origin-client']).toBe('openclaw-us');
    expect(call!.body).toEqual({
      jsonrpc: '2.0',
      id: expect.any(Number),
      method: 'tools/call',
      params: { name: 'search', arguments: params },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ tool: 'search', args: params });

    await run(tool('origin_get'), { id: 'ent_1' });
    await run(tool('origin_timeline'), { session: 's1', turn: 2 });
    await run(tool('origin_digest'), { day: '2026-11-05', time_zone: 'Asia/Shanghai' });
    expect(hub.args().slice(1)).toEqual([
      ['get', { id: 'ent_1' }],
      ['timeline', { session: 's1', turn: 2 }],
      ['digest', { day: '2026-11-05', time_zone: 'Asia/Shanghai' }],
    ]);
  });

  it("keeps a hub URL's path", async () => {
    const { tool } = start({ hub: `${hub.url}/origin/` });
    await run(tool('origin_get'), { id: 'ent_1' });
    expect(hub.calls[0]!.url).toBe('/origin/mcp');
  });

  it('returns each text the hub answered, and nothing else', async () => {
    hub.respond = (c) => ({
      body: {
        jsonrpc: '2.0',
        id: c.body.id,
        result: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    });
    const result = await run(start().tool('origin_get'), { id: 'ent_1' });
    expect(result.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  it("throws the hub's tool errors and refusals as the tool's errors", async () => {
    const { tool } = start();
    hub.respond = (c) => ({
      body: {
        jsonrpc: '2.0',
        id: c.body.id,
        result: { content: [{ type: 'text', text: 'Unknown id: ent_missing' }], isError: true },
      },
    });
    await expect(run(tool('origin_get'), { id: 'ent_missing' })).rejects.toThrow(
      /^Unknown id: ent_missing$/,
    );
    hub.respond = (c) => ({
      body: { jsonrpc: '2.0', id: c.body.id, error: { code: -32602, message: 'Invalid params' } },
    });
    await expect(run(tool('origin_get'), {})).rejects.toThrow(
      "Origin's hub refused the call: Invalid params",
    );
    hub.respond = () => ({ raw: '<html>proxy page</html>' });
    await expect(run(tool('origin_get'), { id: 'x' })).rejects.toThrow(/not an MCP result/);
  });

  it.each([
    [401, { error: 'Missing or invalid token.' }, "refused the plugin's token (401)"],
    [
      403,
      { error: 'This token was issued for the hub MCP endpoint (/mcp) only.' },
      "Origin's hub answered 403: This token was issued",
    ],
    [404, { error: 'Not found.' }, `no MCP endpoint at http://127.0.0.1`],
    [
      406,
      { jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable' }, id: null },
      "Origin's hub answered 406: Not Acceptable",
    ],
    [502, null, "Origin's hub answered 502"],
  ])('says what the hub answered %i', async (status, body, message) => {
    hub.respond = () => (body ? { status, body } : { status, raw: '' });
    await expect(run(start().tool('origin_search'), {})).rejects.toThrow(message);
  });

  it('never says the token, even when the hub echoes it', async () => {
    hub.respond = () => ({ status: 500, body: { error: `bad token ${TOKEN} here` } });
    const err = await run(start().tool('origin_search'), {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Origin's hub answered 500");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("reads the token from the Gateway's config at each call, and says when there is none yet", async () => {
    const ref = {
      source: 'exec',
      provider: 'onepassword',
      id: 'op://OpenClaw/origin-hub/credential',
    };
    let token: unknown = ref;
    const { tool } = start(
      { token: ref },
      {
        current: () => ({ plugins: { entries: { origin: { config: { hub: hub.url, token } } } } }),
      },
    );
    await expect(run(tool('origin_search'), {})).rejects.toThrow(
      "the Gateway has not resolved the hub token's SecretRef",
    );
    expect(hub.calls).toEqual([]);
    token = 'ogn_resolved_later';
    await run(tool('origin_search'), {});
    expect(hub.calls.map((c) => c.headers.authorization)).toEqual(['Bearer ogn_resolved_later']);
  });

  it('gives up after its timeout, and stops when OpenClaw cancels the call', async () => {
    hub.respond = () => ({ delayMs: 2000, body: {} });
    const call = {
      url: hub.url,
      token: TOKEN,
      client: 'openclaw',
      name: 'search',
      args: {},
    };
    expect(await callHubTool({ ...call, timeoutMs: 200 })).toEqual({
      ok: false,
      error: "Origin's hub did not answer within 200 ms",
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await callHubTool({ ...call, signal: controller.signal })).toEqual({
      ok: false,
      error: 'the call to Origin was cancelled',
    });
  });

  it('says when the hub cannot be reached, without the token', async () => {
    const closed = new FakeMcpHub();
    await closed.start();
    const url = closed.url;
    await closed.stop();
    const answer = await callHubTool({
      url,
      token: TOKEN,
      client: 'openclaw',
      name: 'search',
      args: {},
    });
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error).toMatch(
      new RegExp(`^Origin's hub at ${url.replace(/\./g, '\\.')} cannot be reached: `),
    );
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });
});
