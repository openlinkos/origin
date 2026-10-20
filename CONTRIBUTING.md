# Contributing to Origin

Thanks for your interest in Origin! This guide covers the development setup, the project's conventions, and how to add support for a new agent.

## Ways to contribute

- **Report a bug or request a feature** by [opening an issue](https://github.com/openlinkos/origin/issues). Include your OS, Node.js version, the agent and agent version involved, and the exact command you ran.
- **Add a source adapter** for an agent that is not supported yet (see [below](#adding-a-source-adapter)).
- **Improve the documentation**, especially [docs/sources.md](docs/sources.md) when an agent changes its on-disk format.

For security or privacy problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requirements: Node.js 22.13 or later (24 LTS recommended) and pnpm. Run `corepack enable` to use the pnpm version pinned in `package.json`.

```bash
git clone https://github.com/openlinkos/origin.git
cd origin
pnpm install
pnpm build
pnpm test
```

| Script | What it does |
|---|---|
| `pnpm build` | Type-check and compile all packages (`tsc -b`) |
| `pnpm test` | Run the Vitest suite. Tests import package sources directly, so no build is needed first |
| `pnpm lint` | Lint and format-check with Biome |
| `pnpm lint:fix` | Apply Biome fixes and formatting |
| `pnpm clean` | Remove build output |
| `pnpm origin <cmd>` | Run the built CLI |

Always test against a fresh, temporary data directory, never your real `~/.origin`. Before the first release the database schema is edited in place without migrations, so an old data directory may not match the current code:

```bash
ORIGIN_HOME=/tmp/origin-dev ORIGIN_CLAUDE_PROJECTS=packages/adapters/test/fixtures/claude-code pnpm origin sync
```

## Project structure

| Package | Responsibility |
|---|---|
| `packages/core` | Storage, ingestion, entries, forgetting, queries. Depends on no other workspace package |
| `packages/adapters` | One deterministic parser per agent. Depends only on `core` |
| `packages/mcp` | MCP server over stdio. Depends only on `core` (ingestion is injected by the CLI) |
| `packages/cli` | The `origin` command, including `origin mcp` |

[docs/architecture.md](docs/architecture.md) explains the data model and the five invariants that every change must preserve.

## Conventions

- **TypeScript:** strict mode, ESM, `NodeNext` module resolution. Import relative files with the `.js` extension.
- **Formatting:** Biome (2-space indent, single quotes, semicolons, trailing commas, 100-column lines). Run `pnpm lint:fix` before committing.
- **Dependencies:** `core` and `adapters` use only Node built-ins; `mcp` depends on the MCP TypeScript SDK and zod. Open an issue before adding a runtime dependency. Pin all dependencies to exact versions, and reference workspace packages as `workspace:*`.
- **No network, no LLM in the core.** `core` and `adapters` must not make network calls or call model APIs.
- **Language:** code, comments, docs, and commit messages are in English. `README.zh-CN.md` is a translation of `README.md`; if you change one, update the other or mention it in your pull request so a maintainer can.
- **Docs follow code:** if a change affects the data model, an invariant, or a public interface, update `docs/architecture.md` in the same pull request. Put user-visible changes in the README, and agent format findings in `docs/sources.md`.

## Tests and fixtures

- Tests live in `packages/<name>/test/*.test.ts` and run with Vitest.
- Adapter parsing and the invariants (provenance, sticky forgetting, append-only, idempotent sync) must be covered by tests. MCP tools are tested end to end with an in-memory MCP client (`packages/mcp/test`).
- **Fixtures must be synthetic.** Never commit real session logs, even partial ones. Build fixtures by hand or scrub them thoroughly: replace names, paths, repository URLs, prompts, outputs, tokens, and any other identifying or secret content.

## Adding a source adapter

1. Read the agent's documentation and source (where available), and record the format in `docs/sources.md`, including the version you checked against.
2. Create `packages/adapters/src/<id>.ts` that implements `SourceAdapter` from `@openlinkos/origin-core`:
   - `discover()` lists the files to ingest; it must not fail if the agent is not installed.
   - `parseLine()` is a pure, deterministic function from one raw line to events. It throws on malformed input; the ingester counts the failure and moves on.
   - Event ids must be stable across runs (use the agent's own message ids) so that re-syncing stays idempotent.
   - Report the agent version so that format changes can be traced.
   - If the agent compresses its logs, mark those files with `compression: 'zstd'` in `discover()`; Origin ingests the decompressed content.
3. Register the adapter in `allAdapters()` in `packages/adapters/src/index.ts`.
4. Add a synthetic fixture under `packages/adapters/test/fixtures/<id>/` and tests under `packages/adapters/test/`.
5. Update the supported-agents table in both READMEs.

Sources that are not line-oriented, such as SQLite databases, need a raw locator other than file plus line. Open an issue to discuss the design first.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) in English:

```
<type>(<optional scope>): <imperative summary>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`. Scopes are package names (`core`, `adapters`, `mcp`, `cli`). Examples: `feat(adapters): add Codex rollout parser`, `fix(core): detect truncated source files`.

Do not add tool-generated attribution trailers (such as `Co-Authored-By` lines for AI assistants).

## Pull requests

1. Fork the repository and branch off `master` (`feat/codex-adapter`, `fix/tail-hash`, …).
2. Keep each pull request focused on one change.
3. Make sure `pnpm lint`, `pnpm build`, and `pnpm test` pass. CI runs them on Linux and Windows.
4. Describe what changed and why, and link the related issue.

Maintainers may commit directly to `master` after running the same checks.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
