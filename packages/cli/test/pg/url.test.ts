import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OriginError } from '@openlinkos/origin-core';
import { describe, expect, it } from 'vitest';
import { databaseUrlFrom, parseDatabaseUrl, redact } from '../../src/pg/url.js';

/** The error `fn` throws. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected an error');
}

describe('the URL of a store in PostgreSQL', () => {
  it('takes the schema out of the URL, and hides the password', () => {
    const t = parseDatabaseUrl(
      'postgres://origin:s3cr%40t@db.example:5433/hub?sslmode=verify-full&schema=hub_one&application_name=x',
    );
    expect(t.schema).toBe('hub_one');
    expect(t.url).toBe(
      'postgres://origin:s3cr%40t@db.example:5433/hub?sslmode=verify-full&application_name=x',
    );
    expect(t.display).toBe(
      'postgres://origin:***@db.example:5433/hub?sslmode=verify-full&application_name=x&schema=hub_one',
    );
    expect(t.secrets).toEqual(expect.arrayContaining(['s3cr%40t', 's3cr@t']));
  });

  it('leaves a URL without a schema as it is, in schema origin', () => {
    const text = 'postgresql://u@localhost/db?sslrootcert=%2Fetc%2Fca.pem';
    const t = parseDatabaseUrl(text);
    expect(t).toMatchObject({ url: text, schema: 'origin', secrets: [] });
    expect(t.display).toBe('postgresql://u@localhost/db?sslrootcert=%2Fetc%2Fca.pem&schema=origin');
    expect(parseDatabaseUrl('postgres://u@h/db?schema=s').url).toBe('postgres://u@h/db');
  });

  it('hides a password given as a parameter', () => {
    const t = parseDatabaseUrl('postgres://u@h/db?password=p%26w&sslpassword=k');
    expect(t.display).toBe('postgres://u@h/db?password=***&sslpassword=***&schema=origin');
    expect(t.secrets).toEqual(expect.arrayContaining(['p&w', 'p%26w', 'k']));
  });

  it('refuses what is not a PostgreSQL URL, without quoting it', () => {
    for (const text of ['not a url with secret', 'mysql://u:secret@h/db', 'http://u:secret@h/']) {
      const err = thrown(() => parseDatabaseUrl(text));
      expect(err).toBeInstanceOf(OriginError);
      expect(err.message).toMatch(/^ORIGIN_DATABASE_URL is not a (PostgreSQL )?URL/);
      expect(err.message).not.toContain('secret');
    }
  });

  it('refuses a schema that is not a plain lower-case name', () => {
    for (const schema of ['Origin', 'a-b', 'pg_x', '', '1a', 'x'.repeat(64)]) {
      expect(() => parseDatabaseUrl(`postgres://h/db?schema=${schema}`)).toThrow(OriginError);
    }
    expect(() => parseDatabaseUrl('postgres://h/db?schema=a&schema=b')).toThrow(/more than one/);
    expect(parseDatabaseUrl(`postgres://h/db?schema=_a1${'x'.repeat(60)}`).schema).toHaveLength(63);
  });

  it('comes from ORIGIN_DATABASE_URL or the file ORIGIN_DATABASE_URL_FILE names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-url-'));
    try {
      const file = path.join(dir, 'url');
      fs.writeFileSync(file, 'postgres://u:pw@h/db?schema=from_file\n');
      expect(databaseUrlFrom({})).toBeNull();
      expect(databaseUrlFrom({ ORIGIN_DATABASE_URL: '  ' })).toBeNull();
      expect(databaseUrlFrom({ ORIGIN_DATABASE_URL: 'postgres://h/db' })?.schema).toBe('origin');
      expect(databaseUrlFrom({ ORIGIN_DATABASE_URL_FILE: file })).toMatchObject({
        url: 'postgres://u:pw@h/db',
        schema: 'from_file',
      });
      expect(() =>
        databaseUrlFrom({ ORIGIN_DATABASE_URL: 'postgres://h/db', ORIGIN_DATABASE_URL_FILE: file }),
      ).toThrow(/not both/);
      expect(() =>
        databaseUrlFrom({ ORIGIN_DATABASE_URL_FILE: path.join(dir, 'missing') }),
      ).toThrow(/Cannot read ORIGIN_DATABASE_URL_FILE .*ENOENT/);
      fs.writeFileSync(file, 'nonsense secret');
      const err = thrown(() => databaseUrlFrom({ ORIGIN_DATABASE_URL_FILE: file }));
      expect(err.message).toMatch(/^ORIGIN_DATABASE_URL_FILE is not a URL/);
      expect(err.message).not.toContain('secret');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts every secret from a text', () => {
    expect(redact('a pass and pass%40 here', ['pass', 'pass%40'])).toBe('a *** and *** here');
    expect(redact('nothing', [''])).toBe('nothing');
  });
});
