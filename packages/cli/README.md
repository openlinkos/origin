# @openlinkos/origin

The `origin` command of [Origin](https://origin.openlinkos.com): a local-first, cross-agent personal memory for AI coding agents. It archives the sessions Claude Code and Codex write to disk into one store under `~/.origin`, and serves it to every agent over [MCP](https://modelcontextprotocol.io).

```bash
npm install -g @openlinkos/origin   # Node.js 22.16 or later
origin sync                         # archive your agent sessions
claude mcp add --scope user origin -- origin mcp
```

On Windows, agents cannot start npm's `origin.cmd` directly; register `cmd /c origin mcp` instead.
- [Getting started](https://origin.openlinkos.com/guide/getting-started)
- [Connect your agents](https://origin.openlinkos.com/guide/connect-agents)
- [Personal hub](https://origin.openlinkos.com/guide/hub) for several machines and cloud agents
- [Source and issues](https://github.com/openlinkos/origin)

MIT licensed.
