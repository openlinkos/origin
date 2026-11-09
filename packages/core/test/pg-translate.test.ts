import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { inSqlite } from '../../../test/pg.js';
import {
  activeProjects,
  changesSince,
  digest,
  entrySources,
  eventActivity,
  forget,
  getEvent,
  ingestHealth,
  listEntries,
  listEvents,
  listProjects,
  listProposals,
  listSessionEvents,
  listSessions,
  openDatabase,
  rebuildSearchIndexes,
  recallFacets,
  remember,
  restore,
  searchEntries,
  searchEvents,
  sessionPrompts,
  stats,
  syncSource,
} from '../src/index.js';
import {
  forbiddenIn,
  TRANSLATIONS_KEPT,
  TranslateError,
  Translator,
  translate,
} from '../src/pg/translate.js';
import { latestPrompts } from '../src/recall.js';
import { fakeAdapter, line } from './helpers.js';

const sql = (s: string) => translate(s).sql;

describe('translating SQL for PostgreSQL', () => {
  it('numbers the parameters', () => {
    const t = translate('SELECT * FROM t WHERE a = ? AND b IN (?, ?) AND c = ?::bigint');
    expect(t.sql).toBe('SELECT * FROM t WHERE a = $1 AND b IN ($2, $3) AND c = $4::bigint');
    expect(t.params).toBe(4);
    expect(translate('SELECT 1').params).toBe(0);
  });

  it('never rewrites strings, quoted identifiers, or comments', () => {
    const text = `SELECT 'it''s ? LIKE instr(x) CROSS JOIN' AS "a?b ""LIKE""", -- why ? LIKE instr(
      x /* ? CROSS JOIN t ON INDEXED BY i NOT INDEXED */ FROM t WHERE y = ? AND z <> ''`;
    expect(sql(text)).toBe(
      `SELECT 'it''s ? LIKE instr(x) CROSS JOIN' AS "a?b ""LIKE""", -- why ? LIKE instr(
      x /* ? CROSS JOIN t ON INDEXED BY i NOT INDEXED */ FROM t WHERE y = $1 AND z <> ''`,
    );
    // PostgreSQL's own strings, from fragments written for it.
    expect(sql(`SELECT E'\\'?', $$ ? 'x $$, $f$ ? $$ $f$, a ->> 'k', b @> ARRAY[?] FROM t`)).toBe(
      `SELECT E'\\'?', $$ ? 'x $$, $f$ ? $$ $f$, a ->> 'k', b @> ARRAY[$1] FROM t`,
    );
    // A blob, then a parameter.
    expect(sql(`SELECT X'3F', ?`)).toBe(`SELECT X'3F', $1`);
  });

  it('turns LIKE into ILIKE, and instr( into strpos(', () => {
    expect(sql(`SELECT 1 FROM tombstone t WHERE t.target NOT LIKE 'tmb\\_%' ESCAPE '\\'`)).toBe(
      `SELECT 1 FROM tombstone t WHERE t.target NOT ILIKE 'tmb\\_%' ESCAPE '\\'`,
    );
    expect(sql(`SELECT a like ? ESCAPE '\\' FROM t`)).toBe(`SELECT a ilike $1 ESCAPE '\\' FROM t`);
    expect(sql('SELECT instr(e.text, ?) > 0, INSTR (a, b), t.instr, instr FROM t')).toBe(
      'SELECT strpos(e.text, $1) > 0, STRPOS (a, b), t.instr, instr FROM t',
    );
  });

  it("drops SQLite's index hints", () => {
    expect(sql('SELECT 1 FROM event e INDEXED BY event_user_message\n  WHERE e.seq = ?')).toBe(
      'SELECT 1 FROM event e\n  WHERE e.seq = $1',
    );
    expect(sql('SELECT 1 FROM event INDEXED BY "event_ts" WHERE 1 = 1')).toBe(
      'SELECT 1 FROM event WHERE 1 = 1',
    );
    expect(sql('SELECT 1 FROM event e NOT INDEXED WHERE NOT x')).toBe(
      'SELECT 1 FROM event e WHERE NOT x',
    );
  });

  it('turns CROSS JOIN with a join condition into JOIN, and leaves a true cross join', () => {
    expect(
      sql(`FROM session s CROSS JOIN event e INDEXED BY event_session
         ON e.source = s.source`),
    ).toBe(`FROM session s JOIN event e
         ON e.source = s.source`);
    expect(sql('FROM a CROSS JOIN b USING (id) CROSS JOIN c AS x ON x.id = a.id')).toBe(
      'FROM a JOIN b USING (id) JOIN c AS x ON x.id = a.id',
    );
    expect(
      sql('FROM a CROSS JOIN (SELECT id FROM b JOIN c ON c.id = b.id) AS d ON d.id = a.id'),
    ).toBe('FROM a JOIN (SELECT id FROM b JOIN c ON c.id = b.id) AS d ON d.id = a.id');
    // No condition of its own: a cross join on both engines.
    for (const kept of [
      'FROM a CROSS JOIN b WHERE a.x = b.x',
      'FROM a CROSS JOIN b LEFT JOIN c ON c.id = b.id',
      'FROM a CROSS JOIN json_each(?) j, d',
      'SELECT (SELECT 1 FROM a CROSS JOIN b) FROM c JOIN d ON d.x = c.x',
      'INSERT INTO t SELECT * FROM a CROSS JOIN b ON CONFLICT DO NOTHING',
    ]) {
      expect(sql(kept)).toBe(kept.replace('?', '$1'));
    }
  });

  it('says what each statement does', () => {
    const kind = (s: string) => translate(s).kind;
    expect(kind('SELECT 1')).toBe('read');
    expect(kind('  -- a comment\n VALUES (1)')).toBe('read');
    expect(kind('WITH RECURSIVE n(i) AS (SELECT 1) SELECT i FROM n')).toBe('read');
    expect(kind('SELECT \'DELETE\' AS "update" FROM t')).toBe('read');
    expect(kind('(SELECT 1) UNION (SELECT 2)')).toBe('read');
    expect(kind('INSERT INTO t VALUES (?) ON CONFLICT DO NOTHING')).toBe('write');
    expect(kind('update t SET a = 1')).toBe('write');
    expect(kind('DELETE FROM t')).toBe('write');
    expect(kind('WITH n(i) AS (SELECT 1) INSERT INTO t SELECT i FROM n')).toBe('write');
    expect(kind('WITH d AS (DELETE FROM t RETURNING id) SELECT count(*) FROM d')).toBe('write');
    expect(kind('CREATE TABLE IF NOT EXISTS t (a INTEGER)')).toBe('ddl');
    expect(kind('ALTER TABLE t ADD COLUMN b TEXT')).toBe('ddl');
    expect(kind('DROP INDEX x')).toBe('ddl');
    expect(kind('PRAGMA user_version')).toBe('other');
    expect(kind('')).toBe('other');
    // Several statements: the most of them.
    const several = translate('DELETE FROM a; CREATE TEMP TABLE b (x); SELECT 1;');
    expect(several.statements).toBe(3);
    expect(several.kind).toBe('ddl');
    expect(translate('SELECT 1; DELETE FROM a').kind).toBe('write');
    // A SQLite trigger is one statement, whatever its body holds.
    const trigger = translate(`CREATE TRIGGER IF NOT EXISTS x AFTER INSERT ON t BEGIN
      INSERT INTO u (a) VALUES (CASE WHEN new.a THEN 1 ELSE 2 END);
      SELECT RAISE(ABORT, 'no; never');
    END;
    CREATE INDEX IF NOT EXISTS y ON t (a);`);
    expect(trigger.statements).toBe(2);
    expect(trigger.kind).toBe('ddl');
  });

  it('reads transaction control', () => {
    const control = (s: string) => {
      const t = translate(s);
      expect(t.kind).toBe('transaction');
      return t.control;
    };
    expect(control('BEGIN IMMEDIATE')).toEqual({ op: 'begin', mode: 'immediate' });
    expect(control('BEGIN')).toEqual({ op: 'begin', mode: 'deferred' });
    expect(control('begin exclusive transaction;')).toEqual({ op: 'begin', mode: 'exclusive' });
    expect(control('COMMIT')).toEqual({ op: 'commit' });
    expect(control('END TRANSACTION')).toEqual({ op: 'commit' });
    expect(control('ROLLBACK')).toEqual({ op: 'rollback' });
    expect(control('SAVEPOINT apply_tombstone')).toEqual({
      op: 'savepoint',
      name: 'apply_tombstone',
    });
    expect(control('ROLLBACK TO apply_tombstone')).toEqual({
      op: 'rollback to',
      name: 'apply_tombstone',
    });
    expect(control('ROLLBACK TRANSACTION TO SAVEPOINT "a b"')).toEqual({
      op: 'rollback to',
      name: '"a b"',
    });
    expect(control('RELEASE SAVEPOINT x')).toEqual({ op: 'release', name: 'x' });
    expect(translate('SELECT 1').control).toBeUndefined();
    for (const bad of ['BEGIN; SELECT 1', 'COMMIT; BEGIN', 'BEGIN ISOLATION LEVEL SERIALIZABLE']) {
      expect(() => translate(bad)).toThrow(TranslateError);
    }
  });

  it('refuses what it cannot translate', () => {
    expect(() => translate("SELECT 'open")).toThrow(/unterminated string/);
    expect(() => translate('SELECT "open')).toThrow(/unterminated identifier/);
    expect(() => translate('SELECT $$ open')).toThrow(/unterminated dollar/);
    expect(() => translate('SELECT ?1')).toThrow(/numbered parameters/);
    expect(() => translate('SELECT $1')).toThrow(/other than \?/);
    expect(() => translate('SELECT $name')).toThrow(/other than \?/);
  });

  it('keeps the latest translations', () => {
    const t = new Translator({ size: 3 });
    const [a, b, c, d] = ['SELECT ?', 'SELECT 2', 'SELECT 3', 'SELECT 4'] as const;
    const first = t.translate(a);
    const second = t.translate(b);
    t.translate(c);
    expect(t.translate(a)).toBe(first);
    // a was used after b, so b goes.
    t.translate(d);
    expect(t.translate(a)).toBe(first);
    const again = t.translate(b);
    expect(again).not.toBe(second);
    expect(again).toEqual(second);

    const many = new Translator();
    const kept = many.translate('SELECT 0');
    for (let i = 1; i < TRANSLATIONS_KEPT; i++) many.translate(`SELECT ${i}`);
    expect(many.translate('SELECT 0')).toBe(kept);
    for (let i = 0; i < TRANSLATIONS_KEPT; i++) many.translate(`SELECT ${i + TRANSLATIONS_KEPT}`);
    expect(many.translate('SELECT 0')).not.toBe(kept);
  });

  it('finds, in test mode, what PostgreSQL does not have, outside strings and comments', () => {
    const found = (s: string) => forbiddenIn(translate(s).sql);
    const cases: Array<[string, string]> = [
      ['INSERT OR IGNORE INTO t VALUES (1)', 'INSERT OR'],
      ['insert or replace into t values (1)', 'INSERT OR'],
      ['REPLACE INTO t VALUES (1)', 'REPLACE INTO'],
      ["SELECT json_extract(meta, '$.a') FROM t", 'json_extract('],
      ['SELECT value FROM json_each(?)', 'json_each('],
      ["SELECT group_concat(id, ' ') FROM t", 'group_concat('],
      ["SELECT julianday('now')", 'julianday('],
      ['PRAGMA user_version', 'PRAGMA'],
      ["SELECT name FROM sqlite_master WHERE type = 'table'", 'SQLITE_MASTER'],
      ['SELECT rowid FROM event_fts WHERE event_fts MATCH ?', 'MATCH'],
      ['SELECT bm25(event_fts) FROM event_fts', 'bm25('],
      ['SELECT char(31)', 'char('],
      ['SELECT * FROM t LIMIT -1', 'LIMIT -1'],
      ['SELECT origin_cjk(text, kind) FROM event', 'origin_cjk('],
      ['SELECT origin_prompt(text) FROM event', 'origin_prompt('],
      ['CREATE TABLE t (a TEXT PRIMARY KEY) WITHOUT ROWID', 'WITHOUT ROWID'],
      ["SELECT json_extract(meta, '$.s') IS 1 FROM t", 'IS 1'],
      ['SELECT 1 FROM t WHERE a IS NOT ?', 'IS NOT'],
      ['SELECT MAX(a, b) FROM t', 'MAX(a, b)'],
      ['SELECT ifnull(a, 0) FROM t', 'ifnull('],
      ["SELECT RAISE(ABORT, 'no')", 'raise('],
      ["SELECT 1 FROM t WHERE a GLOB 'x*'", 'GLOB'],
      ["SELECT X'00'", "blob literal X'00'"],
      ['SELECT 1 FROM t WHERE a LIKE ?', 'LIKE pattern without ESCAPE'],
      ["SELECT 1 FROM t WHERE a LIKE '%' || ? || '%' AND b = 1", 'LIKE pattern without ESCAPE'],
      ["SELECT 1 FROM t WHERE a LIKE 'a\\_b'", 'LIKE pattern with a backslash and no ESCAPE'],
      ['SELECT 1 /* a /* nested */ FROM t', 'a comment inside a comment'],
    ];
    for (const [text, problem] of cases) {
      expect(found(text).join('; '), text).toContain(problem);
    }
    for (const fine of [
      "SELECT 'INSERT OR IGNORE, PRAGMA, json_extract(, char(31), LIMIT -1, MATCH' AS x",
      'SELECT "json_each", "MATCH" FROM t -- PRAGMA, bm25(\n',
      'INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING',
      'SELECT MAX(a), MIN(DISTINCT b), MAX(a) OVER (ORDER BY b), GREATEST(a, b) FROM t',
      'SELECT 1 FROM t WHERE a IS NULL AND b IS NOT NULL AND c IS NOT DISTINCT FROM ?',
      "SELECT CASE WHEN note LIKE 'device %' THEN 1 END FROM t WHERE path LIKE '@%:%'",
      "SELECT 1 FROM t WHERE a LIKE ? ESCAPE '\\' AND b NOT LIKE 'tmb\\_%' ESCAPE '\\'",
      "SELECT CAST(a AS char(3)), b::char(2) FROM t WHERE c = replace(d, 'x', 'y')",
      'SELECT * FROM t LIMIT ? OFFSET ?',
    ]) {
      expect(found(fine), fine).toEqual([]);
    }

    const checked = new Translator({ check: true });
    expect(() => checked.translate('INSERT OR IGNORE INTO t VALUES (?)')).toThrow(
      /not for PostgreSQL \(INSERT OR\)/,
    );
    expect(checked.translate("SELECT 'PRAGMA' FROM t WHERE a = ?").params).toBe(1);
    // Unchecked, it is translated as it is.
    expect(new Translator().translate('INSERT OR IGNORE INTO t VALUES (?)').sql).toBe(
      'INSERT OR IGNORE INTO t VALUES ($1)',
    );
  });
});

/** Strings, quoted identifiers, and comments, in order: what translation must leave as it is. */
const LITERALS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
const literals = (s: string) => s.match(LITERALS) ?? [];
const code = (s: string) => s.replace(LITERALS, ' ');

/** What a translation must look like, checked without the translator's own tokenizer. */
function looksValid(original: string, method: 'prepare' | 'exec'): void {
  const t = translate(original);
  const out = code(t.sql);
  expect(literals(t.sql)).toEqual(literals(original));
  expect(t.params).toBe(code(original).split('?').length - 1);
  expect([...out.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))).toEqual(
    Array.from({ length: t.params }, (_, i) => i + 1),
  );
  expect(out).not.toMatch(/\?|\bINDEXED\b|\bLIKE\b|\binstr\s*\(|\bCROSS\s+JOIN\b/i);
  let depth = 0;
  for (const c of out) {
    if (c === '(') depth++;
    else if (c === ')') expect(--depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
  if (method === 'prepare') {
    expect(t.statements).toBe(1);
    expect(t.kind).not.toBe('transaction');
  }
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(original)) {
    expect(t.kind).toBe('transaction');
  }
}

describe("translating Origin's own SQL", () => {
  it('translates statements from core as written', () => {
    // overview.ts, eventActivity: an index hint inside a join that keeps its order.
    expect(
      sql(`SELECT s.source AS source, CAST(e.ts / ? AS INTEGER) * ? AS start, COUNT(*) AS n
       FROM session s CROSS JOIN event e INDEXED BY event_session
         ON e.source = s.source AND e.session_id = s.session_id
       WHERE s.ended_at >= ? AND e.ts >= ? AND e.ts < ?
       GROUP BY 1, 2, 3`),
    ).toBe(`SELECT s.source AS source, CAST(e.ts / $1 AS INTEGER) * $2 AS start, COUNT(*) AS n
       FROM session s JOIN event e
         ON e.source = s.source AND e.session_id = s.session_id
       WHERE s.ended_at >= $3 AND e.ts >= $4 AND e.ts < $5
       GROUP BY 1, 2, 3`);
    // search.ts, rangeQuery: the trigram index's statement (its MATCH is left to the search driver).
    const range = translate(`SELECT f.rowid AS seq, x.ts AS ts, (e.kind IN (?)) AS cand, 1 AS pass
      FROM event_fts f CROSS JOIN event x INDEXED BY event_seq_ts ON x.seq = f.rowid CROSS JOIN event e ON e.seq = f.rowid
      WHERE event_fts MATCH ? AND f.rowid BETWEEN ? AND ? AND +f.rowid NOT IN (SELECT ev.seq FROM excluded_event x JOIN event ev ON ev.id = x.event_id)
      AND e.text LIKE ? ESCAPE '\\'
      ORDER BY f.rowid DESC`);
    expect(range.sql).toBe(`SELECT f.rowid AS seq, x.ts AS ts, (e.kind IN ($1)) AS cand, 1 AS pass
      FROM event_fts f JOIN event x ON x.seq = f.rowid JOIN event e ON e.seq = f.rowid
      WHERE event_fts MATCH $2 AND f.rowid BETWEEN $3 AND $4 AND +f.rowid NOT IN (SELECT ev.seq FROM excluded_event x JOIN event ev ON ev.id = x.event_id)
      AND e.text ILIKE $5 ESCAPE '\\'
      ORDER BY f.rowid DESC`);
    expect(forbiddenIn(range.sql)).toEqual(['MATCH']);
    // parents.ts: instr( in a recursive query; char(31) is for the portable rewrites to replace.
    const parents = translate(`WITH RECURSIVE hang(source, id, anc_source, anc_id, seen) AS (
      SELECT p.source, p.session_id, p.parent_source, p.parent_session_id, char(31) FROM session_parent p
      UNION ALL
      SELECT hang.source, hang.id, p.parent_source, p.parent_session_id,
             hang.seen || hang.anc_source || char(31) || hang.anc_id || char(31)
      FROM hang JOIN session_parent p ON p.source = hang.anc_source AND p.session_id = hang.anc_id
      WHERE instr(hang.seen, char(31) || hang.anc_source || char(31) || hang.anc_id || char(31)) = 0)
    SELECT source, id FROM hang WHERE source = ?`);
    expect(parents.kind).toBe('read');
    expect(parents.sql).toContain('WHERE strpos(hang.seen, char(31) ||');
    expect(new Set(forbiddenIn(parents.sql))).toEqual(new Set(['char(']));
    // forgetting.ts, relay.ts, places.ts: LIKE on literals and with ESCAPE.
    for (const [from, to] of [
      [
        `t.target NOT LIKE 'tmb\\_%' ESCAPE '\\' AND t.created_at <= ?`,
        `t.target NOT ILIKE 'tmb\\_%' ESCAPE '\\' AND t.created_at <= $1`,
      ],
      [
        `SELECT id FROM sync_log WHERE source = ? AND note LIKE 'relay%' ORDER BY id DESC LIMIT 1`,
        `SELECT id FROM sync_log WHERE source = $1 AND note ILIKE 'relay%' ORDER BY id DESC LIMIT 1`,
      ],
      [
        `SELECT r.path FROM raw_file r WHERE r.path LIKE '@%:%'`,
        `SELECT r.path FROM raw_file r WHERE r.path ILIKE '@%:%'`,
      ],
    ] as const) {
      expect(sql(from)).toBe(to);
      expect(forbiddenIn(to)).toEqual([]);
    }
    // forgetting.ts, applyTombstone: a savepoint around the work that may fail.
    expect(translate('SAVEPOINT apply_tombstone').control).toEqual({
      op: 'savepoint',
      name: 'apply_tombstone',
    });
  });

  it('translates every statement core runs in a day of work', async () => {
    // Every SQL text the store runs, through node:sqlite itself, from its creation on.
    const seen = new Map<string, 'prepare' | 'exec'>();
    const proto = DatabaseSync.prototype;
    const { prepare, exec } = proto;
    proto.prepare = function (this: DatabaseSync, text: string) {
      if (!seen.has(text)) seen.set(text, 'prepare');
      return prepare.call(this, text);
    } as typeof prepare;
    proto.exec = function (this: DatabaseSync, text: string) {
      seen.set(text, 'exec');
      return exec.call(this, text);
    } as typeof exec;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
    try {
      // Through node:sqlite, whatever engine the run's stores are in.
      const db = inSqlite(() => openDatabase(path.join(home, 'origin.db')));
      try {
        fs.writeFileSync(
          path.join(src, 'a.jsonl'),
          [
            line('u1', 'S1', 1000, 'user', 'deploy the sqlite database 数据库 部署'),
            line('a1', 'S1', 2000, 'assistant', 'Deploying now: sqlite migrations run'),
            line('t1', 'S1', 3000, 'assistant', 'grep -n LIKE src', 'tool_use'),
            line('u2', 'S2', 4000, 'user', 'AI and C# notes about a naïve café'),
          ].join(''),
        );
        await syncSource({ db, home }, fakeAdapter(src));
        for (const q of ['sqlite', 'sqlite database', '数据库', '部署', 'AI', 'C# café', 'naïve']) {
          searchEvents(db, q);
          searchEvents(db, q, { kinds: ['message'] });
          searchEvents(db, q, { order: 'recent', project: 'demo', since: 0, until: 5000 });
        }
        listSessions(db, {});
        listSessionEvents(db, { source: 'fake', sessionId: 'S1' });
        listEvents(db, {});
        getEvent(db, 'fake:u1');
        stats(db);
        listProjects(db);
        sessionPrompts(db, 'fake', 'S1');
        latestPrompts(db);
        const entry = remember(db, {
          kind: 'memory',
          text: 'the hub runs sqlite',
          confidence: 0.9,
          author: 'test',
          sources: [{ eventId: 'fake:u1' }],
        });
        searchEntries(db, 'sqlite');
        searchEntries(db, 'hub AI');
        listEntries(db);
        entrySources(db, entry.id);
        const forgot = forget(db, 'fake:a1', { reason: 'a test' });
        restore(db, forgot.tombstoneId as string, { reason: 'a test' });
        eventActivity(db, { since: 0, until: 10_000 });
        activeProjects(db, { since: 0 });
        ingestHealth(db, { since: 0 });
        digest(db, { now: 5000 });
        changesSince(db);
        listProposals(db);
        recallFacets(db);
        rebuildSearchIndexes(db);
      } finally {
        db.close();
      }
    } finally {
      proto.prepare = prepare;
      proto.exec = exec;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
    }

    expect(seen.size).toBeGreaterThan(100);
    const kinds = new Set<string>();
    const pending = new Set<string>();
    for (const [text, method] of seen) {
      looksValid(text, method);
      kinds.add(translate(text).kind);
      for (const problem of forbiddenIn(translate(text).sql)) pending.add(problem);
    }
    for (const kind of ['read', 'write', 'ddl', 'transaction']) expect(kinds).toContain(kind);
    // What is left for PostgreSQL is SQLite's own SQL, which portable rewrites, dialect helpers,
    // the search drivers, and the PostgreSQL schema replace: never anything else, such as a false
    // alarm of the checks on SQL that is fine.
    const expected = new Set([
      'INSERT OR',
      'json_extract(',
      'json_each(',
      'group_concat(',
      'julianday(',
      'PRAGMA',
      'SQLITE_MASTER',
      'MATCH',
      'bm25(',
      'char(',
      'LIMIT -1',
      'origin_cjk(',
      'origin_prompt(',
      'WITHOUT ROWID',
      'IS 1',
      'MAX(a, b)',
      'raise(',
    ]);
    expect([...pending].filter((p) => !expected.has(p))).toEqual([]);
  });
});
