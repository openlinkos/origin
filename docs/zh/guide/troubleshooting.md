---
sourceHash: sha256-58af5409
---

# 常见问题

常见的问题、你会看到什么，以及该怎么做。Origin 的提示会说明出了什么问题，通常也会说明怎么解决；下面引用的就是这些提示的原文。

## 安装与接入 {#installing-and-connecting}

### Node.js 版本太旧 {#nodejs-is-too-old}

每个命令都失败，提示 `Origin needs Node.js 22.16 or later; this is v20.11.1.`。Origin 用到了 Node.js 22.16 才加入的 zstd 压缩和 SQLite 在线备份。

安装 Node.js 22.16 或更高版本，然后用它重新安装 Origin（`npm install -g @openlinkos/origin`）。如果你用版本管理工具，请确认 Agent 启动的 Node.js 与你的终端里的是同一个：从桌面启动器打开的 Agent，可能在它的 `PATH` 上找到另一个版本。在 Agent 的终端里运行 `node --version` 就能看出是哪个。

### Agent 看不到 Origin 的工具 {#an-agent-does-not-see-origins-tools}

Agent 的列表里没有 `origin` server，或者 server 启动失败。

- 检查注册情况：`claude mcp list`、`codex mcp list` 或 `grok inspect`（见[接入 Agent](./connect-agents.md)）。请在用户范围注册 Origin，而不是按项目注册，这样每个项目都能看到它。
- 在 Windows 上，npm 把 `origin` 装成 `.cmd` 脚本，Agent 无法直接启动它。请注册 `cmd /c origin mcp`，而不是 `origin mcp`。
- 在 Git Bash 里注册时，请在前面加上 `MSYS_NO_PATHCONV=1`，否则 Git Bash 会把 `/c` 改写成 `C:/`，注册的命令启动时就会失败：`MSYS_NO_PATHCONV=1 claude mcp add --scope user origin -- cmd /c origin mcp`。
- 注册或更新 Origin 之后，请重启 Agent：Agent 在会话开始时才启动它的 MCP server。
- 在终端里运行 `origin status`。如果它失败了，server 也会以同样的方式失败，提示会说明原因。

### hook 没有起作用 {#a-hook-does-nothing}

`origin agents` 显示 hook 已经设置好，但会话的行要在一轮结束一分钟后才进入 Origin 或中枢，或者在没有 `origin mcp` 运行时根本不进入。

- **开始一个新会话。** Agent 在会话开始时读取它的 hook。
- **在 Codex 中信任这些 hook。** 新的 hook，以及改动过的 hook，在你信任之前 Codex 都会跳过：在 Codex 里打开 `/hooks`，检查 Origin 的 hook 并信任它们。还有 hook 等待检查时，Codex 会在启动时提醒。
- **它们在后台运行。** 采集 hook 是 `async` 的：Agent 不等待它们，也不显示它们输出的任何内容。`/hooks` 会列出它们；Claude Code 在详细模式（`Ctrl+O`）下会显示后台 hook 何时结束。无论出了什么问题，hook 都以 0 退出，只在标准错误中说明原因。
- **记录文件落后于 hook。** Agent 异步写入它们的记录文件，所以 hook 运行时，这一轮的最后几行可能还没写下。Origin 只读取完整的行；其余部分会随下一个 hook 到达，或者在一分钟内由 `origin mcp` 读取。这是正常的。
- **与 `origin sync` 读取同样的目录。** hook 只采集 Origin 为这个 Agent 读取的目录下的记录文件：Claude Code 是 `~/.claude/projects`（或 `CLAUDE_CONFIG_DIR`、`ORIGIN_CLAUDE_PROJECTS`），Codex 是 `~/.codex`（或 `CODEX_HOME`）下的 `sessions/` 或 `archived_sessions/`。hook 使用 Agent 的环境运行，所以请给 Agent 同样的环境变量，包括 `ORIGIN_HOME`。
- **手动运行它**，给它一个和 Agent 发送的一样的事件，再看它在标准错误中说了什么。一切正常时它什么都不输出，之后 `origin timeline --session <id>` 会显示这个会话最新的消息：

```sh
echo '{"hook_event_name":"Stop","transcript_path":"/home/dana/.claude/projects/-home-dana-code-acme/5e8f0a1b-2c3d-4e5f-9a6b-7c8d9e0f1a2b.jsonl"}' | origin sync --hook claude-code
```

在已接入中枢的设备上，hook 最多等待中枢 3 秒，之后提示 `not sent to the hub yet`；没有发出的内容会在下一次同步时发送。

### 结果里缺少刚说过的话 {#results-lack-what-was-just-said}

Agent 找不到一个会话最后几条消息。

Claude Code 和 Codex 的采集 hook 会在每一轮结束时读入会话新增的行（见[hook 没有起作用](#a-hook-does-nothing)）。`origin mcp` 也会在 `search` 和 `timeline` 之前读入新的日志行，最多每 10 秒一次；在 `remember` 和 `correct` 之前总会读入；后台每分钟一次；Agent 退出时再读一次（见[时效](./mcp.md#freshness)）。所以检索通常能看到几秒前说的话。看不到的是：

- 不使用 Origin 的 Agent 的会话，要等使用 Origin 的 Agent 运行，或运行 `origin sync`。在只有这类 Agent 运行的机器上，请定时运行 `origin sync`。
- 其他设备的会话，要等那台设备的 hook 或同步把它们发给中枢。
- 对没有采集 hook 的 Agent，如果后台查看被关闭（`ORIGIN_WATCH_INTERVAL_MS=0`），什么都看不到。

## 升级 {#upgrading}

### 较新的 Origin 用过的库被拒绝 {#a-store-of-a-newer-origin-is-refused}

每个命令都失败，提示 `The store at … has format version 4, but this Origin knows versions up to 3 only: a newer Origin has used it. Upgrade Origin to open it; nothing was changed.`

较新的 Origin 已经升级了这个库，而一个较旧的 Origin 想打开它，常见的是从另一处安装启动、或在你更新之前就已启动的 Agent 的 MCP server。请更新所有使用这个库的安装（`npm install -g @openlinkos/origin@latest`；中枢则更新镜像），然后重启 Agent。不支持在已升级的库上退回较旧的 Origin。

### 打开库时会升级它 {#the-store-is-upgraded-when-it-is-opened}

更新之后，某个命令输出 `Upgrading the store to version 4: …`，并且比平时慢。

新版本可能会改变库的格式；第一个打开库的命令会就地把它升级到最新，只做一次。有些升级要重新读取已归档的日志，在大的库或中枢上需要一段时间。期间打开这个库的其他命令和 Agent 会等待升级完成，最多 5 分钟。为保险起见，更新前请先备份库（见[备份](./privacy.md#backing-up)）。

如果某一步失败，提示会说明：`The store could not be upgraded to version 4 (…): … Nothing of this step was kept; it runs again the next time the store is opened.`。解决提示中指出的原因，再运行任意一个命令即可。需要重新读取已归档日志的步骤，要用 `origin` 命令来打开库；在把原始镜像放在存储桶里的中枢上，还要先配置好存储桶。

## 个人中枢 {#personal-hub}

### 连不上中枢 {#the-hub-cannot-be-reached}

Agent 得到的结果末尾带有 `Note: the Origin hub was not consulted (the hub at https://hub.example.com is unreachable: …); these results come from this device only.`，或者 `origin sync` 失败。

没有中枢，设备也照常工作：它等待中枢 2 秒（`ORIGIN_HUB_TIMEOUT_MS`）后用自己的库作答，把 Agent 写下的内容先存在本地，下一次同步时再发送。只有纠正或遗忘只在中枢上才有的内容，才需要中枢。

运行 `origin hub status`：它显示设备上次同步的时间、上一次失败的同步的错误，以及中枢现在是否接受这个令牌。提示中枢 `rejected the token (HTTP 401)`，说明令牌已被吊销或输错了：请重新接入这台设备，用 `origin hub connect <url>` 并在管理界面中批准，或者用在中枢上新建的令牌（见[设备和 Agent](./hub.md#devices-and-agents)）。还要检查中枢前面的 TLS 代理或 CDN（见[放在 TLS 之后](./hub.md#put-it-behind-tls)），以及不需要令牌的 `GET /healthz`。

### 令牌属于另一台设备 {#the-token-belongs-to-another-device}

`origin hub connect` 失败，提示 `This token belongs to device "laptop", but this store is named "desktop"; …`，或者中枢以 403 拒绝请求。

中枢令牌只对以它命名的那台设备有效，而设备以它的库的名称为人所知。要么在中枢上创建一个以这个库命名的令牌（`origin token create desktop`），用它来连接；要么，如果这台机器就是 `laptop`，用 `--device laptop` 以那个名称连接。库一旦以某个名称写过条目或遗忘记录，就会保留这个名称（`This store is named "desktop" and keeps that name, …`）；从 Agent 记忆文件导入的条目不算在内。

### Agent 或设备无法登录中枢 {#an-agent-or-a-device-cannot-sign-in-to-the-hub}

`claude mcp login origin` 或 `codex mcp login origin` 报告服务器不支持 OAuth，`origin hub connect <url>` 提示中枢 `does not let devices connect by browser`，或者中枢的页面显示 `This sign-in cannot go on`（中文界面中是“这次登录无法继续”）。

- Agent 和设备通过中枢的[管理界面](./admin.md)登录，所以管理界面必须在中枢自己地址的 `/admin` 下提供（`--admin` 或 `ORIGIN_ADMIN=on`），而不是在单独的监听地址上；中枢前面的代理也必须转发 `/.well-known/oauth-*` 和 `/oauth/*`（见[放在 TLS 之后](./hub.md#put-it-behind-tls)）。否则，请使用令牌（见[设备和 Agent](./hub.md#devices-and-agents)）。
- Claude Code 只登录通过 https 提供的中枢，或者 `localhost`、`127.0.0.1` 上的中枢。
- `Could not read the app's description at https://…`：Claude Code 和 Codex 用 claude.ai 和 chatgpt.com 上的文档描述自己，由中枢去获取；中枢必须能通过 https 访问它们，并且会拒绝私有网络上的地址。
- 以前能用、现在又要求重新登录的 Agent，是被吊销了、退出了登录，或者已到你允许的期限；也可能是它的某个刷新令牌被使用了两次，这会吊销它。请让它重新登录。

### 中继警告有会话还没有发送 {#a-relay-warns-about-sessions-not-sent-yet}

`origin status` 或 Agent 显示 `Warning: Claude Code sessions not sent to the hub yet were last written 24 days ago, and Claude Code deletes them after 30 days (…); …`

[中继](./hub.md#run-a-device-as-a-relay)不为还没发送的会话保留副本，所以如果 Agent 先删除了日志，这些会话就丢失了。请让中枢可以访问，并运行 `origin sync`；`origin status` 按来源显示还有多少待发送。对 Claude Code，你也可以在它的 `settings.json` 里用 `cleanupPeriodDays` 让日志保留更久。

### PostgreSQL 数据库被拒绝 {#the-postgresql-database-is-refused}

中枢无法启动：`The database origin has encoding UTF8 and locale en_US.UTF-8 (libc); a store needs a UTF8 database whose locale is C. Create one with: …`，或者 `Origin needs PostgreSQL 17 or later; this server runs 16.4.`

只有在编码为 UTF8、locale 为 C 的数据库中，PostgreSQL 里的库比较文本、折叠大小写的方式才和 SQLite 一样，所以 Origin 在创建任何东西之前都会检查。数据库的 locale 无法更改：按消息所说新建一个数据库，`CREATE DATABASE origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';`，再让 `ORIGIN_DATABASE_URL` 指向它（见[在 PostgreSQL 上运行中枢](./hub.md#run-the-hub-on-postgresql)）。如果中枢已经在旧数据库上运行过，请先用 `origin db move --to <new-url>` 移走它的库，再删除旧数据库。

### 命令等待库之后失败 {#a-command-waits-for-the-store-then-fails}

中枢所在主机上的某个命令失败，提示 `database is locked: another Origin process holds the store's write lock` 或 `statement timed out`；或者 `origin serve` 拒绝启动：`Another origin serve is running on the store at …: a store is served by one hub at a time.`

- 每次写入都要先拿到库的写锁，最多等 10 秒，与 SQLite 时一样。这样失败的命令遇到了一次较长的写入，例如正在解析的大批推送、一次清除或 `origin db move`：再运行一次即可。
- 一条语句最多运行 5 分钟，一个事务最多空闲等待 5 分钟；`origin db move` 和 `origin db rebuild-search` 在大库上建索引需要更久，允许运行一天。语句超时会让它所在的命令失败，什么也不会改变：检查数据库服务器的负载，然后再运行一次。
- 一个库只由一个中枢服务。另一个 `origin serve` 占着这个库，可能在这台机器上，也可能在另一台指向同一数据库和 schema 的机器上：停掉它。中枢断线后重新连接时会再次拿到这把锁；被强行终止的中枢，在 PostgreSQL 察觉后就会释放它，可能立即，也可能在几分钟之内，取决于服务器的 TCP keepalive 设置。

### 数据库和数据目录不配对 {#the-database-and-the-data-directory-do-not-belong-together}

某个命令或中枢拒绝打开库：`The database at … holds store …, but ORIGIN_HOME … belongs to store …`、`The store at … is not paired with ORIGIN_HOME …`、`The store of ORIGIN_HOME … is in PostgreSQL …: set ORIGIN_DATABASE_URL …`，或者 `The store at … has been moved to …`。

PostgreSQL 中的库把原始镜像放在 `ORIGIN_HOME`（中枢上是 `/data`）中，那里的 `store.json` 记录这些镜像属于哪个库（见[在 PostgreSQL 上运行中枢](./hub.md#run-the-hub-on-postgresql)）。数据库和目录不配对时，Origin 会拒绝，而不是用一个库的事件搭配另一个库的镜像，或者新建一个空库：

- 检查 `ORIGIN_DATABASE_URL`（它的数据库和 `schema` 参数）以及 `ORIGIN_HOME`，或者挂载在 `/data` 的卷。
- `is in PostgreSQL … set ORIGIN_DATABASE_URL`：库已经移到 PostgreSQL，而命令运行时没有 URL；设置它即可。
- `has been moved to …`：`origin db move` 已经把库从这个数据库移走；让 URL 指向它现在所在的位置，如果它在 SQLite 中，就去掉 URL。
- 不要为了绕过这个检查而编辑或删除 `store.json`。

## 归档与数据 {#archive-and-data}

### 解析错误 {#parse-errors}

`origin sync` 报告某个来源有解析错误，或者管理界面的概览显示某个 Agent 有解析错误。

某个 Agent 改变了日志格式，有些行暂时读不懂。不会丢失任何东西：每一行都保存在原始镜像中，文件其余部分照常读取。`origin sync --verbose` 会输出每个错误及其文件和行号。请更新 Origin；新版本学会读取这些行后，会在需要时重新读取它们。如果在最新版本上仍有解析错误，请[报告问题](https://github.com/openlinkos/origin/issues)，写明 Agent 及其版本，但不要附上这些行本身，因为其中可能有隐私数据。

### 数据在哪里，占多少空间 {#where-the-data-is-and-how-much-space-it-takes}

`origin status` 的最后一行是 `Data directory: …`：`~/.origin`，或 `ORIGIN_HOME`。其中有数据库 `origin.db`，以及日志的压缩副本 `raw/`（见[Origin 保存了什么](./privacy.md#what-origin-stores)）。管理界面概览中的「存储」面板（在设备上用 `origin ui`）会显示各占多少空间。

粗略估算，数据库每个事件约占 2.5 KB；日志停止增长之后，原始镜像约为所复制日志的五分之一。数据库旁边的 `origin.db-wal` 存放最近的写入；每次检查点之后，它会被截回到 64 MB。

### 迁移或重置库 {#moving-or-resetting-a-store}

数据库和原始镜像是一个整体：不要只删除、替换或复制其中之一，也不要在 Origin 运行时只复制 `origin.db`。

- **要迁移一个库**，用 `origin backup <dir>` 把它备份到新的空目录，停止 Agent，再备份一次到同一个目录，以复制这期间的变化，然后让 `ORIGIN_HOME` 指向它，包括在你的终端里，以及 Agent 启动 `origin mcp` 时的环境里。备份不包含 `hub.json`，其中是与中枢的连接及其令牌：把它也复制过去，或者用 `origin hub connect` 重新连接。
- **要从头开始**，让 `ORIGIN_HOME` 指向一个新的空目录，把旧目录留作备份。在连接了中枢的设备上，恢复一份备份比用空库更好：库保留它的名称和它在中枢记录中的位置，所以能从中断的地方接着同步。
- **要清除全部数据**，见[清除全部数据](./privacy.md#removing-everything)。
