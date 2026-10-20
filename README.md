# Origin

**Local-first, cross-agent personal memory for AI coding agents.**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Origin archives the sessions your AI agents already write to disk into a single local store. Claude Code and Codex are supported today; Cursor, ZCode, and Grok Build are next. Through one [MCP](https://modelcontextprotocol.io) server, it gives every agent the same memory. Whichever tool you open can look up what you decided last week and why, trace it to the exact original line, and save what it learns for next time.

> **Status: early development.** Ingestion of Claude Code and Codex sessions, the MCP server, and the CLI work end to end. The other agents' adapters are in progress (see [Roadmap](#roadmap)). Packages are not yet published to npm; install from source.

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
- **Incremental, idempotent ingestion.** Only new bytes are read, rewritten files are kept as a new generation, compressed logs (zstd) are read transparently, and concurrent syncs are safe.
- **A CLI** to browse the timeline, inspect any entry or event down to its original line, correct entries, and forget.

## Supported agents

| Agent | Sessions archived | Can use Origin over MCP |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex CLI | ✅ | ✅ |
| Cursor | Planned | ✅ |
| ZCode | Planned | ✅ |
| Grok Build | Planned | ✅ |

Any MCP-capable agent can already query the archive and entries. Archiving an agent's own sessions needs its adapter. To register Origin with each agent, see [Connect your agents](docs/guide/connect-agents.md). Where each agent stores its sessions is documented in [docs/sources.md](docs/sources.md).

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

For Codex, Cursor, ZCode, and Grok Build, see [Connect your agents](docs/guide/connect-agents.md).

## Documentation

The full documentation lives in [`docs/`](docs/) and is published at [origin.openlinkos.com](https://origin.openlinkos.com):

- [Getting started](docs/guide/getting-started.md): install, archive your sessions, ask your first question
- [Connect your agents](docs/guide/connect-agents.md): Claude Code, Codex, Cursor, ZCode, Grok Build, and the MCP tools they get
- [CLI reference](docs/guide/cli.md): every command, with examples and environment variables
- [Privacy and your data](docs/guide/privacy.md): what Origin stores, how forgetting works, how to remove everything
- [Architecture](docs/architecture.md): data model, invariants, ingestion, entries, and the MCP server
- [Session sources](docs/sources.md): the on-disk formats of each agent

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

Agent session logs often contain source code, command output, and anything you typed into a prompt — sometimes including secrets. Origin copies them into `~/.origin` so that they survive the agents' own cleanup. It makes no network connections, and the directory is not encrypted, so protect it like the original logs. `origin forget` hides an entry or a message for good; deleting `~/.origin` removes everything. Details: [Privacy and your data](docs/guide/privacy.md).

## Roadmap

Delivered as small, runnable increments, each usable on its own:

1. ✅ Core store, Claude Code adapter, and CLI (`sync`, `status`, `timeline`, `search`, `show`, `projects`)
2. ✅ MCP server, entries, correction, and sticky forgetting; connected to Claude Code
3. ✅ Codex adapter, including zstd-compressed and archived rollouts
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
docs/                                        documentation site (VitePress)
├── guide/                                   user guides (English; Chinese under docs/zh/)
├── architecture.md                          design, data model, invariants
└── sources.md                               agent session formats
```

## Contributing

Contributions are welcome, especially new source adapters. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and how to add an adapter. To report a security or privacy issue, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © OpenLinkOS contributors
