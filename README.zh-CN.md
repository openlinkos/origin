<h1>
  <img alt="Origin" src="https://openlinkos.com/brand/origin/github/readme.svg" height="56">
</h1>

**本地优先、跨 Agent 的个人记忆，服务于 AI 编码 Agent。**

[![CI](https://github.com/openlinkos/origin/actions/workflows/ci.yml/badge.svg)](https://github.com/openlinkos/origin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

各个 AI Agent 本来就会把会话写在你的磁盘上。Origin 把这些会话归档进同一个本地库：已支持 Claude Code、Codex、Cursor、Grok Build 与 ZCode，其他任何东西也可以把会话写成事件行（一种任何脚本都能写的格式）带进来。通过同一个 [MCP](https://modelcontextprotocol.io) server，Origin 让所有 Agent 共享这份记忆：无论打开哪个工具，它都能查到你上周决定了什么、为什么，能追溯到原始记录的具体一行，并把学到的东西沉淀下来供下次使用。如果你在多台机器上工作，或者使用云端 Agent，可以用自托管的**个人中枢**把它们接入同一份记忆。

> **状态：早期版本（0.5）。** Claude Code、Codex、Cursor、Grok Build 与 ZCode 会话的采集（Claude Code 和 Codex 经由 hook 实时采集），经插件采集 OpenClaw 的会话，以事件行接入你自己的来源；Claude Code、ZCode 与 Grok Build 自身记忆的导入；会话开始时和每个提示的召回；线索、变更流和由你审阅的提议；MCP server、CLI、`origin ui`，以及个人中枢（含管理界面、中继和存储桶）都已经端到端可用。1.0 之前，次版本可能改变存储格式；库会就地升级，[升级](https://origin.openlinkos.com/zh/guide/upgrading)和[更新日志](https://origin.openlinkos.com/zh/changelog)会说明需要怎么做。

## 为什么

同时用多个 AI Agent 时，每个工具各记各的：Claude Code 的记忆按 git 仓库隔离，Codex 按机器，Copilot、ChatGPT、Gemini 按云端账户，彼此读不到对方的记忆。换一个工具或项目，就得从零开始。这些记忆也难以查看和纠正，还会被悄悄清理。例如 Claude Code 默认 30 天后删除会话记录。

Origin 以**人**而不是工具为中心：

- **跨 Agent、跨机器的同一份记忆**：各 Agent 的会话规范化为同一套事件，任何支持 MCP 的 Agent 都能查询；自托管的中枢把你所有的机器和云端 Agent 连在一起。
- **默认可溯源**：每个事件都指向原始文件与行号，每个条目都引用它的来源事件。
- **不怕清理**：原始记录只追加地镜像保存，比 Agent 自身的保留期更长久。
- **可纠正、可遗忘**：条目可以纠正，遗忘也会持久生效：被遗忘的条目或事件在所有地方都保持隐藏，也不能被引用，直到你恢复它。每一次遗忘都连同原因保存为一条记录。
- **你的数据，留在你的机器上**：数据只存放在你控制的机器上：你的设备，以及可选的自建中枢。Origin 从不调用第三方服务，也不调用任何 LLM API。

## 功能

- **MCP server**（`origin mcp`），十二个工具：`brief`、`search`、`timeline`、`changes`、`digest`、`get`、`sources`、`follow`、`remember`、`propose`、`correct`、`forget`。它会自动同步，Agent 看到的总是最新会话。
- **条目**分三类：`memory`（发生过什么）、`knowledge`（稳定的事实）、`cognition`（你的偏好、方法、目标与边界）。每条都带来源、置信度和版本历史。
- **导入原生记忆**：Claude Code、ZCode 和 Grok Build 为自己保存的记忆文件会被导入为条目，每条都引用它所来自的文件版本：Agent 修改一条记忆，条目随之更新；删除一条记忆，条目随之结束。
- **召回**：会话开始时和每个提示时，Agent 会拿到它工作之处有用的内容：你的偏好、项目最新的决定和事实、你在这个项目里最近与任意 Agent 的会话，以及提示所涉及的条目，每项一行，挑选时不调用模型。Claude Code 和 Codex 通过 hook 获得，其他 Agent 通过 `brief` 工具获得；`origin agents connect` 会把这些设置好。每一次召回都有记录，所以你能看到 Agent 拿到了什么、有没有用上。
- **线索与变更流**：属于同一件工作的会话，无论出自一个还是多个 Agent，都会按 Agent 的 `follow` 调用和 git 分支归入一条线索；`changes` 告诉 Agent 自它上次查看以来有什么进入了你的记忆。
- **提议**：Agent 推断而非听到的内容，用 `propose` 提议出来，而不是直接保存；替你整理记忆的 Agent 也是这样，例如通过 MCP 工具读你的工作的个人 Agent。你在 CLI 或管理界面中逐条接受或拒绝：被接受的提议成为一条引用其依据的条目，拒绝则像遗忘一样留下记录。Origin 自己只存储和提供数据，不调用任何模型。
- **按相关度排序的全文检索**：覆盖会话和条目，支持中文子串检索（SQLite FTS5 trigram）。
- **增量、幂等的采集**：只读新增字节；源文件被改写时作为新代次保存；透明读取 zstd 压缩的记录；多个进程同时同步也安全。Claude Code 和 Codex 的 hook 会在每一轮结束时把这一轮新增的行交给 Origin，其他会话和你的中枢几秒后就能看到。
- **CLI**：浏览时间线，查看任意条目或事件直到原文行、任意会话及其各轮和从中写下的条目、任意线索及其会话，纠正条目，审阅提议，以及遗忘和恢复。
- **个人中枢**（`origin serve`，或镜像 `ghcr.io/openlinkos/origin`），由你自己托管：每台设备都保有一份完整的、属于自己的记忆，并用 `origin sync` 把自己写下的内容发送到中枢；设备上的 Agent 通过本地 `origin mcp` 同时读取两边，Claude Code、Codex 这类云端 Agent 通过 HTTP 连接，在浏览器里用 OAuth 登录（做不到的程序用令牌）；设备在管理界面里由你批准接入，不用复制令牌。磁盘空间不多的机器可以作为中继运行：它不保有自己的记忆，直接把 Agent 的记录发送给中枢。
- **中枢的管理界面**（`origin serve --admin`），默认关闭：设备与存储概览、你的会话和条目、检索、纠正、先预览再执行的遗忘和对遗忘内容的恢复、你的设备和 Agent（批准接入、按读写或只读添加、吊销），以及审计日志。页面由中枢渲染，用你的用户名和中枢的管理密码登录。在任何一台机器上，`origin ui` 都能用一次性登录链接，在 `127.0.0.1` 上为它自己的库打开同样的页面。

## 支持的 Agent

| Agent | 会话归档 | 通过 MCP 使用 Origin |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex CLI | ✅ | ✅ |
| Cursor | ✅ | ✅ |
| ZCode | ✅ | ✅ |
| Grok Build | ✅ | ✅ |

任何支持 MCP 的 Agent 现在都能查询归档和条目；归档某个 Agent 自己的会话则需要它的适配器，或者一个把会话写成事件行的脚本：其他 Agent 运行时、聊天工作区、通知流和笔记流水线都可以这样把会话写进 `~/.origin/sources/` 下的目录，或者直接发给你的中枢（见[接入你自己的来源](https://origin.openlinkos.com/zh/guide/sources)）。OpenClaw 的 Agent 则通过 Origin 的 OpenClaw 插件接入（见[接入 OpenClaw](https://origin.openlinkos.com/zh/guide/openclaw)）。如何为各 Agent 注册 Origin，见[接入 Agent](https://origin.openlinkos.com/zh/guide/connect-agents)；各 Agent 把会话存放在哪里，见[会话来源](https://origin.openlinkos.com/zh/sources)。

## 快速开始

**环境要求：** Node.js 22.16 或更高（推荐 24 LTS）。

```bash
npm install -g @openlinkos/origin

origin sync        # 把本机 Agent 会话采集到 ~/.origin
origin status      # 查看已采集的内容
```

如果要参与开发 Origin 本身，请按 [CONTRIBUTING.md](CONTRIBUTING.md) 从源码构建。

### 接入 Claude Code

在用户级注册一次，所有项目共享同一份记忆：

```bash
claude mcp add --scope user origin -- origin mcp
claude mcp list         # origin: … ✔ Connected
```

在 Windows 上，npm 把 `origin` 装成一个 `.cmd` 脚本，Agent 无法直接启动它，请改为注册 `cmd /c origin mcp`，例如 `claude mcp add --scope user origin -- cmd /c origin mcp`。

之后在任意会话里直接问，例如：*「上周在 origin 项目里，关于 schema 迁移我是怎么决定的？为什么？请给出来源。」* Agent 会检索 Origin 并附上事件 id 作答，你可以用 `origin show <id>` 打开原文。遇到值得保留的内容，它会用 `remember` 存成条目。

Codex、Cursor、ZCode、Grok Build 的接入方式见[接入 Agent](https://origin.openlinkos.com/zh/guide/connect-agents)。

## 文档

完整文档在 [`docs/`](docs/) 目录中，并发布在 [origin.openlinkos.com](https://origin.openlinkos.com/zh/)：

- [快速开始](https://origin.openlinkos.com/zh/guide/getting-started)：安装、归档会话、提出第一个问题
- [核心概念](https://origin.openlinkos.com/zh/guide/concepts)：会话、线索、条目、版本、有效期、导入的记忆与遗忘
- [接入 Agent](https://origin.openlinkos.com/zh/guide/connect-agents)：Claude Code、Codex、Cursor、ZCode、Grok Build，以及它们可用的 MCP 工具
- [接入你自己的来源](https://origin.openlinkos.com/zh/guide/sources)：以事件行带来其他任何程序的会话
- [接入 OpenClaw](https://origin.openlinkos.com/zh/guide/openclaw)：把 OpenClaw 上各个 Agent 的会话写进 Origin 的插件
- [个人中枢](https://origin.openlinkos.com/zh/guide/hub)：自托管，让你所有的机器和云端 Agent 共享一份记忆
- [管理界面](https://origin.openlinkos.com/zh/guide/admin)：在浏览器中管理中枢：启用、登录、放在 TLS 之后，或保持私有访问
- [隐私与数据](https://origin.openlinkos.com/zh/guide/privacy)：Origin 保存了什么、遗忘如何生效、如何清除全部数据
- [升级](https://origin.openlinkos.com/zh/guide/upgrading)：版本、镜像标签、存储格式，以及如何升级设备和中枢
- [常见问题](https://origin.openlinkos.com/zh/guide/troubleshooting)：常见问题及其解决方法
- [命令参考](https://origin.openlinkos.com/zh/guide/cli)：全部命令，附示例与环境变量
- [MCP 工具](https://origin.openlinkos.com/zh/guide/mcp)：Agent 使用的十二个工具、参数与返回内容
- [架构](https://origin.openlinkos.com/zh/architecture)：数据模型、不变量、采集、条目、MCP server 与中枢
- [会话来源](https://origin.openlinkos.com/zh/sources)：各 Agent 的本地会话格式，以及它们的记忆
- [更新日志](https://origin.openlinkos.com/zh/changelog)：每个版本改了什么

## 工作原理

```
Agent 会话记录 ──扫描──▶ 只追加的原始镜像 ──确定性解析──▶ 事件库（SQLite + FTS5）
                                                                │      ▲
                                                                │   条目 · 遗忘墓碑
                        各 Agent ◀── MCP server（origin mcp）──┤
                        你       ◀── origin CLI ───────────────┤
                        你       ◀── 中枢的管理界面 ───────────┘
```

Origin 围绕五条不变量构建：**溯源**、**有记录的遗忘**、**只追加**、**你的数据，留在你的机器上**、**单一入口**（Agent 走 MCP；人走 CLI 或自己中枢的管理界面）。内核从不调用模型：提问的 Agent 自己负责推理，Origin 提供事实与来源。数据模型、采集算法、遗忘规则与 MCP 工具见[架构文档](https://origin.openlinkos.com/zh/architecture)。

## 隐私

Agent 会话记录里常有源代码、命令输出，以及你在提示词里输入的任何内容，有时还包括密钥。Origin 会把它们复制到 `~/.origin`，让它们不受 Agent 自身清理的影响。没有中枢时，Origin 不发起任何网络连接；使用中枢时，数据只在你的设备和你自己的中枢之间传输，中枢应放在 TLS 之后。这些库都没有加密，请像保护原始记录一样保护它们。`origin forget` 可以在所有地方隐藏条目或消息，直到你恢复它；删除 `~/.origin`（以及中枢的数据，如果有）即可清除全部数据。详见[隐私与数据](https://origin.openlinkos.com/zh/guide/privacy)。

## 路线图

以小步、可运行的增量交付，每一步都能单独使用：

1. ✅ 核心存储、Claude Code 适配器与 CLI（`sync`、`status`、`timeline`、`search`、`show`、`projects`）
2. ✅ MCP server、条目、纠正与遗忘，已接入 Claude Code
3. ✅ Codex 适配器，支持 zstd 压缩与归档的会话
4. ✅ 个人中枢：自托管、多设备、远程 MCP，附带管理界面
5. ✅ Grok Build 适配器
6. ✅ ZCode 适配器，读取它的 SQLite 数据库
7. ✅ Cursor 适配器：编辑器对话与 CLI 对话记录

**当前已知限制：**

- 很多会话没有标题，因为 Claude Code 只为部分会话写 `summary` 行。
- 项目以主 git 检出所在的目录命名（链接的工作树和子目录都归入它），而不是由 git remote 推导。
- 遗忘只是隐藏，不会从原始镜像文件中物理删除。
- 对把会话存在数据库里的 Agent（ZCode、Cursor 编辑器），每条消息在稳定后归档一次，之后的修改不会再归档。
- Origin 不会自行监听文件。Claude Code 和 Codex 通过它们的 hook（由 `origin agents connect` 设置）把每一轮新增的行交给 Origin；对其他 Agent，Agent 运行期间，它的 MCP server 每分钟检查一次新内容，Agent 退出时再检查一次；其他时候请运行 `origin sync`，它也会与你的中枢同步。
- 在设备上，CLI 管理命令作用于该设备自己的条目；中枢的管理界面可以查看和管理所有设备的条目。

## 目录结构

```
packages/
├── core/       @openlinkos/origin-core      存储、采集、条目、遗忘、查询
├── adapters/   @openlinkos/origin-adapters  各 Agent 的会话解析器
├── mcp/        @openlinkos/origin-mcp       MCP 工具、stdio 与 HTTP server、已接入设备上的合并读取
├── admin/      @openlinkos/origin-admin     中枢的管理界面：服务器端渲染的页面与 JSON API
├── cli/        @openlinkos/origin           origin 命令与中枢（`origin serve`）
└── openclaw/   @openlinkos/origin-openclaw  OpenClaw 插件：把它上面各个 Agent 的会话写成事件行
docs/                                        文档站点（VitePress）
├── guide/                                   使用指南（英文；中文版在 docs/zh/ 下）
├── architecture.md                          设计、数据模型、不变量
└── sources.md                               各 Agent 的会话格式
```

## 参与贡献

欢迎贡献，尤其是新的来源适配器。开发环境、约定以及如何新增适配器见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全或隐私问题请按 [SECURITY.md](SECURITY.md) 报告。所有参与者都应遵守[行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE) © OpenLinkOS contributors
