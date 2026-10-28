<h1>
  <img alt="Origin" src="https://openlinkos.com/brand/origin/github/readme.svg" height="56">
</h1>

**Local-first, cross-agent personal memory for AI coding agents.**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Origin archives the sessions your AI agents already write to disk into a single local store. Claude Code, Codex, Cursor, Grok Build, and ZCode are supported. Through one [MCP](https://modelcontextprotocol.io) server, it gives every agent the same memory. Whichever tool you open can look up what you decided last week and why, trace it to the exact original line, and save what it learns for next time. If you work on several machines or with cloud agents, a self-hosted **personal hub** brings them all into the same memory.

> **Status: early (0.3).** Ingestion of Claude Code, Codex, Cursor, Grok Build, and ZCode sessions, the import of the memories Claude Code, ZCode, and Grok Build keep, the MCP server, the CLI, `origin ui`, and the personal hub with its admin UI, relays, and bucket storage work end to end. Before 1.0, a minor version may change the store format; stores are upgraded in place, and [Upgrading](https://origin.openlinkos.com/guide/upgrading) and the [changelog](CHANGELOG.md) say what to do.

## Why

If you use more than one AI agent, each one remembers on its own terms. Claude Code scopes memory to a git repository, Codex to a machine, and Copilot, ChatGPT, and Gemini to a cloud account. None of them can read the others' memory. Switch tools or projects and you start from zero. That memory is also hard to inspect and correct, and it gets purged quietly: Claude Code, for example, deletes session logs after 30 days by default.

Origin puts **you** at the center instead of the tool:

- **One memory across agents and machines.** Sessions from every agent are normalized into one event store, and any MCP-capable agent can query it. A self-hosted hub joins all your machines and cloud agents.
- **Provenance by default.** Every event points to the original file and line, and every entry cites the events it comes from.
- **Nothing is lost to cleanup.** Logs are mirrored append-only, so they outlive the agent's own retention.
- **Correctable and forgettable.** You can correct entries, and forgetting sticks: a forgotten entry or event stays hidden everywhere, and cannot be cited, until you restore it. Every forget is kept as a record with its reason.
- **Your data, your machines.** Everything stays on machines you control: your devices and, optionally, your own hub. Origin never calls a third-party service or an LLM API.

## Features

- **MCP server** (`origin mcp`) with eight tools: `brief`, `search`, `timeline`, `get`, `sources`, `remember`, `correct`, `forget`. It syncs automatically, so agents always see the latest sessions.
- **Entries** in three kinds: `memory` (what happened), `knowledge` (stable facts), and `cognition` (your preferences, methods, goals, and boundaries). Each carries its sources, a confidence, and a version history.
- **Native memory import.** The memory files that Claude Code, ZCode, and Grok Build keep for themselves are imported as entries, each citing the version of its file: when the agent changes a memory, the entry follows, and when it deletes one, the entry ends.
- **Recall.** When a session starts, and with each prompt, agents are handed what matters where they work: your preferences, the project's latest decisions and facts, its latest sessions with any agent, and the entries the prompt is about, one line each, chosen without a model. Claude Code and Codex get it through their hooks and other agents with the `brief` tool; `origin agents connect` sets this up. Every recall is recorded, so you can see what an agent was handed and whether it used it.
- **Relevance-ranked full-text search** across sessions and entries, including CJK substring search (SQLite FTS5 trigram).
- **Incremental, idempotent ingestion.** Only new bytes are read, rewritten files are kept as a new generation, compressed logs (zstd) are read transparently, and concurrent syncs are safe.
- **A CLI** to browse the timeline, inspect any entry or event down to its original line, correct entries, and forget and restore.
- **A personal hub** (`origin serve`, or the `ghcr.io/openlinkos/origin` image) that you host yourself. Every device keeps a complete memory of its own and sends the hub what it writes with `origin sync`; agents on a device read from both through their local `origin mcp`, and cloud agents connect over HTTP with a token. A machine with little disk can run as a relay that keeps no memory of its own and sends its agents' logs straight to the hub.
- **An admin UI for your hub** (`origin serve --admin`), off by default: an overview of devices and storage, your sessions and entries, search, correcting, forgetting with a preview and restoring what was forgotten, tokens with ready-made connection commands, and an audit log. Pages are rendered on the hub, and you sign in with the hub's admin password. On any machine, `origin ui` opens the same pages for its own store, on `127.0.0.1`, with a one-time sign-in link.

## Supported agents

| Agent | Sessions archived | Can use Origin over MCP |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex CLI | ✅ | ✅ |
| Cursor | ✅ | ✅ |
| ZCode | ✅ | ✅ |
| Grok Build | ✅ | ✅ |

Any MCP-capable agent can already query the archive and entries. Archiving an agent's own sessions needs its adapter. To register Origin with each agent, see [Connect your agents](docs/guide/connect-agents.md). Where each agent stores its sessions is documented in [docs/sources.md](docs/sources.md).

## Getting started

**Requirements:** Node.js 22.16 or later (24 LTS recommended).

```bash
npm install -g @openlinkos/origin

origin sync        # ingest local agent sessions into ~/.origin
origin status      # what has been ingested so far
```

To work on Origin itself, build it from source as described in [CONTRIBUTING.md](CONTRIBUTING.md).

### Connect Claude Code

Register the server once at user scope, so that every project shares the same memory:

```bash
claude mcp add --scope user origin -- origin mcp
claude mcp list         # origin: … ✔ Connected
```

On Windows, npm installs `origin` as a `.cmd` script that agents cannot start directly; register `cmd /c origin mcp` instead, for example `claude mcp add --scope user origin -- cmd /c origin mcp`.

Then ask in any session, for example: *"What did I decide about schema migrations in the origin project last week, and why? Cite your sources."* The agent searches Origin and answers with event ids, which you can open with `origin show <id>`. When it learns something worth keeping, it saves an entry with `remember`.

For Codex, Cursor, ZCode, and Grok Build, see [Connect your agents](docs/guide/connect-agents.md).

## Documentation

The full documentation lives in [`docs/`](docs/) and is published at [origin.openlinkos.com](https://origin.openlinkos.com):

- [Getting started](docs/guide/getting-started.md): install, archive your sessions, ask your first question
- [Concepts](docs/guide/concepts.md): sessions, entries, versions, validity, imported memories, and forgetting
- [Connect your agents](docs/guide/connect-agents.md): Claude Code, Codex, Cursor, ZCode, Grok Build, and the MCP tools they get
- [Personal hub](docs/guide/hub.md): one memory across your machines and cloud agents, self-hosted
- [Admin UI](docs/guide/admin.md): manage your hub in a browser: enable it, sign in, put it behind TLS, or keep it private
- [Privacy and your data](docs/guide/privacy.md): what Origin stores, how forgetting works, how to remove everything
- [Upgrading](docs/guide/upgrading.md): versions, image tags, store formats, and how to upgrade a device and a hub
- [Troubleshooting](docs/guide/troubleshooting.md): common problems and their fixes
- [CLI reference](docs/guide/cli.md): every command, with examples and environment variables
- [MCP tools](docs/guide/mcp.md): the eight tools agents use, their parameters, and what they return
- [Architecture](docs/architecture.md): data model, invariants, ingestion, entries, the MCP server, and the hub
- [Session sources](docs/sources.md): the on-disk formats of each agent, and of their memories
- [Changelog](CHANGELOG.md): what changed in each release

## How it works

```
agent session logs ──scan──▶ append-only raw mirror ──deterministic parsing──▶ event store (SQLite + FTS5)
                                                                                   │      ▲
                                                                                   │   entries · tombstones
                                 agents ◀── MCP server (origin mcp) ───────────────┤
                                 you    ◀── origin CLI ────────────────────────────┤
                                 you    ◀── admin UI on your hub ──────────────────┘
```

Origin is built around five invariants: **provenance**, **recorded forgetting**, **append-only** storage, **your data on your machines**, and a **single entry point** (agents use MCP; people use the CLI or the admin UI of their hub). The core never calls a model. The agent that asks a question does the reasoning, and Origin supplies the facts and their sources. Read [docs/architecture.md](docs/architecture.md) for the data model, the ingestion algorithm, the forgetting rules, and the MCP tools.

## Privacy

Agent session logs often contain source code, command output, and anything you typed into a prompt — sometimes including secrets. Origin copies them into `~/.origin` so that they survive the agents' own cleanup. Without a hub it makes no network connections; with a hub, data travels only between your devices and your own hub, which should sit behind TLS. The stores are not encrypted, so protect them like the original logs. `origin forget` hides an entry or a message everywhere until you restore it; deleting `~/.origin` (and your hub's data, if you run one) removes everything. Details: [Privacy and your data](docs/guide/privacy.md).

## Roadmap

Delivered as small, runnable increments, each usable on its own:

1. ✅ Core store, Claude Code adapter, and CLI (`sync`, `status`, `timeline`, `search`, `show`, `projects`)
2. ✅ MCP server, entries, correction, and forgetting; connected to Claude Code
3. ✅ Codex adapter, including zstd-compressed and archived rollouts
4. ✅ Personal hub: self-hosted, multi-device, remote MCP, with an admin UI
5. ✅ Grok Build adapter
6. ✅ ZCode adapter, reading its SQLite database
7. ✅ Cursor adapter: editor conversations and CLI transcripts

**Known limitations today:**

- Many sessions have no title, because Claude Code writes `summary` lines for only some sessions.
- The project name is the last segment of the working directory, not derived from the git remote.
- Forgetting hides data but does not erase it from the raw mirror files.
- From agents that keep sessions in a database (ZCode, the Cursor editor), each message is archived once, when it has settled; later changes to it are not.
- Origin does not watch files on its own. While an agent runs, its MCP server checks for new lines every minute and once more when the agent exits; otherwise run `origin sync`, which also syncs with your hub.
- On a device, CLI curation commands act on that device's own entries; the hub's admin UI shows and curates the entries of every device.

## Project layout

```
packages/
├── core/       @openlinkos/origin-core      storage, ingestion, entries, forgetting, queries
├── adapters/   @openlinkos/origin-adapters  per-agent session parsers
├── mcp/        @openlinkos/origin-mcp       MCP tools, stdio and HTTP servers, merged reads on a connected device
├── admin/      @openlinkos/origin-admin     the hub's admin UI: server-rendered pages and a JSON API
└── cli/        @openlinkos/origin           the `origin` command and the hub (`origin serve`)
docs/                                        documentation site (VitePress)
├── guide/                                   user guides (English; Chinese under docs/zh/)
├── architecture.md                          design, data model, invariants
└── sources.md                               agent session formats
```

## Contributing

Contributions are welcome, especially new source adapters. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and how to add an adapter. To report a security or privacy issue, follow [SECURITY.md](SECURITY.md). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © OpenLinkOS contributors
