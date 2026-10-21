/**
 * Limits failed key checks (sign-in and re-authentication): at most `perClient` failures per
 * client and `global` failures overall within a sliding window. Once a limit is reached, every
 * key check is refused, even with a correct key, until the oldest failure leaves the window.
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

  /** Whether a key check may run now. `firstBlock` is true once per blocked window. */
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
