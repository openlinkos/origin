# Getting started

Origin runs on your machine. It reads the session logs your AI agents already write to disk, archives them in `~/.origin`, and serves them to every agent through one [MCP](https://modelcontextprotocol.io) server. If you use agents on several machines, a self-hosted [personal hub](./hub.md) can bring them together later.

::: warning Early version
Origin is at 0.1. Until 1.0, a new minor version may change the store format; its [release notes](https://github.com/openlinkos/origin/blob/master/CHANGELOG.md) say what to do.
:::

## Requirements

- Node.js 22.16 or later (24 LTS recommended)
- At least one supported agent: Claude Code, Codex CLI, Cursor, Grok Build, or ZCode.

## Install

```bash
npm install -g @openlinkos/origin
origin --version
```

This puts the `origin` command on your `PATH`. To work on Origin itself, build it from source as described in [CONTRIBUTING.md](https://github.com/openlinkos/origin/blob/master/CONTRIBUTING.md).

## Archive your sessions

```bash
origin sync      # ingest local agent sessions into ~/.origin
origin status    # sessions, events, and entries per source
origin timeline  # sessions from the last 7 days
```

`sync` is incremental and safe to re-run. When agents use Origin over MCP, the server syncs on its own, so you rarely need to run `sync` by hand.

## Connect an agent

Register Origin once, at user scope, so that every project shares the same memory. For Claude Code:

```bash
claude mcp add --scope user origin -- origin mcp
claude mcp list   # origin: … ✔ Connected
```

On Windows, npm installs `origin` as a `.cmd` script that agents cannot start directly; register `cmd /c origin mcp` instead, for example `claude mcp add --scope user origin -- cmd /c origin mcp`.

Other agents are covered in [Connect your agents](./connect-agents.md).

## Ask

Start a new session and ask about your past work, for example:

> What did I decide about schema migrations in the origin project last week, and why? Cite your sources.

The agent searches Origin and answers with entry and event ids. To read the original, run `origin show <id>`. When the agent learns something worth keeping (a decision and its reason, a stable fact, or one of your preferences), it saves an **entry** with `remember`.

## Curate your memory

```bash
origin entries                           # what agents have remembered
origin show ent_5f0c2a9e41b7             # an entry with its sources and history
origin correct ent_5f0c2a9e41b7 "…"      # replace it with a corrected version
origin forget ent_5f0c2a9e41b7 --yes     # forget it for good
```

See the [CLI reference](./cli.md) for every command, and [Privacy and your data](./privacy.md) for what Origin stores and how forgetting works.
