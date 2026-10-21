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
- One person often runs agents on several machines (laptops, servers, cloud agents). An optional, self-hosted **personal hub** gathers every device's sessions into one store and serves it to agents anywhere.

The goal is reached when, from any connected agent on any of your machines, you can ask "what did I decide in project X last week, and why?" and get an answer with sources, and a forgotten entry never comes back.

**Explicit non-goals for now:** multi-tenant hosting (Origin is for one person; everyone runs their own), a hosted service run by the project, end-to-end encryption, two-way sync between replicas, any web interface beyond the owner's admin UI on their own hub (no public pages, no sharing, no multiple accounts), screen/email/browser capture, knowledge graphs, vector search, proactive reminders, and any call to a model API.

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
 people ◀── admin UI (hub, /admin): overview · timeline · search · entries · remember · correct · forget · tokens
```

With a personal hub, each device keeps ingesting locally and replicates its raw mirrors to the hub, which parses them with the same adapters. Agents reach the hub through their device's local `origin mcp` (which forwards to the hub) or, for cloud agents, through the hub's HTTP endpoint:

```
device A: logs ─▶ local store ──push raw mirrors──▶ ┐
device B: logs ─▶ local store ──push raw mirrors──▶ ├─▶ hub store ◀── MCP over HTTP ── cloud agents
                       ▲                            │       ▲
                       └──── pull tombstones ───────┘       └── forwarded MCP ── local origin mcp ◀── agents on A, B
```

## Invariants

These are product guarantees. Each must be covered by tests, and code comments refer to them by number.

1. **Provenance.** Every Entry cites at least one Event; every Event points to a Raw file and line. Any answer can be expanded down to the original text.
2. **Sticky forgetting.** After `forget`, an entry leaves every query immediately, and its source events join an exclusion set that no later write can resurrect.
3. **Append-only.** Raw mirrors and Events are never rewritten. Entries change by supersession (`supersedes`), never in place.
4. **Your data, your machines.** All data lives on machines you control: your devices under `~/.origin/` and, optionally, your own hub. Origin never calls a third-party service; the only network traffic is between your devices and your hub.
5. **Single entry point.** Every read and write goes through the same core operations, whichever interface it comes from: agents use MCP (local stdio, or the hub's HTTP endpoint); people use the CLI or the admin UI of their hub. The hub's replication API carries raw mirrors and tombstones between your own stores and is not an entry point for agents or people.

## Design principles

- **No LLM in the core.** Origin never calls a model API. It archives, normalizes, indexes, and stores. Analysis happens in the agent that is asking — it is already a capable model. Agents persist what they learn through MCP `remember`; people correct and forget through the CLI or the admin UI. If periodic consolidation is ever needed, it will run as a headless coding-agent task (for example `claude -p`), not as a direct model API integration. This is the current position and can be revisited if evaluation shows it falls short, especially for the cognition layer.
- **Deterministic, tolerant adapters.** Each source has a pure, deterministic parser. Agent log formats change frequently, so adapters record the agent version, skip lines they cannot parse, count the failures, and never abort ingestion.
- **MCP as the interoperability point.** MCP is the only interface all target agents share. Several of them also read Claude Code's MCP configuration, so one registration can reach more than one agent.
- **A small, conservative admin UI.** The hub's admin UI is for its owner only. Pages are rendered on the server with a template that escapes every value, plus a little optional script; there are no third-party assets and no bundler. It can do what the CLI can, and nothing that would break an invariant: no editing in place, no un-forgetting, no forgotten text on screen.
- **Small, runnable increments.** Each source adapter ships and is used on its own; the design only goes as deep as the current increment needs.

## Packages

pnpm workspace, TypeScript (strict, ESM, NodeNext), Node.js ≥ 22.13. `core`, `adapters`, and `admin` use only Node built-ins; `mcp` depends on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and zod. The hub and its admin UI use Node's built-in `node:http`.

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@openlinkos/origin-core` | `packages/core` | Storage, schema, ingestion (local and remote), entries, forgetting, tokens, admin keys and sessions, the audit log, queries | — |
| `@openlinkos/origin-adapters` | `packages/adapters` | One deterministic parser per source | core |
| `@openlinkos/origin-mcp` | `packages/mcp` | MCP tools; servers over stdio and stateless HTTP; the forwarding proxy | core |
| `@openlinkos/origin-admin` | `packages/admin` | The hub's admin UI: server-rendered pages, a JSON API, and its static assets | core |
| `@openlinkos/origin` | `packages/cli` | The `origin` command, including `origin mcp`, `origin serve` (the hub), and `origin push` | core, adapters, mcp, admin |

`core` must not depend on any other package, and neither `mcp` nor `admin` may depend on `adapters`: the CLI injects ingestion into the servers as callbacks, and the hub's HTTP server lives in the CLI, which mounts the admin UI's request handler. Adapters implement the `SourceAdapter` interface from `core`:

```ts
interface SourceAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'zcode' | 'grok'
  displayName: string;
  version(): string | null; // agent version, if known
  discover(): Promise<SourceFile[]>; // { absPath, relPath, compression?: 'zstd' }
  parseLine(line: string, ctx: ParseContext): ParsedLine | null; // deterministic; throws on malformed input
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
| `api_token` | Hub access tokens: name and SHA-256 hash, never the token itself |
| `setting` | Small key-value state, such as how far a device has applied the hub's tombstones |
| `admin_key` | Admin UI sign-in keys: name and SHA-256 hash, never the key itself |
| `admin_session` | Admin UI sessions: a hash of the session id, its CSRF token, and its timestamps |
| `audit_log` | Append-only record of administrative actions, with ids and counts but never content; triggers reject updates and deletes |

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

**Compressed sources.** An adapter can mark a file as `compression: 'zstd'`. Origin then ingests and mirrors the decompressed content, using Node's built-in zstd, so cursors, line numbers, and raw lines work as for plain files. Compressed files are written once, so they are skipped when unchanged since their last ingestion.

### Claude Code mapping

- Files: `<projects>/<cwd-slug>/<session-id>.jsonl`, plus sub-agent logs under `<session-id>/subagents/`. The `memory/` and `tool-results/` directories are skipped.
- `user` / `assistant` lines become events. Text blocks are joined into one `message` event; each `tool_use` and `tool_result` block becomes its own event (truncated to 2,000 / 4,000 characters). `isMeta` lines become `meta` events. `thinking` blocks are not indexed but remain in the raw mirror.
- `summary` lines set the session title.
- The project name is the last segment of `cwd`.

The other adapters' mappings are documented next to their formats in [sources.md](sources.md) (Codex: [Codex CLI](sources.md#codex-cli)).

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

## Personal hub

A hub is an ordinary Origin store that also runs `origin serve`. It is self-hosted and single-tenant: one person, their devices, their agents. Nothing in the hub is specific to any hosting provider; the published container image `ghcr.io/openlinkos/origin` runs it anywhere.

### Roles

- **Device**: any machine with agent session logs. It keeps ingesting locally (adapters, raw mirrors, cursors, rewrite generations, compression are unchanged) and runs `origin push` to replicate. Its local store is a staging copy.
- **Hub**: `origin serve` exposes MCP over HTTP for agents, a small replication API for devices, and, when enabled, an admin UI for its owner. The hub is the source of truth for agents: search, timeline, entries, and forgetting all happen there.

### Replication: raw mirrors up, tombstones down

- A device pushes **raw mirror bytes**, not parsed events. The hub stores them as its own append-only mirrors and parses them with the same adapters, so provenance (invariant 1) holds on the hub and parser fixes apply everywhere. Event ids are identical on every store.
- Each remote file is keyed by `(source, "@<device>:<original path>", generation)`; local paths never start with `@`. Hub mirrors live under `raw/devices/<device>/<source>/<relPath>[.g<n>]`.
- Pushing is resumable and idempotent: the device asks for the hub's cursors, then sends `[cursor, local size)` of each mirror in chunks of complete lines (at most 1 MiB, or one longer line). A chunk whose offset does not match the hub's cursor is rejected with the current cursor, and the device resumes from there.
- After pushing, the device pulls the hub's tombstones it has not applied yet and applies them to its staging store, so forgetting reaches every replica (invariant 2). Events forgotten on the hub stay excluded when re-pushed, because exclusion is keyed by event id.

### Access

- Every request to `/mcp` and `/v1/*` needs `Authorization: Bearer <token>`; the admin UI under `/admin` has its own sign-in (see [Admin UI](#admin-ui)). Tokens are created on the hub (`origin token create <name>`), shown once, stored only as SHA-256 hashes, and revocable. Each device or cloud agent gets its own token.
- The hub speaks plain HTTP. Put it behind TLS (a reverse proxy or CDN) before exposing it beyond localhost.
- Entries written through the hub record the agent and token as author, e.g. `claude-code@laptop`: the agent name comes from the MCP client (or the `X-Origin-Client` header set by a forwarding proxy), the suffix from the token name.

### HTTP interface

| Method and path | Purpose |
|---|---|
| `GET /healthz` | `{ "ok": true, "version": … }`, no auth |
| `POST /mcp` | MCP Streamable HTTP, stateless, JSON responses; the same seven tools as the stdio server |
| `GET /v1/cursors?device=<name>` | The hub's byte cursor for every file of that device |
| `POST /v1/ingest` | Append one chunk: JSON `{ device, source, path, relPath, generation, offset, mtimeMs, agentVersion, data }` with `data` in base64; the body may be gzip-encoded. Returns `200 { bytes, eventsAdded, … }` or `409 { bytes }` on an offset mismatch |
| `GET /v1/tombstones?after=<id>` | Tombstones with id greater than `after`, each with its forgotten entries and excluded events |
| `GET`, `POST /admin/…` | The admin UI when enabled: server-rendered pages behind an admin sign-in. 404 when disabled |
| `GET`, `POST /admin/api/…` | The admin UI's JSON API: the same operations, session, and checks as its pages |

The hub validates every field: device names match `[a-z0-9][a-z0-9._-]{0,62}`, the source must be a known adapter, and `relPath` must be relative with no `..` segment, so a device can never write outside its mirror directory.

### Using a hub from a device

- `origin hub connect <url> --token <token> [--device <name>]` stores the connection in `<ORIGIN_HOME>/hub.json` (the device name defaults to the host name). `ORIGIN_HUB_URL`, `ORIGIN_HUB_TOKEN`, and `ORIGIN_DEVICE` override it.
- With a hub configured, `origin mcp` becomes a **forwarding proxy**: it exposes the same tools over stdio, syncs and pushes before each call (at most every 10 seconds for reads, always before `remember` and `correct`), and forwards the call to the hub. Agent registrations do not change, and an agent can still cite what was said a moment ago.
- Cloud agents with no local logs register the hub's `/mcp` URL directly with a bearer token.
- In this version, CLI curation commands (`entries`, `correct`, `forget`, …) act on the store they run against. Curate through your agents, through the hub's admin UI, or by running the CLI on the hub.

### Admin UI

The hub can serve a web interface for its owner. It is off by default, and it is a view onto the same store rather than a separate system: every page and every JSON call goes through the core operations that MCP and the CLI use (invariant 5). The package `@openlinkos/origin-admin` provides a request handler that the hub mounts.

- **Serving.** `origin serve --admin` mounts the UI at `/admin` on the hub's port; `origin serve --admin-listen 127.0.0.1:7078` serves it on a separate listener instead, reached through an SSH tunnel or `kubectl port-forward`. The hub refuses to start if the UI would be served on a non-loopback address unless `--public-url` (`ORIGIN_PUBLIC_URL`) is an https URL, or an http URL on a loopback host such as a container port published on `127.0.0.1`. Without a public URL, the UI answers only loopback connections addressed to a loopback host name, which also defeats DNS rebinding. With the UI disabled, `/admin` is a 404.
- **Sign-in.** Admin keys are created on the hub with `origin admin key create <name>`, shown once (`oga_…`), and stored as SHA-256 hashes in `admin_key`; `ORIGIN_ADMIN_KEY_SHA256` can supply hashes instead, for configuration kept in Git. There is no first-visit setup, so a fresh hub cannot be claimed by whoever reaches it first. Admin keys and hub tokens reject each other: `/mcp` and `/v1/*` accept only bearer tokens (`ogn_…`), and `/admin` accepts only its own session cookie.
- **Sessions.** Sessions live on the server, in `admin_session`, keyed by a hash of the session id. They end after 30 minutes without a request or 12 hours after sign-in, and when their key is revoked. The cookie is `__Host-origin-admin` (Secure, HttpOnly, SameSite=Lax) behind an https public URL, and `origin-admin` (HttpOnly, SameSite=Strict, path `/admin`) on loopback http. Behind an https public URL the plain cookie counts only over a loopback tunnel, so a cookie planted from a sibling subdomain cannot fix a session. Creating or revoking tokens, forgetting, and ending sessions need the key to have been entered within the last 10 minutes.
- **Requests.** Only GET and POST exist, and every write is a POST. A POST needs the session's CSRF token (form field `_csrf` or header `X-CSRF-Token`) and an `Origin` header equal to the hub's origin, and is refused with `Sec-Fetch-Site: cross-site`. Request bodies are limited to 64 KiB. Failed key checks are limited to 10 per client and 100 in total per 10 minutes (429 with `Retry-After`); the client address is taken from `ORIGIN_CLIENT_IP_HEADER` only when that is set, and otherwise from the connection.
- **Responses.** Pages are rendered on the server by a template that escapes every interpolated value; a small script adds conveniences, such as loading a raw line in place, but no page depends on it. Every response carries a strict Content-Security-Policy (no inline script or style, Trusted Types with no policy), `Cache-Control: no-store, private`, `Vary: Cookie`, and headers against framing, sniffing, referrers, and indexing, plus HSTS behind https. There are no third-party assets, and the UI never makes an external request.
- **What it can do.** An overview (counts, devices and their last push, storage, parse errors), tokens (create, with the token shown once next to ready-made connection commands, and revoke), devices, the timeline, sessions, events with their provenance chain (the raw line loads on request, truncated to 4,000 characters; tool events are hidden unless asked for), search, entries and their history, `correct` (confidence 1 unless given), `remember` from an event page (citing that event, author `user`), and `forget` after a preview: the request carries the digest of the plan that was shown and the id typed again, and nothing is forgotten if the plan has changed since (409).
- **What it cannot do.** Edit or delete events, raw mirrors, entries, or tombstones; un-forget; show any text of forgotten content (a tombstone keeps the target id, the reason given, and the ids it removed; the audit log keeps ids and counts only); save an entry without a visible source; show a token again; create admin keys or change security settings; run arbitrary queries or read any file other than a visible event's mirror line.
- **Audit log.** Sign-ins and failed attempts (collapsed to one record per client and window), token changes, entries written, forget operations, and ended sessions from the UI, and token and admin key changes from the CLI, are appended to `audit_log` with the actor, channel, client address, and user agent. Details are ids and counts, never text, so forgetting stays sticky; triggers reject updates and deletes.

## Open questions

- **Cognition at low cost.** How do we build and maintain a model of the person without a dedicated extraction pipeline? For now, agents write cognition entries themselves when they notice something. Whether that is enough is still an open question.
- **Native memory interop.** Claude Code, ZCode, and Grok Build all keep a `MEMORY.md` index plus one Markdown file per memory. Two-way import/export with that layout is planned but not yet designed.
- **Change notification.** File watching is unreliable on some platforms. The MCP server syncs on demand, and the CLI on `origin sync`; a background watcher backed by a periodic full scan may still be needed, especially to push from devices whose agents are idle.
- **Remote curation.** The admin UI covers curation on the hub from a browser. Running `entries`, `correct`, and `forget` from a device's CLI against its hub, with the same preview-and-confirm flow as locally, is still open, as is a loopback-only `origin ui` on a device.

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
