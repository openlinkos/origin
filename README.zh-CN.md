<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://openlinkos.com/brand/origin/github/readme-dark.svg">
    <img alt="Origin" src="https://openlinkos.com/brand/origin/github/readme-light.svg" height="48">
  </picture>
</h1>

**本地优先、跨 Agent 的个人记忆，服务于 AI 编码 Agent。**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

各个 AI Agent 本来就会把会话写在你的磁盘上。Origin 把这些会话归档进同一个本地库：目前支持 Claude Code 与 Codex，Cursor、ZCode、Grok Build 将陆续接入。通过同一个 [MCP](https://modelcontextprotocol.io) server，Origin 让所有 Agent 共享这份记忆：无论打开哪个工具，它都能查到你上周决定了什么、为什么，能追溯到原始记录的具体一行，并把学到的东西沉淀下来供下次使用。如果你在多台机器上工作，或者使用云端 Agent，可以用自托管的**个人中枢**把它们接入同一份记忆。

> **状态：早期开发。** Claude Code 与 Codex 会话的采集、MCP server、CLI 与个人中枢（含管理界面）已经端到端可用；其余 Agent 的适配器正在开发（见[路线图](#路线图)）。各包尚未发布到 npm，请从源码安装。

## 为什么

同时用多个 AI Agent 时，每个工具各记各的：Claude Code 的记忆按 git 仓库隔离，Codex 按机器，Copilot、ChatGPT、Gemini 按云端账户，彼此读不到对方的记忆。换一个工具或项目，就得从零开始。这些记忆也难以查看和纠正，还会被悄悄清理。例如 Claude Code 默认 30 天后删除会话记录。

Origin 以**人**而不是工具为中心：

- **跨 Agent、跨机器的同一份记忆**：各 Agent 的会话规范化为同一套事件，任何支持 MCP 的 Agent 都能查询；自托管的中枢把你所有的机器和云端 Agent 连在一起。
- **默认可溯源**：每个事件都指向原始文件与行号，每个条目都引用它的来源事件。
- **不怕清理**：原始记录只追加地镜像保存，比 Agent 自身的保留期更长久。
- **可纠正、可遗忘**：条目可以纠正；遗忘后的条目或事件不会再出现，也不能再被引用。
- **你的数据，留在你的机器上**：数据只存放在你控制的机器上：你的设备，以及可选的自建中枢。Origin 从不调用第三方服务，也不调用任何 LLM API。

## 功能

- **MCP server**（`origin mcp`），七个工具：`search`、`timeline`、`get`、`sources`、`remember`、`correct`、`forget`。它会自动同步，Agent 看到的总是最新会话。
- **条目**分三类：`memory`（发生过什么）、`knowledge`（稳定的事实）、`cognition`（你的偏好、方法、目标与边界）。每条都带来源、置信度和版本历史。
- **按相关度排序的全文检索**：覆盖会话和条目，支持中文子串检索（SQLite FTS5 trigram）。
- **增量、幂等的采集**：只读新增字节；源文件被改写时作为新代次保存；透明读取 zstd 压缩的记录；多个进程同时同步也安全。
- **CLI**：浏览时间线，查看任意条目或事件直到原文行，纠正条目，以及遗忘。
- **个人中枢**（`origin serve`，或镜像 `ghcr.io/openlinkos/origin`），由你自己托管：各设备用 `origin push` 推送会话，任何设备上的 Agent 通过本地 `origin mcp` 访问它，云端 Agent 则用令牌通过 HTTP 直接连接。
- **中枢的管理界面**（`origin serve --admin`），默认关闭：设备与存储概览、你的会话和条目、检索、纠正，以及先预览再执行的遗忘、附带现成接入命令的令牌管理，以及审计日志。页面由中枢渲染，用中枢的管理密码登录。

## 支持的 Agent

| Agent | 会话归档 | 通过 MCP 使用 Origin |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex CLI | ✅ | ✅ |
| Cursor | 规划中 | ✅ |
| ZCode | 规划中 | ✅ |
| Grok Build | 规划中 | ✅ |

任何支持 MCP 的 Agent 现在都能查询归档和条目；归档某个 Agent 自己的会话则需要它的适配器。如何为各 Agent 注册 Origin，见[接入 Agent](https://origin.openlinkos.com/zh/guide/connect-agents)；各 Agent 把会话存放在哪里，见[会话来源](https://origin.openlinkos.com/zh/sources)。

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

### 接入 Claude Code

在用户级注册一次，所有项目共享同一份记忆：

```bash
claude mcp add --scope user origin -- node /absolute/path/to/origin/packages/cli/dist/bin.js mcp
claude mcp list         # origin: … ✔ Connected
```

之后在任意会话里直接问，例如：*「上周在 origin 项目里，关于 schema 迁移我是怎么决定的？为什么？请给出来源。」* Agent 会检索 Origin 并附上事件 id 作答，你可以用 `origin show <id>` 打开原文。遇到值得保留的内容，它会用 `remember` 存成条目。

Codex、Cursor、ZCode、Grok Build 的接入方式见[接入 Agent](https://origin.openlinkos.com/zh/guide/connect-agents)。

## 文档

完整文档在 [`docs/`](docs/) 目录中，并发布在 [origin.openlinkos.com](https://origin.openlinkos.com/zh/)：

- [快速开始](https://origin.openlinkos.com/zh/guide/getting-started)：安装、归档会话、提出第一个问题
- [接入 Agent](https://origin.openlinkos.com/zh/guide/connect-agents)：Claude Code、Codex、Cursor、ZCode、Grok Build，以及它们可用的 MCP 工具
- [个人中枢](https://origin.openlinkos.com/zh/guide/hub)：自托管，让你所有的机器和云端 Agent 共享一份记忆
- [管理界面](https://origin.openlinkos.com/zh/guide/admin)：在浏览器中管理中枢：启用、登录、放在 TLS 之后，或保持私有访问
- [命令参考](https://origin.openlinkos.com/zh/guide/cli)：全部命令，附示例与环境变量
- [隐私与数据](https://origin.openlinkos.com/zh/guide/privacy)：Origin 保存了什么、遗忘如何生效、如何清除全部数据
- [架构](https://origin.openlinkos.com/zh/architecture)：数据模型、不变量、采集、条目、MCP server 与中枢
- [会话来源](https://origin.openlinkos.com/zh/sources)：各 Agent 的本地会话格式

## 工作原理

```
Agent 会话记录 ──扫描──▶ 只追加的原始镜像 ──确定性解析──▶ 事件库（SQLite + FTS5）
                                                                │      ▲
                                                                │   条目 · 遗忘墓碑
                        各 Agent ◀── MCP server（origin mcp）──┤
                        你       ◀── origin CLI ───────────────┤
                        你       ◀── 中枢的管理界面 ───────────┘
```

Origin 围绕五条不变量构建：**溯源**、**遗忘粘性**、**只追加**、**你的数据，留在你的机器上**、**单一入口**（Agent 走 MCP；人走 CLI 或自己中枢的管理界面）。内核从不调用模型：提问的 Agent 自己负责推理，Origin 提供事实与来源。数据模型、采集算法、遗忘规则与 MCP 工具见[架构文档](https://origin.openlinkos.com/zh/architecture)。

## 隐私

Agent 会话记录里常有源代码、命令输出，以及你在提示词里输入的任何内容，有时还包括密钥。Origin 会把它们复制到 `~/.origin`，让它们不受 Agent 自身清理的影响。没有中枢时，Origin 不发起任何网络连接；使用中枢时，数据只在你的设备和你自己的中枢之间传输，中枢应放在 TLS 之后。这些库都没有加密，请像保护原始记录一样保护它们。`origin forget` 可以永久隐藏条目或消息，删除 `~/.origin`（以及中枢的数据，如果有）即可清除全部数据。详见[隐私与数据](https://origin.openlinkos.com/zh/guide/privacy)。

## 路线图

以小步、可运行的增量交付，每一步都能单独使用：

1. ✅ 核心存储、Claude Code 适配器与 CLI（`sync`、`status`、`timeline`、`search`、`show`、`projects`）
2. ✅ MCP server、条目、纠正与遗忘粘性，已接入 Claude Code
3. ✅ Codex 适配器，支持 zstd 压缩与归档的会话
4. ✅ 个人中枢：自托管、多设备、远程 MCP，附带管理界面
5. Cursor 适配器
6. ZCode 适配器
7. Grok Build 适配器

**当前已知限制：**

- 很多会话没有标题，因为 Claude Code 只为部分会话写 `summary` 行。
- 项目名取自工作目录的最后一段，而不是由 git remote 推导。
- 遗忘只是隐藏，不会从原始镜像文件中物理删除。
- 没有后台文件监听：MCP server 按需同步，其他时候需要运行 `origin sync`（使用中枢时运行 `origin push`）。
- CLI 管理命令作用于它们所运行的那个库。在中枢上，可以用管理界面在浏览器中管理；从设备的 CLI 管理中枢已在计划中。

## 目录结构

```
packages/
├── core/       @openlinkos/origin-core      存储、采集、条目、遗忘、查询
├── adapters/   @openlinkos/origin-adapters  各 Agent 的会话解析器
├── mcp/        @openlinkos/origin-mcp       MCP 工具、stdio 与 HTTP server、转发代理
├── admin/      @openlinkos/origin-admin     中枢的管理界面：服务器端渲染的页面与 JSON API
└── cli/        @openlinkos/origin           origin 命令与中枢（`origin serve`）
docs/                                        文档站点（VitePress）
├── guide/                                   使用指南（英文；中文版在 docs/zh/ 下）
├── architecture.md                          设计、数据模型、不变量
└── sources.md                               各 Agent 的会话格式
```

## 参与贡献

欢迎贡献，尤其是新的来源适配器。开发环境、约定以及如何新增适配器见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全或隐私问题请按 [SECURITY.md](SECURITY.md) 报告。所有参与者都应遵守[行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE) © OpenLinkOS contributors
