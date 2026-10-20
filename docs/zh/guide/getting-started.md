# 快速开始

Origin 运行在你的机器上：读取各 AI Agent 本来就写在磁盘上的会话记录，归档到 `~/.origin`，再通过同一个 [MCP](https://modelcontextprotocol.io) server 提供给所有 Agent。

::: warning 早期开发
Origin 尚未发布到 npm，请按下面的方式从源码安装。
:::

## 环境要求

- Node.js 22.13 或更高（推荐 24 LTS）
- pnpm（`corepack enable` 会安装仓库锁定的版本）
- 至少一个已支持的 Agent：Claude Code 或 Codex CLI。Cursor、ZCode、Grok Build 现在就能*使用* Origin，归档它们自己的会话即将支持。

## 安装

```bash
git clone https://github.com/openlinkos/origin.git
cd origin
pnpm install
pnpm build
```

`origin` 命令即 `node packages/cli/dist/bin.js`。在仓库目录下也可以用 `pnpm origin <命令>`，或者把完整路径设为 `origin` 别名。

## 归档会话

```bash
origin sync      # 把本机 Agent 会话采集到 ~/.origin
origin status    # 各来源的会话、事件与条目统计
origin timeline  # 最近 7 天的会话
```

`sync` 是增量的，可以随时重跑。Agent 通过 MCP 使用 Origin 时，server 会自动同步，一般不需要手动运行。

## 接入 Agent

在用户级注册一次，所有项目共享同一份记忆。以 Claude Code 为例：

```bash
claude mcp add --scope user origin -- node /path/to/origin/packages/cli/dist/bin.js mcp
claude mcp list   # origin: … ✔ Connected
```

其他 Agent 见[接入 Agent](./connect-agents.md)。

## 提问

新开一个会话，直接问过去的工作，例如：

> 上周在 origin 项目里，关于 schema 迁移我是怎么决定的？为什么？请给出来源。

Agent 会检索 Origin，并附上条目与事件 id 作答。想看原文，运行 `origin show <id>`。遇到值得保留的内容（一个决定及其理由、一个稳定的事实、你的某个偏好），Agent 会用 `remember` 存成**条目**。

## 管理记忆

```bash
origin entries                           # Agent 记下了什么
origin show ent_5f0c2a9e41b7             # 条目及其来源与版本历史
origin correct ent_5f0c2a9e41b7 "…"      # 用纠正后的版本替换
origin forget ent_5f0c2a9e41b7 --yes     # 永久遗忘
```

全部命令见[命令参考](./cli.md)；Origin 保存了什么、遗忘如何生效，见[隐私与数据](./privacy.md)。
