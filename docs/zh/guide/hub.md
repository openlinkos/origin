---
sourceHash: sha256-47a1e960
---

# 个人中枢

默认情况下，Origin 只在一台机器上运行：它归档这台机器上的 Agent 会话，也只有这台机器上的 Agent 能访问它。**个人中枢**把你所有机器的会话汇集到一个库里，供你的 Agent 无论在哪里运行都能使用。中枢是自托管、单租户的，只服务一个人以及这个人的设备和 Agent。

## 什么时候需要 {#when-you-need-one}

- 你在多台机器上使用 AI Agent，比如笔记本、台式机和服务器，希望每台机器上的 Agent 都记得在其他机器上发生过的事。
- 你使用云端 Agent，它们本地没有会话记录，但也应该能检索和保存你的记忆。

如果你的 Agent 都在同一台机器上，就不需要中枢。

## 工作方式 {#how-it-works}

- 每台**设备**照旧在本地归档自己的会话，和没有中枢时完全一样，然后运行 `origin sync`。设备接入中枢后，同步还会把本机的原始会话镜像，以及在本机写下的条目和遗忘记录发送到中枢，再取回在中枢或其他设备上被遗忘的内容。
- **中枢**运行 `origin serve`。它用同样的适配器解析推送来的镜像，所以每个回答仍能追溯到原文行；它保存每台设备发来的内容，在那里能找到一切。
- 在设备上，`origin mcp` 仍然根据设备自己的库作答，所以离线时照常可用，同时补充中枢知道的内容：其他设备的会话和条目，以及云端 Agent 写下的条目。云端 Agent 直接连接中枢的 MCP 端点。
- 设备之间从不互相下载数据。从中枢下行的只有遗忘，这样你在任何地方遗忘的内容，在所有地方都会被隐藏。
- 磁盘空间不多的机器可以作为**中继**，而不是完整的设备：它除了游标什么也不保存，直接把 Agent 的记录发送给中枢，并通过中枢回答它的 Agent（见[把设备作为中继运行](#run-a-device-as-a-relay)）。

设计细节见[架构](../architecture.md#personal-hub)。

## 运行中枢 {#run-the-hub}

用 Docker：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

容器内的 `ORIGIN_HOME` 是 `/data`，中枢监听 `0.0.0.0:7077`。请保留 `/data` 卷，整个库都在里面；备份方法见[备份](./privacy.md#backing-up)。

不用 Docker 时，在任何装有 Origin 的机器上（`npm install -g @openlinkos/origin`）：

```bash
origin serve --host 127.0.0.1 --port 7077
```

`GET /healthz` 用于健康检查，不需要鉴权；`POST /mcp` 是 MCP 端点。加上 `--admin` 还会在 `/admin` 下提供[管理界面](./admin.md)。

## 放在 TLS 之后 {#put-it-behind-tls}

中枢使用明文 HTTP。在 localhost 之外开放之前，请把它放在负责 TLS 的反向代理或 CDN 之后，并按以下要求配置代理：

- 把 `/healthz`、`/mcp` 和 `/v1/*` 转发给中枢。
- `/v1/ingest` 用于设备推送会话数据，请求体上限至少设为 16 MiB。
- 不要缓存 `/mcp` 和 `/v1/*`。
- 如果在 `/admin` 下启用了管理界面，还请按[放在 TLS 和 CDN 之后](./admin.md#behind-tls-and-a-cdn)配置；尤其要设置 `ORIGIN_CLIENT_IP_HEADER`，否则任何人的失败登录都会算在你头上。

## 创建令牌 {#create-tokens}

除 `/healthz` 外，每个请求都需要 bearer 令牌。在中枢上为每台设备或每个云端 Agent 各建一个令牌，设备的令牌以设备命名：

```bash
origin token create laptop          # 令牌只显示一次，以 ogn_ 开头
origin token list
origin token revoke laptop
```

使用 Docker 时，通过 `docker exec` 运行同样的命令，例如 `docker exec origin-hub origin token create laptop`。如果启用了[管理界面](./admin.md)，也可以在那里创建和吊销令牌，每个新令牌的接入命令都已准备好，可以直接复制。

令牌名就是设备名：令牌 `laptop` 只能为设备 `laptop` 发送和接收会话、条目和遗忘记录，中枢不接受它代表其他任何设备。所以即使令牌被盗，也无法冒充另一台设备写入。

中枢只保存令牌的哈希，所以请在令牌显示时复制下来。令牌丢失时，请吊销它，再用同一个名称新建一个；设备保留原来的名称，用新令牌重新接入即可。设备退役时，请吊销它的令牌。条目会把 Agent 和设备记为作者，例如 `claude-code@laptop`；直接连接中枢的 Agent 则记为它的令牌名，例如 `ci`。

## 接入设备 {#connect-a-device}

在每台有 Agent 会话记录的机器上：

```bash
origin hub connect https://hub.example.com --token ogn_… --device laptop
origin hub status
origin sync
```

- 中枢以设备的库名称来识别设备：也就是库第一次使用时的 `ORIGIN_DEVICE` 或主机名。这个名称必须与设备的令牌名相同；`origin hub connect` 和 `origin hub status` 会向中枢核对，不一致时拒绝并说明如何解决。`--device` 可以给一个还没有保存过条目、也没有遗忘过任何内容的库改名；此后库会一直保持这个名称，它的令牌也必须以这个名称创建。`origin hub disconnect` 用于断开连接。
- 环境变量 `ORIGIN_HUB_URL`、`ORIGIN_HUB_TOKEN` 会覆盖保存的连接配置。
- `origin sync` 会采集本机会话，发送原始镜像以及在本机写下的条目和遗忘记录，再应用中枢的遗忘记录。可以随时重跑：同步会从上次停下的位置继续。`origin push` 的作用相同。

设备接入后，你已有的 Agent 注册都不用改。`origin mcp` 根据设备的库作答，同时询问中枢，再把两边的回答合并；每条结果都会说明它是在本设备上（`local`）还是在中枢上（`hub`）找到的。如果中枢在 2 秒内（`ORIGIN_HUB_TIMEOUT_MS`）没有回应，Agent 会得到本设备的回答，并附带一条说明：这次没有询问中枢。Agent 保存的内容先落到设备上，并立即同步到中枢；连不上中枢时，则在下一次同步时发送。纠正或遗忘只有中枢才有的内容会在中枢上执行，因此需要能连上中枢。

Agent 运行期间，它的 `origin mcp` 也会在后台同步：记录文件有变化时每分钟一次，Agent 退出时再同步一次，所以设备不需要定时同步。不使用 Origin 的 Agent 的会话，会在下一次有使用 Origin 的 Agent 运行时，或者运行 `origin sync` 时被收取；只有在某台设备上只运行这类 Agent 时，才需要定时运行 `origin sync`（例如用 cron，`*/10 * * * * origin sync`，或 Windows 任务计划程序）。

## 把设备作为中继运行 {#run-a-device-as-a-relay}

设备通常保有一份完整的、属于自己的记忆，其中包括它归档过的每份会话记录的压缩副本。在磁盘空间不多的机器上，例如一台小 VPS，可以改为把它作为**中继**运行：它不保留副本，也不保有自己的记忆，只为每个记录文件保存一个游标，直接从 Agent 自己的记录文件把新的会话发送给中枢。

用 `--relay` 接入一个空库：

```bash
origin hub connect https://hub.example.com --token ogn_… --device vps --relay
origin sync
origin status
```

- 只有还没有保存任何内容的库才能成为中继。如果这台机器上已经有一个保存了会话或条目的库，Origin 会拒绝，并且不做任何改动；请把 `ORIGIN_HOME` 设为一个新目录，再接入那个库。中继会一直是中继；要在这台机器上重新保有完整的库，请再使用一个新的 `ORIGIN_HOME`。
- `origin sync` 把每份会话记录新增的完整行发送给中枢，中枢像收到设备自己的副本一样归档并解析它们；`origin status` 按来源显示还有多少文件和字节尚未发送。和其他设备一样，Agent 的 `origin mcp` 在运行中也会发送新的行。
- Agent 的注册都不用改，但在中继上，`origin mcp` 的每个工具都由中枢作答：它先把刚刚写下的内容发送给中枢，让 Agent 能找到并引用它，再把调用交给中枢。Agent 保存的内容写在中枢上，作者记为 `claude-code@vps`。连不上中枢时，工具会失败，并说明中继离线时无法作答。
- `origin search`、`timeline`、`show`、`entries`、`correct` 和 `forget` 也会询问中枢，`correct` 记为 `user@vps`。中继无法事先列出 `origin forget` 将遗忘的内容，所以它会说明按规则将遗忘什么，并照常需要 `--yes`。`entries --history` 和 `projects` 在中继上不可用；请使用中枢的[管理界面](./admin.md)。
- 连不上中枢时，什么也不会发送，新的会话只存在于 Agent 自己的记录文件中。有些 Agent 会删除旧的记录，Claude Code 默认在 30 天后删除（`cleanupPeriodDays`），所以请确保中继定期连上它的中枢；如果上面运行着不使用 Origin 的 Agent，请定时运行 `origin sync`。

设计细节见[中继](../architecture.md#relays)。

## 接入云端 Agent {#connect-a-cloud-agent}

云端 Agent 没有本地会话记录，所以直接连接中枢，各用自己的令牌：

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI（从环境变量 ORIGIN_TOKEN 读取令牌）
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

## 遗忘 {#forgetting}

通过中枢遗忘，效果和单机时一样（见[隐私与数据](./privacy.md#forgetting)），而且会同步到每台设备：每台设备在下一次同步时应用中枢的遗忘记录，本地副本会隐藏同样的条目和事件；而在某台设备上遗忘的内容会到达中枢，再从中枢到达其他每台设备。即使某台设备再次推送，被遗忘的事件也保持隐藏。

## 在浏览器中管理 {#manage-it-in-a-browser}

中枢可以为你提供一个[管理界面](./admin.md)：设备和存储的概览、你的会话和条目、检索、纠正和遗忘、令牌，以及审计日志。它默认关闭；用 `origin serve --admin`（或 `ORIGIN_ADMIN=on`）启用，并用中枢第一次启动时打印在日志里的密码登录，或者用你通过 `origin admin password` 或 `ORIGIN_ADMIN_PASSWORD` 设置的密码登录。

## 把原始镜像放进存储桶 {#keep-raw-mirrors-in-a-bucket}

原始镜像占据中枢的大部分空间，而其中已封存的帧（一块块压缩后的行）只写一次、永不改变。中枢可以把它们保存在兼容 S3 的存储桶中，而不是自己的磁盘上，例如你自己运行的 MinIO 服务器上的存储桶。每个镜像最新的若干行（每个文件不到 1 MiB）和数据库仍留在中枢的磁盘上。不配置存储桶时，一切照旧。

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
- **帧。** 每个新的帧是一个对象 `<prefix>/<mirror>.zst/<offset>`，对象永远不会被修改或删除。中枢有存储桶之前封存的帧仍留在它的磁盘上，并从那里读取，直到你把它们移走。在中枢上运行（中枢运行期间也可以）：

  ```bash
  origin raw upload            # 上传并校验这些帧，列出可以删除的 .zst 文件
  origin raw upload --remove   # 同上，然后删除这些文件
  ```

  它可以安全地重复运行：已在存储桶中的帧只会被校验。只有一个文件中的每一帧都已从存储桶读回并核对一致，这个文件才会被删除。它一次传 8 帧，这在慢速或远距离的链路上很重要；`--concurrency <n>`（1 到 64）可以调整。某一帧校验失败时，存放它的文件会被保留，其他帧照常继续；存储桶不再响应时，它会停下，下一次运行从那里接着做。
- **等待存储桶。** 中枢向存储桶发送或从中读取每一帧时都会等待，期间不处理其他任何请求，所以请让存储桶离中枢近一些：在局域网中一帧只需几毫秒。无法连接的存储桶会让每个请求最多等待 `ORIGIN_RAW_S3_TIMEOUT_MS`，需要它的推送在它恢复之前都会失败；不会丢失任何东西，设备会在下一次同步时重新推送。
- **备份。** 在中枢上运行 `origin backup` 会把存储桶中的帧复制进备份，所以恢复备份不需要存储桶（见[备份](./privacy.md#backing-up)）。

设计细节见[架构](../architecture.md#frame-stores)。

## 限制 {#limitations}

- 命令行的管理命令（`entries`、`show`、`correct`、`forget` 等）作用于设备自己的库，之后再同步。要查看和管理所有设备的条目，请通过 Agent 或中枢的[管理界面](./admin.md)。
- 设备不会下载其他设备的数据，所以没有中枢时，它只能回答关于自己的问题。
- 中继没有自己的记忆：连不上中枢时，它的 Agent 既不能读取也不能写入记忆，而尚未发送的内容只存在于 Agent 的记录文件中。
- 中枢只为一个人提供一个库，不支持多用户，不支持多个中枢之间的同步，也不支持不经过中枢的设备间同步。
