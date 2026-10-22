---
sourceHash: sha256-d80ce420
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
- 一个人常常在多台机器上运行 Agent（笔记本、服务器、云端 Agent）。每台设备都保有一份完整的、属于自己的记忆；可选的自托管**个人中枢**把每台设备写下的内容汇集到一个库中，让任何地方的 Agent 都能找到。

达成目标的标志是：在你任何一台机器上，从任何一个已接入的 Agent 问“上周在项目 X 里我决定了什么，为什么？”，都能得到附带来源的回答，而且被遗忘的条目永远不会再回来。

**目前明确不做：** 多租户托管（Origin 只服务一个人，每个人运行自己的一份）、由本项目运营的托管服务、端到端加密、设备之间互相拉取对方的数据、不经过中枢的点对点同步、实时协作、自己中枢上供主人使用的管理界面之外的任何 Web 界面（没有公开页面、没有分享、没有多账户）、屏幕 / 邮件 / 浏览器采集、知识图谱、向量检索、主动提醒，以及任何对模型 API 的调用。

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
| **Entry**（条目） | 一条持久的 `memory` / `knowledge` / `cognition` 陈述 | id（`ent_…`）、类型、正文、置信度、作者、项目、来源（事件 id + 引文）、supersedes、root（它的第一个版本）、valid_from / valid_to、created_at、origin（写入它的库）；状态（`active` / `superseded` / `forgotten`）由推导得出，从不存储 |
| **Tombstone**（遗忘记录） | 一次遗忘操作的记录 | id（`tmb_…`）、目标 id、原因、时间、origin（创建它的库）；它在每个库中遗忘的条目和排除的事件 |

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

使用个人中枢时，每台设备都保有一份完整的、属于自己的库，离线时也照常可用。它把原始镜像发送给中枢（由中枢用同样的适配器解析），也把自己写下的条目和遗忘记录发送给中枢；它从中枢收到的只有遗忘记录。设备上的 Agent 使用本地的 `origin mcp`，它根据设备自己的库作答，并合并中枢的回答；云端 Agent 则使用中枢的 HTTP 端点：

```
agents on A ──▶ origin mcp ──▶ store A ──raw mirrors · entries · tombstones──▶ ┐
                    │             ▲                                             │
                    │             └──────────────── tombstones ─────────────────┤
                    └──────── reads, merged (MCP over HTTP) ───────────────────▶ hub store ◀── MCP over HTTP ── cloud agents
agents on B ──▶ origin mcp ──▶ store B ── (as for device A) ───────────────────▶ ┘
```

## 不变量 {#invariants}

这些是产品层面的保证。每一条都必须有测试覆盖，代码注释按编号引用它们。

1. **溯源。** 每个条目至少引用一个事件；每个事件都指向某个 Raw 文件中的某一行。任何回答都能一路展开到原文。
2. **遗忘粘性。** 执行 `forget` 之后，条目立即从该库的所有查询中消失，它的来源事件加入一个排除集，此后任何写入都无法让它们复活。遗忘记录会到达每一个库，并且只增不减：被遗忘的内容无论到达哪里都保持被遗忘，之后才到达的版本和副本也是如此，而且没有任何东西会被取消遗忘。
3. **只追加。** Raw 镜像和事件永远不会被改写。条目通过取代（`supersedes`）来变更，从不原地修改。
4. **你的数据，留在你的机器上。** 所有数据都存放在你控制的机器上：你的各台设备上的 `~/.origin/`，以及可选的你自己的中枢。Origin 从不调用第三方服务；唯一的网络流量发生在你的设备和你的中枢之间。
5. **单一入口。** 无论来自哪个界面，每一次读写都经过同一组 core 操作：Agent 使用 MCP（所在设备的 `origin mcp`，或中枢的 HTTP 端点）；人使用 CLI 或自己中枢的管理界面。写入发生在发起它的那个库中——在设备上就是先写入设备自己的库——再由复制通过同样的操作应用到其他库。中枢的复制 API 在你自己的各个库之间传输原始镜像、条目和遗忘记录，它既不是 Agent 的入口，也不是人的入口。

## 设计原则 {#design-principles}

- **内核不含 LLM。** Origin 从不调用模型 API。它只负责归档、规范化、建立索引和存储。分析发生在提问的那个 Agent 里——它本身就是一个能力很强的模型。Agent 通过 MCP `remember` 保存它学到的东西；人通过 CLI 或管理界面纠正和遗忘。如果将来需要周期性的整合，它会作为无头的编码 Agent 任务运行（例如 `claude -p`），而不是直接集成模型 API。这是当前的立场；如果评估表明它力有不逮，尤其是在认知层，可以重新考虑。
- **确定、容错的适配器。** 每个来源都有一个纯粹、确定性的解析器。Agent 的记录格式变化频繁，所以适配器会记录 Agent 版本，跳过无法解析的行并统计失败次数，绝不中止采集。
- **以 MCP 作为互通点。** MCP 是所有目标 Agent 唯一共有的接口。其中几个 Agent 还会读取 Claude Code 的 MCP 配置，所以一次注册就能覆盖不止一个 Agent。
- **小而保守的管理界面。** 中枢的管理界面只供它的主人使用。页面在服务器端由一个对每个值都做转义的模板渲染，外加一点可选的脚本。它的样式表、字体和图标来自 OpenLinkOS 设计系统（`@openlinkos/ui`），在构建时复制进这个包；不从别处加载任何东西，也没有打包工具。CLI 能做的它都能做，但不做任何会破坏不变量的事：不原地编辑，不撤销遗忘，不在屏幕上显示被遗忘的文本。
- **小而可运行的增量。** 每个来源适配器都单独交付、单独可用；设计只深入到当前增量所需的程度。

## 包 {#packages}

pnpm workspace，TypeScript（strict、ESM、NodeNext），Node.js ≥ 22.13。`core`、`adapters` 和 `admin` 只使用 Node 内置模块；`mcp` 依赖官方的 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 和 zod。中枢及其管理界面使用 Node 内置的 `node:http`。

| 包 | 路径 | 职责 | 依赖 |
|---|---|---|---|
| `@openlinkos/origin-core` | `packages/core` | 存储、schema、采集（本地与远程）、条目、遗忘、令牌、管理密码与会话、审计日志、查询 | — |
| `@openlinkos/origin-adapters` | `packages/adapters` | 每个来源一个确定性解析器 | core |
| `@openlinkos/origin-mcp` | `packages/mcp` | MCP 工具；基于 stdio 和无状态 HTTP 的 server，以及已接入中枢的设备上的 server，它把中枢的回答合并进自己的回答 | core |
| `@openlinkos/origin-admin` | `packages/admin` | 中枢的管理界面：服务器端渲染的页面、JSON API 及其静态资源 | core |
| `@openlinkos/origin` | `packages/cli` | `origin` 命令，包括 `origin mcp`、`origin serve`（中枢），以及设备与中枢之间的同步 | core, adapters, mcp, admin |

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
| `event` | 规范化后的事件，以它们到达本库的次序（`seq`）为键 |
| `event_block` | 每一块 4,096 个连续到达的事件中最晚的时间戳，以及到这一块为止最晚的时间戳（派生数据，由触发器维护） |
| `message_fts`, `event_fts`, `event_cjk` | 事件的检索索引：`message` 事件的完整 trigram 索引、只记录哪些事件含有每个 trigram 的全部事件索引，以及 CJK 二元组索引（见[检索与时间线](#search-and-timeline)） |
| `session` | 基于可见事件的逐会话聚合（派生数据，可重建） |
| `sync_log` | 每次同步运行一行 |
| `entry`, `entry_source`, `entry_fts` | 条目、条目引用的事件（含引文），以及条目的 FTS5 索引。每个版本记录它的 `root`（第一个版本，写入时确定）和它的 `origin` |
| `tombstone`, `forgotten_entry`, `excluded_event` | 遗忘操作，每条都有一个全局 id（`tmb_` 加随机十六进制，与 `ent_` id 相同）和它的 `origin`，以及它们在本库中的影响 |
| `change_log` | 本库写入或收到的条目和遗忘记录的只追加序列（序号、类型、id、origin、时间），由触发器填写；触发器拒绝任何更新和删除。复制游标指向这个序列 |
| `api_token` | 中枢访问令牌：名称和 SHA-256 哈希，从不保存令牌本身 |
| `setting` | 少量键值状态，只属于各自的库，从不复制：库的名称、设备的复制游标，以及中枢上管理密码的 scrypt 哈希 |
| `admin_session` | 管理界面的会话：会话 id 的哈希、它的 CSRF 令牌和各个时间戳 |
| `audit_log` | 管理操作的只追加记录，只含 id 和数量，从不包含内容；触发器拒绝任何更新和删除 |

- 存储使用 Node 内置的 `node:sqlite`，因此没有需要编译的原生模块。多个进程可以共享同一个数据库（CLI，以及每个 Agent 会话各一个 MCP server）；WAL 模式和 busy timeout 负责处理这种情况。
- `session` 是派生数据，可以从 `event` 重建；按来源的汇总（`origin status`、管理界面的概览）从它读取。检索索引也是派生数据，由触发器保持同步：`message_fts` 和 `event_fts` 是外部内容（external-content）表（`message_fts` 的内容是消息事件的视图 `event_message`），`event_cjk` 没有内容表，通过核心在每个连接上注册的函数填写。`rebuildSearchIndexes()` 从事件和条目重建所有这些索引以及 `event_block`。
- **到达次序。** 事件以及随之的检索索引都以 `seq` 为键，即事件到达本库的次序：FTS5 保存相邻键之间的差值，所以连续的键能让索引保持很小。同步时按修改时间从旧到新采集找到的文件，设备也按最后更新的先后把文件推送给中枢，所以到达次序尽可能地跟随时间；但它并不是时间次序，例如中枢可能在收到较新的会话很久之后，才收到某台设备的旧会话。因此，一个触发器为每一块 4,096 个连续到达的事件记录其中最晚的时间戳，以及到这一块为止最晚的时间戳（`event_block`）。按从新到旧的查询从最后到达的事件开始读取索引，分成几条由连续的块组成的链（某一块比它之前的链新一天以上时，就开始一条新链），总是从未读部分可能含有最新事件的那条链读取，一旦没有链可能含有比所需事件更新的事件，就立即停止。一个窄的 `(seq, ts)` 索引无需读取事件就能给出它的时间戳。
- **库的名称。** 每个库都有一个名称，保存在 `setting` 中：在设备上就是设备名，中枢则把自己的库叫作 `hub`。条目和遗忘记录把写入它们的库的名称记为 `origin`，设备也以自己库的名称为中枢所知。库在第一次需要名称时被命名：`origin serve` 把它命名为 `hub`；其他命令使用 `ORIGIN_DEVICE` 或主机名。库一旦写入过条目或遗忘记录，就保持这个名称不变。
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

- **记住（remember）。** 一个条目是一条自成一体的陈述，带有类型、0 到 1 之间的置信度、作者（`<agent>@<device>`：MCP 客户端的名称加上它写入的库的名称，例如 `claude-code@laptop`；CLI 和管理界面写入时为 `user@<device>`；直接使用中枢的 Agent 见[访问](#access)）、可选的项目和有效期，以及至少一个来源（不变量 1）。来源可以是一个事件 id、一段精确引文，或者两者兼有：
  - 给出 id 时，该事件必须存在且可见；如果同时给出引文，引文必须出现在该事件中（忽略空白和大小写）。
  - 只给出引文时，Origin 引用包含该引文的最新可见 `message` 事件，找不到时退而查找 `tool_result` 事件。工具调用永远不参与匹配，因为 Agent 自己那次包含该引文的 `remember` 调用，本身就会作为工具调用被记录下来。最新指时间戳最新。Origin 像检索那样查找引文中的词（见[检索与时间线](#search-and-timeline)），每种事件最多核对含有所有这些词的最新 25,000 个事件，所以完全由非常常见的词组成的引文，可能在较早的事件中找不到；这时请改为引用事件 id。
- **纠正（correct）。** 纠正一个条目的当前版本，会插入一个 `supersedes` 它的新版本（不变量 3）。原有来源会被继承，也可以添加新的来源。纠正的时间总是晚于被纠正的版本，即使本机时钟偏慢也是如此。一个条目的所有版本共享它的 `root`，也就是第一个版本；它们合起来构成这个条目的版本链。
- **并发纠正。** 两个库可能在互相知道之前纠正了同一个版本，所以一个版本可以被不止一个版本取代。这时版本链出现分叉，而每个库都以同样的方式解决它：链中 `(created_at, id)` 最大的版本是**当前**版本，其他版本都是已被取代的版本。一个已被取代、但没有被任何版本纠正的版本，是输给了一次并发纠正，会被标记出来（`concurrent`）。只有当前版本可以被纠正。
- **状态**由推导得出：如果有遗忘记录覆盖该条目，则为 `forgotten`；如果它是所在版本链的当前版本，则为 `active`；否则为 `superseded`（`superseded_by` 指向当前版本）。除非请求历史，查询只返回活跃条目；被遗忘的条目永远不会被返回。历史按从旧到新的顺序列出版本链中的每个版本，包括分叉。

## 遗忘 {#forgetting}

`forget` 接受一个条目 id 或事件 id，并写入一条遗忘记录（不变量 2）：

1. **遗忘一个条目**会遗忘它的所有版本（整条版本链，包括分叉），并排除这些版本引用的所有事件。
2. **遗忘一个事件**会排除该事件，并像规则 1 那样遗忘所有引用它的条目。
3. **当前版本不再有任何可见来源的条目**已经失去溯源，因此同样会被遗忘，包括它的每个版本。这一步不会再排除其他事件，所以级联到此为止。

版本链要么整体被遗忘，要么完全不被遗忘，而且没有任何东西会被取消遗忘。遗忘记录保存目标 id，并记录它在本库中的影响：它遗忘的条目和它排除的事件。

**来自其他库的遗忘记录。** 遗忘记录的 id 是全局的，所以在一个库中创建的遗忘记录，到达任何库时都保持它的 id、origin 和原因。库按上述规则把它应用到自己持有的数据上，同时也应用它在发送方库中的影响，只要库认识那些 id；列出的条目会连同整条版本链一起被遗忘。因此每个库至少会遗忘发送方遗忘的内容，各个库最终收敛到它们的并集。同一条遗忘记录应用两次不会改变任何东西。之后才到达、属于一条已被遗忘版本链的版本，在到达时就会被遗忘；来源已在别处被排除的条目也是如此（规则 2 和 3），所以到达的先后顺序无关紧要。

被排除的事件会从检索、时间线、会话计数、`get` 和 `sources` 中消失，并且再也不能被引用。重新同步——即使源文件已被改写——也不会让它们回来，因为事件 id 是稳定的，而排除按 id 生效。遗忘是隐藏，而不是擦除。原始镜像文件仍保留在磁盘上（不变量 3），但永远不会被展示。物理清除以后可能作为一个显式选项提供。CLI 会先展示将被遗忘的内容，并要求加上 `--yes`，因为遗忘无法撤销。

## 检索与时间线 {#search-and-timeline}

事件检索只覆盖 `message` 事件，除非请求包含工具事件（`--all` / `include_tools`），并且从不返回已遗忘的事件。条目检索覆盖活跃条目。

**词。** 查询按空白切分，每个词都必须作为子串出现在文本中（不区分大小写；`log` 能匹配 `catalog`）。一个词如何被找到，取决于它的字符数：

- **三个或更多字符**：通过 trigram 索引查找，对中日韩（CJK）文字和拉丁文字都一样。
- **一到两个 CJK 字母**（汉字、假名或谚文），例如 `部署` 或 `库`：通过 CJK 索引查找，它保存每一对相邻的 CJK 字母，以及每一串 CJK 字母的最后一个字母。
- **一到两个其他字符**，例如 `AI`、`C#` 或 `5号`：没有索引能找到它们，所以 Origin 从新到旧核对候选事件的文本。候选事件是检索所覆盖的事件（它的事件类型，以及所请求的项目、来源和时间范围）中匹配查询其他词的事件。最多核对最新的 25,000 个候选事件（`SCAN_LIMIT`），所以这样的词可能漏掉较早的事件；限定时间范围、指定项目或加上一个更长的词，就能找到它们。

**索引。** 事件检索由三个 FTS5 索引支撑，它们都以 `seq` 为键。其中一个索引驱动查询，从新到旧，其余的词再过滤它的匹配：

| 索引 | 内容 | 用途 |
|---|---|---|
| `message_fts` | `message` 事件，记录每个 trigram 的位置（`detail=full`） | 含有三个或更多字符的词的消息检索：每个词都作为短语精确匹配，并用 BM25 打分 |
| `event_fts` | 所有事件，只记录哪些事件含有每个 trigram（`detail=none`），体积只是完整索引的一小部分 | 包含工具事件的检索：事件必须含有每个词的每个 trigram，然后再用词本身核对 |
| `event_cjk` | 每个含 CJK 文字的事件的 CJK 二元组（`detail=none`，无内容表） | 一到两个字母的 CJK 词，以及其他词都同样短的查询 |

**排序。** 结果默认按 BM25 相关度排序，最相关的在前。排序只考虑最新的 2,000 个匹配（`RANK_WINDOW`），匹配更少时则考虑全部：查询匹配的事件更多时，较早的匹配既不参与排序也不会返回，所以非常常见的词会偏向近期的事件，而限定时间范围会移动这个窗口。对于消息，BM25 把词作为短语打分；包含工具事件时，它对词的 trigram 打分。没有三个或更多字符的词的查询，以及 `--recent`，改为按时间排序。按时间排序指按时间戳从新到旧，时间戳相同的事件中后到达的在前；相关度相同的结果也按同样的方式排列。无论事件以什么顺序到达，按时间排序的结果以及最新 2,000 个匹配的窗口都是精确的：查询按到达的块读取索引（见[存储](#storage)），一旦没有未读的块可能含有比所需匹配更新的匹配，就立即停止。匹配很少的查询（不超过 2,000 个，或所需数量的五倍）则直接读取全部匹配。

**摘要**显示第一个匹配周围最多 200 个字符的文本，每个匹配都用方括号标出。

**条目**按同样的词检索：三个或更多字符的词通过 `entry_fts` 查找并按 BM25 排序，更短的词通过核对文本查找（条目很少）。没有三个或更多字符的词时，条目从新到旧排列。

时间线按时间列出会话，或按顺序列出单个会话的事件（工具事件默认隐藏，除非请求显示）。

## MCP server {#mcp-server}

`origin mcp` 通过 stdio 提供以下工具。结果是 JSON 文本，时间戳为本地时间的 ISO 8601 格式，精确到毫秒。

| 工具 | 用途 |
|---|---|
| `search` | 对条目和事件做全文检索；不带查询词时列出最近的条目。过滤条件：范围、类型、时间段、来源、项目、工具事件 |
| `timeline` | 某个时间段内的会话（默认 7 天），或单个会话的事件 |
| `get` | 条目及其来源和版本历史，或事件及其完整正文 |
| `sources` | 条目或事件对应的原始记录行：文件、镜像、行号、原始文本 |
| `remember` | 写入一个条目，包括类型、正文、置信度和来源 |
| `correct` | 用纠正后的版本取代一个条目 |
| `forget` | 按上述规则遗忘一个条目或事件；仅在用户明确要求时使用 |

- **新鲜度。** server 在启动时采集所有来源，在读取类工具之前也会采集（最多每 10 秒一次），在 `remember` 和 `correct` 之前则总会采集，因此 Agent 能引用它当前所在对话中的记录行。
- **在已接入中枢的设备上。** server 仍然根据设备自己的库作答，读取类工具（`search`、`timeline`、`get`、`sources`）会同时询问中枢的 `/mcp`。两边的结果会合并、按 id 去重，并标上 `origin: "local"`（本设备有这一项）或 `"hub"`。无论中枢返回什么，设备已经遗忘的内容都不会显示；同一个条目的多个版本中，只列出按[条目](#entries)中的规则确定的当前版本；`get` 会合并两个库中该条目的历史。对于设备没有的 id，`get` 和 `sources` 由中枢作答。如果中枢在 2 秒内（`ORIGIN_HUB_TIMEOUT_MS`）没有回应，或者无法连接，工具就只根据设备作答，并附加第二段文本，说明这次没有询问中枢。
- **已接入中枢的设备上的写入**先落到设备的库中，再同步上去。server 在读取类工具之前与中枢同步（最多每 10 秒一次），每次写入后也会立即同步，而且为了等待中枢而推迟回答的时间不会超过超时时限。对于设备没有的条目或事件，`correct` 和 `forget` 会在中枢上执行；连不上中枢时，它们会失败并给出清楚的错误说明。
- **引导。** server 的 MCP `instructions` 会告诉 Agent 何时检索、何时记住（带理由的决定、稳定的事实、偏好），以及 `forget` 需要明确的请求。
- **错误。** 无效输入、未知 id 和已遗忘的 id 会以工具错误的形式返回，并附带可读的说明。

## 个人中枢 {#personal-hub}

中枢就是一个普通的 Origin 库，只是额外运行了 `origin serve`。它是自托管、单租户的：一个人，以及这个人的设备和 Agent。中枢中没有任何部分依赖特定的托管服务商；发布的容器镜像 `ghcr.io/openlinkos/origin` 可以在任何地方运行它。

### 角色 {#roles}

每个库都是一个副本；中枢是那个始终在线的副本。

- **设备**：任何有 Agent 会话记录的机器。它的库本身就是完整的：它在本地采集（适配器、原始镜像、游标、改写代次、压缩都保持不变），它的 Agent 读写这个库，离线时也照常工作。接入中枢后，它把自己写下的内容发送给中枢（`origin sync`，以及运行中的 `origin mcp`），并通过中枢读取其他库中的内容。
- **中枢**：`origin serve` 为 Agent 提供基于 HTTP 的 MCP，为设备提供复制 API，启用后还为它的主人提供一个管理界面。它保存每台设备发来的内容，以及云端 Agent 直接写入它的内容，所以在那里能找到一切。

### 复制：原始镜像、条目和遗忘记录上行，遗忘记录下行 {#replication-raw-mirrors-entries-and-tombstones-up-tombstones-down}

设备把自己写下的内容发送给中枢；中枢发给设备的只有被遗忘的内容。一次同步（已接入中枢的设备上的 `origin sync`）按顺序分三步进行：

1. **原始镜像。** 设备推送的是**原始镜像字节**，而不是解析后的事件。中枢把它们存为自己的只追加镜像，并用同样的适配器解析，因此溯源（不变量 1）在中枢上同样成立，解析器的修复也会在所有地方生效。事件 id 在每个库中都完全相同。
   - 每个远程文件以 `(source, "@<device>:<original path>", generation)` 为键；本地路径永远不会以 `@` 开头。中枢上的镜像位于 `raw/devices/<device>/<source>/<relPath>[.g<n>]`。
   - 推送可续传且幂等：设备先向中枢查询游标，再把每个镜像的 `[cursor, local size)` 区间按完整行分块发送（每块最多 1 MiB，或者单独一个更长的行）。偏移量与中枢游标不一致的块会被拒绝，并返回当前游标，设备从那里继续。
2. **条目和遗忘记录上行。** 设备按照自己 `change_log` 的顺序，发送推送游标之后它自己写下的条目和遗忘记录（也就是 `origin` 为它的名称的那些）。它已经遗忘的条目永远不会被发送。中枢以相同的 id 保存它们，保留作者和 origin，并按[遗忘](#forgetting)中的规则应用这些遗忘记录，所以一个到达时已属于被遗忘内容的版本或条目，会在到达时就被遗忘。由于设备先推送镜像，它的条目所引用的事件通常已经在中枢上了；如果某个条目引用的事件或它取代的版本还不在中枢上，中枢会说明缺少哪些 id，推送游标停在这个条目之前，之后的条目等到下一次同步。遗忘记录照样发送：遗忘从不等待。
3. **遗忘记录下行。** 设备请求中枢 `change_log` 中位于自己拉取游标之后的遗忘记录；中枢会略去该设备自己创建的那些，并附上每条记录在中枢上的当前影响一起发送。设备把它们应用到自己的库中，从而让遗忘到达每一个副本（不变量 2）。当一条遗忘记录在中枢上的影响后来扩大了——因为中枢把它应用到了设备没有的数据上，或者因为到达了它所覆盖的纠正或条目——中枢会再次记录它，于是每台设备，包括创建它的那台，都会收到扩大后的影响。

- **只有遗忘记录下行。** 中枢从不把条目或事件发给设备：设备的库只保存它自己的会话、它自己的条目，以及与之相关的遗忘记录。
- **每个条目只有一个裁决者。** 设备应用来自中枢的遗忘记录时，只对中枢还没有收到的条目判断规则 3（不再有可见来源）。对其余条目，中枢持有每一个版本，它的裁决作为遗忘记录影响的一部分到达，所以设备和中枢对它们都有的条目永远不会产生分歧。
- **游标。** 设备在 `setting` 中为每个中枢 URL 保存两个游标：自己的变更推送到了哪里，以及中枢的变更拉取到了哪里。每次请求成功后都会保存游标，所以中断的同步会从中断处继续，再次运行则什么也不会发送。
- 在中枢上被遗忘的事件即使被再次推送，也会保持排除，因为排除按事件 id 生效。

### 访问 {#access}

- 发往 `/mcp` 和 `/v1/*` 的每个请求都需要 `Authorization: Bearer <token>`；`/admin` 下的管理界面有自己的登录（见[管理界面](#admin-ui)）。令牌在中枢上创建（`origin token create <name>`），只显示一次，只以 SHA-256 哈希的形式存储，并且可以吊销。每台设备或每个云端 Agent 各用自己的令牌。
- 中枢使用明文 HTTP。在 localhost 之外开放之前，请把它放在 TLS（反向代理或 CDN）之后。
- 设备推送上来的条目保留写入时的作者。通过中枢的 `/mcp` 写入的条目，如果是设备上的 `origin mcp` 报上了它的 Agent 和它自己（请求头 `X-Origin-Client` 和 `X-Origin-Device`），作者记为 `<agent>@<device>`；否则记为 Agent 加令牌名称，例如云端 Agent 的 `claude-code@ci`。

### HTTP 接口 {#http-interface}

| 方法与路径 | 用途 |
|---|---|
| `GET /healthz` | `{ "ok": true, "version": … }`，无需鉴权 |
| `POST /mcp` | MCP Streamable HTTP，无状态，JSON 响应；与 stdio server 相同的七个工具 |
| `GET /v1/cursors?device=<name>` | 该设备每个文件在中枢上的字节游标 |
| `POST /v1/ingest` | 追加一个块：JSON `{ device, source, path, relPath, generation, offset, mtimeMs, agentVersion, data }`，其中 `data` 为 base64；请求体可以使用 gzip 编码。返回 `200 { bytes, eventsAdded, … }`，偏移量不匹配时返回 `409 { bytes }` |
| `POST /v1/entries` | `{ device, entries }`，最多 1,000 个条目，每个为 `{ id, kind, text, confidence, author, project, supersedes, validFrom, validTo, createdAt, origin, sources: [{ eventId, quote }] }`，其 `origin` 必须等于 `device`。按顺序保存；返回 `200 { applied, pending }`，其中 `pending` 为 null，或者是第一个所引用事件或所取代版本尚不在中枢上的条目的 `{ id, missing }`（它之后的条目都不会被保存）。同一个 id 下内容不同时返回 `409` |
| `POST /v1/tombstones` | `{ device, tombstones }`，最多 1,000 条遗忘记录，每条为 `{ id, target, reason, createdAt, origin, entries, events }`，附带它在设备上的影响，其 `origin` 必须等于 `device`。按[遗忘](#forgetting)中的规则应用；返回 `200 { applied }`，同一个 id 下内容不同时返回 `409` |
| `GET /v1/tombstones?after=<seq>&device=<name>` | `{ tombstones, next, more }`：中枢变更日志中序号大于 `after` 的遗忘记录，不含该设备自己创建的，每条都附带 id、目标、原因、`createdAt`、origin，以及它在中枢上遗忘的条目和排除的事件。`more` 为 true 时，用 `after=<next>` 继续 |
| `GET`, `POST /admin/…` | 启用时的管理界面：需要管理员登录的服务器端渲染页面。未启用时返回 404 |
| `GET`, `POST /admin/api/…` | 管理界面的 JSON API：与页面相同的操作、会话和检查 |

中枢会校验每个字段：设备名必须匹配 `[a-z0-9][a-z0-9._-]{0,62}`，并且不能是中枢自己的名称，来源必须是已知的适配器，`relPath` 必须是相对路径且不含 `..` 段，因此设备永远无法写到它的镜像目录之外。

### 从设备使用中枢 {#using-a-hub-from-a-device}

- `origin hub connect <url> --token <token> [--device <name>]` 把连接信息保存在 `<ORIGIN_HOME>/hub.json` 中。设备名就是它的库的名称（见[存储](#storage)）；`--device` 可以给一个还没有写入任何条目或遗忘记录的库改名。`ORIGIN_HUB_URL` 和 `ORIGIN_HUB_TOKEN` 会覆盖保存的连接信息。
- 配置了中枢之后，`origin mcp` 仍然根据设备自己的库提供服务，并合并中枢的回答（见 [MCP server](#mcp-server)）。它在运行中与中枢同步：读取类工具之前最多每 10 秒一次，每次写入后立即同步，而且等待中枢的时间不会超过超时时限。Agent 的注册无需改动，Agent 也仍然能引用刚刚说过的内容。
- 没有本地记录的云端 Agent 直接用 bearer 令牌注册中枢的 `/mcp` URL。
- CLI 管理命令（`entries`、`show`、`correct`、`forget` 等）作用于设备自己的库。在已接入中枢的设备上，`correct` 和 `forget` 之后会与中枢同步，所以改动会到达中枢；如果是遗忘，还会到达其他每台设备。中枢的管理界面会显示所有设备的条目。

### 管理界面 {#admin-ui}

中枢可以为它的主人提供一个 Web 界面。它默认关闭；它是同一个库的一个视图，而不是另一套系统：每个页面、每次 JSON 调用都经过 MCP 和 CLI 所用的同一组 core 操作（不变量 5）。`@openlinkos/origin-admin` 包提供一个请求处理函数，由中枢挂载。

- **提供方式。** `origin serve --admin` 把界面挂载在中枢端口的 `/admin` 下；`origin serve --admin-listen 127.0.0.1:7078` 则改在一个单独的监听地址上提供，通过 SSH 隧道或 `kubectl port-forward` 访问。如果界面会在非回环地址上提供，除非 `--public-url`（`ORIGIN_PUBLIC_URL`）是 https URL，或者是回环主机上的 http URL（例如发布在 `127.0.0.1` 上的容器端口），否则中枢拒绝启动。没有公开 URL 时，界面只响应发往回环主机名的回环连接，这同时也能防御 DNS 重绑定。界面未启用时，`/admin` 返回 404。
- **登录。** 每个中枢只有一个管理密码，没有用户名。设置了 `ORIGIN_ADMIN_PASSWORD` 时，它就是管理密码，并且优先于其他来源；它至少要有 10 个字符，否则中枢拒绝启动。否则，管理密码在中枢上用 `origin admin password` 设置（在终端中输入两次，或从标准输入读取一行），或用 `origin admin password --generate` 生成。如果中枢在启用管理界面的情况下启动时两者都没有，它会生成一个密码（20 个随机 base32 字符，100 位），保存它的哈希，并在日志中只打印这一次。没有首次访问时的设置向导，所以新建的中枢不会被第一个访问到它的人占用。密码以 scrypt 哈希的形式（N = 2^15、r = 8、p = 3，随机的 16 字节盐）写成 `scrypt$N$r$p$<salt>$<hash>`，保存在只留在中枢上的 `setting` 中；中枢也会保存 `ORIGIN_ADMIN_PASSWORD` 的这种哈希，以便发现它是否变化。校验逐个进行，并以恒定时间比较。管理密码和中枢令牌互不接受：密码不能以 `ogn_` 开头，`/mcp` 和 `/v1/*` 只接受 bearer 令牌，`/admin` 只接受它自己的会话 cookie。
- **会话。** 会话保存在服务器端的 `admin_session` 中，以会话 id 的哈希为键。会话在 30 分钟没有请求或登录满 12 小时后结束；管理密码变化时，所有会话都会结束：用 `origin admin password` 设置新密码时，以及中枢启动时 `ORIGIN_ADMIN_PASSWORD` 与上次不同，或者在它和保存的密码之间切换时。在 https 公开 URL 之后，cookie 是 `__Host-origin-admin`（Secure、HttpOnly、SameSite=Lax）；在回环 http 上，cookie 是 `origin-admin`（HttpOnly、SameSite=Strict，路径 `/admin`）。在 https 公开 URL 之后，普通 cookie 只在回环隧道上有效，所以从兄弟子域名种下的 cookie 无法固定会话。创建或吊销令牌、遗忘、结束会话，要求最近 10 分钟内输入过密码。
- **请求。** 只有 GET 和 POST，所有写操作都是 POST。POST 需要会话的 CSRF 令牌（表单字段 `_csrf` 或请求头 `X-CSRF-Token`），以及与中枢源相同的 `Origin` 请求头；带有 `Sec-Fetch-Site: cross-site` 的请求会被拒绝。请求体上限为 64 KiB。密码校验失败的次数受到限制：每个客户端每 10 分钟 10 次，总计每 10 分钟 100 次（返回 429 和 `Retry-After`）；只有设置了 `ORIGIN_CLIENT_IP_HEADER` 时才从该请求头取客户端地址，否则取连接的地址。在代理或 CDN 之后，必须设置这个请求头：否则所有客户端共用代理的地址和同一个限额，任何人的失败尝试都可能把主人锁在外面。
- **响应。** 页面在服务器端由一个对每个插值都做转义的模板渲染；一小段脚本提供一些便利，例如就地加载原始行，但没有页面依赖它。每个响应都带有严格的 Content-Security-Policy（没有内联脚本或样式，启用 Trusted Types 且不允许任何策略）、`Cache-Control: no-store, private`、`Vary: Cookie`，以及防止嵌入、类型嗅探、引用来源泄露和被搜索引擎收录的请求头；在 https 之后还带有 HSTS。所有资源，包括设计系统的样式表、字体和图标，都由中枢自己以带内容哈希的文件名提供；每个页面只内联它用到的图标符号，界面从不发起外部请求。
- **能做什么。** 概览（数量统计、设备及其最近推送、存储、解析错误）、令牌（创建：令牌只显示一次，旁边附有现成的接入命令；吊销）、设备、时间线、会话、带溯源链的事件（原始行按需加载，截断到 4,000 个字符；工具事件默认隐藏）、检索、条目及其历史、`correct`（未指定时置信度为 1）、从事件页面 `remember`（引用该事件，作者为 `user@` 加中枢的名称），以及预览之后的 `forget`：请求带上所展示计划的摘要，并再次输入 id；如果计划在此期间发生了变化，就不会遗忘任何内容（409）。
- **不能做什么。** 编辑或删除事件、原始镜像、条目或遗忘记录；撤销遗忘；显示被遗忘内容的任何文本（遗忘记录只保存目标 id、填写的原因和被移除内容的 id；审计日志只保存 id 和数量）；保存没有可见来源的条目；再次显示令牌；修改管理密码或其他安全设置；执行任意查询，或读取可见事件的镜像行以外的任何文件。
- **审计日志。** 来自界面的登录和失败尝试（每个客户端在每个时间窗口内合并为一条记录）、令牌变更、写入的条目、遗忘操作和被结束的会话（操作者 `owner`），来自 CLI 的令牌和密码变更（操作者 `cli`），以及中枢启动时生成或变更的密码（操作者 `hub`），都会连同渠道、客户端地址和 user agent 一起追加到 `audit_log`。详情只含 id 和数量，从不包含文本或密码，因此遗忘保持粘性；触发器拒绝任何更新和删除。

## 待解决的问题 {#open-questions}

- **低成本的认知。** 如何在没有专门抽取流水线的情况下，构建并维护一个关于这个人的模型？目前由 Agent 在注意到某些东西时自行写入认知条目。这是否足够，仍是一个悬而未决的问题。
- **与原生记忆互通。** Claude Code、ZCode 和 Grok Build 都维护一个 `MEMORY.md` 索引，外加每条记忆一个 Markdown 文件。与这种布局的双向导入 / 导出已在计划中，但尚未设计。
- **变更通知。** 文件监听在某些平台上并不可靠。MCP server 按需同步，CLI 则在运行 `origin sync` 时同步；可能仍然需要一个由定期全量扫描兜底的后台监听器，尤其是为了同步 Agent 闲置的设备。
- **小磁盘的中继模式。** 空间不多的设备可以只保留尚未发送的内容，其余一切都通过中枢读取。这样它就不再是一份独立完整的记忆，所以需要单独设计。
- **中枢的存储后端。** 中枢把原始镜像保存在自己的磁盘上，其余一切保存在 SQLite 中。对于一块磁盘装不下的中枢，原始镜像可以迁到对象存储，库也可以选择改用 PostgreSQL。

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
