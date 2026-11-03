import { createHash } from 'node:crypto';

/**
 * Event lines (docs/sources.md#your-own-sources-event-lines) built from what OpenClaw's hooks see.
 * Building is pure: the same message gives the same line, and the same id, every time it is seen,
 * so that a turn sent again, or a message seen again in the next turn's history, adds nothing.
 */

export type Role = 'user' | 'assistant' | 'system';
export type Kind = 'message' | 'tool_use' | 'tool_result' | 'meta' | 'system';
/**
 * Who wrote a user line, as OpenClaw knows it: its owner, another person, another agent or session,
 * or OpenClaw itself. Recorded as a fact, never guessed.
 */
export type Author = 'owner' | 'person' | 'agent' | 'system';

/** One event line, its fields in the order they are written. */
export interface EventLine {
  id: string;
  session: string;
  time: string;
  role: Role;
  author?: Author;
  /** The name of whoever wrote it, as the channel or OpenClaw's config gives it; never an id. */
  speaker?: string;
  kind: Kind;
  text: string;
  project?: string;
  parent?: string;
  title?: string;
  title_by?: 'agent';
  meta?: Record<string, unknown>;
}

/** What every line of a session carries, from the hook's context. */
export interface SessionInfo {
  sessionKey: string;
  agentId: string;
  project: string;
  /** agentId, channel, accountId, sessionKey, runId, sessionId: those the hook gives. */
  meta: Record<string, string>;
}

/**
 * How a user line pairs with the copy of its message that OpenClaw persisted, which says who wrote
 * it when the copy a run's `agent_end` gives does not (see SenderFacts).
 */
export interface Pairing {
  /** A hash of the message's text (pairingKey). */
  key: string;
  /** The message's idempotency key, when it carries one, as the persisted copy does. */
  idempotencyKey: string | null;
  /** Whether the message itself says who wrote it. */
  known: boolean;
}

/** A line before it is placed in its turn (parent, title), with its time in epoch ms. */
export interface Draft {
  line: EventLine;
  ms: number;
  /** A user message's line: how it pairs with the persisted copy of its message. */
  pair?: Pairing;
}

/** Longest tool call and tool result text, as Origin's adapters keep them. */
export const TOOL_USE_MAX = 2000;
export const TOOL_RESULT_MAX = 4000;
/** Longest title, in characters. */
export const TITLE_MAX = 80;
/** Longest speaker, in characters, as event lines take it. */
export const SPEAKER_MAX = 200;
/** OpenClaw's marker of the runtime context it adds to a turn, which no one said. */
const RUNTIME_CONTEXT_MARKER = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>';

/** A line id: `oc-` and 24 hex digits of a hash of what identifies the event in its session. */
export function lineId(parts: ReadonlyArray<string | number>): string {
  const h = createHash('sha256').update(parts.map(String).join('\u001f'), 'utf8').digest('hex');
  return `oc-${h.slice(0, 24)}`;
}

/** A session's title from its first user message: its first words, without a channel envelope. */
export function titleOf(text: string): string {
  // OpenClaw prefixes a channel message with an envelope, `[Telegram Ann +2m Mon 2026-11-02 …] `.
  const body = text.replace(/^\[[^\]\n]{0,300}\]\s+/, '');
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > TITLE_MAX
    ? `${chars
        .slice(0, TITLE_MAX - 1)
        .join('')
        .trimEnd()}…`
    : flat;
}

const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;

export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A non-empty string, trimmed, or null. */
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

/** The agent of a session key, `agent:<agentId>:…`. */
export function agentOfSessionKey(sessionKey: string): string | null {
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m ? (m[1] as string) : null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
const SPACES_RE = /[\s\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A name as a line's speaker: on one line, at most SPEAKER_MAX characters; null when there is none,
 * or when it is one of `ids`, as a channel that knows no name may give the sender's id in its place.
 */
export function speakerName(value: unknown, ids: readonly unknown[] = []): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(SPACES_RE, ' ').trim();
  if (name.length === 0 || ids.some((id) => str(id) === value.trim())) return null;
  if (name.length <= SPEAKER_MAX) return name;
  let cut = '';
  for (const ch of name) {
    if (cut.length + ch.length > SPEAKER_MAX) break;
    cut += ch;
  }
  return cut.trimEnd();
}

/** A time in epoch ms, from a number or a parseable string, or null. */
export function timeMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 8.64e15 ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
    return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? n : null;
  }
  return null;
}

/** The text of a message's content: a string, or text blocks joined, images as `[image]`. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = asRecord(block);
        if (!b) return typeof block === 'string' ? block : '';
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image') return '[image]';
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  const obj = asRecord(content);
  if (obj && 'content' in obj) return textOf(obj.content);
  return '';
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

interface LineSpec {
  id: string;
  ms: number;
  role: Role;
  author?: Author;
  speaker?: string | null;
  kind: Kind;
  text: string;
  meta?: Record<string, unknown>;
}

/**
 * A draft, or null when its text is empty once trimmed. The text is what happened, as it was:
 * nothing in it is replaced, and only tool calls and results are cut, to what Origin's adapters keep.
 */
function draft(info: SessionInfo, spec: LineSpec): Draft | null {
  const text = spec.text.trim();
  if (text.length === 0) return null;
  const meta = { ...info.meta, ...spec.meta };
  return {
    ms: spec.ms,
    line: {
      id: spec.id,
      session: info.sessionKey,
      time: new Date(spec.ms).toISOString(),
      role: spec.role,
      ...(spec.author ? { author: spec.author } : {}),
      ...(spec.speaker ? { speaker: spec.speaker } : {}),
      kind: spec.kind,
      text,
      project: info.project,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    },
  };
}

/** A message of `agent_end` or of a transcript: the message itself, or a transcript entry's. */
function messageOf(item: unknown): Record<string, unknown> | null {
  const r = asRecord(item);
  if (!r) return null;
  if (typeof r.role === 'string') return r;
  const inner = asRecord(r.message);
  return inner && typeof inner.role === 'string' ? inner : null;
}

export interface BuildOptions {
  includeTools: boolean;
  /** The time of a message that carries none. */
  now: number;
  /** The names of the Gateway's agents by id, lowercase, from its config. */
  agentNames?: ReadonlyMap<string, string>;
}

export interface Authorship {
  author: Author;
  speaker: string | null;
  meta?: Record<string, unknown>;
}

/**
 * What OpenClaw records of who wrote a user message: its `provenance`, which marks an input routed
 * from another session or one OpenClaw made itself, and for a person's input the sender facts in
 * its internal `__openclaw` field. OpenClaw 2026.10.6 keeps these on the copy of a message it
 * persists, and leaves them off the copy a run holds, which `agent_end` gives: the recorder pairs
 * the two (see Recorder.transcriptUpdate). A name that is only the sender's id is left out, and no
 * id is kept.
 */
export interface SenderFacts {
  /** `provenance.kind`: external_user, inter_session, internal_system, or another OpenClaw names. */
  kind: string | null;
  /** The agent of the session an inter-session input came from. */
  sourceAgent: string | null;
  sourceTool: string | null;
  /** Whether `__openclaw` holds any sender fact at all. */
  sender: boolean;
  /** True only when OpenClaw says so, from `commands.ownerAllowFrom`. */
  senderIsOwner: boolean;
  senderName: string | null;
  senderUsername: string | null;
  senderKind: string | null;
}

const SENDER_KEYS = ['senderIsOwner', 'senderId', 'senderName', 'senderUsername', 'senderIdentity'];

export function senderFactsOf(m: Record<string, unknown>): SenderFacts {
  const provenance = asRecord(m.provenance);
  const sender = asRecord(m.__openclaw);
  const identity = asRecord(sender?.senderIdentity);
  const ids = [sender?.senderId, identity?.id];
  const source = str(provenance?.sourceSessionKey);
  return {
    kind: str(provenance?.kind),
    sourceAgent: source ? agentOfSessionKey(source) : null,
    sourceTool: str(provenance?.sourceTool),
    sender: sender !== null && SENDER_KEYS.some((k) => sender[k] !== undefined),
    senderIsOwner: sender?.senderIsOwner === true,
    senderName: speakerName(sender?.senderName, ids),
    senderUsername: speakerName(sender?.senderUsername, ids),
    senderKind: str(identity?.senderKind),
  };
}

/** Whether the facts say who wrote a message: an input routed or made by OpenClaw, or a sender's. */
export const saysWho = (f: SenderFacts): boolean =>
  f.kind === 'inter_session' || f.kind === 'internal_system' || f.sender;

/**
 * Who wrote a user message, from its facts. The owner is the sender OpenClaw itself takes for its
 * owner (`senderIsOwner`, from `commands.ownerAllowFrom`); anyone else is a person, by the name the
 * channel gives; a message without facts is a person's, unnamed.
 */
export function authorshipOf(f: SenderFacts, agentNames?: ReadonlyMap<string, string>): Authorship {
  if (f.kind === 'internal_system') return { author: 'system', speaker: null };
  if (f.kind === 'inter_session') {
    const agent = f.sourceAgent;
    const name = agent ? (agentNames?.get(agent.toLowerCase()) ?? speakerName(agent)) : null;
    return { author: 'agent', speaker: name ?? speakerName(f.sourceTool) };
  }
  return {
    author: f.senderIsOwner ? 'owner' : 'person',
    speaker: f.senderName ?? f.senderUsername,
    ...(f.senderKind === 'bot' ? { meta: { senderKind: 'bot' } } : {}),
  };
}

/** Whether a user message is the runtime context OpenClaw adds to a turn, which no one said. */
export function isRuntimeContext(m: Record<string, unknown>, text = textOf(m.content)): boolean {
  return (
    asRecord(m.runtimeContext) !== null ||
    m.runtimeContextCarrier === true ||
    text.includes(RUNTIME_CONTEXT_MARKER)
  );
}

/**
 * What pairs a user message a run holds with the copy OpenClaw persisted of it, which can differ in
 * its time and in the shape of its content (a string, or text and image parts): a hash of its text
 * parts, joined, without whitespace. Null when it has no text.
 */
export function pairingKey(content: unknown): string | null {
  const parts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.map((block) => {
            if (typeof block === 'string') return block;
            const b = asRecord(block);
            return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
          })
        : [];
  const text = parts.join('').replace(/\s+/g, '');
  return text ? createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32) : null;
}

/**
 * The lines of OpenClaw's messages, as `agent_end` gives them (the session's history as the model
 * saw it, this turn's messages last) and as a transcript's tail reads: user and assistant messages,
 * tool calls and their results, and compaction summaries. Thinking, and messages of kinds it does
 * not know, are left out. A message has no id of its own, so a line's id is a hash of the session,
 * the message's time, its role and kind, and its place in the message (or its tool call's id).
 * A user message's line also says who wrote it (`author`, `speaker`), which is not in its id, as
 * far as the message itself tells, and how it pairs with the persisted copy of its message, which
 * tells it when the message does not (`pair`).
 */
export function draftsFromMessages(
  messages: readonly unknown[],
  info: SessionInfo,
  opts: BuildOptions,
): Draft[] {
  const out: Draft[] = [];
  const push = (d: Draft | null) => {
    if (d) out.push(d);
  };
  for (const item of messages) {
    const m = messageOf(item);
    if (!m) continue;
    const role = m.role as string;
    const ts = timeMs(m.timestamp);
    const ms = ts ?? opts.now;
    // Without a time, the message's content identifies it.
    const at =
      ts ??
      `c:${createHash('sha256')
        .update(json(m.content ?? m.summary))
        .digest('hex')
        .slice(0, 16)}`;
    const key = info.sessionKey;
    if (role === 'user') {
      const text = textOf(m.content);
      const runtime = isRuntimeContext(m, text);
      const kind: Kind = runtime ? 'meta' : 'message';
      // The runtime context is no one's input: a meta line, which event lines take as the system's.
      const facts = runtime ? null : senderFactsOf(m);
      const d = draft(info, {
        // Who wrote a message is not part of what identifies it.
        id: lineId([key, at, 'user', kind, 0]),
        ms,
        role: 'user',
        ...(facts ? authorshipOf(facts, opts.agentNames) : {}),
        kind,
        text,
      });
      const pairing = facts ? pairingKey(m.content) : null;
      if (d && facts && pairing) {
        d.pair = { key: pairing, idempotencyKey: str(m.idempotencyKey), known: saysWho(facts) };
      }
      push(d);
    } else if (role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text =
        typeof m.content === 'string'
          ? m.content
          : blocks
              .map((b) => asRecord(b))
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b?.text as string)
              .join('\n');
      const provider = str(m.provider);
      const model = str(m.model);
      const meta = model ? { model: provider ? `${provider}/${model}` : model } : undefined;
      push(
        draft(info, {
          id: lineId([key, at, 'assistant', 'message', 'text']),
          ms,
          role: 'assistant',
          kind: 'message',
          text,
          meta,
        }),
      );
      if (!opts.includeTools) continue;
      blocks.forEach((block, i) => {
        const b = asRecord(block);
        if (!b || (b.type !== 'toolCall' && b.type !== 'tool_use' && b.type !== 'toolUse')) return;
        const name = str(b.name) ?? 'tool';
        const callId = str(b.id);
        push(
          draft(info, {
            id: lineId([key, at, 'assistant', 'tool_use', callId ?? i]),
            ms,
            role: 'assistant',
            kind: 'tool_use',
            text: truncate(`${name} ${json(b.arguments ?? b.input ?? {})}`, TOOL_USE_MAX),
            meta: { toolName: name, ...(callId ? { callId } : {}) },
          }),
        );
      });
    } else if (role === 'toolResult') {
      if (!opts.includeTools) continue;
      const name = str(m.toolName);
      const callId = str(m.toolCallId);
      push(
        draft(info, {
          id: lineId([key, at, 'user', 'tool_result', callId ?? 0]),
          ms,
          role: 'user',
          kind: 'tool_result',
          text: truncate(textOf(m.content), TOOL_RESULT_MAX),
          meta: {
            ...(name ? { toolName: name } : {}),
            ...(callId ? { callId } : {}),
            ...(m.isError === true ? { isError: true } : {}),
          },
        }),
      );
    } else if (role === 'compactionSummary' || role === 'branchSummary') {
      push(
        draft(info, {
          id: lineId([key, at, 'system', 'meta', role]),
          ms,
          role: 'system',
          kind: 'meta',
          text: typeof m.summary === 'string' ? m.summary : '',
          meta: { summary: role === 'compactionSummary' ? 'compaction' : 'branch' },
        }),
      );
    }
  }
  return out;
}

/**
 * Lines from the hooks that need no conversation access, for a Gateway that does not let the
 * plugin read `agent_end`: a message that arrived (`message_received`), one that was sent
 * (`message_sent`), and a tool call with its result (`after_tool_call`). Their ids come from the
 * channel's message id or the tool call's id when there is one. A message that arrived is a
 * person's, by the name the channel gives: these hooks do not say whether its sender is OpenClaw's
 * owner, so nothing they see is recorded as the owner's.
 */
export function draftFromInbound(
  event: unknown,
  ctx: unknown,
  info: SessionInfo,
  now: number,
): Draft | null {
  const e = asRecord(event) ?? {};
  const c = asRecord(ctx) ?? {};
  const ms = timeMs(e.timestamp) ?? now;
  const messageId = str(e.messageId) ?? str(c.messageId);
  const metadata = asRecord(e.metadata) ?? {};
  const ids = [e.senderId, metadata.senderId];
  return draft(info, {
    id: messageId
      ? lineId([info.sessionKey, 'in', messageId])
      : lineId([info.sessionKey, ms, 'user', 'message', 0]),
    ms,
    role: 'user',
    author: 'person',
    speaker: speakerName(metadata.senderName, ids) ?? speakerName(metadata.senderUsername, ids),
    kind: 'message',
    text: typeof e.content === 'string' ? e.content : '',
    meta: messageId ? { messageId } : undefined,
  });
}

export function draftFromOutbound(event: unknown, info: SessionInfo, now: number): Draft | null {
  const e = asRecord(event) ?? {};
  if (e.success === false) return null;
  const messageId = str(e.messageId);
  return draft(info, {
    id: messageId
      ? lineId([info.sessionKey, 'out', messageId])
      : lineId([info.sessionKey, now, 'assistant', 'message', 0]),
    ms: now,
    role: 'assistant',
    kind: 'message',
    text: typeof e.content === 'string' ? e.content : '',
    meta: messageId ? { messageId } : undefined,
  });
}

export function draftsFromToolCall(
  event: unknown,
  ctx: unknown,
  info: SessionInfo,
  now: number,
): Draft[] {
  const e = asRecord(event) ?? {};
  const c = asRecord(ctx) ?? {};
  const name = str(e.toolName) ?? str(c.toolName) ?? 'tool';
  const callId = str(e.toolCallId) ?? str(c.toolCallId);
  const duration = typeof e.durationMs === 'number' && e.durationMs >= 0 ? e.durationMs : 0;
  const started = now - duration;
  const meta = { toolName: name, ...(callId ? { callId } : {}) };
  const out: Draft[] = [];
  const use = draft(info, {
    id: callId
      ? lineId([info.sessionKey, 'tool', callId, 'tool_use'])
      : lineId([info.sessionKey, started, 'assistant', 'tool_use', name]),
    ms: started,
    role: 'assistant',
    kind: 'tool_use',
    text: truncate(`${name} ${json(e.params ?? {})}`, TOOL_USE_MAX),
    meta,
  });
  if (use) out.push(use);
  const error = str(e.error);
  const resultText =
    e.result === undefined
      ? ''
      : typeof e.result === 'string'
        ? e.result
        : textOf(e.result) || json(e.result);
  const result = draft(info, {
    id: callId
      ? lineId([info.sessionKey, 'tool', callId, 'tool_result'])
      : lineId([info.sessionKey, now, 'user', 'tool_result', name]),
    ms: now,
    role: 'user',
    kind: 'tool_result',
    text: truncate(error ? `Error: ${error}` : resultText, TOOL_RESULT_MAX),
    meta: { ...meta, ...(error ? { isError: true } : {}) },
  });
  if (result) out.push(result);
  return out;
}
