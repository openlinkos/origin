# Connect your agents

Every agent launches the same stdio server, `origin mcp`, which `npm install -g @openlinkos/origin` puts on your `PATH`. On Windows, npm installs `origin` as a `.cmd` script that agents cannot start directly; register `cmd /c origin mcp` instead, for example `claude mcp add --scope user origin -- cmd /c origin mcp` (in Git Bash, prefix it with `MSYS_NO_PATHCONV=1`, or Git Bash turns `/c` into `C:/`). Register Origin globally, not per project, so that all projects share one memory.

| Agent | Sessions archived | Can use Origin over MCP | Setup verified |
|---|---|---|---|
| Claude Code | ✅ | ✅ | End to end |
| Codex CLI | ✅ | ✅ | Registration |
| Cursor | ✅ | ✅ | Per Cursor's docs |
| ZCode | ✅ | ✅ | Per ZCode's docs |
| Grok Build | ✅ | ✅ | Registration |

Other programs, such as another agent runtime, a chat bot, or a notes pipeline, can bring their sessions too, by writing event lines; see [Bring your own source](./sources.md). OpenClaw has a plugin that writes them for it: see [Connect OpenClaw](./openclaw.md).

## Connect them all at once

`origin agents` shows the agents installed on this machine and how each is connected. `origin agents connect` registers Origin's MCP server with each of them, and adds two kinds of hooks to Claude Code and Codex: the [recall](./recall.md) hooks, which hand the agent what matters when a session starts and with each prompt, and the ingest hooks, which hand Origin a session's new lines as each turn ends, in the background, so that other sessions, and your hub, see them right away. It shows what it would change, and changes it only with `--yes`, backing up each file next to it first; it adds and removes only Origin's own entries, and `origin agents disconnect` removes them again. Name agents to connect only those, such as `origin agents connect codex`. On a machine you connected with an earlier version, run it again to add the hooks it lacks.

Start a new session of each agent afterwards. Codex runs a new hook, or one that changed, only once you trust it: open `/hooks` in Codex, review Origin's hooks, and trust them; until then Codex skips them and warns when it starts.

```console
$ origin agents connect
origin agents connect would:
  codex: register the MCP server in /home/dana/.codex/config.toml
  codex: add the recall hooks (SessionStart, UserPromptSubmit) to /home/dana/.codex/hooks.json
  codex: add the ingest hooks (Stop, SubagentStop) to /home/dana/.codex/hooks.json
  cursor: register the MCP server in /home/dana/.cursor/mcp.json

Run again with --yes to make these changes; each file is backed up next to it first.
```

Claude Code gets its ingest hooks at `Stop`, `SubagentStop`, and `PostCompact`, and Codex at `Stop` and `SubagentStop`; [Recall](./recall.md#set-up-the-hooks) shows them as they are written. Cursor, ZCode, and Grok Build get no hooks: their new lines are picked up by `origin mcp` every minute while they run, and by `origin sync`.

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
| `timeline` | Sessions in a time range, or the messages of one session, a turn or a page at a time |
| `changes` | What reached the store since the agent last looked: sessions, events, entries, and forgets, a page at a time |
| `get` | Any id Origin hands over, with what is next to it: an entry with its sources and history, an event with its text and neighbours, a session with its turns and the entries written from it, a thread with its sessions, or a recall with what it handed over |
| `sources` | The original log lines behind an entry or event |
| `follow` | Join the agent's session to the earlier session or thread it continues, so that the work reads as one [thread](./concepts.md#threads) |
| `remember` | Save an entry (`memory`, `knowledge`, or `cognition`) that cites its sources |
| `correct` | Replace an entry with a corrected version |
| `forget` | Hide an entry or event on every store, with your reason; agents only use it when you ask, and only you can restore it |

The server tells agents how to use these tools, so you can simply ask questions in plain language. It syncs new session lines before answering, so an agent can even cite what you said a minute ago. Claude Code's and Codex's ingest hooks hand Origin each turn's new lines as the turn ends; as a fallback, and for the other agents, Origin also picks up new lines every minute in the background while an agent runs, and once more when the agent exits. The tools are specified in [Architecture](../architecture.md#mcp-server). Origin also hands agents what matters where they work: Claude Code through its hooks, at the start of each session and with each prompt, and other agents through `brief`; see [Recall](./recall.md).

## Using a personal hub

If you use agents on several machines, or cloud agents, you can run a [personal hub](./hub.md):

- On a device that is connected to the hub, the local `origin mcp` registrations above keep working. The server answers from the device's own store, adds the hub's answers, and syncs what agents save to the hub.
- Agents without local session logs, such as one on a cloud machine, register the hub's `/mcp` URL directly. Claude Code and Codex sign in to it with OAuth, through your browser, when the hub serves its [admin UI](./admin.md) at `/admin`; other agents use a token.

### Sign in with OAuth

Claude Code:

```bash
claude mcp add --scope user --transport http origin https://hub.example.com/mcp
claude mcp login origin
```

`claude mcp add` saves the hub without signing in. Sign in from the shell with `claude mcp login origin`, which opens the hub in your browser, or inside Claude Code: run `/mcp` and choose `origin`. On a machine without a browser, such as over SSH, `claude mcp login origin --no-browser` prints the link instead: open it on your own computer, then paste back the address your browser ends up at (connect with `ssh -t`, since pasting needs a terminal).

Codex CLI:

```bash
codex mcp add origin --url https://hub.example.com/mcp
codex mcp login origin
```

In the browser, sign in to your hub's admin UI if you have not yet, and the hub asks whether to allow the agent. It shows the agent's name, where your browser returns afterwards (`localhost` and a port, for an agent on your computer), and lets you choose what the agent may do, read and write or read only, and for how long, from 1 to 365 days. Allow it, and the agent receives its tokens: an access token for an hour, which it renews with a refresh token until the time you chose. The agent appears on the admin UI's **Devices and agents** page under its name, such as `claude-code`, where you can revoke it at any time, and what it writes is recorded with that name as author. `claude mcp logout origin` signs Claude Code out on the hub too; `claude mcp remove origin` alone only forgets the hub in Claude Code, so revoke the agent on the hub as well.

Both agents find out how to sign in by themselves: the hub's answer to a request without a token points them to its OAuth metadata (the MCP authorization specification, with PKCE). Claude Code describes itself by a document at claude.ai, and Codex by one at chatgpt.com, which the hub fetches over https, so the hub needs to reach them; agents without such a document register with the hub instead. Claude Code signs in to a hub at a plain `http://` address only on `localhost` or `127.0.0.1`; serve the hub over https everywhere else.

### Use a token

For an agent that cannot open a browser, such as one in CI, or for a hub without the admin UI at `/admin`, add an agent with a token on the hub (**Add an agent** in the admin UI, or `origin token create ci --agent`, with `--readonly` for one that only reads; see [Devices and agents](./hub.md#devices-and-agents)), and give it the token:

```bash
# Claude Code
claude mcp add --scope user --transport http origin https://hub.example.com/mcp --header "Authorization: Bearer ogn_…"

# Codex CLI, with the token in an environment variable
export ORIGIN_TOKEN=ogn_…
codex mcp add origin --url https://hub.example.com/mcp --bearer-token-env-var ORIGIN_TOKEN
```

The admin UI shows these commands with the token in them when you add the agent. An agent that only reads sees only the tools that read.

## After updating Origin

Agents start the installed `origin`. After `npm install -g @openlinkos/origin@latest`, restart running agent sessions so that they pick up the new version. If you run Origin from a checkout instead, restart them after `pnpm build`.
