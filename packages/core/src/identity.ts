import os from 'node:os';
import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { getSetting, setSetting } from './settings.js';
import { checkName } from './tokens.js';

const STORE_NAME = 'store.name';

/** The name a hub gives its store when it starts on a store that has none yet. */
export const HUB_STORE_NAME = 'hub';

/** The host name, lowercased and reduced to the characters a store name allows. */
export function defaultStoreName(): string {
  const name = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  return name || 'device';
}

/**
 * This store's name (see docs/architecture.md#storage): a device's name, or the hub's. Entries and
 * tombstones written here carry it as their `origin`, and a device is known to its hub by it. A
 * store without a name yet takes the host name.
 */
export function storeName(db: Database): string {
  return getSetting(db, STORE_NAME) ?? setStoreName(db, defaultStoreName());
}

/** Give the store a name unless it has one already; returns its name. */
export function initStoreName(db: Database, name: string): string {
  return getSetting(db, STORE_NAME) ?? setStoreName(db, name);
}

/** Whether this store has written an entry or a tombstone under `name`. */
function wroteAs(db: Database, name: string): boolean {
  return db.prepare('SELECT 1 FROM change_log WHERE origin = ? LIMIT 1').get(name) !== undefined;
}

/** Whether the store keeps its name for good: it has written entries or tombstones under it. */
export function isStoreNameFixed(db: Database): boolean {
  const current = getSetting(db, STORE_NAME);
  return current !== null && wroteAs(db, current);
}

/**
 * Name or rename the store. A store that has already written entries or tombstones under its name
 * keeps it: they carry the name, and replication relies on it.
 */
export function setStoreName(db: Database, name: string): string {
  checkName(name, 'store');
  const current = getSetting(db, STORE_NAME);
  if (current === name) return name;
  if (current !== null && wroteAs(db, current)) {
    throw new OriginError(
      `This store is named "${current}" and has written entries or tombstones under that name, so it keeps it; it cannot become "${name}".`,
    );
  }
  setSetting(db, STORE_NAME, name);
  return name;
}
