import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRemote,
  ConflictError,
  changesSince,
  type Database,
  getRecall,
  importedEntryId,
  importMemory,
  isPurgedId,
  isPurgedSession,
  openDatabase,
  PURGED_MARKER,
  purgedLookup,
  type RecallRecord,
  type ReplicaEntry,
  readMirrorLines,
  rebuildAuthorship,
  receiveEntry,
  receiveRecall,
  type SourceAdapter,
  syncSource,
  transaction,
  withPurgedLinesBlanked,
} from '../src/index.js';
import { fakeAdapter, line, mirrorText } from './helpers.js';

/**
 * What a purge removed stays out on arrival (store format 12). The purges here are made by hand,
 * as rows of `purge`, `purged`, and `purge_line`, and the events they delete are deleted the way a
 * purge deletes them, through guard_lift.
 */

let tmp: string;
let home: string;
let logs: string;
let db: Database;
let purges: number;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purged-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  purges = 0;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Removed = ['event' | 'entry' | 'session' | 'recall' | 'file', string, string];

/** Record a purge that removed `removed` (kind, scope, id) and blanked `lines`; returns its id. */
function addPurge(
  removed: Removed[],
  opts: { seqFloor?: number; lines?: Array<[number, number, number]> } = {},
): string {
  const id = `prg_${String(++purges).padStart(12, '0')}`;
  transaction(
    db,
    () => {
      db.prepare(
        `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts, seq_floor)
         VALUES (?, 1000, 'laptop', 'user@laptop', 'cli', 'pasted a secret', '{}', '{}', ?)`,
      ).run(id, opts.seqFloor ?? null);
      const add = db.prepare('INSERT INTO purged (kind, scope, id, purge_id) VALUES (?, ?, ?, ?)');
      for (const [kind, scope, item] of removed) add.run(kind, scope, item, id);
      const blank = db.prepare(
        'INSERT INTO purge_line (raw_file_id, first_line, line_count, purge_id) VALUES (?, ?, ?, ?)',
      );
      for (const [raw, first, count] of opts.lines ?? []) blank.run(raw, first, count, id);
    },
    { immediate: true },
  );
  return id;
}

/** Delete events as a purge does: inside one transaction that lifts the event guard. */
function deleteEvents(ids: string[]): void {
  transaction(
    db,
    () => {
      db.exec("INSERT INTO guard_lift (name) VALUES ('event')");
      try {
        for (const id of ids) {
          db.prepare(
            'DELETE FROM event_author WHERE seq = (SELECT seq FROM event WHERE id = ?)',
          ).run(id);
          db.prepare('DELETE FROM event WHERE id = ?').run(id);
        }
      } finally {
        db.exec('DELETE FROM guard_lift');
      }
    },
    { immediate: true },
  );
}

const eventIds = () =>
  (db.prepare('SELECT id FROM event ORDER BY seq').all() as Array<{ id: string }>).map((r) => r.id);

const rawFileId = (file: string) =>
  (db.prepare('SELECT id FROM raw_file WHERE path = ?').get(file) as { id: number }).id;

describe('a store without purges', () => {
  it('looks nothing up', () => {
    expect(purgedLookup(db).any).toBe(false);
    expect(purgedLookup(db).session('fake', 's1')).toBeNull();
  });
});

describe('new events after a purge', () => {
  it('never take the number of an event a purge deleted', async () => {
    const file = path.join(logs, 'a.jsonl');
    fs.writeFileSync(
      file,
      line('1', 's1', 1000, 'user', 'one') +
        line('2', 's1', 2000, 'user', 'two') +
        line('3', 's1', 3000, 'user', 'three'),
    );
    await syncSource({ db, home }, fakeAdapter(logs));
    // A reader has read every event so far.
    const read = changesSince(db, { after: { event: 0, change: 0 } }).next;
    expect(read.event).toBe(3);

    // A purge deletes the two newest events, which the reader has passed.
    addPurge(
      [
        ['event', '', 'fake:2'],
        ['event', '', 'fake:3'],
      ],
      { seqFloor: 3 },
    );
    deleteEvents(['fake:2', 'fake:3']);

    fs.appendFileSync(file, line('4', 's1', 4000, 'user', 'four'));
    await syncSource({ db, home }, fakeAdapter(logs));
    expect(db.prepare("SELECT seq FROM event WHERE id = 'fake:4'").get()).toEqual({ seq: 4 });
    expect(changesSince(db, { after: read }).events.map((e) => e.id)).toEqual(['fake:4']);
  });
});

describe('lines that hold what a purge removed', () => {
  it('are mirrored as spaces of the same length, and nothing is read from them', async () => {
    const file = path.join(logs, 'a.jsonl');
    const lines = [
      line('1', 's1', 1000, 'user', 'kept'),
      line('2', 's2', 2000, 'user', 'a secret in a purged session'),
      `${JSON.stringify({ session: 's2', title: 'The secret session' })}\n`,
      line('3', 's1', 3000, 'assistant', 'a purged event'),
      // A follow link to the purged session.
      line(
        '4',
        's1',
        4000,
        'assistant',
        '{"link": "lnk_0123456789ab", "follows": "fake:s2"}',
        'tool_result',
      ),
    ];
    fs.writeFileSync(file, lines.join(''));
    addPurge([
      ['session', 'fake', 's2'],
      ['event', '', 'fake:3'],
    ]);

    const r = await syncSource({ db, home }, fakeAdapter(logs));
    expect(r).toMatchObject({ linesRead: 5, eventsAdded: 2, parseErrors: 0, purged: 3 });
    expect(eventIds()).toEqual(['fake:1', 'fake:4']);
    expect(db.prepare("SELECT 1 FROM session WHERE session_id = 's2'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_follow').get()).toEqual({ n: 0 });
    const blank = (l: string) => `${' '.repeat(Buffer.byteLength(l) - 1)}\n`;
    const mirrored = mirrorText(db, home, rawFileId(file));
    expect(mirrored).toBe(
      [
        lines[0],
        blank(lines[1] as string),
        blank(lines[2] as string),
        blank(lines[3] as string),
        lines[4],
      ].join(''),
    );
    expect(Buffer.byteLength(mirrored)).toBe(fs.statSync(file).size);

    // What the session writes later stays out too.
    fs.appendFileSync(file, line('5', 's2', 5000, 'user', 'more of the secret'));
    const again = await syncSource({ db, home }, fakeAdapter(logs));
    expect(again).toMatchObject({ linesRead: 1, eventsAdded: 0, purged: 1 });
    expect(mirrorText(db, home, rawFileId(file))).not.toContain('secret');
  });

  it('leave a store without them as it was', async () => {
    fs.writeFileSync(path.join(logs, 'a.jsonl'), line('1', 's1', 1000, 'user', 'kept'));
    const r = await syncSource({ db, home }, fakeAdapter(logs));
    expect(r).not.toHaveProperty('purged');
  });

  it('are skipped when a purge replaced them with its marker', async () => {
    const file = path.join(logs, 'a.jsonl');
    const marker = `${PURGED_MARKER}"prg_000000000009","state":{}}`;
    fs.writeFileSync(
      file,
      `${line('1', 's1', 1000, 'user', 'kept')}${marker}${' '.repeat(20)}\n${'    '}\n`,
    );
    const r = await syncSource({ db, home }, fakeAdapter(logs));
    expect(r).toMatchObject({ linesRead: 1, eventsAdded: 1, parseErrors: 0 });
  });

  it('are blanked on a hub when a device sends them, at the length the device has', () => {
    addPurge([['session', 'fake', 's2']]);
    const data = Buffer.from(
      line('1', 's1', 1000, 'user', 'kept') + line('2', 's2', 2000, 'user', 'secret'),
    );
    const r = appendRemote({ db, home }, fakeAdapter(logs), {
      device: 'laptop',
      source: 'fake',
      path: '/home/me/a.jsonl',
      relPath: 'a.jsonl',
      generation: 1,
      offset: 0,
      data,
    });
    expect(r).toMatchObject({ ok: true, bytes: data.length, eventsAdded: 1, purged: 1 });
    const mirrored = mirrorText(db, home, rawFileId('@laptop:/home/me/a.jsonl'));
    expect(Buffer.byteLength(mirrored)).toBe(data.length);
    expect(mirrored).not.toContain('secret');
  });
});

describe('a file a purge blocked', () => {
  it('is never read again, on a device or on a hub', async () => {
    const file = path.join(logs, 'a.jsonl');
    fs.writeFileSync(file, line('1', 's1', 1000, 'user', 'kept'));
    addPurge([
      ['file', 'fake', file],
      ['file', 'fake', '@laptop:/home/me/a.jsonl'],
    ]);
    const r = await syncSource({ db, home }, fakeAdapter(logs));
    expect(r).toMatchObject({ filesChanged: 0, linesRead: 0 });
    expect(eventIds()).toEqual([]);

    const data = Buffer.from(line('2', 's2', 2000, 'user', 'sent anyway'));
    const pushed = appendRemote({ db, home }, fakeAdapter(logs), {
      device: 'laptop',
      source: 'fake',
      path: '/home/me/a.jsonl',
      relPath: 'a.jsonl',
      generation: 1,
      offset: 0,
      data,
    });
    expect(pushed).toMatchObject({ ok: true, bytes: data.length, eventsAdded: 0, purged: 1 });
    expect(mirrorText(db, home, rawFileId('@laptop:/home/me/a.jsonl')).trim()).toBe('');
  });

  it('is not asked for more when it is generated', async () => {
    const adapter: SourceAdapter = {
      ...fakeAdapter(logs),
      async discover() {
        return [
          {
            absPath: 'db#1',
            relPath: 'db/1.jsonl',
            generated: {
              token: 'changed',
              mtimeMs: 1,
              next: () => {
                throw new Error('a blocked source was asked for more');
              },
            },
          },
        ];
      },
    };
    addPurge([['file', 'fake', 'db#1']]);
    await expect(syncSource({ db, home }, adapter)).resolves.toMatchObject({ filesChanged: 0 });
  });
});

describe('a generated source whose last line a purge removed', () => {
  /** Rows of a database, each written out as one fake line with its number `n`. */
  let rows: Array<{
    n: number;
    id: string;
    session: string;
    ts: number;
    role: 'user';
    text: string;
  }>;
  /** The last line each call of next() went on from. */
  let asked: Array<string | null>;
  const row = (n: number, text: string) => ({
    n,
    id: String(n),
    session: 's1',
    ts: n * 1000,
    role: 'user' as const,
    text,
  });
  /** The source writes out the rows after the last line's `n`; a purge keeps `continuation`. */
  const generated = (continuation: SourceAdapter['continuation']): SourceAdapter => ({
    ...fakeAdapter(logs),
    async discover() {
      return [
        {
          absPath: 'db#1',
          relPath: 'db/1.jsonl',
          generated: {
            token: `rows:${rows.length}`,
            mtimeMs: 1,
            next(last) {
              asked.push(last);
              const after = last === null ? 0 : (JSON.parse(last) as { n: number }).n;
              return rows.filter((r) => r.n > after).map((r) => JSON.stringify(r));
            },
          },
        },
      ];
    },
    continuation,
  });

  beforeEach(() => {
    rows = [row(1, 'kept'), row(2, 'a purged row'), row(3, 'the last purged row')];
    asked = [];
  });

  it('goes on from the continuation the adapter gives, and writes nothing purged again', async () => {
    const adapter = generated((l) => ({ n: (JSON.parse(l) as { n: number }).n }));
    const prg = addPurge([
      ['event', '', 'fake:2'],
      ['event', '', 'fake:3'],
    ]);
    const r = await syncSource({ db, home }, adapter);
    expect(r).toMatchObject({ linesRead: 3, eventsAdded: 1, parseErrors: 0, purged: 2 });
    // A purged line within the batch is blanked; the last one holds where the source goes on.
    const lines = mirrorText(db, home, rawFileId('db#1')).split('\n');
    const written = rows.map((x) => JSON.stringify(x));
    expect(lines.slice(0, 2)).toEqual([written[0], ' '.repeat(written[1]!.length)]);
    expect(Buffer.byteLength(lines[2]!)).toBe(Buffer.byteLength(written[2]!));
    expect(lines[2]!.trimEnd()).toBe(`${PURGED_MARKER}"${prg}","n":3}`);
    expect(asked).toEqual([null, lines[2]]);

    rows.push(row(4, 'later'));
    const later = await syncSource({ db, home }, adapter);
    expect(later).toMatchObject({ linesRead: 1, eventsAdded: 1 });
    expect(later).not.toHaveProperty('purged');
    expect(asked.slice(2)).toEqual([lines[2], JSON.stringify(rows[3])]);
    expect(eventIds()).toEqual(['fake:1', 'fake:4']);
    expect(mirrorText(db, home, rawFileId('db#1'))).not.toContain('purged row');
  });

  it('ends a source it cannot go on from, rather than write again what was purged', async () => {
    // A continuation longer than the line it would replace does not fit.
    const adapter = generated(() => ({ n: 3, pad: 'x'.repeat(200) }));
    addPurge([['event', '', 'fake:3']]);
    const log: string[] = [];
    const r = await syncSource({ db, home, log: (m) => log.push(m) }, adapter);
    expect(r).toMatchObject({ linesRead: 3, eventsAdded: 2, purged: 1 });
    expect(mirrorText(db, home, rawFileId('db#1')).split('\n')[2]?.trim()).toBe('');
    expect(log).toContain(
      'warning db/1.jsonl: a purge removed its last line; nothing more is read',
    );
    expect(asked).toEqual([null]);

    rows.push(row(4, 'later'));
    expect(await syncSource({ db, home }, adapter)).toMatchObject({ linesRead: 0 });
    expect(asked).toEqual([null]);
    expect(eventIds()).toEqual(['fake:1', 'fake:2']);
  });
});

describe('parsing mirrored lines again', () => {
  it('brings back none of what a purge removed', async () => {
    fs.writeFileSync(
      path.join(logs, 'a.jsonl'),
      line('1', 's1', 1000, 'user', 'kept') + line('2', 's2', 2000, 'user', 'secret'),
    );
    await syncSource({ db, home }, fakeAdapter(logs));
    // The purge deleted the session's events; its mirror is not blanked yet.
    addPurge([['session', 'fake', 's2']]);
    deleteEvents(['fake:2']);
    rebuildAuthorship(db, { home, adapters: [fakeAdapter(logs)] });
    expect(eventIds()).toEqual(['fake:1']);
  });

  it('imports no version of a native memory a purge removed', async () => {
    fs.writeFileSync(path.join(logs, 'm.jsonl'), line('m1', 'mem', 1000, 'user', 'memory line'));
    await syncSource({ db, home }, fakeAdapter(logs));
    const memory = {
      eventId: 'm1',
      previous: null,
      at: 1000,
      entry: { kind: 'memory' as const, text: 'Use pnpm.', confidence: 0.9, project: null },
    };
    const ctx = { source: 'fake', device: 'laptop', growthOrigin: 'laptop' };
    addPurge([['entry', '', importedEntryId('fake:m1')]]);
    expect(transaction(db, () => importMemory(db, ctx, memory))).toBe(false);
  });
});

describe('what a device sends', () => {
  const entry = (over: Partial<ReplicaEntry>): ReplicaEntry => ({
    id: 'ent_00000000000a',
    kind: 'knowledge',
    text: 'Staging is called blue.',
    confidence: 1,
    author: 'user@laptop',
    project: null,
    supersedes: null,
    validFrom: null,
    validTo: null,
    createdAt: 5000,
    origin: 'laptop',
    sources: [],
    ...over,
  });

  it('is never stored when a purge removed it, what it corrects, or what it cites', async () => {
    fs.writeFileSync(path.join(logs, 'a.jsonl'), line('1', 's1', 1000, 'user', 'kept'));
    await syncSource({ db, home }, fakeAdapter(logs));
    const prg = addPurge([
      ['entry', '', 'ent_00000000000a'],
      ['entry', '', 'ent_00000000000b'],
      ['event', '', 'fake:9'],
    ]);
    const opts = { growthOrigin: 'hub' };
    expect(receiveEntry(db, entry({}), opts)).toEqual({ status: 'purged', purgeId: prg });
    expect(
      receiveEntry(db, entry({ id: 'ent_00000000000c', supersedes: 'ent_00000000000b' }), opts),
    ).toEqual({ status: 'purged', purgeId: prg });
    // Not `pending`: the event it cites never comes.
    expect(
      receiveEntry(
        db,
        entry({ id: 'ent_00000000000d', sources: [{ eventId: 'fake:9', quote: null }] }),
        opts,
      ),
    ).toEqual({ status: 'purged', purgeId: prg });
    expect(
      receiveEntry(
        db,
        entry({ id: 'ent_00000000000e', sources: [{ eventId: 'fake:1', quote: null }] }),
        opts,
      ),
    ).toEqual({ status: 'applied' });
    expect(db.prepare('SELECT id FROM entry').all()).toEqual([{ id: 'ent_00000000000e' }]);
  });

  it('keeps no recall item that names what a purge removed', () => {
    const recall = (over: Partial<RecallRecord> = {}): RecallRecord => ({
      id: 'rcl_000000000001',
      at: 1000,
      origin: 'laptop',
      source: 'fake',
      sessionId: 's1',
      occasion: 'prompt',
      project: null,
      cwd: null,
      promptHash: null,
      budget: 400,
      tokens: 60,
      items: [
        {
          rank: 1,
          layer: 'project',
          kind: 'entry',
          ref: 'ent_00000000000a',
          score: 1,
          tokens: 10,
          excerpt: null,
        },
        {
          rank: 2,
          layer: 'messages',
          kind: 'event',
          ref: 'fake:9',
          score: 1,
          tokens: 10,
          excerpt: 0,
        },
        {
          rank: 3,
          layer: 'sessions',
          kind: 'session',
          ref: 'fake:s2',
          score: null,
          tokens: 10,
          excerpt: null,
        },
        {
          rank: 4,
          layer: 'project',
          kind: 'entry',
          ref: 'ent_00000000000f',
          score: 1,
          tokens: 10,
          excerpt: null,
        },
      ],
      ...over,
    });
    // Stored before any purge, then a purge here took one of its items.
    expect(receiveRecall(db, recall())).toBe('applied');
    addPurge([
      ['entry', '', 'ent_00000000000a'],
      ['event', '', 'fake:9'],
      ['session', 'fake', 's2'],
      ['session', 'fake', 's3'],
      ['recall', '', 'rcl_000000000003'],
    ]);
    transaction(
      db,
      () => {
        db.exec("INSERT INTO guard_lift (name) VALUES ('recall_item')");
        db.exec("DELETE FROM recall_item WHERE ref IN ('ent_00000000000a', 'fake:9', 'fake:s2')");
        db.exec('DELETE FROM guard_lift');
      },
      { immediate: true },
    );
    // Sent again, as a device does until it hears back: not a conflict.
    expect(receiveRecall(db, recall())).toBe('exists');
    expect(() => receiveRecall(db, recall({ tokens: 61 }))).toThrow(ConflictError);

    // A new recall keeps only what a purge did not remove.
    expect(receiveRecall(db, recall({ id: 'rcl_000000000002' }))).toBe('applied');
    expect(getRecall(db, 'rcl_000000000002')?.items.map((i) => [i.rank, i.ref])).toEqual([
      [4, 'ent_00000000000f'],
    ]);
    // None at all from a purged session, or that a purge removed.
    expect(receiveRecall(db, recall({ id: 'rcl_000000000004', sessionId: 's3' }))).toBe('purged');
    expect(receiveRecall(db, recall({ id: 'rcl_000000000003' }))).toBe('purged');
    expect(getRecall(db, 'rcl_000000000003')).toBeNull();
  });
});

describe('a mirror a device pushes', () => {
  it('goes with the lines a purge blanked blank, in sealed frames and in the tail', async () => {
    const file = path.join(logs, 'a.jsonl');
    const lines = [1, 2, 3, 4, 5, 6].map((n) =>
      line(String(n), 's1', n * 1000, 'user', `line ${n} ${'x'.repeat(40)}`),
    );
    fs.writeFileSync(file, lines.slice(0, 4).join(''));
    // Small frames: the first lines are sealed, the last ones stay in the tail.
    await syncSource({ db, home, frameBytes: 100 }, fakeAdapter(logs));
    fs.appendFileSync(file, lines.slice(4).join(''));
    await syncSource({ db, home, frameBytes: 100_000 }, fakeAdapter(logs));
    const id = rawFileId(file);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM raw_chunk WHERE raw_file_id = ?').get(id),
    ).not.toEqual({
      n: 0,
    });
    const all = readMirrorLines(db, home, id, 0, 1 << 20);
    expect(withPurgedLinesBlanked(db, home, id, 0, all)).toBe(all);

    addPurge([], {
      lines: [
        [id, 2, 1],
        [id, 5, 1],
      ],
    });
    const blank = (l: string) => `${' '.repeat(Buffer.byteLength(l) - 1)}\n`;
    const expected = lines.map((l, i) => (i === 1 || i === 4 ? blank(l) : l));
    expect(withPurgedLinesBlanked(db, home, id, 0, all).toString()).toBe(expected.join(''));
    // From an offset inside the sealed frames, and from one in the tail.
    for (const from of [1, 3, 4]) {
      const offset = Buffer.byteLength(lines.slice(0, from).join(''));
      const data = readMirrorLines(db, home, id, offset, 1 << 20);
      expect(withPurgedLinesBlanked(db, home, id, offset, data).toString()).toBe(
        expected.slice(from).join(''),
      );
    }
  });
});

describe('places of a purged session', () => {
  it('are neither applied nor kept', async () => {
    fs.writeFileSync(path.join(logs, 'a.jsonl'), line('1', 's1', 1000, 'user', 'kept'));
    await syncSource({ db, home }, fakeAdapter(logs));
    addPurge([['session', 'fake', 's2']]);
    const placeLine = (session: string) =>
      JSON.stringify({ v: 1, type: 'place', session, project: 'demo', root: null, signal: 'git' });
    const remote = appendRemote({ db, home }, fakeAdapter(logs), {
      device: 'laptop',
      source: 'fake',
      path: 'places.jsonl',
      relPath: 'places.jsonl',
      generation: 1,
      offset: 0,
      data: Buffer.from(`${placeLine('s1')}\n${placeLine('s2')}\n`),
    });
    expect(remote).toMatchObject({ ok: true, purged: 1 });
    const placed = () =>
      (
        db.prepare('SELECT session_id FROM session_place ORDER BY session_id').all() as Array<{
          session_id: string;
        }>
      ).map((r) => r.session_id);
    expect(placed()).toEqual(['s1']);
    expect(mirrorText(db, home, rawFileId('@laptop:places.jsonl'))).not.toContain('s2');
  });
});

describe('purged.ts helpers', () => {
  it('reports a store purge by purge', () => {
    const prg = addPurge([
      ['session', 'fake', 's2'],
      ['event', '', 'fake:1'],
    ]);
    const purged = purgedLookup(db);
    expect(purged.any).toBe(true);
    expect(purged.session('fake', 's2')).toBe(prg);
    expect(purged.session('other', 's2')).toBeNull();
    expect(purged.event('fake:1')).toBe(prg);
    expect(purged.entry('fake:1')).toBeNull();
    // What a device's MCP server hides of its hub's answers.
    expect(isPurgedId(db, 'fake:1')).toBe(true);
    expect(isPurgedId(db, 'fake:2')).toBe(false);
    expect(isPurgedSession(db, 'fake', 's2')).toBe(true);
    expect(isPurgedSession(db, 'fake', 's1')).toBe(false);
  });
});
