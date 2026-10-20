# Origin

**Local-first, cross-agent personal memory for AI coding agents.**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Origin archives the sessions your AI agents already write to disk into a single local store. Claude Code is supported today; Codex, Cursor, ZCode, and Grok Build are next. Through one [MCP](https://modelcontextprotocol.io) server, it gives every agent the same memory. Whichever tool you open can look up what you decided last week and why, trace it to the exact original line, and save what it learns for next time.

> **Status: early development.** Ingestion of Claude Code sessions, the MCP server, and the CLI work end to end. The other agents' adapters are in progress (see [Roadmap](#roadmap)). Packages are not yet published to npm; install from source.

## Why

If you use more than one AI agent, each one remembers on its own terms. Claude Code scopes memory to a git repository, Codex to a machine, and Copilot, ChatGPT, and Gemini to a cloud account. None of them can read the others' memory. Switch tools or projects and you start from zero. That memory is also hard to inspect and correct, and it gets purged quietly: Claude Code, for example, deletes session logs after 30 days by default.

Origin puts **you** at the center instead of the tool:

- **One memory across agents.** Sessions from every agent are normalized into one event store, and any MCP-capable agent can query it.
- **Provenance by default.** Every event points to the original file and line, and every entry cites the events it comes from.
- **Nothing is lost to cleanup.** Logs are mirrored append-only, so they outlive the agent's own retention.
- **Correctable and forgettable.** You can correct entries, and forgetting sticks. A forgotten entry or event never shows up again and can never be cited again.
- **Local and private.** Everything stays on your machine. Origin makes no network calls and never calls an LLM API.

## Features

- **MCP server** (`origin mcp`) with seven tools: `search`, `timeline`, `get`, `sources`, `remember`, `correct`, `forget`. It syncs automatically, so agents always see the latest sessions.
- **Entries** in three kinds: `memory` (what happened), `knowledge` (stable facts), and `cognition` (your preferences, methods, goals, and boundaries). Each carries its sources, a confidence, and a version history.
- **Relevance-ranked full-text search** across sessions and entries, including CJK substring search (SQLite FTS5 trigram).
- **Incremental, idempotent ingestion.** Only new bytes are read, rewritten files are kept as a new generation, and concurrent syncs are safe.
- **A CLI** to browse the timeline, inspect any entry or event down to its original line, correct entries, and forget.

## Supported agents

| Agent | Sessions archived | Can use Origin over MCP |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex CLI | Planned | ✅ |
| Cursor | Planned | ✅ |
| ZCode | Planned | ✅ |
| Grok Build | Planned | ✅ |

Any MCP-capable agent can already query the archive and entries. Archiving an agent's own sessions needs its adapter. Where each agent stores its sessions, and how to register Origin with it, is documented in [docs/sources.md](docs/sources.md).

## Getting started

**Requirements:** Node.js 22.13 or later (24 LTS recommended) and pnpm (`corepack enable` installs the pinned version).

```bash
git clone https://github.com/openlinkos/origin.git
cd origin
pnpm install
pnpm build

pnpm origin sync        # ingest local agent sessions into ~/.origin
pnpm origin status      # what has been ingested so far
```

`pnpm origin <command>` runs `node packages/cli/dist/bin.js <command>`; you can alias the latter as `origin`.

### Connect Claude Code

Register the server once at user scope, so that every project shares the same memory:

```bash
claude mcp add --scope user origin -- node /absolute/path/to/origin/packages/cli/dist/bin.js mcp
claude mcp list         # origin: … ✔ Connected
```

Then ask in any session, for example: *"What did I decide about schema migrations in the origin project last week, and why? Cite your sources."* The agent searches Origin and answers with event ids, which you can open with `origin show <id>`. When it learns something worth keeping, it saves an entry with `remember`.

For Codex, Cursor, ZCode, and Grok Build, see [docs/sources.md](docs/sources.md#connecting-agents-to-origin).

### Example

```console
$ origin search "schema migrations"
Entries:
[2026-10-20 10:42] memory, conf 0.9, origin
    No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
    ↳ ent_5f0c2a9e41b7

Events:
[2026-10-20 10:01] claude-code origin user/message
    Let's not add [migrations] yet — we're early. Just test in a fresh temp folder.
    ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

1 entry, 1 event. Details: origin show <id>

$ origin show ent_5f0c2a9e41b7
Entry       ent_5f0c2a9e41b7  memory, active
Created     2026-10-20 10:42 by claude-code  confidence 0.9  project origin

No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.

Sources:
  [2026-10-20 10:01] claude-code origin user/message
      “not add migrations yet”
      ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

$ origin forget ent_5f0c2a9e41b7
This will forget 1 entry and 1 event:
  ent_5f0c2a9e41b7
  claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

Forgetting cannot be undone. Re-run with --yes to confirm.
```

## CLI reference

```text
origin sync      [--source <id>] [--verbose]          Ingest local agent sessions (idempotent, safe to re-run)
origin status                                          Per-source counts, entries, and last sync
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                Events of one session (tool events hidden unless --all)
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id>                                  Show an entry or an event, with its original source
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> [--reason <text>] [--yes]        Forget an entry or event for good (needs --yes)
origin projects                                        Known project names
origin mcp                                             Run the MCP server over stdio (for agents)
```

Time values accept relative durations (`30m`, `24h`, `7d`, `2w`) or dates (`YYYY-MM-DD`, ISO 8601). Entry kinds are `memory`, `knowledge`, and `cognition`.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Where Origin stores its database and raw mirrors |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory (sessions are read from `<dir>/projects`) |
| `ORIGIN_CLAUDE_PROJECTS` | — | Override the Claude Code projects directory directly |

## How it works

```
agent session logs ──scan──▶ append-only raw mirror ──deterministic parsing──▶ event store (SQLite + FTS5)
                                                                                   │      ▲
                                                                                   │   entries · tombstones
                                 agents ◀── MCP server (origin mcp) ───────────────┤
                                 you    ◀── origin CLI ────────────────────────────┘
```

Origin is built around five invariants: **provenance**, **sticky forgetting**, **append-only** storage, **local-first** data, and a **single entry point** (agents use MCP, people use the CLI). The core never calls a model. The agent that asks a question does the reasoning, and Origin supplies the facts and their sources. Read [docs/architecture.md](docs/architecture.md) for the data model, the ingestion algorithm, the forgetting rules, and the MCP tools.

## Privacy

Agent session logs often contain source code, file contents, command output, and anything you typed into a prompt — sometimes including secrets. Origin copies these logs into `~/.origin` so that they survive the agents' own cleanup. Keep in mind:

- Origin makes no network connections and sends nothing anywhere.
- Protect `~/.origin` the way you would protect the original logs. It is not encrypted.
- `origin forget <event-id>` hides a message for good. For example, use it on a prompt where you pasted a secret. The raw mirror file still holds the line on disk.
- To remove everything Origin has stored, delete `~/.origin` (or your `ORIGIN_HOME`).

## Roadmap

Delivered as small, runnable increments, each usable on its own:

1. ✅ Core store, Claude Code adapter, and CLI (`sync`, `status`, `timeline`, `search`, `show`, `projects`)
2. ✅ MCP server, entries, correction, and sticky forgetting; connected to Claude Code
3. Codex adapter
4. Cursor adapter
5. ZCode adapter
6. Grok Build adapter

**Known limitations today:**

- Many sessions have no title, because Claude Code writes `summary` lines for only some sessions.
- The project name is the last segment of the working directory, not derived from the git remote.
- Forgetting hides data but does not erase it from the raw mirror files.
- There is no background file watching. The MCP server syncs on demand; otherwise run `origin sync`.

## Project layout

```
packages/
├── core/       @openlinkos/origin-core      storage, ingestion, entries, forgetting, queries
├── adapters/   @openlinkos/origin-adapters  per-agent session parsers
├── mcp/        @openlinkos/origin-mcp       MCP server (stdio)
└── cli/        @openlinkos/origin           the `origin` command
docs/
├── architecture.md                          design, data model, invariants
└── sources.md                               agent session formats and MCP setup
```

## Contributing

Contributions are welcome, especially new source adapters. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and how to add an adapter. To report a security or privacy issue, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © OpenLinkOS contributors
