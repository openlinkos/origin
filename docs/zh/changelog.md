---
sourceHash: sha256-893580dc
---

# 更新日志

Origin 所有值得注意的改动都列在这里。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)；1.0 之前，次版本可能改变存储格式或公开接口，它的说明会写明需要怎么做。五个包（`@openlinkos/origin` 以及 `@openlinkos/origin-core`、`-adapters`、`-mcp`、`-admin`）以同一个版本号一起发布。英文版更新日志（`CHANGELOG.md`）是 GitHub 发布说明的来源。

## 未发布 {#unreleased}

### 召回 {#recall}

- 召回不经询问，把在 Agent 工作的地方有用的内容交给它：会话开始时，一份简报，包括用户的偏好、项目最新的决定和事实，以及这个项目最近与任意 Agent 的会话；每个提示，第一行与提示有足够罕见的共同词的条目。匹配基于词汇，不调用模型；一份简报不超过约 800 个 token，一个提示的匹配不超过 400 个；Agent 不会拿到它从自己的文件加载的记忆。Claude Code 通过它的 `SessionStart` 和 `UserPromptSubmit` hook 运行召回（`origin recall --hook claude-code`），指南的「召回」一页说明了如何设置。
- 每一次召回都有记录，只记 id，从不记文本：`origin recalls` 列出召回，`origin show rcl_…` 显示一次召回，包括它回应的提示和本会话之后用上的项。只运行 `origin recall` 会预览 Agent 会拿到什么，不做任何记录。
- Origin 的 MCP server 新增第八个工具 `brief`：给 hook 无法交出内容的 Agent（例如 Grok Build、ZCode、Cursor，以及目前的 Codex）同样的简报，加上 `about` 时还有与它匹配的条目。server 的说明会告诉 Agent 在开始任务时调用它，除非召回已经给过它简报。每次调用都记录为一次召回，它的会话根据 Agent 日志中的召回 id 找到。

## [0.3.0] - 2026-10-24 {#_0-3-0-2026-10-24}

导入各 Agent 为自己保存的记忆，检索时略去已结束的条目，并在网站上说明版本与升级。

**升级。** 这个版本第一次打开库时会就地升级它（格式版本 4）。请先升级中枢，再升级它的设备：0.2 的中枢会镜像设备发来的记忆流，但不读取，升级之后才读取；在此之前，设备对导入条目的纠正要等待它。

### 记忆 {#memory}

- 把各 Agent 为自己保存的记忆导入为条目：Claude Code（`~/.claude/projects/<project>/memory/`）、ZCode（`~/.zcode/cli/memories/`）和 Grok Build（`~/.grok/memory-v2/`，以及早期版本的 `~/.grok/memory/`）的记忆文件，只读不写。文件的每个版本成为同一条条目的一个版本，并以该版本的文件作为来源；删除文件会结束它的条目，文件回来后条目重新成为当前版本。每个拥有记忆流的库都从中派生出相同的条目，中枢从它的设备和中继发来的内容派生，所以这些条目从不发送。MCP 结果、CLI 和管理界面会把它们标为导入，文件之后的改动会取代在 Origin 中做的纠正。
- 有效期已结束的条目（`valid_to` 已过），比如文件已被删除的导入记忆，不出现在检索和列表中，除非要求查看历史；`get` 和 `origin show` 仍会显示它们。

### 个人中枢 {#personal-hub}

- 镜像的 `latest` 标签现在跟随发布版本，新增的 `edge` 标签跟随 `master` 上最新的提交；`latest` 以前跟随 `master`。固定一个次版本（比如 `0.3`），由你决定中枢何时升级。

### 文档 {#documentation}

- 网站新增页面：核心概念、MCP 工具、升级（版本、镜像标签、存储格式）、常见问题，以及这份更新日志；网站导航中的版本号链接到它们。

### 修复 {#fixes}

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

### 管理界面 {#admin-ui}

- 会话页按轮次显示：每条提示，或 Agent 执行了的命令，Agent 的工具调用折叠成一行（按工具计数、失败数），展开后每次调用一行，Agent 的回复按 Markdown 渲染，包括表格；其他命令和注入的上下文显示为小注释，长会话按轮次分页并附带日期索引，只读取当前显示的轮次的事件。时间线按天分组会话，用第一条提示命名没有标题的会话，并可按名称筛选；概览新增按 Agent 区分的 30 天活动图、最近的会话、最活跃的项目、每个 Agent 的版本和最后一次导入、最新的条目和遗忘，以及原始镜像的存放位置。
- `origin ui` 为你自己机器上的库提供管理界面，只在 127.0.0.1 上：它用一次性链接代替密码让浏览器登录，不包含只有中枢才有的内容；在连接了中枢的设备上，会在后台把你在其中写下和遗忘的内容同步过去。
- 在 `origin ui` 的终端中按回车，它会打印并打开一个新的登录链接，之前的链接随即失效；它启动时，会像 `origin sync --local` 一样在后台导入这台机器的 Agent 会话，同时界面已经可以使用。
- 管理界面的标签、折叠块、轮次卡片、事件链接、紧凑列表、占比条、活动图及其配色，以及 Markdown 正文，改为来自 OpenLinkOS 设计系统 0.3.0 版（`@openlinkos/ui`），不再自己定义样式：Agent 消息中的链接带下划线，事件链接更容易看到和点中，图表的配色略有变化。

### 遗忘 {#forgetting}

- 遗忘现在是一条记录，所有者随时可以恢复：`forget` 在所有地方（MCP、CLI、管理界面）都要求写原因并记录作者，`origin restore` 和管理界面的「已遗忘」页面可以写明原因后恢复（Agent 不能恢复），这个页面会向所有者展示一次遗忘隐藏了什么，`origin forgotten` 列出遗忘与恢复。恢复是一条以那次遗忘为目标的遗忘记录，像遗忘记录一样复制；请先升级中枢，再升级它的设备，因为 Origin 0.1 会忽略恢复。在管理界面中遗忘时，不再需要再次输入 id 或密码。

### 个人中枢 {#personal-hub-1}

- 为磁盘小的机器提供中继模式：`origin hub connect … --relay` 把一个空库变成中继，它只保存游标，直接从日志把 Agent 的日志发给中枢，并通过中枢回答每个 MCP 工具和 CLI 查询。
- 中枢可以把原始镜像中已封存的帧保存在兼容 S3 的存储桶（比如 MinIO）中（`origin serve --raw-s3-endpoint … --raw-s3-bucket …`，或 `ORIGIN_RAW_S3_*`，密钥从 Secret 挂载时用 `*_FILE`）；`origin raw upload` 会搬移已在磁盘上的帧并加以校验，每次 8 个（`--concurrency`），`origin backup` 会把它们复制回备份中。
- `origin status` 和 `origin hub status` 会显示设备上次完成与中枢同步的时间，以及在那之后失败的上一次同步的错误。
- 中继会在 Agent 删除它尚未发送的日志之前发出警告：当未发送的会话接近 Claude Code 的 `cleanupPeriodDays`（未设置时为 30 天），或者对于其他 Agent，已经等了一周还什么都没发出去时，`origin status`、`origin sync` 和 `origin mcp`（在它的日志里，以及中枢无法回答的工具的错误里）会给出提示。

### 工具 {#tooling}

- 库会记录它的格式版本，较新的 Origin 打开它时会就地升级一次，包括 0.1.0 的库；Origin 会拒绝格式比它所知更新的库。

### 修复 {#fixes-1}

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

### 个人中枢 {#personal-hub-2}

- `origin serve`（也是 `ghcr.io/openlinkos/origin` 镜像）：一个自托管、单租户的中枢，汇集你的设备，并通过 HTTP 向云端 Agent 提供 MCP。
- 每个设备仍然是一个完整的库。`origin sync` 把它的原始镜像、条目和遗忘记录发送到中枢，并带回在别处遗忘的内容；设备上的 Agent 同时读取两个库，中枢没有回应时退回到设备本身。
- 中枢令牌绑定到以它命名的设备。
- 面向中枢所有者的管理界面，默认关闭（`origin serve --admin`）：设备、存储、会话、检索、条目、先预览再执行的纠正和遗忘、附带现成接入命令的令牌管理，以及审计日志，由一个管理密码保护。

### 工具 {#tooling-1}

- `origin backup <dir>` 能在 Agent 持续写入时一致地复制一个库。
- 需要 Node.js 22.16 或更高版本。

[0.3.0]: https://github.com/openlinkos/origin/releases/tag/v0.3.0
[0.2.0]: https://github.com/openlinkos/origin/releases/tag/v0.2.0
[0.1.0]: https://github.com/openlinkos/origin/releases/tag/v0.1.0
