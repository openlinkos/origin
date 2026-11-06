---
sourceHash: sha256-f8554268
---

# 召回

会话开始时，以及你每发出一个提示时，Origin 可以把它已经知道、而在当下有用的内容交给你的 Agent：先是一份简报，包括你的偏好、项目的决定和事实，以及这个项目最近与你的各个 Agent 的会话；然后是与你的提示相关的条目，以及你和你的 Agent 在这个项目以前的会话中就此说过的话。它通过 Agent 的 hook 工作，不调用任何模型，并记录下每一次交出的内容，所以你能看到 Agent 拿到了什么、有没有用上。

Claude Code、Codex、ZCode 和 Cursor 通过它们的 hook 获得召回。其他 Agent 通过 Origin 的 MCP server 请求（见[其他 Agent](#other-agents)）。

## Agent 会拿到什么 {#what-an-agent-is-handed}

- **会话开始时**，一份简报：你在这个项目中的偏好与边界和在哪里都成立的偏好与边界，这个项目最新的决定和事实，以及这个项目最近 30 天内你与任意 Agent 的最近几次对话，其中属于同一件工作的会话，即一条[线索](./concepts.md#threads)，合占一行。子 Agent 的会话、无界面运行，以及只有别人的话的会话都不是你的对话，不在其中。
- **每个提示**，第一行与提示有足够罕见的共同词的条目，最多五条；然后是这个项目其他会话中有这些共同词的过往消息，即你的提示和你的 Agent 的回复，最多三条，每条来自不同的会话。本会话已经拿到的不再给。

每一项一行：条目是 id 和它的开头；过往消息是它的事件 id、Agent、日期和作者，再加上围绕它与提示共有的词的一段摘录。所以一份简报不超过约 800 个 token，一个提示的匹配不超过 600 个。Agent 用 Origin 的 `get` 获取其余内容：条目的正文和来源，会话的各轮和从中写下的条目，或消息的全文及其前后的轮次，每样都带着它近旁内容的 id（见 [MCP 工具](./mcp.md#get)）。例如，会话开始时：

```text
Origin recall rcl_3f9a0c1d2e4b: a brief from the user's cross-agent memory (project acme), one line each. Origin's `get` opens any id here: an entry for its text and sources, a session or thread for its turns or sessions and what was written there. Entries can be outdated; the user's words in this session come first.

The user's preferences and boundaries:
- ent_5f0c2a9e41b7 Run the full test suite before pushing; never skip CI on both platforms

Project acme:
- ent_8e21b4c0d9f3 (2026-10-20) The API keeps v1 routes until every client has moved to v2

Latest sessions in acme, any agent (source, time, session id):
- thr_9d2a6c4e1b07 (3 sessions: claude-code, codex; 2026-10-24 – 2026-10-27): Migrate the billing client to v2; last prompt: run the integration tests again
- claude-code 2026-10-26 11:40 5e8f0a1b-2c3d-4e5f-9a6b-7c8d9e0f1a2b: Fix the flaky upload test
```

再如，提示是「should we drop the v1 routes?」时：

```text
Origin recall rcl_6c1e8d2a4f90: entries and past messages from the user's cross-agent memory that match this prompt, one line each. Origin's `get` opens any id here: an entry for its text and sources, a session or thread for its turns or sessions and what was written there, a message for its full text and the turns around it. Entries and messages can be outdated; the user's words in this session come first.

Matching this prompt:
- ent_8e21b4c0d9f3 (knowledge, 2026-10-20) The API keeps v1 routes until every client has moved to v2

Past messages that match this prompt (agent, day, who):
- codex:019a3b7c-2d4e-7f60-8a1b-9c0d1e2f3a4b:o57 (codex, 2026-10-25, assistant) …the access logs of every client: the v1 routes can be dropped once the mobile app ships 4.2, the last client that still calls /v1/orders.
- claude-code:3e7b1c9d-5a2f-4e8b-b0c6-1d9f2a4e7c38 (claude-code, 2026-10-21, user) keep the v1 routes for now, the mobile app still uses them
```

## 设置 hook {#set-up-the-hooks}

`origin agents connect` 会把它们连同 Origin 的 MCP server 一起，加到每个已安装且支持的 Agent 中：它先显示会改什么，加上 `--yes` 才修改，每个文件改之前都会先备份（见[接入 Agent](./connect-agents.md#connect-them-all-at-once)）。改完之后，为每个 Agent 开始一个新会话；Codex 只有在你用 `/hooks` 信任新的 hook 之后才会运行它们。ZCode 只在它的配置中 `hooks.enabled` 为 true 时运行 hook：Origin 的 hook 是那里仅有的 hook 时，`origin agents connect` 会把它打开；否则它会说明这一点，交给你决定，因为打开后你的其他 hook 也会运行。

它也会加上采集 hook，这些 hook 不交出任何内容：在一轮结束、子 Agent 停止，或者 Claude Code 压缩了对话之后，它们在后台运行 `origin sync --hook`，把会话新增的行读进你的库，再发给你的中枢，这样片刻之后，简报、搜索和其他会话的 `changes` 就都有了这些内容（见[实时采集](../architecture.md#live-ingestion)）。

要手动添加，就把这些 hook 放进 Claude Code 的 `~/.claude/settings.json`，与你已有的 hook 并列。对 Codex，则放进 `~/.codex/hooks.json`，把 `claude-code` 换成 `codex`，并去掉 `PostCompact`：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "origin sync --hook claude-code", "timeout": 60, "async": true }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "origin sync --hook claude-code", "timeout": 60, "async": true }] }
    ],
    "PostCompact": [
      { "hooks": [{ "type": "command", "command": "origin sync --hook claude-code", "timeout": 60, "async": true }] }
    ]
  }
}
```

在两个 Agent 中用 `/hooks` 都可以看到它们。同时保留 Origin 的 MCP server 注册，这样 Agent 才能用 `get` 获取拿到的条目。召回 hook 用时不到一秒，Agent 会等它；采集 hook 在后台运行（`"async": true`），Agent 从不等待它。出现任何问题时，hook 不交出任何内容，也不采集任何内容，Agent 照常继续。

ZCode 和 Cursor 只设召回 hook；它们新增的行靠查看来收取。对 ZCode，把 hook 放进 `~/.zcode/cli/config.json`，与它的其他设置并列，并按 ZCode 自己的格式写：超时以毫秒计，每个 hook 中不放别的字段，因为 ZCode 只要拒绝一个 hook，就会关掉所有 hook。

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        { "hooks": [{ "type": "command", "command": "origin recall --hook zcode", "timeoutMs": 10000 }] }
      ],
      "UserPromptSubmit": [
        { "hooks": [{ "type": "command", "command": "origin recall --hook zcode", "timeoutMs": 10000 }] }
      ]
    }
  }
}
```

对 Cursor，把 hook 放进 `~/.cursor/hooks.json`。它随每个提示运行：会话开始时 hook 交出的内容，Cursor 常常会丢掉，所以对话的第一条提示带来它的简报，以及与这条提示匹配的条目。Grok Build 也读取这个文件，并把 Origin 的这一项列为它暂时无法运行的 Cursor hook；在 `~/.grok/config.toml` 中写上 `[compat.cursor] hooks = false`，它就不再读取这个文件。

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "origin recall --hook cursor", "timeout": 10 }]
  }
}
```

有些 Agent 会运行为别的 Agent 写的 hook：Grok Build 和 Cursor 会运行 `~/.claude/settings.json` 中的 hook。Origin 的 hook 根据运行它的 Agent 发来的内容判断是谁，遇到别的 Agent 就什么都不做，这样就不会有召回记在别的 Agent 名下。Agent 为自己运行的会话，即 ZCode 的子 Agent 或工作流步骤，以及 Cursor 的子 Agent，同样什么都拿不到。

## 其他 Agent {#other-agents}

Grok Build 在会话开始时和随提示都不读取 hook 交出的任何内容，所以它自己请求简报：Origin 的 MCP server 有一个 `brief` 工具，它的说明会告诉 Agent 在开始任务时带上工作目录调用它。不在任何目录中工作的 Agent 也是这样，比如 OpenClaw 的 Agent，或者你[中枢](./hub.md)上的机器人，它们带上自己为之工作的 `project`：OpenClaw Agent 的会话归在它的 Agent id 之下。它们拿到同样的简报，加上 `about` 时还有与任务匹配的条目和过往消息（见 [MCP 工具](./mcp.md#brief)）。除了[注册 Origin](./connect-agents.md)，不需要别的设置。这样的召回与 hook 的一样有记录；它的会话之后根据 Agent 日志中的召回 id 找到。

## 预览 {#preview}

`origin recall` 显示 Agent 在当前目录会拿到什么，不做任何记录：

```sh
origin recall                                        # the brief a new session here would get
origin recall --prompt "should we drop the v1 routes?"
origin recall --agent claude-code --cwd ~/code/acme  # as Claude Code would get it, without its own memories
origin recall --project main                         # as an agent that works in no directory gets it
```

## 查看交出了什么 {#see-what-was-handed-over}

`origin recalls` 按从新到旧列出 Agent 拿到的内容；加 `--all` 还会列出什么都没交出的召回，例如什么都没匹配到的提示。`origin show` 显示一次召回：它回应的提示（会话归档之后才能找到），以及每一项本会话之后有没有用上，也就是 Agent 之后的工具调用或回复中是否提到了它的 id。

```console
$ origin show rcl_7d2e9a0b1c3f
Recall      rcl_7d2e9a0b1c3f
Time        2026-10-28 10:15, at a prompt
Agent       claude-code, session 4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
Project     acme (/home/dana/code/acme)
Device      laptop
Prompt      should we drop the v1 routes?
            ↳ claude-code:5b2d7e1a-3c4f-4d6e-8f9a-0b1c2d3e4f5a
Tokens      about 162 of 600

Handed over, 1 item used since:
  1. prompt, score 9.84, used  ent_8e21b4c0d9f3
     The API keeps v1 routes until every client has moved to v2
  2. messages, score 7.12  codex:019a3b7c-2d4e-7f60-8a1b-9c0d1e2f3a4b:o57
     codex, 2026-10-25, assistant: …the access logs of every client: the v1 routes can be dropped once the mobile app ships 4.2, the last client that still calls /v1/orders.
```

管理界面的「召回」页显示同样的内容，并在会话页面上每次召回所在的那一轮、以及它交出的每个条目的页面上标出它；设备同步时会把召回发送给中枢，所以中枢的管理界面显示每台设备的召回。召回只保存 id、分数和提示的哈希（过往消息还有它的摘录从哪里开始），从不保存文本：每一项是什么，在你查看时才从你的库中读取，所以之后被你遗忘的条目或消息会显示为已遗忘。

## 如何选择 {#how-it-chooses}

- **项目**是你所在的 git 工作树，不在工作树中时就是这个目录本身。其他项目的记忆和知识从不交出。两个同名的检出按目录区分。
- **你在其他项目中的偏好**不放进简报，因为在一个项目中写下的记忆很少说明它在别处是否成立；但与它匹配的提示会把它带出来。不属于任何项目的条目会出现在每份简报中，所以在哪里都成立的条目，就不要给它指定项目。
- **Agent 自己的记忆**（从它为这个项目保存的记忆文件导入的条目）不会交还给它：它自己会加载。其他 Agent 会拿到这些条目。
- **匹配**在每个条目的第一行中查找提示里的词，并按你在自己的提示中（你自己写的，而不是 Agent、程序或别人写的）使用这个词有多少来给它定权重，所以你一直在用的词几乎不算数。它能找到用了你的词的条目，找不到换了说法表达同一件事的条目。
- **过往消息**按你的提示中最罕见的六个词，通过检索索引在含有每个词的最新消息中查找，再以同样的方式按它们的前 2,000 个字符匹配。它们只来自你在这个项目中的对话，本会话除外：你自己的提示和 Agent 的回复，从不来自子 Agent 的会话、无界面运行，或别人说的话。

规则详见[架构](../architecture.md#recall)。

## 限制 {#limits}

- 召回只读取本设备的库：你在其他设备上写下的条目和保存的会话暂时不会被召回。在中继上，hook 不交出任何内容，`brief` 由中枢作答。
- 召回交出的内容会进入 Agent 的对话，就像 Agent 读到的任何内容一样，并留在 Agent 自己的会话记录中。之后遗忘一个条目或一条消息，会让它不再出现在以后的召回中，但不会把它从已经拿到它的对话中移除。
