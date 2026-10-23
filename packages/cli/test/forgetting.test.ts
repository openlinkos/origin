import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createToken,
  type Database,
  forget,
  getEvent,
  initStoreName,
  makeRelay,
  OriginError,
  openDatabase,
  remember,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { cmdForget, cmdForgotten, cmdRestore, type ForgettingCtx } from '../src/forgetting.js';

let tmp: string;
let db: Database;
let out: string[];
let err: string[];
let synced: number;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-forget-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('e1', 's1', 1000, 'user', 'The token is ogn_secret.') +
      line('e2', 's1', 2000, 'assistant', 'Noted.'),
  );
  db = openDatabase(path.join(tmp, 'home', 'origin.db'));
  initStoreName(db, 'laptop');
  await syncSource({ db, home: path.join(tmp, 'home') }, fakeAdapter(src));
  out = [];
  err = [];
  synced = 0;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = (over: Partial<ForgettingCtx> = {}): ForgettingCtx => ({
  db,
  hub: () => null,
  relayHub: () => {
    throw new OriginError('no hub');
  },
  afterChange: async () => {
    synced++;
  },
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  ...over,
});

const printed = () => out.join('\n');

describe('origin forget', () => {
  it('needs a reason, shows what it will hide, and says how to restore it', async () => {
    expect(await cmdForget(ctx(), ['fake:e1'])).toBe(2);
    expect(await cmdForget(ctx(), ['fake:e1', '--reason', '  '])).toBe(2);
    expect(err.join('\n')).toContain('A reason is required');

    expect(await cmdForget(ctx(), ['fake:e1', '--reason', 'pasted a token'])).toBe(1);
    expect(printed()).toContain('This will hide 0 entries and 1 event');
    expect(printed()).toContain('fake:e1');
    expect(printed()).toContain('restore it later');
    expect(printed()).not.toContain('cannot be undone');
    expect(getEvent(db, 'fake:e1')).not.toBeNull();

    out = [];
    expect(await cmdForget(ctx(), ['fake:e1', '--reason', 'pasted a token', '--yes'])).toBe(0);
    expect(getEvent(db, 'fake:e1')).toBeNull();
    expect(printed()).toMatch(/To bring it back: origin restore tmb_[0-9a-f]{12} --reason/);
    expect(synced).toBe(1);
    const row = db
      .prepare(
        'SELECT t.reason, m.author FROM tombstone t JOIN tombstone_meta m ON m.tombstone_id = t.id',
      )
      .get();
    expect(row).toEqual({ reason: 'pasted a token', author: 'user@laptop' });
  });

  it('on a relay, is done on the hub with the reason', async () => {
    const relay = openDatabase(path.join(tmp, 'relay', 'origin.db'));
    makeRelay(relay);
    const asked: Array<[string, Record<string, unknown>]> = [];
    const relayCtx = ctx({
      db: relay,
      relayHub: () => ({ url: 'https://hub.example.com', token: 'ogn_x', device: 'laptop' }),
      ask: async (_hub, name, args) => {
        asked.push([name, args]);
        return { tombstone: 'tmb_0123456789ab', forgotten_entries: [], excluded_events: 1 };
      },
    });
    expect(await cmdForget(relayCtx, ['fake:e1', '--reason', 'secret', '--yes'])).toBe(0);
    expect(asked).toEqual([['forget', { id: 'fake:e1', reason: 'secret' }]]);
    await expect(cmdRestore(relayCtx, ['tmb_0123456789ab', '--reason', 'r'])).rejects.toThrow(
      /admin UI/,
    );
    expect(() => cmdForgotten(relayCtx, [])).toThrow(/admin UI/);
    relay.close();
  });
});

describe('origin restore and origin forgotten', () => {
  it('list the records, and bring back what a forget hid, with a reason', async () => {
    expect(cmdForgotten(ctx(), [])).toBe(0);
    expect(printed()).toBe('Nothing has been forgotten.');
    await cmdForget(ctx(), ['fake:e1', '--reason', 'pasted a token', '--yes']);
    const id = /tombstone (tmb_[0-9a-f]+)/.exec(printed())?.[1] ?? '';

    out = [];
    cmdForgotten(ctx(), []);
    expect(printed()).toContain(id);
    expect(printed()).toContain('in effect');
    expect(printed()).toContain('pasted a token');
    // Ids and reasons, never the text it hides.
    expect(printed()).not.toContain('ogn_secret');

    expect(await cmdRestore(ctx(), [id])).toBe(2);
    out = [];
    expect(await cmdRestore(ctx(), [id, '--reason', 'it was a test token'])).toBe(1);
    expect(printed()).toContain('brings back 0 entries and 1 event');
    expect(printed()).toContain('fake:e1');
    expect(getEvent(db, 'fake:e1')).toBeNull();

    out = [];
    expect(await cmdRestore(ctx(), [id, '--reason', 'it was a test token', '--yes'])).toBe(0);
    expect(getEvent(db, 'fake:e1')).not.toBeNull();
    expect(printed()).toMatch(/Restored tmb_[0-9a-f]+: brought back 0 entries and 1 event/);
    expect(synced).toBe(2);

    out = [];
    cmdForgotten(ctx(), []);
    expect(printed()).toMatch(/tmb_[0-9a-f]+\s+restore\s/);
    expect(printed()).toContain(`restored (tmb_`);
    expect(printed()).toContain('user@laptop');
    await expect(cmdRestore(ctx(), [id, '--reason', 'again', '--yes'])).rejects.toThrow(
      /already been restored/,
    );
  });

  it("logs again, on a hub's own store, the forgets whose coverage changes", async () => {
    const note = (events: string[], text: string) =>
      remember(db, {
        kind: 'knowledge',
        text,
        confidence: 1,
        author: 'claude-code@laptop',
        sources: events.map((eventId) => ({ eventId })),
      });
    const x = note(['fake:e1'], 'x');
    const y = note(['fake:e2'], 'y');
    note(['fake:e1', 'fake:e2'], 'z (rule 3 once both are hidden)');
    const fx = forget(db, x.id, { reason: 'r' });
    const fy = forget(db, y.id, { reason: 'r' });
    const logged = (id: string) =>
      db
        .prepare("SELECT origin FROM change_log WHERE kind = 'tombstone' AND id = ?")
        .all(id) as unknown as Array<{ origin: string }>;
    // z lost its last source when y was forgotten: that forget covers it (rule 3).
    expect(logged(fy.tombstoneId!)).toHaveLength(1);

    // A device's store: restoring x brings z back, and nothing is logged again.
    expect(await cmdRestore(ctx(), [fx.tombstoneId!, '--reason', 'r', '--yes'])).toBe(0);
    expect(logged(fy.tombstoneId!)).toHaveLength(1);

    // A hub's own store (it has issued tokens, and has no hub): forgetting x again takes z under
    // the new forget; restoring y brings z back, so the new forget covers less and is logged again.
    createToken(db, 'desk');
    const fx2 = forget(db, x.id, { reason: 'again' });
    expect(await cmdRestore(ctx(), [fy.tombstoneId!, '--reason', 'r', '--yes'])).toBe(0);
    expect(logged(fx2.tombstoneId!)).toEqual([{ origin: 'laptop' }, { origin: 'laptop' }]);
  });
});
