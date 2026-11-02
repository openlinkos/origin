import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  changesSince,
  correct,
  countProposals,
  type Database,
  describeProposal,
  entrySources,
  forget,
  getProposal,
  getTombstone,
  initStoreName,
  listProposals,
  listRejectedProposals,
  openDatabase,
  PROPOSAL_RESULT_MAX,
  prepareProposal,
  proposalIn,
  proposalJson,
  proposalState,
  rebuildProposals,
  rejectProposal,
  remember,
  resolveId,
  restore,
  searchEntries,
  syncSource,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';

const T0 = Date.UTC(2026, 9, 20, 9);

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-proposals-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'laptop');
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Line {
  id: string;
  session: string;
  ts: number;
  role?: 'user' | 'assistant';
  text: string;
  kind?: string;
  project?: string;
}

function write(file: string, lines: Line[]): void {
  const text = lines.map((l) => JSON.stringify({ role: 'user', ...l })).join('\n');
  fs.appendFileSync(path.join(logs, file), `${text}\n`);
}

const sync = () => syncSource({ db, home }, fakeAdapter(logs));

/** What `propose` returns, as the agent's log records it: pretty-printed JSON. */
function proposeResult(id: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      proposal: id,
      kind: 'knowledge',
      text: 'The demo app deploys from the main branch through CI.',
      confidence: 0.8,
      project: 'demo',
      valid_from: null,
      valid_to: null,
      note: 'Inferred from the deploy discussion; not confirmed.',
      sources: [{ event_id: 'fake:m1', quote: 'deploy from main' }],
      ...fields,
    },
    null,
    2,
  );
}

const P1 = 'prp_0123456789ab';

/** A session where the user said something, and an agent proposed an entry from it. */
function proposedSession(): void {
  write('s1.jsonl', [
    { id: 'm1', session: 's1', ts: T0, text: 'We always deploy from main, through CI.' },
    {
      id: 'm2',
      session: 's1',
      ts: T0 + 1_000,
      role: 'assistant',
      text: 'Noted: CI deploys main.',
    },
  ]);
  write('s2.jsonl', [
    { id: 'q1', session: 's2', ts: T0 + 60_000, text: 'Consolidate yesterday.' },
    {
      id: 'p1',
      session: 's2',
      ts: T0 + 61_000,
      kind: 'tool_result',
      text: proposeResult(P1),
    },
  ]);
}

const tables = () => ({
  proposals: db.prepare('SELECT * FROM proposal ORDER BY id').all(),
  sources: db.prepare('SELECT * FROM proposal_source ORDER BY proposal_id, event_id').all(),
});

describe('proposals', () => {
  it('are derived from the result of propose in an agent log', async () => {
    proposedSession();
    await sync();
    expect(tables()).toEqual({
      proposals: [
        {
          id: P1,
          source: 'fake',
          session_id: 's2',
          event_id: 'fake:p1',
          kind: 'knowledge',
          text: 'The demo app deploys from the main branch through CI.',
          confidence: 0.8,
          project: 'demo',
          valid_from: null,
          valid_to: null,
          note: 'Inferred from the deploy discussion; not confirmed.',
          at: T0 + 61_000,
        },
      ],
      sources: [{ proposal_id: P1, event_id: 'fake:m1', quote: 'deploy from main' }],
    });
    const p = getProposal(db, P1);
    expect(p).toMatchObject({ status: 'pending', entry: null, sessionProject: 'demo' });
    expect(resolveId(db, P1)).toEqual({ kind: 'proposal', id: P1 });
    // Not knowledge yet: entries hold nothing of it.
    expect(searchEntries(db, 'deploys')).toEqual([]);
    // Syncing again derives nothing new.
    await sync();
    expect(tables().proposals).toHaveLength(1);
  });

  it('are found in a result that says more, but not in one that quotes it, is cut short, or is no result', () => {
    const result = proposeResult(P1);
    expect(proposalIn(result)?.id).toBe(P1);
    // An agent's log may add text around the result, such as a note of its own.
    expect(proposalIn(`${result}\nNote: the Origin hub was not consulted.`)?.id).toBe(P1);
    expect(proposalIn(`Result:\n${result}`)?.text).toMatch(/deploys from the main branch/);
    // The same text quoted inside another result has its quotes escaped.
    expect(proposalIn(JSON.stringify({ events: [{ text: result }] }, null, 2))).toBeNull();
    // A result cut short, as an adapter cuts a long tool result.
    expect(proposalIn(`${result.slice(0, 200)}…[+120 chars]`)).toBeNull();
    // Results that do not have the shape `propose` writes.
    for (const fields of [
      { kind: 'opinion' },
      { text: '  ' },
      { confidence: 2 },
      { sources: [] },
      { sources: [{ quote: 'no event' }] },
      { valid_to: 'someday' },
      { note: 'x'.repeat(201) },
    ]) {
      expect(proposalIn(proposeResult(P1, fields))).toBeNull();
    }
    expect(proposalIn('{ "proposal": "prp_nothex" }')).toBeNull();
  });

  it('are not derived from a quoted result, a message, or a tool call', async () => {
    write('s1.jsonl', [
      { id: 'm1', session: 's1', ts: T0, text: 'deploy from main' },
      {
        id: 'q',
        session: 's1',
        ts: T0 + 1,
        kind: 'tool_result',
        text: JSON.stringify({ events: [{ text: proposeResult(P1) }] }),
      },
      { id: 'm', session: 's1', ts: T0 + 2, role: 'assistant', text: proposeResult(P1) },
      { id: 'c', session: 's1', ts: T0 + 3, kind: 'tool_use', text: proposeResult(P1) },
    ]);
    await sync();
    expect(tables()).toEqual({ proposals: [], sources: [] });
  });

  it('take the earliest event that carries them, whatever order the events arrive in', async () => {
    // A tool printed the proposal again later (its output was the result, verbatim).
    write('a.jsonl', [
      { id: 'echo', session: 's3', ts: T0 + 90_000, kind: 'tool_result', text: proposeResult(P1) },
    ]);
    await sync();
    expect(getProposal(db, P1)?.eventId).toBe('fake:echo');
    proposedSession();
    await sync();
    expect(getProposal(db, P1)).toMatchObject({ eventId: 'fake:p1', sessionId: 's2' });
    const incremental = tables();
    rebuildProposals(db);
    expect(tables()).toEqual(incremental);
  });

  it('rebuild to what ingestion derived, hidden events included', async () => {
    proposedSession();
    write('s4.jsonl', [
      {
        id: 'p2',
        session: 's4',
        ts: T0 + 120_000,
        kind: 'tool_result',
        text: proposeResult('prp_00000000000b', { kind: 'cognition', project: null }),
      },
    ]);
    await sync();
    rejectProposal(db, 'prp_00000000000b', { reason: 'Not a preference of mine.' });
    const incremental = tables();
    expect(incremental.proposals).toHaveLength(2);
    rebuildProposals(db);
    expect(tables()).toEqual(incremental);
    expect(listRejectedProposals(db).map((r) => r.id)).toEqual(['prp_00000000000b']);
  });
});

describe('the status of a proposal', () => {
  it('is pending, and accepted once the person accepts it as an entry citing the proposal and its sources', async () => {
    proposedSession();
    await sync();
    const entry = acceptProposal(db, P1, 'user@laptop', T0 + 3_600_000);
    expect(entry).toMatchObject({
      kind: 'knowledge',
      text: 'The demo app deploys from the main branch through CI.',
      confidence: 0.8,
      project: 'demo',
      author: 'user@laptop',
      origin: 'laptop',
      status: 'active',
    });
    // Provenance: what it rests on, and that it was a proposal (invariant 1).
    expect(entrySources(db, entry.id).map((s) => [s.eventId, s.quote])).toEqual([
      ['fake:m1', 'deploy from main'],
      ['fake:p1', 'The demo app deploys from the main branch through CI.'],
    ]);
    expect(getProposal(db, P1)).toMatchObject({ status: 'accepted', entry: entry.id });
    expect(listProposals(db, { status: 'pending' })).toEqual([]);
    expect(listProposals(db, { status: 'accepted' }).map((p) => p.id)).toEqual([P1]);
    expect(describeProposal(db, P1)).toMatchObject({
      session: { sessionId: 's2' },
      sources: [{ eventId: 'fake:m1', event: { text: 'We always deploy from main, through CI.' } }],
      missing: 0,
      entry: { id: entry.id },
    });
    expect(() => acceptProposal(db, P1, 'user@laptop')).toThrow(/already accepted/);
    expect(() => rejectProposal(db, P1, { reason: 'no' })).toThrow(/was accepted/);
    // The person corrects it as any entry; the proposal names the current version.
    const corrected = correct(db, entry.id, { text: 'CI deploys main.', author: 'user@laptop' });
    expect(getProposal(db, P1)?.entry).toBe(corrected.id);
  });

  it('quotes the text proposed as its result records it', async () => {
    write('s1.jsonl', [{ id: 'm1', session: 's1', ts: T0, text: 'deploy from main' }]);
    write('s2.jsonl', [
      {
        id: 'p1',
        session: 's2',
        ts: T0 + 1,
        kind: 'tool_result',
        text: proposeResult(P1, { text: 'Two lines:\nthe "main" branch deploys.' }),
      },
    ]);
    await sync();
    const entry = acceptProposal(db, P1, 'user@laptop');
    expect(entry.text).toBe('Two lines:\nthe "main" branch deploys.');
    expect(entrySources(db, entry.id).at(-1)?.quote).toBe(
      'Two lines:\\nthe \\"main\\" branch deploys.',
    );
  });

  it('is rejected by a forget of its event, with a reason, and pending again after a restore', async () => {
    proposedSession();
    await sync();
    expect(() => rejectProposal(db, P1, { reason: '  ' })).toThrow(/reason is required/);
    const r = rejectProposal(
      db,
      P1,
      { reason: 'CI deploys a release branch.', author: 'user@laptop' },
      T0 + 7_200_000,
    );
    expect(r).toMatchObject({ target: 'fake:p1', targetType: 'event', events: ['fake:p1'] });
    expect(getTombstone(db, r.tombstoneId as string)).toMatchObject({
      kind: 'forget',
      target: 'fake:p1',
      reason: 'CI deploys a release branch.',
      author: 'user@laptop',
      origin: 'laptop',
      inEffect: true,
    });
    // It leaves every list (invariant 2); the rejected are listed by id and reason only.
    expect(getProposal(db, P1)).toBeNull();
    expect(listProposals(db)).toEqual([]);
    expect(countProposals(db)).toBe(0);
    expect(listRejectedProposals(db)).toEqual([
      {
        id: P1,
        source: 'fake',
        sessionId: 's2',
        eventId: 'fake:p1',
        at: T0 + 61_000,
        forget: r.tombstoneId,
        reason: 'CI deploys a release branch.',
        rejectedAt: T0 + 7_200_000,
        author: 'user@laptop',
      },
    ]);
    expect(proposalState(db, P1)?.state).toBe('rejected');
    expect(() => acceptProposal(db, P1, 'user@laptop')).toThrow(/was rejected/);
    expect(() => rejectProposal(db, P1, { reason: 'again' })).toThrow(/was rejected/);
    // A restore brings it back, pending.
    restore(db, r.tombstoneId as string, { reason: 'Reconsidered.', author: 'user@laptop' });
    expect(getProposal(db, P1)?.status).toBe('pending');
    expect(listRejectedProposals(db)).toEqual([]);
  });

  it('leaves every list while an event it cites is forgotten, as an entry would (invariant 2)', async () => {
    proposedSession();
    await sync();
    const f = forget(db, 'fake:m1', { reason: 'Private.' });
    expect(getProposal(db, P1)).toBeNull();
    expect(proposalState(db, P1)).toEqual({ state: 'hidden' });
    expect(listProposals(db)).toEqual([]);
    expect(listRejectedProposals(db)).toEqual([]);
    expect(changesSince(db, { now: T0 + 3_600_000 }).proposals).toEqual([]);
    expect(() => acceptProposal(db, P1, 'user@laptop')).toThrow(/has been forgotten/);
    restore(db, f.tombstoneId as string, { reason: 'Not private after all.' });
    expect(getProposal(db, P1)?.status).toBe('pending');
  });

  it('leaves every list once the entry it became is forgotten', async () => {
    proposedSession();
    await sync();
    const entry = acceptProposal(db, P1, 'user@laptop');
    forget(db, entry.id, { reason: 'Wrong.' });
    expect(getProposal(db, P1)).toBeNull();
    expect(proposalState(db, P1)).toEqual({ state: 'hidden' });
  });

  it('cannot be accepted while an event it cites is not in this store', async () => {
    write('s2.jsonl', [
      {
        id: 'p1',
        session: 's2',
        ts: T0,
        kind: 'tool_result',
        text: proposeResult(P1, { sources: [{ event_id: 'fake:elsewhere', quote: null }] }),
      },
    ]);
    await sync();
    expect(describeProposal(db, P1)).toMatchObject({ sources: [], missing: 1 });
    expect(() => acceptProposal(db, P1, 'user@laptop')).toThrow(/does not have yet/);
  });
});

describe('the event of a proposal', () => {
  it('is cited only by accepting the proposal: remember neither cites it nor finds a quote in it', async () => {
    proposedSession();
    await sync();
    expect(() =>
      remember(db, {
        kind: 'knowledge',
        text: 'Deploys from main.',
        confidence: 1,
        author: 'claude-code@laptop',
        sources: [{ eventId: 'fake:p1' }],
      }),
    ).toThrow(/holds proposal prp_0123456789ab/);
    expect(() =>
      remember(db, {
        kind: 'knowledge',
        text: 'Deploys from main.',
        confidence: 1,
        author: 'claude-code@laptop',
        sources: [{ quote: 'Inferred from the deploy discussion' }],
      }),
    ).toThrow(/No event contains the quote/);
    expect(getProposal(db, P1)?.status).toBe('pending');
  });
});

describe('preparing a proposal', () => {
  it('checks it as remember checks an entry, and writes nothing', async () => {
    proposedSession();
    await sync();
    const before = tables();
    const input = {
      kind: 'memory' as const,
      text: '  Chose CI deploys from main, to keep releases simple.  ',
      confidence: 0.7,
      sources: [{ quote: 'always deploy from main' }, { eventId: 'fake:m2' }],
      project: 'demo',
      note: 'Inferred.',
    };
    const p = prepareProposal(db, input);
    expect(p).toMatchObject({
      kind: 'memory',
      text: 'Chose CI deploys from main, to keep releases simple.',
      sources: [
        { eventId: 'fake:m1', quote: 'always deploy from main' },
        { eventId: 'fake:m2', quote: null },
      ],
    });
    expect(p.id).toMatch(/^prp_[0-9a-f]{12}$/);
    expect(tables()).toEqual(before);
    // What ingestion reads back from its result is what was proposed.
    expect(proposalIn(JSON.stringify(proposalJson(p), null, 2))).toEqual(p);
    expect(prepareProposal(db, input).id).not.toBe(p.id);

    const refused: Array<[Partial<typeof input>, RegExp]> = [
      [{ sources: [{ eventId: 'fake:nope' }] }, /Unknown event/],
      [{ sources: [{ eventId: 'fake:m1', quote: 'never said' }] }, /Quote not found/],
      [{ sources: [{ eventId: 'fake:p1' }] }, /holds proposal/],
      [{ confidence: 1.5 }, /Confidence/],
      [{ text: ' ' }, /empty/],
      [{ note: 'n'.repeat(201) }, /note is too long/],
      [{ text: 'x'.repeat(PROPOSAL_RESULT_MAX) }, /more than the 3800/],
    ];
    for (const [change, error] of refused) {
      expect(() => prepareProposal(db, { ...input, ...change })).toThrow(error);
    }
    forget(db, 'fake:m2', { reason: 'Private.' });
    expect(() => prepareProposal(db, input)).toThrow(/has been forgotten/);
  });
});

describe('the change feed', () => {
  it('lists the proposals made in its range, and reads on after them', async () => {
    proposedSession();
    await sync();
    const now = T0 + 3_600_000;
    const first = changesSince(db, { now });
    expect(first.proposals.map((p) => [p.id, p.status])).toEqual([[P1, 'pending']]);
    // Messages only by default: the proposal's own event is not among the events.
    expect(first.events.map((e) => e.id)).toEqual(['fake:m1', 'fake:m2', 'fake:q1']);
    expect(changesSince(db, { now, project: 'other' }).proposals).toEqual([]);
    expect(
      changesSince(db, { now, session: { source: 'fake', sessionId: 's1' } }).proposals,
    ).toEqual([]);

    // Two more proposals; a page of one at a time reads each once.
    write('s5.jsonl', [
      { id: 'n1', session: 's5', ts: T0 + 200_000, text: 'Later on.' },
      {
        id: 'p5',
        session: 's5',
        ts: T0 + 201_000,
        kind: 'tool_result',
        text: proposeResult('prp_00000000000c'),
      },
      {
        id: 'p6',
        session: 's5',
        ts: T0 + 202_000,
        kind: 'tool_result',
        text: proposeResult('prp_00000000000d'),
      },
    ]);
    await sync();
    const seen: string[] = [];
    let after = first.next;
    for (let i = 0; i < 5; i++) {
      const page = changesSince(db, { after, limit: 1, now });
      seen.push(...page.proposals.map((p) => p.id));
      after = page.next;
      if (!page.more) break;
    }
    expect(seen).toEqual(['prp_00000000000c', 'prp_00000000000d']);
    // Accepted ones are listed with their status; rejected ones are not.
    acceptProposal(db, 'prp_00000000000c', 'user@laptop');
    rejectProposal(db, 'prp_00000000000d', { reason: 'No.' });
    expect(changesSince(db, { after: first.next, now }).proposals.map((p) => p.status)).toEqual([
      'accepted',
    ]);
  });
});
