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

### A hook does nothing {#a-hook-does-nothing}

`origin agents` shows the hooks as set up, but a session's lines reach Origin, or the hub, only a minute after a turn, or not at all while no `origin mcp` runs.

- **Start a new session.** Agents read their hooks when a session starts.
- **In Codex, trust the hooks.** Codex skips a new hook, and one that changed, until you trust it: open `/hooks` in Codex, review Origin's hooks, and trust them. It warns when it starts while a hook waits for review.
- **They run in the background.** The ingest hooks are `async`: the agent does not wait for them and shows nothing they say. `/hooks` lists them; Claude Code shows when a background hook finishes in its verbose mode (`Ctrl+O`). Whatever goes wrong, a hook exits 0 and says why on standard error only.
- **The transcript lags the hook.** Agents write their transcripts asynchronously, so the last lines of a turn may not be written yet when the hook runs. Origin reads only complete lines; the rest arrives with the next hook, or within a minute through `origin mcp`. This is expected.
- **The same directories as `origin sync`.** A hook ingests only a transcript under the directory Origin reads for that agent: `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`, `ORIGIN_CLAUDE_PROJECTS`) for Claude Code, and `sessions/` or `archived_sessions/` of `~/.codex` (or `CODEX_HOME`) for Codex. It runs with the agent's environment, so give the agent the same variables, `ORIGIN_HOME` included.
- **Run it by hand** with an event like the agent's, and read what it says on standard error. It prints nothing when all is well, and `origin timeline --session <id>` then shows the session's latest messages:

```sh
echo '{"hook_event_name":"Stop","transcript_path":"/home/dana/.claude/projects/-home-dana-code-acme/5e8f0a1b-2c3d-4e5f-9a6b-7c8d9e0f1a2b.jsonl"}' | origin sync --hook claude-code
```

On a device connected to a hub, a hook waits at most 3 seconds for the hub and then says `not sent to the hub yet`; the next sync sends what it did not.

### Results lack what was just said {#results-lack-what-was-just-said}

An agent does not find the last few messages of a session.

Claude Code's and Codex's ingest hooks read a session's new lines as each turn ends (see [A hook does nothing](#a-hook-does-nothing)). `origin mcp` also reads new log lines before `search` and `timeline`, at most every 10 seconds, always before `remember` and `correct`, every minute in the background, and once more when the agent exits (see [Freshness](./mcp.md#freshness)). So a search usually sees what was said a few seconds ago. What it does not see:

- Sessions of agents that do not use Origin, until an agent that does runs, or until `origin sync`. Schedule `origin sync` on a machine where such agents run alone.
- Another device's sessions, until that device's hooks or sync send them to the hub.
- For agents without ingest hooks, anything at all if the background look is off: `ORIGIN_WATCH_INTERVAL_MS=0`.

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

Run `origin hub status`: it shows when the device last synced, the error of the last sync that failed, and whether the hub accepts the token now. A message that the hub `rejected the token (HTTP 401)` means the token was revoked or mistyped: connect the device again, with `origin hub connect <url>` and your approval in the admin UI, or with a new token created on the hub (see [Devices and agents](./hub.md#devices-and-agents)). Check the TLS proxy or CDN in front of the hub (see [Put it behind TLS](./hub.md#put-it-behind-tls)) and `GET /healthz`, which needs no token.

### The token belongs to another device {#the-token-belongs-to-another-device}

`origin hub connect` fails with `This token belongs to device "laptop", but this store is named "desktop"; …`, or the hub refuses requests with 403.

A hub token works only for the device it is named after, and a device is known by its store's name. Either create a token named after this store on the hub (`origin token create desktop`) and connect with it, or, if this machine is `laptop`, connect it under that name with `--device laptop`. A store keeps its name once it has written entries or tombstones under it (`This store is named "desktop" and keeps that name, …`); entries imported from agents' memory files do not count.

### An agent or a device cannot sign in to the hub {#an-agent-or-a-device-cannot-sign-in-to-the-hub}

`claude mcp login origin` or `codex mcp login origin` reports that the server does not support OAuth, `origin hub connect <url>` says the hub `does not let devices connect by browser`, or the hub's page says `This sign-in cannot go on`.

- Agents and devices sign in through the hub's [admin UI](./admin.md), so it must be served at `/admin` on the hub's own address (`--admin`, or `ORIGIN_ADMIN=on`), not on a listener of its own, and a proxy in front of the hub must forward `/.well-known/oauth-*` and `/oauth/*` (see [Put it behind TLS](./hub.md#put-it-behind-tls)). Otherwise, use tokens (see [Devices and agents](./hub.md#devices-and-agents)).
- Claude Code signs in only to a hub served over https, or at `localhost` or `127.0.0.1`.
- `Could not read the app's description at https://…`: Claude Code and Codex describe themselves by documents at claude.ai and chatgpt.com, which the hub fetches; the hub must reach them over https, and refuses addresses on private networks.
- An agent that worked before and now asks to sign in again was revoked, signed out, or reached the end of the time you allowed it, or one of its refresh tokens was used twice, which revokes it: sign it in again.

### A relay warns about sessions not sent yet {#a-relay-warns-about-sessions-not-sent-yet}

`origin status` or an agent shows `Warning: Claude Code sessions not sent to the hub yet were last written 24 days ago, and Claude Code deletes them after 30 days (…); …`

A [relay](./hub.md#run-a-device-as-a-relay) keeps no copy of the sessions it has not sent, so they are lost if the agent deletes its logs first. Make the hub reachable and run `origin sync`; `origin status` shows, per source, what is still to send. For Claude Code you can also keep logs longer with `cleanupPeriodDays` in its `settings.json`.

### The PostgreSQL database is refused {#the-postgresql-database-is-refused}

The hub does not start: `The database origin has encoding UTF8 and locale en_US.UTF-8 (libc); a store needs a UTF8 database whose locale is C. Create one with: …`, or `Origin needs PostgreSQL 17 or later; this server runs 16.4.`

A store in PostgreSQL compares and case-folds text as SQLite does only in a UTF8 database whose locale is C, so Origin checks before it creates anything. The locale of a database cannot be changed: create a new one as the message says, `CREATE DATABASE origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';`, and point `ORIGIN_DATABASE_URL` at it (see [Run the hub on PostgreSQL](./hub.md#run-the-hub-on-postgresql)). If the hub already ran on the old database, move its store with `origin db move --to <new-url>` before you drop the old one.

### A command waits for the store, then fails {#a-command-waits-for-the-store-then-fails}

A command on the hub's host fails with `database is locked: another Origin process holds the store's write lock`, or `statement timed out`; or `origin serve` refuses to start: `Another origin serve is running on the store at …: a store is served by one hub at a time.`

- Every write takes the store's write lock and waits up to 10 seconds for it, as with SQLite. A command that fails this way met a long write, such as a large push being parsed, a purge, or `origin db move`: run it again.
- One statement may run for at most 5 minutes, and a transaction may wait idle for at most 5 minutes; `origin db move` and `origin db rebuild-search`, whose index builds take longer on a large store, allow a day. A statement that times out fails its command, which changes nothing: check the server's load, then run it again.
- Only one hub serves a store. Another `origin serve` holds the store, on this machine or another one pointed at the same database and schema: stop it. A hub that lost its connection takes its lock again when it reconnects; one that was killed lets go of it when PostgreSQL notices, at once or within a few minutes, depending on the server's TCP keepalive settings.

### The database and the data directory do not belong together {#the-database-and-the-data-directory-do-not-belong-together}

A command or the hub refuses to open the store: `The database at … holds store …, but ORIGIN_HOME … belongs to store …`, `The store at … is not paired with ORIGIN_HOME …`, `The store of ORIGIN_HOME … is in PostgreSQL …: set ORIGIN_DATABASE_URL …`, or `The store at … has been moved to …`.

A store in PostgreSQL keeps its raw mirrors in `ORIGIN_HOME` (`/data` on a hub), and `store.json` there names the store they belong to (see [Run the hub on PostgreSQL](./hub.md#run-the-hub-on-postgresql)). Origin refuses a database and a directory that do not belong together, rather than serve one store's events with another's mirrors, or create a new, empty store:

- Check `ORIGIN_DATABASE_URL`, its database and its `schema` parameter, and `ORIGIN_HOME`, or the volume mounted at `/data`.
- `is in PostgreSQL … set ORIGIN_DATABASE_URL`: the store was moved into PostgreSQL, and the command ran without the URL; set it.
- `has been moved to …`: `origin db move` moved the store away from this database; point the URL at where it is now, or leave it out if it is in SQLite.
- Do not edit or delete `store.json` to get past this.

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
