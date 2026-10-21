---
sourceHash: sha256-e8c7b11f
---

# 会话来源

各目标 Agent 把会话存放在磁盘上的什么位置，以及适配器需要了解的格式要点。这些格式是各 Agent 的实现细节，经常变化。每一节都注明了核对时所依据的版本；适配器必须记录 Agent 版本，并容忍未知的行。

| 来源 id | Agent | 状态 | 会话存储 | 格式 |
|---|---|---|---|---|
| `claude-code` | [Claude Code](https://code.claude.com) | **已支持** | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` | JSONL 事件流 |
| `codex` | [Codex CLI](https://developers.openai.com/codex) | **已支持** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` | JSONL rollout，首行为 `session_meta` |
| `cursor` | [Cursor](https://cursor.com) | 规划中 | CLI：`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`；IDE：`state.vscdb` | JSONL 消息块；SQLite 键值存储 |
| `zcode` | [ZCode](https://github.com/zai-org/ZCode) | 规划中 | `~/.zcode/cli/db/db.sqlite` | SQLite（关系型） |
| `grok` | [Grok Build](https://github.com/xai-org/grok-build) | 规划中 | `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` | 由 JSONL/JSON 文件组成的目录 |

这五个 Agent 也都维护各自的记忆，范围限定在单个仓库、项目或机器。这些原生记忆没有来源引用，因此 Origin 把它们视为可能的导入对象，而从不把它们当作事实来源。

## Claude Code {#claude-code}

核对版本：v2.1.x（2026 年 10 月）。文档：[记忆](https://code.claude.com/docs/en/memory)、[`.claude` 目录](https://code.claude.com/docs/en/claude-directory)。

- **位置：** `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`（`CLAUDE_CONFIG_DIR` 可覆盖 `~/.claude`）。子 Agent 记录位于 `<session-id>/subagents/agent-*.jsonl`，较大的工具输出位于 `tool-results/`。
- **格式：** 每行一个 JSON 对象。`type` 是 `user`、`assistant`、`summary`、`system`、`mode`、`permission-mode`、`file-history-snapshot` 等之一。消息行带有 `uuid`、`parentUuid`、`timestamp`、`cwd`、`gitBranch`、`sessionId`、`version` 和 `message { role, content }`；`content` 是一个字符串，或由 `text` / `tool_use` / `tool_result` / `thinking` / `image` 块组成的数组。
- **保留期：** 会话在 `cleanupPeriodDays`（默认 30）天后被删除。`memory/` 目录不受此限。
- **原生记忆：** `<cwd-slug>/memory/`——一个 `MEMORY.md` 索引，外加每条记忆一个带 frontmatter 的 Markdown 文件。范围限定在一台机器上的一个 git 仓库。

映射为 Origin 事件的方式见 [architecture.md](architecture.md#claude-code-mapping)。

## Codex CLI {#codex-cli}

核对依据：磁盘上的 codex-cli 0.154 与 `main` 分支源码（2026 年 10 月）。文档：[记忆](https://developers.openai.com/codex/memory)、[配置](https://developers.openai.com/codex/config-reference)；源码：[`codex-rs/protocol/src/models.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)（`ResponseItem`）、[`codex-rs/history`](https://github.com/openai/codex/tree/main/codex-rs/history)（`RolloutItem`）、[`codex-rs/rollout`](https://github.com/openai/codex/tree/main/codex-rs/rollout)。

- **位置：** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`（`CODEX_HOME` 默认为 `~/.codex`）；归档的会话会移到 `$CODEX_HOME/archived_sessions/`。文件名中的 uuid 就是会话（thread）id。一个后台任务会把不再活跃的 rollout 压缩为 `.jsonl.zst`。
- **格式：** 每行一个 `{ timestamp, ordinal, type, payload }` 对象；`ordinal` 在一个 rollout 内唯一。第一行是 `session_meta`（`id`、`cwd`、`originator`、`cli_version`、`model_provider`、`base_instructions`，约 20 KB）。其他类型：`response_item`（对话本身）、`event_msg`（重复 response item 内容的 UI 事件）、`turn_context`、`world_state`、`compacted` 等。
- **Response item：** `message`（角色为 `user`、`assistant` 或 `developer`；`content` 块为 `input_text` / `output_text` / `input_image`；助手消息可能带有 `phase`）、`reasoning`（摘要加上加密内容）、`function_call`（`name`、JSON 字符串形式的 `arguments`、`call_id`）、`custom_tool_call`（`input`，例如 `apply_patch`）、`local_shell_call`（`action.command`）、`web_search_call`、`function_call_output` / `custom_tool_call_output`（`output` 是字符串或内容块）、`compaction` 等。
- **注入的上下文：** Codex 会添加用单个标签包裹的 user 角色消息，例如 `<environment_context>…</environment_context>`。

**Origin 映射：**

- 用户和助手消息变成 `message` 事件；注入的用户消息变成 `meta`。developer 消息、reasoning、compaction 以及 `event_msg` 行会被跳过；原始镜像保留它们。
- 工具调用（`function_call`、`custom_tool_call`、`local_shell_call`、`web_search_call`）变成 `tool_use` 事件（`<name> <input>`，最多 2,000 个字符）。它们的输出变成 `tool_result` 事件（最多 4,000 个字符）。
- 事件 id：`codex:<session-id>:o<ordinal>`；对于没有 ordinal 的 rollout，先退回使用 item id，再退回使用行号。
- cwd、项目和 Agent 版本来自 `session_meta`。对于在之后某次同步中才采集的行，适配器会重新读取该 rollout 的第一行。
- `.jsonl.zst` 文件会被解压，并以普通 JSONL 的形式镜像。同一个 rollout 在压缩前后都被采集时，会产生相同的事件 id，因此事件不会重复。
- **原生记忆：** 默认关闭（`features.memories = true`）。存放在 `~/.codex/memories/` 下，范围限定在机器，分为两个阶段：先按 thread 生成 `raw_memory` / `rollout_summary`，再全局合并到 `MEMORY.md` 和 `memory_summary.md`。其中的条目引用各自的 rollout，并跟踪 `usage_count`；未被使用的记忆默认 30 天后过期。

## Cursor {#cursor}

核对依据：截至 2026 年 10 月的 Cursor CLI 更新日志与编辑器 3.x。文档：[CLI](https://cursor.com/docs/cli/overview)、[hooks](https://cursor.com/docs/hooks)、[CLI 更新日志](https://cursor.com/docs/cli/changelog)。

- **CLI 对话记录：** 官方文档没有指明路径。hooks 会收到 `transcript_path` / `CURSOR_TRANSCRIPT_PATH`。观察到的布局：`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`。每行是 `{"role":"user"|"assistant","message":{"content":[{"type":"text","text":…}]}}`，用户消息中嵌有 `<timestamp>` 和 `<user_query>` 标签。自 2026 年初起，无头模式的对话记录以与 Claude Code 兼容的 JSONL 写入。
- **编辑器对话：** 没有文档。在全局存储的 `state.vscdb`（SQLite）中，`cursorDiskKV` 表保存 `composerData:*` 对话正文，`composerHeaders` 保存元数据。该数据库处于 WAL 模式，必须以只读方式打开。
- **保留期：** 观察到的清理标记（`~/.cursor/projects/.agent-data-cleanup-<date>`）表明 CLI 数据会被定期清除。
- **命令名：** `agent` 是主要的 CLI 命令（`cursor-agent` 是它的别名）。其他工具可能会在 `PATH` 上安装另一个名为 `agent` 的程序，因此检测时不应只依赖名称。
- **原生记忆：** 编辑器的 Memories 功能已在 2.1.x 中移除；只有云端 Automations 仍保留一个 `MEMORIES.md`。

## ZCode {#zcode}

核对版本：v3.1x（2026 年 10 月）。源码：[zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）；文档：[zcode.z.ai](https://zcode.z.ai/en/docs/agents)。

- **位置：** `~/.zcode/cli/db/db.sqlite`（以及 `-wal` / `-shm`）。文档称 schema 属于实现细节，因此适配器应当对照源码核对。
- **格式：** SQLite 表 `session`（`id`、`project_id`、`parent_id`、`directory`、`title`、`version`、…）、`message`（`id`、`session_id`、`data`、`sequence`）和 `part`（`id`、`message_id`、`session_id`、`data`），另有 `todo`、`tool_usage`、`model_usage` 等。`data` 列保存 JSON。原始的模型输入输出还会写入 `~/.zcode/cli/rollout/model-io-*.jsonl`，子 Agent 的输出写入 `~/.zcode/cli/agents/<session>/<agent>/`。
- **定位：** SQLite 来源没有行号，因此原始定位必须是表名加主键，并以只追加的方式镜像。
- **原生记忆：** 默认关闭。`~/.zcode/cli/memories/projects/<project>/memory/` 使用与 Claude Code 相同的 `MEMORY.md` 布局。

## Grok Build {#grok-build}

核对版本：1.0.4x（2026 年 9–10 月）。源码：[xai-org/grok-build](https://github.com/xai-org/grok-build)（Apache-2.0）；文档：[docs.x.ai/build](https://docs.x.ai/build/overview) 以及仓库内的用户指南（`17-sessions.md`、`13-memory.md`）。

- **位置：** `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`（`GROK_HOME` 可覆盖 `~/.grok`）。会话 id 是 UUIDv7。
- **格式：** 每个会话一个目录。`updates.jsonl` 是权威记录（一个 ACP session-update 流）。`chat_history.jsonl` 保存发送给模型的原始消息，`summary.json` 保存标题、时间戳、模型、消息数和父会话。该目录还包含 `system_prompt.txt`、`plan.json`、`rewind_points.jsonl`、`compaction_checkpoints/` 和 `subagents/`。
- **原生记忆：** 实验性功能，默认关闭（`GROK_MEMORY=1`）。以 Markdown 形式存放在 `~/.grok/memory/` 下（全局的 `MEMORY.md`，加上按 git remote 哈希区分的各工作区目录），或者存放在 `~/.grok/memory-v2/` 下。
- **互通：** Grok 会合并 `~/.claude.json` 和 `.mcp.json` 中的 MCP server，因此为 Claude Code 注册 Origin 之后，Grok 也能使用它。

如何为每个 Agent 注册 Origin，见[接入 Agent](guide/connect-agents.md)。
