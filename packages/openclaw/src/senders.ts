import type { SenderFacts } from './lines.js';

/**
 * Who wrote the user messages OpenClaw persisted, as it recorded them, kept in memory until the
 * lines of their run are sent: OpenClaw 2026.10.6 keeps a message's sender facts on the copy it
 * persists, not on the copy a run holds, which `agent_end` gives (see Recorder.transcriptUpdate).
 * In each session, the facts of a text wait in the order its messages were persisted, so that two
 * messages with the same text pair in order. No text is kept, only a hash of it, and no sender id.
 * Bounded: at most SESSION_ENTRIES a session (the oldest dropped first), at most SESSIONS sessions
 * (the one noted least recently dropped first), and nothing older than MAX_AGE_MS.
 */

export const SESSION_ENTRIES = 50;
export const SESSIONS = 200;
/** Longer than a run takes, from the write of its user message to its end, but not for good. */
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface Persisted {
  facts: SenderFacts;
  /** The OpenClaw session (`sessionId`) the message was persisted in. */
  sessionId: string | null;
  idempotencyKey: string | null;
  /** The transcript entry's id. */
  messageId: string | null;
  /** The persisted copy's time, in epoch ms. */
  ts: number | null;
}

interface Entry extends Persisted {
  /** What tells a message written again apart from another with the same text. */
  identity: string | null;
  at: number;
}

interface Session {
  count: number;
  byKey: Map<string, Entry[]>;
}

export class SenderMemory {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Note the facts of a message persisted in `sessionKey`, whose text hashes to `key`. */
  note(sessionKey: string, key: string, persisted: Persisted): void {
    let session = this.sessions.get(sessionKey);
    if (session) this.sessions.delete(sessionKey);
    else session = { count: 0, byKey: new Map() };
    // Most recently noted last, so that the session noted least recently is dropped first.
    this.sessions.set(sessionKey, session);
    let queue = session.byKey.get(key);
    if (!queue) {
      queue = [];
      session.byKey.set(key, queue);
    }
    const identity = persisted.idempotencyKey
      ? `k:${persisted.idempotencyKey}`
      : persisted.messageId
        ? `m:${persisted.messageId}`
        : persisted.ts !== null
          ? `t:${persisted.ts}`
          : null;
    // OpenClaw may write a message again, as when it records the prompt the model saw with it.
    const again = identity === null ? undefined : queue.find((e) => e.identity === identity);
    if (again) {
      again.facts = persisted.facts;
      return;
    }
    queue.push({ ...persisted, identity, at: this.now() });
    session.count++;
    this.expire(session);
    if (session.count > SESSION_ENTRIES) this.dropOldest(session);
    while (this.sessions.size > SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value as string);
    }
  }

  /**
   * Take the facts of the oldest message of `sessionKey` noted with `key`, or of the one with
   * `idempotencyKey` if there is one; null when there are none.
   */
  take(sessionKey: string, key: string, idempotencyKey: string | null): SenderFacts | null {
    const session = this.sessions.get(sessionKey);
    if (!session) return null;
    this.expire(session);
    const queue = session.byKey.get(key);
    if (!queue) return null;
    const byKey = idempotencyKey ? queue.findIndex((e) => e.idempotencyKey === idempotencyKey) : -1;
    const [entry] = queue.splice(Math.max(byKey, 0), 1);
    if (!entry) return null;
    this.removed(session, key, queue, sessionKey);
    return entry.facts;
  }

  /** Forget a session's messages: those persisted in `sessionId`, and those of no known one; all without it. */
  forget(sessionKey: string, sessionId: string | null = null): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (sessionId === null) {
      this.sessions.delete(sessionKey);
      return;
    }
    for (const [key, queue] of [...session.byKey]) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const entry = queue[i] as Entry;
        if (entry.sessionId === null || entry.sessionId === sessionId) {
          queue.splice(i, 1);
          this.removed(session, key, queue, sessionKey);
        }
      }
    }
  }

  /** How many messages are noted, in all sessions. */
  size(): number {
    let n = 0;
    for (const session of this.sessions.values()) n += session.count;
    return n;
  }

  private expire(session: Session): void {
    const before = this.now() - MAX_AGE_MS;
    for (const [key, queue] of [...session.byKey]) {
      while (queue.length > 0 && (queue[0] as Entry).at < before) {
        queue.shift();
        session.count--;
      }
      if (queue.length === 0) session.byKey.delete(key);
    }
  }

  private dropOldest(session: Session): void {
    let oldest: { key: string; at: number } | null = null;
    for (const [key, queue] of session.byKey) {
      const head = queue[0];
      if (head && (!oldest || head.at < oldest.at)) oldest = { key, at: head.at };
    }
    if (!oldest) return;
    const queue = session.byKey.get(oldest.key) as Entry[];
    queue.shift();
    session.count--;
    if (queue.length === 0) session.byKey.delete(oldest.key);
  }

  private removed(session: Session, key: string, queue: Entry[], sessionKey: string): void {
    session.count--;
    if (queue.length === 0) session.byKey.delete(key);
    if (session.count <= 0) this.sessions.delete(sessionKey);
  }
}
