-- The schema of Origin 0.1.0 (packages/core/src/schema.ts at v0.1.0), verbatim: store format version 1.
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
