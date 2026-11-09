---
sourceHash: sha256-b9a07aa8
---

# 接入 OpenClaw

[OpenClaw](https://docs.openclaw.ai) 在它的 Gateway 中运行 Agent，常常是在一台没有运行 Origin 设备的服务器上，并把它们的记录保存在自己的数据库里。Origin 的 OpenClaw 插件 `@openlinkos/origin-openclaw` 在 Gateway 内部看到每一轮对话结束，把它作为[事件行](./sources.md)写进 Origin：发给你的[个人中枢](./hub.md)，或者写进同一台主机上某个 Origin 设备读取的目录。这样，你的 OpenClaw Agent 的会话就会像任何 Agent 的会话一样出现在 Origin 中。有中枢时，插件还会在你发起的轮次中，无论是私聊、频道还是子区，把 Origin 的读取工具交给这些 Agent，让它们拿到关于自己工作的简报，并能查阅你记忆中的其余内容；在别人发起的轮次中则从不给出（见[让 Agent 读取 Origin](#read-origin-from-your-agents)）。

这个插件对照 OpenClaw 2026.10.6 核对过：它的钩子及其载荷、插件清单和安装命令，都按这个版本的样子使用；它的工具遵循这个版本关于插件工具的文档。

## 它发送什么 {#what-it-sends}

- **每一轮，在它结束时。** 有会话访问权限时（见[下文](#with-or-without-conversation-access)），插件在一次运行结束时（`agent_end`），以及在 OpenClaw 把消息压缩掉之前（`before_compaction`），读取这次运行的消息。没有这个权限时，它用到达的消息（`message_received`）、工具调用（`after_tool_call`）和每条发出的回复（`message_sent`）拼出每一轮。
- **消息与工具。** 用户的消息、Agent 的回复、它的工具调用（`tool_use`）及其结果（`tool_result`），像 Origin 的适配器那样分别截断到 2,000 和 4,000 个字符。OpenClaw 为一轮对话附加的上下文，以及它压缩会话时写下的摘要，记为 `meta`。思考过程不发送。
- **附件。** 带着文件（例如一张照片）的消息会说明这一点：每个文件的类型（`image`、`audio`、`video`、`sticker` 或 `file`），以及 OpenClaw 给出时的文件名和大小，最多十个，记在这一行的 `meta.attachments` 中；消息文本之后还会为每个文件加一个标记，例如 `[image: IMG_0001.jpg]`，让搜索能找到它，也让只有文件的消息同样被记录下来。文件的内容和它存放的位置从不发送：没有内容、路径或链接。
- **每条消息是谁写的。** 每条用户消息都按 OpenClaw 的记录说明它是谁写的：OpenClaw 的所有者、另一个人、另一个 Agent，还是 OpenClaw 自己，以及用的是什么名字（见[下文](#who-wrote-each-message)）。
- **会话。** 每个 OpenClaw 会话键对应一个会话，例如 `agent:main:telegram:direct:42`；它的标题只设一次，取自第一条用户消息，截断到 80 个字符，并去掉渠道加的信封。`/new` 和 `/reset` 保留会话键，所以对话在 Origin 中延续在同一个会话里；每一行的 `meta.sessionId` 能区分 OpenClaw 的各个会话。
- **项目。** 每个会话的项目是它的 Agent 的 id，例如 `main`，除非你按渠道命名它，或者给所有会话同一个名字（`projectBy`、`project`）。
- **上下文。** 每一行的 `meta` 包含 OpenClaw 给出的 Agent、渠道及其账号、会话键和会话 id，以及这次运行；工具的行还包含工具名和这次调用的 id（`callId`），用来把调用和它的结果配对。
- **稳定的 id。** 一行的 id 是它的会话、它的消息的时间、它的角色和类型以及它在消息中的位置的哈希，不包括它是谁写的，所以再次发送的消息，例如丢失应答或重启之后，id 不变，Origin 不会为它新增任何东西。
- **它略去什么。** 你没有列出的 Agent（`agents`）；不是某个人发起的那一轮的运行（`triggers`），例如心跳和定时任务，连同它们加入的消息；无痕线程；以及 OpenClaw 自己的内部运行，无论它们的触发方式是什么：它为一次运行的副作用保留的隐藏会话（会话键为 `agent:<agent>:internal-session-effects:…`），例如一次性的模型运行（`openclaw infer model run --gateway`）、后端要求不留可见副作用的运行、Control UI 的旁聊或认证探测；以及 Active Memory 的召回运行（`…:active-memory:…`）。OpenClaw 把其中一些作为 `user` 运行启动，并把它们的提示记为所有者的，但没有人和 Agent 进行过这些对话。
- **发生了什么，就发送什么。** 行中的任何内容都不做脱敏：一条消息、一次工具调用或一个工具的结果，都按运行中的原样发送，其中含有的密钥也一样，例如粘贴进消息的令牌，或者密码管理器的工具返回的值。要完全不发送工具调用和结果，把 `includeTools` 设为 `false`。

## 安装 {#install}

在 Gateway 所在的主机上用 OpenClaw 的命令安装它；`--pin` 记下安装的版本，`npm:@openlinkos/origin-openclaw@<version>` 可以选定一个版本，例如与你的 Origin 相同的版本：

```bash
openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities
```

要在发布之前试一个改动，可以从 Origin 的代码检出构建它并安装打出的包；可以在任何地方构建，再把文件复制到 Gateway 的主机上：

```bash
git clone https://github.com/openlinkos/origin.git && cd origin
pnpm install && pnpm build
cd packages/openclaw && pnpm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/openlinkos-origin-openclaw-*.tgz --force --accept-capabilities
```

`openclaw plugins install ./packages/openclaw --force --accept-capabilities` 则安装构建好的目录，加 `-l` 会链接它而不是复制。`--force` 确认你信任一个 ClawHub 之外的来源，`--accept-capabilities` 通过 OpenClaw 对这类来源的插件要求的能力审查。它在 OpenClaw 中的 id 是 `origin`。然后按下文配置它；`openclaw plugins inspect origin --runtime --json` 会列出它注册的钩子和工具。安装新版本会应用到正在运行的 Gateway，不需要重启 Gateway。

## 配置 {#configure}

插件的设置写在 Gateway 的配置 `~/.openclaw/openclaw.json` 中，位于 `plugins.entries.origin` 之下。发往中枢、令牌保存在 1Password 中、只记录一个 Agent 时：

```json
{
  "plugins": {
    "entries": {
      "origin": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "hub": "https://hub.example.com",
          "token": { "source": "exec", "provider": "onepassword", "id": "op://OpenClaw/origin-hub/credential" },
          "agents": ["main"]
        }
      }
    }
  }
}
```

| 选项 | 默认值 | 作用 |
|---|---|---|
| `hub` | | 你的中枢的 URL；设置它或 `dir` |
| `token` | | 中枢令牌：一个由 Gateway 解析的 SecretRef，或者令牌本身 |
| `tokenEnv` | | 保存令牌的 Gateway 环境变量的名字，用来代替 `token` |
| `dir` | | 这台主机上某个 Origin 设备读取的目录，例如 `~/.origin/sources/openclaw`；设置它或 `hub` |
| `source` | `openclaw` | 中枢记录这些行所用的来源；写入目录时，目录的名字就是来源 |
| `agents` | 所有 Agent | 要记录的 Agent 的 id |
| `triggers` | `["user"]` | 要记录的运行类型：`user` 表示某个人发起的一轮，此外还有 `cron`、`heartbeat` 以及 OpenClaw 给出的其他类型 |
| `projectBy` | `agent` | 按 Agent（`agent`）或渠道（`channel`）为每个会话的项目命名 |
| `project` | | 所有会话共用的一个项目名，代替 `projectBy` |
| `includeTools` | `true` | 发送工具调用及其结果 |
| `reconcileOnEnd` | `false` | 会话结束时，读取它的记录的末尾，最多 200 条消息，把从未发送过的发出去；需要会话访问权限 |
| `tools` | `owner-turns` | Agent 何时获得 Origin 的读取工具（见[下文](#read-origin-from-your-agents)）：`owner-turns` 在你发起的每一轮中，`owner-private` 只在 OpenClaw 判定为你的私有记忆受众的轮次中，`off` 从不。没有中枢时没有工具 |
| `spoolDir` | OpenClaw 状态目录中的 `origin-openclaw/` | 插件保存尚未投递的行以及已发送记录的地方 |
| `timeoutMs` | `5000` | 一次向中枢投递最多可以花多久，单位为毫秒 |

修改这一段配置后，OpenClaw 会重新加载插件来应用它，不需要重启 Gateway。重新加载时，OpenClaw 在解析 SecretRef 之前就注册插件，所以插件每次发送、每次有 Agent 调用它的工具时，都从 Gateway 正在运行的配置（其中的 SecretRef 已解析）读取中枢令牌：在 Gateway 解析出令牌之前，这些行在暂存区中等待，工具会把这一点告诉 Agent；解析出来时，日志会说一次，那一行以 `origin: the Gateway resolved the hub token` 开头。你在配置中改了令牌，从下一次发送起就用新的令牌。设置无效的插件什么也不记录，并在 Gateway 的日志中说明原因，只说一次，那一行以 `origin: not recording` 开头；设置有效时，它会记一行以 `origin: recording` 开头的日志。

### 有或没有会话访问权限 {#with-or-without-conversation-access}

对于不是它自带的插件，OpenClaw 只有在插件条目中把 `hooks.allowConversationAccess` 设为 `true` 时，才让它在运行结束时读取这次运行的消息；这个设置与 `config` 并列，而不是写在 `config` 里面。插件像 OpenClaw 一样读取这个设置，并据此记录：

- **有这个权限时**，插件看到的每次运行都和模型看到的一样：每一条消息、每一次工具调用及其结果，无论来自哪个渠道，也包括没有人发消息的运行。它还知道每次运行是哪一类，供 `triggers` 使用。应该这样使用它。
- **没有这个权限时**，它看到的是经过 Gateway 的消息钩子和工具钩子的内容：渠道上到达的每条消息、每次工具调用，以及发往渠道的每条回复，每条回复会把这一轮到目前为止的内容发出去。除了凭会话键，它分不清心跳或定时任务与某个人发起的一轮，也分不清发送者是不是 OpenClaw 的所有者，还会漏掉没有发往渠道的内容。要这样使用，就从上面的配置中去掉 `hooks`。

### 发往你的中枢 {#send-to-your-hub}

在中枢上创建一个 Agent 令牌，以 Gateway 所在的主机命名，然后把它交给插件：

```bash
origin token create openclaw-us --agent   # on the hub, or: docker exec origin-hub origin token create openclaw-us --agent
```

令牌的名字就是记录这些行时所用的设备：中枢把它们保存为由 `openclaw-us` 发送的来源 `openclaw` 的文件，与你的设备发来的内容放在一起。给每个 Gateway 一个自己的令牌。插件的读取工具用同一个令牌调用中枢，所以它不能是 `--readonly` 的：中枢允许这种令牌读取，但不接收它发来的行。不要把令牌写进 `openclaw.json`：像上面那样写成 SecretRef，Gateway 会从 1Password 解析它，插件从 Gateway 的配置中读取解析后的令牌；或者把它放进 Gateway 服务的一个环境变量，并写上这个变量的名字：

```json
{ "hub": "https://hub.example.com", "tokenEnv": "ORIGIN_HUB_TOKEN" }
```

投递从不拖住 Gateway：每一轮都交给一个队列，它一次只发一个请求，最多等中枢 `timeoutMs`，没能发出的内容放进暂存区；下一轮和 Gateway 下次启动时会先按顺序发送暂存区。中枢以无效为由拒绝的请求会被移到暂存区旁边的 `rejected/` 中，不再发送。

### 写入目录 {#write-to-a-directory}

如果 Gateway 所在的主机上运行着一个 Origin 设备，插件也可以改为写进这台设备自己的来源，设备会像读取任何[你自己的来源](./sources.md#write-lines-on-a-device)一样读取它们，并推送给它的中枢：

```json
{ "dir": "~/.origin/sources/openclaw" }
```

每一行写到这个目录下的 `<agent>/<yyyy>/<mm>/<session>.jsonl`，每个会话每个月（UTC）一个文件；一个 `VERSION` 文件记下 OpenClaw 和插件的版本，Origin 会把它与事件一起保存。设备用 `origin sync` 读取新行，有 Agent 运行 `origin mcp` 时也会每分钟读取一次。

## 你在 Origin 中看到什么 {#what-you-see-in-origin}

```bash
origin timeline --source openclaw                       # the sessions, newest first
origin timeline --session agent:main:telegram:direct:42 # one session, with its turns
origin search "migration lock" --source openclaw        # its messages, among everything else
```

在中枢上，这些会话出现在[管理界面](./admin.md)的 `openclaw` 之下，接入中枢的 Agent 可以通过 `search`、`timeline` 和 `get` 找到它们。一行的出处指向中枢为发送它的文件保存的镜像 `raw/devices/openclaw-us/openclaw/…`，通过 `origin show` 能看到插件写下的那一行原文。

有中枢时，你的 OpenClaw Agent 也能在你发起的轮次中通过插件的工具读取它（见[下文](#read-origin-from-your-agents)）。以其他方式访问你中枢 MCP server 的 Agent 同样不在任何目录中工作，所以它向 `brief` 请求的是它的会话所归的项目，除非你设置了 `projectBy` 或 `project`，那就是它的 Agent id：`{ "project": "main" }`（见 [MCP 工具](./mcp.md#brief)）。

## 让 Agent 读取 Origin {#read-origin-from-your-agents}

有中枢时，插件会在你发起的轮次中，把五个工具交给它记录的 Agent，也就是 Origin 那些只读的 [MCP 工具](./mcp.md)（见下文）：

| 工具 | 作用 | MCP 工具 |
|---|---|---|
| `origin_brief` | 你的记忆中关于这个 Agent 的项目的内容：你的偏好、项目最新的决定和事实、它最近与任意 Agent 的会话；带 `about` 时，还有与任务匹配的条目和过往消息 | `brief` |
| `origin_search` | 对你的条目和已归档会话做全文检索 | `search` |
| `origin_get` | 打开 Origin 给出的任意 id，以及与它相邻的内容 | `get` |
| `origin_timeline` | 一段时间内的会话，或者一个会话的事件，一次一页 | `timeline` |
| `origin_digest` | 某一天发生了什么，只从库中读取 | `digest` |

每个工具都接受它对应的 MCP 工具的参数，并把调用交给你中枢的 MCP 端点 `POST /mcp`，使用插件配置中的中枢和令牌：就是它投递行时用的令牌，每次调用时从 Gateway 的配置中读取，所以 SecretRef 始终是 SecretRef。正因如此，插件自带工具，而不是让你把中枢加进 OpenClaw 的 `mcp.servers`：OpenClaw 2026.10.6 不解析 MCP server 请求头中的 SecretRef，令牌就只能以明文写在 `openclaw.json` 里。这些工具什么也不写，只有中枢为每次简报记下的召回，与任何 Agent 的一样（见[召回](./recall.md)）：记为 Agent `openclaw`（插件的 `source`）在以令牌命名的设备上发起。

- **只在你发起的轮次中。** Origin 原样保存你的会话，不做任何脱敏，所以这些工具只在答复你的消息的轮次中提供：OpenClaw 指明了这条消息的发送者，并认定发送者是它的所有者，例如发送者与 `commands.ownerAllowFrom` 相符时（见[每条消息是谁写的](#who-wrote-each-message)）。私聊、群聊、Discord 频道和子区（thread）都是如此。别人发起的轮次拿不到；没有人发送的运行也拿不到，例如 cron、心跳运行或 `openclaw agent`；一次答复多人排队消息的轮次同样拿不到，OpenClaw 不为它指明发送者。这些事实都来自 OpenClaw，它随这一轮交给每个插件工具；插件不从模型、也不从消息文本中获取任何判断依据。如果在中枢作答期间这一轮失去了授权，例如它的会话被重置，工具会失败，Agent 拿不到答复中的任何内容。这需要 OpenClaw 2026.10.6 或更高版本：在更早的版本上，插件不注册任何工具，并在 Gateway 的日志中说明一次，那一行以 `origin: the read tools need` 开头。
- **在共享频道中。** 在频道、群聊或子区中，Agent 的答复会发到其中每个人都能读到的地方，它在 Origin 中找到的内容也随之公开：只在那里问你自己也愿意在那里说的事。而且，这一轮是你的，对话却不只是你的：Agent 会读取频道的历史消息，包括别人的消息，一条有意引导它的消息，例如要它在你的记忆中查找某件事并贴出来，就可能让它在你发起的轮次中调用这些工具。在这一点要紧的地方，把 `tools` 设为 `owner-private`：这些工具就只在 OpenClaw 判定为其所有者私有记忆受众（memory audience）的轮次中提供，也就是 OpenClaw 自己的记忆插件所用的那个受众；OpenClaw 只在与你的私聊中判定出它，并且只在其记忆槽位中的插件通过 OpenClaw 的记忆 provider runtime 提供记忆时才会判定。使用常见的记忆插件 `memory-core` 时，它不判定任何受众，所以 `owner-private` 一个工具也不会提供。
- **按自己的项目获得简报。** `origin_brief` 不接受目录：它按同样的规则，为 Agent 给出插件归档它的会话所用的那个项目的简报，即它的 Agent id，除非你设置了 `projectBy` 或 `project`。Agent 可以指定另一个 `project`，也可以传入 `about`，说明任务是关于什么的。这个工具的说明让 Agent 在开始一个可能建立在以往工作之上的任务时，以及在回答关于以往工作、决定或你的偏好的问题之前调用它；它列出的 id 可以用 `origin_get` 打开。
- **只给它记录的 Agent。** `agents` 没有列出的 Agent 拿不到这些工具。要让插件记录的某个 Agent 拿不到它们，就在 OpenClaw 中为这个 Agent 设置工具策略，拒绝它们。
- **在 OpenClaw 的工具配置档中。** 插件的清单把这些工具加进 `coding`、`messaging` 和 `full` 三个配置档，所以使用其中之一的 Agent 能看到它们。使用 `minimal`，或者在 `tools.allow` 中有你自己的允许列表时，把它们的名字，或者代表全部五个工具的插件 id `origin`，加进 `tools.allow` 或 `tools.alsoAllow`。如果你设置了 `plugins.allow`，它必须包含 `origin`，这与插件要记录时的要求相同。
- **无法作答时**，工具会失败，并给出一行 Agent 能读懂的说明：中枢拒绝了令牌（`401`）、连不上中枢、中枢 15 秒内没有作答，或者 Gateway 还没有解析出令牌。其中从不包含令牌。
- **不提供工具时**，把 `tools` 设为 `off`。0.6.0 的插件接受 `true` 和 `false`，它们仍分别表示 `owner-turns` 和 `off`。

要检查，先列出插件注册了什么，然后在一个新会话中向 Agent 问一个关于以往工作的问题，例如“关于部署我们是怎么决定的？”：

```bash
openclaw plugins inspect origin --runtime --json   # the hooks, and the five origin_ tools
```

请你自己从 OpenClaw 认作其所有者的账号提问：由别人提问时，Agent 没有 Origin 的工具。Agent 会调用 `origin_brief` 或 `origin_search`，并根据拿到的内容作答。在中枢上，`origin show <recall id>` 会显示一次简报交出了什么，召回 id 就是简报开头的那个 id。

## 每条消息是谁写的 {#who-wrote-each-message}

每条用户消息的那一行都用[事件行](../sources.md#your-own-sources-event-lines)的字段 `author` 和 `speaker` 说明它是谁写的。它记下的是 OpenClaw 随消息保存的事实：插件和 Origin 都不评判消息，也不去推断谁是谁。

| OpenClaw 对这条消息的记录 | `author` | `speaker` |
|---|---|---|
| 来自 OpenClaw 认定为其所有者的发送者 | `owner` | 他在渠道上的名字，如果渠道给出 |
| 来自其他任何人，或者 OpenClaw 不认识的发送者 | `person` | 他在渠道上的名字，没有名字时用用户名，如果渠道给出 |
| 来自渠道上的机器人 | `person`，并且 `meta.senderKind` 为 `bot` | 它的名字 |
| 从另一个会话转来（`inter_session`）：`sessions_send`、子 Agent 的汇报、工具的完成通知 | `agent` | 发送方 Agent 在 Gateway 配置中的名字（`name` 或 `identity.name`），没有名字时用它的 id；没有发送方会话时，用工具名 |
| 由 OpenClaw 自己生成（`internal_system`）：定时任务、心跳、唤醒、重启后的恢复 | `system` | |

OpenClaw 为一轮对话附加的上下文仍是一行 `meta`，两个字段都没有，事件行把它当作系统写的。任何一行都不带发送者的 id，`speaker` 和 `meta` 中都没有：只是发送者 id 的名字会被略去。

- **所有者由 OpenClaw 认定。** 当发送者与 Gateway 配置中 `commands.ownerAllowFrom` 的某一项相符，例如 `telegram:<your user id>`，或者以具有 `operator.admin` 的操作员身份在 Control UI 中书写时，OpenClaw 把这条消息标为其所有者的。插件对此没有自己的设置。名单之外的你的账号会被记为 `person`：如果名单里只有你的 Discord 账号，你在 Telegram、飞书或微信上的消息就会被记为 `person`，直到你把这些账号加进 `commands.ownerAllowFrom`。把一个账号加进去，也会让它获得 OpenClaw 留给所有者的权限，例如仅限所有者的命令和执行审批；有中枢时，还会让它发起的轮次获得 Origin 的读取工具。
- **来自一个内部字段。** 发送者的这些事实，即 OpenClaw 是否认定他为所有者、他的名字、他是不是机器人，来自 `__openclaw`：这是 OpenClaw 为自己保存在消息上、没有向插件声明的字段；一条消息是否由别的会话转来或由 OpenClaw 生成，来自它的 `provenance`。插件对照 OpenClaw 2026.10.6 写入它们的方式核对过，并随它支持的每个 OpenClaw 版本重新核对。
- **来自 OpenClaw 保存的那一份。** OpenClaw 2026.10.6 把这些事实写在它保存到会话记录里的那一份用户消息上，而不是写在运行持有的那一份上，`agent_end` 给出的是后者。所以插件监听 OpenClaw 的记录更新（`api.runtime.events.onSessionTranscriptUpdate`，它不是钩子，不改变 OpenClaw 的任何行为），按会话和消息文本的哈希记下每条用户消息是谁写的，并在运行结束时交给这条消息的那一行。同一个会话中文本相同的消息，按它们被保存的顺序配对。它不保存任何文本，最多保存每个会话 50 条消息、200 个会话、两小时；一个会话结束时，它的记录随之清除。一行的 id 与这些都无关。
- **无法判断时**，插件把消息记为 `person` 写的，不带名字：在插件加载之前保存的消息，例如插件安装后一个会话的第一轮发出的历史；或者一轮的文本与 OpenClaw 保存的任何一条消息都不相同，例如 OpenClaw 把排队的消息合成一个提示时。
- **没有会话访问权限时**，插件只能看到消息钩子，它们给出发送者的名字，但不说明 OpenClaw 是否认定他为所有者：到达的每条消息都按那个名字记为 `person` 写的，没有任何消息记为所有者的。

## 限制 {#limits}

- **从安装时起。** 插件发送 Gateway 的运行向它展示的内容。一个会话的第一轮会把当时模型看到的会话历史发出去；OpenClaw 在那之前压缩掉的部分只留在它的摘要里。
- **一个会话键一个会话。** 同一个会话键下的对话，无论在 `/new` 之前还是之后，在 Origin 中都是一个会话。
- **在运行结束时。** 行在一次运行结束时发送，或者在 OpenClaw 压缩它们之前发送。因 Gateway 崩溃而中断的运行，会随这个会话的下一次运行从历史中发出；`reconcileOnEnd` 还会读取已结束会话的记录。
- **密钥原样发送。** 插件不做任何脱敏，所以进入一次运行的密钥也会进入 Origin。用 `origin forget` 隐藏含有密钥的事件（见[遗忘](./privacy.md#forgetting)）。
- **重试随轮次进行。** 暂存区随下一轮以及 Gateway 启动时发送，没有自己的定时器。

## 常见问题 {#troubleshooting}

| 现象 | 检查什么 |
|---|---|
| Origin 什么也没收到 | Gateway 的日志：`origin: not recording: …` 说明了配置中要改什么；`openclaw plugins inspect origin --runtime --json` 列出它注册的钩子 |
| Agent 没有 `origin_brief` | 这一轮是你从 OpenClaw 的 `commands.ownerAllowFrom` 中的账号发起的：插件只在 OpenClaw 认作其所有者的轮次中提供这些工具，别人的轮次、cron 和心跳运行中都没有；`tools` 设为 `owner-private` 时，只在 OpenClaw 判定为其所有者私有受众的私聊中提供。然后：`openclaw plugins inspect origin --runtime --json` 列出了这些工具，Gateway 的日志中有一行以 `origin: giving` 开头；这个 Agent 在 `agents` 之列；OpenClaw 的工具策略允许它使用这些工具（见[让 Agent 读取 Origin](#read-origin-from-your-agents)） |
| 工具失败，提示 `Origin's hub refused the plugin's token (401)` | 令牌不对或已被吊销：在中枢上创建一个新令牌 |
| 工具失败，提示 `Origin cannot be read yet` | Gateway 还没有解析出令牌的 SecretRef：修正它，与投递时一样 |
| 日志中有 `origin: recording … from the message hooks` | 没有会话访问权限：在插件条目中、与 `config` 并列（而不是在它里面）把 `hooks.allowConversationAccess` 设为 `true` |
| `cannot deliver to …: the hub answered 401` | 令牌不对或已被吊销：在中枢上创建一个新令牌 |
| `cannot deliver to …: the Gateway has not resolved the hub token's SecretRef yet` | Gateway 无法解析令牌的 SecretRef，例如它读不到的 1Password 引用：修正它；这些行在暂存区中等待，解析出来后就会发出 |
| 你自己的消息显示为 `person` | 你书写时用的账号不在 OpenClaw 的 `commands.ownerAllowFrom` 中，插件没有会话访问权限，或者插件没有看到这条消息被保存（见[每条消息是谁写的](#who-wrote-each-message)） |
| `the hub answered 404` | 中枢运行的 Origin 早于 `/v1/sources/<name>/lines`：升级它；这些行在暂存区中等待 |
| `… lines wait in …/spool` | 无法连到中枢；它们会随下一轮发出，或者在 Gateway 启动时发出 |
| 目录中的行一直没有出现 | 目录名必须是一个来源的名字：2 到 32 个小写字母、数字和连字符，例如 `openclaw`；读取之后，`origin status` 会列出这个来源 |
