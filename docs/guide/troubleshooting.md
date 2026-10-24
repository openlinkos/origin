# Troubleshooting

Common problems, what you see, and what to do. Origin's messages say what went wrong and usually how to fix it; the quotes below are those messages.

## Installing and connecting {#installing-and-connecting}

### Node.js is too old {#nodejs-is-too-old}

Every command fails with `Origin needs Node.js 22.16 or later; this is v20.11.1.` Origin uses the zstd compression and the online SQLite backup that Node.js added in 22.16.

Install Node.js 22.16 or later, then install Origin again with that Node.js (`npm install -g @openlinkos/origin`). If you use a version manager, make sure the agents start the same Node.js as your shell: an agent started from a desktop launcher may find another one on its `PATH`. `node --version` in the agent's terminal tells you which.

### An agent does not see Origin's tools {#an-agent-does-not-see-origins-tools}

The agent lists no `origin` server, or the server fails to start.

- Check the registration: `claude mcp list`, `codex mcp list`, or `grok inspect` (see [Connect your agents](./connect-agents.md)). Register Origin at user scope, not per project, so that every project sees it.
- On Windows, npm installs `origin` as a `.cmd` script, which agents cannot start directly. Register `cmd /c origin mcp` instead of `origin mcp`.
- In Git Bash, prefix the registration with `MSYS_NO_PATHCONV=1`, or Git Bash turns `/c` into `C:/` and the registration fails at start: `MSYS_NO_PATHCONV=1 claude mcp add --scope user origin -- cmd /c origin mcp`.
- Restart the agent after registering Origin or updating it: agents start their MCP servers when a session starts.
- Run `origin status` in a terminal. If it fails, the server fails the same way, and the message says why.

### Results lack what was just said {#results-lack-what-was-just-said}

An agent does not find the last few messages of a session.

`origin mcp` reads new log lines before `search` and `timeline`, at most every 10 seconds, always before `remember` and `correct`, every minute in the background, and once more when the agent exits (see [Freshness](./mcp.md#freshness)). So a search usually sees what was said a few seconds ago. What it does not see:

- Sessions of agents that do not use Origin, until an agent that does runs, or until `origin sync`. Schedule `origin sync` on a machine where such agents run alone.
- Another device's sessions, until that device syncs with the hub.
- Anything at all if the background look is off: `ORIGIN_WATCH_INTERVAL_MS=0`.

## Upgrading {#upgrading}

### A store of a newer Origin is refused {#a-store-of-a-newer-origin-is-refused}

Every command fails with `The store at … has format version 4, but this Origin knows versions up to 3 only: a newer Origin has used it. Upgrade Origin to open it; nothing was changed.`

A newer Origin has upgraded the store, and an older one tries to open it, often an agent's MCP server started from another installation or before you updated. Update every installation that uses the store (`npm install -g @openlinkos/origin@latest`; on a hub, the image), then restart the agents. Going back to an older Origin on an upgraded store is not supported.

### The store is upgraded when it is opened {#the-store-is-upgraded-when-it-is-opened}

After an update, a command prints `Upgrading the store to version 4: …` and takes longer than usual.

A new version may change the store's format; the first command that opens the store brings it up to date, once, in place. Some upgrades read the archived logs again, which takes a while on a large store or a hub. Other commands and agents that open the store meanwhile wait for the upgrade, up to 5 minutes. To be safe, back the store up before you update (see [Backing up](./privacy.md#backing-up)).

If a step fails, the message says so: `The store could not be upgraded to version 4 (…): … Nothing of this step was kept; it runs again the next time the store is opened.` Fix the cause it names and run any command again. A step that reads the archived logs needs the `origin` command; on a hub that keeps raw mirrors in a bucket, it also needs the bucket configured.

## Personal hub {#personal-hub}

### The hub cannot be reached {#the-hub-cannot-be-reached}

Results from an agent end with `Note: the Origin hub was not consulted (the hub at https://hub.example.com is unreachable: …); these results come from this device only.`, or `origin sync` fails.

A device keeps working without its hub: it answers from its own store after waiting 2 seconds for the hub (`ORIGIN_HUB_TIMEOUT_MS`), saves what agents write locally, and sends it on the next sync. Only correcting or forgetting something that only the hub has needs the hub.

Run `origin hub status`: it shows when the device last synced, the error of the last sync that failed, and whether the hub accepts the token now. A message that the hub `rejected the token (HTTP 401)` means the token was revoked or mistyped: create a new one on the hub and connect again (see [Create tokens](./hub.md#create-tokens)). Check the TLS proxy or CDN in front of the hub (see [Put it behind TLS](./hub.md#put-it-behind-tls)) and `GET /healthz`, which needs no token.

### The token belongs to another device {#the-token-belongs-to-another-device}

`origin hub connect` fails with `This token belongs to device "laptop", but this store is named "desktop"; …`, or the hub refuses requests with 403.

A hub token works only for the device it is named after, and a device is known by its store's name. Either create a token named after this store on the hub (`origin token create desktop`) and connect with it, or, if this machine is `laptop`, connect it under that name with `--device laptop`. A store keeps its name once it has written entries or tombstones under it (`This store is named "desktop" and keeps that name, …`); entries imported from agents' memory files do not count.

### A relay warns about sessions not sent yet {#a-relay-warns-about-sessions-not-sent-yet}

`origin status` or an agent shows `Warning: Claude Code sessions not sent to the hub yet were last written 24 days ago, and Claude Code deletes them after 30 days (…); …`

A [relay](./hub.md#run-a-device-as-a-relay) keeps no copy of the sessions it has not sent, so they are lost if the agent deletes its logs first. Make the hub reachable and run `origin sync`; `origin status` shows, per source, what is still to send. For Claude Code you can also keep logs longer with `cleanupPeriodDays` in its `settings.json`.

## Archive and data {#archive-and-data}

### Parse errors {#parse-errors}

`origin sync` reports parse errors for a source, or the admin UI's overview shows parse errors for an agent.

An agent changed the format of its logs, and some lines are not understood yet. Nothing is lost: every line is kept in the raw mirror, and the rest of the file is still read. `origin sync --verbose` prints each error with its file and line. Update Origin; when a new version learns to read such lines, it reads them again where needed. If parse errors persist on the latest version, [report them](https://github.com/openlinkos/origin/issues) with the agent and its version, but without the lines themselves, which may hold private data.

### Where the data is, and how much space it takes {#where-the-data-is-and-how-much-space-it-takes}

`origin status` ends with `Data directory: …`: `~/.origin`, or `ORIGIN_HOME`. It holds `origin.db`, the database, and `raw/`, the compressed copies of the logs (see [What Origin stores](./privacy.md#what-origin-stores)). The Storage panel of the admin UI's overview (`origin ui` on a device) shows how much each takes.

As a rule of thumb, the database takes about 2.5 KB per event, and the raw mirrors about a fifth of the logs they copy once the logs stop growing. Next to the database, `origin.db-wal` holds recent writes; it is cut back to 64 MB after each checkpoint.

### Moving or resetting a store {#moving-or-resetting-a-store}

The database and the raw mirrors belong together: never delete, replace, or copy one without the other, and do not copy `origin.db` alone while Origin runs.

- **To move a store**, back it up into the new, empty directory with `origin backup <dir>`, stop the agents, back up once more into the same directory to copy what changed meanwhile, and point `ORIGIN_HOME` at it, in your shell and in the environment the agents start `origin mcp` with. A backup does not include `hub.json`, which holds the connection to a hub and its token: copy it too, or connect again with `origin hub connect`.
- **To start over**, point `ORIGIN_HOME` at a new, empty directory and keep the old one as a backup. On a device connected to a hub, restoring a backup is better than an empty store: a store keeps its name and its place in the hub's records, so it goes on where it stopped.
- **To remove everything**, see [Removing everything](./privacy.md#removing-everything).
