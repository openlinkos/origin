import { type SpawnOptions, spawn } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { type AdminHandler, createLocalAdmin, type HubLink } from '@openlinkos/origin-admin';
import {
  type Database,
  getSetting,
  OriginError,
  type SourceAdapter,
  syncSource,
} from '@openlinkos/origin-core';
import type { HubConfig } from './hub/config.js';
import { createAdminServer } from './hub/serve.js';
import { syncedKey, syncWithHub } from './hub/sync.js';

/** `origin ui` listens on this address only (see docs/architecture.md#admin-ui). */
export const UI_HOST = '127.0.0.1';
export const UI_PORT = 7079;
/** How long stopping `origin ui` waits for a sync with the hub that is under way. */
const CLOSE_TIMEOUT_MS = 5000;

export interface StartUiOptions {
  db: Database;
  home: string;
  version: string;
  /** Only 127.0.0.1 is accepted; anything else is refused. */
  host?: string;
  /** 0 picks a free port. */
  port: number;
  /** The hub this device is connected to, read each time: the connection can change meanwhile. */
  hub: () => HubConfig | null;
  /**
   * The agents whose new log lines to ingest in the background once the UI listens, as
   * `origin sync --local` does, so that it shows what they wrote last. None by default.
   */
  ingest?: SourceAdapter[];
  log?: (message: string) => void;
  /** Clock, for tests. */
  now?: () => number;
}

/** What the background ingest of `origin ui` added. */
export interface UiIngest {
  filesChanged: number;
  eventsAdded: number;
  parseErrors: number;
  durationMs: number;
}

export interface RunningUi {
  /** The UI's address, e.g. `http://127.0.0.1:7079/admin/`. */
  url: string;
  /** The one-time sign-in link: it works once, within a few minutes, and only in this process. */
  signInUrl: string;
  /** Issue a new sign-in link, as signInUrl is; the previous one stops working, used or not. */
  newSignInUrl(): string;
  /** The background ingest: what it added once it is done, or null if there was none. */
  ingested: Promise<UiIngest | null>;
  /** Wait for the sync with the hub that the last write started, if any. */
  idle(): Promise<void>;
  /**
   * Stop serving; waits a few seconds for a sync with the hub that is under way. An ingest under way
   * is not waited for: it starts no other source, and the next sync goes on where it stopped.
   */
  close(): Promise<void>;
}

/**
 * One sync with the hub at a time, in the background. A request while one runs makes it run once
 * more afterwards, so that every write is followed by a sync that started after it.
 */
class BackgroundSync {
  private running: Promise<void> | null = null;
  private again = false;
  lastError: string | null = null;

  constructor(
    private readonly sync: () => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  get syncing(): boolean {
    return this.running !== null;
  }

  request(): void {
    this.again = true;
    this.running ??= this.loop();
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async loop(): Promise<void> {
    // Let request() record this run before it can end.
    await Promise.resolve();
    while (this.again) {
      this.again = false;
      try {
        await this.sync();
        this.lastError = null;
      } catch (err) {
        this.lastError = (err as Error).message;
        this.log(`Saved here; not synced with the hub yet: ${this.lastError}`);
      }
    }
    this.running = null;
  }
}

/** A URL to show: without credentials, should it carry any. */
function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new OriginError(
              `Port ${port} on ${host} is in use (is origin ui already running?). Choose another with --port.`,
            )
          : err,
      );
    });
    server.listen(port, host, () => resolve());
  });
}

/**
 * Serve the admin UI for this device's own store on 127.0.0.1 (`origin ui`). It signs the owner in
 * with a one-time link instead of a password, answers only to its own Host values, and, on a device
 * connected to a hub, syncs with the hub in the background after every write, as `origin correct`
 * and `origin forget` do.
 */
export async function startLocalUi(o: StartUiOptions): Promise<RunningUi> {
  const host = o.host ?? UI_HOST;
  if (host !== UI_HOST) {
    throw new OriginError(
      `origin ui listens only on ${UI_HOST}, not ${host}: anyone who can reach it gets to your memory with a sign-in link, so it must not be reachable from other machines. To use it from another machine, forward its port over SSH (ssh -L ${o.port || UI_PORT}:127.0.0.1:${o.port || UI_PORT} <host>) and open the link it prints.`,
    );
  }
  const log = o.log ?? (() => {});
  let handler: AdminHandler | null = null;
  const server = createAdminServer((req, res, url) => {
    if (handler) return handler(req, res, url);
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Starting.');
    return Promise.resolve();
  });
  await listen(server, o.port, host);
  const port = (server.address() as AddressInfo).port;

  const background = new BackgroundSync(async () => {
    const hub = o.hub();
    if (hub) await syncWithHub({ db: o.db, home: o.home, hub });
  }, log);
  const hubLink = (): HubLink | null => {
    const hub = o.hub();
    if (!hub) return null;
    const at = Number(getSetting(o.db, syncedKey(hub)));
    return {
      url: shownUrl(hub.url),
      device: hub.device,
      lastSyncAt: Number.isFinite(at) && at > 0 ? at : null,
      syncing: background.syncing,
      lastError: background.lastError,
    };
  };
  const admin = createLocalAdmin({
    db: o.db,
    home: o.home,
    version: o.version,
    port,
    hub: hubLink,
    afterWrite: () => {
      if (o.hub()) background.request();
    },
    log,
    now: o.now,
  });
  handler = admin.handler;
  const base = `http://${host}:${port}`;
  let stopping = false;
  return {
    url: `${base}/admin/`,
    signInUrl: `${base}${admin.signInPath()}`,
    newSignInUrl: () => `${base}${admin.signInPath()}`,
    ingested: ingestInBackground(o, log, () => stopping),
    idle: () => background.idle(),
    async close() {
      stopping = true;
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        background.idle(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

/**
 * Ingest the agents' new log lines one source after another, as `origin sync --local` does, while
 * the UI serves: each write transaction is short, and the ingest lets requests in between. It
 * starts once the caller has had the UI, and stops before the next source once `stopped()`.
 */
async function ingestInBackground(
  o: StartUiOptions,
  log: (message: string) => void,
  stopped: () => boolean,
): Promise<UiIngest | null> {
  if (!o.ingest || o.ingest.length === 0) return null;
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  const total: UiIngest = { filesChanged: 0, eventsAdded: 0, parseErrors: 0, durationMs: 0 };
  for (const adapter of o.ingest) {
    if (stopped()) break;
    try {
      const r = await syncSource({ db: o.db, home: o.home }, adapter);
      total.filesChanged += r.filesChanged;
      total.eventsAdded += r.eventsAdded;
      total.parseErrors += r.parseErrors;
    } catch (err) {
      // Once origin ui stops, the store closes under it: that is no error of the source.
      if (!stopped()) log(`Could not ingest ${adapter.id}: ${(err as Error).message}`);
    }
  }
  total.durationMs = Date.now() - startedAt;
  return total;
}

/**
 * Call `onEnter` each time Enter is pressed in the terminal `origin ui` runs in. Standard input is
 * read only if it is a terminal: input from a pipe or a file, or none, as under a service manager,
 * is left alone. Returns a function that stops listening.
 */
export function onEnter(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  onEnter: () => void,
): () => void {
  if (input.isTTY !== true) return () => {};
  const lines = readline.createInterface({ input, terminal: false });
  lines.on('line', () => onEnter());
  let open = true;
  lines.once('close', () => {
    open = false;
  });
  return () => {
    if (open) lines.close();
    input.pause();
  };
}

/**
 * A page that sends the browser on to the sign-in link. The browser is given this file rather than
 * the link itself, as Jupyter does: a command line can be read by other users of the machine (on
 * Linux, in /proc), and one of them could use the link first. The file is readable only by its
 * owner, in a directory of its own, and is removed when `origin ui` stops.
 */
export function writeSignInFile(url: string): {
  file: string;
  /** Send the browser on to a new link instead, from the same file. */
  update(url: string): void;
  remove(): void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ui-'));
  const file = path.join(dir, 'sign-in.html');
  const write = (link: string) => {
    const attr = link.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    fs.writeFileSync(
      file,
      `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${attr}">\n<title>Origin</title>\n<p><a href="${attr}">Open Origin</a></p>\n`,
      { mode: 0o600 },
    );
  };
  write(url);
  return { file, update: write, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** How to open a file or URL with the default browser, with what each platform has built in. */
export function browserCommand(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[]; options: SpawnOptions } {
  if (platform === 'win32') {
    // `start` is built into cmd; its first quoted argument is the window title. /s keeps the
    // quotes of the command as written, so a path with spaces stays one argument.
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"start "" "${target}""`],
      options: { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
    };
  }
  // In a session of its own, so that Ctrl+C on origin ui does not stop a browser it started.
  const options: SpawnOptions = { stdio: 'ignore', detached: true };
  if (platform === 'darwin') return { command: 'open', args: [target], options };
  return { command: 'xdg-open', args: [target], options };
}

/** Open `target` in the default browser. Failing to is not an error: the link is printed too. */
export function openInBrowser(target: string, log: (message: string) => void): void {
  const { command, args, options } = browserCommand(process.platform, target);
  const fail = (why: string) =>
    log(`Could not open a browser (${why}); open the sign-in link above yourself.`);
  try {
    const child = spawn(command, args, options);
    child.on('error', (err) => fail(err.message));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) fail(`${command} exited with ${code}`);
    });
    child.unref();
  } catch (err) {
    fail((err as Error).message);
  }
}
