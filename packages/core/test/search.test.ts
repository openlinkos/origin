import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Database,
  type EventKind,
  entrySources,
  forget,
  OriginError,
  openDatabase,
  parseQuery,
  RANK_WINDOW,
  rebuildSearchIndexes,
  remember,
  SCAN_LIMIT,
  type SearchOptions,
  searchEntries,
  searchEvents,
  syncSource,
} from '../src/index.js';
import { fakeAdapter, line } from './helpers.js';

let home: string;
let src: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

type Row = [id: string, ts: number, text: string, kind?: EventKind];

/** Ingest events (one session) through the real sync path. */
async function ingest(rows: Row[], file = 'f.jsonl'): Promise<void> {
  fs.writeFileSync(
    path.join(src, file),
    rows.map(([id, ts, text, kind]) => line(id, 'S', ts, 'user', text, kind)).join(''),
  );
  await syncSource({ db, home }, fakeAdapter(src));
}

const ids = (query: string, opts: SearchOptions = {}) =>
  searchEvents(db, query, { limit: 100, ...opts }).map((h) => h.id.replace('fake:', ''));
const messages = (query: string, opts: SearchOptions = {}) =>
  ids(query, { kinds: ['message'], ...opts });

describe('parseQuery', () => {
  it('classifies terms by length in characters and script', () => {
    expect(parseQuery('数据库 部署 库 AI x C# 5号 sqlite 𠀀𠀁 Error error')).toEqual([
      { text: '数据库', kind: 'long' },
      { text: '部署', kind: 'cjk' },
      { text: '库', kind: 'cjk' },
      { text: 'AI', kind: 'short' },
      { text: 'x', kind: 'short' },
      { text: 'C#', kind: 'short' },
      { text: '5号', kind: 'short' },
      { text: 'sqlite', kind: 'long' },
      { text: '𠀀𠀁', kind: 'cjk' },
      { text: 'Error', kind: 'long' },
    ]);
  });
});

describe('searchEvents terms', () => {
  it('requires every term, short CJK terms included', async () => {
    await ingest([
      ['both', 1000, '部署了新的证书'],
      ['first', 2000, '部署 服务'],
      ['second', 3000, '证书 过期'],
      ['spaced', 4000, '先部署 再换证书'],
    ]);
    expect(messages('部署 证书')).toEqual(['spaced', 'both']);
    expect(messages('部署')).toEqual(['spaced', 'first', 'both']);
    expect(messages('证书 过期')).toEqual(['second']);
  });

  it('finds one- and two-letter CJK terms anywhere in a run of CJK letters', async () => {
    await ingest([
      ['end', 1000, '这是数据库'],
      ['middle', 2000, '库存不足'],
      ['inner', 3000, '数据库表结构'],
      ['kana', 4000, 'サーバーを再起動'],
      ['hangul', 5000, '서버 재시작'],
      ['none', 6000, 'no CJK at all'],
    ]);
    expect(messages('库')).toEqual(['inner', 'middle', 'end']);
    expect(messages('据库')).toEqual(['inner', 'end']);
    expect(messages('数据库', { order: 'recent' })).toEqual(['inner', 'end']);
    expect(messages('バー')).toEqual(['kana']);
    expect(messages('ー')).toEqual(['kana']);
    expect(messages('서버')).toEqual(['hangul']);
  });

  it('requires short non-CJK terms too, as case-insensitive substrings', async () => {
    await ingest([
      ['ai-db', 1000, 'The AI agent writes to the DB'],
      ['ai', 2000, 'the ai agent only'],
      ['db', 3000, 'the db only'],
      ['mixed', 4000, 'AI 数据库 agent'],
      ['cjk-only', 5000, '数据库 agent'],
    ]);
    expect(messages('ai db')).toEqual(['ai-db']);
    expect(messages('AI')).toEqual(['mixed', 'ai', 'ai-db']);
    expect(messages('agent ai')).toEqual(['mixed', 'ai', 'ai-db']);
    expect(messages('数据库 AI')).toEqual(['mixed']);
    expect(messages('数据库 agent')).toEqual(['cjk-only', 'mixed']);
  });

  it('matches whole terms with tool events, not just their trigrams', async () => {
    await ingest([
      ['msg', 1000, 'an Error in the parser'],
      ['scattered', 2000, 'err rro ror', 'tool_result'],
      ['tool', 3000, 'fatal ERROR: disk full', 'tool_result'],
      ['call', 4000, '{"command":"grep error"}', 'tool_use'],
    ]);
    expect(ids('error').sort()).toEqual(['call', 'msg', 'tool']);
    expect(ids('error', { order: 'recent' })).toEqual(['call', 'tool', 'msg']);
    expect(messages('error')).toEqual(['msg']);
    expect(ids('err').sort()).toEqual(['call', 'msg', 'scattered', 'tool']);
    expect(ids('error', { kinds: ['tool_result'] })).toEqual(['tool']);
  });

  it('ignores case beyond ASCII in every index', async () => {
    await ingest([
      ['msg', 1000, 'Großer ÄRGER mit dem Server'],
      ['tool', 2000, 'ÄRGER im Log', 'tool_result'],
      ['short', 3000, 'Ü und mehr', 'tool_result'],
    ]);
    expect(messages('ärger')).toEqual(['msg']);
    expect(ids('ärger')).toEqual(['tool', 'msg']);
    expect(ids('ü')).toEqual(['short']);
  });

  it('searches CJK terms in tool events only when asked', async () => {
    await ingest([
      ['msg', 1000, '设计文档'],
      ['tool', 2000, '设计稿已上传', 'tool_result'],
    ]);
    expect(messages('设计')).toEqual(['msg']);
    expect(ids('设计')).toEqual(['tool', 'msg']);
    expect(ids('设计', { kinds: ['tool_result'] })).toEqual(['tool']);
  });

  it('applies the time range and filters to every index', async () => {
    await ingest([
      ['a', 1000, '部署 sqlite AI'],
      ['b', 2000, '部署 sqlite AI'],
      ['c', 3000, '部署 sqlite AI'],
    ]);
    for (const q of ['部署', 'sqlite', 'AI', 'sqlite 部署 AI']) {
      expect(messages(q, { since: 1500, until: 2500 })).toEqual(['b']);
      expect(ids(q, { since: 2000 })).toEqual(['c', 'b']);
      expect(ids(q, { project: 'demo', until: 1000 })).toEqual(['a']);
      expect(ids(q, { project: 'other' })).toEqual([]);
    }
  });

  it('brackets the matches in a snippet around the first one', async () => {
    const long = `${'filler '.repeat(40)}the sqlite index ${'more '.repeat(60)}`;
    await ingest([['s', 1000, long]]);
    const [hit] = searchEvents(db, 'SQLite index');
    expect(hit?.snippet).toMatch(/^….*the \[sqlite\] \[index\] .*…$/);
    expect(hit?.snippet.length).toBeLessThan(230);
  });
});

describe('ranking', () => {
  it('ranks the newest RANK_WINDOW matches by relevance', async () => {
    const newer = (n: number): Row[] =>
      Array.from({ length: n }, (_, i) => [
        `n${i}`,
        10_000 + i,
        `a long note that mentions sqlite once among many other words ${i}`,
      ]);
    // Exactly RANK_WINDOW matches: the old, most relevant one is ranked first.
    await ingest([['best', 1, 'sqlite sqlite sqlite'], ...newer(RANK_WINDOW - 1)]);
    expect(messages('sqlite', { limit: 1 })).toEqual(['best']);
    expect(ids('sqlite', { limit: 1 })).toEqual(['best']);
    expect(messages('sqlite', { limit: 1, offset: 1 })).not.toEqual(['best']);
    // One more, newer match pushes it out of the ranked window...
    await ingest(
      [['newest', 99_999, 'another note that mentions sqlite once among words']],
      'g.jsonl',
    );
    expect(messages('sqlite', { limit: 1 })).not.toEqual(['best']);
    expect(messages('sqlite', { limit: RANK_WINDOW + 10 })).toHaveLength(RANK_WINDOW);
    expect(messages('sqlite', { limit: RANK_WINDOW + 10 })).not.toContain('best');
    // ...but not out of a time range that holds fewer matches, or out of the newest-first order.
    expect(messages('sqlite', { limit: 1, until: 5000 })).toEqual(['best']);
    expect(messages('sqlite', { order: 'recent', limit: 1, offset: RANK_WINDOW })).toEqual([
      'best',
    ]);
  });
});

describe('terms without an index', () => {
  /** Insert many plain events quickly, bypassing the mirror (they need no provenance here). */
  function bulk(
    count: number,
    firstTs: number,
    text: string,
    project = 'demo',
    kind = 'message',
  ): void {
    const raw = db
      .prepare(
        `INSERT INTO raw_file (source, path, mirror, first_seen_at, updated_at)
         VALUES ('fake', ?, 'bulk', 0, 0)`,
      )
      .run(`bulk-${firstTs}`).lastInsertRowid;
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
       INSERT INTO event (id, source, session_id, ts, project, role, kind, text, raw_file_id,
                          raw_line)
       SELECT 'fake:bulk' || CAST(? + i AS INTEGER), 'fake', 'B', CAST(? + i AS INTEGER), ?, 'user', ?, ?, ?, 1
       FROM n`,
    ).run(count, firstTs, firstTs, project, kind, text, raw);
  }

  it('checks at most the newest SCAN_LIMIT candidates of the search', async () => {
    await ingest([['old', 1000, 'see qz here']]);
    // Newer events of other kinds are not candidates of a message search, but are of a search of
    // every kind.
    bulk(SCAN_LIMIT, 10_000, 'nothing else', 'demo', 'tool_result');
    expect(messages('qz')).toEqual(['old']);
    expect(ids('qz')).toEqual([]);
    bulk(SCAN_LIMIT, 200_000, 'nothing else');
    expect(messages('qz')).toEqual([]);
    // A time range or a project that leaves fewer candidates reaches it.
    expect(messages('qz', { until: 9_999 })).toEqual(['old']);
    // Indexed terms narrow the candidates first.
    expect(messages('see qz')).toEqual(['old']);
    bulk(10, 400_000, 'other project', 'small');
    expect(messages('qz', { project: 'demo' })).toEqual([]);
    const small = { id: 'small', session: 'S2', ts: 500_000, role: 'user', project: 'small' };
    fs.writeFileSync(
      path.join(src, 'g.jsonl'),
      `${JSON.stringify({ ...small, text: 'qz in a small project' })}\n`,
    );
    await syncSource({ db, home }, fakeAdapter(src));
    expect(messages('qz', { project: 'small' })).toEqual(['small']);
  });

  it('filters by a small project through its index and a large one by reading the matches', () => {
    bulk(1_500, 1_000, 'needle in a haystack', 'big');
    bulk(1_500, 5_000, 'needle in a haystack', 'other');
    const size = db.prepare(
      `INSERT OR REPLACE INTO session (source, session_id, project, started_at, ended_at, event_count)
       VALUES ('fake', 'big-session', 'big', 1000, 2499, ?)`,
    );
    for (const events of [1_500, 1_000_000]) {
      size.run(events);
      expect(messages('needle', { project: 'big', order: 'recent', limit: 3 })).toEqual([
        'bulk2499',
        'bulk2498',
        'bulk2497',
      ]);
      expect(messages('needle', { project: 'big', limit: 5_000 })).toHaveLength(1_500);
      expect(messages('needle', { project: 'big', since: 2_400, limit: 5_000 })).toHaveLength(100);
      expect(messages('needle', { project: 'other', until: 5_009, limit: 5_000 })).toHaveLength(10);
    }
  });
});

describe('time order with many matches', () => {
  // Three imports, each of sessions spread over a time range, arriving one after the other: the
  // newer half of the time in order, then the whole range in order (a hub receiving a device's
  // history), then the whole range in random order (a first sync of unsorted files). Enough events
  // for several blocks of arrivals, read through several chains.
  async function ingestScrambled(): Promise<void> {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const words = ['sqlite', 'sqlite 部署', 'sqlite AI', 'other', 'sqlite qz', 'deploy 部署'];
    const kinds: EventKind[] = ['message', 'message', 'tool_result'];
    const imports: Array<[name: string, from: number, sorted: boolean]> = [
      ['a', 5e8, true],
      ['b', 0, true],
      ['c', 0, false],
    ];
    for (const [name, from, sorted] of imports) {
      const dir = path.join(src, name);
      fs.mkdirSync(dir);
      const starts = Array.from({ length: 16 }, () => from + Math.floor(rand() * (1e9 - from)));
      if (sorted) starts.sort((x, y) => x - y);
      starts.forEach((start, s) => {
        let ts = start;
        const project = s % 3 === 0 ? 'small' : 'demo';
        let body = '';
        for (let i = 0; i < 1100; i++) {
          ts += rand() < 0.01 ? 7_200_000 : Math.floor(rand() * 20_000); // gaps, and ties too
          const o = {
            id: `${name}${s}-${i}`,
            session: `${name}${s}`,
            ts,
            role: 'user',
            kind: kinds[Math.floor(rand() * kinds.length)],
            text: `${words[Math.floor(rand() * words.length)]} ${i}`,
            project,
          };
          body += `${JSON.stringify(o)}\n`;
        }
        fs.writeFileSync(path.join(dir, `${String(s).padStart(2, '0')}.jsonl`), body);
      });
      await syncSource({ db, home }, fakeAdapter(dir));
    }
  }

  /**
   * Brute force: every visible event matching all terms and filters, newest first; terms without an
   * index are checked against the newest SCAN_LIMIT events that match the rest only.
   */
  function expected(query: string, opts: SearchOptions): string[] {
    const terms = parseQuery(query);
    const has = (r: { text: string }, t: { text: string }) =>
      r.text.toLowerCase().includes(t.text.toLowerCase());
    const short = terms.filter((t) => t.kind === 'short');
    const rest = terms.filter((t) => t.kind !== 'short');
    const rows = db
      .prepare(
        `SELECT id, seq, ts, text, kind, project FROM event e
         WHERE NOT EXISTS (SELECT 1 FROM excluded_event x WHERE x.event_id = e.id)`,
      )
      .all() as Array<{
      id: string;
      seq: number;
      ts: number;
      text: string;
      kind: string;
      project: string;
    }>;
    const candidates = rows
      .filter(
        (r) =>
          rest.every((t) => has(r, t)) &&
          (!opts.kinds || opts.kinds.includes(r.kind as EventKind)) &&
          (!opts.project || r.project === opts.project) &&
          (opts.since === undefined || r.ts >= opts.since) &&
          (opts.until === undefined || r.ts <= opts.until),
      )
      .sort((a, b) => b.ts - a.ts || b.seq - a.seq);
    return (short.length > 0 ? candidates.slice(0, SCAN_LIMIT) : candidates)
      .filter((r) => short.every((t) => has(r, t)))
      .map((r) => r.id.replace('fake:', ''));
  }

  it('returns exactly the newest matches, in order, from any index', async () => {
    await ingestScrambled();
    const blocks = db.prepare('SELECT COUNT(*) AS n FROM event_block').get() as { n: number };
    expect(blocks.n).toBeGreaterThan(10);
    forget(
      db,
      (
        db.prepare("SELECT id FROM event WHERE text LIKE 'sqlite%' LIMIT 1 OFFSET 7").get() as {
          id: string;
        }
      ).id,
    );
    const mid = 5e8;
    const cases: Array<[string, SearchOptions]> = [
      ['sqlite', { kinds: ['message'] }],
      ['sqlite', {}],
      ['sqlite', { kinds: ['message'], since: mid }],
      ['sqlite', { kinds: ['message'], until: mid }],
      ['sqlite', { project: 'small' }],
      ['部署', { kinds: ['message'] }],
      ['部署', {}],
      ['sqlite 部署', { kinds: ['message'] }],
      ['ai', { kinds: ['message'] }],
      ['sqlite qz', {}],
      ['qz', { kinds: ['message'], project: 'small' }],
    ];
    for (const [q, opts] of cases) {
      const all = expected(q, opts);
      expect(all.length).toBeGreaterThan(0);
      for (const [limit, offset] of [
        [20, 0],
        [50, 130],
        [all.length + 5, 0],
      ] as const) {
        expect(
          ids(q, { ...opts, order: 'recent', limit, offset }),
          `${q} ${JSON.stringify(opts)}`,
        ).toEqual(all.slice(offset, offset + limit));
      }
    }
  });

  it('ranks exactly the newest RANK_WINDOW matches', async () => {
    await ingestScrambled();
    for (const opts of [{}, { kinds: ['message'] as EventKind[] }, { project: 'demo' }]) {
      const newestIds = expected('sqlite', opts).slice(0, RANK_WINDOW);
      const ranked = ids('sqlite', { ...opts, limit: RANK_WINDOW + 50 });
      expect(ranked).toHaveLength(newestIds.length);
      expect([...ranked].sort()).toEqual([...newestIds].sort());
    }
  });
});

describe('forgetting and rebuilding', () => {
  const queries: Array<[string, SearchOptions]> = [
    ['sqlite', { kinds: ['message'] }],
    ['sqlite', { kinds: ['message'], order: 'recent' }],
    ['sqlite', {}],
    ['sqlite', { order: 'recent' }],
    ['部署', { kinds: ['message'] }],
    ['部署', {}],
    ['qz', { kinds: ['message'] }],
    ['qz sqlite', {}],
  ];

  async function setUp(): Promise<void> {
    await ingest([
      ['keep', 1000, 'sqlite 部署 qz keep'],
      ['gone', 2000, 'sqlite 部署 qz gone'],
      ['tool-keep', 3000, 'sqlite 部署 qz tool keep', 'tool_result'],
      ['tool-gone', 4000, 'sqlite 部署 qz tool gone', 'tool_result'],
    ]);
  }

  it('hides forgotten events from every index (invariant 2)', async () => {
    await setUp();
    forget(db, 'fake:gone');
    forget(db, 'fake:tool-gone');
    for (const [q, opts] of queries) {
      const found = ids(q, opts);
      expect(found).not.toContain('gone');
      expect(found).not.toContain('tool-gone');
      expect(found).toContain(opts.kinds ? 'keep' : 'tool-keep');
    }
  });

  it('gives the same results after the indexes are rebuilt', async () => {
    await setUp();
    remember(db, {
      kind: 'memory',
      text: 'sqlite 部署 keeps working',
      confidence: 0.5,
      author: 'test',
      sources: [{ eventId: 'fake:keep' }],
    });
    forget(db, 'fake:gone');
    const before = queries.map(([q, opts]) => ids(q, opts));
    const entriesBefore = searchEntries(db, 'sqlite 部署').map((e) => e.id);
    rebuildSearchIndexes(db);
    expect(queries.map(([q, opts]) => ids(q, opts))).toEqual(before);
    expect(searchEntries(db, 'sqlite 部署').map((e) => e.id)).toEqual(entriesBefore);
    // The message index still holds messages only.
    expect(messages('tool')).toEqual([]);
    for (const table of ['event_fts', 'message_fts', 'entry_fts']) {
      db.exec(`INSERT INTO ${table} (${table}) VALUES ('integrity-check')`);
    }
  });
});

describe('searchEntries terms', () => {
  it('requires every term, short ones included', async () => {
    await ingest([['e', 1000, 'source event']]);
    const add = (text: string) =>
      remember(db, {
        kind: 'knowledge',
        text,
        confidence: 0.5,
        author: 'test',
        sources: [{ eventId: 'fake:e' }],
      }).id;
    const both = add('部署了新的证书');
    add('只有部署');
    const ai = add('The AI agent keeps a DB of notes');
    expect(searchEntries(db, '部署 证书').map((e) => e.id)).toEqual([both]);
    expect(searchEntries(db, 'ai db').map((e) => e.id)).toEqual([ai]);
    expect(searchEntries(db, 'notes AI').map((e) => e.id)).toEqual([ai]);
    expect(searchEntries(db, 'notes XY')).toEqual([]);
  });
});

describe('remember by quote', () => {
  const cite = (quote: string) =>
    entrySources(
      db,
      remember(db, {
        kind: 'memory',
        text: 'a statement',
        confidence: 0.5,
        author: 'test',
        sources: [{ quote }],
      }).id,
    ).map((s) => s.eventId.replace('fake:', ''));

  it('cites the newest message by time, whatever order the events arrived in', async () => {
    await ingest([['new', 5000, 'We chose SQLite with FTS5 for storage.']]);
    await ingest([['old', 1000, 'We chose SQLite with FTS5 for storage.']], 'g.jsonl');
    expect(cite('chose sqlite with  FTS5\nfor storage')).toEqual(['new']);
  });

  it('prefers messages, falls back to tool results, and never cites tool calls', async () => {
    await ingest([
      ['result', 1000, 'build failed: missing semicolon in parser.ts', 'tool_result'],
      ['msg', 2000, 'the build failed: missing semicolon in parser.ts'],
      ['call', 3000, 'remember {"quote":"missing semicolon in parser.ts"}', 'tool_use'],
      ['only-result', 4000, 'exit code 137 (out of memory)', 'tool_result'],
      ['only-call', 5000, 'remember {"quote":"never in a message or result"}', 'tool_use'],
    ]);
    expect(cite('Missing semicolon in parser.ts')).toEqual(['msg']);
    expect(cite('exit code 137 (out of memory)')).toEqual(['only-result']);
    expect(() => cite('never in a message or result')).toThrow(OriginError);
  });

  it('skips forgotten events', async () => {
    await ingest([
      ['older', 1000, 'deploy the certificate on Friday'],
      ['newer', 2000, 'deploy the certificate on Friday'],
    ]);
    forget(db, 'fake:newer');
    expect(cite('deploy the certificate on friday')).toEqual(['older']);
    forget(db, 'fake:older');
    expect(() => cite('deploy the certificate on friday')).toThrow(/No event contains the quote/);
  });

  it('finds quotes of short words, CJK or not, and quotes with wildcards or quotes', async () => {
    await ingest([
      ['zh', 1000, '我们先部署 再换证书'],
      ['short', 2000, 'it is ok to go'],
      ['wild', 3000, 'coverage is 100% for a_b "quoted"'],
    ]);
    expect(cite('部署 再换证书')).toEqual(['zh']);
    expect(cite('is ok to')).toEqual(['short']);
    expect(cite('100% for a_b "quoted"')).toEqual(['wild']);
    expect(() => cite('100% for axb')).toThrow(OriginError);
  });
});
