# Connect your agents

Every agent launches the same stdio server, `node <repo>/packages/cli/dist/bin.js mcp`. Replace `/path/to/origin` below with the absolute path of your checkout. Register Origin globally, not per project, so that all projects share one memory.

| Agent | Sessions archived | Can use Origin over MCP | Setup verified |
|---|---|---|---|
| Claude Code | ✅ | ✅ | End to end |
| Codex CLI | ✅ | ✅ | Registration |
| Cursor | Planned | ✅ | Per Cursor's docs |
| ZCode | Planned | ✅ | Per ZCode's docs |
| Grok Build | Planned | ✅ | Per Grok's docs |

## Claude Code

```bash
claude mcp add --scope user origin -- node /path/to/origin/packages/cli/dist/bin.js mcp
claude mcp list
```

## Codex CLI

```bash
codex mcp add origin -- node /path/to/origin/packages/cli/dist/bin.js mcp
```

This writes the following to `~/.codex/config.toml`:

```toml
[mcp_servers.origin]
command = "node"
args = ["/path/to/origin/packages/cli/dist/bin.js", "mcp"]
```

## Cursor

`~/.cursor/mcp.json` is shared by the editor and the CLI:

```json
{
  "mcpServers": {
    "origin": { "command": "node", "args": ["/path/to/origin/packages/cli/dist/bin.js", "mcp"] }
  }
}
```

## ZCode

Add the server under `mcp.servers` in `~/.zcode/cli/config.json`, or use ZCode's import of Claude Code or Codex MCP settings.

## Grok Build

Grok reads `~/.claude.json`, so the Claude Code registration above is picked up automatically. Otherwise, add an `[mcp_servers.origin]` table to `~/.grok/config.toml` as for Codex.

## What agents can do

| Tool | What it does |
|---|---|
| `search` | Full-text search over entries and session events, best match first; without a query, lists recent entries |
| `timeline` | Sessions in a time range, or the messages of one session |
| `get` | An entry with its sources and history, or an event with its full text |
| `sources` | The original log lines behind an entry or event |
| `remember` | Save an entry (`memory`, `knowledge`, or `cognition`) that cites its sources |
| `correct` | Replace an entry with a corrected version |
| `forget` | Forget an entry or event for good; agents only use it when you ask |

The server tells agents how to use these tools, so you can simply ask questions in plain language. It syncs new session lines before answering, so an agent can even cite what you said a minute ago. The tools are specified in [Architecture](../architecture.md#mcp-server).

## After updating Origin

Agents start the server from your checkout. After you pull and run `pnpm build`, restart running agent sessions so that they pick up the new version.
