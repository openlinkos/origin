# Origin

**Local-first, cross-agent personal memory for AI coding agents.**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Origin archives the sessions your AI agents already write to disk — Claude Code today; Codex, Cursor, ZCode, and Grok Build next — into a single local store. It lets you search them, walk them as a timeline, and trace any result back to the exact original line. Next, it will expose that memory to every agent through one [MCP](https://modelcontextprotocol.io) server, so whichever tool you open already knows what you decided last week, and why.

> **Status: early development.** Ingestion, search, timeline, and provenance work for Claude Code. The MCP server and the remaining adapters are in progress (see [Roadmap](#roadmap)). Packages are not yet published to npm; install from source.

## Why

If you use more than one AI agent, each one remembers on its own terms. Claude Code scopes memory to a git repository, Codex to a machine, and Copilot, ChatGPT, and Gemini to a cloud account. None of them can read the others' memory. Switch tools or projects and you start from zero. That memory is also hard to inspect and correct, and it gets purged quietly: Claude Code, for example, deletes session logs after 30 days by default.

Origin puts **you** at the center instead of the tool:

- **One archive across agents.** Sessions from every agent are normalized into one event store.
- **Provenance by default.** Every event points to the original file and line, and you can always see the raw source.
- **Nothing is lost to cleanup.** Logs are mirrored append-only, so they outlive the agent's own retention.
- **Local and private.** Everything stays on your machine. Origin makes no network calls and never calls an LLM API.
- **Correctable and forgettable** *(planned)*. Durable entries can be corrected or forgotten, and forgetting sticks.

## Features

- `origin sync`: incremental, idempotent ingestion. Only new bytes are read; rewritten files are detected and kept as a new generation.
- Full-text search over all sessions, including CJK substring search (SQLite FTS5 trigram).
- A timeline of sessions by day, or of the events inside one session.
- `origin show <event-id>`: the normalized event plus its raw locator and the original line.
- Zero runtime dependencies: Node.js built-ins only, including `node:sqlite`.

## Supported agents

| Agent | Status |
|---|---|
| Claude Code | ✅ Supported |
| Codex CLI | Planned |
| Cursor | Planned |
| ZCode | Planned |
| Grok Build | Planned |

Where each agent stores its sessions is documented in [docs/sources.md](docs/sources.md).

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

### Example

```console
$ origin sync
source       files  changed  lines  new events  parse errors  new gens  time
-----------  -----  -------  -----  ----------  ------------  --------  -----
claude-code  13     13       3755   1046        0             0         371ms

$ origin timeline --since 2d
2026-10-19
  11:41–11:42  claude-code my-app                  6 events  Check repository status
           ↳ 0f1e2d3c-4b5a-4697-8877-665544332211

$ origin search "repository status"
[2026-10-19 11:42] claude-code my-app user/message
    Check the repository status for me
    ↳ claude-code:22222222-2222-4222-8222-222222222222

$ origin show claude-code:22222222-2222-4222-8222-222222222222
Event    claude-code:22222222-2222-4222-8222-222222222222
Time     2026-10-19 11:42  (2026-10-19T03:42:00.000Z)
Source   claude-code  session 0f1e2d3c-4b5a-4697-8877-665544332211  version 2.1.303
...
Raw locator:
  original  ~/.claude/projects/-home-me-my-app/0f1e2d3c-….jsonl (generation 1)
  mirror    ~/.origin/raw/claude-code/-home-me-my-app/0f1e2d3c-….jsonl:5
```

## CLI reference

```text
origin sync      [--source <id>] [--verbose]          Ingest local agent sessions (idempotent, safe to re-run)
origin status                                          Per-source session/event counts and last sync
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                Events of one session (tool events hidden unless --all)
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--limit 20]
origin show      <event-id>                            Show an event, its raw locator, and the original line
origin projects                                        Known project names
```

Time values accept relative durations (`30m`, `24h`, `7d`, `2w`) or dates (`YYYY-MM-DD`, ISO 8601).

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Where Origin stores its database and raw mirrors |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory (sessions are read from `<dir>/projects`) |
| `ORIGIN_CLAUDE_PROJECTS` | — | Override the Claude Code projects directory directly |

## How it works

```
agent session logs ──scan──▶ append-only raw mirror ──deterministic parsing──▶ event store (SQLite + FTS5)
                                                                                   │
                                 agents ◀── MCP server (planned) ──────────────────┤
                                 you    ◀── origin CLI ────────────────────────────┘
```

Origin is built around five invariants: **provenance**, **sticky forgetting**, **append-only** storage, **local-first** data, and a **single entry point** (agents use MCP, people use the CLI). The core never calls a model. The agent that asks a question does the reasoning, and Origin supplies the facts and their sources. Read [docs/architecture.md](docs/architecture.md) for the data model, the ingestion algorithm, and the planned MCP tools.

## Privacy

Agent session logs often contain source code, file contents, command output, and anything you typed into a prompt — sometimes including secrets. Origin copies these logs into `~/.origin` so that they survive the agents' own cleanup. Keep in mind:

- Origin makes no network connections and sends nothing anywhere.
- Protect `~/.origin` the way you would protect the original logs. It is not encrypted.
- To remove everything Origin has stored, delete `~/.origin` (or your `ORIGIN_HOME`).

## Roadmap

Delivered as small, runnable increments, each usable on its own:

1. ✅ Core store, Claude Code adapter, and CLI (`sync`, `status`, `timeline`, `search`, `show`, `projects`)
2. MCP server with entries and tombstones (`search`, `timeline`, `get`, `sources`, `remember`, `correct`, `forget`), connected to Claude Code
3. Codex adapter
4. Cursor adapter
5. ZCode adapter
6. Grok Build adapter

**Known limitations today:**

- Many sessions have no title, because Claude Code writes `summary` lines for only some sessions.
- Search results are ordered by time, not relevance, and tool events can crowd them.
- The project name is the last segment of the working directory, not derived from the git remote.
- There is no file watching yet. Run `origin sync` manually or on a schedule.

## Project layout

```
packages/
├── core/       @openlinkos/origin-core      storage, schema, ingestion, queries
├── adapters/   @openlinkos/origin-adapters  per-agent session parsers
├── mcp/        @openlinkos/origin-mcp       MCP server (in progress)
└── cli/        @openlinkos/origin           the `origin` command
docs/
├── architecture.md                          design, data model, invariants
└── sources.md                               on-disk formats of supported agents
```

## Contributing

Contributions are welcome, especially new source adapters. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and how to add an adapter. To report a security or privacy issue, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © OpenLinkOS contributors
