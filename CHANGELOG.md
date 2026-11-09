# Changelog

All notable changes to Origin are listed here. Versions follow [Semantic Versioning](https://semver.org); before 1.0, a minor version may change the store format or a public interface, and its notes say what to do. The six packages (`@openlinkos/origin` and `@openlinkos/origin-core`, `-adapters`, `-mcp`, `-admin`, and `-openclaw`, the plugin for OpenClaw) are released together under one version.

## [0.7.0] - 2026-11-11

Lets you delete for good what must not be kept, from the command line or the admin UI, and carries a hub's purges down to its devices; lets a self-hosted hub keep its store in PostgreSQL; bounds every hit `search` hands an agent, and pages long entries in `get`; keeps OpenClaw's internal runs, and what attachments hold, out of your memory; and puts each session in the thread of its own project.

**Upgrading.** Back up first, with `origin backup <dir>` (on a hub, inside its container). The store format moves from version 11 to version 12: the first command after the upgrade, or the hub as it starts, adds the empty tables of purges and the guards that only a purge can lift, derives every thread again, and empties `place_head`, so that the next sync reads each `places.jsonl` mirror once more. A hub that ran an `edge` image may already be at format 12, and then no step runs: run `origin sessions repair` on it to derive its threads again. From format 12 on, an Origin of an earlier version refuses the store, so that none ingests again what a purge removed; to go back, restore the backup. Upgrade the hub before its devices, and the devices soon after: a device of 0.6 cannot read its hub's purges, and keeps what they removed until it is upgraded, when its next sync applies them all. Then restart your agents, or their Origin MCP servers: an `origin mcp` of 0.6 refuses to write to the upgraded store and exits, so that its client starts the new one. Then:

- On OpenClaw, update the plugin (`openclaw plugins update "@openlinkos/origin-openclaw@0.7.0"`) and restart the Gateway.
- To move a hub to PostgreSQL, which is optional: create a database in UTF8 with the C locale on PostgreSQL 17 or later, let the upgraded hub start once, stop it, back it up, run `origin db move --to <postgres-url> --yes` on its `/data`, and start it again with `ORIGIN_DATABASE_URL` (or `ORIGIN_DATABASE_URL_FILE`) naming the database. See [Run the hub on PostgreSQL](https://origin.openlinkos.com/guide/hub#run-the-hub-on-postgresql).

### Purging

- Forgetting hides, and a restore brings back; a purge deletes for good, for what must not be kept at all, such as a secret pasted into a session. Only you purge: with `origin purge <selector> --reason <text>` on the store's own machine, or with **Purge…** on the page of an event, a session, an entry, or a forget in the admin UI, on a hub or in `origin ui`.
- The selectors: `event <id>…`; `session <source>:<id>`, with its child sessions unless `--keep-children`; `entry <id>`, every version of its chain; `forgotten <tmb-id>`, what a forget hides on this store, or `forgotten all`; `recall <id>`; and `lines --source <id>`, lines of a source's mirrors, narrowed to a device or a writer (`--from`), a path, a raw file and a range of its lines, a time range, or the lines its adapter could not parse (`--unparsed`), such as a bot's malformed lines. The admin UI purges events, sessions, entries, and what a forget hides.
- A purge takes more than it selects, so that every answer can still be traced to its source: a purged event takes its whole raw line, and every other event that line yields; every entry chain that cites a purged event goes whole; a session takes its events, recalls, and child sessions. So a purge first shows what it would delete, by id and count and never as text, with the digest of that plan, its warnings, and what it cannot reach, and acts only with `--yes`, or in the admin UI once you type `purge`. Every purge needs a reason. In the admin UI, and with `--digest` on the command line, it confirms the digest of the preview, and deletes nothing if the store has changed so that it would now delete something else. On a hub, the admin UI asks for your password again if you have not entered it in the last 10 minutes. A purge that fails deletes nothing, and says why.
- What a purge deletes leaves the database and the search indexes, and its lines in the raw mirrors are blanked in place: every byte but the line break becomes a space, so that every other line keeps its place, and the last line of a stream Origin generates, such as a ZCode session or a Cursor conversation, becomes a line that says only where the stream goes on. The mirrors are blanked right after, one at a time; `origin status` lists those still to blank, and `origin purge --resume`, `origin sync`, `origin ui` as it starts, and a hub as it starts and every minute finish them.
- Data that arrives later is kept out: syncing an agent's file again, parsing mirrored lines again, a device's push, the lines a writer sends, and the entries and recalls a device sends never bring back what a purge removed. A line that holds it is stored blank, and the answer to `POST /v1/sources/<name>/lines` counts such lines in `purged`. No event number is given out again, so that a cursor of `changes` taken before a purge still sees what arrives after it.
- A purge made on a hub reaches its devices: the hub serves its purges at `GET /v1/purges`, to a device's own token only, and each device applies them at its next sync, before it sends anything, so that nothing they removed comes back up; `origin sync` says how many it applied. A purge made on a device deletes only the device's copy, and `origin mcp` there hides the hub's copy of it; the CLI, and the preview in `origin ui`, link to the same purge in the hub's admin UI. A relay holds nothing to purge.
- Each purge is kept as a record: who made it, when, why, what it selected, and counts, never what it deleted. `origin purged` lists the records, newest first, and `origin purged <prg-id>` shows one with the mirror lines it blanked; the admin UI lists them under **Purges** on the Forgotten page, shows the latest on the overview, and says on a forget's page which purges touched it, and the audit log records each by ids and counts. The reason is kept for good: say why, without quoting what you purge.
- Purging is never offered to agents: no MCP tool, hook, or tool of the OpenClaw plugin purges, and no token of a device, an agent, or an OAuth client reaches it. Scripts that sign in as you purge through the admin UI's JSON API: `GET /admin/api/purge-plan` previews, and `POST /admin/api/purge`, like the form's `POST /admin/purge`, needs a reason, the digest of the plan it confirms, and on a hub your password within the last 10 minutes.
- A purge does not reach backups made before it (a later `origin backup` into the same directory copies again, whole, the mirrors it changed), older versions of objects in a bucket that keeps them, PostgreSQL's write-ahead log and its dead rows until they are vacuumed, stores it has not reached, or your agents' own files: what an agent writes again arrives as new data. The preview lists these limits every time, and so do the guides to the CLI, the admin UI, the hub, and privacy.
- Store format 12 adds the records of purges, and guards that refuse to delete events, entries, recalls, and raw chunks, or to rewrite raw chunks, outside a purge's own write transaction: raw mirrors and events stay append-only, except for what a purge blanks or deletes. An Origin of an earlier version refuses a store of format 12.

### PostgreSQL for the hub

- A self-hosted hub can keep its store in PostgreSQL instead of SQLite, for when its database outgrows the hub's disk, or when you already run and back up PostgreSQL. Set `ORIGIN_DATABASE_URL`, or `ORIGIN_DATABASE_URL_FILE` to a file that holds it, such as a mounted secret; the URL's `schema` parameter names the schema, `origin` by default. It needs PostgreSQL 17 or later and a database in UTF8 with the C locale, so that text is compared and case-folded as in SQLite; the hub refuses any other database, and says how to create one. Connect directly, or through a pooler in session mode: transaction pooling does not work. Devices keep their stores in SQLite, and neither they nor your agents notice the difference.
- The raw mirrors stay in `ORIGIN_HOME` (`/data`), and `store.json` there pairs them with the database: Origin refuses a database and a directory that belong to different stores, and never starts a new, empty store in SQLite because the URL was left out. One `origin serve` runs per store: a second hub on the same database and schema refuses to start. The commands that work with the machine's own agents (`sync`, `push`, `hub`, `mcp`, `ui`, `agents`, `sessions reproject`, and `sessions parents`) refuse to run there, and agents' hooks do nothing. `origin status` and the admin UI's overview show where the database is, without its password.
- `origin db move --to <postgres-url | sqlite>` moves a hub's store from SQLite into PostgreSQL and back, or into another PostgreSQL database or schema, with the hub stopped; without `--yes`, it says what it would do. It copies every table with its keys, so that every cursor goes on as before, builds the search indexes, checks the copy table by table, and only then retires the old store; if anything does not match, nothing is kept. On a store of 250,000 events, a move into PostgreSQL took about a minute and a half. `origin db rebuild-search`, to run after a major upgrade of PostgreSQL, rebuilds the trigram indexes and what search derives from the events. `origin backup` of a store in PostgreSQL exports it, from one snapshot, into `<dir>/origin.db`, a store in SQLite, which is restored like any other backup.
- Search in PostgreSQL needs no extension: GIN indexes over each event's trigrams stand for FTS5, and BM25 is computed in TypeScript as FTS5 computes it, so that it finds the same events in the same order, which the same tests check on both engines. The architecture document describes three known differences: a few characters whose lower case is longer or depends on context, such as `İ` and a final `Σ`, fold differently; how many events a term matches is counted exactly up to 20,000 and estimated beyond, so that ranking can differ slightly for a term that common; and U+0000, which PostgreSQL's text cannot hold, is stored as U+FFFD. Searches take longer there than in SQLite, most for terms found in many events.
- The CLI, `@openlinkos/origin`, and no other package, now depends on the PostgreSQL driver `pg` (8.23.1). It is installed with the CLI, but loaded only when a store in PostgreSQL is opened: a device never loads it.
- CI now runs the whole suite on SQLite and on PostgreSQL 17, on Linux and on Windows, and CONTRIBUTING.md says how to run it on PostgreSQL yourself.

### Search and get

- Every hit of `search` is now bounded, however long what it found. An entry hit carried the entry's whole text; it is now cut to 400 characters, as an event hit is, and both carry `total_chars`, the length of the whole text, which `get` reads, and, with a query, a `snippet` around the first match. The result adds `more`, which says, for entries and for events, whether more match than `limit` let through; a device connected to a hub merges the hub's. So a long entry no longer fills an agent's context. `origin search` shows entries by their snippet, as it shows events, and says when more match than `--limit` shows. The tools' parameters are unchanged.
- `get` reads a long entry a page at a time, as it reads an event: `entry.text` holds up to 20,000 characters from `offset`, with `total_chars` and `next_offset` (null at the end), and every page carries the rest of the card, the entry's sources, history, and related entries. `offset` now applies to entries in `get` and in the OpenClaw plugin's `origin_get`.

### The OpenClaw plugin

- The plugin no longer records OpenClaw's internal runs, which nobody had with an agent: the hidden sessions OpenClaw keeps for a run's effects (session keys `agent:<agent>:internal-session-effects:…`), such as a one-shot model run (`openclaw infer model run --gateway`), a backend's run without visible effects, the Control UI's side chat, and the auth probe; and Active Memory's recall runs (`…:active-memory:…`). OpenClaw starts some of them as `user` runs and keeps their prompt as its owner's, so they were recorded as your conversations, and counted in briefs and digests. They are left out whatever `triggers` says. Those recorded before stay, until you forget or purge them.
- A message that came with files says so. It used to be recorded as its caption alone, and a message that was only a file not at all. Each user line now lists in `meta.attachments` each file's kind (`image`, `audio`, `video`, `sticker`, or `file`), and its name and size when OpenClaw gives them, at most ten; and its text gets a marker for each, such as `[image]` or `[file: report.pdf]`, so that a search finds the message, and `get`, a timeline, or a digest shows that it carried a file. What a file holds, its path, and its link are never sent.

### Documentation

- The guide to your own sources says more about a bot that writes its own conversations: its replies are `message` lines, a reply it sends through a tool included, holding the text it sent; a line's `text` holds only what was written, without the markup a platform wraps around a turn; and the runs in which the bot copies its conversations to Origin are left out.
- The MCP reference says which prompt names a session in `digest`: `prompt`, given when the session has no title, is the prompt that opened it, perhaps on an earlier day, while `prompts` are those written that day. The recall guide says when an item counts as used: a later tool call or reply in the session mentions the item's own id; opening the recall with `get rcl_…`, or using what an item says without naming its id, does not count.
- New sections: Purging in the guides to the CLI, the admin UI, and the hub; Run the hub on PostgreSQL in the hub's guide, Move a hub to PostgreSQL in Upgrading, and three entries on PostgreSQL in Troubleshooting; and Purging and Database engines in the architecture.

### Fixes

- Threads place each session by its own project. Once a session had a place, the rule that joins your conversations on one git branch took every session for the project of whichever place came first, and so joined sessions of different projects on a branch of the same name into one thread. Format 12 derives every thread again by the fixed rule. On a store already at format 12, `origin sessions repair` does it: it now derives every thread again, from scratch, after filling places and parent links, and says how many sessions changed thread (`--dry-run` counts them and writes nothing).
- Sessions that ended at the same time are listed in one order, by source and session id after their end, so that a page of sessions no longer repeats or skips one at its edge.
- The latest line of each `places.jsonl` is kept under plain keys, without the U+0000 that PostgreSQL's text cannot hold: on a hub there, every sync of a device's places file would otherwise read its whole mirror again. The upgrade empties these keys, and the next sync of each places file reads its mirror once more.
- On a hub that keeps raw mirrors in a bucket, a request whose worker thread died or hung no longer waits out its timeout: it fails as soon as that is noticed, and the retry runs on a new worker.

## [0.6.1] - 2026-11-09

Gives OpenClaw's agents Origin's read tools in every turn you start, in channels and threads as well as in direct messages.

**Upgrading.** Nothing changes in the store, and only the OpenClaw plugin changes. On OpenClaw, update the plugin (`openclaw plugins update "@openlinkos/origin-openclaw@0.6.1"`) and restart the Gateway. Make sure your account is in `commands.ownerAllowFrom`, and that the plugin's settings do not turn its tools off.

### Read tools in OpenClaw

- The plugin offered its read tools only in turns OpenClaw resolved as the owner's own (`owner-private`). OpenClaw resolves that only when its memory slot holds a plugin with a provider runtime, never with memory-core, and never in a Discord guild channel or thread, so the tools were missing where most conversations happen. They are now offered in every turn the owner starts: when OpenClaw says the turn's sender is the owner (`commands.ownerAllowFrom`) and names that sender. A turn someone else starts, a cron or heartbeat run, an `openclaw agent` run, and a turn that batches messages of several senders still get none.
- In a shared channel, an answer is posted where the channel's members can read it, and other people's messages in its history can steer a turn you start. The new `tools` setting narrows the tools or turns them off: `"owner-turns"` (the default), `"owner-private"`, or `"off"`. The `true` and `false` of 0.6.0 still mean `"owner-turns"` and `"off"`.

## [0.6.0] - 2026-11-06

Hands agents your past messages with each prompt, not only entries; brings recall to ZCode, Cursor, and OpenClaw's agents; recaps a day with `digest`; tells a writer of event lines why a line was refused; and ends a search that could run forever.

**Upgrading.** The store format moves from version 10 to version 11: the first command after the upgrade, or the hub as it starts, makes the table of recall items again, keeping every row; it takes a moment. Upgrade the hub before its devices: a hub of 0.5 refuses a recall that lists a past message, and a device's sync says so and keeps that recall, and those after it, until the hub is upgraded. Then restart your agents, or their Origin MCP servers: an `origin mcp` of 0.5.0 refuses to write to the upgraded store and exits, so that its client starts the new one. Then, on each device:

- Run `origin agents connect`, and then with `--yes`, to add the recall hooks of ZCode and Cursor. ZCode runs hooks only while `hooks.enabled` is true: Origin turns it on when its hooks are the only ones there, and otherwise says so. Start a new session of each agent.
- On OpenClaw, update the plugin (`openclaw plugins update "@openlinkos/origin-openclaw@0.6.0"`) and restart the Gateway: with a hub, it gives your agents Origin's read tools in your own turns.

### Daily digest

- The new MCP tool `digest`, and `origin digest`, recap one calendar day from the store alone, with no model call: the day's totals, by project and by agent; its top-level sessions, most recent first, each with your prompts that day, its tool calls by tool, and the files its edit calls changed, with the work of its child sessions counted in; the entries written and the proposals made that day; and its forgets and restores, by id only. Nothing forgotten is counted or shown. Every session, entry, and proposal comes with its id, for `get` or `origin show`.
- The day is today unless `day` (`--day`) names another, in the time zone of the process that answers, or the one `time_zone` names; `project` and `source` narrow it, and `limit` caps each list (50, at most 200). Which tools count as file edits, per agent, is in the documentation of sources.
- `digest` reads, so read-only agents have it too. On a device connected to a hub, it is the hub's digest of the device's day, less what the device has forgotten, or the device's own when the hub does not answer in time; on a relay, the call and `origin digest` go to the hub. `origin digest --json` prints what the tool returns.

### Past messages in recall

- Recall hands over what was said, not only what was written down: with each prompt, after the entries that match it, up to three past messages of the project's conversations that match it the same way, your prompts and your agents' replies, each from a different session and none from the session itself. Each is one line: its event id, its agent, its day, and who wrote it, and an excerpt around the rarest of the prompt's words it holds; `get` on the id opens the whole message and the turns around it. A sub-agent's session, a headless run, and other people's words are never quoted, and nothing forgotten is.
- `brief` with `about` hands over the past messages that match the task the same way.
- A prompt's matches may now take about 600 tokens (they took 400), and a brief an agent asks for about 1,500 (it took 1,200), to make room for them.
- A recall records a past message by its id and where its excerpt starts, never by its text: `origin show rcl_…`, `get` on a recall, and the admin UI show it as it is now, linked, or that it was forgotten since.
- A search within a project, as recall makes for each word it looks up, checks each match's project where that reads less than listing the project's events first; on a store of 200,000 events, this took looking past messages up from about a second to a few tens of milliseconds.

### Recall in more agents

- ZCode and Cursor get recall through their hooks. `origin agents connect` adds `origin recall --hook zcode` at `SessionStart` and `UserPromptSubmit` to `hooks.events` in `~/.zcode/cli/config.json`, and `origin recall --hook cursor` at `beforeSubmitPrompt` to `~/.cursor/hooks.json`, next to the hooks already there. ZCode runs hooks only while `hooks.enabled` is true: Origin turns it on when its hooks are the only ones there, and otherwise says so and leaves it to you. Cursor often loses what a hook hands over when a conversation starts, so its first prompt brings the brief, with the prompt's matches. A ZCode sub-agent or workflow step, and a Cursor sub-agent, get nothing.
- `brief` takes a `project`, for agents that work in no directory, such as OpenClaw's, whose sessions are filed under their agent id: `{ "project": "main" }` briefs on that project's entries and sessions. With a `cwd` too, the project's name is the one given; with neither, the server's own directory, as before. `origin recall --project <name>` previews it.
- OpenClaw's agents read Origin through the plugin for OpenClaw. With a hub, it gives the agents it records five tools, `origin_brief`, `origin_search`, `origin_get`, `origin_timeline`, and `origin_digest`, only in the turns OpenClaw resolves as its owner's private memory audience: never to the people an agent answers in a shared conversation, nor in someone else's turn, nor in a cron, heartbeat, or other detached run, since Origin keeps your sessions unredacted. The tools need OpenClaw 2026.10.6 or later; on an older one the plugin gives none and says so. They take the parameters of the MCP tools `brief`, `search`, `get`, `timeline`, and `digest` and hand each call to the hub's `/mcp` with the plugin's hub token, read from the Gateway's config as deliveries read it, so the token stays a SecretRef. `origin_brief` briefs an agent on the project its sessions are filed under, its agent id, as the turn's memory audience names it, unless `projectBy` or `project` says otherwise, and its description has the agent call it when a task may build on earlier work. The plugin's manifest adds the tools to OpenClaw's `coding`, `messaging`, and `full` tool profiles; the new option `tools: false` gives none. Install the new version of the plugin with `--force --accept-capabilities`, as before; the Gateway need not restart.
- Origin's hooks do nothing when another agent runs them: Grok Build and Cursor run the hooks in `~/.claude/settings.json`, and Grok's runs of them recorded recalls under `claude-code` that no session was handed. Those recorded before stay as they are.
- `origin agents` says when Codex has not trusted Origin's hooks yet, and when ZCode's hooks are off.

### Event lines sent to a hub

- The hub's answer to `POST /v1/sources/<name>/lines` adds `errors`: the first five lines that are not valid events, each with its number in the file and why, so that a writer in the cloud, which cannot read the hub's log, can fix itself.
- The guide to your own sources says how a bot that writes its own conversations marks what reached it: only what you wrote is `owner`; a prompt the platform adds, a scheduled trigger, or an alert is `system`, and another bot's message `agent`. It also says to send whole texts and ids without the source's name.

### Removed

- `origin distill` is removed, with `ORIGIN_DISTILL_COMMAND` and its guide page. Origin stores and serves your memory and runs no model; consolidating memory is left to agents that read it through the MCP tools and propose entries with `propose`. Proposals, and accepting or rejecting them in the CLI and the admin UI, are unchanged.

### Fixes

- A search that matches many events, of which its filters (a session, a project, a source, kinds) keep fewer than it needs, no longer runs forever when it has no start time: it ends once every match is read.

## [0.5.0] - 2026-11-06

Lets agents read along from any id, groups sessions into threads, archives each turn as it ends, has agents propose what you then review, brings in the sessions of any program, OpenClaw's included, tells your words from everyone else's, files each session under its main project, and connects agents and devices to your hub without copying tokens.

**Upgrading.** The store format moves from version 4 to version 10: the first command after the upgrade, or the hub as it starts, upgrades the store in place, once, step by step; to be safe, back it up first with `origin backup <dir>`. Two of the steps parse the archived logs again, to learn who wrote each message and which session is another's child, so on a large store this can take a minute or more; it says how far it is as it goes. Upgrade the hub before its devices: a hub of 0.4 refuses the recalls that name a thread and the files of your own sources, which a device keeps and sends once the hub is upgraded, and answers `404` to the event lines that the OpenClaw plugin and other writers post to it. After upgrading a hub, sign in to its admin UI once to choose your username; devices and agents keep their tokens. Then restart your agents, or at least their Origin MCP servers: an `origin mcp` started on 0.4.0 goes on writing to the upgraded store without knowing it should stop. From this version on, a process whose store a newer Origin has upgraded refuses to write and says to restart it, and `origin mcp` exits, so that its client starts it again. Then, on each device:

- Run `origin agents connect`, and then with `--yes`, to add the ingest hooks to Claude Code and Codex; in Codex, trust them with `/hooks`. Agents see the new MCP tools `changes`, `follow`, and `propose` in their next session.
- `origin sessions reproject` files the sessions archived before in a linked work tree, or in a subdirectory of a work tree, under their main project; until then they keep their directory's name. Run it on the device that holds them, not on a hub.
- `origin sessions parents` fills in the names of ZCode's workflow runs, and the parents of Grok Build sessions that only a summary names, reading both read-only.
- `origin sessions repair` gives a project, and a missing parent, to the sessions that an older `origin mcp` still running ingested after the upgrade.

Each of the three `origin sessions` commands takes `--dry-run`, which only reports what it would change.

### Reading along

- `get` opens any id Origin hands an agent, not only entries and events: a session (by its id, or as `<source>:<session id>`), a thread (`thr_…`), a recall (`rcl_…`), and a proposal (`prp_…`) too. Each comes back bounded, with what is next to it, one line each with its id, so that an agent follows what matters one hop at a time rather than reading whole sessions: an entry with its sources, history, and up to 10 related entries; an event with its turn and that turn's prompt, the event it follows, the two events on each side, and the entries that cite it; a session with where its first 20 turns start, its thread, the entries written from it, the recalls it was handed, and the sessions just before and after it in its project, of any agent.
- Long things are read a page at a time: `timeline` reads a session one turn (`turn`) or one page (`after`) at a time and says how many events follow (`more`), and `get` reads a long event from an `offset`, 20,000 characters at a time. MCP results name each event's session by its title or first prompt (`session_title`).
- `origin show <session id>` prints a session as the same card, with the id of each thing it lists, to show next; `--source` picks one when sessions of two agents share an id.

### Threads and changes

- Sessions that belong to one piece of work, with one agent or several, form a thread (`thr_…`), derived from the archive without a model: those an agent links with the new MCP tool `follow`, which it calls once when you take up work from an earlier session, and your conversations of one project on the same git branch, other than a default branch such as `main`, within 30 days of each other (Claude Code records the branch, and your own sources can give one). Nothing about a thread is written by hand: forgetting the event of a link, or every event of a session, takes the session out of it.
- The brief gives a thread of several sessions one line; `timeline` and `origin timeline` show each session's thread; `get` and `origin show thr_…` show a thread's sessions, agents, and branches, the entries written from them, and its last prompt; and in the admin UI a session's page names its thread, which has a page of its own.
- The new MCP tool `changes` tells an agent what reached the store since it last looked, oldest first and a page at a time: the sessions and events, the current entries, the proposals, and the forgets, by id only. It starts from the `next` of the agent's last call, or 24 hours back, and can be narrowed to a project, a thread, or a session. On a connected device it merges the device's changes with the hub's.

### Live ingestion

- Claude Code and Codex now hand Origin a session's new lines as each turn ends, so that other sessions, and your hub, see them a moment later. `origin agents connect` adds ingest hooks that run `origin sync --hook claude-code` (or `codex`) in the background at `Stop` and `SubagentStop`, and in Claude Code at `PostCompact` too. The agent never waits for them: a hook waits at most 3 seconds for the store and for the hub, prints nothing, and exits 0 whatever happens, saying why on standard error. On a machine connected before, run `origin agents connect` again to add them; Codex runs them once you trust them with `/hooks`. `origin mcp` still looks for new lines every minute, as the fallback and for the other agents.

### Proposals

- The new MCP tool `propose` hands you an entry to review instead of saving it: for what an agent infers and you have not confirmed, and for whatever it writes when it consolidates your memory for you. It takes the fields of `remember` and a note, and writes nothing: Origin reads the proposal from the agent's log, on every store that archives it. Until you accept it, a proposal is not knowledge: search, briefs, and recall leave it out.
- Only you accept or reject a proposal. `origin proposals` lists those waiting for you (`--status`, `--project`), and `origin show prp_…` shows one with the events it cites; `origin accept prp_… --yes` writes its entry, as you, citing those events and the proposal itself, and `origin reject prp_… --reason <text> --yes` forgets it, as a record that `origin restore` lifts. The admin UI has a Proposals page, with how many wait in the sidebar and on the overview, and accepts or rejects a proposal from its page.
- `origin distill` has Claude Code, run headless (`claude -p`) against this Origin's MCP server alone, with Origin's tools only and none of those that write, read a scope and propose entries for you to review: by default the last 24 hours of the project you are in, or another project (`--project`) or a thread (`--thread`), on one day (`--day`) or since a time (`--since`), with at most `--max` proposals (10) and `--max-turns` turns (40). `--dry-run` prints the prompt and the command and runs nothing. Afterwards it ingests the run's session and lists what it proposed. The run is a Claude Code session, paid for as any other; Origin itself calls no model, and schedules nothing.

### Your own sources

- Any program can bring its sessions to Origin as event lines: JSONL, one event per line, only ever appended to, with an `id`, `session`, `time`, `role`, `kind`, and `text`, and optionally a `title`, `project`, `cwd`, `branch`, `parent`, `author`, `speaker`, and `meta`. Its sessions then show wherever an agent's do: in the timeline, search, briefs, threads, the change feed, and the admin UI.
- On a device, each directory under `~/.origin/sources/` whose name has 2 to 32 lowercase letters, digits, and hyphens, starting with a letter, such as `chat-ops`, is a source of that name. Every `.jsonl` file below it is read by `origin sync` (`--source chat-ops` reads that one alone), and every minute by `origin mcp` while an agent runs; a `VERSION` file in it records the writer's version. Nothing else needs setting up, and Origin still makes no network calls: the writer polls or listens to its service itself. A device sends its sources to its hub like its agents' logs.
- A writer that runs on none of your devices, such as a bot or an agent runtime in the cloud, appends lines to your hub with `POST /v1/sources/<name>/lines?path=<path>`, at most 8 MiB at a time, with an agent's token of its own (`origin token create <name> --agent`). The hub answers how many lines it read, how many events were new, how many it already had, and how many were not valid; sending lines again is safe.

### OpenClaw

- A sixth package, `@openlinkos/origin-openclaw`, is a plugin for OpenClaw's Gateway that writes the sessions of OpenClaw's agents to Origin as event lines as each run ends: to your hub, with an agent's token, or into a directory that an Origin device on the same host reads, such as `~/.origin/sources/openclaw`. Install it with `openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities` and configure it under `plugins.entries.origin` in `~/.openclaw/openclaw.json`; it was checked against OpenClaw 2026.10.6. With `hooks.allowConversationAccess`, it sends every message, tool call, and result of a run; without it, what passes through the Gateway's message and tool hooks.
- Each user message says who wrote it, as OpenClaw records it: OpenClaw's owner, as OpenClaw decides it (`commands.ownerAllowFrom`), another person, another agent, or OpenClaw itself, by name and never by id. The plugin redacts nothing (`includeTools: false` sends no tool calls or results), never holds up the Gateway, keeps what it could not deliver in a spool that the next turn sends first, and reads the hub token, a SecretRef included, from the Gateway's config at each delivery.

### Who wrote it

- Origin records who wrote each input: you, another person, an agent, such as a parent agent prompting a sub-agent, or the system, such as the agent's runtime or a program (notices, summaries, reminders, command echoes). It reads this from what each agent writes for it, and event lines say it with `author` and `speaker`. A sub-agent's session or a workflow step is a child, all of whose input is the agent's, and all the input of a headless run (`claude -p`, `codex exec`) is the system's.
- Only your own prompts name a session without a title, start its turns, make it one of your conversations, which briefs list and branches join into threads, and are the words recall weighs. A `cognition`, your preference, can only come from your own words: one that cites messages none of which you wrote is refused.
- MCP results mark a message you did not write with `by` (`person`, `agent`, or `system`) and its `speaker`, when known, and the server tells agents that what it says is not your preference; the CLI and the admin UI show who wrote it beside it.
- From Claude Code, the prompts you type while the agent is busy, which it queues without writing a user line, are archived as your messages, those of sessions archived before included.

### Projects and parent sessions

- A session's project is now its main project: a session in a linked git work tree, or in a subdirectory of a work tree, belongs to the main checkout's project, named after its directory, rather than to its own directory's name. A name the agent or the line gave is kept, and a directory that is gone is resolved from what the store has learned or from the agent's own record of it. Listings, filters, threads, and briefs use this name; events keep the label their line wrote, and entries are not renamed, but a project filter finds an entry by either name. A device records what it resolved in `places.jsonl` and sends it to its hub, which learns the names from it. `origin sessions reproject` resolves the sessions archived before.
- A sub-agent's or a workflow step's session is recorded as the child of its parent when the agent's log names the parent: ZCode's sub-agents and workflow steps, and the sub-agents of Grok Build and Codex (Claude Code and Cursor name none). Lists show top-level sessions, each with how many children it has and the names of their workflows; `origin timeline --children` and `timeline`'s `include_children` list the children too, and the admin UI nests them under their parent. `get` and `origin show` list a parent's children by workflow run and name a child's parent, and a search hit in a child names its parent. A workflow step whose title contains `actor#N@M` is shown as `{run name} · actor#N@M`. `origin sessions parents` fills in what only ZCode's database or a Grok Build summary says.

### Personal hub

- **Devices and agents.** Every token is now a device's or an agent's (a cloud agent, a bot, or a pipeline), and an agent's is *read and write* or *read only*: a read-only agent has only the MCP tools that read, and sends nothing to the hub. The admin UI's Tokens page becomes Devices and agents: your devices with their tokens and the data they last sent, your agents with a token, and the agents signed in with OAuth, each revocable; **Add an agent** shows the token once with ready-made commands for Claude Code, Codex, and event lines. On the hub, `origin token create <name> --agent [--readonly]` creates an agent's token, `origin token list` lists them all, and `origin token revoke` revokes any. Tokens created before keep working as they did: each is a device's if the hub holds data only a device sends under its name, or if it was never used, and an agent's otherwise.
- **Agents sign in with OAuth.** With the admin UI served at `/admin` on the hub's address, the hub is the OAuth authorization server of its MCP endpoint, as MCP's authorization specification describes: `claude mcp add --scope user --transport http origin https://hub.example.com/mcp`, then `claude mcp login origin` (or `/mcp` in Claude Code), and `codex mcp add origin --url https://hub.example.com/mcp` with `codex mcp login origin`, open the hub in your browser, where you allow the agent, choosing what it may do and for how long, and no token is copied. It supports client metadata documents and dynamic registration, PKCE (`S256`) only, resource indicators, one-time codes, and refresh tokens that rotate, a reused one revoking the agent. A `401` from `/mcp` now says where the hub's OAuth metadata is. A proxy in front of the hub must also forward `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, and `/oauth/*`.
- **Devices connect by your approval.** `origin hub connect <url>` without `--token` prints a link and a code; open it, sign in to the admin UI, and approve "Connect device laptop to your hub?", and the device receives its token, under its store's name. `--token` keeps working, and is what a hub without the admin UI at `/admin` needs.
- **Your username.** A hub has one owner, and you now sign in to its admin UI with your username and the admin password. The first sign-in, on a new hub or on one upgraded from an earlier version, chooses the username, with the password you already have; `origin admin username <name>` changes it. The audit log names you by it.
- Opening a hub's address in a browser shows a public landing page instead of a bare JSON error: Origin's mark and name, one sentence on what the hub is, in English or Chinese, a **Sign in** button when the admin UI is served at `/admin`, and "Powered by Origin, open source" with links to the site and the source. It shows nothing from the store. A client that asks for JSON gets `{"service":"origin","docs":"https://origin.openlinkos.com/"}`, `/robots.txt` keeps search engines away from the whole hub, as a personal hub is not for search results, and `ORIGIN_POWERED_BY=off` leaves the credit out for a hub presented under its owner's name. A proxy in front of the hub should forward `/`, `/robots.txt`, and `/assets/*` too.
- Requests without a valid token are still refused with `401`; the JSON body now also has `docs`, the address of the hub's guide.
- Every page of the admin UI ends with Origin's version and links to the documentation, the source on GitHub, and the forms to report an issue, and the sign-in pages of a hub and of `origin ui` say under their form that Origin is open source.

### Tooling

- Asking for help (`origin --help`, `-h`, `help`, or `--help` after a command) and arguments a command does not take no longer open the store, so they never upgrade it.
- How long an unfinished ZCode message must stay unchanged before Origin archives it is now set with `ORIGIN_ZCODE_SETTLE_MS`: one hour by default, and `0` archives it at the next sync once its time has passed.

### Documentation

- New pages on the site: Connect OpenClaw, Bring your own source, and Consolidate. The site also serves `/llms.txt`, `/llms-full.txt`, and each page as Markdown, at its address with `.md` appended, for agents to read.

### Fixes

- On a device, two files of one source with the same path below its root, such as an agent's directory before and after it moved, no longer share one mirror, in which the second cut the first's lines short: a later file gets a mirror of its own. Files that already shared one go on, with their next lines, in a new generation with a mirror each, read again from the start; no upgrade step is needed.
- A device whose hub refuses a file (`400` or `413`, a proxy's error page included) says which and why, and still sends its other files, entries, and forgets; the refused file is tried again at the next sync, as a relay already did.

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

[0.7.0]: https://github.com/openlinkos/origin/releases/tag/v0.7.0
[0.6.1]: https://github.com/openlinkos/origin/releases/tag/v0.6.1
[0.6.0]: https://github.com/openlinkos/origin/releases/tag/v0.6.0
[0.5.0]: https://github.com/openlinkos/origin/releases/tag/v0.5.0
[0.4.0]: https://github.com/openlinkos/origin/releases/tag/v0.4.0
[0.3.0]: https://github.com/openlinkos/origin/releases/tag/v0.3.0
[0.2.0]: https://github.com/openlinkos/origin/releases/tag/v0.2.0
[0.1.0]: https://github.com/openlinkos/origin/releases/tag/v0.1.0
