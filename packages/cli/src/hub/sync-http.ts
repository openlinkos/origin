import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from 'node:worker_threads';

/**
 * Synchronous HTTP requests, for the hub's bucket (see s3.ts): node:sqlite is synchronous, and
 * sealed frames are written and read inside write transactions, so the frame store cannot wait for
 * a promise. A worker thread runs `fetch`; the calling thread posts it a request and blocks on
 * `Atomics.wait` until the worker has posted the response and raised a flag, then takes the
 * response with `receiveMessageOnPort` (the technique of the synckit package). The caller's event
 * loop stands still meanwhile: on a hub, no other request is served during a frame's transfer.
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
  close(): void;
}

/**
 * The worker: runs each request with its own timeout, posts the response or the error, and then
 * raises the request's flag. Plain JavaScript, evaluated as a CommonJS script, so that it needs no
 * file of its own next to the compiled code.
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const port = workerData.port;
port.on('message', async ({ id, flag, request, timeoutMs }) => {
  let reply;
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = new Uint8Array(await res.arrayBuffer());
    reply = { id, status: res.status, headers: Object.fromEntries(res.headers), body };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const cause = err && err.cause && err.cause.message ? ': ' + err.cause.message : '';
    reply = { id, error: timedOut ? 'timed out' : String((err && err.message) || err) + cause, timedOut };
  }
  port.postMessage(reply, reply.body ? [reply.body.buffer] : []);
  const view = new Int32Array(flag);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
});
`;

interface Reply {
  id: number;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  error?: string;
  timedOut?: boolean;
}

export class SyncHttp implements HttpClient {
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private nextId = 1;
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
    const port = this.start();
    const id = this.nextId++;
    const flag = new SharedArrayBuffer(4);
    // A view is cloned with its whole buffer: send only its own bytes.
    const body =
      req.body && (req.body.byteOffset !== 0 || req.body.byteLength !== req.body.buffer.byteLength)
        ? new Uint8Array(req.body)
        : req.body;
    port.postMessage({ id, flag, request: { ...req, body }, timeoutMs });
    Atomics.wait(new Int32Array(flag), 0, 0, Math.max(0, timeoutMs + this.graceMs));
    for (;;) {
      const received = receiveMessageOnPort(port);
      if (!received) break;
      const reply = received.message as Reply;
      // A reply to an earlier request that this thread stopped waiting for: dropped.
      if (reply.id !== id) continue;
      if (reply.error !== undefined) throw new SyncHttpError(reply.error, reply.timedOut === true);
      return {
        status: reply.status as number,
        headers: reply.headers ?? {},
        body: Buffer.from(
          (reply.body as Uint8Array).buffer,
          (reply.body as Uint8Array).byteOffset,
          (reply.body as Uint8Array).byteLength,
        ),
      };
    }
    // No answer even after the worker's own timeout: it is stuck or gone. Start a new one.
    this.close();
    throw new SyncHttpError(`timed out after ${timeoutMs} ms (no answer from the worker)`, true);
  }

  /** Stop the worker; the next request starts a new one. */
  close(): void {
    const worker = this.worker;
    this.worker = null;
    this.port?.close();
    this.port = null;
    void worker?.terminate();
  }

  private start(): MessagePort {
    if (this.worker && this.port) return this.port;
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { port: port2 },
      transferList: [port2],
    });
    // Neither keeps the process alive: a hub, or a command, exits when it is done.
    worker.unref();
    port1.unref();
    worker.on('error', () => this.forget(worker));
    worker.on('exit', () => this.forget(worker));
    this.worker = worker;
    this.port = port1;
    return port1;
  }

  private forget(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = null;
      this.port?.close();
      this.port = null;
    }
  }
}
