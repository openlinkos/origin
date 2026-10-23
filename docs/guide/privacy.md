# Privacy and your data

Agent session logs often contain source code, file contents, command output, and anything you typed into a prompt — sometimes including secrets. Origin copies these logs so that they survive the agents' own cleanup. This page explains what it stores and how to remove it.

## What Origin stores

Everything lives in one directory, `~/.origin` (or `ORIGIN_HOME`):

- `origin.db`: a SQLite database with the normalized events, their search index, your entries, and the record of everything you forgot.
- `raw/`: append-only copies of the original session log files, compressed with zstd: each is a `.zst` file of compressed frames and a `.tail` file with its newest lines. A hub can keep the compressed frames in a bucket instead (see [Keep raw mirrors in a bucket](./hub.md#keep-raw-mirrors-in-a-bucket)).

Your data lives only on machines you control: your devices and, if you run one, your own hub, with the bucket you give it, if any. Origin never calls a third-party service or an LLM API. Without a hub it makes no network connections at all; with a hub, the only traffic is between your devices and your hub, and between the hub and its bucket. The directory is not encrypted, so protect it the way you would protect the original logs.

## Forgetting

`origin forget <id>` (or the agent's `forget` tool, used only when you ask) is permanent:

1. **Forgetting an entry** forgets every version of it and hides the events it cites.
2. **Forgetting an event** hides it and forgets every entry that cites it.
3. **An entry left with no visible source** is forgotten too.

Forgotten entries and events disappear from search, timelines, and every MCP tool, and can never be cited again, even after re-syncing. For example, use `origin forget <event-id>` on a prompt where you pasted a secret.

Forgetting **hides**; it does not erase. The raw mirror files under `~/.origin/raw/` still contain the original lines, because the archive is append-only.

## With a personal hub

A [personal hub](./hub.md) changes where your data lives:

- **A server you control.** The hub holds a full copy of every connected device's sessions and all your entries. Run it only on a machine you control, and protect its data directory like `~/.origin`.
- **TLS and tokens.** The hub speaks plain HTTP, so put it behind TLS before exposing it. Every request except `/healthz` needs a token. The hub stores only hashes of tokens, and you can revoke a token when a device is lost or retired. A device's token works only for that device, so it can never write as another one.
- **Forgetting reaches every device.** Forget anywhere, on a device or on the hub, and the hub and then every device apply the same tombstone on their next sync. Forgotten events stay hidden even if a device pushes them again.
- **What each device keeps.** Each device keeps its own sessions and entries, and sends them to the hub; it never receives other devices' sessions or entries. Forgetting hides data on every store, but as everywhere, the raw mirror files still contain the original lines.
- **A bucket holds your sessions.** If the hub keeps raw mirrors in a bucket, the bucket holds the original lines, compressed but not encrypted, including those of forgotten events. Use an object store you run, such as MinIO, or one you trust like the hub itself; give the hub keys that reach only its prefix, and reach the bucket over https beyond the hub's own network.
- **The admin UI shows your sessions.** If you enable the hub's [admin UI](./admin.md), anyone who knows the admin password can read your archived sessions and entries in a browser. Guard the password like the hub itself. The UI never shows the text of forgotten entries or events.
- **The audit log records clients.** Sign-ins and administrative actions are logged on the hub with the client's address and the browser's user agent, but never with entry or event text.
- **A CDN sees decrypted traffic.** A CDN or proxy that terminates TLS sees everything that passes through it: what devices push, what agents read, and what the admin UI shows you. Prefer [private access](./admin.md#private-access) to the admin UI if that matters to you.

## Backing up

`origin backup <dir>` backs up a store into a directory, even while agents or the hub keep using it:

```bash
origin backup /backups/origin
```

It first copies `origin.db` with SQLite's online backup in a single step, so that the copy is one consistent snapshot, and then the `raw/` mirrors as that copy records them. Compressed frames never change, so running it again into the same directory copies only new frames and the newest lines. To restore, copy the directory into an empty `ORIGIN_HOME` (on a hub, the `/data` volume). Like the store, a backup keeps the raw lines of forgotten events.

On a hub that keeps raw mirrors in a [bucket](./hub.md#keep-raw-mirrors-in-a-bucket), run `origin backup` on the hub, where the bucket is configured. It copies the compressed frames from the bucket into the backup directory, laid out as without a bucket, so that a backup holds everything and is restored the same way, with or without the bucket; the restored store keeps its frames on disk until it is given a bucket again. The first backup downloads every frame, and later ones only the frames that are new. Objects in the bucket are never changed or deleted, so you may also back up the bucket on its own, but a backup directory never needs it.

Other ways of copying a large database that is in use are slower or unsafe. `VACUUM INTO` rebuilds every table and index, which takes many times longer (about 13 minutes rather than 40 seconds for a 20 GB database). The `.backup` command of `sqlite3` copies in small steps and starts over whenever another process writes, which Origin does every few seconds while agents run. A plain copy of the file is consistent only when no Origin process is running, because recent writes may still be in `origin.db-wal`.

## Removing everything

Delete `~/.origin` (or your `ORIGIN_HOME`). Without a hub, Origin keeps nothing anywhere else; with a hub, also delete the hub's data directory (`/data` in the container) and, if it has a bucket, the objects under its prefix, and revoke the device's token. Also remove the MCP registration from your agents (for Claude Code: `claude mcp remove --scope user origin`).

## Reporting a problem

If you find a way Origin could leak, expose, or corrupt your data, please report it privately as described in the [security policy](https://github.com/openlinkos/origin/blob/master/SECURITY.md).
