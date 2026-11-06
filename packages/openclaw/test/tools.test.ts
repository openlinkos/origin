import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callHubTool, PROTOCOL_VERSION } from '../src/hub-mcp.js';
import plugin, { registerOrigin } from '../src/index.js';
import { ORIGIN_TOOLS, TOOL_NAMES } from '../src/tools.js';
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
      `origin: giving every agent Origin's read tools from ${hub.url}, in the owner's own turns: origin_brief, origin_search, origin_get, origin_timeline, origin_digest`,
    ]);
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

  it('registers no tools with a directory, or with tools set to false', () => {
    const dir = start({ hub: undefined, token: undefined, dir: path.join(state, 'openclaw') });
    expect(dir.tools.size).toBe(0);
    expect(dir.hooks.size).toBeGreaterThan(0);
    const off = start({ tools: false });
    expect(off.tools.size).toBe(0);
    expect(off.hooks.has('agent_end')).toBe(true);
    expect(off.logs.some((l) => l.message.includes('read tools'))).toBe(false);
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

describe("only in the owner's own turns", () => {
  const conversation = {
    kind: 'conversation',
    agentId: 'xiaohan',
    sessionKey: 'agent:xiaohan:telegram:group:7',
    sessionId: 'sess-2',
  };

  it('offers every tool in a turn OpenClaw resolved as the owner-private audience', () => {
    const { tool } = start();
    for (const name of TOOL_NAMES) expect(tool(name, owner())?.name).toBe(name);
  });

  it("offers none for a conversation's audience, or a turn without one, whoever sent it", () => {
    const { tool, logs } = start();
    for (const name of TOOL_NAMES) {
      expect(tool(name, owner({ memoryAudience: conversation }))).toBeNull();
      expect(tool(name, owner({ memoryAudience: conversation, senderIsOwner: true }))).toBeNull();
      // A cron, heartbeat, or detached run, or someone else's turn: no audience.
      expect(tool(name, owner({ memoryAudience: undefined }))).toBeNull();
      expect(tool(name, owner({ memoryAudience: undefined, senderIsOwner: true }))).toBeNull();
      expect(tool(name, owner({ memoryAudience: { kind: 'owner' } }))).toBeNull();
      expect(tool(name, owner({ memoryAudience: 'owner-private' }))).toBeNull();
    }
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('offers none without a context, or with one that lacks the invocation guard, and says so once', () => {
    const { tool, tools, logs } = start();
    for (const name of TOOL_NAMES) {
      expect(tools.get(name)?.factory.create(undefined)).toBeNull();
      expect(tool(name, null)).toBeNull();
      expect(tool(name, 'agent:xiaohan:main')).toBeNull();
      // A context of an older version: the run's fields and even an audience, but no guard.
      expect(tool(name, { ...agentCtx(), senderIsOwner: true })).toBeNull();
      expect(tool(name, owner({ assertInvocationCurrent: undefined }))).toBeNull();
    }
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'origin: the read tools need an OpenClaw that resolves memory audiences, and this one built a tool without its invocation guard: its agents get no Origin tools',
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
      'origin: the read tools need an OpenClaw that resolves memory audiences (2026.10.6 or later), and this one is 2026.9.30: its agents get no Origin tools',
    ]);
    expect(old.logs.some((l) => l.message.includes('giving'))).toBe(false);
    // A later one, a pre-release of the first, or one that does not say: the tools, still gated.
    for (const version of ['2026.10.9', '2027.1.2', '2026.10.6-beta.1', null, 'dev']) {
      const host = start({}, { version });
      expect([...host.tools.keys()]).toEqual(TOOL_NAMES);
      expect(host.tool('origin_search', agentCtx())).toBeNull();
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
