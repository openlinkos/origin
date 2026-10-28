---
sourceHash: sha256-f85f83fc
---

# 召回

会话开始时，以及你每发出一个提示时，Origin 可以把它已经知道、而在当下有用的内容交给你的 Agent：先是一份简报，包括你的偏好、项目的决定和事实，以及这个项目最近与你的各个 Agent 的会话；然后是与你的提示相关的条目。它通过 Agent 的 hook 工作，不调用任何模型，并记录下每一次交出的内容，所以你能看到 Agent 拿到了什么、有没有用上。

Claude Code 通过它的 hook 获得召回。其他 Agent 通过 Origin 的 MCP server 请求（见[其他 Agent](#other-agents)）。

## Agent 会拿到什么 {#what-an-agent-is-handed}

- **会话开始时**，一份简报：你在这个项目中的偏好与边界和在哪里都成立的偏好与边界，这个项目最新的决定和事实，以及这个项目最近 30 天内与任意 Agent 的最近几个会话。
- **每个提示**，第一行与提示有足够罕见的共同词的条目，最多五条，本会话已经拿到的不再给。

每一项一行，是 id 和条目的开头，所以一份简报不超过约 800 个 token，一个提示的匹配不超过 400 个。Agent 用 Origin 的 `get` 获取其余内容。例如，会话开始时：

```text
Origin recall rcl_3f9a0c1d2e4b: a brief from the user's cross-agent memory (project acme), one line each. Call Origin's `get` with an entry id for its full text and sources, or `timeline` with a session id to read that session. Entries can be outdated; the user's words in this session come first.

The user's preferences and boundaries:
- ent_5f0c2a9e41b7 Run the full test suite before pushing; never skip CI on both platforms

Project acme:
- ent_8e21b4c0d9f3 (2026-10-20) The API keeps v1 routes until every client has moved to v2

Latest sessions in acme, any agent (source, time, session id):
- codex 2026-10-27 18:02 0199a1b2-7c3d-4e5f-8a6b-9c0d1e2f3a4b: Migrate the billing client to v2; last prompt: run the integration tests again
```

## 为 Claude Code 设置 {#set-up-claude-code}

在 `~/.claude/settings.json` 中加入两个 hook（与你已有的 hook 并列），然后开始一个新的 Claude Code 会话：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ]
  }
}
```

在 Claude Code 中用 `/hooks` 可以看到它们。同时保留 Origin 的 MCP server 注册（见[接入 Agent](./connect-agents.md)），这样 Agent 才能用 `get` 获取拿到的条目。hook 用时不到一秒；出现任何问题时，它不交出任何内容，Claude Code 照常继续。

## 其他 Agent {#other-agents}

hook 无法交出内容的 Agent，例如 Grok Build、ZCode 和 Cursor，以及目前的 Codex，会自己请求简报：Origin 的 MCP server 有一个 `brief` 工具，它的说明会告诉 Agent 在开始任务时带上工作目录调用它。它们拿到同样的简报，加上 `about` 时还有与任务匹配的条目（见 [MCP 工具](./mcp.md#brief)）。除了[注册 Origin](./connect-agents.md)，不需要别的设置。这样的召回与 hook 的一样有记录；它的会话之后根据 Agent 日志中的召回 id 找到。

## 预览 {#preview}

`origin recall` 显示 Agent 在当前目录会拿到什么，不做任何记录：

```sh
origin recall                                        # the brief a new session here would get
origin recall --prompt "should we drop the v1 routes?"
origin recall --agent claude-code --cwd ~/code/acme  # as Claude Code would get it, without its own memories
```

## 查看交出了什么 {#see-what-was-handed-over}

`origin recalls` 按从新到旧列出 Agent 拿到的内容；加 `--all` 还会列出什么都没交出的召回，例如没有匹配到条目的提示。`origin show` 显示一次召回：它回应的提示（会话归档之后才能找到），以及每一项本会话之后有没有用上，也就是 Agent 之后的工具调用或回复中是否提到了它的 id。

```console
$ origin show rcl_7d2e9a0b1c3f
Recall      rcl_7d2e9a0b1c3f
Time        2026-10-28 10:15, at a prompt
Agent       claude-code, session 4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
Project     acme (/home/dana/code/acme)
Device      laptop
Prompt      should we drop the v1 routes?
            ↳ claude-code:5b2d7e1a-3c4f-4d6e-8f9a-0b1c2d3e4f5a
Tokens      about 96 of 400

Handed over, 1 item used since:
  1. prompt, score 9.84, used  ent_8e21b4c0d9f3
     The API keeps v1 routes until every client has moved to v2
```

管理界面的「召回」页显示同样的内容，并在会话页面上每次召回所在的那一轮、以及它交出的每个条目的页面上标出它；设备同步时会把召回发送给中枢，所以中枢的管理界面显示每台设备的召回。召回只保存 id、分数和提示的哈希，从不保存文本：每一项是什么，在你查看时才从你的库中读取，所以之后被你遗忘的条目会显示为已遗忘。

## 如何选择 {#how-it-chooses}

- **项目**是你所在的 git 工作树，不在工作树中时就是这个目录本身。其他项目的记忆和知识从不交出。两个同名的检出按目录区分。
- **你在其他项目中的偏好**不放进简报，因为在一个项目中写下的记忆很少说明它在别处是否成立；但与它匹配的提示会把它带出来。不属于任何项目的条目会出现在每份简报中，所以在哪里都成立的条目，就不要给它指定项目。
- **Agent 自己的记忆**（从它为这个项目保存的记忆文件导入的条目）不会交还给它：它自己会加载。其他 Agent 会拿到这些条目。
- **匹配**在每个条目的第一行中查找提示里的词，并按你在自己的提示中使用这个词有多少来给它定权重，所以你一直在用的词几乎不算数。它能找到用了你的词的条目，找不到换了说法表达同一件事的条目。

规则详见[架构](../architecture.md#recall)。

## 限制 {#limits}

- 召回只读取本设备的库：你在其他设备上写下的条目暂时不会被召回。在中继上，hook 不交出任何内容，`brief` 由中枢作答。
- 召回交出的内容会进入 Agent 的对话，就像 Agent 读到的任何内容一样，并留在 Agent 自己的会话记录中。之后遗忘一个条目，会让它不再出现在以后的召回中，但不会把它从已经拿到它的对话中移除。
