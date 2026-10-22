import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  checkAdminPassword,
  createAdminSession,
  createToken,
  type Database,
  generateAdminPassword,
  getAdminSession,
  getSetting,
  hashAdminPassword,
  hasStoredAdminPassword,
  listAudit,
  OriginError,
  openDatabase,
  prepareAdminCredential,
  recordAudit,
  type ScryptParams,
  setAdminPassword,
  setSetting,
  verifyAdminPassword,
  verifyAdminPasswordHash,
} from '../src/index.js';

/** Cheap parameters, so that the tests stay fast; the hashes record their own parameters. */
const FAST: ScryptParams = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct horse battery';

let home: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-password-'));
  db = openDatabase(path.join(home, 'origin.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Whether the session with this id hash has been ended. */
const ended = (idHash: string) =>
  (
    db.prepare('SELECT ended_at FROM admin_session WHERE id_hash = ?').get(idHash) as {
      ended_at: number | null;
    }
  ).ended_at !== null;

const session = (now = Date.now()) => createAdminSession(db, {}, now).session.idHash;

describe('admin password hashes', () => {
  it('use scrypt with a random salt and the default parameters', async () => {
    const hash = await hashAdminPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyAdminPasswordHash(PASSWORD, hash)).toBe(true);
    expect(await verifyAdminPasswordHash(`${PASSWORD}!`, hash)).toBe(false);
  });

  it('differ for the same password, and reject anything malformed', async () => {
    const a = await hashAdminPassword(PASSWORD, FAST);
    const b = await hashAdminPassword(PASSWORD, FAST);
    expect(a).not.toBe(b);
    expect(await verifyAdminPasswordHash(PASSWORD, b)).toBe(true);
    for (const bad of [
      '',
      'plain',
      a.replace('scrypt$', 'bcrypt$'),
      a.slice(0, -1),
      a.replace('$16$', '$15$'),
      a.replace('$16$', `$${2 ** 21}$`),
      a.replace('$1$1$', '$64$1$'),
    ]) {
      expect(await verifyAdminPasswordHash(PASSWORD, bad), bad).toBe(false);
    }
    await expect(hashAdminPassword(PASSWORD, { N: 3, r: 1, p: 1 })).rejects.toThrow(OriginError);
  });
});

describe('admin passwords', () => {
  it('need at least 10 characters, no surrounding whitespace, and no token prefix', () => {
    expect(ADMIN_PASSWORD_MIN_LENGTH).toBe(10);
    expect(() => checkAdminPassword('a'.repeat(9))).toThrow(/at least 10 characters/);
    expect(() => checkAdminPassword('a'.repeat(10))).not.toThrow();
    // Characters, not UTF-16 code units.
    expect(() => checkAdminPassword('密'.repeat(10))).not.toThrow();
    expect(() => checkAdminPassword('😀'.repeat(5))).toThrow(/at least 10/);
    expect(() => checkAdminPassword(`${PASSWORD}\n`)).toThrow(/line break/);
    expect(() => checkAdminPassword(` ${PASSWORD}`)).toThrow(/space/);
    expect(() => checkAdminPassword('a'.repeat(1025))).toThrow(/at most/);
    expect(() => checkAdminPassword(`ogn_${'a'.repeat(43)}`)).toThrow(/ogn_/);
    expect(() => checkAdminPassword('short', 'ORIGIN_ADMIN_PASSWORD')).toThrow(
      /^ORIGIN_ADMIN_PASSWORD must be at least 10 characters long\.$/,
    );
  });

  it('are generated with 100 random bits in groups that are easy to type', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateAdminPassword();
      expect(p).toMatch(/^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$/);
      expect(() => checkAdminPassword(p)).not.toThrow();
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it('are stored only as a hash; setting one replaces the old one and ends every session', async () => {
    expect(hasStoredAdminPassword(db)).toBe(false);
    expect(await verifyAdminPassword(db, { source: 'stored' }, PASSWORD)).toBe(false);
    expect(await setAdminPassword(db, PASSWORD, { params: FAST })).toBe(0);
    expect(hasStoredAdminPassword(db)).toBe(true);
    const rows = JSON.stringify(db.prepare('SELECT * FROM setting').all());
    expect(rows).not.toContain(PASSWORD);
    expect(await verifyAdminPassword(db, { source: 'stored' }, PASSWORD)).toBe(true);
    // Surrounding whitespace, as when pasting, is ignored.
    expect(await verifyAdminPassword(db, { source: 'stored' }, ` ${PASSWORD}\n`)).toBe(true);
    expect(await verifyAdminPassword(db, { source: 'stored' }, 'wrong password!')).toBe(false);
    expect(await verifyAdminPassword(db, { source: 'stored' }, 42)).toBe(false);

    const a = session();
    const b = session();
    expect(await setAdminPassword(db, 'another password', { params: FAST })).toBe(2);
    expect(ended(a) && ended(b)).toBe(true);
    expect(await verifyAdminPassword(db, { source: 'stored' }, PASSWORD)).toBe(false);
    expect(await verifyAdminPassword(db, { source: 'stored' }, 'another password')).toBe(true);
    await expect(setAdminPassword(db, 'too short')).rejects.toThrow(OriginError);
  });

  it('never accept a hub token, even one that matches the stored hash', async () => {
    const token = createToken(db, 'laptop');
    setSetting(db, 'admin.password', await hashAdminPassword(token, FAST));
    expect(await verifyAdminPassword(db, { source: 'stored' }, token)).toBe(false);
  });
});

describe('the admin credential at startup', () => {
  it('generates a password once when none is configured', async () => {
    const old = session();
    const first = await prepareAdminCredential(db, { params: FAST });
    expect(first.credential).toEqual({ source: 'stored' });
    expect(first.generated).toMatch(/^[0-9a-z]{5}(-[0-9a-z]{5}){3}$/);
    expect(first).toMatchObject({ changed: true, sessionsEnded: 1 });
    expect(ended(old)).toBe(true);
    expect(await verifyAdminPassword(db, first.credential, first.generated)).toBe(true);
    expect(JSON.stringify(db.prepare('SELECT * FROM setting').all())).not.toContain(
      first.generated,
    );

    const live = session();
    const second = await prepareAdminCredential(db, { params: FAST });
    expect(second).toMatchObject({ generated: null, changed: false, sessionsEnded: 0 });
    expect(ended(live)).toBe(false);
  });

  it('prefers ORIGIN_ADMIN_PASSWORD, and ends sessions when it changes', async () => {
    await setAdminPassword(db, PASSWORD, { params: FAST });
    const env = 'from the environment';
    const first = await prepareAdminCredential(db, { envPassword: env, params: FAST });
    expect(first).toMatchObject({ generated: null, changed: true });
    expect(first.credential.source).toBe('env');
    expect(await verifyAdminPassword(db, first.credential, env)).toBe(true);
    expect(await verifyAdminPassword(db, first.credential, PASSWORD)).toBe(false);
    // Only a scrypt hash of it is kept, to notice a change.
    expect(getSetting(db, 'admin.credential')).toMatch(/^env:scrypt\$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM setting').all())).not.toContain(env);

    // The same password on the next start: sessions stay.
    const a = session();
    const same = await prepareAdminCredential(db, { envPassword: env, params: FAST });
    expect(same).toMatchObject({ changed: false, sessionsEnded: 0, credential: first.credential });
    expect(ended(a)).toBe(false);

    // A different one: every session ends.
    const changed = await prepareAdminCredential(db, {
      envPassword: 'changed in the secret',
      params: FAST,
    });
    expect(changed).toMatchObject({ changed: true, sessionsEnded: 1 });
    expect(ended(a)).toBe(true);
    expect(await verifyAdminPassword(db, changed.credential, env)).toBe(false);

    // Back to the stored password: sessions end again, and nothing is generated.
    const b = session();
    const stored = await prepareAdminCredential(db, { params: FAST });
    expect(stored).toMatchObject({ generated: null, changed: true, sessionsEnded: 1 });
    expect(ended(b)).toBe(true);
    expect(await verifyAdminPassword(db, stored.credential, PASSWORD)).toBe(true);
  });

  it('works on a database created when the hub signed in with admin keys', async () => {
    // That version also had an admin_key table, and sessions named after the key they used.
    const { id } = createAdminSession(db, {}, Date.now());
    db.prepare("UPDATE admin_session SET key_name = 'laptop-key'").run();
    recordAudit(db, { actor: 'key:laptop-key', channel: 'ui', action: 'login' });
    db.exec(`CREATE TABLE admin_key (
      name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      last_used_at INTEGER, revoked_at INTEGER)`);
    db.prepare('INSERT INTO admin_key (name, hash, created_at) VALUES (?, ?, ?)').run(
      'laptop-key',
      'a'.repeat(64),
      1,
    );
    db.close();
    db = openDatabase(path.join(home, 'origin.db'));
    expect(getAdminSession(db, id)).toBeNull();
    const prepared = await prepareAdminCredential(db, { params: FAST });
    expect(prepared).toMatchObject({ changed: true, sessionsEnded: 1 });
    expect(await verifyAdminPassword(db, prepared.credential, prepared.generated)).toBe(true);
    expect(listAudit(db).map((r) => r.actor)).toEqual(['key:laptop-key']);
  });

  it('refuses an ORIGIN_ADMIN_PASSWORD that is too short', async () => {
    await expect(prepareAdminCredential(db, { envPassword: 'hunter2' })).rejects.toThrow(
      /ORIGIN_ADMIN_PASSWORD must be at least 10 characters/,
    );
    expect(getSetting(db, 'admin.credential')).toBeNull();
    expect(hasStoredAdminPassword(db)).toBe(false);
  });
});
