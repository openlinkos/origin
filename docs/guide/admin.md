# Admin UI

A [personal hub](./hub.md) can serve a web interface for you, its owner. From a browser you can see what your devices have pushed, browse and search your sessions, curate entries, forget what should not be kept, and manage the hub's tokens. The admin UI is off by default. It is for one person: there are no public pages, no sharing, and no other accounts. You can also open it on your own machine, for the store there, without a hub: see [On your own machine](#on-your-own-machine).

## What you can do

- **Overview**: counts of events, sessions, entries, devices, tokens, and tombstones; a chart of your activity over the last 30 days, events per day by agent, with its numbers in a table; your recent sessions and most active projects; each agent with its latest version, when its sessions were last archived, and its parse errors in the last 7 days; each device with the last time it sent data (flagged after 24 hours); the latest entries, and the latest forgets and restores; storage: the database, the raw mirrors on disk, and, on a hub that keeps them in a bucket, the frames there, and free disk space; parse errors in the last 24 hours and 7 days; the version and uptime.
- **Tokens**: create a token for a device (named after the device, since a device's token works only for it) or a cloud agent, shown once together with ready-to-paste commands for `origin hub connect`, Claude Code, Codex, and an optional sync schedule; revoke a token.
- **Devices** and the files each one has pushed, and a **Connect** page with the commands to connect a new device or agent.
- **Timeline**: every session by the day it was last active, with its agent, project, duration, and number of turns. A session without a title is named by its first prompt, in italics. Filter by words in the name, by agent, or by project. Days follow the time zone of the machine that serves the UI; for a hub in a container, set `TZ`, such as `TZ=Asia/Shanghai`.
- **Sessions, turn by turn**: a session's page shows one card per turn: a turn starts at a prompt you typed, or at a command such as `/review` that the agent then acted on, and holds everything until the next one. A card shows your prompt (or the command), then the agent's tool calls folded into one line (how many calls of which tools, and how many failed), and the agent's last reply, formatted as Markdown. Open the line for one row per call: what it was about (the file, command, pattern, or URL), whether it succeeded, and its input and result on request; what the agent said on the way appears among them. Commands the agent did not act on, such as `/clear` or `/model`, their output, and context the agent injected appear as small notes. Every item links to its event, and so to its provenance. Long sessions are paged by turns, and an index of days jumps to the first turn of each; **Expanded** opens every tool run at once.
- **Events** with their provenance: the device, the original file, the generation, and the mirror line. The original raw line is shown only when you ask for it, shortened to 4,000 characters.
- **Search** across entries and events.
- **Entries**: browse them with their sources and version history (where each version was written, and which versions lost to a concurrent correction), **correct** an entry (a new version replaces it; the old one stays in the history), and **remember** a new entry from an event page, citing that event. Entries you write are recorded with the author `user@hub` (`user@` and the hub's name), as `origin correct` records `user@` and the device's name. Entries imported from the memory files agents keep for themselves are marked, and an entry whose validity has ended, such as an imported memory whose file was deleted, appears in the history.
- **Recalls**: what your agents were handed without asking (see [Recall](./recall.md)), each item as it is now and whether the session used it. An entry's page lists the recalls that handed it over, and a session's page shows each recall in its turn. A hub's admin UI shows every device's.
- **Forget** an entry or an event: the UI first shows exactly which entries and events will be hidden, and you confirm once, with a reason. Forgetting works as everywhere else (see [Privacy and your data](./privacy.md#forgetting)) and reaches every device on its next sync.
- **Forgotten**: every forget and restore, with its time, where it was made, who made it, its reason, and what it covers. A forget's own page shows you what it hides, the entries' text and the session events, which appear nowhere else; **Restore** there brings it back, after saying what will come back and asking for a reason.
- The **audit log**, and your open **sign-ins**.

The admin UI is available in English and Simplified Chinese, following your browser's language, and follows your system's light or dark mode. Both can be switched at the foot of the sidebar, or below the form on the sign-in page.

## On your own machine

On any machine where Origin archives your sessions, `origin ui` serves the admin UI for that machine's own store (`~/.origin`, or `$ORIGIN_HOME`). No hub is needed:

```bash
origin ui                 # opens http://127.0.0.1:7079/admin/ in your browser
origin ui --port 7080     # on another port
origin ui --no-open       # only print the sign-in link
```

There is no password. When it starts, `origin ui` prints a sign-in link and opens it in your default browser. The link works once, within 5 minutes, and keeps that browser signed in until you stop `origin ui` with Ctrl+C, for at most 12 hours. For a new link, for example to sign in from another browser, press Enter in the terminal where `origin ui` runs, or start it again; the previous link stops working, whether it was used or not.

It has the pages above, except those that only make sense on a hub: tokens, devices, connection commands, and sign-ins. Remembering, correcting, forgetting, and restoring work as on a hub, and the audit log records them with the actor `local`. It shows what the store holds: agents that use Origin archive their sessions as they go, and when it starts, `origin ui` brings in the rest in the background, as `origin sync --local` does, while you browse. If the machine is connected to a hub, the overview shows the hub and when the machine last synced with it; what you change is sent to the hub in the background right away, or with the next sync if the hub cannot be reached.

`origin ui` listens only on `127.0.0.1`, and answers only to `127.0.0.1` and `localhost` on its own port. To use it on a machine you reach over SSH, forward the same port number, then open the link it prints:

```bash
ssh -L 7079:127.0.0.1:7079 you@workstation   # then, on the workstation: origin ui --no-open
```

## Enable it

There are two ways to serve it:

```bash
# At /admin on the hub's own port, behind the same TLS proxy as the hub
origin serve --host 127.0.0.1 --port 7077 --admin --public-url https://hub.example.com

# On a separate, private listener, reached through an SSH tunnel or a port-forward
origin serve --host 0.0.0.0 --port 7077 --admin-listen 127.0.0.1:7078
```

The hub refuses to start if the admin UI could be reached over plain HTTP from another machine. When the UI listens on an address other than loopback, `--public-url` must be the `https://` address of the TLS proxy in front of the hub, or an `http://` address on a loopback host such as `http://localhost:7077` when the port is only published on `127.0.0.1`. Without `--public-url`, the UI answers only requests that reach it on a loopback address, such as through a tunnel.

With Docker, use environment variables:

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data \
  -e ORIGIN_ADMIN=on -e ORIGIN_PUBLIC_URL=https://hub.example.com \
  ghcr.io/openlinkos/origin
```

| Variable | Purpose |
|---|---|
| `ORIGIN_ADMIN` | `on` serves the admin UI at `/admin` on the hub's port, like `--admin` |
| `ORIGIN_ADMIN_LISTEN` | `host:port` of a separate listener for the admin UI, like `--admin-listen` |
| `ORIGIN_PUBLIC_URL` | The hub's public URL, like `--public-url`; the UI's commands use it as the hub's address |
| `ORIGIN_CLIENT_IP_HEADER` | A header with the client's address set by your proxy, such as `X-Real-IP`; trusted only when set, and needed behind a proxy or CDN (see [below](#behind-tls-and-a-cdn)) |
| `ORIGIN_ADMIN_PASSWORD` | The admin password, at least 10 characters; when set, it takes the place of the stored one (see [Sign in](#sign-in)) |

Command-line flags take precedence over the environment. Use either `/admin` on the hub or a separate listener, not both.

## Sign in

A hub has one admin password, and there are no user names. The admin UI has no setup page, so a new hub cannot be claimed by whoever reaches it first. Instead, the first time the hub starts with the admin UI enabled, it generates a password and prints it to its log, this once only:

```text
Generated an admin password for the admin UI (shown only this once):

    abcde-fghjk-mnpqr-stvwx

Sign in with it, then set your own with: origin admin password
```

With Docker, read it with `docker logs origin-hub`. Open `https://hub.example.com/admin/`, sign in with it, and then choose your own password on the hub:

```bash
origin admin password                               # asks twice, without showing what you type
docker exec -it origin-hub origin admin password    # the same, with Docker
origin admin password --generate                    # or pick a random one, printed once
```

The password needs at least 10 characters. A new password replaces the old one at once and signs out every session; nothing needs restarting. Run the same command if you lose the password. Without a terminal, the command reads the password from the first line of its standard input, so scripts can pipe it in, for example `docker exec -i origin-hub origin admin password < password.txt`. The sign-in form presents it as the password of a fixed user name, so your browser's password manager can save it.

To keep the password in your deployment's configuration instead, such as a Docker Compose file or a Kubernetes Secret, set `ORIGIN_ADMIN_PASSWORD`. When it is set, it is the password, and the stored one is ignored. It must have at least 10 characters, or the hub refuses to start. To change it, restart the hub with the new value: the hub notices the change and signs out every session. `origin admin password` warns you when it sees this variable, since a password it stores has no effect while the variable is set.

The hub keeps the password only as a scrypt hash in its own database, and never sends it to devices. The admin password and the tokens of devices and agents are separate: a token (`ogn_…`) never signs in to the admin UI, and the admin password never works for MCP or for pushing.

```bash
origin admin sessions               # open sessions: sign-in time, last activity, client
origin admin sessions --revoke-all  # sign out everywhere
origin admin audit --limit 50       # recent administrative actions
```

A session ends after 30 minutes without activity or 12 hours after you signed in. Creating or revoking a token and signing out other sessions ask for the password again if you have not entered it in the last 10 minutes. Forgetting and restoring do not: each can be undone by the other.

## Behind TLS and a CDN

If you reach the admin UI through the same reverse proxy or CDN as the hub, configure it as for the hub (see [Put it behind TLS](./hub.md#put-it-behind-tls)), and also:

- Forward `/admin` and `/admin/*` to the hub unchanged: no path rewriting, and keep the `Host`, `Origin`, and `Cookie` request headers and the `Set-Cookie` response header.
- Bypass the cache for `/admin` and `/admin/*`. The hub marks every response `Cache-Control: no-store, private`, but some CDNs cache by rule regardless.
- Do not inject scripts, rewrite HTML, or add analytics on `/admin*`: the UI's Content-Security-Policy blocks them.
- Pass `--public-url` with the address you open in the browser. Every form submission is checked against it.
- Set `ORIGIN_CLIENT_IP_HEADER` to the header in which the proxy passes the real client address, such as `X-Real-IP`, so that the sign-in limit and the audit log see real addresses. Without it, every request seems to come from the proxy, so all failed sign-ins share one limit: anyone could make 10 wrong guesses and lock you out for 10 minutes. Only set it if the hub cannot be reached except through that proxy, since anyone else could forge the header.

A CDN terminates TLS, so it sees the decrypted traffic, including the session content the admin UI shows you. If that matters to you, prefer private access.

## Private access

The admin UI does not need to be public at all. Serve it on a loopback listener and reach it through a tunnel:

```bash
# On the hub
origin serve --host 0.0.0.0 --port 7077 --admin-listen 127.0.0.1:7078

# On your computer, with SSH; then open http://localhost:7078/admin/
ssh -N -L 7078:127.0.0.1:7078 you@hub-host

# Or, with Kubernetes; then open http://localhost:7078/admin/
kubectl port-forward deploy/origin-hub 7078:7078
```

Over a loopback address the UI works on plain HTTP, with a session cookie restricted to `/admin`. With Docker, you can instead publish the hub's port on loopback only, and declare that address as the public URL:

```bash
docker run -d --name origin-hub -p 127.0.0.1:7077:7077 -v origin-data:/data \
  -e ORIGIN_ADMIN=on -e ORIGIN_PUBLIC_URL=http://localhost:7077 \
  ghcr.io/openlinkos/origin
```

## Security

- **Your data stays put.** The admin UI loads nothing from other sites and makes no requests of its own beyond the hub. It reads and writes through the same operations as the CLI and MCP, so provenance and recorded forgetting hold.
- **What it never does.** It cannot edit or delete events, raw mirrors, entries, or tombstones, and shows the text of forgotten content only on the page of the forget that hides it: lists show a tombstone's target id, its reason, and counts, and the audit log keeps ids and counts only. A restore adds a record; it deletes nothing. It cannot show a token again, change the admin password, or change its own security settings. Those stay on the hub's command line.
- **The password.** The hub stores only a scrypt hash of it (N = 2^15, r = 8, p = 3, with a random salt), checks one attempt at a time, and compares in constant time.
- **Requests.** Every change is a form submission that must carry the session's anti-forgery token and come from the hub's own address; cross-site requests are refused. After 10 failed sign-ins from one client within 10 minutes (100 from all clients), sign-in pauses and the UI says when to retry. Behind a proxy or CDN, this needs `ORIGIN_CLIENT_IP_HEADER` (see [Behind TLS and a CDN](#behind-tls-and-a-cdn)).
- **Pages.** Everything shown is escaped, so a session log that contains HTML or script is displayed as text. The agent's replies are formatted on the server from a small part of Markdown (paragraphs, headings, emphasis, code, lists, quotes, tables, and links), never from HTML in them; a link opens only an `http` or `https` address, in a new tab, and shows that address next to its text. Every response forbids inline scripts, framing, caching, and indexing.
- **Audit log.** Sign-ins, failed attempts, token changes, entries written, forgets and restores, and ended sessions are recorded with the time, the client address, and the browser's user agent. Token and password changes made with the CLI, and passwords the hub generates or finds changed when it starts, are recorded too, but never the password itself. The log can only grow; read it in the UI or with `origin admin audit`.

Report security problems privately, as described in the [security policy](https://github.com/openlinkos/origin/blob/master/SECURITY.md).
