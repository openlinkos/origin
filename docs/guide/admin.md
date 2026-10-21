# Admin UI

A [personal hub](./hub.md) can serve a web interface for you, its owner. From a browser you can see what your devices have pushed, browse and search your sessions, curate entries, forget what should not be kept, and manage the hub's tokens. The admin UI is off by default. It is for one person: there are no public pages, no sharing, and no other accounts.

## What you can do

- **Overview**: counts of events, sessions, entries, devices, tokens, and tombstones; each device with the last time it sent data (flagged after 24 hours); storage use and free disk space; parse errors in the last 24 hours and 7 days; the version and uptime.
- **Tokens**: create a token for a device or a cloud agent, shown once together with ready-to-paste commands for `origin hub connect`, Claude Code, Codex, and a push schedule; revoke a token.
- **Devices** and the files each one has pushed, and a **Connect** page with the commands to connect a new device or agent.
- **Timeline and sessions**: every session, and the events of one session in order. Tool calls and results are hidden unless you ask for them.
- **Events** with their provenance: the device, the original file, the generation, and the mirror line. The original raw line is shown only when you ask for it, shortened to 4,000 characters.
- **Search** across entries and events.
- **Entries**: browse them with their sources and version history, **correct** an entry (a new version replaces it; the old one stays in the history), and **remember** a new entry from an event page, citing that event. Entries you write are recorded with the author `user`, as with `origin correct`.
- **Forget** an entry or an event: the UI first shows exactly which entries and events will be forgotten, and you confirm by typing the id. Forgetting works as everywhere else (see [Privacy and your data](./privacy.md#forgetting)) and reaches every device on its next push.
- **Tombstones**, the **audit log**, and your open **sign-ins**.

The admin UI is available in English and Simplified Chinese, following your browser's language, with a switch in the header. It follows your system's light or dark mode, also with a switch.

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
| `ORIGIN_CLIENT_IP_HEADER` | A header with the client's address set by your proxy, such as `X-Real-IP`; trusted only when set |
| `ORIGIN_ADMIN_KEY_SHA256` | SHA-256 hashes of admin keys, comma-separated, for configuration kept in Git (see below) |

Command-line flags take precedence over the environment. Use either `/admin` on the hub or a separate listener, not both.

## Sign in

The admin UI has no setup page: a new hub cannot be claimed by whoever reaches it first. Create an admin key on the hub instead:

```bash
origin admin key create me          # prints the key once, starting with oga_
docker exec origin-hub origin admin key create me   # the same, with Docker
```

Open `https://hub.example.com/admin/` and sign in with the key. Keep it in a password manager: the hub stores only its hash and cannot show it again. Admin keys are separate from the tokens of devices and agents. A token (`ogn_…`) never signs in to the admin UI, and an admin key never works for MCP or for pushing.

```bash
origin admin key list
origin admin key revoke me          # also ends every session signed in with it
origin admin sessions               # open sessions: key, sign-in time, client
origin admin sessions --revoke-all  # sign out everywhere
origin admin audit --limit 50       # recent administrative actions
```

To keep the key out of the hub's database, for example when the hub's configuration lives in Git, generate a key yourself and give the hub only its SHA-256 hash:

```bash
KEY="oga_$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
printf %s "$KEY" | sha256sum        # put the hex digest in ORIGIN_ADMIN_KEY_SHA256
```

A session ends after 30 minutes without activity or 12 hours after you signed in. Creating or revoking a token, forgetting, and signing out other sessions ask for your key again if you have not entered it in the last 10 minutes.

## Behind TLS and a CDN

If you reach the admin UI through the same reverse proxy or CDN as the hub, configure it as for the hub (see [Put it behind TLS](./hub.md#put-it-behind-tls)), and also:

- Forward `/admin` and `/admin/*` to the hub unchanged: no path rewriting, and keep the `Host`, `Origin`, and `Cookie` request headers and the `Set-Cookie` response header.
- Bypass the cache for `/admin` and `/admin/*`. The hub marks every response `Cache-Control: no-store, private`, but some CDNs cache by rule regardless.
- Do not inject scripts, rewrite HTML, or add analytics on `/admin*`: the UI's Content-Security-Policy blocks them.
- Pass `--public-url` with the address you open in the browser. Every form submission is checked against it.
- If the proxy sets a header with the real client address, name it in `ORIGIN_CLIENT_IP_HEADER`, so that the sign-in limit and the audit log see real addresses. Only set it if the hub cannot be reached except through that proxy, since anyone else could forge the header.

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

- **Your data stays put.** The admin UI loads nothing from other sites and makes no requests of its own beyond the hub. It reads and writes through the same operations as the CLI and MCP, so provenance and sticky forgetting hold.
- **What it never does.** It cannot edit or delete events, raw mirrors, entries, or tombstones, cannot undo a forget, and never shows the text of anything forgotten: tombstones and the audit log keep only ids and counts. It cannot show a token again, create admin keys, or change its own security settings. Those stay on the hub's command line.
- **Requests.** Every change is a form submission that must carry the session's anti-forgery token and come from the hub's own address; cross-site requests are refused. After 10 failed sign-ins from one client within 10 minutes (100 from all clients), sign-in pauses and the UI says when to retry.
- **Pages.** Everything shown is escaped, so a session log that contains HTML or script is displayed as text. Every response forbids inline scripts, framing, caching, and indexing.
- **Audit log.** Sign-ins, failed attempts, token changes, entries written, forget operations, and ended sessions are recorded with the time, the key name, the client address, and the browser's user agent. Token and admin key changes made with the CLI are recorded too. The log can only grow; read it in the UI or with `origin admin audit`.

Report security problems privately, as described in the [security policy](https://github.com/openlinkos/origin/blob/master/SECURITY.md).
