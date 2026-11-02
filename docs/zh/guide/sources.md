---
sourceHash: sha256-1fa888e4
---

# 接入你自己的来源

Origin 读取五个编码 Agent 的记录，每个 Agent 有自己的适配器。而你的很多工作发生在别处：另一个 Agent 运行时、一个聊天工作区、一条通知流、一条笔记流水线。这些都可以带进 Origin，不必改动它的代码：让一个脚本把它们的事件写成**事件行**（Origin 自己的一种 JSONL 格式），放进 Origin 读取的目录，它们就成为和任何 Agent 的会话一样的会话：出现在时间线、搜索、交给 Agent 的简报、线索和变更流中，也出现在管理界面里。对于 OpenClaw，Origin 有一个自己的写入者，即一个插件：见[接入 OpenClaw](./openclaw.md)。

## 格式 {#the-format}

一个事件行文件每行一个 JSON 对象，每个对象一个事件，只追加、不改写。每一行都有六个字段：`id`、所属的 `session`、`time`、`role`、`kind` 和 `text`。例如（合成数据）：

```json
{"id":"msg-1001","session":"incident-42","time":"2026-11-02T09:30:00Z","role":"user","kind":"message","text":"Is the deploy stuck?","project":"demo-app","title":"Deploy incident"}
```

- `time` 是带时区偏移的 ISO 8601，例如 `2026-11-02T09:30:00Z` 或 `2026-11-02T17:30:00+08:00`，或者以数字表示的 epoch 毫秒。
- `role` 是 `user`、`assistant` 或 `system`。
- `kind` 是 `message`（说出的话）、`tool_use` 和 `tool_result`（一次调用和它返回的结果）、`meta`（并非说出的上下文，例如注入的通知），或者 `system`（系统的事件）。
- 可选字段给出会话的标题（`title`）、项目和工作目录（`project`、`cwd`）、git 分支（`branch`）、一个事件所接续的那一行（`parent`）、一条消息是谁写的（`author`、`speaker`；见[谁写的](#who-wrote-it)），以及你想保留的其他任何内容（`meta`）。

无效的行，例如没有 `time` 的行，会被计为解析错误并跳过，其他行照常读取。全部字段和规则见[会话来源](../sources.md#your-own-sources-event-lines)。

## 在设备上写入 {#write-lines-on-a-device}

`~/.origin/sources/`（或 `$ORIGIN_HOME/sources/`）下的每个目录都是一个来源，以目录名命名，例如 `chat-ops`。名称由 2 到 32 个小写字母、数字和连字符组成，以字母开头，并且不是内置来源之一（`claude-code`、`codex`、`cursor`、`grok`、`zcode`），也不是 `origin`、`hub`、`local`、`all` 和 `devices`；其他名称的目录会被 Origin 忽略，同步时它会说明这一点。目录下任意深度的每个 `.jsonl` 文件都会被读取，所以写入者可以每天、每个频道或每次运行用一个文件。不需要别的设置。

在 shell 中：

```bash
mkdir -p ~/.origin/sources/chat-ops
echo '{"id":"msg-1002","session":"incident-42","time":"2026-11-02T09:31:00Z","role":"assistant","kind":"message","text":"It waits on a migration lock.","parent":"msg-1001"}' \
  >> ~/.origin/sources/chat-ops/incidents.jsonl
origin sync --source chat-ops
```

在 Node 中：

```js
// append-event.mjs: append one event line to the source chat-ops.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const home = process.env.ORIGIN_HOME || join(homedir(), '.origin');
const file = join(home, 'sources', 'chat-ops', 'incidents.jsonl');
mkdirSync(dirname(file), { recursive: true });
const event = {
  id: 'msg-1003',
  session: 'incident-42',
  time: new Date().toISOString(),
  role: 'user',
  kind: 'message',
  text: 'Release the lock, then retry the deploy.',
  project: 'demo-app',
};
appendFileSync(file, `${JSON.stringify(event)}\n`);
```

- **整行写入。** Origin 只读取完整的行，所以每一行要一次写完，以换行符结尾；还在写的行会在写完之后被读取。
- **何时读取。** `origin sync` 读取所有来源，`origin sync --source chat-ops` 只读这一个；Agent 运行期间，`origin mcp` 每分钟查看一次新增的行；`origin ui` 启动时会读取它们。`origin status` 会列出这个来源及其会话数和事件数。
- **它的版本。** 目录中的 `VERSION` 文件，第一行写一个版本号，例如 `chat-bridge 1.4.2`，会作为事件的 Agent 版本记录下来。
- **送往中枢。** 在接入了[个人中枢](./hub.md)的设备上，`origin sync` 会像发送每个 Agent 的记录一样，把这个来源已归档的行发送给中枢；中继则直接把这些文件新增的行发送给中枢。

## 把行发给你的中枢 {#send-lines-to-your-hub}

不在你任何设备上运行的写入者，例如聊天机器人或云端的 Agent 运行时，可以改为把它的行直接发给你的[个人中枢](./hub.md)。在中枢上为它创建一个自己的 Agent 令牌，以它命名，例如 `origin token create chat-bridge --agent`，然后提交行：

```bash
curl -sS -X POST "https://hub.example.com/v1/sources/chat-ops/lines?path=2026/11/02.jsonl" \
  -H "Authorization: Bearer $ORIGIN_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @lines.jsonl
```

```json
{ "lines": 2, "events": 2, "duplicates": 0, "parse_errors": 0 }
```

- **去向。** 中枢把这些行保存为该来源的文件 `path`，这里是 `chat-ops` 的 `2026/11/02.jsonl`，发送者是令牌的名称 `chat-bridge`，并像读取设备发来的内容一样读取它们。它们只在中枢上：设备从不下载它们，Agent 通过中枢找到它们，与那里的其他一切相同。
- **请求体。** 事件行，最多 8 MiB，类型为 `application/x-ndjson` 或 `text/plain`，可以用 gzip 编码。请使用 `--data-binary`，它按原样发送文件；`-d` 会去掉换行符。末尾没有换行符的单独一行，就像 `-d '{"id":…}'` 发送的那样，也没有问题。
- **回答。** 中枢读到多少行、它们带来多少新事件、多少行它已经有了（`duplicates`），以及多少行不是有效事件（`parse_errors`），这些行会被保留，但不会读出任何内容。
- **再发一次。** 如果不确定某个请求是否到达，就再发一次：中枢已有的行不会新增任何内容。
- **自己的令牌。** 设备的令牌也能用，并以那台设备的身份发送；用它发送的行，即使路径与那台设备自己的 `sources/` 目录中的某个文件相同，也会保存在一个单独的文件中，与设备的文件并存。

## 选择 id 与会话 {#choose-ids-and-sessions}

- **一个 id 永远指同一个事件。** 让一个来源的每个事件都有自己的 `id`，并且每次写它时都用同一个：写入者自己的 id（例如聊天消息的 id）最合适。`id` 已在该来源中的行不会新增任何内容，所以在不确定某一行是否写成功时，再写一次是安全的。你几台设备上同名的来源在中枢上是同一个来源，所以它们的 id 也不能相互冲突。
- **行永远不会被修改。** 与 Origin 的整个归档一样，来源是只追加的：一个事件一旦读入，文本就不再改变。要表达别的内容，就用新的 id 写一个新事件。
- **一个会话是一段对话。** 一个聊天线程、一次事故、一次任务运行、一天的笔记：任何你想作为整体打开的东西。它的事件按时间顺序显示，无论它们在哪个文件里。
- **Origin 给自己的对象用的 id** 以 `ent_`、`thr_`、`rcl_` 或 `prp_` 开头；会话 id 不要以它们开头，否则 `get` 会把它当成这些对象之一。

## 谁写的 {#who-wrote-it}

Origin 会记录每条消息是谁写的：你、别人、某个 Agent，还是某个程序。它从不自行把一条消息当成你的：要由你的来源在 `role` 为 `user` 的行上用 `author` 说明。

- `"author": "owner"`：你自己写的内容：你在聊天工作区里的消息、你的笔记，以及在你知道哪个说话人是你之后，转写稿中你说的那些行。
- `"author": "person"`：别人，或者没人说明是谁的说话人。不带 `author` 的 `message` 行属于某个人（person）。
- `"author": "agent"`：某个 Agent：在频道里回复的机器人，或者一个 Agent 给另一个 Agent 的提示。
- `"author": "system"`：由程序生成的内容：通知、告警、定时发出的提示。不带 `author` 的 `meta` 行属于系统。
- `"speaker"` 说明是谁，用人们认识的名字：`"Sam"`、`"Speaker 2"`、某个机器人的名字，最多 200 个字符。不要在这里写平台的用户 id：Origin 会原样显示它，也不识别任何人。

```json
{"id":"msg-2001","session":"incident-42","time":"2026-11-02T09:32:00Z","role":"user","kind":"message","text":"Roll back the migration.","author":"owner"}
{"id":"msg-2002","session":"incident-42","time":"2026-11-02T09:33:00Z","role":"user","kind":"message","text":"Rolling it back now.","author":"person","speaker":"Sam"}
```

没有说话人信息的录音什么也没说明，它的行属于某个人（person）。规则，以及每个 Agent 的记录如何说明消息是谁写的，见[作者](../architecture.md#authors)。

## 标题、项目与线索 {#titles-projects-and-threads}

- **标题。** 带 `title` 的行为它的会话命名，以最新的为准。本人给出的标题请加上 `"title_by": "user"`：之后不带它的标题不会替换它，就像你在 Claude Code 中重命名过的会话会保留它的名称一样。没有标题的会话以它的第一条用户消息命名，与任何 Agent 相同。
- **项目。** `project` 是项目名，与 Origin 在别处命名项目的方式一致：工作目录的最后一段，例如 `demo-app`。如果给出 `cwd`，即工作目录本身，简报就能区分两个同名的检出。一个在某项目中启动的 Agent，会收到这个项目最近的会话，来源不限，你自己的来源也在其中。
- **线索。** 同一项目中位于同一个 `branch`（`main` 这样的默认分支除外）上、彼此相隔不超过 30 天的会话，会彼此组成一条[线索](./concepts.md#threads)，也会与 Agent 在这个分支上的会话组成线索。Agent 也可以用 `follow` 把自己的会话接到你的某个会话上。

## 你会看到什么 {#what-you-see}

同步之后，来源的会话出现在 Origin 的每个视图中，与 Agent 的会话一样：

```bash
origin timeline --source chat-ops      # its sessions, with their threads
origin show incident-42                # one session, with its turns
origin search "migration lock"         # its messages, among everything else
origin recall --cwd ~/code/demo-app    # what an agent there is handed
```

- 在[管理界面](./admin.md)中，它以自己的名称列出，使用中性的颜色。
- 通过 MCP，`timeline`、`search`、`get` 和 `brief` 会显示它的会话和事件，`changes` 会在新事件到达时列出它们，所以每隔几分钟查看一次的 Agent 也能看到。
- Agent 可以在条目中引用它的事件，你也可以遗忘这些事件，与任何事件相同。

## 限制 {#limits}

- **Origin 不替你访问网络。** 它只读取文件。从聊天工作区或通知服务获取事件的写入者自己运行，轮询或订阅这个服务，然后追加行；Origin 从不访问这个服务，也不需要它的凭据。
- **它靠查看，没有人通知它。** 你自己的来源没有 hook：它们的行随下一次 `origin sync` 到达，或者在 Agent 运行 `origin mcp` 期间一分钟之内到达；发给中枢的行一到就会被读取。
- **不用于记忆。** `memory` 类会被拒绝：导入的记忆只来自 Agent 为自己保存的记忆文件。要记下一个决定或一条事实，请保存一个条目，并引用相应的事件。
- **不是编辑的地方。** 被重写而不是被追加的文件，会作为新的一代从头再读一遍，Origin 已经读入的事件保持原样。
