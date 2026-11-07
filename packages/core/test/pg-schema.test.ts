import { describe, expect, it } from 'vitest';
import {
  missingObjects,
  PG_CLIENT_OBJECTS,
  PG_CREATE_DATABASE,
  PG_OBJECTS,
  PG_PRESENT_HERE_SQL,
  type PgPreflight,
  preflightProblem,
} from '../src/pg/schema.js';
import { forbiddenIn, translate } from '../src/pg/translate.js';

const good: PgPreflight = {
  version: 170_004,
  release: '17.4',
  database: 'origin',
  encoding: 'UTF8',
  provider: 'c',
  collate: 'C',
  ctype: 'C',
  locale: null,
};

describe('the PostgreSQL schema', () => {
  it('accepts PostgreSQL 17 or later, in a UTF8 database whose locale is C', () => {
    expect(preflightProblem(good)).toBeNull();
    expect(preflightProblem({ ...good, collate: 'POSIX', ctype: 'POSIX' })).toBeNull();
    expect(
      preflightProblem({ ...good, version: 180_006, provider: 'b', locale: 'C', ctype: 'C.UTF-8' }),
    ).toBeNull();
  });

  it('refuses an older server, or another encoding or locale, saying what to do', () => {
    expect(preflightProblem({ ...good, version: 160_008, release: '16.8' })).toBe(
      'Origin needs PostgreSQL 17 or later; this server runs 16.8.',
    );
    for (const p of [
      { ...good, encoding: 'SQL_ASCII' },
      { ...good, collate: 'en_US.UTF-8' },
      { ...good, ctype: 'C.UTF-8' },
      { ...good, provider: 'b', locale: 'C.UTF-8' },
      { ...good, provider: 'b', locale: 'PG_UNICODE_FAST' },
      { ...good, provider: 'i', locale: 'und' },
    ]) {
      const problem = preflightProblem(p);
      expect(problem).toContain(`The database origin has encoding ${p.encoding}`);
      expect(problem).toContain(PG_CREATE_DATABASE);
    }
  });

  it('finds the objects a store lacks', () => {
    expect(missingObjects([], PG_CLIENT_OBJECTS).map((o) => o.name)).toEqual([
      'store_format',
      'origin_lock_key',
    ]);
    expect(
      missingObjects(
        [
          { kind: 'table', name: 'store_format' },
          { kind: 'index', name: 'origin_lock_key' },
        ],
        PG_CLIENT_OBJECTS,
      ).map((o) => `${o.kind} ${o.name}`),
    ).toEqual(['function origin_lock_key']);
  });

  it('is written for PostgreSQL alone, which the translator leaves as it is', () => {
    for (const o of PG_OBJECTS) {
      expect(forbiddenIn(o.sql), o.name).toEqual([]);
      const t = translate(o.sql);
      expect(t.kind, o.name).toBe('ddl');
      expect(t.sql, o.name).toBe(o.sql);
      expect(t.params, o.name).toBe(0);
    }
    // All of it at once, as a new store is created.
    const all = translate(PG_OBJECTS.map((o) => `${o.sql};\n`).join(''));
    expect(all.statements).toBe(PG_OBJECTS.length);
    expect(forbiddenIn(PG_PRESENT_HERE_SQL)).toEqual([]);
    expect(translate(PG_PRESENT_HERE_SQL)).toMatchObject({ kind: 'read', params: 0 });
  });

  it('names each object once, and creates each after the functions it uses', () => {
    const names = PG_OBJECTS.map((o) => `${o.kind} ${o.name}`);
    expect(new Set(names).size).toBe(names.length);
    const functions = PG_OBJECTS.filter((o) => o.kind === 'function').map((o) => o.name);
    PG_OBJECTS.forEach((o, i) => {
      const before = new Set(
        PG_OBJECTS.slice(0, i)
          .filter((p) => p.kind === 'function')
          .map((p) => p.name),
      );
      if (o.kind === 'function') return;
      for (const f of functions) {
        if (new RegExp(`\\b${f}\\(`).test(o.sql))
          expect(before.has(f), `${o.name}: ${f}`).toBe(true);
      }
    });
  });

  it('fixes the search path of every function, and plans the queries of its own once', () => {
    for (const o of PG_OBJECTS.filter((p) => p.kind === 'function')) {
      expect(o.sql, o.name).toContain('SET search_path FROM CURRENT');
      if (PG_CLIENT_OBJECTS.includes(o)) continue;
      expect(o.sql, o.name).toContain('SET plan_cache_mode = force_generic_plan');
    }
  });
});
