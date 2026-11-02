import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Batch, SendResult, Sink } from '../src/delivery.js';
import type { HookHandler, PluginApi } from '../src/types.js';

/** Synthetic data only: these sessions, agents, and messages are made up. */
export const T = Date.parse('2026-11-02T01:30:00Z');
export const SESSION = 'agent:xiaohan:telegram:direct:42';

/** The context `agent_end` gives (OpenClaw 2026.10.6), for the synthetic session. */
export const agentCtx = (over: Record<string, unknown> = {}) => ({
  agentId: 'xiaohan',
  sessionKey: SESSION,
  sessionId: 'sess-1',
  runId: 'run-1',
  channel: 'telegram',
  channelId: 'telegram',
  accountId: 'bot-a',
  trigger: 'user',
  workspaceDir: '/srv/openclaw/workspace-xiaohan',
  modelProviderId: 'anthropic',
  modelId: 'claude-test',
  ...over,
});

export const user = (text: string, at: number, extra: Record<string, unknown> = {}) => ({
  role: 'user',
  content: text,
  timestamp: at,
  ...extra,
});

export const assistant = (blocks: unknown[], at: number) => ({
  role: 'assistant',
  content: blocks,
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-test',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  stopReason: 'stop',
  timestamp: at,
});

export const toolResult = (callId: string, toolName: string, text: string, at: number) => ({
  role: 'toolResult',
  toolCallId: callId,
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: at,
});

/** A first turn: a question, a tool call and its result, and an answer. */
export function firstTurn(): unknown[] {
  return [
    user(
      '[Telegram Dana +1m Mon 2026-11-02 09:30 GMT+8] Dana: Is the deploy stuck again today?',
      T,
    ),
    assistant(
      [
        { type: 'thinking', thinking: 'Look at the pods first.' },
        { type: 'text', text: 'Let me look.' },
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'exec',
          arguments: { command: 'kubectl get pods' },
        },
      ],
      T + 1000,
    ),
    toolResult('call_1', 'exec', 'web-1 Running\nmigrate-1 Pending', T + 2000),
    assistant([{ type: 'text', text: 'It waits on a migration lock.' }], T + 3000),
  ];
}

/** A sink that keeps what it is sent. */
export class MemorySink implements Sink {
  readonly target = 'memory';
  readonly batches: Batch[] = [];
  async send(batch: Batch): Promise<SendResult> {
    this.batches.push(batch);
    return { outcome: 'ok', sent: batch.lines.length };
  }
  /** Every line sent, parsed. */
  lines(): Array<Record<string, unknown>> {
    return this.batches.flatMap((b) => b.lines.map((l) => JSON.parse(l)));
  }
}

export interface FakeApi {
  api: PluginApi;
  hooks: Map<string, HookHandler>;
  logs: Array<{ level: string; message: string }>;
}

/** An OpenClaw `api`, as `register` receives it, that records the hooks registered. */
export function fakeApi(
  opts: {
    pluginConfig?: unknown;
    config?: unknown;
    registrationMode?: string;
    stateDir?: string;
    conversationAccess?: boolean;
  } = {},
): FakeApi {
  const hooks = new Map<string, HookHandler>();
  const logs: FakeApi['logs'] = [];
  const log = (level: string) => (message: string) => logs.push({ level, message });
  const access = opts.conversationAccess ?? true;
  const api: PluginApi = {
    id: 'origin',
    registrationMode: opts.registrationMode ?? 'full',
    config: opts.config ?? {
      plugins: {
        entries: { origin: { enabled: true, hooks: { allowConversationAccess: access } } },
      },
    },
    pluginConfig: opts.pluginConfig,
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    runtime: {
      version: '2026.10.6',
      state: { resolveStateDir: () => opts.stateDir ?? path.join(os.tmpdir(), 'unused-openclaw') },
    },
    on: (name, handler) => {
      hooks.set(name, handler);
    },
  };
  return { api, hooks, logs };
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
