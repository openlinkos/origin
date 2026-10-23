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
- A machine with little disk can be a **relay** instead of a complete device: it keeps nothing but cursors, sends its agents' logs straight to the hub, and answers its agents through the hub (see [Run a device as a relay](#run-a-device-as-a-relay)).

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

## Run a device as a relay

A device normally keeps a complete memory of its own, including a compressed copy of every session log it has archived. On a machine with little disk, such as a small VPS, run it as a **relay** instead: it keeps no copy and no memory of its own, only a cursor per log file, and sends new sessions to the hub straight from the agents' own logs.

Connect an empty store with `--relay`:

```bash
origin hub connect https://hub.example.com --token ogn_… --device vps --relay
origin sync
origin status
```

- Only a store that holds nothing yet can become a relay. If this machine already has a store with sessions or entries, Origin refuses and changes nothing; set `ORIGIN_HOME` to a new directory and connect that one. A relay stays a relay; to keep a complete store on the machine again, use another new `ORIGIN_HOME`.
- `origin sync` sends the new complete lines of every session log to the hub, which archives and parses them as if the device had sent its own copy, and `origin status` shows, for each source, how many files and bytes are still to send. Agents' `origin mcp` sends new lines as they run, as on any device.
- Agents keep their registrations, but on a relay `origin mcp` answers every tool from the hub: it first sends the hub what was just written, so that agents can find and cite it, then hands the call to the hub. What agents save is written on the hub, recorded as `claude-code@vps`. If the hub cannot be reached, tools fail with a message saying that the relay cannot answer offline.
- `origin search`, `timeline`, `show`, `entries`, `correct`, and `forget` ask the hub too, and `correct` records `user@vps`. A relay cannot list beforehand what `origin forget` will forget, so it says what the rules will forget, and needs `--yes` as always. `entries --history` and `projects` are not available on a relay; use the hub's [admin UI](./admin.md).
- While the hub cannot be reached, nothing is sent, and new sessions exist only in the agents' own logs. Some agents delete old logs, Claude Code after 30 days by default (`cleanupPeriodDays`), so make sure a relay reaches its hub regularly; if agents that do not use Origin run on it, schedule `origin sync`.

The design is in [Relays](../architecture.md#relays).

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

## Keep raw mirrors in a bucket

Raw mirrors take most of a hub's space, and their sealed frames, compressed blocks of lines, are written once and never change. A hub can keep them in an S3-compatible bucket instead of its disk, such as one on a MinIO server you run. The newest lines of each mirror (under 1 MiB per file) and the database stay on the hub's disk. Without a bucket, nothing changes.

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
- **Frames.** Each new frame is one object, `<prefix>/<mirror>.zst/<offset>`, and objects are never changed or deleted. Frames sealed before the hub had a bucket stay on its disk, and are read from there until you move them. On the hub, even while it serves:

  ```bash
  origin raw upload            # upload and verify them, and list the .zst files that may go
  origin raw upload --remove   # the same, then remove those files
  ```

  It is safe to run again: frames already in the bucket are only verified. A file is removed only once every frame in it has been read back from the bucket and matches. It moves 8 frames at a time, which matters over a slow or distant link; `--concurrency <n>` (1 to 64) changes that. If a frame fails its check, the file that holds it is kept and the others go on; if the bucket stops answering, it stops, and the next run goes on from there.
- **Waiting for the bucket.** The hub waits for each frame it sends to or reads from the bucket, and serves nothing else meanwhile, so keep the bucket close: on a LAN a frame takes a few milliseconds. A bucket that cannot be reached holds each request up to `ORIGIN_RAW_S3_TIMEOUT_MS`, and pushes that need it fail until it is back; nothing is lost, and devices push again on their next sync.
- **Backups.** `origin backup` on the hub copies the frames from the bucket into the backup, so a backup needs no bucket to restore (see [Backing up](./privacy.md#backing-up)).

The design is in [Architecture](../architecture.md#frame-stores).

## Limitations

- CLI curation commands (`entries`, `show`, `correct`, `forget`, …) act on the device's own store, then sync. To see and curate the entries of every device, use your agents or the hub's [admin UI](./admin.md).
- A device does not download other devices' data, so without the hub it can only answer about itself.
- A relay has no memory of its own: while its hub cannot be reached, its agents can neither read nor write memory, and what it has not sent yet exists only in the agents' logs.
- The hub is one store for one person. It does not support multiple users, sync between hubs, or sync between devices without a hub.
