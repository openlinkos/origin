/**
 * The schema of a store in PostgreSQL, beside the one schema.ts creates in SQLite (see
 * docs/architecture.md#storage), and what a PostgreSQL server and database must be for a store.
 *
 * PG_OBJECTS is the latest format (PG_BASE_VERSION, 12, and every version after it): the tables,
 * columns, constraints, and indexes of schema.ts, by the same names, and these differences:
 *
 * - Types: INTEGER is BIGINT, but for the flags session.title_manual and oauth_client.document,
 *   INTEGER with CHECK (0 or 1); REAL is DOUBLE PRECISION; TEXT stays TEXT (`meta` too, so that it
 *   keeps its bytes). No table is WITHOUT ROWID.
 * - Keys: what SQLite assigns as a rowid (an INTEGER PRIMARY KEY left out of an INSERT), a trigger
 *   assigns here, MAX + 1 under the store's write lock (see key()). entry and tombstone, whose
 *   implicit rowid queries read, have a `rowid` column filled the same way.
 * - store_format holds the format version, which SQLite keeps in `PRAGMA user_version`.
 * - Search: GIN indexes over origin_trigrams() instead of event_fts, message_fts, and entry_fts,
 *   and two tables that Origin fills from TypeScript as it inserts an event, as SQLite's triggers
 *   call JavaScript: event_cjk (the CJK tokens of cjk.ts, as an array) and event_prompt (the user
 *   messages that read as a prompt, see prompt.ts). event_block also counts, per block, the events
 *   and messages and their lengths in trigrams, the statistics BM25 needs (see bm25.ts), which
 *   FTS5 keeps itself. No event_message view.
 * - Append-only guards: the same triggers, through one function, origin_append_only(), which a
 *   purge lifts as SQLite's do (guard_lift); TRUNCATE, which skips row triggers, is refused on
 *   every guarded table.
 * - origin_path() and origin_contains() are SQL functions, where SQLite calls JavaScript.
 *   Case is folded by PostgreSQL's builtin pg_c_utf8 collation, which uses Unicode's simple case
 *   mapping: the same as JavaScript's toLowerCase() but for the few characters that lower to more
 *   than one (İ) or by context (final Σ).
 *
 * Each object's SQL is PostgreSQL's own, which Database.exec runs as it is (the translator changes
 * none of it), with the store's schema first on `search_path`; every function fixes that path (SET
 * search_path FROM CURRENT), so it finds the store's tables whoever calls it, and those that index
 * expressions call use pg_catalog's objects alone. An object is created when the store lacks it, and
 * never replaced: changing one needs a migration.
 */

/** An object of a store's schema, by the name it has in the catalog. */
export interface PgObject {
  kind: 'table' | 'index' | 'function' | 'trigger';
  name: string;
  /** The statement that creates it. */
  sql: string;
}

/** The first PostgreSQL release a store may live in (`server_version_num`). */
export const PG_MIN_SERVER_VERSION = 170_000;

/** The command that creates a database a store may live in, for messages. */
export const PG_CREATE_DATABASE =
  "CREATE DATABASE origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';";

/**
 * The high 32 bits of the store's lock key ('ORIG'); the low 32 bits are the oid of the store's
 * schema, so that stores in two schemas of one database never wait for each other.
 */
export const PG_LOCK_TAG = 0x4f524947;

/**
 * What the client needs before it can take the store's write lock, and so creates on connecting
 * when the store lacks it (the rest of the schema is created when the store is opened).
 */
export const PG_CLIENT_OBJECTS: readonly PgObject[] = [
  {
    kind: 'table',
    name: 'store_format',
    sql: `CREATE TABLE store_format (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  version integer NOT NULL,
  store_id text NOT NULL,
  moved_to text
)`,
  },
  {
    kind: 'function',
    name: 'origin_lock_key',
    // SET search_path FROM CURRENT fixes current_schema() to the store's schema, whatever the
    // caller's search_path; the oid is looked up by name, which needs no quoting.
    sql: `CREATE FUNCTION origin_lock_key() RETURNS bigint LANGUAGE sql STABLE
SET search_path FROM CURRENT AS
$$ SELECT (${PG_LOCK_TAG}::bigint << 32) | (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema())::bigint $$`,
  },
];

const table = (name: string, columns: string): PgObject => ({
  kind: 'table',
  name,
  sql: `CREATE TABLE ${name} (${columns}\n)`,
});

/** An index: `on` is what follows its name (`ON table (columns)`, …). */
const index = (name: string, on: string): PgObject => ({
  kind: 'index',
  name,
  sql: `CREATE INDEX ${name} ${on}`,
});

const fn = (name: string, sql: string): PgObject => ({ kind: 'function', name, sql });

const trigger = (name: string, sql: string): PgObject => ({
  kind: 'trigger',
  name,
  sql: `CREATE TRIGGER ${name} ${sql}`,
});

/**
 * The settings of every function below: the store's schema first on search_path, whoever calls it;
 * and plans made once. The queries in these functions run alike whatever values they are given,
 * while Origin's client has its sessions plan each execution afresh (plan_cache_mode), for Origin's
 * own queries: these would then be planned again on every row, which makes a trigger two to three
 * times as slow.
 */
const SETTINGS = 'SET search_path FROM CURRENT SET plan_cache_mode = force_generic_plan';

/**
 * The key `column` of `table`, where an INSERT leaves it out: the next after the greatest, as
 * SQLite assigns a rowid, so keys stay dense and an INSERT that adds nothing (ON CONFLICT DO
 * NOTHING) uses none up. `next` is the expression of that key. Every insert takes the store's write
 * lock first (a transaction that holds it takes it again at no cost), even one from outside Origin,
 * so that two never take the same key, and keys become visible in the order they were taken, which
 * cursors on them (change_log.seq, event.seq) rely on. A function and a trigger, both named
 * `<table>_<column>`.
 */
function key(
  table: string,
  column: string,
  next = `coalesce((SELECT max(${column}) FROM ${table}), 0) + 1`,
): PgObject[] {
  const name = `${table}_${column}`;
  return [
    fn(
      name,
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql
${SETTINGS} AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(origin_lock_key());
  IF NEW.${column} IS NULL THEN
    NEW.${column} := ${next};
  END IF;
  RETURN NEW;
END
$$`,
    ),
    trigger(name, `BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`),
  ];
}

/**
 * The append-only guards of `table`, as schema.ts has them: `<table>_no_update` and
 * `<table>_no_delete` for the operations given, each either lifted while guard_lift names the table
 * (`lift`) or never (`never`), and `<table>_no_truncate`, which nothing lifts.
 */
function appendOnly(
  table: string,
  ops: { update?: 'lift' | 'never'; delete?: 'lift' | 'never' },
): PgObject[] {
  const guards: PgObject[] = [];
  for (const op of ['update', 'delete'] as const) {
    const how = ops[op];
    if (!how) continue;
    guards.push(
      trigger(
        `${table}_no_${op}`,
        `BEFORE ${op.toUpperCase()} ON ${table} FOR EACH ROW EXECUTE FUNCTION origin_append_only(${
          how === 'lift' ? `'${table}'` : ''
        })`,
      ),
    );
  }
  guards.push(
    trigger(
      `${table}_no_truncate`,
      `BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION origin_append_only()`,
    ),
  );
  return guards;
}

/** The functions the tables' triggers and indexes call, and the queries. */
const FUNCTIONS: PgObject[] = [
  // The guard of an append-only table (see appendOnly). A row guard given the name of its table
  // holds unless guard_lift names it, as SQLite's `WHEN NOT EXISTS (SELECT 1 FROM guard_lift ...)`
  // does: only a purge's own transaction adds such a row, and deletes it before it commits.
  fn(
    'origin_append_only',
    `CREATE FUNCTION origin_append_only() RETURNS trigger LANGUAGE plpgsql
${SETTINGS} AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND TG_NARGS = 1
     AND EXISTS (SELECT 1 FROM guard_lift WHERE name = TG_ARGV[0]) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$`,
  ),
  // An entry or tombstone into change_log (the argument is its kind), at the time of the statement
  // in milliseconds, truncated, as SQLite's julianday('now') gives it.
  fn(
    'origin_change',
    `CREATE FUNCTION origin_change() RETURNS trigger LANGUAGE plpgsql
${SETTINGS} AS $$
BEGIN
  INSERT INTO change_log (kind, id, origin, at)
  VALUES (TG_ARGV[0], NEW.id, NEW.origin,
          floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint);
  RETURN NULL;
END
$$`,
  ),
  // The distinct trigrams of a text, case folded, as FTS5's trigram tokenizer emits them: every run
  // of three characters (code points), spaces included; none in a text of fewer than three. Only
  // pg_catalog's objects, as an index expression is computed with a restricted search_path during
  // maintenance (ANALYZE, REINDEX).
  fn(
    'origin_trigrams',
    `CREATE FUNCTION origin_trigrams(t text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE COST 10000
${SETTINGS} AS $$
  SELECT coalesce(array_agg(DISTINCT g), '{}')
  FROM (SELECT c || lead(c) OVER w || lead(c, 2) OVER w AS g
          FROM unnest(string_to_array(lower(t COLLATE pg_catalog.pg_c_utf8), NULL))
            WITH ORDINALITY AS u(c, i)
        WINDOW w AS (ORDER BY i)) AS s
  WHERE g IS NOT NULL
$$`,
  ),
  // comparePath (places.ts): backslashes as slashes, no trailing slash, and the case of a drive or
  // UNC path folded.
  fn(
    'origin_path',
    `CREATE FUNCTION origin_path(p text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
${SETTINGS} AS $$
  SELECT CASE WHEN s ~ '^[A-Za-z]:/' OR left(s, 2) = '//'
           THEN lower(s COLLATE pg_catalog.pg_c_utf8) ELSE s END
  FROM (SELECT regexp_replace(replace(p, E'\\\\', '/'), '/+$', '') AS s) AS t
$$`,
  ),
  // Whether a text contains a term, ignoring case beyond ASCII (which ILIKE under the C locale does
  // not); false for NULL, as SQLite's function gives 0.
  fn(
    'origin_contains',
    `CREATE FUNCTION origin_contains(t text, term text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
${SETTINGS} AS $$
  SELECT coalesce(strpos(lower(t COLLATE pg_catalog.pg_c_utf8),
                         lower(term COLLATE pg_catalog.pg_c_utf8)) > 0, false)
$$`,
  ),
];

/**
 * The blocks of event_block (see schema.ts): the latest timestamp in each block of 4,096 arrivals
 * and up to it, as SQLite's trigger keeps it, and what BM25 reads where FTS5 keeps its own totals:
 * the events (`docs`) and their lengths in trigrams (`tokens`, a text's characters less two, never
 * below zero), and the same for messages alone (message_fts indexes only those). A deleted event
 * leaves the timestamps as they are, as in SQLite, and comes off the counts, as it comes off FTS5's.
 */
const EVENT_BLOCK: PgObject[] = [
  fn(
    'event_block_ai',
    `CREATE FUNCTION event_block_ai() RETURNS trigger LANGUAGE plpgsql
${SETTINGS} AS $$
DECLARE
  b bigint := NEW.seq >> 12;
  d bigint := greatest(char_length(NEW.text) - 2, 0);
  m bigint := (NEW.kind = 'message')::int;
BEGIN
  INSERT INTO event_block AS k (block, max_ts, latest_ts, docs, tokens, message_docs, message_tokens)
  VALUES (b, NEW.ts,
          greatest(NEW.ts, coalesce((SELECT latest_ts FROM event_block WHERE block = b - 1), NEW.ts)),
          1, d, m, m * d)
  ON CONFLICT (block) DO UPDATE SET
    max_ts = greatest(k.max_ts, NEW.ts),
    latest_ts = greatest(k.latest_ts, NEW.ts),
    docs = k.docs + 1,
    tokens = k.tokens + d,
    message_docs = k.message_docs + m,
    message_tokens = k.message_tokens + m * d;
  RETURN NULL;
END
$$`,
  ),
  trigger('event_block_ai', 'AFTER INSERT ON event FOR EACH ROW EXECUTE FUNCTION event_block_ai()'),
  // The counts without a deleted event, or with an updated one's new text and kind instead of its
  // old ones (SQLite's event_au keeps FTS5's totals so).
  fn(
    'event_block_counts',
    `CREATE FUNCTION event_block_counts() RETURNS trigger LANGUAGE plpgsql
${SETTINGS} AS $$
DECLARE
  d bigint := greatest(char_length(OLD.text) - 2, 0);
  m bigint := (OLD.kind = 'message')::int;
BEGIN
  UPDATE event_block SET
    docs = docs - 1,
    tokens = tokens - d,
    message_docs = message_docs - m,
    message_tokens = message_tokens - m * d
  WHERE block = OLD.seq >> 12;
  IF TG_OP = 'UPDATE' THEN
    d := greatest(char_length(NEW.text) - 2, 0);
    m := (NEW.kind = 'message')::int;
    UPDATE event_block SET
      docs = docs + 1,
      tokens = tokens + d,
      message_docs = message_docs + m,
      message_tokens = message_tokens + m * d
    WHERE block = NEW.seq >> 12;
  END IF;
  RETURN NULL;
END
$$`,
  ),
  trigger(
    'event_block_ad',
    'AFTER DELETE ON event FOR EACH ROW EXECUTE FUNCTION event_block_counts()',
  ),
  trigger(
    'event_block_au',
    'AFTER UPDATE OF text, kind ON event FOR EACH ROW EXECUTE FUNCTION event_block_counts()',
  ),
];

/**
 * Every object of a store's schema in PostgreSQL, in an order that creates each after what it
 * needs. Tables in the order of schema.ts, each with its indexes, keys, and triggers.
 */
export const PG_OBJECTS: readonly PgObject[] = [
  ...PG_CLIENT_OBJECTS,
  ...FUNCTIONS,
  table(
    'guard_lift',
    `
  name TEXT PRIMARY KEY`,
  ),
  table(
    'raw_file',
    `
  id             BIGINT PRIMARY KEY,
  source         TEXT   NOT NULL,
  path           TEXT   NOT NULL,
  generation     BIGINT NOT NULL DEFAULT 1,
  mirror         TEXT   NOT NULL,
  bytes_ingested BIGINT NOT NULL DEFAULT 0,
  lines_ingested BIGINT NOT NULL DEFAULT 0,
  tail_hash      TEXT   NOT NULL DEFAULT '',
  first_seen_at  BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  UNIQUE (source, path, generation)`,
  ),
  // ASCII case only, as SQLite's lower(), under the C locale a store's database has.
  index('raw_file_mirror', 'ON raw_file (lower(mirror))'),
  ...key('raw_file', 'id'),
  table(
    'raw_chunk',
    `
  raw_file_id  BIGINT NOT NULL REFERENCES raw_file(id),
  first_line   BIGINT NOT NULL,
  line_count   BIGINT NOT NULL,
  byte_offset  BIGINT NOT NULL,
  byte_length  BIGINT NOT NULL,
  frame_offset BIGINT NOT NULL,
  frame_length BIGINT NOT NULL,
  PRIMARY KEY (raw_file_id, first_line)`,
  ),
  index('raw_chunk_offset', 'ON raw_chunk (raw_file_id, byte_offset)'),
  ...appendOnly('raw_chunk', { update: 'lift', delete: 'lift' }),
  table(
    'session',
    `
  source       TEXT    NOT NULL,
  session_id   TEXT    NOT NULL,
  project      TEXT,
  cwd          TEXT,
  title        TEXT,
  started_at   BIGINT,
  ended_at     BIGINT,
  event_count  BIGINT  NOT NULL DEFAULT 0,
  title_manual INTEGER NOT NULL DEFAULT 0 CHECK (title_manual IN (0, 1)),
  git_branch   TEXT,
  PRIMARY KEY (source, session_id)`,
  ),
  index('session_project', 'ON session (project)'),
  table(
    'project_root',
    `
  device  TEXT   NOT NULL DEFAULT '',
  path    TEXT   NOT NULL,
  project TEXT   NOT NULL,
  root    TEXT   NOT NULL,
  signal  TEXT   NOT NULL,
  seen_at BIGINT NOT NULL,
  PRIMARY KEY (device, path)`,
  ),
  table(
    'session_place',
    `
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project    TEXT NOT NULL,
  root       TEXT,
  signal     TEXT NOT NULL,
  PRIMARY KEY (source, session_id)`,
  ),
  index('session_place_project', 'ON session_place (project)'),
  table(
    'place_head',
    `
  source TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  key    TEXT NOT NULL,
  line   TEXT NOT NULL,
  PRIMARY KEY (source, device, key)`,
  ),
  table(
    'session_follow',
    `
  source            TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  link_id           TEXT NOT NULL,
  target_source     TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  event_id          TEXT PRIMARY KEY`,
  ),
  index('session_follow_from', 'ON session_follow (source, session_id)'),
  index('session_follow_to', 'ON session_follow (target_source, target_session_id)'),
  table(
    'session_thread',
    `
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  PRIMARY KEY (source, session_id)`,
  ),
  index('session_thread_id', 'ON session_thread (thread_id)'),
  table(
    'proposal',
    `
  id         TEXT             PRIMARY KEY,
  source     TEXT             NOT NULL,
  session_id TEXT             NOT NULL,
  event_id   TEXT             NOT NULL,
  kind       TEXT             NOT NULL,
  text       TEXT             NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  project    TEXT,
  valid_from BIGINT,
  valid_to   BIGINT,
  note       TEXT,
  at         BIGINT           NOT NULL`,
  ),
  index('proposal_event', 'ON proposal (event_id)'),
  index('proposal_session', 'ON proposal (source, session_id)'),
  index('proposal_at', 'ON proposal (at)'),
  table(
    'proposal_source',
    `
  proposal_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  quote       TEXT,
  PRIMARY KEY (proposal_id, event_id)`,
  ),
  index('proposal_source_event', 'ON proposal_source (event_id)'),
  table(
    'event',
    `
  seq           BIGINT PRIMARY KEY,
  id            TEXT   NOT NULL UNIQUE,
  source        TEXT   NOT NULL,
  session_id    TEXT   NOT NULL,
  parent_id     TEXT,
  ts            BIGINT NOT NULL,
  project       TEXT,
  cwd           TEXT,
  git_branch    TEXT,
  role          TEXT   NOT NULL,
  kind          TEXT   NOT NULL,
  text          TEXT   NOT NULL,
  raw_file_id   BIGINT NOT NULL REFERENCES raw_file(id),
  raw_line      BIGINT NOT NULL,
  agent_version TEXT,
  meta          TEXT`,
  ),
  index('event_ts', 'ON event (ts)'),
  index('event_session', 'ON event (source, session_id, ts)'),
  index('event_project', 'ON event (project, ts)'),
  index('event_seq_ts', 'ON event (seq, ts)'),
  index(
    'event_user_message',
    "ON event (source, session_id, ts) WHERE role = 'user' AND kind = 'message'",
  ),
  // event_fts and message_fts.
  index('event_grams', 'ON event USING gin (origin_trigrams(text))'),
  index('event_message_grams', "ON event USING gin (origin_trigrams(text)) WHERE kind = 'message'"),
  // After the greatest seq of an event, or of one a purge deleted, so that no number a changes
  // cursor may have passed is given out again (see eventInserter).
  ...key(
    'event',
    'seq',
    'coalesce(greatest((SELECT max(seq) FROM event), (SELECT max(seq_floor) FROM purge)), 0) + 1',
  ),
  ...appendOnly('event', { delete: 'lift' }),
  table(
    'event_author',
    `
  seq     BIGINT PRIMARY KEY,
  author  TEXT   NOT NULL CHECK (author IN ('owner', 'person', 'agent', 'system')),
  speaker TEXT,
  signal  TEXT   NOT NULL`,
  ),
  table(
    'session_kind',
    `
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('child', 'headless')),
  signal     TEXT NOT NULL,
  PRIMARY KEY (source, session_id, kind, signal)`,
  ),
  table(
    'session_parent',
    `
  source            TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  parent_source     TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  via               TEXT NOT NULL CHECK (via IN ('subagent', 'workflow')),
  run_group         TEXT,
  run_name          TEXT,
  signal            TEXT NOT NULL,
  PRIMARY KEY (source, session_id)`,
  ),
  index('session_parent_parent', 'ON session_parent (parent_source, parent_session_id)'),
  table(
    'event_block',
    `
  block          BIGINT PRIMARY KEY,
  max_ts         BIGINT NOT NULL,
  latest_ts      BIGINT NOT NULL,
  docs           BIGINT NOT NULL DEFAULT 0,
  tokens         BIGINT NOT NULL DEFAULT 0,
  message_docs   BIGINT NOT NULL DEFAULT 0,
  message_tokens BIGINT NOT NULL DEFAULT 0`,
  ),
  ...EVENT_BLOCK,
  // event_cjk: the tokens cjkIndexText gives an event (its CJK bigrams and letters, and `msg` for a
  // message), where it gives any. event_prompt: the user messages promptTitle reads as a prompt.
  // Both are filled as the event is inserted, and go with it.
  table(
    'event_cjk',
    `
  seq    BIGINT PRIMARY KEY REFERENCES event(seq) ON DELETE CASCADE,
  tokens TEXT[] NOT NULL`,
  ),
  index('event_cjk_tokens', 'ON event_cjk USING gin (tokens)'),
  table(
    'event_prompt',
    `
  seq BIGINT PRIMARY KEY REFERENCES event(seq) ON DELETE CASCADE`,
  ),
  table(
    'sync_log',
    `
  id            BIGINT PRIMARY KEY,
  source        TEXT   NOT NULL,
  started_at    BIGINT NOT NULL,
  finished_at   BIGINT NOT NULL,
  files_seen    BIGINT NOT NULL,
  files_changed BIGINT NOT NULL,
  lines_read    BIGINT NOT NULL,
  events_added  BIGINT NOT NULL,
  parse_errors  BIGINT NOT NULL,
  note          TEXT`,
  ),
  index('sync_log_finished', 'ON sync_log (finished_at)'),
  index('sync_log_source', 'ON sync_log (source, id)'),
  ...key('sync_log', 'id'),
  table(
    'entry',
    `
  id         TEXT             PRIMARY KEY,
  kind       TEXT             NOT NULL CHECK (kind IN ('memory', 'knowledge', 'cognition')),
  text       TEXT             NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  author     TEXT             NOT NULL,
  project    TEXT,
  supersedes TEXT             REFERENCES entry(id),
  root       TEXT             NOT NULL,
  valid_from BIGINT,
  valid_to   BIGINT,
  created_at BIGINT           NOT NULL,
  origin     TEXT             NOT NULL,
  rowid      BIGINT           NOT NULL UNIQUE`,
  ),
  index('entry_created', 'ON entry (created_at)'),
  index('entry_supersedes', 'ON entry (supersedes)'),
  index('entry_root', 'ON entry (root, created_at, id)'),
  // entry_fts.
  index('entry_grams', 'ON entry USING gin (origin_trigrams(text))'),
  ...key('entry', 'rowid'),
  ...appendOnly('entry', { update: 'never', delete: 'lift' }),
  table(
    'entry_source',
    `
  entry_id TEXT NOT NULL REFERENCES entry(id),
  event_id TEXT NOT NULL REFERENCES event(id),
  quote    TEXT,
  PRIMARY KEY (entry_id, event_id)`,
  ),
  index('entry_source_event', 'ON entry_source (event_id)'),
  ...appendOnly('entry_source', { delete: 'lift' }),
  table(
    'imported_entry',
    `
  entry_id TEXT PRIMARY KEY REFERENCES entry(id)`,
  ),
  ...appendOnly('imported_entry', { delete: 'lift' }),
  table(
    'tombstone',
    `
  id         TEXT   PRIMARY KEY,
  target     TEXT   NOT NULL,
  reason     TEXT,
  created_at BIGINT NOT NULL,
  origin     TEXT   NOT NULL,
  rowid      BIGINT NOT NULL UNIQUE`,
  ),
  ...key('tombstone', 'rowid'),
  ...appendOnly('tombstone', { update: 'never', delete: 'never' }),
  table(
    'forgotten_entry',
    `
  entry_id     TEXT PRIMARY KEY REFERENCES entry(id),
  tombstone_id TEXT NOT NULL REFERENCES tombstone(id)`,
  ),
  index('forgotten_entry_tombstone', 'ON forgotten_entry (tombstone_id)'),
  table(
    'excluded_event',
    `
  event_id     TEXT PRIMARY KEY REFERENCES event(id),
  tombstone_id TEXT NOT NULL REFERENCES tombstone(id)`,
  ),
  index('excluded_event_tombstone', 'ON excluded_event (tombstone_id)'),
  index('tombstone_target', 'ON tombstone (target)'),
  table(
    'tombstone_effect',
    `
  tombstone_id TEXT NOT NULL REFERENCES tombstone(id),
  kind         TEXT NOT NULL CHECK (kind IN ('entry', 'event')),
  item         TEXT NOT NULL,
  how          TEXT NOT NULL CHECK (how IN ('direct', 'listed', 'reported', 'cascade')),
  PRIMARY KEY (tombstone_id, kind, item, how)`,
  ),
  index('tombstone_effect_item', 'ON tombstone_effect (item, kind)'),
  table(
    'tombstone_meta',
    `
  tombstone_id TEXT PRIMARY KEY REFERENCES tombstone(id),
  author       TEXT`,
  ),
  table(
    'change_log',
    `
  seq    BIGINT PRIMARY KEY,
  kind   TEXT   NOT NULL CHECK (kind IN ('entry', 'tombstone')),
  id     TEXT   NOT NULL,
  origin TEXT   NOT NULL,
  at     BIGINT NOT NULL`,
  ),
  index('change_log_kind', 'ON change_log (kind, seq)'),
  index('change_log_id', 'ON change_log (id)'),
  ...key('change_log', 'seq'),
  trigger(
    'entry_change',
    "AFTER INSERT ON entry FOR EACH ROW EXECUTE FUNCTION origin_change('entry')",
  ),
  trigger(
    'tombstone_change',
    "AFTER INSERT ON tombstone FOR EACH ROW EXECUTE FUNCTION origin_change('tombstone')",
  ),
  ...appendOnly('change_log', { update: 'never', delete: 'never' }),
  table(
    'recall',
    `
  seq         BIGINT PRIMARY KEY,
  id          TEXT   NOT NULL UNIQUE,
  at          BIGINT NOT NULL,
  origin      TEXT   NOT NULL,
  source      TEXT,
  session_id  TEXT,
  occasion    TEXT   NOT NULL CHECK (occasion IN ('start', 'prompt', 'request')),
  project     TEXT,
  cwd         TEXT,
  prompt_hash TEXT,
  budget      BIGINT NOT NULL,
  tokens      BIGINT NOT NULL`,
  ),
  index('recall_at', 'ON recall (at)'),
  index('recall_session', 'ON recall (source, session_id, seq)'),
  ...key('recall', 'seq'),
  table(
    'recall_item',
    `
  recall_id TEXT             NOT NULL REFERENCES recall(id),
  rank      BIGINT           NOT NULL,
  layer     TEXT             NOT NULL CHECK (layer IN ('cognition', 'project', 'sessions', 'prompt', 'messages')),
  kind      TEXT             NOT NULL CHECK (kind IN ('entry', 'session', 'thread', 'event')),
  ref       TEXT             NOT NULL,
  score     DOUBLE PRECISION,
  tokens    BIGINT           NOT NULL,
  excerpt   BIGINT           CHECK (excerpt IS NULL OR (kind = 'event' AND excerpt >= 0)),
  PRIMARY KEY (recall_id, rank)`,
  ),
  index('recall_item_ref', 'ON recall_item (ref)'),
  ...appendOnly('recall', { update: 'never', delete: 'lift' }),
  ...appendOnly('recall_item', { update: 'never', delete: 'lift' }),
  table(
    'purge',
    `
  seq         BIGINT PRIMARY KEY,
  id          TEXT   NOT NULL UNIQUE,
  at          BIGINT NOT NULL,
  origin      TEXT   NOT NULL,
  author      TEXT   NOT NULL,
  channel     TEXT   NOT NULL CHECK (channel IN ('cli', 'ui', 'api', 'hub')),
  reason      TEXT   NOT NULL CHECK (length(trim(reason)) > 0),
  selector    TEXT   NOT NULL,
  counts      TEXT   NOT NULL,
  touched     TEXT   NOT NULL DEFAULT '{}',
  seq_floor   BIGINT,
  received_at BIGINT`,
  ),
  ...key('purge', 'seq'),
  table(
    'purged',
    `
  kind     TEXT NOT NULL CHECK (kind IN ('event', 'entry', 'session', 'recall', 'file')),
  scope    TEXT NOT NULL DEFAULT '',
  id       TEXT NOT NULL,
  purge_id TEXT NOT NULL REFERENCES purge(id),
  PRIMARY KEY (kind, scope, id)`,
  ),
  index('purged_purge', 'ON purged (purge_id)'),
  table(
    'purge_line',
    `
  raw_file_id BIGINT NOT NULL REFERENCES raw_file(id),
  first_line  BIGINT NOT NULL,
  line_count  BIGINT NOT NULL CHECK (line_count > 0),
  purge_id    TEXT   NOT NULL REFERENCES purge(id),
  PRIMARY KEY (raw_file_id, first_line, purge_id)`,
  ),
  index('purge_line_purge', 'ON purge_line (purge_id)'),
  table(
    'purge_pending',
    `
  raw_file_id BIGINT PRIMARY KEY REFERENCES raw_file(id),
  since       BIGINT NOT NULL,
  attempts    BIGINT NOT NULL DEFAULT 0,
  error       TEXT`,
  ),
  ...appendOnly('purge', { update: 'never', delete: 'never' }),
  ...appendOnly('purged', { update: 'never', delete: 'never' }),
  ...appendOnly('purge_line', { update: 'never', delete: 'never' }),
  table(
    'api_token',
    `
  name         TEXT   PRIMARY KEY,
  hash         TEXT   NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at   BIGINT,
  kind         TEXT   NOT NULL DEFAULT 'device' CHECK (kind IN ('device', 'agent')),
  preset       TEXT   NOT NULL DEFAULT 'readwrite' CHECK (preset IN ('readwrite', 'readonly'))`,
  ),
  table(
    'oauth_client',
    `
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  uri           TEXT,
  redirect_uris TEXT    NOT NULL,
  document      INTEGER NOT NULL DEFAULT 0 CHECK (document IN (0, 1)),
  created_at    BIGINT  NOT NULL,
  expires_at    BIGINT`,
  ),
  table(
    'oauth_code',
    `
  hash         TEXT   PRIMARY KEY,
  client_id    TEXT   NOT NULL,
  client_name  TEXT   NOT NULL,
  redirect_uri TEXT   NOT NULL,
  challenge    TEXT   NOT NULL,
  preset       TEXT   NOT NULL CHECK (preset IN ('readwrite', 'readonly')),
  scope        TEXT   NOT NULL,
  resource     TEXT   NOT NULL,
  days         BIGINT NOT NULL,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  used_at      BIGINT,
  grant_id     TEXT`,
  ),
  table(
    'oauth_grant',
    `
  id           TEXT   PRIMARY KEY,
  name         TEXT   NOT NULL,
  client_id    TEXT   NOT NULL,
  client_name  TEXT   NOT NULL,
  preset       TEXT   NOT NULL CHECK (preset IN ('readwrite', 'readonly')),
  scope        TEXT   NOT NULL,
  resource     TEXT   NOT NULL,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at   BIGINT,
  revoked_by   TEXT`,
  ),
  index('oauth_grant_name', 'ON oauth_grant (name)'),
  table(
    'oauth_token',
    `
  hash       TEXT   PRIMARY KEY,
  grant_id   TEXT   NOT NULL,
  kind       TEXT   NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT`,
  ),
  index('oauth_token_grant', 'ON oauth_token (grant_id)'),
  table(
    'device_request',
    `
  hash       TEXT   PRIMARY KEY,
  user_code  TEXT   NOT NULL UNIQUE,
  device     TEXT   NOT NULL,
  ip         TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  interval_s BIGINT NOT NULL,
  polled_at  BIGINT,
  status     TEXT   NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'done')),
  decided_at BIGINT`,
  ),
  table(
    'setting',
    `
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL`,
  ),
  table(
    'admin_session',
    `
  id_hash      TEXT   PRIMARY KEY,
  key_name     TEXT   NOT NULL,
  csrf         TEXT   NOT NULL,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  fresh_at     BIGINT NOT NULL,
  ended_at     BIGINT,
  ip           TEXT,
  user_agent   TEXT`,
  ),
  table(
    'audit_log',
    `
  id         BIGINT PRIMARY KEY,
  at         BIGINT NOT NULL,
  actor      TEXT   NOT NULL,
  channel    TEXT   NOT NULL CHECK (channel IN ('ui', 'cli', 'api')),
  action     TEXT   NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT`,
  ),
  ...key('audit_log', 'id'),
  ...appendOnly('audit_log', { update: 'never', delete: 'never' }),
];

/**
 * The objects a schema has, as rows of `kind` and `name`: its tables, indexes, functions, and
 * triggers (not those PostgreSQL makes for constraints). `schema` is the SQL of its name.
 */
function presentSql(schema: string): string {
  return `WITH s AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ${schema})
SELECT CASE WHEN c.relkind = 'i' THEN 'index' ELSE 'table' END AS kind, c.relname AS name
  FROM pg_catalog.pg_class c JOIN s ON c.relnamespace = s.oid WHERE c.relkind IN ('r', 'p', 'i')
UNION ALL
SELECT 'function', p.proname FROM pg_catalog.pg_proc p JOIN s ON p.pronamespace = s.oid
UNION ALL
SELECT 'trigger', t.tgname FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN s ON c.relnamespace = s.oid
  WHERE NOT t.tgisinternal`;
}

/** The objects of the schema named `$1`, for the client (see presentSql). */
export const PG_PRESENT_SQL = presentSql('$1');

/**
 * The objects of the store's schema, the first on search_path, as Database.prepare takes it (see
 * presentSql).
 */
export const PG_PRESENT_HERE_SQL = presentSql('current_schema()');

/** Of `objects`, those that `present` (rows of PG_PRESENT_SQL) lacks, in order. */
export function missingObjects(
  present: ReadonlyArray<{ kind: string; name: string }>,
  objects: readonly PgObject[] = PG_OBJECTS,
): PgObject[] {
  const have = new Set(present.map((o) => `${o.kind} ${o.name}`));
  return objects.filter((o) => !have.has(`${o.kind} ${o.name}`));
}

/**
 * The server and the database, as preflightProblem reads them: one row. `datlocale` is read through
 * to_jsonb, so that the query runs on any release and an old one is refused by its version.
 */
export const PG_PREFLIGHT_SQL = `SELECT current_setting('server_version_num')::integer AS version,
  current_setting('server_version') AS release,
  d.datname AS database, pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
  d.datlocprovider::text AS provider, d.datcollate AS collate, d.datctype AS ctype,
  pg_catalog.to_jsonb(d) ->> 'datlocale' AS locale
FROM pg_catalog.pg_database d WHERE d.datname = current_database()`;

/** A row of PG_PREFLIGHT_SQL. */
export interface PgPreflight {
  version: number;
  release: string;
  database: string;
  encoding: string;
  /** `c` (libc), `i` (ICU), or `b` (builtin). */
  provider: string;
  collate: string;
  ctype: string;
  locale: string | null;
}

const C_LOCALES = new Set(['C', 'POSIX']);

/**
 * Why a store may not live in this database, or null if it may. PostgreSQL 17 or later, and a UTF8
 * database whose collation and character classes are C: SQLite's lower() and LIKE fold ASCII only,
 * and so must PostgreSQL's, for every value whatever its collation (literals and parameters take
 * the database's). C.UTF-8 folds beyond ASCII, so it is refused too.
 */
export function preflightProblem(p: PgPreflight): string | null {
  if (p.version < PG_MIN_SERVER_VERSION) {
    return `Origin needs PostgreSQL 17 or later; this server runs ${p.release}.`;
  }
  const libc = p.provider === 'c' && C_LOCALES.has(p.collate) && C_LOCALES.has(p.ctype);
  const builtin = p.provider === 'b' && p.locale === 'C';
  if (p.encoding === 'UTF8' && (libc || builtin)) return null;
  const locale = p.provider === 'c' ? `${p.collate}/${p.ctype}` : `${p.locale ?? '?'}`;
  const provider = { c: 'libc', i: 'ICU', b: 'builtin' }[p.provider] ?? p.provider;
  return `The database ${p.database} has encoding ${p.encoding} and locale ${locale} (${provider}); a store needs a UTF8 database whose locale is C. Create one with: ${PG_CREATE_DATABASE}`;
}
