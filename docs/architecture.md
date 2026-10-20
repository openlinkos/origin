# Architecture

This document describes Origin's current design: the problem it targets, the data model, the invariants every change must preserve, and how ingestion, entries, search, and the MCP server work. It is the reference for contributors; if a change alters the data model, an invariant, or a public interface, update this document in the same commit.

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
- Let the person inspect, correct, and forget entries via the `origin` CLI; forgetting must stick.

The goal is reached when, from any connected agent, you can ask "what did I decide in project X last week, and why?" and get an answer with sources, and a forgotten entry never comes back.

**Explicit non-goals for now:** encryption and key management, multi-device sync, a web UI, screen/email/browser capture, knowledge graphs, vector search, proactive reminders, and any call to a model API.

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
| **Raw** | Append-only mirror of an original log file | source, original path, generation, byte/line cursor, tail hash |
| **Event** | A normalized conversation event: user message, assistant message, tool call, tool result | id, source, session, timestamp, project, cwd, git branch, role, kind, text, raw locator |
| **Entry** | A durable `memory` / `knowledge` / `cognition` statement | id (`ent_…`), kind, text, confidence, author, project, sources (event ids + quotes), supersedes, valid_from / valid_to, created_at; status (`active` / `superseded` / `forgotten`) is derived, never stored |
| **Tombstone** | Record of a forget operation | target id, reason, time; the entries it forgot and the events it excluded |

## Data flow

```
agent session logs on disk ──scan──▶ Raw (append-only mirror)
                                        │ deterministic adapter parsing (no LLM)
                                        ▼
                                  Event store (SQLite + FTS5) ◀── Entries · Tombstones
                                        │
 agents ◀── MCP (stdio): search · timeline · get · sources · remember · correct · forget
 people ◀── CLI `origin`: sync · status · timeline · search · show · entries · correct · forget
```

## Invariants

These are product guarantees. Each must be covered by tests, and code comments refer to them by number.

1. **Provenance.** Every Entry cites at least one Event; every Event points to a Raw file and line. Any answer can be expanded down to the original text.
2. **Sticky forgetting.** After `forget`, an entry leaves every query immediately, and its source events join an exclusion set that no later write can resurrect.
3. **Append-only.** Raw mirrors and Events are never rewritten. Entries change by supersession (`supersedes`), never in place.
4. **Local-first.** All data lives on the local machine under `~/.origin/` (SQLite plus files). The core makes no network calls.
5. **Single entry point.** Agents read and write only through the MCP server; people use the CLI. Nothing else touches the store.

## Design principles

- **No LLM in the core.** Origin never calls a model API. It archives, normalizes, indexes, and stores. Analysis happens in the agent that is asking — it is already a capable model. Agents persist what they learn through MCP `remember`; people correct and forget through the CLI. If periodic consolidation is ever needed, it will run as a headless coding-agent task (for example `claude -p`), not as a direct model API integration. This is the current position and can be revisited if evaluation shows it falls short, especially for the cognition layer.
- **Deterministic, tolerant adapters.** Each source has a pure, deterministic parser. Agent log formats change frequently, so adapters record the agent version, skip lines they cannot parse, count the failures, and never abort ingestion.
- **MCP as the interoperability point.** MCP is the only interface all target agents share. Several of them also read Claude Code's MCP configuration, so one registration can reach more than one agent.
- **Small, runnable increments.** Each source adapter ships and is used on its own; the design only goes as deep as the current increment needs.

## Packages

pnpm workspace, TypeScript (strict, ESM, NodeNext), Node.js ≥ 22.13. `core` and `adapters` use only Node built-ins; `mcp` depends on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and zod.

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@openlinkos/origin-core` | `packages/core` | Storage, schema, ingestion, entries, forgetting, queries | — |
| `@openlinkos/origin-adapters` | `packages/adapters` | One deterministic parser per source | core |
| `@openlinkos/origin-mcp` | `packages/mcp` | MCP server over stdio | core |
| `@openlinkos/origin` | `packages/cli` | The `origin` command, including `origin mcp` | core, adapters, mcp |

`core` must not depend on any other package, and `mcp` must not depend on `adapters`: the CLI injects ingestion into the server as a callback. Adapters implement the `SourceAdapter` interface from `core`:

```ts
interface SourceAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'zcode' | 'grok'
  displayName: string;
  version(): string | null; // agent version, if known
  discover(): Promise<SourceFile[]>;
  parseLine(line: string, ctx: ParseContext): ParsedLine | null; // pure; throws on malformed input
}
```

## Storage

```
~/.origin/                 # or $ORIGIN_HOME
├── origin.db              # SQLite (WAL)
└── raw/<source>/...       # append-only mirrors of the original log files
```

| Table | Contents |
|---|---|
| `raw_file` | One row per mirrored file generation, with its ingestion cursor |
| `event`, `event_fts` | Normalized events and their FTS5 trigram index |
| `session` | Per-session aggregates over visible events (derived, rebuildable) |
| `sync_log` | One row per sync run |
| `entry`, `entry_source`, `entry_fts` | Entries, the events they cite (with quotes), and their FTS5 index |
| `tombstone`, `forgotten_entry`, `excluded_event` | Forget operations and their effects |

- Storage uses Node's built-in `node:sqlite`, so there are no native modules to compile. Several processes may share the database (the CLI and one MCP server per agent session); WAL mode and a busy timeout handle this.
- `session` is derived and can be rebuilt from `event`. The FTS indexes are external-content tables kept in sync by triggers.
- **No migrations before the first release.** The schema is one set of idempotent statements applied every time the database is opened, so added tables and indexes appear in existing databases automatically. Any other schema change is made in place and needs a fresh `ORIGIN_HOME`. Delete the whole directory, never just `origin.db`: mirror paths are deterministic, so re-syncing into an existing `raw/` would append duplicate content. Versioned migrations will arrive with the first release.

## Ingestion

`origin sync` (and the MCP server, see below) runs every adapter's `discover()` and ingests each file in its own `BEGIN IMMEDIATE` transaction, so concurrent syncs from different processes are serialized and never ingest the same bytes twice:

1. **Cursor.** Each `raw_file` row tracks `bytes_ingested`, `lines_ingested`, and `tail_hash` (SHA-256 of the last 4 KB ingested). The cursor is read under the write lock, and only bytes after it are read.
2. **Rewrite detection.** If the file shrank or its tail no longer matches, it was rewritten rather than appended. Origin opens a new *generation* with a fresh mirror and keeps the old mirror intact (invariant 3).
3. **Complete lines only.** Bytes up to the last newline are appended to the mirror; a trailing partial line waits for the next sync. A mirror always equals the ingested bytes of its generation, so bytes left past the cursor by an interrupted sync are dropped before appending (invariant 1).
4. **Parse and insert.** Each line goes through `parseLine`; failures are counted, not fatal. Events are inserted with `INSERT OR IGNORE` under the id `<source>:<native-id>[#<block-index>]`, which makes sync idempotent (invariant 3). Each event stores its mirror file and line number (invariant 1).
5. **Bookkeeping.** Affected sessions are re-aggregated, the cursor advances in the same transaction, and a `sync_log` row records the run.

### Claude Code mapping

- Files: `<projects>/<cwd-slug>/<session-id>.jsonl`, plus sub-agent logs under `<session-id>/subagents/`. The `memory/` and `tool-results/` directories are skipped.
- `user` / `assistant` lines become events. Text blocks are joined into one `message` event; each `tool_use` and `tool_result` block becomes its own event (truncated to 2,000 / 4,000 characters). `isMeta` lines become `meta` events. `thinking` blocks are not indexed but remain in the raw mirror.
- `summary` lines set the session title.
- The project name is the last segment of `cwd`.

See [sources.md](sources.md) for the on-disk formats of all target agents.

## Entries

- **Remember.** An entry is one self-contained statement with a kind, a confidence between 0 and 1, an author (the MCP client's name, or `user` for CLI corrections), an optional project and validity range, and at least one source (invariant 1). A source is an event id, an exact quote, or both:
  - With an id, the event must exist and be visible; a quote, if given, must occur in it (whitespace and case are ignored).
  - With only a quote, Origin cites the most recent visible `message` event containing it, falling back to `tool_result` events. Tool calls are never matched, because the agent's own `remember` call, which contains the quote, is itself logged as a tool call.
- **Correct.** Correcting an active entry inserts a new entry that `supersedes` it (invariant 3). Sources carry over and new ones can be added. History is linear: an entry can be superseded at most once, and only the newest version is active.
- **Status** is derived: `forgotten` if a tombstone covers the entry, `superseded` if a newer version exists, otherwise `active`. Queries return active entries unless history is requested; forgotten entries are never returned.

## Forgetting

`forget` takes an entry id or an event id and records a tombstone (invariant 2):

1. **Forgetting an entry** forgets every version of it and excludes all events those versions cite.
2. **Forgetting an event** excludes it and forgets every entry that cites it, as in rule 1.
3. **An active entry left with no visible source** has lost its provenance and is forgotten as well. This excludes no further events, so the cascade stops here.

Excluded events disappear from search, timelines, session counts, `get`, and `sources`, and can never be cited again. Re-syncing, even a rewritten source file, does not bring them back, because event ids are stable and exclusion is keyed by id. Forgetting hides; it does not erase. The raw mirror files stay on disk (invariant 3) but are never shown. Physical purging may come later as an explicit option. The CLI shows what will be forgotten and requires `--yes`, because forgetting cannot be undone.

## Search and timeline

- Full-text search uses FTS5 with the `trigram` tokenizer, so case-insensitive substring search works for CJK as well as Latin text. Each whitespace-separated term becomes a quoted phrase, and terms are combined with AND. A trigram index cannot serve terms shorter than three characters, so those queries fall back to `LIKE`.
- Results are ranked by BM25 relevance by default, or by time on request (`--recent`); `LIKE` fallbacks are always ordered by time. Event search covers `message` events unless tool events are requested (`--all` / `include_tools`). Entry search covers active entries.
- The timeline lists sessions by time, or the events of one session in order (tool events are hidden unless requested).

## MCP server

`origin mcp` serves these tools over stdio. Results are JSON text with local ISO 8601 timestamps.

| Tool | Purpose |
|---|---|
| `search` | Full-text search over entries and events; without a query, lists recent entries. Filters: scope, kind, time range, source, project, tool events |
| `timeline` | Sessions in a time range (default 7 days), or the events of one session |
| `get` | An entry with its sources and version history, or an event with its full text |
| `sources` | Original log lines for an entry or event: file, mirror, line number, raw text |
| `remember` | Write an entry with kind, text, confidence, and sources |
| `correct` | Supersede an entry with a corrected version |
| `forget` | Forget an entry or event, per the rules above; only on the user's explicit request |

- **Freshness.** The server syncs all sources when it starts, before read tools (at most every 10 seconds), and always before `remember` and `correct`, so an agent can cite lines from the conversation it is in.
- **Guidance.** The server's MCP `instructions` tell agents when to search, when to remember (decisions with reasons, stable facts, preferences), and that `forget` needs an explicit request.
- **Errors.** Invalid input, unknown ids, and forgotten ids come back as tool errors with a readable message.

## Open questions

- **Cognition at low cost.** How do we build and maintain a model of the person without a dedicated extraction pipeline? For now, agents write cognition entries themselves when they notice something. Whether that is enough is still an open question.
- **Native memory interop.** Claude Code, ZCode, and Grok Build all keep a `MEMORY.md` index plus one Markdown file per memory. Two-way import/export with that layout is planned but not yet designed.
- **Change notification.** File watching is unreliable on some platforms. The MCP server syncs on demand, and the CLI on `origin sync`; a background watcher backed by a periodic full scan may still be needed.

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
