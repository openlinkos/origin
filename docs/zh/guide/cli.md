# 命令参考

```text
origin sync      [--source <id>] [--verbose]          采集本机 Agent 会话（幂等，可随时重跑）
origin status                                          各来源统计、条目数与上次采集时间
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                单个会话的事件（默认不含工具事件）
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id>                                  显示条目或事件，以及它的原始来源
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> [--reason <text>] [--yes]        永久遗忘条目或事件（需加 --yes 确认）
origin projects                                        已知的项目名
origin mcp                                             以 stdio 运行 MCP server（供 Agent 使用）
```

- **时间参数**：相对时长（`30m`、`24h`、`7d`、`2w`）或日期（`YYYY-MM-DD`、ISO 8601）。
- **来源 id**：`claude-code` 与 `codex`（`cursor`、`zcode`、`grok` 将随适配器上线）。
- **条目类型**：`memory`（发生过什么）、`knowledge`（稳定的事实）、`cognition`（你的偏好、方法、目标与边界）。
- **id 形式**：条目如 `ent_5f0c2a9e41b7`；事件如 `claude-code:<uuid>` 或 `codex:<session>:o12`。
- CLI 输出为英文。

## 检索

`search` 同时检索条目和会话消息，默认按相关度排序。加 `--recent` 改为按时间排序，加 `--all` 会把工具调用及其输出也纳入检索。中文同样支持子串检索。

## 查看

`show` 显示条目及其来源与版本历史；对事件则显示原始定位：原文件、镜像文件与行号，以及原文行。

## 纠正与遗忘

`correct` 会为条目添加一个新版本，旧版本保留为历史。`forget` 会先列出影响范围，加 `--yes` 才真正执行。遗忘规则见[隐私与数据](./privacy.md#遗忘)。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Origin 的数据库与原始镜像目录 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置目录（会话从 `<dir>/projects` 读取） |
| `ORIGIN_CLAUDE_PROJECTS` | — | 直接指定 Claude Code 的 projects 目录 |
| `CODEX_HOME` | `~/.codex` | Codex 的主目录（从 `sessions/` 与 `archived_sessions/` 读取会话） |
