---
sourceHash: sha256-ab2c1c58
---

# 会话来源

各目标 Agent 把会话存放在磁盘上的什么位置，以及适配器需要了解的格式要点。这些格式是各 Agent 的实现细节，经常变化。每一节都注明了核对时所依据的版本；适配器必须记录 Agent 版本，并容忍未知的行。

| 来源 id | Agent | 状态 | 会话存储 | 格式 |
|---|---|---|---|---|
| `claude-code` | [Claude Code](https://code.claude.com) | **已支持** | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | JSONL 事件流 |
| `codex` | [Codex CLI](https://developers.openai.com/codex) | **已支持** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | JSONL rollout，首行为 `session_meta` |
| `cursor` | [Cursor](https://cursor.com) | **已支持** | CLI：`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`；IDE：`state.vscdb` | JSONL 消息块；SQLite 键值存储 |
| `zcode` | [ZCode](https://github.com/zai-org/ZCode) | **已支持** | `~/.zcode/cli/db/db.sqlite` | SQLite（关系型） |
| `grok` | [Grok Build](https://github.com/xai-org/grok-build) | **已支持** | `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl` | JSONL 格式的 ACP session-update 流 |
| `<name>` | 你自己的：任何写事件行的程序 | **已支持** | `~/.origin/sources/<name>/**/*.jsonl` | 事件行，见[你自己的来源](#your-own-sources-event-lines) |

这五个 Agent 也都维护各自的记忆，范围限定在单个仓库、项目或机器。Origin 把 Claude Code、ZCode 和 Grok Build 的记忆文件导入为条目（见[原生记忆](#native-memories)）；这些文件不引用任何来源，所以导入的条目引用的是它所来自的那个文件版本。

## Claude Code {#claude-code}

核对版本：v2.1.x（2026 年 10 月）。文档：[记忆](https://code.claude.com/docs/en/memory)、[`.claude` 目录](https://code.claude.com/docs/en/claude-directory)。

- **位置：** `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`（`CLAUDE_CONFIG_DIR` 可覆盖 `~/.claude`）。子 Agent 记录位于 `<session-id>/subagents/agent-*.jsonl`，较大的工具输出位于 `tool-results/`。这些记录不指明父会话，Origin 也不会从中记录父会话（见[父会话](architecture.md#parent-sessions)）。
- **格式：** 每行一个 JSON 对象。`type` 是 `user`、`assistant`、`ai-title`、`custom-title`、`agent-name`、`last-prompt`、`summary`、`system`、`mode`、`permission-mode`、`file-history-snapshot`、`attachment` 等之一。消息行带有 `uuid`、`parentUuid`、`timestamp`、`cwd`、`gitBranch`、`sessionId`、`version` 和 `message { role, content }`；`content` 是一个字符串，或由 `text` / `tool_use` / `tool_result` / `thinking` / `image` 块组成的数组。
- **标题：** `{ type: "ai-title", aiTitle, sessionId }` 是 Claude Code 生成的标题，大约每一轮都会再写一次，并随着对话的进行而改变；最新的一行就是当前的标题。用户给出的名称（`/rename`、`--name`、hook 的 `sessionTitle`、Agent SDK 的 `renameSession()`）是一行 `{ type: "custom-title", customTitle, sessionId }`，同样会被再次写入，并且优先于 AI 生成的标题，即使它后面还有 `ai-title` 行。`{ type: "agent-name", agentName, sessionId }` 是会话在 Claude Code 的 Agent 视图中的名称；它出现在会话自己的记录中，而不只是子 Agent 的记录中，并且重复 AI 生成的标题或自定义标题。`{ type: "last-prompt", lastPrompt, leafUuid, sessionId }` 记录最近的一条提示。2.1 之前的版本写入的则是 `{ type: "summary", summary, leafUuid }` 行。
- **谁写的**（按 2.1.303 核对，2026 年 11 月）：user 行在 `origin.kind` 中说明是谁发出的：`human` 表示用户输入的内容，`task-notification` 表示后台任务的通知，`peer` 或 `coordinator` 表示另一个 Agent 的消息，那个 Agent 的名字在 `origin.name` 中，id 在 `origin.from` 中。`promptSource` 说明提示是怎样输入的（`typed`、`queued`、`system`、`sdk`）。压缩写下的摘要是一条标有 `isCompactSummary` 的用户消息。子 Agent 的行标有 `isSidechain`，位于 `subagents/` 下的记录中；无界面运行（`claude -p`、Agent SDK）的每一行都记录 `sdk-cli` 或其他 `sdk-*` 形式的 `entrypoint`（否则是 `cli`）。更早的版本既不记录 `origin`，也不记录 `promptSource`。
- **排队的提示：** 用户在 Agent 忙碌时发出的提示，写成一行 `attachment`，其中的 `attachment` 带有 `type` 为 `queued_command`、`prompt`（一个字符串，或文本和图片块）、`commandMode` 为 `prompt`，以及 `origin.kind` 为 `human`；Claude Code 把它交给正在进行的那一轮，不为它写 user 行。后台任务的通知也这样排队，`origin.kind` 为 `task-notification`，交给子 Agent 的消息也是如此。
- **保留期：** 会话在 `cleanupPeriodDays`（默认 30）天后被删除。`memory/` 目录不受此限。
- **Hook**（2026 年 11 月核对，[hooks](https://code.claude.com/docs/en/hooks)）：命令 hook 在标准输入上读取一个 JSON 事件，其中有 `session_id`、`transcript_path`（会话的记录文件）、`cwd` 和 `hook_event_name`；`SubagentStop` 还有 `agent_id`、`agent_type` 和 `agent_transcript_path`，即 `subagents/` 下子 Agent 的记录文件。记录文件是异步写入的，所以一轮的 `Stop` hook 运行时，文件里可能还没有这一轮的最后几行。带 `"async": true` 的 hook 在后台运行，Claude Code 不等待它；所有 `SessionEnd` hook 共用 1.5 秒。Origin 的采集 hook 在 `Stop`、`SubagentStop` 和 `PostCompact` 时运行（见[实时采集](architecture.md#live-ingestion)）。
- **原生记忆：** `<cwd-slug>/memory/`——一个 `MEMORY.md` 索引，外加每条记忆一个带 frontmatter 的 Markdown 文件。范围限定在一台机器上的一个 git 仓库。会被导入，见[原生记忆](#native-memories)。

映射为 Origin 事件的方式见 [architecture.md](architecture.md#claude-code-mapping)。

## Codex CLI {#codex-cli}

核对依据：磁盘上的 codex-cli 0.154 与 `main` 分支源码（2026 年 10 月）。文档：[记忆](https://developers.openai.com/codex/memory)、[配置](https://developers.openai.com/codex/config-reference)；源码：[`codex-rs/protocol/src/models.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)（`ResponseItem`）、[`codex-rs/history`](https://github.com/openai/codex/tree/main/codex-rs/history)（`RolloutItem`）、[`codex-rs/rollout`](https://github.com/openai/codex/tree/main/codex-rs/rollout)。

- **位置：** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`（`CODEX_HOME` 默认为 `~/.codex`）；归档的会话会移到 `$CODEX_HOME/archived_sessions/`。文件名中的 uuid 就是会话（thread）id。一个后台任务会把不再活跃的 rollout 压缩为 `.jsonl.zst`。
- **格式：** 每行一个 `{ timestamp, ordinal, type, payload }` 对象；`ordinal` 在一个 rollout 内唯一。第一行是 `session_meta`（`id`、`cwd`、`originator`、`cli_version`、`model_provider`、`base_instructions`，约 20 KB，以及 `source`，即启动会话的是什么：`cli`、`vscode`、表示 `codex exec` 的 `exec`、`mcp`，或者 Codex 启动的子 Agent 的对象，例如 `{ "subagent": { "thread_spawn": { "parent_thread_id": …, "depth": … } } }`）。其他类型：`response_item`（对话本身）、`event_msg`（重复 response item 内容的 UI 事件）、`turn_context`、`world_state`、`compacted` 等。
- **Response item：** `message`（角色为 `user`、`assistant` 或 `developer`；`content` 块为 `input_text` / `output_text` / `input_image`；助手消息可能带有 `phase`）、`reasoning`（摘要加上加密内容）、`function_call`（`name`、JSON 字符串形式的 `arguments`、`call_id`）、`custom_tool_call`（`input`，例如 `apply_patch`）、`local_shell_call`（`action.command`）、`web_search_call`、`function_call_output` / `custom_tool_call_output`（`output` 是字符串或内容块）、`compaction` 等。
- **注入的上下文：** Codex 会添加用单个标签包裹的 user 角色消息，例如 `<environment_context>…</environment_context>`。0.154 的用户消息在 `internal_chat_message_metadata_passthrough.content_item_kinds` 中说明它由什么组成：`user.text` 表示用户输入的内容，`environments.environment_context` 表示上面那种上下文。
- **Hook**（2026 年 11 月核对，[hooks](https://developers.openai.com/codex/hooks)）：`~/.codex/hooks.json`，或 `config.toml` 中的 `[hooks]`，事件和字段与 Claude Code 相同：`session_id`（子 Agent 的 hook 得到的是父会话的 id）、`transcript_path`（会话的 rollout，或 null）、`cwd` 和 `hook_event_name`，`SubagentStop` 时还有 `agent_transcript_path`（或 null）。`"async": true` 让 hook 在后台运行；`SessionEnd` hook 只有 1 秒。新的或改动过的 hook，只有在用户用 `/hooks` 信任之后 Codex 才会运行，信任时记录的是 hook 的哈希。Origin 的采集 hook 在 `Stop` 和 `SubagentStop` 时运行。

**Origin 映射：**

- 用户和助手消息变成 `message` 事件；注入的用户消息变成 `meta`。developer 消息、reasoning、compaction 以及 `event_msg` 行会被跳过；原始镜像保留它们。
- **谁写的：** `session_meta` 指明是子 Agent（`source` 为 `{ "subagent": … }`）的会话是子会话，它的输入全部属于 Agent；`codex exec` 的会话是无界面运行，它的输入全部属于系统。其他情况下，`content_item_kinds` 含有 `user.text` 的用户消息属于用户，不含的属于系统；没有这个字段的 rollout 交由消息的类型和正文决定（见[作者](architecture.md#authors)）。其他 source（`cli`、`vscode`、`mcp` 等）不会让会话成为子会话或无界面运行。
- **它的父会话：** 当 `source.subagent` 是对象，且 `thread_spawn.parent_thread_id` 是非空字符串时，这个 id 就是父会话，`via` 为 `subagent`，信号为 `parent_thread_id`，父会话的来源是 `codex`（见[父会话](architecture.md#parent-sessions)）。`source.subagent` 只是一个字符串时，仍然把会话标为子会话，但不指明父会话。
- 工具调用（`function_call`、`custom_tool_call`、`local_shell_call`、`web_search_call`）变成 `tool_use` 事件（`<name> <input>`，最多 2,000 个字符）。它们的输出变成 `tool_result` 事件（最多 4,000 个字符）。
- 事件 id：`codex:<session-id>:o<ordinal>`；对于没有 ordinal 的 rollout，先退回使用 item id，再退回使用行号。
- cwd、项目和 Agent 版本来自 `session_meta`。对于在之后某次同步中才采集的行，适配器会重新读取该 rollout 的第一行。
- `.jsonl.zst` 文件会被解压，并以普通 JSONL 的形式镜像。同一个 rollout 在压缩前后都被采集时，会产生相同的事件 id，因此事件不会重复。
- **原生记忆：** 默认关闭（`features.memories = true`）。存放在 `~/.codex/memories/` 下，范围限定在机器，分为两个阶段：先按 thread 生成 `raw_memory` / `rollout_summary`，再全局合并到 `MEMORY.md` 和 `memory_summary.md`。其中的条目引用各自的 rollout，并跟踪 `usage_count`；未被使用的记忆默认 30 天后过期。尚未导入。

## Cursor {#cursor}

核对依据：磁盘上的编辑器 3.25，以及截至 2026 年 10 月的 Cursor CLI 更新日志。文档：[CLI](https://cursor.com/docs/cli/overview)、[hooks](https://cursor.com/docs/hooks)、[CLI 更新日志](https://cursor.com/docs/cli/changelog)。

- **对话记录（transcript）：** 官方文档没有指明路径。hooks 会收到 `transcript_path` / `CURSOR_TRANSCRIPT_PATH`。观察到的布局：`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`，其中 slug 是把工作目录的分隔符换成 `-` 得到的（因此无法从它还原目录）。每行是带有 `text` 和 `tool_use`（`name`、`input`）块的 `{"role":"user"|"assistant","message":{"content":[…]}}`，或者一个 `{"type":"turn_ended"}` 标记；没有 id，没有工具结果，也没有时间戳，只有用户消息里嵌着的 `<timestamp>`（精确到分钟，带 UTC 偏移）和 `<user_query>` 标签。编辑器里的 Agent 也会以对话的 id 为对话写对话记录。自 2026 年初起，无头模式的对话记录以与 Claude Code 兼容的 JSONL 写入。
- **编辑器对话：** 没有文档。在编辑器的全局存储中（Windows 上是 `%APPDATA%\Cursor\User\globalStorage\state.vscdb`，macOS 上是 `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`，Linux 上是 `~/.config/Cursor/User/globalStorage/state.vscdb`；SQLite），键值表 `cursorDiskKV` 保存 `composerData:<conversation>`（它的 `name`、`createdAt`、`lastUpdatedAt`、`status`、`generatingBubbleIds`、`workspaceIdentifier.uri.fsPath`，以及 `fullConversationHeadersOnly`，即它显示的消息按顺序排列的 id），每条消息一个 `bubbleId:<conversation>:<bubble>`（`type` 为 1 是用户、为 2 是 Agent，`text`、`createdAt`，Cursor 自己写的用户消息带有 `isSimulatedMsg` 和 `simulatedMsgReason`，以及 `toolFormerData`，带有工具调用的 `name`、`params`、`result`、`status` 和 `error`）。值会被原地改写。这张表里还有对话已不再显示的消息，大多是已显示消息的副本；数据库的其他表里还存着凭据，所以只以只读方式打开，并且只读这些键。
- **保留期：** 观察到的清理标记（`~/.cursor/projects/.agent-data-cleanup-<date>`）表明 CLI 数据会被定期清除。
- **命令名：** `agent` 是主要的 CLI 命令（`cursor-agent` 是它的别名）。其他工具可能会在 `PATH` 上安装另一个名为 `agent` 的程序，因此检测时不应只依赖名称。
- **原生记忆：** 编辑器的 Memories 功能已在 2.1.x 中移除；只有云端 Automations 仍保留一个 `MEMORIES.md`。
- **Hook**（2026 年 11 月对照磁盘上的 3.27 版编辑器核对，见 [hooks](https://cursor.com/docs/hooks)）：`~/.cursor/hooks.json` 的 `version` 为 1，在每个事件下以 `{ command, timeout }` 列出 hook，超时以秒计。每个事件都带有 `conversation_id`（对话在编辑器数据库和它的 transcript 中的 id）、`generation_id`、`hook_event_name`（Cursor 的 camelCase 名称）、`cursor_version`、`workspace_roots`（各工作区文件夹 URI 的路径，在 Windows 上是 `/c:/…`）、`user_email` 和 `transcript_path`，没有 `cwd`；子 Agent 的事件还带有 `parent_agent_id`。`beforeSubmitPrompt` 还带有 `prompt` 和 `attachments`，并从 hook 的输出中读取 `additional_context`。`sessionStart` 在对话创建期间运行，不等待它，它返回的内容只有在对话届时已经就绪时才会保留。Cursor 也会运行 `~/.claude/settings.json` 中的 hook，在它自己的事件上（`SessionStart` 在 `sessionStart`，`UserPromptSubmit` 在 `beforeSubmitPrompt`），传入同样的字段。Origin 的召回 hook 在 `beforeSubmitPrompt` 运行（见[召回](architecture.md#recall)）。

**Origin 映射：**

- 每个编辑器对话是一个[生成的来源](architecture.md#ingestion)，命名为 `<database>#<conversation>`。它显示的每条消息按创建顺序、在不再生成时（或者对话一小时没有变化之后）写出一次，写成一行：消息的键和值保持存储时的原样，再加上对话的 `composerId`、`name`、`createdAt`、`lastUpdatedAt` 和 `workspaceIdentifier`。消息的文本变成 `message` 事件；工具调用变成一个 `tool_use` 事件（`<name> <params>`，最多 2,000 个字符）和一个 `tool_result` 事件（它的结果或错误，最多 4,000 个字符），`status` 不是 `completed` 时会记下。事件 id：`cursor:<conversation>:<bubble>`，工具调用加 `#1`，其结果加 `#2`。cwd 是对话的工作区文件夹，标题是对话的名称。
- 对话在编辑器数据库里的对话记录会被跳过：保留编辑器的记录，它带有工具结果和准确的时间。其他对话记录作为文件采集：文本块变成 `message` 事件（用户消息取 `<user_query>` 里的文本），`tool_use` 块变成 `tool_use` 事件。用户消息的时间是它的 `<timestamp>`，回复的时间取它之前那条提示。事件 id 为 `cursor:<uuid>:L<line>-<hash>`，由行号和该行 SHA-256 的前 8 个十六进制字符组成，工具调用再加 `#<block>`。对话记录没有 cwd，它们的项目是 slug。
- 行里不带 Cursor 的版本，所以事件记录的是已安装编辑器的版本。
- **谁写的：** 编辑器标有 `isSimulatedMsg` 的用户消息属于系统。其他用户消息，无论来自编辑器还是对话记录，都没有更多说明，交由它们的正文决定（见[作者](architecture.md#authors)）。
- **没有父会话。** 对话记录和编辑器对话都不指明会话是从哪个会话开始的，Origin 也不记录（见[父会话](architecture.md#parent-sessions)）。

## ZCode {#zcode}

核对依据：磁盘上 3.1x 版应用的数据库，其中的会话由它的 CLI 0.16 写入（2026 年 10 月）。源码：[zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）；文档：[zcode.z.ai](https://zcode.z.ai/en/docs/agents)。

- **位置：** `~/.zcode/cli/db/db.sqlite`，WAL 模式（以及 `-wal` / `-shm`）。文档称 schema 属于实现细节；`schema_migration` 表记录了它的迁移。
- **格式：** SQLite 表 `session`（`id`、`project_id`、`parent_id`、`directory`、`title`、`version`、`task_type`、…）、`message`（`id`、`session_id`、`sequence`、`time_created`、`time_updated`、`data`）和 `part`（`id`、`message_id`、`session_id`、`sequence`、`time_created`、`time_updated`、`data`），另有 `todo`、`tool_usage`、`model_usage`、工作流相关的表等。`sequence` 给一个会话的消息、一条消息的部件排序。`data` 保存 JSON：消息的 `role`、`time`（`created`，回复结束后还有 `completed`）、`error`、`path.cwd`、`semantics.transcriptVisibility`（ZCode 为模型添加的提醒、通知和摘要为 `hidden`）、`semantics.origin`，即用户消息是谁写的（`real_user`；ZCode 自己添加的则为 `agent_runtime` 和 `system`），以及 `semantics.kind`（`user_prompt`、`todo_reminder`、`background_notification`、`compact_summary`、…）；部件的 `type`（`text`、`reasoning`、`tool`、`file`、`step-start`、`step-finish`、`timeline`、`compaction`），文本部件带 `text` 和 `synthetic`，工具部件带 `tool`、`callID` 和 `state`（`status`、`input`、`output` 或 `error`、`time`）。子 Agent 和工作流步骤作为带有 `parent_id` 的独立会话运行：会话的 `task_type` 为 `interactive` 表示与用户的对话，`selection_side_chat` 表示就某段选中内容开的旁聊，`subagent_child` 和 `workflow_child` 表示子 Agent 和工作流步骤的会话，ZCode 照样把它们的提示标为 `real_user`。原始的模型输入输出还会写入 `~/.zcode/cli/rollout/model-io-*.jsonl`。
- **行会被原地修改：** 回复流式输出时，它的消息和部件会改变；ZCode 压缩会话时，过了很久的部件也会再变。
- **Hook**（2026 年 11 月对照 3.17 版应用及其 0.17 版 CLI 核对，见 [hooks](https://zcode.z.ai/en/docs/hooks)）：`~/.zcode/cli/config.json` 中的 `hooks.events` 在每个事件下列出 matcher 组，与 Claude Code 相同；只有 `hooks.enabled` 为 true 时 ZCode 才运行它们，默认不是。它的 schema 很严格，只要拒绝一项，就会关掉所有 hook：`command` hook 接受 `type`、`command`、`timeoutMs`（默认 60 秒）和少数几个选项，不接受 `args`，那只属于 `process` hook。事件带有 Claude Code 的字段 `hook_event_name`、`session_id`（会话的 id，与数据库中一致）、`permission_mode` 和 `transcript_path`（ZCode 为 hook 写的临时文件，不是会话的日志），旁边是它自己的 `hookEventName`、`sessionId`、`agentName`、`cwd`、`mode`、`model`，在 `SessionStart` 还有 `source`（`startup` 或 `resume`）；`UserPromptSubmit` 还带有 `prompt` 和 `attachmentsSummary`。hook 在子 Agent 的会话和工作流步骤的会话中也会运行，它们的 id 是 `sess_subagent_agent_<uuid>` 和 `sess_dwf-<run>-<actor>`。ZCode 读取 `hookSpecificOutput.additionalContext`（带上它所问的 `hookEventName`）或顶层的 `additionalContext`，忽略普通输出。`SessionStart` 在会话第一轮之前运行，会话恢复时再运行一次。每个 hook 都会得到 `ZCODE_SESSION_ID` 和 `ZCODE_PROJECT_DIR`，以及 Claude Code 对应的变量名。

**Origin 映射：**

- 每个会话是一个[生成的来源](architecture.md#ingestion)，命名为 `<database>#<session-id>`。每条消息在稳定之后写出一次（用户消息在它的部件写入之后，回复在完成或失败之后，任何消息在会话已经越过它、或者已经有 `ORIGIN_ZCODE_SETTLE_MS` 毫秒没有变化之后（默认一小时，`3600000`）），写成一行：消息的行、它所有部件的行，以及会话的 `id`、`parent_id`、`directory`、`title`、`version` 和 `task_type`，每一列都保持存储时的原样。当 `dwf_actor` 指明这个会话时，这一行还带有 `workflow`：该 actor 的 `dwf_run`（`id`、`name`、`resumed_from`）以及 `group`，即 `resumed_from` 链的根，在写出这一行时沿链走完。不读取 `workflow_run`。数据库仍以只读方式打开。写出之后消息再有变化，不会再镜像。
- **它的父会话：** 非空且不是会话自身的 `parent_id`。`workflow_child` 的 `via` 是 `workflow`，`subagent_child` 的是 `subagent`；信号是 `parent_id`，除非这一行带有 `workflow`，那时信号是 `dwf_run`，运行的名称被保留，分组在设置了 `workflow.group` 时用它，在 `resumed_from` 为 null 时用 `workflow.id`（见[父会话](architecture.md#parent-sessions)）。行里没有的分组留空，直到 `origin sessions parents` 再次只读地读取 `dwf_run` 并把它追加进去。
- 文本部件变成 `message` 事件；隐藏消息里的文本，或标记为 `synthetic` 的文本，变成 `meta`。文件部件变成 `[image]` 或 `[file]`。
- **谁写的：** `task_type` 为 `subagent_child` 或 `workflow_child` 的会话，它的每条输入都属于 Agent。其他情况下由用户消息的 `semantics.origin` 决定：`real_user` 属于用户，`agent_runtime` 和 `system` 属于系统；ZCode 隐藏起来的旁聊提示也属于用户，作为 `meta` 事件，只是不算提示。工具部件变成一个 `tool_use` 事件（`<tool> <input>`，最多 2,000 个字符）和一个 `tool_result` 事件（它的输出或错误，最多 4,000 个字符），`status` 不是 `completed` 时会记下。reasoning、步骤标记、时间线通知和压缩标记会被跳过；镜像保留它们。
- 事件 id：`zcode:<session-id>:<消息 sequence>.<部件 sequence>`，工具的结果加 `#1`。
- 时间戳取自部件自己的时间，其次是它所在的行。cwd 取自消息的 `path.cwd`，其次是会话的目录；标题和 ZCode 版本取自会话。
- **原生记忆：** 默认关闭。`~/.zcode/cli/memories/projects/<project>-<hash>/memory/` 使用与 Claude Code 相同的 `MEMORY.md` 布局。会被导入，见[原生记忆](#native-memories)。

## Grok Build {#grok-build}

核对依据：磁盘上的 1.0.41（2026 年 10 月）。源码：[xai-org/grok-build](https://github.com/xai-org/grok-build)（Apache-2.0）；文档：[docs.x.ai/build](https://docs.x.ai/build/overview) 以及仓库内的用户指南（`17-sessions.md`、`07-mcp-servers.md`、`13-memory.md`）。

- **位置：** `$GROK_HOME/sessions/<group>/<session-id>/`（`GROK_HOME` 默认为 `~/.grok`）。group 是 URL 编码后的工作目录；编码后超过 255 字节时，Grok 改用 slug 加哈希命名，并把原路径记在 `.cwd` 文件里。会话 id 是 UUIDv7，客户端也可以用 `-s` 指定自己的 id。`sessions/` 下还有 Grok 自己的 `session_search.sqlite`。
- **格式：** 每个会话一个目录。`updates.jsonl` 是权威记录，一个 ACP session-update 流，每行一个 `{ method, params: { sessionId, update, _meta }, timestamp }` 对象：`method` 是 `session/update` 或 `_x.ai/session/update`，`timestamp` 以秒为单位，`_meta` 带有 `eventId`（在文件内唯一，大多是 `<session-id>-<n>`）和 `agentTimestampMs`。`update.sessionUpdate` 是 `user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`turn_completed`、`background_tasks`、`subagent_spawned`、`subagent_finished`、`goal_updated` 或其他类型。在磁盘上，每个消息块都是一整条消息。
- **其他文件：** `chat_history.jsonl` 保存发送给模型的消息，不带时间戳；`events.jsonl` 是遥测（阶段、工具耗时）；`summary.json` 保存标题、时间戳、模型和消息数。目录里还有 `system_prompt.txt`、`plan.json`、`rewind_points.jsonl`、`compaction_checkpoints/` 和 `subagents/`。从未有过对话的会话没有 `updates.jsonl`。
- **子 Agent** 作为独立会话，存放在同一棵目录树里。父会话的记录用一条 `subagent_spawned` 更新（`child_session_id`、`parent_session_id`、`subagent_type`）点名它启动的每个子 Agent，子 Agent 的 `summary.json` 在 `session_kind` 中说明自己是什么：`subagent`、`subagent_fork` 或 `subagent_resume`，无界面运行则为 `headless`；用户运行的会话没有这个字段。`agent_name` 是运行会话的 Agent 的名称：用户运行的会话是 `grok-build-plan`，子 Agent 是它的类型（`explore`、`general-purpose`）。
- **消息是谁写的：** 用户消息的 `_meta` 说明它是怎样来的：`promptIndex`，它在会话的提示中的序号；`interjection`，在一轮进行中发出；`hostTurn`，由 Grok 的宿主发起的一轮；`hideFromScrollback`，不放进对话记录，用于 Grok 自己发出的后续提示，Grok 照样把它们编进提示的序号。子 Agent 的提示也有 `promptIndex`。
- **标题：** `summary.json` 是一个 JSON 对象，每一轮都被原地重写：`info`（`id`、`cwd`）、`generated_title`、`session_summary`、`title_is_manual`、`created_at`、`updated_at`、`num_messages`、`agent_name`、`session_kind` 等。`generated_title` 保存 Grok 显示的标题：在第一条提示之后生成，并在最初的几轮中再生成一两次；或者是用 `/rename` 给出的标题，它会设置 `title_is_manual`，此后自动标题不再改动它，直到 `/rename --auto` 把它清空。`session_summary` 为较旧的客户端镜像这个标题，并在 `generated_title` 为空时显示。
- **原生记忆：** 实验性功能，默认关闭（`GROK_MEMORY=1`）。以 Markdown 形式存放在 `~/.grok/memory/` 下（全局的 `MEMORY.md`，加上按 git remote 哈希区分的各工作区目录），或者存放在 `~/.grok/memory-v2/` 下。会被导入，见[原生记忆](#native-memories)。
- **Hook**（2026 年 11 月对照 1.0.70 版及其用户指南的 `10-hooks.md` 核对）：除了自己的 hook，Grok 默认还会运行 `~/.claude/settings.json` 中的 hook，以及 `~/.cursor/hooks.json` 中按 matcher 组写的 hook；Cursor 自己格式的项，它列为暂时无法运行的 hook。在 `~/.grok/config.toml` 的 `[compat.claude]` 或 `[compat.cursor]` 下写 `hooks = false` 可以停止这样做。事件带有 camelCase 字段 `hookEventName`（Grok 的 snake_case 名称）、`sessionId`、`cwd`、`workspaceRoot` 和 `permissionMode`，旁边是 Claude Code 的 snake_case 字段（`hook_event_name`，用 Claude 的名称，`session_id`、`transcript_path`……），每个 hook 都会得到 `GROK_HOOK_EVENT`、`GROK_SESSION_ID` 和 `GROK_WORKSPACE_ROOT`。在 `SessionStart`，Grok 只读取 `systemMessage`，把它显示出来，不交给模型；在 `UserPromptSubmit`，放行的 hook 输出的内容会被丢弃。所以 hook 交不出任何内容给它的模型；Origin 不为它添加 hook，Grok 自己调用 `brief`。
- **互通：** Grok 默认合并 `~/.claude.json`、Cursor 的 `mcp.json` 和项目 `.mcp.json` 中的 MCP server，因此为 Claude Code 注册 Origin 之后，Grok 也能使用它。`grok inspect` 列出合并后的 server；`grok mcp list` 只显示 Grok 自己配置的。

**Origin 映射：**

- 会话的标题来自它的 `summary.json`，通过一个以该文件命名、镜像为 `sessions/<group>/<session-id>/title.jsonl` 的[生成的来源](architecture.md#ingestion)读取：每当 Grok 显示的标题（`generated_title`，为空时是 `session_summary`）或会话的 `session_kind` 与上一次写出的那一行不同，就写出一行，按原样保存该文件的 `info`、`generated_title`、`session_summary`、`title_is_manual`、`updated_at` 和 `session_kind`。它的令牌是文件的大小和修改时间，所以标题没有变化的一轮什么也不会写出；读到 Grok 正在重写的文件时，会在它再次改变后重新读取；在行中还不含 `session_kind` 时写出的流会再读取一次，好让子 Agent 的行说明它是什么。最新一行的标题就是会话的标题，因为 Grok 自己保留改名后的标题。中枢从镜像中得到同样的标题。
- 在其他文件中，只读取 `updates.jsonl`。用户和 Agent 的消息块变成 `message` 事件；Grok 在对话记录里隐藏的用户消息（`hideFromScrollback`，例如目标的后续提示）变成 `meta`。思考、计划，以及轮次、任务和目标的通知会被跳过；原始镜像保留它们。`subagent_spawned` 更新不产生事件。当 `child_session_id` 和 `parent_session_id` 都非空且彼此不同时，它把这个子会话记录为该父会话的子 Agent（信号 `subagent_spawned`；见[父会话](architecture.md#parent-sessions)）。标题行的 `session_kind` 说明某个会话是子 Agent，并不指明父会话。只有 `summary.json` 的 `parent_session_id` 记录的父会话，要等 `origin sessions parents` 只读地读取这个文件并追加之后，才会进入镜像。
- **谁写的：** 子 Agent 会话的每条输入都属于 Agent，无论是父会话的 `subagent_spawned` 更新还是它自己标题行的 `session_kind` 先说明这一点；无界面运行的输入属于系统。其他情况下依次为：Grok 隐藏的消息（`hideFromScrollback`）属于系统，`hostTurn` 的消息也属于系统，即使它们可能带有 `promptIndex`；带有 `promptIndex` 或 `interjection` 的消息属于用户；其余的交由正文决定（见[作者](architecture.md#authors)）。
- `tool_call` 变成 `tool_use` 事件（`<name> <input>`，最多 2,000 个字符），名称取自 `_meta["x.ai/tool"]`，服务端搜索命名为 `web_search`。带有 `rawOutput` 的 `tool_call_update` 变成它的 `tool_result`（Grok 显示的文本、图片和 diff，没有时用原始输出；最多 4,000 个字符），`status` 不是 `completed` 时会记下。其他 `tool_call_update` 行只是在细化这次调用，会被跳过。
- 事件 id：`eventId` 形如 `<session-id>-<n>` 时为 `grok:<session-id>:e<n>`，否则为 `grok:<session-id>:<eventId>`，没有时退回使用行号。
- 时间戳取自 `agentTimestampMs`，其次是 `timestamp`。cwd 和项目来自 group 的名称；slug 加哈希命名的 group 里的会话没有 cwd，因为中枢看不到 `.cwd` 文件。行里不带 Grok 的版本，所以事件记录的是同步时已安装的版本（`$GROK_HOME/version.json`）。

## 原生记忆 {#native-memories}

核对版本与上面各节相同（2026 年 10 月）。Origin 把下面这些记忆目录作为记忆流读取，每个目录一条，并把每个记忆文件导入为一个条目；它从不写入这些目录。文件如何变成事件和条目，见 [architecture.md](architecture.md#native-memories)。

| 来源 id | 记忆目录 | 读取的文件 | 镜像为 |
|---|---|---|---|
| `claude-code` | `~/.claude/projects/<cwd-slug>/memory/` | 除 `MEMORY.md` 外的 `*.md` | `memory/<cwd-slug>.jsonl` |
| `zcode` | `~/.zcode/cli/memories/projects/<name>-<hash>/memory/` | 除 `MEMORY.md` 外的 `*.md` | `memory/<name>-<hash>.jsonl` |
| `grok` | `$GROK_HOME/memory-v2/global/`、`$GROK_HOME/memory-v2/workspaces/<name>-<hash>/` | `topics/*.md`、`observations/_inbox/*.md` | `memory/v2/global.jsonl`、`memory/v2/workspaces/<name>-<hash>.jsonl` |
| `grok` | `$GROK_HOME/memory/`、`$GROK_HOME/memory/<name>-<hash>/` | `MEMORY.md` | `memory/v1/global.jsonl`、`memory/v1/<name>-<hash>.jsonl` |

超过 256 KiB 的文件不会读取。条目的类型取自记忆的类型（如果有）：`user` 和 `feedback`（这个人是什么样的、提出过什么要求）对应 `cognition`，`project` 对应 `memory`，`reference`、其他类型或没有类型对应 `knowledge`。

**Claude Code 和 ZCode** 为每条记忆保存一个带 YAML front matter 的 Markdown 文件，另有一个每条记忆一行的索引 `MEMORY.md`，Origin 不读取它：它说的内容，各个文件里都有。例如（虚构的示例）：

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

- front matter 包含 `name`、`description`，以及带有记忆 `type` 的 `metadata`（写在顶层的 `type` 也会读取）；Claude Code 还会写入 `node_type`、`originSessionId`（写下这条记忆的会话）和 `modified`。条目的正文是描述、一个空行，再加上正文部分；置信度为 0.9。
- Claude Code 以项目的 slug 命名这个目录，而 slug 无法还原为路径：工作目录以及项目（工作目录的最后一段）取自该项目最新的会话记录中记下的 `cwd`。
- ZCode 以项目的工作目录命名这个目录，形如 `<basename>-<hash>`：basename 是该目录的最后一段，hash 是其小写路径的 SHA-256 的前 16 个十六进制字符。Origin 在 ZCode 各会话的目录中找出具有这个 hash 的工作目录；找不到时，以 hash 之前的名称作为项目。

**Grok Build** 的记忆有两种布局，都是实验性的。

- **第 2 版**（`memory-v2/`）有一个存放全局记忆的目录，每个工作区还各有一个，命名为 `<basename>-<hash>`。Grok 用模型从会话中捕获*观察*（observation），放进 `observations/_inbox/`：front matter 带有 `type`、`session_id`、`keywords`、`created_at` 等，接着是一个标题和一段文字。之后它把观察整合进*主题*，即 `topics/*.md`（一个标题、一行摘要和若干小节，没有 front matter），并把已整合的观察移到 `archive/`。每个主题是一个 `knowledge` 条目，正文是去掉 HTML 注释后的全文，置信度为 0.9。收件箱中的每条观察是一个条目，正文是它的正文部分，类型由它的 `type` 决定，置信度为 0.7；当 Grok 把它移到归档中时，这个条目就结束了，Origin 不读取归档。`MEMORY.md` 是 Grok 生成的索引，`index.sqlite` 和 `memory_state.sqlite` 保存它自己的状态（包括它自己的遗忘）；这些都不会读取。工作区的工作目录，取自它的某条观察被捕获时所在的会话（观察的 `session_id`，在各会话分组中查找）；找不到时，项目为 hash 之前的名称。全局记忆没有项目。
- **第 1 版**（`memory/`）把记忆本身保存在 `MEMORY.md` 中：一个全局的，每个工作区各一个。每个都是一个 `knowledge` 条目，正文是去掉 HTML 注释后的文本，置信度为 0.9；只有标题和引用说明的文件除外，例如 Grok 写入的模板。工作区的工作目录取自它的标题 `# Project Memory — <path>`。

**Codex** 启用记忆后，把记忆保存在 `~/.codex/memories/` 下，形式是它自己合并的摘要；Origin 尚未读取它们。**Cursor** 已不再在磁盘上保存记忆。

## 编辑过的文件 {#files-edited}

[每日摘要](architecture.md#daily-digest)列出每个会话在这一天里改动过的文件。没有哪个 Agent 直接记录这一点，所以 Origin 从 Agent 的工具调用中读取，尽力而为、结果确定：取自下面这些工具的调用，即它们输入中的路径。Origin 用模式匹配而不是解析器，从 `tool_use` 事件的文本（`<tool> <input>`，截到 2,000 个字符）中读取路径，所以被截断的输入仍能给出截断之前的路径，而截断处所在的那条路径会被略去。位于会话工作目录之下的路径显示为相对于它的路径，用 `/` 分隔；其他路径按原样显示。一次调用中写到的每条路径各计一次。

| 来源 id | 算作编辑文件的工具 | 路径取自 | 失败的调用 |
|---|---|---|---|
| `claude-code` | `Edit`、`MultiEdit`、`Write`、`NotebookEdit` | `file_path`；`NotebookEdit` 为 `notebook_path` | 当天的结果带有 `is_error` 时略去 |
| `codex` | `apply_patch`：自定义工具调用的补丁，或函数调用参数中 JSON 的 `input` | 补丁中的 `*** Add File:`、`*** Update File:`、`*** Delete File:` 和 `*** Move to:` 行 | 计入：输出中没有 Origin 能读出的失败标记 |
| `grok` | `search_replace` | `file_path` | 当天的结果带有 `completed` 以外的 `status` 时略去 |
| `cursor` | `StrReplace`，在 transcript 中 | `path` | 计入：transcript 中没有结果 |
| `zcode`、Cursor 编辑器中的对话、你自己的来源 | 无 | | |

从不解析 shell 命令，所以命令改动过的文件不会列出，其他工具写过的文件也不会。Origin 核对过的 ZCode 和 Cursor 编辑器的格式中，没有它能够依靠的编辑工具；事件行中也没有 Origin 认识的工具名称。无论是什么工具，每次工具调用都计入摘要的工具计数。

如何为每个 Agent 注册 Origin，见[接入 Agent](guide/connect-agents.md)。

## 你自己的来源：事件行 {#your-own-sources-event-lines}

上面每个 Agent 都有一个读取其自身记录的适配器。其他任何东西都可以用 Origin 自己的一种格式把会话带进 Origin，这种格式叫**事件行**，任何脚本都能写：另一个 Agent 运行时、一个聊天工作区、一条通知流、一条笔记流水线。所有这样的来源都由同一个适配器读取，它和其他适配器一样纯粹、确定；它读到的内容和其他来源的事件一样对待。

一个事件行文件是 UTF-8 的 JSONL：每行一个 JSON 对象，每个对象一个事件，只追加、不改写。例如（合成数据）：

```json
{"id":"m-1042","session":"standup-2026-11-02","time":"2026-11-02T09:30:00+08:00","role":"user","kind":"message","text":"Ship the retry fix before the demo.","project":"demo-app","branch":"retry-fix","title":"Standup, Nov 2","title_by":"user"}
```

| 字段 | 必需 | 取值 |
|---|---|---|
| `id` | 是 | 事件的 id，在该来源内唯一：1 到 200 个字符，不含控制字符。事件在 Origin 中的 id 是 `<source>:<id>` |
| `session` | 是 | 事件所属的会话：1 到 200 个字符，不含控制字符 |
| `time` | 是 | 事件发生的时间：带时区偏移的 ISO 8601，例如 `2026-11-02T09:30:00Z` 或 `2026-11-02T17:30:00+08:00`，或者以数字表示的 epoch 毫秒 |
| `role` | 是 | `user`、`assistant` 或 `system` |
| `kind` | 是 | `message`、`tool_use`、`tool_result`、`meta` 或 `system`。`memory` 会被拒绝：它留给 Agent 为自己保存的记忆文件 |
| `text` | 是 | 事件的文本，一个字符串，按原样保存 |
| `project` | 否 | 项目名。写了它就保留这个名字，工作树不会替换它。没有时取 `cwd` 的最后一段；这台机器能看到工作树时，则取主工作树（见[项目](architecture.md#projects)） |
| `cwd` | 否 | 工作目录，召回据此区分两个同名的检出 |
| `branch` | 否 | git 分支，同一项目的会话据此加入同一条线索（见[线索](architecture.md#threads)） |
| `parent` | 否 | 这一行所接续的那一行的 `id`，`get` 会显示它 |
| `title` | 否 | 截至这一行时会话的标题；以最新的为准 |
| `title_by` | 否 | `user` 表示由本人给出的标题，之后不是 `user` 的标题不会替换它；默认值 `agent` 表示生成的标题 |
| `author` | 否 | `role` 为 `user` 的行是谁写的（见[作者](architecture.md#authors)）：`owner` 表示这份记忆的主人写的，`person` 表示另一个人，或不知道是不是主人的人，`agent` 表示某个 Agent，`system` 表示某个程序。没有它时，`message` 属于某个人（person），`meta` 事件属于系统：`owner` 要由来源自己说明。用于消息和 meta 事件；工具结果由它的类型说明 |
| `speaker` | 否 | 是谁说的，用人们认识的名字：显示名（`Alice`）、某个 Agent 的名字，或转写工具给的标签（`Speaker 2`），1 到 200 个字符，不含控制字符；用于 `role` 为 `user` 的行。绝不能是不透明的 id，例如平台的用户 id：Origin 会原样显示它，也不识别任何人 |
| `meta` | 否 | 一个 JSON 对象，作为事件的 meta 保存。`callId` 在管理界面的会话页上把 `tool_use` 与它的 `tool_result` 配成一对 |

**Origin 映射：**

- 每一行是一个事件，id 是该行的 `id` 加上来源名（`<source>:<id>`），带有它的 `session`、`time` 和上面的各字段。行按原样读取，不截断，也不拆成块。
- **校验。** 不是 JSON 对象、缺少必需字段，或某个字段类型不对的行，都是解析错误；没有时区偏移的 `time`、`memory` 类的 `kind`、取值不是 `user` 或 `agent` 的 `title_by`、不在四种取值之内或出现在 `role` 不是 `user` 的行上的 `author`，以及超过 200 个字符或含控制字符的 `speaker` 也是：这一行会被计数，不产生任何内容，仍然留在原始镜像中，它前后的行照常读取。取值为 `null` 或空字符串的可选字段视同没有。Origin 不认识的字段留在原始镜像中。
- **Id。** 事件 id 已在存储中的行不会新增任何内容，所以同一行发送两次只会采集一次。请让一个来源的每个事件都有自己的 `id`，无论它属于哪个会话。一个来源在各个库之间是同一个：在中枢上，几台设备上同名的来源，以及在那里追加给它的行，共用同一个 id 空间。
- **会话与标题。** 一个会话的事件是该来源任意文件中带有这个 `session` 的事件。它的标题取自带 `title` 的最新一行，但不是由本人给出的标题永远不会替换本人给出的标题，这与 Claude Code 相同。
- **作者。** 一行的 `author` 和 `speaker` 属于它的输入。只有写入者知道是这份记忆的主人写的内容，才标为 `owner`：例如聊天桥接写主人自己账号的消息，笔记流水线写主人的笔记。转写工具给说话人加了标签的录音，为每一行给出它的 `speaker`，并在写入者知道哪个标签是主人之后，把主人的行标为 `author: owner`；没有说话人信息的录音什么也不说明，它的行属于某个人（person）。

例如（合成数据），一场按标签转写的会议，写入者知道 `Speaker 1` 是主人；以及一条没有任何说话人信息的语音备忘：

```json
{"id":"sync-1104-0007","session":"weekly-sync-2026-11-04","time":"2026-11-04T10:04:12+08:00","role":"user","kind":"message","text":"Let's move the release to Friday.","speaker":"Speaker 2"}
{"id":"sync-1104-0008","session":"weekly-sync-2026-11-04","time":"2026-11-04T10:04:20+08:00","role":"user","kind":"message","text":"Friday works if QA signs off.","author":"owner","speaker":"Speaker 1"}
{"id":"memo-0042","session":"voice-memo-0042","time":"2026-11-04T18:30:00+08:00","role":"user","kind":"message","text":"Renew the domain before it lapses."}
```

第一行属于某个人（person），`Speaker 2`；第二行属于主人；第三行没有说明是谁说的，属于某个人（person）。

### 在设备上 {#on-a-device}

`~/.origin/sources/`（或 `$ORIGIN_HOME/sources/`）下的每个目录都是一个来源，以目录名命名：

```
~/.origin/sources/
├── chat-ops/                 # the source chat-ops
│   ├── VERSION               # optional: the version of what writes it, on its first line
│   └── 2026/11/02.jsonl      # every .jsonl file below the directory, at any depth
└── notes/
    └── inbox.jsonl
```

- **名称。** 由 2 到 32 个小写字母、数字和连字符组成，以字母开头，并且不是上面内置来源的 id，也不是 `origin`、`hub`、`local`、`all` 和 `devices`。其他名称的目录会被忽略，Origin 同步时会给出警告。目录可以是指向别处某个目录的链接；目录之下指向文件或目录的链接不会被跟随。
- **文件。** 目录下任意深度的每个 `.jsonl` 文件，最旧的在前；隐藏的文件和目录（`.name`）不读取。只读取完整的行，所以写入者每次追加一整行，以换行符结尾。被重写而不是被追加的文件，会像 Agent 的记录一样，作为新的一代从头重新镜像，其中 id 已在该来源中的行不会新增任何内容。
- **版本。** 如果目录中有 `VERSION` 文件，它的第一行会被记录为此后读取的事件的 Agent 版本。
- **镜像。** 与 Agent 相同，位于 `raw/<name>/` 下，路径与文件在目录中的路径相同。接入中枢的设备会推送它们，中枢把它们保存为 `raw/devices/<device>/<name>/…`；中继则把这些文件的行直接发送给中枢。
- **读取。** `origin sync` 读取所有来源，`origin sync --source <name>` 只读其中一个，Agent 运行期间 `origin mcp` 每分钟查看一次新增的行。没有 hook。

### 在中枢上 {#on-a-hub}

不在你任何设备上运行的写入者，例如机器人或云端的运行时，改为用自己的令牌向你的中枢追加事件行（见[把行发给你的中枢](guide/sources.md#send-lines-to-your-hub)）：

```
POST /v1/sources/<name>/lines?path=<path>
Authorization: Bearer <token>
Content-Type: application/x-ndjson
```

- **文件。** 这些行追加到来源 `<name>` 的文件 `path` 末尾，视为令牌所属设备发送的内容，镜像为 `raw/devices/<device>/<name>/<path>`。`path` 是相对路径，由 `/` 分隔的若干部分组成，每部分由字母、数字、`.`、`_` 和 `-` 组成并以字母或数字开头，以 `.jsonl` 结尾，最多 200 个字符。`<name>` 遵循上面的命名规则。
- **请求体。** 事件行，类型为 `application/x-ndjson` 或 `text/plain`，可以用 gzip 编码，解压后最多 8 MiB。没有换行符的最后一行以请求体结尾为界。
- **回答。** `200 { "lines", "events", "duplicates", "parse_errors" }`：读到的行数、它们新增的事件数、事件已在中枢上的行数，以及不是有效事件的行数。再次发送同样的行是安全的：它们会按发送的样子再镜像一次，并计为重复。名称、路径或请求体无效时返回 `400`，没有有效令牌返回 `401`，令牌不服务于任何设备返回 `403`，请求体过大返回 `413`，媒体类型不对返回 `415`。
