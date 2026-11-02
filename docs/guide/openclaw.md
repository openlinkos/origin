# Connect OpenClaw

[OpenClaw](https://docs.openclaw.ai) runs agents in its Gateway, often on a server where no Origin device runs, and keeps their transcripts in a database of its own. Origin's plugin for OpenClaw, `@openlinkos/origin-openclaw`, sees each turn inside the Gateway as it ends and writes it to Origin as [event lines](./sources.md): to your [personal hub](./hub.md), or into a directory that an Origin device on the same host reads. The sessions of your OpenClaw agents then show in Origin like any agent's.

The plugin was checked against OpenClaw 2026.10.6: its hooks and their payloads, its plugin manifest, and its install command as that version has them.

## What it sends

- **Each turn, as it ends.** With conversation access (see [below](#with-or-without-conversation-access)), the plugin reads the run's messages when it ends (`agent_end`), and before OpenClaw compacts them away (`before_compaction`). Without it, it builds each turn from the message that arrived (`message_received`), the tool calls (`after_tool_call`), and each reply as it is sent (`message_sent`).
- **Messages and tools.** The user's messages, the agent's replies, its tool calls (`tool_use`) and their results (`tool_result`), cut to 2,000 and 4,000 characters as Origin's adapters keep them. The context OpenClaw adds to a turn, and the summaries it writes when it compacts a session, are kept as `meta`. Thinking is left out.
- **Sessions.** One session per OpenClaw session key, such as `agent:main:telegram:direct:42`, titled once by its first user message, cut to 80 characters and without the channel's envelope. `/new` and `/reset` keep the key, so the conversation goes on in the same session in Origin; each line's `meta.sessionId` tells OpenClaw's sessions apart.
- **Projects.** Each session's project is its agent's id, such as `main`, unless you name it after the channel or give one name to all (`projectBy`, `project`).
- **Context.** Each line's `meta` holds the agent, the channel and its account, the session key and id, and the run, as OpenClaw gives them; a tool line also holds the tool's name and its call's id (`callId`), which pairs a call with its result.
- **Stable ids.** A line's id is a hash of its session, its message's time, its role and kind, and its place in the message, so a message sent again, as after a lost answer or a restart, has the same id, and Origin adds nothing for it.
- **What it leaves out.** The agents you do not list (`agents`); runs that are not a person's turn (`triggers`), such as heartbeats and cron jobs, with the messages they add; incognito threads; and every result of the 1Password plugin's agent tool (`onepassword`), which returns secret values. Before a line leaves the Gateway, Origin tokens (`ogn_…`) and 1Password references (`op://…`) in it are replaced with `[redacted]`.

## Install

Once the package is on npm, install it on the Gateway's host with OpenClaw's command; `--pin` records the version it installs, and `npm:@openlinkos/origin-openclaw@<version>` picks one, such as your Origin's:

```bash
openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities
```

Before then, or to try a change, build it from a checkout of Origin and install the tarball; build it anywhere and copy the file to the Gateway's host:

```bash
git clone https://github.com/openlinkos/origin.git && cd origin
pnpm install && pnpm build
cd packages/openclaw && pnpm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/openlinkos-origin-openclaw-*.tgz --force --accept-capabilities
```

`openclaw plugins install ./packages/openclaw --force --accept-capabilities` installs the built directory instead, and `-l` links it rather than copying it. `--force` confirms that you trust a source outside ClawHub, and `--accept-capabilities` approves the capability review OpenClaw asks for with a plugin from such a source. Its id in OpenClaw is `origin`. Then configure it as below; `openclaw plugins inspect origin --runtime --json` shows the hooks it registered.

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
| `spoolDir` | `origin-openclaw/` in OpenClaw's state directory | Where the plugin keeps the lines it could not deliver yet, and the record of those it sent |
| `timeoutMs` | `5000` | How long one delivery to the hub may take, in milliseconds |

OpenClaw applies a change to this block by reloading the plugin; the Gateway need not restart. A plugin whose settings are not valid records nothing and says why, once, in the Gateway's log, in a line that starts with `origin: not recording`; a valid one logs a line that starts with `origin: recording`.

### With or without conversation access

OpenClaw lets a plugin it does not bundle read a run's messages at its end only with `hooks.allowConversationAccess` set to `true` in its entry, beside `config`, not inside it. The plugin reads that setting, as OpenClaw does, and records accordingly:

- **With it**, the plugin sees each run as the model saw it: every message, every tool call and result, whichever channel, and runs nobody sent a message for. It also knows which kind of run each was, for `triggers`. This is the way to use it.
- **Without it**, it sees what goes through the Gateway's message and tool hooks: each message that arrives on a channel, each tool call, and each reply sent to a channel, which sends the turn so far. It cannot tell a heartbeat or a cron run from a person's turn except by its session key, and it misses what is not sent to a channel. Drop `hooks` from the block above to use it this way.

### Send to your hub

Create a token on the hub, named after the Gateway's host, and give it to the plugin:

```bash
origin token create openclaw-us       # on the hub, or: docker exec origin-hub origin token create openclaw-us
```

The token's name is the device the lines are recorded under: the hub keeps them as files of the source `openclaw` sent by `openclaw-us`, beside what your devices send. Give each Gateway a token of its own. Keep the token out of `openclaw.json`: as a SecretRef, as above, the Gateway resolves it from 1Password when it loads the plugin; or put it in an environment variable of the Gateway's service and name that variable:

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

## Limits

- **From the time it is installed.** The plugin sends what the Gateway's runs show it. The first turn of a session sends the session's history as the model sees it then; what OpenClaw compacted away before is only in its summary.
- **One session per key.** A session key's conversations, before and after `/new`, are one session in Origin.
- **At the end of a run.** Lines are sent when a run ends, or before OpenClaw compacts them. A run cut short by a crash of the Gateway is sent with the session's next run, from the history; `reconcileOnEnd` also reads an ended session's transcript.
- **Redaction is narrow.** It replaces Origin tokens and 1Password references, and leaves out the 1Password tool's results. A secret that reaches a message any other way is sent as it is.
- **Retries ride on turns.** The spool is sent with the next turn and when the Gateway starts, not on a timer of its own.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Nothing reaches Origin | The Gateway's log: `origin: not recording: …` says what to fix in the config; `openclaw plugins inspect origin --runtime --json` lists the hooks it registered |
| The log says `origin: recording … from the message hooks` | Conversation access is off: set `hooks.allowConversationAccess` to `true` in the entry, beside `config`, not inside it |
| `cannot deliver to …: the hub answered 401` | The token is wrong or was revoked: create a new one on the hub |
| `the hub answered 404` | The hub runs an Origin from before `/v1/sources/<name>/lines`: upgrade it; the lines wait in the spool |
| `… lines wait in …/spool` | The hub could not be reached; they are sent with the next turn, or when the Gateway starts |
| A directory's lines never show | Its name must be a source's: 2 to 32 lowercase letters, digits, and hyphens, such as `openclaw`; `origin status` lists the source once it is read |
