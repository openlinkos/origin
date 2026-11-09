import { describe, expect, it } from 'vitest';
import { inSqlite } from '../../../test/pg.js';
import {
  idList,
  isPrompt,
  json,
  jsonIsNotOne,
  jsonIsOne,
  pairList,
  perDialect,
  trigramFilter,
} from '../src/dialect.js';
import { openMemoryDatabase } from '../src/index.js';

describe('SQL that the engines spell differently', () => {
  it('is on SQLite what the queries always said', () => {
    expect(json('sqlite', 'e.meta', 'toolName')).toBe("json_extract(e.meta, '$.toolName')");
    expect(jsonIsOne('sqlite', 'e.meta', 'sidechain')).toBe(
      "json_extract(e.meta, '$.sidechain') IS 1",
    );
    expect(jsonIsNotOne('sqlite', 'e.meta', 'sidechain')).toBe(
      "json_extract(e.meta, '$.sidechain') IS NOT 1",
    );
    expect(idList('sqlite', 'bigint')).toBe('SELECT value FROM json_each(?)');
    expect(idList('sqlite', 'text')).toBe('SELECT value FROM json_each(?)');
    expect(pairList('sqlite')).toBe(
      "SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)",
    );
    expect(isPrompt('sqlite', 'e')).toBe('origin_prompt(e.text) = 1');
    expect(trigramFilter('sqlite', 'e', ['prp', 'rp_'])).toEqual({
      from: 'event_fts f JOIN event e ON e.seq = f.rowid',
      where: `event_fts MATCH '"prp" AND "rp_"'`,
    });
  });

  it('is written for PostgreSQL too', () => {
    expect(json('postgres', 'e.meta', 'toolName')).toBe("(e.meta)::json ->> 'toolName'");
    expect(jsonIsOne('postgres', 'e.meta', 'sidechain')).toBe(
      "coalesce((e.meta)::json ->> 'sidechain' IN ('true', '1'), false)",
    );
    expect(jsonIsNotOne('postgres', 'e.meta', 'sidechain')).toBe(
      "NOT coalesce((e.meta)::json ->> 'sidechain' IN ('true', '1'), false)",
    );
    expect(idList('postgres', 'bigint')).toBe(
      'SELECT value::bigint FROM json_array_elements_text(?::json) AS value',
    );
    expect(idList('postgres', 'text')).toBe(
      'SELECT value FROM json_array_elements_text(?::json) AS value',
    );
    expect(pairList('postgres')).toBe(
      'SELECT pair ->> 0, pair ->> 1 FROM json_array_elements(?::json) AS pair',
    );
    expect(isPrompt('postgres', 'e')).toBe(
      'EXISTS (SELECT 1 FROM event_prompt ep WHERE ep.seq = e.seq)',
    );
    expect(trigramFilter('postgres', 'e', ['lnk', 'nk_'])).toEqual({
      from: 'event e',
      where: "origin_trigrams(e.text) @> ARRAY['lnk', 'nk_']",
    });
  });

  it('names only plain keys and trigrams', () => {
    expect(() => json('sqlite', 'e.meta', "x') OR 1 --")).toThrow(/JSON key/);
    expect(() => jsonIsOne('postgres', 'e.meta', 'a.b')).toThrow(/JSON key/);
    expect(() => trigramFilter('sqlite', 'e', ['ab'])).toThrow(/trigram/);
    expect(() => trigramFilter('sqlite', 'e', ['a"b'])).toThrow(/trigram/);
    expect(trigramFilter('sqlite', 'e', ['中文字']).where).toBe(`event_fts MATCH '"中文字"'`);
  });

  it('is built once per engine', () => {
    let built = 0;
    const sql = perDialect((d) => `${++built}:${d}`);
    expect(sql('sqlite')).toBe('1:sqlite');
    expect(sql('sqlite')).toBe('1:sqlite');
    expect(sql('postgres')).toBe('2:postgres');
  });

  it('reads JSON and lists as the queries need, on SQLite', () => {
    const db = inSqlite(openMemoryDatabase);
    try {
      const meta = JSON.stringify({ sidechain: true, toolName: 'Edit', n: 1 });
      const row = db
        .prepare(
          `SELECT ${json('sqlite', 'm', 'toolName')} AS name, ${jsonIsOne('sqlite', 'm', 'sidechain')} AS side,
                  ${jsonIsOne('sqlite', 'm', 'missing')} AS missing,
                  ${jsonIsNotOne('sqlite', 'm', 'n')} AS n
             FROM (SELECT ? AS m)`,
        )
        .get(meta);
      expect(row).toEqual({ name: 'Edit', side: 1, missing: 0, n: 0 });
      const ids = db
        .prepare(`SELECT value AS v FROM (${idList('sqlite', 'bigint')}) ORDER BY v`)
        .all('[3, 1, 2]')
        .map((r) => r.v);
      expect(ids).toEqual([1, 2, 3]);
      const pairs = db.prepare(`${pairList('sqlite')}`).all('[["a", "b"], ["c", "d"]]');
      expect(pairs.map((r) => Object.values(r))).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    } finally {
      db.close();
    }
  });
});
