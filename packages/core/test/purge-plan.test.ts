import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  correct,
  type Database,
  forget,
  ingestPlacesFile,
  initStoreName,
  insertRecall,
  openDatabase,
  type PurgeSelector,
  planPurge,
  remember,
  restore,
  type SourceAdapter,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

/**
 * Planning a purge: what a selector takes by the rules, and a preview that names ids and counts
 * but never the text it removes.
 */

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purge-plan-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'laptop');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * The fake source, where a line `{"block":[…]}` yields an event for each object in it, as an
 * agent's line with several content blocks does.
 */
function blockAdapter(root: string): SourceAdapter {
  const base = fakeAdapter(root);
  return {
    ...base,
    parseLine(l, ctx) {
      const o = JSON.parse(l) as { block?: unknown[] };
      if (!Array.isArray(o.block)) return base.parseLine(l, ctx);
      return {
        events: o.block.flatMap((b) => base.parseLine(JSON.stringify(b), ctx)?.events ?? []),
      };
    },
  };
}

const adapter = () => blockAdapter(logs);
const sync = () => syncSource({ db, home }, adapter());
const plan = (selector: PurgeSelector) => planPurge(db, home, [adapter()], selector);
const write = (file: string, text: string) => fs.appendFileSync(path.join(logs, file), text);
const block = (...events: string[]) =>
  `${JSON.stringify({ block: events.map((e) => JSON.parse(e)) })}\n`;
const rawFileId = (p: string, generation = 1) =>
  (
    db.prepare('SELECT id FROM raw_file WHERE path = ? AND generation = ?').get(p, generation) as {
      id: number;
    }
  ).id;
const note = (events: string[], text: string) =>
  remember(db, {
    kind: 'knowledge',
    text,
    confidence: 1,
    author: 'claude-code@laptop',
    sources: events.map((eventId) => ({ eventId })),
  });
const why = { reason: 'pasted a secret', author: 'user@laptop' };

describe('a plan', () => {
  it('names ids and counts, never text, and the same plan has the same digest', async () => {
    write(
      'a.jsonl',
      line('1', 's1', 1000, 'user', 'kept') + line('2', 's1', 2000, 'user', 'the-secret-token'),
    );
    await sync();
    const p = plan({ kind: 'event', ids: ['fake:2'] });
    expect(p.events).toEqual(['fake:2']);
    expect(p.files).toEqual([
      expect.objectContaining({
        rawFileId: rawFileId(path.join(logs, 'a.jsonl')),
        source: 'fake',
        lines: [[2, 1]],
        blocked: false,
        continued: false,
      }),
    ]);
    expect(p.counts).toMatchObject({ events: 1, closure: 0, mirrors: 1, lines: 1, sessions: 0 });
    expect(p.refusals).toEqual([]);
    expect(p.limits.length).toBeGreaterThan(0);
    expect(JSON.stringify(p)).not.toContain('the-secret-token');
    expect(p.digest).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(plan({ kind: 'event', ids: ['fake:2'] }).digest).toBe(p.digest);
    expect(plan({ kind: 'event', ids: ['fake:1'] }).digest).not.toBe(p.digest);
  });

  it('refuses a selector that names nothing on this store', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'kept'));
    await sync();
    expect(() => plan({ kind: 'event', ids: ['fake:9'] })).toThrow(/Unknown event fake:9/);
    expect(() => plan({ kind: 'event', ids: [] })).toThrow(/at least one event/);
    expect(() => plan({ kind: 'session', source: 'fake', sessionId: 's9' })).toThrow(
      /Unknown session/,
    );
    expect(() => plan({ kind: 'entry', id: 'ent_000000000000' })).toThrow(/Unknown entry/);
    expect(() => plan({ kind: 'recall', id: 'rcl_000000000000' })).toThrow(/Unknown recall/);
    expect(() => plan({ kind: 'forgotten', tombstone: 'tmb_000000000000' })).toThrow(
      /Unknown forget/,
    );
    expect(() => plan({ kind: 'lines', source: 'other' })).toThrow(/No mirrored file/);
    expect(() => plan({ kind: 'nothing' } as unknown as PurgeSelector)).toThrow(/Unknown kind/);
  });

  it('needs the adapters of the mirrors it parses', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'kept'));
    await sync();
    expect(() => planPurge(db, home, [], { kind: 'event', ids: ['fake:1'] })).toThrow(
      /needs the fake adapter/,
    );
  });
});

describe('line closure (P0)', () => {
  it('takes every event of a purged line, and the line where a later generation has it again', async () => {
    const file = path.join(logs, 'a.jsonl');
    const one = line('1', 's1', 1000, 'user', 'first');
    const pair = block(
      line('2', 's1', 2000, 'assistant', 'text'),
      line('3', 's1', 2000, 'assistant', 'tool'),
    );
    fs.writeFileSync(file, one + pair);
    await sync();
    // The agent rewrites the file: a new generation, with the same line again.
    fs.writeFileSync(file, line('0', 's1', 500, 'user', 'a new beginning, longer') + pair);
    await sync();
    expect(rawFileId(file, 2)).toBeGreaterThan(rawFileId(file, 1));

    const p = plan({ kind: 'event', ids: ['fake:2'] });
    expect(p.events).toEqual(['fake:2', 'fake:3']);
    expect(p.closure).toEqual(['fake:3']);
    expect(p.files.map((f) => [f.generation, f.lines])).toEqual([
      [1, [[2, 1]]],
      [2, [[2, 1]]],
    ]);
    expect(p.warnings).toContainEqual(expect.objectContaining({ code: 'closure', count: 1 }));
  });

  it('takes the lines a hub stored again because a writer sent them twice', () => {
    const data = Buffer.from(
      line('1', 's1', 1000, 'user', 'kept') + line('2', 's1', 2000, 'user', 'secret'),
    );
    const send = (generation: number, offset: number) =>
      appendRemote({ db, home }, adapter(), {
        device: 'phone',
        source: 'fake',
        path: '/home/me/a.jsonl',
        relPath: 'a.jsonl',
        generation,
        offset,
        data,
      });
    send(1, 0);
    // The writer sends the same lines again: after them, and as a new generation of the file.
    send(1, data.length);
    send(2, 0);
    const p = plan({ kind: 'event', ids: ['fake:2'] });
    expect(p.files.map((f) => [f.path, f.generation, f.lines])).toEqual([
      [
        '@phone:/home/me/a.jsonl',
        1,
        [
          [2, 1],
          [4, 1],
        ],
      ],
      ['@phone:/home/me/a.jsonl', 2, [[2, 1]]],
    ]);
  });
});

describe('entries (P1, P2)', () => {
  it('takes a whole chain, every version, and the chains that cite a purged event', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one') + line('2', 's1', 2000, 'user', 'two'));
    await sync();
    const a = note(['fake:1'], 'first note');
    const a2 = correct(db, a.id, { text: 'first note, corrected', author: 'user@laptop' });
    const b = note(['fake:2'], 'second note');

    const byEntry = plan({ kind: 'entry', id: a2.id });
    expect(byEntry.entries).toEqual([a.id, a2.id].sort());
    expect(byEntry.chains).toEqual([a.id]);
    expect(byEntry.events).toEqual([]);
    expect(byEntry.files).toEqual([]);
    expect(byEntry.warnings.map((w) => w.code)).not.toContain('chains');

    const byEvent = plan({ kind: 'event', ids: ['fake:2'] });
    expect(byEvent.entries).toEqual([b.id]);
    expect(byEvent.warnings).toContainEqual(expect.objectContaining({ code: 'chains', count: 1 }));
  });
});

describe('sessions (P3)', () => {
  it('takes its events, children, recalls, titles, and only its lines of a shared file', async () => {
    write(
      's1.jsonl',
      line('1', 's1', 1000, 'user', 'parent') +
        `${JSON.stringify({ session: 's1', title: 'A title' })}\n`,
    );
    write(
      'kid.jsonl',
      `${JSON.stringify({ id: 'k1', session: 'kid', ts: 1500, role: 'assistant', text: 'child', parents: [{ session: 'kid', parent: 's1' }] })}\n`,
    );
    write(
      'mixed.jsonl',
      line('m1', 's1', 1100, 'user', 'here') + line('m2', 's2', 1200, 'user', 'other'),
    );
    await sync();
    await ingestPlacesFile({ db, home }, 'fake', {
      absPath: 'places.jsonl',
      relPath: 'places.jsonl',
      generated: {
        token: 't1',
        mtimeMs: 1,
        next: (last) =>
          last
            ? []
            : [
                '{"v":1,"type":"place","session":"s1","project":"demo","root":null,"signal":"git"}',
                '{"v":1,"type":"place","session":"s2","project":"demo","root":null,"signal":"git"}',
              ],
      },
    });
    insertRecall(db, {
      id: 'rcl_00000000000a',
      at: 2000,
      origin: 'laptop',
      source: 'fake',
      sessionId: 's1',
      occasion: 'start',
      project: 'demo',
      cwd: null,
      promptHash: null,
      budget: 100,
      tokens: 10,
      items: [],
    });

    const p = plan({ kind: 'session', source: 'fake', sessionId: 's1' });
    expect(p.sessions).toEqual([
      { source: 'fake', sessionId: 'kid' },
      { source: 'fake', sessionId: 's1' },
    ]);
    expect(p.events).toEqual(['fake:1', 'fake:k1', 'fake:m1']);
    expect(p.closure).toEqual([]);
    expect(p.recalls).toEqual(['rcl_00000000000a']);
    const byPath = Object.fromEntries(p.files.map((f) => [path.basename(f.path), f]));
    expect(byPath['s1.jsonl']).toMatchObject({ lines: [[1, 2]], blocked: true });
    expect(byPath['kid.jsonl']).toMatchObject({ lines: [[1, 1]], blocked: true });
    expect(byPath['mixed.jsonl']).toMatchObject({ lines: [[1, 1]], blocked: false });
    expect(byPath['places.jsonl']).toMatchObject({ lines: [[1, 1]], blocked: false });
    expect(p.counts).toMatchObject({ sessions: 2, recalls: 1, files: 2, mirrors: 4, lines: 5 });

    const kept = plan({ kind: 'session', source: 'fake', sessionId: 's1', keepChildren: true });
    expect(kept.sessions).toEqual([{ source: 'fake', sessionId: 's1' }]);
    expect(kept.events).toEqual(['fake:1', 'fake:m1']);
  });
});

describe('proposals (P4)', () => {
  it('takes the event of a proposal that loses every source it cites', async () => {
    write('s1.jsonl', line('m1', 's1', 1000, 'user', 'We always deploy from main.'));
    const proposal = JSON.stringify({
      proposal: 'prp_0123456789ab',
      kind: 'knowledge',
      text: 'Deploys go from main.',
      confidence: 0.8,
      project: 'demo',
      valid_from: null,
      valid_to: null,
      note: null,
      sources: [{ event_id: 'fake:m1', quote: 'deploy from main' }],
    });
    write('s2.jsonl', line('p1', 's2', 2000, 'user', proposal, 'tool_result'));
    await sync();
    expect(db.prepare('SELECT event_id FROM proposal').all()).toEqual([{ event_id: 'fake:p1' }]);
    const p = plan({ kind: 'event', ids: ['fake:m1'] });
    expect(p.events).toEqual(['fake:m1', 'fake:p1']);
    expect(p.proposals).toEqual(['prp_0123456789ab']);
  });
});

describe('forgotten (P5)', () => {
  it('takes what a forget in effect covers, and refuses one that was restored', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one') + line('2', 's1', 2000, 'user', 'two'));
    await sync();
    const e = note(['fake:1'], 'a note');
    const f = forget(db, 'fake:2', why);
    const p = plan({ kind: 'forgotten', tombstone: f.tombstoneId as string });
    expect(p.events).toEqual(['fake:2']);
    expect(p.tombstones).toEqual([f.tombstoneId]);
    expect(p.warnings.map((w) => w.code)).not.toContain('visible');

    const g = forget(db, e.id, why);
    // Forgetting an entry hides the events it cites too.
    const all = plan({ kind: 'forgotten', tombstone: 'all' });
    expect(all.events).toEqual(['fake:1', 'fake:2']);
    expect(all.entries).toEqual([e.id]);
    expect(all.tombstones.sort()).toEqual([f.tombstoneId, g.tombstoneId].sort());

    restore(db, f.tombstoneId as string, { reason: 'it was fine', author: 'user@laptop' });
    expect(() => plan({ kind: 'forgotten', tombstone: f.tombstoneId as string })).toThrow(
      /has been restored/,
    );
  });

  it('warns of events it takes that are not forgotten', async () => {
    write(
      'a.jsonl',
      block(line('1', 's1', 1000, 'user', 'shown'), line('2', 's1', 1000, 'user', 'hidden')),
    );
    await sync();
    const f = forget(db, 'fake:2', why);
    const p = plan({ kind: 'forgotten', tombstone: f.tombstoneId as string });
    expect(p.events).toEqual(['fake:1', 'fake:2']);
    expect(p.warnings).toContainEqual(expect.objectContaining({ code: 'visible', count: 1 }));
  });
});

describe('recall items (P6)', () => {
  it('are removed where a recall that stays names what is purged', async () => {
    write('a.jsonl', line('1', 's1', 1000, 'user', 'one'));
    write('b.jsonl', line('2', 's2', 1000, 'user', 'two'));
    await sync();
    const item = (rank: number, kind: 'entry' | 'session' | 'event', ref: string) => ({
      rank,
      layer: kind === 'event' ? ('messages' as const) : ('sessions' as const),
      kind,
      ref,
      score: null,
      tokens: 5,
      excerpt: null,
    });
    insertRecall(db, {
      id: 'rcl_00000000000b',
      at: 3000,
      origin: 'laptop',
      source: 'fake',
      sessionId: 's2',
      occasion: 'start',
      project: 'demo',
      cwd: null,
      promptHash: null,
      budget: 100,
      tokens: 15,
      items: [
        item(1, 'session', 'fake:s1'),
        item(2, 'event', 'fake:1'),
        item(3, 'session', 'fake:s2'),
      ],
    });
    const p = plan({ kind: 'session', source: 'fake', sessionId: 's1' });
    expect(p.recalls).toEqual([]);
    expect(p.recallItems).toEqual([
      { recall: 'rcl_00000000000b', rank: 1 },
      { recall: 'rcl_00000000000b', rank: 2 },
    ]);
  });
});

describe('lines', () => {
  it('takes a range of a file, lines between two times, or the lines that do not parse', async () => {
    write(
      'a.jsonl',
      line('1', 's1', 1000, 'user', 'one') +
        'not json at all\n' +
        line('2', 's1', 2000, 'user', 'two') +
        line('3', 's1', 3000, 'user', 'three'),
    );
    await sync();
    const id = rawFileId(path.join(logs, 'a.jsonl'));
    const range = plan({ kind: 'lines', source: 'fake', file: id, lines: { first: 2, last: 3 } });
    expect(range.files[0]?.lines).toEqual([[2, 2]]);
    expect(range.events).toEqual(['fake:2']);

    const timed = plan({ kind: 'lines', source: 'fake', since: 2000, until: 3000 });
    expect(timed.events).toEqual(['fake:2']);

    const unparsed = plan({ kind: 'lines', source: 'fake', file: id, unparsed: true });
    expect(unparsed.files[0]?.lines).toEqual([[2, 1]]);
    expect(unparsed.events).toEqual([]);

    expect(() => plan({ kind: 'lines', source: 'fake', unparsed: true })).toThrow(/one raw file/);
    expect(() => plan({ kind: 'lines', source: 'fake', lines: { first: 1, last: 1 } })).toThrow(
      /needs the raw file/,
    );
    const all = plan({ kind: 'lines', source: 'fake', path: path.join(logs, 'a.jsonl') });
    expect(all.files[0]?.lines).toEqual([[1, 4]]);
    expect(all.files[0]?.blocked).toBe(false);
  });

  it('takes what a device sent, by its name', () => {
    appendRemote({ db, home }, adapter(), {
      device: 'phone',
      source: 'fake',
      path: '/p/a.jsonl',
      relPath: 'a.jsonl',
      generation: 1,
      offset: 0,
      data: Buffer.from(line('1', 's1', 1000, 'user', 'from the phone')),
    });
    write('b.jsonl', line('2', 's2', 1000, 'user', 'mine'));
    return sync().then(() => {
      const p = plan({ kind: 'lines', source: 'fake', from: 'phone' });
      expect(p.events).toEqual(['fake:1']);
      expect(p.files.map((f) => f.path)).toEqual(['@phone:/p/a.jsonl']);
    });
  });
});

describe('a generated source', () => {
  const rows = [1, 2, 3].map((n) => ({
    n,
    id: String(n),
    session: 's1',
    ts: n * 1000,
    role: 'user',
    text: `row number ${n} of the stream`,
  }));
  const generated = (continuation: SourceAdapter['continuation']): SourceAdapter => ({
    ...adapter(),
    async discover() {
      return [
        {
          absPath: 'db#1',
          relPath: 'db/1.jsonl',
          generated: {
            token: 'rows:3',
            mtimeMs: 1,
            next: (last) => (last === null ? rows.map((r) => JSON.stringify(r)) : []),
          },
        },
      ];
    },
    continuation,
  });

  it('goes on from its last line when it is purged, or the plan is refused', async () => {
    const fits = generated((l) => ({ n: (JSON.parse(l) as { n: number }).n }));
    await syncSource({ db, home }, fits);
    const p = planPurge(db, home, [fits], { kind: 'event', ids: ['fake:3'] });
    expect(p.files[0]).toMatchObject({ lines: [[3, 1]], continued: true, blocked: false });
    expect(p.refusals).toEqual([]);
    // Not the last line: simply blanked.
    expect(planPurge(db, home, [fits], { kind: 'event', ids: ['fake:2'] }).files[0]).toMatchObject({
      continued: false,
    });

    const long = generated(() => ({ n: 3, pad: 'x'.repeat(200) }));
    const refused = planPurge(db, home, [long], { kind: 'event', ids: ['fake:3'] });
    expect(refused.refusals).toHaveLength(1);
    expect(refused.warnings).toContainEqual(
      expect.objectContaining({ code: 'no-continuation', count: 1 }),
    );
  });

  it('is not blocked when every session in it is purged, unless it is named after one', async () => {
    const fits = generated((l) => ({ n: (JSON.parse(l) as { n: number }).n }));
    await syncSource({ db, home }, fits);
    const p = planPurge(db, home, [fits], { kind: 'session', source: 'fake', sessionId: 's1' });
    expect(p.files[0]).toMatchObject({ lines: [[1, 3]], blocked: false, continued: true });
  });
});
