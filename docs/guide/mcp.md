# MCP tools

Origin serves eight tools over the [Model Context Protocol](https://modelcontextprotocol.io): `brief`, which hands an agent what matters where it works, four to read the archive and the entries, and three to write entries and forget. This page is the reference for anyone who registers Origin with an agent or builds on it; to simply connect an agent, see [Connect your agents](./connect-agents.md).

## Reaching Origin {#reaching-origin}

There are two ways in, with the same tools:

- **On a device**, agents start `origin mcp`, which serves over stdio. It answers from the device's store. On a device connected to a [personal hub](./hub.md), it also asks the hub and merges both answers; on a [relay](./hub.md#run-a-device-as-a-relay), it hands every call to the hub.
- **On a hub**, `POST /mcp` serves the same tools over MCP Streamable HTTP, statelessly, with JSON responses (no server-sent events, and `GET` is refused with 405), so it works behind any proxy or CDN. This is for cloud agents and other clients without local session logs:
  - `Authorization: Bearer <token>` is required, with a token created on the hub (`origin token create <name>`).
  - `X-Origin-Client: <agent>` is optional. Entries written through the request are recorded as `<agent>@<token name>`, or as the token's name alone without the header.
  - `X-Origin-Device: <name>` is optional, and must be the token's name if sent; otherwise the hub refuses the request with 403.

```bash
# A cloud agent registers the hub's endpoint with its own token
claude mcp add --scope user --transport http origin https://hub.example.com/mcp \
  --header "Authorization: Bearer ogn_…" --header "X-Origin-Client: claude-code"
```

The server's MCP `instructions` tell agents how to use the tools: call `brief` when they start a task, unless a recall already gave them one; search and read before answering questions about past work and cite entry and event ids; remember decisions with their reasons, stable facts, and preferences of the user, citing the events they come from; treat entries marked `imported` as mirrors of an agent's own memory files; correct entries that are wrong; and forget only when the user asks, with their reason.

## Conventions {#conventions}

- **Results** are one JSON text item. Times in results are ISO 8601 in the server's local time zone, with milliseconds and offset, such as `2026-10-20T09:12:30.000+08:00`.
- **Time arguments** (`since`, `until`, `valid_from`, `valid_to`) take a relative value, `30m`, `24h`, `7d`, or `2w`, counted back from now, or an absolute date or time, `2026-10-20` or ISO 8601.
- **Ids.** Entries are `ent_` and 12 to 32 hex characters. Events are `<source>:<id in the source>`, such as `claude-code:7d0c4a1e-…`; a source is `claude-code`, `codex`, `cursor`, `zcode`, or `grok`.
- **Errors** come back as tool errors (`isError`) with a readable message, never as protocol errors: invalid input, unknown ids (`Unknown entry or event <id>.`), and forgotten ids (`<id> has been forgotten.`).
- **On a device connected to a hub**, every entry, event, session, and source in a result carries `origin`: `local` if this device has it, `hub` if only the hub does. Of the versions of one entry, only the current one is listed. If the hub does not answer within 2 seconds (`ORIGIN_HUB_TIMEOUT_MS`), the result holds this device's answer alone, followed by a second text item: `Note: the Origin hub was not consulted (<reason>); these results come from this device only.`
- **On a relay**, every result is the hub's, as the hub returns it, without `origin` labels. When the hub cannot be reached, every tool fails with a message saying that the relay answers only through its hub.

## Entries, events, and sessions {#entries-events-and-sessions}

An **entry** in a result has these fields:

| Field | Meaning |
|---|---|
| `id`, `kind`, `text`, `confidence` | The entry: `kind` is `memory`, `knowledge`, or `cognition`; `confidence` is between 0 and 1 |
| `status` | `active` (the current version) or `superseded`; forgotten entries are never returned |
| `concurrent` | For a superseded version: true if it lost to a concurrent correction rather than being corrected |
| `project` | The project it belongs to, or null |
| `author` | Who wrote it: `<agent>@<device>`, or `user@<device>` from the CLI and the admin UI |
| `created` | When this version was written |
| `valid_from`, `valid_to` | When it holds, if known. An entry whose `valid_to` has passed is left out of search and listings |
| `supersedes`, `superseded_by`, `root` | The version it corrects, the current version if this one is superseded, and the entry's first version, which all versions share |
| `imported` | True if it was derived from an agent's own memory file (see [Native memories](../sources.md#native-memories)): a later version of the file supersedes a correction made in Origin. Absent from hubs older than 0.3 |

An **event** has `id`, `time`, `source`, `project`, `session` (the session id), `role` (`user`, `assistant`, or `system`), `kind` (`message`, `tool_use`, `tool_result`, `meta`, `system`, or `memory` for a version of a memory file), and `text`, cut to a length that depends on the tool, with the number of characters cut noted at the end.

A **session** has `session`, `source`, `project`, `title` (the title its agent gave it, or null), `prompt` (for a session without a title, its first prompt, cut to 80 characters), `started`, `ended`, and `events` (the number of its visible events).

## brief {#brief}

What the user's memory holds for where the agent works, one line per item: a brief of the user's preferences and boundaries, the project's latest decisions and facts, and its latest sessions with any agent, and with `about`, the entries that match it. It is what an agent's hooks are handed (see [Recall](./recall.md)), for agents whose hooks cannot hand anything over, and it is recorded the same way, as a recall.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `cwd` | string | the directory the server runs in | The agent's working directory: the git work tree that holds it, or the directory itself, is the project. A hub cannot see the agent's disk, so it takes the directory as it is, and needs it |
| `about` | string | none | What the task is about, in the user's words: adds the entries that match it |

It returns `{ recall, text }`: the recall's id, and the items under a header that says how to read them, or a line saying that the user's memory holds nothing for the project yet. On a device connected to a hub, `brief` reads the device's store only; a relay hands it to the hub with the work tree it runs in as `cwd`, and the hub records the recall as made for the device.

```json
{ "cwd": "/home/dana/code/demo-app", "about": "the release workflow" }
```

```json
{
  "recall": "rcl_8b2f4e1a9c0d",
  "text": "Origin recall rcl_8b2f4e1a9c0d: a brief from the user's cross-agent memory (project demo-app), one line each. Call Origin's `get` with an entry id for its full text and sources, or `timeline` with a session id to read that session. Entries can be outdated; the user's words in this session come first.\n\nThe user's preferences and boundaries:\n- ent_5f0c2a9e41b7 Run the full test suite before pushing\n\nProject demo-app:\n- ent_3f9a1c2b7d4e (2026-10-20) Releases are tagged from master once CI passes on Ubuntu and Windows."
}
```

## search {#search}

Full-text search over entries and session events, best match first. Without a query, it lists the most recent entries.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | none | Words or phrases; every word must occur, in any language (see [Search and timeline](../architecture.md#search-and-timeline)) |
| `scope` | `all`, `entries`, or `events` | `all` | What to search |
| `kind` | `memory`, `knowledge`, or `cognition` | any | Entries of this kind only |
| `since`, `until` | time | none | When entries were written and events happened |
| `source` | source id | any | Events of this source only |
| `project` | string | any | Entries and events of this project only |
| `include_tools` | boolean | `false` | Also search tool calls and tool results, not only messages |
| `limit` | integer, 1 to 100 | 20 | At most this many entries, and this many events |

It returns `{ entries, events }`: current entries, without those whose validity has ended, and events, each with its text cut to 400 characters and a `snippet` of up to 200 characters around the first match, with every match in brackets.

```json
{ "query": "release workflow", "limit": 5 }
```

```json
{
  "entries": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "kind": "memory",
      "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
      "confidence": 0.9,
      "status": "active",
      "concurrent": false,
      "project": "demo-app",
      "author": "claude-code@laptop",
      "created": "2026-10-20T09:12:30.000+08:00",
      "valid_from": null,
      "valid_to": null,
      "supersedes": null,
      "superseded_by": null,
      "root": "ent_3f9a1c2b7d4e",
      "imported": false
    }
  ],
  "events": [
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
      "time": "2026-10-20T09:01:05.120+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "user",
      "kind": "message",
      "text": "Set up the release workflow: tag from master, publish with provenance.",
      "snippet": "Set up the [release] [workflow]: tag from master, publish with provenance."
    }
  ]
}
```

## timeline {#timeline}

Sessions in a time range, newest first; or, with `session`, the events of one session in order.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `since` | time | `7d` | Sessions active since then |
| `until` | time | none | Sessions started before then |
| `source` | source id | any | Sessions of this source only; with `session`, the source of that session |
| `project` | string | any | Sessions of this project only |
| `session` | string | none | A session id: list its events instead |
| `include_tools` | boolean | `false` | With `session`: also list tool calls and results, injected context, and system events, not only messages |
| `limit` | integer, 1 to 500 | 50 | At most this many sessions, or events |

It returns `{ sessions }`, sessions ordered by their last activity, or `{ session, events }`, the session's first events oldest first, each with its text cut to 1,000 characters. There is no paging within a session: a longer session needs a larger `limit`, or `search` with `project` and a time range.

```json
{ "since": "2d", "project": "demo-app", "limit": 2 }
```

```json
{
  "sessions": [
    {
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "source": "claude-code",
      "project": "demo-app",
      "title": "Release workflow",
      "prompt": null,
      "started": "2026-10-20T09:01:05.120+08:00",
      "ended": "2026-10-20T10:44:51.007+08:00",
      "events": 212
    },
    {
      "session": "ses_0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d",
      "source": "zcode",
      "project": "demo-app",
      "title": null,
      "prompt": "Why does the upload retry twice on a 503?",
      "started": "2026-10-19T16:20:00.000+08:00",
      "ended": "2026-10-19T16:52:13.480+08:00",
      "events": 48
    }
  ]
}
```

## get {#get}

An entry with its sources and versions, or an event with its full text.

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string | An entry id (`ent_…`) or an event id (`<source>:…`) |

For an entry, it returns `{ entry, sources, history }`: `sources` are the events it cites, each with the `quote` it cites from it, or null, and its text cut to 500 characters; `history` lists every version of the entry, oldest first, forks included, each with `id`, `supersedes`, `author`, `created`, and `status`. An entry that is superseded or whose validity has ended is still returned by id. For an event, it returns the event with its text cut to 20,000 characters, and its `cwd`, `git_branch`, and `agent_version`.

```json
{ "id": "ent_3f9a1c2b7d4e" }
```

```json
{
  "entry": {
    "id": "ent_3f9a1c2b7d4e",
    "kind": "memory",
    "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
    "status": "active",
    "root": "ent_3f9a1c2b7d4e",
    "imported": false
  },
  "sources": [
    {
      "quote": "tag from master",
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
      "time": "2026-10-20T09:01:05.120+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "user",
      "kind": "message",
      "text": "Set up the release workflow: tag from master, publish with provenance."
    }
  ],
  "history": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "supersedes": null,
      "author": "claude-code@laptop",
      "created": "2026-10-20T09:12:30.000+08:00",
      "status": "active"
    }
  ]
}
```

The entry above is shortened; a result holds all its fields.

## sources {#sources}

The original log lines behind an entry or an event: the provenance of an answer.

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string | An entry id or an event id |

It returns a list, one item per cited event (one for an event): `event_id`, `time`, `quote`, `original_file` (the agent's log file, on the device that has it), `mirror_file` (Origin's mirror of it, kept as `<mirror_file>.zst` and `<mirror_file>.tail`), `line` (the line number in the mirror, the same as in that version of the original file), and `raw`, the line as the agent wrote it, cut to 4,000 characters. On a hub, `original_file` is the path on the device that sent it.

```json
{ "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001" }
```

```json
[
  {
    "event_id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
    "time": "2026-10-20T09:01:05.120+08:00",
    "quote": null,
    "original_file": "/home/dev/.claude/projects/-home-dev-demo-app/2f1e8c47-0000-4000-8000-000000000001.jsonl",
    "mirror_file": "/home/dev/.origin/raw/claude-code/-home-dev-demo-app/2f1e8c47-0000-4000-8000-000000000001.jsonl",
    "line": 3,
    "raw": "{\"type\":\"user\",\"uuid\":\"7d0c4a1e-0000-4000-8000-000000000001\",\"message\":{\"role\":\"user\",\"content\":\"Set up the release workflow: tag from master, publish with provenance.\"}}"
  }
]
```

## remember {#remember}

Save a new entry. Every entry cites at least one event, so that it can be traced to what was said.

| Parameter | Type | Meaning |
|---|---|---|
| `kind` | `memory`, `knowledge`, or `cognition` | What happened (a decision and why), a stable fact, or the user's preferences, methods, goals, or boundaries |
| `text` | string, required | One self-contained statement |
| `sources` | list, at least one | Each `{ event_id, quote }`: an event id, an exact quote, or both |
| `confidence` | number, 0 to 1, required | How sure the agent is |
| `project` | string | The project it belongs to, if any |
| `valid_from`, `valid_to` | time | When it holds, if known |

A source with an `event_id` must name a visible event, and its `quote`, if given, must occur in it, ignoring whitespace and case. A source with only a `quote` cites the most recent visible message that contains it, or failing that, a tool result; tool calls are never matched, since the agent's own `remember` call contains the quote. To cite a line just written in the conversation, quote it: the server ingests new lines before it saves. It returns `{ entry }`, the new entry, with author `<agent>@<device>`, the agent being the MCP client's name.

```json
{
  "kind": "cognition",
  "text": "Prefers small commits, each with one purpose.",
  "confidence": 0.9,
  "sources": [{ "quote": "keep each commit to one purpose" }]
}
```

Errors include `No event contains the quote "…". Search for the event and cite its id instead.`, `Quote not found in event <id>: "…"`, and `Event <id> has been forgotten and cannot be cited.`

## correct {#correct}

Replace an entry with a corrected version. The old version stays in the history; the new one supersedes it.

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string | The entry's current version |
| `text` | string, required | The corrected statement |
| `kind` | `memory`, `knowledge`, or `cognition` | A new kind; the old one by default |
| `confidence` | number, 0 to 1 | A new confidence; the old one by default |
| `sources` | list | More sources, added to those that carry over |
| `valid_from`, `valid_to` | time | New validity; the old one by default |

Only the current version can be corrected: correcting another fails with the id of the current one (`Entry <id> was already corrected; its current version is <id>. Correct that one instead.`). A correction is dated after the version it corrects. It returns `{ entry }`, the new version. On a connected device, an entry that only the hub has is corrected on the hub, which needs the hub to be reachable.

```json
{ "id": "ent_3f9a1c2b7d4e", "text": "Releases are tagged from master once CI passes on Ubuntu, Windows, and macOS." }
```

## forget {#forget}

Hide an entry, every version of it, and the events it cites; or an event and every entry that cites it. What is hidden leaves every query on every store, and cannot be cited. Agents call it only when the user asks, with the user's reason (see [Forgetting](./privacy.md#forgetting)).

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string | An entry id or an event id |
| `reason` | string, 1 to 2,000 characters, required | Why the user wants it forgotten; kept with the record |

It returns `{ tombstone, forgotten_entries, excluded_events }`: the id of the forget (`tmb_…`), the ids of the entry versions it hid, and the number of events it hid. If everything was hidden already, nothing is recorded and `tombstone` is null. On a connected device, an entry or event that only the hub has is forgotten on the hub.

```json
{ "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000002", "reason": "I pasted an API key in this prompt" }
```

```json
{ "tombstone": "tmb_6c1d0e9a2b3f", "forgotten_entries": [], "excluded_events": 1 }
```

There is **no tool to restore**: a forget is a record that only the user can undo, from `origin restore` or the admin UI.

## Freshness {#freshness}

Agents can find and cite what was said a moment ago, because `origin mcp` reads the agents' logs as it goes:

- When it starts, it ingests every source in the background, and on a connected device syncs with the hub.
- `brief`, `search`, and `timeline` first ingest new lines, at most every 10 seconds. On a connected device, `get` and `sources` do too, and every read also syncs with the hub, at most every 10 seconds, waiting for it no longer than the hub timeout.
- `remember` and `correct` always ingest first, and on a connected device sync with the hub right after.
- In the background, it looks for new log lines every 60 seconds (`ORIGIN_WATCH_INTERVAL_MS`; `0` turns this off), and ingests and syncs only if a log file changed.
- When the agent exits, it ingests and syncs once more, for at most 5 seconds.

The hub's `/mcp` reads the hub's store as it is: it has what every device has synced, and devices sync as described above. Sessions of agents that do not use Origin reach the store the next time one that does runs, or with `origin sync`.
