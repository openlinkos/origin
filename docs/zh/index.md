---
sourceHash: sha256-58b60cec
layout: home

hero:
  name: Origin
  text: 所有 AI Agent 共享的一份记忆
  tagline: 本地优先、跨 Agent 的个人记忆。Origin 归档你的 Agent 会话并支持检索，让每个 Agent 都能回答你决定过什么、为什么，并给出来源。
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: Origin
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 工作原理
      link: /zh/architecture

features:
  - title: 跨 Agent、跨机器的同一份记忆
    details: 归档 Claude Code、Codex、Cursor、Grok Build 与 ZCode 的会话。自托管的个人中枢把你所有的机器和云端 Agent 接入同一份记忆。
  - title: 默认可溯源
    details: 每个回答都能追溯到原始会话记录中的具体一行。
  - title: 不怕清理
    details: 会话记录只追加地镜像保存，比各 Agent 自己的保留期更长久。
  - title: 可纠正、可遗忘
    details: 错误的条目可以纠正；遗忘后的条目和消息不会再出现，也不能再被引用。
  - title: 你的数据，留在你的机器上
    details: 数据只存放在你控制的机器上：你的设备，以及可选的自建中枢。Origin 从不调用第三方服务，也不调用任何 LLM API。
  - title: 开源
    details: 采用 MIT 许可证的 TypeScript 项目，基于 SQLite 与 Model Context Protocol。
---
