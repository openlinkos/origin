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

/** A line before it is placed in its turn (parent, title), with its time in epoch ms. */
export interface Draft {
  line: EventLine;
  ms: number;
}

/** Longest tool call and tool result text, as Origin's adapters keep them. */
export const TOOL_USE_MAX = 2000;
export const TOOL_RESULT_MAX = 4000;
/** Longest title, in characters. */
export const TITLE_MAX = 80;
/** Longest speaker, in characters, as event lines take it. */
export const SPEAKER_MAX = 200;
/**
 * Tools whose results never leave OpenClaw: the 1Password plugin's agent tool returns secret values
 * in its results, and they stay in the model's context and the transcript.
 */
export const SECRET_TOOLS: readonly string[] = ['onepassword'];
/** OpenClaw's marker of the runtime context it adds to a turn, which no one said. */
const RUNTIME_CONTEXT_MARKER = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>';

/** Origin hub tokens and 1Password references, replaced wherever they appear in a line. */
const SECRET_RES = [/ogn_[A-Za-z0-9_-]+/g, /op:\/\/[^\s"'`<>()[\]{}]+/g];
export const REDACTED = '[redacted]';

/** `text` with every Origin token (`ogn_…`) and 1Password reference (`op://…`) replaced. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, REDACTED);
  return out;
}

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

/** A draft, or null when its text is empty once trimmed and redacted. */
function draft(info: SessionInfo, spec: LineSpec): Draft | null {
  const text = redact(spec.text).trim();
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

const isSecretTool = (name: string | null) =>
  name !== null && SECRET_TOOLS.includes(name.toLowerCase());

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

interface Authorship {
  author: Author;
  speaker: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Who wrote a user message, from what OpenClaw records with it: its `provenance`, which marks an
 * input routed from another session or one OpenClaw made itself, and for a person's input the
 * sender facts in its internal `__openclaw` field. The owner is the sender OpenClaw itself takes
 * for its owner (`senderIsOwner`, from `commands.ownerAllowFrom`); anyone else is a person, by the
 * name the channel gives. No sender id is kept.
 */
function authorshipOf(m: Record<string, unknown>, opts: BuildOptions): Authorship {
  const provenance = asRecord(m.provenance);
  if (provenance?.kind === 'internal_system') return { author: 'system', speaker: null };
  if (provenance?.kind === 'inter_session') {
    const source = str(provenance.sourceSessionKey);
    const agent = source ? agentOfSessionKey(source) : null;
    const name = agent ? (opts.agentNames?.get(agent.toLowerCase()) ?? speakerName(agent)) : null;
    return { author: 'agent', speaker: name ?? speakerName(provenance.sourceTool) };
  }
  const sender = asRecord(m.__openclaw) ?? {};
  const identity = asRecord(sender.senderIdentity);
  const ids = [sender.senderId, identity?.id];
  return {
    author: sender.senderIsOwner === true ? 'owner' : 'person',
    speaker: speakerName(sender.senderName, ids) ?? speakerName(sender.senderUsername, ids),
    ...(identity?.senderKind === 'bot' ? { meta: { senderKind: 'bot' } } : {}),
  };
}

/**
 * The lines of OpenClaw's messages, as `agent_end` gives them (the session's history as the model
 * saw it, this turn's messages last) and as a transcript's tail reads: user and assistant messages,
 * tool calls and their results, and compaction summaries. Thinking, and messages of kinds it does
 * not know, are left out. A message has no id of its own, so a line's id is a hash of the session,
 * the message's time, its role and kind, and its place in the message (or its tool call's id).
 * A user message's line also says who wrote it (`author`, `speaker`), which is not in its id.
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
      const runtime =
        asRecord(m.runtimeContext) !== null ||
        m.runtimeContextCarrier === true ||
        text.includes(RUNTIME_CONTEXT_MARKER);
      const kind: Kind = runtime ? 'meta' : 'message';
      // The runtime context is no one's input: a meta line, which event lines take as the system's.
      const by = runtime ? null : authorshipOf(m, opts);
      push(
        draft(info, {
          // Who wrote a message is not part of what identifies it.
          id: lineId([key, at, 'user', kind, 0]),
          ms,
          role: 'user',
          ...(by ?? {}),
          kind,
          text,
        }),
      );
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
      if (isSecretTool(name)) continue;
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
  if (isSecretTool(name)) return out;
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
