# AGENTS.md

Instructions for AI coding agents working in this repository. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md` only. On Windows checkouts without symlink support, `CLAUDE.md` appears as a 9-byte text file containing `AGENTS.md`. Do not edit it.

## Project

Origin is a local-first, cross-agent personal memory for AI coding agents. It archives agent session logs into an append-only SQLite store and serves search, timelines, provenance, and durable entries to agents over MCP and to people through the `origin` CLI. An optional self-hosted personal hub (`origin serve`) gathers several devices into one store, and can serve an admin UI to its owner; it is single-tenant by design.

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

## Rules

- **Preserve the invariants** in `docs/architecture.md`: provenance, recorded forgetting, append-only storage, local-first data, and a single entry point. Changes that touch them need tests.
- **No network and no model calls** in `core` or `adapters`.
- **Keep adapters deterministic and tolerant**: pure parsing, stable event ids, the agent version recorded, and parse errors counted rather than fatal.
- **Migrate the store format; never ask for a fresh `ORIGIN_HOME`.** `packages/core/src/schema.ts` is the latest format, and its idempotent statements run on every open. A new table, index, view, or trigger that existing data needs nothing from goes there alone; any other change (a column, a constraint, a changed trigger or view, rows to fill in, mirrored lines to parse again) also needs a migration with the next version in `packages/core/src/migrations.ts`, so that an upgraded store ends up the same as a new one. A released migration is never changed. Test each migration on a store of the version before it (see "Migrations" in `docs/architecture.md`).
- **Respect dependency direction**: `core` depends on no workspace package; `adapters`, `mcp`, and `admin` depend only on `core`; only `cli` brings them together.
- **Ask before adding runtime dependencies.** `core`, `adapters`, and `admin` use only Node built-ins; `mcp` uses the MCP SDK and zod. Pin all dependencies to exact versions.
- **Keep the admin UI conservative.** `packages/admin` renders every page on the server with the escaping `html` template (`raw()` only for static markup written in the package), uses no inline scripts or styles, loads nothing from third parties, and writes only through core operations. Never add routes that edit or delete events, mirrors, entries, or tombstones, re-show a token, or change the admin password. Forgotten text is shown only to the owner, on a forget's own page in the Forgotten view, and the only way to bring it back is a restore with a reason, which adds a tombstone through core. The write routes are pinned by a test; change that snapshot only deliberately.
- **Keep design and code in step.** If a change alters the data model, an invariant, or a public interface, update `docs/architecture.md` (and `docs/zh/architecture.md`) in the same commit. If code and the design document disagree, raise it rather than silently picking one.
- **Use English** for code, comments, CLI output, and commit messages. Keep `README.zh-CN.md` in sync with `README.md`.
- **The documentation site is bilingual; English is the source of truth.** Every page in `docs/` has a Simplified Chinese counterpart at the same path under `docs/zh/` with the same headings in the same order (each h2/h3 with an explicit `{#id}` anchor equal to the id of the English heading), the same code blocks, links that stay inside the Chinese site (relative `.md` links to `docs/zh/` pages, absolute links under `/zh/`), and a `sourceHash` frontmatter field: `sha256-` plus the first 8 hex characters of the SHA-256 of the English file, with CRLF normalized to LF (see CONTRIBUTING.md for a one-liner). Update the Chinese page and its `sourceHash` in the same commit as the English change. English pages never link into `/zh/`. `pnpm docs:build` enforces all of this through `@openlinkos/vitepress-theme` and fails on any gap.
- **Only product docs belong in the repo.** Do not add discussion transcripts, iteration logs, or personal notes.
- **`docs/` is the website** (origin.openlinkos.com). The site image is built and published to GHCR by `.github/workflows/site.yml`; server and deployment configuration does not belong in this repo.

## Privacy

- Never commit real session logs, the contents of `~/.origin`, secrets, tokens, or `.env` files.
- Test fixtures must be synthetic or thoroughly scrubbed (names, paths, repository URLs, prompts, outputs).

## Releases

The five packages share one version and are published to npm by `.github/workflows/release.yml`; the same tag adds the version, minor-version, and `latest` tags to the `ghcr.io/openlinkos/origin` image (`edge` follows `master`). To release, add the version's section to `CHANGELOG.md` (it becomes the GitHub release notes and is included in the site's changelog page), translate it in `docs/zh/changelog.md` with the same headings, add the version's store format to the table in `docs/guide/upgrading.md` (and its Chinese page) if it changed, bump `version` in every `packages/*/package.json` (the site's navigation shows it), commit, then tag `v<version>` and push the tag. A maintainer approves the run in the `npm` environment; npm trusted publishing attaches provenance. Never publish from a workstation. A change to the store format needs a migration (see Rules), not a fresh `ORIGIN_HOME`.

## Git

- Maintainers commit directly to `master`. External contributions come in through pull requests.
- Run `pnpm lint` and `pnpm test` (and `pnpm docs:build` when `docs/` changes) before every commit, then commit and push once a change is complete and verified.
- Use Conventional Commits in English: `<type>(<scope>): <summary>`, where type is one of `feat | fix | docs | refactor | test | perf | build | ci | chore` and scope is a package name.
- Do not add attribution trailers such as `Co-Authored-By`. The project's `.claude/settings.json` blanks Claude Code's commit and PR attribution to enforce this.
