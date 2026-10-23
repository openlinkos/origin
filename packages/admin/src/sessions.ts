import { createHash, randomBytes } from 'node:crypto';
import {
  ADMIN_OWNER,
  ADMIN_SESSION_MAX_MS,
  type AdminSession,
  createAdminSession,
  type Database,
  endAdminSession,
  getAdminSession,
  isAdminSessionFresh,
  markAdminSessionFresh,
} from '@openlinkos/origin-core';
import { safeEqual } from './http.js';

/** Where the sessions of an admin UI live. */
export interface SessionStore {
  /** Start a session; the id goes into the cookie and is never kept, only its hash. */
  create(
    client: { ip: string | null; userAgent: string | null },
    now: number,
  ): { id: string; session: AdminSession };
  /** The live session for a cookie value, or null. */
  get(id: string, now: number): AdminSession | null;
  end(session: AdminSession, now: number): void;
  /** Whether the session may take a sensitive action without entering the password again. */
  isFresh(session: AdminSession, now: number): boolean;
  markFresh(session: AdminSession, now: number): void;
}

/** The hub's sessions: in `admin_session`, with the limits of core (see docs/architecture.md#admin-ui). */
export function storedSessions(db: Database): SessionStore {
  return {
    create: (client, now) => createAdminSession(db, client, now),
    get: (id, now) => getAdminSession(db, id, { now }),
    end: (session, now) => void endAdminSession(db, session.idHash, now),
    isFresh: (session, now) => isAdminSessionFresh(session, now),
    markFresh: (session, now) => markAdminSessionFresh(db, session.idHash, now),
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The sessions of `origin ui`: kept in this process only, so they end when it exits, however it
 * exits, and a session of the local UI is never valid anywhere else, not even for a hub admin UI
 * served from the same store. A session lasts at most 12 hours, like the hub's, but has no idle
 * limit: on one's own machine the browser is the owner's, and there is no password to enter again.
 */
export class MemorySessions implements SessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  create(
    client: { ip: string | null; userAgent: string | null },
    now: number,
  ): { id: string; session: AdminSession } {
    for (const [hash, s] of this.sessions) {
      if (now - s.createdAt >= ADMIN_SESSION_MAX_MS) this.sessions.delete(hash);
    }
    const id = randomBytes(32).toString('base64url');
    const idHash = sha256(id);
    const session: AdminSession = {
      idHash,
      handle: idHash.slice(0, 16),
      csrf: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      freshAt: now,
      ip: client.ip,
      userAgent: client.userAgent ? client.userAgent.slice(0, 256) : null,
    };
    this.sessions.set(idHash, session);
    return { id, session };
  }

  get(id: string, now: number): AdminSession | null {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    const session = this.sessions.get(sha256(id));
    if (!session) return null;
    if (now - session.createdAt >= ADMIN_SESSION_MAX_MS) {
      this.sessions.delete(session.idHash);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  end(session: AdminSession): void {
    this.sessions.delete(session.idHash);
  }

  /** There is no password locally; `origin ui` asks for nothing again (its routes need no freshness). */
  isFresh(): boolean {
    return true;
  }

  markFresh(): void {}
}

/** How long the sign-in link of `origin ui` works. */
export const SIGN_IN_LINK_MS = 5 * 60_000;

export type SignInResult = 'ok' | 'used' | 'expired' | 'invalid';

/**
 * The one-time secret of `origin ui`'s sign-in link. Only its hash is kept, in this process, so it
 * also ends when the process exits. It works once, within SIGN_IN_LINK_MS of being issued; issuing
 * a new one invalidates the previous one.
 */
export class SignInLink {
  private hash: string | null = null;
  private expiresAt = 0;
  private used = false;

  issue(now: number): string {
    const secret = randomBytes(32).toString('base64url');
    this.hash = sha256(secret);
    this.expiresAt = now + SIGN_IN_LINK_MS;
    this.used = false;
    return secret;
  }

  /** Check a secret and, if it is valid, use it up. */
  redeem(secret: unknown, now: number): SignInResult {
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 128) return 'invalid';
    if (this.hash === null || !safeEqual(sha256(secret), this.hash)) return 'invalid';
    if (this.used) return 'used';
    if (now >= this.expiresAt) return 'expired';
    this.used = true;
    return 'ok';
  }
}

/** The actor of the audit log for the owner signed in to `origin ui`. */
export const LOCAL_ACTOR = 'local';
/** The actor for the owner signed in to the hub's admin UI. */
export const HUB_ACTOR = ADMIN_OWNER;
