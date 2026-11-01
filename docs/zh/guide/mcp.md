---
sourceHash: sha256-4e536dab
---

# MCP 工具

Origin 通过 [Model Context Protocol](https://modelcontextprotocol.io) 提供八个工具：`brief` 把 Agent 工作之处有用的内容交给它，四个用来读取归档和条目，三个用来写条目和遗忘。本页是给把 Origin 接入 Agent、或在它之上开发的人看的参考；只想接入 Agent，请看[接入 Agent](./connect-agents.md)。

## 接入方式 {#reaching-origin}

有两种接入方式，工具相同：

- **在设备上**，Agent 启动 `origin mcp`，通过 stdio 提供服务。它从设备自己的库作答。在连接了[个人中枢](./hub.md)的设备上，它还会同时询问中枢，并合并两边的答案；在[中继](./hub.md#run-a-device-as-a-relay)上，它把每次调用都交给中枢。
- **在中枢上**，`POST /mcp` 通过 MCP Streamable HTTP 提供同样的工具，无状态，响应为 JSON（不用服务器推送事件，`GET` 会返回 405），所以可以放在任何代理或 CDN 之后。这是给云端 Agent 和其他没有本地会话日志的客户端用的：
  - 必须带 `Authorization: Bearer <token>`，令牌在中枢上创建（`origin token create <name>`）。
  - `X-Origin-Client: <agent>` 可选。通过这次请求写下的条目记为 `<agent>@<令牌名>`；不带这个头时只记令牌名。
  - `X-Origin-Device: <name>` 可选，带了就必须等于令牌名，否则中枢以 403 拒绝请求。

```bash
# 云端 Agent 用它自己的令牌注册中枢的端点
claude mcp add --scope user --transport http origin https://hub.example.com/mcp \
  --header "Authorization: Bearer ogn_…" --header "X-Origin-Client: claude-code"
```

服务器在 MCP 的 `instructions` 里告诉 Agent 怎样使用这些工具：开始任务时，如果召回还没有给过简报，就调用 `brief`；回答关于过去工作的问题前先检索和阅读（顺着 `get` 在它打开的内容旁列出的 id 读下去，长会话一次读一轮），并引用条目和事件的 id；记下决定及其理由、稳定的事实和用户的偏好，并引用它们出自的事件；把标为 `imported` 的条目看作某个 Agent 自己记忆文件的镜像；纠正有误的条目；只在用户要求时遗忘，并带上用户给的原因。

## 约定 {#conventions}

- **结果**是一个 JSON 文本项。结果中的时间是 ISO 8601 格式，用服务器所在时区的本地时间，带毫秒和时区偏移，例如 `2026-10-20T09:12:30.000+08:00`。
- **时间参数**（`since`、`until`、`valid_from`、`valid_to`）接受相对值 `30m`、`24h`、`7d`、`2w`（从现在往前算），或绝对的日期、时间：`2026-10-20` 或 ISO 8601。
- **id。** 条目 id 是 `ent_` 加 12 到 32 个十六进制字符。事件 id 是 `<来源>:<来源中的 id>`，例如 `claude-code:7d0c4a1e-…`；来源是 `claude-code`、`codex`、`cursor`、`zcode` 或 `grok` 之一。会话用它的 Agent 自己给的 id（例如一个 UUID），也可以像召回记录它那样写成 `<来源>:<会话 id>`。召回 id 是 `rcl_` 加 12 个十六进制字符。[`get`](#get) 可以打开其中任意一种。
- **错误**以工具错误（`isError`）返回，附可读的说明，从不作为协议错误返回：无效的输入、未知的 id（`Unknown entry or event <id>.`）和已遗忘的 id（`<id> has been forgotten.`）。
- **在连接了中枢的设备上**，结果中的每个条目、事件、会话和来源都带有 `origin`：本设备有的为 `local`，只有中枢有的为 `hub`；结果中列出的存根（见下文）不带，因为它们来自给出回答的那个库。同一条目的多个版本只列出当前版本。如果中枢在 2 秒内（`ORIGIN_HUB_TIMEOUT_MS`）没有回答，结果只包含本设备的答案，后面再跟一个文本项：`Note: the Origin hub was not consulted (<reason>); these results come from this device only.`
- **在中继上**，每个结果都是中枢返回的原样，不带 `origin` 标注。连不上中枢时，每个工具都会失败，并说明中继只能通过它的中枢作答。

## 条目、事件和会话 {#entries-events-and-sessions}

结果中的**条目**有这些字段：

| 字段 | 含义 |
|---|---|
| `id`、`kind`、`text`、`confidence` | 条目本身：`kind` 为 `memory`、`knowledge` 或 `cognition`；`confidence` 在 0 到 1 之间 |
| `status` | `active`（当前版本）或 `superseded`；已遗忘的条目从不返回 |
| `concurrent` | 对已取代的版本：如果它是输给了一次并发纠正，而不是被纠正，就为 true |
| `project` | 所属项目，没有则为 null |
| `author` | 写下它的人：`<agent>@<设备>`，或来自 CLI 和管理界面的 `user@<设备>` |
| `created` | 这个版本写下的时间 |
| `valid_from`、`valid_to` | 它成立的时间范围，已知时才有。`valid_to` 已过的条目不出现在检索和列表中 |
| `supersedes`、`superseded_by`、`root` | 它纠正的版本、本版本被取代时的当前版本，以及条目的第一个版本（所有版本共用） |
| `imported` | 如果它派生自某个 Agent 自己的记忆文件（见[原生记忆](../sources.md#native-memories)），则为 true：文件之后的版本会取代在 Origin 中做的纠正。早于 0.3 的中枢不返回这个字段 |

**事件**有 `id`、`time`、`source`、`project`、`session`（会话 id）、`role`（`user`、`assistant` 或 `system`）、`kind`（`message`、`tool_use`、`tool_result`、`meta`、`system`，或表示记忆文件某个版本的 `memory`）和 `text`；`text` 按工具截断到不同长度，末尾注明截掉了多少字符。

**会话**有 `session`、`source`、`project`、`title`（Agent 给它起的标题，没有则为 null）、`prompt`（没有标题的会话的第一条提示，截到 80 个字符）、`started`、`ended` 和 `events`（可见事件的数量）。

**存根**是结果对它近旁内容的展示：一行，带一个 id，供 `get` 打开。条目的存根是 `{ id, kind, text, created }`，`text` 取它的第一行；事件的存根是 `{ id, time, role, kind, text }`，`text` 是合并成一行的正文；两者都截到约 120 个字符。会话的存根就是上面这样的会话。

## brief {#brief}

用户的记忆中与 Agent 工作之处有关的内容，每项一行：一份简报，包括用户的偏好与边界、项目最新的决定和事实、这个项目最近与任意 Agent 的会话；加上 `about` 时，还有与它匹配的条目。它就是 Agent 的 hook 会拿到的内容（见[召回](./recall.md)），供 hook 无法交出内容的 Agent 使用，也以同样的方式记录为一次召回。

| 参数 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `cwd` | 字符串 | server 运行所在的目录 | Agent 的工作目录：包含它的 git 工作树，或者这个目录本身，就是项目。中枢看不到 Agent 的磁盘，所以按原样使用这个目录，而且必须提供 |
| `about` | 字符串 | 无 | 任务是关于什么的，用用户的话说：会加上与它匹配的条目 |

它返回 `{ recall, text }`：召回的 id，以及各项内容，上面有一行说明如何阅读；如果用户的记忆中还没有这个项目的内容，就是一行这样的说明。在已接入中枢的设备上，`brief` 只读取设备的库；中继把它交给中枢，以自己运行所在的工作树作为 `cwd`，中枢把这次召回记录为为该设备所做。

```json
{ "cwd": "/home/dana/code/demo-app", "about": "the release workflow" }
```

```json
{
  "recall": "rcl_8b2f4e1a9c0d",
  "text": "Origin recall rcl_8b2f4e1a9c0d: a brief from the user's cross-agent memory (project demo-app), one line each. Origin's `get` opens any id here: an entry for its text and sources, a session for its turns and what was written from it. Entries can be outdated; the user's words in this session come first.\n\nThe user's preferences and boundaries:\n- ent_5f0c2a9e41b7 Run the full test suite before pushing\n\nProject demo-app:\n- ent_3f9a1c2b7d4e (2026-10-20) Releases are tagged from master once CI passes on Ubuntu and Windows."
}
```

## search {#search}

对条目和会话事件做全文检索，最匹配的在前。不给查询时，列出最近的条目。

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `query` | 字符串 | 无 | 词或短语；每个词都必须出现，任何语言都可以（见[检索与时间线](../architecture.md#search-and-timeline)） |
| `scope` | `all`、`entries` 或 `events` | `all` | 检索什么 |
| `kind` | `memory`、`knowledge` 或 `cognition` | 任意 | 只要这一类的条目 |
| `since`、`until` | 时间 | 无 | 条目写下的时间、事件发生的时间 |
| `source` | 来源 id | 任意 | 只要这个来源的事件 |
| `project` | 字符串 | 任意 | 只要这个项目的条目和事件 |
| `include_tools` | 布尔值 | `false` | 除了消息，也检索工具调用和工具结果 |
| `limit` | 整数，1 到 100 | 20 | 条目和事件各自最多返回这么多 |

返回 `{ entries, events }`：当前的条目（不含有效期已结束的），以及事件；每个事件的文本截到 400 个字符，并带有一个 `snippet`，即第一处匹配附近最多 200 个字符，每处匹配都用方括号标出，还带有 `session_title`，即事件所在会话的标题，没有标题时为它的第一条提示。

```json
{ "query": "release workflow", "limit": 5 }
```

```json
{
  "entries": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "kind": "memory",
      "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
      "confidence": 0.9,
      "status": "active",
      "concurrent": false,
      "project": "demo-app",
      "author": "claude-code@laptop",
      "created": "2026-10-20T09:12:30.000+08:00",
      "valid_from": null,
      "valid_to": null,
      "supersedes": null,
      "superseded_by": null,
      "root": "ent_3f9a1c2b7d4e",
      "imported": false
    }
  ],
  "events": [
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
      "time": "2026-10-20T09:01:05.120+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "user",
      "kind": "message",
      "text": "Set up the release workflow: tag from master, publish with provenance.",
      "snippet": "Set up the [release] [workflow]: tag from master, publish with provenance.",
      "session_title": "Release workflow"
    }
  ]
}
```

## timeline {#timeline}

某个时间范围内的会话，最新的在前；给了 `session` 时，按顺序一页一页地列出一个会话的事件。

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `since` | 时间 | `7d` | 自那时起有活动的会话 |
| `until` | 时间 | 无 | 在那时之前开始的会话 |
| `source` | 来源 id | 任意 | 只要这个来源的会话；与 `session` 一起使用时，指那个会话的来源 |
| `project` | 字符串 | 任意 | 只要这个项目的会话 |
| `session` | 字符串 | 无 | 会话 id：改为列出它的事件 |
| `turn` | 整数，0 或更大 | 无 | 与 `session` 一起使用时：只列出这一轮的事件。一轮从一条提示开始，第一条为 1；0 是第一条提示之前的内容 |
| `after` | 事件 id | 无 | 与 `session` 一起使用时：只列出这个事件之后的事件，即上一页的最后一个之后 |
| `include_tools` | 布尔值 | `false` | 与 `session` 一起使用时：除了消息，也列出工具调用和结果、注入的上下文和系统事件 |
| `limit` | 整数，1 到 500 | 50 | 最多返回这么多会话或事件 |

返回 `{ sessions }`，按最后活动时间排序；或者在给了 `session` 时返回 `{ session, title, prompt, events, more }`：会话的名称，所请求范围内最早的若干事件，从早到晚，每个事件的文本截到 1,000 个字符，以及 `more`，即这个范围内最后一个事件之后还有多少可见的事件。要继续读，把最后一个事件的 id 作为 `after` 传入；要读某一轮，把它的序号作为 `turn` 传入（[`get`](#get) 给出的会话卡片列出了它的各轮）。两个来源的会话共用同一个会话 id 时，需要给出 `source`。

```json
{ "since": "2d", "project": "demo-app", "limit": 2 }
```

```json
{
  "sessions": [
    {
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "source": "claude-code",
      "project": "demo-app",
      "title": "Release workflow",
      "prompt": null,
      "started": "2026-10-20T09:01:05.120+08:00",
      "ended": "2026-10-20T10:44:51.007+08:00",
      "events": 212
    },
    {
      "session": "ses_0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d",
      "source": "zcode",
      "project": "demo-app",
      "title": null,
      "prompt": "Why does the upload retry twice on a 503?",
      "started": "2026-10-19T16:20:00.000+08:00",
      "ended": "2026-10-19T16:52:13.480+08:00",
      "events": 48
    }
  ]
}
```

一个会话的一轮，每次两个事件：

```json
{ "session": "2f1e8c47-0000-4000-8000-000000000001", "turn": 2, "limit": 2 }
```

```json
{
  "session": "2f1e8c47-0000-4000-8000-000000000001",
  "title": "Release workflow",
  "prompt": null,
  "events": [
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000005",
      "time": "2026-10-20T09:20:41.300+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "user",
      "kind": "message",
      "text": "Now publish with provenance from the release job."
    },
    {
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000006",
      "time": "2026-10-20T09:20:52.004+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "assistant",
      "kind": "message",
      "text": "The release job now publishes with --provenance; it needs id-token: write."
    }
  ],
  "more": 3
}
```

下一页用同样的 `turn`，并传入 `"after": "claude-code:7d0c4a1e-0000-4000-8000-000000000006"`。

## get {#get}

Origin 交出的任意 id，连同它近旁的内容：条目、事件、会话或召回（见[沿引用阅读](../architecture.md#reading-along-references)）。近旁的一切都以存根给出，一行，带着 id，这样 Agent 就能一跳一跳地打开接下来要紧的内容，而不必读完整个会话。

| 参数 | 类型 | 含义 |
|---|---|---|
| `id` | 字符串 | 条目 id（`ent_…`）、事件 id（`<来源>:…`）、会话 id（单独的 id，或 `<来源>:<会话 id>`）或召回 id（`rcl_…`） |
| `source` | 来源 id | 两个来源的会话共用同一个会话 id 时：指明是哪一个。不给时，这样的 id 会报错，并列出这些来源 |
| `offset` | 整数，0 或更大 | 对事件：正文从哪里开始，以 UTF-16 码元计（默认 0），用来分页读取很长的正文 |

- **条目**：`{ entry, sources, history, related }`。`sources` 是它引用的事件，每个带有它从中引用的 `quote`（没有则为 null）、截到 500 个字符的文本，以及 `session_title`；`history` 列出条目的每个版本，从早到晚，包括分叉，每个版本有 `id`、`supersedes`、`author`、`created` 和 `status`；`related` 以存根列出最多 10 个其他的当前条目，它们引用了这个条目所引用会话中的某个事件，从新到旧。已被取代或有效期已结束的条目，按 id 仍然可以取到。
- **事件**：事件本身，带有它的 `cwd`、`git_branch`、`agent_version` 和 `session_title`，以及从 `offset` 开始、最多 20,000 个字符的正文，并给出 `total_chars`（正文全长）和 `next_offset`（下一页的起点，读到末尾时为 null）。它的第一页（`offset` 为 0）还带有它近旁的内容：`turn`，即 `{ number, prompt }`，它所在的轮次和开启这一轮的提示的存根，在第一条提示之前则为 null；`replies_to`，它的 Agent 记录的、它所接续的事件的存根（Claude Code 的 `parentUuid`），没有则为 null；`around`，即 `{ before, after }`，同一会话中它前后各两个可见事件的存根，除非它本身是工具调用或工具结果，否则只取消息；以及 `cited_by`，以存根列出最多 10 个引用它的当前条目。
- **会话**：一张卡片，带有会话的各字段、它的 `cwd`，以及 `turns`（轮数）；`prompts`，它前 20 轮的起点，每个为 `{ turn, id, time, text }`，以及 `more_prompts`，即这些之后还有多少轮；`entries`，以存根列出最多 10 个从中写下的当前条目（引用了它的事件的条目），从新到旧；`recalls`，最多 10 次它拿到的召回，从新到旧，每次为 `{ id, occasion, time, items }`，`items` 是它交出的内容中仍然可见的数量；以及 `before` 和 `after`，同一项目中按开始时间紧挨在它前后的会话，不限 Agent，没有则为 null。要读某一轮，用 [`timeline`](#timeline)。
- **召回**：`{ id, time, occasion, agent, session, device, project, directory, budget, tokens, items, text }`：它在何时、为哪个 Agent、哪个会话和哪台设备、在哪里而做，它的预算和用掉的 token，它的各项，每项为 `{ rank, layer, kind, id, score, used }`（会话还有 `source`；`used` 表示会话后来是否用到了这一项，会话还不知道时为 null），以及 `text`，即 Agent 拿到的内容，按库现在的样子重建。此后被遗忘的内容在两者中都会略去。

当前条目就是列表中会显示的条目：没有被取代、没有被遗忘、也没有到期。被遗忘的内容从不出现在存根中，也不被计数。在连接了中枢的设备上，事件、会话或召回来自其中一个库，带的是那个库的存根：设备有这个 id 时用设备的，否则用中枢的，并去掉设备已遗忘的内容。

```json
{ "id": "ent_3f9a1c2b7d4e" }
```

```json
{
  "entry": {
    "id": "ent_3f9a1c2b7d4e",
    "kind": "memory",
    "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
    "status": "active",
    "root": "ent_3f9a1c2b7d4e",
    "imported": false
  },
  "sources": [
    {
      "quote": "tag from master",
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
      "time": "2026-10-20T09:01:05.120+08:00",
      "source": "claude-code",
      "project": "demo-app",
      "session": "2f1e8c47-0000-4000-8000-000000000001",
      "role": "user",
      "kind": "message",
      "text": "Set up the release workflow: tag from master, publish with provenance.",
      "session_title": "Release workflow"
    }
  ],
  "history": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "supersedes": null,
      "author": "claude-code@laptop",
      "created": "2026-10-20T09:12:30.000+08:00",
      "status": "active"
    }
  ],
  "related": [
    {
      "id": "ent_9c4d2e7f1a6b",
      "kind": "knowledge",
      "text": "The npm token is gone: packages publish through trusted publishing.",
      "created": "2026-10-20T10:31:02.517+08:00"
    }
  ]
}
```

上面的条目做了删节；实际结果包含它的全部字段。按 id 打开一个会话：

```json
{ "id": "2f1e8c47-0000-4000-8000-000000000001" }
```

```json
{
  "session": "2f1e8c47-0000-4000-8000-000000000001",
  "source": "claude-code",
  "project": "demo-app",
  "cwd": "/home/dana/code/demo-app",
  "title": "Release workflow",
  "prompt": null,
  "started": "2026-10-20T09:01:05.120+08:00",
  "ended": "2026-10-20T10:44:51.007+08:00",
  "events": 212,
  "turns": 2,
  "prompts": [
    {
      "turn": 1,
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
      "time": "2026-10-20T09:01:05.120+08:00",
      "text": "Set up the release workflow: tag from master, publish with provenance."
    },
    {
      "turn": 2,
      "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000005",
      "time": "2026-10-20T09:20:41.300+08:00",
      "text": "Now publish with provenance from the release job."
    }
  ],
  "more_prompts": 0,
  "entries": [
    {
      "id": "ent_3f9a1c2b7d4e",
      "kind": "memory",
      "text": "Releases are tagged from master once CI passes on Ubuntu and Windows.",
      "created": "2026-10-20T09:12:30.000+08:00"
    }
  ],
  "recalls": [
    { "id": "rcl_8b2f4e1a9c0d", "occasion": "start", "time": "2026-10-20T09:01:04.870+08:00", "items": 2 }
  ],
  "before": {
    "session": "ses_0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d",
    "source": "zcode",
    "project": "demo-app",
    "title": null,
    "prompt": "Why does the upload retry twice on a 503?",
    "started": "2026-10-19T16:20:00.000+08:00",
    "ended": "2026-10-19T16:52:13.480+08:00",
    "events": 48
  },
  "after": null
}
```

## sources {#sources}

条目或事件背后的原始日志行：一个答案的出处。

| 参数 | 类型 | 含义 |
|---|---|---|
| `id` | 字符串 | 条目 id 或事件 id |

返回一个列表，每个被引用的事件一项（事件则只有一项）：`event_id`、`time`、`quote`、`original_file`（Agent 的日志文件，在拥有它的设备上的路径）、`mirror_file`（Origin 为它保存的镜像，存为 `<mirror_file>.zst` 和 `<mirror_file>.tail`）、`line`（在镜像中的行号，与原始文件那一版中的行号相同），以及 `raw`，即 Agent 写下的那一行原文，截到 4,000 个字符。在中枢上，`original_file` 是发送它的设备上的路径。

```json
{ "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001" }
```

```json
[
  {
    "event_id": "claude-code:7d0c4a1e-0000-4000-8000-000000000001",
    "time": "2026-10-20T09:01:05.120+08:00",
    "quote": null,
    "original_file": "/home/dev/.claude/projects/-home-dev-demo-app/2f1e8c47-0000-4000-8000-000000000001.jsonl",
    "mirror_file": "/home/dev/.origin/raw/claude-code/-home-dev-demo-app/2f1e8c47-0000-4000-8000-000000000001.jsonl",
    "line": 3,
    "raw": "{\"type\":\"user\",\"uuid\":\"7d0c4a1e-0000-4000-8000-000000000001\",\"message\":{\"role\":\"user\",\"content\":\"Set up the release workflow: tag from master, publish with provenance.\"}}"
  }
]
```

## remember {#remember}

保存一个新条目。每个条目至少引用一个事件，以便追溯到当时说的话。

| 参数 | 类型 | 含义 |
|---|---|---|
| `kind` | `memory`、`knowledge` 或 `cognition` | 发生了什么（一个决定及其理由）、一个稳定的事实，或用户的偏好、方法、目标或边界 |
| `text` | 字符串，必填 | 一句自成一体的陈述 |
| `sources` | 列表，至少一项 | 每项为 `{ event_id, quote }`：事件 id、一段原文引用，或两者都有 |
| `confidence` | 数字，0 到 1，必填 | Agent 有多大把握 |
| `project` | 字符串 | 所属项目，如果有 |
| `valid_from`、`valid_to` | 时间 | 它成立的时间范围，如果已知 |

带 `event_id` 的来源必须指向一个可见的事件，给了 `quote` 的话，引文必须出现在其中（忽略空白和大小写）。只带 `quote` 的来源，引用包含它的最近一条可见消息，找不到时再找工具结果；从不匹配工具调用，因为 Agent 自己的 `remember` 调用里就含有这段引文。要引用对话中刚写下的内容，直接引用原文即可：服务器在保存前会先读入新的日志行。返回 `{ entry }`，即新条目，作者为 `<agent>@<设备>`，其中 agent 是 MCP 客户端的名称。

```json
{
  "kind": "cognition",
  "text": "Prefers small commits, each with one purpose.",
  "confidence": 0.9,
  "sources": [{ "quote": "keep each commit to one purpose" }]
}
```

可能的错误包括 `No event contains the quote "…". Search for the event and cite its id instead.`、`Quote not found in event <id>: "…"` 和 `Event <id> has been forgotten and cannot be cited.`

## correct {#correct}

用纠正后的版本替换一个条目。旧版本留在历史中，新版本取代它。

| 参数 | 类型 | 含义 |
|---|---|---|
| `id` | 字符串 | 条目的当前版本 |
| `text` | 字符串，必填 | 纠正后的陈述 |
| `kind` | `memory`、`knowledge` 或 `cognition` | 新的类别；默认沿用旧的 |
| `confidence` | 数字，0 到 1 | 新的置信度；默认沿用旧的 |
| `sources` | 列表 | 更多来源，加在沿用下来的来源之后 |
| `valid_from`、`valid_to` | 时间 | 新的有效期；默认沿用旧的 |

只能纠正当前版本：纠正其他版本会失败，并给出当前版本的 id（`Entry <id> was already corrected; its current version is <id>. Correct that one instead.`）。纠正的时间总是晚于它所纠正的版本。返回 `{ entry }`，即新版本。在连接了中枢的设备上，只有中枢才有的条目会在中枢上纠正，这需要能连上中枢。

```json
{ "id": "ent_3f9a1c2b7d4e", "text": "Releases are tagged from master once CI passes on Ubuntu, Windows, and macOS." }
```

## forget {#forget}

隐藏一个条目、它的每个版本和它引用的事件；或者一个事件和引用它的每个条目。被隐藏的内容退出每个库上的一切查询，也不能再被引用。Agent 只在用户要求时调用它，并带上用户给的原因（见[遗忘](./privacy.md#forgetting)）。

| 参数 | 类型 | 含义 |
|---|---|---|
| `id` | 字符串 | 条目 id 或事件 id |
| `reason` | 字符串，1 到 2,000 个字符，必填 | 用户为什么要遗忘它；随记录保存 |

返回 `{ tombstone, forgotten_entries, excluded_events }`：这次遗忘的 id（`tmb_…`）、它隐藏的条目版本的 id，以及它隐藏的事件数量。如果所有内容都已经被隐藏，就不会记录任何东西，`tombstone` 为 null。在连接了中枢的设备上，只有中枢才有的条目或事件会在中枢上遗忘。

```json
{ "id": "claude-code:7d0c4a1e-0000-4000-8000-000000000002", "reason": "I pasted an API key in this prompt" }
```

```json
{ "tombstone": "tmb_6c1d0e9a2b3f", "forgotten_entries": [], "excluded_events": 1 }
```

**没有恢复工具**：遗忘是一条记录，只有用户本人能撤销，用 `origin restore` 或管理界面。

## 时效 {#freshness}

Agent 能找到并引用刚刚说过的话，因为 `origin mcp` 会边运行边读取 Agent 的日志：

- 启动时，它在后台读入所有来源；在连接了中枢的设备上，还会与中枢同步。
- `brief`、`search` 和 `timeline` 先读入新的日志行，最多每 10 秒一次。在连接了中枢的设备上，`get` 和 `sources` 也会这样做，并且每次读取还会与中枢同步，最多每 10 秒一次，等待中枢的时间不超过中枢超时。
- `remember` 和 `correct` 总是先读入新行；在连接了中枢的设备上，之后会立即与中枢同步。
- 在后台，它每 60 秒查看一次有没有新的日志行（`ORIGIN_WATCH_INTERVAL_MS`；设为 `0` 则关闭），只有日志文件有变化时才读入和同步。
- Agent 退出时，它再读入并同步一次，最多 5 秒。

中枢的 `/mcp` 按中枢库的现状作答：其中有每台设备已同步的内容，而设备按上面所说的方式同步。不使用 Origin 的 Agent 的会话，要等下一次使用 Origin 的 Agent 运行，或运行 `origin sync`，才会进入库中。
