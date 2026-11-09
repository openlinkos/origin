# AGENTS.md

Instructions for AI coding agents working in this repository. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md` only. On Windows checkouts without symlink support, `CLAUDE.md` appears as a 9-byte text file containing `AGENTS.md`. Do not edit it.

## Project

Origin is a local-first, cross-agent personal memory for AI coding agents. It archives agent session logs into an append-only SQLite store and serves search, timelines, provenance, and durable entries to agents over MCP and to people through the `origin` CLI. An optional self-hosted personal hub (`origin serve`) gathers several devices into one store, and can serve an admin UI to its owner; it is single-tenant by design. A plugin for OpenClaw (`packages/openclaw`) writes the sessions of OpenClaw's agents to Origin as event lines, and gives those agents Origin's read tools, which it forwards to the hub.

Read these before making non-trivial changes:

- [README.md](README.md): what Origin does and how to use it.
- [docs/architecture.md](docs/architecture.md): the data model, the five invariants, and the ingestion and search design. This is the authoritative design document.
- [docs/sources.md](docs/sources.md): the on-disk session formats of each agent.
- [CONTRIBUTING.md](CONTRIBUTING.md): conventions, tests, and how to add an adapter.

## Commands

```bash
pnpm install
pnpm build        # tsc -b across all packages
pnpm test         # vitest
pnpm lint         # biome check
pnpm lint:fix     # biome check --write
pnpm docs:dev     # documentation site (VitePress) with live reload
pnpm docs:build   # build the site; fails on dead links
```

When running the CLI, always point `ORIGIN_HOME` at a fresh temporary directory.

`pnpm test` runs the suite on SQLite. With `ORIGIN_TEST_DATABASE_URL` set to a PostgreSQL 17+ server (a role that may create databases, such as `postgres://postgres@127.0.0.1:55432/postgres`), it runs it again with every store in PostgreSQL; see "Tests and fixtures" in CONTRIBUTING.md.

## Rules

- **Preserve the invariants** in `docs/architecture.md`: provenance, recorded forgetting, append-only storage, local-first data, and a single entry point. Changes that touch them need tests.
- **No network and no model calls** in `core` or `adapters`.
- **Keep adapters deterministic and tolerant**: pure parsing, stable event ids, the agent version recorded, and parse errors counted rather than fatal.
- **Migrate the store format; never ask for a fresh `ORIGIN_HOME`.** `packages/core/src/schema.ts` is the latest format, and its idempotent statements run on every open. A new table, index, view, or trigger that existing data needs nothing from goes there alone; any other change (a column, a constraint, a changed trigger or view, rows to fill in, mirrored lines to parse again) also needs a migration with the next version in `packages/core/src/migrations.ts`, so that an upgraded store ends up the same as a new one. A released migration is never changed. Test each migration on a store of the version before it (see "Migrations" in `docs/architecture.md`). Every version after `PG_BASE_VERSION` runs on both engines: write its `up` in SQL both accept, with the helpers of `packages/core/src/dialect.ts`, or give it a `postgres` step, and run its test on both (`pnpm test`, then again with `ORIGIN_TEST_DATABASE_URL` set). Change `schema.ts` and `packages/core/src/pg/schema.ts` together; the schema parity test (`packages/cli/test/pg/schema.test.ts`) shows what differs.
- **Two database engines.** A device's store is SQLite; a hub's is SQLite or PostgreSQL 17 or later. Shared code writes SQL that both accept, through the `Database` interface (`packages/core/src/database.ts`). SQL one engine spells differently lives only in `packages/core/src/dialect.ts`, the search drivers (`search-fts5.ts`, `pg/search.ts`), `packages/core/src/pg/`, the migrations, and the client in `packages/cli/src/pg/`. Every transaction that writes is immediate (`BEGIN IMMEDIATE`, `transaction(db, fn, { immediate: true })`). Inside one, never catch a SQL error and carry on, and run nothing after it in a `finally`: PostgreSQL refuses every statement of a transaction after an error, so the cleanup's error would hide the first; let the ROLLBACK undo it, or use a savepoint. Keep U+0000 out of text the store keeps: PostgreSQL's text cannot hold it. Order by a unique key when ties would come out in another order on the other engine. `core` never imports `pg`, the CLI's only database driver, which only the PostgreSQL client's worker (and the tests' global setup) loads.
- **Derived values are computed in TypeScript on PostgreSQL.** `event_cjk` and `event_prompt` hold what `cjkTokens` (`packages/core/src/cjk.ts`) and `promptTitle` return; SQLite computes the same in functions of the connection. A change to what they return for existing text needs a migration that derives them again (and the CJK index on SQLite).
- **Respect dependency direction**: `core` and `openclaw` depend on no workspace package (`openclaw` runs inside OpenClaw and reaches Origin only over HTTP or a source's directory: through the event lines it writes and, for its read tools, the hub's MCP endpoint; its tests may use `adapters` to check the lines, and a test in `cli` checks its tools' parameters against the MCP server's); `adapters`, `mcp`, and `admin` depend only on `core`; only `cli` brings them together.
- **Ask before adding runtime dependencies.** `core`, `adapters`, `admin`, and `openclaw` use only Node built-ins (`openclaw` names OpenClaw only as an optional peer, which is never installed with it); `mcp` uses the MCP SDK and zod. Pin all dependencies to exact versions.
- **Keep the admin UI conservative.** `packages/admin` renders every page on the server with the escaping `html` template (`raw()` only for static markup written in the package), uses no inline scripts or styles, loads nothing from third parties, and writes only through core operations. Never add routes that edit events, mirrors, entries, or tombstones, delete anything except through core's `purge`, re-show a token, or change the admin password. Purge has exactly two write routes, `POST /admin/purge` and `POST /admin/api/purge`, both `fresh` on a hub; each requires a reason and the digest of the preview it confirms, and what the UI shows about a purge is ids and counts, never the content it deletes. Forgotten text is shown only to the owner, on a forget's own page in the Forgotten view, and the only way to bring it back is a restore with a reason, which adds a tombstone through core. The write routes are pinned by a test; change that snapshot only deliberately.
- **Purging is the owner's alone.** Only the CLI (`origin purge`), the admin UI, and its API call core's `planPurge` and `purge`. Never expose them through MCP (a hub's `/mcp` or `origin mcp`), the OpenClaw plugin, or the replication API (`/v1/*` only carries a hub's purges down to its devices), and never let a device's, an agent's, or an OAuth token reach them. Tests pin the MCP tool list and the admin write routes.
- **Keep design and code in step.** If a change alters the data model, an invariant, or a public interface, update `docs/architecture.md` (and `docs/zh/architecture.md`) in the same commit. If code and the design document disagree, raise it rather than silently picking one.
- **Use English** for code, comments, CLI output, and commit messages. Keep `README.zh-CN.md` in sync with `README.md`.
- **The documentation site is bilingual; English is the source of truth.** Every page in `docs/` has a Simplified Chinese counterpart at the same path under `docs/zh/` with the same headings in the same order (each h2/h3 with an explicit `{#id}` anchor equal to the id of the English heading), the same code blocks, links that stay inside the Chinese site (relative `.md` links to `docs/zh/` pages, absolute links under `/zh/`), and a `sourceHash` frontmatter field: `sha256-` plus the first 8 hex characters of the SHA-256 of the English file, with CRLF normalized to LF (see CONTRIBUTING.md for a one-liner). Update the Chinese page and its `sourceHash` in the same commit as the English change. English pages never link into `/zh/`. `pnpm docs:build` enforces all of this through `@openlinkos/vitepress-theme` and fails on any gap.
- **Only product docs belong in the repo.** Do not add discussion transcripts, iteration logs, or personal notes.
- **`docs/` is the website** (origin.openlinkos.com). The site image is built and published to GHCR by `.github/workflows/site.yml`; server and deployment configuration does not belong in this repo.

## Privacy

- Never commit real session logs, the contents of `~/.origin`, secrets, tokens, or `.env` files.
- Test fixtures must be synthetic or thoroughly scrubbed (names, paths, repository URLs, prompts, outputs).

## Releases

The six packages share one version and are published to npm by `.github/workflows/release.yml`; the same tag adds the version, minor-version, and `latest` tags to the `ghcr.io/openlinkos/origin` image (`edge` follows `master`). To release, add the version's section to `CHANGELOG.md` (it becomes the GitHub release notes and is included in the site's changelog page), translate it in `docs/zh/changelog.md` with the same headings, add the version's store format to the table in `docs/guide/upgrading.md` (and its Chinese page) if it changed, bump `version` in every `packages/*/package.json` (the site's navigation shows it), commit, then tag `v<version>` and push the tag. A maintainer approves the run in the `npm` environment; npm trusted publishing attaches provenance. Never publish from a workstation. A change to the store format needs a migration (see Rules), not a fresh `ORIGIN_HOME`.

## Git

- Maintainers commit directly to `master`. External contributions come in through pull requests.
- Run `pnpm lint` and `pnpm test` (and `pnpm docs:build` when `docs/` changes) before every commit, then commit and push once a change is complete and verified.
- Use Conventional Commits in English: `<type>(<scope>): <summary>`, where type is one of `feat | fix | docs | refactor | test | perf | build | ci | chore` and scope is a package name.
- Do not add attribution trailers such as `Co-Authored-By`. The project's `.claude/settings.json` blanks Claude Code's commit and PR attribution to enforce this.
