---
sourceHash: sha256-eda32189
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

设计细节见[架构](../architecture.md#personal-hub)。

## 运行中枢 {#run-the-hub}

用 Docker：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

容器内的 `ORIGIN_HOME` 是 `/data`，中枢监听 `0.0.0.0:7077`。请保留 `/data` 卷，整个库都在里面；备份方法见[备份](./privacy.md#backing-up)。

从源码运行，在任何装有 Origin 的机器上：

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

只有 Agent 被调用时才会同步。如果某台设备上的 Agent 闲置，又想让中枢保持最新，可以定时运行 `origin sync`，例如用 cron（`*/10 * * * * origin sync`）或 Windows 任务计划程序。

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

## 限制 {#limitations}

- 命令行的管理命令（`entries`、`show`、`correct`、`forget` 等）作用于设备自己的库，之后再同步。要查看和管理所有设备的条目，请通过 Agent 或中枢的[管理界面](./admin.md)。
- 设备不会下载其他设备的数据，所以没有中枢时，它只能回答关于自己的问题。
- 中枢只为一个人提供一个库，不支持多用户，不支持多个中枢之间的同步，也不支持不经过中枢的设备间同步。
