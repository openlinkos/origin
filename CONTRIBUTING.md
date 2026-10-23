# Contributing to Origin

Thanks for your interest in Origin! This guide covers the development setup, the project's conventions, and how to add support for a new agent. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug or request a feature** by [opening an issue](https://github.com/openlinkos/origin/issues/new/choose); the forms ask for your OS, Node.js version, the agent and agent version involved, and the exact command you ran. Use synthetic data only.
- **Add a source adapter** for an agent that is not supported yet (see [below](#adding-a-source-adapter)).
- **Improve the documentation**, especially [docs/sources.md](docs/sources.md) when an agent changes its on-disk format.

For security or privacy problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requirements: Node.js 22.16 or later (24 LTS recommended) and pnpm. Run `corepack enable` to use the pnpm version pinned in `package.json`.

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
| `pnpm docs:dev` | Serve the documentation site locally with live reload |
| `pnpm docs:build` | Build the documentation site; fails on dead links |
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
| `packages/mcp` | MCP tools, servers over stdio and stateless HTTP, and the server of a device connected to a hub, which merges the hub's answers into its own. Depends only on `core` (ingestion and replication are injected by the CLI) |
| `packages/admin` | The hub's admin UI: server-rendered pages, a JSON API, a small browser script (`client/`), and static assets (`assets/`). Styled with the OpenLinkOS design system (`@openlinkos/ui`, a dev dependency whose stylesheet, fonts, and icons the build copies into `dist/vendor`). Depends only on `core` |
| `packages/cli` | The `origin` command, including `origin mcp`, the personal hub (`origin serve`) with its admin UI and replication API, and a device's sync with its hub |

[docs/architecture.md](docs/architecture.md) explains the data model and the five invariants that every change must preserve.

## Conventions

- **TypeScript:** strict mode, ESM, `NodeNext` module resolution. Import relative files with the `.js` extension.
- **Formatting:** Biome (2-space indent, single quotes, semicolons, trailing commas, 100-column lines). Run `pnpm lint:fix` before committing.
- **Dependencies:** `core`, `adapters`, and `admin` use only Node built-ins; `mcp` depends on the MCP TypeScript SDK and zod. Open an issue before adding a runtime dependency. Pin all dependencies to exact versions, and reference workspace packages as `workspace:*`.
- **No network, no LLM in the core.** `core` and `adapters` must not make network calls or call model APIs.
- **Language:** code, comments, CLI output, and commit messages are in English. The documentation site is bilingual; see [Bilingual documentation](#bilingual-documentation). `README.zh-CN.md` is a translation of `README.md`; if you change one, update the other or mention it in your pull request so a maintainer can.
- **Docs follow code:** if a change affects the data model, an invariant, or a public interface, update `docs/architecture.md` and `docs/zh/architecture.md` in the same pull request. Document user-visible changes in the guides (`docs/guide/` and their Chinese versions in `docs/zh/guide/`) and, if they change the quick start, in both READMEs. Record agent format findings in `docs/sources.md` and `docs/zh/sources.md`.
- **Documentation site:** `docs/` is the [origin.openlinkos.com](https://origin.openlinkos.com) site (VitePress). Links between pages are relative `.md` links; link to repository files outside `docs/` with full GitHub URLs.

## Bilingual documentation

The site is published in English and Simplified Chinese, and the English pages are the source of truth. Every page in `docs/` has a Chinese counterpart at the same path under `docs/zh/` (for example `docs/guide/hub.md` and `docs/zh/guide/hub.md`). A Chinese page keeps:

- **The same headings, in the same order.** Every `##` and `###` heading carries an explicit anchor equal to the id VitePress generates for the English heading, such as `## 环境要求 {#requirements}`, so anchors are identical in both languages. To find the English ids, run `pnpm docs:build` and look at the `id` attributes in `docs/.vitepress/dist/<page>.html`.
- **The same code blocks.** Commands, identifiers, and CLI output stay as in English; only comments and descriptions may be translated.
- **Links inside the Chinese site.** Relative `.md` links resolve to Chinese pages, and absolute site links start with `/zh/`. English pages never link into `/zh/`. External links and links to GitHub files stay as they are.
- **A `sourceHash` frontmatter field** that records which version of the English page it translates: `sha256-` followed by the first 8 hex characters of the SHA-256 of the English file, with CRLF line endings normalized to LF.

```yaml
---
sourceHash: sha256-1a2b3c4d
---
```

Compute the hash from the repository root, passing the English file:

```bash
node -e "const c=require('fs').readFileSync(process.argv[1],'utf8').replace(/\r\n/g,'\n');console.log('sha256-'+require('crypto').createHash('sha256').update(c,'utf8').digest('hex').slice(0,8))" docs/guide/cli.md
```

`pnpm docs:build` checks every rule above (the site uses the shared `@openlinkos/vitepress-theme`) and fails with the exact fix, including the `sourceHash` line to paste. Change the English page, the Chinese page, and its `sourceHash` in the same pull request. If you cannot write Chinese, change only the English page and say so in the pull request description; a maintainer will push the translation to your branch before merging, so keep "Allow edits by maintainers" enabled.

## Tests and fixtures

- Tests live in `packages/<name>/test/*.test.ts` and run with Vitest.
- Adapter parsing and the invariants (provenance, sticky forgetting, append-only, idempotent sync) must be covered by tests. MCP tools are tested end to end with in-memory and HTTP MCP clients (`packages/mcp/test`, including a connected device against an in-process hub), replication with real device-to-hub round trips (`packages/cli/test`), and the admin UI through HTTP with its security checks (`packages/admin/test`, and end to end in `packages/cli/test/admin.test.ts`). Always use temporary `ORIGIN_HOME` directories in tests.
- **Fixtures must be synthetic.** Never commit real session logs, even partial ones. Build fixtures by hand or scrub them thoroughly: replace names, paths, repository URLs, prompts, outputs, tokens, and any other identifying or secret content.

## Adding a source adapter

1. Read the agent's documentation and source (where available), and record the format in `docs/sources.md` and `docs/zh/sources.md`, including the version you checked against.
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

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`. Scopes are package names (`core`, `adapters`, `mcp`, `admin`, `cli`), or `docs` and `ci`. Examples: `feat(adapters): add Codex rollout parser`, `fix(core): detect truncated source files`.

Do not add tool-generated attribution trailers (such as `Co-Authored-By` lines for AI assistants).

## Pull requests

1. Fork the repository and branch off `master` (`feat/codex-adapter`, `fix/tail-hash`, …).
2. Keep each pull request focused on one change.
3. Make sure `pnpm lint`, `pnpm build`, `pnpm test`, and `pnpm docs:build` pass. CI runs them on Linux and Windows.
4. Describe what changed and why, and link the related issue.

Maintainers may commit directly to `master` after running the same checks.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
