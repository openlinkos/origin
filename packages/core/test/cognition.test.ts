import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  correct,
  type Database,
  type EntryKind,
  getEntry,
  importedEntryId,
  importMemory,
  openDatabase,
  prepareProposal,
  proposalJson,
  remember,
  type SourceInput,
  setStoreName,
  syncSource,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';

let tmp: string;
let home: string;
let logs: string;
let db: Database;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cognition-'));
  home = path.join(tmp, 'home');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(home);
  fs.mkdirSync(logs);
  db = openDatabase(path.join(home, 'origin.db'));
  setStoreName(db, 'laptop');
  await ingest(
    'a.jsonl',
    {
      id: 'mine',
      session: 's1',
      ts: 1000,
      role: 'user',
      text: 'I prefer small commits.',
      author: 'owner',
    },
    {
      id: 'sam',
      session: 's1',
      ts: 2000,
      role: 'user',
      text: 'I prefer squash merges.',
      author: 'person',
      speaker: 'Sam',
    },
    {
      id: 'bot',
      session: 's1',
      ts: 3000,
      role: 'user',
      text: 'Prefer rebasing.',
      author: 'agent',
      signal: 'origin.kind',
    },
    {
      id: 'note',
      session: 's1',
      ts: 4000,
      role: 'user',
      kind: 'meta',
      text: 'Reminder: be brief.',
    },
    {
      id: 'reply',
      session: 's1',
      ts: 5000,
      role: 'assistant',
      text: 'Noted: you prefer small commits.',
    },
    {
      id: 'tool',
      session: 's1',
      ts: 6000,
      role: 'user',
      kind: 'tool_result',
      text: 'git log: 3 small commits',
    },
    // A sub-agent's session: ZCode labels its prompt as the user's, its session says otherwise.
    {
      id: 'kid',
      session: 'k1',
      ts: 7000,
      role: 'user',
      text: 'Always prefer tabs.',
      author: 'owner',
    },
    { kinds: [{ session: 'k1', kind: 'child', signal: 'task_type' }] },
  );
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function ingest(file: string, ...lines: Array<Record<string, unknown>>): Promise<void> {
  fs.appendFileSync(path.join(logs, file), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  await syncSource({ db, home }, fakeAdapter(logs));
}

const save = (kind: EntryKind, ...sources: SourceInput[]) =>
  remember(db, {
    kind,
    text: 'Prefers this way of working.',
    confidence: 0.8,
    author: 'claude-code@laptop',
    sources,
  });
const ids = (...names: string[]) => names.map((n) => ({ eventId: `fake:${n}` }));

describe("a preference comes only from the user's own words", () => {
  it('refuses a cognition whose input sources none of which the owner wrote', () => {
    expect(() => save('cognition', ...ids('sam'))).toThrow(
      "A preference can only come from the user's own words: fake:sam (by person, Sam) is not the user's.",
    );
    expect(() => save('cognition', ...ids('sam', 'bot', 'note'))).toThrow(
      /fake:sam \(by person, Sam\), fake:bot \(by agent\), fake:note \(by system\) are not the user's\. Cite what the user wrote, or save this as memory or knowledge\./,
    );
    // A sub-agent's prompt is its parent agent's, whatever its line says.
    expect(() => save('cognition', ...ids('kid'))).toThrow(/fake:kid \(by agent\)/);
    // A quote is found in the event it comes from, and checked the same.
    expect(() => save('cognition', { quote: 'squash merges' })).toThrow(/fake:sam/);
  });

  it("takes a cognition that cites the owner's words, or no input at all", () => {
    expect(save('cognition', ...ids('mine')).kind).toBe('cognition');
    expect(save('cognition', ...ids('mine', 'sam')).kind).toBe('cognition');
    expect(save('cognition', ...ids('reply')).kind).toBe('cognition');
    expect(save('cognition', ...ids('tool')).kind).toBe('cognition');
    // What others said can be memory or knowledge.
    expect(save('knowledge', ...ids('sam', 'bot')).kind).toBe('knowledge');
    expect(save('memory', ...ids('kid')).kind).toBe('memory');
  });

  it('checks a correction that makes an entry a cognition, or adds to its sources', () => {
    const fact = save('knowledge', ...ids('sam'));
    expect(() =>
      correct(db, fact.id, {
        text: 'Prefers squash merges.',
        kind: 'cognition',
        author: 'user@laptop',
      }),
    ).toThrow(/A preference can only come from the user's own words: fake:sam/);
    const pref = save('cognition', ...ids('reply'));
    expect(() =>
      correct(db, pref.id, {
        text: 'Prefers rebasing.',
        sources: ids('bot'),
        author: 'user@laptop',
      }),
    ).toThrow(/fake:bot \(by agent\)/);
    // With the owner's words among them, or rewording it alone, it is taken.
    const added = correct(db, pref.id, {
      text: 'Prefers small commits.',
      sources: ids('mine', 'bot'),
      author: 'user@laptop',
    });
    expect(added.kind).toBe('cognition');
    expect(
      correct(db, added.id, { text: 'Prefers small, focused commits.', author: 'user@laptop' })
        .kind,
    ).toBe('cognition');
  });

  it('checks a proposal when it is made, and again when it is accepted', async () => {
    expect(() =>
      prepareProposal(db, {
        kind: 'cognition',
        text: 'Prefers squash merges.',
        confidence: 0.6,
        sources: ids('sam'),
      }),
    ).toThrow(/fake:sam \(by person, Sam\)/);
    // Proposed while the session's prompt read as the owner's, then its session turned out to be
    // a sub-agent's: accepting it is refused.
    await ingest('b.jsonl', {
      id: 'late',
      session: 'k2',
      ts: 8000,
      role: 'user',
      text: 'Prefer spaces.',
    });
    const p = prepareProposal(db, {
      kind: 'cognition',
      text: 'Prefers spaces.',
      confidence: 0.6,
      sources: ids('late'),
    });
    await ingest('b.jsonl', {
      id: 'result',
      session: 's9',
      ts: 9000,
      role: 'user',
      kind: 'tool_result',
      text: JSON.stringify(proposalJson(p), null, 2),
    });
    await ingest('b.jsonl', {
      kinds: [{ session: 'k2', kind: 'child', signal: 'subagent_spawned' }],
    });
    expect(() => acceptProposal(db, p.id, 'user@laptop')).toThrow(/fake:late \(by agent\)/);
  });

  it("leaves the entries imported from an agent's memory files alone", async () => {
    await ingest('m.jsonl', {
      id: 'mem1',
      session: 'memory',
      ts: 10_000,
      role: 'user',
      kind: 'memory',
      text: 'Prefers small commits.',
    });
    // A version of a memory file is no input: an imported cognition cites it, and so may a remember.
    importMemory(
      db,
      { source: 'fake', device: 'laptop', growthOrigin: 'laptop' },
      {
        eventId: 'mem1',
        previous: null,
        at: 10_000,
        entry: {
          kind: 'cognition',
          text: 'Prefers small commits.',
          confidence: 0.9,
          project: null,
        },
      },
    );
    expect(getEntry(db, importedEntryId('fake:mem1'))).toMatchObject({ kind: 'cognition' });
    expect(save('cognition', ...ids('mem1')).kind).toBe('cognition');
  });
});
