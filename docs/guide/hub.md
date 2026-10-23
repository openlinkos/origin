# Personal hub

By default Origin lives on one machine: it archives that machine's agent sessions, and only agents on that machine can reach it. A **personal hub** gathers the sessions of all your machines into one store and serves it to your agents wherever they run. The hub is self-hosted and single-tenant: it serves one person and that person's devices and agents.

## When you need one

- You use AI agents on more than one machine, such as a laptop, a desktop, and a server, and want each of them to remember what happened on the others.
- You use cloud agents that have no local session logs but should still be able to search and save your memory.

If all your agents run on one machine, you do not need a hub.

## How it works

- Every **device** keeps archiving its own sessions locally, exactly as without a hub, and runs `origin sync`. Once the device is connected, a sync also sends the device's raw session mirrors, and the entries and tombstones written on it, to the hub, then pulls back anything that was forgotten on the hub or on another device.
- The **hub** runs `origin serve`. It parses the pushed mirrors with the same adapters, so every answer still traces back to the original line, and it holds what every device has sent: it is where everything can be found.
- On a device, `origin mcp` keeps answering from the device's own store, so it keeps working offline, and adds what the hub knows: other devices' sessions and entries, and entries written by cloud agents. Cloud agents connect to the hub's MCP endpoint directly.
- Devices never download each other's data. Only forgetting travels down from the hub, so that what you forget anywhere is hidden everywhere.

The design is in [Architecture](../architecture.md#personal-hub).

## Run the hub

With Docker:

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

Inside the container, `ORIGIN_HOME` is `/data`, and the hub listens on `0.0.0.0:7077`. Keep the `/data` volume, because it holds the whole store; to back it up, see [Backing up](./privacy.md#backing-up).

Without Docker, on any machine with Origin installed (`npm install -g @openlinkos/origin`):

```bash
origin serve --host 127.0.0.1 --port 7077
```

`GET /healthz` reports health without authentication, and `POST /mcp` is the MCP endpoint. Add `--admin` to also serve the [admin UI](./admin.md) at `/admin`.

## Put it behind TLS

The hub speaks plain HTTP. Before you expose it beyond localhost, put it behind a reverse proxy or CDN that terminates TLS, and configure the proxy as follows:

- Forward `/healthz`, `/mcp`, and `/v1/*` to the hub.
- Allow request bodies of at least 16 MiB on `/v1/ingest`, which devices use to push session data.
- Do not cache `/mcp` or `/v1/*`.
- If you enable the admin UI at `/admin`, also follow [Behind TLS and a CDN](./admin.md#behind-tls-and-a-cdn); in particular, set `ORIGIN_CLIENT_IP_HEADER`, or failed sign-ins from anyone count against you.

## Create tokens

Every request except `/healthz` needs a bearer token. Create one token per device or cloud agent, on the hub, and name a device's token after the device:

```bash
origin token create laptop          # prints the token once, starting with ogn_
origin token list
origin token revoke laptop
```

With Docker, run the same commands through `docker exec`, for example `docker exec origin-hub origin token create laptop`. If you enable the [admin UI](./admin.md), you can also create and revoke tokens there, with the connection commands for each new token ready to copy.

A token's name is a device name: the token `laptop` sends and receives sessions, entries, and tombstones only for the device `laptop`, and the hub refuses it for any other device. So a stolen token can never write as another device.

The hub stores only a hash of each token, so copy the token when it is printed. If a token is lost, revoke it and create a new one with the same name; the device keeps its name and reconnects with the new token. If a device is retired, revoke its token. Entries record the agent and the device as author, for example `claude-code@laptop`; an agent that connects to the hub directly is recorded with its token name, for example `ci`.

## Connect a device

On each machine with agent session logs:

```bash
origin hub connect https://hub.example.com --token ogn_… --device laptop
origin hub status
origin sync
```

- The hub knows the device by its store's name: `ORIGIN_DEVICE`, or the host name, when the store was first used. That name must be the name of the device's token; `origin hub connect` and `origin hub status` check it with the hub, and if they differ, refuse and say how to fix it. `--device` renames a store that has not saved an entry or forgotten anything yet; after that, the store keeps its name, and its token must be created under that name. `origin hub disconnect` removes the connection.
- `ORIGIN_HUB_URL` and `ORIGIN_HUB_TOKEN` override the stored connection.
- `origin sync` ingests local sessions, sends the raw mirrors and the entries and tombstones written on the device, and applies the hub's tombstones. It is safe to re-run: a sync picks up where the previous one stopped. `origin push` does the same.

Once the device is connected, the agent registrations you already have stay the same. `origin mcp` answers from the device's store and asks the hub at the same time, then merges both answers; each result says whether it was found on this device (`local`) or on the hub (`hub`). If the hub does not answer within 2 seconds (`ORIGIN_HUB_TIMEOUT_MS`), the agent gets this device's answer with a note that the hub was not consulted. What agents save lands on the device first and is synced to the hub right away, or on the next sync if the hub cannot be reached. Correcting or forgetting something that only the hub has is done on the hub, so it needs the hub to be reachable.

While an agent runs, its `origin mcp` also syncs in the background: every minute when log files have changed, and once more when the agent exits, so a device needs no scheduled sync. Sessions of agents that do not use Origin are picked up the next time one that does runs, or by `origin sync`; schedule `origin sync` (for example with cron, `*/10 * * * * origin sync`, or the Windows Task Scheduler) only on a device where such agents run alone.

## Connect a cloud agent

Cloud agents have no local session logs, so they talk to the hub directly, each with its own token:

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI (reads the token from the ORIGIN_TOKEN environment variable)
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

## Forgetting

Forgetting through the hub works as on one machine (see [Privacy and your data](./privacy.md#forgetting)), and it reaches every device. Each device applies the hub's tombstones on its next sync, so its local copy hides the same entries and events, and what a device forgets reaches the hub and, from there, every other device. Forgotten events stay hidden even if a device pushes them again.

## Manage it in a browser

The hub can serve an [admin UI](./admin.md) for you: an overview of your devices and storage, your sessions and entries, search, correcting and forgetting, tokens, and an audit log. It is off by default; enable it with `origin serve --admin` (or `ORIGIN_ADMIN=on`) and sign in with the password the hub prints to its log on that first start, or one you set with `origin admin password` or `ORIGIN_ADMIN_PASSWORD`.

## Limitations

- CLI curation commands (`entries`, `show`, `correct`, `forget`, …) act on the device's own store, then sync. To see and curate the entries of every device, use your agents or the hub's [admin UI](./admin.md).
- A device does not download other devices' data, so without the hub it can only answer about itself.
- The hub is one store for one person. It does not support multiple users, sync between hubs, or sync between devices without a hub.
