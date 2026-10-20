# CLI reference

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
origin mcp                                             Run the MCP server over stdio (forwards to the hub when connected)

origin serve     [--host 127.0.0.1] [--port 7077]      Run this store as a personal hub (MCP over HTTP)
origin token     create <name> | list | revoke <name>  Manage the hub's access tokens (run on the hub)
origin hub       connect <url> --token <token> [--device <name>] | status | disconnect
origin push                                            Sync locally, push raw mirrors to the hub, pull tombstones
```

- **Time values** are relative durations (`30m`, `24h`, `7d`, `2w`) or dates (`YYYY-MM-DD`, ISO 8601).
- **Source ids** are `claude-code` and `codex` (plus `cursor`, `zcode`, and `grok` once their adapters ship).
- **Entry kinds** are `memory` (what happened), `knowledge` (stable facts), and `cognition` (your preferences, methods, goals, and boundaries).
- **Ids** look like `ent_5f0c2a9e41b7` for entries and `claude-code:<uuid>` or `codex:<session>:o12` for events.

## Searching

`search` looks in entries and in session messages. Results are ranked by relevance; `--recent` sorts by time instead, and `--all` also searches tool calls and their output. CJK text works too, as substrings.

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
```

## Inspecting

`show` prints an entry with its sources and version history, or an event with its raw locator: the original file, the mirror file and line, and the original line itself.

```console
$ origin show ent_5f0c2a9e41b7
Entry       ent_5f0c2a9e41b7  memory, active
Created     2026-10-20 10:42 by claude-code  confidence 0.9  project origin

No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.

Sources:
  [2026-10-20 10:01] claude-code origin user/message
      “not add migrations yet”
      ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
```

## Correcting and forgetting

`correct` adds a new version of an entry and keeps the old one as history. `forget` first shows what it will affect, and only acts with `--yes`:

```console
$ origin forget ent_5f0c2a9e41b7
This will forget 1 entry and 1 event:
  ent_5f0c2a9e41b7
  claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

Forgetting cannot be undone. Re-run with --yes to confirm.
```

The rules are described in [Privacy and your data](./privacy.md#forgetting).

## Personal hub

These commands run a [personal hub](./hub.md) and connect devices to it.

- On the hub, `origin serve` exposes `POST /mcp` and the replication API, and `GET /healthz` reports health without authentication. `origin token create <name>` prints a new token once (prefix `ogn_`); the hub stores only its hash.
- On a device, `origin hub connect` saves the hub's URL, a token, and the device name (by default the host name). `origin push` can be re-run at any time, and each push resumes where the previous one stopped.
- Once a device is connected, `origin mcp` forwards every tool call to the hub, after pushing new session lines.
- Curation commands (`entries`, `show`, `correct`, `forget`, …) act on the store they run against. On a connected device, that is the local staging copy.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Where Origin stores its database and raw mirrors |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory (sessions are read from `<dir>/projects`) |
| `ORIGIN_CLAUDE_PROJECTS` | — | Override the Claude Code projects directory directly |
| `CODEX_HOME` | `~/.codex` | Codex's home directory (rollouts are read from `sessions/` and `archived_sessions/`) |
| `ORIGIN_HUB_URL` | — | Hub URL; overrides `origin hub connect` |
| `ORIGIN_HUB_TOKEN` | — | Hub token; overrides `origin hub connect` |
| `ORIGIN_DEVICE` | host name | This device's name on the hub |
