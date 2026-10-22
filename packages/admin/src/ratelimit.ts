/**
 * Limits failed password checks (sign-in and re-authentication): at most `perClient` failures per
 * client and `global` failures overall within a sliding window. Once a limit is reached, every
 * password check is refused, even with the correct password, until the oldest failure leaves the
 * window. Behind a proxy, clients are told apart only with ORIGIN_CLIENT_IP_HEADER; without it they
 * all share the proxy's address, and so one per-client limit.
 */
export interface LimiterOptions {
  perClient: number;
  global: number;
  windowMs: number;
  /** Clients tracked at most; the least recently failing are forgotten first. */
  maxClients: number;
}

export const LOGIN_LIMITS: LimiterOptions = {
  perClient: 10,
  global: 100,
  windowMs: 10 * 60_000,
  maxClients: 10_000,
};

interface Bucket {
  failures: number[];
  /** Whether the block of the current window has already been written to the audit log. */
  blockLogged: boolean;
}

export type LimitCheck = { ok: true } | { ok: false; retryAfterSec: number; firstBlock: boolean };

export class LoginLimiter {
  private readonly clients = new Map<string, Bucket>();
  private readonly all: Bucket = { failures: [], blockLogged: false };

  constructor(private readonly o: LimiterOptions = LOGIN_LIMITS) {}

  private prune(bucket: Bucket, now: number): void {
    const cutoff = now - this.o.windowMs;
    while (bucket.failures.length > 0 && (bucket.failures[0] ?? 0) <= cutoff) {
      bucket.failures.shift();
    }
    if (bucket.failures.length === 0) bucket.blockLogged = false;
  }

  private bucket(client: string, now: number): Bucket {
    let b = this.clients.get(client);
    if (!b) {
      b = { failures: [], blockLogged: false };
      this.clients.set(client, b);
      if (this.clients.size > this.o.maxClients) {
        for (const [key, value] of this.clients) {
          this.prune(value, now);
          if (value.failures.length === 0 || this.clients.size > this.o.maxClients) {
            this.clients.delete(key);
          }
          if (this.clients.size <= this.o.maxClients) break;
        }
      }
    }
    this.prune(b, now);
    return b;
  }

  /** Whether a password check may run now. `firstBlock` is true once per blocked window. */
  check(client: string, now: number): LimitCheck {
    this.prune(this.all, now);
    const b = this.bucket(client, now);
    const blocked = [
      b.failures.length >= this.o.perClient ? b : null,
      this.all.failures.length >= this.o.global ? this.all : null,
    ].filter((x): x is Bucket => x !== null);
    if (blocked.length === 0) return { ok: true };
    const until = Math.max(...blocked.map((x) => (x.failures[0] ?? now) + this.o.windowMs));
    const firstBlock = blocked.some((x) => !x.blockLogged);
    for (const x of blocked) x.blockLogged = true;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)), firstBlock };
  }

  /** Record a failure. Returns the client's failure count in the window, this one included. */
  fail(client: string, now: number): number {
    const b = this.bucket(client, now);
    b.failures.push(now);
    this.prune(this.all, now);
    this.all.failures.push(now);
    return b.failures.length;
  }
}

/**
 * Runs password checks one at a time. scrypt is slow and needs 32 MiB on purpose, so checking in
 * series bounds the hub's memory, and it makes the limiter exact: a burst of concurrent guesses
 * cannot all pass the limit check before the first failure is counted. At most `maxWaiting` checks
 * wait; beyond that, run() returns null and the caller answers 429.
 */
export class CheckQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly maxWaiting = 32) {}

  run<T>(task: () => Promise<T>): Promise<T> | null {
    if (this.waiting >= this.maxWaiting) return null;
    this.waiting++;
    const result = this.tail.then(task).finally(() => {
      this.waiting--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
