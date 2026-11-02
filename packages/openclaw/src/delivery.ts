import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Log } from './log.js';

/**
 * Delivering event lines, in order and at least once, without ever making OpenClaw wait: hooks hand
 * batches to a queue and return; the queue sends one batch at a time, each request bounded by a
 * timeout, and keeps what it could not send in a spool that the next delivery, and the Gateway's
 * start, send first. Origin ignores lines whose ids it already has, so sending a line twice, as a
 * retry after a lost answer may, is harmless.
 */

/** The lines of one file: its relative path and the lines, serialized, without line breaks. */
export interface Batch {
  path: string;
  lines: string[];
}

/**
 * What became of a batch: delivered (`ok`), to try again later (`retry`), or refused for good
 * (`reject`, a request the hub will never take as it is). `sent` counts the lines delivered before
 * a failure, for a batch sent in parts.
 */
export interface SendResult {
  outcome: 'ok' | 'retry' | 'reject';
  sent: number;
  message?: string;
}

export interface Sink {
  /** Where the lines go, for messages. */
  readonly target: string;
  send(batch: Batch): Promise<SendResult>;
}

/** Most bytes of lines in one request to a hub; the hub takes up to 8 MiB. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Appends to the files of a source's directory, `<dir>/<path>`, which an Origin device on this
 * host reads as the source named after the directory (`~/.origin/sources/<name>/`).
 */
export class DirSink implements Sink {
  readonly target: string;
  private versionWritten = false;

  constructor(
    private readonly dir: string,
    private readonly version: string | null,
  ) {
    this.target = dir;
  }

  async send(batch: Batch): Promise<SendResult> {
    try {
      const file = path.join(this.dir, ...batch.path.split('/'));
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await this.writeVersion();
      // A line cut short by a crash would swallow the next one: start on a line of its own.
      const lead = (await endsWithNewline(file)) ? '' : '\n';
      await fs.promises.appendFile(file, `${lead}${batch.lines.join('\n')}\n`);
      return { outcome: 'ok', sent: batch.lines.length };
    } catch (err) {
      return { outcome: 'retry', sent: 0, message: (err as Error).message };
    }
  }

  /** The source's VERSION file, which Origin records as the version of what wrote its events. */
  private async writeVersion(): Promise<void> {
    if (this.versionWritten || !this.version) return;
    const file = path.join(this.dir, 'VERSION');
    const current = await fs.promises.readFile(file, 'utf8').catch(() => null);
    if (current?.split(/\r?\n/, 1)[0] !== this.version) {
      await fs.promises.writeFile(file, `${this.version}\n`);
    }
    this.versionWritten = true;
  }
}

/** Whether `file` is missing, empty, or ends with a line break. */
async function endsWithNewline(file: string): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return true;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/** Statuses for a request the hub will never take as it is: bad path or body, too large, wrong type. */
const REFUSED = [400, 413, 415];

/**
 * Posts lines to a hub, `POST <hub>/v1/sources/<source>/lines?path=<path>` with a token of their
 * own (docs/architecture.md#http-interface), in requests of at most MAX_REQUEST_BYTES.
 */
export class HubSink implements Sink {
  readonly target: string;
  private warnedParseErrors = false;

  constructor(
    private readonly url: string,
    private readonly source: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly log: Log,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.target = url;
  }

  async send(batch: Batch): Promise<SendResult> {
    let sent = 0;
    for (const part of chunks(batch.lines, MAX_REQUEST_BYTES)) {
      const r = await this.post(batch.path, part);
      if (r.outcome !== 'ok') return { ...r, sent };
      sent += part.length;
    }
    return { outcome: 'ok', sent };
  }

  private async post(file: string, lines: string[]): Promise<SendResult> {
    const endpoint = `${this.url}/v1/sources/${encodeURIComponent(this.source)}/lines?path=${encodeURIComponent(file)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: `${lines.join('\n')}\n`,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const message =
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? `no answer within ${this.timeoutMs} ms`
          : `${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ''}`;
      return { outcome: 'retry', sent: 0, message };
    }
    const body = await res.text().catch(() => '');
    if (res.ok) {
      const answer = parseJson(body);
      const parseErrors = typeof answer?.parse_errors === 'number' ? answer.parse_errors : 0;
      if (parseErrors > 0 && !this.warnedParseErrors) {
        this.warnedParseErrors = true;
        this.log.warn(
          `the hub could not read ${parseErrors} of the lines sent to ${file}; it keeps them`,
        );
      }
      return { outcome: 'ok', sent: lines.length };
    }
    const reason = str(parseJson(body)?.error) ?? body.slice(0, 300);
    const message = `the hub answered ${res.status}${reason ? `: ${reason}` : ''}`;
    return { outcome: REFUSED.includes(res.status) ? 'reject' : 'retry', sent: 0, message };
  }
}

/** `lines` in groups of at most `max` bytes each (a longer line in a group of its own). */
function* chunks(lines: readonly string[], max: number): Generator<string[]> {
  let group: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (group.length > 0 && bytes + size > max) {
      yield group;
      group = [];
      bytes = 0;
    }
    group.push(line);
    bytes += size;
  }
  if (group.length > 0) yield group;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * The spool: batches not delivered yet, one file each under `<dir>/spool/`, named so that they sort
 * in the order they were spooled, written once (to a temporary name, then renamed) and removed once
 * delivered. Files rather than one file that is rewritten as it drains, so that two instances of the
 * plugin, as overlap while OpenClaw reloads it, never lose each other's batches: at worst they send
 * one twice. Batches the hub refused for good are moved to `<dir>/rejected/`, kept for a person to
 * look at, and never sent again.
 */
export class Spool {
  readonly dir: string;
  private readonly rejectedDir: string;
  private seq = 0;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'spool');
    this.rejectedDir = path.join(stateDir, 'rejected');
  }

  /** The spooled batches' files, oldest first. */
  async list(): Promise<string[]> {
    const names = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith('.json')).sort();
  }

  async read(name: string): Promise<Batch | null> {
    try {
      const v = JSON.parse(await fs.promises.readFile(path.join(this.dir, name), 'utf8'));
      if (
        typeof v?.path === 'string' &&
        Array.isArray(v.lines) &&
        v.lines.every((l: unknown) => typeof l === 'string')
      ) {
        return { path: v.path, lines: v.lines };
      }
    } catch {
      // unreadable: set aside below
    }
    return null;
  }

  async add(batch: Batch): Promise<void> {
    if (batch.lines.length === 0) return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const name = `${String(Date.now()).padStart(15, '0')}-${String(this.seq++).padStart(6, '0')}-${randomBytes(4).toString('hex')}.json`;
    await this.write(name, batch);
  }

  /** Replace a spooled batch with what is left of it. */
  async replace(name: string, batch: Batch): Promise<void> {
    await this.write(name, batch);
  }

  private async write(name: string, batch: Batch): Promise<void> {
    const tmp = path.join(this.dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
    await fs.promises.writeFile(tmp, JSON.stringify({ path: batch.path, lines: batch.lines }));
    await fs.promises.rename(tmp, path.join(this.dir, name));
  }

  async remove(name: string): Promise<void> {
    await fs.promises.rm(path.join(this.dir, name), { force: true });
  }

  /** Move a batch the hub refused for good out of the spool. */
  async reject(name: string | null, batch: Batch | null): Promise<string> {
    await fs.promises.mkdir(this.rejectedDir, { recursive: true });
    const target = path.join(
      this.rejectedDir,
      name ?? `${String(Date.now()).padStart(15, '0')}-${randomBytes(4).toString('hex')}.json`,
    );
    if (name) {
      await fs.promises.rename(path.join(this.dir, name), target).catch(async () => {
        if (batch) await fs.promises.writeFile(target, JSON.stringify(batch));
      });
    } else if (batch) {
      await fs.promises.writeFile(target, JSON.stringify(batch));
    }
    return target;
  }
}

/**
 * Sends batches one at a time, in the order they were handed over, spooled batches first. Every
 * method resolves; failures are logged, once until delivery works again.
 */
export class Deliverer {
  private chain: Promise<unknown> = Promise.resolve();
  private failing = false;

  constructor(
    private readonly sink: Sink,
    readonly spool: Spool,
    private readonly log: Log,
  ) {}

  /**
   * Deliver `batches`, after what the spool holds. Resolves to true once each batch is delivered,
   * spooled, or set aside, and to false if it could not even be spooled, in which case its lines may
   * be handed over again.
   */
  deliver(batches: readonly Batch[]): Promise<boolean> {
    const run = this.chain.then(() => this.run(batches));
    this.chain = run.catch(() => undefined);
    return run.catch((err) => {
      this.log.error(`delivery failed: ${(err as Error).message}`);
      return false;
    });
  }

  /** Send what the spool holds, as when the Gateway starts. */
  retry(): Promise<boolean> {
    return this.deliver([]);
  }

  /** Resolves when everything handed over so far has been dealt with. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private async run(batches: readonly Batch[]): Promise<boolean> {
    const drained = await this.drain();
    let i = 0;
    if (drained) {
      for (; i < batches.length; i++) {
        const batch = batches[i] as Batch;
        const r = await this.sink.send(batch);
        if (r.outcome === 'ok') {
          this.recovered();
          continue;
        }
        const rest = { path: batch.path, lines: batch.lines.slice(r.sent) };
        if (r.outcome === 'reject') {
          const where = await this.spool.reject(null, rest);
          this.log.error(`${r.message}; ${rest.lines.length} lines set aside in ${where}`);
          continue;
        }
        this.failed(r.message, rest.lines.length + countLines(batches.slice(i + 1)));
        await this.spool.add(rest);
        i++;
        break;
      }
    }
    for (; i < batches.length; i++) await this.spool.add(batches[i] as Batch);
    return true;
  }

  /** Send the spooled batches, oldest first; true when the spool is empty afterwards. */
  private async drain(): Promise<boolean> {
    for (const name of await this.spool.list()) {
      const batch = await this.spool.read(name);
      if (!batch) {
        // Another instance delivered it meanwhile, or it cannot be read: nothing to send.
        if (await exists(path.join(this.spool.dir, name))) {
          const where = await this.spool.reject(name, null);
          this.log.error(`could not read spooled batch ${name}; moved to ${where}`);
        }
        continue;
      }
      const r = await this.sink.send(batch);
      if (r.outcome === 'ok') {
        await this.spool.remove(name);
        this.recovered();
        continue;
      }
      if (r.outcome === 'reject') {
        const where = await this.spool.reject(name, batch);
        this.log.error(`${r.message}; ${batch.lines.length} spooled lines set aside in ${where}`);
        continue;
      }
      if (r.sent > 0)
        await this.spool.replace(name, { path: batch.path, lines: batch.lines.slice(r.sent) });
      this.failed(r.message, null);
      return false;
    }
    return true;
  }

  private failed(message: string | undefined, lines: number | null): void {
    if (this.failing) {
      this.log.debug(`still cannot deliver to ${this.sink.target}: ${message}`);
      return;
    }
    this.failing = true;
    this.log.warn(
      `cannot deliver to ${this.sink.target}: ${message}; ${lines === null ? 'the spooled lines wait' : `${lines} lines wait`} in ${this.spool.dir} for the next turn or the Gateway's next start`,
    );
  }

  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.log.info(`delivering to ${this.sink.target} again`);
  }
}

const countLines = (batches: readonly Batch[]) => batches.reduce((n, b) => n + b.lines.length, 0);

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}
