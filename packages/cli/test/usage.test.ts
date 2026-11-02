import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store040 } from '../../core/test/legacy.js';
import { ARGS, checkArgs, isStoreCommand } from '../src/args.js';
import { main } from '../src/main.js';

/**
 * Opening a store upgrades an older one, so printing usage, or refusing arguments that are not
 * valid, must never open it: a store of Origin 0.4.0 stays as it is, byte for byte.
 */

let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-usage-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  store040(path.join(home, 'origin.db')).close();
  saved = { ORIGIN_HOME: process.env.ORIGIN_HOME, ORIGIN_DEVICE: process.env.ORIGIN_DEVICE };
  process.env.ORIGIN_HOME = home;
  process.env.ORIGIN_DEVICE = 'laptop';
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const hash = (p: string) =>
  fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'none';

/**
 * The store as it is on disk: the database and its write-ahead log, byte for byte, the other entries
 * of its home, and its format version, read without writing (reading creates the WAL's index,
 * `origin.db-shm`, which holds no data and is left out).
 */
function snapshot(): { db: string; wal: string; entries: string[]; version: number } {
  const file = path.join(home, 'origin.db');
  const db = new DatabaseSync(file, { readOnly: true });
  let version: number;
  try {
    ({ user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    });
  } finally {
    db.close();
  }
  return {
    db: hash(file),
    wal: hash(`${file}-wal`),
    entries: fs.readdirSync(home).filter((n) => !n.endsWith('-shm') && !n.endsWith('-wal')),
    version,
  };
}

describe('usage never opens the store', () => {
  it.each([
    ['serve', '--help'],
    ['serve', '-h'],
    ['serve', '--port', '7078', '--help'],
    ['mcp', '--help'],
    ['ui', '--help'],
    ['status', '-h'],
    ['sync', '--help'],
    ['search', 'deploy', '--help'],
    ['token', 'help'],
    ['token', 'create', 'laptop', '--help'],
    ['hub', '--help'],
    ['admin', 'help'],
    ['help'],
    ['--help'],
    ['-h'],
  ])('origin %s %s … prints the usage and leaves a 0.4.0 store as it is', async (...argv) => {
    const before = snapshot();
    expect(before.version).toBe(4);
    expect(await main(argv)).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(home, 'raw'))).toBe(false);
  });

  it.each([
    [['serve', '--prot', '7078'], "Unknown option '--prot'"],
    [['serve', '--port'], "Option '--port <value>' argument missing"],
    [['mcp', '--stdio'], "Unknown option '--stdio'"],
    [['ui', '--browser'], "Unknown option '--browser'"],
    [['status', 'now'], "Unexpected argument 'now'"],
    [['show'], 'An argument is missing.'],
    [['backup', 'a', 'b'], 'Too many arguments.'],
    [['forget', 'ent_1'], 'A reason is required'],
    [['token'], 'Missing a subcommand.'],
    [['token', 'make', 'laptop'], 'Unknown subcommand "make".'],
    [['hub', 'connect', 'https://hub.example.com'], '--token is required'],
    [['raw', 'upload', '--concurency', '4'], "Unknown option '--concurency'"],
  ])('origin %j is refused with its usage before the store is opened', async (argv, message) => {
    const before = snapshot();
    expect(await main(argv)).toBe(2);
    const said = err.join('\n');
    expect(said).toContain(message);
    expect(said).toContain('Usage: origin');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(home, 'raw'))).toBe(false);
  });

  it('refuses an unknown command before the store is opened', async () => {
    const before = snapshot();
    expect(await main(['serv'])).toBe(2);
    expect(err.join('\n')).toContain('Unknown command: serv');
    expect(snapshot()).toEqual(before);
  });

  it('opens, and upgrades, the store once a command runs', async () => {
    expect(await main(['status'])).toBe(0);
    expect(snapshot().version).toBeGreaterThan(4);
  });
});

describe('the arguments table', () => {
  it('covers every command that opens the store, and only those', () => {
    expect(Object.keys(ARGS).sort()).toEqual(
      [
        'accept',
        'admin',
        'backup',
        'correct',
        'distill',
        'entries',
        'forget',
        'forgotten',
        'hub',
        'mcp',
        'projects',
        'proposals',
        'push',
        'raw',
        'recalls',
        'reject',
        'restore',
        'search',
        'serve',
        'show',
        'status',
        'sync',
        'timeline',
        'token',
        'ui',
      ].sort(),
    );
    expect(isStoreCommand('agents')).toBe(false);
    expect(isStoreCommand('toString')).toBe(false);
  });

  it('lets valid arguments through', () => {
    expect(checkArgs('serve', ['--host', '0.0.0.0', '--port', '7077', '--admin'])).toEqual({
      kind: 'run',
    });
    expect(checkArgs('search', ['migration', 'lock', '--since', '7d'])).toEqual({ kind: 'run' });
    expect(checkArgs('forget', ['ent_1', '--reason', 'wrong', '--yes'])).toEqual({ kind: 'run' });
    expect(checkArgs('token', ['create', 'laptop'])).toEqual({ kind: 'run' });
    expect(checkArgs('hub', ['connect', 'https://hub.example.com', '--token', 'ogn_x'])).toEqual({
      kind: 'run',
    });
    // After `--`, --help is an argument, not a request for help.
    expect(checkArgs('search', ['--', '--help'])).toEqual({ kind: 'run' });
  });
});
