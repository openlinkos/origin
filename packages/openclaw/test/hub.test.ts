import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { parseEventLine } from '@openlinkos/origin-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES } from '../src/delivery.js';
import { registerOrigin } from '../src/index.js';
import { agentCtx, assistant, fakeApi, firstTurn, T, tmpDir, user } from './fake.js';

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: string;
}

/** A stand-in for the hub's `/v1/sources/<name>/lines`, answering as `respond` says. */
class FakeHub {
  readonly requests: Recorded[] = [];
  respond: (r: Recorded) => { status: number; body?: unknown; delayMs?: number } = () => ({
    status: 200,
  });
  private server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      this.requests.push(r);
      const { status, body, delayMs } = this.respond(r);
      const lines = r.body.split('\n').filter(Boolean).length;
      const answer =
        body ??
        (status === 200
          ? { lines, events: lines, duplicates: 0, parse_errors: 0 }
          : { error: 'busy' });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
      }, delayMs ?? 0);
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

  /** The lines of every request that the hub took, in order. */
  delivered(): Array<Record<string, unknown>> {
    return this.requests
      .filter((r) => this.ok.has(r))
      .flatMap((r) =>
        r.body
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
  }
  readonly ok = new Set<Recorded>();
}

let hub: FakeHub;
let state: string;
beforeEach(async () => {
  hub = new FakeHub();
  await hub.start();
  const respond = hub.respond;
  hub.respond = (r) => {
    const out = respond(r);
    if (out.status === 200 && !out.delayMs) hub.ok.add(r);
    return out;
  };
  state = tmpDir('origin-openclaw-hub-');
});
afterEach(async () => {
  await hub.stop();
  fs.rmSync(state, { recursive: true, force: true });
});

/** Make the fake hub answer by `fn`, still noting which requests it took. */
function answer(
  fn: (r: Recorded, n: number) => { status: number; body?: unknown; delayMs?: number },
) {
  let n = 0;
  hub.respond = (r) => {
    const out = fn(r, n++);
    if (out.status === 200 && !out.delayMs) hub.ok.add(r);
    return out;
  };
}

function start(
  pluginConfig: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  current?: () => unknown,
) {
  const fake = fakeApi({
    pluginConfig: { hub: hub.url, token: 'ogn_test_token', ...pluginConfig },
    stateDir: state,
    current,
  });
  const rec = registerOrigin(fake.api, { now: () => T + 60_000, env });
  if (!rec) throw new Error(JSON.stringify(fake.logs));
  return { ...fake, rec };
}

const spooled = () => {
  const dir = path.join(state, 'origin-openclaw', 'spool');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
};

describe('delivery to a hub', () => {
  it('posts each turn to the source lines endpoint with the token', async () => {
    const { hooks, rec } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(hub.requests).toHaveLength(1);
    const [r] = hub.requests;
    expect(r!.method).toBe('POST');
    const url = new URL(r!.url, hub.url);
    expect(url.pathname).toBe('/v1/sources/openclaw/lines');
    expect(url.searchParams.get('path')).toMatch(
      /^xiaohan\/2026\/11\/agent-xiaohan-telegram-direct-42-[0-9a-f]{10}\.jsonl$/,
    );
    expect(r!.auth).toBe('Bearer ogn_test_token');
    expect(r!.type).toBe('application/x-ndjson');
    expect(r!.body.endsWith('\n')).toBe(true);
    const lines = r!.body.trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(parseEventLine(line).events).toHaveLength(1);
  });

  it('takes the token from the environment variable tokenEnv names, and another source name', async () => {
    const { hooks, rec } = start(
      { token: undefined, tokenEnv: 'ORIGIN_HUB_TOKEN_TEST', source: 'openclaw-us' },
      { ORIGIN_HUB_TOKEN_TEST: 'ogn_from_env' },
      // The Gateway's config holds no token then: the one from the environment is used.
      () => ({
        plugins: { entries: { origin: { config: { tokenEnv: 'ORIGIN_HUB_TOKEN_TEST' } } } },
      }),
    );
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(hub.requests[0]!.auth).toBe('Bearer ogn_from_env');
    expect(new URL(hub.requests[0]!.url, hub.url).pathname).toBe('/v1/sources/openclaw-us/lines');
  });

  it('waits for the Gateway to resolve the token, as on a reload, and then delivers what waited', async () => {
    const ref = {
      source: 'exec',
      provider: 'onepassword',
      id: 'op://OpenClaw/origin-hub/credential',
    };
    let token: unknown = ref;
    const current = () => ({
      plugins: { entries: { origin: { enabled: true, config: { hub: hub.url, token } } } },
    });
    const { hooks, rec, logs } = start({ token: ref }, {}, current);
    expect(rec.config.target).toMatchObject({ kind: 'hub', token: null });
    expect(logs.map((l) => l.message)).toEqual([
      expect.stringMatching(/^origin: recording every agent/),
      expect.stringMatching(/^origin: giving every agent Origin's read tools from http/),
      expect.stringContaining("has not resolved the hub token's SecretRef yet"),
    ]);
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(hub.requests).toEqual([]);
    expect(spooled()).toHaveLength(1);
    expect(logs.filter((l) => l.level === 'warn' && l.message.includes('cannot deliver'))).toEqual([
      expect.objectContaining({ message: expect.stringContaining('not resolved') }),
    ]);

    token = 'ogn_resolved';
    await hooks.get('gateway_start')!({ port: 18789 }, {});
    await rec.idle();
    expect(spooled()).toEqual([]);
    expect(hub.requests.map((r) => r.auth)).toEqual(['Bearer ogn_resolved']);
    await hooks.get('agent_end')!(
      { messages: [...firstTurn(), user('And now?', T + 20_000)], success: true },
      agentCtx({ runId: 'run-2' }),
    );
    await rec.idle();
    expect(hub.delivered()).toHaveLength(6);
    // Said once, when the token came.
    expect(
      logs.filter((l) => l.message.includes('the Gateway resolved the hub token: delivering to')),
    ).toEqual([expect.objectContaining({ level: 'info' })]);
  });

  it("reads the token from the Gateway's config at each delivery, else the one it was registered with", async () => {
    let live: unknown = 'ogn_live_1';
    const current = () => {
      if (live === 'fail') throw new Error('no snapshot');
      return { plugins: { entries: { Origin: { config: { token: live } } } } };
    };
    const { hooks, rec } = start({ token: 'ogn_registered' }, {}, current);
    const turn = async (i: number) => {
      await hooks.get('agent_end')!(
        { messages: [user(`Turn ${i}.`, T + i * 1000)], success: true },
        agentCtx({ runId: `run-${i}` }),
      );
      await rec.idle();
    };
    await turn(1);
    live = 'ogn_live_2';
    await turn(2);
    live = { source: 'exec', id: 'op://x' };
    await turn(3);
    live = 'fail';
    await turn(4);
    expect(hub.requests.map((r) => r.auth)).toEqual([
      'Bearer ogn_live_1',
      'Bearer ogn_live_2',
      'Bearer ogn_registered',
      'Bearer ogn_registered',
    ]);
  });

  it('spools a turn the hub cannot take, and sends it first with the next turn', async () => {
    answer((_r, n) => ({ status: n === 0 ? 503 : 200 }));
    const { hooks, rec, logs } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(spooled()).toHaveLength(1);
    expect(
      logs.filter((l) => l.level === 'warn' && l.message.includes('cannot deliver')),
    ).toHaveLength(1);

    const next = [...firstTurn(), user('Retry it.', T + 20_000)];
    await hooks.get('agent_end')!({ messages: next, success: true }, agentCtx({ runId: 'run-2' }));
    await rec.idle();
    expect(spooled()).toEqual([]);
    expect(hub.requests).toHaveLength(3);
    // The spooled turn first, then the new one: the order the lines were written in.
    expect(hub.delivered().map((l) => l.text)).toEqual([
      expect.stringContaining('Is the deploy stuck'),
      'Let me look.',
      expect.stringContaining('exec'),
      expect.stringContaining('migrate-1'),
      'It waits on a migration lock.',
      'Retry it.',
    ]);
  });

  it('spools a turn when the hub does not answer in time, and sends it when the Gateway starts', async () => {
    answer((_r, n) => (n === 0 ? { status: 200, delayMs: 2000 } : { status: 200 }));
    const { hooks, rec } = start({ timeoutMs: 200 });
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(spooled()).toHaveLength(1);

    // A new instance, as after a restart: gateway_start sends the spool.
    const again = start();
    await again.hooks.get('gateway_start')!({ port: 18789 }, {});
    await again.rec.idle();
    expect(spooled()).toEqual([]);
    expect(hub.delivered()).toHaveLength(5);
    // The lines were recorded as handed over: the next turn does not send them again.
    await again.hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await again.rec.idle();
    expect(hub.requests).toHaveLength(2);
  });

  it('sets aside a batch the hub refuses for good, and goes on', async () => {
    answer((_r, n) =>
      n === 0 ? { status: 400, body: { error: 'Invalid "path"' } } : { status: 200 },
    );
    const { hooks, rec, logs } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(spooled()).toEqual([]);
    const rejected = path.join(state, 'origin-openclaw', 'rejected');
    expect(fs.readdirSync(rejected)).toHaveLength(1);
    expect(logs.some((l) => l.level === 'error' && l.message.includes('Invalid "path"'))).toBe(
      true,
    );
    await hooks.get('agent_end')!(
      { messages: [...firstTurn(), user('Next.', T + 20_000)], success: true },
      agentCtx(),
    );
    await rec.idle();
    expect(hub.requests).toHaveLength(2);
    expect(hub.delivered().map((l) => l.text)).toEqual(['Next.']);
  });

  it('splits a large turn into requests the hub takes, and spools only what was not sent', async () => {
    answer((_r, n) => ({ status: n === 1 ? 502 : 200 }));
    const { hooks, rec } = start();
    const big = 'x'.repeat(300 * 1024);
    const messages = [0, 1, 2, 3, 4, 5].map((i) =>
      assistant([{ type: 'text', text: `${i} ${big}` }], T + i * 1000),
    );
    await hooks.get('agent_end')!({ messages, success: true }, agentCtx());
    await rec.idle();
    expect(hub.requests.length).toBe(2);
    for (const r of hub.requests)
      expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(spooled()).toHaveLength(1);
    await hooks.get('gateway_start')!({ port: 1 }, {});
    await rec.idle();
    expect(spooled()).toEqual([]);
    expect(hub.delivered().map((l) => String(l.text).slice(0, 1))).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  it('waits a little for deliveries in flight when the Gateway stops', async () => {
    answer(() => ({ status: 200, delayMs: 100 }));
    const { hooks } = start();
    await hooks.get('agent_end')!({ messages: firstTurn(), success: true }, agentCtx());
    await hooks.get('gateway_stop')!({ reason: 'shutdown' }, {});
    expect(hub.requests).toHaveLength(1);
  });
});
