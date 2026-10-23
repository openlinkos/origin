# Architecture

This document describes Origin's current design: the problem it targets, the data model, the invariants every change must preserve, and how ingestion, entries, search, the MCP server, and the personal hub work. It is the reference for contributors; if a change alters the data model, an invariant, or a public interface, update this document in the same commit.

## Contents

- [Problem](#problem)
- [Scope](#scope)
- [Memory, knowledge, and cognition](#memory-knowledge-and-cognition)
- [Core objects](#core-objects)
- [Data flow](#data-flow)
- [Invariants](#invariants)
- [Design principles](#design-principles)
- [Packages](#packages)
- [Storage](#storage)
- [Ingestion](#ingestion)
- [Entries](#entries)
- [Forgetting](#forgetting)
- [Search and timeline](#search-and-timeline)
- [MCP server](#mcp-server)
- [Personal hub](#personal-hub)
- [Open questions](#open-questions)
- [Prior art](#prior-art)

## Problem

Developers increasingly work across several AI agents at once — Claude Code, Codex, Cursor, ZCode, Grok Build. Each agent keeps its own memory, scoped to a repository, a machine, or a cloud account. Switching tools or projects means starting from zero. That memory is hard to inspect, hard to correct, invisible to other agents, and often silently purged (Claude Code, for example, deletes local session logs after 30 days by default).

At the same time, every one of these agents writes plain, parseable session logs to the local disk, and every one of them can talk to a local [MCP](https://modelcontextprotocol.io) server. Origin builds on both facts: it archives all local agent sessions into a single local store and makes that store available to every agent through one MCP server.

The long-term direction is an AI that accompanies one person over time, where memory, knowledge, and an understanding of the person persist across tools and model generations. Origin starts with that core.

## Scope

**Current goal — a cross-agent personal memory over MCP:**

- Archive local sessions from Claude Code, Codex, Cursor, ZCode, and Grok Build into one append-only store.
- Let any agent search the archive, walk the timeline, expand any answer to its original source, and record durable entries (memory / knowledge / cognition) via MCP.
- Let the person inspect, correct, and forget entries via the `origin` CLI, or the admin UI of their hub; forgetting must stick.
- One person often runs agents on several machines (laptops, servers, cloud agents). Every device keeps a complete memory of its own; an optional, self-hosted **personal hub** gathers what every device writes into one store, so that agents anywhere can find it.

The goal is reached when, from any connected agent on any of your machines, you can ask "what did I decide in project X last week, and why?" and get an answer with sources, and a forgotten entry never comes back.

**Explicit non-goals for now:** multi-tenant hosting (Origin is for one person; everyone runs their own), a hosted service run by the project, end-to-end encryption, devices pulling each other's data, peer-to-peer sync without a hub, real-time collaboration, any web interface beyond the owner's admin UI on their own hub (no public pages, no sharing, no multiple accounts), screen/email/browser capture, knowledge graphs, vector search, proactive reminders, and any call to a model API.

## Memory, knowledge, and cognition

Origin distinguishes three kinds of durable entries. Every entry carries its sources and can be corrected or forgotten.

| Kind | Meaning | Example |
|---|---|---|
| `memory` | What happened (episodic) | "On Oct 20 we dropped schema versioning until the first release, to keep the code simple." |
| `knowledge` | Stable facts and relations | "Project A depends on library B." |
| `cognition` | A model of the person: preferences, methods, goals, boundaries | "Prefers commit messages without attribution trailers." |

## Core objects

| Object | Meaning | Key fields |
|---|---|---|
| **Source** | An adapter for one agent: `claude-code`, `codex`, `cursor`, `zcode`, `grok` | id, agent version, discovery root |
| **Raw** | Append-only mirror of an original log file, stored in zstd frames | source, original path, generation, byte/line cursor, tail hash, sealed frames |
| **Event** | A normalized conversation event: user message, assistant message, tool call, tool result | id, source, session, timestamp, project, cwd, git branch, role, kind, text, raw locator |
| **Entry** | A durable `memory` / `knowledge` / `cognition` statement | id (`ent_…`), kind, text, confidence, author, project, sources (event ids + quotes), supersedes, root (its first version), valid_from / valid_to, created_at, origin (the store that wrote it); status (`active` / `superseded` / `forgotten`) is derived, never stored |
| **Tombstone** | Record of a forget operation | id (`tmb_…`), target id, reason, time, origin (the store that created it); the entries it forgot and the events it excluded on each store |

## Data flow

```
agent session logs on disk ──scan──▶ Raw (append-only mirror)
                                        │ deterministic adapter parsing (no LLM)
                                        ▼
                                  Event store (SQLite + FTS5) ◀── Entries · Tombstones
                                        │
 agents ◀── MCP (stdio): search · timeline · get · sources · remember · correct · forget
 people ◀── CLI `origin`: sync · status · timeline · search · show · entries · correct · forget
 people ◀── admin UI (hub, /admin): overview · timeline · search · entries · remember · correct · forget · tokens
```

With a personal hub, every device keeps a complete store of its own and stays usable offline. It sends the hub its raw mirrors, which the hub parses with the same adapters, and the entries and tombstones it writes; it receives only tombstones. Agents on a device use its local `origin mcp`, which answers from the device's store and merges in the hub's answers; cloud agents use the hub's HTTP endpoint:

```
agents on A ──▶ origin mcp ──▶ store A ──raw mirrors · entries · tombstones──▶ ┐
                    │             ▲                                             │
                    │             └──────────────── tombstones ─────────────────┤
                    └──────── reads, merged (MCP over HTTP) ───────────────────▶ hub store ◀── MCP over HTTP ── cloud agents
agents on B ──▶ origin mcp ──▶ store B ── (as for device A) ───────────────────▶ ┘
```

## Invariants

These are product guarantees. Each must be covered by tests, and code comments refer to them by number.

1. **Provenance.** Every Entry cites at least one Event; every Event points to a Raw file and line. Any answer can be expanded down to the original text.
2. **Sticky forgetting.** After `forget`, an entry leaves every query on that store immediately, and its source events join an exclusion set that no later write can resurrect. Tombstones reach every store and only accumulate: what was forgotten stays forgotten wherever it arrives, including versions and copies that arrive later, and nothing un-forgets.
3. **Append-only.** Raw mirrors and Events are never rewritten: the content of a mirror, its uncompressed bytes, only grows, and a line once ingested never changes, however it is stored (see [Raw mirrors](#raw-mirrors)). Entries change by supersession (`supersedes`), never in place.
4. **Your data, your machines.** All data lives on machines you control: your devices under `~/.origin/` and, optionally, your own hub. Origin never calls a third-party service; the only network traffic is between your devices and your hub.
5. **Single entry point.** Every read and write goes through the same core operations, whichever interface it comes from: agents use MCP (their device's `origin mcp`, or the hub's HTTP endpoint); people use the CLI or the admin UI of their hub. A write lands in the store where it is made, on a device its own store first, and replication applies it to other stores through the same operations. The hub's replication API carries raw mirrors, entries, and tombstones between your own stores and is not an entry point for agents or people.

## Design principles

- **No LLM in the core.** Origin never calls a model API. It archives, normalizes, indexes, and stores. Analysis happens in the agent that is asking — it is already a capable model. Agents persist what they learn through MCP `remember`; people correct and forget through the CLI or the admin UI. If periodic consolidation is ever needed, it will run as a headless coding-agent task (for example `claude -p`), not as a direct model API integration. This is the current position and can be revisited if evaluation shows it falls short, especially for the cognition layer.
- **Deterministic, tolerant adapters.** Each source has a pure, deterministic parser. Agent log formats change frequently, so adapters record the agent version, skip lines they cannot parse, count the failures, and never abort ingestion.
- **MCP as the interoperability point.** MCP is the only interface all target agents share. Several of them also read Claude Code's MCP configuration, so one registration can reach more than one agent.
- **A small, conservative admin UI.** The hub's admin UI is for its owner only. Pages are rendered on the server with a template that escapes every value, plus a little optional script. Its stylesheet, fonts, and icons come from the OpenLinkOS design system (`@openlinkos/ui`) and are copied into the package when it is built; nothing is loaded from elsewhere, and there is no bundler. It can do what the CLI can, and nothing that would break an invariant: no editing in place, no un-forgetting, no forgotten text on screen.
- **Small, runnable increments.** Each source adapter ships and is used on its own; the design only goes as deep as the current increment needs.

## Packages

pnpm workspace, TypeScript (strict, ESM, NodeNext), Node.js ≥ 22.16 (for zstd in `node:zlib` and the online backup of `node:sqlite`). `core`, `adapters`, and `admin` use only Node built-ins; `mcp` depends on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and zod. The hub and its admin UI use Node's built-in `node:http`.

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@openlinkos/origin-core` | `packages/core` | Storage, schema, ingestion (local and remote), entries, forgetting, tokens, the admin password and sessions, the audit log, queries | — |
| `@openlinkos/origin-adapters` | `packages/adapters` | One deterministic parser per source | core |
| `@openlinkos/origin-mcp` | `packages/mcp` | MCP tools; servers over stdio and stateless HTTP, and the server of a device connected to a hub, which merges the hub's answers into its own | core |
| `@openlinkos/origin-admin` | `packages/admin` | The hub's admin UI: server-rendered pages, a JSON API, and its static assets | core |
| `@openlinkos/origin` | `packages/cli` | The `origin` command, including `origin mcp`, `origin serve` (the hub), and a device's sync with its hub | core, adapters, mcp, admin |

All five packages are published to npm together under one version; people install `@openlinkos/origin`, which brings the others along. Before 1.0 the other four are internal: their APIs may change in any release.

`core` must not depend on any other package, and neither `mcp` nor `admin` may depend on `adapters`: the CLI injects ingestion into the servers as callbacks, and the hub's HTTP server lives in the CLI, which mounts the admin UI's request handler. Adapters implement the `SourceAdapter` interface from `core`:

```ts
interface SourceAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'zcode' | 'grok'
  displayName: string;
  version(): string | null; // agent version, if known
  discover(): Promise<SourceFile[]>; // { absPath, relPath, compression?: 'zstd' }
  parseLine(line: string, ctx: ParseContext): ParsedLine | null; // deterministic; throws on malformed input
}
// ctx: { absPath, relPath, lineNo, fileMtimeMs, readLine(n) }; readLine returns an earlier line of
// the same file as ingested, for an adapter that needs, say, a file's first line on a hub.
```

## Storage

```
~/.origin/                 # or $ORIGIN_HOME
├── origin.db              # SQLite (WAL)
└── raw/<source>/...       # append-only mirrors of the original log files:
                           #   <mirror>.zst (sealed zstd frames) and <mirror>.tail (open tail)
```

| Table | Contents |
|---|---|
| `raw_file` | One row per mirrored file generation, with its ingestion cursor |
| `raw_chunk` | The sealed frames of each mirror: first line, line count, offset and length in the content and in the `.zst` file. Triggers reject updates and deletes |
| `event` | Normalized events, keyed by their order of arrival in this store (`seq`) |
| `event_block` | For each block of 4,096 consecutive arrivals, the latest timestamp in it and up to it (derived, kept by a trigger) |
| `message_fts`, `event_fts`, `event_cjk` | The search indexes over events: a full trigram index of `message` events, a trigram index of every event that records only which events contain each trigram, and an index of CJK bigrams (see [Search and timeline](#search-and-timeline)) |
| `session` | Per-session aggregates over visible events (derived, rebuildable) |
| `sync_log` | One row per sync run |
| `entry`, `entry_source`, `entry_fts` | Entries, the events they cite (with quotes), and their FTS5 index. Each version records its `root` (the first version, fixed when it is written) and its `origin` |
| `tombstone`, `forgotten_entry`, `excluded_event` | Forget operations, each with a global id (`tmb_` and random hex, like `ent_` ids) and its `origin`, and their effects on this store |
| `change_log` | Append-only sequence of the entries and tombstones this store has written or received (sequence number, kind, id, origin, time), filled by triggers; triggers reject updates and deletes. Replication cursors point into it |
| `api_token` | Hub access tokens: name (for a device, the device's name) and SHA-256 hash, never the token itself |
| `setting` | Small key-value state, local to each store and never replicated: the store's name, a device's replication cursors, and on a hub the scrypt hash of the admin password |
| `admin_session` | Admin UI sessions: a hash of the session id, its CSRF token, and its timestamps |
| `audit_log` | Append-only record of administrative actions, with ids and counts but never content; triggers reject updates and deletes |

- Storage uses Node's built-in `node:sqlite`, so there are no native modules to compile. Several processes may share the database (the CLI and one MCP server per agent session); WAL mode and a busy timeout handle this.
- `session` is derived and can be rebuilt from `event`; per-source totals (`origin status`, the admin overview) are read from it. The search indexes are derived too and kept in sync by triggers: `message_fts` and `event_fts` are external-content tables (the content of `message_fts` is the `event_message` view of message events), and `event_cjk` is contentless, filled through a function that the core registers on every connection. `rebuildSearchIndexes()` rebuilds them all, and `event_block`, from the events and entries.
- **Arrival order.** Events, and the search indexes with them, are keyed by `seq`, their order of arrival in this store: FTS5 stores the differences between consecutive keys, so dense keys keep the indexes small. A sync ingests the files it finds oldest first, by modification time, and a device pushes its files to its hub in the order it last updated them, so arrival order follows time as far as possible; but it is not time order, since a hub, for example, may receive a device's old sessions long after newer ones. So a trigger records, for each block of 4,096 consecutive arrivals, the latest timestamp in it and up to it (`event_block`). A newest-first query reads its index latest arrival first, in a few chains of consecutive blocks (a block more than a day newer than the chain before it starts a new one), always from the chain whose unread part may hold the newest event, and stops as soon as no chain may hold one newer than those it needs. A narrow `(seq, ts)` index gives an event's timestamp without reading the event.
- **Size.** On a store of two million events averaging about 800 characters of text, the database takes about 2,550 bytes per event: 1,360 for the event itself, 205 for its indexes, 500 for `event_fts`, 460 for `message_fts`, and 20 for `event_cjk`. A full trigram index of every event would take about 2,350 bytes per event on its own.
- **Backups.** `origin backup <dir>` copies the database with SQLite's online backup in one step, a consistent snapshot even while other processes write, and then the raw mirrors as that snapshot records them: the sealed frames the directory does not have yet, and each open tail, extended, or written again if frames were sealed from it since. A tail is read from the live store, where it may have been sealed meanwhile; a mirror's content only grows, so it is the same (see [Backing up](guide/privacy.md#backing-up)).
- **Store names.** Every store has a name, kept in `setting`: on a device it is the device's name, and a hub calls its store `hub`. Entries and tombstones record the name of the store that wrote them as their `origin`, and a device is known to its hub by its store's name. A store is named the first time it needs a name: `origin serve` names it `hub`; other commands use `ORIGIN_DEVICE` or the host name. Once a store has written an entry or a tombstone, it keeps its name.
- **No migrations before the first release.** The schema is one set of idempotent statements applied every time the database is opened, so added tables and indexes appear in existing databases automatically. Any other schema change is made in place and needs a fresh `ORIGIN_HOME`. Delete the whole directory, never just `origin.db`: the mirrors under `raw/` are only meaningful with the database that records them. Versioned migrations will arrive with the first release.

### Raw mirrors

A mirror holds the ingested bytes of one generation of a file: its *content*, complete lines only. It is stored compressed, in two files named after it:

- `<mirror>.zst`: the **sealed frames**, independent zstd frames (level 3, with checksums), each holding complete lines, appended one after another. `raw_chunk` records each frame: its first line, its line count, its offset and length in the content, and its offset and length in the file. Reading a line decompresses only the frame that holds it.
- `<mirror>.tail`: the **open tail**, the newest lines, uncompressed.

The content is the frames, decompressed, followed by the tail, each up to what the database records (`raw_chunk` for the frames, `raw_file.bytes_ingested` for the end); every read and write of `raw/` goes through one module (`mirror.ts` in `core`). Line numbers, cursors, rewrite generations, tail hashes, and event ids are all in terms of the content, as for a plain copy of the file.

- **Sealing.** New lines are appended to the tail while it stays under 1 MiB. The append that would bring it to 1 MiB or more seals the tail and the new lines instead: they are cut into frames, each ending at the first line break once it holds 1 MiB (a longer line fills a frame of its own, and a last piece under half a MiB joins the frame before it), the frames are appended to `<mirror>.zst` and flushed to disk, and `raw_chunk` records them in the transaction that advances the cursor. Once that transaction has committed and the write-ahead log has been flushed, a short transaction empties the tail. A file that has not grown for an hour is likely finished, so its tail is sealed too, whatever its size, by the next sync of its source on a device and by a check every 10 minutes on a hub; lines appended later start a new tail.
- **What append-only means here.** The content only grows, and the bytes of a line never change (invariant 3). On disk, `<mirror>.zst` only grows and its frames are never rewritten (`raw_chunk` rejects updates and deletes); `<mirror>.tail` is only appended to, except that it is emptied once its lines are in frames. Sealing moves lines from the tail into a frame without changing the content.
- **Crash safety.** Bytes in either file past what the database records are not part of the mirror: readers never read them, and the next write to the mirror drops them before appending. A crash after a frame is written but before its transaction commits leaves a frame that nothing records; it is dropped, and the lines, still in the tail, are sealed again. A crash after the commit but before the tail is emptied leaves lines in the tail that are also in a frame; the database says the tail is empty, so they are ignored and then dropped. Neither loses or doubles a line. A file shorter than the database records has lost data, and Origin refuses to append to that mirror rather than break provenance (invariant 1). A reader that finds the tail emptied by a concurrent seal in another process reads again.
- **Size.** On 171 MiB of synthetic Claude Code logs shaped like real ones (large tool results, base64 screenshots for about a quarter of the bytes, Chinese and English text), the mirrors take 35 MiB once their files have stopped growing (4.9×; 52 MiB right after an import, while every file still has an open tail). Ingesting takes about 15% longer, and reading a random raw line takes 1.5 ms on average, against 6.8 ms to scan a whole plain mirror.

## Ingestion

`origin sync` (and the MCP server, see below) runs every adapter's `discover()`. A file whose size and tail have not changed since its last ingestion is skipped without taking the write lock. The new lines of a changed file are ingested in `BEGIN IMMEDIATE` transactions of at most 1 MiB of lines each (a longer line takes a transaction of its own), so concurrent syncs from different processes are serialized and never ingest the same bytes twice, and no process holds the write lock for long, even while it imports a large backlog:

1. **Cursor.** Each `raw_file` row tracks `bytes_ingested`, `lines_ingested`, and `tail_hash` (SHA-256 of the last 4 KB ingested). The cursor is read under the write lock, and only bytes after it are read.
2. **Rewrite detection.** If the file shrank or its tail no longer matches, it was rewritten rather than appended. Origin opens a new *generation* with a fresh mirror and keeps the old mirror intact (invariant 3).
3. **Complete lines only.** Bytes up to the last newline are appended to the mirror (see [Raw mirrors](#raw-mirrors)); a trailing partial line waits for the next sync. A mirror's content always equals the ingested bytes of its generation, so bytes left past the cursor by an interrupted sync are dropped before appending (invariant 1).
4. **Parse and insert.** Each line goes through `parseLine`; failures are counted, not fatal. Events are inserted with `INSERT OR IGNORE` under the id `<source>:<native-id>[#<block-index>]`, which makes sync idempotent (invariant 3). Each event stores its mirror file and line number (invariant 1).
5. **Bookkeeping.** Affected sessions are re-aggregated, the cursor advances in the same transaction, and a `sync_log` row records the sync.

**Compressed sources.** An adapter can mark a file as `compression: 'zstd'`. Origin then ingests and mirrors the decompressed content, using Node's built-in zstd, so cursors, line numbers, and raw lines work as for plain files. Compressed files are written once, so they are skipped when unchanged since their last ingestion, and each is ingested in a single transaction.

**Several processes.** The CLI and one MCP server per agent session may use the same store at once. Readers never wait for writers (WAL). A writer waits up to 10 seconds for the write lock (the busy timeout); since syncs take the lock only for changed files and only for one bounded transaction at a time, a sync or a `remember` waits at most about one such transaction, even while another process imports a large backlog. After each checkpoint, the write-ahead log is truncated to 64 MiB (`journal_size_limit`), so a large import does not leave a log of gigabytes behind.

### Claude Code mapping

- Files: `<projects>/<cwd-slug>/<session-id>.jsonl`, plus sub-agent logs under `<session-id>/subagents/`. The `memory/` and `tool-results/` directories are skipped.
- `user` / `assistant` lines become events. Text blocks are joined into one `message` event; each `tool_use` and `tool_result` block becomes its own event (truncated to 2,000 / 4,000 characters). `isMeta` lines become `meta` events. `thinking` blocks are not indexed but remain in the raw mirror.
- `summary` lines set the session title.
- The project name is the last segment of `cwd`.

The other adapters' mappings are documented next to their formats in [sources.md](sources.md) (Codex: [Codex CLI](sources.md#codex-cli)).

## Entries

- **Remember.** An entry is one self-contained statement with a kind, a confidence between 0 and 1, an author (`<agent>@<device>`: the MCP client's name and the name of the store it writes to, such as `claude-code@laptop`, or `user@<device>` for the CLI and the admin UI; see [Access](#access) for agents that use a hub directly), an optional project and validity range, and at least one source (invariant 1). A source is an event id, an exact quote, or both:
  - With an id, the event must exist and be visible; a quote, if given, must occur in it (whitespace and case are ignored).
  - With only a quote, Origin cites the most recent visible `message` event containing it, falling back to `tool_result` events. Tool calls are never matched, because the agent's own `remember` call, which contains the quote, is itself logged as a tool call. Most recent means by timestamp. Origin looks up the quote's words the way a search does (see [Search and timeline](#search-and-timeline)) and checks at most the newest 25,000 events of each kind that contain all of them, so a quote made only of very common words may not be found in older events; cite the event id instead.
- **Correct.** Correcting the current version of an entry inserts a new version that `supersedes` it (invariant 3). Sources carry over and new ones can be added. A correction is always dated after the version it corrects, even when the local clock is behind. All versions of an entry share its `root`, the first version; together they form its chain.
- **Concurrent corrections.** Two stores may correct the same version before they hear of each other, so a version can be superseded by more than one. The chain then forks, and every store resolves it the same way: the version with the greatest `(created_at, id)` in the chain is the **current** version; every other version is superseded. A superseded version that nothing corrects lost to a concurrent correction and is marked as such (`concurrent`). Only the current version can be corrected.
- **Status** is derived: `forgotten` if a tombstone covers the entry, `active` if it is the current version of its chain, otherwise `superseded` (with the current version as `superseded_by`). Queries return active entries unless history is requested; forgotten entries are never returned. History lists every version of the chain, forks included, oldest first.

## Forgetting

`forget` takes an entry id or an event id and records a tombstone (invariant 2):

1. **Forgetting an entry** forgets every version of it (its whole chain, forks included) and excludes all events those versions cite.
2. **Forgetting an event** excludes it and forgets every entry that cites it, as in rule 1.
3. **An entry whose current version is left with no visible source** has lost its provenance and is forgotten as well, every version of it. This excludes no further events, so the cascade stops here.

A chain is forgotten as a whole or not at all, and nothing un-forgets. The tombstone keeps the target id and records its effects on the store: the entries it forgot and the events it excluded.

**Tombstones from other stores.** Tombstone ids are global, so a tombstone created on one store keeps its id, origin, and reason on every store it reaches. A store applies it by the rules above to the data it holds, and also applies the effects the tombstone had on the store that sent it, as far as it knows those ids; a listed entry takes its whole chain with it. Each store therefore forgets at least what the sender forgot, and the stores converge on the union. Applying a tombstone twice changes nothing. A version that arrives later in a forgotten chain is forgotten on arrival, and so is an entry whose sources were excluded elsewhere (rules 2 and 3), so the order of arrival does not matter.

Excluded events disappear from search, timelines, session counts, `get`, and `sources`, and can never be cited again. Re-syncing, even a rewritten source file, does not bring them back, because event ids are stable and exclusion is keyed by id. Forgetting hides; it does not erase. The raw mirror files stay on disk (invariant 3) but are never shown. Physical purging may come later as an explicit option. The CLI shows what will be forgotten and requires `--yes`, because forgetting cannot be undone.

## Search and timeline

Event search covers `message` events unless tool events are requested (`--all` / `include_tools`), and never returns forgotten events. Entry search covers active entries.

**Terms.** A query is split on whitespace, and every term must occur in the text, ignoring case, as a substring (`log` matches `catalog`). How a term is found depends on its length in characters:

- **Three or more characters**: through a trigram index, for CJK as well as Latin text.
- **One or two CJK letters** (Han, kana, or Hangul), such as `部署` or `库`: through the CJK index, which holds every pair of adjacent CJK letters and the last letter of each stretch of them.
- **One or two other characters**, such as `AI`, `C#`, or `5号`: no index can find them, so Origin checks the text of candidate events, newest first. The candidates are the events the search covers (its kinds, and the requested project, source, and time range) that match the query's other terms. At most the newest 25,000 candidates are checked (`SCAN_LIMIT`), so such a term can miss older events; a time range, a project, or a longer term reaches them.

**Indexes.** Three FTS5 indexes serve event search, all keyed by `seq`. One of them drives a query, newest first, and the other terms filter its matches:

| Index | Holds | Used for |
|---|---|---|
| `message_fts` | `message` events, with the position of every trigram (`detail=full`) | Message searches with a term of three or more characters: each term is matched exactly as a phrase and scored by BM25 |
| `event_fts` | Every event, recording only which events contain each trigram (`detail=none`), a fraction of the size of a full index | Searches that include tool events: an event must contain every trigram of every term, and is then checked against the terms themselves |
| `event_cjk` | The CJK bigrams of every event with CJK text (`detail=none`, contentless) | CJK terms of one or two letters, and queries whose only other terms are that short |

**Order.** By default, results are ranked by BM25 relevance, best first. Ranking considers the newest 2,000 matches (`RANK_WINDOW`), or all of them if there are fewer: when a query matches more events, the older ones are neither ranked nor returned, so very common terms favour recent events, and a time range moves the window. For messages, BM25 scores the terms as phrases; with tool events, it scores their trigrams. Queries without a term of three or more characters, and `--recent`, are ordered by time instead. Ordered by time means newest first by timestamp, and among events with the same timestamp, the later arrival first; ties in relevance are broken the same way. Results ordered by time, and the window of the newest 2,000 matches, are exact whatever order events arrived in: a query reads its index by blocks of arrivals (see [Storage](#storage)) and stops as soon as no unread block can hold a newer match than those it needs. A query with only a few matches (up to 2,000, or five times as many as it needs) reads them all instead.

**Snippets** show up to 200 characters of text around the first match, with every match in brackets.

**Entries** are searched by the same terms: terms of three or more characters through `entry_fts`, ranked by BM25, and shorter ones by checking the text (entries are few). Without a term of three or more characters, entries are newest first.

The timeline lists sessions by time, or the events of one session in order (tool events are hidden unless requested).

## MCP server

`origin mcp` serves these tools over stdio. Results are JSON text with local ISO 8601 timestamps, to the millisecond.

| Tool | Purpose |
|---|---|
| `search` | Full-text search over entries and events; without a query, lists recent entries. Filters: scope, kind, time range, source, project, tool events |
| `timeline` | Sessions in a time range (default 7 days), or the events of one session |
| `get` | An entry with its sources and version history, or an event with its full text |
| `sources` | Original log lines for an entry or event: file, mirror, line number, raw text |
| `remember` | Write an entry with kind, text, confidence, and sources |
| `correct` | Supersede an entry with a corrected version |
| `forget` | Forget an entry or event, per the rules above; only on the user's explicit request |

- **Freshness.** The server ingests all sources when it starts, before read tools (at most every 10 seconds), and always before `remember` and `correct`, so an agent can cite lines from the conversation it is in.
- **While the agent runs.** The server also looks for new log lines every 60 seconds (`ORIGIN_WATCH_INTERVAL_MS`; 0 turns this off), so that what is written after the agent's last tool call reaches the store, and the hub, without waiting for the next agent. A look compares each log file's size and modification time with what they were at the last ingestion, without reading the files, and ingests only if something changed. It runs in the background through the same gates as the other refreshes, so it never overlaps another sync, one look at a time; a tool call never waits for it unless it needs a refresh anyway, and a long ingestion lets tool calls through between its transactions.
- **When the agent leaves.** When standard input ends, or the server gets SIGTERM, SIGINT, or SIGHUP, it ingests once more, and syncs with the hub when connected, waiting at most 5 seconds, then exits. An agent that kills the server outright skips this; the next start catches up.
- **On a device connected to a hub.** The server still answers from the device's own store, and read tools (`search`, `timeline`, `get`, `sources`) ask the hub's `/mcp` at the same time. Results from both are merged, de-duplicated by id, and labelled `origin: "local"` (this device has it) or `"hub"`. What the device has forgotten is never shown, whatever the hub returns, and of the versions of one entry, only the current one by the rule in [Entries](#entries) is listed; `get` merges an entry's history from both stores. `get` and `sources` for an id the device does not have are answered by the hub. If the hub does not answer within 2 seconds (`ORIGIN_HUB_TIMEOUT_MS`) or cannot be reached, the tool answers from the device alone and adds a second text item saying that the hub was not consulted. The server opens its hub connection as soon as the agent has initialized, so the first read does not spend that time on the TLS handshake and MCP initialization.
- **Writes on a connected device** land in the device's store first and are then synced up. The server syncs with the hub before read tools at most every 10 seconds, right after every write, after each background look that found new lines, and when the agent leaves, and never holds an answer for the hub longer than the timeout. A sync that failed is retried at the next background look. `correct` and `forget` of an entry or event the device does not have are carried out on the hub, and fail with a clear error when it cannot be reached.
- **Guidance.** The server's MCP `instructions` tell agents when to search, when to remember (decisions with reasons, stable facts, preferences), and that `forget` needs an explicit request.
- **Errors.** Invalid input, unknown ids, and forgotten ids come back as tool errors with a readable message.

## Personal hub

A hub is an ordinary Origin store that also runs `origin serve`. It is self-hosted and single-tenant: one person, their devices, their agents. Nothing in the hub is specific to any hosting provider; the published container image `ghcr.io/openlinkos/origin` runs it anywhere.

### Roles

Every store is a replica; the hub is the one that is always online.

- **Device**: any machine with agent session logs. Its store is complete on its own: it ingests locally (adapters, raw mirrors, cursors, rewrite generations, compression are unchanged), its agents read and write it, and it keeps working offline. Connected to a hub, it sends the hub what it writes (`origin sync`, and `origin mcp` as it goes) and reads what other stores have through the hub.
- **Hub**: `origin serve` exposes MCP over HTTP for agents, a replication API for devices, and, when enabled, an admin UI for its owner. It holds what every device has sent, plus what cloud agents write to it directly, so everything can be found there.

### Replication: raw mirrors, entries, and tombstones up; tombstones down

A device sends its hub what it has written itself; the hub sends devices only what was forgotten. A sync (`origin sync` on a connected device) takes three steps, in this order:

1. **Raw mirrors.** A device pushes **raw mirror bytes**, not parsed events. The hub stores them as its own append-only mirrors and parses them with the same adapters, so provenance (invariant 1) holds on the hub and parser fixes apply everywhere. Event ids are identical on every store.
   - Each remote file is keyed by `(source, "@<device>:<original path>", generation)`; local paths never start with `@`. Hub mirrors live under `raw/devices/<device>/<source>/<relPath>[.g<n>]`, stored like any other (see [Raw mirrors](#raw-mirrors)).
   - Pushing is resumable and idempotent: the device asks for the hub's cursors, then sends `[cursor, local size)` of each mirror in chunks of complete lines (at most 1 MiB, or one longer line). A chunk whose offset does not match the hub's cursor is rejected with the current cursor, and the device resumes from there. Offsets and cursors count bytes of a mirror's content, uncompressed: the device reads its mirror decompressed, the request is gzip-encoded on the way, and the hub compresses what it stores.
2. **Entries and tombstones up.** The device sends the entries and tombstones it wrote itself (those whose `origin` is its name), in the order of its `change_log`, after its push cursor. Entries it has forgotten are never sent. The hub stores them under the same ids, with their author and origin, and applies the tombstones by the rules in [Forgetting](#forgetting), so a version or entry that arrives into something already forgotten is forgotten on arrival. Because the device pushes its mirrors first, the events its entries cite are normally on the hub already; if an entry's cited events or the version it supersedes are not there yet, the hub says which ids are missing, the push cursor stops before that entry, and later entries wait for the next sync. Tombstones are sent all the same: forgetting never waits.
3. **Tombstones down.** The device asks for the tombstones after its pull cursor in the hub's `change_log`; the hub leaves out the ones that device created and sends each with its current effects on the hub. The device applies them to its store, so forgetting reaches every replica (invariant 2). When a tombstone's effects on the hub grow later, because the hub applied it to data the device did not have or because a correction or entry arrived that it covers, the hub logs it again, and every device, its creator included, receives the larger effects.

- **Only tombstones come down.** The hub never sends entries or events to a device: a device's store holds its own sessions, its own entries, and the tombstones that concern them.
- **One judge per entry.** When a device applies a tombstone from the hub, it decides rule 3 (no visible source left) only for entries the hub has not received yet. For the others, the hub holds every version, and its verdict arrives as part of the tombstone's effects, so a device and its hub never disagree about an entry they both have.
- **Cursors.** A device keeps two cursors per hub URL in `setting`: how far it has pushed its own changes, and how far it has pulled the hub's. Each is saved after every successful request, so an interrupted sync resumes where it stopped, and running it again sends nothing.
- Events forgotten on the hub stay excluded when re-pushed, because exclusion is keyed by event id.

### Access

- Every request to `/mcp` and `/v1/*` needs `Authorization: Bearer <token>`; the admin UI under `/admin` has its own sign-in (see [Admin UI](#admin-ui)). Tokens are created on the hub (`origin token create <name>`), shown once, stored only as SHA-256 hashes, and revocable. Each device or cloud agent gets its own token.
- **A token is bound to one device, the one it is named after.** On the replication API, a token sends and receives data only for that device: what it pushes is stored under the token's name, a request that names another device (`device` in its body or query) is refused with `403`, and so is a record whose `origin` is not that device. A device's store must therefore have its token's name, which `origin hub connect` checks (see [Using a hub from a device](#using-a-hub-from-a-device)). A token named like the hub itself serves no device; a token used only for `/mcp`, such as a cloud agent's, needs no device. A revoked token can be replaced by a new one under the same name, so a device that lost its token keeps its name; an active token must be revoked first.
- The hub speaks plain HTTP. Put it behind TLS (a reverse proxy or CDN) before exposing it beyond localhost.
- Entries keep the author they were written with when a device pushes them. Entries written through the hub's `/mcp` record `<agent>@<token name>` when the caller names its agent in `X-Origin-Client`, as a device's `origin mcp` does (`claude-code@laptop`), and the token name alone otherwise (`ci` for a cloud agent's token), since a stateless request does not carry the MCP client's name. The device part is always the token's name: a device's `origin mcp` also sends its name in `X-Origin-Device`, and the hub refuses (`403`) a request whose header names another device, so no token writes as another device, and a device whose store and token disagree fails visibly.

### HTTP interface

| Method and path | Purpose |
|---|---|
| `GET /healthz` | `{ "ok": true, "version": … }`, no auth |
| `POST /mcp` | MCP Streamable HTTP, stateless, JSON responses; the same seven tools as the stdio server |
| `GET /v1/device` | `{ device, hub }`: the device the token belongs to (its name), and the hub's name |
| `GET /v1/cursors?device=<name>` | The hub's byte cursor for every file of the token's device |
| `POST /v1/ingest` | Append one chunk: JSON `{ device, source, path, relPath, generation, offset, mtimeMs, agentVersion, data }` with `data` in base64 and `offset` in the mirror's uncompressed content; the body may be gzip-encoded. Returns `200 { bytes, eventsAdded, … }` or `409 { bytes }` on an offset mismatch |
| `POST /v1/entries` | `{ device, entries }` with at most 1,000 entries, each `{ id, kind, text, confidence, author, project, supersedes, validFrom, validTo, createdAt, origin, sources: [{ eventId, quote }] }`, whose `origin` must be the token's device. Stored in order; returns `200 { applied, pending }`, where `pending` is null, or `{ id, missing }` for the first entry whose cited events or superseded version are not on the hub yet (nothing after it is stored). `409` for a different body under an existing id |
| `POST /v1/tombstones` | `{ device, tombstones }` with at most 1,000 tombstones, each `{ id, target, reason, createdAt, origin, entries, events }` with its effects on the device, whose `origin` must be the token's device. Applied by the rules in [Forgetting](#forgetting); returns `200 { applied }`, or `409` for a different body under an existing id |
| `GET /v1/tombstones?after=<seq>&device=<name>` | `{ tombstones, next, more }`: the tombstones in the hub's change log after sequence number `after`, except those the token's device created, each with its id, target, reason, `createdAt`, origin, and its forgotten entries and excluded events on the hub. Continue with `after=<next>` while `more` is true |
| `GET`, `POST /admin/…` | The admin UI when enabled: server-rendered pages behind an admin sign-in. 404 when disabled |
| `GET`, `POST /admin/api/…` | The admin UI's JSON API: the same operations, session, and checks as its pages |

The hub validates every field. A replication request acts for its token's device: `device` is optional, and a request that names another device is refused with `403` and the token's device in the body (`{ error, device }`). Device names match `[a-z0-9][a-z0-9._-]{0,62}` and may not be the hub's own name, the source must be a known adapter, and `relPath` must be relative with no `..` segment, so a device can never write outside its own mirror directory.

### Using a hub from a device

- `origin hub connect <url> --token <token> [--device <name>]` stores the connection in `<ORIGIN_HOME>/hub.json`. The device's name is its store's name (see [Storage](#storage)), and it must be the name of the device's token: the command asks the hub which device the token belongs to (`GET /v1/device`) and, if that is not this store, refuses and says how to fix it. `--device` renames a store that has not written any entry or tombstone yet. `origin hub status` makes the same check. `ORIGIN_HUB_URL` and `ORIGIN_HUB_TOKEN` override the stored connection.
- With a hub configured, `origin mcp` keeps serving from the device's own store and merges in the hub's answers (see [MCP server](#mcp-server)). It syncs with the hub as it goes: before read tools at most every 10 seconds, right after every write, every minute while log files change, and once more when the agent leaves; it waits for the hub no longer than the timeout. Agent registrations do not change, and an agent can still cite what was said a moment ago.
- Cloud agents with no local logs register the hub's `/mcp` URL directly with a bearer token.
- CLI curation commands (`entries`, `show`, `correct`, `forget`, …) act on the device's own store. On a connected device, `correct` and `forget` then sync with the hub, so the change reaches the hub and, for forgetting, every other device. The hub's admin UI shows the entries of every device.

### Admin UI

The hub can serve a web interface for its owner. It is off by default, and it is a view onto the same store rather than a separate system: every page and every JSON call goes through the core operations that MCP and the CLI use (invariant 5). The package `@openlinkos/origin-admin` provides a request handler that the hub mounts.

- **Serving.** `origin serve --admin` mounts the UI at `/admin` on the hub's port; `origin serve --admin-listen 127.0.0.1:7078` serves it on a separate listener instead, reached through an SSH tunnel or `kubectl port-forward`. The hub refuses to start if the UI would be served on a non-loopback address unless `--public-url` (`ORIGIN_PUBLIC_URL`) is an https URL, or an http URL on a loopback host such as a container port published on `127.0.0.1`. Without a public URL, the UI answers only loopback connections addressed to a loopback host name, which also defeats DNS rebinding. With the UI disabled, `/admin` is a 404.
- **Sign-in.** A hub has one admin password and no user names. When `ORIGIN_ADMIN_PASSWORD` is set, it is the password and takes precedence; it must have at least 10 characters, or the hub refuses to start. Otherwise the password is set on the hub with `origin admin password` (typed twice on a terminal, or one line on standard input) or generated with `origin admin password --generate`. If there is neither when the hub starts with the admin UI enabled, the hub generates one (20 random base32 characters, 100 bits), stores its hash, and prints it once to its log. There is no first-visit setup, so a fresh hub cannot be claimed by whoever reaches it first. The password is stored as a scrypt hash (N = 2^15, r = 8, p = 3, a random 16-byte salt), written `scrypt$N$r$p$<salt>$<hash>`, in `setting`, which stays on the hub; the hub keeps such a hash of `ORIGIN_ADMIN_PASSWORD` too, to notice when it changes. Checks run one at a time and compare in constant time. The password and hub tokens reject each other: a password cannot start with `ogn_`, `/mcp` and `/v1/*` accept only bearer tokens, and `/admin` accepts only its own session cookie.
- **Sessions.** Sessions live on the server, in `admin_session`, keyed by a hash of the session id. They end after 30 minutes without a request or 12 hours after sign-in, and all of them end when the password changes: when it is set with `origin admin password`, and when the hub starts with a different `ORIGIN_ADMIN_PASSWORD` than before or switches between it and the stored password. The cookie is `__Host-origin-admin` (Secure, HttpOnly, SameSite=Lax) behind an https public URL, and `origin-admin` (HttpOnly, SameSite=Strict, path `/admin`) on loopback http. Behind an https public URL the plain cookie counts only over a loopback tunnel, so a cookie planted from a sibling subdomain cannot fix a session. Creating or revoking tokens, forgetting, and ending sessions need the password to have been entered within the last 10 minutes.
- **Requests.** Only GET and POST exist, and every write is a POST. A POST needs the session's CSRF token (form field `_csrf` or header `X-CSRF-Token`) and an `Origin` header equal to the hub's origin, and is refused with `Sec-Fetch-Site: cross-site`. Request bodies are limited to 64 KiB. Failed password checks are limited to 10 per client and 100 in total per 10 minutes (429 with `Retry-After`); the client address is taken from `ORIGIN_CLIENT_IP_HEADER` only when that is set, and otherwise from the connection. Behind a proxy or CDN, that header must be set: otherwise every client shares the proxy's address and one limit, and anyone's failed attempts can lock the owner out.
- **Responses.** Pages are rendered on the server by a template that escapes every interpolated value; a small script adds conveniences, such as loading a raw line in place, but no page depends on it. Every response carries a strict Content-Security-Policy (no inline script or style, Trusted Types with no policy), `Cache-Control: no-store, private`, `Vary: Cookie`, and headers against framing, sniffing, referrers, and indexing, plus HSTS behind https. Every asset, the design system's stylesheet, fonts, and icons included, is served by the hub itself under a content-hashed name; each page inlines only the icon symbols it uses, and the UI never makes an external request.
- **What it can do.** An overview (counts, devices and their last push, storage, parse errors), tokens (create, with the token shown once next to ready-made connection commands, and revoke), devices, the timeline, sessions, events with their provenance chain (the raw line loads on request, truncated to 4,000 characters; tool events are hidden unless asked for), search, entries and their history, `correct` (confidence 1 unless given), `remember` from an event page (citing that event, author `user@` and the hub's name), and `forget` after a preview: the request carries the digest of the plan that was shown and the id typed again, and nothing is forgotten if the plan has changed since (409).
- **What it cannot do.** Edit or delete events, raw mirrors, entries, or tombstones; un-forget; show any text of forgotten content (a tombstone keeps the target id, the reason given, and the ids it removed; the audit log keeps ids and counts only); save an entry without a visible source; show a token again; change the admin password or other security settings; run arbitrary queries or read any file other than a visible event's mirror line.
- **Audit log.** Sign-ins and failed attempts (collapsed to one record per client and window), token changes, entries written, forget operations, and ended sessions from the UI (actor `owner`); token and password changes from the CLI (actor `cli`); and passwords generated or changed when the hub starts (actor `hub`) are appended to `audit_log` with the channel, client address, and user agent. Details are ids and counts, never text or passwords, so forgetting stays sticky; triggers reject updates and deletes.

## Open questions

- **Cognition at low cost.** How do we build and maintain a model of the person without a dedicated extraction pipeline? For now, agents write cognition entries themselves when they notice something. Whether that is enough is still an open question.
- **Native memory interop.** Claude Code, ZCode, and Grok Build all keep a `MEMORY.md` index plus one Markdown file per memory. Two-way import/export with that layout is planned but not yet designed.
- **Change notification.** `origin mcp` looks for new log lines every minute while an agent runs, comparing file sizes and times, and syncs once more when the agent leaves, so a device needs no scheduled task while its agents use Origin. What remains: lines written by agents that do not use Origin, or after an agent that kills its server, wait for the next agent or `origin sync`; and watching files rather than looking every minute would cut the delay, but file watching is unreliable on some platforms.
- **Relay mode for small disks.** A device with little space could keep only what it has not sent yet and read everything else through its hub. It would then no longer be a complete memory on its own, so this needs its own design.
- **Hub storage backends.** A hub keeps raw mirrors on its disk and everything else in SQLite. For hubs that outgrow one disk, raw mirrors could move to object storage, and the store optionally to PostgreSQL.

## Prior art

Surveyed in October 2026. Origin borrows ideas from these projects but depends on none of them.

| Project | Idea Origin borrows |
|---|---|
| [Hindsight](https://github.com/vectorize-io/hindsight) | Entries cite their evidence and expand to the original text; an explicit "mental model" layer |
| [Graphiti](https://github.com/getzep/graphiti) | Bi-temporal validity (`valid_from` / `valid_to`), without building a graph |
| [GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) | Citations that are re-validated before use |
| [MacPaw Portable Memory](https://github.com/MacPaw/portable-memory) | Deletion tombstones as a first-class concept |
| [Codex memories](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md) | Memory derived from local session logs, with references back to the session |

Other systems in this space include [mem0](https://github.com/mem0ai/mem0), [Letta](https://github.com/letta-ai/letta-code), [Supermemory](https://github.com/supermemoryai/supermemory), [Cognee](https://github.com/topoteretes/cognee), and the reference [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory). Most of them lack either fine-grained provenance or a forget operation you can verify, and vendor memories (Claude, ChatGPT, Gemini, Copilot, Codex) are each scoped to one product with no third-party read API.
