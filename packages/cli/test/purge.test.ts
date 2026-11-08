import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConflictError,
  type Database,
  getEvent,
  getPurge,
  initStoreName,
  listAudit,
  listPurges,
  makeRelay,
  OriginError,
  openDatabase,
  pendingPurgeMirrors,
  purge,
  searchEvents,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { checkArgs } from '../src/args.js';
import type { HubConfig } from '../src/hub/config.js';
import { main } from '../src/main.js';
import { cmdPurge, cmdPurged, hubPurgeLink, type PurgeCtx, purgeSelector } from '../src/purge.js';

/** `origin purge` and `origin purged`, on synthetic sessions only. */

let tmp: string;
let home: string;
let src: string;
let db: Database;
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-purge-'));
  home = path.join(tmp, 'home');
  src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('e1', 's1', 1000, 'user', 'The deploy key is zebracanary.') +
      line('e2', 's1', 2000, 'assistant', 'Noted.'),
  );
  fs.writeFileSync(path.join(src, 's2.jsonl'), line('e3', 's2', 3000, 'user', 'Kept words.'));
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'laptop');
  await syncSource({ db, home }, fakeAdapter(src));
  out = [];
  err = [];
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = (over: Partial<PurgeCtx> = {}): PurgeCtx => ({
  db,
  home,
  adapters: [fakeAdapter(src)],
  hub: () => null,
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  ...over,
});

const printed = () => out.join('\n');
const HUB: HubConfig = { url: 'https://hub.example.com', token: 'ogn_x', device: 'laptop' };

describe('origin purge', () => {
  it('previews what it deletes, by id and count, and deletes it only with --yes', () => {
    expect(cmdPurge(ctx(), ['session', 'fake:s1', '--reason', 'a secret was pasted'])).toBe(1);
    const preview = printed();
    expect(preview).toContain('This purge deletes for good, from this store (laptop): 2 events');
    expect(preview).toContain('1 session');
    expect(preview).toContain('fake:s1');
    expect(preview).toMatch(/s1\.jsonl \(fake, raw file \d+\): lines 1-2/);
    expect(preview).toMatch(/Digest: sha256:[0-9a-f]{32}/);
    expect(preview).toContain('A purge does not reach:');
    expect(preview).toContain('This cannot be undone.');
    // Ids and counts only: never the text it deletes.
    expect(preview).not.toContain('zebracanary');
    expect(getEvent(db, 'fake:e1')).not.toBeNull();
    expect(listPurges(db)).toEqual([]);

    out = [];
    expect(
      cmdPurge(ctx(), ['session', 'fake:s1', '--reason', 'a secret was pasted', '--yes']),
    ).toBe(0);
    expect(printed()).toMatch(/^Purged prg_[0-9a-f]{12}: 2 events/);
    expect(printed()).not.toContain('zebracanary');
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(getEvent(db, 'fake:e3')).not.toBeNull();
    expect(searchEvents(db, 'zebracanary')).toEqual([]);
    const [record] = listPurges(db);
    expect(record).toMatchObject({
      origin: 'laptop',
      author: 'user@laptop',
      channel: 'cli',
      reason: 'a secret was pasted',
      selector: { kind: 'session', source: 'fake', sessionId: 's1' },
    });
    expect(listAudit(db, { action: 'purge' })[0]).toMatchObject({ actor: 'cli', channel: 'cli' });
    // The mirror is blanked at once.
    expect(pendingPurgeMirrors(db)).toEqual([]);
  });

  it('needs a reason, and says what is wrong with a selector before the store is opened', () => {
    expect(cmdPurge(ctx(), ['event', 'fake:e1'])).toBe(2);
    expect(cmdPurge(ctx(), ['event', 'fake:e1', '--reason', '  '])).toBe(2);
    expect(err.join('\n')).toContain('A reason is required');
    const problem = (argv: string[]) => {
      const c = checkArgs('purge', argv);
      return c.kind === 'error' ? c.message : c.kind;
    };
    expect(problem(['event', 'fake:e1', '--reason', 'r'])).toBe('run');
    expect(problem(['--resume'])).toBe('run');
    expect(problem(['--reason', 'r'])).toContain('Say what to purge.');
    expect(problem(['session', 's1', '--reason', 'r'])).toContain('with its source');
    expect(problem(['entries', 'ent_1', '--reason', 'r'])).toContain('Unknown selector "entries"');
    expect(problem(['event', 'fake:e1', '--source', 'fake', '--reason', 'r'])).toContain(
      '--source goes with the lines selector',
    );
    expect(problem(['lines', '--reason', 'r'])).toContain('--source <id>');
    expect(problem(['lines', '--source', 'fake', '--lines', '2-4', '--reason', 'r'])).toContain(
      'needs the raw file',
    );
    expect(problem(['lines', '--source', 'fake', '--unparsed', '--reason', 'r'])).toContain(
      'Unparsed lines are purged only',
    );
    expect(problem(['lines', '--source', 'fake', '--since', 'soon', '--reason', 'r'])).toContain(
      '--since takes a time',
    );
    expect(problem(['--resume', 'event', 'x'])).toContain('--resume takes no selector');
    expect(checkArgs('purged', ['a', 'b'])).toMatchObject({ kind: 'error' });
  });

  it('reads every selector', () => {
    const now = Date.UTC(2026, 10, 8);
    expect(purgeSelector(['event', 'a:1', 'a:2'], {})).toEqual({
      kind: 'event',
      ids: ['a:1', 'a:2'],
    });
    expect(purgeSelector(['session', 'codex:a:b'], { 'keep-children': true })).toEqual({
      kind: 'session',
      source: 'codex',
      sessionId: 'a:b',
      keepChildren: true,
    });
    expect(purgeSelector(['entry', 'ent_1'], {})).toEqual({ kind: 'entry', id: 'ent_1' });
    expect(purgeSelector(['forgotten', 'all'], {})).toEqual({
      kind: 'forgotten',
      tombstone: 'all',
    });
    expect(purgeSelector(['recall', 'rcl_1'], {})).toEqual({ kind: 'recall', id: 'rcl_1' });
    expect(
      purgeSelector(
        ['lines'],
        {
          source: 'chat',
          from: 'bot',
          file: '12',
          lines: '3-7',
          since: '2026-11-01',
          until: '1d',
          unparsed: true,
        },
        now,
      ),
    ).toEqual({
      kind: 'lines',
      source: 'chat',
      from: 'bot',
      file: 12,
      lines: { first: 3, last: 7 },
      since: Date.parse('2026-11-01'),
      until: now - 86_400_000,
      unparsed: true,
    });
  });

  it('prints every id with --json, and at most 50 of a kind otherwise', async () => {
    fs.writeFileSync(
      path.join(src, 'big.jsonl'),
      Array.from({ length: 60 }, (_, i) => line(`b${i}`, 'big', 10_000 + i, 'user', `n${i}`)).join(
        '',
      ),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    const ids = Array.from({ length: 60 }, (_, i) => `fake:b${i}`);
    expect(cmdPurge(ctx(), ['event', ...ids, '--reason', 'test data'])).toBe(1);
    expect(printed()).toContain('Events (60):');
    expect(printed()).toContain('… and 10 more');

    out = [];
    expect(cmdPurge(ctx(), ['event', ...ids, '--reason', 'test data', '--json'])).toBe(1);
    const plan = JSON.parse(printed());
    expect(plan.events).toHaveLength(60);
    expect(plan.counts.events).toBe(60);
    expect(getEvent(db, 'fake:b0')).not.toBeNull();
  });

  it('applies only the plan shown when given its digest', async () => {
    cmdPurge(ctx(), ['event', 'fake:e1', '--reason', 'r', '--json']);
    const before = JSON.parse(printed());
    // The agent writes the same event again: the purge would now blank that line too.
    fs.appendFileSync(path.join(src, 's1.jsonl'), line('e1', 's1', 1000, 'user', 'again'));
    await syncSource({ db, home }, fakeAdapter(src));
    expect(() =>
      cmdPurge(ctx(), ['event', 'fake:e1', '--reason', 'r', '--yes', '--digest', before.digest]),
    ).toThrow(ConflictError);
    expect(getEvent(db, 'fake:e1')).not.toBeNull();
    out = [];
    cmdPurge(ctx(), ['event', 'fake:e1', '--reason', 'r', '--json']);
    const after = JSON.parse(printed());
    expect(after.digest).not.toBe(before.digest);
    expect(after.counts.lines).toBe(2);
    out = [];
    expect(
      cmdPurge(ctx(), ['event', 'fake:e1', '--reason', 'r', '--yes', '--digest', after.digest]),
    ).toBe(0);
    expect(getEvent(db, 'fake:e1')).toBeNull();
  });

  it('says that a hub keeps its copy, and links to the same purge there', () => {
    expect(
      cmdPurge(ctx({ hub: () => HUB }), ['session', 'fake:s1', '--reason', 'r', '--yes']),
    ).toBe(0);
    expect(printed()).toContain('This store syncs to the hub at https://hub.example.com');
    expect(printed()).toContain('https://hub.example.com/admin/purge?session=fake%3As1');
    expect(hubPurgeLink(HUB, { kind: 'event', ids: ['codex:a', 'codex:b'] }, null)).toBe(
      'https://hub.example.com/admin/purge?event=codex%3Aa&event=codex%3Ab',
    );
    expect(
      hubPurgeLink(
        HUB,
        { kind: 'lines', source: 'chat', path: '/logs/a.jsonl', unparsed: true },
        null,
      ),
    ).toBe(
      'https://hub.example.com/admin/purge?lines=chat&from=laptop&path=%2Flogs%2Fa.jsonl&unparsed=1',
    );
  });

  it('refuses on a relay: purge on the hub', () => {
    const relayHome = path.join(tmp, 'relay');
    const relay = openDatabase(path.join(relayHome, 'origin.db'));
    try {
      initStoreName(relay, 'phone');
      makeRelay(relay);
      expect(() =>
        cmdPurge(ctx({ db: relay, home: relayHome, hub: () => HUB }), [
          'event',
          'fake:e1',
          '--reason',
          'r',
          '--yes',
        ]),
      ).toThrow(/relay.*purge on your hub.*https:\/\/hub\.example\.com\/admin\/purge/);
      expect(() => cmdPurged(ctx({ db: relay, home: relayHome }), [])).toThrow(OriginError);
    } finally {
      relay.close();
    }
  });

  it('blanks what a purge left in the mirrors with --resume', () => {
    purge(
      db,
      home,
      [fakeAdapter(src)],
      { kind: 'event', ids: ['fake:e1'] },
      {
        reason: 'r',
        author: 'user@laptop',
        channel: 'cli',
        complete: false,
      },
    );
    expect(pendingPurgeMirrors(db)).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, 'raw', 'fake', 's1.jsonl.tail'), 'utf8')).toContain(
      'zebracanary',
    );
    expect(cmdPurge(ctx(), ['--resume'])).toBe(0);
    expect(printed()).toContain('Blanked 1 purged line in 1 mirror.');
    expect(pendingPurgeMirrors(db)).toEqual([]);
    expect(fs.readFileSync(path.join(home, 'raw', 'fake', 's1.jsonl.tail'), 'utf8')).not.toContain(
      'zebracanary',
    );
    out = [];
    expect(cmdPurge(ctx(), ['--resume'])).toBe(0);
    expect(printed()).toBe('No purge has lines left to blank.');
  });
});

describe('origin purged', () => {
  it('lists purges by id, reason, and counts, and shows one with every id it removed', () => {
    expect(cmdPurged(ctx(), [])).toBe(0);
    expect(printed()).toBe('Nothing has been purged.');
    cmdPurge(ctx(), ['session', 'fake:s1', '--reason', 'pasted a secret', '--yes']);
    const id = listPurges(db)[0]?.id as string;

    out = [];
    expect(cmdPurged(ctx(), [])).toBe(0);
    expect(printed()).toContain(id);
    expect(printed()).toContain('laptop (user@laptop)');
    expect(printed()).toContain('session fake:s1');
    expect(printed()).toContain('pasted a secret');

    out = [];
    expect(cmdPurged(ctx(), [id])).toBe(0);
    expect(printed()).toContain(`Purge ${id}`);
    expect(printed()).toContain('Reason:    pasted a secret');
    expect(printed()).toContain('Sessions (1):\n  fake:s1');
    expect(printed()).toMatch(/s1\.jsonl \(fake, raw file \d+\): lines 1-2/);
    expect(printed()).not.toContain('zebracanary');

    out = [];
    expect(cmdPurged(ctx(), [id, '--json'])).toBe(0);
    expect(JSON.parse(printed())).toMatchObject(getPurge(db, id) as object);
    expect(() => cmdPurged(ctx(), ['prg_000000000000'])).toThrow('Unknown purge');
    expect(() => cmdPurged(ctx(), ['tmb_1'])).toThrow('Not a purge id');
  });
});

describe('origin status', () => {
  let saved: Record<string, string | undefined>;
  let logged: string[];

  beforeEach(() => {
    saved = { ORIGIN_HOME: process.env.ORIGIN_HOME, ORIGIN_DEVICE: process.env.ORIGIN_DEVICE };
    process.env.ORIGIN_HOME = home;
    process.env.ORIGIN_DEVICE = 'laptop';
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('lists the mirrors whose purged lines are still to blank', async () => {
    purge(
      db,
      home,
      [fakeAdapter(src)],
      { kind: 'event', ids: ['fake:e1'] },
      {
        reason: 'r',
        author: 'user@laptop',
        channel: 'cli',
        complete: false,
      },
    );
    expect(await main(['status'])).toBe(0);
    expect(logged.join('\n')).toMatch(
      /Purged lines still to blank in 1 mirror \(origin purge --resume, or the next sync\):\n {2}fake[\\/]s1\.jsonl \(prg_[0-9a-f]{12}\)/,
    );
  });
});
