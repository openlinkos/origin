import { OriginError, STORE_VERSION, StoreUpgradedError } from '@openlinkos/origin-core';
import { describe, expect, it } from 'vitest';
import { ConnectionLostError, PgError } from '../../src/pg/client.js';
import { parseDatabaseUrl } from '../../src/pg/url.js';
import {
  backend,
  onPostgres,
  open,
  outside,
  sleep,
  target,
  terminateLater,
  urls,
  usePostgres,
} from './helpers.js';

usePostgres();

/** The error `fn` throws. */
function thrown(fn: () => unknown): Error & Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error('expected an error');
}

/** A client of a new schema with table `t` (id, g, v). */
function withTable(rows = 0) {
  const db = open(target());
  db.exec('CREATE TABLE t (id BIGINT PRIMARY KEY, g BIGINT NOT NULL DEFAULT 0, v TEXT)');
  if (rows > 0) {
    db.exec(
      `INSERT INTO t (id, g, v) SELECT n, n % 16, 'row ' || n FROM generate_series(1, ${rows}) n`,
    );
  }
  return db;
}

describe.skipIf(!onPostgres)('opening a store in PostgreSQL', () => {
  it('creates the schema and what the client needs, once', async () => {
    const t = target();
    const db = open(t, { command: 'test' });
    expect(db.dialect).toBe('postgres');
    expect(db.formatVersion()).toBe(0);
    expect(db.hasTable('store_format')).toBe(true);
    expect(db.hasColumn('store_format', 'moved_to')).toBe(true);
    expect(db.hasColumn('store_format', 'nope')).toBe(false);
    expect(db.hasTable('pg_class')).toBe(false);
    const [fn] = await outside(
      `SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'origin_lock_key'`,
      [t.schema],
    );
    expect(fn?.proconfig).toEqual([`search_path=${t.schema}`]);
    db.setFormatVersion(STORE_VERSION);
    expect(db.formatVersion()).toBe(STORE_VERSION);
    const [row] = await outside(`SELECT version, store_id FROM ${t.schema}.store_format`);
    expect(row?.version).toBe(STORE_VERSION);
    expect(row?.store_id).toMatch(/^[0-9a-f-]{36}$/);
    db.close();
    // Opened again, it finds them and changes nothing.
    const again = open(t);
    expect(again.formatVersion()).toBe(STORE_VERSION);
    expect(() => again.setFormatVersion(-1)).toThrow(/format version/);
  });

  it('sets up the session', () => {
    const t = target();
    const db = open(t, { command: 'serve', statementTimeoutMs: 120_000 });
    const show = (name: string) =>
      (db.prepare(`SELECT current_setting('${name}') AS v`).get() as { v: string }).v;
    expect(show('search_path')).toBe(t.schema);
    expect(show('statement_timeout')).toBe('2min');
    expect(show('idle_in_transaction_session_timeout')).toBe('5min');
    expect(show('synchronous_commit')).toBe('on');
    expect(show('plan_cache_mode')).toBe('force_custom_plan');
    expect(show('jit')).toBe('off');
    expect(show('work_mem')).toBe('64MB');
    expect(show('client_encoding')).toBe('UTF8');
    expect(show('application_name')).toMatch(/^origin serve .+:\d+$/);
  });

  it('says where it is without the password', () => {
    const db = open(target('shown'));
    expect(db.location()).toMatch(/^postgres(ql)?:\/\/[^@]*@[^?]+\?schema=shown$/);
    const password = new URL(urls().database).password;
    if (password) {
      expect(db.location()).not.toContain(password);
      expect(db.location()).toContain(':***@');
    }
  });

  it('refuses a database whose locale is not C, saying how to create one', async () => {
    const name = `origin_test_cutf8_${process.pid}`;
    await outside(
      `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'`,
      [],
      urls().server,
    );
    try {
      const u = new URL(urls().database);
      u.pathname = `/${name}`;
      const err = thrown(() => open(parseDatabaseUrl(u.href)));
      expect(err).toBeInstanceOf(OriginError);
      expect(err.message).toContain('C.UTF-8');
      expect(err.message).toContain(
        "CREATE DATABASE origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';",
      );
    } finally {
      await outside(`DROP DATABASE ${name} WITH (FORCE)`, [], urls().server);
    }
  });

  it('refuses a wrong password without showing it', () => {
    const u = new URL(urls().database);
    u.username = u.username || 'postgres';
    u.password = 'not-the-password-1234';
    const err = thrown(() => open(parseDatabaseUrl(u.href)));
    expect(err).toBeInstanceOf(OriginError);
    expect(err.message).toMatch(/^Cannot open the store at postgres(ql)?:\/\/[^:]+:\*\*\*@/);
    expect(err.message).not.toContain('not-the-password-1234');
    expect((err.cause as PgError).code).toMatch(/^28/);
  });
});

describe.skipIf(!onPostgres)('values', () => {
  it('reads values as node:sqlite does', () => {
    const db = open(target());
    const row = db
      .prepare(
        `SELECT 1::int2 AS a, 2::int4 AS b, 3::int8 AS c, 4.5::float8 AS d, 0.1::float4 AS e,
                (0.1::float8 + 0.2::float8) AS f, 12345.678::numeric AS g, sum(x) AS h,
                true AS i, false AS j, NULL::text AS k, '{"b": 1, "a": [2]}'::json AS l,
                '{"b": 1, "a": [2]}'::jsonb AS m, 'text' AS n, '\\x00ff10'::bytea AS o,
                now()::date::text AS p, 9007199254740991::int8 AS q
         FROM (VALUES (1::int8), (2::int8)) v(x)`,
      )
      .get() as Record<string, unknown>;
    expect(Object.getPrototypeOf(row)).toBe(null);
    expect(row).toEqual({
      a: 1,
      b: 2,
      c: 3,
      d: 4.5,
      e: 0.1,
      f: 0.1 + 0.2,
      g: 12345.678,
      h: 3,
      i: 1,
      j: 0,
      k: null,
      l: '{"b": 1, "a": [2]}',
      m: '{"a": [2], "b": 1}',
      n: 'text',
      o: new Uint8Array([0, 255, 16]),
      p: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      q: Number.MAX_SAFE_INTEGER,
    });
    // Of two columns of one name, the last.
    expect(db.prepare('SELECT 1 AS a, 2 AS a').get()).toEqual({ a: 2 });
  });

  it('fails on integers beyond 2^53, as node:sqlite does', () => {
    const db = open(target());
    for (const sql of [
      'SELECT 9007199254740992::int8 AS n',
      'SELECT -9007199254740993::int8 AS n',
      'SELECT 1e20::numeric AS n',
    ]) {
      const err = thrown(() => db.prepare(sql).get());
      expect(err).toBeInstanceOf(RangeError);
      expect(err.code).toBe('ERR_OUT_OF_RANGE');
      expect(err.message).toMatch(/^Value is too large to be represented as a JavaScript number/);
    }
    // The connection goes on.
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
  });

  it('binds values as node:sqlite does, and U+0000 as U+FFFD', () => {
    const db = withTable();
    db.exec('CREATE TABLE b (k TEXT, n BIGINT, x DOUBLE PRECISION, y BYTEA)');
    const text = 'a\u0000b 中文 😀 Ä\u0000';
    db.prepare('INSERT INTO b (k, n, x, y) VALUES (?, ?, ?, ?)').run(
      text,
      2n ** 52n,
      1 / 3,
      new Uint8Array([1, 2, 0, 255]),
    );
    expect(db.prepare('SELECT * FROM b').get()).toEqual({
      k: 'a�b 中文 😀 Ä�',
      n: 2 ** 52,
      x: 1 / 3,
      y: new Uint8Array([1, 2, 0, 255]),
    });
    // A boolean binds as 1 or 0, missing parameters as NULL; undefined and objects are refused.
    expect(db.prepare('SELECT ? AS a, ? AS b, ? AS c').get(true as never, false as never)).toEqual({
      a: '1',
      b: '0',
      c: null,
    });
    const undef = thrown(() => db.prepare('SELECT ? AS a').get(undefined as never));
    expect(undef).toBeInstanceOf(TypeError);
    expect(undef.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(() => db.prepare('SELECT ? AS a').get({} as never)).toThrow(TypeError);
    expect(() => db.prepare('SELECT ? AS a').get(1, 2)).toThrow(RangeError);
  });

  it('has no rowid of the last insert, and counts changes', () => {
    const db = withTable(10);
    const r = db.prepare('UPDATE t SET v = ? WHERE id <= ?').run('x', 4);
    expect(r.changes).toBe(4);
    expect(() => r.lastInsertRowid).toThrow(/RETURNING/);
    expect(db.prepare('SELECT 1').run().changes).toBe(0);
    expect(db.prepare('DELETE FROM t WHERE id > ?').run(8).changes).toBe(2);
  });
});

describe.skipIf(!onPostgres)('translated SQL', () => {
  it('runs SQL written for SQLite', () => {
    const db = withTable();
    db.prepare('INSERT INTO t (id, v) VALUES (?, ?), (?, ?), (?, ?)').run(
      1,
      'Hello',
      2,
      'ÄBC',
      3,
      'äbc',
    );
    // LIKE ignores ASCII case only, as SQLite's does.
    expect(db.prepare("SELECT id FROM t WHERE v LIKE 'hel%'").all()).toEqual([{ id: 1 }]);
    expect(db.prepare("SELECT id FROM t WHERE v LIKE 'äb%' ORDER BY id").all()).toEqual([
      { id: 3 },
    ]);
    expect(db.prepare("SELECT instr(v, 'l') AS i FROM t WHERE id = 1").get()).toEqual({ i: 3 });
    expect(db.prepare('SELECT lower(v) AS l FROM t WHERE id = 2').get()).toEqual({ l: 'Äbc' });
  });

  it('refuses SQLite-only SQL in test mode', () => {
    const db = open(target());
    expect(() => db.prepare("SELECT json_extract('{}', '$.a')")).toThrow(/not for PostgreSQL/);
    expect(() => db.exec('INSERT OR IGNORE INTO x VALUES (1)')).toThrow(/INSERT OR/);
    expect(() => db.prepare('SELECT 1; SELECT 2')).toThrow(/one statement/);
    const lenient = open(target(), { checkSql: false });
    expect(() => lenient.prepare("SELECT json_extract('{}', '$.a')")).not.toThrow();
  });
});

describe.skipIf(!onPostgres)('get()', () => {
  it('runs a query for its first row only', () => {
    const db = open(target());
    const q = 'SELECT 1 / (2 - g) AS x FROM generate_series(1, 3) g';
    // The second row would divide by zero.
    expect(db.prepare(q).get()).toEqual({ x: 1 });
    expect(thrown(() => db.prepare(q).all()).code).toBe('22012');
    expect(db.prepare('SELECT 1 AS x WHERE false').get()).toBeUndefined();
    // An error before the first row leaves the connection usable.
    expect(thrown(() => db.prepare('SELECT * FROM missing').get()).code).toBe('42P01');
    expect(db.prepare('SELECT 2 AS x').get()).toEqual({ x: 2 });
  });

  it('runs a write whole, returning its first row', () => {
    const db = withTable();
    const first = db
      .prepare('INSERT INTO t (id) SELECT n FROM generate_series(1, 5) n RETURNING id')
      .get();
    expect(first).toEqual({ id: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 5 });
  });
});

describe.skipIf(!onPostgres)('iterate()', () => {
  it('reads a large result in batches', () => {
    const db = open(target());
    const started = performance.now();
    let rows = 0;
    let bytes = 0;
    let last = 0;
    for (const r of db
      .prepare("SELECT g, repeat('x', 1000) || g AS s FROM generate_series(1, ?) g ORDER BY g")
      .iterate(100_000) as Iterable<{ g: number; s: string }>) {
      expect(r.g).toBe(last + 1);
      last = r.g;
      rows++;
      bytes += r.s.length;
    }
    expect(rows).toBe(100_000);
    expect(bytes).toBeGreaterThan(100_000_000);
    expect(db.isTransaction).toBe(false);
    // About 100 MB: a few seconds at most.
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it('refuses all() of more than the cap, which iterate() reads', () => {
    const db = open(target(), { resultCapBytes: 1_000_000 });
    const q = db.prepare("SELECT repeat('x', 1000) AS s FROM generate_series(1, 2000)");
    expect(thrown(() => q.all()).message).toMatch(/larger than .* iterate\(\)/);
    expect([...q.iterate()].length).toBe(2000);
  });

  it('reads 16 iterators interleaved, in one snapshot, which ends with the last', () => {
    const db = withTable(16 * 300);
    const other = open(db.target);
    const its = Array.from({ length: 16 }, (_, g) =>
      db.prepare('SELECT id FROM t WHERE g = ? ORDER BY id').iterate(g),
    );
    const seen: number[][] = its.map(() => []);
    const done = new Set<number>();
    for (let round = 1; done.size < its.length; round++) {
      its.forEach((it, g) => {
        if (done.has(g)) return;
        const r = it.next();
        if (r.done) done.add(g);
        else seen[g]?.push((r.value as { id: number }).id);
      });
      if (round === 10) {
        // Meanwhile another client commits a row; the iterators, and reads beside them, do not
        // see it: they read one snapshot.
        other.prepare('INSERT INTO t (id, g) VALUES (?, ?)').run(100_000, 3);
        expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 16 * 300 });
        expect(db.isTransaction).toBe(false);
      }
    }
    seen.forEach((ids, g) => {
      expect(ids).toEqual(Array.from({ length: 300 }, (_, i) => g + 16 * (i + (g === 0 ? 1 : 0))));
    });
    // The snapshot has ended: the row is there.
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 16 * 300 + 1 });
  });

  it('reads what is left into memory when a write comes', async () => {
    const db = withTable(2000);
    const it = db.prepare('SELECT id FROM t ORDER BY id').iterate();
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push((it.next().value as { id: number }).id);
    db.prepare('INSERT INTO t (id) VALUES (?)').run(5000);
    // Written and committed, not waiting for the iterator.
    expect(await outside(`SELECT count(*)::int AS n FROM ${db.target.schema}.t`)).toEqual([
      { n: 2001 },
    ]);
    for (let r = it.next(); !r.done; r = it.next()) ids.push((r.value as { id: number }).id);
    expect(ids).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1));
  });

  it('reads what is left into memory when a transaction begins', () => {
    const db = withTable(500);
    const it = db.prepare('SELECT id FROM t ORDER BY id').iterate();
    it.next();
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM t').run();
    db.exec('COMMIT');
    expect([...it].length).toBe(499);
  });

  it('closes an iterator left open when the event loop turns', async () => {
    const db = withTable(500);
    // This client's connection only: other test files share the run's database.
    const pid = backend(db);
    const it = db.prepare('SELECT id FROM t ORDER BY id').iterate();
    expect(it.next().value).toEqual({ id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => it.next()).toThrow(/closed/);
    const [row] = await outside(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid = $1",
      [pid],
    );
    expect(row?.n).toBe(0);
    // Read to its end, or closed, an iterator needs nothing more.
    expect([...db.prepare('SELECT id FROM t').iterate()].length).toBe(500);
    const early = db.prepare('SELECT id FROM t').iterate();
    early.next();
    early.return?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(early.next().done).toBe(true);
  });

  it('reads in the transaction it is opened in, and goes on after COMMIT', () => {
    const db = withTable(300);
    db.exec('BEGIN IMMEDIATE');
    const it = db.prepare('SELECT id FROM t ORDER BY id').iterate();
    expect(it.next().value).toEqual({ id: 1 });
    db.prepare('DELETE FROM t WHERE id > 100').run();
    db.exec('COMMIT');
    // The cursor read the rows as they were when it was declared.
    expect([...it].length).toBe(299);
    db.exec('BEGIN IMMEDIATE');
    const gone = db.prepare('SELECT id FROM t').iterate();
    gone.next();
    db.exec('ROLLBACK');
    expect(() => gone.next()).toThrow(/rolled back/);
  });

  it('iterates over the rows of a write', () => {
    const db = withTable();
    const ids = [
      ...db
        .prepare('INSERT INTO t (id) SELECT n FROM generate_series(1, 3) n RETURNING id')
        .iterate(),
    ];
    expect(ids).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('has the helpers of an iterator', () => {
    const db = withTable(5);
    const it = db.prepare('SELECT id FROM t ORDER BY id').iterate() as IterableIterator<{
      id: number;
    }> & { toArray?: () => unknown[] };
    if (typeof it.toArray === 'function') expect(it.toArray().length).toBe(5);
  });
});

describe.skipIf(!onPostgres)('transactions', () => {
  it('controls them as SQLite does', () => {
    const db = withTable();
    expect(thrown(() => db.exec('COMMIT')).message).toBe(
      'cannot commit - no transaction is active',
    );
    expect(thrown(() => db.exec('ROLLBACK')).message).toBe(
      'cannot rollback - no transaction is active',
    );
    db.exec('BEGIN IMMEDIATE');
    expect(db.isTransaction).toBe(true);
    expect(thrown(() => db.exec('BEGIN')).message).toBe(
      'cannot start a transaction within a transaction',
    );
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    db.exec('ROLLBACK');
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  it('refuses a write in a deferred transaction, which reads one snapshot', async () => {
    const db = withTable(3);
    db.exec('BEGIN');
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
    await outside(`INSERT INTO ${db.target.schema}.t (id) VALUES (10)`);
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
    expect(thrown(() => db.prepare('INSERT INTO t (id) VALUES (11)').run()).message).toMatch(
      /^writing transactions must be immediate/,
    );
    expect(() => db.exec('CREATE TABLE u (a INT)')).toThrow(/must be immediate/);
    // Refused before it was sent: the transaction goes on.
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
    db.exec('COMMIT');
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 4 });
  });

  it('keeps savepoints', () => {
    const db = withTable();
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    db.exec('SAVEPOINT a');
    db.prepare('INSERT INTO t (id) VALUES (2)').run();
    db.exec('ROLLBACK TO a');
    db.exec('RELEASE a');
    db.exec('SAVEPOINT b');
    // An error inside a savepoint aborts only what follows it.
    expect(thrown(() => db.prepare('INSERT INTO t (id) VALUES (1)').run()).code).toBe('23505');
    db.exec('ROLLBACK TO b');
    db.exec('RELEASE SAVEPOINT b');
    db.prepare('INSERT INTO t (id) VALUES (3)').run();
    db.exec('COMMIT');
    expect(db.prepare('SELECT id FROM t ORDER BY id').all()).toEqual([{ id: 1 }, { id: 3 }]);
    expect(() => db.exec('SAVEPOINT c')).toThrow(/outside a transaction/);
  });

  it('fails a COMMIT after an error, and leaves the ROLLBACK to the caller', () => {
    const db = withTable();
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO t (id) VALUES (2)').run();
    expect(thrown(() => db.prepare('INSERT INTO t (id) VALUES (1)').run()).code).toBe('23505');
    const err = thrown(() => db.exec('COMMIT'));
    expect(err).toBeInstanceOf(PgError);
    expect(err.code).toBe('25P02');
    expect(err.message).toMatch(/rolled back/);
    expect(db.isTransaction).toBe(true);
    expect(() => db.prepare('SELECT 1').get()).toThrow(/roll it back/);
    db.exec('ROLLBACK');
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT id FROM t').all()).toEqual([{ id: 1 }]);
  });

  it('refuses writes once a newer Origin has upgraded the store, or moved it', async () => {
    const db = withTable();
    db.setFormatVersion(STORE_VERSION);
    await outside(`UPDATE ${db.target.schema}.store_format SET version = $1`, [STORE_VERSION + 1]);
    expect(thrown(() => db.exec('BEGIN IMMEDIATE'))).toBeInstanceOf(StoreUpgradedError);
    expect(db.isTransaction).toBe(false);
    expect(thrown(() => db.prepare('INSERT INTO t (id) VALUES (1)').run())).toBeInstanceOf(
      StoreUpgradedError,
    );
    await outside(
      `UPDATE ${db.target.schema}.store_format SET version = $1, moved_to = 'elsewhere'`,
      [STORE_VERSION],
    );
    expect(thrown(() => db.exec('BEGIN IMMEDIATE')).message).toMatch(/moved to elsewhere/);
    // Nothing was written, and reads go on.
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });
});

describe.skipIf(!onPostgres)('the write lock', () => {
  it('makes a second writer wait, then fail with a message of its own', async () => {
    const a = withTable();
    const b = open(a.target);
    a.exec('BEGIN IMMEDIATE');
    a.prepare('INSERT INTO t (id) VALUES (1)').run();
    // Readers do not wait.
    expect(b.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    const started = performance.now();
    const err = b.withWaitTimeout(300, () => thrown(() => b.exec('BEGIN IMMEDIATE')));
    const waited = performance.now() - started;
    expect(err).toBeInstanceOf(PgError);
    expect(err.code).toBe('55P03');
    expect(err.message).toBe(
      "database is locked: another Origin process holds the store's write lock",
    );
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(5_000);
    expect(b.isTransaction).toBe(false);
    // A write on its own takes the lock too.
    const solo = b.withWaitTimeout(200, () =>
      thrown(() => b.prepare('INSERT INTO t (id) VALUES (2)').run()),
    );
    expect(solo.code).toBe('55P03');
    // For an async `fn`, until its promise settles.
    const later = await b.withWaitTimeout(300, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const t0 = performance.now();
      return { err: thrown(() => b.exec('BEGIN IMMEDIATE')), waited: performance.now() - t0 };
    });
    expect(later.err.code).toBe('55P03');
    expect(later.waited).toBeLessThan(5_000);
    a.exec('COMMIT');
    b.exec('BEGIN IMMEDIATE');
    b.prepare('INSERT INTO t (id) VALUES (2)').run();
    b.exec('COMMIT');
    expect(a.prepare('SELECT id FROM t ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('is the store’s own: another schema does not wait', () => {
    const a = withTable();
    const c = withTable();
    a.exec('BEGIN IMMEDIATE');
    c.withWaitTimeout(200, () => c.exec('BEGIN IMMEDIATE'));
    c.exec('COMMIT');
    a.exec('COMMIT');
  });
});

describe.skipIf(!onPostgres)('limits and errors', () => {
  it('times out a statement that runs too long', () => {
    const db = open(target(), { statementTimeoutMs: 300 });
    const err = thrown(() => db.prepare('SELECT pg_sleep(3)').get());
    expect(err).toBeInstanceOf(PgError);
    expect(err.code).toBe('57014');
    expect(err.message).toBe('statement timed out');
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
  });

  it('reports what PostgreSQL says, with its code', () => {
    const db = withTable();
    db.exec('CREATE TABLE c (a TEXT NOT NULL, CONSTRAINT c_a UNIQUE (a))');
    db.prepare('INSERT INTO c (a) VALUES (?)').run('x');
    const dup = thrown(() => db.prepare('INSERT INTO c (a) VALUES (?)').run('x'));
    expect(dup).toBeInstanceOf(PgError);
    expect(dup).toMatchObject({ code: '23505', constraint: 'c_a', table: 'c' });
    expect(dup.detail).toContain('(a)=(x)');
    expect(thrown(() => db.prepare('INSERT INTO c (a) VALUES (NULL)').run())).toMatchObject({
      code: '23502',
      column: 'a',
    });
    expect(thrown(() => db.exec('SELEC 1'))).toMatchObject({ code: '42601' });
    const append = thrown(() =>
      db.exec("DO $$ BEGIN RAISE EXCEPTION 'raw_chunk is append-only'; END $$"),
    );
    expect(append.message).toBe('raw_chunk is append-only');
  });

  it('cannot be used once closed', () => {
    const db = open(target());
    db.close();
    db.close();
    const err = thrown(() => db.prepare('SELECT 1'));
    expect(err.message).toBe('database is not open');
    expect(err.code).toBe('ERR_INVALID_STATE');
  });
});

describe.skipIf(!onPostgres)('a lost connection', () => {
  it('outside a transaction: connects again, and reads and writes go on', async () => {
    const db = withTable();
    const first = backend(db);
    await outside('SELECT pg_terminate_backend($1)', [first]);
    sleep(200);
    expect(db.prepare('SELECT 7 AS n').get()).toEqual({ n: 7 });
    const second = backend(db);
    expect(second).not.toBe(first);
    await outside('SELECT pg_terminate_backend($1)', [second]);
    sleep(200);
    // A write whose connection was gone before it was sent is sent on a new one.
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  it('outside a transaction: a read cut off is read again, once', async () => {
    const db = withTable();
    const killed = terminateLater(backend(db), 300);
    expect(db.prepare('SELECT pg_sleep(1.5), 8 AS n').get()).toMatchObject({ n: 8 });
    await killed;
    // A read that cuts itself off fails the second time too.
    const err = thrown(() => db.prepare('SELECT pg_terminate_backend(pg_backend_pid())').get());
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(db.prepare('SELECT 9 AS n').get()).toEqual({ n: 9 });
  });

  it('outside a transaction: a write cut off before its COMMIT is written once', async () => {
    const db = withTable();
    const killed = terminateLater(backend(db), 300);
    db.prepare('INSERT INTO t (id, v) SELECT 1, pg_sleep(1.5)::text').run();
    await killed;
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  it('inside a transaction: ends it, and the ROLLBACK that follows does nothing', async () => {
    const db = withTable();
    const other = open(db.target);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    await outside('SELECT pg_terminate_backend($1)', [backend(db)]);
    sleep(200);
    const err = thrown(() => db.prepare('INSERT INTO t (id) VALUES (2)').run());
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(db.isTransaction).toBe(true);
    expect(() => db.prepare('SELECT 1').get()).toThrow(ConnectionLostError);
    expect(() => db.exec('COMMIT')).toThrow(ConnectionLostError);
    db.exec('ROLLBACK TO x');
    db.exec('ROLLBACK');
    expect(db.isTransaction).toBe(false);
    // Nothing was kept, and the lock is free.
    other.withWaitTimeout(1_000, () => other.exec('BEGIN IMMEDIATE'));
    other.exec('COMMIT');
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  it('inside a transaction: a statement cut off fails', async () => {
    const db = withTable();
    db.exec('BEGIN IMMEDIATE');
    const killed = terminateLater(backend(db), 300);
    const err = thrown(() => db.prepare('SELECT pg_sleep(1.5)').get());
    await killed;
    expect(err).toBeInstanceOf(ConnectionLostError);
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
  });

  it('fails the iterators that read on it', async () => {
    const db = withTable(1000);
    const pid = backend(db);
    const it = db.prepare('SELECT id FROM t').iterate();
    it.next();
    // Without letting the event loop turn, which would close the iterator.
    const killed = terminateLater(pid, 0);
    sleep(1_000);
    expect(() => {
      for (const _ of it);
    }).toThrow(ConnectionLostError);
    await killed;
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1000 });
  });

  it('when the worker dies during a call: fails it, and the next call starts anew', () => {
    const db = withTable();
    const other = open(db.target);
    db.exitWorkerForTests(300);
    const started = performance.now();
    const err = thrown(() => db.prepare('SELECT pg_sleep(5)').get());
    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
    // Inside a transaction: the server sees the connection close (once the statement ends, at
    // the latest), and rolls it back.
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    db.exitWorkerForTests(200);
    expect(() => db.prepare('SELECT pg_sleep(1)').get()).toThrow(ConnectionLostError);
    db.exec('ROLLBACK');
    other.withWaitTimeout(5_000, () => other.exec('BEGIN IMMEDIATE'));
    expect(other.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    other.exec('COMMIT');
  });
});
