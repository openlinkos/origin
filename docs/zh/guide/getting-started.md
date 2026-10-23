---
sourceHash: sha256-6dc1a23b
---

# 快速开始

Origin 运行在你的机器上：读取各 AI Agent 本来就写在磁盘上的会话记录，归档到 `~/.origin`，再通过同一个 [MCP](https://modelcontextprotocol.io) server 提供给所有 Agent。如果你在多台机器上使用 Agent，之后可以用自托管的[个人中枢](./hub.md)把它们连在一起。

::: warning 早期版本
Origin 目前是 0.1。1.0 之前，新的次版本可能改变存储格式，[发布说明](https://github.com/openlinkos/origin/blob/master/CHANGELOG.md)会说明需要怎么做。
:::

## 环境要求 {#requirements}

- Node.js 22.16 或更高（推荐 24 LTS）
- 至少一个已支持的 Agent：Claude Code、Codex CLI、Cursor、Grok Build 或 ZCode。

## 安装 {#install}

```bash
npm install -g @openlinkos/origin
origin --version
```

这会把 `origin` 命令放到你的 `PATH` 里。如果要参与开发 Origin 本身，请按 [CONTRIBUTING.md](https://github.com/openlinkos/origin/blob/master/CONTRIBUTING.md) 从源码构建。

## 归档会话 {#archive-your-sessions}

```bash
origin sync      # 把本机 Agent 会话采集到 ~/.origin
origin status    # 各来源的会话、事件与条目统计
origin timeline  # 最近 7 天的会话
```

`sync` 是增量的，可以随时重跑。Agent 通过 MCP 使用 Origin 时，server 会自动同步，一般不需要手动运行。

## 接入 Agent {#connect-an-agent}

在用户级注册一次，所有项目共享同一份记忆。以 Claude Code 为例：

```bash
claude mcp add --scope user origin -- origin mcp
claude mcp list   # origin: … ✔ Connected
```

在 Windows 上，npm 把 `origin` 装成一个 `.cmd` 脚本，Agent 无法直接启动它，请改为注册 `cmd /c origin mcp`，例如 `claude mcp add --scope user origin -- cmd /c origin mcp`。

其他 Agent 见[接入 Agent](./connect-agents.md)。

## 提问 {#ask}

新开一个会话，直接问过去的工作，例如：

> 上周在 origin 项目里，关于 schema 迁移我是怎么决定的？为什么？请给出来源。

Agent 会检索 Origin，并附上条目与事件 id 作答。想看原文，运行 `origin show <id>`。遇到值得保留的内容（一个决定及其理由、一个稳定的事实、你的某个偏好），Agent 会用 `remember` 存成**条目**。

## 管理记忆 {#curate-your-memory}

```bash
origin entries                           # Agent 记下了什么
origin show ent_5f0c2a9e41b7             # 条目及其来源与版本历史
origin correct ent_5f0c2a9e41b7 "…"      # 用纠正后的版本替换
origin forget ent_5f0c2a9e41b7 --reason "wrong" --yes   # 在所有地方隐藏它，并保存为记录
origin restore tmb_3a9d70c1e2f4 --reason "needed" --yes  # 把它找回来
```

想在浏览器里做同样的事，运行 `origin ui`：它会用一次性登录链接，在 `127.0.0.1` 上为这台机器的库打开[管理界面](./admin.md#on-your-own-machine)。

全部命令见[命令参考](./cli.md)；Origin 保存了什么、遗忘如何生效，见[隐私与数据](./privacy.md)。
