import type { Config } from './config.js';
import { type Batch, Deliverer, type Sink, Spool } from './delivery.js';
import { linesPath } from './files.js';
import {
  agentOfSessionKey,
  asRecord,
  type Draft,
  draftFromInbound,
  draftFromOutbound,
  draftsFromMessages,
  draftsFromToolCall,
  type EventLine,
  type SessionInfo,
  str,
  titleOf,
} from './lines.js';
import type { Log } from './log.js';
import { SessionStore } from './state.js';

/**
 * How the plugin learns of a turn. `agent_end`, when the Gateway grants it conversation access,
 * gives the session's history at the end of every run, the most complete view. Without that grant,
 * the turn is assembled from the hooks every plugin may use: the message that arrived
 * (`message_received`), the tool calls (`after_tool_call`), and the reply as it is sent
 * (`message_sent`), which sends the turn so far.
 */
export type TurnSource = 'agent_end' | 'messages';

export interface RecorderOptions {
  config: Config;
  sink: Sink;
  log: Log;
  turns: TurnSource;
  /** The names of the Gateway's agents by id, lowercase, which name the agent behind a routed input. */
  agentNames?: ReadonlyMap<string, string>;
  now?: () => number;
}

/** A run of another trigger is left out with the messages it added since it started, give or take. */
const RUN_SLACK_MS = 2000;
/** Lines of a session buffered from the message hooks, and sessions with a buffer, at most. */
const BUFFER_LINES = 500;
const BUFFER_SESSIONS = 200;
/** What `session_end` reads of an ended transcript, and how long it waits for it. */
const TAIL_MESSAGES = 200;
const TAIL_BYTES = 2 * 1024 * 1024;
const TAIL_WAIT_MS = 1500;
/** How long the Gateway's stop waits for deliveries in flight, at most. */
const STOP_WAIT_MS = 4000;

/** The kind of run a session key suggests, when the hook does not say (`ctx.trigger`). */
export function triggerOfSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(':');
  if (parts.includes('cron')) return 'cron';
  if (parts[parts.length - 1] === 'heartbeat') return 'heartbeat';
  return 'user';
}

/** Session keys of incognito threads hold a part that starts with `incognito`; they are never recorded. */
const isIncognito = (sessionKey: string) =>
  sessionKey.split(':').some((p) => p.toLowerCase().startsWith('incognito'));

export class Recorder {
  readonly config: Config;
  readonly turns: TurnSource;
  private readonly log: Log;
  private readonly agentNames: ReadonlyMap<string, string>;
  private readonly now: () => number;
  private readonly sessions: SessionStore;
  private readonly deliverer: Deliverer;
  private readonly buffers = new Map<string, { info: SessionInfo; drafts: Draft[] }>();

  constructor(opts: RecorderOptions) {
    this.config = opts.config;
    this.turns = opts.turns;
    this.log = opts.log;
    this.agentNames = opts.agentNames ?? new Map();
    this.now = opts.now ?? Date.now;
    this.sessions = new SessionStore(opts.config.stateDir, opts.log);
    this.deliverer = new Deliverer(opts.sink, new Spool(opts.config.stateDir), opts.log);
  }

  /** The session a hook is about, or null if it is not one to record. */
  private session(ctx: unknown, event?: unknown): (SessionInfo & { trigger: string }) | null {
    const c = asRecord(ctx) ?? {};
    const e = asRecord(event) ?? {};
    const sessionKey = str(c.sessionKey) ?? str(e.sessionKey);
    if (!sessionKey || isIncognito(sessionKey)) return null;
    const agentId = str(c.agentId) ?? agentOfSessionKey(sessionKey) ?? 'unknown';
    if (this.config.agents && !this.config.agents.includes(agentId)) return null;
    const channel = str(c.channel) ?? str(c.messageProvider) ?? str(c.channelId);
    const project =
      this.config.project ?? (this.config.projectBy === 'channel' ? (channel ?? agentId) : agentId);
    const meta: Record<string, string> = { agentId };
    const add = (k: string, v: string | null) => {
      if (v) meta[k] = v;
    };
    add('channel', channel);
    add('accountId', str(c.accountId));
    meta.sessionKey = sessionKey;
    add('runId', str(c.runId) ?? str(e.runId));
    add('sessionId', str(c.sessionId) ?? str(e.sessionId));
    return {
      sessionKey,
      agentId,
      project,
      meta,
      trigger: str(c.trigger) ?? triggerOfSessionKey(sessionKey),
    };
  }

  private recorded(trigger: string): boolean {
    return this.config.triggers.includes(trigger);
  }

  /** `agent_end`: send what is new in the session's history. */
  agentEnd(event: unknown, ctx: unknown): void {
    const info = this.session(ctx, event);
    if (!info) return;
    const e = asRecord(event) ?? {};
    const buffered = this.buffers.get(info.sessionKey);
    this.buffers.delete(info.sessionKey);
    if (!this.recorded(info.trigger)) {
      // Leave out this run's messages for good, so that the next turn does not send them either.
      if (Array.isArray(e.messages)) {
        const since =
          typeof e.durationMs === 'number' ? this.now() - e.durationMs - RUN_SLACK_MS : -Infinity;
        this.skip(
          info,
          this.build(e.messages, info).filter((d) => d.ms >= since),
        );
      }
      return;
    }
    if (!Array.isArray(e.messages)) {
      // A host whose agent_end carries no messages: the turn is what the other hooks saw.
      if (buffered) this.send(buffered.info, buffered.drafts);
      return;
    }
    // An empty list is taken at its word: OpenClaw gives one for incognito sessions.
    this.send(info, this.build(e.messages, info));
  }

  /** `before_compaction`: send what is new among the messages about to be compacted away. */
  beforeCompaction(event: unknown, ctx: unknown): void {
    const info = this.session(ctx, event);
    if (!info || !this.recorded(info.trigger)) return;
    const messages = asRecord(event)?.messages;
    if (Array.isArray(messages)) this.send(info, this.build(messages, info));
  }

  messageReceived(event: unknown, ctx: unknown): void {
    const info = this.session(ctx, event);
    if (!info || !this.recorded(info.trigger)) return;
    this.buffer(info, [draftFromInbound(event, ctx, info, this.now())]);
  }

  afterToolCall(event: unknown, ctx: unknown): void {
    if (!this.config.includeTools) return;
    const info = this.session(ctx, event);
    if (!info || !this.recorded(info.trigger)) return;
    this.buffer(info, draftsFromToolCall(event, ctx, info, this.now()));
  }

  /** `message_sent`: the reply went out; without agent_end, that ends the turn so far. */
  messageSent(event: unknown, ctx: unknown): void {
    const info = this.session(ctx, event);
    if (!info || !this.recorded(info.trigger)) return;
    this.buffer(info, [draftFromOutbound(event, info, this.now())]);
    if (this.turns === 'messages') this.flush(info.sessionKey);
  }

  /**
   * `session_end`: send what is still buffered, and, with reconcileOnEnd and conversation access,
   * whatever the ended transcript's tail holds that was never sent.
   */
  async sessionEnd(event: unknown, ctx: unknown): Promise<void> {
    const info = this.session(ctx, event);
    if (!info) return;
    if (this.turns === 'messages') this.flush(info.sessionKey);
    else this.buffers.delete(info.sessionKey);
    const transcript = asRecord(asRecord(ctx)?.endedTranscript);
    if (
      this.config.reconcileOnEnd &&
      this.turns === 'agent_end' &&
      transcript?.available === true &&
      typeof transcript.readTail === 'function'
    ) {
      const read = (transcript.readTail as (o: object) => Promise<unknown>)({
        maxMessages: TAIL_MESSAGES,
        maxBytes: TAIL_BYTES,
      });
      const tail = asRecord(await withTimeout(read, TAIL_WAIT_MS));
      if (Array.isArray(tail?.messages)) this.send(info, this.build(tail.messages, info));
    }
    this.sessions.forget(info.sessionKey);
  }

  /** `gateway_start`: send what the spool holds. */
  gatewayStart(): void {
    void this.deliverer.retry();
  }

  /** `gateway_stop`: send what is buffered, and wait a little for deliveries in flight. */
  async gatewayStop(): Promise<void> {
    if (this.turns === 'messages') for (const key of [...this.buffers.keys()]) this.flush(key);
    await withTimeout(this.deliverer.idle(), Math.min(this.config.timeoutMs, STOP_WAIT_MS));
  }

  /** Resolves when everything handed over so far has been delivered or spooled. */
  idle(): Promise<void> {
    return this.deliverer.idle();
  }

  private build(messages: readonly unknown[], info: SessionInfo): Draft[] {
    return draftsFromMessages(messages, info, {
      includeTools: this.config.includeTools,
      now: this.now(),
      agentNames: this.agentNames,
    });
  }

  private buffer(info: SessionInfo, drafts: Array<Draft | null>): void {
    const add = drafts.filter((d): d is Draft => d !== null);
    if (add.length === 0) return;
    let b = this.buffers.get(info.sessionKey);
    if (!b) {
      b = { info, drafts: [] };
      this.buffers.set(info.sessionKey, b);
      while (this.buffers.size > BUFFER_SESSIONS) {
        this.buffers.delete(this.buffers.keys().next().value as string);
      }
    }
    b.info = info;
    b.drafts.push(...add);
    if (b.drafts.length > BUFFER_LINES) b.drafts.splice(0, b.drafts.length - BUFFER_LINES);
  }

  private flush(sessionKey: string): void {
    const b = this.buffers.get(sessionKey);
    this.buffers.delete(sessionKey);
    if (b && b.drafts.length > 0) this.send(b.info, b.drafts);
  }

  /** Record that `drafts` are left out, without sending them. */
  private skip(info: SessionInfo, drafts: readonly Draft[]): void {
    const record = this.sessions.get(info.agentId, info.sessionKey);
    const ids = drafts.map((d) => d.line.id).filter((id) => !record.ids.has(id));
    for (const id of ids) record.ids.add(id);
    this.sessions.persist(info.agentId, info.sessionKey, ids, false);
  }

  /**
   * Send the lines of `drafts` not handed over before, as one turn: each line's parent is the line
   * before it, and the session's first user message carries its title, once.
   */
  private send(info: SessionInfo, drafts: readonly Draft[]): void {
    const record = this.sessions.get(info.agentId, info.sessionKey);
    const seen = new Set<string>();
    const fresh = drafts.filter((d) => {
      if (record.ids.has(d.line.id) || seen.has(d.line.id)) return false;
      seen.add(d.line.id);
      return true;
    });
    if (fresh.length === 0) return;
    let titled = false;
    let parent: string | undefined;
    const placed = fresh.map((d) => {
      const { id, session, time, role, author, speaker, kind, text, project, meta } = d.line;
      const line: EventLine = {
        id,
        session,
        time,
        role,
        ...(author ? { author } : {}),
        ...(speaker ? { speaker } : {}),
        kind,
        text,
        project,
      };
      if (parent) line.parent = parent;
      if (!record.titled && !titled && role === 'user' && kind === 'message') {
        const title = titleOf(text);
        if (title) {
          line.title = title;
          line.title_by = 'agent';
          titled = true;
        }
      }
      if (meta) line.meta = meta;
      parent = id;
      return { line, ms: d.ms };
    });
    const ids = placed.map((p) => p.line.id);
    for (const id of ids) record.ids.add(id);
    if (titled) record.titled = true;
    void this.deliverer.deliver(batches(info, placed)).then((handed) => {
      if (handed) {
        this.sessions.persist(info.agentId, info.sessionKey, ids, titled);
        return;
      }
      // Not even spooled: let a later turn hand these lines over again.
      for (const id of ids) record.ids.delete(id);
      if (titled) record.titled = false;
    });
  }
}

/** The lines of a turn by file, each file's lines in order, files in the order they first appear. */
function batches(
  info: SessionInfo,
  placed: ReadonlyArray<{ line: EventLine; ms: number }>,
): Batch[] {
  const byPath = new Map<string, string[]>();
  for (const { line, ms } of placed) {
    const p = linesPath(info.agentId, info.sessionKey, ms);
    let lines = byPath.get(p);
    if (!lines) {
      lines = [];
      byPath.set(p, lines);
    }
    lines.push(JSON.stringify(line));
  }
  return [...byPath].map(([path, lines]) => ({ path, lines }));
}

/** `p`'s value, or null if it takes longer than `ms` or fails. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
