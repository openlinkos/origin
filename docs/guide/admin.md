# Admin UI

A [personal hub](./hub.md) can serve a web interface for you, its owner. From a browser you can see what your devices have pushed, browse and search your sessions, curate entries, review what agents proposed, forget what should not be kept, purge what must go for good, and manage your devices and agents, approving those that sign in through you. The admin UI is off by default. It is for one person: there are no public pages, no sharing, and no other accounts. The hub's own [landing page](./hub.md#the-landing-page) at `/` is public but shows nothing from your store; when the admin UI is at `/admin`, its **Sign in** button leads here. You can also open it on your own machine, for the store there, without a hub: see [On your own machine](#on-your-own-machine).

## What you can do

- **Overview**: a strip of figures, each with the last 30 days under it: events and sessions with a line of each day, entries split by kind, recalls with how many the session went on to use, and on a hub, devices; a chart of events per day by agent, with its numbers in a table; recalls by occasion, with how many were used, the share used, and the items and tokens of an average recall; your recent sessions and most active projects; each agent with its latest version, when its sessions were last archived, and its parse errors in the last 7 days; on a device, its hub and when it last synced; parse errors in the last 24 hours and 7 days, the version, and the uptime; storage: the database, the raw mirrors on disk, and, on a hub that keeps them in a bucket, the frames there, and free disk space; on a hub, each device with the last time it sent data (flagged after 24 hours); the latest entries, the latest forgets and restores, and the latest purges.
- **Devices and agents**: your devices, each with its token and when it last sent data, linked to the files it pushed; your agents with a token, each *read and write* or *read only*; and the agents signed in with OAuth, such as Claude Code or Codex, with what each may do and until when. Revoke any of them. **Add an agent** creates a token for a program that cannot open a browser, such as a bot or a CI job, and shows it once with ready-to-paste commands for Claude Code, Codex, and appending event lines. The **Connect** page has the commands to connect a new device or agent.
- **Approving agents and devices**: when Claude Code, Codex, or another MCP client signs in to the hub, your browser opens the hub's page "*Claude Code* wants to use your Origin memory", which says where your browser returns afterwards, and warns when that is an address on your own computer, which any program there could be listening on. Choose what the agent may do and for how long (1, 30, 90, or 365 days), and allow or deny it. When a device runs `origin hub connect`, open the link it prints, or **/admin/activate** and its code, and approve "Connect device *laptop* to your hub?"; the page says when and from which address the device asked, and whether a device of that name is connected already, whose token approving would replace.
- **Sessions**: every top-level session, most recently active first, with its agent, project, turns, events, duration, and recalls. A child is nested under its parent and takes no row of its own; the name you see is the display title, and the stored title stays as the agent wrote it (see [Parent sessions](../architecture.md#parent-sessions)). Filters on the left narrow the list by agent, by project, to sessions that were handed something, or to those with or without a title, each with how many sessions it would leave; above the list, filter by words in the name, pick a time range (today, 7 days, 30 days, or all), and sort by the latest activity, the most events, or the longest. A histogram above shows the sessions of the last 30 days by agent. A session without a title is named by its first prompt, in italics, and a session in a [thread](./concepts.md#threads) shows the thread's id under its name. Days follow the time zone of the machine that serves the UI; for a hub in a container, set `TZ`, such as `TZ=Asia/Shanghai`.
- **Threads**: a session in a thread says so at the top of its page, "In thread", with the thread's name and how many other sessions it has. The thread's page lists its sessions, oldest first, with their agents, the work branches they were on, the entries written from them, and its last prompt, each linked to its page.
- **A session as a trace**: a session's page lists its turns on the left: a turn starts at a prompt you typed, or at a command such as `/review` that the agent then acted on, and holds everything until the next one. Each row shows the prompt, how many tools the agent called and how many failed, a dot when the agent was handed something, and how long the turn took; filter the list to turns with recalls or with failed calls. The turn shown, by default the latest, opens into its steps: its prompt, its recalls, the calls of each tool, and its reply, each placed where it falls in the turn. On the right is that turn in full: your prompt (or the command), what recall handed over, the agent's tool calls folded into one line (how many calls of which tools, and how many failed), and the agent's last reply, formatted as Markdown. Open the line for one row per call: what it was about (the file, command, pattern, or URL), whether it succeeded, and its input and result on request; what the agent said on the way appears among them. Commands the agent did not act on, such as `/clear` or `/model`, their output, and context the agent injected appear as small notes. A message you did not write, such as a teammate's in a chat, a sub-agent's prompt, or the summary a compaction writes, starts no turn: it appears in the turn it falls in, with a small label of who wrote it (see [Who wrote it](./sources.md#who-wrote-it)). Every item links to its event, and so to its provenance. A turn too long for one page is shown in parts.
- **Events** with their provenance: the device, the original file, the generation, and the mirror line. The original raw line is shown only when you ask for it, shortened to 4,000 characters.
- **Search** across entries and events.
- **Entries**: every current entry, newest first, filtered on the left by kind, project, author, whether it was imported or remembered, and whether it was ever handed to an agent; above the list, by words or an id, by when it was written, and with older versions too. An entry's page shows its text, the events it cites, its versions (where each was written, and which lost to a concurrent correction), and the recalls that handed it over. **Correct** an entry (a new version replaces it; the old one stays in the history), and **remember** a new entry from an event page, citing that event. Entries you write are recorded with the author `user@hub` (`user@` and the hub's name), as `origin correct` records `user@` and the device's name. Entries imported from the memory files agents keep for themselves can be told apart by a filter, and an entry whose validity has ended, such as an imported memory whose file was deleted, appears with the older versions.
- **Recalls**: what your agents were handed without asking (see [Recall](./recall.md)), filtered by agent, occasion, device, time, and whether anything was handed over, with a histogram of the last 30 days. A recall's page shows the text the agent was handed, rebuilt from the store as it is now (an item forgotten since is left out, and counted), how its budget was spent, each item with its layer, score, and size and whether the session used it, and the other recalls of the session. An entry's page lists the recalls that handed it over, and a session's trace shows each recall in its turn. A hub's admin UI shows every device's.
- **Proposals**: the entries agents proposed for you to review (see [Proposals](./concepts.md#proposals)), those that wait for you first, with how many in the sidebar and on the overview; filter them by status and project. A proposal's page shows its text, kind, confidence, and the agent's note, the events it cites with their quotes, and the session that made it. **Accept** writes its entry, as you, citing those events and the proposal itself, and opens the entry; **Reject**, with a reason, forgets the proposal as a record, and opens that record on the Forgotten page, where restoring it makes it pending again. Rejected proposals are listed by id and reason only.
- **Forget** an entry or an event: the UI first shows exactly which entries and events will be hidden, and you confirm once, with a reason. Forgetting works as everywhere else (see [Privacy and your data](./privacy.md#forgetting)) and reaches every device on its next sync.
- **Forgotten**: every forget and restore, with its time, where it was made, who made it, its reason, and what it covers. A forget's own page shows you what it hides, the entries' text and the session events, which appear nowhere else; **Restore** there brings it back, after saying what will come back and asking for a reason.
- **Purge** what must not be kept at all, from **Purge…** on the page of an event, a session, an entry, or a forget: the UI first shows, by id and count, everything that will be deleted for good, and you confirm with a reason (see [Purging](#purging)). **Purges**, on the Forgotten page, lists every purge with its record, and a forget that a purge touched says so.
- The **audit log**, and your open **sign-ins**.

The admin UI is available in English and Simplified Chinese, following your browser's language, and follows your system's light or dark mode. Both can be switched in the **Preferences** menu at the foot of the sidebar, which also signs you out, or below the form on the sign-in page.

Origin is open source, and the UI says so: the foot of every page shows Origin's version, with links to this documentation, the source code on GitHub, and the forms to report an issue, and the sign-in page has a line under its form with the documentation and the source. `ORIGIN_POWERED_BY=off`, which leaves the credit to Origin off the hub's landing page, does not remove them.

It adapts to the width of the window rather than squeezing a page. On a narrower window, between 860 and 1200 pixels, the sidebar becomes a column of icons, each named on hover, and the search field becomes a button. On a phone or a window narrower than that, the sidebar opens from the menu button at the top left. Where a page has no room beside its content, a list's filters open from a **Filters** button, with the filters that are on shown above the list as tags that remove them; a session's turns open from the button that says which turn is shown; and the details of a recall or an entry follow its content. Wide tables become rows that name each value, so nothing scrolls sideways and no column is left out.

## On your own machine

On any machine where Origin archives your sessions, `origin ui` serves the admin UI for that machine's own store (`~/.origin`, or `$ORIGIN_HOME`). No hub is needed:

```bash
origin ui                 # opens http://127.0.0.1:7079/admin/ in your browser
origin ui --port 7080     # on another port
origin ui --no-open       # only print the sign-in link
```

There is no password. When it starts, `origin ui` prints a sign-in link and opens it in your default browser. The link works once, within 5 minutes, and keeps that browser signed in until you stop `origin ui` with Ctrl+C, for at most 12 hours. For a new link, for example to sign in from another browser, press Enter in the terminal where `origin ui` runs, or start it again; the previous link stops working, whether it was used or not.

It has the pages above, except those that only make sense on a hub: devices and agents, approving them, connection commands, and sign-ins. Remembering, correcting, forgetting, restoring, and purging work as on a hub, without a password, and the audit log records them with the actor `local`. It shows what the store holds: agents that use Origin archive their sessions as they go, and when it starts, `origin ui` brings in the rest in the background, as `origin sync --local` does, while you browse. If the machine is connected to a hub, the overview shows the hub and when the machine last synced with it; what you change is sent to the hub in the background right away, or with the next sync if the hub cannot be reached.

`origin ui` listens only on `127.0.0.1`, and answers only to `127.0.0.1` and `localhost` on its own port. To use it on a machine you reach over SSH, forward the same port number, then open the link it prints:

```bash
ssh -L 7079:127.0.0.1:7079 you@workstation   # then, on the workstation: origin ui --no-open
```

## Purging

Forgetting hides; a purge deletes. Purge what should not be kept anywhere, such as a secret pasted into a prompt, or a session of test data: open the event, the session, the entry, or the forget whose hidden content should go, and choose **Purge…**.

The preview lists, by id and count and never as text, everything the purge deletes from this store: the events, with every other event read from the same raw lines; the entries, every version of each, and every entry that cites a purged event; the sessions, with their child sessions; the recalls and the items of recalls that name what goes; and the lines of the raw mirrors, which are blanked in place. It names the forgets that will cover less, warns about what the rules add, and says what a purge does not reach: backups made before it, old object versions in a bucket, stores it has not reached yet, the agents' own files, and on PostgreSQL the write-ahead log. To purge, give a reason, type `purge`, and on a hub, enter your password again if you have not in the last 10 minutes. If the store has changed since the preview so that the purge would delete something else, nothing is deleted and the preview is shown again as it is now.

What a purge deletes is gone for good: no restore brings it back, and syncing an agent's file again or a device sending it again does not either. Each purge is kept as a record under **Purges**: who made it, when, why, what it selected, and counts, never what it deleted. A hub's purge reaches your devices when they next sync. A purge on `origin ui` stays on that device, and the hub keeps its copy: the preview links to the same purge on the hub.

The admin UI's JSON API does the same, for scripts that sign in as you: `POST /admin/api/login` with your username and password, then send the session cookie, the `csrf` it returns as the `X-CSRF-Token` header, and an `Origin` header with the hub's address. `GET /admin/api/purge-plan` takes the preview's query (`?event=<id>`, `?session=<source>:<session-id>`, `?entry=<id>`, `?forgotten=<tmb-id>` or `?forgotten=all`) and returns the plan with its `digest`; `POST /admin/api/purge` with `{ "selector", "digest", "reason" }`, the selector as the plan returned it, purges, within 10 minutes of the password (`POST /admin/api/reauth` enters it again), or answers 409 if the plan has changed. Device, agent, and OAuth tokens never reach these routes, and neither MCP nor the OpenClaw plugin can purge.

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

A hub has one owner, you, and you sign in with your username and the hub's admin password. The admin UI has no setup page, so a new hub cannot be claimed by whoever reaches it first: the only thing chosen at the first visit is your username, and that needs the password. The first time the hub starts with the admin UI enabled, it generates a password and prints it to its log, this once only:

```text
Generated an admin password for the admin UI (shown only this once):

    abcde-fghjk-mnpqr-stvwx

Sign in with it, then set your own with: origin admin password
```

With Docker, read it with `docker logs origin-hub`. Open `https://hub.example.com/admin/`, choose your username, and sign in with that password; from then on, you sign in with both. The username has 2 to 32 lowercase letters, digits, `-`, `_`, or `.`. Then choose your own password on the hub:

```bash
origin admin password                               # asks twice, without showing what you type
docker exec -it origin-hub origin admin password    # the same, with Docker
origin admin password --generate                    # or pick a random one, printed once
origin admin username dana                          # change your username; without a name, show it
```

On a hub upgraded from a version without usernames, the first sign-in asks for your username too, with the password you already have, and the sessions you had sign in again; nothing else changes.

The password needs at least 10 characters. A new password replaces the old one at once and signs out every session; nothing needs restarting. Run the same command if you lose the password. Without a terminal, the command reads the password from the first line of its standard input, so scripts can pipe it in, for example `docker exec -i origin-hub origin admin password < password.txt`. Your browser's password manager can save the username and password together.

To keep the password in your deployment's configuration instead, such as a Docker Compose file or a Kubernetes Secret, set `ORIGIN_ADMIN_PASSWORD`. When it is set, it is the password, and the stored one is ignored. It must have at least 10 characters, or the hub refuses to start. To change it, restart the hub with the new value: the hub notices the change and signs out every session. `origin admin password` warns you when it sees this variable, since a password it stores has no effect while the variable is set.

The hub keeps the password only as a scrypt hash in its own database, and never sends it to devices. The admin password and the credentials of devices and agents are separate: a token (`ogn_…`) never signs in to the admin UI, and the admin password never works for MCP or for pushing. Agents and devices that sign in through you get credentials of their own, which you can revoke on Devices and agents.

```bash
origin admin sessions               # open sessions: sign-in time, last activity, client
origin admin sessions --revoke-all  # sign out everywhere
origin admin audit --limit 50       # recent administrative actions
```

A session ends after 30 minutes without activity or 12 hours after you signed in. Adding or revoking a device or an agent, allowing an agent or approving a device, signing out other sessions, and purging ask for the password again if you have not entered it in the last 10 minutes. Forgetting and restoring do not: each can be undone by the other.

## Behind TLS and a CDN

If you reach the admin UI through the same reverse proxy or CDN as the hub, configure it as for the hub (see [Put it behind TLS](./hub.md#put-it-behind-tls)), and also:

- Forward `/admin` and `/admin/*` to the hub unchanged: no path rewriting, and keep the `Host`, `Origin`, and `Cookie` request headers and the `Set-Cookie` response header. Forward the paths through which agents and devices sign in too: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, and `/oauth/*`.
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

Over a loopback address the UI works on plain HTTP, with a session cookie restricted to `/admin`. On a separate listener, the admin UI is not where agents and devices can reach it, so they cannot sign in through you: give them tokens instead (see [Devices and agents](./hub.md#devices-and-agents)). With Docker, you can instead publish the hub's port on loopback only, and declare that address as the public URL:

```bash
docker run -d --name origin-hub -p 127.0.0.1:7077:7077 -v origin-data:/data \
  -e ORIGIN_ADMIN=on -e ORIGIN_PUBLIC_URL=http://localhost:7077 \
  ghcr.io/openlinkos/origin
```

## Security

- **Your data stays put.** The admin UI loads nothing from other sites and makes no requests of its own beyond the hub. It reads and writes through the same operations as the CLI and MCP, so provenance and recorded forgetting hold.
- **What it never does.** It cannot edit events, raw mirrors, entries, or tombstones. The one thing it deletes is what you purge, and only after it has shown you, as ids and counts and never as text, what will go; you give a reason and, on a hub, your password within the last 10 minutes. A purge keeps a record (who, when, why, and counts) that is never deleted. It shows the text of forgotten content only on the page of the forget that hides it: lists show a tombstone's target id, its reason, and counts, and the audit log keeps ids and counts only. A restore adds a record; it deletes nothing. Accepting a proposal writes an entry, and rejecting one is a forget, as everywhere else. It cannot show a token again, change the admin password or your username once chosen, or change its own security settings. Those stay on the hub's command line.
- **The password.** The hub stores only a scrypt hash of it (N = 2^15, r = 8, p = 3, with a random salt), checks one attempt at a time, and compares in constant time.
- **Agents and devices signing in.** An agent signs in with OAuth as the MCP specification describes: with PKCE, to the hub's own MCP endpoint only, and only once you allow it. An authorization code works once, within a minute; the agent's access token lasts an hour, and each refresh token works once, so a refresh token used twice, which means it was copied, revokes the agent at once. An agent that describes itself by a document at its own address is fetched only over https and only from public addresses. A device's code is approved only by you, signed in, and works for 10 minutes. Every agent and device can be revoked, and only hashes of their credentials are stored.
- **Requests.** Every change is a form submission that must carry the session's anti-forgery token and come from the hub's own address; cross-site requests are refused. After 10 failed sign-ins from one client within 10 minutes (100 from all clients), sign-in pauses and the UI says when to retry. Behind a proxy or CDN, this needs `ORIGIN_CLIENT_IP_HEADER` (see [Behind TLS and a CDN](#behind-tls-and-a-cdn)).
- **Pages.** Everything shown is escaped, so a session log that contains HTML or script is displayed as text. The agent's replies are formatted on the server from a small part of Markdown (paragraphs, headings, emphasis, code, lists, quotes, tables, and links), never from HTML in them; a link opens only an `http` or `https` address, in a new tab, and shows that address next to its text. Every response forbids inline scripts, framing, caching, and indexing.
- **Audit log.** Sign-ins, failed attempts, the username you chose, token changes, agents allowed and denied, devices approved and denied, agents revoked, entries written, proposals accepted and rejected, forgets and restores, purges, and ended sessions are recorded under your username, with the time, the client address, and the browser's user agent. Token, username, and password changes made with the CLI, and passwords the hub generates or finds changed when it starts, are recorded too, but never the password itself; so is what agents and devices do to their own access through the hub, under `<username> / <agent>` or the device's name: an agent signing out, an agent revoked because a token of it was used twice, a device receiving its token. The log can only grow; read it in the UI or with `origin admin audit`.

Report security problems privately, as described in the [security policy](https://github.com/openlinkos/origin/blob/master/SECURITY.md).
