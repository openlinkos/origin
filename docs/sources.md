# Session sources

Where each target agent stores its sessions on disk and what an adapter needs to know about the format. Formats are implementation details of each agent and change often. Every section notes the version it was checked against; adapters must record the agent version and tolerate unknown lines.

| Source id | Agent | Status | Session storage | Format |
|---|---|---|---|---|
| `claude-code` | [Claude Code](https://code.claude.com) | **Supported** | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | JSONL event stream |
| `codex` | [Codex CLI](https://developers.openai.com/codex) | **Supported** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | JSONL rollout, first line `session_meta` |
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

Checked against codex-cli 0.154 on disk and the `main` source (October 2026). Docs: [memory](https://developers.openai.com/codex/memory), [config](https://developers.openai.com/codex/config-reference); source: [`codex-rs/protocol/src/models.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs) (`ResponseItem`), [`codex-rs/history`](https://github.com/openai/codex/tree/main/codex-rs/history) (`RolloutItem`), [`codex-rs/rollout`](https://github.com/openai/codex/tree/main/codex-rs/rollout).

- **Location:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl` (`CODEX_HOME` defaults to `~/.codex`); archived sessions move to `$CODEX_HOME/archived_sessions/`. The uuid in the file name is the session (thread) id. A background job compresses cold rollouts to `.jsonl.zst`.
- **Format:** one `{ timestamp, ordinal, type, payload }` object per line; `ordinal` is unique within a rollout. The first line is `session_meta` (`id`, `cwd`, `originator`, `cli_version`, `model_provider`, `base_instructions`, about 20 KB). Other types: `response_item` (the conversation), `event_msg` (UI events that repeat response items), `turn_context`, `world_state`, `compacted`, and more.
- **Response items:** `message` (role `user`, `assistant`, or `developer`; `content` blocks `input_text` / `output_text` / `input_image`; assistant messages may carry a `phase`), `reasoning` (summary plus encrypted content), `function_call` (`name`, JSON-string `arguments`, `call_id`), `custom_tool_call` (`input`, e.g. `apply_patch`), `local_shell_call` (`action.command`), `web_search_call`, `function_call_output` / `custom_tool_call_output` (`output` is a string or content blocks), `compaction`, and others.
- **Injected context:** Codex adds user-role messages wrapped in a single tag, such as `<environment_context>…</environment_context>`.

**Origin mapping:**

- User and assistant messages become `message` events; injected user messages become `meta`. Developer messages, reasoning, compaction, and `event_msg` lines are skipped; the raw mirror keeps them.
- Tool calls (`function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`) become `tool_use` events (`<name> <input>`, at most 2,000 characters). Their outputs become `tool_result` events (at most 4,000 characters).
- Event id: `codex:<session-id>:o<ordinal>`, falling back to the item id, then the line number, for rollouts without ordinals.
- cwd, project, and agent version come from `session_meta`. For lines ingested in a later sync, the adapter re-reads the rollout's first line.
- `.jsonl.zst` files are decompressed and mirrored as plain JSONL. A rollout seen both before and after compression yields the same event ids, so events are not duplicated.
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

## Connecting agents to Origin

Every agent launches the same stdio server, `node <repo>/packages/cli/dist/bin.js mcp`. Replace `/path/to/origin` below with the absolute path of your checkout. Register Origin globally, not per project, so that all projects share one memory. The Claude Code setup has been verified end to end; the other configurations follow each agent's documentation.

**Claude Code**

```bash
claude mcp add --scope user origin -- node /path/to/origin/packages/cli/dist/bin.js mcp
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.origin]
command = "node"
args = ["/path/to/origin/packages/cli/dist/bin.js", "mcp"]
```

**Cursor** — `~/.cursor/mcp.json` (shared by the editor and the CLI):

```json
{
  "mcpServers": {
    "origin": { "command": "node", "args": ["/path/to/origin/packages/cli/dist/bin.js", "mcp"] }
  }
}
```

**ZCode** — add the server under `mcp.servers` in `~/.zcode/cli/config.json`, or use ZCode's import of Claude Code or Codex MCP settings.

**Grok Build** — reads `~/.claude.json`, so the Claude Code registration above is picked up automatically. Otherwise add `[mcp_servers.origin]` to `~/.grok/config.toml` as for Codex.
