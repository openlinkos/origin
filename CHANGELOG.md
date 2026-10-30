# Changelog

All notable changes to Origin are listed here. Versions follow [Semantic Versioning](https://semver.org); before 1.0, a minor version may change the store format or a public interface, and its notes say what to do. The five packages (`@openlinkos/origin` and `@openlinkos/origin-core`, `-adapters`, `-mcp`, `-admin`) are released together under one version.

## [0.4.0] - 2026-10-30

Hands your agents what matters without being asked, connects the agents on a machine with one command, and redesigns the admin UI as a workbench that adapts to every window.

**Upgrading.** The store format stays at version 4; the first time this version opens a store, it adds the tables of recalls. Upgrade the hub before its devices: a hub of 0.3 refuses the recalls a device sends, and they wait on the device until the hub is upgraded. Agents that use Origin's MCP server see the new `brief` tool once they restart.

### Recall

- Recall hands an agent what matters where it works, without being asked: when a session starts, a brief of the user's preferences, the project's latest decisions and facts, and its latest sessions with any agent; with each prompt, the entries whose first line shares rare enough words with it. Matching is lexical and calls no model, a brief stays within about 800 tokens and a prompt's matches within 400, and an agent is not handed the memories it loads from its own files. Claude Code and Codex run it from their `SessionStart` and `UserPromptSubmit` hooks (`origin recall --hook claude-code`, or `codex`); the Recall page of the guide shows how to set them up.
- Every recall is recorded, by id and never by text: `origin recalls` lists them, and `origin show rcl_…` shows one, with the prompt it answered and the items the session went on to use. `origin recall` alone previews what an agent would be handed, and records nothing.
- Origin's MCP server has an eighth tool, `brief`, which hands an agent the same brief, and with `about` the entries that match it, for agents whose hooks cannot hand anything over: Grok Build, ZCode, and Cursor. The server's instructions tell agents to call it when they start a task, unless a recall already gave them one. Each call is recorded as a recall, and its session is found from the recall's id in the agent's log.
- The admin UI has a Recalls page: each recall with what it handed over, as it is now, and whether the session used it. An entry's page lists the recalls that handed it over, and a session's page shows each recall in its turn.
- `origin agents` shows how each agent on the machine is connected. `origin agents connect` registers Origin's MCP server with each, and adds the recall hooks to Claude Code and Codex: it shows the changes first, and makes them with `--yes`, backing up each file, touching only Origin's own entries. `origin agents disconnect` removes them.
- A device sends the recalls it made to its hub when it syncs, so the hub holds every device's. Upgrade the hub first: one from before recalls refuses them, and they wait on the device until it is upgraded.

### Admin UI

- The admin UI, on a hub and with `origin ui`, is laid out as a workbench: a sidebar with counts, a bar at the top with breadcrumbs, search, and on a device a way to its hub, and denser pages, in version 0.6.1 of the OpenLinkOS design system.
- It adapts to the window instead of squeezing pages. Between 860 and 1200 pixels the sidebar is a column of icons; narrower, it opens from a menu button. A list's filters, a session's turns, and a page's details fold into panes that open from a button, or below the content, rather than disappearing; the filters that are on show above a list as tags that remove them; wide tables become rows that name each value; and chart labels keep their size at every width. The theme, the language, and signing out moved into a Preferences menu at the foot of the sidebar.
- The overview is a dashboard: figures with the last 30 days under each, events per day by agent, how recalls went by occasion, recent sessions, active projects, the agents, and the state of the store.
- Sessions, entries, and recalls are lists with filters on the left, each with how many it would leave, and time ranges above; sessions and recalls have a histogram of the last 30 days by agent, and sessions can be sorted by latest activity, events, or length. Links that filtered the timeline by `source` still work.
- A session's page is a trace: an outline of its turns with their tool calls, failures, recalls, and durations, which can be narrowed to the turns with recalls or with failures; the turn shown opens into its steps, placed in time, and is shown in full beside the outline. The index of days and the expanded view are gone.
- A recall's page shows the text the agent was handed, rebuilt from the store as it is now, how its budget was spent, and the other recalls of its session.
- A device's page lists its files 50 at a time, the most recently updated first, by file name with the folder under it, instead of all at once.

## [0.3.0] - 2026-10-24

Imports the memories your agents keep for themselves, leaves ended entries out of search, and documents versions and upgrades on the site.

**Upgrading.** A store is upgraded in place the first time this version opens it (format version 4). Upgrade the hub before its devices: a hub of 0.2 mirrors the memory streams a device sends without reading them, and reads them once it is upgraded, but until then a device's corrections of imported entries wait for it.

### Memory

- Imports the memories agents keep for themselves as entries: the memory files of Claude Code (`~/.claude/projects/<project>/memory/`), ZCode (`~/.zcode/cli/memories/`), and Grok Build (`~/.grok/memory-v2/`, and `~/.grok/memory/` of earlier versions), read and never written. Each version of a file becomes a version of one entry, citing that version of the file as its source; a deleted file ends its entry, and a file that comes back makes it current again. Every store that has a memory stream derives the same entries from it, a hub from what its devices and relays send, so these entries are never sent. MCP results, the CLI, and the admin UI mark them as imported, and a later change of the file supersedes a correction made in Origin.
- Entries whose validity has ended (their `valid_to` has passed), such as an imported memory whose file was deleted, are left out of search and listings unless history is requested; `get` and `origin show` still show them.

### Personal hub

- The image's `latest` tag now follows releases, and the new `edge` tag the latest commit on `master`; `latest` used to follow `master`. Pin a minor version, such as `0.3`, to choose when your hub upgrades.

### Documentation

- New pages on the site: Concepts, MCP tools, Upgrading (versions, image tags, store formats), Troubleshooting, and this changelog, which the version in the site's navigation links to.

### Fixes

- A forget made on one store before another store had the entry or event it targets now covers them there once they arrive; entries imported from native memories have the same id on every store, so they can be forgotten on a device before its hub derives them.

## [0.2.0] - 2026-10-24

Five agents archived instead of two, a local admin UI, relays, restorable forgetting, and versioned stores.

**Upgrading.** A store is upgraded in place the first time Origin 0.2 opens it; to be safe, back it up first with `origin backup <dir>`. Upgrade the hub before its devices, since Origin 0.1 ignores restores, and do not go back to 0.1 on an upgraded store. Re-register nothing: `origin mcp` keeps its name and tools (`forget` now requires a reason).

### Archive and search

- Archives Grok Build sessions (source id `grok`): the update stream of each session under `~/.grok/sessions/` (or `$GROK_HOME`).
- Archives ZCode sessions (source id `zcode`) from its SQLite database, `~/.zcode/cli/db/db.sqlite`, opened read-only: each message once it has settled, with its parts, as one mirrored line.
- Archives Cursor sessions (source id `cursor`): the conversations of the editor, from its `state.vscdb` opened read-only, and the transcripts under `~/.cursor/projects/`.
- Adapters can generate the lines of a source that is not a log file, such as a database; Origin mirrors and ingests them like a file's.
- Sessions get their titles again from Claude Code 2.1, which writes `ai-title` lines, and a name given with `/rename` takes precedence over the generated title; upgrading a store titles the Claude Code sessions it already holds, on devices and hubs. Grok Build sessions are titled from their `summary.json`. A session without a title, such as every Codex session, has its first prompt as a provisional name (`prompt`, next to `title`, in the MCP `timeline` and `origin timeline`), and `origin status` counts the titled sessions.

### Admin UI

- A session's page shows it turn by turn: each prompt, or command the agent acted on, with the agent's tool calls folded into one line (calls per tool, failures) that opens to a row per call, and the agent's reply rendered as Markdown, tables included; other commands and injected context appear as small notes, long sessions are paged by turns with an index of days, and only the events of the turns shown are read. The timeline groups sessions by day, names untitled ones by their first prompt, and filters by name; the overview adds a 30-day activity chart by agent, recent sessions, the most active projects, each agent's version and last ingestion, the latest entries and forgets, and where the raw mirrors are stored.
- `origin ui` serves the admin UI for the store on your own machine, on 127.0.0.1 only: it signs your browser in with a one-time link instead of a password, leaves out what only a hub has, and on a device connected to a hub syncs what you write and forget there in the background.
- `origin ui` prints and opens a new sign-in link when you press Enter in its terminal, and the previous one stops working; and when it starts, it ingests this machine's agent sessions in the background, as `origin sync --local` does, while the UI can already be used.
- The admin UI takes its chips, folds, turn cards, event links, compact lists, share meters, activity chart and its colours, and Markdown prose from version 0.3.0 of the OpenLinkOS design system (`@openlinkos/ui`) instead of styling its own: links in the agent's messages are underlined, event links are easier to see and to hit, and the chart's colours change slightly.

### Forgetting

- A forget is now a record that the owner can restore at any time: `forget` requires a reason everywhere (MCP, CLI, admin UI) and records its author, `origin restore` and the admin UI's Forgotten page restore it with a reason (agents cannot), the page shows the owner what a forget hides, and `origin forgotten` lists forgets and restores. A restore is a tombstone whose target is the forget, and replicates like one; upgrade the hub before its devices, since Origin 0.1 ignores restores. Forgetting in the admin UI no longer asks to type the id or the password again.

### Personal hub

- Relay mode for machines with little disk: `origin hub connect … --relay` makes an empty store a relay, which keeps only cursors, sends its agents' logs to the hub straight from the logs, and answers every MCP tool and CLI query through the hub.
- A hub can keep the sealed frames of its raw mirrors in an S3-compatible bucket such as MinIO (`origin serve --raw-s3-endpoint … --raw-s3-bucket …`, or `ORIGIN_RAW_S3_*`, with `*_FILE` for keys mounted from a Secret); `origin raw upload` moves the frames already on disk, verified, 8 at a time (`--concurrency`), and `origin backup` copies them back into the backup.
- `origin status` and `origin hub status` show when the device last finished a sync with its hub, and the error of the last sync if it failed since.
- A relay warns before agents delete logs it has not sent: `origin status`, `origin sync`, and `origin mcp` (in its log and in the errors of tools the hub cannot answer) say when unsent sessions near Claude Code's `cleanupPeriodDays` (30 days unless set), or, for other agents, have waited a week with nothing sent.

### Tooling

- Stores record their format version and are upgraded in place, once, when a newer Origin opens them, stores of 0.1.0 included; Origin refuses a store whose format is newer than it knows.

### Fixes

- A device no longer gives up pushing a file that another of its processes (`origin sync` and an agent's `origin mcp`) is pushing at the same time, and neither does a relay.
- A device sends the agent version it recorded for a file's events with the file, so a hub records the same version for agents whose logs carry none (Grok Build, Cursor).
- A tool call that gets several results, such as a Claude Code background agent's, keeps them all instead of showing the later ones as a call named `?`.

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

[Unreleased]: https://github.com/openlinkos/origin/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/openlinkos/origin/releases/tag/v0.3.0
[0.2.0]: https://github.com/openlinkos/origin/releases/tag/v0.2.0
[0.1.0]: https://github.com/openlinkos/origin/releases/tag/v0.1.0
