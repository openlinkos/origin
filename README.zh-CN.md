# Origin

**本地优先、跨 Agent 的个人记忆，服务于 AI 编码 Agent。**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

各个 AI Agent 本来就会把会话写在你的磁盘上。Origin 把这些会话归档进同一个本地库：目前支持 Claude Code，Codex、Cursor、ZCode、Grok Build 将陆续接入。归档后可以检索、按时间线回看，任何结果都能追溯到原始文件的具体一行。下一步，Origin 会通过同一个 [MCP](https://modelcontextprotocol.io) server 把这份记忆开放给所有 Agent：无论打开哪个工具，它都知道你上周决定了什么、为什么。

> **状态：早期开发。** Claude Code 的采集、检索、时间线与溯源已可用；MCP server 与其余适配器正在开发（见[路线图](#路线图)）。各包尚未发布到 npm，请从源码安装。

## 为什么

同时用多个 AI Agent 时，每个工具各记各的：Claude Code 的记忆按 git 仓库隔离，Codex 按机器，Copilot、ChatGPT、Gemini 按云端账户，彼此读不到对方的记忆。换一个工具或项目，就得从零开始。这些记忆也难以查看和纠正，还会被悄悄清理。例如 Claude Code 默认 30 天后删除会话记录。

Origin 以**人**而不是工具为中心：

- **一份跨 Agent 的归档**：各 Agent 的会话规范化为同一套事件。
- **默认可溯源**：每个事件都指向原始文件与行号，随时可以查看原文。
- **不怕清理**：原始记录只追加地镜像保存，比 Agent 自身的保留期更长久。
- **本地、私密**：数据全部留在本机；Origin 不联网，也不调用任何 LLM API。
- **可纠正、可遗忘**（规划中）：沉淀下来的条目可以纠正或遗忘，遗忘后不会复活。

## 功能

- `origin sync`：增量、幂等的采集。只读新增字节；源文件被改写时自动识别，作为新代次保存。
- 全部会话的全文检索，支持中文子串检索（SQLite FTS5 trigram）。
- 时间线：按天列出会话，或按顺序列出单个会话内的事件。
- `origin show <event-id>`：显示规范化后的事件、原始定位和原文行。
- 零运行时依赖：只用 Node.js 内置模块（包括 `node:sqlite`）。

## 支持的 Agent

| Agent | 状态 |
|---|---|
| Claude Code | ✅ 已支持 |
| Codex CLI | 规划中 |
| Cursor | 规划中 |
| ZCode | 规划中 |
| Grok Build | 规划中 |

各 Agent 的会话存储位置与格式见 [docs/sources.md](docs/sources.md)（英文）。

## 快速开始

**环境要求：** Node.js 22.13 或更高（推荐 24 LTS），以及 pnpm（`corepack enable` 会安装锁定的版本）。

```bash
git clone https://github.com/openlinkos/origin.git
cd origin
pnpm install
pnpm build

pnpm origin sync        # 把本机 Agent 会话采集到 ~/.origin
pnpm origin status      # 查看已采集的内容
```

`pnpm origin <命令>` 等价于 `node packages/cli/dist/bin.js <命令>`，可以把后者设为 `origin` 别名。

## 命令参考

```text
origin sync      [--source <id>] [--verbose]          采集本机 Agent 会话（幂等，可随时重跑）
origin status                                          各来源的会话/事件统计与上次采集时间
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                单个会话的事件（默认不含工具事件）
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--limit 20]
origin show      <event-id>                            显示事件、原始定位与原文行
origin projects                                        已知的项目名
```

时间参数可以是相对时长（`30m`、`24h`、`7d`、`2w`），也可以是日期（`YYYY-MM-DD`、ISO 8601）。CLI 输出为英文。

## 配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Origin 的数据库与原始镜像目录 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置目录（会话从 `<dir>/projects` 读取） |
| `ORIGIN_CLAUDE_PROJECTS` | — | 直接指定 Claude Code 的 projects 目录 |

## 工作原理

```
Agent 会话记录 ──扫描──▶ 只追加的原始镜像 ──确定性解析──▶ 事件库（SQLite + FTS5）
                                                                │
                        各 Agent ◀── MCP server（规划中）──────┤
                        你       ◀── origin CLI ───────────────┘
```

Origin 围绕五条不变量构建：**溯源**、**遗忘粘性**、**只追加**、**本地优先**、**单一入口**（Agent 走 MCP，人走 CLI）。内核从不调用模型：提问的 Agent 自己负责推理，Origin 提供事实与来源。数据模型、采集算法与规划中的 MCP 工具见 [docs/architecture.md](docs/architecture.md)（英文）。

## 隐私

Agent 会话记录里常有源代码、文件内容、命令输出，以及你在提示词里输入的任何内容，有时还包括密钥。Origin 会把这些记录复制到 `~/.origin`，让它们不受 Agent 自身清理的影响。请注意：

- Origin 不发起任何网络连接，不向任何地方发送数据。
- 请像保护原始记录一样保护 `~/.origin`。该目录没有加密。
- 删除 `~/.origin`（或你设置的 `ORIGIN_HOME`）即可清除 Origin 保存的全部数据。

## 路线图

以小步、可运行的增量交付，每一步都能单独使用：

1. ✅ 核心存储、Claude Code 适配器与 CLI（`sync`、`status`、`timeline`、`search`、`show`、`projects`）
2. MCP server 与条目、遗忘墓碑（`search`、`timeline`、`get`、`sources`、`remember`、`correct`、`forget`），接入 Claude Code
3. Codex 适配器
4. Cursor 适配器
5. ZCode 适配器
6. Grok Build 适配器

**当前已知限制：**

- 很多会话没有标题，因为 Claude Code 只为部分会话写 `summary` 行。
- 检索结果按时间排序而不是按相关度，工具事件可能挤占结果。
- 项目名取自工作目录的最后一段，而不是由 git remote 推导。
- 尚无文件监听，需要手动或定时运行 `origin sync`。

## 目录结构

```
packages/
├── core/       @openlinkos/origin-core      存储、schema、采集、查询
├── adapters/   @openlinkos/origin-adapters  各 Agent 的会话解析器
├── mcp/        @openlinkos/origin-mcp       MCP server（开发中）
└── cli/        @openlinkos/origin           origin 命令
docs/
├── architecture.md                          设计、数据模型、不变量
└── sources.md                               各 Agent 的本地会话格式
```

## 参与贡献

欢迎贡献，尤其是新的来源适配器。开发环境、约定以及如何新增适配器见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全或隐私问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

[MIT](LICENSE) © OpenLinkOS contributors
