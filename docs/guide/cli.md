# CLI reference

```text
origin sync      [--source <id>] [--verbose] [--local] Ingest local agent sessions, then sync with the hub if connected
origin status                                          Per-source counts, entries, and last sync
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                Events of one session (tool events hidden unless --all)
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id>                                  Show an entry or an event, with its original source
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> --reason <text> [--yes]          Hide an entry or event on every store, as a record (needs --yes)
origin forgotten [--limit 50]                          Forgets and restores, newest first, with their reasons
origin restore   <tombstone-id> --reason <text> [--yes]  Bring back what a forget hid (needs --yes)
origin projects                                        Known project names
origin backup    <dir>                                 Back up the database and raw mirrors into <dir> (incremental)
origin mcp                                             Run the MCP server over stdio (adds the hub's answers when connected)
origin ui        [--port 7079] [--no-open]             Browse and curate this store in your browser, on 127.0.0.1

origin serve     [--host 127.0.0.1] [--port 7077]      Run this store as a personal hub (MCP over HTTP)
                 [--admin | --admin-listen <host:port>] [--public-url <url>]   Also serve the admin UI
                 [--raw-s3-endpoint <url> --raw-s3-bucket <name> [--raw-s3-prefix <p>]]   Keep sealed frames in a bucket
origin raw       upload [--remove] [--concurrency 8]    Move sealed frames still on the hub's disk to its bucket (run on the hub)
origin token     create <name> | list | revoke <name>  Manage the hub's access tokens (run on the hub)
origin admin     password [--generate]                 Set the admin UI password; signs out every session (run on the hub)
origin admin     sessions [--revoke-all] | audit [--limit 50]       Admin UI sessions and the audit log
origin hub       connect <url> --token <token> [--device <name>] [--relay] | status | disconnect
origin push                                            Same as origin sync (kept for existing schedules)
```

- **Time values** are relative durations (`30m`, `24h`, `7d`, `2w`) or dates (`YYYY-MM-DD`, ISO 8601).
- **Source ids** are `claude-code`, `codex`, `cursor`, `grok`, and `zcode`.
- **Entry kinds** are `memory` (what happened), `knowledge` (stable facts), and `cognition` (your preferences, methods, goals, and boundaries).
- **Entries** listed and found are the current ones. Superseded versions, and entries whose validity has ended (such as an imported memory whose file was deleted), appear with `origin entries --history` and in `origin show`. Entries imported from the memory files agents keep for themselves are marked as imported.
- **Ids** look like `ent_5f0c2a9e41b7` for entries, `claude-code:<uuid>` or `codex:<session>:o12` for events, and `tmb_3a9d70c1e2f4` for tombstones, the records that forgetting and restoring leave.

## Searching

`search` looks in entries and in session messages. Every word of the query must occur, as a case-insensitive substring; CJK text works too, including one- and two-character words such as `部署`. Results are ranked by relevance among the newest 2,000 matches; `--recent` sorts by time instead, newest first, and `--all` also searches tool calls and their output. Other words shorter than three characters, such as `AI`, are checked against the newest 25,000 events that match the rest of the query, so add a longer word or a time range to reach older ones. The details are in [Search and timeline](../architecture.md#search-and-timeline).

```console
$ origin search "schema migrations"
Entries:
[2026-10-20 10:42] memory, conf 0.9, origin
    No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
    ↳ ent_5f0c2a9e41b7

Events:
[2026-10-20 10:01] claude-code origin user/message
    Let's not add [migrations] yet — we're early. Just test in a fresh temp folder.
    ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

1 entry, 1 event. Details: origin show <id>
```

## Inspecting

`show` prints an entry with its sources and version history, or an event with its raw locator: the original file, the mirror and line (a mirror is stored compressed, as `<mirror>.zst` and `<mirror>.tail`), and the original line itself.

```console
$ origin show ent_5f0c2a9e41b7
Entry       ent_5f0c2a9e41b7  memory, active
Created     2026-10-20 10:42 by claude-code  confidence 0.9  project origin

No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.

Sources:
  [2026-10-20 10:01] claude-code origin user/message
      “not add migrations yet”
      ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
```

## Correcting and forgetting

`correct` adds a new version of an entry and keeps the old one as history. `forget` needs a reason, first shows what it will hide, and only acts with `--yes`:

```console
$ origin forget ent_5f0c2a9e41b7 --reason "wrong project"
This will hide 1 entry and 1 event, here and on every store it reaches:
  ent_5f0c2a9e41b7
  claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

The forget is kept as a record with its reason; you can restore it later with origin restore. Re-run with --yes to confirm.
```

`origin forgotten` lists the forgets and restores of this store, newest first, with their ids, targets, status, and reasons. `origin restore <tombstone-id> --reason <text>` brings back what a forget hid, except what another forget still hides; like `forget`, it first shows what it will bring back, and only acts with `--yes`. Agents cannot restore. To hide something again after a restore, forget it again.

The rules are described in [Privacy and your data](./privacy.md#forgetting).

## In your browser

`origin ui` serves the [admin UI](./admin.md#on-your-own-machine) for this machine's store, on `127.0.0.1` only, at port 7079 unless you pass `--port`. It prints a sign-in link, which works once, within 5 minutes, and opens it in your default browser; `--no-open` only prints it. There is no password. While it runs in a terminal, press Enter for a new link, which it prints and opens the same way; the previous link stops working. Stop it with Ctrl+C, which also signs the browser out. When it starts, it ingests this machine's agent sessions in the background, as `origin sync --local` does, so the UI shows what your agents wrote last; the UI can be used meanwhile. It refuses to run on a relay, which keeps no sessions of its own. On a device connected to a hub, the entries you write, and what you forget or restore there, are synced with the hub in the background, as after `correct`, `forget`, and `restore`.

## Personal hub

These commands run a [personal hub](./hub.md) and connect devices to it.

- On the hub, `origin serve` exposes `POST /mcp` and the replication API, and `GET /healthz` reports health without authentication. `origin token create <name>` prints a new token once (prefix `ogn_`); the hub stores only its hash. Name a device's token after the device: it works only for the device of that name. A revoked token can be replaced by a new one of the same name.
- On a device, `origin hub connect` saves the hub's URL and a token; the hub knows the device by its store's name, which must be the token's name. `origin hub connect` and `origin hub status` check this with the hub and say how to fix a mismatch. From then on, `origin sync` also syncs with the hub: it sends new raw mirror bytes and the entries and tombstones written on the device, then applies the tombstones of the hub. It can be re-run at any time, and each run resumes where the previous one stopped. `--local` skips the hub. `origin status` and `origin hub status` show when the device last finished a sync with the hub, whichever command or agent ran it, and the error of the last sync if it failed since.
- Once a device is connected, `origin mcp` answers from the device's store and merges in the hub's answers, waiting for the hub at most 2 seconds; what agents save is written on the device and then synced.
- Curation commands (`entries`, `show`, `correct`, `forget`, …) act on the device's own store. On a connected device, `correct`, `forget`, and `restore` then sync with the hub; if the hub cannot be reached, the change stays on the device until the next sync.
- `origin hub connect … --relay` makes an empty store a [relay](./hub.md#run-a-device-as-a-relay), which keeps no sessions or entries of its own; a store that holds any is refused. On a relay, `origin sync` sends the agents' new log lines straight to the hub (`--local` does not apply), `origin status` shows per source the files and bytes still to send and warns when sessions not sent yet near the age at which their agent deletes them, `origin mcp` hands every tool call to the hub, and `search`, `timeline`, `show`, `entries`, `correct`, and `forget` ask the hub; `entries --history`, `projects`, `forgotten`, and `restore` are not available (restore in the hub's admin UI). `origin hub status` shows the mode.
- `origin serve --admin` also serves the [admin UI](./admin.md) at `/admin`, and `--admin-listen <host:port>` serves it on a separate listener instead. Behind TLS, pass the hub's https address with `--public-url`; the hub refuses to serve the UI over plain HTTP beyond loopback.
- `origin serve --raw-s3-endpoint <url> --raw-s3-bucket <name>`, or the `ORIGIN_RAW_S3_*` variables, keeps the hub's sealed frames, most of its raw mirrors, in an S3-compatible bucket such as MinIO; the keys are read only from the environment. `origin raw upload` moves the frames sealed before to the bucket, verifying each, 8 at a time unless `--concurrency` says otherwise, and `--remove` then removes the local files that held them. See [Keep raw mirrors in a bucket](./hub.md#keep-raw-mirrors-in-a-bucket).
- `origin admin password` sets the admin UI's password: it asks twice on a terminal, without showing what you type, and otherwise reads one line from standard input; `--generate` picks a random one and prints it once. The password needs at least 10 characters, and setting it signs out every admin session. On its first start with the admin UI enabled, the hub generates a password and prints it to its log once. `origin admin sessions --revoke-all` signs out every session, and `origin admin audit` prints the audit log. Token and password changes made with the CLI are recorded there too.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Where Origin stores its database and raw mirrors |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory (sessions are read from `<dir>/projects`) |
| `ORIGIN_CLAUDE_PROJECTS` | — | Override the Claude Code projects directory directly |
| `CODEX_HOME` | `~/.codex` | Codex's home directory (rollouts are read from `sessions/` and `archived_sessions/`) |
| `GROK_HOME` | `~/.grok` | Grok Build's home directory (sessions are read from `sessions/`, memories from `memory-v2/` and `memory/`) |
| `ORIGIN_HUB_URL` | — | Hub URL; overrides `origin hub connect` |
| `ORIGIN_HUB_TOKEN` | — | Hub token; overrides `origin hub connect` |
| `ORIGIN_DEVICE` | host name | The name a new store takes: this device's name on the hub, and the origin recorded on what it writes |
| `ORIGIN_HUB_TIMEOUT_MS` | `2000` | How long `origin mcp` on a connected device waits for the hub before answering without it |
| `ORIGIN_WATCH_INTERVAL_MS` | `60000` | How often `origin mcp` looks for new log lines while an agent runs (and syncs them with the hub when connected); `0` turns it off |
| `ORIGIN_ADMIN` | `off` | `on` serves the admin UI at `/admin` (`origin serve --admin`) |
| `ORIGIN_ADMIN_LISTEN` | — | Serve the admin UI on this `host:port` instead (`--admin-listen`) |
| `ORIGIN_PUBLIC_URL` | — | The hub's public https URL (`--public-url`) |
| `ORIGIN_CLIENT_IP_HEADER` | — | Header with the client address set by your proxy; trusted only when set, and needed behind a proxy or CDN |
| `ORIGIN_ADMIN_PASSWORD` | — | The admin UI's password (at least 10 characters); when set, it takes the place of the one set with `origin admin password` |
| `ORIGIN_RAW_S3_ENDPOINT`, `ORIGIN_RAW_S3_BUCKET` | — | Keep the hub's sealed frames in this S3-compatible bucket (`--raw-s3-endpoint`, `--raw-s3-bucket`) |
| `ORIGIN_RAW_S3_PREFIX` | none | The prefix of the bucket's keys (`--raw-s3-prefix`) |
| `ORIGIN_RAW_S3_REGION` | `us-east-1` | The region requests to the bucket are signed for (`--raw-s3-region`) |
| `ORIGIN_RAW_S3_ADDRESSING` | `path` | `path` or `virtual`: how the bucket is addressed (`--raw-s3-addressing`) |
| `ORIGIN_RAW_S3_ACCESS_KEY_ID`, `ORIGIN_RAW_S3_SECRET_ACCESS_KEY` | — | The bucket's keys, or with `_FILE`, files that hold them |
| `ORIGIN_RAW_S3_TIMEOUT_MS` | `30000` | How long one request to the bucket may take |
