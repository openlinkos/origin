import { SyncWorker, SyncWorkerError } from '../sync-worker.js';

/**
 * Synchronous HTTP requests, for the hub's bucket (see s3.ts): node:sqlite is synchronous, and
 * sealed frames are written and read inside write transactions, so the frame store cannot wait for
 * a promise. A worker thread runs `fetch`, and the calling thread blocks until it answers (see
 * sync-worker.ts). The caller's event loop stands still meanwhile: on a hub, no other request is
 * served during a frame's transfer.
 *
 * Outside transactions, as `origin raw upload` moves frames, the same requests can also be sent
 * without blocking (requestAsync), on the calling thread, several at once.
 */

export interface SyncRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface SyncResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** A request that failed before a response arrived: the network, a timeout, or the worker. */
export class SyncHttpError extends Error {
  constructor(
    message: string,
    /** True if the request timed out. */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

/** How much longer than its own timeout the caller waits for the worker's answer. */
const GRACE_MS = 2000;

/** What the bucket needs of an HTTP client (tests replace it). */
export interface HttpClient {
  request(req: SyncRequest): SyncResponse;
  /** The same request without blocking; it answers and fails as `request` does. */
  requestAsync(req: SyncRequest): Promise<SyncResponse>;
  close(): void;
}

/**
 * Send a request with `fetch` on the calling thread, as the worker does: with its own timeout,
 * without following redirects, and failing with a SyncHttpError.
 */
export async function fetchResponse(req: SyncRequest, timeoutMs: number): Promise<SyncResponse> {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const cause = e?.cause?.message ? `: ${e.cause.message}` : '';
    throw new SyncHttpError(timedOut ? 'timed out' : `${e?.message ?? e}${cause}`, timedOut);
  }
}

/**
 * The worker's handler (see sync-worker.ts): runs each request with its own timeout, and answers
 * with the response, its body moved rather than copied, or with the error.
 */
const HANDLER_SOURCE = `async ({ request, timeoutMs }, { transfer }) => {
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = new Uint8Array(await res.arrayBuffer());
    transfer.push(body.buffer);
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const cause = err && err.cause && err.cause.message ? ': ' + err.cause.message : '';
    return { error: timedOut ? 'timed out' : String((err && err.message) || err) + cause, timedOut };
  }
}`;

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  error?: string;
  timedOut?: boolean;
}

export class SyncHttp implements HttpClient {
  private readonly worker = new SyncWorker({ source: HANDLER_SOURCE });
  private readonly graceMs: number;

  /** `timeoutMs`: how long one request may take, from sending it to its last response byte. */
  constructor(
    readonly timeoutMs: number,
    opts: { graceMs?: number } = {},
  ) {
    this.graceMs = opts.graceMs ?? GRACE_MS;
  }

  /** Send a request and wait for its response, blocking this thread. */
  request(req: SyncRequest, timeoutMs = this.timeoutMs): SyncResponse {
    // A view is cloned with its whole buffer: send only its own bytes.
    const body =
      req.body && (req.body.byteOffset !== 0 || req.body.byteLength !== req.body.buffer.byteLength)
        ? new Uint8Array(req.body)
        : req.body;
    let reply: Reply;
    try {
      reply = this.worker.call<Reply>(
        { request: { ...req, body }, timeoutMs },
        { timeoutMs: Math.max(0, timeoutMs + this.graceMs) },
      );
    } catch (err) {
      if (!(err instanceof SyncWorkerError)) throw err;
      // The worker has been stopped, and the next request starts a new one. No answer even after
      // the worker's own timeout: it is stuck. A worker that died or stopped beating did not time
      // out, so the bucket tries again.
      if (err.reason === 'timeout') {
        throw new SyncHttpError(
          `timed out after ${timeoutMs} ms (no answer from the worker)`,
          true,
        );
      }
      throw new SyncHttpError(err.message);
    }
    if (reply.error !== undefined) throw new SyncHttpError(reply.error, reply.timedOut === true);
    const answered = reply.body as Uint8Array;
    return {
      status: reply.status as number,
      headers: reply.headers ?? {},
      body: Buffer.from(answered.buffer, answered.byteOffset, answered.byteLength),
    };
  }

  /** Send a request without blocking, on this thread rather than the worker's. */
  requestAsync(req: SyncRequest, timeoutMs = this.timeoutMs): Promise<SyncResponse> {
    return fetchResponse(req, timeoutMs);
  }

  /** Stop the worker; the next request starts a new one. */
  close(): void {
    this.worker.close();
  }
}
