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

- **Preserve the invariants** in `docs/architecture.md`: provenance, sticky forgetting, append-only storage, local-first data, and a single entry point. Changes that touch them need tests.
- **No network and no model calls** in `core` or `adapters`.
- **Keep adapters deterministic and tolerant**: pure parsing, stable event ids, the agent version recorded, and parse errors counted rather than fatal.
- **No migrations before the first release.** Edit the schema in `packages/core/src/schema.ts` in place; do not add schema versions or migration code.
- **Respect dependency direction**: `core` depends on no workspace package; `adapters`, `mcp`, and `admin` depend only on `core`; only `cli` brings them together.
- **Ask before adding runtime dependencies.** `core`, `adapters`, and `admin` use only Node built-ins; `mcp` uses the MCP SDK and zod. Pin all dependencies to exact versions.
- **Keep the admin UI conservative.** `packages/admin` renders every page on the server with the escaping `html` template (`raw()` only for static markup written in the package), uses no inline scripts or styles, loads nothing from third parties, and writes only through core operations. Never add routes that edit or delete events, mirrors, entries, or tombstones, un-forget, show forgotten text, re-show a token, or create admin keys; the write routes are pinned by a test.
- **Keep design and code in step.** If a change alters the data model, an invariant, or a public interface, update `docs/architecture.md` (and `docs/zh/architecture.md`) in the same commit. If code and the design document disagree, raise it rather than silently picking one.
- **Use English** for code, comments, CLI output, and commit messages. Keep `README.zh-CN.md` in sync with `README.md`.
- **The documentation site is bilingual; English is the source of truth.** Every page in `docs/` has a Simplified Chinese counterpart at the same path under `docs/zh/` with the same headings in the same order (each h2/h3 with an explicit `{#id}` anchor equal to the id of the English heading), the same code blocks, links that stay inside the Chinese site (relative `.md` links to `docs/zh/` pages, absolute links under `/zh/`), and a `sourceHash` frontmatter field: `sha256-` plus the first 8 hex characters of the SHA-256 of the English file, with CRLF normalized to LF (see CONTRIBUTING.md for a one-liner). Update the Chinese page and its `sourceHash` in the same commit as the English change. English pages never link into `/zh/`. `pnpm docs:build` enforces all of this through `@openlinkos/vitepress-theme` and fails on any gap.
- **Only product docs belong in the repo.** Do not add discussion transcripts, iteration logs, or personal notes.
- **`docs/` is the website** (origin.openlinkos.com). The site image is built and published to GHCR by `.github/workflows/site.yml`; server and deployment configuration does not belong in this repo.

## Privacy

- Never commit real session logs, the contents of `~/.origin`, secrets, tokens, or `.env` files.
- Test fixtures must be synthetic or thoroughly scrubbed (names, paths, repository URLs, prompts, outputs).

## Git

- Maintainers commit directly to `master`. External contributions come in through pull requests.
- Run `pnpm lint` and `pnpm test` (and `pnpm docs:build` when `docs/` changes) before every commit, then commit and push once a change is complete and verified.
- Use Conventional Commits in English: `<type>(<scope>): <summary>`, where type is one of `feat | fix | docs | refactor | test | perf | build | ci | chore` and scope is a package name.
- Do not add attribution trailers such as `Co-Authored-By`. The project's `.claude/settings.json` blanks Claude Code's commit and PR attribution to enforce this.
