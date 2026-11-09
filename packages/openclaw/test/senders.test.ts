import fs from 'node:fs';
import path from 'node:path';
import { parseEventLine } from '@openlinkos/origin-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerOrigin } from '../src/index.js';
import { lineId, pairingKey, type SenderFacts } from '../src/lines.js';
import { MAX_AGE_MS, SESSION_ENTRIES, SESSIONS, SenderMemory } from '../src/senders.js';
import { agentCtx, assistant, fakeApi, MemorySink, persisted, T, tmpDir, user } from './fake.js';

/**
 * OpenClaw 2026.10.6 gives `agent_end` the run's own copies of its messages, which lack who wrote
 * a user message; the copy it persists has it, a few seconds later in time. Synthetic data only:
 * these sessions, ids, names, and messages are made up.
 */

let state: string;
beforeEach(() => {
  state = tmpDir('origin-openclaw-senders-');
});
afterEach(() => {
  fs.rmSync(state, { recursive: true, force: true });
});

/** A Discord guild channel's session, as OpenClaw keys it. */
const GUILD = 'agent:main:discord:channel:1300000000000000001';
const guildCtx = (over: Record<string, unknown> = {}) =>
  agentCtx({
    agentId: 'main',
    sessionKey: GUILD,
    channel: 'discord',
    channelId: 'discord',
    accountId: 'bot-d',
    ...over,
  });
/** Synthetic sender ids, which no line may carry. */
const IDS = ['777000111', '777000222', '777000333'];

/** The copy OpenClaw persists of a user message: later in time, with who wrote it. */
const stored = (text: unknown, at: number, extra: Record<string, unknown> = {}) => ({
  role: 'user',
  content: text,
  timestamp: at + 5500,
  idempotencyKey: `turn-${at}:user`,
  provenance: { kind: 'external_user' },
  ...extra,
});
const sender = (facts: Record<string, unknown>) => ({ __openclaw: facts });
const observed = (id: string, senderKind: string) => ({
  type: 'observation',
  id,
  pluginId: 'discord',
  accountId: 'bot-d',
  senderKind,
});
const owner = sender({
  senderIsOwner: true,
  senderId: '777000111',
  senderName: 'Dana',
  senderUsername: 'dana_ops',
  senderIdentity: observed('777000111', 'human'),
});

function start(over: { config?: unknown; pluginConfig?: Record<string, unknown> } = {}) {
  const sink = new MemorySink();
  const fake = fakeApi({
    pluginConfig: { dir: path.join(state, 'sources', 'openclaw'), ...over.pluginConfig },
    stateDir: state,
    config: over.config,
  });
  const rec = registerOrigin(fake.api, { sink, now: () => T + 60_000 });
  if (!rec) throw new Error(JSON.stringify(fake.logs));
  const end = async (messages: unknown[], ctx = guildCtx()) => {
    await fake.hooks.get('agent_end')!({ messages, success: true }, ctx);
    await rec.idle();
  };
  return { ...fake, rec, sink, end };
}

const by = (lines: Array<Record<string, unknown>>) =>
  lines.filter((l) => l.role === 'user').map((l) => [l.author, l.speaker ?? null]);

describe('who wrote each message, from the copy OpenClaw persisted', () => {
  it("records the owner's message in a guild channel as the owner's, by name", async () => {
    const { persist, end, sink, listeners } = start();
    expect(listeners.size).toBe(1);
    const text = 'Is the canary green?';
    persist(persisted(stored(text, T, owner), { sessionKey: GUILD }));
    // The run's copy: its content in parts, its own time, and nothing of who wrote it.
    const mine = user('', T, { content: [{ type: 'text', text }] });
    await end([mine, assistant([{ type: 'text', text: 'It is.' }], T + 9000)]);
    const [line, answer] = sink.lines();
    expect(line).toMatchObject({ role: 'user', author: 'owner', speaker: 'Dana', kind: 'message' });
    expect(line!.meta).not.toHaveProperty('senderKind');
    // The line keeps the run's time and the id it always had.
    expect(line!.id).toBe(lineId([GUILD, T, 'user', 'message', 0]));
    expect(line!.time).toBe(new Date(T).toISOString());
    expect(answer).not.toHaveProperty('author');
    for (const l of sink.lines()) expect(parseEventLine(JSON.stringify(l)).events).toHaveLength(1);
    const all = JSON.stringify(sink.lines());
    for (const id of IDS) expect(all).not.toContain(id);
  });

  it('records a CLI turn of the owner, and another person, and a bot, as OpenClaw says', async () => {
    const { persist, end, sink } = start();
    const cli = 'agent:main:main';
    persist(
      persisted(stored('Deploy the fix.', T, sender({ senderIsOwner: true })), { sessionKey: cli }),
    );
    await end([user('Deploy the fix.', T)], agentCtx({ agentId: 'main', sessionKey: cli }));
    persist(
      persisted(
        stored(
          'Can I see it too?',
          T + 1000,
          sender({ senderIsOwner: false, senderId: '777000222', senderName: 'Lee' }),
        ),
        { sessionKey: GUILD },
      ),
    );
    persist(
      persisted(
        stored(
          'Build 12 failed.',
          T + 2000,
          sender({
            senderIsOwner: false,
            senderId: '777000333',
            senderName: 'CI Bot',
            senderIdentity: observed('777000333', 'bot'),
          }),
        ),
        { sessionKey: GUILD },
      ),
    );
    await end([user('Can I see it too?', T + 1000), user('Build 12 failed.', T + 2000)]);
    const lines = sink.lines();
    expect(by(lines)).toEqual([
      ['owner', null],
      ['person', 'Lee'],
      ['person', 'CI Bot'],
    ]);
    expect(lines[2]!.meta).toMatchObject({ senderKind: 'bot' });
    expect(lines[1]!.meta).not.toHaveProperty('senderKind');
  });

  it('records what another session routed in as its agent, and what OpenClaw made as the system', async () => {
    const { persist, end, sink } = start({
      config: {
        agents: { list: [{ id: 'xiaowen', name: 'Xiaowen' }] },
        plugins: { entries: { origin: { hooks: { allowConversationAccess: true } } } },
      },
      pluginConfig: { triggers: ['user', 'cron'] },
    });
    persist(
      persisted(
        stored('The report is ready.', T, {
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: 'agent:xiaowen:telegram:direct:777000222',
            sourceTool: 'sessions_send',
          },
          ...sender({ senderIsOwner: false }),
        }),
        { sessionKey: GUILD },
      ),
    );
    await end([user('The report is ready.', T)]);
    const cron = 'agent:main:cron:nightly';
    persist(
      persisted(
        stored('Write the nightly report.', T + 1000, {
          provenance: { kind: 'internal_system', sourceTool: 'cron', jobId: 'job-1' },
        }),
        { sessionKey: cron },
      ),
    );
    await end(
      [user('Write the nightly report.', T + 1000)],
      agentCtx({ agentId: 'main', sessionKey: cron, trigger: 'cron' }),
    );
    expect(by(sink.lines())).toEqual([
      ['agent', 'Xiaowen'],
      ['system', null],
    ]);
    expect(JSON.stringify(sink.lines())).not.toContain('777000222');
  });

  it('pairs messages with the same text in order, across turns', async () => {
    const { persist, end, sink } = start();
    const lee = sender({ senderIsOwner: false, senderName: 'Lee' });
    persist(persisted(stored('ok', T, owner), { sessionKey: GUILD }));
    persist(persisted(stored('ok', T + 1000, lee), { sessionKey: GUILD }));
    await end([user('ok', T), user(' ok ', T + 1000)]);
    expect(by(sink.lines())).toEqual([
      ['owner', 'Dana'],
      ['person', 'Lee'],
    ]);

    // The next turn's history holds both again; only its own message takes the next facts.
    persist(persisted(stored('ok', T + 20_000, lee), { sessionKey: GUILD }));
    persist(persisted(stored('ok', T + 40_000, owner), { sessionKey: GUILD }));
    await end(
      [user('ok', T), user('ok', T + 1000), user('ok', T + 20_000)],
      guildCtx({ runId: 'run-2' }),
    );
    await end(
      [user('ok', T), user('ok', T + 1000), user('ok', T + 20_000), user('ok', T + 40_000)],
      guildCtx({ runId: 'run-3' }),
    );
    expect(by(sink.lines())).toEqual([
      ['owner', 'Dana'],
      ['person', 'Lee'],
      ['person', 'Lee'],
      ['owner', 'Dana'],
    ]);
  });

  it('takes a message written twice, as OpenClaw may write it, once', async () => {
    const { persist, end, sink, rec } = start();
    const first = stored('Ship it.', T, owner);
    persist(persisted(first, { sessionKey: GUILD, messageId: 'entry-1' }));
    // Written again with the prompt the model saw: the same message, the same idempotency key.
    persist(
      persisted(
        {
          ...first,
          __openclaw: { ...first.__openclaw, modelPromptProjection: { version: 1, text: 'x' } },
        },
        { sessionKey: GUILD, messageId: 'entry-1' },
      ),
    );
    expect(rec.senders.size()).toBe(1);
    persist(
      persisted(stored('Ship it.', T + 30_000, sender({ senderName: 'Lee' })), {
        sessionKey: GUILD,
      }),
    );
    await end([user('Ship it.', T), user('Ship it.', T + 30_000)]);
    expect(by(sink.lines())).toEqual([
      ['owner', 'Dana'],
      ['person', 'Lee'],
    ]);
    expect(rec.senders.size()).toBe(0);
  });

  it("records a message whose persisted copy it never saw as a person's, without a name", async () => {
    const { persist, end, sink } = start();
    // Another session's, another text's, and an incognito thread's facts pair with nothing here.
    persist(
      persisted(stored('Hello there.', T, owner), {
        sessionKey: 'agent:main:discord:channel:1300000000000000002',
      }),
    );
    persist(persisted(stored('Something else.', T, owner), { sessionKey: GUILD }));
    await end([user('Hello there.', T)]);
    expect(by(sink.lines())).toEqual([['person', null]]);
  });

  it('keeps what the run copy says itself, and still takes its persisted facts', async () => {
    const { persist, end, sink, rec } = start();
    persist(persisted(stored('Status?', T, owner), { sessionKey: GUILD }));
    persist(
      persisted(stored('Status?', T + 1000, sender({ senderName: 'Lee' })), { sessionKey: GUILD }),
    );
    await end([
      user('Status?', T, sender({ senderIsOwner: false, senderName: 'Kim' })),
      user('Status?', T + 1000),
    ]);
    expect(by(sink.lines())).toEqual([
      ['person', 'Kim'],
      ['person', 'Lee'],
    ]);
    expect(rec.senders.size()).toBe(0);
  });

  it('notes nothing of what it does not record', async () => {
    const { persist, rec } = start({ pluginConfig: { agents: ['main'] } });
    persist(
      persisted(stored('Secret plans.', T, owner), {
        sessionKey: 'agent:main:incognito-1:direct:1',
      }),
    );
    persist(persisted(stored('Elsewhere.', T, owner), { sessionKey: 'agent:other:main' }));
    persist(persisted({ ...stored('Hi.', T, owner), role: 'assistant' }, { sessionKey: GUILD }));
    persist(
      persisted(
        stored(
          '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nx\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
          T,
          owner,
        ),
        {
          sessionKey: GUILD,
        },
      ),
    );
    persist(persisted(stored([{ type: 'image', data: 'x' }], T, owner), { sessionKey: GUILD }));
    persist(
      persisted(stored('No facts.', T, { provenance: { kind: 'external_user' } }), {
        sessionKey: GUILD,
      }),
    );
    expect(rec.senders.size()).toBe(0);
    persist(persisted(stored('Counted.', T, owner), { sessionKey: GUILD }));
    expect(rec.senders.size()).toBe(1);
  });

  it('leaves out the facts of runs it leaves out, and forgets an ended session', async () => {
    const { persist, end, sink, rec, hooks } = start();
    const heartbeat = 'agent:main:main:heartbeat';
    persist(persisted(stored('Check in.', T, owner), { sessionKey: heartbeat }));
    await end(
      [user('Check in.', T)],
      agentCtx({ agentId: 'main', sessionKey: heartbeat, trigger: 'heartbeat' }),
    );
    expect(sink.lines()).toEqual([]);
    expect(rec.senders.size()).toBe(0);

    persist(persisted(stored('Old.', T, owner), { sessionKey: GUILD, sessionId: 'sess-1' }));
    persist(persisted(stored('New.', T, owner), { sessionKey: GUILD, sessionId: 'sess-2' }));
    await hooks.get('session_end')!(
      { sessionId: 'sess-1', sessionKey: GUILD, reason: 'new' },
      guildCtx({ sessionId: 'sess-1' }),
    );
    expect(rec.senders.size()).toBe(1);
    await end([user('New.', T)], guildCtx({ sessionId: 'sess-2' }));
    expect(by(sink.lines())).toEqual([['owner', 'Dana']]);
  });

  it("never takes OpenClaw's internal runs for the owner's, though it persists their prompt so", async () => {
    const { persist, end, sink, rec } = start();
    // A one-shot model run, as OpenClaw 2026.10.6 runs it through its agent method: a `user` run in
    // a hidden session, whose prompt it persists with the operator's sender facts.
    const hidden =
      'agent:main:internal-session-effects:0d9c8b7a-6f5e-4d3c-2b1a-09f8e7d6c5b4-1a2b3c4d5e6f7081';
    const prompt = 'Reply with one word: does this synthetic diff look safe?';
    persist(persisted(stored(prompt, T, owner), { sessionKey: hidden, sessionId: 'x' }));
    persist(
      persisted(stored(prompt, T, owner), {
        sessionKey: GUILD,
        sessionId: 'internal-session-effects-run-2-0123456789abcdef',
      }),
    );
    expect(rec.senders.size()).toBe(0);
    await end([user(prompt, T)], guildCtx({ sessionKey: hidden, sessionId: 'x' }));
    await end(
      [user(prompt, T)],
      guildCtx({ sessionId: 'internal-session-effects-run-2-0123456789abcdef' }),
    );
    expect(sink.lines()).toEqual([]);
  });

  it('listens only with conversation access, and stops listening when OpenClaw disposes of it', () => {
    const without = fakeApi({
      pluginConfig: { dir: state },
      stateDir: state,
      conversationAccess: false,
    });
    registerOrigin(without.api);
    expect(without.listeners.size).toBe(0);

    const fake = fakeApi({ pluginConfig: { dir: state }, stateDir: state });
    registerOrigin(fake.api);
    expect(fake.listeners.size).toBe(1);
    fake.dispose();
    expect(fake.listeners.size).toBe(0);

    const old = fakeApi({ pluginConfig: { dir: state }, stateDir: state, events: false });
    expect(registerOrigin(old.api)).not.toBeNull();
    expect(
      old.logs.some((l) => l.level === 'warn' && l.message.includes('no transcript updates')),
    ).toBe(true);
  });

  it('never throws into OpenClaw, and returns nothing, whatever an update holds', () => {
    const fake = fakeApi({ pluginConfig: { dir: state }, stateDir: state });
    const rec = registerOrigin(fake.api)!;
    const [listener] = [...fake.listeners];
    const odd: unknown[] = [
      undefined,
      null,
      42,
      'x',
      [],
      {},
      { message: null },
      { message: { role: 'user' } },
      { message: { role: 'user', content: 'Hi.', __openclaw: { senderIsOwner: true } } },
      { sessionKey: 7, message: { role: 'user', content: 'Hi.', __openclaw: 'x' } },
      {
        target: { sessionKey: GUILD },
        message: { role: 'user', content: { text: 1 }, __openclaw: [] },
      },
      {
        sessionKey: GUILD,
        message: {
          role: 'user',
          content: [null, 5, { type: 'text', text: 7 }, 'Hi.'],
          timestamp: 'never',
          idempotencyKey: {},
          provenance: 'x',
          __openclaw: { senderIsOwner: 'true', senderName: { x: 1 }, senderIdentity: 5 },
        },
      },
    ];
    for (const update of odd) expect(listener!(update)).toBeUndefined();
    // One that throws inside is caught, and said once.
    const throwing = {
      get sessionKey() {
        throw new Error('boom');
      },
      message: { role: 'user', content: 'Hi.' },
    };
    expect(listener!(throwing)).toBeUndefined();
    expect(listener!(throwing)).toBeUndefined();
    expect(fake.logs.filter((l) => l.level === 'error')).toHaveLength(1);
    expect(rec.senders.size()).toBe(1);
  });
});

describe('the pairing key', () => {
  it('is the text, without whitespace, whatever the shape of the content', () => {
    const key = pairingKey('Is the canary\ngreen?');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(pairingKey([{ type: 'text', text: 'Is the canary green?' }])).toBe(key);
    expect(
      pairingKey([
        { type: 'text', text: ' Is the canary ' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'text', text: 'green? ' },
      ]),
    ).toBe(key);
    expect(pairingKey('Is the canary red?')).not.toBe(key);
    expect(pairingKey('')).toBeNull();
    expect(pairingKey([{ type: 'image', data: 'x' }])).toBeNull();
    expect(pairingKey(undefined)).toBeNull();
  });
});

describe('the memory of who wrote what', () => {
  const facts = (name: string): SenderFacts => ({
    kind: 'external_user',
    sourceAgent: null,
    sourceTool: null,
    sender: true,
    senderIsOwner: false,
    senderName: name,
    senderUsername: null,
    senderKind: null,
  });
  const note = (m: SenderMemory, session: string, key: string, name: string, ts: number) =>
    m.note(session, key, {
      facts: facts(name),
      sessionId: null,
      idempotencyKey: null,
      messageId: null,
      ts,
    });

  it('keeps at most SESSION_ENTRIES a session, dropping the oldest', () => {
    let now = T;
    const m = new SenderMemory(() => now);
    for (let i = 0; i < SESSION_ENTRIES + 5; i++) {
      now += 1;
      note(m, 's', `k${i % 3}`, `n${i}`, i);
    }
    expect(m.size()).toBe(SESSION_ENTRIES);
    // The five oldest went: n0..n4, of keys k0, k1, k2, k0, k1.
    expect(m.take('s', 'k0', null)?.senderName).toBe('n6');
    expect(m.take('s', 'k1', null)?.senderName).toBe('n7');
    expect(m.take('s', 'k2', null)?.senderName).toBe('n5');
  });

  it('keeps at most SESSIONS sessions, dropping the one noted least recently', () => {
    const m = new SenderMemory(() => T);
    for (let i = 0; i < SESSIONS; i++) note(m, `s${i}`, 'k', `n${i}`, i);
    expect(m.size()).toBe(SESSIONS);
    // s0 is noted again, so s1 is now the one noted least recently, and goes first.
    note(m, 's0', 'k', 'again', 999);
    note(m, 'one-more', 'k', 'last', 1000);
    note(m, 'two-more', 'k', 'later', 1001);
    expect(m.size()).toBe(SESSIONS + 1);
    expect(m.take('s1', 'k', null)).toBeNull();
    expect(m.take('s2', 'k', null)).toBeNull();
    expect(m.take('s3', 'k', null)?.senderName).toBe('n3');
    expect(m.take('s0', 'k', null)?.senderName).toBe('n0');
    expect(m.take('s0', 'k', null)?.senderName).toBe('again');
    expect(m.take('two-more', 'k', null)?.senderName).toBe('later');
  });

  it('drops what is older than MAX_AGE_MS', () => {
    let now = T;
    const m = new SenderMemory(() => now);
    note(m, 's', 'k', 'old', 1);
    now += MAX_AGE_MS / 2;
    note(m, 's', 'k', 'newer', 2);
    now += MAX_AGE_MS / 2 + 1;
    expect(m.take('s', 'k', null)?.senderName).toBe('newer');
    expect(m.size()).toBe(0);
  });

  it('takes the message with the idempotency key asked for, else the oldest', () => {
    const m = new SenderMemory(() => T);
    m.note('s', 'k', {
      facts: facts('a'),
      sessionId: null,
      idempotencyKey: 'run-1:user',
      messageId: null,
      ts: 1,
    });
    m.note('s', 'k', {
      facts: facts('b'),
      sessionId: null,
      idempotencyKey: 'run-2:user',
      messageId: null,
      ts: 2,
    });
    m.note('s', 'k', {
      facts: facts('c'),
      sessionId: null,
      idempotencyKey: 'run-3:user',
      messageId: null,
      ts: 3,
    });
    expect(m.take('s', 'k', 'run-2:user')?.senderName).toBe('b');
    expect(m.take('s', 'k', 'run-9:user')?.senderName).toBe('a');
    expect(m.take('s', 'k', null)?.senderName).toBe('c');
    expect(m.take('s', 'k', null)).toBeNull();
  });
});
