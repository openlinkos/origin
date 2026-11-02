import type { Database } from './db.js';

/**
 * Set, to the time it happened, when a store comes to hold events that lines it had mirrored long
 * before now yield, as an upgrade that reads more of them adds (see reparse.ts). A forget of such an
 * event that reached a device before covered nothing there, and was not kept; so a device pulls
 * every tombstone of its hub once more after this changes (see pullTombstones in the CLI).
 */
export const PULL_TOMBSTONES_AGAIN = 'tombstones.pull-again';

/** Small key-value state kept in the store. */
export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
