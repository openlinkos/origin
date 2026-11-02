# MCP tools

Origin serves eleven tools over the [Model Context Protocol](https://modelcontextprotocol.io): `brief`, which hands an agent what matters where it works, five to read the archive and the entries, `follow`, which joins the agent's session to the work it continues, `propose`, which hands the user an entry to review, and three to write entries and forget. This page is the reference for anyone who registers Origin with an agent or builds on it; to simply connect an agent, see [Connect your agents](./connect-agents.md).

## Reaching Origin {#reaching-origin}

There are two ways in, with the same tools:

- **On a device**, agents start `origin mcp`, which serves over stdio. It answers from the device's store. On a device connected to a [personal hub](./hub.md), it also asks the hub and merges both answers; on a [relay](./hub.md#run-a-device-as-a-relay), it hands every call to the hub.
- **On a hub**, `POST /mcp` serves the same tools over MCP Streamable HTTP, statelessly, with JSON responses (no server-sent events, and `GET` is refused with 405), so it works behind any proxy or CDN. This is for cloud agents and other clients without local session logs:
  - `Authorization: Bearer <token>` is required: a token created on the hub (`origin token create <name> --agent`), or the access token of an agent signed in with OAuth, which Claude Code and Codex get by themselves (see [Connect your agents](./connect-agents.md#sign-in-with-oauth)). An agent that may only read is served the tools that read, without `remember`, `propose`, `correct`, and `forget`.
  - `X-Origin-Client: <agent>` is optional. Entries written through the request are recorded as `<agent>@<name>`, the name being the token's or the signed-in agent's, or as that name alone without the header.
  - `X-Origin-Device: <name>` is optional, and must be the token's name if sent; otherwise the hub refuses the request with 403.

```bash
# A cloud agent registers the hub's endpoint with its own token
claude mcp add --scope user --transport http origin https://hub.example.com/mcp \
  --header "Authorization: Bearer ogn_…" --header "X-Origin-Client: claude-code"
```

The server's MCP `instructions` tell agents how to use the tools: call `brief` when they start a task, unless a recall already gave them one; search and read before answering questions about past work, following the ids that `get` lists next to what it opens and reading a long session a turn at a time, and cite entry and event ids; call `follow` once when the user continues work from an earlier session; call `changes` with the `next` of their last call to learn what changed since; remember decisions with their reasons, stable facts, and preferences of the user, citing the events they come from, and propose rather than remember what they infer and the user has not confirmed, or what they write when consolidating the user's memory; take a message marked with `by` as not written by the user, so that what it says is not the user's preference; treat entries marked `imported` as mirrors of an agent's own memory files; correct entries that are wrong; and forget only when the user asks, with their reason.

## Conventions {#conventions}

- **Results** are one JSON text item. Times in results are ISO 8601 in the server's local time zone, with milliseconds and offset, such as `2026-10-20T09:12:30.000+08:00`.
- **Time arguments** (`since`, `until`, `valid_from`, `valid_to`) take a relative value, `30m`, `24h`, `7d`, or `2w`, counted back from now, or an absolute date or time, `2026-10-20` or ISO 8601.
- **Ids.** Entries are `ent_` and 12 to 32 hex characters. Events are `<source>:<id in the source>`, such as `claude-code:7d0c4a1e-…`; a source is `claude-code`, `codex`, `cursor`, `zcode`, or `grok`, or the name of one of the user's own sources (see [Bring your own source](./sources.md)). Sessions go by their agent's own id, such as a UUID, or by `<source>:<session id>`, as recalls record them. Threads are `thr_` and 12 hex characters, and so are recalls, with `rcl_`, and proposals, with `prp_`. [`get`](#get) opens any of them.
- **Errors** come back as tool errors (`isError`) with a readable message, never as protocol errors: invalid input, unknown ids (`Unknown entry or event <id>.`), and forgotten ids (`<id> has been forgotten.`).
- **On a device connected to a hub**, every entry, event, session, and source in a result carries `origin`: `local` if this device has it, `hub` if only the hub does; the stubs a result lists (see below) do not, as they come from the store that answered. Of the versions of one entry, only the current one is listed. If the hub does not answer within 2 seconds (`ORIGIN_HUB_TIMEOUT_MS`), the result holds this device's answer alone, followed by a second text item: `Note: the Origin hub was not consulted (<reason>); these results come from this device only.`
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

An **event** has `id`, `time`, `source`, `project`, `session` (the session id), `role` (`user`, `assistant`, or `system`), `kind` (`message`, `tool_use`, `tool_result`, `meta`, `system`, or `memory` for a version of a memory file), and `text`, cut to a length that depends on the tool, with the number of characters cut noted at the end. A message or meta event of the `user` role that the user did not write also has `by`, who wrote it: `person` (someone else, or a speaker nobody named), `agent` (such as a parent agent prompting a sub-agent), or `system` (the agent's runtime or a program: notices, summaries, reminders, command echoes), and `speaker`, the name or label its source gave, when it gave one. The user's own messages, and events that are no input, have neither (see [Authors](../architecture.md#authors)):

```json
{
  "id": "chat-ops:msg-2002",
  "time": "2026-11-02T17:33:00.000+08:00",
  "source": "chat-ops",
  "project": "demo-app",
  "session": "incident-42",
  "role": "user",
  "by": "person",
  "speaker": "Sam",
  "kind": "message",
  "text": "Rolling it back now."
}
```

A **session** has `session`, `source`, `project`, `title` (the title its agent gave it, or null), `prompt` (for a session without a title, the first prompt the user wrote in it, cut to 80 characters, or null), `started`, `ended`, `events` (the number of its visible events), and `thread`, the id of the thread it is in with other sessions, or null.

A **thread** is the sessions of one project that belong to one piece of work, with one agent or several: those that agents linked with [`follow`](#follow), and those on the same git branch, other than a default branch such as `main`, within 30 days of each other. Origin derives threads from the archive; nothing about them is written by hand. A thread's id comes from its first session, so it changes only when an earlier session joins it (see [Threads](../architecture.md#threads)).

A **stub** is what a result shows of what is next to it: one line with an id, for `get` to open. An entry's stub is `{ id, kind, text, created }`, with its first line as `text`; an event's is `{ id, time, role, kind, text }`, with its text on one line, and `by` and `speaker` as an event has them; both are cut to about 120 characters. A session's stub is the session as above.

## brief {#brief}

What the user's memory holds for where the agent works, one line per item: a brief of the user's preferences and boundaries, the project's latest decisions and facts, and its latest conversations of the user's with any agent, and with `about`, the entries that match it. It is what an agent's hooks are handed (see [Recall](./recall.md)), for agents whose hooks cannot hand anything over, and it is recorded the same way, as a recall.

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
  "text": "Origin recall rcl_8b2f4e1a9c0d: a brief from the user's cross-agent memory (project demo-app), one line each. Origin's `get` opens any id here: an entry for its text and sources, a session or thread for its turns or sessions and what was written there. Entries can be outdated; the user's words in this session come first.\n\nThe user's preferences and boundaries:\n- ent_5f0c2a9e41b7 Run the full test suite before pushing\n\nProject demo-app:\n- ent_3f9a1c2b7d4e (2026-10-20) Releases are tagged from master once CI passes on Ubuntu and Windows.\n\nLatest sessions in demo-app, any agent (source, time, session id):\n- thr_4c1e9a7b2d30 (2 sessions: claude-code, codex; 2026-10-20 – 2026-10-22): Release workflow; last prompt: tag v0.5.0 once CI is green"
}
```

A session in a thread with others is listed as its thread, on one line: its id, how many sessions of which agents, from when to when, its name, and its last prompt.

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

It returns `{ entries, events }`: current entries, without those whose validity has ended, and events, each with its text cut to 400 characters, a `snippet` of up to 200 characters around the first match, with every match in brackets, and `session_title`, the title of the event's session or, without one, its first prompt.

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
      "snippet": "Set up the [release] [workflow]: tag from master, publish with provenance.",
      "session_title": "Release workflow"
    }
  ]
}
```

## timeline {#timeline}

Sessions in a time range, newest first; or, with `session`, the events of one session in order, a page at a time.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `since` | time | `7d` | Sessions active since then |
| `until` | time | none | Sessions started before then |
| `source` | source id | any | Sessions of this source only; with `session`, the source of that session |
| `project` | string | any | Sessions of this project only |
| `session` | string | none | A session id: list its events instead |
| `turn` | integer, 0 or more | none | With `session`: only the events of this turn. A turn starts at a prompt the user wrote, or a command the agent acted on, 1 at the first; 0 is what came before the first prompt |
| `after` | event id | none | With `session`: only the events after this one, the last of the page before |
| `include_tools` | boolean | `false` | With `session`: also list tool calls and results, injected context, and system events, not only messages |
| `limit` | integer, 1 to 500 | 50 | At most this many sessions, or events |

It returns `{ sessions }`, sessions ordered by their last activity, each with its `thread`, or, with `session`, `{ session, title, prompt, events, more }`: the session's name, its first events in the range asked for, oldest first, each with its text cut to 1,000 characters, and `more`, how many visible events of that range follow the last one. To read on, pass the last event's id as `after`; to read one turn, pass its number as `turn` (a session's card from [`get`](#get) lists its turns). A session id that sessions of two sources share needs `source`.

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
      "events": 212,
      "thread": "thr_4c1e9a7b2d30"
    },
    {
      "session": "ses_0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d",
      "source": "zcode",
      "project": "demo-app",
      "title": null,
      "prompt": "Why does the upload retry twice on a 503?",
      "started": "2026-10-19T16:20:00.000+08:00",
      "ended": "2026-10-19T16:52:13.480+08:00",
      "events": 48,
      "thread": null
    }
  ]
}
```

One turn of a session, two events at a time:

```json
{ "session": "2f1e8c47-0000-4000-8000-000000000001", "turn": 2, "limit": 2 }
```

```json
{
  "session": "2f1e8c47-0000-4000-8000-000000000001",
  "title": "Release workflow",
  "prompt": null,
  "events": [
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000005",
      "time": "2026-10-20T09:20:41.300+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "user",
      "kind": "message",
      "text": "Now publish with provenance from the release job."
    },
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000006",
      "time": "2026-10-20T09:20:52.004+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "assistant",
      "kind": "message",
      "text": "The release job now publishes with --provenance; it needs id-token: write."
    }
  ],
  "more": 3
}
```

The next page passes `"after": "claude-code:7d0c4a1e-0000-4000-8000-000000000006"` with the same `turn`.

## changes {#changes}

What reached the store since a cursor, oldest first: for an agent that comes back, or looks every few minutes, to learn what changed since it last looked without reading everything again (see [Change feed](../architecture.md#change-feed)).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `after` | string | none | The `next` of the last call. Without it, the changes of the last 24 hours, the newest `limit` of them if there are more |
| `project` | string | any | Events and sessions of this project, and its entries |
| `thread` | thread id | any | Events and sessions of this thread, and the entries written from them |
| `session` | string | any | Events of this session (its id, or `<source>:<session id>`), and the entries written from it |
| `include_tools` | boolean | `false` | Also list tool calls and results, injected context, and system events, not only messages |
| `limit` | integer, 1 to 200 | 50 | At most this many events, and this many entries and forgets |

It returns `{ sessions, events, entries, forgets, proposals, next, more }`:

- `events`: visible events in the order they reached the store, as stubs with their `session`;
- `sessions`: the sessions of those events, as `timeline` lists them, with their `thread`, and `new`, true if the session started in the range (none of its events came before);
- `entries`: entries written or received in the range that are current, as stubs with the version they `supersedes`;
- `forgets`: forgets in the range, `{ id, target, at }`, with the id of what was forgotten but never its text or the reason, so that the agent stops citing it; a restore is listed too, with the forget's id as its target;
- `proposals`: entries proposed in the range (see [propose](#propose)), pending or accepted, as stubs `{ id, kind, text, status, time, session, event, project }`, whatever `include_tools` says, so that an agent or a runtime notices them; a page with more than `limit` of them ends at the last one it lists;
- `next`: the cursor to pass as `after` next time; `more`: true when there was more than a page, so read on with `next`.

The cursor is opaque; pass it back as it is, to the server that gave it. A malformed one is an error. Without `after`, `next` is the cursor as of now: what came before is for `search` and `timeline`. On a device connected to a hub, the cursor holds the device's and the hub's: both answers are merged and labelled, and when the hub is not consulted, its part stays where it was.

```json
{ "after": "eyJlIjo0MTIwLCJjIjo4OH0", "limit": 20 }
```

```json
{
  "sessions": [
    {
      "session": "2f1e8c47-0000-4000-8000-000000000003",
      "source": "claude-code",
      "project": "demo-app",
      "title": "Tag the release",
      "prompt": null,
      "started": "2026-10-22T17:31:40.002+08:00",
      "ended": "2026-10-22T17:40:12.300+08:00",
      "events": 6,
      "thread": "thr_4c1e9a7b2d30",
      "new": true
    }
  ],
  "events": [
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000031",
      "time": "2026-10-22T17:31:40.002+08:00",
      "role": "user",
      "kind": "message",
      "text": "tag v0.5.0 once CI is green",
      "session": "2f1e8c47-0000-4000-8000-000000000003"
    }
  ],
  "entries": [
    {
      "id": "ent_7a2c9e1f0b44",
      "kind": "memory",
      "text": "v0.5.0 is tagged from master after both CI jobs passed.",
      "created": "2026-10-22T17:39:58.114+08:00",
      "supersedes": null
    }
  ],
  "forgets": [
    { "id": "tmb_6c1d0e9a2b3f", "target": "claude-code:7d0c4a1e-0000-4000-8000-000000000002", "at": "2026-10-22T17:35:00.000+08:00" }
  ],
  "proposals": [
    {
      "id": "prp_1b7e4c0a9d23",
      "kind": "knowledge",
      "text": "Releases are tagged only after both CI jobs pass.",
      "status": "pending",
      "time": "2026-10-22T17:39:02.410+08:00",
      "session": "2f1e8c47-0000-4000-8000-000000000003",
      "event": "claude-code:7d0c4a1e-0000-4000-8000-000000000040#0",
      "project": "demo-app"
    }
  ],
  "next": "eyJlIjo0MTI3LCJjIjo4OX0",
  "more": false
}
```

## get {#get}

Any id Origin hands over, with what is next to it: an entry, an event, a session, a thread, a recall, or a proposal (see [Reading along references](../architecture.md#reading-along-references)). Everything next to it comes as a stub, one line with its id, so that an agent opens what matters next, one hop at a time, rather than reading whole sessions.

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string | An entry id (`ent_…`), an event id (`<source>:…`), a session id (alone, or as `<source>:<session id>`), a thread id (`thr_…`), a recall id (`rcl_…`), or a proposal id (`prp_…`) |
| `source` | source id | For a session id that sessions of two sources share: which one. Without it, such an id is an error that names the sources |
| `offset` | integer, 0 or more | For an event: where its text starts, in UTF-16 code units (0 by default), to read a long one in pages |

- **An entry**: `{ entry, sources, history, related }`. `sources` are the events it cites, each with the `quote` it cites from it, or null, its text cut to 500 characters, and its `session_title`; `history` lists every version of the entry, oldest first, forks included, each with `id`, `supersedes`, `author`, `created`, and `status`; `related` lists up to 10 other current entries that cite an event this one cites, or another event of a session it cites, newest first, as stubs; for an entry imported from a memory file, only those that cite the same version of the file. An entry that is superseded or whose validity has ended is still returned by id.
- **An event**: the event with its `cwd`, `git_branch`, `agent_version`, and `session_title`, and its text from `offset` on, at most 20,000 characters, with `total_chars`, the length of all of it, and `next_offset`, where the next page starts, or null at the end. Its first page (`offset` 0) also has what is next to it: `turn`, `{ number, prompt }`, the turn it falls in and the stub of the prompt that started that turn, or null before the first prompt; `replies_to`, the stub of the event its agent recorded it as following (Claude Code's `parentUuid`), or null; `around`, `{ before, after }`, the stubs of the two visible events on each side in its session, messages only unless the event is a tool call or result; and `cited_by`, up to 10 current entries that cite it, as stubs.
- **A session**: a card with the fields of a session, its `cwd`, and `turns`, its number of turns; `prompts`, where its first 20 turns start, each `{ turn, id, time, text }`, and `more_prompts`, how many turns follow those; `thread`, `{ id, sessions }`, the thread it is in and how many sessions that has, or null; `entries`, up to 10 current entries written from it (that cite its events), newest first, as stubs; `recalls`, up to 10 recalls it was handed, newest first, each `{ id, occasion, time, items }`, where `items` counts what it handed over that is still visible; and `before` and `after`, the sessions just before and after it in its project, of any agent, by when they started, or null. Read a turn with [`timeline`](#timeline).
- **A thread**: `{ thread, project, title, started, ended, sessions, more_sessions, agents, branches, entries, last_prompt }`: its id, its project and name (its first session's), when it started and ended, its first 20 `sessions`, oldest first, and how many follow those, the `agents` of its sessions and the work `branches` they were on, `entries`, up to 10 current entries written from any of its sessions, newest first, as stubs, and `last_prompt`, the stub of the latest prompt of its most recent session that has one, with its `session`, or null.
- **A recall**: `{ id, time, occasion, agent, session, device, project, directory, budget, tokens, items, text }`: when, for which agent, session, and device, and where it was made, its budget and the tokens it used, its items, each `{ rank, layer, kind, id, score, used }` (`kind` is `entry`, `session`, or `thread`, and a session's has its `source`; `used` says whether the session went on to use the item, and is null while the session is not known), and `text`, what the agent was handed, rebuilt from the store as it is now. What was forgotten since is left out of both.
- **A proposal**: `{ id, status, kind, text, confidence, project, valid_from, valid_to, note, time, agent, session, event, sources, missing_sources, accepted_as }`: what it proposes; `status`, `pending` or `accepted`; when it was proposed, by which `agent`, in which `session` (as `timeline` lists it), and the `event` it was read from; `sources`, the events it cites, as stubs with their `quote` and `session`, and `missing_sources`, how many of them this store does not have yet; and `accepted_as`, the stub of the entry it became (its current version), or null. A rejected proposal is an error (``Proposal <id> was rejected (tmb_…); restoring that forget makes it pending again.``), and so is one that cites a forgotten event (`Proposal <id> has been forgotten.`).

Current entries are those that listings show: not superseded, forgotten, or ended. What was forgotten is never among the stubs, nor counted. On a device connected to a hub, an event, a session, a thread, a recall, or a proposal comes from one store, with that store's stubs: the device's when it has the id, otherwise the hub's, without what the device has forgotten.

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
      "text": "Set up the release workflow: tag from master, publish with provenance.",
      "session_title": "Release workflow"
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
  ],
  "related": [
    {
      "id": "ent_9c4d2e7f1a6b",
      "kind": "knowledge",
      "text": "The npm token is gone: packages publish through trusted publishing.",
      "created": "2026-10-20T10:31:02.517+08:00"
    }
  ]
}
```

The entry above is shortened; a result holds all its fields. A session, by its id:

```json
{ "id": "2f1e8c47-0000-4000-8000-000000000001" }
```

```json
{
  "session": "2f1e8c47-0000-4000-8000-000000000001",
  "source": "claude-code",
  "project": "demo-app",
  "cwd": "/home/dana/code/demo-app",
  "title": "Release workflow",
  "prompt": null,
  "started": "2026-10-20T09:01:05.120+08:00",
  "ended": "2026-10-20T10:44:51.007+08:00",
  "events": 212,
  "turns": 2,
  "prompts": [
    {
      "turn": 1,
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
      "time": "2026-10-20T09:01:05.120+08:00",
      "text": "Set up the release workflow: tag from master, publish with provenance."
    },
    {
      "turn": 2,
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000005",
      "time": "2026-10-20T09:20:41.300+08:00",
      "text": "Now publish with provenance from the release job."
    }
  ],
  "more_prompts": 0,
  "thread": { "id": "thr_4c1e9a7b2d30", "sessions": 2 },
  "entries": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "kind": "memory",
      "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
      "created": "2026-10-20T09:12:30.000+08:00"
    }
  ],
  "recalls": [
    { "id": "rcl_8b2f4e1a9c0d", "occasion": "start", "time": "2026-10-20T09:01:04.870+08:00", "items": 2 }
  ],
  "before": {
    "session": "ses_0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d",
    "source": "zcode",
    "project": "demo-app",
    "title": null,
    "prompt": "Why does the upload retry twice on a 503?",
    "started": "2026-10-19T16:20:00.000+08:00",
    "ended": "2026-10-19T16:52:13.480+08:00",
    "events": 48,
    "thread": null
  },
  "after": null
}
```

And its thread:

```json
{ "id": "thr_4c1e9a7b2d30" }
```

```json
{
  "thread": "thr_4c1e9a7b2d30",
  "project": "demo-app",
  "title": "Release workflow",
  "started": "2026-10-20T09:01:05.120+08:00",
  "ended": "2026-10-22T17:40:12.300+08:00",
  "sessions": [
    {
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "source": "claude-code",
      "project": "demo-app",
      "title": "Release workflow",
      "prompt": null,
      "started": "2026-10-20T09:01:05.120+08:00",
      "ended": "2026-10-20T10:44:51.007+08:00",
      "events": 212,
      "thread": "thr_4c1e9a7b2d30"
    },
    {
      "session": "0199f3c2-5b1a-7e4d-8c6f-1a2b3c4d5e6f",
      "source": "codex",
      "project": "demo-app",
      "title": null,
      "prompt": "Check the release job before we tag",
      "started": "2026-10-22T17:02:11.840+08:00",
      "ended": "2026-10-22T17:40:12.300+08:00",
      "events": 64,
      "thread": "thr_4c1e9a7b2d30"
    }
  ],
  "more_sessions": 0,
  "agents": ["claude-code", "codex"],
  "branches": ["release-workflow"],
  "entries": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "kind": "memory",
      "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
      "created": "2026-10-20T09:12:30.000+08:00"
    }
  ],
  "last_prompt": {
    "id": "codex:0199f3c2-5b1a-7e4d-8c6f-1a2b3c4d5e6f:o118",
    "time": "2026-10-22T17:38:02.511+08:00",
    "role": "user",
    "kind": "message",
    "text": "tag v0.5.0 once CI is green",
    "session": "0199f3c2-5b1a-7e4d-8c6f-1a2b3c4d5e6f"
  }
}
```

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

## follow {#follow}

Declare that the agent's session continues an earlier session, or a thread, of the project it works in, so that they form one thread. Agents call it once, when the user takes up work from a session that `brief`, `timeline`, or `search` showed them. It writes nothing: the agent's log records the tool's result, and Origin reads the link from it there, on every store that archives the log (see [Threads](../architecture.md#threads)).

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string, required | The session (its id, or `<source>:<session id>`) or the thread (`thr_…`) that the work continues |
| `note` | string, at most 200 characters | A few words on how the work continues |
| `cwd` | string | The agent's working directory, by default the directory the server runs in: the target must be of its project, by the project's name or by a directory in its git work tree. A hub cannot see the agent's disk, so it needs it |

It returns `{ link, follows, thread, note }`: the link's id (`lnk_` and 12 random hex characters), the session it continues as `<source>:<session id>` (a thread's first session, for a thread), the thread that session is in, or null while it is in none, and the note. Once the session's log is archived, both sessions are in one thread. On a device connected to a hub, a session or thread that only the hub has is checked by the hub; a relay hands the call to the hub with its work tree as `cwd`.

```json
{ "id": "2f1e8c47-0000-4000-8000-000000000001", "note": "tag the release prepared there" }
```

```json
{
  "link": "lnk_5d0e2b9a7c14",
  "follows": "claude-code:2f1e8c47-0000-4000-8000-000000000001",
  "thread": null,
  "note": "tag the release prepared there"
}
```

Errors include `Unknown session or thread <id>.`, ``<id> is a session of project <name>, not of project <name>: `follow` links the sessions of one project.``, and, for an entry, event, or recall id, ``<id> is an event: `follow` takes the id of a session or of a thread (thr_…).``

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

A source with an `event_id` must name a visible event, and its `quote`, if given, must occur in it, ignoring whitespace and case. A source with only a `quote` cites the most recent visible message that contains it, or failing that, a tool result other than the result of `propose`; tool calls are never matched, since the agent's own `remember` call contains the quote. The event of a proposal cannot be cited: only the user accepts a proposal, which writes its entry. To cite a line just written in the conversation, quote it: the server ingests new lines before it saves. It returns `{ entry }`, the new entry, with author `<agent>@<device>`, the agent being the MCP client's name.

```json
{
  "kind": "cognition",
  "text": "Prefers small commits, each with one purpose.",
  "confidence": 0.9,
  "sources": [{ "quote": "keep each commit to one purpose" }]
}
```

A `cognition` comes only from the user's own words: one whose sources include messages or meta events none of which the user wrote, such as another person's message, an agent's prompt to a sub-agent, or a program's notice, is refused; the agent's own messages and tool events alone do not count either way. Errors include `No event contains the quote "…". Search for the event and cite its id instead.`, `Quote not found in event <id>: "…"`, `Event <id> has been forgotten and cannot be cited.`, and ``A preference can only come from the user's own words: <id> (by person, Sam) is not the user's. Cite what the user wrote, or save this as memory or knowledge.``

## propose {#propose}

Propose an entry for the user to review, rather than saving it: for what the agent infers and the user has not confirmed, and for everything it writes when it consolidates the user's memory on their behalf, as [`origin distill`](./distill.md) has it do. Only the user accepts or rejects a proposal, with `origin accept` and `origin reject` or in the admin UI; agents have no tool for either (see [Proposals](../architecture.md#proposals)).

| Parameter | Type | Meaning |
|---|---|---|
| `kind`, `text`, `sources`, `confidence`, `project`, `valid_from`, `valid_to` | as for [`remember`](#remember) | The entry it proposes |
| `note` | string, at most 200 characters | Why the agent proposes rather than remembers, in a few words |

It is checked as `remember` is: every source must resolve to a visible event, and every quote must be found, in the device's own store on a connected device, and on the hub through a relay. It writes nothing: it returns the proposal whole, `{ proposal, kind, text, confidence, project, valid_from, valid_to, note, sources }`, with a new id (`prp_` and 12 random hex characters) and each source as the `{ event_id, quote }` it resolved to. The agent's log records that result, and Origin reads the proposal from it there, on every store that archives the log, as it reads the links of `follow`. An agent's log keeps 4,000 characters of a tool result, so a proposal whose result would be longer than 3,800 is refused: shorten its text or its quotes, or cite events by id alone.

```json
{
  "kind": "knowledge",
  "text": "Releases are tagged only after both CI jobs pass.",
  "confidence": 0.7,
  "project": "demo-app",
  "sources": [{ "event_id": "claude-code:7d0c4a1e-0000-4000-8000-000000000031", "quote": "once CI is green" }],
  "note": "Inferred from how the last two releases went."
}
```

```json
{
  "proposal": "prp_1b7e4c0a9d23",
  "kind": "knowledge",
  "text": "Releases are tagged only after both CI jobs pass.",
  "confidence": 0.7,
  "project": "demo-app",
  "valid_from": null,
  "valid_to": null,
  "note": "Inferred from how the last two releases went.",
  "sources": [
    { "event_id": "claude-code:7d0c4a1e-0000-4000-8000-000000000031", "quote": "once CI is green" }
  ]
}
```

Accepting the proposal writes its entry, as `user@<device>`, citing what it cites and the proposal's own event; rejecting it forgets that event, with the user's reason. Until then it is not knowledge: `search`, `brief`, and recall never hand it over, while `get` opens it and `changes` lists it. Its errors are those of `remember`, and `This proposal would take <n> characters, more than the 3800 an agent's log keeps of a tool result: …`.

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

Only the current version can be corrected: correcting another fails with the id of the current one (`Entry <id> was already corrected; its current version is <id>. Correct that one instead.`). A correction is dated after the version it corrects. One that makes an entry a `cognition`, or adds sources to one, is checked as [`remember`](#remember) checks a cognition. It returns `{ entry }`, the new version. On a connected device, an entry that only the hub has is corrected on the hub, which needs the hub to be reachable.

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
- `brief`, `search`, `timeline`, `changes`, and `follow` first ingest new lines, at most every 10 seconds. On a connected device, `get` and `sources` do too, and every read also syncs with the hub, at most every 10 seconds, waiting for it no longer than the hub timeout.
- `remember`, `propose`, and `correct` always ingest first, and on a connected device `remember` and `correct` sync with the hub right after; `propose` writes nothing to sync.
- Claude Code's and Codex's ingest hooks, which `origin agents connect` sets up, ingest a session's new lines as each turn ends, and on a connected device push them to the hub (see [Connect your agents](./connect-agents.md#connect-them-all-at-once)).
- In the background, as the fallback for other agents and for what a hook missed, it looks for new log lines every 60 seconds (`ORIGIN_WATCH_INTERVAL_MS`; `0` turns this off), and ingests and syncs only if a log file changed.
- When the agent exits, it ingests and syncs once more, for at most 5 seconds.

The hub's `/mcp` reads the hub's store as it is: it has what every device has synced, and devices sync as described above. Sessions of agents that do not use Origin reach the store the next time one that does runs, or with `origin sync`.
