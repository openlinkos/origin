import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { adapterById } from '@openlinkos/origin-adapters';
import {
  type Database,
  dbPath,
  defaultStoreName,
  initStoreName,
  isRelay,
  openDatabase,
  originHome,
  type SourceAdapter,
  type SourceFile,
  storeName,
  syncFile,
} from '@openlinkos/origin-core';
import { type HookIO, runByAnother } from './hook-caller.js';
import { setUpFrames } from './hub/bucket.js';
import { type HubConfig, readHubConfig } from './hub/config.js';
import { relayFileWithHub } from './hub/relay.js';
import { pushFile } from './hub/sync.js';
import { storeAdapters } from './sources.js';

/**
 * `origin sync --hook <agent>`: live ingestion (see docs/architecture.md#live-ingestion). An
 * agent's hooks run it when a turn ends, a sub-agent stops, or the conversation was compacted,
 * with the hook's event on standard input, which names the session's transcript. It ingests that
 * file alone, from its cursor, and on a device connected to a hub pushes the file's new lines to
 * the hub; a relay sends them to its hub instead. A hook is a signal to read, not a promise that
 * the transcript is complete: agents write it asynchronously, so a line written after the hook ran
 * is read by the next hook, or by `origin mcp`'s look every minute. Loaded on its own (see bin.ts),
 * so that it starts fast, and it never stands in the agent's way: whatever goes wrong, it prints
 * nothing on standard output, says why on standard error, and exits 0.
 */

/** Agents whose hooks name their session's transcript (see agents.ts for the hooks connect adds). */
export const INGEST_HOOK_AGENTS = ['claude-code', 'codex'] as const;

/** How long a hook waits for the store's write lock before it gives up (the next hook reads on). */
const HOOK_BUSY_MS = 3_000;
/** How long a hook waits for the hub; what is not sent by then waits for the next sync. */
const HOOK_HUB_MS = 3_000;

const USAGE = `Usage:
  origin sync --hook <agent>   Run as the agent's hook: ingest the transcript its event on standard input names
Hooks: ${INGEST_HOOK_AGENTS.join(', ')}`;

/**
 * The fields of a hook's event that name files, as Claude Code and Codex send them: the session's
 * transcript (`transcript_path`, which Codex may send as null), and for `SubagentStop` the
 * sub-agent's own (`agent_transcript_path`).
 */
interface HookEvent {
  transcript_path?: unknown;
  agent_transcript_path?: unknown;
}

/** The files a hook's event names, as absolute paths, the session's first; none for other input. */
export function hookFiles(event: unknown, home = os.homedir()): string[] {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return [];
  const e = event as HookEvent;
  const files: string[] = [];
  for (const value of [e.transcript_path, e.agent_transcript_path]) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    // Documentation examples write paths under the home directory with `~`.
    const expanded = /^~(?=$|[\\/])/.test(value) ? path.join(home, value.slice(1)) : value;
    const absPath = path.resolve(expanded);
    if (!files.includes(absPath)) files.push(absPath);
  }
  return files;
}

/** The files of `adapter` among `paths` that exist now: each as its adapter locates it. */
function locatedFiles(adapter: SourceAdapter, paths: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const p of paths) {
    const file = adapter.locate?.(p) ?? null;
    if (!file || out.some((f) => f.absPath === file.absPath)) continue;
    try {
      if (fs.statSync(file.absPath).isFile()) out.push(file);
    } catch {
      // not written yet, or gone: nothing to read
    }
  }
  return out;
}

function openStore(home: string): Database {
  const db = openDatabase(dbPath(home), {
    adapters: storeAdapters(home),
    log: (m) => console.error(m),
  });
  setUpFrames(db, home, { command: 'other', env: process.env });
  return db;
}

/**
 * Run `send` with a fetch that is cut off after HOOK_HUB_MS: a hook never waits longer for the hub.
 * A send cut off fails like one that cannot reach the hub, and is reported; what it did not send
 * waits for the next sync (pushes and relays resume from where the hub stands).
 */
async function toHub(send: (doFetch: typeof fetch) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`no answer within ${HOOK_HUB_MS / 1000} s`)),
    HOOK_HUB_MS,
  );
  timer.unref();
  try {
    await send((input, init) => fetch(input, { ...init, signal: controller.signal }));
  } catch (err) {
    console.error(
      `origin sync: not sent to the hub yet (${(err as Error).message}); the next sync sends it.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export type { HookIO };

const STDIN: HookIO = { stdin: () => fs.readFileSync(0, 'utf8') };

/** Answer one hook. Always exits 0: a failure is reported on standard error only. */
async function runHook(agent: string, io: HookIO): Promise<number> {
  let db: Database | null = null;
  try {
    const adapter = (INGEST_HOOK_AGENTS as readonly string[]).includes(agent)
      ? adapterById(agent)
      : null;
    if (!adapter) {
      console.error(
        `origin sync: no ingest hook for "${agent}" (hooks: ${INGEST_HOOK_AGENTS.join(', ')}); nothing was read.`,
      );
      return 0;
    }
    const input = io.stdin();
    if (input.trim() === '') return 0;
    let event: unknown;
    try {
      event = JSON.parse(input);
    } catch {
      console.error('origin sync: the hook event on standard input is not JSON; nothing was read.');
      return 0;
    }
    // Another agent running this agent's hooks (see hook-caller.ts): its sessions are found by looking.
    if (runByAnother(agent, event, io.env)) return 0;
    // Only files this agent's adapter would ingest, and that are there: nothing else opens the store.
    const files = locatedFiles(adapter, hookFiles(event));
    if (files.length === 0) return 0;

    const home = originHome();
    db = openStore(home);
    db.exec(`PRAGMA busy_timeout = ${HOOK_BUSY_MS};`);
    initStoreName(db, process.env.ORIGIN_DEVICE || defaultStoreName());
    const saved = readHubConfig(home);
    const hub: HubConfig | null = saved ? { ...saved, device: storeName(db) } : null;

    if (isRelay(db)) {
      // A relay keeps nothing to ingest into: it sends the lines to its hub, straight from the
      // file. Without a hub, they wait in the agent's log for the next sync.
      if (!hub) return 0;
      const store = db;
      await toHub(async (doFetch) => {
        for (const file of files) {
          const r = await relayFileWithHub(
            { db: store, home, hub, adapter, fetch: doFetch },
            file.absPath,
          );
          for (const f of r.failed) console.error(`origin sync: not sent: ${f.path}: ${f.reason}`);
        }
      });
      return 0;
    }

    const changed: SourceFile[] = [];
    for (const file of files) {
      const r = await syncFile({ db, home }, adapter, file.absPath);
      if (r.filesChanged > 0) changed.push(file);
    }
    if (!hub || changed.length === 0) return 0;
    const store = db;
    await toHub(async (doFetch) => {
      for (const file of changed) {
        const r = await pushFile(
          { db: store, home, hub, fetch: doFetch },
          { source: adapter.id, path: file.absPath },
        );
        for (const f of r.refused) {
          console.error(`origin sync: not sent: ${f.path}: the hub refused it: ${f.reason}`);
        }
      }
    });
    return 0;
  } catch (err) {
    console.error(`origin sync: ${(err as Error).message}`);
    return 0;
  } finally {
    db?.close();
  }
}

/** Whether `origin sync` arguments ask for the hook (see bin.ts). */
export function isHookCall(args: string[]): boolean {
  return args.some((a) => a === '--hook' || a.startsWith('--hook='));
}

/** `origin sync --hook <agent>`; argv starts with `sync`. */
export async function main(argv: string[], io: HookIO = STDIN): Promise<number> {
  let values: { hook?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: { hook: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (err) {
    // Hooks are written once and run on every turn: a bad one says why, and is no failure.
    console.error(`origin sync: ${(err as Error).message}\n${USAGE}`);
    return 0;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  return runHook(values.hook ?? '', io);
}
