# Personal hub

By default Origin lives on one machine: it archives that machine's agent sessions, and only agents on that machine can reach it. A **personal hub** gathers the sessions of all your machines into one store and serves it to your agents wherever they run. The hub is self-hosted and single-tenant: it serves one person and that person's devices and agents.

## When you need one

- You use AI agents on more than one machine, such as a laptop, a desktop, and a server, and want each of them to remember what happened on the others.
- You use cloud agents that have no local session logs but should still be able to search and save your memory.

If all your agents run on one machine, you do not need a hub.

## How it works

- Every **device** keeps archiving its own sessions locally, exactly as without a hub, and runs `origin sync`. Once the device is connected, a sync also sends the device's raw session mirrors, and the entries and tombstones written on it, to the hub, then pulls back anything that was forgotten on the hub or on another device, and what you purged on the hub.
- The **hub** runs `origin serve`. It parses the pushed mirrors with the same adapters, so every answer still traces back to the original line, and it holds what every device has sent: it is where everything can be found.
- On a device, `origin mcp` keeps answering from the device's own store, so it keeps working offline, and adds what the hub knows: other devices' sessions and entries, and entries written by cloud agents. Cloud agents connect to the hub's MCP endpoint directly.
- Devices never download each other's data. Only forgetting and purging travel down from the hub, so that what you forget anywhere is hidden everywhere, and what you purge on the hub is deleted everywhere.
- A machine with little disk can be a **relay** instead of a complete device: it keeps nothing but cursors, sends its agents' logs straight to the hub, and answers its agents through the hub (see [Run a device as a relay](#run-a-device-as-a-relay)).

The design is in [Architecture](../architecture.md#personal-hub).

## Run the hub

With Docker:

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

Inside the container, `ORIGIN_HOME` is `/data`, and the hub listens on `0.0.0.0:7077`. Keep the `/data` volume, because it holds the whole store; to back it up, see [Backing up](./privacy.md#backing-up). `latest` is the latest release; for a hub you keep, pin a minor version such as `ghcr.io/openlinkos/origin:0.3`, and upgrade it as [Upgrading](./upgrading.md#upgrade-a-hub) describes.

Without Docker, on any machine with Origin installed (`npm install -g @openlinkos/origin`):

```bash
origin serve --host 127.0.0.1 --port 7077
```

`GET /healthz` reports health without authentication, and `POST /mcp` is the MCP endpoint. Add `--admin` to also serve the [admin UI](./admin.md) at `/admin`; with it there, devices and agents sign in through you, in your browser, rather than with tokens you copy (see [Devices and agents](#devices-and-agents)).

## The landing page

Open the hub's address in a browser, such as `http://localhost:7077/`, and it shows a public page that needs no token: Origin's mark and name, one sentence on what the hub is, in English or Chinese as your browser prefers, a **Sign in** button when the [admin UI](./admin.md) is served at `/admin` on the same port, and at its foot "Powered by Origin, open source", with links to this site and to the source code. The page shows nothing from your store. A client that asks for JSON (`Accept: application/json`) gets `{"service":"origin","docs":"https://origin.openlinkos.com/"}` instead. `/robots.txt` lets search engines read that page and nothing else, and the hub serves the page's stylesheet, fonts, and marks itself, under `/assets/`.

Search engines are asked to stay away from the whole hub (`/robots.txt` disallows everything): the page is there for people who open the address, not for search results.

If you present the hub under your own name, set `ORIGIN_POWERED_BY=off` to leave the credit to Origin off the page; the admin UI keeps its links to the project.

Every other path, except `/healthz`, the admin UI with its own sign-in, and the sign-in endpoints of agents and devices under `/.well-known/` and `/oauth/`, needs a token (see [Devices and agents](#devices-and-agents)). A request without one gets `401` with `{"error":"Missing or invalid token.","docs":"https://origin.openlinkos.com/guide/hub"}`, whose `docs` is this guide.

## Put it behind TLS

The hub speaks plain HTTP. Before you expose it beyond localhost, put it behind a reverse proxy or CDN that terminates TLS, and configure the proxy as follows:

- Forward `/healthz`, `/mcp`, and `/v1/*` to the hub, and `/`, `/robots.txt`, and `/assets/*` for its [landing page](#the-landing-page). With the admin UI at `/admin`, also forward `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, and `/oauth/*`, through which agents and devices sign in.
- Allow request bodies of at least 16 MiB on `/v1/ingest`, which devices use to push session data, and of 8 MiB on `/v1/sources/*/lines`, if programs append event lines to the hub (see [Append event lines](#append-event-lines)).
- Do not cache `/mcp`, `/v1/*`, or `/oauth/*`.
- If you enable the admin UI at `/admin`, also follow [Behind TLS and a CDN](./admin.md#behind-tls-and-a-cdn); in particular, set `ORIGIN_CLIENT_IP_HEADER`, or failed sign-ins from anyone count against you.

## Devices and agents

Everything that reaches the hub does so for you: your **devices**, the machines that sync their sessions with it, and your **agents**, the cloud agents, bots, and pipelines that use its MCP endpoint. Each has a name and credentials that you can revoke at any time, on the admin UI's **Devices and agents** page, or with `origin token list` and `origin token revoke <name>` on the hub. There are no other people: the hub is yours alone.

With the [admin UI](./admin.md) served at `/admin` on the hub's own address (`--admin`), devices and agents that can open a browser sign in through you, and no token is copied anywhere:

- A device runs `origin hub connect <url>`, and you approve it in the admin UI (see [Connect a device](#connect-a-device)).
- Claude Code, Codex, and other MCP clients sign in with OAuth: they open the hub in your browser, you allow them, and they keep and renew their own tokens (see [Connect a cloud agent](#connect-a-cloud-agent)).

For a program that cannot open a browser, such as a bot, a CI job, or a pipeline, or on a hub without the admin UI at `/admin`, create a token on the hub:

```bash
origin token create laptop                         # a device's token, named after it; printed once, starting with ogn_
origin token create ci --agent                     # an agent's token: MCP, and event lines
origin token create dashboard --agent --readonly   # an agent that only reads
origin token list
origin token revoke ci
```

With Docker, run the same commands through `docker exec`, for example `docker exec origin-hub origin token create laptop`. In the admin UI, **Add an agent** creates an agent's token and shows it once, with the commands that use it.

- **What each may do.** A device, and an agent unless you choose otherwise, is *read and write*: everything a token can do. An agent can be *read only*: it searches and reads through MCP, without the tools that write (`remember`, `propose`, `correct`, `forget`), and sends nothing to the hub. Tokens you created before this existed keep working as they did, as read and write.
- **A device's token works only for it.** A token's name is a device name: the token `laptop` sends and receives sessions, entries, and tombstones only for the device `laptop`, and the hub refuses it for any other device. So a stolen token can never write as another device.
- The hub stores only a hash of each token, so copy a token when it is printed. If a device loses its token, revoke it and connect the device again, by browser or with a new token of the same name; the device keeps its name. If a device is retired, revoke it. Entries record the agent and the device as author, for example `claude-code@laptop`; an agent that connects to the hub directly is recorded with its name, for example `ci`, or `claude-code` for Claude Code signed in with OAuth.

## Connect a device

On each machine with agent session logs:

```bash
origin hub connect https://hub.example.com
origin hub status
origin sync
```

`origin hub connect` asks the hub for a code, and prints where to approve the device:

```text
To connect laptop to https://hub.example.com, open this link, sign in, and approve it:

    https://hub.example.com/admin/activate?code=BCDF-GHJK

or open https://hub.example.com/admin/activate and enter the code BCDF-GHJK. It expires in 10 minutes.
Waiting for approval…
```

Open the link in any browser, on any device, sign in to the admin UI, check that the code is the one the command shows, and choose **Connect laptop**. Within a few seconds the command receives the device's token and connects. If a device of that name is connected already, the page says so, and approving gives the name to the new one: the token of the old one stops working. Approve only a code you have just seen on your own device.

On a hub without the admin UI at `/admin`, create a token for the device on the hub and connect with it: `origin hub connect https://hub.example.com --token ogn_… --device laptop`.

- The hub knows the device by its store's name: `ORIGIN_DEVICE`, or the host name, when the store was first used. It connects under that name, and its token is named after it; `origin hub connect` and `origin hub status` check it with the hub, and if they differ, refuse and say how to fix it. `--device` renames a store that has not saved an entry or forgotten anything yet; after that, the store keeps its name, and a token created for it must have that name. `origin hub disconnect` removes the connection.
- `ORIGIN_HUB_URL` and `ORIGIN_HUB_TOKEN` override the stored connection.
- `origin sync` ingests local sessions, applies the purges made on the hub, sends the raw mirrors and the entries and tombstones written on the device, and applies the hub's tombstones. It is safe to re-run: a sync picks up where the previous one stopped. `origin push` does the same.

Once the device is connected, the agent registrations you already have stay the same. `origin mcp` answers from the device's store and asks the hub at the same time, then merges both answers; each result says whether it was found on this device (`local`) or on the hub (`hub`). If the hub does not answer within 2 seconds (`ORIGIN_HUB_TIMEOUT_MS`), the agent gets this device's answer with a note that the hub was not consulted. What agents save lands on the device first and is synced to the hub right away, or on the next sync if the hub cannot be reached. Correcting or forgetting something that only the hub has is done on the hub, so it needs the hub to be reachable.

While an agent runs, Claude Code's and Codex's ingest hooks push each turn's new lines to the hub as the turn ends, and its `origin mcp` also syncs in the background: every minute when log files have changed, and once more when the agent exits, so a device needs no scheduled sync. Sessions of agents that do not use Origin are picked up the next time one that does runs, or by `origin sync`; schedule `origin sync` (for example with cron, `*/10 * * * * origin sync`, or the Windows Task Scheduler) only on a device where such agents run alone.

## Run a device as a relay

A device normally keeps a complete memory of its own, including a compressed copy of every session log it has archived. On a machine with little disk, such as a small VPS, run it as a **relay** instead: it keeps no copy and no memory of its own, only a cursor per log file, and sends new sessions to the hub straight from the agents' own logs.

Connect an empty store with `--relay`:

```bash
origin hub connect https://hub.example.com --device vps --relay
origin sync
origin status
```

Approve the device in the admin UI as for any device, or pass a token created on the hub with `--token`.

- Only a store that holds nothing yet can become a relay. If this machine already has a store with sessions or entries, Origin refuses and changes nothing; set `ORIGIN_HOME` to a new directory and connect that one. A relay stays a relay; to keep a complete store on the machine again, use another new `ORIGIN_HOME`.
- `origin sync` sends the new complete lines of every session log to the hub, which archives and parses them as if the device had sent its own copy, and `origin status` shows, for each source, how many files and bytes are still to send. Agents' ingest hooks and `origin mcp` send new lines as they run, as on any device.
- Agents keep their registrations, but on a relay `origin mcp` answers every tool from the hub: it first sends the hub what was just written, so that agents can find and cite it, then hands the call to the hub. What agents save is written on the hub, recorded as `claude-code@vps`. If the hub cannot be reached, tools fail with a message saying that the relay cannot answer offline.
- `origin search`, `timeline`, `show`, `entries`, `correct`, and `forget` ask the hub too, and `correct` records `user@vps`. A relay cannot list beforehand what `origin forget` will hide, so it says what the rules will hide, and needs `--yes` as always. `entries --history`, `projects`, `forgotten`, and `restore` are not available on a relay; use the hub's [admin UI](./admin.md).
- While the hub cannot be reached, nothing is sent, and new sessions exist only in the agents' own logs. Some agents delete old logs, Claude Code after 30 days by default (`cleanupPeriodDays`), so make sure a relay reaches its hub regularly; if agents that do not use Origin run on it, schedule `origin sync`.
- Before that happens, the relay warns: `origin status`, and `origin sync` when it could not send everything, say when sessions not sent yet are within a week of the age at which Claude Code deletes them (`cleanupPeriodDays` in `~/.claude/settings.json`, or 30 days), and, for other agents, when they have waited a week with nothing sent. While the hub cannot be reached, the agents' tools that fail say so too.

The design is in [Relays](../architecture.md#relays).

## Connect a cloud agent

Cloud agents have no local session logs, so they talk to the hub directly. Claude Code and Codex sign in with OAuth, through your browser:

```bash
# Claude Code: add the hub, then sign in with /mcp inside Claude Code, or from the shell
claude mcp add --scope user --transport http origin https://hub.example.com/mcp
claude mcp login origin

# Codex CLI
codex mcp add origin --url https://hub.example.com/mcp
codex mcp login origin
```

The agent opens the hub in your browser. Sign in to the admin UI, and allow it, choosing what it may do (read and write, or read only) and for how long (1 to 365 days). It then keeps its own tokens and renews them, and it appears under **Devices and agents**, where you can revoke it at any time; `claude mcp logout origin` signs Claude Code out. See [Connect your agents](./connect-agents.md#using-a-personal-hub) for the details.

An agent that cannot open a browser uses a token instead (see [Devices and agents](#devices-and-agents)):

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI (reads the token from the ORIGIN_TOKEN environment variable)
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

## Append event lines

Programs that run on none of your devices, such as a bot, an agent runtime in the cloud, or a pipeline, can bring their sessions to the hub as [event lines](./sources.md). Give each an agent's token of its own, named after it, and post its lines to `POST /v1/sources/<name>/lines?path=<path>`:

```bash
origin token create chat-bridge --agent    # on the hub, once; prints the token
curl -sS -X POST "https://hub.example.com/v1/sources/chat-ops/lines?path=incidents.jsonl" \
  -H "Authorization: Bearer ogn_…" -H "Content-Type: application/x-ndjson" \
  --data-binary @incidents.jsonl
```

The hub appends the lines to file `path` of the source `chat-ops`, as sent by the token's name, `chat-bridge`, archives and parses them as it does what devices send, and answers with how many lines it read, how many events were new, how many it already had, how many were not valid events, and how many it stored blank because a purge removed what they hold. Sending lines again is safe. A request holds at most 8 MiB of lines. See [Send lines to your hub](./sources.md#send-lines-to-your-hub).

## Forgetting

Forgetting through the hub works as on one machine (see [Privacy and your data](./privacy.md#forgetting)), and it reaches every device. Each device applies the hub's tombstones on its next sync, so its local copy hides the same entries and events, and what a device forgets reaches the hub and, from there, every other device. Forgotten events stay hidden even if a device pushes them again. Restoring travels the same way: restore on the hub's admin UI, or with `origin restore` on a device, and every store brings back what that forget hid, in whatever order the forget and the restore reach it.

## Purging

A purge deletes for good what you select, and keeps a record with your reason (see [Purging](./cli.md#purging)). Purge on the hub, in its [admin UI](./admin.md): each device applies the purge at its next sync, before it sends anything, so what it removed is deleted from the device's store too, and never comes back up from it, whatever the agents' logs there still hold. `origin sync` says how many purges it applied, and `origin purged` lists them under the hub's id, with its reason. A purge made on a device, with `origin purge`, deletes only that device's copy: the hub keeps what it already received, so the command prints a link to the same purge in the hub's admin UI. Tokens of devices and agents cannot purge anything on the hub; a device's token only reads the hub's purges. A purge does not reach backups, or the agents' own log files.

## Manage it in a browser

The hub can serve an [admin UI](./admin.md) for you: an overview of your devices and storage, your sessions and entries, search, correcting and forgetting, your devices and agents, and an audit log. It is off by default; enable it with `origin serve --admin` (or `ORIGIN_ADMIN=on`). At the first sign-in, choose your username, and enter the password the hub prints to its log on that first start, or one you set with `origin admin password` or `ORIGIN_ADMIN_PASSWORD`; from then on you sign in with both.

## Keep raw mirrors in a bucket

Raw mirrors take most of a hub's space, and their sealed frames, compressed blocks of lines, are written once and change only when a purge blanks lines in them. A hub can keep them in an S3-compatible bucket instead of its disk, such as one on a MinIO server you run. The newest lines of each mirror (under 1 MiB per file) and the database stay on the hub's disk. Without a bucket, nothing changes.

Configure the bucket with flags of `origin serve` or with environment variables:

| Variable | Flag | Default | Purpose |
|---|---|---|---|
| `ORIGIN_RAW_S3_ENDPOINT` | `--raw-s3-endpoint` | — | The store's address, such as `http://minio:9000` |
| `ORIGIN_RAW_S3_BUCKET` | `--raw-s3-bucket` | — | The bucket |
| `ORIGIN_RAW_S3_PREFIX` | `--raw-s3-prefix` | none | Put before every key; give each hub its own |
| `ORIGIN_RAW_S3_REGION` | `--raw-s3-region` | `us-east-1` | The region requests are signed for; MinIO accepts the default |
| `ORIGIN_RAW_S3_ADDRESSING` | `--raw-s3-addressing` | `path` | `path` for `<endpoint>/<bucket>/<key>` (MinIO's default), `virtual` for `<bucket>.<host>/<key>` |
| `ORIGIN_RAW_S3_ACCESS_KEY_ID` | — | — | The access key; or `ORIGIN_RAW_S3_ACCESS_KEY_ID_FILE`, a file that holds it |
| `ORIGIN_RAW_S3_SECRET_ACCESS_KEY` | — | — | The secret key; or `ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE`, a file that holds it |
| `ORIGIN_RAW_S3_TIMEOUT_MS` | — | `30000` | How long one request may take |

The keys come only from the environment or from files, never from flags, so they do not show in process lists, and Origin never prints them. They need `s3:PutObject` and `s3:GetObject` on the prefix, and `s3:ListBucket` on the bucket, without which a store reports a missing object as access denied; Origin never lists or deletes objects. Reach the bucket over https unless it is on the hub's own private network: the frames hold your sessions.

With Docker:

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data \
  -e ORIGIN_RAW_S3_ENDPOINT=http://minio:9000 -e ORIGIN_RAW_S3_BUCKET=origin -e ORIGIN_RAW_S3_PREFIX=hub \
  --env-file origin-s3.env ghcr.io/openlinkos/origin
```

where `origin-s3.env` holds `ORIGIN_RAW_S3_ACCESS_KEY_ID=…` and `ORIGIN_RAW_S3_SECRET_ACCESS_KEY=…`. On Kubernetes, keep the keys in a Secret and mount it as files:

```yaml
# The bucket's keys:
apiVersion: v1
kind: Secret
metadata:
  name: origin-raw-s3
stringData:
  access-key-id: origin-hub
  secret-access-key: change-me
---
# In the hub's StatefulSet or Deployment, under spec.template.spec:
containers:
  - name: origin
    image: ghcr.io/openlinkos/origin
    env:
      - name: ORIGIN_RAW_S3_ENDPOINT
        value: http://minio.minio.svc.cluster.local:9000
      - name: ORIGIN_RAW_S3_BUCKET
        value: origin
      - name: ORIGIN_RAW_S3_PREFIX
        value: hub
      - name: ORIGIN_RAW_S3_ACCESS_KEY_ID_FILE
        value: /run/secrets/origin-raw-s3/access-key-id
      - name: ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE
        value: /run/secrets/origin-raw-s3/secret-access-key
    volumeMounts:
      - name: origin-raw-s3
        mountPath: /run/secrets/origin-raw-s3
        readOnly: true
volumes:
  - name: origin-raw-s3
    secret:
      secretName: origin-raw-s3
```

- **Starting.** The hub writes one small object, `<prefix>/.origin-check`, reads it back, and refuses to start if it cannot. From then on the store remembers the bucket and the prefix: the hub refuses to start without them or with others, and other commands run on the hub, such as `origin backup` or `origin show`, reach the bucket through the same variables. The endpoint may change.
- **Frames.** Each new frame is one object, `<prefix>/<mirror>.zst/<offset>`, and objects are never deleted, and put again only by a purge, which blanks lines in them. Frames sealed before the hub had a bucket stay on its disk, and are read from there until you move them. On the hub, even while it serves:

  ```bash
  origin raw upload            # upload and verify them, and list the .zst files that may go
  origin raw upload --remove   # the same, then remove those files
  ```

  It is safe to run again: frames already in the bucket are only verified. A file is removed only once every frame in it has been read back from the bucket and matches. It moves 8 frames at a time, which matters over a slow or distant link; `--concurrency <n>` (1 to 64) changes that. If a frame fails its check, the file that holds it is kept and the others go on; if the bucket stops answering, it stops, and the next run goes on from there.
- **Waiting for the bucket.** The hub waits for each frame it sends to or reads from the bucket, and serves nothing else meanwhile, so keep the bucket close: on a LAN a frame takes a few milliseconds. A bucket that cannot be reached holds each request up to `ORIGIN_RAW_S3_TIMEOUT_MS`, and pushes that need it fail until it is back; nothing is lost, and devices push again on their next sync.
- **Backups.** `origin backup` on the hub copies the frames from the bucket into the backup, so a backup needs no bucket to restore (see [Backing up](./privacy.md#backing-up)).

The design is in [Architecture](../architecture.md#frame-stores).

## Run the hub on PostgreSQL

A hub keeps its database in SQLite, `/data/origin.db`, unless you give it a PostgreSQL database. Use PostgreSQL when the hub's database outgrows its disk, or when you already run PostgreSQL and back it up. Devices always keep their stores in SQLite, and nothing changes for them or for your agents: they connect to the hub as before, and search finds the same things.

**The database.** PostgreSQL 17 or later, and a database whose encoding is UTF8 and whose locale is C, so that text is compared and case-folded the same way everywhere. As a superuser:

```sql
CREATE ROLE origin LOGIN PASSWORD 'change-me';
CREATE DATABASE origin OWNER origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';
```

The hub refuses any other database, and says how to create one. On its first start it creates its schema, `origin`, and its tables in it; the role needs to be allowed to create a schema in the database, which its owner is.

**The URL.** Set `ORIGIN_DATABASE_URL` to `postgres://user:password@host:5432/database`, or `ORIGIN_DATABASE_URL_FILE` to a file that holds it, such as a mounted Secret. The `schema` parameter names the schema the store is in, `origin` by default, so that one database can hold several stores; Origin reads it and gives the rest of the URL to the driver as it is. For TLS, add `sslmode=verify-full` and `sslrootcert=/path/to/ca.pem`, a CA certificate the hub can read. The password never appears in Origin's messages: `origin status` and the admin UI's overview show the URL without it.

**Connections.** Each Origin process holds one connection of its own: the hub, and each command you run on the hub's host. Connect directly, or through a pooler in session mode; transaction pooling, such as PgBouncer's `pool_mode = transaction`, does not work, because Origin keeps settings and locks on its connection.

**What stays in `/data`.** The raw mirrors, `raw/` (unless their sealed frames are in a [bucket](#keep-raw-mirrors-in-a-bucket)), and `store.json`, which pairs the mirrors with the database: it holds the id of the store whose mirrors these are, and that the store is in PostgreSQL. The hub refuses to start on a database that holds another store, or a new one when `/data` already holds mirrors; and without the URL, it does not create an empty SQLite store in `/data`, but says to set it. Keep the `/data` volume, and back up both.

**One hub per store.** While `origin serve` runs, it holds a lock on the store, so a second hub on the same store, from this machine or another, refuses to start. Other commands on the hub's host, such as `origin token`, `origin admin`, `origin forget`, or `origin backup`, run beside it, as with SQLite.

**Commands that do not run.** A store in PostgreSQL is a hub's, so the commands that work with a machine's own agents refuse to run there, with exit code 2, and say why: `origin sync` and `origin push`, `origin hub`, `origin mcp` (agents use the hub's `/mcp`), `origin ui` (use `origin serve --admin`), `origin agents`, `origin sessions reproject`, and `origin sessions parents`. Agents' hooks, `origin sync --hook` and `origin recall --hook`, do nothing and exit 0, with one line on standard error.

With Docker, the URL in a file:

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data \
  -v /etc/origin/database-url:/run/secrets/database-url:ro \
  -e ORIGIN_DATABASE_URL_FILE=/run/secrets/database-url \
  ghcr.io/openlinkos/origin
```

On Kubernetes, keep the URL in a Secret, and mount it as a file:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: origin-database
stringData:
  url: postgres://origin:change-me@postgres.db.svc.cluster.local:5432/origin?sslmode=verify-full&sslrootcert=/run/secrets/origin-database/ca.pem
  ca.pem: |
    -----BEGIN CERTIFICATE-----
    …
---
# In the hub's StatefulSet or Deployment, under spec.template.spec:
containers:
  - name: origin
    image: ghcr.io/openlinkos/origin
    env:
      - name: ORIGIN_DATABASE_URL_FILE
        value: /run/secrets/origin-database/url
    volumeMounts:
      - name: origin-database
        mountPath: /run/secrets/origin-database
        readOnly: true
volumes:
  - name: origin-database
    secret:
      secretName: origin-database
```

- **Moving a hub.** `origin db move` moves a hub's store from SQLite into PostgreSQL, and back, with the hub stopped (see [Move a hub to PostgreSQL](./upgrading.md#move-a-hub-to-postgresql)).
- **Backups.** `origin backup <dir>` exports the store, from one snapshot, into `<dir>/origin.db`, a SQLite database, with the mirrors as before (see [Backing up](./privacy.md#backing-up)). Restore it into an empty `/data` and start a hub on it as it is, or move it into PostgreSQL again with `origin db move`. A dump of the database (`pg_dump`) with a copy of `/data` is consistent only if the hub is stopped while both are made, since the hub keeps changing the newest lines of the mirrors as it runs.

The design is in [Architecture](../architecture.md#database-engines).

## Limitations

- CLI curation commands (`entries`, `show`, `correct`, `forget`, …) act on the device's own store, then sync. To see and curate the entries of every device, use your agents or the hub's [admin UI](./admin.md).
- A device does not download other devices' data, so without the hub it can only answer about itself.
- A relay has no memory of its own: while its hub cannot be reached, its agents can neither read nor write memory, and what it has not sent yet exists only in the agents' logs.
- The hub is one store for one person. It does not support multiple users, sync between hubs, or sync between devices without a hub.
