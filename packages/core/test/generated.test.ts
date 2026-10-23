import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  fingerprintSources,
  listEvents,
  openDatabase,
  rawLocator,
  readRawLine,
  type SourceAdapter,
  syncSource,
} from '../src/index.js';
import { TRANSACTION_BYTES } from '../src/ingest.js';
import { fakeAdapter, line } from './helpers.js';

let home: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * A source that is not a file, like a database: its rows become lines once they are written out,
 * and the last line written out says where to go on.
 */
function databaseSource() {
  const rows: string[] = [];
  const state = { token: 't0', calls: [] as Array<string | null> };
  const adapter: SourceAdapter = {
    ...fakeAdapter(home),
    async discover() {
      return [
        {
          absPath: '/data/agent.db#s1',
          relPath: 'sessions/s1.jsonl',
          generated: {
            token: state.token,
            mtimeMs: 1000,
            next(last, maxBytes) {
              state.calls.push(last);
              const from = last === null ? 0 : rows.indexOf(last) + 1;
              const out: string[] = [];
              let bytes = 0;
              for (const row of rows.slice(from)) {
                if (out.length > 0 && bytes + row.length > maxBytes) break;
                out.push(row);
                bytes += row.length + 1;
              }
              return out;
            },
          },
        },
      ];
    },
  };
  const add = (id: string, text: string, ts = 1000) =>
    rows.push(line(id, 's1', ts, 'user', text).trimEnd());
  return { adapter, state, add };
}

describe('generated sources', () => {
  it('mirrors and ingests the lines an adapter writes, asking again only when its token changes', async () => {
    const { adapter, state, add } = databaseSource();
    add('1', 'first row');
    add('2', 'second row');

    expect(await syncSource({ db, home }, adapter)).toMatchObject({
      filesChanged: 1,
      eventsAdded: 2,
      parseErrors: 0,
    });
    // Asked from the start, then once more after the last line written out, for nothing.
    expect(state.calls).toHaveLength(2);
    expect(state.calls[0]).toBeNull();
    expect(state.calls[1]).toContain('second row');
    const [first] = listEvents(db, { sessionId: 's1' });
    const loc = rawLocator(db, home, first!)!;
    expect(loc).toMatchObject({ originalPath: '/data/agent.db#s1', line: 1 });
    expect(JSON.parse(readRawLine(db, home, loc)!)).toMatchObject({ text: 'first row' });

    // The same token: the adapter is not asked.
    expect(await syncSource({ db, home }, adapter)).toMatchObject({ filesChanged: 0 });
    expect(state.calls).toHaveLength(2);

    // A new token: the adapter goes on from the last line written out.
    add('3', 'third row');
    state.token = 't1';
    expect(await syncSource({ db, home }, adapter)).toMatchObject({ eventsAdded: 1 });
    expect(state.calls[2]).toContain('second row');
    expect(listEvents(db, { sessionId: 's1' }).map((e) => e.text)).toEqual([
      'first row',
      'second row',
      'third row',
    ]);
  });

  it('keeps the token when there was nothing new, so the adapter is not asked again', async () => {
    const { adapter, state, add } = databaseSource();
    add('1', 'only row');
    await syncSource({ db, home }, adapter);
    state.token = 't1'; // changed, but nothing to write out (say, a reply still streaming)
    expect(await syncSource({ db, home }, adapter)).toMatchObject({ eventsAdded: 0 });
    expect(state.calls).toHaveLength(3);
    await syncSource({ db, home }, adapter);
    expect(state.calls).toHaveLength(3);
  });

  it('takes a large backlog in bounded transactions', async () => {
    const { adapter, state, add } = databaseSource();
    const text = 'x'.repeat(Math.ceil(TRANSACTION_BYTES / 3));
    for (let i = 1; i <= 7; i++) add(String(i), `${i} ${text}`);
    expect(await syncSource({ db, home }, adapter)).toMatchObject({ eventsAdded: 7 });
    expect(state.calls.length).toBeGreaterThan(2);
    expect(listEvents(db, { sessionId: 's1' })).toHaveLength(7);
  });

  it('is fingerprinted by its token', async () => {
    const { adapter, state } = databaseSource();
    const before = await fingerprintSources([adapter]);
    expect(await fingerprintSources([adapter])).toBe(before);
    state.token = 't1';
    expect(await fingerprintSources([adapter])).not.toBe(before);
  });
});
