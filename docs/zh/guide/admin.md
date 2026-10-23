---
sourceHash: sha256-a66647ef
---

# 管理界面

[个人中枢](./hub.md)可以为你——它的主人——提供一个 Web 界面。在浏览器里，你可以查看各台设备推送了什么，浏览和检索你的会话，管理条目，遗忘不该保留的内容，以及管理中枢的令牌。管理界面默认关闭。它只供一个人使用：没有公开页面，没有分享，也没有其他账户。

## 能做什么 {#what-you-can-do}

- **概览**：事件、会话、条目、设备、令牌和遗忘记录的数量；每台设备最近一次发送数据的时间（超过 24 小时会被标出）；存储用量和可用磁盘空间；最近 24 小时和 7 天的解析错误；版本和运行时长。
- **令牌**：为设备（以设备命名，因为设备的令牌只对这台设备有效）或云端 Agent 创建令牌。令牌只显示一次，旁边附有可直接粘贴的命令：`origin hub connect`、Claude Code、Codex，以及定时同步；也可以吊销令牌。
- **设备**及每台设备推送过的文件；以及一个**接入**页面，列出接入新设备或新 Agent 的命令。
- **时间线和会话**：所有会话，以及单个会话按顺序排列的事件。工具调用和结果默认隐藏，需要时可以显示。
- **事件**及其溯源：设备、原始文件、代次和镜像行。原始记录行只在你要求时才显示，并截断到 4,000 个字符。
- **检索**：同时检索条目和事件。
- **条目**：浏览条目及其来源和版本历史（每个版本写入于哪里，以及哪些版本输给了并发纠正）；**纠正**条目（新版本取代它，旧版本留在历史中）；在事件页面上**记住**一个新条目，并引用该事件。你写入的条目作者记为 `user@hub`（`user@` 加中枢的名称），就像 `origin correct` 记为 `user@` 加设备的名称一样。
- **遗忘**条目或事件：界面会先准确列出将被遗忘的条目和事件，你需要输入 id 来确认。遗忘的效果和其他地方完全一样（见[隐私与数据](./privacy.md#forgetting)），并会在每台设备下一次同步时同步过去。
- **遗忘记录**、**审计日志**，以及你当前打开的**登录会话**。

管理界面提供英文和简体中文，默认跟随浏览器的语言，也跟随系统的浅色或深色模式。两者都可以在侧边栏底部切换，登录页则在表单下方切换。

## 启用 {#enable-it}

有两种提供方式：

```bash
# 挂在中枢自己端口的 /admin 下，与中枢共用同一个 TLS 代理
origin serve --host 127.0.0.1 --port 7077 --admin --public-url https://hub.example.com

# 挂在一个单独的私有监听地址上，通过 SSH 隧道或端口转发访问
origin serve --host 0.0.0.0 --port 7077 --admin-listen 127.0.0.1:7078
```

如果管理界面可能被其他机器通过明文 HTTP 访问，中枢会拒绝启动。当界面监听的不是回环地址时，`--public-url` 必须是中枢前面那个 TLS 代理的 `https://` 地址；或者，在端口只发布到 `127.0.0.1` 时，可以是回环主机上的 `http://` 地址，例如 `http://localhost:7077`。不设置 `--public-url` 时，界面只响应经回环地址到达的请求，例如通过隧道来的请求。

使用 Docker 时，用环境变量：

```bash
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data \
  -e ORIGIN_ADMIN=on -e ORIGIN_PUBLIC_URL=https://hub.example.com \
  ghcr.io/openlinkos/origin
```

| 变量 | 用途 |
|---|---|
| `ORIGIN_ADMIN` | 设为 `on` 时，在中枢端口的 `/admin` 下提供管理界面，等同于 `--admin` |
| `ORIGIN_ADMIN_LISTEN` | 管理界面单独监听的 `host:port`，等同于 `--admin-listen` |
| `ORIGIN_PUBLIC_URL` | 中枢的公开 URL，等同于 `--public-url`；界面里的命令把它当作中枢的地址 |
| `ORIGIN_CLIENT_IP_HEADER` | 由你的代理设置、携带客户端地址的请求头，例如 `X-Real-IP`；只有设置了才会被信任，在代理或 CDN 之后必须设置（见[下文](#behind-tls-and-a-cdn)） |
| `ORIGIN_ADMIN_PASSWORD` | 管理密码，至少 10 个字符；设置后取代保存在中枢上的密码（见[登录](#sign-in)） |

命令行参数优先于环境变量。在中枢的 `/admin` 下提供和单独监听，二者只能选一种。

## 登录 {#sign-in}

每个中枢只有一个管理密码，没有用户名。管理界面没有初始设置页面，所以新建的中枢不会被第一个访问到它的人占用。取而代之的是：中枢第一次在启用管理界面的情况下启动时，会生成一个密码并打印到它的日志中，只打印这一次：

```text
Generated an admin password for the admin UI (shown only this once):

    abcde-fghjk-mnpqr-stvwx

Sign in with it, then set your own with: origin admin password
```

使用 Docker 时，用 `docker logs origin-hub` 查看。打开 `https://hub.example.com/admin/`，用它登录，然后在中枢上设置你自己的密码：

```bash
origin admin password                               # 询问两次，不显示你输入的内容
docker exec -it origin-hub origin admin password    # 使用 Docker 时的相同操作
origin admin password --generate                    # 或者随机生成一个，只打印一次
```

密码至少需要 10 个字符。新密码会立即取代旧密码，并让所有会话退出登录；不需要重启任何东西。忘记密码时，也运行同一个命令。没有终端时，这个命令从标准输入的第一行读取密码，方便脚本通过管道传入，例如 `docker exec -i origin-hub origin admin password < password.txt`。登录表单把它作为一个固定用户名的密码提交，所以浏览器自带的密码管理器可以保存它。

如果想把密码放在部署配置里，例如 Docker Compose 文件或 Kubernetes Secret，请设置 `ORIGIN_ADMIN_PASSWORD`。设置后，它就是管理密码，保存在中枢上的密码会被忽略。它至少要有 10 个字符，否则中枢拒绝启动。要修改它，用新的值重启中枢：中枢会发现变化，并让所有会话退出登录。`origin admin password` 发现这个变量时会提醒你，因为只要这个变量存在，它保存的密码就不起作用。

中枢只在自己的数据库里保存密码的 scrypt 哈希，也从不把它发送给设备。管理密码与设备和 Agent 的令牌是分开的：令牌（`ogn_…`）永远不能登录管理界面，管理密码也永远不能用于 MCP 或推送。

```bash
origin admin sessions               # 打开的会话：登录时间、最近活动、客户端
origin admin sessions --revoke-all  # 在所有地方退出登录
origin admin audit --limit 50       # 最近的管理操作
```

会话在 30 分钟无活动或登录满 12 小时后结束。创建或吊销令牌、遗忘、让其他会话退出登录时，如果你在最近 10 分钟内没有输入过密码，界面会要求你再输入一次。

## 放在 TLS 和 CDN 之后 {#behind-tls-and-a-cdn}

如果你通过与中枢相同的反向代理或 CDN 访问管理界面，请按中枢的要求配置它（见[放在 TLS 之后](./hub.md#put-it-behind-tls)），并且：

- 把 `/admin` 和 `/admin/*` 原样转发给中枢：不要改写路径，保留 `Host`、`Origin` 和 `Cookie` 请求头，以及 `Set-Cookie` 响应头。
- 对 `/admin` 和 `/admin/*` 跳过缓存。中枢的每个响应都标有 `Cache-Control: no-store, private`，但有些 CDN 会按规则无视它继续缓存。
- 不要在 `/admin*` 上注入脚本、改写 HTML 或加入统计代码：界面的 Content-Security-Policy 会阻止它们。
- 用 `--public-url` 传入你在浏览器中打开的地址。每一次表单提交都会对照它检查。
- 把 `ORIGIN_CLIENT_IP_HEADER` 设为代理用来传递真实客户端地址的请求头，例如 `X-Real-IP`，这样登录次数限制和审计日志看到的才是真实地址。不设置时，所有请求看起来都来自代理，所有失败的登录共用同一个限额：任何人只要猜错 10 次，就能把你锁在外面 10 分钟。只有当中枢除了经过这个代理之外无法被访问时才设置它，否则任何人都可以伪造这个请求头。

CDN 会终止 TLS，因此它能看到解密后的流量，包括管理界面展示给你的会话内容。如果你在意这一点，请优先使用私有访问。

## 私有访问 {#private-access}

管理界面完全不必公开。让它监听回环地址，再通过隧道访问：

```bash
# 在中枢上
origin serve --host 0.0.0.0 --port 7077 --admin-listen 127.0.0.1:7078

# 在你的电脑上使用 SSH；然后打开 http://localhost:7078/admin/
ssh -N -L 7078:127.0.0.1:7078 you@hub-host

# 或者使用 Kubernetes；然后打开 http://localhost:7078/admin/
kubectl port-forward deploy/origin-hub 7078:7078
```

经由回环地址访问时，界面可以使用明文 HTTP，会话 cookie 限定在 `/admin` 路径下。使用 Docker 时，也可以只把中枢的端口发布到回环地址上，并把这个地址声明为公开 URL：

```bash
docker run -d --name origin-hub -p 127.0.0.1:7077:7077 -v origin-data:/data \
  -e ORIGIN_ADMIN=on -e ORIGIN_PUBLIC_URL=http://localhost:7077 \
  ghcr.io/openlinkos/origin
```

## 安全 {#security}

- **数据不外流。** 管理界面不从其他网站加载任何东西，除了访问中枢本身之外也不发起任何请求。它通过与 CLI 和 MCP 相同的操作读写数据，因此溯源和遗忘粘性依然成立。
- **它永远不做的事。** 它不能编辑或删除事件、原始镜像、条目或遗忘记录，不能撤销遗忘，也从不显示任何被遗忘内容的文本：遗忘记录只保留目标 id、你填写的原因（如果有）和被移除内容的 id，审计日志只保留 id 和数量。它不能再次显示令牌，不能修改管理密码，也不能修改自己的安全设置。这些都只能在中枢的命令行上进行。
- **密码。** 中枢只保存它的 scrypt 哈希（N = 2^15、r = 8、p = 3，带随机盐），每次只校验一个尝试，并以恒定时间比较。
- **请求。** 每一次修改都是一次表单提交，必须带有会话的防伪令牌，并且来自中枢自己的地址；跨站请求会被拒绝。同一个客户端在 10 分钟内登录失败 10 次（所有客户端合计 100 次）后，登录会暂停，界面会告诉你何时可以重试。在代理或 CDN 之后，这需要设置 `ORIGIN_CLIENT_IP_HEADER`（见[放在 TLS 和 CDN 之后](#behind-tls-and-a-cdn)）。
- **页面。** 显示的所有内容都经过转义，所以包含 HTML 或脚本的会话记录只会以文本形式显示。每个响应都禁止内联脚本、被嵌入、缓存和被搜索引擎收录。
- **审计日志。** 登录、失败的尝试、令牌变更、写入的条目、遗忘操作和被结束的会话，都会连同时间、客户端地址和浏览器的 user agent 一起记录下来。用 CLI 进行的令牌和密码变更，以及中枢启动时生成的密码或发现的密码变化，也会被记录，但从不记录密码本身。这个日志只增不减；可以在界面中或用 `origin admin audit` 查看。

请按[安全策略](https://github.com/openlinkos/origin/blob/master/SECURITY.md)私下报告安全问题。
