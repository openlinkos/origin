# CLI reference

```text
origin sync      [--source <id>] [--verbose] [--local] Ingest local agent sessions, then sync with the hub if connected
origin sync      --hook <agent>                        Ingest the transcript an agent's hook names (reads its event on stdin)
origin status                                          Per-source counts, entries, and last sync
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50] [--children]
origin timeline  --session <id> [--all]                Events of one session (tool events hidden unless --all)
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id> [--source <id>]                  Show an entry, an event (with its original source), a session, a thread, a recall, or a proposal
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> --reason <text> [--yes]          Hide an entry or event on every store, as a record (needs --yes)
origin forgotten [--limit 50]                          Forgets and restores, newest first, with their reasons
origin restore   <tombstone-id> --reason <text> [--yes]  Bring back what a forget hid (needs --yes)
origin proposals [--project <name>] [--status pending|accepted|rejected|all] [--limit 50]   Entries agents proposed, for you to review
origin accept    <proposal-id> [--yes]                 Accept a proposal: write its entry (needs --yes)
origin reject    <proposal-id> --reason <text> [--yes] Reject a proposal: forget it, as a record (needs --yes)
origin distill   [--project <name> | --thread <thr_…>] [--day <YYYY-MM-DD> | --since <t>] [--max 10] [--dry-run]
                                                       Have Claude Code, headless, read a scope and propose entries
origin recall    [--cwd <dir>] [--prompt <text>] [--agent <id>]   What an agent would be handed there; --hook <agent> answers its hooks
origin recalls   [--since <t>] [--agent <id>] [--session <id>] [--all] [--limit 50]   What agents were handed, newest first
origin projects                                        Known project names
origin sessions  parents [--dry-run] [--zcode-db <file>] [--grok-home <dir>]
                                                       Fill workflow run names, and Grok parents only a summary names
origin backup    <dir>                                 Back up the database and raw mirrors into <dir> (incremental)
origin mcp                                             Run the MCP server over stdio (adds the hub's answers when connected)
origin agents    [connect | disconnect] [<agent>...] [--yes]   Register Origin, and its hooks, with the agents here
origin ui        [--port 7079] [--no-open]             Browse and curate this store in your browser, on 127.0.0.1

origin serve     [--host 127.0.0.1] [--port 7077]      Run this store as a personal hub (MCP over HTTP)
                 [--admin | --admin-listen <host:port>] [--public-url <url>]   Also serve the admin UI
                 [--raw-s3-endpoint <url> --raw-s3-bucket <name> [--raw-s3-prefix <p>]]   Keep sealed frames in a bucket
origin raw       upload [--remove] [--concurrency 8]    Move sealed frames still on the hub's disk to its bucket (run on the hub)
origin token     create <name> [--agent [--readonly]] | list | revoke <name>   Tokens of devices and agents (run on the hub)
origin admin     password [--generate]                 Set the admin UI password; signs out every session (run on the hub)
origin admin     username [<name>]                     Show or change the owner's username (run on the hub)
origin admin     sessions [--revoke-all] | audit [--limit 50]       Admin UI sessions and the audit log
origin hub       connect <url> [--token <token>] [--device <name>] [--relay] | status | disconnect
                                                       Without --token, approve the device in the hub's admin UI
origin push                                            Same as origin sync (kept for existing schedules)
```

- **Time values** are relative durations (`30m`, `24h`, `7d`, `2w`) or dates (`YYYY-MM-DD`, ISO 8601).
- **Source ids** are `claude-code`, `codex`, `cursor`, `grok`, and `zcode`, and the name of each of your own sources, a directory under `~/.origin/sources/` (see [Bring your own source](./sources.md)). `origin sync` warns of a directory there whose name names no source, and leaves it alone.
- **Entry kinds** are `memory` (what happened), `knowledge` (stable facts), and `cognition` (your preferences, methods, goals, and boundaries).
- **Entries** listed and found are the current ones. Superseded versions, and entries whose validity has ended (such as an imported memory whose file was deleted), appear with `origin entries --history` and in `origin show`. Entries imported from the memory files agents keep for themselves are marked as imported.
- **Ids** look like `ent_5f0c2a9e41b7` for entries, `claude-code:<uuid>` or `codex:<session>:o12` for events, `tmb_3a9d70c1e2f4` for tombstones, the records that forgetting and restoring leave, `rcl_7d2e9a0b1c3f` for recalls, `prp_1b7e4c0a9d23` for proposals, entries agents proposed for you to review, and `thr_4c1e9a7b2d30` for threads, the sessions of one piece of work (see [Threads](./concepts.md#threads)). Sessions go by the id their agent gives them, such as a UUID; `origin timeline` shows a session's thread next to its id.
- **Help.** `origin --help`, or `--help` (`-h`) after any command, prints this list. Asking for help, and arguments a command does not take, never open the store, so they never upgrade it (see [Your store](./upgrading.md#your-store)).

## Searching

`search` looks in entries and in session messages. Every word of the query must occur, as a case-insensitive substring; CJK text works too, including one- and two-character words such as `部署`. Results are ranked by relevance among the newest 2,000 matches; `--recent` sorts by time instead, newest first, and `--all` also searches tool calls and their output. Other words shorter than three characters, such as `AI`, are checked against the newest 25,000 events that match the rest of the query, so add a longer word or a time range to reach older ones. A hit in a child session also names its parent (`source:id`) and that parent's title. The details are in [Search and timeline](../architecture.md#search-and-timeline).

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

For a session id, `show` prints the session as a card, the one the MCP tool `get` hands agents: its name and time, its thread, if it is in one, the prompts that start its first 20 turns, the entries written from it, the recalls it was handed, and the sessions just before and after it in its project, with the id of each, to `show` next. A child names its parent, and a parent lists its children, grouped by workflow run, one line each. When sessions of two agents have the same id, `--source` picks one.

```console
$ origin show 9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f
Session     9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f  claude-code, project origin
Name        Store format
Directory   /home/dana/code/origin
Time        2026-10-20 09:58 – 11:20
Events      186 events, 2 turns
Thread      thr_4c1e9a7b2d30, 2 sessions  (origin show thr_4c1e9a7b2d30)

Turns:
    1. [2026-10-20 09:58] How should we version the store format?
       ↳ claude-code:2b7e4d1a-9c3f-4a5b-8e6d-1f0a3b4c5d6e
    2. [2026-10-20 10:01] Let's not add migrations yet — we're early. Just test in a fresh temp folder.
       ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

Entries written from it:
  [2026-10-20 10:42] memory  No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
      ↳ ent_5f0c2a9e41b7

Recalls it was handed:
  [2026-10-20 09:58] at the start of a session, 3 items  ↳ rcl_3f9a0c1d2e4b

Before      codex 2026-10-19 17:30  “Sketch the store layout”
            ↳ 0199a1b2-7c3d-4e5f-8a6b-9c0d1e2f3a4b
After       —

Its events: origin timeline --session 9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f
```

For a thread id, `show` prints the thread as a card, as `get` hands it to agents: its name, project, and time, its first 20 sessions, oldest first, the agents and work branches they were of, the entries written from them, and its last prompt.

```console
$ origin show thr_4c1e9a7b2d30
Thread      thr_4c1e9a7b2d30  project origin
Name        Store format
Time        2026-10-20 09:58 – 2026-10-22 16:05
Sessions    2 sessions, of claude-code, codex
Branches    store-format

Sessions:
  [2026-10-20 09:58] claude-code   186 events  Store format
      ↳ 9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f
  [2026-10-22 15:12] codex          74 events  “Write the migration for the new column”
      ↳ 0199b7c4-2d1e-7f3a-8b5c-6d7e8f9a0b1c

Entries written from it:
  [2026-10-20 10:42] memory  No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
      ↳ ent_5f0c2a9e41b7

Last prompt [2026-10-22 16:01] run the migration tests on Windows too
      ↳ codex:0199b7c4-2d1e-7f3a-8b5c-6d7e8f9a0b1c:o212

A session of it: origin show <session id>
```

## Parent sessions

`origin timeline` lists top-level sessions: none that record a parent, and no child session that names none. `--children` lists those too. A parent line adds how many children it has, and their workflow names, when there are any. A workflow step whose stored title contains `actor#N@M` is shown as `{run name} · actor#N@M`; the title in the store is unchanged. The same names are what `origin show` prints. See [Parent sessions](../architecture.md#parent-sessions).

`origin sessions parents` reads ZCode's database and Grok Build's session directory, read-only, and appends parent lines to each source's `places.jsonl`: a workflow run's group and name, and a Grok parent that only `summary.json` names (`parent_session_id`), when the archive does not already record that parent. `--dry-run` prints how many lines it would append and writes nothing. `--zcode-db` and `--grok-home` name those paths; without them, `~/.zcode` and `~/.grok` (`GROK_HOME` when it is set) are used, and a path that is not there is skipped. The command exits 0 in that case. On a relay, which keeps no sessions, it says so and exits without opening those homes.

## Recall

`origin recall` shows what an agent would be handed in the current directory, or in `--cwd`: the brief of a new session, or, with `--prompt`, the entries a prompt matches. `--agent` shows it as that agent would get it, without the memories it loads itself. It records nothing. `origin agents connect` sets up the hooks (see [Connect your agents](./connect-agents.md#connect-them-all-at-once)). Claude Code's and Codex's hooks run `origin recall --hook claude-code` or `--hook codex`, which reads the hook's event on standard input, records what it hands over, and prints it for the agent. `origin recalls` lists what agents were handed, newest first (`--all` also lists recalls that handed nothing over), and `origin show rcl_…` shows one, with the prompt it answered and the items the session went on to use. See [Recall](./recall.md).

## Ingesting from hooks

Claude Code's and Codex's ingest hooks run `origin sync --hook claude-code` or `--hook codex` in the background when a turn ends, when a sub-agent stops, and, in Claude Code, after a compaction; `origin agents connect` sets them up (see [Connect your agents](./connect-agents.md#connect-them-all-at-once)). It reads the hook's event on standard input, ingests the transcript the event names, and at `SubagentStop` the sub-agent's too, from where the last ingestion of that file stopped, and on a device connected to a hub pushes the file's new lines to the hub, waiting at most 3 seconds; on a relay, it sends them to the hub. It prints nothing; whatever goes wrong, it says why on standard error and exits 0, so that it never stands in the agent's way. `origin sync` itself works as before: other agents' sessions are picked up by it, and by `origin mcp` every minute. See [Live ingestion](../architecture.md#live-ingestion).

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

## Reviewing proposals

Agents propose, with the MCP tool [`propose`](./mcp.md#propose), what they infer and you have not confirmed, and what they write when they consolidate your memory for you, as [`origin distill`](./distill.md) has them do. A proposal is no entry until you accept it. `origin proposals` lists those that wait for you, newest first; `--status accepted` lists those you accepted, with the entry each became, `--status rejected` those you rejected, by id and reason only, and `--status all` all three. `--project` keeps those of one project: the project a proposal names, or its session's.

```console
$ origin proposals
proposal          status   kind       proposed          project  text
----------------  -------  ---------  ----------------  -------  -------------------------------------------------
prp_1b7e4c0a9d23  pending  knowledge  2026-10-22 17:39  origin   Releases are tagged only after both CI jobs pass.

1 proposal pending. Review one with origin show <id>, then origin accept <id> or origin reject <id> --reason <text>.
```

`origin show prp_…` prints a proposal as the MCP tool `get` hands it: what it proposes, who proposed it and in which session, the agent's note, and the events it cites, with their quotes. `origin accept` writes its entry, as you (`user@<device>`), citing those events and the proposal itself; `origin reject` forgets the proposal's event with your reason, as a record that `origin restore` lifts, which makes the proposal pending again. Both first say what they will do, and only act with `--yes`:

```console
$ origin accept prp_1b7e4c0a9d23 --yes
Accepted prp_1b7e4c0a9d23 as ent_7a2c9e1f0b44.
To change it: origin correct ent_7a2c9e1f0b44 <text>

$ origin reject prp_6e2d9a4c1b07 --reason "We tag from release branches now" --yes
Rejected prp_6e2d9a4c1b07 (tombstone tmb_2d8f0c1a9e35).
To bring it back: origin restore tmb_2d8f0c1a9e35 --reason <text>
```

An accepted proposal is an entry like any other: correct it or forget it as such. On a connected device, accepting and rejecting then sync with the hub, so that the entry or the forget reaches every store. On a relay, review proposals in the hub's admin UI; `origin show prp_…` still asks the hub. See [Proposals](../architecture.md#proposals) for the rules.

## Consolidating

`origin distill` runs Claude Code headless (`claude -p`) on a scope, by default the last 24 hours of the project you are in, against this Origin's own MCP server and nothing else, to read what happened and propose entries for you to review. `--project` or `--thread` picks what it reads, `--day` or `--since` when, `--max` how many it may propose (10 by default), and `--max-turns` how many turns it may take (40); `--dry-run` prints the prompt and the command and runs nothing. When it ends, it ingests the run's session and lists what it proposed. See [Consolidate with a headless agent](./distill.md).

## In your browser

`origin ui` serves the [admin UI](./admin.md#on-your-own-machine) for this machine's store, on `127.0.0.1` only, at port 7079 unless you pass `--port`. It prints a sign-in link, which works once, within 5 minutes, and opens it in your default browser; `--no-open` only prints it. There is no password. While it runs in a terminal, press Enter for a new link, which it prints and opens the same way; the previous link stops working. Stop it with Ctrl+C, which also signs the browser out. When it starts, it ingests this machine's agent sessions in the background, as `origin sync --local` does, so the UI shows what your agents wrote last; the UI can be used meanwhile. It refuses to run on a relay, which keeps no sessions of its own. On a device connected to a hub, the entries you write, and what you forget or restore there, are synced with the hub in the background, as after `correct`, `forget`, and `restore`.

## Personal hub

These commands run a [personal hub](./hub.md) and connect devices to it.

- On the hub, `origin serve` exposes `POST /mcp`, the replication API, and `POST /v1/sources/<name>/lines`, through which programs without a device append [event lines](./sources.md#send-lines-to-your-hub), `GET /healthz` reports health without authentication, and `GET /` is a public [landing page](./hub.md#the-landing-page) that says what the hub is. `origin token create <name>` prints a new device's token once (prefix `ogn_`); the hub stores only its hash. Name a device's token after the device: it works only for the device of that name. `--agent` makes it an agent's token instead, for a cloud agent, a bot, or a pipeline, and `--readonly` one that only reads: MCP without the tools that write, and nothing sent to the hub. `origin token list` lists the tokens with their kind and access, and the agents signed in with OAuth; `origin token revoke <name>` revokes either. A revoked token can be replaced by a new one of the same name. See [Devices and agents](./hub.md#devices-and-agents).
- On a device, `origin hub connect <url>` connects the device by your approval in the browser: it prints a link and a code, you approve the device in the hub's admin UI, and it receives its token, under its store's name; with `--token`, it uses a token created on the hub instead, which must have the store's name. It saves the hub's URL and the token. `origin hub connect` and `origin hub status` check this with the hub and say how to fix a mismatch. From then on, `origin sync` also syncs with the hub: it sends new raw mirror bytes and the entries and tombstones written on the device, then applies the tombstones of the hub. It can be re-run at any time, and each run resumes where the previous one stopped. `--local` skips the hub. `origin status` and `origin hub status` show when the device last finished a sync with the hub, whichever command or agent ran it, and the error of the last sync if it failed since.
- Once a device is connected, `origin mcp` answers from the device's store and merges in the hub's answers, waiting for the hub at most 2 seconds; what agents save is written on the device and then synced.
- Curation commands (`entries`, `show`, `correct`, `forget`, …) act on the device's own store. On a connected device, `correct`, `forget`, and `restore` then sync with the hub; if the hub cannot be reached, the change stays on the device until the next sync.
- `origin hub connect … --relay` makes an empty store a [relay](./hub.md#run-a-device-as-a-relay), which keeps no sessions or entries of its own; a store that holds any is refused. On a relay, `origin sync` sends the agents' new log lines straight to the hub (`--local` does not apply), `origin status` shows per source the files and bytes still to send and warns when sessions not sent yet near the age at which their agent deletes them, `origin mcp` hands every tool call to the hub, and `search`, `timeline`, `show`, `entries`, `correct`, and `forget` ask the hub; `entries --history`, `projects`, `forgotten`, and `restore` are not available (restore in the hub's admin UI). `origin hub status` shows the mode.
- `origin serve --admin` also serves the [admin UI](./admin.md) at `/admin`, and `--admin-listen <host:port>` serves it on a separate listener instead. Behind TLS, pass the hub's https address with `--public-url`; the hub refuses to serve the UI over plain HTTP beyond loopback. With the UI at `/admin`, agents sign in to the hub's MCP endpoint with OAuth, and devices connect by your approval (see [Connect your agents](./connect-agents.md#sign-in-with-oauth)).
- `origin serve --raw-s3-endpoint <url> --raw-s3-bucket <name>`, or the `ORIGIN_RAW_S3_*` variables, keeps the hub's sealed frames, most of its raw mirrors, in an S3-compatible bucket such as MinIO; the keys are read only from the environment. `origin raw upload` moves the frames sealed before to the bucket, verifying each, 8 at a time unless `--concurrency` says otherwise, and `--remove` then removes the local files that held them. See [Keep raw mirrors in a bucket](./hub.md#keep-raw-mirrors-in-a-bucket).
- `origin admin username <name>` changes the username you sign in to the admin UI with, and without a name shows it; you choose it at your first sign-in, with the admin password.
- `origin admin password` sets the admin UI's password: it asks twice on a terminal, without showing what you type, and otherwise reads one line from standard input; `--generate` picks a random one and prints it once. The password needs at least 10 characters, and setting it signs out every admin session. On its first start with the admin UI enabled, the hub generates a password and prints it to its log once. `origin admin sessions --revoke-all` signs out every session, and `origin admin audit` prints the audit log. Token, username, and password changes made with the CLI are recorded there too.

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
| `ORIGIN_DISTILL_COMMAND` | `claude` on the `PATH` | The command `origin distill` runs in place of `claude`: a program, or a `.js` or `.mjs` script run with Node |
| `ORIGIN_WATCH_INTERVAL_MS` | `60000` | How often `origin mcp` looks for new log lines while an agent runs (and syncs them with the hub when connected), the fallback for what agents' hooks do not hand over; `0` turns it off |
| `ORIGIN_ZCODE_SETTLE_MS` | `3600000` | How long an unfinished ZCode message must stay unchanged before Origin writes it out. `0` writes it on the next sync once its timestamp is in the past. The Grok adapter has no such wait |
| `ORIGIN_ADMIN` | `off` | `on` serves the admin UI at `/admin` (`origin serve --admin`) |
| `ORIGIN_ADMIN_LISTEN` | — | Serve the admin UI on this `host:port` instead (`--admin-listen`) |
| `ORIGIN_PUBLIC_URL` | — | The hub's public https URL (`--public-url`) |
| `ORIGIN_CLIENT_IP_HEADER` | — | Header with the client address set by your proxy; trusted only when set, and needed behind a proxy or CDN |
| `ORIGIN_ADMIN_PASSWORD` | — | The admin UI's password (at least 10 characters); when set, it takes the place of the one set with `origin admin password` |
| `ORIGIN_POWERED_BY` | `on` | `off` leaves the credit to Origin, "Powered by Origin, open source" and its links, off the hub's [landing page](./hub.md#the-landing-page) |
| `ORIGIN_RAW_S3_ENDPOINT`, `ORIGIN_RAW_S3_BUCKET` | — | Keep the hub's sealed frames in this S3-compatible bucket (`--raw-s3-endpoint`, `--raw-s3-bucket`) |
| `ORIGIN_RAW_S3_PREFIX` | none | The prefix of the bucket's keys (`--raw-s3-prefix`) |
| `ORIGIN_RAW_S3_REGION` | `us-east-1` | The region requests to the bucket are signed for (`--raw-s3-region`) |
| `ORIGIN_RAW_S3_ADDRESSING` | `path` | `path` or `virtual`: how the bucket is addressed (`--raw-s3-addressing`) |
| `ORIGIN_RAW_S3_ACCESS_KEY_ID`, `ORIGIN_RAW_S3_SECRET_ACCESS_KEY` | — | The bucket's keys, or with `_FILE`, files that hold them |
| `ORIGIN_RAW_S3_TIMEOUT_MS` | `30000` | How long one request to the bucket may take |
