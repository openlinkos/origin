import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onPostgres } from '../../../test/pg.js';
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
    ['digest', '--help'],
    ['digest', '--day', '2026-10-20', '-h'],
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
    [['purge', 'session', 'claude-code:s1'], 'A reason is required'],
    [['purge', 'sesion', 's1', '--reason', 'r'], 'Unknown selector "sesion"'],
    [['purged', 'prg_1', 'prg_2'], 'Too many arguments.'],
    [['token'], 'Missing a subcommand.'],
    [['token', 'make', 'laptop'], 'Unknown subcommand "make".'],
    [['hub', 'connect'], 'An argument is missing.'],
    [['token', 'create', 'ci', '--read-only'], "Unknown option '--read-only'"],
    [['admin', 'username', 'a', 'b'], 'Too many arguments.'],
    [['raw', 'upload', '--concurency', '4'], "Unknown option '--concurency'"],
    [['digest', '--day', '2026-02-30'], 'Not a day: 2026-02-30'],
    [['digest', '--day', 'yesterday'], 'Not a day: yesterday'],
    [['digest', '--limit', '0'], '--limit must be a whole number from 1 to 200.'],
    [['digest', '--limit', '201'], '--limit must be a whole number from 1 to 200.'],
    [['digest', '--jsn'], "Unknown option '--jsn'"],
    [['digest', '2026-10-20'], "Unexpected argument '2026-10-20'"],
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

  it.skipIf(onPostgres)('opens, and upgrades, the store once a command runs', async () => {
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
        'db',
        'digest',
        'entries',
        'forget',
        'forgotten',
        'hub',
        'mcp',
        'projects',
        'proposals',
        'purge',
        'purged',
        'push',
        'raw',
        'recalls',
        'reject',
        'restore',
        'search',
        'serve',
        'sessions',
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
    expect(checkArgs('db', ['move', '--to', 'sqlite'])).toEqual({ kind: 'run' });
    expect(
      checkArgs('db', ['move', '--to', 'postgres://origin:pw@db:5432/origin', '--yes']),
    ).toEqual({ kind: 'run' });
    expect(checkArgs('db', ['rebuild-search'])).toEqual({ kind: 'run' });
    const noTarget = checkArgs('db', ['move']);
    expect(noTarget.kind === 'error' && noTarget.message).toMatch(/--to is required/);
    // A URL that is not one is refused without quoting it, as it may hold a password.
    const other = checkArgs('db', ['move', '--to', 'mysql://origin:s3cret@db/origin']);
    expect(other.kind).toBe('error');
    expect(other.kind === 'error' && other.message).not.toContain('s3cret');
    expect(checkArgs('hub', ['connect', 'https://hub.example.com', '--token', 'ogn_x'])).toEqual({
      kind: 'run',
    });
    // Without a token, the owner approves the device in the hub's admin UI.
    expect(checkArgs('hub', ['connect', 'https://hub.example.com'])).toEqual({ kind: 'run' });
    expect(checkArgs('token', ['create', 'ci', '--agent', '--readonly'])).toEqual({ kind: 'run' });
    expect(checkArgs('admin', ['username'])).toEqual({ kind: 'run' });
    expect(checkArgs('admin', ['username', 'dana'])).toEqual({ kind: 'run' });
    expect(checkArgs('digest', [])).toEqual({ kind: 'run' });
    expect(
      checkArgs('digest', [
        '--day',
        '2026-10-20',
        '--project',
        'origin',
        '--limit',
        '200',
        '--json',
      ]),
    ).toEqual({ kind: 'run' });
    // After `--`, --help is an argument, not a request for help.
    expect(checkArgs('search', ['--', '--help'])).toEqual({ kind: 'run' });
  });
});
