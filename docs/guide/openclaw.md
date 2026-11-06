# Connect OpenClaw

[OpenClaw](https://docs.openclaw.ai) runs agents in its Gateway, often on a server where no Origin device runs, and keeps their transcripts in a database of its own. Origin's plugin for OpenClaw, `@openlinkos/origin-openclaw`, sees each turn inside the Gateway as it ends and writes it to Origin as [event lines](./sources.md): to your [personal hub](./hub.md), or into a directory that an Origin device on the same host reads. The sessions of your OpenClaw agents then show in Origin like any agent's. With a hub, the plugin also gives those agents Origin's read tools, so that they are briefed on their own work and can look up the rest of your memory (see [Read Origin from your agents](#read-origin-from-your-agents)).

The plugin was checked against OpenClaw 2026.10.6: its hooks and their payloads, its plugin manifest, and its install command as that version has them; its tools follow that version's documentation of plugin tools.

## What it sends

- **Each turn, as it ends.** With conversation access (see [below](#with-or-without-conversation-access)), the plugin reads the run's messages when it ends (`agent_end`), and before OpenClaw compacts them away (`before_compaction`). Without it, it builds each turn from the message that arrived (`message_received`), the tool calls (`after_tool_call`), and each reply as it is sent (`message_sent`).
- **Messages and tools.** The user's messages, the agent's replies, its tool calls (`tool_use`) and their results (`tool_result`), cut to 2,000 and 4,000 characters as Origin's adapters keep them. The context OpenClaw adds to a turn, and the summaries it writes when it compacts a session, are kept as `meta`. Thinking is left out.
- **Who wrote each message.** Each user message says who wrote it, as OpenClaw records it: OpenClaw's owner, another person, another agent, or OpenClaw itself, and by what name (see [below](#who-wrote-each-message)).
- **Sessions.** One session per OpenClaw session key, such as `agent:main:telegram:direct:42`, titled once by its first user message, cut to 80 characters and without the channel's envelope. `/new` and `/reset` keep the key, so the conversation goes on in the same session in Origin; each line's `meta.sessionId` tells OpenClaw's sessions apart.
- **Projects.** Each session's project is its agent's id, such as `main`, unless you name it after the channel or give one name to all (`projectBy`, `project`).
- **Context.** Each line's `meta` holds the agent, the channel and its account, the session key and id, and the run, as OpenClaw gives them; a tool line also holds the tool's name and its call's id (`callId`), which pairs a call with its result.
- **Stable ids.** A line's id is a hash of its session, its message's time, its role and kind, and its place in the message, not of who wrote it, so a message sent again, as after a lost answer or a restart, has the same id, and Origin adds nothing for it.
- **What it leaves out.** The agents you do not list (`agents`); runs that are not a person's turn (`triggers`), such as heartbeats and cron jobs, with the messages they add; and incognito threads.
- **What happened, as it was.** Nothing in a line is redacted: a message, a tool call, or a tool's result is sent as the run had it, with whatever secret it holds, such as a token pasted into a message or a value a password manager's tool returned. To send no tool calls or results at all, set `includeTools` to `false`.

## Install

Install it on the Gateway's host with OpenClaw's command; `--pin` records the version it installs, and `npm:@openlinkos/origin-openclaw@<version>` picks one, such as your Origin's:

```bash
openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities
```

To try a change before it is released, build it from a checkout of Origin and install the tarball; build it anywhere and copy the file to the Gateway's host:

```bash
git clone https://github.com/openlinkos/origin.git && cd origin
pnpm install && pnpm build
cd packages/openclaw && pnpm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/openlinkos-origin-openclaw-*.tgz --force --accept-capabilities
```

`openclaw plugins install ./packages/openclaw --force --accept-capabilities` installs the built directory instead, and `-l` links it rather than copying it. `--force` confirms that you trust a source outside ClawHub, and `--accept-capabilities` approves the capability review OpenClaw asks for with a plugin from such a source. Its id in OpenClaw is `origin`. Then configure it as below; `openclaw plugins inspect origin --runtime --json` shows the hooks and tools it registered. Installing a new version applies to the running Gateway; the Gateway need not restart.

## Configure

The plugin's settings go in the Gateway's config, `~/.openclaw/openclaw.json`, under `plugins.entries.origin`. For a hub, with the token in 1Password, recording one agent:

```json
{
  "plugins": {
    "entries": {
      "origin": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "hub": "https://hub.example.com",
          "token": { "source": "exec", "provider": "onepassword", "id": "op://OpenClaw/origin-hub/credential" },
          "agents": ["main"]
        }
      }
    }
  }
}
```

| Option | Default | What it does |
|---|---|---|
| `hub` | | Your hub's URL; set this or `dir` |
| `token` | | The hub token: a SecretRef, which the Gateway resolves, or the token itself |
| `tokenEnv` | | The name of an environment variable of the Gateway that holds the token, instead of `token` |
| `dir` | | A directory an Origin device on this host reads, such as `~/.origin/sources/openclaw`; set this or `hub` |
| `source` | `openclaw` | The source the hub records the lines under; in a directory, the directory's name is the source |
| `agents` | every agent | The ids of the agents to record |
| `triggers` | `["user"]` | The kinds of runs to record: `user` for a person's turns, and `cron`, `heartbeat`, and the others OpenClaw names |
| `projectBy` | `agent` | Name each session's project after its agent (`agent`) or its channel (`channel`) |
| `project` | | One project for every session, instead of `projectBy` |
| `includeTools` | `true` | Send tool calls and their results |
| `reconcileOnEnd` | `false` | When a session ends, read the end of its transcript, up to 200 messages, and send what was never sent; needs conversation access |
| `tools` | `true` with a hub | Give the agents Origin's read tools (see [below](#read-origin-from-your-agents)); `false` gives none. Without a hub, there are none |
| `spoolDir` | `origin-openclaw/` in OpenClaw's state directory | Where the plugin keeps the lines it could not deliver yet, and the record of those it sent |
| `timeoutMs` | `5000` | How long one delivery to the hub may take, in milliseconds |

OpenClaw applies a change to this block by reloading the plugin; the Gateway need not restart. On a reload, OpenClaw registers the plugin before it resolves a SecretRef, so the plugin reads the hub token from the Gateway's config as it runs, SecretRefs resolved, each time it delivers or an agent calls one of its tools: until the Gateway has resolved the token, the lines wait in the spool, the tools say so to the agent, and the log says once when it has, in a line that starts with `origin: the Gateway resolved the hub token`. A token you change in the config is used from the next delivery on. A plugin whose settings are not valid records nothing and says why, once, in the Gateway's log, in a line that starts with `origin: not recording`; a valid one logs a line that starts with `origin: recording`.

### With or without conversation access

OpenClaw lets a plugin it does not bundle read a run's messages at its end only with `hooks.allowConversationAccess` set to `true` in its entry, beside `config`, not inside it. The plugin reads that setting, as OpenClaw does, and records accordingly:

- **With it**, the plugin sees each run as the model saw it: every message, every tool call and result, whichever channel, and runs nobody sent a message for. It also knows which kind of run each was, for `triggers`. This is the way to use it.
- **Without it**, it sees what goes through the Gateway's message and tool hooks: each message that arrives on a channel, each tool call, and each reply sent to a channel, which sends the turn so far. It cannot tell a heartbeat or a cron run from a person's turn except by its session key, nor whether a sender is OpenClaw's owner, and it misses what is not sent to a channel. Drop `hooks` from the block above to use it this way.

### Send to your hub

Create an agent's token on the hub, named after the Gateway's host, and give it to the plugin:

```bash
origin token create openclaw-us --agent   # on the hub, or: docker exec origin-hub origin token create openclaw-us --agent
```

The token's name is the device the lines are recorded under: the hub keeps them as files of the source `openclaw` sent by `openclaw-us`, beside what your devices send. Give each Gateway a token of its own. The plugin's read tools call the hub with the same token, so it must not be `--readonly`, which the hub lets read but not send lines. Keep the token out of `openclaw.json`: as a SecretRef, as above, the Gateway resolves it from 1Password, and the plugin reads it, resolved, from the Gateway's config; or put it in an environment variable of the Gateway's service and name that variable:

```json
{ "hub": "https://hub.example.com", "tokenEnv": "ORIGIN_HUB_TOKEN" }
```

Deliveries never hold up the Gateway: each turn is handed to a queue that sends one request at a time, waits at most `timeoutMs` for the hub, and keeps what it could not send in a spool, which the next turn and the Gateway's next start send first, in order. A request the hub refuses as invalid is set aside in `rejected/` beside the spool and never sent again.

### Write to a directory

When an Origin device runs on the Gateway's host, the plugin can write into the device's own sources instead, and the device reads them, and pushes them to its hub, like any [source of your own](./sources.md#write-lines-on-a-device):

```json
{ "dir": "~/.origin/sources/openclaw" }
```

Each line goes to `<agent>/<yyyy>/<mm>/<session>.jsonl` below the directory, one file per session and month (UTC), and a `VERSION` file records OpenClaw's version and the plugin's, which Origin keeps with the events. The device reads new lines with `origin sync`, and every minute while an agent runs `origin mcp`.

## What you see in Origin

```bash
origin timeline --source openclaw                       # the sessions, newest first
origin timeline --session agent:main:telegram:direct:42 # one session, with its turns
origin search "migration lock" --source openclaw        # its messages, among everything else
```

On the hub, the sessions appear in the [admin UI](./admin.md) under `openclaw`, and agents connected to the hub find them through `search`, `timeline`, and `get`. A line's provenance leads to the hub's mirror of the file it was sent in, `raw/devices/openclaw-us/openclaw/…`, and through `origin show` to the line as the plugin wrote it.

With a hub, your OpenClaw agents read it too, through the plugin's tools (see [below](#read-origin-from-your-agents)). An agent that reaches your hub's MCP server some other way also works in no directory, so it asks `brief` for the project its sessions are filed under, its agent id unless you set `projectBy` or `project`: `{ "project": "main" }` (see [MCP tools](./mcp.md#brief)).

## Read Origin from your agents

With a hub, the plugin gives the agents it records five tools, the [MCP tools](./mcp.md) of Origin's that read:

| Tool | What it does | MCP tool |
|---|---|---|
| `origin_brief` | What your memory holds for the agent's project: your preferences, the project's latest decisions and facts, and its latest sessions with any agent; with `about`, also the entries and past messages that match the task | `brief` |
| `origin_search` | Full-text search over your entries and archived sessions | `search` |
| `origin_get` | Opens any id Origin hands over, with what is next to it | `get` |
| `origin_timeline` | Sessions in a time range, or the events of one session, a page at a time | `timeline` |
| `origin_digest` | What happened on one day, from the store alone | `digest` |

Each takes the parameters of its MCP tool and hands the call to your hub's MCP endpoint, `POST /mcp`, with the hub and the token of the plugin's config: the token it delivers lines with, read from the Gateway's config at each call, so a SecretRef stays a SecretRef. This is why the plugin brings tools of its own rather than having you add the hub to OpenClaw's `mcp.servers`: OpenClaw 2026.10.6 resolves no SecretRef in an MCP server's headers, so the token would sit in `openclaw.json` as plain text. The tools write nothing but the recall the hub records for each brief, as for any agent's (see [Recall](./recall.md)): made for the agent `openclaw`, the plugin's `source`, on the device its token is named after.

- **Briefed on its own project.** `origin_brief` takes no directory: it briefs an agent on the project the plugin files the agent's sessions under, by the same rule, its agent id unless you set `projectBy` or `project`. The agent may name another `project`, and pass `about`, what the task is about. The tool's description has the agent call it when it starts a task that may build on earlier work, and before it answers a question about past work, decisions, or your preferences; the ids it lists open with `origin_get`.
- **For the agents it records.** An agent that `agents` leaves out does not get the tools. To keep them from an agent the plugin records, deny them in OpenClaw's tool policy for that agent.
- **In OpenClaw's tool profiles.** The plugin's manifest adds the tools to the `coding`, `messaging`, and `full` profiles, so an agent with one of these sees them. With `minimal`, or an allowlist of your own in `tools.allow`, add their names, or the plugin's id `origin` for all five, to `tools.allow` or `tools.alsoAllow`. If you set `plugins.allow`, it must name `origin`, as it must for the plugin to record.
- **When they cannot answer**, they fail with a line the agent reads: the hub refused the token (`401`), cannot be reached, did not answer within 15 seconds, or the Gateway has not resolved the token yet. The token is never in it.
- **To give no tools**, set `tools` to `false`.

To check, list what the plugin registered, then ask an agent, in a new session, about earlier work, such as "what did we decide about the deploy?":

```bash
openclaw plugins inspect origin --runtime --json   # the hooks, and the five origin_ tools
```

The agent calls `origin_brief`, or `origin_search`, and answers from what it is handed. On the hub, `origin show <recall id>` shows what a brief handed over, by the id the brief begins with.

## Who wrote each message

Each user message's line says who wrote it, in the [event-line](../sources.md#your-own-sources-event-lines) fields `author` and `speaker`. It records what OpenClaw keeps with the message, as a fact: neither the plugin nor Origin judges a message or works out who anyone is.

| The message, as OpenClaw records it | `author` | `speaker` |
|---|---|---|
| From a sender OpenClaw takes for its owner | `owner` | Their name on the channel, when it gives one |
| From anyone else, or from a sender OpenClaw does not know | `person` | Their name, or else their username, on the channel, when it gives one |
| From a bot on the channel | `person`, and `meta.senderKind` is `bot` | Its name |
| Routed from another session (`inter_session`): `sessions_send`, a sub-agent's report, a tool's completion | `agent` | The sending agent's name in the Gateway's config (`name`, or `identity.name`), or else its id; without a sending session, the tool |
| Made by OpenClaw itself (`internal_system`): cron jobs, heartbeats, wake-ups, recovery after a restart | `system` | |

The context OpenClaw adds to a turn stays a `meta` line with neither field, which event lines read as the system's. No line carries a sender's id, in `speaker` or in `meta`: a name that is only the sender's id is left out.

- **The owner is whom OpenClaw names.** OpenClaw marks a message as its owner's when the sender matches an entry of `commands.ownerAllowFrom` in the Gateway's config, such as `telegram:<your user id>`, or writes in the Control UI as an operator with `operator.admin`. The plugin has no setting of its own for this. Your accounts that the list leaves out are recorded as a `person`'s: if it names only your Discord account, your messages on Telegram, Feishu, or WeChat are recorded as `person` until you add those accounts to `commands.ownerAllowFrom`. Adding an account there also gives it what OpenClaw keeps for its owner, such as owner-only commands and exec approvals.
- **From an internal field.** The sender's facts, whether OpenClaw takes the sender for its owner, their name, and whether they are a bot, come from `__openclaw`, a field OpenClaw keeps on its messages for itself and does not declare to plugins; whether a message was routed or made by OpenClaw comes from its `provenance`. The plugin was checked against how OpenClaw 2026.10.6 writes them, and is checked again with each OpenClaw version it supports.
- **From the copy OpenClaw persists.** OpenClaw 2026.10.6 writes these facts onto the copy of a user message it persists in the session's transcript, not onto the copy the run holds, which `agent_end` gives. So the plugin listens to OpenClaw's transcript updates (`api.runtime.events.onSessionTranscriptUpdate`, which is not a hook and changes nothing OpenClaw does), notes who wrote each user message by its session and a hash of its text, and gives that to the message's line when the run ends. Messages with the same text in a session pair in the order they were persisted. It keeps no text, and at most 50 messages a session, 200 sessions, and two hours; a session's notes go when it ends. A line's id does not depend on any of this.
- **When it cannot tell**, it records a message as a `person`'s, without a name: a message persisted before the plugin was loaded, such as the history a session's first turn sends after the plugin is installed, or a turn whose text is not that of any message OpenClaw persisted, as when OpenClaw puts queued messages together into one prompt.
- **Without conversation access**, the plugin sees only the message hooks, which give the sender's name but not whether OpenClaw takes the sender for its owner: every message that arrives is recorded as a `person`'s, by that name, and nothing as the owner's.

## Limits

- **From the time it is installed.** The plugin sends what the Gateway's runs show it. The first turn of a session sends the session's history as the model sees it then; what OpenClaw compacted away before is only in its summary.
- **One session per key.** A session key's conversations, before and after `/new`, are one session in Origin.
- **At the end of a run.** Lines are sent when a run ends, or before OpenClaw compacts them. A run cut short by a crash of the Gateway is sent with the session's next run, from the history; `reconcileOnEnd` also reads an ended session's transcript.
- **Secrets are sent as they are.** The plugin redacts nothing, so a secret that reaches a run reaches Origin. Hide an event that holds one with `origin forget` (see [Forgetting](./privacy.md#forgetting)).
- **Retries ride on turns.** The spool is sent with the next turn and when the Gateway starts, not on a timer of its own.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Nothing reaches Origin | The Gateway's log: `origin: not recording: …` says what to fix in the config; `openclaw plugins inspect origin --runtime --json` lists the hooks it registered |
| An agent has no `origin_brief` | `openclaw plugins inspect origin --runtime --json` lists the tools, and the Gateway's log has a line that starts with `origin: giving`; the agent is among `agents`; OpenClaw's tool policy lets the tools through for it (see [Read Origin from your agents](#read-origin-from-your-agents)) |
| A tool fails with `Origin's hub refused the plugin's token (401)` | The token is wrong or was revoked: create a new one on the hub |
| A tool fails with `Origin cannot be read yet` | The Gateway has not resolved the token's SecretRef: fix it, as for deliveries |
| The log says `origin: recording … from the message hooks` | Conversation access is off: set `hooks.allowConversationAccess` to `true` in the entry, beside `config`, not inside it |
| `cannot deliver to …: the hub answered 401` | The token is wrong or was revoked: create a new one on the hub |
| `cannot deliver to …: the Gateway has not resolved the hub token's SecretRef yet` | The Gateway could not resolve the token's SecretRef, such as a 1Password reference it cannot read: fix it; the lines wait in the spool and are sent once it resolves |
| Your own messages show as `person` | The account you wrote from is not in OpenClaw's `commands.ownerAllowFrom`, the plugin has no conversation access, or it did not see the message persisted (see [Who wrote each message](#who-wrote-each-message)) |
| `the hub answered 404` | The hub runs an Origin from before `/v1/sources/<name>/lines`: upgrade it; the lines wait in the spool |
| `… lines wait in …/spool` | The hub could not be reached; they are sent with the next turn, or when the Gateway starts |
| A directory's lines never show | Its name must be a source's: 2 to 32 lowercase letters, digits, and hyphens, such as `openclaw`; `origin status` lists the source once it is read |
