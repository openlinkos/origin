# Connect your agents

Every agent launches the same stdio server, `origin mcp`, which `npm install -g @openlinkos/origin` puts on your `PATH`. On Windows, npm installs `origin` as a `.cmd` script that agents cannot start directly; register `cmd /c origin mcp` instead, for example `claude mcp add --scope user origin -- cmd /c origin mcp` (in Git Bash, prefix it with `MSYS_NO_PATHCONV=1`, or Git Bash turns `/c` into `C:/`). Register Origin globally, not per project, so that all projects share one memory.

| Agent | Sessions archived | Can use Origin over MCP | Setup verified |
|---|---|---|---|
| Claude Code | ✅ | ✅ | End to end |
| Codex CLI | ✅ | ✅ | Registration |
| Cursor | ✅ | ✅ | Per Cursor's docs |
| ZCode | ✅ | ✅ | Per ZCode's docs |
| Grok Build | ✅ | ✅ | Registration |

## Connect them all at once

`origin agents` shows the agents installed on this machine and how each is connected. `origin agents connect` registers Origin's MCP server with each of them, and adds the [recall](./recall.md) hooks to Claude Code and Codex. It shows what it would change, and changes it only with `--yes`, backing up each file next to it first; it adds and removes only Origin's own entries, and `origin agents disconnect` removes them again. Name agents to connect only those, such as `origin agents connect codex`. Start a new session of each agent afterwards; Codex runs new hooks only once you trust them, with `/hooks`.

```console
$ origin agents connect
origin agents connect would:
  codex: register the MCP server in /home/dana/.codex/config.toml
  codex: add the recall hooks (SessionStart, UserPromptSubmit) to /home/dana/.codex/hooks.json
  cursor: register the MCP server in /home/dana/.cursor/mcp.json

Run again with --yes to make these changes; each file is backed up next to it first.
```

The sections below show what it writes for each agent, to do it by hand.

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

Grok merges the MCP servers in `~/.claude.json` by default, so the Claude Code registration above is picked up automatically; `grok inspect` lists it (`grok mcp list` shows only Grok's own servers). Otherwise, add an `[mcp_servers.origin]` table to `~/.grok/config.toml` as for Codex.

## What agents can do

| Tool | What it does |
|---|---|
| `brief` | What matters where the agent works: your preferences, the project's decisions and facts, and its latest sessions ([Recall](./recall.md)) |
| `search` | Full-text search over entries and session events, best match first; without a query, lists recent entries |
| `timeline` | Sessions in a time range, or the messages of one session |
| `get` | An entry with its sources and history, or an event with its full text |
| `sources` | The original log lines behind an entry or event |
| `remember` | Save an entry (`memory`, `knowledge`, or `cognition`) that cites its sources |
| `correct` | Replace an entry with a corrected version |
| `forget` | Hide an entry or event on every store, with your reason; agents only use it when you ask, and only you can restore it |

The server tells agents how to use these tools, so you can simply ask questions in plain language. It syncs new session lines before answering, so an agent can even cite what you said a minute ago. While an agent runs, Origin also picks up new lines every minute in the background, and once more when the agent exits. The tools are specified in [Architecture](../architecture.md#mcp-server). Origin also hands agents what matters where they work: Claude Code through its hooks, at the start of each session and with each prompt, and other agents through `brief`; see [Recall](./recall.md).

## Using a personal hub

If you use agents on several machines, or cloud agents, you can run a [personal hub](./hub.md):

- On a device that is connected to the hub, the local `origin mcp` registrations above keep working. The server answers from the device's own store, adds the hub's answers, and syncs what agents save to the hub.
- Cloud agents, which have no local session logs, register the hub's `/mcp` URL directly with their own token. For example, in Claude Code: `claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"`.

## After updating Origin

Agents start the installed `origin`. After `npm install -g @openlinkos/origin@latest`, restart running agent sessions so that they pick up the new version. If you run Origin from a checkout instead, restart them after `pnpm build`.
