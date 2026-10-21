---
sourceHash: sha256-ab6a3312
---

# 命令参考

```text
origin sync      [--source <id>] [--verbose]          采集本机 Agent 会话（幂等，可随时重跑）
origin status                                          各来源统计、条目数与上次采集时间
origin timeline  [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50]
origin timeline  --session <id> [--all]                单个会话的事件（默认不含工具事件）
origin search    <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]
origin show      <id>                                  显示条目或事件，以及它的原始来源
origin entries   [--kind <kind>] [--project <name>] [--history] [--limit 50]
origin correct   <entry-id> <text> [--kind <kind>] [--confidence <0-1>]
origin forget    <id> [--reason <text>] [--yes]        永久遗忘条目或事件（需加 --yes 确认）
origin projects                                        已知的项目名
origin mcp                                             以 stdio 运行 MCP server（接入中枢后转发到中枢）

origin serve     [--host 127.0.0.1] [--port 7077]      把本库作为个人中枢运行（MCP over HTTP）
                 [--admin | --admin-listen <host:port>] [--public-url <url>]   同时提供管理界面
origin token     create <name> | list | revoke <name>  管理中枢的访问令牌（在中枢上运行）
origin admin     key create <name> | key list | key revoke <name>   管理管理界面的登录密钥（在中枢上运行）
origin admin     sessions [--revoke-all] | audit [--limit 50]       管理界面的会话与审计日志
origin hub       connect <url> --token <token> [--device <name>] | status | disconnect
origin push                                            本地同步、推送原始镜像到中枢、取回遗忘记录
```

- **时间参数**：相对时长（`30m`、`24h`、`7d`、`2w`）或日期（`YYYY-MM-DD`、ISO 8601）。
- **来源 id**：`claude-code` 与 `codex`（`cursor`、`zcode`、`grok` 将随适配器上线）。
- **条目类型**：`memory`（发生过什么）、`knowledge`（稳定的事实）、`cognition`（你的偏好、方法、目标与边界）。
- **id 形式**：条目如 `ent_5f0c2a9e41b7`；事件如 `claude-code:<uuid>` 或 `codex:<session>:o12`。
- CLI 输出为英文。

## 检索 {#searching}

`search` 同时检索条目和会话消息，默认按相关度排序。加 `--recent` 改为按时间排序，加 `--all` 会把工具调用及其输出也纳入检索。中文同样支持子串检索。

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

`show` 显示条目及其来源与版本历史；对事件则显示原始定位：原文件、镜像文件与行号，以及原文行。

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

## 个人中枢 {#personal-hub}

这些命令用于运行[个人中枢](./hub.md)，以及把设备接入中枢。

- 在中枢上，`origin serve` 提供 `POST /mcp` 和复制接口，`GET /healthz` 用于健康检查，不需要鉴权。`origin token create <name>` 会打印一个新令牌，只显示一次（以 `ogn_` 开头）；中枢只保存令牌的哈希。
- 在设备上，`origin hub connect` 保存中枢地址、令牌和设备名（默认为主机名）。`origin push` 可以随时重跑，每次推送都会从上次停下的位置继续。
- 设备接入后，`origin mcp` 会先推送新的会话记录，再把每次工具调用转发给中枢。
- 管理命令（`entries`、`show`、`correct`、`forget` 等）作用于它们所运行的那个库。在已接入的设备上，那就是本地暂存副本。
- `origin serve --admin` 会同时在 `/admin` 下提供[管理界面](./admin.md)；`--admin-listen <host:port>` 则改为在单独的监听地址上提供。在 TLS 之后时，用 `--public-url` 传入中枢的 https 地址；中枢拒绝在回环地址之外通过明文 HTTP 提供管理界面。
- `origin admin key create <name>` 只打印一次管理密钥（前缀 `oga_`），用它登录管理界面。`origin admin sessions --revoke-all` 让所有会话退出登录，`origin admin audit` 打印审计日志。用 CLI 进行的令牌和管理密钥变更也会记录在其中。

## 环境变量 {#environment-variables}

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ORIGIN_HOME` | `~/.origin` | Origin 的数据库与原始镜像目录 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置目录（会话从 `<dir>/projects` 读取） |
| `ORIGIN_CLAUDE_PROJECTS` | — | 直接指定 Claude Code 的 projects 目录 |
| `CODEX_HOME` | `~/.codex` | Codex 的主目录（从 `sessions/` 与 `archived_sessions/` 读取会话） |
| `ORIGIN_HUB_URL` | — | 中枢地址，覆盖 `origin hub connect` 的配置 |
| `ORIGIN_HUB_TOKEN` | — | 中枢令牌，覆盖 `origin hub connect` 的配置 |
| `ORIGIN_DEVICE` | 主机名 | 本设备在中枢上的名称 |
| `ORIGIN_ADMIN` | `off` | 设为 `on` 时在 `/admin` 下提供管理界面（`origin serve --admin`） |
| `ORIGIN_ADMIN_LISTEN` | — | 改为在这个 `host:port` 上提供管理界面（`--admin-listen`） |
| `ORIGIN_PUBLIC_URL` | — | 中枢的公开 https URL（`--public-url`） |
| `ORIGIN_CLIENT_IP_HEADER` | — | 由你的代理设置、携带客户端地址的请求头；只有设置了才会被信任 |
| `ORIGIN_ADMIN_KEY_SHA256` | — | 保存在数据库之外的管理密钥的 SHA-256 哈希，以逗号分隔 |
