---
sourceHash: sha256-893580dc
---

# 更新日志

Origin 所有值得注意的改动都列在这里。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)；1.0 之前，次版本可能改变存储格式或公开接口，它的说明会写明需要怎么做。六个包（`@openlinkos/origin` 以及 `@openlinkos/origin-core`、`-adapters`、`-mcp`、`-admin` 和 OpenClaw 插件 `-openclaw`）以同一个版本号一起发布。英文版更新日志（`CHANGELOG.md`）是 GitHub 发布说明的来源。

## [Unreleased] {#unreleased}

### 每日摘要 {#daily-digest}

- 新的 MCP 工具 `digest` 和 `origin digest` 只从库中读取，不调用任何模型，回顾一个日历日：当天的合计，按项目和按 Agent 分列；当天的顶层会话，最近的在前，每个会话附上你当天的提示、按工具统计的工具调用，以及它的编辑调用改过的文件，子会话的工作也计入其中；当天写下的条目和提出的提议；以及当天的遗忘和恢复，只列 id。被遗忘的内容既不计数也不显示。每个会话、条目和提议都带着它的 id，可以交给 `get` 或 `origin show`。
- 日子默认是今天，可用 `day`（`--day`）指定别的日子，按作答进程的时区计算，或者按 `time_zone` 指定的时区；`project` 和 `source` 缩小范围，`limit` 限制每个列表的条数（默认 50，最多 200）。各 Agent 哪些工具算作编辑文件，见来源的文档。
- `digest` 只读，所以只读的 Agent 也能用。在已接入中枢的设备上，它是中枢对这台设备的那一天的摘要，去掉设备已遗忘的内容；中枢没有及时作答时，则是设备自己的摘要；在中继上，这个调用和 `origin digest` 都交给中枢。`origin digest --json` 打印的就是这个工具返回的内容。
- 存储格式没有变化。

### 移除 {#removed}

- 移除了 `origin distill`，以及 `ORIGIN_DISTILL_COMMAND` 和它的指南页面。Origin 存储并提供你的记忆，不运行任何模型；整理记忆交给通过 MCP 工具读取它、用 `propose` 提议条目的 Agent。提议，以及在 CLI 和管理界面中接受或拒绝提议，都没有变化。

## [0.5.0] - 2026-11-06 {#_0-5-0-2026-11-06}

让 Agent 从任意 id 顺着读下去，把会话归入线索，每一轮一结束就归档，让 Agent 提议、由你审阅，接入任何程序的会话（包括 OpenClaw 的），分清你的话和别人的话，把每个会话归到它的主项目下，并让 Agent 和设备不必复制令牌就能接入你的中枢。

**升级。** 库格式从版本 4 升级到版本 10：升级后的第一条命令，或者启动中的中枢，会就地、一次性地逐步升级库；为稳妥起见，请先用 `origin backup <dir>` 备份。其中两步会重新解析已归档的日志，以得知每条消息是谁写的、哪个会话是另一个会话的子会话，所以在大的库上可能要一分钟或更久；它会边做边说明进度。请先升级中枢，再升级它的设备：0.4 的中枢不接收列出线索的召回记录，也不接收你自己的来源的文件，设备会保留它们，等中枢升级后再发送；对 OpenClaw 插件和其他写入方发来的事件行，它会返回 `404`。升级中枢后，登录一次它的管理界面，选定你的用户名；设备和 Agent 保留各自的令牌。然后重启你的 Agent，至少重启它们的 Origin MCP server：在 0.4.0 上启动的 `origin mcp` 会继续写入已经升级的库，并不知道自己该停下。从这个版本起，进程发现库已被更新的 Origin 升级后会拒绝写入，并提示重启它；`origin mcp` 则会退出，由它的客户端重新启动。之后，在每台设备上：

- 运行 `origin agents connect`，再加上 `--yes` 运行一次，为 Claude Code 和 Codex 加上采集 hook；在 Codex 中用 `/hooks` 信任它们。Agent 在下一个会话中就能看到新的 MCP 工具 `changes`、`follow` 和 `propose`。
- `origin sessions reproject` 把以前归档的、位于链接的工作树或工作树子目录中的会话归到它们的主项目下；在此之前，它们沿用所在目录的名字。请在保存这些会话的设备上运行，不要在中枢上运行。
- `origin sessions parents` 补上 ZCode 工作流运行的名称，以及只有摘要写明的 Grok Build 会话的父会话，两者都只读地读取。
- `origin sessions repair` 为仍在运行的旧版 `origin mcp` 在升级之后采集的会话补上项目和缺失的父会话。

这三个 `origin sessions` 命令都接受 `--dry-run`，只报告会做哪些修改。

### 沿引用阅读 {#reading-along}

- `get` 能打开 Origin 交给 Agent 的任何 id，不再只是条目和事件：还有会话（用它的 id，或写成 `<source>:<session id>`）、线索（`thr_…`）、召回（`rcl_…`）和提议（`prp_…`）。每次返回的内容都有上限，并附上与它相邻的内容，每项一行、带上 id，让 Agent 一次一跳地追看要紧的内容，而不是把整个会话读进来：条目附带它的来源、历史和最多 10 条相关条目；事件附带它所在的那一轮和这一轮的提示、它所接续的事件、前后各两个事件，以及引用它的条目；会话附带它前 20 轮各自从哪里开始、它的线索、从中写下的条目、交给它的召回，以及同一项目中紧挨在它之前和之后的会话（任意 Agent 的）。
- 长内容分页读取：`timeline` 一次读会话的一轮（`turn`）或一页（`after`），并说明后面还有多少个事件（`more`）；`get` 从 `offset` 开始读取长事件，每次 20,000 个字符。MCP 结果用会话的标题或第一条提示指称每个事件所属的会话（`session_title`）。
- `origin show <session id>` 把会话打印成同样的卡片，列出的每一项都带 id，可以接着 `show`；两个 Agent 的会话 id 相同时，用 `--source` 选其中一个。

### 线索与变更 {#threads-and-changes}

- 属于同一件工作的会话，无论用的是一个还是几个 Agent，组成一条线索（`thr_…`），由 Origin 从归档中推导，不调用模型：Agent 用新的 MCP 工具 `follow` 链接起来的会话（你接着做某个早先会话里的工作时，Agent 调用它一次），以及同一项目中位于同一个 git 分支（`main` 这样的默认分支除外）上、彼此相隔不超过 30 天的你的对话（Claude Code 会记录分支，你自己的来源也可以给出分支）。线索的任何部分都不是手写的：遗忘一条链接的事件，或一个会话的全部事件，这个会话就会离开线索。
- 简报中，几个会话组成的线索只占一行；`timeline` 和 `origin timeline` 显示每个会话所在的线索；`get` 和 `origin show thr_…` 显示线索的会话、Agent 和分支，从中写下的条目，以及它的最后一条提示；在管理界面中，会话页面写明它所在的线索，线索也有自己的页面。
- 新的 MCP 工具 `changes` 告诉 Agent 自它上次查看以来有什么进入了库，从旧到新，分页返回：会话和事件、当前的条目、提议，以及遗忘（只给 id）。它从 Agent 上一次调用得到的 `next` 开始，没有时从 24 小时前开始，可以限定到一个项目、一条线索或一个会话。在已接入中枢的设备上，它把设备的变更和中枢的变更合并起来。

### 实时采集 {#live-ingestion}

- Claude Code 和 Codex 现在会在每一轮结束时把会话的新行交给 Origin，其他会话和你的中枢片刻之后就能看到。`origin agents connect` 会加上采集 hook，在 `Stop` 和 `SubagentStop` 时（Claude Code 还有 `PostCompact`）在后台运行 `origin sync --hook claude-code`（或 `codex`）。Agent 从不等待它们：hook 等待库和中枢各不超过 3 秒，什么都不输出，无论发生什么都以 0 退出，并在标准错误中说明原因。在以前接好的机器上，再运行一次 `origin agents connect` 就会加上它们；Codex 要等你在 `/hooks` 中信任之后才会运行它们。`origin mcp` 仍然每分钟查找一次新行，作为后备，也用于其他 Agent。

### 提议 {#proposals}

- 新的 MCP 工具 `propose` 把一条条目交给你审阅，而不是直接保存：用于 Agent 推断出、而你还没有确认的内容，以及它代你整理记忆时写下的任何内容。它接受 `remember` 的各个字段，外加一条说明，并且不写入任何东西：在每个归档了 Agent 记录的库中，Origin 都从这份记录里读出提议。在你接受之前，提议不算知识：检索、简报和召回都不包括它。
- 只有你能接受或拒绝提议。`origin proposals` 列出等你处理的提议（`--status`、`--project`），`origin show prp_…` 显示一条提议及它引用的事件；`origin accept prp_… --yes` 以你的名义写下它的条目，引用这些事件和提议本身；`origin reject prp_… --reason <text> --yes` 遗忘它，作为一条记录，`origin restore` 可以撤销。管理界面新增「提议」页，侧边栏和概览上显示有多少条在等待，在提议的页面上就能接受或拒绝它。
- `origin distill` 让 Claude Code 以无头方式（`claude -p`）运行，只连接这个 Origin 的 MCP server，只能用 Origin 的工具，且不能用会写入的工具，读取一个范围并提议条目供你审阅：默认是你所在项目的最近 24 小时，也可以是另一个项目（`--project`）或一条线索（`--thread`），某一天（`--day`）或自某个时间起（`--since`），最多 `--max` 条提议（10）、`--max-turns` 轮（40）。`--dry-run` 打印提示和命令，什么也不运行。运行结束后，它采集这次运行的会话，并列出它提议了什么。这次运行就是一个 Claude Code 会话，和其他会话一样计费；Origin 本身不调用模型，也不安排任何定时运行。

### 你自己的来源 {#your-own-sources}

- 任何程序都可以把自己的会话以事件行的形式带进 Origin：JSONL，每行一个事件，只追加，包含 `id`、`session`、`time`、`role`、`kind` 和 `text`，可选 `title`、`project`、`cwd`、`branch`、`parent`、`author`、`speaker` 和 `meta`。之后它的会话就出现在 Agent 的会话出现的每个地方：时间线、检索、简报、线索、变更流和管理界面。
- 在设备上，`~/.origin/sources/` 下每个名字由 2 到 32 个小写字母、数字和连字符组成、以字母开头的目录（比如 `chat-ops`）都是一个同名的来源。它下面的每个 `.jsonl` 文件都由 `origin sync` 读取（`--source chat-ops` 只读这一个），Agent 运行期间 `origin mcp` 也每分钟读取一次；目录中的 `VERSION` 文件记录写入方的版本。不需要其他任何设置，Origin 也仍然不发起任何网络请求：写入方自己轮询或订阅它的服务。设备会像发送 Agent 的日志一样，把这些来源发送给它的中枢。
- 不在你任何设备上运行的写入方，比如机器人或云端的 Agent 运行时，用 `POST /v1/sources/<name>/lines?path=<path>` 向你的中枢追加行，每次最多 8 MiB，并使用它自己的 Agent 令牌（`origin token create <name> --agent`）。中枢会回答读了多少行、新增多少事件、多少是它已有的、多少不是有效的事件；重新发送是安全的。

### OpenClaw {#openclaw}

- 第六个包 `@openlinkos/origin-openclaw` 是 OpenClaw Gateway 的插件，在每次运行结束时把 OpenClaw 各个 Agent 的会话以事件行写入 Origin：用 Agent 令牌发往你的中枢，或者写进同一台主机上 Origin 设备读取的目录，比如 `~/.origin/sources/openclaw`。用 `openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities` 安装，在 `~/.openclaw/openclaw.json` 的 `plugins.entries.origin` 下配置；它针对 OpenClaw 2026.10.6 核对过。开启 `hooks.allowConversationAccess` 时，它发送一次运行中的每条消息、每次工具调用及其结果；不开启时，发送经过 Gateway 消息和工具 hook 的内容。
- 每条用户消息都写明是谁写的，以 OpenClaw 的记录为准：OpenClaw 的主人（由 OpenClaw 按 `commands.ownerAllowFrom` 判定）、其他人、另一个 Agent，或 OpenClaw 自己，只记名字，从不记 id。插件不做任何脱敏（`includeTools: false` 则完全不发送工具调用和结果），从不拖住 Gateway，把没能送达的内容放进暂存区，由下一轮先发送，并在每次发送时从 Gateway 的配置中读取中枢令牌（SecretRef 也一样）。

### 谁写的 {#who-wrote-it}

- Origin 记录每条输入是谁写的：你、其他人、Agent（比如父 Agent 给子 Agent 的提示），或者系统（比如 Agent 的运行时或某个程序：通知、摘要、提醒、命令回显）。它从各个 Agent 为此写下的字段中读出这一点，事件行则用 `author` 和 `speaker` 写明。子 Agent 的会话或工作流步骤是子会话，它的全部输入都是 Agent 的；无界面运行（`claude -p`、`codex exec`）的全部输入都是系统的。
- 只有你自己的提示才会为没有标题的会话命名、开启它的轮次、让它成为你的对话（简报列出这些对话，分支把它们连成线索），也只有它们是召回加权所用的词。`cognition`（你的偏好）只能来自你自己的话：引用的消息没有一条是你写的，就会被拒绝。
- MCP 结果会给不是你写的消息标上 `by`（`person`、`agent` 或 `system`），已知时还有 `speaker`，server 也会告诉 Agent，这样的消息说的不是你的偏好；CLI 和管理界面会在消息旁边显示是谁写的。
- 在 Claude Code 中，你在 Agent 忙碌时输入、由它排队而没有写成用户行的提示，会作为你的消息归档，以前归档的会话也一样。

### 项目与父会话 {#projects-and-parent-sessions}

- 会话的项目现在是它的主项目：位于链接的 git 工作树中，或者位于工作树子目录中的会话，属于主检出的项目，以那个目录命名，而不再以会话自己所在目录的名字命名。Agent 或这一行给出的名字会保留；已经不存在的目录，按这个库已经学到的根，或按 Agent 自己对它的记录来解析。列表、筛选、线索和简报都用这个名字；事件保留它那一行写下的标签，条目也不改名，但按项目筛选时，用哪个名字都能找到条目。设备把解析结果记在 `places.jsonl` 中并发送给中枢，中枢从中学到这些名字。`origin sessions reproject` 解析以前归档的会话。
- 当 Agent 的日志写明了父会话时，子 Agent 或工作流步骤的会话会被记录为父会话的子会话：ZCode 的子 Agent 和工作流步骤，以及 Grok Build 和 Codex 的子 Agent（Claude Code 和 Cursor 不写明父会话）。列表显示顶层会话，每个都带上它有多少子会话，以及这些子会话的工作流名称；`origin timeline --children` 和 `timeline` 的 `include_children` 会把子会话也列出来，管理界面把它们嵌在父会话之下。`get` 和 `origin show` 按工作流运行列出父会话的子会话，并写明子会话的父会话；检索命中子会话时也会写明它的父会话。标题含有 `actor#N@M` 的工作流步骤显示为 `{运行名称} · actor#N@M`。`origin sessions parents` 补上只有 ZCode 数据库或 Grok Build 摘要才有的信息。

### 个人中枢 {#personal-hub}

- **设备和 Agent。** 现在每个令牌都属于一台设备或一个 Agent（云端 Agent、机器人或流水线），Agent 的令牌是*读写*或*只读*的：只读的 Agent 只有读取类的 MCP 工具，也不向中枢发送任何内容。管理界面的「令牌」页改为「设备和 Agent」：你的设备及其令牌和它们最近发送的数据，使用令牌的 Agent，以及通过 OAuth 登录的 Agent，每一个都可以吊销；**添加 Agent** 只显示一次令牌，并附上现成的命令：Claude Code、Codex 和事件行。在中枢上，`origin token create <name> --agent [--readonly]` 创建 Agent 的令牌，`origin token list` 列出全部，`origin token revoke` 可以吊销其中任何一个。之前创建的令牌照旧可用：如果中枢保存着只有设备才会以这个令牌的名称发送的数据，或者这个令牌从未用过，它就是设备的令牌，否则是 Agent 的令牌。
- **Agent 用 OAuth 登录。** 管理界面在中枢地址的 `/admin` 下提供时，中枢就是它的 MCP 端点的 OAuth 授权服务器，如 MCP 授权规范所述：`claude mcp add --scope user --transport http origin https://hub.example.com/mcp` 之后运行 `claude mcp login origin`（或者在 Claude Code 中运行 `/mcp`），以及 `codex mcp add origin --url https://hub.example.com/mcp` 之后运行 `codex mcp login origin`，都会在你的浏览器里打开中枢，由你允许这个 Agent，并选择它能做什么、有效多久，不需要复制任何令牌。它支持客户端元数据文档和动态客户端注册，只支持 PKCE（`S256`），支持资源指示符、一次性授权码，以及轮换的刷新令牌，刷新令牌一旦被重复使用，这个 Agent 就会被吊销。`/mcp` 返回的 `401` 现在会说明中枢的 OAuth 元数据在哪里。中枢前面的代理还必须转发 `/.well-known/oauth-protected-resource`、`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server` 和 `/oauth/*`。
- **设备经由你的批准接入。** 不带 `--token` 的 `origin hub connect <url>` 会打印一个链接和一个验证码；打开链接，登录管理界面，批准「把设备 laptop 接入你的中枢？」，设备就会以它的库名称收到自己的令牌。`--token` 仍然可用，没有在 `/admin` 下提供管理界面的中枢需要用它。
- **你的用户名。** 中枢只有一个主人，现在你用自己的用户名和管理密码登录它的管理界面。第一次登录时选定用户名，无论是新的中枢，还是从早先版本升级而来的中枢，密码都用你已有的那个；`origin admin username <name>` 可以修改它。审计日志用它来指称你。
- 在浏览器中打开中枢的地址，会看到一个公开首页，而不再是一个光秃秃的 JSON 错误：Origin 的标志和名称，一句说明这个中枢是什么的话（中文或英文），管理界面在 `/admin` 下提供时有一个**登录**按钮，以及「由开源的 Origin 驱动」和指向网站与源代码的链接。页面不显示库里的任何内容。请求 JSON 的客户端会收到 `{"service":"origin","docs":"https://origin.openlinkos.com/"}`，`/robots.txt` 让搜索引擎不收录整个中枢（个人中枢不进搜索结果）；以自己的名义展示中枢时，设置 `ORIGIN_POWERED_BY=off` 可以去掉署名。中枢前面的代理还需要转发 `/`、`/robots.txt` 和 `/assets/*`。
- 没有有效令牌的请求仍然被拒绝并返回 `401`；JSON 响应体现在还有 `docs`，即中枢指南的地址。
- 管理界面的每个页面底部显示 Origin 的版本，以及指向文档、GitHub 上的源代码和反馈问题表单的链接；中枢和 `origin ui` 的登录页在表单下方说明 Origin 是开源软件。

### 工具 {#tooling}

- 请求帮助（`origin --help`、`-h`、`help`，或命令后的 `--help`）以及命令不接受的参数，都不再打开库，因此永远不会升级它。
- 未完成的 ZCode 消息要保持多久不变，Origin 才归档它，现在可以用 `ORIGIN_ZCODE_SETTLE_MS` 设置：默认一小时；设为 `0` 时，只要消息的时间已经过去，下一次同步就归档它。

### 文档 {#documentation}

- 网站新增页面：接入 OpenClaw、接入你自己的来源，以及整理记忆。网站还提供 `/llms.txt`、`/llms-full.txt`，以及每个页面的 Markdown（在页面地址后加上 `.md`），供 Agent 阅读。

### 修复 {#fixes}

- 在设备上，同一来源中相对其根目录路径相同的两个文件（比如 Agent 的目录在移动前后的文件）不再共用一个镜像，以前后一个文件会在其中截断前一个文件的行：后来的文件会有自己的镜像。已经共用一个镜像的文件，在下次有新行时各自转入新的一代，使用自己的镜像，并从头重新读取；不需要任何升级步骤。
- 中枢拒绝某个文件时（`400` 或 `413`，包括代理返回的错误页），设备会说明是哪个文件、为什么，并照样发送它的其他文件、条目和遗忘记录；被拒绝的文件在下次同步时再试，和中继一直以来的做法一样。

## [0.4.0] - 2026-10-30 {#_0-4-0-2026-10-30}

不经询问就把有用的内容交给 Agent，一条命令接好本机的各个 Agent，并把管理界面重做成随窗口宽度自适应的工作台。

**升级。** 库格式仍为版本 4；这个版本第一次打开库时，会新增召回记录的表。请先升级中枢，再升级它的设备：0.3 的中枢不接收设备发来的召回记录，这些记录会留在设备上，直到中枢升级。使用 Origin MCP server 的 Agent 重启后就能看到新的 `brief` 工具。

### 召回 {#recall}

- 召回不经询问，把在 Agent 工作的地方有用的内容交给它：会话开始时，一份简报，包括用户的偏好、项目最新的决定和事实，以及这个项目最近与任意 Agent 的会话；每个提示，第一行与提示有足够罕见的共同词的条目。匹配基于词汇，不调用模型；一份简报不超过约 800 个 token，一个提示的匹配不超过 400 个；Agent 不会拿到它从自己的文件加载的记忆。Claude Code 和 Codex 通过它们的 `SessionStart` 和 `UserPromptSubmit` hook 运行召回（`origin recall --hook claude-code`，或 `codex`），指南的「召回」一页说明了如何设置。
- 每一次召回都有记录，只记 id，从不记文本：`origin recalls` 列出召回，`origin show rcl_…` 显示一次召回，包括它回应的提示和本会话之后用上的项。只运行 `origin recall` 会预览 Agent 会拿到什么，不做任何记录。
- Origin 的 MCP server 新增第八个工具 `brief`：给 hook 无法交出内容的 Agent（Grok Build、ZCode 和 Cursor）同样的简报，加上 `about` 时还有与它匹配的条目。server 的说明会告诉 Agent 在开始任务时调用它，除非召回已经给过它简报。每次调用都记录为一次召回，它的会话根据 Agent 日志中的召回 id 找到。
- 管理界面新增「召回」页：每一次召回交出了什么（按现在的样子显示），以及会话是否用上了。条目的页面列出交出过它的召回，会话的页面在每次召回所在的那一轮显示它。
- `origin agents` 显示本机每个 Agent 的接入情况。`origin agents connect` 把 Origin 的 MCP server 注册到每个 Agent，并为 Claude Code 和 Codex 加上召回 hook：它先显示要做的修改，加上 `--yes` 才执行，每个文件都先备份，只动 Origin 自己的那一项。`origin agents disconnect` 会把它们去掉。
- 设备同步时会把自己所做的召回发送给中枢，所以中枢保存着每台设备的召回。请先升级中枢：旧版中枢不接收召回，召回会留在设备上，等它升级后再发送。

### 管理界面 {#admin-ui}

- 管理界面（中枢上的，以及 `origin ui`）改成工作台式的布局：带计数的侧边栏，顶栏放面包屑、检索，在设备上还有通往它的中枢的入口，页面信息更紧凑，使用 0.6.1 版的 OpenLinkOS 设计系统。
- 界面随窗口宽度调整布局，不再把页面挤扁。860 到 1200 像素之间，侧边栏是一列图标；更窄时，侧边栏从菜单按钮打开。列表的筛选、会话的轮次和页面的详情在放不下时收进从按钮打开的窗格，或者排到正文后面，而不是消失；已选的筛选条件以标签形式显示在列表上方，点一下就能去掉；宽表格变成逐行列出各项名称和数值的形式；图表的文字在任何宽度下都保持原来的大小。配色、语言和退出登录移到侧边栏底部的「偏好设置」菜单中。
- 概览成为仪表盘：每个数字下面是近 30 天的情况，按 Agent 区分每天的事件数，按时机统计的召回效果，最近的会话、活跃项目、各个 Agent，以及库的状态。
- 会话、条目和召回都是左侧带筛选的列表，每个筛选项都标出选中后剩下多少，上方可以选时间范围；会话和召回有按 Agent 区分的近 30 天直方图，会话可以按最近活动、事件数或时长排序。按 `source` 筛选时间线的旧链接仍然有效。
- 会话页面成为一条轨迹：轮次大纲列出每一轮的工具调用、失败、召回和时长，可以只看有召回或有失败的轮次；当前一轮展开成按时间排列的步骤，并在大纲旁完整显示。日期索引和全部展开的视图已经去掉。
- 一次召回的页面显示交给 Agent 的文本（按现在库中的内容重建）、预算是怎么用掉的，以及同一会话的其他召回。
- 设备页面每页列出 50 个文件，最近更新的在前，先显示文件名、目录在下一行，不再一次全部列出。

## [0.3.0] - 2026-10-24 {#_0-3-0-2026-10-24}

导入各 Agent 为自己保存的记忆，检索时略去已结束的条目，并在网站上说明版本与升级。

**升级。** 这个版本第一次打开库时会就地升级它（格式版本 4）。请先升级中枢，再升级它的设备：0.2 的中枢会镜像设备发来的记忆流，但不读取，升级之后才读取；在此之前，设备对导入条目的纠正要等待它。

### 记忆 {#memory}

- 把各 Agent 为自己保存的记忆导入为条目：Claude Code（`~/.claude/projects/<project>/memory/`）、ZCode（`~/.zcode/cli/memories/`）和 Grok Build（`~/.grok/memory-v2/`，以及早期版本的 `~/.grok/memory/`）的记忆文件，只读不写。文件的每个版本成为同一条条目的一个版本，并以该版本的文件作为来源；删除文件会结束它的条目，文件回来后条目重新成为当前版本。每个拥有记忆流的库都从中派生出相同的条目，中枢从它的设备和中继发来的内容派生，所以这些条目从不发送。MCP 结果、CLI 和管理界面会把它们标为导入，文件之后的改动会取代在 Origin 中做的纠正。
- 有效期已结束的条目（`valid_to` 已过），比如文件已被删除的导入记忆，不出现在检索和列表中，除非要求查看历史；`get` 和 `origin show` 仍会显示它们。

### 个人中枢 {#personal-hub-1}

- 镜像的 `latest` 标签现在跟随发布版本，新增的 `edge` 标签跟随 `master` 上最新的提交；`latest` 以前跟随 `master`。固定一个次版本（比如 `0.3`），由你决定中枢何时升级。

### 文档 {#documentation-1}

- 网站新增页面：核心概念、MCP 工具、升级（版本、镜像标签、存储格式）、常见问题，以及这份更新日志；网站导航中的版本号链接到它们。

### 修复 {#fixes-1}

- 在一个库中做的遗忘，如果另一个库当时还没有它指向的条目或事件，现在会在它们到达那个库时覆盖它们；从原生记忆导入的条目在每个库中的 id 都相同，所以可能在设备上被遗忘之后，中枢才派生出它。

## [0.2.0] - 2026-10-24 {#_0-2-0-2026-10-24}

归档的 Agent 从两个增加到五个，新增本机管理界面、中继、可恢复的遗忘，以及带版本的库。

**升级。** Origin 0.2 第一次打开库时会就地升级它；为稳妥起见，请先用 `origin backup <dir>` 备份。请先升级中枢，再升级它的设备，因为 Origin 0.1 会忽略恢复；升级过的库不要再回到 0.1。无需重新注册：`origin mcp` 的名称和工具不变（`forget` 现在要求写原因）。

### 归档与检索 {#archive-and-search}

- 归档 Grok Build 会话（来源 id `grok`）：`~/.grok/sessions/`（或 `$GROK_HOME`）下每个会话的更新流。
- 从 ZCode 的 SQLite 数据库 `~/.zcode/cli/db/db.sqlite`（只读打开）归档 ZCode 会话（来源 id `zcode`）：每条消息在稳定之后，连同它的各个部分，写成一行镜像。
- 归档 Cursor 会话（来源 id `cursor`）：编辑器的对话（来自只读打开的 `state.vscdb`），以及 `~/.cursor/projects/` 下的对话记录。
- 适配器可以为不是日志文件的来源（比如数据库）生成行；Origin 像对待文件的行一样镜像并导入它们。
- 会话重新从 Claude Code 2.1 写下的 `ai-title` 行获得标题，用 `/rename` 起的名字优先于生成的标题；升级库时，会为它已有的 Claude Code 会话加上标题，在设备和中枢上都是如此。Grok Build 会话的标题来自它的 `summary.json`。没有标题的会话（比如所有 Codex 会话）以第一条提示作为暂名（MCP `timeline` 和 `origin timeline` 中与 `title` 并列的 `prompt`），`origin status` 会统计有标题的会话数。

### 管理界面 {#admin-ui-1}

- 会话页按轮次显示：每条提示，或 Agent 执行了的命令，Agent 的工具调用折叠成一行（按工具计数、失败数），展开后每次调用一行，Agent 的回复按 Markdown 渲染，包括表格；其他命令和注入的上下文显示为小注释，长会话按轮次分页并附带日期索引，只读取当前显示的轮次的事件。时间线按天分组会话，用第一条提示命名没有标题的会话，并可按名称筛选；概览新增按 Agent 区分的 30 天活动图、最近的会话、最活跃的项目、每个 Agent 的版本和最后一次导入、最新的条目和遗忘，以及原始镜像的存放位置。
- `origin ui` 为你自己机器上的库提供管理界面，只在 127.0.0.1 上：它用一次性链接代替密码让浏览器登录，不包含只有中枢才有的内容；在连接了中枢的设备上，会在后台把你在其中写下和遗忘的内容同步过去。
- 在 `origin ui` 的终端中按回车，它会打印并打开一个新的登录链接，之前的链接随即失效；它启动时，会像 `origin sync --local` 一样在后台导入这台机器的 Agent 会话，同时界面已经可以使用。
- 管理界面的标签、折叠块、轮次卡片、事件链接、紧凑列表、占比条、活动图及其配色，以及 Markdown 正文，改为来自 OpenLinkOS 设计系统 0.3.0 版（`@openlinkos/ui`），不再自己定义样式：Agent 消息中的链接带下划线，事件链接更容易看到和点中，图表的配色略有变化。

### 遗忘 {#forgetting}

- 遗忘现在是一条记录，所有者随时可以恢复：`forget` 在所有地方（MCP、CLI、管理界面）都要求写原因并记录作者，`origin restore` 和管理界面的「已遗忘」页面可以写明原因后恢复（Agent 不能恢复），这个页面会向所有者展示一次遗忘隐藏了什么，`origin forgotten` 列出遗忘与恢复。恢复是一条以那次遗忘为目标的遗忘记录，像遗忘记录一样复制；请先升级中枢，再升级它的设备，因为 Origin 0.1 会忽略恢复。在管理界面中遗忘时，不再需要再次输入 id 或密码。

### 个人中枢 {#personal-hub-2}

- 为磁盘小的机器提供中继模式：`origin hub connect … --relay` 把一个空库变成中继，它只保存游标，直接从日志把 Agent 的日志发给中枢，并通过中枢回答每个 MCP 工具和 CLI 查询。
- 中枢可以把原始镜像中已封存的帧保存在兼容 S3 的存储桶（比如 MinIO）中（`origin serve --raw-s3-endpoint … --raw-s3-bucket …`，或 `ORIGIN_RAW_S3_*`，密钥从 Secret 挂载时用 `*_FILE`）；`origin raw upload` 会搬移已在磁盘上的帧并加以校验，每次 8 个（`--concurrency`），`origin backup` 会把它们复制回备份中。
- `origin status` 和 `origin hub status` 会显示设备上次完成与中枢同步的时间，以及在那之后失败的上一次同步的错误。
- 中继会在 Agent 删除它尚未发送的日志之前发出警告：当未发送的会话接近 Claude Code 的 `cleanupPeriodDays`（未设置时为 30 天），或者对于其他 Agent，已经等了一周还什么都没发出去时，`origin status`、`origin sync` 和 `origin mcp`（在它的日志里，以及中枢无法回答的工具的错误里）会给出提示。

### 工具 {#tooling-1}

- 库会记录它的格式版本，较新的 Origin 打开它时会就地升级一次，包括 0.1.0 的库；Origin 会拒绝格式比它所知更新的库。

### 修复 {#fixes-2}

- 设备不再在另一个进程（`origin sync` 和某个 Agent 的 `origin mcp`）同时推送同一个文件时放弃推送，中继也是如此。
- 设备在发送文件时，会一并发送它为该文件的事件记录的 Agent 版本，这样对于日志中不带版本的 Agent（Grok Build、Cursor），中枢会记录同样的版本。
- 得到多个结果的工具调用（比如 Claude Code 后台 Agent 的调用）会保留全部结果，不再把后面的结果显示成名为 `?` 的调用。

## [0.1.0] - 2026-10-23 {#_0-1-0-2026-10-23}

第一个版本。

### 归档与检索 {#archive-and-search-1}

- 把 Claude Code 和 Codex CLI 的会话归档到 `~/.origin`（或 `$ORIGIN_HOME`）下的一个只追加的库中。导入是增量且幂等的，被重写的文件作为新的一代保留，并能读取 zstd 压缩的 Codex 记录。
- 原始镜像以可随机读取的 zstd 帧存储；每个事件都指向它的原始文件和行。
- 对会话和条目的全文检索：每个词都必须以不区分大小写的子串形式匹配，包括一到两个字的中日韩词语；结果按相关度排序或按时间排序。

### 条目与遗忘 {#entries-and-forgetting}

- 三种条目：`memory`、`knowledge` 和 `cognition`，每条都引用它所来自的事件，带有置信度和版本历史。
- `correct` 会取代一条条目；来自不同库的并发纠正会收敛到最新的那个。
- `forget` 在每个库上永久隐藏一条条目或一个事件，之后任何东西都不能再引用它。

### Agent {#agents}

- `origin mcp`：一个通过 stdio 提供服务的 MCP 服务器，有七个工具：`search`、`timeline`、`get`、`sources`、`remember`、`correct` 和 `forget`。它在 Agent 启动时、读取之前、写入之后、Agent 运行期间每分钟，以及 Agent 退出时同步一次。

### 个人中枢 {#personal-hub-3}

- `origin serve`（也是 `ghcr.io/openlinkos/origin` 镜像）：一个自托管、单租户的中枢，汇集你的设备，并通过 HTTP 向云端 Agent 提供 MCP。
- 每个设备仍然是一个完整的库。`origin sync` 把它的原始镜像、条目和遗忘记录发送到中枢，并带回在别处遗忘的内容；设备上的 Agent 同时读取两个库，中枢没有回应时退回到设备本身。
- 中枢令牌绑定到以它命名的设备。
- 面向中枢所有者的管理界面，默认关闭（`origin serve --admin`）：设备、存储、会话、检索、条目、先预览再执行的纠正和遗忘、附带现成接入命令的令牌管理，以及审计日志，由一个管理密码保护。

### 工具 {#tooling-2}

- `origin backup <dir>` 能在 Agent 持续写入时一致地复制一个库。
- 需要 Node.js 22.16 或更高版本。

[0.5.0]: https://github.com/openlinkos/origin/releases/tag/v0.5.0
[0.4.0]: https://github.com/openlinkos/origin/releases/tag/v0.4.0
[0.3.0]: https://github.com/openlinkos/origin/releases/tag/v0.3.0
[0.2.0]: https://github.com/openlinkos/origin/releases/tag/v0.2.0
[0.1.0]: https://github.com/openlinkos/origin/releases/tag/v0.1.0
