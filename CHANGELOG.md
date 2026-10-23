# Changelog

All notable changes to Origin are listed here. Versions follow [Semantic Versioning](https://semver.org); before 1.0, a minor version may change the store format or a public interface, and its notes say what to do. The five packages (`@openlinkos/origin` and `@openlinkos/origin-core`, `-adapters`, `-mcp`, `-admin`) are released together under one version.

## [Unreleased]

### Archive and search

- Archives Grok Build sessions (source id `grok`): the update stream of each session under `~/.grok/sessions/` (or `$GROK_HOME`).
- Archives ZCode sessions (source id `zcode`) from its SQLite database, `~/.zcode/cli/db/db.sqlite`, opened read-only: each message once it has settled, with its parts, as one mirrored line.
- Archives Cursor sessions (source id `cursor`): the conversations of the editor, from its `state.vscdb` opened read-only, and the transcripts under `~/.cursor/projects/`.
- Adapters can generate the lines of a source that is not a log file, such as a database; Origin mirrors and ingests them like a file's.

### Admin UI

- `origin ui` serves the admin UI for the store on your own machine, on 127.0.0.1 only: it signs your browser in with a one-time link instead of a password, leaves out what only a hub has, and on a device connected to a hub syncs what you write and forget there in the background.

### Personal hub

- Relay mode for machines with little disk: `origin hub connect … --relay` makes an empty store a relay, which keeps only cursors, sends its agents' logs to the hub straight from the logs, and answers every MCP tool and CLI query through the hub.
- A hub can keep the sealed frames of its raw mirrors in an S3-compatible bucket such as MinIO (`origin serve --raw-s3-endpoint … --raw-s3-bucket …`, or `ORIGIN_RAW_S3_*`, with `*_FILE` for keys mounted from a Secret); `origin raw upload` moves the frames already on disk, verified, 8 at a time (`--concurrency`), and `origin backup` copies them back into the backup.
- `origin status` and `origin hub status` show when the device last finished a sync with its hub, and the error of the last sync if it failed since.

## [0.1.0] - 2026-10-23

The first release.

### Archive and search

- Archives Claude Code and Codex CLI sessions into one append-only store under `~/.origin` (or `$ORIGIN_HOME`). Ingestion is incremental and idempotent, keeps rewritten files as new generations, and reads zstd-compressed Codex rollouts.
- Raw mirrors are stored in seekable zstd frames; every event points to its original file and line.
- Full-text search over sessions and entries: every term must match, as a case-insensitive substring, including CJK words of one or two characters; results are ranked by relevance or ordered by time.

### Entries and forgetting

- Entries of three kinds, `memory`, `knowledge`, and `cognition`, each citing the events it comes from, with a confidence and a version history.
- `correct` supersedes an entry; concurrent corrections from different stores converge on the newest.
- `forget` hides an entry or event for good, on every store, and nothing can cite it again.

### Agents

- `origin mcp`: an MCP server over stdio with seven tools, `search`, `timeline`, `get`, `sources`, `remember`, `correct`, and `forget`. It syncs when an agent starts, before reads, after writes, every minute while the agent runs, and once more when it exits.

### Personal hub

- `origin serve` (also the `ghcr.io/openlinkos/origin` image): a self-hosted, single-tenant hub that gathers your devices and serves MCP over HTTP to cloud agents.
- Every device stays a complete store of its own. `origin sync` sends its raw mirrors, entries, and tombstones to the hub and brings back what was forgotten elsewhere; agents on a device read both stores at once and fall back to the device when the hub does not answer.
- Hub tokens are bound to the device they are named after.
- An admin UI for the hub's owner, off by default (`origin serve --admin`): devices, storage, sessions, search, entries, correcting and forgetting with a preview, tokens with ready-made connection commands, and an audit log, behind one admin password.

### Tooling

- `origin backup <dir>` copies a store consistently while agents keep writing.
- Requires Node.js 22.16 or later.

[0.1.0]: https://github.com/openlinkos/origin/releases/tag/v0.1.0
