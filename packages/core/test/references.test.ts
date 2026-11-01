import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CARD_PROMPTS,
  correct,
  currentEntriesCiting,
  type Database,
  describeSession,
  type Entry,
  entriesOfSession,
  eventContext,
  findSession,
  forget,
  getEvent,
  getSession,
  insertRecall,
  openDatabase,
  readSession,
  relatedEntries,
  remember,
  resolveId,
  sessionNames,
  sessionTurnStarts,
  stubText,
  syncSource,
  transaction,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let home: string;
let src: string;
let db: Database;

/** A line of the fake source with a parent event, as Claude Code records one. */
const reply = (id: string, session: string, ts: number, text: string, parent: string) =>
  `${JSON.stringify({ id, session, ts, role: 'assistant', text, parent })}\n`;

const ids = (items: Array<{ id: string }>) => items.map((x) => x.id);

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
  fs.writeFileSync(
    path.join(src, 's0.jsonl'),
    line('a1', 's0', 1000, 'user', 'Plan the cache layer') +
      line('a2', 's0', 1100, 'assistant', 'Plan ready.'),
  );
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('b1', 's1', 2000, 'user', 'Add an LRU cache to the API client') +
      line('b2', 's1', 2010, 'assistant', 'Reading the client first.') +
      line('b3', 's1', 2020, 'assistant', 'Read src/client.ts', 'tool_use') +
      line('b4', 's1', 2030, 'user', 'export class Client {}', 'tool_result') +
      line('b5', 's1', 2040, 'assistant', 'The cache wraps fetch; done.') +
      line('b6', 's1', 3000, 'user', 'Now make the TTL configurable') +
      reply('b7', 's1', 3010, 'TTL is an option now.', 'b6'),
  );
  fs.writeFileSync(
    path.join(src, 's2.jsonl'),
    line('c1', 's2', 4000, 'user', 'Document the cache options'),
  );
  fs.writeFileSync(
    path.join(src, 'sx.jsonl'),
    `${JSON.stringify({ id: 'x1', session: 'sx', ts: 2500, role: 'user', text: 'Unrelated work', project: 'other' })}\n`,
  );
  await syncSource({ db, home }, fakeAdapter(src));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

/** Entries are written a second apart, so that newest first is a stable order. */
let clock = 1_000_000;
const tick = () => {
  clock += 1000;
  return clock;
};
const note = (text: string, eventId: string): Entry =>
  remember(
    db,
    {
      kind: 'memory',
      text,
      confidence: 0.9,
      author: 'test',
      project: 'demo',
      sources: [{ eventId }],
    },
    tick(),
  );

/** A recall the session was handed, as a hook records it. */
function handed(id: string, at: number, refs: string[]): void {
  transaction(
    db,
    () =>
      insertRecall(db, {
        id,
        at,
        origin: 'laptop',
        source: 'fake',
        sessionId: 's1',
        occasion: 'prompt',
        project: 'demo',
        cwd: null,
        promptHash: null,
        budget: 400,
        tokens: 60,
        items: refs.map((ref, i) => ({
          rank: i + 1,
          layer: 'prompt',
          kind: 'entry',
          ref,
          score: 1,
          tokens: 20,
        })),
      }),
    { immediate: true },
  );
}

describe('opening ids', () => {
  it('tells entries, recalls, events, and sessions apart', () => {
    expect(resolveId(db, 'ent_0123456789ab')).toEqual({ kind: 'entry', id: 'ent_0123456789ab' });
    expect(resolveId(db, 'rcl_0123456789ab')).toEqual({ kind: 'recall', id: 'rcl_0123456789ab' });
    expect(resolveId(db, 'fake:b1')).toEqual({ kind: 'event', id: 'fake:b1' });
    // A session by its id alone, or as recalls record it, `<source>:<session id>`.
    expect(resolveId(db, 's1')).toMatchObject({ kind: 'session', session: { sessionId: 's1' } });
    expect(resolveId(db, 'fake:s1')).toMatchObject({
      kind: 'session',
      session: { source: 'fake' },
    });
    expect(resolveId(db, 'fake:nope')).toBeNull();
    expect(resolveId(db, 'nope')).toBeNull();
    // A forgotten event is still an event, so that it is reported as forgotten.
    forget(db, 'fake:a2', { reason: 'test' });
    expect(resolveId(db, 'fake:a2')).toEqual({ kind: 'event', id: 'fake:a2' });
  });

  it('asks for the source of a session id that two sources have', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
    try {
      fs.writeFileSync(path.join(other, 's1.jsonl'), line('z1', 's1', 9000, 'user', 'Elsewhere'));
      await syncSource({ db, home }, { ...fakeAdapter(other), id: 'twin' });
      expect(() => findSession(db, 's1')).toThrow(/more than one source \(fake, twin\)/);
      expect(() => resolveId(db, 's1')).toThrow(/pass `source`/);
      expect(findSession(db, 's1', 'twin')).toMatchObject({ source: 'twin', eventCount: 1 });
      expect(resolveId(db, 's1', 'fake')).toMatchObject({ session: { source: 'fake' } });
      expect(resolveId(db, 'twin:s1')).toMatchObject({ session: { source: 'twin' } });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('what is next to an event', () => {
  it('names its session, its turn, the messages around it, and the entries citing it', () => {
    const cited = note('The API client caches with an LRU.', 'fake:b5');
    const event = getEvent(db, 'fake:b5')!;
    const ctx = eventContext(db, event);
    expect(ctx.session).toMatchObject({
      sessionId: 's1',
      prompt: 'Add an LRU cache to the API client',
    });
    expect(ctx.turn).toMatchObject({ number: 1, start: { id: 'fake:b1' } });
    // A message's neighbours are messages; the tool events between them are left out.
    expect(ids(ctx.before)).toEqual(['fake:b1', 'fake:b2']);
    expect(ids(ctx.after)).toEqual(['fake:b6', 'fake:b7']);
    expect(ids(ctx.citedBy)).toEqual([cited.id]);
    expect(ctx.repliesTo).toBeNull();
  });

  it("lists any kind around a tool event, and the event an agent's line follows", () => {
    const tool = eventContext(db, getEvent(db, 'fake:b3')!);
    expect(ids(tool.before)).toEqual(['fake:b1', 'fake:b2']);
    expect(ids(tool.after)).toEqual(['fake:b4', 'fake:b5']);
    const answer = eventContext(db, getEvent(db, 'fake:b7')!);
    expect(answer.repliesTo?.id).toBe('fake:b6');
    expect(answer.turn).toMatchObject({ number: 2, start: { id: 'fake:b6' } });
    expect(ids(answer.after)).toEqual([]);
  });
});

describe('a session as a card', () => {
  it('lists its turns, the entries written from it, its recalls, and its neighbours', () => {
    const first = note('Cache the API client with an LRU.', 'fake:b1');
    const ttl = note('The cache TTL is configurable.', 'fake:b6');
    const elsewhere = note('Plan first.', 'fake:a1');
    handed('rcl_000000000001', 2005, [elsewhere.id]);
    handed('rcl_000000000002', 3005, [first.id, ttl.id]);
    handed('rcl_000000000003', 3006, []);
    const card = describeSession(db, getSession(db, 'fake', 's1')!);
    expect(card.turns).toBe(2);
    expect(card.prompts.map((p) => [p.turn, p.id, p.prompt])).toEqual([
      [1, 'fake:b1', 'Add an LRU cache to the API client'],
      [2, 'fake:b6', 'Now make the TTL configurable'],
    ]);
    expect(card.morePrompts).toBe(0);
    expect(ids(card.entries)).toEqual([ttl.id, first.id]);
    // Newest first; a recall that handed nothing over is left out.
    expect(card.recalls.map((r) => [r.recall.id, r.items])).toEqual([
      ['rcl_000000000002', 2],
      ['rcl_000000000001', 1],
    ]);
    // The sessions before and after it in its project, of any agent; another project's are not.
    expect(card.before?.sessionId).toBe('s0');
    expect(card.after?.sessionId).toBe('s2');
    expect(describeSession(db, getSession(db, 'fake', 's0')!).before).toBeNull();
  });

  it('lists the first turns of a long session, and says how many more there are', async () => {
    const lines = Array.from({ length: CARD_PROMPTS + 3 }, (_, i) =>
      line(`p${i}`, 'long', 10_000 + i, 'user', `Prompt number ${i + 1}`),
    );
    fs.writeFileSync(path.join(src, 'long.jsonl'), lines.join(''));
    await syncSource({ db, home }, fakeAdapter(src));
    const card = describeSession(db, getSession(db, 'fake', 'long')!);
    expect(card.turns).toBe(CARD_PROMPTS + 3);
    expect(card.prompts).toHaveLength(CARD_PROMPTS);
    expect(card.prompts.at(-1)?.turn).toBe(CARD_PROMPTS);
    expect(card.morePrompts).toBe(3);
  });

  it('names related entries: current ones from the same sessions, never its own versions', () => {
    const first = note('Cache the API client with an LRU.', 'fake:b1');
    const ttl = note('The cache TTL is configurable.', 'fake:b6');
    note('Plan first.', 'fake:a1');
    const fixed = correct(
      db,
      ttl.id,
      { text: 'The cache TTL is an option.', author: 'test' },
      tick(),
    );
    expect(ids(relatedEntries(db, first.id))).toEqual([fixed.id]);
    expect(ids(relatedEntries(db, fixed.id))).toEqual([first.id]);
    expect(ids(relatedEntries(db, ttl.id))).toEqual([first.id]);
    expect(ids(entriesOfSession(db, 'fake', 's1'))).toEqual([fixed.id, first.id]);
    expect(ids(currentEntriesCiting(db, 'fake:b6'))).toEqual([fixed.id]);
    // An entry whose validity has ended is history, not a neighbour.
    remember(db, {
      kind: 'knowledge',
      text: 'An old fact.',
      confidence: 0.5,
      author: 'test',
      validTo: 1,
      sources: [{ eventId: 'fake:b2' }],
    });
    expect(ids(entriesOfSession(db, 'fake', 's1'))).toEqual([fixed.id, first.id]);
  });
});

describe('reading a session in pages', () => {
  const page = (o: { turn?: number; after?: string; limit?: number; tools?: boolean }) => {
    const r = readSession(db, {
      source: 'fake',
      sessionId: 's1',
      kinds: o.tools ? undefined : ['message'],
      turn: o.turn,
      after: o.after,
      limit: o.limit,
    });
    return { events: ids(r.events), more: r.more };
  };

  it('pages after an event, says how many follow, and reads one turn', () => {
    expect(page({ limit: 2 })).toEqual({ events: ['fake:b1', 'fake:b2'], more: 3 });
    expect(page({ after: 'fake:b2', limit: 2 })).toEqual({
      events: ['fake:b5', 'fake:b6'],
      more: 1,
    });
    expect(page({ after: 'fake:b6' })).toEqual({ events: ['fake:b7'], more: 0 });
    expect(page({ turn: 1 })).toEqual({ events: ['fake:b1', 'fake:b2', 'fake:b5'], more: 0 });
    expect(page({ turn: 1, tools: true, limit: 3 })).toEqual({
      events: ['fake:b1', 'fake:b2', 'fake:b3'],
      more: 2,
    });
    expect(page({ turn: 2, after: 'fake:b6' })).toEqual({ events: ['fake:b7'], more: 0 });
    expect(page({ turn: 0 })).toEqual({ events: [], more: 0 });
    expect(() => page({ turn: 3 })).toThrow('Session s1 has 2 turns');
    expect(() => page({ after: 'fake:a1' })).toThrow('Event fake:a1 is not in session s1.');
  });
});

describe('forgetting and the neighbours of what remains', () => {
  it('leaves what was forgotten out of every list and count (invariant 2)', () => {
    const first = note('Cache the API client with an LRU.', 'fake:b1');
    const ttl = note('The cache TTL is configurable.', 'fake:b6');
    const done = note('The cache wraps fetch.', 'fake:b5');
    handed('rcl_000000000001', 3005, [ttl.id]);
    expect(ids(relatedEntries(db, done.id))).toEqual([ttl.id, first.id]);

    // An event: gone from around its neighbours, from the turns it started, and from the pages.
    forget(db, 'fake:b2', { reason: 'test' });
    expect(ids(eventContext(db, getEvent(db, 'fake:b5')!).before)).toEqual(['fake:b1']);
    expect(
      readSession(db, { source: 'fake', sessionId: 's1', kinds: ['message'] }).events,
    ).toHaveLength(4);
    expect(() => readSession(db, { source: 'fake', sessionId: 's1', after: 'fake:b2' })).toThrow(
      'fake:b2 has been forgotten.',
    );

    // The prompt of turn 2, and the entry that cites only it (rule 3): its turn, its recall, and
    // the entry leave the card, the related entries, and the event's own neighbours.
    forget(db, 'fake:b6', { reason: 'test' });
    const card = describeSession(db, getSession(db, 'fake', 's1')!);
    expect(card.turns).toBe(1);
    expect(ids(card.prompts)).toEqual(['fake:b1']);
    expect(ids(card.entries)).toEqual([done.id, first.id]);
    expect(card.recalls).toEqual([]);
    expect(card.session.eventCount).toBe(5);
    const answer = eventContext(db, getEvent(db, 'fake:b7')!);
    expect(answer.repliesTo).toBeNull();
    expect(answer.turn).toMatchObject({ number: 1, start: { id: 'fake:b1' } });
    expect(ids(answer.before)).toEqual(['fake:b1', 'fake:b5']);
    expect(ids(relatedEntries(db, done.id))).toEqual([first.id]);

    // An entry: with the event it cites (rule 1), out of the card and every list.
    forget(db, first.id, { reason: 'test' });
    expect(ids(describeSession(db, getSession(db, 'fake', 's1')!).entries)).toEqual([done.id]);
    expect(ids(currentEntriesCiting(db, 'fake:b1'))).toEqual([]);
    expect(eventContext(db, getEvent(db, 'fake:b5')!).turn).toBeNull();
    expect(sessionTurnStarts(db, 'fake', 's1')).toEqual([]);
    expect(ids(relatedEntries(db, done.id))).toEqual([]);
  });
});

describe('imported memories', () => {
  it('relate only through the very version they cite, and are no session', async () => {
    // A memory stream holds every memory file of a directory, under one session id.
    fs.writeFileSync(
      path.join(src, 'memory.jsonl'),
      line('m1', 'memory/demo', 1500, 'user', '# Cache\nUse an LRU.', 'memory') +
        line('m2', 'memory/demo', 1501, 'user', '# Deploy\nShip on Fridays.', 'memory') +
        line('m3', 'memory/demo', 1502, 'user', '# Style\nKeep commits short.', 'memory'),
    );
    await syncSource({ db, home }, fakeAdapter(src));
    const cache = note('Use an LRU for the cache.', 'fake:m1');
    note('Ship on Fridays.', 'fake:m2');
    note('Keep commits short.', 'fake:m3');
    expect(ids(relatedEntries(db, cache.id))).toEqual([]);
    const same = note('The cache is an LRU, as its memory file says.', 'fake:m1');
    expect(ids(relatedEntries(db, cache.id))).toEqual([same.id]);

    // Entries written from a session are unaffected.
    const first = note('Cache the API client with an LRU.', 'fake:b1');
    const done = note('The cache wraps fetch.', 'fake:b5');
    expect(ids(relatedEntries(db, first.id))).toEqual([done.id]);

    // A memory stream is no session: it is not opened, named, or listed next to one.
    expect(getSession(db, 'fake', 'memory/demo')).toBeNull();
    expect(resolveId(db, 'memory/demo')).toBeNull();
    expect(resolveId(db, 'fake:memory/demo')).toBeNull();
    expect(sessionNames(db, [{ source: 'fake', sessionId: 'memory/demo' }]).size).toBe(0);
    const card = describeSession(db, getSession(db, 'fake', 's1')!);
    expect(card.before?.sessionId).toBe('s0');
    expect(ids(card.entries)).toEqual([done.id, first.id]);
    expect(describeSession(db, getSession(db, 'fake', 's0')!).after?.sessionId).toBe('s1');
  });
});

describe('stubs and names', () => {
  it('cut text to one short line', () => {
    expect(stubText('  two\n\nlines  ')).toBe('two lines');
    const long = stubText('word '.repeat(100), 20);
    expect([...long]).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
    expect(stubText(`${'x'.repeat(10)}${' '.repeat(1000)}`, 20)).toBe('xxxxxxxxxx…');
  });

  it('name sessions by their titles, or their first prompts, for a page of results', () => {
    const names = sessionNames(db, [
      { source: 'fake', sessionId: 's1' },
      { source: 'fake', sessionId: 's1' },
      { source: 'fake', sessionId: 's2' },
      { source: 'fake', sessionId: 'missing' },
    ]);
    expect([...names]).toEqual([
      ['fake\ns1', 'Add an LRU cache to the API client'],
      ['fake\ns2', 'Document the cache options'],
    ]);
  });
});
