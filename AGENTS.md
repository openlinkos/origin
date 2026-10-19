# AGENTS.md

Instructions for AI coding agents working in this repository. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md` only. On Windows checkouts without symlink support, `CLAUDE.md` appears as a 9-byte text file containing `AGENTS.md`. Do not edit it.

## Project

Origin is a local-first, cross-agent personal memory for AI coding agents. It archives local agent session logs into an append-only SQLite store, provides search, a timeline, and provenance through the `origin` CLI, and will expose the store to agents through an MCP server.

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
```

When running the CLI, always point `ORIGIN_HOME` at a fresh temporary directory.

## Rules

- **Preserve the invariants** in `docs/architecture.md`: provenance, sticky forgetting, append-only storage, local-first data, and a single entry point. Changes that touch them need tests.
- **No network and no model calls** in `core` or `adapters`.
- **Keep adapters deterministic and tolerant**: pure parsing, stable event ids, the agent version recorded, and parse errors counted rather than fatal.
- **No migrations before the first release.** Edit the schema in `packages/core/src/schema.ts` in place; do not add schema versions or migration code.
- **Respect dependency direction**: `core` depends on no workspace package; `adapters` and `mcp` depend only on `core`.
- **Ask before adding runtime dependencies.** Pin dev dependencies to exact versions.
- **Keep design and code in step.** If a change alters the data model, an invariant, or a public interface, update `docs/architecture.md` in the same commit. If code and the design document disagree, raise it rather than silently picking one.
- **Use English** for code, comments, docs, CLI output, and commit messages. Keep `README.zh-CN.md` in sync with `README.md`.
- **Only product docs belong in the repo.** Do not add discussion transcripts, iteration logs, or personal notes.

## Privacy

- Never commit real session logs, the contents of `~/.origin`, secrets, tokens, or `.env` files.
- Test fixtures must be synthetic or thoroughly scrubbed (names, paths, repository URLs, prompts, outputs).

## Git

- Maintainers commit directly to `master`. External contributions come in through pull requests.
- Run `pnpm lint` and `pnpm test` before every commit, then commit and push once a change is complete and verified.
- Use Conventional Commits in English: `<type>(<scope>): <summary>`, where type is one of `feat | fix | docs | refactor | test | perf | build | ci | chore` and scope is a package name.
- Do not add attribution trailers such as `Co-Authored-By`. The project's `.claude/settings.json` blanks Claude Code's commit and PR attribution to enforce this.
