/**
 * Database schema (see docs/architecture.md).
 * - raw_file: append-only mirror cursors for original files (Raw).
 * - raw_chunk: the sealed zstd frames of each mirror (see mirror.ts): first line, line count,
 *   offset and length in the mirror's content and in its `.zst` file. Append-only: triggers reject
 *   updates and deletes.
 * - event: unified events (Event), append-only, keyed by `seq`, their order of arrival in this store
 *   (the rowid; explicit so that VACUUM keeps it, since the search indexes refer to it).
 *   event_user_message indexes a session's user messages alone, which a turn starts with (see
 *   sessionPrompts), so that a long session's turns are found without reading its other events.
 * - event_block: for each block of 4,096 consecutive arrivals, the latest timestamp in it and up to
 *   its end, kept by a trigger, so that a newest-first query reading an index by arrival knows when
 *   nothing older can follow (see search.ts); derived.
 * - session: aggregate per (source, session_id), derived from its visible events and rebuildable,
 *   plus its title, from the lines that carry one, and whether the user gave it (title_manual,
 *   added in version 2).
 * - event_fts, message_fts, event_cjk: the search indexes, all keyed by seq and filled by
 *   triggers; rebuildSearchIndexes() rebuilds them. event_fts is a trigram index of every event
 *   that records only which events contain each trigram (detail=none), message_fts a full trigram
 *   index of message events (positions, for phrases and BM25; its content is the event_message
 *   view), and event_cjk a contentless index of CJK bigrams (see cjk.ts).
 * - sync_log: per-sync statistics.
 * - entry / entry_source: durable entries and the events they cite (Entry), append-only; an entry
 *   changes only by being superseded. Several versions may supersede the same one (concurrent
 *   corrections on different stores); `root` is the first version of the chain, fixed on insert.
 *   Status is derived, never stored. `origin` is the store that wrote the version.
 * - entry_fts: FTS5 trigram index over entries.
 * - imported_entry: the versions of entries this store derived from native memories (see
 *   memories.ts). Every store that parses a memory stream derives them, so they are never sent.
 * - tombstone / forgotten_entry / excluded_event: forget and restore operations (Tombstone, with a
 *   global `tmb_` id and the store it came from; a restore is a tombstone whose target is a
 *   forget's id), and what is hidden on this store: each hidden entry and event with one forget in
 *   effect that covers it.
 * - tombstone_effect: what each forget covers on this store, several forgets per item: by the
 *   rules from its target (`direct`), as its hub listed it (`listed`, on a device, replaced by
 *   each new list), as a device reported it (`reported`, on a hub), or by rule 3 (`cascade`). An
 *   item is hidden while a forget in effect covers it (see forgetting.ts).
 * - tombstone_meta: the author of each tombstone, when known. Every tombstone written by this
 *   version has a row; tombstones without one predate tombstone_effect and are filled in from
 *   forgotten_entry and excluded_event when the database is opened (BACKFILL_EFFECTS).
 * - change_log: append-only sequence of the entries and tombstones this store has received or
 *   written, filled by triggers; replication cursors point into it.
 * - api_token: hub access tokens (name and SHA-256 hash; the token itself is never stored).
 * - setting: small key-value state, local to this store and never replicated: the store's name,
 *   a device's replication cursors, or the scrypt hash of the hub's admin password.
 * - admin_session: server-side admin UI sessions (only a hash of the session id is stored). The
 *   key_name column predates the single admin password and now always holds `owner`.
 * - audit_log: append-only record of administrative actions with ids and counts only, never
 *   content; triggers reject every UPDATE and DELETE.
 *
 * This is the schema of the latest format version: a new store is created with it. Every statement
 * is idempotent and runs on each open, after the migrations, so a new table, index, view, or
 * trigger that existing data needs nothing from appears in existing stores without a migration.
 * Any other change, such as a new column or a changed definition (`IF NOT EXISTS` keeps an old
 * one), needs a migration in migrations.ts as well as the change here, so that an upgraded store
 * and a new one end up the same (see docs/architecture.md#migrations).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_file (
  id             INTEGER PRIMARY KEY,
  source         TEXT    NOT NULL,
  path           TEXT    NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 1,
  mirror         TEXT    NOT NULL,
  bytes_ingested INTEGER NOT NULL DEFAULT 0,
  lines_ingested INTEGER NOT NULL DEFAULT 0,
  tail_hash      TEXT    NOT NULL DEFAULT '',
  first_seen_at  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (source, path, generation)
);

CREATE TABLE IF NOT EXISTS raw_chunk (
  raw_file_id  INTEGER NOT NULL REFERENCES raw_file(id),
  first_line   INTEGER NOT NULL,
  line_count   INTEGER NOT NULL,
  byte_offset  INTEGER NOT NULL,
  byte_length  INTEGER NOT NULL,
  frame_offset INTEGER NOT NULL,
  frame_length INTEGER NOT NULL,
  PRIMARY KEY (raw_file_id, first_line)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS raw_chunk_offset ON raw_chunk (raw_file_id, byte_offset);
CREATE TRIGGER IF NOT EXISTS raw_chunk_no_update BEFORE UPDATE ON raw_chunk BEGIN
  SELECT RAISE(ABORT, 'raw_chunk is append-only');
END;
CREATE TRIGGER IF NOT EXISTS raw_chunk_no_delete BEFORE DELETE ON raw_chunk BEGIN
  SELECT RAISE(ABORT, 'raw_chunk is append-only');
END;

CREATE TABLE IF NOT EXISTS session (
  source       TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  project      TEXT,
  cwd          TEXT,
  title        TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  event_count  INTEGER NOT NULL DEFAULT 0,
  title_manual INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id)
);

CREATE TABLE IF NOT EXISTS event (
  seq           INTEGER PRIMARY KEY,
  id            TEXT    NOT NULL UNIQUE,
  source        TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  parent_id     TEXT,
  ts            INTEGER NOT NULL,
  project       TEXT,
  cwd           TEXT,
  git_branch    TEXT,
  role          TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  raw_file_id   INTEGER NOT NULL REFERENCES raw_file(id),
  raw_line      INTEGER NOT NULL,
  agent_version TEXT,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS event_ts      ON event (ts);
CREATE INDEX IF NOT EXISTS event_session ON event (source, session_id, ts);
CREATE INDEX IF NOT EXISTS event_project ON event (project, ts);
CREATE INDEX IF NOT EXISTS event_seq_ts  ON event (seq, ts);
CREATE INDEX IF NOT EXISTS event_user_message ON event (source, session_id, ts)
  WHERE role = 'user' AND kind = 'message';

CREATE TABLE IF NOT EXISTS event_block (
  block     INTEGER PRIMARY KEY,
  max_ts    INTEGER NOT NULL,
  latest_ts INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS event_block_ai AFTER INSERT ON event BEGIN
  INSERT OR IGNORE INTO event_block (block, max_ts, latest_ts)
    VALUES (new.seq >> 12, new.ts, MAX(new.ts, COALESCE(
      (SELECT latest_ts FROM event_block WHERE block = (new.seq >> 12) - 1), new.ts)));
  UPDATE event_block SET max_ts = MAX(max_ts, new.ts), latest_ts = MAX(latest_ts, new.ts)
    WHERE block = new.seq >> 12;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  text,
  content = 'event',
  content_rowid = 'seq',
  tokenize = 'trigram',
  detail = 'none'
);
CREATE VIEW IF NOT EXISTS event_message (seq, text) AS
  SELECT seq, text FROM event WHERE kind = 'message';
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  content = 'event_message',
  content_rowid = 'seq',
  tokenize = 'trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS event_cjk USING fts5(
  text,
  content = '',
  detail = 'none',
  columnsize = 0,
  tokenize = 'ascii'
);
CREATE TRIGGER IF NOT EXISTS event_ai AFTER INSERT ON event BEGIN
  INSERT INTO event_fts (rowid, text) VALUES (new.seq, new.text);
  INSERT INTO message_fts (rowid, text) SELECT new.seq, new.text WHERE new.kind = 'message';
  INSERT INTO event_cjk (rowid, text)
    SELECT new.seq, t FROM (SELECT origin_cjk(new.text, new.kind) AS t) WHERE t IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS event_ad AFTER DELETE ON event BEGIN
  INSERT INTO event_fts (event_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO message_fts (message_fts, rowid, text)
    SELECT 'delete', old.seq, old.text WHERE old.kind = 'message';
  INSERT INTO event_cjk (event_cjk, rowid, text)
    SELECT 'delete', old.seq, t FROM (SELECT origin_cjk(old.text, old.kind) AS t)
    WHERE t IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS event_au AFTER UPDATE OF text, kind ON event BEGIN
  INSERT INTO event_fts (event_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO message_fts (message_fts, rowid, text)
    SELECT 'delete', old.seq, old.text WHERE old.kind = 'message';
  INSERT INTO event_cjk (event_cjk, rowid, text)
    SELECT 'delete', old.seq, t FROM (SELECT origin_cjk(old.text, old.kind) AS t)
    WHERE t IS NOT NULL;
  INSERT INTO event_fts (rowid, text) VALUES (new.seq, new.text);
  INSERT INTO message_fts (rowid, text) SELECT new.seq, new.text WHERE new.kind = 'message';
  INSERT INTO event_cjk (rowid, text)
    SELECT new.seq, t FROM (SELECT origin_cjk(new.text, new.kind) AS t) WHERE t IS NOT NULL;
END;

CREATE TABLE IF NOT EXISTS sync_log (
  id            INTEGER PRIMARY KEY,
  source        TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  files_seen    INTEGER NOT NULL,
  files_changed INTEGER NOT NULL,
  lines_read    INTEGER NOT NULL,
  events_added  INTEGER NOT NULL,
  parse_errors  INTEGER NOT NULL,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS sync_log_finished ON sync_log (finished_at);
CREATE INDEX IF NOT EXISTS sync_log_source   ON sync_log (source, id);

CREATE TABLE IF NOT EXISTS entry (
  id         TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('memory', 'knowledge', 'cognition')),
  text       TEXT    NOT NULL,
  confidence REAL    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  author     TEXT    NOT NULL,
  project    TEXT,
  supersedes TEXT    REFERENCES entry(id),
  root       TEXT    NOT NULL,
  valid_from INTEGER,
  valid_to   INTEGER,
  created_at INTEGER NOT NULL,
  origin     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_created    ON entry (created_at);
CREATE INDEX IF NOT EXISTS entry_supersedes ON entry (supersedes);
CREATE INDEX IF NOT EXISTS entry_root       ON entry (root, created_at, id);

CREATE TABLE IF NOT EXISTS entry_source (
  entry_id TEXT NOT NULL REFERENCES entry(id),
  event_id TEXT NOT NULL REFERENCES event(id),
  quote    TEXT,
  PRIMARY KEY (entry_id, event_id)
);
CREATE INDEX IF NOT EXISTS entry_source_event ON entry_source (event_id);

CREATE TABLE IF NOT EXISTS imported_entry (
  entry_id TEXT PRIMARY KEY REFERENCES entry(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  text,
  content = 'entry',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS entry_ai AFTER INSERT ON entry BEGIN
  INSERT INTO entry_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS tombstone (
  id         TEXT    PRIMARY KEY,
  target     TEXT    NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  origin     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS forgotten_entry (
  entry_id     TEXT PRIMARY KEY REFERENCES entry(id),
  tombstone_id TEXT NOT NULL REFERENCES tombstone(id)
);
CREATE INDEX IF NOT EXISTS forgotten_entry_tombstone ON forgotten_entry (tombstone_id);

CREATE TABLE IF NOT EXISTS excluded_event (
  event_id     TEXT PRIMARY KEY REFERENCES event(id),
  tombstone_id TEXT NOT NULL REFERENCES tombstone(id)
);
CREATE INDEX IF NOT EXISTS excluded_event_tombstone ON excluded_event (tombstone_id);
CREATE INDEX IF NOT EXISTS tombstone_target ON tombstone (target);

CREATE TABLE IF NOT EXISTS tombstone_effect (
  tombstone_id TEXT NOT NULL REFERENCES tombstone(id),
  kind         TEXT NOT NULL CHECK (kind IN ('entry', 'event')),
  item         TEXT NOT NULL,
  how          TEXT NOT NULL CHECK (how IN ('direct', 'listed', 'reported', 'cascade')),
  PRIMARY KEY (tombstone_id, kind, item, how)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tombstone_effect_item ON tombstone_effect (item, kind);

CREATE TABLE IF NOT EXISTS tombstone_meta (
  tombstone_id TEXT PRIMARY KEY REFERENCES tombstone(id),
  author       TEXT
);

CREATE TABLE IF NOT EXISTS change_log (
  seq    INTEGER PRIMARY KEY,
  kind   TEXT    NOT NULL CHECK (kind IN ('entry', 'tombstone')),
  id     TEXT    NOT NULL,
  origin TEXT    NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_kind ON change_log (kind, seq);
CREATE INDEX IF NOT EXISTS change_log_id   ON change_log (id);
CREATE TRIGGER IF NOT EXISTS entry_change AFTER INSERT ON entry BEGIN
  INSERT INTO change_log (kind, id, origin, at)
  VALUES ('entry', new.id, new.origin, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS tombstone_change AFTER INSERT ON tombstone BEGIN
  INSERT INTO change_log (kind, id, origin, at)
  VALUES ('tombstone', new.id, new.origin, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS change_log_no_update BEFORE UPDATE ON change_log BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS change_log_no_delete BEFORE DELETE ON change_log BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;

CREATE TABLE IF NOT EXISTS api_token (
  name         TEXT    PRIMARY KEY,
  hash         TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_session (
  id_hash      TEXT    PRIMARY KEY,
  key_name     TEXT    NOT NULL,
  csrf         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  fresh_at     INTEGER NOT NULL,
  ended_at     INTEGER,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
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
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
`;

/** Whether some tombstone predates tombstone_effect and tombstone_meta (a read-only check). */
export const NEEDS_BACKFILL = `SELECT 1 FROM tombstone t
  WHERE NOT EXISTS (SELECT 1 FROM tombstone_meta m WHERE m.tombstone_id = t.id) LIMIT 1`;

/**
 * Record, once, what the forgets of a store written before tombstone_effect existed cover: what
 * forgotten_entry and excluded_event attribute to each, and what the rules give from its target
 * (rule 1 for an entry, rule 2 for an event; see forgetting.ts). All of it counts as `direct`, so it
 * stays hidden while the forget is in effect. Then every such tombstone gets its tombstone_meta row.
 */
export const BACKFILL_EFFECTS = `
CREATE TEMP TABLE IF NOT EXISTS backfill_todo (id TEXT PRIMARY KEY, target TEXT NOT NULL);
DELETE FROM backfill_todo;
INSERT INTO backfill_todo (id, target)
  SELECT t.id, t.target FROM tombstone t
  WHERE NOT EXISTS (SELECT 1 FROM tombstone_meta m WHERE m.tombstone_id = t.id);
CREATE TEMP TABLE IF NOT EXISTS backfill_chain (tid TEXT NOT NULL, root TEXT NOT NULL);
DELETE FROM backfill_chain;
INSERT INTO backfill_chain (tid, root)
  SELECT d.id, en.root FROM backfill_todo d JOIN entry en ON en.id = d.target
  UNION
  SELECT d.id, en.root FROM backfill_todo d
    JOIN entry_source s ON s.event_id = d.target JOIN entry en ON en.id = s.entry_id;
INSERT OR IGNORE INTO tombstone_effect (tombstone_id, kind, item, how)
  SELECT c.tid, 'entry', v.id, 'direct' FROM backfill_chain c JOIN entry v ON v.root = c.root
  UNION
  SELECT c.tid, 'event', s.event_id, 'direct' FROM backfill_chain c
    JOIN entry v ON v.root = c.root JOIN entry_source s ON s.entry_id = v.id
    WHERE EXISTS (SELECT 1 FROM event e WHERE e.id = s.event_id)
  UNION
  SELECT d.id, 'event', d.target, 'direct' FROM backfill_todo d
    WHERE EXISTS (SELECT 1 FROM event e WHERE e.id = d.target)
  UNION
  SELECT f.tombstone_id, 'entry', f.entry_id, 'direct' FROM forgotten_entry f
    JOIN backfill_todo d ON d.id = f.tombstone_id
  UNION
  SELECT x.tombstone_id, 'event', x.event_id, 'direct' FROM excluded_event x
    JOIN backfill_todo d ON d.id = x.tombstone_id;
INSERT OR IGNORE INTO tombstone_meta (tombstone_id, author) SELECT id, NULL FROM backfill_todo;
DELETE FROM backfill_todo;
DELETE FROM backfill_chain;
`;
