# Privacy and your data

Agent session logs often contain source code, file contents, command output, and anything you typed into a prompt — sometimes including secrets. Origin copies these logs so that they survive the agents' own cleanup. This page explains what it stores and how to remove it.

## What Origin stores

Everything lives in one directory, `~/.origin` (or `ORIGIN_HOME`):

- `origin.db`: a SQLite database with the normalized events, their search index, your entries, and the record of everything you forgot.
- `raw/`: append-only copies of the original session log files.

Origin makes no network connections, sends nothing anywhere, and never calls an LLM API. The directory is not encrypted, so protect it the way you would protect the original logs.

## Forgetting

`origin forget <id>` (or the agent's `forget` tool, used only when you ask) is permanent:

1. **Forgetting an entry** forgets every version of it and hides the events it cites.
2. **Forgetting an event** hides it and forgets every entry that cites it.
3. **An entry left with no visible source** is forgotten too.

Forgotten entries and events disappear from search, timelines, and every MCP tool, and can never be cited again, even after re-syncing. For example, use `origin forget <event-id>` on a prompt where you pasted a secret.

Forgetting **hides**; it does not erase. The raw mirror files under `~/.origin/raw/` still contain the original lines, because the archive is append-only.

## Removing everything

Delete `~/.origin` (or your `ORIGIN_HOME`). Origin keeps nothing anywhere else. Also remove the MCP registration from your agents (for Claude Code: `claude mcp remove --scope user origin`).

## Reporting a problem

If you find a way Origin could leak, expose, or corrupt your data, please report it privately as described in the [security policy](https://github.com/openlinkos/origin/blob/master/SECURITY.md).
