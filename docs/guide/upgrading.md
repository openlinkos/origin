# Upgrading

Origin is released as one version across its five npm packages and the hub's container image. This page explains what a version promises, how to upgrade a device and a hub, and what happens to your store when you do. What changed in each release is in the [changelog](../changelog.md).

## Versions

Origin follows [Semantic Versioning](https://semver.org). Before 1.0:

- A **minor** version (0.2, 0.3, …) may change the store format, the CLI, the MCP tools, or the hub's API. Its changelog section starts with an **Upgrading** note that says what to do, if anything.
- A **patch** version (0.3.1, …) only fixes bugs, and never changes the store format.
- `@openlinkos/origin` is the package to install; it brings the other four (`-core`, `-adapters`, `-mcp`, `-admin`) at the same version. Their APIs are internal until 1.0 and may change in any release.

Every release is built and published by GitHub Actions from a tag, never from a workstation, with npm provenance, and with provenance and SBOM attestations on the images (see [Verify a release](#verify-a-release)).

To see the version you run:

```bash
origin --version
curl -s https://hub.example.com/healthz     # a hub: {"ok":true,"version":"…"}
```

## Upgrade a device

```bash
npm install -g @openlinkos/origin@latest
origin --version
origin status          # opens the store, upgrading it if needed
```

Then restart your agents, or their sessions, so that each one starts the new `origin mcp`. An `origin mcp` already running keeps the version it started with until its agent restarts.

Origin needs Node.js 22.16 or later; a release may raise that minimum, and says so in its upgrading note.

## Upgrade a hub

The hub's image is `ghcr.io/openlinkos/origin`, with these tags:

| Tag | Points to |
|---|---|
| `0.3.0` | That release, unchanged |
| `0.3` | The latest patch release of 0.3 |
| `latest` | The latest release |
| `edge` | The latest commit on `master`, unreleased |

Pin a minor version, such as `0.3`, and change it when you choose to upgrade; `latest` moves to a new minor version, which may upgrade your store, as soon as it is released. To upgrade a hub run with Docker:

```bash
docker pull ghcr.io/openlinkos/origin:0.3
docker rm -f origin-hub
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin:0.3
docker logs origin-hub     # shows the upgrade of the store, if any
```

Keep the same `/data` volume and the same environment (admin UI, bucket, client IP header). A hub installed with npm upgrades like a device; restart `origin serve` afterwards.

**Upgrade the hub before its devices.** A newer device may send what an older hub cannot read yet, such as the memory streams added in 0.3: the hub keeps them, and reads them once it is upgraded, but meanwhile corrections of what it has not read wait for it. A hub of a newer version serves devices of an older one without trouble.

## Your store

A store records the version of its format. When a newer Origin opens an older store, it upgrades it in place, once, before anything else; the first command after an upgrade, or the hub as it starts, prints what it does. Each step runs in a transaction of its own, so an interrupted upgrade is safe to run again. Upgrades never rewrite raw mirrors or events, and never bring back what you forgot.

| Release | Store format | What the upgrade does |
|---|---|---|
| 0.1.0 | 1 | — |
| 0.2.0 | 3 | Records the format version; adds whether the user named a session; reads the titles of Claude Code sessions from the lines already archived |
| 0.3.0 | 4 | Reads the memory streams a hub archived before it could (see [Native memories](../sources.md#native-memories)) |

Formats 2 and 3 were both introduced by 0.2.0. The details of each step are in [Architecture](../architecture.md#migrations).

- **Back up first.** An upgrade is careful, but a backup costs one command: `origin backup <dir>` (see [Backing up](./privacy.md#backing-up)). On a hub, run it inside the container before you replace it, for example `docker exec origin-hub origin backup /data/backup-0.2`.
- **There is no downgrade.** An Origin that finds a store of a newer format refuses to open it and says to upgrade, without changing anything. To go back to an older version, restore the backup you made before upgrading; what was written since is lost.
- **Several processes.** If several processes open the store at once, such as the CLI and the MCP servers of several agents, one of them runs the upgrade and the others wait for it, up to five minutes.

## Verify a release

The npm packages carry provenance that ties each one to the GitHub Actions run that built it:

```bash
npm audit signatures            # in a project that depends on @openlinkos/origin
npm view @openlinkos/origin@0.3.0 dist.attestations
```

The images are built with provenance and an SBOM, both attached to the image:

```bash
docker buildx imagetools inspect ghcr.io/openlinkos/origin:0.3.0 --format '{{json .Provenance}}'
```

Each release also has a page on [GitHub](https://github.com/openlinkos/origin/releases), with the notes from the changelog.
