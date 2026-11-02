---
sourceHash: sha256-7f397f55
---

# 命令参考

```text
origin sync      [--source <id>] [--verbose] [--local] 采集本机 Agent 会话；已接入中枢时再与中枢同步
origin sync      --hook <agent>                        采集 Agent 的 hook 指明的记录文件（从标准输入读取它的事件）
origin status                                          各来源统计、条目数与上次采集时间
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                单个会话的事件（默认不含工具事件）
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id> [--source <id>]                  显示条目、事件（以及它的原始来源）、会话、线索、一次召回或一条提议
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> --reason <text> [--yes]          在每个库中隐藏条目或事件，并保存为记录（需加 --yes 确认）
origin forgotten [--limit 50]                          遗忘与恢复的记录，从新到旧，附原因
origin restore   <tombstone-id> --reason <text> [--yes]  带回一次遗忘隐藏的内容（需加 --yes 确认）
origin proposals [--project <name>] [--status pending|accepted|rejected|all] [--limit 50]   Agent 提出、等你审阅的条目
origin accept    <proposal-id> [--yes]                 接受一条提议：写下它的条目（需要 --yes）
origin reject    <proposal-id> --reason <text> [--yes] 拒绝一条提议：遗忘它，并留下记录（需要 --yes）
origin distill   [--project <name> | --thread <thr_…>] [--day <YYYY-MM-DD> | --since <t>] [--max 10] [--dry-run]
                                                       让无头的 Claude Code 读取一个范围并提议条目
origin recall    [--cwd <dir>] [--prompt <text>] [--agent <id>]   Agent 在该目录会拿到什么；--hook <agent> 用于回应它的 hook
origin recalls   [--since <t>] [--agent <id>] [--session <id>] [--all] [--limit 50]   Agent 拿到过什么，从新到旧
origin projects                                        已知的项目名
origin backup    <dir>                                 把数据库和原始镜像备份到 <dir>（增量）
origin mcp                                             以 stdio 运行 MCP server（接入中枢后补充中枢的回答）
origin agents    [connect | disconnect] [<agent>...] [--yes]   把 Origin 及其 hook 接入本机的 Agent
origin ui        [--port 7079] [--no-open]             在浏览器中浏览和管理本库，只监听 127.0.0.1

origin serve     [--host 127.0.0.1] [--port 7077]      把本库作为个人中枢运行（MCP over HTTP）
                 [--admin | --admin-listen <host:port>] [--public-url <url>]   同时提供管理界面
                 [--raw-s3-endpoint <url> --raw-s3-bucket <name> [--raw-s3-prefix <p>]]   把已封存的帧保存在存储桶中
origin raw       upload [--remove] [--concurrency 8]    把仍在中枢磁盘上的已封存帧移入它的存储桶（在中枢上运行）
origin token     create <name> [--agent [--readonly]] | list | revoke <name>   设备和 Agent 的令牌（在中枢上运行）
origin admin     password [--generate]                 设置管理界面的密码，并让所有会话退出登录（在中枢上运行）
origin admin     username [<name>]                     查看或修改主人的用户名（在中枢上运行）
origin admin     sessions [--revoke-all] | audit [--limit 50]       管理界面的会话与审计日志
origin hub       connect <url> [--token <token>] [--device <name>] [--relay] | status | disconnect
                                                       不带 --token 时，在中枢的管理界面中批准这台设备
origin push                                            与 origin sync 相同（为已有的定时任务保留）
```

- **时间参数**：相对时长（`30m`、`24h`、`7d`、`2w`）或日期（`YYYY-MM-DD`、ISO 8601）。
- **来源 id**：`claude-code`、`codex`、`cursor`、`grok` 与 `zcode`，以及你自己每个来源的名称，即 `~/.origin/sources/` 下的一个目录（见[接入你自己的来源](./sources.md)）。那里名称不能作为来源名称的目录，`origin sync` 会给出警告，并且不去动它。
- **条目类型**：`memory`（发生过什么）、`knowledge`（稳定的事实）、`cognition`（你的偏好、方法、目标与边界）。
- **条目**：列出和检索到的都是当前的条目。已被取代的版本，以及有效期已经结束的条目（例如文件已被删除的导入记忆），用 `origin entries --history` 或 `origin show` 才能看到。从 Agent 为自己保存的记忆文件导入的条目会标记为导入的。
- **id 形式**：条目如 `ent_5f0c2a9e41b7`；事件如 `claude-code:<uuid>` 或 `codex:<session>:o12`；遗忘记录（遗忘与恢复留下的记录）如 `tmb_3a9d70c1e2f4`；召回如 `rcl_7d2e9a0b1c3f`；提议，即 Agent 提出、等你审阅的条目，如 `prp_1b7e4c0a9d23`；线索，即属于同一件工作的那些会话（见[线索](./concepts.md#threads)），如 `thr_4c1e9a7b2d30`。会话用它的 Agent 给的 id，例如一个 UUID；`origin timeline` 会在会话 id 旁显示它的线索。
- **帮助**：`origin --help`，或者任何命令后面加 `--help`（`-h`），会打印上面这份列表。请求帮助，以及命令不接受的参数，都不会打开库，所以永远不会升级它（见[你的库](./upgrading.md#your-store)）。
- CLI 输出为英文。

## 检索 {#searching}

`search` 同时检索条目和会话消息。查询中的每个词都必须作为子串出现（不区分大小写）；中文同样支持，包括 `部署` 这样一到两个字的词。结果在最新的 2,000 个匹配中按相关度排序；加 `--recent` 改为按时间从新到旧排序，加 `--all` 会把工具调用及其输出也纳入检索。其他短于三个字符的词，例如 `AI`，只在匹配查询其余部分的最新 25,000 个事件中核对，所以要找更早的事件，请加上一个更长的词或限定时间范围。详见[检索与时间线](../architecture.md#search-and-timeline)。

```console
$ origin search "schema migrations"
Entries:
[2026-10-20 10:42] memory, conf 0.9, origin
    No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
    ↳ ent_5f0c2a9e41b7

Events:
[2026-10-20 10:01] claude-code origin user/message
    Let's not add [migrations] yet — we're early. Just test in a fresh temp folder.
    ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

1 entry, 1 event. Details: origin show <id>
```

## 查看 {#inspecting}

`show` 显示条目及其来源与版本历史；对事件则显示原始定位：原文件、镜像与行号（镜像以压缩形式存储为 `<mirror>.zst` 和 `<mirror>.tail`），以及原文行。

```console
$ origin show ent_5f0c2a9e41b7
Entry       ent_5f0c2a9e41b7  memory, active
Created     2026-10-20 10:42 by claude-code  confidence 0.9  project origin

No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.

Sources:
  [2026-10-20 10:01] claude-code origin user/message
      “not add migrations yet”
      ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
```

对会话 id，`show` 以卡片的形式显示这个会话，就是 MCP 工具 `get` 交给 Agent 的那张：它的名称和时间、它所在的线索（如果有的话）、开启它前 20 轮的提示、从中写下的条目、它拿到的召回，以及同一项目中紧挨在它前后的会话，每样都带着 id，可以接着 `show`。两个 Agent 的会话 id 相同时，用 `--source` 选其中一个。

```console
$ origin show 9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f
Session     9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f  claude-code, project origin
Name        Store format
Directory   /home/dana/code/origin
Time        2026-10-20 09:58 – 11:20
Events      186 events, 2 turns
Thread      thr_4c1e9a7b2d30, 2 sessions  (origin show thr_4c1e9a7b2d30)

Turns:
    1. [2026-10-20 09:58] How should we version the store format?
       ↳ claude-code:2b7e4d1a-9c3f-4a5b-8e6d-1f0a3b4c5d6e
    2. [2026-10-20 10:01] Let's not add migrations yet — we're early. Just test in a fresh temp folder.
       ↳ claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

Entries written from it:
  [2026-10-20 10:42] memory  No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
      ↳ ent_5f0c2a9e41b7

Recalls it was handed:
  [2026-10-20 09:58] at the start of a session, 3 items  ↳ rcl_3f9a0c1d2e4b

Before      codex 2026-10-19 17:30  “Sketch the store layout”
            ↳ 0199a1b2-7c3d-4e5f-8a6b-9c0d1e2f3a4b
After       —

Its events: origin timeline --session 9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f
```

对线索 id，`show` 以卡片的形式显示这条线索，就是 `get` 交给 Agent 的那张：它的名称、项目和时间，它的前 20 个会话（从旧到新），这些会话所属的 Agent 和所在的工作分支，从中写下的条目，以及它的最后一条提示。

```console
$ origin show thr_4c1e9a7b2d30
Thread      thr_4c1e9a7b2d30  project origin
Name        Store format
Time        2026-10-20 09:58 – 2026-10-22 16:05
Sessions    2 sessions, of claude-code, codex
Branches    store-format

Sessions:
  [2026-10-20 09:58] claude-code   186 events  Store format
      ↳ 9d3b6f20-5a1e-4c7d-8b2f-6e0a4c9d1b3f
  [2026-10-22 15:12] codex          74 events  “Write the migration for the new column”
      ↳ 0199b7c4-2d1e-7f3a-8b5c-6d7e8f9a0b1c

Entries written from it:
  [2026-10-20 10:42] memory  No schema versioning or migrations before the first release; test against a fresh ORIGIN_HOME.
      ↳ ent_5f0c2a9e41b7

Last prompt [2026-10-22 16:01] run the migration tests on Windows too
      ↳ codex:0199b7c4-2d1e-7f3a-8b5c-6d7e8f9a0b1c:o212

A session of it: origin show <session id>
```

## 召回 {#recall}

`origin recall` 显示 Agent 在当前目录（或 `--cwd` 指定的目录）会拿到什么：新会话的简报，或者加上 `--prompt` 时与提示匹配的条目。`--agent` 按该 Agent 会拿到的样子显示，不含它自己加载的记忆。它不做任何记录。`origin agents connect` 会设置好这些 hook（见[接入 Agent](./connect-agents.md#connect-them-all-at-once)）。Claude Code 和 Codex 的 hook 运行 `origin recall --hook claude-code` 或 `--hook codex`，它从标准输入读取 hook 的事件，记录交出的内容，并输出给 Agent。`origin recalls` 按从新到旧列出 Agent 拿到过什么（加 `--all` 还会列出什么都没交出的召回），`origin show rcl_…` 显示一次召回，包括它回应的提示和本会话之后用上的项。见[召回](./recall.md)。

## 从 hook 采集 {#ingesting-from-hooks}

Claude Code 和 Codex 的采集 hook 会在一轮结束、子 Agent 停止，以及 Claude Code 压缩对话之后，在后台运行 `origin sync --hook claude-code` 或 `--hook codex`；`origin agents connect` 会设置好它们（见[接入 Agent](./connect-agents.md#connect-them-all-at-once)）。它从标准输入读取 hook 的事件，采集事件指明的记录文件，在 `SubagentStop` 时还有子 Agent 的记录文件，从这个文件上次采集停下的地方开始；在已接入中枢的设备上，再把这个文件新增的行推送给中枢，最多等待 3 秒；在中继上，则把它们发给中枢。它什么都不输出；无论出了什么问题，它都在标准错误中说明原因并以 0 退出，从不妨碍 Agent。`origin sync` 本身照旧工作：其他 Agent 的会话由它收取，也由 `origin mcp` 每分钟收取一次。见[实时采集](../architecture.md#live-ingestion)。

## 纠正与遗忘 {#correcting-and-forgetting}

`correct` 会为条目添加一个新版本，旧版本保留为历史。`forget` 需要一个原因，会先列出将隐藏的内容，加 `--yes` 才真正执行：

```console
$ origin forget ent_5f0c2a9e41b7 --reason "wrong project"
This will hide 1 entry and 1 event, here and on every store it reaches:
  ent_5f0c2a9e41b7
  claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

The forget is kept as a record with its reason; you can restore it later with origin restore. Re-run with --yes to confirm.
```

`origin forgotten` 列出本库的遗忘与恢复记录，从新到旧，附带 id、目标、状态和原因。`origin restore <tombstone-id> --reason <text>` 会带回一次遗忘隐藏的内容，仍被其他遗忘隐藏的除外；它和 `forget` 一样，会先列出将带回的内容，加 `--yes` 才真正执行。Agent 不能恢复。恢复之后要再次隐藏，就再遗忘一次。

遗忘规则见[隐私与数据](./privacy.md#forgetting)。

## 审阅提议 {#reviewing-proposals}

Agent 用 MCP 工具 [`propose`](./mcp.md#propose) 提议它推断出、你尚未确认的内容，以及它替你整理记忆时写下的内容，[`origin distill`](./distill.md) 就让它这样做。提议在你接受之前都不是条目。`origin proposals` 从新到旧列出等着你的提议；`--status accepted` 列出你接受了的，以及每条成为的条目；`--status rejected` 列出你拒绝了的，只列 id 和原因；`--status all` 三者都列。`--project` 只保留一个项目的提议：提议指明的项目，或者它所在会话的项目。

```console
$ origin proposals
proposal          status   kind       proposed          project  text
----------------  -------  ---------  ----------------  -------  -------------------------------------------------
prp_1b7e4c0a9d23  pending  knowledge  2026-10-22 17:39  origin   Releases are tagged only after both CI jobs pass.

1 proposal pending. Review one with origin show <id>, then origin accept <id> or origin reject <id> --reason <text>.
```

`origin show prp_…` 像 MCP 工具 `get` 交给 Agent 的那样显示一条提议：它提议的内容，由谁、在哪个会话中提出，Agent 的说明，以及它引用的事件和引文。`origin accept` 以你的身份（`user@<设备>`）写下它的条目，引用这些事件以及这条提议本身；`origin reject` 以你给的原因遗忘这条提议的事件，留下一条记录，`origin restore` 可以解除它，使提议重新成为待审。两者都会先说明将要做什么，只有加上 `--yes` 才执行：

```console
$ origin accept prp_1b7e4c0a9d23 --yes
Accepted prp_1b7e4c0a9d23 as ent_7a2c9e1f0b44.
To change it: origin correct ent_7a2c9e1f0b44 <text>

$ origin reject prp_6e2d9a4c1b07 --reason "We tag from release branches now" --yes
Rejected prp_6e2d9a4c1b07 (tombstone tmb_2d8f0c1a9e35).
To bring it back: origin restore tmb_2d8f0c1a9e35 --reason <text>
```

被接受的提议就是一个普通的条目：照常纠正或遗忘它。在连接了中枢的设备上，接受和拒绝之后会与中枢同步，这样条目或遗忘就会到达每个库。在中继上，请在中枢的管理界面中审阅提议；`origin show prp_…` 仍然会询问中枢。规则见[提议](../architecture.md#proposals)。

## 整理记忆 {#consolidating}

`origin distill` 在一个范围上以无头方式运行 Claude Code（`claude -p`），默认范围是你所在项目的最近 24 小时；它只连接本 Origin 自己的 MCP server，读取发生了什么，并提议条目交给你审阅。`--project` 或 `--thread` 选择读什么，`--day` 或 `--since` 选择什么时候，`--max` 限制它最多提议多少条（默认 10 条），`--max-turns` 限制它最多用多少轮（40）；`--dry-run` 只打印提示词和命令，不运行任何东西。结束时，它采集这次运行的会话，并列出它的提议。见[用无头 Agent 整理记忆](./distill.md)。

## 在浏览器中 {#in-your-browser}

`origin ui` 为这台机器的库提供[管理界面](./admin.md#on-your-own-machine)，只监听 `127.0.0.1`，端口默认为 7079，可用 `--port` 指定。它会打印一个登录链接，并在默认浏览器中打开；链接只能使用一次，须在 5 分钟内使用；`--no-open` 只打印链接。这里没有密码。它在终端里运行时，按 Enter 就会得到一个新链接，同样会打印并打开；之前的链接随即失效。用 Ctrl+C 停止它，浏览器也随之退出登录。它启动时会在后台归档这台机器上 Agent 的会话，和 `origin sync --local` 一样，所以界面能显示 Agent 最近写下的内容；归档期间界面照常可用。它拒绝在中继上运行，因为中继不保有自己的会话。在已接入中枢的设备上，你在那里写入的条目以及遗忘和恢复操作，会在后台与中枢同步，与 `correct`、`forget` 和 `restore` 之后一样。

## 个人中枢 {#personal-hub}

这些命令用于运行[个人中枢](./hub.md)，以及把设备接入中枢。

- 在中枢上，`origin serve` 提供 `POST /mcp`、复制接口，以及没有设备的程序用来追加[事件行](./sources.md#send-lines-to-your-hub)的 `POST /v1/sources/<name>/lines`，`GET /healthz` 用于健康检查，不需要鉴权，`GET /` 是说明这个中枢是什么的[公开首页](./hub.md#the-landing-page)。`origin token create <name>` 会打印一个新的设备令牌，只显示一次（以 `ogn_` 开头）；中枢只保存令牌的哈希。设备的令牌请以设备命名：它只对同名的设备有效。`--agent` 改为创建 Agent 的令牌，供云端 Agent、机器人或流水线使用；`--readonly` 则创建只读取的令牌：MCP 中没有写入类工具，也不向中枢发送任何内容。`origin token list` 列出令牌及其类型和权限，以及通过 OAuth 登录的 Agent；`origin token revoke <name>` 可以吊销其中任何一种。被吊销的令牌可以用同一个名称新建一个来替换。见[设备和 Agent](./hub.md#devices-and-agents)。
- 在设备上，`origin hub connect <url>` 经由你在浏览器中的批准接入设备：它打印一个链接和一个验证码，你在中枢的管理界面中批准这台设备，设备随即以它的库名称收到自己的令牌；加上 `--token` 时，它改用在中枢上创建的令牌，这个令牌必须以库的名称命名。它会保存中枢地址和令牌。`origin hub connect` 和 `origin hub status` 会向中枢核对，不一致时说明如何解决。此后 `origin sync` 也会与中枢同步：发送新的原始镜像字节，以及在本设备上写下的条目和遗忘记录，再应用中枢的遗忘记录。可以随时重跑，每次都会从上次停下的位置继续。`--local` 会跳过中枢。`origin status` 和 `origin hub status` 会显示这台设备上一次与中枢同步完成的时间（无论由哪个命令或 Agent 发起），如果此后有一次同步失败，还会显示它的错误。
- 设备接入后，`origin mcp` 根据设备的库作答，并合并中枢的回答，等待中枢最多 2 秒；Agent 保存的内容写在设备上，然后再同步。
- 管理命令（`entries`、`show`、`correct`、`forget` 等）作用于设备自己的库。在已接入中枢的设备上，`correct`、`forget` 和 `restore` 之后会与中枢同步；如果连不上中枢，改动会留在设备上，直到下一次同步。
- `origin hub connect … --relay` 把一个空库变成[中继](./hub.md#run-a-device-as-a-relay)，它不保有自己的会话或条目；已经保存了这些内容的库会被拒绝。在中继上，`origin sync` 直接把 Agent 新增的记录行发送给中枢（`--local` 不适用），`origin status` 按来源显示尚未发送的文件和字节，并在尚未发送的会话临近被 Agent 删除的年龄时发出警告，`origin mcp` 把每一次工具调用都交给中枢，`search`、`timeline`、`show`、`entries`、`correct` 和 `forget` 都会询问中枢；`entries --history`、`projects`、`forgotten` 和 `restore` 不可用（恢复请在中枢的管理界面中进行）。`origin hub status` 会显示模式。
- `origin serve --admin` 会同时在 `/admin` 下提供[管理界面](./admin.md)；`--admin-listen <host:port>` 则改为在单独的监听地址上提供。在 TLS 之后时，用 `--public-url` 传入中枢的 https 地址；中枢拒绝在回环地址之外通过明文 HTTP 提供管理界面。管理界面在 `/admin` 下时，Agent 用 OAuth 登录中枢的 MCP 端点，设备经由你的批准接入（见[接入 Agent](./connect-agents.md#sign-in-with-oauth)）。
- `origin serve --raw-s3-endpoint <url> --raw-s3-bucket <name>`，或 `ORIGIN_RAW_S3_*` 环境变量，会把中枢已封存的帧——原始镜像的大部分——保存在兼容 S3 的存储桶中，例如 MinIO；密钥只从环境变量读取。`origin raw upload` 把此前封存的帧移入存储桶并逐帧校验，默认一次 8 帧（可用 `--concurrency` 调整），`--remove` 随后删除原先存放它们的本地文件。见[把原始镜像放进存储桶](./hub.md#keep-raw-mirrors-in-a-bucket)。
- `origin admin username <name>` 修改你登录管理界面所用的用户名，不带名称时显示它；用户名在你第一次登录时连同管理密码一起选定。
- `origin admin password` 设置管理界面的密码：在终端中询问两次，不显示你输入的内容；没有终端时从标准输入读取一行。`--generate` 随机生成一个密码，只打印一次。密码至少需要 10 个字符，设置后所有管理会话都会退出登录。中枢第一次在启用管理界面的情况下启动时，会生成一个密码，并在日志中打印一次。`origin admin sessions --revoke-all` 让所有会话退出登录，`origin admin audit` 打印审计日志。用 CLI 进行的令牌、用户名和密码变更也会记录在其中。

## 环境变量 {#environment-variables}

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Origin 的数据库与原始镜像目录 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置目录（会话从 `<dir>/projects` 读取） |
| `ORIGIN_CLAUDE_PROJECTS` | — | 直接指定 Claude Code 的 projects 目录 |
| `CODEX_HOME` | `~/.codex` | Codex 的主目录（从 `sessions/` 与 `archived_sessions/` 读取会话） |
| `GROK_HOME` | `~/.grok` | Grok Build 的主目录（从 `sessions/` 读取会话，从 `memory-v2/` 与 `memory/` 读取记忆） |
| `ORIGIN_HUB_URL` | — | 中枢地址，覆盖 `origin hub connect` 的配置 |
| `ORIGIN_HUB_TOKEN` | — | 中枢令牌，覆盖 `origin hub connect` 的配置 |
| `ORIGIN_DEVICE` | 主机名 | 新库使用的名称：也就是本设备在中枢上的名称，以及它写入的内容所记录的来源库（origin） |
| `ORIGIN_HUB_TIMEOUT_MS` | `2000` | 已接入中枢的设备上，`origin mcp` 等待中枢多久，超时后不再等待中枢直接作答 |
| `ORIGIN_DISTILL_COMMAND` | `PATH` 上的 `claude` | `origin distill` 用来代替 `claude` 运行的命令：一个程序，或者用 Node 运行的 `.js` 或 `.mjs` 脚本 |
| `ORIGIN_WATCH_INTERVAL_MS` | `60000` | Agent 运行期间，`origin mcp` 多久查看一次新的记录行（已接入中枢时一并同步），作为 Agent 的 hook 没有交来的内容的后备；设为 `0` 则关闭 |
| `ORIGIN_ADMIN` | `off` | 设为 `on` 时在 `/admin` 下提供管理界面（`origin serve --admin`） |
| `ORIGIN_ADMIN_LISTEN` | — | 改为在这个 `host:port` 上提供管理界面（`--admin-listen`） |
| `ORIGIN_PUBLIC_URL` | — | 中枢的公开 https URL（`--public-url`） |
| `ORIGIN_CLIENT_IP_HEADER` | — | 由你的代理设置、携带客户端地址的请求头；只有设置了才会被信任，在代理或 CDN 之后必须设置 |
| `ORIGIN_ADMIN_PASSWORD` | — | 管理界面的密码（至少 10 个字符）；设置后取代用 `origin admin password` 设置的密码 |
| `ORIGIN_POWERED_BY` | `on` | 设为 `off` 时，中枢的[公开首页](./hub.md#the-landing-page)不显示对 Origin 的署名（「由开源的 Origin 驱动」及其链接） |
| `ORIGIN_RAW_S3_ENDPOINT`, `ORIGIN_RAW_S3_BUCKET` | — | 把中枢已封存的帧保存在这个兼容 S3 的存储桶中（`--raw-s3-endpoint`、`--raw-s3-bucket`） |
| `ORIGIN_RAW_S3_PREFIX` | 无 | 存储桶中键的前缀（`--raw-s3-prefix`） |
| `ORIGIN_RAW_S3_REGION` | `us-east-1` | 发往存储桶的请求签名所用的区域（`--raw-s3-region`） |
| `ORIGIN_RAW_S3_ADDRESSING` | `path` | `path` 或 `virtual`：存储桶的寻址方式（`--raw-s3-addressing`） |
| `ORIGIN_RAW_S3_ACCESS_KEY_ID`, `ORIGIN_RAW_S3_SECRET_ACCESS_KEY` | — | 存储桶的密钥；加上 `_FILE` 时指定存放它们的文件 |
| `ORIGIN_RAW_S3_TIMEOUT_MS` | `30000` | 发往存储桶的单个请求最长可用的时间 |
