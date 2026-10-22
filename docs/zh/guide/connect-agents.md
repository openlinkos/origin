---
sourceHash: sha256-d0264f33
---

# 接入 Agent

所有 Agent 启动的都是同一个 stdio server：`node <仓库>/packages/cli/dist/bin.js mcp`。把下文的 `/path/to/origin` 换成你本地仓库的绝对路径。请在全局（而不是单个项目）注册，让所有项目共享同一份记忆。

| Agent | 会话归档 | 通过 MCP 使用 Origin | 接入验证 |
|---|---|---|---|
| Claude Code | ✅ | ✅ | 端到端 |
| Codex CLI | ✅ | ✅ | 已注册 |
| Cursor | 规划中 | ✅ | 依据 Cursor 文档 |
| ZCode | 规划中 | ✅ | 依据 ZCode 文档 |
| Grok Build | 规划中 | ✅ | 依据 Grok 文档 |

## Claude Code {#claude-code}

```bash
claude mcp add --scope user origin -- node /path/to/origin/packages/cli/dist/bin.js mcp
claude mcp list
```

## Codex CLI {#codex-cli}

```bash
codex mcp add origin -- node /path/to/origin/packages/cli/dist/bin.js mcp
```

它会在 `~/.codex/config.toml` 中写入：

```toml
[mcp_servers.origin]
command = "node"
args = ["/path/to/origin/packages/cli/dist/bin.js", "mcp"]
```

## Cursor {#cursor}

`~/.cursor/mcp.json`（编辑器与 CLI 共用）：

```json
{
  "mcpServers": {
    "origin": { "command": "node", "args": ["/path/to/origin/packages/cli/dist/bin.js", "mcp"] }
  }
}
```

## ZCode {#zcode}

在 `~/.zcode/cli/config.json` 的 `mcp.servers` 下添加该 server，或使用 ZCode 从 Claude Code / Codex 导入 MCP 配置的功能。

## Grok Build {#grok-build}

Grok 会读取 `~/.claude.json`，所以完成上面的 Claude Code 注册后会自动生效；否则仿照 Codex，在 `~/.grok/config.toml` 中添加 `[mcp_servers.origin]`。

## Agent 能做什么 {#what-agents-can-do}

| 工具 | 作用 |
|---|---|
| `search` | 全文检索条目与会话事件，按相关度排序；不带查询词时列出最近的条目 |
| `timeline` | 某个时间段内的会话，或单个会话内的消息 |
| `get` | 条目及其来源与历史，或事件的完整正文 |
| `sources` | 条目或事件背后的原始记录行 |
| `remember` | 保存一条引用来源的条目（`memory`、`knowledge` 或 `cognition`） |
| `correct` | 用纠正后的版本替换条目 |
| `forget` | 永久遗忘条目或事件；只有你明确要求时 Agent 才会使用 |

server 会告诉 Agent 如何使用这些工具，你只需用自然语言提问。它在回答前会同步新的会话记录，所以 Agent 甚至能引用你一分钟前说的话。工具的完整说明见[架构](../architecture.md#mcp-server)。

## 使用个人中枢 {#using-a-personal-hub}

如果你在多台机器上使用 Agent，或者使用云端 Agent，可以运行一个[个人中枢](./hub.md)：

- 已接入中枢的设备上，上面这些本地 `origin mcp` 注册照常可用：server 根据设备自己的库作答，补充中枢的回答，并把 Agent 保存的内容同步到中枢。
- 云端 Agent 没有本地会话记录，用各自的令牌直接注册中枢的 `/mcp` 地址。例如在 Claude Code 中：`claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"`。

## 更新 Origin 之后 {#after-updating-origin}

Agent 从你的本地仓库启动 server。拉取新代码并运行 `pnpm build` 后，请重启正在运行的 Agent 会话，以加载新版本。
