# Session sources

Where each target agent stores its sessions on disk and what an adapter needs to know about the format. Formats are implementation details of each agent and change often. Every section notes the version it was checked against; adapters must record the agent version and tolerate unknown lines.

| Source id | Agent | Status | Session storage | Format |
|---|---|---|---|---|
| `claude-code` | [Claude Code](https://code.claude.com) | **Supported** | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | JSONL event stream |
| `codex` | [Codex CLI](https://developers.openai.com/codex) | Planned | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL, first line `session_meta` |
| `cursor` | [Cursor](https://cursor.com) | Planned | CLI: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`; IDE: `state.vscdb` | JSONL message blocks; SQLite key-value |
| `zcode` | [ZCode](https://github.com/zai-org/ZCode) | Planned | `~/.zcode/cli/db/db.sqlite` | SQLite (relational) |
| `grok` | [Grok Build](https://github.com/xai-org/grok-build) | Planned | `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` | Directory of JSONL/JSON files |

All five agents also keep their own memory, scoped per repository, project, or machine. These native memories have no source references, so Origin treats them as a possible import target and never as a source of truth.

## Claude Code

Checked against v2.1.x (October 2026). Docs: [memory](https://code.claude.com/docs/en/memory), [`.claude` directory](https://code.claude.com/docs/en/claude-directory).

- **Location:** `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (`CLAUDE_CONFIG_DIR` overrides `~/.claude`). Sub-agent logs live in `<session-id>/subagents/agent-*.jsonl`, and large tool outputs in `tool-results/`.
- **Format:** one JSON object per line. `type` is one of `user`, `assistant`, `summary`, `system`, `mode`, `permission-mode`, `file-history-snapshot`, and others. Message lines carry `uuid`, `parentUuid`, `timestamp`, `cwd`, `gitBranch`, `sessionId`, `version`, and `message { role, content }`; `content` is a string or an array of `text` / `tool_use` / `tool_result` / `thinking` / `image` blocks.
- **Retention:** sessions are deleted after `cleanupPeriodDays` (default 30). The `memory/` directory is exempt.
- **Native memory:** `<cwd-slug>/memory/` — a `MEMORY.md` index plus one Markdown file per memory with frontmatter. Scoped to one git repository on one machine.

The mapping into Origin events is described in [architecture.md](architecture.md#claude-code-mapping).

## Codex CLI

Checked against rust-v0.16x (October 2026). Docs: [memory](https://developers.openai.com/codex/memory), [config](https://developers.openai.com/codex/config-reference); source: [`codex-rs/rollout`](https://github.com/openai/codex/tree/main/codex-rs/rollout).

- **Location:** `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`; archived sessions go to `~/.codex/archived_sessions/`.
- **Format:** JSONL. The first line is `session_meta` with `session_id`, `cwd`, `originator`, `cli_version`, `model_provider`, and `base_instructions`. The source tree includes a zstd compression module, so adapters should expect compressed rollouts.
- **Native memory:** off by default (`features.memories = true`). Stored under `~/.codex/memories/` and scoped to the machine, as a two-stage pipeline: per-thread `raw_memory` / `rollout_summary`, then a global merge into `MEMORY.md` and `memory_summary.md`. Entries reference their rollout and track `usage_count`; unused memories expire after 30 days by default.

## Cursor

Checked against Cursor CLI changelog through October 2026 and editor 3.x. Docs: [CLI](https://cursor.com/docs/cli/overview), [hooks](https://cursor.com/docs/hooks), [CLI changelog](https://cursor.com/docs/cli/changelog).

- **CLI transcripts:** official docs do not specify a path. Hooks receive `transcript_path` / `CURSOR_TRANSCRIPT_PATH`. Observed layout: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`. Each line is `{"role":"user"|"assistant","message":{"content":[{"type":"text","text":…}]}}`, and user messages embed `<timestamp>` and `<user_query>` tags. Since early 2026, headless transcripts are written as Claude Code–compatible JSONL.
- **Editor conversations:** undocumented. In the global storage `state.vscdb` (SQLite), the `cursorDiskKV` table holds `composerData:*` conversation bodies and `composerHeaders` holds metadata. The database is in WAL mode and must be opened read-only.
- **Retention:** observed cleanup markers (`~/.cursor/projects/.agent-data-cleanup-<date>`) suggest periodic purging of CLI data.
- **Command name:** `agent` is the primary CLI command (`cursor-agent` is an alias). Other tools may install a different `agent` binary on `PATH`, so detection should not rely on the name alone.
- **Native memory:** editor Memories were removed in 2.1.x; only cloud Automations keep a `MEMORIES.md`.

## ZCode

Checked against v3.1x (October 2026). Source: [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0); docs: [zcode.z.ai](https://zcode.z.ai/en/docs/agents).

- **Location:** `~/.zcode/cli/db/db.sqlite` (with `-wal` / `-shm`). The documentation calls the schema an implementation detail, so the adapter should be checked against the source.
- **Format:** SQLite tables `session` (`id`, `project_id`, `parent_id`, `directory`, `title`, `version`, …), `message` (`id`, `session_id`, `data`, `sequence`), and `part` (`id`, `message_id`, `session_id`, `data`), plus `todo`, `tool_usage`, `model_usage`, and others. `data` columns hold JSON. Raw model I/O is also written to `~/.zcode/cli/rollout/model-io-*.jsonl`, and sub-agent output to `~/.zcode/cli/agents/<session>/<agent>/`.
- **Locator:** a SQLite source has no line numbers, so the raw locator must be the table plus primary key, mirrored append-only.
- **Native memory:** off by default. `~/.zcode/cli/memories/projects/<project>/memory/` uses the same `MEMORY.md` layout as Claude Code.

## Grok Build

Checked against 1.0.4x (September–October 2026). Source: [xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0); docs: [docs.x.ai/build](https://docs.x.ai/build/overview) and the in-repo user guide (`17-sessions.md`, `13-memory.md`).

- **Location:** `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` (`GROK_HOME` overrides `~/.grok`). Session ids are UUIDv7.
- **Format:** a directory per session. `updates.jsonl` is the authoritative log (an ACP session-update stream). `chat_history.jsonl` holds the raw messages sent to the model, and `summary.json` the title, timestamps, model, message count, and parent session. The directory also contains `system_prompt.txt`, `plan.json`, `rewind_points.jsonl`, `compaction_checkpoints/`, and `subagents/`.
- **Native memory:** experimental and off by default (`GROK_MEMORY=1`). Markdown under `~/.grok/memory/` (global `MEMORY.md` plus per-workspace directories keyed by a git-remote hash) or `~/.grok/memory-v2/`.
- **Interop:** Grok merges MCP servers from `~/.claude.json` and `.mcp.json`, so registering Origin for Claude Code also exposes it to Grok.

## Connecting agents to Origin's MCP server

Once the MCP server ships, each agent registers it through its own configuration:

| Agent | MCP configuration |
|---|---|
| Claude Code | `claude mcp add` / `~/.claude.json` / project `.mcp.json` |
| Codex CLI | `~/.codex/config.toml` (`[mcp_servers.<name>]`) |
| Cursor | `~/.cursor/mcp.json` or project `.cursor/mcp.json` |
| ZCode | `~/.zcode/cli/config.json` (`mcp.servers`); can import from Claude Code and Codex settings |
| Grok Build | `~/.grok/config.toml` (`[mcp_servers.<name>]`); also reads Claude Code and Cursor MCP configs |
