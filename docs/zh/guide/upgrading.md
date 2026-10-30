---
sourceHash: sha256-0c895981
---

# 升级

Origin 的五个 npm 包和中枢的容器镜像使用同一个版本号一起发布。本页说明版本号意味着什么、如何升级设备和中枢，以及升级时你的库会发生什么。每个版本具体改了什么，见[更新日志](../changelog.md)。

## 版本 {#versions}

Origin 遵循[语义化版本](https://semver.org/lang/zh-CN/)。在 1.0 之前：

- **次版本**（0.2、0.3……）可能改变存储格式、CLI、MCP 工具或中枢的 API。它在更新日志中的那一节以一段**升级**说明开头，写明需要做什么（如果需要的话）。
- **修订版本**（0.3.1……）只修复问题，从不改变存储格式。
- 要安装的包是 `@openlinkos/origin`，它会带上同一版本的另外四个包（`-core`、`-adapters`、`-mcp`、`-admin`）。在 1.0 之前，这四个包的 API 属于内部接口，任何版本都可能改变。

每个版本都由 GitHub Actions 从标签构建并发布，从不在个人电脑上发布；npm 包带有来源证明（provenance），镜像带有来源证明和 SBOM 证明（见[验证发布](#verify-a-release)）。

查看你运行的版本：

```bash
origin --version
curl -s https://hub.example.com/healthz     # a hub: {"ok":true,"version":"…"}
```

## 升级设备 {#upgrade-a-device}

```bash
npm install -g @openlinkos/origin@latest
origin --version
origin status          # opens the store, upgrading it if needed
```

然后重启你的 Agent 或它们的会话，让每个 Agent 都启动新的 `origin mcp`。已经在运行的 `origin mcp` 会一直保持它启动时的版本，直到它的 Agent 重启。

Origin 需要 Node.js 22.16 或更高版本；某个版本可能提高这个最低要求，会在它的升级说明里写明。

## 升级中枢 {#upgrade-a-hub}

中枢的镜像是 `ghcr.io/openlinkos/origin`，有以下标签：

| 标签 | 指向 |
|---|---|
| `0.4.0` | 这个版本本身，不会变化 |
| `0.4` | 0.4 的最新修订版本 |
| `latest` | 最新发布的版本 |
| `edge` | `master` 上最新的提交，尚未发布 |

请固定一个次版本，比如 `0.4`，在你决定升级时再改它；`latest` 会在新的次版本发布后立刻指向它，而新的次版本可能会升级你的库。升级用 Docker 运行的中枢：

```bash
docker pull ghcr.io/openlinkos/origin:0.4
docker rm -f origin-hub
docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin:0.4
docker logs origin-hub     # shows the upgrade of the store, if any
```

保留同一个 `/data` 卷和同样的环境变量（管理界面、存储桶、客户端 IP 请求头）。用 npm 安装的中枢，升级方式与设备相同，之后重启 `origin serve`。

**先升级中枢，再升级它的设备。** 较新的设备可能发送较旧的中枢还读不懂的内容，比如 0.3 新增的记忆流：中枢会保存它们，并在升级之后读取，但在此之前，对它尚未读取的内容所做的纠正要等待它。0.3 的中枢不接收 0.4 新增的召回记录，设备会保留它们，直到中枢升级。较新版本的中枢可以正常服务较旧版本的设备。

## 你的库 {#your-store}

库会记录它的格式版本。较新的 Origin 打开较旧的库时，会先就地升级它，只升级一次，再做其他事；升级后的第一条命令，或者启动时的中枢，会打印它做了什么。每一步都在单独的事务中执行，所以中断的升级可以放心地再运行一次。升级从不重写原始镜像或事件，也从不让你遗忘的内容回来。

| 版本 | 存储格式 | 升级做了什么 |
|---|---|---|
| 0.1.0 | 1 | — |
| 0.2.0 | 3 | 记录格式版本；记录会话名称是否由用户设定；从已归档的行中读取 Claude Code 会话的标题 |
| 0.3.0 | 4 | 读取中枢在能读懂记忆流之前归档的记忆流（见[原生记忆](../sources.md#native-memories)） |
| 0.4.0 | 4 | 新增召回记录的表；格式和已存的内容都不变 |

格式 2 和 3 都是 0.2.0 引入的。每一步的细节见[架构](../architecture.md#migrations)。

- **先备份。** 升级是谨慎的，而备份只需一条命令：`origin backup <dir>`（见[备份](./privacy.md#backing-up)）。在中枢上，请在替换容器之前在容器内运行，比如 `docker exec origin-hub origin backup /data/backup-0.2`。
- **不能降级。** Origin 发现库的格式比自己新时，会拒绝打开并提示升级，不做任何改动。要回到旧版本，请恢复升级前做的备份；在那之后写入的内容会丢失。
- **多个进程。** 如果有多个进程同时打开库，比如 CLI 和多个 Agent 的 MCP 服务器，由其中一个执行升级，其他进程等待它完成，最多等五分钟。

## 验证发布 {#verify-a-release}

npm 包带有来源证明，把每个包和构建它的 GitHub Actions 运行关联起来：

```bash
npm audit signatures            # in a project that depends on @openlinkos/origin
npm view @openlinkos/origin@0.4.0 dist.attestations
```

镜像在构建时附带了来源证明和 SBOM：

```bash
docker buildx imagetools inspect ghcr.io/openlinkos/origin:0.4.0 --format '{{json .Provenance}}'
```

每个版本在 [GitHub](https://github.com/openlinkos/origin/releases) 上也有一个发布页，附有更新日志中的说明。
