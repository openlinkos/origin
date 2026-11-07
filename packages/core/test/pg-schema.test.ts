import { describe, expect, it } from 'vitest';
import {
  missingObjects,
  PG_CLIENT_OBJECTS,
  PG_CREATE_DATABASE,
  PG_OBJECTS,
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

  it('is written for PostgreSQL alone', () => {
    for (const o of PG_OBJECTS) {
      expect(forbiddenIn(o.sql), o.name).toEqual([]);
      expect(translate(o.sql).kind, o.name).toBe('ddl');
    }
  });
});
