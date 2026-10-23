# Session sources

Where each target agent stores its sessions on disk and what an adapter needs to know about the format. Formats are implementation details of each agent and change often. Every section notes the version it was checked against; adapters must record the agent version and tolerate unknown lines.

| Source id | Agent | Status | Session storage | Format |
|---|---|---|---|---|
| `claude-code` | [Claude Code](https://code.claude.com) | **Supported** | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | JSONL event stream |
| `codex` | [Codex CLI](https://developers.openai.com/codex) | **Supported** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | JSONL rollout, first line `session_meta` |
| `cursor` | [Cursor](https://cursor.com) | **Supported** | CLI: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`; IDE: `state.vscdb` | JSONL message blocks; SQLite key-value |
| `zcode` | [ZCode](https://github.com/zai-org/ZCode) | **Supported** | `~/.zcode/cli/db/db.sqlite` | SQLite (relational) |
| `grok` | [Grok Build](https://github.com/xai-org/grok-build) | **Supported** | `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl` | JSONL ACP session-update stream |

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

Checked against editor 3.25 on disk and the Cursor CLI changelog through October 2026. Docs: [CLI](https://cursor.com/docs/cli/overview), [hooks](https://cursor.com/docs/hooks), [CLI changelog](https://cursor.com/docs/cli/changelog).

- **Transcripts:** official docs do not specify a path. Hooks receive `transcript_path` / `CURSOR_TRANSCRIPT_PATH`. Observed layout: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`, where the slug is the working directory with its separators turned into `-` (so the directory cannot be recovered from it). Each line is `{"role":"user"|"assistant","message":{"content":[…]}}` with `text` and `tool_use` (`name`, `input`) blocks, or a `{"type":"turn_ended"}` marker; there are no ids, no tool results, and no timestamps except the `<timestamp>` (to the minute, with its UTC offset) and `<user_query>` tags a user message embeds. The editor's agent writes transcripts of its conversations too, under the conversation's id. Since early 2026, headless transcripts are written as Claude Code–compatible JSONL.
- **Editor conversations:** undocumented. In the editor's global storage (`%APPDATA%\Cursor\User\globalStorage\state.vscdb` on Windows, `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` on macOS, `~/.config/Cursor/User/globalStorage/state.vscdb` on Linux; SQLite), the key-value table `cursorDiskKV` holds `composerData:<conversation>` (its `name`, `createdAt`, `lastUpdatedAt`, `status`, `generatingBubbleIds`, `workspaceIdentifier.uri.fsPath`, and `fullConversationHeadersOnly`, the ids of the messages it shows, in order) and one `bubbleId:<conversation>:<bubble>` per message (`type` 1 for the user and 2 for the agent, `text`, `createdAt`, and `toolFormerData` with a tool call's `name`, `params`, `result`, `status`, and `error`). Values are rewritten in place. The table also holds messages a conversation no longer shows, mostly copies of shown ones, and the database holds credentials in other tables, so it is opened read-only and only these keys are read.
- **Retention:** observed cleanup markers (`~/.cursor/projects/.agent-data-cleanup-<date>`) suggest periodic purging of CLI data.
- **Command name:** `agent` is the primary CLI command (`cursor-agent` is an alias). Other tools may install a different `agent` binary on `PATH`, so detection should not rely on the name alone.
- **Native memory:** editor Memories were removed in 2.1.x; only cloud Automations keep a `MEMORIES.md`.

**Origin mapping:**

- Each editor conversation is a [generated source](architecture.md#ingestion) named `<database>#<conversation>`. Every message it shows is written out once, in creation order, when it is no longer being generated (or once the conversation has not changed for an hour), as one line holding the message's key and value as stored and the conversation's `composerId`, `name`, `createdAt`, `lastUpdatedAt`, and `workspaceIdentifier`. A message's text becomes a `message` event; a tool call becomes a `tool_use` event (`<name> <params>`, at most 2,000 characters) and a `tool_result` event (its result or error, at most 4,000 characters), noting `status` unless it is `completed`. Event ids: `cursor:<conversation>:<bubble>`, with `#1` for a tool call and `#2` for its result. The cwd is the conversation's workspace folder, and the title its name.
- A transcript whose conversation is in the editor's database is skipped: the editor's record, with tool results and exact times, is kept. Other transcripts are ingested as files: text blocks become `message` events (for a user message, the text of `<user_query>`) and `tool_use` blocks `tool_use` events. A user message's time is its `<timestamp>`, and a reply's that of the prompt before it. Event ids are `cursor:<uuid>:L<line>-<hash>`, from the line number and the first 8 hex characters of the line's SHA-256, plus `#<block>` for a tool call. Transcripts have no cwd; their project is the slug.
- Lines carry no Cursor version, so events record the installed editor's version.

## ZCode

Checked against the database of the 3.1x app on disk, sessions written by its CLI 0.16 (October 2026). Source: [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0); docs: [zcode.z.ai](https://zcode.z.ai/en/docs/agents).

- **Location:** `~/.zcode/cli/db/db.sqlite`, in WAL mode (with `-wal` / `-shm`). The documentation calls the schema an implementation detail; `schema_migration` records its migrations.
- **Format:** SQLite tables `session` (`id`, `project_id`, `parent_id`, `directory`, `title`, `version`, `task_type`, …), `message` (`id`, `session_id`, `sequence`, `time_created`, `time_updated`, `data`), and `part` (`id`, `message_id`, `session_id`, `sequence`, `time_created`, `time_updated`, `data`), plus `todo`, `tool_usage`, `model_usage`, workflow tables, and others. `sequence` orders the messages of a session and the parts of a message. `data` holds JSON: a message's `role`, `time` (`created`, and `completed` once a reply has finished), `error`, `path.cwd`, and `semantics.transcriptVisibility` (`hidden` for reminders, notifications, and summaries ZCode adds for the model); a part's `type` (`text`, `reasoning`, `tool`, `file`, `step-start`, `step-finish`, `timeline`, `compaction`), with `text` and `synthetic` for text, and `tool`, `callID`, and `state` (`status`, `input`, `output` or `error`, `time`) for a tool. Sub-agents and workflow steps run as sessions of their own (`task_type`). Raw model I/O is also written to `~/.zcode/cli/rollout/model-io-*.jsonl`.
- **Rows change in place:** a reply's message and parts change while it streams, and parts change again long after, when ZCode compacts a session.

**Origin mapping:**

- Each session is a [generated source](architecture.md#ingestion) named `<database>#<session-id>`. Every message is written out once, when it has settled (a user message once its parts are there, a reply once it has completed or failed, any message once the session has moved past it or has not changed for an hour), as one line holding the message row, its part rows, and the session's `id`, `parent_id`, `directory`, `title`, `version`, and `task_type`, with every column as stored. Later changes to a written-out message are not mirrored.
- Text parts become `message` events; text in a hidden message, or marked `synthetic`, becomes `meta`. A file part becomes `[image]` or `[file]`. A tool part becomes a `tool_use` event (`<tool> <input>`, at most 2,000 characters) and a `tool_result` event (its output or error, at most 4,000 characters), noting `status` unless it is `completed`. Reasoning, step markers, timeline notices, and compaction markers are skipped; the mirror keeps them.
- Event id: `zcode:<session-id>:<message sequence>.<part sequence>`, with `#1` for a tool's result.
- Timestamps come from the part's own times, then its row. The cwd comes from the message's `path.cwd`, then the session's directory; the title and the ZCode version come from the session.
- **Native memory:** off by default. `~/.zcode/cli/memories/projects/<project>/memory/` uses the same `MEMORY.md` layout as Claude Code.

## Grok Build

Checked against 1.0.41 on disk (October 2026). Source: [xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0); docs: [docs.x.ai/build](https://docs.x.ai/build/overview) and the in-repo user guide (`17-sessions.md`, `07-mcp-servers.md`, `13-memory.md`).

- **Location:** `$GROK_HOME/sessions/<group>/<session-id>/` (`GROK_HOME` defaults to `~/.grok`). The group is the URL-encoded working directory; when that would exceed 255 bytes, Grok names it by a slug and a hash instead and records the path in a `.cwd` file. Session ids are UUIDv7, unless a client supplies its own with `-s`. `sessions/` also holds Grok's own `session_search.sqlite`.
- **Format:** a directory per session. `updates.jsonl` is the authoritative log, an ACP session-update stream with one `{ method, params: { sessionId, update, _meta }, timestamp }` object per line: `method` is `session/update` or `_x.ai/session/update`, `timestamp` is in seconds, and `_meta` carries `eventId` (unique within the file, mostly `<session-id>-<n>`) and `agentTimestampMs`. `update.sessionUpdate` is `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `turn_completed`, `background_tasks`, `subagent_spawned`, `subagent_finished`, `goal_updated`, or another kind. On disk, each message chunk holds a whole message.
- **Other files:** `chat_history.jsonl` holds the messages sent to the model, without timestamps; `events.jsonl` is telemetry (phases, tool timings); `summary.json` holds the title, timestamps, model, and message counts. The directory also contains `system_prompt.txt`, `plan.json`, `rewind_points.jsonl`, `compaction_checkpoints/`, and `subagents/`. Internal planning agents (`grok-build-plan`) leave sessions without `updates.jsonl`; sub-agents run as sessions of their own in the same tree.
- **Native memory:** experimental and off by default (`GROK_MEMORY=1`). Markdown under `~/.grok/memory/` (global `MEMORY.md` plus per-workspace directories keyed by a git-remote hash) or `~/.grok/memory-v2/`.
- **Interop:** by default Grok merges MCP servers from `~/.claude.json`, Cursor's `mcp.json`, and a project's `.mcp.json`, so registering Origin for Claude Code also exposes it to Grok. `grok inspect` lists the merged servers; `grok mcp list` shows only Grok's own.

**Origin mapping:**

- Only `updates.jsonl` is read. User and agent message chunks become `message` events; user messages that Grok hides from the transcript (`hideFromScrollback`, such as goal follow-ups) become `meta`. Thoughts, plans, and turn, task, goal, and sub-agent notices are skipped; the raw mirror keeps them.
- A `tool_call` becomes a `tool_use` event (`<name> <input>`, at most 2,000 characters), with the name from `_meta["x.ai/tool"]` and server-side searches named `web_search`. The `tool_call_update` that carries `rawOutput` becomes its `tool_result` (the text, images, and diffs Grok shows, or else the raw output; at most 4,000 characters), noting `status` unless it is `completed`. Other `tool_call_update` lines only refine the call and are skipped.
- Event id: `grok:<session-id>:e<n>` for an `eventId` of the form `<session-id>-<n>`, otherwise `grok:<session-id>:<eventId>`, falling back to the line number.
- Timestamps come from `agentTimestampMs`, then `timestamp`. The cwd and project come from the group's name; sessions in a slug-and-hash group have none, since a hub never sees the `.cwd` file. Lines carry no Grok version, so events record the version installed when they are synced (`$GROK_HOME/version.json`).

To register Origin with each agent, see [Connect your agents](guide/connect-agents.md).
