# Connect your agents

Every agent launches the same stdio server, `origin mcp`, which `npm install -g @openlinkos/origin` puts on your `PATH`. On Windows, npm installs `origin` as a `.cmd` script that agents cannot start directly; register `cmd /c origin mcp` instead, for example `claude mcp add --scope user origin -- cmd /c origin mcp` (in Git Bash, prefix it with `MSYS_NO_PATHCONV=1`, or Git Bash turns `/c` into `C:/`). Register Origin globally, not per project, so that all projects share one memory.

| Agent | Sessions archived | Can use Origin over MCP | Setup verified |
|---|---|---|---|
| Claude Code | ✅ | ✅ | End to end |
| Codex CLI | ✅ | ✅ | Registration |
| Cursor | Planned | ✅ | Per Cursor's docs |
| ZCode | Planned | ✅ | Per ZCode's docs |
| Grok Build | Planned | ✅ | Per Grok's docs |

## Claude Code

```bash
claude mcp add --scope user origin -- origin mcp
claude mcp list
```

## Codex CLI

```bash
codex mcp add origin -- origin mcp
```

This writes the following to `~/.codex/config.toml`:

```toml
[mcp_servers.origin]
command = "origin"
args = ["mcp"]
```

## Cursor

`~/.cursor/mcp.json` is shared by the editor and the CLI:

```json
{
  "mcpServers": {
    "origin": { "command": "origin", "args": ["mcp"] }
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

The server tells agents how to use these tools, so you can simply ask questions in plain language. It syncs new session lines before answering, so an agent can even cite what you said a minute ago. While an agent runs, Origin also picks up new lines every minute in the background, and once more when the agent exits. The tools are specified in [Architecture](../architecture.md#mcp-server).

## Using a personal hub

If you use agents on several machines, or cloud agents, you can run a [personal hub](./hub.md):

- On a device that is connected to the hub, the local `origin mcp` registrations above keep working. The server answers from the device's own store, adds the hub's answers, and syncs what agents save to the hub.
- Cloud agents, which have no local session logs, register the hub's `/mcp` URL directly with their own token. For example, in Claude Code: `claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"`.

## After updating Origin

Agents start the installed `origin`. After `npm install -g @openlinkos/origin@latest`, restart running agent sessions so that they pick up the new version. If you run Origin from a checkout instead, restart them after `pnpm build`.
