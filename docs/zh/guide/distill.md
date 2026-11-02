---
sourceHash: sha256-4badfeeb
---

# 用无头 Agent 整理记忆

Agent 会边工作边保存它学到的内容，但很多要紧的东西从来没有被明确说出来：顺带做出的决定，出现过两次的偏好，项目里定下来的事实。`origin distill` 请无头运行的 Claude Code 通过 Origin 读一天或一条线索的工作，提议值得保留的条目。你来审阅这些提议，逐条接受或拒绝。Origin 自己不调用任何模型：这次运行就是一个普通的 Claude Code 会话，它提议的内容等着你决定（见[提议](../architecture.md#proposals)）。

## 它做什么 {#what-it-does}

1. **选定范围**：默认是你所在的 git 工作树的项目，时间是最近 24 小时。`--project` 指定另一个项目，`--thread` 则改为一条线索；`--day YYYY-MM-DD` 取你所在时区的某一天，`--since` 取到现在为止的一段时间，例如 `7d`。没有给时间的线索会被整条读取。同一个库、同样的选项，得到的范围相同：它的会话（之前各次运行的会话除外），从旧到新，最多按 id 列出 30 个；以及这个项目待审的提议，最多 20 条，这次运行不得再提出它们。
2. **写出提示词**，用简明的英文：这次运行是做什么的、代谁而做，范围是什么，怎样通过 Origin 的工具读它（`get` 查看会话的各轮和任意 id，`timeline` 读一轮，`changes` 看最近 24 小时进入库中的内容，`search` 查条目已经写了什么），提议什么（memory：带理由的决定；knowledge：稳定的事实；cognition：你的偏好、方法、目标和边界），按 id 引用事件，绝不调用 `remember`、`correct`、`forget` 或 `follow`，最多提议 `--max` 条（默认 10 条），最后用一行说明它提议了多少条。
3. **无头运行 Claude Code**：在项目的目录中（本机上这个项目最新会话的目录，否则为当前目录），提示词从标准输入传入。这次运行使用本 Origin 自己的 MCP server（以这个库启动），不使用其他任何 server；它只能使用 Origin 的工具，不能使用 Claude Code 自带的工具，也不能使用会写入的工具：

   ```bash
   claude -p --output-format json --mcp-config <file> --strict-mcp-config \
     --allowedTools "mcp__origin__*" \
     --disallowedTools mcp__origin__remember,mcp__origin__correct,mcp__origin__forget,mcp__origin__follow \
     --tools "" --max-turns 40 --session-id <uuid> --name "Origin distill: <scope>"
   ```

   这个文件只含一个 server，`origin`：即 `node <origin 的 bin.js> mcp`，`ORIGIN_HOME` 设为这个库。会话被命名为 `Origin distill: …`，这样之后的运行会把它排除在范围之外。
4. **采集这次运行的会话**：像 Agent 的 hook 那样从它的记录文件采集（找不到记录文件时，同步一次 Claude Code 的会话），在连接了中枢的设备上还会与中枢同步。然后列出这个会话提出的提议，带上它们的 id 和会话的 id。除此之外不记录任何东西：这次运行就是它的会话。

## 运行 {#running-it}

```bash
origin distill --dry-run                          # print the prompt and the command; run nothing
origin distill                                    # this project, the last 24 hours
origin distill --project demo-app --day 2026-10-20 --max 5
origin distill --thread thr_4c1e9a7b2d30          # a whole thread
```

```console
$ origin distill --max 5
Consolidating project demo-app, the last 24 hours: 4 sessions, at most 5 proposals.
Running Claude Code headless in /home/dana/code/demo-app (session 6a1f0c3e-0000-4000-8000-000000000042) …

Session 6a1f0c3e-0000-4000-8000-000000000042: 17 turns, 2.1min, $0.38.
The agent said: Proposed 2 entries.

It proposed 2 entries:
  prp_1b7e4c0a9d23  knowledge  Releases are tagged only after both CI jobs pass.
  prp_6e2d9a4c1b07  cognition  Prefers one purpose per commit, with no attribution trailers.

Review them: origin show <id>, then origin accept <id> or origin reject <id> --reason <text>; or the Proposals page of origin ui.
```

它需要 `PATH` 上有已登录的 `claude`；`ORIGIN_DISTILL_COMMAND` 可以指定另一个命令来代替它。目前只有 Claude Code 能运行它（`--agent claude-code`，即默认值）。它不能在中继上运行，因为中继没有可读的会话：请在中枢上运行，或在有完整库的设备上运行。Origin 不安排任何定时任务：由你在需要的时候运行它。

## 开销 {#cost}

一次运行就是一个 Claude Code 会话，像其他会话一样计费：用你的订阅额度或你的 API 密钥。开销随范围和 Agent 读取的内容增长：清闲的一天只需要几轮，忙碌的一天要多得多。`--max-turns` 限制轮数（默认 40），`--max` 限制提议数。Claude Code 报告了这次运行的费用时，摘要会显示它。提示词和 Agent 读取的内容会发给你的 Claude Code 所用的模型，和你的任何会话一样；Origin 自己不向任何地方发送任何东西。

## 审阅它的提议 {#reviewing-what-it-proposed}

提议在 [CLI](./cli.md#reviewing-proposals) 中和[管理界面](./admin.md)的“提议”页面上等着你：

- `origin proposals` 列出待审的提议；`origin show prp_…` 显示一条提议及它引用的事件。
- `origin accept prp_… --yes` 以你的身份写下它的条目，引用这些事件以及这条提议本身。之后可以像对待任何条目那样纠正或遗忘它。
- `origin reject prp_… --reason <text> --yes` 遗忘这条提议，作为一条带有你的原因的记录；`origin restore` 可以把它带回来。

Agent 不能接受或拒绝。在你决定之前，提议还不是知识：简报、检索和召回都不会交出它，下一次运行也会被告知不要再提出它。

## 它的会话 {#its-session}

这次运行和你的其他会话一样，是项目目录中的一个 Claude Code 会话，所以你的 Claude Code 设置对它同样适用：你的 hook 会运行（包括 Origin 的 hook），你的 `CLAUDE.md` 文件会被读取。它的工具只有 Origin 的：它读取归档，并且只能提议。你可以在 `origin timeline` 和管理界面中找到它，名为 `Origin distill: …`，每条提议都会显示提出它的会话。
