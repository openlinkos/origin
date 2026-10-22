import { randomBytes, randomInt, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';
import { endAdminSessions } from './admin.js';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { getSetting, setSetting } from './settings.js';
import { TOKEN_PREFIX } from './tokens.js';

/**
 * The hub's admin password (see docs/architecture.md#admin-ui): one per hub, with no user names.
 * It comes from ORIGIN_ADMIN_PASSWORD when that is set, and otherwise from the store, where it is
 * set with `origin admin password` or generated on the first start with the admin UI enabled. Only
 * a scrypt hash is kept, in the local `setting` table, which is never replicated.
 */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 1024;

/** `setting` keys: the hash of the stored password, and the credential sessions were created under. */
const PASSWORD_SETTING = 'admin.password';
const CREDENTIAL_SETTING = 'admin.credential';
const STORED_FINGERPRINT = 'stored';
const ENV_FINGERPRINT_PREFIX = 'env:';

export interface ScryptParams {
  /** CPU and memory cost, a power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
}

/**
 * One of the equivalent scrypt configurations in the OWASP Password Storage Cheat Sheet. It needs
 * 32 MiB per hash rather than the 64 or 128 MiB of the others, so that a small hub stays well within
 * its memory even when sign-in attempts arrive together (the admin UI also checks one password at a
 * time), and takes about 0.1 s on a current CPU. Node's default `maxmem` of 32 MiB is just short of
 * what scrypt allocates for it (128·r·(N + p + 2) bytes), so `maxmem` is always set explicitly.
 */
export const ADMIN_SCRYPT_PARAMS: Readonly<ScryptParams> = { N: 2 ** 15, r: 8, p: 3 };

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Bounds for parameters read back from a stored hash, so that a stored value cannot exhaust memory. */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_MEMORY = 256 * 1024 * 1024;
const HASH_RE =
  /^scrypt\$(\d{1,8})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22,88})\$([A-Za-z0-9_-]{43})$/;

/** Easy to type: lowercase Crockford base32, without i, l, o, and u. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function checkParams({ N, r, p }: ScryptParams): void {
  if (
    !Number.isInteger(N) ||
    N < 2 ||
    N > MAX_N ||
    (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > MAX_R ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > MAX_P ||
    128 * N * r > MAX_MEMORY
  ) {
    throw new OriginError(`Unsupported scrypt parameters N=${N}, r=${r}, p=${p}.`);
  }
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const { N, r, p } = params;
  // Twice what OpenSSL allocates for these parameters.
  const options: ScryptOptions = { N, r, p, maxmem: 2 * 128 * r * (N + p + 2) };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Throw unless `password` can be an admin password. `what` names it in the message. */
export function checkAdminPassword(password: string, what = 'The admin password'): void {
  if (password.trim() !== password) {
    throw new OriginError(`${what} must not start or end with a space or a line break.`);
  }
  if ([...password].length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new OriginError(`${what} must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters long.`);
  }
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw new OriginError(`${what} must be at most ${ADMIN_PASSWORD_MAX_LENGTH} characters long.`);
  }
  if (password.startsWith(TOKEN_PREFIX)) {
    throw new OriginError(
      `${what} must not start with ${TOKEN_PREFIX}, which marks hub access tokens.`,
    );
  }
}

/** A scrypt hash of `password` with a random salt: `scrypt$N$r$p$<salt>$<hash>` (base64url). */
export async function hashAdminPassword(
  password: string,
  params: ScryptParams = ADMIN_SCRYPT_PARAMS,
): Promise<string> {
  checkParams(params);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether `password` matches a hash from hashAdminPassword. False for anything malformed. */
export async function verifyAdminPasswordHash(password: string, encoded: string): Promise<boolean> {
  const m = HASH_RE.exec(encoded);
  if (!m) return false;
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  try {
    checkParams(params);
  } catch {
    return false;
  }
  const expected = Buffer.from(m[5] ?? '', 'base64url');
  const key = await derive(password, Buffer.from(m[4] ?? '', 'base64url'), params);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A random admin password: 20 base32 characters (100 bits) in groups of five. */
export function generateAdminPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 5; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

/** Whether a password is stored (set with `origin admin password`, or generated). */
export function hasStoredAdminPassword(db: Database): boolean {
  return getSetting(db, PASSWORD_SETTING) !== null;
}

/**
 * Store a new admin password, replacing the old one, and end every admin session. Returns how many
 * sessions were ended.
 */
export async function setAdminPassword(
  db: Database,
  password: string,
  opts: { now?: number; params?: ScryptParams } = {},
): Promise<number> {
  checkAdminPassword(password);
  const hash = await hashAdminPassword(password, opts.params);
  setSetting(db, PASSWORD_SETTING, hash);
  return endAdminSessions(db, {}, opts.now ?? Date.now());
}

/**
 * What the hub checks admin passwords against: the password from the environment (as a hash held
 * in memory), or the one in the store, read on every check so that `origin admin password` takes
 * effect at once.
 */
export type AdminCredential = { source: 'env'; hash: string } | { source: 'stored' };

export interface PreparedAdminCredential {
  credential: AdminCredential;
  /** A password generated because none was configured; to be shown once, then never again. */
  generated: string | null;
  /** Whether the credential differs from the one the existing sessions were created under. */
  changed: boolean;
  sessionsEnded: number;
}

/**
 * Settle the admin credential when the hub starts with the admin UI enabled. ORIGIN_ADMIN_PASSWORD
 * (`envPassword`) takes precedence; otherwise the stored password is used, and one is generated if
 * there is none. Sessions end whenever the credential differs from the one they were created under:
 * the environment password changed between starts, or the hub switched between it and the stored one.
 * To notice a change, the hub keeps a scrypt hash of the environment password in `setting`.
 */
export async function prepareAdminCredential(
  db: Database,
  opts: { envPassword?: string | null; now?: number; params?: ScryptParams } = {},
): Promise<PreparedAdminCredential> {
  const now = opts.now ?? Date.now();
  const previous = getSetting(db, CREDENTIAL_SETTING);
  let credential: AdminCredential;
  let fingerprint: string;
  let generated: string | null = null;
  let sessionsEnded = 0;
  if (opts.envPassword !== undefined && opts.envPassword !== null) {
    checkAdminPassword(opts.envPassword, 'ORIGIN_ADMIN_PASSWORD');
    const known = previous?.startsWith(ENV_FINGERPRINT_PREFIX)
      ? previous.slice(ENV_FINGERPRINT_PREFIX.length)
      : null;
    const hash =
      known !== null && (await verifyAdminPasswordHash(opts.envPassword, known))
        ? known
        : await hashAdminPassword(opts.envPassword, opts.params);
    credential = { source: 'env', hash };
    fingerprint = `${ENV_FINGERPRINT_PREFIX}${hash}`;
  } else {
    if (!hasStoredAdminPassword(db)) {
      generated = generateAdminPassword();
      sessionsEnded += await setAdminPassword(db, generated, { now, params: opts.params });
    }
    credential = { source: 'stored' };
    fingerprint = STORED_FINGERPRINT;
  }
  const changed = previous !== fingerprint;
  if (changed) {
    sessionsEnded += endAdminSessions(db, {}, now);
    setSetting(db, CREDENTIAL_SETTING, fingerprint);
  }
  return { credential, generated, changed, sessionsEnded };
}

/**
 * Whether `password` is the admin password. Surrounding whitespace is ignored (a password cannot
 * have any). Hub access tokens are refused outright, whatever the password.
 */
export async function verifyAdminPassword(
  db: Database,
  credential: AdminCredential,
  password: unknown,
): Promise<boolean> {
  if (typeof password !== 'string') return false;
  const input = password.trim();
  if (
    input.length === 0 ||
    input.length > ADMIN_PASSWORD_MAX_LENGTH ||
    input.startsWith(TOKEN_PREFIX)
  ) {
    return false;
  }
  const encoded = credential.source === 'env' ? credential.hash : getSetting(db, PASSWORD_SETTING);
  if (encoded === null) return false;
  return verifyAdminPasswordHash(input, encoded);
}
