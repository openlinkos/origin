import fs from 'node:fs';
import { parseEventLine } from '@openlinkos/origin-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, parseConfig } from '../src/config.js';
import { agentDir, isSafeLinesPath, linesPath, sessionFileBase } from '../src/files.js';
import { draftsFromMessages, lineId, redact, titleOf } from '../src/lines.js';
import { pluginLog } from '../src/log.js';
import { Recorder, type TurnSource, triggerOfSessionKey } from '../src/recorder.js';
import {
  agentCtx,
  assistant,
  firstTurn,
  MemorySink,
  SESSION,
  T,
  tmpDir,
  toolResult,
  user,
} from './fake.js';

let state: string;
beforeEach(() => {
  state = tmpDir('origin-openclaw-lines-');
});
afterEach(() => {
  fs.rmSync(state, { recursive: true, force: true });
});

function config(over: Record<string, unknown> = {}): Config {
  const r = parseConfig(
    { dir: state, spoolDir: state, ...over },
    { env: {}, defaultStateDir: state },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

function recorder(over: Record<string, unknown> = {}, turns: TurnSource = 'agent_end') {
  const sink = new MemorySink();
  const rec = new Recorder({
    config: config(over),
    sink,
    log: pluginLog(undefined),
    turns,
    now: () => T + 60_000,
  });
  return { rec, sink };
}

/** Every line parses as an event line, and gives the event Origin will store. */
function parsed(lines: Array<Record<string, unknown>>) {
  return lines.map((l) => {
    const p = parseEventLine(JSON.stringify(l));
    expect(p.events).toHaveLength(1);
    return { ...p, event: p.events[0]! };
  });
}

describe('lines from agent_end', () => {
  it('turns a turn into valid event lines: messages, tool calls, and results', async () => {
    const { rec, sink } = recorder();
    rec.agentEnd({ messages: firstTurn(), success: true, durationMs: 4000 }, agentCtx());
    await rec.idle();
    const lines = sink.lines();
    expect(lines.map((l) => [l.role, l.kind, l.text])).toEqual([
      [
        'user',
        'message',
        '[Telegram Dana +1m Mon 2026-11-02 09:30 GMT+8] Dana: Is the deploy stuck again today?',
      ],
      ['assistant', 'message', 'Let me look.'],
      ['assistant', 'tool_use', 'exec {"command":"kubectl get pods"}'],
      ['user', 'tool_result', 'web-1 Running\nmigrate-1 Pending'],
      ['assistant', 'message', 'It waits on a migration lock.'],
    ]);
    const events = parsed(lines);
    expect(events.map((p) => p.event.sessionId)).toEqual(Array(5).fill(SESSION));
    expect(events[0]!.event.ts).toBe(T);
    expect(events[2]!.event.meta).toMatchObject({ toolName: 'exec', callId: 'call_1' });
    expect(events[3]!.event.meta).toMatchObject({ toolName: 'exec', callId: 'call_1' });
    expect(events[1]!.event.meta).toMatchObject({ model: 'anthropic/claude-test' });
    // Thinking stays in OpenClaw.
    expect(JSON.stringify(lines)).not.toContain('Look at the pods first');
  });

  it('carries the session context in meta and chains each line to the one before', async () => {
    const { rec, sink } = recorder();
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    const lines = sink.lines();
    expect(lines[0]!.meta).toEqual({
      agentId: 'xiaohan',
      channel: 'telegram',
      accountId: 'bot-a',
      sessionKey: SESSION,
      runId: 'run-1',
      sessionId: 'sess-1',
    });
    expect(lines[0]!.parent).toBeUndefined();
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.parent).toBe(lines[i - 1]!.id);
    expect(lines.every((l) => /^oc-[0-9a-f]{24}$/.test(String(l.id)))).toBe(true);
  });

  it('titles the session once, from its first user message, without the channel envelope', async () => {
    const { rec, sink } = recorder();
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    const [first, ...rest] = sink.lines();
    expect(first).toMatchObject({
      title: 'Dana: Is the deploy stuck again today?',
      title_by: 'agent',
    });
    expect(rest.some((l) => 'title' in l)).toBe(false);
    expect(parseEventLine(JSON.stringify(first)).sessionTitle).toBe(
      'Dana: Is the deploy stuck again today?',
    );

    const next = [...firstTurn(), user('And the other cluster?', T + 10_000)];
    rec.agentEnd({ messages: next, success: true }, agentCtx({ runId: 'run-2' }));
    await rec.idle();
    const sent = sink.lines().slice(5);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('title');
  });

  it('cuts a long title short', () => {
    expect(titleOf(`${'word '.repeat(40)}`)).toHaveLength(80);
    expect(titleOf('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(titleOf('  short  ')).toBe('short');
  });

  it('sends only what is new each turn, and nothing again after a restart', async () => {
    const { rec, sink } = recorder();
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    const history = [
      ...firstTurn(),
      user('Release the lock, then retry.', T + 20_000),
      assistant([{ type: 'text', text: 'Done; the deploy is running.' }], T + 21_000),
    ];
    rec.agentEnd({ messages: history, success: true }, agentCtx({ runId: 'run-2' }));
    await rec.idle();
    expect(sink.lines().map((l) => l.text)).toHaveLength(7);
    expect(sink.batches).toHaveLength(2);
    expect(sink.lines()[5]!.parent).toBeUndefined();

    // A new process, with the same state directory: the history is not sent again, nor its title.
    const again = recorder();
    again.rec.agentEnd(
      { messages: [...history, user('Thanks.', T + 30_000)], success: true },
      agentCtx({ runId: 'run-3' }),
    );
    await again.rec.idle();
    expect(again.sink.lines().map((l) => l.text)).toEqual(['Thanks.']);
    expect(again.sink.lines()[0]).not.toHaveProperty('title');
  });

  it('gives a message the same id however often it is built', () => {
    const info = { sessionKey: SESSION, agentId: 'xiaohan', project: 'xiaohan', meta: {} };
    const a = draftsFromMessages(firstTurn(), info, { includeTools: true, now: 1 });
    const b = draftsFromMessages(
      firstTurn(),
      { ...info, meta: { runId: 'other' } },
      {
        includeTools: true,
        now: 2,
      },
    );
    expect(b.map((d) => d.line.id)).toEqual(a.map((d) => d.line.id));
    expect(new Set(a.map((d) => d.line.id)).size).toBe(a.length);
    // The same message in another session is another event.
    const c = draftsFromMessages(
      firstTurn(),
      { ...info, sessionKey: 'agent:xiaohan:main' },
      {
        includeTools: true,
        now: 1,
      },
    );
    expect(c.map((d) => d.line.id).some((id) => a.some((d) => d.line.id === id))).toBe(false);
    expect(lineId(['a', 1])).toBe(lineId(['a', '1']));
  });

  it('reads transcript entries, string timestamps, and summaries', () => {
    const info = { sessionKey: SESSION, agentId: 'xiaohan', project: 'xiaohan', meta: {} };
    const drafts = draftsFromMessages(
      [
        { type: 'message', id: 'e1', message: user('From the transcript.', T) },
        {
          role: 'compactionSummary',
          summary: 'Earlier: the deploy was stuck.',
          tokensBefore: 9,
          timestamp: '2026-11-02T01:00:00Z',
        },
        { role: 'custom', customType: 'x', content: 'not a conversation message', timestamp: T },
        null,
        42,
      ],
      info,
      { includeTools: true, now: T },
    );
    expect(drafts.map((d) => [d.line.role, d.line.kind, d.line.text])).toEqual([
      ['user', 'message', 'From the transcript.'],
      ['system', 'meta', 'Earlier: the deploy was stuck.'],
    ]);
    expect(drafts[1]!.ms).toBe(Date.parse('2026-11-02T01:00:00Z'));
    for (const d of drafts) parsed([d.line as unknown as Record<string, unknown>]);
  });

  it('marks the runtime context OpenClaw adds as meta', async () => {
    const { rec, sink } = recorder();
    const messages = [
      user(
        '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context:\nnow 09:30\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
        T - 1,
        {
          runtimeContext: { retained: true },
        },
      ),
      ...firstTurn(),
    ];
    rec.agentEnd({ messages, success: true }, agentCtx());
    await rec.idle();
    const [ctxLine, first] = sink.lines();
    expect(ctxLine).toMatchObject({ role: 'user', kind: 'meta' });
    expect(ctxLine).not.toHaveProperty('title');
    expect(first).toHaveProperty('title');
  });

  it('leaves out tool calls with includeTools false', async () => {
    const { rec, sink } = recorder({ includeTools: false });
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(sink.lines().map((l) => l.kind)).toEqual(['message', 'message', 'message']);
  });
});

describe('secrets', () => {
  it('redacts Origin tokens and 1Password references everywhere', () => {
    expect(redact('token ogn_Ab3_x-9 and op://OpenClaw/hub token/credential.')).toBe(
      'token [redacted] and [redacted] token/credential.',
    );
    expect(redact('"op://Vault/Item/field"')).toBe('"[redacted]"');
  });

  it('never sends the 1Password tool results, and redacts what refers to them', async () => {
    const { rec, sink } = recorder();
    const messages = [
      user(
        'My hub token is ogn_0123456789abcdef_XY; put it in op://OpenClaw/origin-hub/credential',
        T,
      ),
      assistant(
        [
          {
            type: 'toolCall',
            id: 'call_9',
            name: 'onepassword',
            arguments: { action: 'get', ref: 'op://OpenClaw/origin-hub/credential' },
          },
        ],
        T + 1000,
      ),
      toolResult('call_9', 'onepassword', 'ogn_secretvalue and s3cr3t-pa55word', T + 2000),
      assistant([{ type: 'text', text: 'Stored: ogn_0123456789abcdef_XY' }], T + 3000),
    ];
    rec.agentEnd({ messages, success: true }, agentCtx());
    await rec.idle();
    const all = JSON.stringify(sink.lines());
    expect(all).not.toContain('s3cr3t-pa55word');
    expect(all).not.toMatch(/ogn_[A-Za-z0-9]/);
    expect(all).not.toContain('op://');
    expect(sink.lines().map((l) => l.kind)).toEqual(['message', 'tool_use', 'message']);
    expect(sink.lines()[0]!.title).toBe('My hub token is [redacted]; put it in [redacted]');
  });
});

describe('projects', () => {
  it('names the project after the agent by default, the channel, or one name', async () => {
    const byAgent = recorder();
    byAgent.rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    const byChannel = recorder({ projectBy: 'channel', spoolDir: tmpDir('origin-openclaw-c-') });
    byChannel.rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    const fixed = recorder({ project: 'ops', spoolDir: tmpDir('origin-openclaw-f-') });
    fixed.rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    await Promise.all([byAgent.rec.idle(), byChannel.rec.idle(), fixed.rec.idle()]);
    expect(new Set(byAgent.sink.lines().map((l) => l.project))).toEqual(new Set(['xiaohan']));
    expect(new Set(byChannel.sink.lines().map((l) => l.project))).toEqual(new Set(['telegram']));
    expect(new Set(fixed.sink.lines().map((l) => l.project))).toEqual(new Set(['ops']));
    expect(parsed(byChannel.sink.lines())[0]!.event.project).toBe('telegram');
  });

  it('falls back to the agent when a run has no channel, and to the session key for the agent', async () => {
    const { rec, sink } = recorder({ projectBy: 'channel' });
    rec.agentEnd(
      { messages: firstTurn(), success: true },
      { sessionKey: 'agent:xiaowen:main', trigger: 'user' },
    );
    await rec.idle();
    expect(sink.lines()[0]).toMatchObject({ project: 'xiaowen', meta: { agentId: 'xiaowen' } });
  });
});

describe('what is recorded', () => {
  it('records only the agents listed', async () => {
    const { rec, sink } = recorder({ agents: ['main'] });
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    rec.agentEnd(
      { messages: firstTurn(), success: true },
      agentCtx({ agentId: 'main', sessionKey: 'agent:main:main' }),
    );
    await rec.idle();
    expect(new Set(sink.lines().map((l) => l.session))).toEqual(new Set(['agent:main:main']));
  });

  it('leaves out the runs of other triggers, with their messages, for good', async () => {
    const { rec, sink } = recorder();
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    // A heartbeat in the same session adds a prompt and an answer.
    const now = T + 60_000;
    const heartbeat = [
      ...firstTurn(),
      user('Read HEARTBEAT.md if it exists.', now - 3000),
      assistant([{ type: 'text', text: 'HEARTBEAT_OK' }], now - 1000),
    ];
    rec.agentEnd(
      { messages: heartbeat, success: true, durationMs: 3000 },
      agentCtx({ trigger: 'heartbeat' }),
    );
    rec.agentEnd(
      { messages: [...heartbeat, user('Back to the deploy.', now)], success: true },
      agentCtx(),
    );
    await rec.idle();
    expect(sink.lines().map((l) => l.text)).not.toContain('HEARTBEAT_OK');
    expect(sink.lines().at(-1)!.text).toBe('Back to the deploy.');
    expect(sink.lines()).toHaveLength(6);
  });

  it('records cron runs when triggers lists them', async () => {
    const { rec, sink } = recorder({ triggers: ['user', 'cron'] });
    rec.agentEnd(
      { messages: firstTurn(), success: true },
      agentCtx({ trigger: 'cron', sessionKey: 'agent:xiaohan:cron:daily' }),
    );
    await rec.idle();
    expect(sink.lines()).toHaveLength(5);
  });

  it('never records incognito threads, empty runs, or runs without a session', async () => {
    const { rec, sink } = recorder();
    rec.agentEnd(
      { messages: firstTurn(), success: true },
      agentCtx({ sessionKey: 'agent:xiaohan:dashboard:incognito-7f3a' }),
    );
    rec.agentEnd({ messages: [], success: true }, agentCtx());
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx({ sessionKey: undefined }));
    await rec.idle();
    expect(sink.lines()).toEqual([]);
  });

  it('guesses the trigger from the session key when the hook does not say', () => {
    expect(triggerOfSessionKey('agent:main:cron:nightly')).toBe('cron');
    expect(triggerOfSessionKey('agent:main:main:heartbeat')).toBe('heartbeat');
    expect(triggerOfSessionKey('agent:main:telegram:direct:42')).toBe('user');
  });

  it('sends what is about to be compacted away', async () => {
    const { rec, sink } = recorder();
    rec.beforeCompaction({ messageCount: 4, messages: firstTurn() }, agentCtx());
    rec.agentEnd({ messages: [user('After compaction.', T + 50_000)], success: true }, agentCtx());
    await rec.idle();
    expect(sink.lines().map((l) => l.text)).toHaveLength(6);
  });
});

describe('lines from the message hooks', () => {
  it('assembles a turn from message_received, after_tool_call, and message_sent', async () => {
    const { rec, sink } = recorder({}, 'messages');
    const msgCtx = {
      channelId: 'telegram',
      accountId: 'bot-a',
      conversationId: '42',
      sessionKey: SESSION,
    };
    rec.messageReceived(
      {
        from: 'dana',
        content: 'Is the deploy stuck?',
        timestamp: T,
        messageId: '1001',
        sessionKey: SESSION,
      },
      msgCtx,
    );
    rec.afterToolCall(
      {
        toolName: 'exec',
        params: { command: 'kubectl get pods' },
        toolCallId: 'call_1',
        result: { content: [{ type: 'text', text: 'migrate-1 Pending' }] },
        durationMs: 800,
      },
      { agentId: 'xiaohan', sessionKey: SESSION, toolName: 'exec', toolCallId: 'call_1' },
    );
    rec.afterToolCall(
      {
        toolName: 'onepassword',
        params: { ref: 'op://OpenClaw/x/credential' },
        toolCallId: 'call_2',
        result: 'hunter2-secret',
      },
      { agentId: 'xiaohan', sessionKey: SESSION, toolName: 'onepassword' },
    );
    expect(sink.batches).toHaveLength(0);
    rec.messageSent(
      {
        to: '42',
        content: 'It waits on a migration lock.',
        success: true,
        messageId: '1002',
        sessionKey: SESSION,
      },
      msgCtx,
    );
    rec.messageSent(
      { to: '42', content: 'never delivered', success: false, sessionKey: SESSION },
      msgCtx,
    );
    await rec.idle();
    const lines = sink.lines();
    expect(lines.map((l) => [l.role, l.kind])).toEqual([
      ['user', 'message'],
      ['assistant', 'tool_use'],
      ['user', 'tool_result'],
      ['assistant', 'tool_use'],
      ['assistant', 'message'],
    ]);
    expect(JSON.stringify(lines)).not.toContain('hunter2-secret');
    expect(JSON.stringify(lines)).not.toContain('op://');
    expect(lines[0]).toMatchObject({
      title: 'Is the deploy stuck?',
      project: 'xiaohan',
      meta: { messageId: '1001', channel: 'telegram' },
    });
    const events = parsed(lines);
    expect(events[0]!.event.ts).toBe(T);
    expect(events[0]!.event.id).toBe(lineId([SESSION, 'in', '1001']));
  });

  it('flushes the buffered turn when agent_end carries no messages', async () => {
    const { rec, sink } = recorder();
    rec.messageReceived(
      { content: 'Hello?', timestamp: T, sessionKey: SESSION },
      { channelId: 'telegram', sessionKey: SESSION },
    );
    rec.messageSent(
      { to: '42', content: 'Hi.', success: true, sessionKey: SESSION },
      { channelId: 'telegram', sessionKey: SESSION },
    );
    expect(sink.batches).toHaveLength(0);
    rec.agentEnd({ success: true }, agentCtx());
    await rec.idle();
    expect(sink.lines().map((l) => l.text)).toEqual(['Hello?', 'Hi.']);
  });

  it('drops the buffered turn when agent_end has the messages', async () => {
    const { rec, sink } = recorder();
    rec.messageReceived(
      { content: 'Is the deploy stuck again today?', sessionKey: SESSION },
      { sessionKey: SESSION },
    );
    rec.agentEnd({ messages: firstTurn(), success: true }, agentCtx());
    await rec.idle();
    expect(sink.lines()).toHaveLength(5);
  });

  it('sends what is buffered when the session ends', async () => {
    const { rec, sink } = recorder({}, 'messages');
    rec.messageReceived(
      { content: 'One last thing.', sessionKey: SESSION },
      { sessionKey: SESSION },
    );
    await rec.sessionEnd(
      { sessionId: 'sess-1', sessionKey: SESSION, messageCount: 1, reason: 'idle' },
      { sessionId: 'sess-1', sessionKey: SESSION, agentId: 'xiaohan' },
    );
    await rec.idle();
    expect(sink.lines().map((l) => l.text)).toEqual(['One last thing.']);
  });
});

describe('reconciliation on session_end', () => {
  it('sends what the ended transcript holds and was never sent', async () => {
    const { rec, sink } = recorder({ reconcileOnEnd: true });
    rec.agentEnd({ messages: firstTurn().slice(0, 2), success: true }, agentCtx());
    let asked: unknown;
    const readTail = async (opts: unknown) => {
      asked = opts;
      return { messages: firstTurn(), totalMessages: 4, truncated: false };
    };
    await rec.sessionEnd(
      { sessionId: 'sess-1', sessionKey: SESSION, messageCount: 4, reason: 'reset' },
      {
        agentId: 'xiaohan',
        sessionId: 'sess-1',
        sessionKey: SESSION,
        endedTranscript: { available: true, readTail },
      },
    );
    await rec.idle();
    expect(asked).toEqual({ maxMessages: 200, maxBytes: 2 * 1024 * 1024 });
    expect(sink.lines()).toHaveLength(5);
    expect(sink.batches).toHaveLength(2);
  });

  it('is off by default', async () => {
    const { rec, sink } = recorder();
    const readTail = async () => ({ messages: firstTurn(), totalMessages: 4, truncated: false });
    await rec.sessionEnd(
      { sessionId: 'sess-1', sessionKey: SESSION, messageCount: 4 },
      { agentId: 'xiaohan', sessionKey: SESSION, endedTranscript: { available: true, readTail } },
    );
    await rec.idle();
    expect(sink.lines()).toEqual([]);
  });
});

describe('file names', () => {
  // The hub's rule for `path` (packages/cli/src/hub/server.ts, linesPath), restated.
  const HUB_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
  const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
  const hubTakes = (p: string) =>
    p.length <= 200 &&
    p.endsWith('.jsonl') &&
    p.split('/').every((s) => HUB_SEGMENT.test(s) && !DEVICE.test(s));

  it('puts a line in its agent, month, and session file', () => {
    const p = linesPath('xiaohan', SESSION, T);
    expect(p).toMatch(/^xiaohan\/2026\/11\/agent-xiaohan-telegram-direct-42-[0-9a-f]{10}\.jsonl$/);
    expect(linesPath('xiaohan', SESSION, Date.parse('2026-12-01T00:00:00Z'))).toMatch(
      /^xiaohan\/2026\/12\//,
    );
    expect(sessionFileBase(SESSION)).toBe(sessionFileBase(SESSION));
  });

  it('makes every session key and agent id a path the hub takes, and keeps keys apart', () => {
    const keys = [
      SESSION,
      'agent:main:main',
      'agent:Main:main',
      'agent:main:dashboard:7f3a/../../etc',
      'agent:主:飞书:群:123',
      'con',
      'CON.txt',
      'aux.agent',
      '...',
      '',
      `agent:main:${'x'.repeat(500)}`,
      'agent:main:a b\tc\nd',
    ];
    const agents = ['xiaohan', 'main', 'CON', 'nul.x', '..', '', '主', 'a'.repeat(300), 'agent.'];
    const names = new Set<string>();
    for (const key of keys) {
      names.add(sessionFileBase(key));
      for (const agent of agents) {
        const p = linesPath(agent, key, T);
        expect(isSafeLinesPath(p), p).toBe(true);
        expect(hubTakes(p), p).toBe(true);
      }
    }
    expect(names.size).toBe(keys.length);
    expect(agentDir('CON')).toBe('agent-CON');
  });
});
