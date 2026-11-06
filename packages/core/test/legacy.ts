import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { cjkIndexText } from '../src/cjk.js';
import type { Database } from '../src/index.js';

/** The schema of Origin 0.1.0, verbatim: store format version 1. */
export const SCHEMA_0_1_0 = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/schema-0.1.0.sql', import.meta.url)),
  'utf8',
);

/** The schema of Origin 0.4.0, verbatim: store format version 4. */
export const SCHEMA_0_4_0 = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/schema-0.4.0.sql', import.meta.url)),
  'utf8',
);

/**
 * A database as Origin 0.1.0 created it: its pragmas, its functions, its schema, and no version.
 * The caller fills it, through this connection, and closes it.
 */
export function legacyStore(file: string): Database {
  const db = oldConnection(file);
  db.exec(SCHEMA_0_1_0);
  return db;
}

/**
 * A database as Origin 0.4.0 created it: its pragmas, its functions, its schema, and version 4. The
 * caller fills it, through this connection, and closes it.
 */
export function store040(file: string): Database {
  const db = oldConnection(file);
  db.exec(SCHEMA_0_4_0);
  db.exec('PRAGMA user_version = 4');
  return db;
}

function oldConnection(file: string): Database {
  const db = new DatabaseSync(file);
  db.function('origin_cjk', { deterministic: true }, (text, kind) =>
    typeof text === 'string' ? cjkIndexText(text, String(kind)) : null,
  );
  db.function('origin_contains', { deterministic: true }, (text, needle) =>
    typeof text === 'string' && typeof needle === 'string' && text.toLowerCase().includes(needle)
      ? 1
      : 0,
  );
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}

/**
 * What a database's schema is, for comparing a migrated store with a new one: each table's columns
 * (an added column changes a table's SQL text, but not its columns), and the SQL of everything
 * else, with whitespace collapsed.
 */
export function schemaOf(db: Database): unknown[] {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return objects.map((o) => {
    if (o.type === 'table' && !/^CREATE VIRTUAL/i.test(o.sql ?? '')) {
      return {
        type: o.type,
        name: o.name,
        columns: db.prepare(`PRAGMA table_xinfo("${o.name}")`).all(),
      };
    }
    return { ...o, sql: o.sql?.replace(/\s+/g, ' ') ?? null };
  });
}

/**
 * Turn a store of the latest version, closed, back into the store 0.1.0 would have made of the same
 * lines: without the columns added since, without a version, and without the titles of Claude Code
 * sessions, which 0.1.0 did not read from `ai-title` and `custom-title` lines (this drops those
 * from `summary` lines too, which the migration reads again as well). Throws if the schema is then
 * not that of 0.1.0, so that a new migration cannot leave this behind unnoticed.
 */
export function downgradeToV1(file: string): void {
  const db = new DatabaseSync(file);
  try {
    dropParents(db);
    dropPlaces(db);
    // Version 8: authorship.
    dropAuthorship(db);
    undoV7(db);
    // Version 6: proposals.
    db.exec('DROP TABLE IF EXISTS proposal_source');
    db.exec('DROP TABLE IF EXISTS proposal');
    // Version 5: session branches and threads.
    db.exec('DROP INDEX IF EXISTS session_project');
    db.exec('ALTER TABLE session DROP COLUMN git_branch');
    db.exec('DROP TABLE IF EXISTS session_follow');
    db.exec('DROP TABLE IF EXISTS session_thread');
    db.exec('ALTER TABLE session DROP COLUMN title_manual');
    // Tables and indexes added since 0.1.0 without a migration (created on open, filled from what
    // 0.1.0 kept; see BACKFILL_EFFECTS).
    db.exec('DROP TABLE IF EXISTS tombstone_effect');
    db.exec('DROP TABLE IF EXISTS tombstone_meta');
    db.exec('DROP INDEX IF EXISTS tombstone_target');
    db.exec('DROP INDEX IF EXISTS event_user_message');
    db.exec('DROP INDEX IF EXISTS raw_file_mirror');
    db.exec('DROP TABLE IF EXISTS imported_entry');
    db.exec('DROP TABLE IF EXISTS recall_item');
    db.exec('DROP TABLE IF EXISTS recall');
    db.exec("UPDATE session SET title = NULL WHERE source = 'claude-code'");
    db.exec('PRAGMA user_version = 0');
    const reference = legacyStore(':memory:');
    const same = JSON.stringify(schemaOf(db)) === JSON.stringify(schemaOf(reference));
    reference.close();
    if (!same) throw new Error('downgradeToV1 must undo every migration since 0.1.0');
  } finally {
    db.close();
  }
}

/**
 * Undo version 11: recall_item as version 5 made it, without the kind `event`, the layer
 * `messages`, or `excerpt`, its rows, index, and triggers kept. Throws on an item version 10 cannot
 * hold.
 */
function undoV11(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE recall_item_v10 (
  recall_id TEXT    NOT NULL REFERENCES recall(id),
  rank      INTEGER NOT NULL,
  layer     TEXT    NOT NULL CHECK (layer IN ('cognition', 'project', 'sessions', 'prompt')),
  kind      TEXT    NOT NULL CHECK (kind IN ('entry', 'session', 'thread')),
  ref       TEXT    NOT NULL,
  score     REAL,
  tokens    INTEGER NOT NULL,
  PRIMARY KEY (recall_id, rank)
) WITHOUT ROWID;
INSERT INTO recall_item_v10 (recall_id, rank, layer, kind, ref, score, tokens)
  SELECT recall_id, rank, layer, kind, ref, score, tokens FROM recall_item;
DROP TABLE recall_item;
ALTER TABLE recall_item_v10 RENAME TO recall_item;
CREATE INDEX recall_item_ref ON recall_item (ref);
CREATE TRIGGER recall_item_no_update BEFORE UPDATE ON recall_item BEGIN
  SELECT RAISE(ABORT, 'recall_item is append-only');
END;
CREATE TRIGGER recall_item_no_delete BEFORE DELETE ON recall_item BEGIN
  SELECT RAISE(ABORT, 'recall_item is append-only');
END;`);
}

/**
 * Turn a store of the latest version, closed, back into a store of version 10: recall items that
 * cannot be past messages (see undoV11).
 */
export function downgradeToV10(file: string): void {
  const db = new DatabaseSync(file);
  try {
    undoV11(db);
    db.exec('PRAGMA user_version = 10');
  } finally {
    db.close();
  }
}

/** The table version 10 added: parent sessions. Dropping it drops its index. */
function dropParents(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS session_parent');
}

/** The tables version 9 added: resolved project names. */
function dropPlaces(db: DatabaseSync): void {
  db.exec('DROP INDEX IF EXISTS session_place_project');
  db.exec('DROP TABLE IF EXISTS session_place');
  db.exec('DROP TABLE IF EXISTS project_root');
  db.exec('DROP TABLE IF EXISTS place_head');
}

/** The tables version 8 added: who wrote each input, and the kinds of sessions. */
function dropAuthorship(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS event_author');
  db.exec('DROP TABLE IF EXISTS session_kind');
}

/**
 * Turn a store of the latest version, closed, back into a store of version 7: without the tables of
 * authorship, which version 8 added. Its events and mirrors stay, so the migration derives who wrote
 * each input again from the mirrors.
 */
export function downgradeToV7(file: string): void {
  const db = new DatabaseSync(file);
  try {
    undoV11(db);
    dropParents(db);
    dropPlaces(db);
    dropAuthorship(db);
    db.exec('PRAGMA user_version = 7');
  } finally {
    db.close();
  }
}

/**
 * Turn a store of the latest version, closed, back into a store of version 5: without the tables of
 * proposals, which version 6 added, nor what versions 7 and 8 added. Its events stay, so the
 * migrations derive the proposals again.
 */
export function downgradeToV5(file: string): void {
  const db = new DatabaseSync(file);
  try {
    undoV11(db);
    dropParents(db);
    dropPlaces(db);
    dropAuthorship(db);
    undoV7(db);
    db.exec('DROP TABLE IF EXISTS proposal_source');
    db.exec('DROP TABLE IF EXISTS proposal');
    db.exec('PRAGMA user_version = 5');
  } finally {
    db.close();
  }
}

/**
 * Undo version 7 and the tables added with it: tokens without a kind or a preset, the audit log
 * without the `api` channel, and no OAuth tables.
 */
function undoV7(db: DatabaseSync): void {
  for (const table of [
    'oauth_token',
    'oauth_grant',
    'oauth_code',
    'oauth_client',
    'device_request',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.exec('ALTER TABLE api_token DROP COLUMN kind');
  db.exec('ALTER TABLE api_token DROP COLUMN preset');
  db.exec(`
CREATE TABLE audit_log_v6 (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor      TEXT    NOT NULL,
  channel    TEXT    NOT NULL CHECK (channel IN ('ui', 'cli')),
  action     TEXT    NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT
);
INSERT INTO audit_log_v6 SELECT * FROM audit_log WHERE channel IN ('ui', 'cli');
DROP TABLE audit_log;
ALTER TABLE audit_log_v6 RENAME TO audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;`);
}

/**
 * Turn a store of the latest version, closed, back into a store of version 6: tokens without a
 * kind or a preset, which version 7 added, and the audit log without its `api` channel, nor the
 * tables of authorship, which version 8 added.
 */
export function downgradeToV6(file: string): void {
  const db = new DatabaseSync(file);
  try {
    undoV11(db);
    dropParents(db);
    dropPlaces(db);
    dropAuthorship(db);
    undoV7(db);
    db.exec('PRAGMA user_version = 6');
  } finally {
    db.close();
  }
}

export function userVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
