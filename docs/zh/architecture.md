---
sourceHash: sha256-ddf9cd6e
---

# 架构

本文描述 Origin 当前的设计：它要解决的问题、数据模型、每一处改动都必须保持的不变量，以及采集、条目、检索、MCP server 和个人中枢的工作方式。它是贡献者的参考文档；如果某项改动改变了数据模型、某条不变量或某个公共接口，请在同一个提交中更新本文档。

## 目录 {#contents}

- [问题](#problem)
- [范围](#scope)
- [记忆、知识与认知](#memory-knowledge-and-cognition)
- [核心对象](#core-objects)
- [数据流](#data-flow)
- [不变量](#invariants)
- [设计原则](#design-principles)
- [包](#packages)
- [存储](#storage)
- [采集](#ingestion)
- [条目](#entries)
- [遗忘](#forgetting)
- [检索与时间线](#search-and-timeline)
- [MCP server](#mcp-server)
- [个人中枢](#personal-hub)
- [待解决的问题](#open-questions)
- [相关工作](#prior-art)

## 问题 {#problem}

开发者越来越多地同时使用多个 AI Agent：Claude Code、Codex、Cursor、ZCode、Grok Build。每个 Agent 都有自己的记忆，范围限定在一个仓库、一台机器或一个云端账户。换一个工具或项目，就得从零开始。这些记忆难以查看，难以纠正，其他 Agent 看不到，还常常被悄悄清除（例如 Claude Code 默认在 30 天后删除本地会话记录）。

与此同时，这些 Agent 都会把纯文本、可解析的会话记录写到本地磁盘，也都能与本地的 [MCP](https://modelcontextprotocol.io) server 通信。Origin 正是建立在这两点之上：它把本机所有 Agent 会话归档进同一个本地库，再通过同一个 MCP server 把这个库提供给每个 Agent。

长远的方向，是一个长期陪伴一个人的 AI：记忆、知识以及对这个人的理解，都能跨越工具和模型代际延续下去。Origin 从这个核心做起。

## 范围 {#scope}

**当前目标——一份通过 MCP 提供的跨 Agent 个人记忆：**

- 把 Claude Code、Codex、Cursor、ZCode、Grok Build 的本地会话归档进同一个只追加的库。
- 让任何 Agent 都能通过 MCP 检索归档、浏览时间线、把任何回答展开到它的原始来源，并记录持久的条目（记忆 / 知识 / 认知）。
- 让人通过 `origin` CLI 或自己中枢的管理界面查看、纠正和遗忘条目；遗忘必须持久生效。
- 一个人常常在多台机器上运行 Agent（笔记本、服务器、云端 Agent）。可选的自托管**个人中枢**把每台设备的会话汇集到一个库中，并为任何地方的 Agent 提供服务。

达成目标的标志是：在你任何一台机器上，从任何一个已接入的 Agent 问“上周在项目 X 里我决定了什么，为什么？”，都能得到附带来源的回答，而且被遗忘的条目永远不会再回来。

**目前明确不做：** 多租户托管（Origin 只服务一个人，每个人运行自己的一份）、由本项目运营的托管服务、端到端加密、副本之间的双向同步、自己中枢上供主人使用的管理界面之外的任何 Web 界面（没有公开页面、没有分享、没有多账户）、屏幕 / 邮件 / 浏览器采集、知识图谱、向量检索、主动提醒，以及任何对模型 API 的调用。

## 记忆、知识与认知 {#memory-knowledge-and-cognition}

Origin 区分三类持久条目。每个条目都带有自己的来源，并且可以被纠正或遗忘。

| 类型 | 含义 | 示例 |
|---|---|---|
| `memory` | 发生过什么（情景记忆） | “10 月 20 日，为了保持代码简单，我们决定在首个版本发布前不做 schema 版本管理。” |
| `knowledge` | 稳定的事实与关系 | “项目 A 依赖库 B。” |
| `cognition` | 关于这个人的模型：偏好、方法、目标、边界 | “偏好不带署名 trailer 的提交信息。” |

## 核心对象 {#core-objects}

| 对象 | 含义 | 关键字段 |
|---|---|---|
| **Source**（来源） | 某个 Agent 的适配器：`claude-code`、`codex`、`cursor`、`zcode`、`grok` | id、Agent 版本、发现根目录 |
| **Raw**（原始镜像） | 原始记录文件的只追加镜像 | 来源、原始路径、代次、字节 / 行游标、尾部哈希 |
| **Event**（事件） | 规范化后的对话事件：用户消息、助手消息、工具调用、工具结果 | id、来源、会话、时间戳、项目、cwd、git 分支、角色、类型、正文、原始定位 |
| **Entry**（条目） | 一条持久的 `memory` / `knowledge` / `cognition` 陈述 | id（`ent_…`）、类型、正文、置信度、作者、项目、来源（事件 id + 引文）、supersedes、valid_from / valid_to、created_at；状态（`active` / `superseded` / `forgotten`）由推导得出，从不存储 |
| **Tombstone**（遗忘记录） | 一次遗忘操作的记录 | 目标 id、原因、时间；它遗忘的条目和它排除的事件 |

## 数据流 {#data-flow}

```
agent session logs on disk ──scan──▶ Raw (append-only mirror)
                                        │ deterministic adapter parsing (no LLM)
                                        ▼
                                  Event store (SQLite + FTS5) ◀── Entries · Tombstones
                                        │
 agents ◀── MCP (stdio): search · timeline · get · sources · remember · correct · forget
 people ◀── CLI `origin`: sync · status · timeline · search · show · entries · correct · forget
 people ◀── admin UI (hub, /admin): overview · timeline · search · entries · remember · correct · forget · tokens
```

使用个人中枢时，每台设备照常在本地采集，并把原始镜像复制到中枢，由中枢用同样的适配器解析。Agent 通过所在设备上的本地 `origin mcp`（它会转发给中枢）访问中枢；云端 Agent 则通过中枢的 HTTP 端点访问：

```
device A: logs ─▶ local store ──push raw mirrors──▶ ┐
device B: logs ─▶ local store ──push raw mirrors──▶ ├─▶ hub store ◀── MCP over HTTP ── cloud agents
                       ▲                            │       ▲
                       └──── pull tombstones ───────┘       └── forwarded MCP ── local origin mcp ◀── agents on A, B
```

## 不变量 {#invariants}

这些是产品层面的保证。每一条都必须有测试覆盖，代码注释按编号引用它们。

1. **溯源。** 每个条目至少引用一个事件；每个事件都指向某个 Raw 文件中的某一行。任何回答都能一路展开到原文。
2. **遗忘粘性。** 执行 `forget` 之后，条目立即从所有查询中消失，它的来源事件加入一个排除集，此后任何写入都无法让它们复活。
3. **只追加。** Raw 镜像和事件永远不会被改写。条目通过取代（`supersedes`）来变更，从不原地修改。
4. **你的数据，留在你的机器上。** 所有数据都存放在你控制的机器上：你的各台设备上的 `~/.origin/`，以及可选的你自己的中枢。Origin 从不调用第三方服务；唯一的网络流量发生在你的设备和你的中枢之间。
5. **单一入口。** 无论来自哪个界面，每一次读写都经过同一组 core 操作：Agent 使用 MCP（本地 stdio，或中枢的 HTTP 端点）；人使用 CLI 或自己中枢的管理界面。中枢的复制 API 在你自己的各个库之间传输原始镜像和遗忘记录，它既不是 Agent 的入口，也不是人的入口。

## 设计原则 {#design-principles}

- **内核不含 LLM。** Origin 从不调用模型 API。它只负责归档、规范化、建立索引和存储。分析发生在提问的那个 Agent 里——它本身就是一个能力很强的模型。Agent 通过 MCP `remember` 保存它学到的东西；人通过 CLI 或管理界面纠正和遗忘。如果将来需要周期性的整合，它会作为无头的编码 Agent 任务运行（例如 `claude -p`），而不是直接集成模型 API。这是当前的立场；如果评估表明它力有不逮，尤其是在认知层，可以重新考虑。
- **确定、容错的适配器。** 每个来源都有一个纯粹、确定性的解析器。Agent 的记录格式变化频繁，所以适配器会记录 Agent 版本，跳过无法解析的行并统计失败次数，绝不中止采集。
- **以 MCP 作为互通点。** MCP 是所有目标 Agent 唯一共有的接口。其中几个 Agent 还会读取 Claude Code 的 MCP 配置，所以一次注册就能覆盖不止一个 Agent。
- **小而保守的管理界面。** 中枢的管理界面只供它的主人使用。页面在服务器端由一个对每个值都做转义的模板渲染，外加一点可选的脚本；没有第三方资源，也没有打包工具。CLI 能做的它都能做，但不做任何会破坏不变量的事：不原地编辑，不撤销遗忘，不在屏幕上显示被遗忘的文本。
- **小而可运行的增量。** 每个来源适配器都单独交付、单独可用；设计只深入到当前增量所需的程度。

## 包 {#packages}

pnpm workspace，TypeScript（strict、ESM、NodeNext），Node.js ≥ 22.13。`core`、`adapters` 和 `admin` 只使用 Node 内置模块；`mcp` 依赖官方的 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 和 zod。中枢及其管理界面使用 Node 内置的 `node:http`。

| 包 | 路径 | 职责 | 依赖 |
|---|---|---|---|
| `@openlinkos/origin-core` | `packages/core` | 存储、schema、采集（本地与远程）、条目、遗忘、令牌、管理密钥与会话、审计日志、查询 | — |
| `@openlinkos/origin-adapters` | `packages/adapters` | 每个来源一个确定性解析器 | core |
| `@openlinkos/origin-mcp` | `packages/mcp` | MCP 工具；基于 stdio 和无状态 HTTP 的 server；转发代理 | core |
| `@openlinkos/origin-admin` | `packages/admin` | 中枢的管理界面：服务器端渲染的页面、JSON API 及其静态资源 | core |
| `@openlinkos/origin` | `packages/cli` | `origin` 命令，包括 `origin mcp`、`origin serve`（中枢）和 `origin push` | core, adapters, mcp, admin |

`core` 不得依赖任何其他包，`mcp` 和 `admin` 都不得依赖 `adapters`：CLI 以回调的形式把采集注入各个 server，中枢的 HTTP server 位于 CLI 中，并由它挂载管理界面的请求处理函数。适配器实现 `core` 中的 `SourceAdapter` 接口：

```ts
interface SourceAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'zcode' | 'grok'
  displayName: string;
  version(): string | null; // agent version, if known
  discover(): Promise<SourceFile[]>; // { absPath, relPath, compression?: 'zstd' }
  parseLine(line: string, ctx: ParseContext): ParsedLine | null; // deterministic; throws on malformed input
}
```

## 存储 {#storage}

```
~/.origin/                 # or $ORIGIN_HOME
├── origin.db              # SQLite (WAL)
└── raw/<source>/...       # append-only mirrors of the original log files
```

| 表 | 内容 |
|---|---|
| `raw_file` | 每个镜像文件代次一行，带有它的采集游标 |
| `event`, `event_fts` | 规范化后的事件及其 FTS5 trigram 索引 |
| `session` | 基于可见事件的逐会话聚合（派生数据，可重建） |
| `sync_log` | 每次同步运行一行 |
| `entry`, `entry_source`, `entry_fts` | 条目、条目引用的事件（含引文），以及条目的 FTS5 索引 |
| `tombstone`, `forgotten_entry`, `excluded_event` | 遗忘操作及其影响 |
| `api_token` | 中枢访问令牌：名称和 SHA-256 哈希，从不保存令牌本身 |
| `setting` | 少量键值状态，例如某台设备已经应用到中枢的哪一条遗忘记录 |
| `admin_key` | 管理界面的登录密钥：名称和 SHA-256 哈希，从不保存密钥本身 |
| `admin_session` | 管理界面的会话：会话 id 的哈希、它的 CSRF 令牌和各个时间戳 |
| `audit_log` | 管理操作的只追加记录，只含 id 和数量，从不包含内容；触发器拒绝任何更新和删除 |

- 存储使用 Node 内置的 `node:sqlite`，因此没有需要编译的原生模块。多个进程可以共享同一个数据库（CLI，以及每个 Agent 会话各一个 MCP server）；WAL 模式和 busy timeout 负责处理这种情况。
- `session` 是派生数据，可以从 `event` 重建。FTS 索引是外部内容（external-content）表，由触发器保持同步。
- **首个版本发布前不做迁移。** schema 是一组幂等语句，每次打开数据库时都会执行，所以新增的表和索引会自动出现在已有的数据库中。其他任何 schema 改动都直接原地修改，并且需要一个全新的 `ORIGIN_HOME`。请删除整个目录，而不要只删 `origin.db`：镜像路径是确定的，重新同步到已有的 `raw/` 里会追加重复内容。带版本的迁移将随首个版本一起推出。

## 采集 {#ingestion}

`origin sync`（以及 MCP server，见下文）会运行每个适配器的 `discover()`，并在各自独立的 `BEGIN IMMEDIATE` 事务中采集每个文件，因此来自不同进程的并发同步会被串行化，绝不会把同样的字节采集两次：

1. **游标。** 每个 `raw_file` 行记录 `bytes_ingested`、`lines_ingested` 和 `tail_hash`（最后采集的 4 KB 的 SHA-256）。游标在写锁之下读取，并且只读取游标之后的字节。
2. **改写检测。** 如果文件变小了，或者尾部不再匹配，说明它是被改写而不是被追加。Origin 会开启一个新的*代次*，使用全新的镜像，并保持旧镜像完好无损（不变量 3）。
3. **只取完整行。** 截至最后一个换行符的字节会被追加到镜像中；末尾不完整的行留待下一次同步。镜像始终等于其代次已采集的字节，因此被中断的同步遗留在游标之后的字节，会在追加之前被丢弃（不变量 1）。
4. **解析与插入。** 每一行都经过 `parseLine`；失败只计数，不致命。事件以 `<source>:<native-id>[#<block-index>]` 为 id、用 `INSERT OR IGNORE` 插入，这使同步具有幂等性（不变量 3）。每个事件都保存它的镜像文件和行号（不变量 1）。
5. **收尾记录。** 受影响的会话被重新聚合，游标在同一个事务中前移，并由一行 `sync_log` 记录这次运行。

**压缩的来源。** 适配器可以把文件标记为 `compression: 'zstd'`。Origin 随后使用 Node 内置的 zstd，采集并镜像解压后的内容，因此游标、行号和原始行的工作方式与普通文件相同。压缩文件只写入一次，所以自上次采集以来没有变化时会被跳过。

### Claude Code 映射 {#claude-code-mapping}

- 文件：`<projects>/<cwd-slug>/<session-id>.jsonl`，以及 `<session-id>/subagents/` 下的子 Agent 记录。`memory/` 和 `tool-results/` 目录会被跳过。
- `user` / `assistant` 行变成事件。文本块合并为一个 `message` 事件；每个 `tool_use` 和 `tool_result` 块各自成为一个事件（分别截断到 2,000 / 4,000 个字符）。`isMeta` 行变成 `meta` 事件。`thinking` 块不建立索引，但保留在原始镜像中。
- `summary` 行设置会话标题。
- 项目名取 `cwd` 的最后一段。

其他适配器的映射与各自的格式一起记录在 [sources.md](sources.md) 中（Codex 见 [Codex CLI](sources.md#codex-cli)）。

## 条目 {#entries}

- **记住（remember）。** 一个条目是一条自成一体的陈述，带有类型、0 到 1 之间的置信度、作者（MCP 客户端的名称；通过 CLI 纠正时为 `user`）、可选的项目和有效期，以及至少一个来源（不变量 1）。来源可以是一个事件 id、一段精确引文，或者两者兼有：
  - 给出 id 时，该事件必须存在且可见；如果同时给出引文，引文必须出现在该事件中（忽略空白和大小写）。
  - 只给出引文时，Origin 引用包含该引文的最新可见 `message` 事件，找不到时退而查找 `tool_result` 事件。工具调用永远不参与匹配，因为 Agent 自己那次包含该引文的 `remember` 调用，本身就会作为工具调用被记录下来。
- **纠正（correct）。** 纠正一个活跃条目，会插入一个 `supersedes` 它的新条目（不变量 3）。原有来源会被继承，也可以添加新的来源。历史是线性的：一个条目最多只能被取代一次，只有最新版本是活跃的。
- **状态**由推导得出：如果有遗忘记录覆盖该条目，则为 `forgotten`；如果存在更新的版本，则为 `superseded`；否则为 `active`。除非请求历史，查询只返回活跃条目；被遗忘的条目永远不会被返回。

## 遗忘 {#forgetting}

`forget` 接受一个条目 id 或事件 id，并写入一条遗忘记录（不变量 2）：

1. **遗忘一个条目**会遗忘它的所有版本，并排除这些版本引用的所有事件。
2. **遗忘一个事件**会排除该事件，并像规则 1 那样遗忘所有引用它的条目。
3. **不再有任何可见来源的活跃条目**已经失去溯源，因此同样会被遗忘。这一步不会再排除其他事件，所以级联到此为止。

被排除的事件会从检索、时间线、会话计数、`get` 和 `sources` 中消失，并且再也不能被引用。重新同步——即使源文件已被改写——也不会让它们回来，因为事件 id 是稳定的，而排除按 id 生效。遗忘是隐藏，而不是擦除。原始镜像文件仍保留在磁盘上（不变量 3），但永远不会被展示。物理清除以后可能作为一个显式选项提供。CLI 会先展示将被遗忘的内容，并要求加上 `--yes`，因为遗忘无法撤销。

## 检索与时间线 {#search-and-timeline}

- 全文检索使用带 `trigram` 分词器的 FTS5，因此不区分大小写的子串检索对中日韩（CJK）文字和拉丁文字同样有效。每个以空白分隔的词都会成为一个加引号的短语，各词之间以 AND 组合。trigram 索引无法服务短于三个字符的词，所以这类查询会退回使用 `LIKE`。
- 结果默认按 BM25 相关度排序，也可以按需改为按时间排序（`--recent`）；退回 `LIKE` 的查询总是按时间排序。事件检索只覆盖 `message` 事件，除非请求包含工具事件（`--all` / `include_tools`）。条目检索覆盖活跃条目。
- 时间线按时间列出会话，或按顺序列出单个会话的事件（工具事件默认隐藏，除非请求显示）。

## MCP server {#mcp-server}

`origin mcp` 通过 stdio 提供以下工具。结果是 JSON 文本，时间戳为本地时间的 ISO 8601 格式。

| 工具 | 用途 |
|---|---|
| `search` | 对条目和事件做全文检索；不带查询词时列出最近的条目。过滤条件：范围、类型、时间段、来源、项目、工具事件 |
| `timeline` | 某个时间段内的会话（默认 7 天），或单个会话的事件 |
| `get` | 条目及其来源和版本历史，或事件及其完整正文 |
| `sources` | 条目或事件对应的原始记录行：文件、镜像、行号、原始文本 |
| `remember` | 写入一个条目，包括类型、正文、置信度和来源 |
| `correct` | 用纠正后的版本取代一个条目 |
| `forget` | 按上述规则遗忘一个条目或事件；仅在用户明确要求时使用 |

- **新鲜度。** server 在启动时同步所有来源，在读取类工具之前也会同步（最多每 10 秒一次），在 `remember` 和 `correct` 之前则总会同步，因此 Agent 能引用它当前所在对话中的记录行。
- **引导。** server 的 MCP `instructions` 会告诉 Agent 何时检索、何时记住（带理由的决定、稳定的事实、偏好），以及 `forget` 需要明确的请求。
- **错误。** 无效输入、未知 id 和已遗忘的 id 会以工具错误的形式返回，并附带可读的说明。

## 个人中枢 {#personal-hub}

中枢就是一个普通的 Origin 库，只是额外运行了 `origin serve`。它是自托管、单租户的：一个人，以及这个人的设备和 Agent。中枢中没有任何部分依赖特定的托管服务商；发布的容器镜像 `ghcr.io/openlinkos/origin` 可以在任何地方运行它。

### 角色 {#roles}

- **设备**：任何有 Agent 会话记录的机器。它照常在本地采集（适配器、原始镜像、游标、改写代次、压缩都保持不变），并运行 `origin push` 进行复制。它的本地库是一个暂存副本。
- **中枢**：`origin serve` 为 Agent 提供基于 HTTP 的 MCP，为设备提供一个小型复制 API，启用后还为它的主人提供一个管理界面。对 Agent 而言，中枢是唯一的事实来源：检索、时间线、条目和遗忘都在那里进行。

### 复制：原始镜像上行，遗忘记录下行 {#replication-raw-mirrors-up-tombstones-down}

- 设备推送的是**原始镜像字节**，而不是解析后的事件。中枢把它们存为自己的只追加镜像，并用同样的适配器解析，因此溯源（不变量 1）在中枢上同样成立，解析器的修复也会在所有地方生效。事件 id 在每个库中都完全相同。
- 每个远程文件以 `(source, "@<device>:<original path>", generation)` 为键；本地路径永远不会以 `@` 开头。中枢上的镜像位于 `raw/devices/<device>/<source>/<relPath>[.g<n>]`。
- 推送可续传且幂等：设备先向中枢查询游标，再把每个镜像的 `[cursor, local size)` 区间按完整行分块发送（每块最多 1 MiB，或者单独一个更长的行）。偏移量与中枢游标不一致的块会被拒绝，并返回当前游标，设备从那里继续。
- 推送之后，设备取回自己尚未应用的中枢遗忘记录，并应用到自己的暂存库中，从而让遗忘到达每一个副本（不变量 2）。在中枢上被遗忘的事件即使被再次推送，也会保持排除，因为排除按事件 id 生效。

### 访问 {#access}

- 发往 `/mcp` 和 `/v1/*` 的每个请求都需要 `Authorization: Bearer <token>`；`/admin` 下的管理界面有自己的登录（见[管理界面](#admin-ui)）。令牌在中枢上创建（`origin token create <name>`），只显示一次，只以 SHA-256 哈希的形式存储，并且可以吊销。每台设备或每个云端 Agent 各用自己的令牌。
- 中枢使用明文 HTTP。在 localhost 之外开放之前，请把它放在 TLS（反向代理或 CDN）之后。
- 通过中枢写入的条目会把 Agent 和令牌记为作者，例如 `claude-code@laptop`：Agent 名称来自 MCP 客户端（或转发代理设置的 `X-Origin-Client` 请求头），后缀来自令牌名称。

### HTTP 接口 {#http-interface}

| 方法与路径 | 用途 |
|---|---|
| `GET /healthz` | `{ "ok": true, "version": … }`，无需鉴权 |
| `POST /mcp` | MCP Streamable HTTP，无状态，JSON 响应；与 stdio server 相同的七个工具 |
| `GET /v1/cursors?device=<name>` | 该设备每个文件在中枢上的字节游标 |
| `POST /v1/ingest` | 追加一个块：JSON `{ device, source, path, relPath, generation, offset, mtimeMs, agentVersion, data }`，其中 `data` 为 base64；请求体可以使用 gzip 编码。返回 `200 { bytes, eventsAdded, … }`，偏移量不匹配时返回 `409 { bytes }` |
| `GET /v1/tombstones?after=<id>` | id 大于 `after` 的遗忘记录，每条都附带它遗忘的条目和排除的事件 |
| `GET`, `POST /admin/…` | 启用时的管理界面：需要管理员登录的服务器端渲染页面。未启用时返回 404 |
| `GET`, `POST /admin/api/…` | 管理界面的 JSON API：与页面相同的操作、会话和检查 |

中枢会校验每个字段：设备名必须匹配 `[a-z0-9][a-z0-9._-]{0,62}`，来源必须是已知的适配器，`relPath` 必须是相对路径且不含 `..` 段，因此设备永远无法写到它的镜像目录之外。

### 从设备使用中枢 {#using-a-hub-from-a-device}

- `origin hub connect <url> --token <token> [--device <name>]` 把连接信息保存在 `<ORIGIN_HOME>/hub.json` 中（设备名默认为主机名）。`ORIGIN_HUB_URL`、`ORIGIN_HUB_TOKEN` 和 `ORIGIN_DEVICE` 会覆盖其中的配置。
- 配置了中枢之后，`origin mcp` 就成为一个**转发代理**：它通过 stdio 提供同样的工具，每次调用前先同步和推送（读取类调用最多每 10 秒一次，`remember` 和 `correct` 之前总会进行），再把调用转发给中枢。Agent 的注册无需改动，Agent 也仍然能引用刚刚说过的内容。
- 没有本地记录的云端 Agent 直接用 bearer 令牌注册中枢的 `/mcp` URL。
- 在当前版本中，CLI 管理命令（`entries`、`correct`、`forget` 等）作用于它们所运行的那个库。请通过 Agent、中枢的管理界面，或在中枢上运行 CLI 来管理记忆。

### 管理界面 {#admin-ui}

中枢可以为它的主人提供一个 Web 界面。它默认关闭；它是同一个库的一个视图，而不是另一套系统：每个页面、每次 JSON 调用都经过 MCP 和 CLI 所用的同一组 core 操作（不变量 5）。`@openlinkos/origin-admin` 包提供一个请求处理函数，由中枢挂载。

- **提供方式。** `origin serve --admin` 把界面挂载在中枢端口的 `/admin` 下；`origin serve --admin-listen 127.0.0.1:7078` 则改在一个单独的监听地址上提供，通过 SSH 隧道或 `kubectl port-forward` 访问。如果界面会在非回环地址上提供，除非 `--public-url`（`ORIGIN_PUBLIC_URL`）是 https URL，或者是回环主机上的 http URL（例如发布在 `127.0.0.1` 上的容器端口），否则中枢拒绝启动。没有公开 URL 时，界面只响应发往回环主机名的回环连接，这同时也能防御 DNS 重绑定。界面未启用时，`/admin` 返回 404。
- **登录。** 管理密钥在中枢上用 `origin admin key create <name>` 创建，只显示一次（`oga_…`），以 SHA-256 哈希的形式保存在 `admin_key` 中；也可以通过 `ORIGIN_ADMIN_KEY_SHA256` 提供哈希，便于把配置放在 Git 里。没有首次访问时的设置向导，所以新建的中枢不会被第一个访问到它的人占用。管理密钥和中枢令牌互不接受：`/mcp` 和 `/v1/*` 只接受 bearer 令牌（`ogn_…`），`/admin` 只接受它自己的会话 cookie。
- **会话。** 会话保存在服务器端的 `admin_session` 中，以会话 id 的哈希为键。会话在 30 分钟没有请求、登录满 12 小时，或者所用密钥被吊销时结束。在 https 公开 URL 之后，cookie 是 `__Host-origin-admin`（Secure、HttpOnly、SameSite=Lax）；在回环 http 上，cookie 是 `origin-admin`（HttpOnly、SameSite=Strict，路径 `/admin`）。创建或吊销令牌、遗忘、结束会话，要求最近 10 分钟内输入过密钥。
- **请求。** 只有 GET 和 POST，所有写操作都是 POST。POST 需要会话的 CSRF 令牌（表单字段 `_csrf` 或请求头 `X-CSRF-Token`），以及与中枢源相同的 `Origin` 请求头；带有 `Sec-Fetch-Site: cross-site` 的请求会被拒绝。请求体上限为 64 KiB。密钥校验失败的次数受到限制：每个客户端每 10 分钟 10 次，总计每 10 分钟 100 次（返回 429 和 `Retry-After`）；只有设置了 `ORIGIN_CLIENT_IP_HEADER` 时才从该请求头取客户端地址，否则取连接的地址。
- **响应。** 页面在服务器端由一个对每个插值都做转义的模板渲染；一小段脚本提供一些便利，例如就地加载原始行，但没有页面依赖它。每个响应都带有严格的 Content-Security-Policy（没有内联脚本或样式，启用 Trusted Types 且不允许任何策略）、`Cache-Control: no-store, private`、`Vary: Cookie`，以及防止嵌入、类型嗅探、引用来源泄露和被搜索引擎收录的请求头；在 https 之后还带有 HSTS。没有第三方资源，界面也从不发起外部请求。
- **能做什么。** 概览（数量统计、设备及其最近推送、存储、解析错误）、令牌（创建：令牌只显示一次，旁边附有现成的接入命令；吊销）、设备、时间线、会话、带溯源链的事件（原始行按需加载，截断到 4,000 个字符；工具事件默认隐藏）、检索、条目及其历史、`correct`（未指定时置信度为 1）、从事件页面 `remember`（引用该事件，作者为 `user`），以及预览之后的 `forget`：请求带上所展示计划的摘要，并再次输入 id；如果计划在此期间发生了变化，就不会遗忘任何内容（409）。
- **不能做什么。** 编辑或删除事件、原始镜像、条目或遗忘记录；撤销遗忘；显示被遗忘内容的任何文本（遗忘记录和审计日志只保存 id 和数量）；保存没有可见来源的条目；再次显示令牌；创建管理密钥或修改安全设置；执行任意查询，或读取可见事件的镜像行以外的任何文件。
- **审计日志。** 来自界面的登录和失败尝试（每个客户端在每个时间窗口内合并为一条记录）、令牌变更、写入的条目、遗忘操作和被结束的会话，以及来自 CLI 的令牌和管理密钥变更，都会连同操作者、渠道、客户端地址和 user agent 一起追加到 `audit_log`。详情只含 id 和数量，从不包含文本，因此遗忘保持粘性；触发器拒绝任何更新和删除。

## 待解决的问题 {#open-questions}

- **低成本的认知。** 如何在没有专门抽取流水线的情况下，构建并维护一个关于这个人的模型？目前由 Agent 在注意到某些东西时自行写入认知条目。这是否足够，仍是一个悬而未决的问题。
- **与原生记忆互通。** Claude Code、ZCode 和 Grok Build 都维护一个 `MEMORY.md` 索引，外加每条记忆一个 Markdown 文件。与这种布局的双向导入 / 导出已在计划中，但尚未设计。
- **变更通知。** 文件监听在某些平台上并不可靠。MCP server 按需同步，CLI 则在运行 `origin sync` 时同步；可能仍然需要一个由定期全量扫描兜底的后台监听器，尤其是为了从 Agent 闲置的设备上推送。
- **远程管理。** 管理界面已经可以在浏览器中管理中枢上的记忆。在设备的 CLI 上针对它的中枢运行 `entries`、`correct` 和 `forget`，并保持与本地相同的“预览—确认”流程，仍有待解决；设备上只监听回环地址的 `origin ui` 也是如此。

## 相关工作 {#prior-art}

调研于 2026 年 10 月。Origin 借鉴了这些项目的想法，但不依赖其中任何一个。

| 项目 | Origin 借鉴的想法 |
|---|---|
| [Hindsight](https://github.com/vectorize-io/hindsight) | 条目引用自己的证据，并能展开到原文；一个显式的“心智模型”层 |
| [Graphiti](https://github.com/getzep/graphiti) | 双时态有效期（`valid_from` / `valid_to`），但不构建图 |
| [GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) | 使用前会重新验证的引用 |
| [MacPaw Portable Memory](https://github.com/MacPaw/portable-memory) | 把删除墓碑（tombstone）作为一等概念 |
| [Codex memories](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md) | 从本地会话记录派生的记忆，并带有指回会话的引用 |

这一领域的其他系统还包括 [mem0](https://github.com/mem0ai/mem0)、[Letta](https://github.com/letta-ai/letta-code)、[Supermemory](https://github.com/supermemoryai/supermemory)、[Cognee](https://github.com/topoteretes/cognee)，以及参考实现 [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)。它们大多要么缺少细粒度的溯源，要么缺少可以验证的遗忘操作；而各厂商的记忆（Claude、ChatGPT、Gemini、Copilot、Codex）都只限于各自的产品，没有面向第三方的读取 API。
