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

/**
 * A database as Origin 0.1.0 created it: its pragmas, its functions, its schema, and no version.
 * The caller fills it, through this connection, and closes it.
 */
export function legacyStore(file: string): Database {
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
  db.exec(SCHEMA_0_1_0);
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
    db.exec('ALTER TABLE session DROP COLUMN title_manual');
    // Tables and indexes added since 0.1.0 without a migration (created on open, filled from what
    // 0.1.0 kept; see BACKFILL_EFFECTS).
    db.exec('DROP TABLE IF EXISTS tombstone_effect');
    db.exec('DROP TABLE IF EXISTS tombstone_meta');
    db.exec('DROP INDEX IF EXISTS tombstone_target');
    db.exec('DROP INDEX IF EXISTS event_user_message');
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

export function userVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
