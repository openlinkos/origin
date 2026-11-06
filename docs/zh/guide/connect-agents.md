---
sourceHash: sha256-81d122fd
---

# 接入 Agent

所有 Agent 启动的都是同一个 stdio server：`origin mcp`，`npm install -g @openlinkos/origin` 会把它放到你的 `PATH` 里。在 Windows 上，npm 把 `origin` 装成一个 `.cmd` 脚本，Agent 无法直接启动它，请改为注册 `cmd /c origin mcp`，例如 `claude mcp add --scope user origin -- cmd /c origin mcp`（在 Git Bash 里要在前面加上 `MSYS_NO_PATHCONV=1`，否则 Git Bash 会把 `/c` 改写成 `C:/`）。请在全局（而不是单个项目）注册，让所有项目共享同一份记忆。

| Agent | 会话归档 | 通过 MCP 使用 Origin | 接入验证 |
|---|---|---|---|
| Claude Code | ✅ | ✅ | 端到端 |
| Codex CLI | ✅ | ✅ | 已注册 |
| Cursor | ✅ | ✅ | 依据 Cursor 文档 |
| ZCode | ✅ | ✅ | 依据 ZCode 文档 |
| Grok Build | ✅ | ✅ | 已注册 |

其他程序，例如另一个 Agent 运行时、聊天机器人或笔记流水线，也可以通过写事件行带来它们的会话；见[接入你自己的来源](./sources.md)。OpenClaw 有一个替它写事件行的插件：见[接入 OpenClaw](./openclaw.md)。

## 一次接好所有 Agent {#connect-them-all-at-once}

`origin agents` 显示这台机器上装了哪些 Agent，以及每个是怎样接入的。`origin agents connect` 把 Origin 的 MCP server 注册到其中每一个，并加上两类 hook：[召回](./recall.md) hook，在会话开始时和每个提示时把有用的内容交给 Agent，加给 Claude Code、Codex、ZCode 和 Cursor；以及采集 hook，在每一轮结束时于后台把会话新增的行交给 Origin，让其他会话和你的中枢马上就能看到，加给 Claude Code 和 Codex。它先显示会改什么，加上 `--yes` 才真的修改，每个文件改之前都会在旁边备份；它只添加和删除 Origin 自己的那一项，`origin agents disconnect` 会把它们去掉。写出 Agent 的名字就只处理这些，例如 `origin agents connect codex`。在用早先版本接入过的机器上，再运行一次即可补上缺少的 hook。

改完之后，为每个 Agent 开始一个新会话。Codex 只有在你信任新的或改动过的 hook 之后才会运行它：在 Codex 里打开 `/hooks`，检查 Origin 的 hook 并信任它们；在此之前，Codex 会跳过它们，并在启动时给出提醒；Codex 还没有信任任何 hook 时，`origin agents` 会显示它们尚未被信任。ZCode 只在 `~/.zcode/cli/config.json` 中 `hooks.enabled` 为 true 时运行 hook，默认是关闭的：Origin 的 hook 是那里仅有的 hook 时，`origin agents connect` 会把它打开；否则交给你决定，因为打开后你的其他 hook 也会运行，`origin agents` 会显示 Origin 的 hook 处于关闭状态。

```console
$ origin agents connect
origin agents connect would:
  codex: register the MCP server in /home/dana/.codex/config.toml
  codex: add the recall hooks (SessionStart, UserPromptSubmit) to /home/dana/.codex/hooks.json
  codex: add the ingest hooks (Stop, SubagentStop) to /home/dana/.codex/hooks.json
  cursor: register the MCP server in /home/dana/.cursor/mcp.json
  cursor: add the recall hooks (beforeSubmitPrompt) to /home/dana/.cursor/hooks.json

Run again with --yes to make these changes; each file is backed up next to it first.
```

Claude Code 的采集 hook 设在 `Stop`、`SubagentStop` 和 `PostCompact`，Codex 的设在 `Stop` 和 `SubagentStop`；ZCode 的召回 hook 设在 `SessionStart` 和 `UserPromptSubmit`，Cursor 的设在 `beforeSubmitPrompt`；它们写下的样子都见[召回](./recall.md#set-up-the-hooks)。Grok Build 不加 hook：会话开始时和随提示，它都不读取 hook 交出的任何内容，而是自己请求简报。Cursor、ZCode 和 Grok Build 运行期间，新增的行由 `origin mcp` 每分钟收取一次，`origin sync` 也会收取。

下面各节说明它为每个 Agent 写入了什么，方便手动设置。

## Claude Code {#claude-code}

```bash
claude mcp add --scope user origin -- origin mcp
claude mcp list
```

## Codex CLI {#codex-cli}

```bash
codex mcp add origin -- origin mcp
```

它会在 `~/.codex/config.toml` 中写入：

```toml
[mcp_servers.origin]
command = "origin"
args = ["mcp"]
```

## Cursor {#cursor}

`~/.cursor/mcp.json`（编辑器与 CLI 共用），`~/.cursor/hooks.json` 也是如此，它的召回 hook 放在那里（见[召回](./recall.md#set-up-the-hooks)）：

```json
{
  "mcpServers": {
    "origin": { "command": "origin", "args": ["mcp"] }
  }
}
```

## ZCode {#zcode}

在 `~/.zcode/cli/config.json` 的 `mcp.servers` 下添加该 server，或使用 ZCode 从 Claude Code / Codex 导入 MCP 配置的功能。它的召回 hook 也放在这个文件中，见[召回](./recall.md#set-up-the-hooks)。

## Grok Build {#grok-build}

Grok 默认合并 `~/.claude.json` 中的 MCP server，所以完成上面的 Claude Code 注册后会自动生效，`grok inspect` 能看到它（`grok mcp list` 只显示 Grok 自己配置的 server）；否则仿照 Codex，在 `~/.grok/config.toml` 中添加 `[mcp_servers.origin]`。

## Agent 能做什么 {#what-agents-can-do}

| 工具 | 作用 |
|---|---|
| `brief` | Agent 工作之处有用的内容：你的偏好、项目的决定和事实，以及它最近的会话（[召回](./recall.md)） |
| `search` | 全文检索条目与会话事件，按相关度排序；不带查询词时列出最近的条目 |
| `timeline` | 某个时间段内的会话，或单个会话内的消息，一次一轮或一页 |
| `changes` | 自 Agent 上次查看以来到达库中的内容：会话、事件、条目和遗忘，一次一页 |
| `digest` | 一天的概览：这一天的会话，连同你的提示、调用的工具和编辑过的文件，以及这一天里写下、提议和遗忘的条目（[digest](./mcp.md#digest)） |
| `get` | Origin 交出的任意 id，连同它近旁的内容：条目及其来源与历史，事件及其正文和前后的事件，会话及其各轮和从中写下的条目，线索及其会话，召回及其交出的内容，或提议及其来源与状态 |
| `sources` | 条目或事件背后的原始记录行 |
| `follow` | 把 Agent 的会话接到它所接续的早先会话或线索上，让这件工作读起来是一条[线索](./concepts.md#threads) |
| `remember` | 保存一条引用来源的条目（`memory`、`knowledge` 或 `cognition`） |
| `propose` | 不直接保存，而是把一条条目交给你审阅，用于 Agent 推断出、你还没有确认的内容；只有你能接受或拒绝它（[propose](./mcp.md#propose)） |
| `correct` | 用纠正后的版本替换条目 |
| `forget` | 在每个库中隐藏条目或事件，并附上你的原因；只有你明确要求时 Agent 才会使用，也只有你能恢复 |

server 会告诉 Agent 如何使用这些工具，你只需用自然语言提问。它在回答前会同步新的会话记录，所以 Agent 甚至能引用你一分钟前说的话。Claude Code 和 Codex 的采集 hook 会在每一轮结束时把这一轮新增的行交给 Origin；作为后备，也为了其他 Agent，Agent 运行期间 Origin 还会在后台每分钟收取一次新的记录行，并在 Agent 退出时再收取一次。工具的完整说明见[架构](../architecture.md#mcp-server)。Origin 还会把 Agent 工作之处有用的内容交给它：Claude Code、Codex、ZCode 和 Cursor 通过它们的 hook，在每个会话开始时和每个提示时；其他 Agent 通过 `brief`。见[召回](./recall.md)。

## 使用个人中枢 {#using-a-personal-hub}

如果你在多台机器上使用 Agent，或者使用云端 Agent，可以运行一个[个人中枢](./hub.md)：

- 已接入中枢的设备上，上面这些本地 `origin mcp` 注册照常可用：server 根据设备自己的库作答，补充中枢的回答，并把 Agent 保存的内容同步到中枢。
- 没有本地会话记录的 Agent，例如在云端机器上运行的 Agent，直接注册中枢的 `/mcp` 地址。中枢在 `/admin` 下提供[管理界面](./admin.md)时，Claude Code 和 Codex 通过你的浏览器用 OAuth 登录它；其他 Agent 使用令牌。

### 用 OAuth 登录 {#sign-in-with-oauth}

Claude Code：

```bash
claude mcp add --scope user --transport http origin https://hub.example.com/mcp
claude mcp login origin
```

`claude mcp add` 只保存中枢，并不登录。要登录，可以在命令行中运行 `claude mcp login origin`，它会在你的浏览器里打开中枢；也可以在 Claude Code 里运行 `/mcp` 并选择 `origin`。在没有浏览器的机器上，例如通过 SSH 时，`claude mcp login origin --no-browser` 会改为打印链接：在你自己的电脑上打开它，再把浏览器最后停留的地址粘贴回来（请用 `ssh -t` 连接，因为粘贴需要终端）。

Codex CLI：

```bash
codex mcp add origin --url https://hub.example.com/mcp
codex mcp login origin
```

在浏览器中，如果还没有登录中枢的管理界面，请先登录，然后中枢会询问是否允许这个 Agent。页面显示 Agent 的名称、之后浏览器会回到哪里（对于你电脑上的 Agent，是 `localhost` 加一个端口），并让你选择这个 Agent 能做什么（读写或只读）以及有效多久（1 到 365 天）。允许之后，Agent 会收到它的令牌：一个有效期一小时的访问令牌，它用刷新令牌不断续期，直到你选择的期限为止。Agent 以自己的名称（例如 `claude-code`）出现在管理界面的**设备和 Agent**页面，你可以随时在那里吊销它，它写入的内容也以这个名称记为作者。`claude mcp logout origin` 也会让 Claude Code 在中枢上退出登录；单独运行 `claude mcp remove origin` 只会让 Claude Code 忘掉这个中枢，所以还请在中枢上吊销这个 Agent。

两个 Agent 都能自己弄清楚如何登录：中枢对不带令牌的请求的回答，会把它们指向中枢的 OAuth 元数据（遵循 MCP 授权规范，使用 PKCE）。Claude Code 用 claude.ai 上的一份文档描述自己，Codex 用 chatgpt.com 上的一份，中枢通过 https 获取这些文档，所以中枢需要能访问这两个地址；没有这类文档的 Agent 则改为向中枢注册。Claude Code 只在 `localhost` 或 `127.0.0.1` 上登录使用明文 `http://` 地址的中枢；在其他任何地方，请通过 https 提供中枢。

### 使用令牌 {#use-a-token}

对于不能打开浏览器的 Agent，例如在 CI 中运行的 Agent，或者在没有在 `/admin` 下提供管理界面的中枢上，请在中枢上添加一个带令牌的 Agent（在管理界面中用**添加 Agent**，或者运行 `origin token create ci --agent`，只读取的 Agent 再加上 `--readonly`；见[设备和 Agent](./hub.md#devices-and-agents)），再把令牌交给它：

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI，令牌放在环境变量中
export ORIGIN_TOKEN=ogn_…
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

添加 Agent 时，管理界面会显示这些命令，令牌已填在其中。只读的 Agent 只能看到读取类的工具。

## 更新 Origin 之后 {#after-updating-origin}

Agent 启动的是已安装的 `origin`。运行 `npm install -g @openlinkos/origin@latest` 之后，请重启正在运行的 Agent 会话，以加载新版本。如果你从本地仓库运行 Origin，则在 `pnpm build` 之后重启。
