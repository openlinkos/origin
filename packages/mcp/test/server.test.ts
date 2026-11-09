import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  acceptProposal,
  type Database,
  getRecall,
  openDatabase,
  rejectProposal,
  syncSource,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { createOriginServer } from '../src/index.js';
import { briefIn, sourceOfAgent } from '../src/local.js';

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

/** A parent session with a title, and one workflow child linked to it. */
function writeChildSession(dir: string): void {
  const now = Date.now();
  fs.writeFileSync(
    path.join(dir, 'family.jsonl'),
    `${[
      JSON.stringify({
        id: 'r1',
        session: 'parent-1',
        ts: now - 2000,
        role: 'user',
        text: 'Start the cache work',
        project: 'demo',
      }),
      JSON.stringify({
        id: 'r2',
        session: 'parent-1',
        ts: now - 1000,
        role: 'user',
        text: 'Keep going on the cache',
        project: 'demo',
      }),
      JSON.stringify({ session: 'parent-1', title: 'Cache the retries' }),
      JSON.stringify({
        id: 'c1',
        session: 'child-1',
        ts: now,
        role: 'user',
        text: 'zebraparentlink step',
        project: 'demo',
        parents: [
          {
            session: 'child-1',
            parent: 'parent-1',
            via: 'workflow',
            signal: 'dwf_run',
            group: 'run-1',
            name: 'Ship',
          },
        ],
      }),
    ].join('\n')}\n`,
  );
}

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = r.content[0]?.text ?? '';
  return { isError: r.isError === true, text, json: r.isError ? null : JSON.parse(text) };
}

describe('origin MCP server', () => {
  it('exposes the twelve tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'brief',
        'changes',
        'correct',
        'digest',
        'follow',
        'forget',
        'get',
        'propose',
        'remember',
        'search',
        'sources',
        'timeline',
      ].sort(),
    );
  });

  it('has no tool that purges, and no code that could', async () => {
    // A purge deletes for good: only the owner makes one, through the CLI or the admin UI, never an
    // agent. Neither this server nor the OpenClaw plugin's tools may reach it.
    const { tools } = await client.listTools();
    expect(tools.filter((t) => /purge|erase|delete|wipe/i.test(t.name))).toEqual([]);
    const packages = path.resolve(import.meta.dirname, '../..');
    const files = ['mcp', 'openclaw'].flatMap((pkg) =>
      (fs.readdirSync(path.join(packages, pkg, 'src'), { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(packages, pkg, 'src', f)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
      expect(code.match(/\b(purge|planPurge|completePurges)\b/g), file).toBeNull();
    }
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
    expect(nowhere.text).toContain('Pass `cwd`, your working directory, or `project`');
  });

  it('briefs an agent that works in no directory on its project, by name', async () => {
    // An OpenClaw agent's sessions: filed under the agent's id, with no working directory.
    const now = Date.now();
    const at = (n: number) => now - 60_000 + n * 1000;
    fs.writeFileSync(
      path.join(src, 'openclaw.jsonl'),
      `${[
        {
          id: 'oc1',
          session: 'oc-main-1',
          ts: at(1),
          role: 'user',
          text: 'Plan the weekly digest',
        },
        { id: 'oc2', session: 'oc-main-1', ts: at(2), role: 'assistant', text: 'Planned it.' },
        { id: 'oc3', session: 'oc-wen-1', ts: at(3), role: 'user', text: 'Draft the newsletter' },
        { id: 'oc4', session: 'oc-wen-1', ts: at(4), role: 'assistant', text: 'Drafted it.' },
      ]
        .map((l) =>
          JSON.stringify({ ...l, project: l.session === 'oc-main-1' ? 'main' : 'xiaowen' }),
        )
        .join('\n')}\n`,
    );
    const saved = await call('remember', {
      kind: 'knowledge',
      text: 'The weekly digest goes out on Mondays.',
      confidence: 0.9,
      project: 'main',
      sources: [{ event_id: 'fake:oc1' }],
    });
    expect(saved.isError).toBe(false);
    const r = await call('brief', { project: 'main' });
    expect(r.json.text).toContain('(project main)');
    expect(r.json.text).toContain('The weekly digest goes out on Mondays.');
    expect(r.json.text).toContain('oc-main-1: Plan the weekly digest');
    expect(r.json.text).not.toContain('oc-wen-1');
    expect(getRecall(db, r.json.recall)).toMatchObject({
      occasion: 'request',
      project: 'main',
      cwd: null,
    });
    // Another agent's project is another project.
    const other = await call('brief', { project: 'xiaowen' });
    expect(other.json.text).toContain('oc-wen-1: Draft the newsletter');
    expect(other.json.text).not.toContain('Mondays');
    // With a directory too, the name is the project's, and the directory is kept.
    const both = await call('brief', { project: 'main', cwd: '/home/dana/code/demo' });
    expect(getRecall(db, both.json.recall)).toMatchObject({
      project: 'main',
      cwd: '/home/dana/code/demo',
    });
    expect(both.json.text).toContain('The weekly digest goes out on Mondays.');
  });

  it("briefs on a named project, not on the server's own directory", () => {
    const here = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-here-'));
    try {
      const named = briefIn(db, { project: 'main' }, 'openclaw@laptop', here);
      expect(getRecall(db, named.recall)).toMatchObject({ project: 'main', cwd: null });
      const own = briefIn(db, {}, 'openclaw@laptop', here);
      expect(getRecall(db, own.recall)).toMatchObject({ cwd: here });
    } finally {
      fs.rmSync(here, { recursive: true, force: true });
    }
  });

  it('hands over the past messages that match the task an agent asks about', async () => {
    await call('search', {}); // ingest
    const r = await call('brief', {
      cwd: '/home/dana/code/demo',
      about: 'Why did we pick SQLite with trigram search?',
    });
    expect(r.json.text).toContain('a message for its full text and the turns around it');
    expect(r.json.text).toMatch(
      /\n\nPast messages that match the task \(agent, day, who\):\n- fake:e2 \(fake, \d{4}-\d\d-\d\d, assistant\) Done: SQLite with FTS5 trigram search\.$/,
    );
    expect(getRecall(db, r.json.recall)?.items).toEqual([
      expect.objectContaining({ layer: 'messages', kind: 'event', ref: 'fake:e2', excerpt: 0 }),
    ]);
    const opened = (await call('get', { id: r.json.recall })).json;
    expect(opened.items).toEqual([
      expect.objectContaining({ layer: 'messages', kind: 'event', id: 'fake:e2' }),
    ]);
    expect(opened.text).toBe(r.json.text);
  });

  it("knows the agents Origin reads behind their MCP clients' names", () => {
    expect(sourceOfAgent('claude-code')).toBe('claude-code');
    expect(sourceOfAgent('codex-mcp-client')).toBe('codex');
    expect(sourceOfAgent('Cursor-VSCode')).toBe('cursor');
    expect(sourceOfAgent('grok-cli')).toBe('grok');
    expect(sourceOfAgent('claude-ai')).toBe('claude-ai');
  });

  it('lists a child session only when include_children is set', async () => {
    writeChildSession(src);
    const hidden = await call('timeline', { since: '1970-01-01' });
    const sessions = hidden.json.sessions as Array<{
      session: string;
      children?: number;
      workflows?: string[];
      title?: string | null;
    }>;
    expect(sessions.map((s) => s.session)).not.toContain('child-1');
    expect(sessions.find((s) => s.session === 'parent-1')).toMatchObject({
      children: 1,
      workflows: ['Ship'],
      title: 'Cache the retries',
    });
    const shown = await call('timeline', { since: '1970-01-01', include_children: true });
    expect(shown.json.sessions.map((s: { session: string }) => s.session)).toEqual(
      expect.arrayContaining(['parent-1', 'child-1']),
    );
  });

  it("names a child hit's parent and that parent's title", async () => {
    writeChildSession(src);
    const r = await call('search', { query: 'zebraparentlink' });
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0]).toMatchObject({
      parent: 'fake:parent-1',
      parent_title: 'Cache the retries',
    });
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
      children: 0,
      workflows: [],
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
    expect((await call('search', { query: 'SQLite' })).json).toEqual({
      entries: [],
      events: [],
      more: { entries: false, events: false },
    });
    const gone = await call('get', { id: 'fake:e1' });
    expect(gone).toMatchObject({ isError: true, text: 'fake:e1 has been forgotten.' });
  });

  it('bounds every hit, entries as events, and says when the limit left hits out', async () => {
    const tail = 'Then the retries back off for a minute. '.repeat(40);
    const long = `${'Background on the queue. '.repeat(40)}Chose zebrafence for the queue. ${tail}`;
    const from = { confidence: 0.9, sources: [{ event_id: 'fake:e1' }] };
    const written = (await call('remember', { kind: 'memory', text: long, ...from })).json.entry;
    await call('remember', { kind: 'memory', text: 'Short note: zebrafence stays.', ...from });

    const r = await call('search', { query: 'zebrafence', scope: 'entries', limit: 1 });
    expect(r.json.more).toEqual({ entries: true, events: false });
    const all = await call('search', { query: 'zebrafence', scope: 'entries' });
    expect(all.json.more).toEqual({ entries: false, events: false });
    const hit = all.json.entries.find((e: { id: string }) => e.id === written.id);
    // The text is cut as an event's is, the snippet sits around the match, and the length says
    // how much `get` has.
    expect(hit.total_chars).toBe(long.trim().length);
    expect(hit.text.length).toBeLessThan(500);
    expect(hit.text).toMatch(/…\[\+\d+ chars\]$/);
    expect(hit.snippet).toContain('[zebrafence]');
    expect(hit.snippet.length).toBeLessThan(220);

    // A list without a query has no snippet, and is bounded all the same.
    const listed = await call('search', { scope: 'entries', limit: 1 });
    expect(listed.json.more.entries).toBe(true);
    expect(listed.json.entries[0]).not.toHaveProperty('snippet');
    expect(listed.json.entries[0].total_chars).toBeGreaterThan(0);

    const events = await call('search', { query: 'SQLite', scope: 'events', limit: 1 });
    expect(events.json.more).toEqual({ entries: false, events: true });
    expect(events.json.events[0].total_chars).toBe(events.json.events[0].text.length);
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

describe('who wrote a message', () => {
  /** A session with the user's prompt, a teammate's message, a sub-agent's prompt, and a notice. */
  beforeEach(() => {
    const lines = [
      {
        id: 'w1',
        session: 'w',
        ts: 10_000,
        role: 'user',
        text: 'Ship the retry fix today.',
        author: 'owner',
      },
      {
        id: 'w2',
        session: 'w',
        ts: 11_000,
        role: 'user',
        text: 'Wait for QA first.',
        author: 'person',
        speaker: 'Sam',
      },
      {
        id: 'w3',
        session: 'w',
        ts: 12_000,
        role: 'user',
        text: 'Check the retry tests.',
        author: 'agent',
        speaker: 'reviewer',
      },
      {
        id: 'w4',
        session: 'w',
        ts: 13_000,
        role: 'user',
        kind: 'meta',
        text: 'Reminder: QA signs off.',
      },
      { id: 'w5', session: 'w', ts: 14_000, role: 'assistant', text: 'Waiting for QA.' },
      {
        id: 'w6',
        session: 'w',
        ts: 15_000,
        role: 'user',
        text: '<command-name>/review</command-name>',
      },
      {
        id: 'w7',
        session: 'w',
        ts: 16_000,
        role: 'assistant',
        kind: 'tool_use',
        text: 'Review {}',
      },
    ];
    fs.writeFileSync(
      path.join(src, 'w.jsonl'),
      lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
    );
  });

  it("marks a message the user did not write with `by` and its speaker, and leaves the user's as it was", async () => {
    const page = await call('timeline', { session: 'w', include_tools: true });
    expect(
      page.json.events.map((e: Record<string, unknown>) => [e.id, e.by ?? null, e.speaker ?? null]),
    ).toEqual([
      ['fake:w1', null, null],
      ['fake:w2', 'person', 'Sam'],
      ['fake:w3', 'agent', 'reviewer'],
      ['fake:w4', 'system', null],
      ['fake:w5', null, null],
      ['fake:w6', 'system', null],
      ['fake:w7', null, null],
    ]);
    // The user's own message has exactly the fields it always had.
    expect(Object.keys(page.json.events[0]).sort()).toEqual(
      ['id', 'time', 'source', 'project', 'session', 'role', 'kind', 'text'].sort(),
    );
    const hit = (await call('search', { query: 'QA first' })).json.events[0];
    expect(hit).toMatchObject({ id: 'fake:w2', by: 'person', speaker: 'Sam' });
    const event = (await call('get', { id: 'fake:w3' })).json;
    expect(event).toMatchObject({ by: 'agent', speaker: 'reviewer' });
    expect(event.around.before.map((e: Record<string, unknown>) => [e.id, e.by ?? null])).toEqual([
      ['fake:w1', null],
      ['fake:w2', 'person'],
    ]);
    // A session's turns: the user's prompt, and a command the agent acted on, whose echo Claude
    // Code writes.
    const card = (await call('get', { id: 'w' })).json;
    expect(card.prompt).toBe('Ship the retry fix today.');
    expect(card.prompts.map((p: Record<string, unknown>) => [p.text, p.by ?? null])).toEqual([
      ['Ship the retry fix today.', null],
      ['/review', 'system'],
    ]);
    // From the start of the store: these lines are older than the feed's last 24 hours.
    const start = Buffer.from(JSON.stringify({ e: 0, c: 0 })).toString('base64url');
    const feed = (await call('changes', { after: start })).json;
    expect(
      feed.events
        .filter((e: { session: string }) => e.session === 'w')
        .map((e: Record<string, unknown>) => e.by ?? null),
    ).toEqual([null, 'person', 'agent', null, 'system']);
    expect(client.getInstructions()).toContain(
      'A message marked with `by` (`person`, `agent`, or `system`, with its `speaker` when known) was not written by the user',
    );
  });

  it('refuses a preference that rests only on what others wrote', async () => {
    const r = await call('remember', {
      kind: 'cognition',
      text: 'Waits for QA before shipping.',
      confidence: 0.8,
      sources: [{ event_id: 'fake:w2' }],
    });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toBe(
      "A preference can only come from the user's own words: fake:w2 (by person, Sam) is not the user's. Cite what the user wrote, or save this as memory or knowledge.",
    );
    const ok = await call('remember', {
      kind: 'knowledge',
      text: 'QA signs off before a release ships.',
      confidence: 0.8,
      sources: [{ event_id: 'fake:w2' }],
    });
    expect(ok.json.entry).toMatchObject({ kind: 'knowledge' });
    const proposed = await call('propose', {
      kind: 'cognition',
      text: 'Waits for QA.',
      confidence: 0.5,
      sources: [{ quote: 'Wait for QA first' }],
    });
    expect(proposed).toMatchObject({ isError: true });
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

describe('proposals', () => {
  /** Propose, and record the result in the agent's log, as Claude Code would. */
  async function proposeAndLog(args: Record<string, unknown>, ts = 5000, n = 1) {
    const r = await call('propose', args);
    expect(r.isError).toBe(false);
    fs.appendFileSync(
      path.join(src, 'p.jsonl'),
      fakeLine({ id: `q${n}`, session: 'sp', ts: ts - 1, text: 'Consolidate the day.' }) +
        fakeLine({ id: `p${n}`, session: 'sp', ts, kind: 'tool_result', text: r.text }),
    );
    await call('search', {}); // reads the log
    return r;
  }

  it('proposes an entry, writes nothing, and the result in the log becomes a proposal', async () => {
    await call('search', {});
    const r = await proposeAndLog({
      kind: 'knowledge',
      text: 'All data stays local, in SQLite.',
      confidence: 0.7,
      project: 'demo',
      sources: [{ quote: 'so it stays local' }, { event_id: 'fake:e2' }],
      note: 'Inferred from the first prompt.',
    });
    const id = r.json.proposal;
    expect(r.json).toEqual({
      proposal: expect.stringMatching(/^prp_[0-9a-f]{12}$/),
      kind: 'knowledge',
      text: 'All data stays local, in SQLite.',
      confidence: 0.7,
      project: 'demo',
      valid_from: null,
      valid_to: null,
      note: 'Inferred from the first prompt.',
      sources: [
        { event_id: 'fake:e1', quote: 'so it stays local' },
        { event_id: 'fake:e2', quote: null },
      ],
    });
    // Nothing durable was written; ingestion reads the proposal from the log.
    expect(db.prepare('SELECT COUNT(*) AS n FROM entry').get()).toEqual({ n: 0 });

    const card = await call('get', { id });
    expect(card.json).toEqual({
      id,
      status: 'pending',
      kind: 'knowledge',
      text: 'All data stays local, in SQLite.',
      confidence: 0.7,
      project: 'demo',
      valid_from: null,
      valid_to: null,
      note: 'Inferred from the first prompt.',
      time: expect.any(String),
      agent: 'fake',
      session: expect.objectContaining({ session: 'sp', source: 'fake' }),
      event: 'fake:p1',
      sources: [
        expect.objectContaining({ id: 'fake:e1', quote: 'so it stays local', session: 's1' }),
        expect.objectContaining({ id: 'fake:e2', quote: null, session: 's1' }),
      ],
      missing_sources: 0,
      accepted_as: null,
    });
    // The card is no result of `propose`: opening it in a session proposes nothing again.
    expect(card.text).not.toContain('"proposal"');

    // Not knowledge yet: search and the brief hand over no proposal.
    expect((await call('search', { query: 'stays local, in SQLite' })).json.entries).toEqual([]);
    expect((await call('brief', { cwd: '/home/dana/code/demo' })).json.text).not.toContain(
      'All data stays local',
    );
    // The change feed lists it, so a runtime notices it.
    const changes = await call('changes', { after: undefined });
    expect(changes.json.proposals).toEqual([]); // older than 24 hours
    const recent = Date.now();
    await proposeAndLog(
      {
        kind: 'cognition',
        text: 'Likes small steps.',
        confidence: 0.5,
        sources: [{ event_id: 'fake:e1' }],
      },
      recent,
      2,
    );
    const feed = await call('changes', {});
    expect(feed.json.proposals).toEqual([
      {
        id: expect.stringMatching(/^prp_/),
        kind: 'cognition',
        text: 'Likes small steps.',
        status: 'pending',
        time: expect.any(String),
        session: 'sp',
        event: 'fake:p2',
        project: 'demo',
      },
    ]);
  });

  it('leaves accepting to the user, and shows the entry a proposal became', async () => {
    await call('search', {});
    const r = await proposeAndLog({
      kind: 'memory',
      text: 'Chose SQLite to keep data local.',
      confidence: 0.8,
      sources: [{ event_id: 'fake:e1' }],
    });
    await call('search', {});
    // An agent cannot accept it by citing its event.
    const cite = await call('remember', {
      kind: 'memory',
      text: 'Chose SQLite.',
      confidence: 1,
      sources: [{ event_id: 'fake:p1' }],
    });
    expect(cite).toMatchObject({ isError: true });
    expect(cite.text).toContain(`holds proposal ${r.json.proposal}`);
    const entry = acceptProposal(db, r.json.proposal, 'user@laptop');
    expect((await call('get', { id: r.json.proposal })).json).toMatchObject({
      status: 'accepted',
      accepted_as: { id: entry.id, kind: 'memory', text: 'Chose SQLite to keep data local.' },
    });
    // The entry's sources show it was proposed.
    const opened = await call('get', { id: entry.id });
    expect(opened.json.sources.map((s: { id: string }) => s.id)).toEqual(['fake:e1', 'fake:p1']);
  });

  it('checks a proposal as remember checks an entry', async () => {
    await call('search', {});
    const refused = async (args: Record<string, unknown>) => {
      const r = await call('propose', {
        kind: 'knowledge',
        text: 'Something.',
        confidence: 0.5,
        sources: [{ event_id: 'fake:e1' }],
        ...args,
      });
      expect(r.isError).toBe(true);
      return r.text;
    };
    expect(await refused({ sources: [{ event_id: 'fake:nope' }] })).toBe(
      'Unknown event fake:nope.',
    );
    expect(await refused({ sources: [{ event_id: 'fake:e1', quote: 'never said' }] })).toContain(
      'Quote not found',
    );
    expect(await refused({ text: 'x'.repeat(4000) })).toContain('more than the 3800');
    expect(await refused({ note: 'n'.repeat(201) })).toMatch(/200|note/i);
    await call('forget', { id: 'fake:e1', reason: 'test' });
    expect(await refused({})).toContain('has been forgotten');
  });

  it('opens no proposal that was rejected or that it does not know', async () => {
    await call('search', {});
    const r = await proposeAndLog({
      kind: 'knowledge',
      text: 'SQLite is the store.',
      confidence: 0.6,
      sources: [{ event_id: 'fake:e2' }],
    });
    await call('search', {});
    const reject = rejectProposal(db, r.json.proposal, { reason: 'Already known.' });
    expect((await call('get', { id: r.json.proposal })).text).toBe(
      `Proposal ${r.json.proposal} was rejected (${reject.tombstoneId}); restoring that forget makes it pending again.`,
    );
    expect((await call('get', { id: 'prp_000000000000' })).text).toBe(
      'Unknown proposal prp_000000000000.',
    );
  });
});

describe('digest', () => {
  it('sums up a day: its sessions as ids `get` opens, their prompts, and its times in its zone', async () => {
    const r = await call('digest', { day: '1970-01-01', time_zone: 'UTC' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      day: '1970-01-01',
      time_zone: 'UTC',
      from: '1970-01-01T00:00:00.000+00:00',
      until: '1970-01-02T00:00:00.000+00:00',
      totals: { sessions: 1, events: 2, prompts: 1, projects: 1, agents: 1, children: 0 },
      projects: [{ project: 'demo', sessions: 1, events: 2, prompts: 1 }],
      agents: [{ source: 'fake', sessions: 1, events: 2, prompts: 1 }],
      more_sessions: 0,
      children_included_in: ['events', 'first', 'last', 'tools', 'tool_calls', 'files'],
      entries: [],
      proposals: [],
      forgets: [],
    });
    expect(r.json.sessions).toEqual([
      {
        id: 'fake:s1',
        source: 'fake',
        session: 's1',
        project: 'demo',
        thread: null,
        title: null,
        prompt: 'Store everything in SQLite so it stays local.',
        first: '1970-01-01T00:00:01.000+00:00',
        last: '1970-01-01T00:00:02.000+00:00',
        events: 2,
        prompts: [
          {
            id: 'fake:e1',
            time: '1970-01-01T00:00:01.000+00:00',
            text: 'Store everything in SQLite so it stays local.',
          },
        ],
        more_prompts: 0,
        tools: {},
        tool_calls: 0,
        files: [],
        more_files: 0,
        children: 0,
        workflows: [],
      },
    ]);
    expect((await call('get', { id: r.json.sessions[0].id })).json).toMatchObject({
      session: 's1',
      turns: 1,
    });
    // Eight hours ahead of UTC, the same events fall on the same day, and the times say so.
    const east = await call('digest', { day: '1970-01-01', time_zone: 'Asia/Shanghai' });
    expect(east.json.from).toBe('1970-01-01T00:00:00.000+08:00');
    expect(east.json.sessions[0].first).toBe('1970-01-01T08:00:01.000+08:00');
    expect((await call('digest', { day: '1970-01-02', time_zone: 'UTC' })).json.sessions).toEqual(
      [],
    );
  });

  it("folds today's workflow child into its parent, and lists the entries written", async () => {
    writeChildSession(src);
    await call('remember', {
      kind: 'knowledge',
      text: 'Retries are cached.\nFor a day.',
      confidence: 0.9,
      sources: [{ event_id: 'fake:r1' }],
    });
    const r = await call('digest', {});
    expect(r.json.day).toBe(
      new Date().toLocaleDateString('en-CA', {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
    expect(r.json.sessions.map((s: { id: string }) => s.id)).toEqual(['fake:parent-1']);
    expect(r.json.sessions[0]).toMatchObject({
      title: 'Cache the retries',
      events: 3,
      children: 1,
      workflows: ['Ship'],
    });
    expect(r.json.sessions[0].prompts.map((p: { id: string }) => p.id)).toEqual([
      'fake:r1',
      'fake:r2',
    ]);
    expect(r.json.entries).toEqual([
      expect.objectContaining({
        kind: 'knowledge',
        text: 'Retries are cached.',
        author: 'test-agent@laptop',
        supersedes: null,
      }),
    ]);
  });

  it('refuses a day or a time zone it cannot read', async () => {
    expect((await call('digest', { day: '2026-1-5' })).isError).toBe(true);
    expect((await call('digest', { day: '2026-02-30' })).text).toMatch(/Not a day: 2026-02-30/);
    expect((await call('digest', { time_zone: 'Mars/Olympus' })).text).toMatch(/Unknown time zone/);
    expect((await call('digest', { limit: 201 })).isError).toBe(true);
  });
});

describe('a read-only connection', () => {
  it('has the reading tools only, and says so', async () => {
    const server = createOriginServer({ db, home, readOnly: true, syncIntervalMs: 0 });
    const reader = new Client({ name: 'reader', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([reader.connect(clientSide), server.mcp.connect(serverSide)]);
    const { tools } = await reader.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['brief', 'changes', 'digest', 'follow', 'get', 'search', 'sources', 'timeline'].sort(),
    );
    expect(reader.getInstructions()).toContain('This connection is read-only');
    const digest = (await reader.callTool({ name: 'digest', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(digest.isError).toBeFalsy();
    expect(JSON.parse(digest.content[0]?.text ?? '{}')).toHaveProperty('totals');
    const r = (await reader.callTool({
      name: 'remember',
      arguments: { kind: 'memory', text: 'x', confidence: 1, sources: [{ quote: 'SQLite' }] },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/remember/);
    await reader.close();
  });
});
