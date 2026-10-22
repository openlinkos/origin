/**
 * Database schema (see docs/architecture.md).
 * - raw_file: append-only mirror cursors for original files (Raw).
 * - event: unified events (Event), append-only.
 * - session: derived aggregate per (source, session_id); rebuildable.
 * - event_fts: FTS5 trigram index; can be dropped and rebuilt.
 * - sync_log: per-sync statistics.
 * - entry / entry_source: durable entries and the events they cite (Entry), append-only; an entry
 *   changes only by being superseded. Several versions may supersede the same one (concurrent
 *   corrections on different stores); `root` is the first version of the chain, fixed on insert.
 *   Status is derived, never stored. `origin` is the store that wrote the version.
 * - entry_fts: FTS5 trigram index over entries.
 * - tombstone / forgotten_entry / excluded_event: forget operations (Tombstone, with a global
 *   `tmb_` id and the store it came from) and their effects on this store.
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
 * Pre-release: there are no migrations. Every statement is idempotent and runs on each open, so
 * new tables and indexes appear in existing databases; any other change requires a fresh
 * ORIGIN_HOME.
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

CREATE TABLE IF NOT EXISTS session (
  source      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  project     TEXT,
  cwd         TEXT,
  title       TEXT,
  started_at  INTEGER,
  ended_at    INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id)
);

CREATE TABLE IF NOT EXISTS event (
  id            TEXT PRIMARY KEY,
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

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  text,
  content = 'event',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS event_ai AFTER INSERT ON event BEGIN
  INSERT INTO event_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS event_ad AFTER DELETE ON event BEGIN
  INSERT INTO event_fts (event_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS event_au AFTER UPDATE OF text ON event BEGIN
  INSERT INTO event_fts (event_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO event_fts (rowid, text) VALUES (new.rowid, new.text);
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
