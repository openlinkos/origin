import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Database, openDatabase, syncSource } from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { createOriginServer } from '../src/index.js';

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
  it('exposes the seven tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['correct', 'forget', 'get', 'remember', 'search', 'sources', 'timeline'].sort(),
    );
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
