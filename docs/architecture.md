# Architecture

This document describes Origin's current design: the problem it targets, the data model, the invariants every change must preserve, and how ingestion and search work. It is the reference for contributors; if a change alters the data model, an invariant, or a public interface, update this document in the same commit.

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
- [Search and timeline](#search-and-timeline)
- [MCP interface (planned)](#mcp-interface-planned)
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
| `memory` | What happened (episodic) | "On Oct 19 we decided to ship in small runnable increments instead of milestones." |
| `knowledge` | Stable facts and relations | "Project A depends on library B." |
| `cognition` | A model of the person: preferences, methods, goals, boundaries | "Prefers commit messages without attribution trailers." |

## Core objects

| Object | Meaning | Key fields |
|---|---|---|
| **Source** | An adapter for one agent: `claude-code`, `codex`, `cursor`, `zcode`, `grok` | id, agent version, discovery root |
| **Raw** | Append-only mirror of an original log file | source, original path, generation, byte/line cursor, tail hash |
| **Event** | A normalized conversation event: user message, assistant message, tool call, tool result | id, source, session, timestamp, project, cwd, git branch, role, kind, text, raw locator |
| **Entry** *(planned)* | A durable `memory` / `knowledge` / `cognition` item | id, kind, text, confidence, sources (event ids + quotes), author, created_at, valid_from / valid_to, status (`active` / `superseded` / `forgotten`), supersedes |
| **Tombstone** *(planned)* | Record of a forget operation | entry id, excluded event ids, time; applies to all future writes |

## Data flow

```
agent session logs on disk ──scan──▶ Raw (append-only mirror)
                                        │ deterministic adapter parsing (no LLM)
                                        ▼
                                  Event store (SQLite + FTS5)
                                        │
 agents ◀── MCP (stdio): search · timeline · get · sources · remember · correct · forget  (planned)
 people ◀── CLI `origin`: sync · status · timeline · search · show · projects
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

pnpm workspace, TypeScript (strict, ESM, NodeNext), Node.js ≥ 22.13. No runtime dependencies beyond Node built-ins so far.

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@openlinkos/origin-core` | `packages/core` | Storage, schema, ingestion, queries, invariants | — |
| `@openlinkos/origin-adapters` | `packages/adapters` | One deterministic parser per source | core |
| `@openlinkos/origin-mcp` | `packages/mcp` | MCP server over stdio (placeholder) | core |
| `@openlinkos/origin` | `packages/cli` | The `origin` command | core, adapters |

`core` must not depend on any other package. Adapters implement the `SourceAdapter` interface from `core`:

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
├── origin.db              # SQLite (WAL): raw_file, event, session, event_fts, sync_log
└── raw/<source>/...       # append-only mirrors of the original log files
```

- Storage uses Node's built-in `node:sqlite`, so there are no native modules to compile.
- `session` is a derived table and can be rebuilt from `event`. `event_fts` is an external-content FTS5 index kept in sync by triggers; it can be dropped and rebuilt.
- **No migrations before the first release.** The schema is one set of idempotent statements applied every time the database is opened, so added tables and indexes appear in existing databases automatically. Any other schema change is made in place and needs a fresh `ORIGIN_HOME`. Delete the whole directory, never just `origin.db`: mirror paths are deterministic, so re-syncing into an existing `raw/` would append duplicate content. Versioned migrations will arrive with the first release.

## Ingestion

`origin sync` runs every adapter's `discover()` and, for each file:

1. **Cursor.** Each `raw_file` row tracks `bytes_ingested`, `lines_ingested`, and `tail_hash` (SHA-256 of the last 4 KB ingested). Only bytes after the cursor are read.
2. **Rewrite detection.** If the file shrank or its tail no longer matches, it was rewritten rather than appended. Origin opens a new *generation* with a fresh mirror and keeps the old mirror intact (invariant 3).
3. **Complete lines only.** Bytes up to the last newline are appended to the mirror; a trailing partial line waits for the next sync.
4. **Parse and insert.** Each line goes through `parseLine`; failures are counted, not fatal. Events are inserted with `INSERT OR IGNORE` under the id `<source>:<native-id>[#<block-index>]`, which makes sync idempotent (invariant 3). Each event stores its mirror file and line number (invariant 1).
5. **Bookkeeping.** Affected sessions are re-aggregated, the cursor advances in the same transaction, and a `sync_log` row records the run.

### Claude Code mapping

- Files: `<projects>/<cwd-slug>/<session-id>.jsonl`, plus sub-agent logs under `<session-id>/subagents/`. The `memory/` and `tool-results/` directories are skipped.
- `user` / `assistant` lines become events. Text blocks are joined into one `message` event; each `tool_use` and `tool_result` block becomes its own event (truncated to 2,000 / 4,000 characters). `isMeta` lines become `meta` events. `thinking` blocks are not indexed but remain in the raw mirror.
- `summary` lines set the session title.
- The project name is the last segment of `cwd`.

See [sources.md](sources.md) for the on-disk formats of all target agents.

## Search and timeline

- Full-text search uses FTS5 with the `trigram` tokenizer, so case-insensitive substring search works for CJK as well as Latin text. Each whitespace-separated term becomes a quoted phrase, and terms are combined with AND. A trigram index cannot serve terms shorter than three characters, so those queries fall back to `LIKE`.
- Results are ordered newest first and can be filtered by time range, source, and project.
- The timeline lists sessions by time, or the events of one session in order (tool events are hidden unless `--all` is given).

## MCP interface (planned)

The MCP server will expose these tools over stdio:

| Tool | Purpose |
|---|---|
| `search` | Full-text search over events and entries |
| `timeline` | Sessions and events in a time range, optionally filtered by project or source |
| `get` | Fetch an event or entry by id |
| `sources` | Expand an entry or event to its original raw text |
| `remember` | Write an entry (`memory` / `knowledge` / `cognition`) with sources and confidence |
| `correct` | Supersede an entry with a corrected version |
| `forget` | Forget an entry and tombstone its sources |

## Open questions

- **Cognition at low cost.** How do we build and maintain a model of the person without a dedicated extraction pipeline? For now, agents write cognition entries themselves when they notice something. Whether that is enough is still an open question.
- **Native memory interop.** Claude Code, ZCode, and Grok Build all keep a `MEMORY.md` index plus one Markdown file per memory. Two-way import/export with that layout is planned but not yet designed.
- **Change notification.** File watching is unreliable on some platforms. For now ingestion runs on an explicit `origin sync`; a watcher backed by a periodic full scan is planned.

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
