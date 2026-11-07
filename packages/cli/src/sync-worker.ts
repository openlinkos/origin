import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  type Transferable,
  Worker,
} from 'node:worker_threads';

/**
 * Synchronous calls into a worker thread, for work that only has an asynchronous API (fetch, a
 * database driver) where Origin's code must wait for it without a promise: node:sqlite is
 * synchronous, and so is everything built on it. The calling thread posts a request to the worker
 * and blocks on `Atomics.wait` until the worker has posted its answer and raised a word in shared
 * memory, then takes the answer with `receiveMessageOnPort` (the technique of the synckit package).
 * `postMessage` has queued the answer on the port before it returns, so it is there when the
 * caller wakes. The caller's event loop stands still meanwhile, as it does during a node:sqlite
 * query.
 *
 * A blocked thread cannot receive the worker's `exit` event, so the worker shows that it lives
 * through the shared memory as well: a heartbeat counter it raises every `heartbeatMs`, and a state
 * word it sets when it fails. A call ends with a SyncWorkerError, instead of waiting forever, when
 * the worker dies, stops beating for `stallMs` (a thread stuck in a loop, or gone), or does not
 * answer in the call's own time; the worker is then stopped, and the next call starts a new one.
 *
 * The worker runs `source`, plain JavaScript evaluated as CommonJS (so that it needs no file of its
 * own next to the compiled code, and runs the same from TypeScript sources under the tests).
 */

/** The shared words, as an Int32Array over SharedArrayBuffer(16). */
const ANSWERED = 0; // the id of the last answer posted (-1 once the worker has failed)
const HEARTBEAT = 1; // raised by the worker every heartbeatMs
const STATE = 2; // STARTING, READY, or DEAD
// Word 3 is reserved.
const STARTING = 0;
const READY = 1;
const DEAD = 2;

/** How the worker beats, and how long the caller tolerates silence, by default. */
const HEARTBEAT_MS = 250;
const STALL_MS = 30_000;

/** Why a call failed without an answer from the worker's code. */
export type SyncWorkerFailure = 'timeout' | 'stalled' | 'died';

/** A call that got no answer: the worker died, stopped beating, or took longer than allowed. */
export class SyncWorkerError extends Error {
  constructor(
    message: string,
    readonly reason: SyncWorkerFailure,
  ) {
    super(message);
    this.name = 'SyncWorkerError';
  }
}

export interface SyncWorkerOptions {
  /**
   * JavaScript source of an expression whose value handles each request: a function of the request
   * and a context `{ data, transfer }`, returning the answer or a promise of it. It is evaluated once
   * per worker, with `require` in scope; an expression such as `(() => { const x = require(…);
   * return async (request) => …; })()` keeps state across calls. Push buffers of the answer onto
   * `context.transfer` to move them rather than copy them. What it throws is thrown by `call`: an
   * Error with the same name and message, and the same own properties where they are primitives.
   */
  source: string;
  /** Data for the handler (`context.data`), cloned into each worker. */
  data?: unknown;
  /** How often the worker raises its heartbeat. */
  heartbeatMs?: number;
  /** How long a call waits without a heartbeat before it takes the worker for dead. */
  stallMs?: number;
}

export interface CallOptions {
  /** How long the call may take, from posting the request to its answer (no limit by default). */
  timeoutMs?: number;
  /** Buffers of the request to move to the worker rather than copy. */
  transfer?: Transferable[];
}

/** An error as the worker posts it. */
interface PostedError {
  name: string;
  message: string;
  props: Record<string, unknown>;
}

type Answer =
  | { id: number; value: unknown; error?: undefined; fatal?: undefined }
  | { id: number; error: PostedError; fatal?: undefined }
  | { fatal: PostedError; id?: undefined; error?: undefined };

const WORKER_SOURCE = `'use strict';
const { workerData } = require('node:worker_threads');
const { port, shared, heartbeatMs, source, data } = workerData;
const words = new Int32Array(shared);

function posted(err) {
  const props = {};
  let name = 'Error';
  let message = String(err);
  if (err !== null && typeof err === 'object') {
    name = typeof err.name === 'string' ? err.name : name;
    message = typeof err.message === 'string' ? err.message : message;
    for (const key of Object.keys(err)) {
      const v = err[key];
      if (v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v)) props[key] = v;
    }
  }
  return { name, message, props };
}

function raise(value) {
  Atomics.store(words, ${ANSWERED}, value);
  Atomics.notify(words, ${ANSWERED});
}

let dead = false;
function die(err) {
  if (dead) return;
  dead = true;
  try {
    port.postMessage({ fatal: posted(err) });
  } catch {}
  Atomics.store(words, ${STATE}, ${DEAD});
  raise(-1);
}
process.on('uncaughtException', (err) => {
  die(err);
  process.exit(1);
});
process.on('exit', (code) => die(new Error('the worker exited with code ' + code)));

setInterval(() => Atomics.add(words, ${HEARTBEAT}, 1), heartbeatMs).unref();
const handle = new Function('require', 'return (' + source + '\\n);')(require);
Atomics.store(words, ${STATE}, ${READY});

port.on('message', async ({ id, request }) => {
  const transfer = [];
  let answer;
  try {
    answer = { id, value: await handle(request, { data, transfer }) };
  } catch (err) {
    answer = { id, error: posted(err) };
    transfer.length = 0;
  }
  try {
    port.postMessage(answer, transfer);
  } catch (err) {
    port.postMessage({ id, error: posted(err) });
  }
  raise(id);
});
`;

function rebuilt(e: PostedError): Error {
  const err = new Error(e.message);
  Object.assign(err, e.props);
  if (e.name !== 'Error') err.name = e.name;
  return err;
}

export class SyncWorker {
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private words: Int32Array | null = null;
  private nextId = 1;
  private readonly heartbeatMs: number;
  private readonly stallMs: number;

  constructor(private readonly opts: SyncWorkerOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.stallMs = opts.stallMs ?? STALL_MS;
  }

  /**
   * Send a request to the worker and return its answer, blocking this thread until it comes. A
   * worker that has died since the last call is replaced first.
   */
  call<T = unknown>(request: unknown, opts: CallOptions = {}): T {
    if (this.words && Atomics.load(this.words, STATE) === DEAD) this.close();
    const { port, words } = this.start();
    const id = this.nextId;
    this.nextId = id >= 0x7fffffff ? 1 : id + 1;
    port.postMessage({ id, request }, opts.transfer ?? []);
    const started = performance.now();
    const deadline = started + (opts.timeoutMs ?? Number.POSITIVE_INFINITY);
    // A sign of life: the worker has started, or its heartbeat has moved, since `alive`.
    let state = Atomics.load(words, STATE);
    let beat = Atomics.load(words, HEARTBEAT);
    let alive = started;
    for (;;) {
      // Read before taking messages: an answer posted after this changes it, so the wait below
      // returns at once rather than sleeping past it.
      const answered = Atomics.load(words, ANSWERED);
      for (let got = receiveMessageOnPort(port); got; got = receiveMessageOnPort(port)) {
        const answer = got.message as Answer;
        if (answer.fatal) this.fail('died', `the worker failed: ${answer.fatal.message}`);
        // An answer to an earlier call that this thread stopped waiting for: dropped.
        if (answer.id !== id) continue;
        if (answer.error) throw rebuilt(answer.error);
        return answer.value as T;
      }
      const now = performance.now();
      const nowState = Atomics.load(words, STATE);
      if (nowState === DEAD) this.fail('died', 'the worker stopped');
      if (now >= deadline) {
        this.fail('timeout', `no answer from the worker within ${opts.timeoutMs} ms`);
      }
      const nowBeat = Atomics.load(words, HEARTBEAT);
      if (nowState !== state || nowBeat !== beat) {
        state = nowState;
        beat = nowBeat;
        alive = now;
      } else if (now - alive >= this.stallMs) {
        this.fail(
          'stalled',
          state === STARTING
            ? `the worker did not start within ${this.stallMs} ms`
            : `the worker stopped responding (no heartbeat for ${this.stallMs} ms)`,
        );
      }
      // Wake up at the deadline, and now and then to look at the heartbeat.
      const wait = Math.min(deadline - now, alive + this.stallMs - now, this.stallMs / 4);
      Atomics.wait(words, ANSWERED, answered, Math.max(1, Math.ceil(wait)));
    }
  }

  /** Stop the worker; the next call starts a new one. */
  close(): void {
    const worker = this.worker;
    this.worker = null;
    this.port?.close();
    this.port = null;
    this.words = null;
    void worker?.terminate();
  }

  private fail(reason: SyncWorkerFailure, message: string): never {
    this.close();
    throw new SyncWorkerError(message, reason);
  }

  private start(): { port: MessagePort; words: Int32Array } {
    if (this.worker && this.port && this.words) return { port: this.port, words: this.words };
    const { port1, port2 } = new MessageChannel();
    const shared = new SharedArrayBuffer(16);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        port: port2,
        shared,
        heartbeatMs: this.heartbeatMs,
        source: this.opts.source,
        data: this.opts.data,
      },
      transferList: [port2],
    });
    // Neither keeps the process alive: a hub, or a command, exits when it is done.
    worker.unref();
    port1.unref();
    // Between calls the event loop runs, and a worker that has stopped is forgotten here.
    worker.on('error', () => this.forget(worker));
    worker.on('exit', () => this.forget(worker));
    this.worker = worker;
    this.port = port1;
    this.words = new Int32Array(shared);
    return { port: port1, words: this.words };
  }

  private forget(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = null;
      this.port?.close();
      this.port = null;
      this.words = null;
    }
  }
}
