# Concepts

This page explains how Origin remembers: what it keeps, how what agents learn becomes durable, and how you stay in control of it. It assumes you have read [Getting started](./getting-started.md). For the full design, see [Architecture](../architecture.md).

## Sessions and events

Every supported agent (Claude Code, Codex, Cursor, Grok Build, ZCode) already writes its conversations to disk. Origin reads them and keeps two things:

- **Raw mirrors**: append-only copies of the original logs, stored compressed under `~/.origin/raw/`. They outlive the agent's own cleanup, and they are never rewritten.
- **Events**: each message, tool call, and tool result, normalized across agents, grouped into **sessions**, and indexed for search. Every event points to the line of the mirror it came from.

That pointer is **provenance**: any answer Origin gives can be expanded down to the original text, with `origin show <id>`, the MCP `sources` tool, or the event's page in the [admin UI](./admin.md). Origin never summarizes or rewrites what was said, and it never calls a model to do so.

## Entries

Sessions record everything; **entries** record what is worth keeping. An entry is one self-contained statement that an agent saves with `remember` when it learns something that will matter later, or that you write from the CLI or the admin UI. There are three kinds:

| Kind | What it holds | Example |
|---|---|---|
| `memory` | What happened: a decision and its reason | "Dropped schema versioning until the first release, to keep the code simple." |
| `knowledge` | A stable fact | "The demo app deploys from the `main` branch through CI." |
| `cognition` | Something about you: a preference, a method, a goal, a boundary | "Prefers commit messages without attribution trailers." |

Every entry also has:

- **Sources**: at least one event it is based on, optionally with the exact words it quotes. An entry without a source cannot be saved.
- **An author**: `<agent>@<device>` for an agent, such as `claude-code@laptop`, or `user@<device>` when you wrote it.
- **A confidence** between 0 and 1, and optionally a **project**.

Agents find entries with `search` and read them with `get`; any agent connected to Origin sees what the others remembered.

## Versions and corrections

Entries are never edited in place. Correcting one, with `origin correct`, the admin UI, or an agent's `correct`, adds a new version that replaces it; the old version stays in the entry's history, with its sources carried over. Search and listings show the current version, and the history shows them all:

```bash
origin show ent_5f0c2a9e41b7        # the entry, its sources, and its versions
origin entries --history            # every version, superseded and ended ones included
```

If two of your machines correct the same version before they hear of each other, both corrections are kept and every store settles on the same one, the later, as current; the other is marked as having lost to a concurrent correction.

## Validity

An entry can say when it holds, with `valid_from` and `valid_to`. Once its `valid_to` has passed, the entry has **ended**: it is history rather than current knowledge. Ended entries are left out of search and listings, so agents are not handed what no longer holds, but they stay in the history, and `origin show` and the MCP `get` tool still show them by id.

## Native memories

Claude Code, ZCode, and Grok Build keep memories of their own: Markdown files the agent writes and rewrites, one note per file, in a directory per project or workspace. Origin imports them as entries, one way: it reads the files and never writes them, so that what one agent remembered reaches every agent, with its provenance. Each layout is described in [Session sources](../sources.md#native-memories).

- **One entry per memory file.** Each version of the file becomes a version of the entry, citing that version of the file as its source. The memory's type gives the entry's kind: what you are like or asked for becomes `cognition`, what happened in a project `memory`, the rest `knowledge`.
- **A deleted file ends its entry.** Its last version stays in the history, with its validity ended at the deletion; if the file comes back, the entry is current again.
- **The file has the last word.** You can correct an imported entry in Origin, but when the file changes after your correction, the new version of the file replaces it. To change what the agent itself remembers, edit its file.
- **Forgetting hides it in Origin only.** A forgotten imported entry stays hidden as its file changes, but the agent's file is left as it is: edit or delete the file too if the agent should stop using it.

Imported entries are marked as such in MCP results, the CLI, and the admin UI. See [Native memories](../architecture.md#native-memories) in the architecture for how they are derived.

## Forgetting and restoring

Forgetting hides an entry or an event everywhere: from search, timelines, and every MCP tool, on this machine and, as the forget reaches them, on your hub and your other devices. Forgetting an entry hides every version of it and the events it cites; forgetting an event hides it and every entry based on it. Re-syncing never brings anything back.

Every forget needs a reason and is kept as a record, with when, where, and by whom it was made. An agent may forget, but only when you ask, and it must give your reason. Only you can **restore** a forget, with a reason of your own, from the CLI or the admin UI; the restore is a record too, so the history of what was forgotten and brought back stays complete.

Forgetting hides; it does not erase. The raw mirrors keep the original lines, which is what makes a restore possible. See [Privacy and your data](./privacy.md#forgetting) for the commands, and [Forgetting](../architecture.md#forgetting) in the architecture for the exact rules.

## Devices, hubs, and relays

Each machine you use agents on is a **device** with a complete store of its own, which works offline. A self-hosted **personal hub** gathers what every device archives and writes into one store, so that agents on any machine, and cloud agents, can find it; forgets made anywhere reach every store. A machine with little disk can be a **relay** instead: it keeps nothing of its own, sends its agents' logs straight to the hub, and answers through it. See [Personal hub](./hub.md) to set one up.
