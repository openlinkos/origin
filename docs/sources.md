# Session sources

Where each target agent stores its sessions on disk and what an adapter needs to know about the format. Formats are implementation details of each agent and change often. Every section notes the version it was checked against; adapters must record the agent version and tolerate unknown lines.

| Source id | Agent | Status | Session storage | Format |
|---|---|---|---|---|
| `claude-code` | [Claude Code](https://code.claude.com) | **Supported** | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | JSONL event stream |
| `codex` | [Codex CLI](https://developers.openai.com/codex) | **Supported** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | JSONL rollout, first line `session_meta` |
| `cursor` | [Cursor](https://cursor.com) | **Supported** | CLI: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`; IDE: `state.vscdb` | JSONL message blocks; SQLite key-value |
| `zcode` | [ZCode](https://github.com/zai-org/ZCode) | **Supported** | `~/.zcode/cli/db/db.sqlite` | SQLite (relational) |
| `grok` | [Grok Build](https://github.com/xai-org/grok-build) | **Supported** | `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl` | JSONL ACP session-update stream |
| `<name>` | Your own: any program that writes event lines | **Supported** | `~/.origin/sources/<name>/**/*.jsonl` | Event lines, see [Your own sources](#your-own-sources-event-lines) |

All five agents also keep their own memory, scoped per repository, project, or machine. Origin imports the memory files of Claude Code, ZCode, and Grok Build as entries (see [Native memories](#native-memories)); since those files cite no sources, an imported entry cites the version of the file it comes from.

## Claude Code

Checked against v2.1.x (October 2026). Docs: [memory](https://code.claude.com/docs/en/memory), [`.claude` directory](https://code.claude.com/docs/en/claude-directory).

- **Location:** `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (`CLAUDE_CONFIG_DIR` overrides `~/.claude`). Sub-agent logs live in `<session-id>/subagents/agent-*.jsonl`, and large tool outputs in `tool-results/`. Those logs name no parent session, and Origin records none from them (see [Parent sessions](architecture.md#parent-sessions)).
- **Format:** one JSON object per line. `type` is one of `user`, `assistant`, `ai-title`, `custom-title`, `agent-name`, `last-prompt`, `summary`, `system`, `mode`, `permission-mode`, `file-history-snapshot`, `attachment`, and others. Message lines carry `uuid`, `parentUuid`, `timestamp`, `cwd`, `gitBranch`, `sessionId`, `version`, and `message { role, content }`; `content` is a string or an array of `text` / `tool_use` / `tool_result` / `thinking` / `image` blocks.
- **Titles:** `{ type: "ai-title", aiTitle, sessionId }` is the title Claude Code generates, written again every turn or so and changed as the conversation goes on; the latest is current. A name the user gives (`/rename`, `--name`, a hook's `sessionTitle`, the Agent SDK's `renameSession()`) is a `{ type: "custom-title", customTitle, sessionId }` line, also written again, which takes precedence over the AI title, even when `ai-title` lines follow it. `{ type: "agent-name", agentName, sessionId }` names the session in Claude Code's agent view; it appears in the session's own log, not only for sub-agents, and repeats the AI title or the custom title. `{ type: "last-prompt", lastPrompt, leafUuid, sessionId }` records the latest prompt. Versions before 2.1 wrote `{ type: "summary", summary, leafUuid }` lines instead.
- **Who wrote it** (checked against 2.1.303, November 2026): a user line says who sent it in `origin.kind`: `human` for what the user typed, `task-notification` for a background task's notice, and `peer` or `coordinator` for another agent's message, with that agent's name in `origin.name` and its id in `origin.from`. `promptSource` says how a prompt was entered (`typed`, `queued`, `system`, `sdk`). The summary a compaction writes is a user message marked `isCompactSummary`. A sub-agent's lines are marked `isSidechain`, in a log under `subagents/`, and every line of a headless run (`claude -p`, the Agent SDK) records an `entrypoint` of `sdk-cli` or another `sdk-*` (`cli` otherwise). Earlier versions record none of `origin` and `promptSource`.
- **Queued prompts:** a prompt the user sends while the agent is busy is written as an `attachment` line whose `attachment` has `type` `queued_command`, the `prompt` (a string, or text and image blocks), `commandMode` `prompt`, and `origin.kind` `human`; Claude Code hands it to the turn under way and writes no user line for it. Background tasks' notices are queued the same way, with `origin.kind` `task-notification`, and so are the messages a sub-agent is handed.
- **Retention:** sessions are deleted after `cleanupPeriodDays` (default 30). The `memory/` directory is exempt.
- **Hooks** (checked November 2026, [hooks](https://code.claude.com/docs/en/hooks)): a command hook reads a JSON event on standard input with `session_id`, `transcript_path` (the session's log), `cwd`, and `hook_event_name`; `SubagentStop` adds `agent_id`, `agent_type`, and `agent_transcript_path`, the sub-agent's log under `subagents/`. The log is written asynchronously, so it may not hold a turn's last lines yet when the turn's `Stop` hook runs. A hook with `"async": true` runs in the background, and Claude Code does not wait for it; all `SessionEnd` hooks share 1.5 seconds. Origin's ingest hooks run at `Stop`, `SubagentStop`, and `PostCompact` (see [Live ingestion](architecture.md#live-ingestion)).
- **Native memory:** `<cwd-slug>/memory/` — a `MEMORY.md` index plus one Markdown file per memory with frontmatter. Scoped to one git repository on one machine. Imported; see [Native memories](#native-memories).

The mapping into Origin events is described in [architecture.md](architecture.md#claude-code-mapping).

## Codex CLI

Checked against codex-cli 0.154 on disk and the `main` source (October 2026). Docs: [memory](https://developers.openai.com/codex/memory), [config](https://developers.openai.com/codex/config-reference); source: [`codex-rs/protocol/src/models.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs) (`ResponseItem`), [`codex-rs/history`](https://github.com/openai/codex/tree/main/codex-rs/history) (`RolloutItem`), [`codex-rs/rollout`](https://github.com/openai/codex/tree/main/codex-rs/rollout).

- **Location:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl` (`CODEX_HOME` defaults to `~/.codex`); archived sessions move to `$CODEX_HOME/archived_sessions/`. The uuid in the file name is the session (thread) id. A background job compresses cold rollouts to `.jsonl.zst`.
- **Format:** one `{ timestamp, ordinal, type, payload }` object per line; `ordinal` is unique within a rollout. The first line is `session_meta` (`id`, `cwd`, `originator`, `cli_version`, `model_provider`, `base_instructions`, about 20 KB, and `source`, what started the session: `cli`, `vscode`, `exec` for `codex exec`, `mcp`, or an object such as `{ "subagent": { "thread_spawn": { "parent_thread_id": …, "depth": … } } }` for a sub-agent Codex spawned). Other types: `response_item` (the conversation), `event_msg` (UI events that repeat response items), `turn_context`, `world_state`, `compacted`, and more.
- **Response items:** `message` (role `user`, `assistant`, or `developer`; `content` blocks `input_text` / `output_text` / `input_image`; assistant messages may carry a `phase`), `reasoning` (summary plus encrypted content), `function_call` (`name`, JSON-string `arguments`, `call_id`), `custom_tool_call` (`input`, e.g. `apply_patch`), `local_shell_call` (`action.command`), `web_search_call`, `function_call_output` / `custom_tool_call_output` (`output` is a string or content blocks), `compaction`, and others.
- **Injected context:** Codex adds user-role messages wrapped in a single tag, such as `<environment_context>…</environment_context>`. A user message of 0.154 says what it is made of in `internal_chat_message_metadata_passthrough.content_item_kinds`: `user.text` for what the user typed, `environments.environment_context` for that context.
- **Hooks** (checked November 2026, [hooks](https://developers.openai.com/codex/hooks)): `~/.codex/hooks.json`, or `[hooks]` in `config.toml`, with the same events and fields as Claude Code's: `session_id` (a sub-agent's hooks get the parent's), `transcript_path` (the session's rollout, or null), `cwd`, and `hook_event_name`, and at `SubagentStop`, `agent_transcript_path` (or null). `"async": true` runs a hook in the background; `SessionEnd` hooks get 1 second. Codex runs a new or changed hook only once the user has trusted it with `/hooks`, which records a hash of the hook. Origin's ingest hooks run at `Stop` and `SubagentStop`.

**Origin mapping:**

- User and assistant messages become `message` events; injected user messages become `meta`. Developer messages, reasoning, compaction, and `event_msg` lines are skipped; the raw mirror keeps them.
- **Who wrote it:** a session whose `session_meta` names a sub-agent (`source` `{ "subagent": … }`) is a child, all of whose input is the agent's, and one of `codex exec` a headless run, all of whose input is the system's. Otherwise a user message is the user's if its `content_item_kinds` hold `user.text`, and the system's if they do not; a rollout without them leaves it to the message's kind and text (see [Authors](architecture.md#authors)). Other sources (`cli`, `vscode`, `mcp`, and the rest) make no session a child or a headless run.
- **Its parent:** when `source.subagent` is an object and `thread_spawn.parent_thread_id` is a non-empty string, that id is the parent, `via` `subagent`, signal `parent_thread_id`, and the parent source is `codex` (see [Parent sessions](architecture.md#parent-sessions)). A `source.subagent` that is only a string still marks the session as a child and names no parent.
- Tool calls (`function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`) become `tool_use` events (`<name> <input>`, at most 2,000 characters). Their outputs become `tool_result` events (at most 4,000 characters).
- Event id: `codex:<session-id>:o<ordinal>`, falling back to the item id, then the line number, for rollouts without ordinals.
- cwd, project, and agent version come from `session_meta`. For lines ingested in a later sync, the adapter re-reads the rollout's first line.
- `.jsonl.zst` files are decompressed and mirrored as plain JSONL. A rollout seen both before and after compression yields the same event ids, so events are not duplicated.
- **Native memory:** off by default (`features.memories = true`). Stored under `~/.codex/memories/` and scoped to the machine, as a two-stage pipeline: per-thread `raw_memory` / `rollout_summary`, then a global merge into `MEMORY.md` and `memory_summary.md`. Entries reference their rollout and track `usage_count`; unused memories expire after 30 days by default. Not imported yet.

## Cursor

Checked against editor 3.25 on disk and the Cursor CLI changelog through October 2026. Docs: [CLI](https://cursor.com/docs/cli/overview), [hooks](https://cursor.com/docs/hooks), [CLI changelog](https://cursor.com/docs/cli/changelog).

- **Transcripts:** official docs do not specify a path. Hooks receive `transcript_path` / `CURSOR_TRANSCRIPT_PATH`. Observed layout: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`, where the slug is the working directory with its separators turned into `-` (so the directory cannot be recovered from it). Each line is `{"role":"user"|"assistant","message":{"content":[…]}}` with `text` and `tool_use` (`name`, `input`) blocks, or a `{"type":"turn_ended"}` marker; there are no ids, no tool results, and no timestamps except the `<timestamp>` (to the minute, with its UTC offset) and `<user_query>` tags a user message embeds. The editor's agent writes transcripts of its conversations too, under the conversation's id. Since early 2026, headless transcripts are written as Claude Code–compatible JSONL.
- **Editor conversations:** undocumented. In the editor's global storage (`%APPDATA%\Cursor\User\globalStorage\state.vscdb` on Windows, `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` on macOS, `~/.config/Cursor/User/globalStorage/state.vscdb` on Linux; SQLite), the key-value table `cursorDiskKV` holds `composerData:<conversation>` (its `name`, `createdAt`, `lastUpdatedAt`, `status`, `generatingBubbleIds`, `workspaceIdentifier.uri.fsPath`, and `fullConversationHeadersOnly`, the ids of the messages it shows, in order) and one `bubbleId:<conversation>:<bubble>` per message (`type` 1 for the user and 2 for the agent, `text`, `createdAt`, `isSimulatedMsg` with a `simulatedMsgReason` for a user message Cursor wrote itself, and `toolFormerData` with a tool call's `name`, `params`, `result`, `status`, and `error`). Values are rewritten in place. The table also holds messages a conversation no longer shows, mostly copies of shown ones, and the database holds credentials in other tables, so it is opened read-only and only these keys are read.
- **Retention:** observed cleanup markers (`~/.cursor/projects/.agent-data-cleanup-<date>`) suggest periodic purging of CLI data.
- **Command name:** `agent` is the primary CLI command (`cursor-agent` is an alias). Other tools may install a different `agent` binary on `PATH`, so detection should not rely on the name alone.
- **Native memory:** editor Memories were removed in 2.1.x; only cloud Automations keep a `MEMORIES.md`.

**Origin mapping:**

- Each editor conversation is a [generated source](architecture.md#ingestion) named `<database>#<conversation>`. Every message it shows is written out once, in creation order, when it is no longer being generated (or once the conversation has not changed for an hour), as one line holding the message's key and value as stored and the conversation's `composerId`, `name`, `createdAt`, `lastUpdatedAt`, and `workspaceIdentifier`. A message's text becomes a `message` event; a tool call becomes a `tool_use` event (`<name> <params>`, at most 2,000 characters) and a `tool_result` event (its result or error, at most 4,000 characters), noting `status` unless it is `completed`. Event ids: `cursor:<conversation>:<bubble>`, with `#1` for a tool call and `#2` for its result. The cwd is the conversation's workspace folder, and the title its name.
- A transcript whose conversation is in the editor's database is skipped: the editor's record, with tool results and exact times, is kept. Other transcripts are ingested as files: text blocks become `message` events (for a user message, the text of `<user_query>`) and `tool_use` blocks `tool_use` events. A user message's time is its `<timestamp>`, and a reply's that of the prompt before it. Event ids are `cursor:<uuid>:L<line>-<hash>`, from the line number and the first 8 hex characters of the line's SHA-256, plus `#<block>` for a tool call. Transcripts have no cwd; their project is the slug.
- Lines carry no Cursor version, so events record the installed editor's version.
- **Who wrote it:** a user message the editor marks `isSimulatedMsg` is the system's. Other user messages, of the editor and of transcripts, which say nothing more, are left to their text (see [Authors](architecture.md#authors)).
- **No parent.** Neither a transcript nor an editor conversation names the session it was started from, and Origin records none (see [Parent sessions](architecture.md#parent-sessions)).

## ZCode

Checked against the database of the 3.1x app on disk, sessions written by its CLI 0.16 (October 2026). Source: [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0); docs: [zcode.z.ai](https://zcode.z.ai/en/docs/agents).

- **Location:** `~/.zcode/cli/db/db.sqlite`, in WAL mode (with `-wal` / `-shm`). The documentation calls the schema an implementation detail; `schema_migration` records its migrations.
- **Format:** SQLite tables `session` (`id`, `project_id`, `parent_id`, `directory`, `title`, `version`, `task_type`, …), `message` (`id`, `session_id`, `sequence`, `time_created`, `time_updated`, `data`), and `part` (`id`, `message_id`, `session_id`, `sequence`, `time_created`, `time_updated`, `data`), plus `todo`, `tool_usage`, `model_usage`, workflow tables, and others. `sequence` orders the messages of a session and the parts of a message. `data` holds JSON: a message's `role`, `time` (`created`, and `completed` once a reply has finished), `error`, `path.cwd`, `semantics.transcriptVisibility` (`hidden` for reminders, notifications, and summaries ZCode adds for the model), `semantics.origin`, who wrote a user message (`real_user`, or `agent_runtime` and `system` for what ZCode adds), and `semantics.kind` (`user_prompt`, `todo_reminder`, `background_notification`, `compact_summary`, …); a part's `type` (`text`, `reasoning`, `tool`, `file`, `step-start`, `step-finish`, `timeline`, `compaction`), with `text` and `synthetic` for text, and `tool`, `callID`, and `state` (`status`, `input`, `output` or `error`, `time`) for a tool. Sub-agents and workflow steps run as sessions of their own, with a `parent_id`: a session's `task_type` is `interactive` for a conversation with the user, `selection_side_chat` for a side chat about a selection, and `subagent_child` and `workflow_child` for a sub-agent's and a workflow step's, whose prompts ZCode labels `real_user` all the same. Raw model I/O is also written to `~/.zcode/cli/rollout/model-io-*.jsonl`.
- **Rows change in place:** a reply's message and parts change while it streams, and parts change again long after, when ZCode compacts a session.

**Origin mapping:**

- Each session is a [generated source](architecture.md#ingestion) named `<database>#<session-id>`. Every message is written out once, when it has settled (a user message once its parts are there, a reply once it has completed or failed, any message once the session has moved past it or has not changed for `ORIGIN_ZCODE_SETTLE_MS` milliseconds, one hour (`3600000`) by default), as one line holding the message row, its part rows, and the session's `id`, `parent_id`, `directory`, `title`, `version`, and `task_type`, with every column as stored. When `dwf_actor` names the session, the line also holds `workflow`: that actor's `dwf_run` (`id`, `name`, `resumed_from`) and `group`, the root of the `resumed_from` chain, walked while the line is written. `workflow_run` is not read. The database is opened read-only, as it already is. Later changes to a written-out message are not mirrored.
- **Its parent:** a non-empty `parent_id` other than the session itself. `workflow_child` is `via` `workflow` and `subagent_child` is `via` `subagent`; the signal is `parent_id`, unless the line carries `workflow`, in which case the signal is `dwf_run`, the run's name is kept, and the group is `workflow.group` when it is set, or `workflow.id` when `resumed_from` is null (see [Parent sessions](architecture.md#parent-sessions)). A group a line does not carry is left empty until `origin sessions parents` reads `dwf_run` again, still read-only, and appends it.
- Text parts become `message` events; text in a hidden message, or marked `synthetic`, becomes `meta`. A file part becomes `[image]` or `[file]`.
- **Who wrote it:** every input of a session whose `task_type` is `subagent_child` or `workflow_child` is the agent's. Otherwise a user message's `semantics.origin` decides: `real_user` the user's, `agent_runtime` and `system` the system's; a side chat's prompt that ZCode hides is the user's too, as a `meta` event, though it is no prompt. A tool part becomes a `tool_use` event (`<tool> <input>`, at most 2,000 characters) and a `tool_result` event (its output or error, at most 4,000 characters), noting `status` unless it is `completed`. Reasoning, step markers, timeline notices, and compaction markers are skipped; the mirror keeps them.
- Event id: `zcode:<session-id>:<message sequence>.<part sequence>`, with `#1` for a tool's result.
- Timestamps come from the part's own times, then its row. The cwd comes from the message's `path.cwd`, then the session's directory; the title and the ZCode version come from the session.
- **Native memory:** off by default. `~/.zcode/cli/memories/projects/<project>-<hash>/memory/` uses the same `MEMORY.md` layout as Claude Code. Imported; see [Native memories](#native-memories).

## Grok Build

Checked against 1.0.41 on disk (October 2026). Source: [xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0); docs: [docs.x.ai/build](https://docs.x.ai/build/overview) and the in-repo user guide (`17-sessions.md`, `07-mcp-servers.md`, `13-memory.md`).

- **Location:** `$GROK_HOME/sessions/<group>/<session-id>/` (`GROK_HOME` defaults to `~/.grok`). The group is the URL-encoded working directory; when that would exceed 255 bytes, Grok names it by a slug and a hash instead and records the path in a `.cwd` file. Session ids are UUIDv7, unless a client supplies its own with `-s`. `sessions/` also holds Grok's own `session_search.sqlite`.
- **Format:** a directory per session. `updates.jsonl` is the authoritative log, an ACP session-update stream with one `{ method, params: { sessionId, update, _meta }, timestamp }` object per line: `method` is `session/update` or `_x.ai/session/update`, `timestamp` is in seconds, and `_meta` carries `eventId` (unique within the file, mostly `<session-id>-<n>`) and `agentTimestampMs`. `update.sessionUpdate` is `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `turn_completed`, `background_tasks`, `subagent_spawned`, `subagent_finished`, `goal_updated`, or another kind. On disk, each message chunk holds a whole message.
- **Other files:** `chat_history.jsonl` holds the messages sent to the model, without timestamps; `events.jsonl` is telemetry (phases, tool timings); `summary.json` holds the title, timestamps, model, and message counts. The directory also contains `system_prompt.txt`, `plan.json`, `rewind_points.jsonl`, `compaction_checkpoints/`, and `subagents/`. A session that never held a conversation has no `updates.jsonl`.
- **Sub-agents** run as sessions of their own in the same tree. The parent's log names each one it starts, in a `subagent_spawned` update (`child_session_id`, `parent_session_id`, `subagent_type`), and the sub-agent's `summary.json` says what it is in `session_kind`: `subagent`, `subagent_fork`, or `subagent_resume`, or `headless` for a headless run; a session the user runs has none. `agent_name` names the agent: `grok-build-plan` for the sessions the user runs, a sub-agent's type (`explore`, `general-purpose`) for a sub-agent.
- **Who wrote a message:** a user message's `_meta` says how it came: `promptIndex`, its place among the session's prompts; `interjection`, sent while a turn ran; `hostTurn`, a turn Grok's host started; and `hideFromScrollback`, kept out of the transcript, for the follow-ups Grok sends on its own, which it numbers among the prompts all the same. A sub-agent's prompts have a `promptIndex` too.
- **Titles:** `summary.json` is one JSON object, rewritten in place every turn: `info` (`id`, `cwd`), `generated_title`, `session_summary`, `title_is_manual`, `created_at`, `updated_at`, `num_messages`, `agent_name`, `session_kind`, and more. `generated_title` holds the title Grok shows: generated after the first prompt and again at a couple of early turns, or the one given with `/rename`, which sets `title_is_manual` and which automatic titles then leave alone until `/rename --auto` blanks it. `session_summary` mirrors the title for older clients, and is shown when `generated_title` is blank.
- **Native memory:** experimental and off by default (`GROK_MEMORY=1`). Markdown under `~/.grok/memory/` (global `MEMORY.md` plus per-workspace directories keyed by a git-remote hash) or `~/.grok/memory-v2/`. Imported; see [Native memories](#native-memories).
- **Interop:** by default Grok merges MCP servers from `~/.claude.json`, Cursor's `mcp.json`, and a project's `.mcp.json`, so registering Origin for Claude Code also exposes it to Grok. `grok inspect` lists the merged servers; `grok mcp list` shows only Grok's own.

**Origin mapping:**

- A session's title comes from its `summary.json`, through a [generated source](architecture.md#ingestion) named after the file and mirrored as `sessions/<group>/<session-id>/title.jsonl`: whenever the title Grok shows (`generated_title`, else `session_summary`), or the session's `session_kind`, is not that of the last line written out, one line holding the file's `info`, `generated_title`, `session_summary`, `title_is_manual`, `updated_at`, and `session_kind`, as stored. Its token is the file's size and modification time, so a turn that leaves the title as it was writes nothing; a file caught while Grok rewrites it is read again once it changes; and a stream written before its lines held `session_kind` is read once more, so that a sub-agent's line says what it is. The latest line's title is the session's, since Grok keeps a renamed title itself. A hub gets the same title from the mirror.
- Of the other files, only `updates.jsonl` is read. User and agent message chunks become `message` events; user messages that Grok hides from the transcript (`hideFromScrollback`, such as goal follow-ups) become `meta`. Thoughts, plans, and turn, task, and goal notices are skipped; the raw mirror keeps them. A `subagent_spawned` update yields no event. When `child_session_id` and `parent_session_id` are non-empty and differ, it records the child as a sub-agent of that parent (signal `subagent_spawned`; see [Parent sessions](architecture.md#parent-sessions)). A title line's `session_kind` says that a session is a sub-agent and names no parent. A parent that only `summary.json` records, in `parent_session_id`, is not in the mirror until `origin sessions parents` reads that file, read-only, and appends it.
- **Who wrote it:** every input of a sub-agent's session is the agent's, whether its parent's `subagent_spawned` update or its own title line's `session_kind` says so, whichever arrives first; a headless run's is the system's. Otherwise, in this order: a message Grok hides (`hideFromScrollback`) is the system's, as is one of a `hostTurn`, though it may have a `promptIndex`; one with a `promptIndex`, or an `interjection`, is the user's; any other is left to its text (see [Authors](architecture.md#authors)).
- A `tool_call` becomes a `tool_use` event (`<name> <input>`, at most 2,000 characters), with the name from `_meta["x.ai/tool"]` and server-side searches named `web_search`. The `tool_call_update` that carries `rawOutput` becomes its `tool_result` (the text, images, and diffs Grok shows, or else the raw output; at most 4,000 characters), noting `status` unless it is `completed`. Other `tool_call_update` lines only refine the call and are skipped.
- Event id: `grok:<session-id>:e<n>` for an `eventId` of the form `<session-id>-<n>`, otherwise `grok:<session-id>:<eventId>`, falling back to the line number.
- Timestamps come from `agentTimestampMs`, then `timestamp`. The cwd and project come from the group's name; sessions in a slug-and-hash group have none, since a hub never sees the `.cwd` file. Lines carry no Grok version, so events record the version installed when they are synced (`$GROK_HOME/version.json`).

## Native memories

Checked against the same versions as the sections above (October 2026). Origin reads the memory directories below as memory streams, one per directory, and imports each memory file as an entry; it never writes to them. How the files become events and entries is described in [architecture.md](architecture.md#native-memories).

| Source id | Memory directory | Files read | Mirrored as |
|---|---|---|---|
| `claude-code` | `~/.claude/projects/<cwd-slug>/memory/` | `*.md` but `MEMORY.md` | `memory/<cwd-slug>.jsonl` |
| `zcode` | `~/.zcode/cli/memories/projects/<name>-<hash>/memory/` | `*.md` but `MEMORY.md` | `memory/<name>-<hash>.jsonl` |
| `grok` | `$GROK_HOME/memory-v2/global/`, `$GROK_HOME/memory-v2/workspaces/<name>-<hash>/` | `topics/*.md`, `observations/_inbox/*.md` | `memory/v2/global.jsonl`, `memory/v2/workspaces/<name>-<hash>.jsonl` |
| `grok` | `$GROK_HOME/memory/`, `$GROK_HOME/memory/<name>-<hash>/` | `MEMORY.md` | `memory/v1/global.jsonl`, `memory/v1/<name>-<hash>.jsonl` |

Files over 256 KiB are not read. An entry's kind comes from the memory's type, where it has one: `user` and `feedback` (what the person is like, or asked for) give `cognition`, `project` gives `memory`, and `reference`, any other type, or none gives `knowledge`.

**Claude Code and ZCode** keep one Markdown file per memory, with YAML front matter, and an index, `MEMORY.md`, of one line per memory, which Origin does not read: the files say everything it says. For example (synthetic):

```markdown
---
name: small-commits
description: Prefers small commits, each with one purpose
metadata:
  type: feedback
  originSessionId: 3f2a9c1e-7b4d-4e8a-9c6b-1d2e3f4a5b6c
---

Split unrelated changes into separate commits.

**Why:** a commit with one purpose is easy to review and to revert.
```

- The front matter holds `name`, `description`, and `metadata` with the memory's `type` (a `type` at the top level is read too), and in Claude Code also `node_type`, `originSessionId` (the session that wrote it), and `modified`. The entry's text is the description, a blank line, and the body; its confidence is 0.9.
- Claude Code names the directory after its project's slug, which cannot be turned back into a path: the working directory, and the project (its last segment), come from the `cwd` recorded in the project's newest session logs.
- ZCode names the directory `<basename>-<hash>`, after its project's working directory: the basename is the directory's last segment, and the hash the first 16 hex digits of the SHA-256 of its lowercased path. Origin finds the working directory among those of ZCode's sessions that have this hash, and otherwise takes the name before the hash as the project.

**Grok Build** keeps memory in one of two layouts, both experimental.

- **Version 2** (`memory-v2/`) has a directory for global memories and one per workspace, named `<basename>-<hash>`. Grok captures *observations* from sessions with a model, into `observations/_inbox/`: front matter with `type`, `session_id`, `keywords`, `created_at`, and more, then a heading and a paragraph. Later it consolidates them into *topics*, `topics/*.md` (a heading, a one-line summary, and sections, without front matter), and moves the observations it consolidated to `archive/`. Each topic is a `knowledge` entry of its whole text, HTML comments left out, with confidence 0.9. Each observation in the inbox is an entry of its body, of the kind its `type` gives, with confidence 0.7; it ends when Grok moves it to the archive, which Origin does not read. `MEMORY.md` is an index Grok generates, and `index.sqlite` and `memory_state.sqlite` hold its own state, its own forgetting included; none of them is read. A workspace's working directory is that of the session one of its observations was captured from (its `session_id`, found among the session groups); without one, the project is the name before the hash. Global memories have no project.
- **Version 1** (`memory/`) kept the memories themselves in `MEMORY.md`, a global one and one per workspace. Each is a `knowledge` entry of its text, HTML comments left out, with confidence 0.9, unless it holds only headings and notes, like the template Grok writes. A workspace's working directory comes from its heading, `# Project Memory — <path>`.

**Codex** keeps memories under `~/.codex/memories/` when they are enabled, as summaries it merges itself; Origin does not read them yet. **Cursor** no longer keeps memories on disk.

## Files edited

A [daily digest](architecture.md#daily-digest) lists the files each session changed that day. No agent records that as such, so Origin reads it from the agent's tool calls, best effort and deterministically: from the calls of the tools below, the paths in their input. It reads them from the `tool_use` event's text (`<tool> <input>`, cut at 2,000 characters) with a pattern rather than a parser, so that a cut input still gives the paths before the cut, and a path the cut ends in is left out. A path under the session's working directory is shown relative to it, with `/` separators; any other as written. A call counts once for each path it names.

| Source id | Tools counted as file edits | Paths from | Failed calls |
|---|---|---|---|
| `claude-code` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | `file_path`; `notebook_path` for `NotebookEdit` | Left out when their result that day has `is_error` |
| `codex` | `apply_patch`: a custom tool call's patch, or the JSON `input` of a function call's arguments | The patch's `*** Add File:`, `*** Update File:`, `*** Delete File:`, and `*** Move to:` lines | Counted: an output records no failure Origin can read |
| `grok` | `search_replace` | `file_path` | Left out when their result that day has a `status` other than `completed` |
| `cursor` | `StrReplace`, in transcripts | `path` | Counted: transcripts hold no results |
| `zcode`, Cursor's editor conversations, your own sources | None | | |

Shell commands are never parsed, so a file a command changed is not listed, nor is a file another tool wrote. The ZCode and Cursor editor formats Origin was checked against show no edit tool it can rely on, and event lines name no tools Origin knows. Every tool call counts in the digest's tool counts, whatever its tool.

To register Origin with each agent, see [Connect your agents](guide/connect-agents.md).

## Your own sources: event lines

The agents above each have an adapter that reads their own logs. Anything else can bring its sessions to Origin in a format of Origin's own, **event lines**, which any script can write: another agent runtime, a chat workspace, a notification stream, a notes pipeline. One adapter reads every such source, as purely and deterministically as the others, and what it reads is treated like every other source's events.

A file of event lines is UTF-8 JSONL: one JSON object per line, one event each, only ever appended to. For example (synthetic):

```json
{"id":"m-1042","session":"standup-2026-11-02","time":"2026-11-02T09:30:00+08:00","role":"user","kind":"message","text":"Ship the retry fix before the demo.","project":"demo-app","branch":"retry-fix","title":"Standup, Nov 2","title_by":"user"}
```

| Field | Required | Value |
|---|---|---|
| `id` | yes | The event's id, unique within the source: 1 to 200 characters, no control characters. The event's id in Origin is `<source>:<id>` |
| `session` | yes | The session the event belongs to: 1 to 200 characters, no control characters |
| `time` | yes | When it happened: ISO 8601 with an offset, such as `2026-11-02T09:30:00Z` or `2026-11-02T17:30:00+08:00`, or epoch milliseconds as a number |
| `role` | yes | `user`, `assistant`, or `system` |
| `kind` | yes | `message`, `tool_use`, `tool_result`, `meta`, or `system`. `memory` is refused: it is reserved for the memory files agents keep for themselves |
| `text` | yes | The event's text, a string, kept as written |
| `project` | no | The project, by name. Naming it keeps that name, and a work tree does not replace it. Without one, the last segment of `cwd`, or the main work tree when this machine can see it (see [Projects](architecture.md#projects)) |
| `cwd` | no | The working directory, by which recall tells two checkouts with the same name apart |
| `branch` | no | The git branch, by which sessions of a project join a thread (see [Threads](architecture.md#threads)) |
| `parent` | no | The `id` of the line this one follows, as `get` shows it |
| `title` | no | The session's title as of this line; the latest one wins |
| `title_by` | no | `user` for a title the person gave, which later titles that are not also `user` do not replace; `agent`, the default, for a generated one |
| `author` | no | Who wrote a line whose `role` is `user` (see [Authors](architecture.md#authors)): `owner` for what the person whose memory this is wrote, `person` for another human, or one not known to be the owner, `agent` for an agent, `system` for a program. Without it, a `message` is a `person`'s and a `meta` event the `system`'s: a source states `owner` itself. Kept for messages and meta events; a tool result has its kind instead |
| `speaker` | no | Who said it, as people know them: a display name (`Alice`), an agent's name, or a label a transcriber gives (`Speaker 2`), 1 to 200 characters, without control characters; for a line whose `role` is `user`. Never an opaque id, such as a platform's user id: Origin shows it as it is, and identifies no one |
| `meta` | no | A JSON object, kept as the event's meta. A `callId` pairs a `tool_use` with its `tool_result` on a session's page in the admin UI |

**Origin mapping:**

- Each line is one event, with the line's `id` under the source's name (`<source>:<id>`), its `session`, its `time`, and the fields above. Lines are read as they are; nothing is truncated or cut into blocks.
- **Validation.** A line that is not a JSON object, lacks a required field, or has a field of the wrong type is a parse error, as is a `time` without an offset, a `kind` of `memory`, a `title_by` other than `user` or `agent`, an `author` other than the four, or on a line whose `role` is not `user`, and a `speaker` longer than 200 characters or with control characters: it is counted and yields nothing, it stays in the raw mirror, and the lines around it are read as usual. An optional field that is `null` or an empty string counts as absent. Fields Origin does not know are left in the raw mirror.
- **Ids.** A line whose event id the store already has adds nothing, so a line sent twice is ingested once. Give every event of a source its own `id`, whichever session it belongs to. A source is one across stores: on a hub, the sources of one name on several devices, and the lines appended to it there, share one space of ids.
- **Sessions and titles.** A session's events are those with its `session`, from any file of the source. Its title is that of its latest line with a `title`, except that a title not given by the person never replaces one that was, as for Claude Code.
- **Authors.** A line's `author` and `speaker` are its input's. Say `owner` only for what the person whose memory this is wrote, when the writer knows it: a chat bridge for their own account's messages, a notes pipeline for their notes. A recording whose transcriber labels speakers gives each line its `speaker`, and the owner's lines `author: owner` once the writer knows which label is theirs; a recording without speaker information says nothing, and its lines are a `person`'s.

For example (synthetic), a meeting transcribed with labels, whose writer knows that `Speaker 1` is the owner, and a voice memo transcribed without any:

```json
{"id":"sync-1104-0007","session":"weekly-sync-2026-11-04","time":"2026-11-04T10:04:12+08:00","role":"user","kind":"message","text":"Let's move the release to Friday.","speaker":"Speaker 2"}
{"id":"sync-1104-0008","session":"weekly-sync-2026-11-04","time":"2026-11-04T10:04:20+08:00","role":"user","kind":"message","text":"Friday works if QA signs off.","author":"owner","speaker":"Speaker 1"}
{"id":"memo-0042","session":"voice-memo-0042","time":"2026-11-04T18:30:00+08:00","role":"user","kind":"message","text":"Renew the domain before it lapses."}
```

The first line is a `person`'s, `Speaker 2`; the second the owner's; the third, which says nothing of who spoke, a `person`'s.

### On a device

Each directory under `~/.origin/sources/` (or `$ORIGIN_HOME/sources/`) is a source, named after the directory:

```
~/.origin/sources/
├── chat-ops/                 # the source chat-ops
│   ├── VERSION               # optional: the version of what writes it, on its first line
│   └── 2026/11/02.jsonl      # every .jsonl file below the directory, at any depth
└── notes/
    └── inbox.jsonl
```

- **Names.** 2 to 32 lowercase letters, digits, and hyphens, starting with a letter, other than the ids of the built-in sources above and `origin`, `hub`, `local`, `all`, and `devices`. A directory with another name is ignored, with a warning when Origin syncs. The directory may be a link to one elsewhere; links below it, to files or directories, are not followed.
- **Files.** Every `.jsonl` file below the directory, at any depth, oldest first; hidden files and directories (`.name`) are left out. Only complete lines are read, so a writer appends a whole line, ending with a line break, at a time. A file rewritten rather than appended to is mirrored again from its start as a new generation, as an agent's log would be, and its lines whose ids the source already has add nothing.
- **Version.** The first line of a `VERSION` file in the directory, if there is one, is recorded as the agent version of the events read after it.
- **Mirrors.** As for agents, under `raw/<name>/` with the files' paths in the directory. A device connected to a hub pushes them, and the hub keeps them as `raw/devices/<device>/<name>/…`; a relay sends the files' lines to the hub instead.
- **Reading.** `origin sync` reads every source, `origin sync --source <name>` one of them, and `origin mcp` looks for new lines every minute while an agent runs. There are no hooks.

### On a hub

A writer that runs on none of your devices, such as a bot or a runtime in the cloud, appends event lines to your hub instead, with a token of its own (see [Send lines to your hub](guide/sources.md#send-lines-to-your-hub)):

```
POST /v1/sources/<name>/lines?path=<path>
Authorization: Bearer <token>
Content-Type: application/x-ndjson
```

- **The file.** The lines go to the end of file `path` of the source `<name>`, as sent by the device the token is named after, and are mirrored as `raw/devices/<device>/<name>/<path>`. `path` is relative, made of `/`-separated parts of letters, digits, `.`, `_`, and `-`, each starting with a letter or digit, and ends in `.jsonl`; it has at most 200 characters. `<name>` follows the rules for names above.
- **The body.** Event lines, as `application/x-ndjson` or `text/plain`, possibly gzip-encoded, at most 8 MiB once decompressed. A last line without a line break ends with the body.
- **The answer.** `200 { "lines", "events", "duplicates", "parse_errors" }`: the lines read, the events they added, the lines whose events the hub already had, and the lines that are not valid events. Sending the same lines again is safe: they are mirrored again, as sent, and count as duplicates. `400` for an invalid name, path, or body, `401` without a valid token, `403` for a token that serves no device, `413` for a body too large, `415` for another media type.
