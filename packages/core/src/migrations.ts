import type { Database } from './db.js';
import { assertStoreCurrent, transaction } from './db.js';
import { OriginError, StoreUpgradedError } from './errors.js';
import { sessionBranchQuery } from './ingest.js';
import { reparsePlaces } from './places.js';
import { deriveProposals } from './proposals.js';
import { reparseAuthorship, reparseMemories, reparseParents, reparseTitles } from './reparse.js';
import { SCHEMA } from './schema.js';
import { deriveThreads } from './threads.js';
import type { SourceAdapter } from './types.js';

/**
 * Versions of the store format, and the migrations between them (see
 * docs/architecture.md#migrations).
 *
 * A store records its version in the database header, `PRAGMA user_version`: SQLite keeps it there
 * for applications, it can be read before any table exists, and it is written in the same
 * transaction as the changes it describes, so a migration and its version commit or roll back
 * together. A backup copies it with the database. Origin 0.1.0 wrote no version: a store without
 * one is version 1 if it has the tables of 0.1.0, and new otherwise.
 *
 * Opening a store brings it to the latest version, in order and once each:
 *
 * - A new store gets the current schema and the latest version in one transaction.
 * - An older store runs each migration it lacks in a transaction of its own, under the write lock
 *   (BEGIN IMMEDIATE). The version is read again once the lock is held, so when several processes
 *   open the store at once (the CLI, one MCP server per agent), one runs each migration and the
 *   others find it done. A migration that fails is rolled back with its version; the next open runs
 *   it again.
 * - A store whose version is newer than this code knows is refused, unchanged.
 *
 * Then the schema's idempotent statements run, as on every open: tables, indexes, views, and
 * triggers that are new, and that existing data needs nothing from, appear without a migration.
 */

/** What a migration can use. */
export interface MigrationContext {
  db: Database;
  /** ORIGIN_HOME: the raw mirrors are under `<home>/raw`. */
  home: string;
  /**
   * The adapter of a source, for a migration that parses mirrored lines again. Throws an
   * OriginError if the store was opened without it (core has no adapters of its own).
   */
  adapter(source: string): SourceAdapter;
  /** The adapter of a source if the store was opened with one, else null. */
  findAdapter(source: string): SourceAdapter | null;
  log(message: string): void;
}

/**
 * One step of the store format. A schema migration changes tables in place (ALTER TABLE, …); a
 * data migration changes or fills rows, reading the store and its raw mirrors. Either runs inside
 * a write transaction that also records its version, so it must not commit or begin one itself.
 */
export interface Migration {
  /** The version the store has once it has run: one more than the migration before it. */
  version: number;
  /** What it does, for messages. */
  name: string;
  up(ctx: MigrationContext): void;
}

/**
 * Origin's migrations, in order. Version 1 is the schema of 0.1.0, which has none. A migration is
 * never changed once released: a fix is a new migration.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: 'remember which session titles the user gave',
    up: ({ db }) =>
      db.exec('ALTER TABLE session ADD COLUMN title_manual INTEGER NOT NULL DEFAULT 0'),
  },
  {
    // Claude Code 2.1 writes `ai-title` and, after /rename, `custom-title` lines instead of
    // `summary` lines. 0.1.0 mirrored them but skipped them, and a sync does not parse old lines
    // again; only lines that name one of these types are read again.
    version: 3,
    name: 'session titles from Claude Code lines that were skipped before',
    up: (ctx) => reparseTitles(ctx, 'claude-code', ['"ai-title"', '"custom-title"', '"summary"']),
  },
  {
    version: 4,
    name: 'events and entries of memory streams mirrored before they were read',
    up: (ctx) => {
      for (const source of ['claude-code', 'zcode', 'grok']) reparseMemories(ctx, source);
    },
  },
  {
    // Threads (see threads.ts): each session's branch, the follow links and threads derived from
    // the store, and recall items that name a thread.
    version: 5,
    name: 'session branches and threads',
    up: ({ db }) => {
      if (!db.hasColumn('session', 'git_branch')) {
        db.exec('ALTER TABLE session ADD COLUMN git_branch TEXT');
      }
      db.exec(
        `UPDATE session SET git_branch = (${sessionBranchQuery(
          'e.source = session.source AND e.session_id = session.session_id',
        )})`,
      );
      db.exec(THREAD_TABLES_V5);
      // A CHECK constraint cannot be changed in place: the table is made again, rows and all. A
      // store of 0.3 has no recall tables yet; the schema creates them after the migrations.
      if (db.hasTable('recall_item')) db.exec(RECALL_ITEM_V5);
      // By the rules as they were: who wrote what is known from version 8 on, which derives the
      // threads again.
      deriveThreads(db, { anySession: true });
    },
  },
  {
    // Proposals (see proposals.ts): derived from the tool results that carry them, which a store
    // may hold already, such as a hub that received a device's lines before it was upgraded.
    version: 6,
    name: 'proposals from the tool results already archived',
    up: ({ db }) => {
      db.exec(PROPOSAL_TABLES_V6);
      deriveProposals(db);
    },
  },
  {
    // Devices and agents (see tokens.ts): each token is the credential of a device or of an agent
    // of the owner, with a preset; tokens made before keep what they could do (readwrite). Requests
    // of devices and agents to the hub are audited on a channel of their own.
    version: 7,
    name: 'tokens of devices and agents, and an audit channel for the hub API',
    up: ({ db }) => {
      if (!db.hasColumn('api_token', 'kind')) {
        db.exec(
          "ALTER TABLE api_token ADD COLUMN kind TEXT NOT NULL DEFAULT 'device' CHECK (kind IN ('device', 'agent'))",
        );
      }
      if (!db.hasColumn('api_token', 'preset')) {
        db.exec(
          "ALTER TABLE api_token ADD COLUMN preset TEXT NOT NULL DEFAULT 'readwrite' CHECK (preset IN ('readwrite', 'readonly'))",
        );
      }
      classifyTokensV7(db);
      const audit = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
        .get() as { sql: string } | undefined;
      if (audit && !audit.sql.includes("'api'")) db.exec(AUDIT_LOG_V7);
    },
  },
  {
    // Who wrote each input (see authors.ts): derived from the lines already archived, which are
    // parsed again for it, and threads again, since their branch rule counts only the owner's
    // conversations. Lines that now yield an event they did not, such as the prompts Claude Code
    // queued while the agent was busy, add it.
    version: 8,
    name: 'who wrote each input, from the lines already archived',
    up: (ctx) => {
      ctx.db.exec(AUTHOR_TABLES_V8);
      reparseAuthorship(ctx);
      deriveThreads(ctx.db);
    },
  },
  {
    // Where a session belongs, apart from the label on its first event. Empty until a place line
    // or a later resolution fills it. Does not read the filesystem and does not reparse mirrors.
    // The SQL is written here, the same shape schema.ts creates for a new store (one project root
    // per device, and place_head). This file does not import that shape; the two must stay in step.
    version: 9,
    name: 'where a session belongs, apart from the label on its line',
    up: (ctx) => {
      ctx.db.exec(PLACE_TABLES_V9);
    },
  },
  {
    // Parent sessions (see parents.ts), then places.jsonl lines mirrored before those tables
    // existed: a later sync skips bytes it already has, so they are applied here, after
    // session_parent exists. A places line whose version this Origin does not know stays in the
    // mirror, is skipped, and is logged as a warning; the format that understands it calls
    // reparsePlaces again. Threads again, so a child joins its parent and a linked work tree joins
    // the main checkout. Does not open an agent's database or session directory. The parent-table
    // SQL is written below, not imported from schema.ts.
    version: 10,
    name: 'parent sessions, and places already mirrored',
    up: (ctx) => {
      ctx.db.exec(PARENT_TABLES);
      reparseParents(ctx);
      reparsePlaces(ctx.db, ctx.home, ctx.log);
      deriveThreads(ctx.db);
    },
  },
  {
    // Recall hands over past messages too (see recall.ts): an item may be an event, in the layer
    // `messages`, with where its excerpt starts. A CHECK constraint cannot be changed in place, so
    // recall_item is made again, rows, index, and triggers with it, as version 5 did. A store
    // without recall tables yet gets them from the schema after the migrations.
    version: 11,
    name: 'recall items that are past messages',
    up: ({ db }) => {
      if (!db.hasTable('recall_item')) return;
      const excerpt = db.hasColumn('recall_item', 'excerpt') ? 'excerpt' : 'NULL';
      db.exec(recallItemV11(excerpt));
    },
  },
];

/**
 * recall_item again, whose items may now be past messages, with where each one's excerpt starts;
 * its triggers and index go with it. `excerpt` is what the old rows hold for it (none, NULL).
 */
function recallItemV11(excerpt: string): string {
  return `
CREATE TABLE recall_item_v11 (
  recall_id TEXT    NOT NULL REFERENCES recall(id),
  rank      INTEGER NOT NULL,
  layer     TEXT    NOT NULL CHECK (layer IN ('cognition', 'project', 'sessions', 'prompt', 'messages')),
  kind      TEXT    NOT NULL CHECK (kind IN ('entry', 'session', 'thread', 'event')),
  ref       TEXT    NOT NULL,
  score     REAL,
  tokens    INTEGER NOT NULL,
  excerpt   INTEGER CHECK (excerpt IS NULL OR (kind = 'event' AND excerpt >= 0)),
  PRIMARY KEY (recall_id, rank)
) WITHOUT ROWID;
INSERT INTO recall_item_v11 (recall_id, rank, layer, kind, ref, score, tokens, excerpt)
  SELECT recall_id, rank, layer, kind, ref, score, tokens, ${excerpt} FROM recall_item;
DROP TABLE recall_item;
ALTER TABLE recall_item_v11 RENAME TO recall_item;
CREATE INDEX IF NOT EXISTS recall_item_ref ON recall_item (ref);
CREATE TRIGGER IF NOT EXISTS recall_item_no_update BEFORE UPDATE ON recall_item BEGIN
  SELECT RAISE(ABORT, 'recall_item is append-only');
END;
CREATE TRIGGER IF NOT EXISTS recall_item_no_delete BEFORE DELETE ON recall_item BEGIN
  SELECT RAISE(ABORT, 'recall_item is append-only');
END;
`;
}

/**
 * Version 9: where a session belongs. Written here, not imported from schema.ts. A new store is
 * created from schema.ts with this same shape; keep the two the same. This step fills nothing.
 * Version 10 reads the places already mirrored. A line whose version this Origin does not know
 * stays in the mirror; the format that understands it calls reparsePlaces again.
 */
const PLACE_TABLES_V9 = `
CREATE TABLE IF NOT EXISTS project_root (
  device  TEXT NOT NULL DEFAULT '',
  path    TEXT NOT NULL,
  project TEXT NOT NULL,
  root    TEXT NOT NULL,
  signal  TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (device, path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_place (
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project    TEXT NOT NULL,
  root       TEXT,
  signal     TEXT NOT NULL,
  PRIMARY KEY (source, session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_place_project ON session_place (project);
CREATE TABLE IF NOT EXISTS place_head (
  source TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  key    TEXT NOT NULL,
  line   TEXT NOT NULL,
  PRIMARY KEY (source, device, key)
) WITHOUT ROWID;
`;

/**
 * Version 7: a token is a device's when the hub holds what only a device sends under its name (a
 * file it pushed from its own disk, at an absolute path, or an entry, a tombstone, or a recall it
 * wrote), or when it was never used, as tokens were named after devices; otherwise it is an
 * agent's (a cloud agent that used /mcp, or a program that appended event lines, at relative
 * paths). Either keeps working as before.
 */
function classifyTokensV7(db: Database): void {
  const tokens = db.prepare('SELECT name, last_used_at FROM api_token').all() as Array<{
    name: string;
    last_used_at: number | null;
  }>;
  if (tokens.length === 0) return;
  const devices = new Set<string>();
  const pushed = db
    .prepare("SELECT path FROM raw_file WHERE substr(path, 1, 1) = '@'")
    .all() as Array<{ path: string }>;
  for (const { path } of pushed) {
    const colon = path.indexOf(':');
    if (colon < 0) continue;
    if (/^([\\/]|[A-Za-z]:[\\/])/.test(path.slice(colon + 1))) devices.add(path.slice(1, colon));
  }
  for (const table of ['entry', 'tombstone', 'recall']) {
    if (!db.hasTable(table) || !db.hasColumn(table, 'origin')) continue;
    for (const r of db.prepare(`SELECT DISTINCT origin FROM ${table}`).all() as Array<{
      origin: string;
    }>) {
      devices.add(r.origin);
    }
  }
  const setKind = db.prepare('UPDATE api_token SET kind = ? WHERE name = ?');
  for (const t of tokens) {
    setKind.run(t.last_used_at === null || devices.has(t.name) ? 'device' : 'agent', t.name);
  }
}

/** audit_log again, with the channel `api`; its rows keep their ids, and its triggers go with it. */
const AUDIT_LOG_V7 = `
CREATE TABLE audit_log_v7 (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor      TEXT    NOT NULL,
  channel    TEXT    NOT NULL CHECK (channel IN ('ui', 'cli', 'api')),
  action     TEXT    NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT
);
INSERT INTO audit_log_v7 (id, at, actor, channel, action, target, detail, ip, user_agent)
  SELECT id, at, actor, channel, action, target, detail, ip, user_agent FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_v7 RENAME TO audit_log;
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
`;

/** Version 10's parent-session table, written here rather than imported from schema.ts. */
const PARENT_TABLES = `
CREATE TABLE IF NOT EXISTS session_parent (
  source            TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  parent_source     TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  via               TEXT NOT NULL CHECK (via IN ('subagent', 'workflow')),
  run_group         TEXT,
  run_name          TEXT,
  signal            TEXT NOT NULL,
  PRIMARY KEY (source, session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_parent_parent ON session_parent (parent_source, parent_session_id);
`;

/** The tables of authorship, as version 8 created them. */
const AUTHOR_TABLES_V8 = `
CREATE TABLE IF NOT EXISTS event_author (
  seq     INTEGER PRIMARY KEY,
  author  TEXT    NOT NULL CHECK (author IN ('owner', 'person', 'agent', 'system')),
  speaker TEXT,
  signal  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS session_kind (
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('child', 'headless')),
  signal     TEXT NOT NULL,
  PRIMARY KEY (source, session_id, kind, signal)
) WITHOUT ROWID;
`;

/** The tables of proposals, as version 6 created them. */
const PROPOSAL_TABLES_V6 = `
CREATE TABLE IF NOT EXISTS proposal (
  id         TEXT    PRIMARY KEY,
  source     TEXT    NOT NULL,
  session_id TEXT    NOT NULL,
  event_id   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  confidence REAL    NOT NULL,
  project    TEXT,
  valid_from INTEGER,
  valid_to   INTEGER,
  note       TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proposal_event   ON proposal (event_id);
CREATE INDEX IF NOT EXISTS proposal_session ON proposal (source, session_id);
CREATE INDEX IF NOT EXISTS proposal_at      ON proposal (at);
CREATE TABLE IF NOT EXISTS proposal_source (
  proposal_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  quote       TEXT,
  PRIMARY KEY (proposal_id, event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS proposal_source_event ON proposal_source (event_id);
`;

/** The tables of threads, as version 5 created them. */
const THREAD_TABLES_V5 = `
CREATE TABLE IF NOT EXISTS session_follow (
  source            TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  link_id           TEXT NOT NULL,
  target_source     TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  event_id          TEXT PRIMARY KEY
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_follow_from ON session_follow (source, session_id);
CREATE INDEX IF NOT EXISTS session_follow_to ON session_follow (target_source, target_session_id);
CREATE TABLE IF NOT EXISTS session_thread (
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  PRIMARY KEY (source, session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_thread_id ON session_thread (thread_id);
`;

/** recall_item again, whose items may now be threads; its triggers and index go with it. */
const RECALL_ITEM_V5 = `
CREATE TABLE recall_item_v5 (
  recall_id TEXT    NOT NULL REFERENCES recall(id),
  rank      INTEGER NOT NULL,
  layer     TEXT    NOT NULL CHECK (layer IN ('cognition', 'project', 'sessions', 'prompt')),
  kind      TEXT    NOT NULL CHECK (kind IN ('entry', 'session', 'thread')),
  ref       TEXT    NOT NULL,
  score     REAL,
  tokens    INTEGER NOT NULL,
  PRIMARY KEY (recall_id, rank)
) WITHOUT ROWID;
INSERT INTO recall_item_v5 (recall_id, rank, layer, kind, ref, score, tokens)
  SELECT recall_id, rank, layer, kind, ref, score, tokens FROM recall_item;
DROP TABLE recall_item;
ALTER TABLE recall_item_v5 RENAME TO recall_item;
CREATE INDEX IF NOT EXISTS recall_item_ref ON recall_item (ref);
CREATE TRIGGER IF NOT EXISTS recall_item_no_update BEFORE UPDATE ON recall_item BEGIN
  SELECT RAISE(ABORT, 'recall_item is append-only');
END;
CREATE TRIGGER IF NOT EXISTS recall_item_no_delete BEFORE DELETE ON recall_item BEGIN
  SELECT RAISE(ABORT, 'recall_item is append-only');
END;
`;

/** The version of a store created by 0.1.0, the first release, which recorded none. */
export const FIRST_VERSION = 1;

/** The latest version: what this code creates, and brings older stores to. */
export const STORE_VERSION = latestVersion(MIGRATIONS);

/** How long a process waits for another to finish a migration before it gives up. */
export const MIGRATION_WAIT_MS = 5 * 60_000;

export interface MigrateOptions {
  /** ORIGIN_HOME, for migrations that read raw mirrors. */
  home: string;
  /** The database file, for messages. */
  file?: string;
  /** Adapters, for migrations that parse mirrored lines again: a list, or a lookup by source id. */
  adapters?: SourceAdapter[] | ((source: string) => SourceAdapter | null);
  /**
   * Called once before the first migration this process runs, if any: set up what migrations
   * read, such as the frame store of a hub that keeps its sealed frames in a bucket. The store is
   * still at its old version, so this may use only what every version has (`setting`).
   */
  beforeMigrate?: (db: Database) => void;
  log?: (message: string) => void;
  /** The migrations to run, in order (tests); Origin's by default. */
  migrations?: Migration[];
}

function latestVersion(migrations: Migration[]): number {
  let version = FIRST_VERSION;
  for (const m of migrations) {
    if (m.version !== version + 1) {
      throw new Error(`Migration "${m.name}" is version ${m.version}; expected ${version + 1}.`);
    }
    version = m.version;
  }
  return version;
}

/** `PRAGMA user_version`: 0 for a store that records none. */
function userVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/**
 * The version of a store: the one it records, else 1 for a store of 0.1.0 (which has the `raw_file`
 * and `event` tables), else 0 for a new one.
 */
export function storeVersion(db: Database): number {
  const recorded = userVersion(db);
  if (recorded > 0) return recorded;
  return db.hasTable('raw_file') && db.hasTable('event') ? FIRST_VERSION : 0;
}

/** A store written by a newer Origin than this one. */
class NewerStoreError extends OriginError {}

function refuseNewer(version: number, latest: number, file: string | undefined): void {
  if (version <= latest) return;
  throw new NewerStoreError(
    `The store${file ? ` at ${file}` : ''} has format version ${version}, but this Origin knows versions up to ${latest} only: a newer Origin has used it. Upgrade Origin to open it; nothing was changed.`,
  );
}

/**
 * Throw an OriginError if the store was written by a newer Origin, before anything is changed in
 * it, not even its journal mode.
 */
export function refuseNewerStore(
  db: Database,
  opts: Pick<MigrateOptions, 'file' | 'migrations'> = {},
): void {
  const latest = opts.migrations ? latestVersion(opts.migrations) : STORE_VERSION;
  refuseNewer(storeVersion(db), latest, opts.file);
}

/**
 * Run `fn` in a write transaction, waiting up to MIGRATION_WAIT_MS for the lock: another process
 * may be running a migration that takes a while.
 */
function underLock<T>(db: Database, fn: () => T): T {
  assertStoreCurrent(db);
  const timeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  db.exec(`PRAGMA busy_timeout = ${MIGRATION_WAIT_MS}`);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
  }
}

/** What a migration, or a rebuild that parses mirrored lines again, is given (see MigrationContext). */
function migrationContext(
  db: Database,
  home: string,
  adapters: MigrateOptions['adapters'],
  log: (message: string) => void,
): MigrationContext {
  const byId = new Map((Array.isArray(adapters) ? adapters : []).map((a) => [a.id, a]));
  const find =
    typeof adapters === 'function' ? adapters : (source: string) => byId.get(source) ?? null;
  return {
    db,
    home,
    adapter(source) {
      const adapter = find(source);
      if (!adapter) {
        throw new OriginError(
          `This step re-reads the store's ${source} mirrors, which needs the ${source} adapter: open the store with the origin command.`,
        );
      }
      return adapter;
    },
    findAdapter: (source) => find(source) ?? null,
    log,
  };
}

/**
 * Derive who wrote each input again, from scratch, from the raw mirrors (see reparseAuthorship), and
 * the threads with it, whose branch rule counts only the owner's conversations: what ingestion keeps
 * up to date as it goes. Needs the adapters of the sources whose mirrors the store holds, as
 * migrations do (the built-in ones at least).
 */
export function rebuildAuthorship(
  db: Database,
  opts: Pick<MigrateOptions, 'home' | 'adapters' | 'log'>,
): void {
  const ctx = migrationContext(db, opts.home, opts.adapters, opts.log ?? (() => {}));
  transaction(
    db,
    () => {
      db.exec('DELETE FROM event_author');
      db.exec('DELETE FROM session_kind');
      reparseAuthorship(ctx);
      deriveThreads(db);
    },
    { immediate: true },
  );
}

/**
 * Bring a store to the latest version (see the top of this file), then apply the schema's
 * idempotent statements. Throws an OriginError for a store newer than this code, or when a
 * migration fails; what earlier migrations did stays.
 */
export function migrate(db: Database, opts: MigrateOptions): void {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = opts.migrations ? latestVersion(migrations) : STORE_VERSION;
  const log = opts.log ?? (() => {});
  const found = storeVersion(db);
  const stamped = userVersion(db) !== 0;
  refuseNewer(found, latest, opts.file);

  if (found === 0) {
    underLock(db, () => {
      const now = storeVersion(db);
      refuseNewer(now, latest, opts.file);
      if (now !== 0) return; // created by another process meanwhile
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${latest}`);
    });
  } else if (found < latest || !stamped) {
    opts.beforeMigrate?.(db);
    const ctx = migrationContext(db, opts.home, opts.adapters, log);
    // A store of 0.1.0 records no version yet: record 1, then go on from there.
    const steps: Array<{ version: number; name: string; up?: () => void }> = [
      { version: FIRST_VERSION, name: 'record the format version' },
      ...migrations.map((m) => ({ version: m.version, name: m.name, up: () => m.up(ctx) })),
    ];
    for (const step of steps) {
      if (step.version < found || (step.version === found && stamped)) continue;
      try {
        underLock(db, () => {
          const now = storeVersion(db);
          refuseNewer(now, latest, opts.file);
          // Done already, by another process that opened the store at the same time.
          if (now >= step.version && userVersion(db) !== 0) return;
          if (step.up) log(`Upgrading the store to version ${step.version}: ${step.name}.`);
          step.up?.();
          db.exec(`PRAGMA user_version = ${step.version}`);
        });
      } catch (err) {
        if (!step.up || err instanceof NewerStoreError || err instanceof StoreUpgradedError)
          throw err;
        const reason = (err as Error).message.replace(/\.?$/, '.');
        throw Object.assign(
          new OriginError(
            `The store could not be upgraded to version ${step.version} (${step.name}): ${reason} Nothing of this step was kept; it runs again the next time the store is opened.`,
          ),
          { cause: err },
        );
      }
    }
  }
  db.exec(SCHEMA);
}
