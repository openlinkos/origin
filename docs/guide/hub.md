# Personal hub

By default Origin lives on one machine: it archives that machine's agent sessions, and only agents on that machine can reach it. A **personal hub** gathers the sessions of all your machines into one store and serves it to your agents wherever they run. The hub is self-hosted and single-tenant: it serves one person and that person's devices and agents.

## When you need one

- You use AI agents on more than one machine, such as a laptop, a desktop, and a server, and want each of them to remember what happened on the others.
- You use cloud agents that have no local session logs but should still be able to search and save your memory.

If all your agents run on one machine, you do not need a hub.

## How it works

- Every **device** keeps archiving its own sessions locally, exactly as without a hub, and runs `origin push`. The push sends the device's raw session mirrors to the hub, then pulls back anything that was forgotten on the hub.
- The **hub** runs `origin serve`. It parses the pushed mirrors with the same adapters, so every answer still traces back to the original line, and it is the store your agents talk to.
- On a device, `origin mcp` keeps working as before but forwards each call to the hub, after pushing what is new. Cloud agents connect to the hub's MCP endpoint directly.

The design is in [Architecture](../architecture.md#personal-hub).

## Run the hub

With Docker:

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

Inside the container, `ORIGIN_HOME` is `/data`, and the hub listens on `0.0.0.0:7077`. Keep the `/data` volume, because it holds the whole store.

From source, on any machine with Origin installed:

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

Every request except `/healthz` needs a bearer token. Create one token per device or cloud agent, on the hub:

```bash
origin token create laptop          # prints the token once, starting with ogn_
origin token list
origin token revoke laptop
```

With Docker, run the same commands through `docker exec`, for example `docker exec origin-hub origin token create laptop`. If you enable the [admin UI](./admin.md), you can also create and revoke tokens there, with the connection commands for each new token ready to copy.

The hub stores only a hash of each token, so copy the token when it is printed. If a token is lost or a device is retired, revoke the token. Entries an agent saves through the hub record the agent and the token name as author, for example `claude-code@laptop`.

## Connect a device

On each machine with agent session logs:

```bash
origin hub connect https://hub.example.com --token ogn_… --device laptop
origin hub status
origin push
```

- `--device` defaults to the host name. `origin hub disconnect` removes the connection.
- `ORIGIN_HUB_URL`, `ORIGIN_HUB_TOKEN`, and `ORIGIN_DEVICE` override the stored connection.
- `origin push` syncs local sessions, pushes the raw mirrors, and pulls the hub's tombstones. It is safe to re-run: a push picks up where the previous one stopped.

Once the device is connected, `origin mcp` forwards to the hub, so the agent registrations you already have stay the same. Each agent call first pushes new session lines: before reads at most every 10 seconds, and always before `remember` and `correct`. An agent can therefore still cite what you said a moment ago.

Agents push only when they are used. To keep the hub current from a device whose agents are idle, schedule `origin push`, for example with cron (`*/10 * * * * origin push`) or the Windows Task Scheduler.

## Connect a cloud agent

Cloud agents have no local session logs, so they talk to the hub directly, each with its own token:

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI (reads the token from the ORIGIN_TOKEN environment variable)
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

## Forgetting

Forgetting through the hub works as on one machine (see [Privacy and your data](./privacy.md#forgetting)), and it reaches every device. Each device applies the hub's tombstones on its next push, so its local staging copy hides the same entries and events. Forgotten events stay hidden even if a device pushes them again.

## Manage it in a browser

The hub can serve an [admin UI](./admin.md) for you: an overview of your devices and storage, your sessions and entries, search, correcting and forgetting, tokens, and an audit log. It is off by default; enable it with `origin serve --admin` (or `ORIGIN_ADMIN=on`) and sign in with the password the hub prints to its log on that first start, or one you set with `origin admin password` or `ORIGIN_ADMIN_PASSWORD`.

## Limitations

- CLI curation commands (`entries`, `show`, `correct`, `forget`, …) act on the store they run against. On a connected device, that is the local staging copy. Curate through your agents, in the hub's [admin UI](./admin.md), or by running the CLI on the hub (`docker exec origin-hub origin …`). Curation from a device's CLI is planned.
- Entries saved on a device before it was connected to a hub stay in that device's local store; they are not migrated.
- The hub is one store for one person. It does not support multiple users or two-way sync between hubs.
