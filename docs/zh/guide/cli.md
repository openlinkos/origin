---
sourceHash: sha256-123e620d
---

# 命令参考

```text
origin sync      [--source <id>] [--verbose] [--local] 采集本机 Agent 会话；已接入中枢时再与中枢同步
origin status                                          各来源统计、条目数与上次采集时间
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                单个会话的事件（默认不含工具事件）
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id>                                  显示条目或事件，以及它的原始来源
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> [--reason <text>] [--yes]        永久遗忘条目或事件（需加 --yes 确认）
origin projects                                        已知的项目名
origin backup    <dir>                                 把数据库和原始镜像备份到 <dir>（增量）
origin mcp                                             以 stdio 运行 MCP server（接入中枢后补充中枢的回答）
origin ui        [--port 7079] [--no-open]             在浏览器中浏览和管理本库，只监听 127.0.0.1

origin serve     [--host 127.0.0.1] [--port 7077]      把本库作为个人中枢运行（MCP over HTTP）
                 [--admin | --admin-listen <host:port>] [--public-url <url>]   同时提供管理界面
                 [--raw-s3-endpoint <url> --raw-s3-bucket <name> [--raw-s3-prefix <p>]]   把已封存的帧保存在存储桶中
origin raw       upload [--remove] [--concurrency 8]    把仍在中枢磁盘上的已封存帧移入它的存储桶（在中枢上运行）
origin token     create <name> | list | revoke <name>  管理中枢的访问令牌（在中枢上运行）
origin admin     password [--generate]                 设置管理界面的密码，并让所有会话退出登录（在中枢上运行）
origin admin     sessions [--revoke-all] | audit [--limit 50]       管理界面的会话与审计日志
origin hub       connect <url> --token <token> [--device <name>] [--relay] | status | disconnect
origin push                                            与 origin sync 相同（为已有的定时任务保留）
```

- **时间参数**：相对时长（`30m`、`24h`、`7d`、`2w`）或日期（`YYYY-MM-DD`、ISO 8601）。
- **来源 id**：`claude-code`、`codex`、`cursor`、`grok` 与 `zcode`。
- **条目类型**：`memory`（发生过什么）、`knowledge`（稳定的事实）、`cognition`（你的偏好、方法、目标与边界）。
- **id 形式**：条目如 `ent_5f0c2a9e41b7`；事件如 `claude-code:<uuid>` 或 `codex:<session>:o12`；遗忘记录（遗忘操作留下的记录）如 `tmb_3a9d70c1e2f4`。
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

## 纠正与遗忘 {#correcting-and-forgetting}

`correct` 会为条目添加一个新版本，旧版本保留为历史。`forget` 会先列出影响范围，加 `--yes` 才真正执行：

```console
$ origin forget ent_5f0c2a9e41b7
This will forget 1 entry and 1 event:
  ent_5f0c2a9e41b7
  claude-code:4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b

Forgetting cannot be undone. Re-run with --yes to confirm.
```

遗忘规则见[隐私与数据](./privacy.md#forgetting)。

## 在浏览器中 {#in-your-browser}

`origin ui` 为这台机器的库提供[管理界面](./admin.md#on-your-own-machine)，只监听 `127.0.0.1`，端口默认为 7079，可用 `--port` 指定。它会打印一个登录链接，并在默认浏览器中打开；链接只能使用一次，须在 5 分钟内使用；`--no-open` 只打印链接。这里没有密码。它在终端里运行时，按 Enter 就会得到一个新链接，同样会打印并打开；之前的链接随即失效。用 Ctrl+C 停止它，浏览器也随之退出登录。它启动时会在后台归档这台机器上 Agent 的会话，和 `origin sync --local` 一样，所以界面能显示 Agent 最近写下的内容；归档期间界面照常可用。它拒绝在中继上运行，因为中继不保有自己的会话。在已接入中枢的设备上，你在那里写入的条目和遗忘操作会在后台与中枢同步，与 `correct` 和 `forget` 之后一样。

## 个人中枢 {#personal-hub}

这些命令用于运行[个人中枢](./hub.md)，以及把设备接入中枢。

- 在中枢上，`origin serve` 提供 `POST /mcp` 和复制接口，`GET /healthz` 用于健康检查，不需要鉴权。`origin token create <name>` 会打印一个新令牌，只显示一次（以 `ogn_` 开头）；中枢只保存令牌的哈希。设备的令牌请以设备命名：它只对同名的设备有效。被吊销的令牌可以用同一个名称新建一个来替换。
- 在设备上，`origin hub connect` 保存中枢地址和令牌；中枢以设备的库名称来识别它，这个名称必须与令牌名相同。`origin hub connect` 和 `origin hub status` 会向中枢核对，不一致时说明如何解决。此后 `origin sync` 也会与中枢同步：发送新的原始镜像字节，以及在本设备上写下的条目和遗忘记录，再应用中枢的遗忘记录。可以随时重跑，每次都会从上次停下的位置继续。`--local` 会跳过中枢。`origin status` 和 `origin hub status` 会显示这台设备上一次与中枢同步完成的时间（无论由哪个命令或 Agent 发起），如果此后有一次同步失败，还会显示它的错误。
- 设备接入后，`origin mcp` 根据设备的库作答，并合并中枢的回答，等待中枢最多 2 秒；Agent 保存的内容写在设备上，然后再同步。
- 管理命令（`entries`、`show`、`correct`、`forget` 等）作用于设备自己的库。在已接入中枢的设备上，`correct` 和 `forget` 之后会与中枢同步；如果连不上中枢，改动会留在设备上，直到下一次同步。
- `origin hub connect … --relay` 把一个空库变成[中继](./hub.md#run-a-device-as-a-relay)，它不保有自己的会话或条目；已经保存了这些内容的库会被拒绝。在中继上，`origin sync` 直接把 Agent 新增的记录行发送给中枢（`--local` 不适用），`origin status` 按来源显示尚未发送的文件和字节，并在尚未发送的会话临近被 Agent 删除的年龄时发出警告，`origin mcp` 把每一次工具调用都交给中枢，`search`、`timeline`、`show`、`entries`、`correct` 和 `forget` 都会询问中枢；`entries --history` 和 `projects` 不可用。`origin hub status` 会显示模式。
- `origin serve --admin` 会同时在 `/admin` 下提供[管理界面](./admin.md)；`--admin-listen <host:port>` 则改为在单独的监听地址上提供。在 TLS 之后时，用 `--public-url` 传入中枢的 https 地址；中枢拒绝在回环地址之外通过明文 HTTP 提供管理界面。
- `origin serve --raw-s3-endpoint <url> --raw-s3-bucket <name>`，或 `ORIGIN_RAW_S3_*` 环境变量，会把中枢已封存的帧——原始镜像的大部分——保存在兼容 S3 的存储桶中，例如 MinIO；密钥只从环境变量读取。`origin raw upload` 把此前封存的帧移入存储桶并逐帧校验，默认一次 8 帧（可用 `--concurrency` 调整），`--remove` 随后删除原先存放它们的本地文件。见[把原始镜像放进存储桶](./hub.md#keep-raw-mirrors-in-a-bucket)。
- `origin admin password` 设置管理界面的密码：在终端中询问两次，不显示你输入的内容；没有终端时从标准输入读取一行。`--generate` 随机生成一个密码，只打印一次。密码至少需要 10 个字符，设置后所有管理会话都会退出登录。中枢第一次在启用管理界面的情况下启动时，会生成一个密码，并在日志中打印一次。`origin admin sessions --revoke-all` 让所有会话退出登录，`origin admin audit` 打印审计日志。用 CLI 进行的令牌和密码变更也会记录在其中。

## 环境变量 {#environment-variables}

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Origin 的数据库与原始镜像目录 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置目录（会话从 `<dir>/projects` 读取） |
| `ORIGIN_CLAUDE_PROJECTS` | — | 直接指定 Claude Code 的 projects 目录 |
| `CODEX_HOME` | `~/.codex` | Codex 的主目录（从 `sessions/` 与 `archived_sessions/` 读取会话） |
| `ORIGIN_HUB_URL` | — | 中枢地址，覆盖 `origin hub connect` 的配置 |
| `ORIGIN_HUB_TOKEN` | — | 中枢令牌，覆盖 `origin hub connect` 的配置 |
| `ORIGIN_DEVICE` | 主机名 | 新库使用的名称：也就是本设备在中枢上的名称，以及它写入的内容所记录的来源库（origin） |
| `ORIGIN_HUB_TIMEOUT_MS` | `2000` | 已接入中枢的设备上，`origin mcp` 等待中枢多久，超时后不再等待中枢直接作答 |
| `ORIGIN_WATCH_INTERVAL_MS` | `60000` | Agent 运行期间，`origin mcp` 多久查看一次新的记录行（已接入中枢时一并同步）；设为 `0` 则关闭 |
| `ORIGIN_ADMIN` | `off` | 设为 `on` 时在 `/admin` 下提供管理界面（`origin serve --admin`） |
| `ORIGIN_ADMIN_LISTEN` | — | 改为在这个 `host:port` 上提供管理界面（`--admin-listen`） |
| `ORIGIN_PUBLIC_URL` | — | 中枢的公开 https URL（`--public-url`） |
| `ORIGIN_CLIENT_IP_HEADER` | — | 由你的代理设置、携带客户端地址的请求头；只有设置了才会被信任，在代理或 CDN 之后必须设置 |
| `ORIGIN_ADMIN_PASSWORD` | — | 管理界面的密码（至少 10 个字符）；设置后取代用 `origin admin password` 设置的密码 |
| `ORIGIN_RAW_S3_ENDPOINT`, `ORIGIN_RAW_S3_BUCKET` | — | 把中枢已封存的帧保存在这个兼容 S3 的存储桶中（`--raw-s3-endpoint`、`--raw-s3-bucket`） |
| `ORIGIN_RAW_S3_PREFIX` | 无 | 存储桶中键的前缀（`--raw-s3-prefix`） |
| `ORIGIN_RAW_S3_REGION` | `us-east-1` | 发往存储桶的请求签名所用的区域（`--raw-s3-region`） |
| `ORIGIN_RAW_S3_ADDRESSING` | `path` | `path` 或 `virtual`：存储桶的寻址方式（`--raw-s3-addressing`） |
| `ORIGIN_RAW_S3_ACCESS_KEY_ID`, `ORIGIN_RAW_S3_SECRET_ACCESS_KEY` | — | 存储桶的密钥；加上 `_FILE` 时指定存放它们的文件 |
| `ORIGIN_RAW_S3_TIMEOUT_MS` | `30000` | 发往存储桶的单个请求最长可用的时间 |
