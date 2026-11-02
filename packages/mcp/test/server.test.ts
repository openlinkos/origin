import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Database, getRecall, openDatabase, syncSource } from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { createOriginServer } from '../src/index.js';
import { sourceOfAgent } from '../src/local.js';

let home: string;
let src: string;
let db: Database;
let client: Client;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('e1', 's1', 1000, 'user', 'Store everything in SQLite so it stays local.') +
      line('e2', 's1', 2000, 'assistant', 'Done: SQLite with FTS5 trigram search.'),
  );
  const server = createOriginServer({
    db,
    home,
    device: 'laptop',
    sync: async () => {
      await syncSource({ db, home }, fakeAdapter(src));
    },
    syncIntervalMs: 0,
  });
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.mcp.connect(serverSide)]);
});

afterEach(async () => {
  await client.close();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = r.content[0]?.text ?? '';
  return { isError: r.isError === true, text, json: r.isError ? null : JSON.parse(text) };
}

describe('origin MCP server', () => {
  it('exposes the ten tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'brief',
        'changes',
        'correct',
        'follow',
        'forget',
        'get',
        'remember',
        'search',
        'sources',
        'timeline',
      ].sort(),
    );
  });

  it('briefs an agent on where it works, and records the recall for its device', async () => {
    await call('remember', {
      kind: 'cognition',
      text: 'Keep every store local, in SQLite.',
      confidence: 0.9,
      project: 'demo',
      sources: [{ quote: 'so it stays local' }],
    });
    // A server without a directory of its own, like a hub, takes the agent's as it is.
    const r = await call('brief', { cwd: '/home/dana/code/demo' });
    expect(r.json.recall).toMatch(/^rcl_[0-9a-f]{12}$/);
    expect(r.json.text).toContain('Keep every store local, in SQLite.');
    expect(getRecall(db, r.json.recall)).toMatchObject({
      occasion: 'request',
      source: 'test-agent',
      origin: 'laptop',
      project: 'demo',
      cwd: '/home/dana/code/demo',
      sessionId: null,
    });
    const elsewhere = await call('brief', { cwd: '/home/dana/code/other' });
    expect(elsewhere.json.text).toContain('holds nothing for project other');
    const nowhere = await call('brief', {});
    expect(nowhere).toMatchObject({ isError: true });
    expect(nowhere.text).toContain('Pass `cwd`');
  });

  it("knows the agents Origin reads behind their MCP clients' names", () => {
    expect(sourceOfAgent('claude-code')).toBe('claude-code');
    expect(sourceOfAgent('codex-mcp-client')).toBe('codex');
    expect(sourceOfAgent('Cursor-VSCode')).toBe('cursor');
    expect(sourceOfAgent('grok-cli')).toBe('grok');
    expect(sourceOfAgent('claude-ai')).toBe('claude-ai');
  });

  it('syncs before reading, so new session lines are searchable', async () => {
    fs.appendFileSync(
      path.join(src, 's1.jsonl'),
      line('e3', 's1', 3000, 'user', 'Add a watcher later.'),
    );
    const r = await call('search', { query: 'watcher' });
    expect(r.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:e3']);
    const t = await call('timeline', { since: '1970-01-01' });
    // Without a title, a session is named by its first prompt, kept apart from the title.
    expect(t.json.sessions[0]).toEqual({
      session: 's1',
      source: 'fake',
      project: 'demo',
      title: null,
      prompt: 'Store everything in SQLite so it stays local.',
      started: expect.any(String),
      ended: expect.any(String),
      events: 3,
      thread: null,
    });
  });

  it('remembers, explains, corrects, and forgets', async () => {
    const remembered = await call('remember', {
      kind: 'memory',
      text: 'Chose SQLite so that all data stays local.',
      confidence: 0.9,
      sources: [{ quote: 'so it stays local' }],
    });
    const entry = remembered.json.entry;
    // Authors are `<agent>@<device>` on every store.
    expect(entry).toMatchObject({ kind: 'memory', author: 'test-agent@laptop', status: 'active' });

    const listed = await call('search', { scope: 'entries' });
    expect(listed.json.entries.map((e: { id: string }) => e.id)).toEqual([entry.id]);

    const got = await call('get', { id: entry.id });
    expect(got.json.sources.map((s: { id: string }) => s.id)).toEqual(['fake:e1']);

    const sources = await call('sources', { id: entry.id });
    expect(sources.json[0]).toMatchObject({ event_id: 'fake:e1', line: 1 });
    expect(JSON.parse(sources.json[0].raw)).toMatchObject({ id: 'e1' });

    const corrected = await call('correct', {
      id: entry.id,
      text: 'Chose SQLite with FTS5 so that all data stays local.',
      sources: [{ event_id: 'fake:e2' }],
    });
    const v2 = corrected.json.entry;
    expect(v2.supersedes).toBe(entry.id);
    const history = (await call('get', { id: v2.id })).json.history;
    expect(history.map((v: { id: string }) => v.id)).toEqual([entry.id, v2.id]);
    expect(history.map((v: { status: string }) => v.status)).toEqual(['superseded', 'active']);

    const forgotten = await call('forget', { id: v2.id, reason: 'test' });
    expect(forgotten.json.forgotten_entries.sort()).toEqual([entry.id, v2.id].sort());
    expect((await call('search', { query: 'SQLite' })).json).toEqual({ entries: [], events: [] });
    const gone = await call('get', { id: 'fake:e1' });
    expect(gone).toMatchObject({ isError: true, text: 'fake:e1 has been forgotten.' });
  });

  it('forgets only with a reason, records who asked, and has no way to restore', async () => {
    const { tools } = await client.listTools();
    const spec = tools.find((t) => t.name === 'forget');
    expect(spec?.inputSchema.required).toEqual(expect.arrayContaining(['id', 'reason']));
    expect(spec?.description).toContain('restore it later');
    expect(tools.some((t) => /restore|unforget/i.test(t.name))).toBe(false);
    const init = client.getInstructions() ?? '';
    expect(init).not.toContain('cannot be undone');
    expect(init).toContain('only the user can restore it');

    await call('search', {}); // ingest
    for (const args of [{ id: 'fake:e1' }, { id: 'fake:e1', reason: '   ' }]) {
      expect((await call('forget', args)).isError).toBe(true);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM tombstone').get()).toEqual({ n: 0 });

    const forgotten = await call('forget', { id: 'fake:e1', reason: ' the user pasted a secret ' });
    const row = db
      .prepare(
        `SELECT t.reason, m.author FROM tombstone t JOIN tombstone_meta m ON m.tombstone_id = t.id
         WHERE t.id = ?`,
      )
      .get(forgotten.json.tombstone);
    expect(row).toEqual({ reason: 'the user pasted a secret', author: 'test-agent@laptop' });
  });

  it('reports caller errors as tool errors', async () => {
    const r = await call('remember', {
      kind: 'knowledge',
      text: 'x',
      confidence: 0.5,
      sources: [{ event_id: 'fake:missing' }],
    });
    expect(r).toMatchObject({ isError: true, text: 'Unknown event fake:missing.' });
  });
});

describe('reading along references', () => {
  const s1 = () => path.join(src, 's1.jsonl');
  beforeEach(() => {
    fs.appendFileSync(
      s1(),
      line('e3', 's1', 3000, 'user', 'Now add a watcher for new log lines.') +
        line('e4', 's1', 3010, 'assistant', 'Read src/watch.ts', 'tool_use') +
        line('e5', 's1', 3020, 'user', 'x'.repeat(25_000), 'tool_result') +
        `${JSON.stringify({ id: 'e6', session: 's1', ts: 3030, role: 'assistant', text: 'The watcher looks every minute.', parent: 'e3' })}\n`,
    );
    fs.writeFileSync(
      path.join(src, 's2.jsonl'),
      line('f1', 's2', 5000, 'user', 'Document the watcher.'),
    );
  });

  /** Write an entry citing a quote, in project demo. */
  const note = async (text: string, quote: string) =>
    (
      await call('remember', {
        kind: 'memory',
        text,
        confidence: 0.9,
        project: 'demo',
        sources: [{ quote }],
      })
    ).json.entry.id as string;

  it('opens a session as a card, and a recall with what it handed over', async () => {
    const stored = await note('Everything is stored in SQLite.', 'so it stays local');
    const brief = await call('brief', { cwd: '/home/dana/code/demo' });
    const recall = brief.json.recall as string;
    // The agent's log holds the brief it was handed, then a reply that uses what was in it.
    const now = Date.now() + 1000;
    fs.appendFileSync(
      s1(),
      line('g1', 's1', now, 'user', JSON.stringify(brief.json), 'tool_result') +
        line('g2', 's1', now + 1, 'assistant', `As ${stored} says, SQLite it is.`),
    );
    await call('search', {}); // ingest

    const card = (await call('get', { id: 's1' })).json;
    expect(card).toMatchObject({
      session: 's1',
      source: 'fake',
      project: 'demo',
      title: null,
      prompt: 'Store everything in SQLite so it stays local.',
      events: 8,
      turns: 2,
      more_prompts: 0,
      before: null,
      after: { session: 's2', prompt: 'Document the watcher.' },
    });
    expect(card.prompts).toEqual([
      { turn: 1, id: 'fake:e1', time: expect.any(String), text: card.prompt },
      {
        turn: 2,
        id: 'fake:e3',
        time: expect.any(String),
        text: 'Now add a watcher for new log lines.',
      },
    ]);
    expect(card.entries).toEqual([
      {
        id: stored,
        kind: 'memory',
        text: 'Everything is stored in SQLite.',
        created: expect.any(String),
      },
    ]);
    expect(card.recalls).toEqual([
      { id: recall, occasion: 'request', time: expect.any(String), items: 1 },
    ]);
    // `<source>:<session id>`, as recalls record sessions, opens it too.
    expect((await call('get', { id: 'fake:s1' })).json.turns).toBe(2);

    const opened = (await call('get', { id: recall })).json;
    expect(opened).toMatchObject({
      id: recall,
      occasion: 'request',
      agent: 'test-agent',
      session: 's1',
      device: 'laptop',
      project: 'demo',
      directory: '/home/dana/code/demo',
      items: [{ rank: 1, layer: 'project', kind: 'entry', id: stored, score: null, used: true }],
    });
    expect(opened.text).toBe(brief.json.text);

    // Forgotten, the entry (and the event it cites) leaves the card, the recall, and the counts
    // (invariant 2).
    await call('forget', { id: stored, reason: 'test' });
    const after = (await call('get', { id: 's1' })).json;
    expect(after).toMatchObject({ events: 7, turns: 1, entries: [], recalls: [] });
    expect(after.prompts.map((p: { id: string }) => p.id)).toEqual(['fake:e3']);
    expect((await call('get', { id: recall })).json).toMatchObject({ items: [], text: '' });
  });

  it('opens an event with its session, turn, neighbours, and citations, and pages its text', async () => {
    const cited = await note('The watcher looks for new lines every minute.', 'every minute');
    const answer = (await call('get', { id: 'fake:e6' })).json;
    expect(answer).toMatchObject({
      id: 'fake:e6',
      session_title: 'Store everything in SQLite so it stays local.',
      offset: 0,
      total_chars: 31,
      next_offset: null,
      turn: { number: 2, prompt: { id: 'fake:e3', role: 'user', kind: 'message' } },
      replies_to: { id: 'fake:e3', text: 'Now add a watcher for new log lines.' },
      cited_by: [{ id: cited, kind: 'memory' }],
    });
    // A message's neighbours are messages; a tool event's, any kind.
    const near = (r: {
      around: { before: Array<{ id: string }>; after: Array<{ id: string }> };
    }) => [r.around.before.map((e) => e.id), r.around.after.map((e) => e.id)];
    expect(near(answer)).toEqual([['fake:e2', 'fake:e3'], []]);

    const long = (await call('get', { id: 'fake:e5' })).json;
    expect(near(long)).toEqual([['fake:e3', 'fake:e4'], ['fake:e6']]);
    expect(long).toMatchObject({ offset: 0, total_chars: 25_000, next_offset: 20_000 });
    expect(long.text).toBe(`${'x'.repeat(20_000)}…[+5000 chars]`);
    expect(long.around.before[1].text).toBe('Read src/watch.ts');
    const rest = (await call('get', { id: 'fake:e5', offset: 20_000 })).json;
    expect(rest).toMatchObject({ offset: 20_000, total_chars: 25_000, next_offset: null });
    expect(rest.text).toBe('x'.repeat(5000));
    // Later pages carry the text alone.
    expect(rest.around).toBeUndefined();
    expect(rest.turn).toBeUndefined();
  });

  it('pages a session by turns and after an event, saying how many follow', async () => {
    await call('search', {}); // ingest
    const page = async (args: Record<string, unknown>) => {
      const r = await call('timeline', { session: 's1', ...args });
      if (r.isError) return r.text;
      return [r.json.events.map((e: { id: string }) => e.id), r.json.more];
    };
    const first = (await call('timeline', { session: 's1', limit: 1 })).json;
    expect(first).toMatchObject({
      session: 's1',
      title: null,
      prompt: 'Store everything in SQLite so it stays local.',
      more: 3,
    });
    expect(await page({ after: 'fake:e1', limit: 2 })).toEqual([['fake:e2', 'fake:e3'], 1]);
    expect(await page({ turn: 2, include_tools: true })).toEqual([
      ['fake:e3', 'fake:e4', 'fake:e5', 'fake:e6'],
      0,
    ]);
    expect(await page({ turn: 1 })).toEqual([['fake:e1', 'fake:e2'], 0]);
    expect(await page({ turn: 3 })).toMatch(/^Session s1 has 2 turns/);
    expect(await page({ after: 'fake:f1' })).toBe('Event fake:f1 is not in session s1.');
    expect((await call('timeline', { session: 'nope' })).json).toEqual({
      session: 'nope',
      title: null,
      prompt: null,
      events: [],
      more: 0,
    });
  });

  it('names the session of every search hit, and of every source of an entry', async () => {
    const r = await call('search', { query: 'watcher' });
    expect(
      r.json.events.map((e: { id: string; session_title: string }) => [e.id, e.session_title]),
    ).toEqual(
      expect.arrayContaining([
        ['fake:e3', 'Store everything in SQLite so it stays local.'],
        ['fake:f1', 'Document the watcher.'],
      ]),
    );
    const documented = await note('Document the watcher.', 'Document the watcher');
    const watcher = await note('A watcher looks for new lines.', 'add a watcher');
    const got = (await call('get', { id: watcher })).json;
    expect(got.sources[0]).toMatchObject({
      id: 'fake:e3',
      session_title: 'Store everything in SQLite so it stays local.',
    });
    // Related: other current entries from the same sessions; s2's entry is not.
    expect(got.related).toEqual([]);
    expect((await call('get', { id: documented })).json.related).toEqual([]);
    const minute = await note('The watcher runs every minute.', 'every minute');
    const now = (await call('get', { id: watcher })).json;
    expect(now.related.map((e: { id: string }) => e.id)).toEqual([minute]);
  });

  it('keeps the errors for ids it does not know', async () => {
    await call('search', {});
    expect(await call('get', { id: 'nope' })).toMatchObject({
      isError: true,
      text: 'Unknown entry or event nope.',
    });
    expect(await call('get', { id: 'rcl_000000000000' })).toMatchObject({
      isError: true,
      text: 'Unknown entry or event rcl_000000000000.',
    });
  });
});

/** A line of the fake agent's log, with any of its fields. */
const fakeLine = (fields: Record<string, unknown>) =>
  `${JSON.stringify({ role: 'user', ...fields })}\n`;

describe('threads and changes', () => {
  const HOUR = 3_600_000;

  it('follows a session, and the result in the log joins the two into a thread', async () => {
    await call('search', {});
    const r = await call('follow', {
      id: 's1',
      note: 'goes on with the SQLite store',
      cwd: '/home/dana/code/demo',
    });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      link: expect.stringMatching(/^lnk_[0-9a-f]{12}$/),
      follows: 'fake:s1',
      thread: null,
      note: 'goes on with the SQLite store',
    });
    // The agent's log records the tool result; ingestion reads the link from it.
    fs.writeFileSync(
      path.join(src, 's2.jsonl'),
      fakeLine({ id: 'f1', session: 's2', ts: 4000, text: 'Carry on with the store.' }) +
        fakeLine({ id: 'f2', session: 's2', ts: 4001, kind: 'tool_result', text: r.text }),
    );
    const t = await call('timeline', { since: '1970-01-01' });
    const thread = t.json.sessions[0].thread;
    expect(thread).toMatch(/^thr_[0-9a-f]{12}$/);
    expect(t.json.sessions.map((s: { thread: string }) => s.thread)).toEqual([thread, thread]);

    const card = (await call('get', { id: thread })).json;
    expect(card).toMatchObject({
      thread,
      project: 'demo',
      title: 'Store everything in SQLite so it stays local.',
      more_sessions: 0,
      agents: ['fake'],
      branches: [],
      entries: [],
      last_prompt: { id: 'fake:f1', text: 'Carry on with the store.', session: 's2' },
    });
    expect(card.sessions.map((s: { session: string }) => s.session)).toEqual(['s1', 's2']);
    expect((await call('get', { id: 's2' })).json.thread).toEqual({ id: thread, sessions: 2 });
    // Following the thread names its root.
    const again = await call('follow', { id: thread, cwd: '/home/dana/code/demo' });
    expect(again.json).toMatchObject({ follows: 'fake:s1', thread, note: null });
  });

  it('refuses to follow what is no session of this project', async () => {
    await call('search', {});
    const other = await call('follow', { id: 's1', cwd: '/home/dana/code/other' });
    expect(other).toMatchObject({ isError: true });
    expect(other.text).toContain('s1 is a session of project demo, not of project other');
    expect(await call('follow', { id: 's9', cwd: '/home/dana/code/demo' })).toMatchObject({
      isError: true,
      text: 'Unknown session or thread s9.',
    });
    expect(await call('follow', { id: 'thr_000000000000', cwd: '/x/demo' })).toMatchObject({
      isError: true,
      text: 'Unknown session or thread thr_000000000000.',
    });
    expect((await call('follow', { id: 'fake:e1', cwd: '/x/demo' })).text).toContain(
      'fake:e1 is an event',
    );
    // A hub cannot tell where the agent works.
    expect((await call('follow', { id: 's1' })).text).toContain('Pass `cwd`');
    expect((await call('get', { id: 'thr_000000000000' })).text).toBe(
      'Unknown entry or event thr_000000000000.',
    );
  });

  it('lists what changed since a cursor, a page at a time', async () => {
    const now = Date.now();
    fs.writeFileSync(
      path.join(src, 'n.jsonl'),
      fakeLine({ id: 'n1', session: 'sn', ts: now - HOUR, text: 'Recent work.' }) +
        fakeLine({ id: 'n2', session: 'sn', ts: now - HOUR + 1, kind: 'tool_use', text: 'ls' }),
    );
    const first = await call('changes', {});
    expect(first.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:n1']);
    expect(first.json.events[0]).toEqual({
      id: 'fake:n1',
      time: expect.any(String),
      role: 'user',
      kind: 'message',
      text: 'Recent work.',
      session: 'sn',
    });
    expect(first.json.sessions).toMatchObject([{ session: 'sn', new: true, thread: null }]);
    expect(first.json.more).toBe(false);

    fs.appendFileSync(
      path.join(src, 'n.jsonl'),
      fakeLine({ id: 'n3', session: 'sn', ts: now, text: 'Next step.' }) +
        fakeLine({ id: 'n4', session: 'sn', ts: now + 1, role: 'assistant', text: 'Done.' }),
    );
    const saved = await call('remember', {
      kind: 'memory',
      text: 'The next step is done.',
      confidence: 0.8,
      sources: [{ event_id: 'fake:n4' }],
    });
    const page = await call('changes', { after: first.json.next, limit: 1 });
    expect(page.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:n3']);
    expect(page.json.sessions).toMatchObject([{ session: 'sn', new: false }]);
    expect(page.json.entries).toEqual([
      {
        id: saved.json.entry.id,
        kind: 'memory',
        text: 'The next step is done.',
        created: expect.any(String),
        supersedes: null,
      },
    ]);
    expect(page.json.more).toBe(true);
    const rest = await call('changes', { after: page.json.next, include_tools: true });
    expect(rest.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:n4']);
    expect(rest.json.more).toBe(false);
    const gone = await call('forget', { id: 'fake:n3', reason: 'test' });
    const later = await call('changes', { after: rest.json.next });
    expect(later.json.forgets).toEqual([
      { id: gone.json.tombstone, target: 'fake:n3', at: expect.any(String) },
    ]);
    expect(later.json.events).toEqual([]);
    // The forgotten event is gone from a range read again; filters keep to what they name.
    const again = await call('changes', { session: 'sn', after: first.json.next });
    expect(again.json.events.map((e: { id: string }) => e.id)).toEqual(['fake:n4']);
    expect((await call('changes', { project: 'other' })).json.events).toEqual([]);
    expect(await call('changes', { after: 'not a cursor' })).toMatchObject({ isError: true });
    expect((await call('changes', { session: 'nope' })).text).toBe('Unknown session nope.');
  });

  it('hands over a thread on one line in a brief, and records it as a thread', async () => {
    const now = Date.now();
    fs.writeFileSync(
      path.join(src, 'b.jsonl'),
      [
        { id: 'b1', session: 'sa', ts: now - 3 * HOUR, text: 'Start the parser.' },
        { id: 'b2', session: 'sa', ts: now - 3 * HOUR + 1, role: 'assistant', text: 'Started.' },
        { id: 'b3', session: 'sb', ts: now - HOUR, text: 'Finish the parser tests.' },
        { id: 'b4', session: 'sb', ts: now - HOUR + 1, role: 'assistant', text: 'Finished.' },
      ]
        .map((l) => fakeLine({ ...l, branch: 'feat-parser' }))
        .join(''),
    );
    const r = await call('brief', { cwd: '/home/dana/code/demo' });
    const thread = (await call('timeline', {})).json.sessions.find(
      (s: { session: string }) => s.session === 'sb',
    ).thread;
    expect(thread).toMatch(/^thr_/);
    expect(r.json.text).toContain(`- ${thread} (2 sessions: fake; `);
    expect(r.json.text).toContain('): Start the parser.; last prompt: Finish the parser tests.');
    expect(r.json.text).toContain('a session or thread for its turns or sessions');
    // One line for the thread, not one per session.
    expect(r.json.text).not.toContain(' sa: ');
    expect(r.json.text).not.toContain(' sb: ');
    const items = getRecall(db, r.json.recall)?.items ?? [];
    expect(items).toContainEqual(
      expect.objectContaining({ layer: 'sessions', kind: 'thread', ref: thread }),
    );
    expect((await call('get', { id: r.json.recall })).json.items).toContainEqual(
      expect.objectContaining({ kind: 'thread', id: thread }),
    );
  });
});
