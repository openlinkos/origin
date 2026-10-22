---
sourceHash: sha256-4f5094bb
---

# 个人中枢

默认情况下，Origin 只在一台机器上运行：它归档这台机器上的 Agent 会话，也只有这台机器上的 Agent 能访问它。**个人中枢**把你所有机器的会话汇集到一个库里，供你的 Agent 无论在哪里运行都能使用。中枢是自托管、单租户的，只服务一个人以及这个人的设备和 Agent。

## 什么时候需要 {#when-you-need-one}

- 你在多台机器上使用 AI Agent，比如笔记本、台式机和服务器，希望每台机器上的 Agent 都记得在其他机器上发生过的事。
- 你使用云端 Agent，它们本地没有会话记录，但也应该能检索和保存你的记忆。

如果你的 Agent 都在同一台机器上，就不需要中枢。

## 工作方式 {#how-it-works}

- 每台**设备**照旧在本地归档自己的会话，和没有中枢时完全一样，然后运行 `origin push`：把本机的原始会话镜像推送到中枢，再取回中枢上的遗忘记录。
- **中枢**运行 `origin serve`。它用同样的适配器解析推送来的镜像，所以每个回答仍能追溯到原文行；你的 Agent 访问的就是这个库。
- 在设备上，`origin mcp` 用法不变，只是每次调用前先推送新内容，再把调用转发给中枢。云端 Agent 直接连接中枢的 MCP 端点。

设计细节见[架构](../architecture.md#personal-hub)。

## 运行中枢 {#run-the-hub}

用 Docker：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
curl http://localhost:7077/healthz
```

容器内的 `ORIGIN_HOME` 是 `/data`，中枢监听 `0.0.0.0:7077`。请保留 `/data` 卷，整个库都在里面。

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

除 `/healthz` 外，每个请求都需要 bearer 令牌。在中枢上为每台设备或每个云端 Agent 各建一个令牌：

```bash
origin token create laptop          # 令牌只显示一次，以 ogn_ 开头
origin token list
origin token revoke laptop
```

使用 Docker 时，通过 `docker exec` 运行同样的命令，例如 `docker exec origin-hub origin token create laptop`。如果启用了[管理界面](./admin.md)，也可以在那里创建和吊销令牌，每个新令牌的接入命令都已准备好，可以直接复制。

中枢只保存令牌的哈希，所以请在令牌显示时复制下来。令牌丢失或设备退役时，请吊销对应的令牌。Agent 通过中枢保存的条目，会把 Agent 和令牌名一起记为作者，例如 `claude-code@laptop`。

## 接入设备 {#connect-a-device}

在每台有 Agent 会话记录的机器上：

```bash
origin hub connect https://hub.example.com --token ogn_… --device laptop
origin hub status
origin push
```

- 中枢以设备的库名称来识别设备：也就是库第一次使用时的 `ORIGIN_DEVICE` 或主机名。`--device` 可以给一个还没有保存过条目、也没有遗忘过任何内容的库改名；此后库会一直保持这个名称。`origin hub disconnect` 用于断开连接。
- 环境变量 `ORIGIN_HUB_URL`、`ORIGIN_HUB_TOKEN` 会覆盖保存的连接配置。
- `origin push` 会先同步本机会话，再推送原始镜像，最后取回中枢的遗忘记录。可以随时重跑：推送会从上次停下的位置继续。

设备接入后，`origin mcp` 会转发到中枢，所以你已有的 Agent 注册都不用改。每次 Agent 调用前都会先推送新的会话记录：读取类调用最多每 10 秒推送一次，`remember` 和 `correct` 之前则总会推送。因此 Agent 仍能引用你刚刚说过的话。

只有 Agent 被调用时才会推送。如果某台设备上的 Agent 闲置，又想让中枢保持最新，可以定时运行 `origin push`，例如用 cron（`*/10 * * * * origin push`）或 Windows 任务计划程序。

## 接入云端 Agent {#connect-a-cloud-agent}

云端 Agent 没有本地会话记录，所以直接连接中枢，各用自己的令牌：

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI（从环境变量 ORIGIN_TOKEN 读取令牌）
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

## 遗忘 {#forgetting}

通过中枢遗忘，效果和单机时一样（见[隐私与数据](./privacy.md#forgetting)），而且会同步到每台设备：每台设备在下一次推送时应用中枢的遗忘记录，本地暂存副本会隐藏同样的条目和事件。即使某台设备再次推送，被遗忘的事件也保持隐藏。

## 在浏览器中管理 {#manage-it-in-a-browser}

中枢可以为你提供一个[管理界面](./admin.md)：设备和存储的概览、你的会话和条目、检索、纠正和遗忘、令牌，以及审计日志。它默认关闭；用 `origin serve --admin`（或 `ORIGIN_ADMIN=on`）启用，并用中枢第一次启动时打印在日志里的密码登录，或者用你通过 `origin admin password` 或 `ORIGIN_ADMIN_PASSWORD` 设置的密码登录。

## 限制 {#limitations}

- 命令行的管理命令（`entries`、`show`、`correct`、`forget` 等）作用于它们所运行的那个库。在已接入的设备上，那就是本地暂存副本。请通过 Agent、在中枢的[管理界面](./admin.md)中，或在中枢上运行 CLI（`docker exec origin-hub origin …`）来管理记忆。从设备的 CLI 管理中枢已在计划中。
- 设备接入中枢之前保存的条目，会留在该设备的本地库里，不会迁移到中枢。
- 中枢只为一个人提供一个库，不支持多用户，也不支持多个中枢之间的双向同步。
