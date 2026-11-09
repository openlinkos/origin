---
sourceHash: sha256-e916c39e
---

# 个人中枢

默认情况下，Origin 只在一台机器上运行：它归档这台机器上的 Agent 会话，也只有这台机器上的 Agent 能访问它。**个人中枢**把你所有机器的会话汇集到一个库里，供你的 Agent 无论在哪里运行都能使用。中枢是自托管、单租户的，只服务一个人以及这个人的设备和 Agent。

## 什么时候需要 {#when-you-need-one}

- 你在多台机器上使用 AI Agent，比如笔记本、台式机和服务器，希望每台机器上的 Agent 都记得在其他机器上发生过的事。
- 你使用云端 Agent，它们本地没有会话记录，但也应该能检索和保存你的记忆。

如果你的 Agent 都在同一台机器上，就不需要中枢。

## 工作方式 {#how-it-works}

- 每台**设备**照旧在本地归档自己的会话，和没有中枢时完全一样，然后运行 `origin sync`。设备接入中枢后，同步还会把本机的原始会话镜像，以及在本机写下的条目和遗忘记录发送到中枢，再取回在中枢或其他设备上被遗忘的内容，以及你在中枢上清除的内容。
- **中枢**运行 `origin serve`。它用同样的适配器解析推送来的镜像，所以每个回答仍能追溯到原文行；它保存每台设备发来的内容，在那里能找到一切。
- 在设备上，`origin mcp` 仍然根据设备自己的库作答，所以离线时照常可用，同时补充中枢知道的内容：其他设备的会话和条目，以及云端 Agent 写下的条目。云端 Agent 直接连接中枢的 MCP 端点。
- 设备之间从不互相下载数据。从中枢下行的只有遗忘和清除，这样你在任何地方遗忘的内容，在所有地方都会被隐藏，而你在中枢上清除的内容，在所有地方都会被删除。
- 磁盘空间不多的机器可以作为**中继**，而不是完整的设备：它除了游标什么也不保存，直接把 Agent 的记录发送给中枢，并通过中枢回答它的 Agent（见[把设备作为中继运行](#run-a-device-as-a-relay)）。

设计细节见[架构](../architecture.md#personal-hub)。

## 运行中枢 {#run-the-hub}

用 Docker：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

容器内的 `ORIGIN_HOME` 是 `/data`，中枢监听 `0.0.0.0:7077`。请保留 `/data` 卷，整个库都在里面；备份方法见[备份](./privacy.md#backing-up)。`latest` 是最新发布的版本；长期运行的中枢请固定一个次版本，比如 `ghcr.io/openlinkos/origin:0.3`，并按[升级](./upgrading.md#upgrade-a-hub)中的说明升级。

不用 Docker 时，在任何装有 Origin 的机器上（`npm install -g @openlinkos/origin`）：

```bash
origin serve --host 127.0.0.1 --port 7077
```

`GET /healthz` 用于健康检查，不需要鉴权；`POST /mcp` 是 MCP 端点。加上 `--admin` 还会在 `/admin` 下提供[管理界面](./admin.md)；有了它，设备和 Agent 会经由你、在你的浏览器里登录，而不是用你复制过去的令牌（见[设备和 Agent](#devices-and-agents)）。

## 公开首页 {#the-landing-page}

在浏览器中打开中枢的地址，比如 `http://localhost:7077/`，会看到一个不需要令牌的公开页面：Origin 的标志和名称，一句说明这个中枢是什么的话（按浏览器的偏好显示中文或英文）；如果[管理界面](./admin.md)在同一端口的 `/admin` 下提供，还有一个**登录**按钮；页脚是「由开源的 Origin 驱动」，以及指向本站和源代码的链接。页面不显示库里的任何内容。请求 JSON 的客户端（`Accept: application/json`）会收到 `{"service":"origin","docs":"https://origin.openlinkos.com/"}`。`/robots.txt` 只允许搜索引擎读取这个页面，页面用到的样式表、字体和标志由中枢自己在 `/assets/` 下提供。

中枢让搜索引擎不收录整个站点（`/robots.txt` 禁止一切）：这个页面是给打开地址的人看的，不是给搜索结果的。

如果你以自己的名义展示这个中枢，设置 `ORIGIN_POWERED_BY=off` 可以去掉页面上对 Origin 的署名；管理界面中指向项目的链接仍然保留。

除 `/healthz`、有自己登录的管理界面，以及 Agent 和设备在 `/.well-known/` 和 `/oauth/` 下的登录端点外，其他所有路径都需要令牌（见[设备和 Agent](#devices-and-agents)）。没有令牌的请求会收到 `401` 和 `{"error":"Missing or invalid token.","docs":"https://origin.openlinkos.com/guide/hub"}`，其中的 `docs` 就是本指南。

## 放在 TLS 之后 {#put-it-behind-tls}

中枢使用明文 HTTP。在 localhost 之外开放之前，请把它放在负责 TLS 的反向代理或 CDN 之后，并按以下要求配置代理：

- 把 `/healthz`、`/mcp` 和 `/v1/*` 转发给中枢；为了[公开首页](#the-landing-page)，还要转发 `/`、`/robots.txt` 和 `/assets/*`。管理界面在 `/admin` 下时，还要转发 `/.well-known/oauth-protected-resource`、`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server` 和 `/oauth/*`，Agent 和设备通过它们登录。
- `/v1/ingest` 用于设备推送会话数据，请求体上限至少设为 16 MiB；如果有程序向中枢追加事件行，`/v1/sources/*/lines` 的请求体上限设为 8 MiB（见[追加事件行](#append-event-lines)）。
- 不要缓存 `/mcp`、`/v1/*` 和 `/oauth/*`。
- 如果在 `/admin` 下启用了管理界面，还请按[放在 TLS 和 CDN 之后](./admin.md#behind-tls-and-a-cdn)配置；尤其要设置 `ORIGIN_CLIENT_IP_HEADER`，否则任何人的失败登录都会算在你头上。

## 设备和 Agent {#devices-and-agents}

所有访问中枢的东西都代表你：你的**设备**，也就是与中枢同步会话的机器；以及你的 **Agent**，也就是使用中枢 MCP 端点的云端 Agent、机器人和流水线。每一个都有自己的名称和凭据，你可以随时吊销它们：在管理界面的**设备和 Agent**页面，或者在中枢上用 `origin token list` 和 `origin token revoke <name>`。没有其他人：中枢只属于你一个人。

[管理界面](./admin.md)在中枢自己地址的 `/admin` 下提供时（`--admin`），能打开浏览器的设备和 Agent 会经由你来登录，不需要到处复制令牌：

- 设备运行 `origin hub connect <url>`，由你在管理界面中批准（见[接入设备](#connect-a-device)）。
- Claude Code、Codex 和其他 MCP 客户端用 OAuth 登录：它们在你的浏览器里打开中枢，由你允许，之后它们自己保管并续期自己的令牌（见[接入云端 Agent](#connect-a-cloud-agent)）。

对于不能打开浏览器的程序，例如机器人、CI 任务或流水线，或者在没有在 `/admin` 下提供管理界面的中枢上，请在中枢上创建令牌：

```bash
origin token create laptop                         # 设备的令牌，以设备命名；只显示一次，以 ogn_ 开头
origin token create ci --agent                     # Agent 的令牌：MCP 和事件行
origin token create dashboard --agent --readonly   # 只读取的 Agent
origin token list
origin token revoke ci
```

使用 Docker 时，通过 `docker exec` 运行同样的命令，例如 `docker exec origin-hub origin token create laptop`。在管理界面中，**添加 Agent** 会创建一个 Agent 的令牌并显示一次，同时给出使用它的命令。

- **各自能做什么。** 设备，以及你没有另作选择的 Agent，都是*读写*的：令牌能做的一切都可以做。Agent 也可以是*只读*的：它通过 MCP 搜索和读取，没有写入类工具（`remember`、`propose`、`correct`、`forget`），也不向中枢发送任何内容。在有这项设置之前创建的令牌照旧可用，都是读写的。
- **设备的令牌只对它自己有效。** 令牌名就是设备名：令牌 `laptop` 只能为设备 `laptop` 发送和接收会话、条目和遗忘记录，中枢不接受它代表其他任何设备。所以即使令牌被盗，也无法冒充另一台设备写入。
- 中枢只保存令牌的哈希，所以请在令牌显示时复制下来。设备丢失令牌时，请吊销它，再重新接入这台设备，通过浏览器，或者用一个同名的新令牌；设备保留原来的名称。设备退役时，请吊销它。条目会把 Agent 和设备记为作者，例如 `claude-code@laptop`；直接连接中枢的 Agent 则记为它的名称，例如 `ci`，通过 OAuth 登录的 Claude Code 记为 `claude-code`。

## 接入设备 {#connect-a-device}

在每台有 Agent 会话记录的机器上：

```bash
origin hub connect https://hub.example.com
origin hub status
origin sync
```

`origin hub connect` 向中枢要一个验证码，并打印在哪里批准这台设备：

```text
To connect laptop to https://hub.example.com, open this link, sign in, and approve it:

    https://hub.example.com/admin/activate?code=BCDF-GHJK

or open https://hub.example.com/admin/activate and enter the code BCDF-GHJK. It expires in 10 minutes.
Waiting for approval…
```

在任意设备的任意浏览器中打开这个链接，登录管理界面，核对验证码与命令显示的一致，然后选择**接入 laptop**。几秒之内，命令就会收到设备的令牌并完成接入。如果已经有同名的设备接入，页面会说明；批准后这个名称归新设备，旧设备的令牌随即失效。只批准你刚刚在自己设备上看到的验证码。

在没有在 `/admin` 下提供管理界面的中枢上，请在中枢上为设备创建令牌，再用它接入：`origin hub connect https://hub.example.com --token ogn_… --device laptop`。

- 中枢以设备的库名称来识别设备：也就是库第一次使用时的 `ORIGIN_DEVICE` 或主机名。设备以这个名称接入，它的令牌也以它命名；`origin hub connect` 和 `origin hub status` 会向中枢核对，不一致时拒绝并说明如何解决。`--device` 可以给一个还没有保存过条目、也没有遗忘过任何内容的库改名；此后库会一直保持这个名称，为它创建的令牌也必须使用这个名称。`origin hub disconnect` 用于断开连接。
- 环境变量 `ORIGIN_HUB_URL`、`ORIGIN_HUB_TOKEN` 会覆盖保存的连接配置。
- `origin sync` 会采集本机会话，应用在中枢上做的清除，发送原始镜像以及在本机写下的条目和遗忘记录，再应用中枢的遗忘记录。可以随时重跑：同步会从上次停下的位置继续。`origin push` 的作用相同。

设备接入后，你已有的 Agent 注册都不用改。`origin mcp` 根据设备的库作答，同时询问中枢，再把两边的回答合并；每条结果都会说明它是在本设备上（`local`）还是在中枢上（`hub`）找到的。如果中枢在 2 秒内（`ORIGIN_HUB_TIMEOUT_MS`）没有回应，Agent 会得到本设备的回答，并附带一条说明：这次没有询问中枢。Agent 保存的内容先落到设备上，并立即同步到中枢；连不上中枢时，则在下一次同步时发送。纠正或遗忘只有中枢才有的内容会在中枢上执行，因此需要能连上中枢。

Agent 运行期间，Claude Code 和 Codex 的采集 hook 会在每一轮结束时把这一轮新增的行推送给中枢，它的 `origin mcp` 也会在后台同步：记录文件有变化时每分钟一次，Agent 退出时再同步一次，所以设备不需要定时同步。不使用 Origin 的 Agent 的会话，会在下一次有使用 Origin 的 Agent 运行时，或者运行 `origin sync` 时被收取；只有在某台设备上只运行这类 Agent 时，才需要定时运行 `origin sync`（例如用 cron，`*/10 * * * * origin sync`，或 Windows 任务计划程序）。

## 把设备作为中继运行 {#run-a-device-as-a-relay}

设备通常保有一份完整的、属于自己的记忆，其中包括它归档过的每份会话记录的压缩副本。在磁盘空间不多的机器上，例如一台小 VPS，可以改为把它作为**中继**运行：它不保留副本，也不保有自己的记忆，只为每个记录文件保存一个游标，直接从 Agent 自己的记录文件把新的会话发送给中枢。

用 `--relay` 接入一个空库：

```bash
origin hub connect https://hub.example.com --device vps --relay
origin sync
origin status
```

和其他设备一样，在管理界面中批准这台设备，或者用 `--token` 传入在中枢上创建的令牌。

- 只有还没有保存任何内容的库才能成为中继。如果这台机器上已经有一个保存了会话或条目的库，Origin 会拒绝，并且不做任何改动；请把 `ORIGIN_HOME` 设为一个新目录，再接入那个库。中继会一直是中继；要在这台机器上重新保有完整的库，请再使用一个新的 `ORIGIN_HOME`。
- `origin sync` 把每份会话记录新增的完整行发送给中枢，中枢像收到设备自己的副本一样归档并解析它们；`origin status` 按来源显示还有多少文件和字节尚未发送。和其他设备一样，Agent 的采集 hook 和 `origin mcp` 在运行中也会发送新的行。
- Agent 的注册都不用改，但在中继上，`origin mcp` 的每个工具都由中枢作答：它先把刚刚写下的内容发送给中枢，让 Agent 能找到并引用它，再把调用交给中枢。Agent 保存的内容写在中枢上，作者记为 `claude-code@vps`。连不上中枢时，工具会失败，并说明中继离线时无法作答。
- `origin search`、`timeline`、`show`、`entries`、`correct` 和 `forget` 也会询问中枢，`correct` 记为 `user@vps`。中继无法事先列出 `origin forget` 将隐藏的内容，所以它会说明按规则将隐藏什么，并照常需要 `--yes`。`entries --history`、`projects`、`forgotten` 和 `restore` 在中继上不可用；请使用中枢的[管理界面](./admin.md)。
- 连不上中枢时，什么也不会发送，新的会话只存在于 Agent 自己的记录文件中。有些 Agent 会删除旧的记录，Claude Code 默认在 30 天后删除（`cleanupPeriodDays`），所以请确保中继定期连上它的中枢；如果上面运行着不使用 Origin 的 Agent，请定时运行 `origin sync`。
- 在那之前，中继会发出警告：尚未发送的会话距离 Claude Code 删除它们的年龄（`~/.claude/settings.json` 中的 `cleanupPeriodDays`，或 30 天）不到一周时，以及其他 Agent 的会话已等待一周仍未发送时，`origin status` 会说明，`origin sync` 在没能发送全部内容时也会说明。连不上中枢期间，Agent 的工具失败时也会提到这一点。

设计细节见[中继](../architecture.md#relays)。

## 接入云端 Agent {#connect-a-cloud-agent}

云端 Agent 没有本地会话记录，所以直接连接中枢。Claude Code 和 Codex 通过你的浏览器用 OAuth 登录：

```bash
# Claude Code：添加中枢，然后在 Claude Code 中用 /mcp 登录，或者在命令行中登录
claude mcp add --scope user --transport http origin https://hub.example.com/mcp
claude mcp login origin

# Codex CLI
codex mcp add origin --url https://hub.example.com/mcp
codex mcp login origin
```

Agent 会在你的浏览器里打开中枢。登录管理界面，然后允许它，并选择它能做什么（读写或只读）以及有效多久（1 到 365 天）。之后它自己保管并续期自己的令牌，并出现在**设备和 Agent**中，你可以随时在那里吊销它；`claude mcp logout origin` 让 Claude Code 退出登录。详见[接入 Agent](./connect-agents.md#using-a-personal-hub)。

不能打开浏览器的 Agent 改用令牌（见[设备和 Agent](#devices-and-agents)）：

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI（从环境变量 ORIGIN_TOKEN 读取令牌）
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

## 追加事件行 {#append-event-lines}

不在你任何设备上运行的程序，例如机器人、云端的 Agent 运行时或流水线，可以把它们的会话以[事件行](./sources.md)带到中枢。为每个程序创建一个它自己的 Agent 令牌，以它命名，然后把它的行提交到 `POST /v1/sources/<name>/lines?path=<path>`：

```bash
origin token create chat-bridge --agent    # 在中枢上执行一次；会打印令牌
curl -sS -X POST "https://hub.example.com/v1/sources/chat-ops/lines?path=incidents.jsonl" \
  -H "Authorization: Bearer ogn_…" -H "Content-Type: application/x-ndjson" \
  --data-binary @incidents.jsonl
```

中枢把这些行追加到来源 `chat-ops` 的文件 `path`，视为令牌名称 `chat-bridge` 发送的内容，像处理设备发来的内容一样归档并解析它们，然后回答它读到多少行、多少事件是新的、多少它已经有了、多少不是有效事件，以及多少因为清除删除了其中的内容而以涂白的形式存储。再次发送同样的行是安全的。一个请求最多包含 8 MiB 的行。见[把行发给你的中枢](./sources.md#send-lines-to-your-hub)。

## 遗忘 {#forgetting}

通过中枢遗忘，效果和单机时一样（见[隐私与数据](./privacy.md#forgetting)），而且会同步到每台设备：每台设备在下一次同步时应用中枢的遗忘记录，本地副本会隐藏同样的条目和事件；而在某台设备上遗忘的内容会到达中枢，再从中枢到达其他每台设备。即使某台设备再次推送，被遗忘的事件也保持隐藏。恢复也以同样的方式传递：在中枢的管理界面中恢复，或者在设备上用 `origin restore` 恢复，每个库都会带回那次遗忘隐藏的内容，无论遗忘和恢复以什么顺序到达。

## 清除 {#purging}

清除会永久删除你选中的内容，并保存一条附有你的原因的记录（见[清除](./cli.md#purging)）。请在中枢的[管理界面](./admin.md)中清除：每台设备在下一次同步时、发送任何内容之前应用这次清除，所以它删除的内容也会从设备的库中删除，而且无论那里的 Agent 记录中还留着什么，都不会再从设备回到中枢。`origin sync` 会说明它应用了多少次清除，`origin purged` 以中枢的 id 列出它们，并附上原因。在设备上用 `origin purge` 做的清除只删除这台设备上的副本：中枢保留它已经收到的内容，所以这个命令会打印一个链接，指向中枢管理界面中的同一次清除。设备和 Agent 的令牌都无法在中枢上清除任何东西；设备的令牌只能读取中枢的清除。清除触及不到备份，也触及不到 Agent 自己的记录文件。

## 在浏览器中管理 {#manage-it-in-a-browser}

中枢可以为你提供一个[管理界面](./admin.md)：设备和存储的概览、你的会话和条目、检索、纠正和遗忘、你的设备和 Agent，以及审计日志。它默认关闭；用 `origin serve --admin`（或 `ORIGIN_ADMIN=on`）启用。第一次登录时，选择你的用户名，并输入中枢第一次启动时打印在日志里的密码，或者你通过 `origin admin password` 或 `ORIGIN_ADMIN_PASSWORD` 设置的密码；此后登录都需要这两项。

## 把原始镜像放进存储桶 {#keep-raw-mirrors-in-a-bucket}

原始镜像占据中枢的大部分空间，而其中已封存的帧（一块块压缩后的行）只写一次，只有清除涂白其中的行时才会改变。中枢可以把它们保存在兼容 S3 的存储桶中，而不是自己的磁盘上，例如你自己运行的 MinIO 服务器上的存储桶。每个镜像最新的若干行（每个文件不到 1 MiB）和数据库仍留在中枢的磁盘上。不配置存储桶时，一切照旧。

用 `origin serve` 的参数或环境变量配置存储桶：

| 变量 | 参数 | 默认值 | 用途 |
|---|---|---|---|
| `ORIGIN_RAW_S3_ENDPOINT` | `--raw-s3-endpoint` | — | 存储服务的地址，例如 `http://minio:9000` |
| `ORIGIN_RAW_S3_BUCKET` | `--raw-s3-bucket` | — | 存储桶 |
| `ORIGIN_RAW_S3_PREFIX` | `--raw-s3-prefix` | 无 | 加在每个键前面；每个中枢请使用各自的前缀 |
| `ORIGIN_RAW_S3_REGION` | `--raw-s3-region` | `us-east-1` | 请求签名所用的区域；MinIO 接受默认值 |
| `ORIGIN_RAW_S3_ADDRESSING` | `--raw-s3-addressing` | `path` | `path` 表示 `<endpoint>/<bucket>/<key>`（MinIO 的默认方式），`virtual` 表示 `<bucket>.<host>/<key>` |
| `ORIGIN_RAW_S3_ACCESS_KEY_ID` | — | — | 访问密钥 ID；或用 `ORIGIN_RAW_S3_ACCESS_KEY_ID_FILE` 指定存放它的文件 |
| `ORIGIN_RAW_S3_SECRET_ACCESS_KEY` | — | — | 私有访问密钥；或用 `ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE` 指定存放它的文件 |
| `ORIGIN_RAW_S3_TIMEOUT_MS` | — | `30000` | 单个请求最长可用的时间 |

密钥只从环境变量或文件读取，从不通过参数传入，所以不会出现在进程列表里，Origin 也从不打印它们。它们需要对该前缀的 `s3:PutObject` 和 `s3:GetObject` 权限，以及对存储桶的 `s3:ListBucket` 权限——没有后者，存储服务会把不存在的对象报告为拒绝访问；Origin 从不列出或删除对象。除非存储桶就在中枢所在的私有网络中，否则请通过 https 访问它：帧里保存着你的会话。

用 Docker：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data \
  -e ORIGIN_RAW_S3_ENDPOINT=http://minio:9000 -e ORIGIN_RAW_S3_BUCKET=origin -e ORIGIN_RAW_S3_PREFIX=hub \
  --env-file origin-s3.env ghcr.io/openlinkos/origin
```

其中 `origin-s3.env` 包含 `ORIGIN_RAW_S3_ACCESS_KEY_ID=…` 和 `ORIGIN_RAW_S3_SECRET_ACCESS_KEY=…`。在 Kubernetes 上，把密钥放在 Secret 中，并以文件形式挂载：

```yaml
# 存储桶的密钥：
apiVersion: v1
kind: Secret
metadata:
  name: origin-raw-s3
stringData:
  access-key-id: origin-hub
  secret-access-key: change-me
---
# 在中枢的 StatefulSet 或 Deployment 中，位于 spec.template.spec 之下：
containers:
  - name: origin
    image: ghcr.io/openlinkos/origin
    env:
      - name: ORIGIN_RAW_S3_ENDPOINT
        value: http://minio.minio.svc.cluster.local:9000
      - name: ORIGIN_RAW_S3_BUCKET
        value: origin
      - name: ORIGIN_RAW_S3_PREFIX
        value: hub
      - name: ORIGIN_RAW_S3_ACCESS_KEY_ID_FILE
        value: /run/secrets/origin-raw-s3/access-key-id
      - name: ORIGIN_RAW_S3_SECRET_ACCESS_KEY_FILE
        value: /run/secrets/origin-raw-s3/secret-access-key
    volumeMounts:
      - name: origin-raw-s3
        mountPath: /run/secrets/origin-raw-s3
        readOnly: true
volumes:
  - name: origin-raw-s3
    secret:
      secretName: origin-raw-s3
```

- **启动。** 中枢写入一个小对象 `<prefix>/.origin-check` 并读回；如果做不到，就拒绝启动。从此以后，库会记住这个存储桶和前缀：没有它们、或换成别的，中枢都会拒绝启动；在中枢上运行的其他命令，例如 `origin backup` 或 `origin show`，通过同样的环境变量访问存储桶。端点可以改变。
- **帧。** 每个新的帧是一个对象 `<prefix>/<mirror>.zst/<offset>`，对象永远不会被删除，只有清除涂白其中的行时才会被重新写入。中枢有存储桶之前封存的帧仍留在它的磁盘上，并从那里读取，直到你把它们移走。在中枢上运行（中枢运行期间也可以）：

  ```bash
  origin raw upload            # 上传并校验这些帧，列出可以删除的 .zst 文件
  origin raw upload --remove   # 同上，然后删除这些文件
  ```

  它可以安全地重复运行：已在存储桶中的帧只会被校验。只有一个文件中的每一帧都已从存储桶读回并核对一致，这个文件才会被删除。它一次传 8 帧，这在慢速或远距离的链路上很重要；`--concurrency <n>`（1 到 64）可以调整。某一帧校验失败时，存放它的文件会被保留，其他帧照常继续；存储桶不再响应时，它会停下，下一次运行从那里接着做。
- **等待存储桶。** 中枢向存储桶发送或从中读取每一帧时都会等待，期间不处理其他任何请求，所以请让存储桶离中枢近一些：在局域网中一帧只需几毫秒。无法连接的存储桶会让每个请求最多等待 `ORIGIN_RAW_S3_TIMEOUT_MS`，需要它的推送在它恢复之前都会失败；不会丢失任何东西，设备会在下一次同步时重新推送。
- **备份。** 在中枢上运行 `origin backup` 会把存储桶中的帧复制进备份，所以恢复备份不需要存储桶（见[备份](./privacy.md#backing-up)）。

设计细节见[架构](../architecture.md#frame-stores)。

## 在 PostgreSQL 上运行中枢 {#run-the-hub-on-postgresql}

中枢默认把数据库放在 SQLite 中，即 `/data/origin.db`；给它一个 PostgreSQL 数据库，它就改用 PostgreSQL。当中枢的数据库超出它的磁盘，或者你本来就在运行并备份 PostgreSQL 时，可以用它。设备总是把库放在 SQLite 中，对设备和你的 Agent 来说一切照旧：它们照常连接中枢，检索也找得到同样的内容。

**数据库。** PostgreSQL 17 或更高版本，数据库的编码为 UTF8、locale 为 C，这样各处比较文本、折叠大小写的方式都一样。以超级用户身份执行：

```sql
CREATE ROLE origin LOGIN PASSWORD 'change-me';
CREATE DATABASE origin OWNER origin TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';
```

其他数据库中枢一概拒绝，并说明如何创建合适的数据库。第一次启动时，它会创建自己的 schema `origin`，并在其中建表；这个角色需要有权在数据库中创建 schema，数据库的所有者就有这个权限。

**URL。** 把 `ORIGIN_DATABASE_URL` 设为 `postgres://user:password@host:5432/database`，或者把 `ORIGIN_DATABASE_URL_FILE` 设为保存它的文件，例如挂载进来的 Secret。参数 `schema` 指定库所在的 schema，默认为 `origin`，这样一个数据库可以容纳多个库；Origin 读取这个参数，URL 的其余部分原样交给驱动。要使用 TLS，加上 `sslmode=verify-full` 和 `sslrootcert=/path/to/ca.pem`，即中枢能读取的 CA 证书。密码从不出现在 Origin 的消息中：`origin status` 和管理界面的概览显示的 URL 都不含密码。

**连接。** 每个 Origin 进程各自持有一个连接：中枢一个，你在中枢所在主机上运行的每个命令各一个。可以直连，也可以经过会话模式的连接池；事务模式的连接池（例如 PgBouncer 的 `pool_mode = transaction`）不能用，因为 Origin 会在自己的连接上保留设置和锁。

**留在 `/data` 中的内容。** 原始镜像 `raw/`（除非它们已封存的帧放在[存储桶](#keep-raw-mirrors-in-a-bucket)中），以及 `store.json`：它把镜像和数据库配成一对，记录这些镜像属于哪个库，以及这个库在 PostgreSQL 中。中枢拒绝在存有另一个库的数据库上启动，也拒绝在 `/data` 已有镜像时新建库；没有 URL 时，它不会在 `/data` 中新建一个空的 SQLite 库，而是提示你设置 URL。请保留 `/data` 卷，并且两者都要备份。

**一个库只由一个中枢服务。** `origin serve` 运行期间持有库上的一把锁，所以同一个库上的第二个中枢，无论在这台机器还是别的机器上，都会拒绝启动。中枢所在主机上的其他命令，例如 `origin token`、`origin admin`、`origin forget` 或 `origin backup`，可以和它同时运行，与 SQLite 时一样。

**不能运行的命令。** PostgreSQL 中的库属于中枢，所以那些处理本机 Agent 的命令在这里拒绝运行，退出码为 2，并说明原因：`origin sync` 和 `origin push`、`origin hub`、`origin mcp`（Agent 使用中枢的 `/mcp`）、`origin ui`（请用 `origin serve --admin`）、`origin agents`、`origin sessions reproject` 和 `origin sessions parents`。Agent 的钩子 `origin sync --hook` 和 `origin recall --hook` 什么也不做并以 0 退出，在标准错误输出上留一行说明。

使用 Docker，把 URL 放在文件中：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data \
  -v /etc/origin/database-url:/run/secrets/database-url:ro \
  -e ORIGIN_DATABASE_URL_FILE=/run/secrets/database-url \
  ghcr.io/openlinkos/origin
```

在 Kubernetes 上，把 URL 放在 Secret 中，并以文件形式挂载：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: origin-database
stringData:
  url: postgres://origin:change-me@postgres.db.svc.cluster.local:5432/origin?sslmode=verify-full&sslrootcert=/run/secrets/origin-database/ca.pem
  ca.pem: |
    -----BEGIN CERTIFICATE-----
    …
---
# In the hub's StatefulSet or Deployment, under spec.template.spec:
containers:
  - name: origin
    image: ghcr.io/openlinkos/origin
    env:
      - name: ORIGIN_DATABASE_URL_FILE
        value: /run/secrets/origin-database/url
    volumeMounts:
      - name: origin-database
        mountPath: /run/secrets/origin-database
        readOnly: true
volumes:
  - name: origin-database
    secret:
      secretName: origin-database
```

- **迁移中枢。** `origin db move` 在中枢停止时把它的库从 SQLite 移到 PostgreSQL，也可以移回来（见[把中枢移到 PostgreSQL](./upgrading.md#move-a-hub-to-postgresql)）。
- **备份。** `origin backup <dir>` 从同一个快照把库导出到 SQLite 数据库 `<dir>/origin.db`，镜像照旧复制（见[备份](./privacy.md#backing-up)）。把它恢复到一个空的 `/data` 中，可以直接在上面启动中枢，也可以用 `origin db move` 再移回 PostgreSQL。数据库的转储（`pg_dump`）加上 `/data` 的副本，只有在两者都是中枢停止期间做的才是一致的，因为中枢运行时会不断改动镜像中最新的几行。

设计细节见[架构](../architecture.md#database-engines)。

## 限制 {#limitations}

- 命令行的管理命令（`entries`、`show`、`correct`、`forget` 等）作用于设备自己的库，之后再同步。要查看和管理所有设备的条目，请通过 Agent 或中枢的[管理界面](./admin.md)。
- 设备不会下载其他设备的数据，所以没有中枢时，它只能回答关于自己的问题。
- 中继没有自己的记忆：连不上中枢时，它的 Agent 既不能读取也不能写入记忆，而尚未发送的内容只存在于 Agent 的记录文件中。
- 中枢只为一个人提供一个库，不支持多用户，不支持多个中枢之间的同步，也不支持不经过中枢的设备间同步。
