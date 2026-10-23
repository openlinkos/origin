import type { Database } from './db.js';
import { OriginError } from './errors.js';
import { getSetting, setSetting } from './settings.js';

/**
 * What a store keeps (see docs/architecture.md#relays). A `complete` store, the default, mirrors
 * and ingests its agents' logs and is a whole memory on its own. A `relay` keeps none of that: it
 * sends its agents' new log lines straight to its hub, and holds only the cursors of what the hub
 * has acknowledged. The mode is kept in `setting`, so it belongs to the store, not the connection.
 */
export type StoreMode = 'complete' | 'relay';

const MODE_KEY = 'store.mode';

export function storeMode(db: Database): StoreMode {
  return getSetting(db, MODE_KEY) === 'relay' ? 'relay' : 'complete';
}

export function isRelay(db: Database): boolean {
  return storeMode(db) === 'relay';
}

/** What a store holds that a relay would not keep: events, mirrored files, entries, tombstones. */
function heldData(db: Database): { events: number; files: number; records: number } {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    events: count('event'),
    files: count('raw_file'),
    records: count('entry') + count('tombstone'),
  };
}

/**
 * Refuse unless this store can become a relay: only a store that holds nothing yet can, because a
 * relay keeps no events, mirrors, entries, or tombstones, and nothing is ever deleted to make room
 * (invariant 3). A relay can always stay one.
 */
export function checkRelayable(db: Database): void {
  if (isRelay(db)) return;
  const held = heldData(db);
  if (held.events + held.files + held.records > 0) {
    const what = [
      held.events > 0 ? `${held.events} event${held.events === 1 ? '' : 's'}` : null,
      held.files > 0 ? `${held.files} mirrored file${held.files === 1 ? '' : 's'}` : null,
      held.records > 0
        ? `${held.records} entr${held.records === 1 ? 'y or tombstone' : 'ies and tombstones'}`
        : null,
    ]
      .filter(Boolean)
      .join(', ');
    throw new OriginError(
      `This store already holds ${what}, and a relay keeps none, so it cannot become one; nothing was changed. To use this machine as a relay, connect an empty store: set ORIGIN_HOME to a new directory and run origin hub connect there with --relay.`,
    );
  }
}

/** Make this store a relay (see checkRelayable). A relay stays one: it cannot become complete again. */
export function makeRelay(db: Database): void {
  checkRelayable(db);
  setSetting(db, MODE_KEY, 'relay');
}

/** Refuse to relay from a complete store: it mirrors its logs and pushes the mirrors instead. */
export function assertRelay(db: Database): void {
  if (!isRelay(db)) {
    throw new OriginError(
      "This store is not a relay: it keeps its own mirrors of its agents' logs and pushes them to its hub with origin sync.",
    );
  }
}

/** Refuse what only a complete store can do. */
export function assertComplete(db: Database, what: string): void {
  if (isRelay(db)) {
    throw new OriginError(
      `This store is a relay: it keeps no sessions of its own and cannot ${what}. Its agents' sessions go to its hub with origin sync.`,
    );
  }
}
