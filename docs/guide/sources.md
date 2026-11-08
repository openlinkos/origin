# Bring your own source

Origin reads the logs of five coding agents, each with an adapter of its own. Much of your work happens elsewhere: in another agent runtime, a chat workspace, a notification stream, a notes pipeline. You can bring any of these to Origin without changing its code. Have a script write their events as **event lines**, a JSONL format of Origin's own, into a directory Origin reads, and they become sessions like any agent's: in the timeline, in search, in the briefs agents are handed, in threads and the change feed, and in the admin UI. For OpenClaw, Origin has a writer of its own, a plugin: see [Connect OpenClaw](./openclaw.md).

## The format

A file of event lines holds one JSON object per line, one event each, and is only ever appended to. Every line has six fields: an `id`, the `session` it belongs to, its `time`, a `role`, a `kind`, and its `text`. For example (synthetic):

```json
{"id":"msg-1001","session":"incident-42","time":"2026-11-02T09:30:00Z","role":"user","kind":"message","text":"Is the deploy stuck?","project":"demo-app","title":"Deploy incident"}
```

- `time` is ISO 8601 with an offset, such as `2026-11-02T09:30:00Z` or `2026-11-02T17:30:00+08:00`, or epoch milliseconds as a number.
- `role` is `user`, `assistant`, or `system`.
- `kind` is `message` for what was said, `tool_use` and `tool_result` for a call and what it returned, `meta` for context that was not said, such as an injected notice, and `system` for events of the system.
- Optional fields give a session its `title`, its `project` and working directory (`cwd`), its git `branch`, the line an event follows (`parent`), who wrote a message (`author`, `speaker`; see [Who wrote it](#who-wrote-it)), and anything else you want to keep (`meta`).

A line that is not valid, for example one without a `time`, is counted as a parse error and skipped; the others are read as usual. Every field and rule is in [Session sources](../sources.md#your-own-sources-event-lines).

## Write lines on a device

Each directory under `~/.origin/sources/` (or `$ORIGIN_HOME/sources/`) is a source, named after the directory, such as `chat-ops`. A name has 2 to 32 lowercase letters, digits, and hyphens, starts with a letter, and is not one of the built-in sources (`claude-code`, `codex`, `cursor`, `grok`, `zcode`) or `origin`, `hub`, `local`, `all`, and `devices`; Origin ignores a directory with any other name and says so when it syncs. Every `.jsonl` file below the directory is read, at any depth, so a writer can keep a file per day, per channel, or per run. There is nothing else to set up.

From a shell:

```bash
mkdir -p ~/.origin/sources/chat-ops
echo '{"id":"msg-1002","session":"incident-42","time":"2026-11-02T09:31:00Z","role":"assistant","kind":"message","text":"It waits on a migration lock.","parent":"msg-1001"}' \
  >> ~/.origin/sources/chat-ops/incidents.jsonl
origin sync --source chat-ops
```

From Node:

```js
// append-event.mjs: append one event line to the source chat-ops.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const home = process.env.ORIGIN_HOME || join(homedir(), '.origin');
const file = join(home, 'sources', 'chat-ops', 'incidents.jsonl');
mkdirSync(dirname(file), { recursive: true });
const event = {
  id: 'msg-1003',
  session: 'incident-42',
  time: new Date().toISOString(),
  role: 'user',
  kind: 'message',
  text: 'Release the lock, then retry the deploy.',
  project: 'demo-app',
};
appendFileSync(file, `${JSON.stringify(event)}\n`);
```

- **Whole lines.** Origin reads only complete lines, so append each line at once, ending with a line break; a line still being written is read once it ends.
- **When it is read.** `origin sync` reads every source, and `origin sync --source chat-ops` this one; while an agent runs, `origin mcp` looks for new lines every minute; `origin ui` reads them when it starts. `origin status` lists the source with its sessions and events.
- **Its version.** A `VERSION` file in the directory, with a version on its first line, such as `chat-bridge 1.4.2`, is recorded with the events as their agent's version.
- **To your hub.** On a device connected to a [personal hub](./hub.md), `origin sync` sends the source's archived lines to the hub as it sends every agent's, and a relay sends the files' new lines straight to it.

## Send lines to your hub

A writer that runs on none of your devices, such as a chat bot or an agent runtime in the cloud, can send its lines straight to your [personal hub](./hub.md) instead. Give it an agent's token of its own, created on the hub and named after it, such as `origin token create chat-bridge --agent`, and post lines:

```bash
curl -sS -X POST "https://hub.example.com/v1/sources/chat-ops/lines?path=2026/11/02.jsonl" \
  -H "Authorization: Bearer $ORIGIN_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @lines.jsonl
```

```json
{ "lines": 2, "events": 2, "duplicates": 0, "parse_errors": 0, "purged": 0, "errors": [] }
```

- **Where they go.** The hub keeps the lines as file `path` of the source, here `2026/11/02.jsonl` of `chat-ops`, sent by the token's name, `chat-bridge`, and reads them as it reads what a device sends. They stay on the hub: devices never download them, and agents find them through the hub, as everything else there.
- **The body.** Event lines, at most 8 MiB, as `application/x-ndjson` or `text/plain`, possibly gzip-encoded. Use `--data-binary`, which sends a file as it is, rather than `-d`, which drops its line breaks; one line without a line break at the end, as `-d '{"id":…}'` sends it, is fine.
- **The answer.** How many lines the hub read, how many new events they gave, how many it already had (`duplicates`), how many are not valid events (`parse_errors`), which it keeps but reads nothing from, and how many it stored blank because you purged what they hold (`purged`, see [Purging](./cli.md#purging)); `errors` describes the first five of those, each with its line's number in the file and why, such as `{ "line": 7, "error": "\"author\" is only for lines whose \"role\" is user" }`. Fix the writer and go on appending to the same file: a line once read is kept, valid or not, so sending it again in a new file only adds a copy.
- **Sending again.** If you do not know whether a request arrived, send it again: lines the hub already has add nothing.
- **A token of its own.** A device's token works too, and sends as that device; lines sent with it under a path that the device's own `sources/` directory also has are kept in a file of their own, beside the device's.

## Choose ids and sessions

- **An id names one event, for good.** Give every event of a source its own `id`, and the same one each time you write it: the writer's own id, such as a chat message's, serves best. A line whose `id` the source already has adds nothing, so writing a line again, when you are not sure it was written, is safe. Sources of one name on several of your devices are one source on your hub, so their ids must not collide either.
- **Lines are never changed.** Like Origin's whole archive, a source is append-only: an event, once read, keeps its text. To say something else, write a new event with a new id.
- **A session is one conversation.** A chat thread, an incident, a run of a job, a day of notes: whatever you would want to open as a whole. Its events are shown in time order, whichever file holds them.
- **Ids Origin gives its own objects** start with `ent_`, `thr_`, `rcl_`, or `prp_`; do not start a session id with them, since `get` would read it as one of those.

## A bot that writes its own conversations

An agent or a bot that sends its own conversations, say a cloud bot keeping a copy of each chat, writes what happened, as it happened, and says who wrote each input:

- **Inputs and replies.** What reached the bot is a line whose `role` is `user`, with its `author` (see [Who wrote it](#who-wrote-it)); the bot's own replies, tool calls, and tool results are `assistant` lines, with no `author` or `speaker`. A reply is a `message`, even one the bot sends through a tool, such as a call that posts to the chat: its line holds the text it sent. A reply that also calls tools is a line for its text and one for each call. Thinking is left out, as Origin's adapters leave it out. Several bots writing to one source put their names in `meta`, and give each its own sessions.
- **The words alone.** A message's `text` is what was written: take off the markup a platform wraps around a turn, such as a timestamp, a query tag, or the id of the machine it came from. The time goes in `time`, and what else is worth keeping in `meta`. Keep `meta` short, such as the bot's name and the platform's id for the message: it is kept with every line, and is not a second copy of it.
- **Only your words are yours.** A prompt the platform adds unseen, a scheduled task's trigger, an alert, and a run's report are `system`; what another bot hands over is `agent`, with that bot's name as `speaker`. Origin takes `owner` lines for your words: they weigh what recall finds, and are your prompts in a session's page and a day's digest.
- **The whole text.** Send each message as it was, not cut short: a request holds 8 MiB.
- **Not its own upkeep.** The runs in which the bot copies its conversations to Origin are not among them: leave them out. A job that only copies lines needs no model: a script that reads the platform's history and posts it does the same.
- **Ids and titles.** An `id` is the bot's own id for the message, without the source's name, which Origin adds (`<source>:<id>`). Give a `title` only when the conversation has one; without it, Origin names a session by its first prompt of yours.
- **Mistakes.** Lines already read are not changed. To replace them, ask for the wrong events to be forgotten and send the right ones with new ids, best under the source's final name.

## Who wrote it

Origin records who wrote each message: you, someone else, an agent, or a program. It never takes a message for yours on its own: your source says so, with `author`, on a line whose `role` is `user`.

- `"author": "owner"` for what you wrote yourself: your messages in a chat workspace, your notes, your lines in a transcript once you know which speaker you are.
- `"author": "person"` for someone else, or a speaker nobody named. A `message` line without `author` is a person's.
- `"author": "agent"` for an agent: a bot replying in a channel, one agent prompting another.
- `"author": "system"` for what a program generated: a notice, an alert, a scheduled prompt. A `meta` line without `author` is the system's.
- `"speaker"` says who it was, as people know them: `"Sam"`, `"Speaker 2"`, a bot's name, at most 200 characters. Never put a platform's user id there: Origin shows it as it is, and identifies no one.

```json
{"id":"msg-2001","session":"incident-42","time":"2026-11-02T09:32:00Z","role":"user","kind":"message","text":"Roll back the migration.","author":"owner"}
{"id":"msg-2002","session":"incident-42","time":"2026-11-02T09:33:00Z","role":"user","kind":"message","text":"Rolling it back now.","author":"person","speaker":"Sam"}
```

A recording with no speaker information says nothing, and its lines are a person's. Your own messages count for more than others': only they name a session without a title, start its turns, make it one of your conversations, which briefs list and branches join into threads, and are the words recall weighs. The rules, and how each agent's logs say who wrote a message, are in [Authors](../architecture.md#authors).

## Titles, projects, and threads

- **Titles.** A line with a `title` names its session, and the latest wins. Add `"title_by": "user"` to a title the person gave: a later title without it does not replace it, as a session you renamed in Claude Code keeps its name. Without a title, a session is named by the first message you wrote in it (`"author": "owner"`), as for any agent.
- **Projects.** `project` names the project. A line that sets it keeps that name. Otherwise Origin uses the main git work tree — a linked work tree is the project it was made from — or, failing that, the last segment of `cwd`, such as `demo-app`. With `cwd`, briefs tell two checkouts with the same name apart, and two directories of one work tree are one project once the resolution is known (see [Projects](../architecture.md#projects)). An agent that starts in a project is handed the project's latest conversations of yours, of any source: a session of your source is one once it holds a message of yours.
- **Threads.** Your conversations of a project on the same `branch`, other than a default branch such as `main`, within 30 days of each other, form a [thread](./concepts.md#threads) with each other and with your sessions with agents on that branch. An agent can also join its session to one of yours with `follow`.

## What you see

Once synced, a source's sessions are in every view of Origin, the same as an agent's:

```bash
origin timeline --source chat-ops      # its sessions, with their threads
origin show incident-42                # one session, with its turns
origin search "migration lock"         # its messages, among everything else
origin recall --cwd ~/code/demo-app    # what an agent there is handed
```

- In the [admin UI](./admin.md), it is listed under its name, in a neutral colour.
- Through MCP, `timeline`, `search`, `get`, and `brief` show its sessions and events, and `changes` lists its new events as they arrive, so that an agent that looks every few minutes sees them.
- Agents can cite its events in entries, and you can forget them, as any events.

## Limits

- **Origin calls no network for you.** It reads files. A writer that takes events from a chat workspace or a notification service runs on its own, polling the service or subscribing to it, and appends lines; Origin never reaches the service, and needs no credentials for it.
- **It looks; nothing tells it.** Your sources have no hooks: their lines arrive with the next `origin sync`, or within a minute while an agent runs `origin mcp`; lines sent to the hub are read as they arrive.
- **Not for memories.** The `memory` kind is refused: imported memories come only from the memory files agents keep for themselves. To record a decision or a fact, save an entry, citing the event.
- **Not a place to edit.** A file rewritten rather than appended to is read again from its start, as a new generation, and its events that Origin has already read stay as they were.
