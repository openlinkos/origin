# Recall

When a session starts, and with each prompt you send, Origin can hand your agent what it already knows that matters there: a short brief of your preferences, the project's decisions and facts, and its latest sessions with any of your agents; then the entries your prompt is about. It works through the agent's hooks, calls no model, and records every time it hands something over, so you can see what an agent was given and whether it used it.

Claude Code and Codex get recall through their hooks. Other agents ask for it through Origin's MCP server (see [Other agents](#other-agents)).

## What an agent is handed

- **When a session starts**, a brief: your preferences and boundaries for this project and those that hold everywhere, this project's latest decisions and facts, and its latest sessions with any agent in the last 30 days.
- **With each prompt**, the entries whose first line shares rare enough words with it, at most five, leaving out what the session was already handed.

Each item is one line, an id and the start of the entry, so a brief stays under about 800 tokens and a prompt's matches under 400. The agent asks Origin's `get` for the rest. For example, at the start of a session:

```text
Origin recall rcl_3f9a0c1d2e4b: a brief from the user's cross-agent memory (project acme), one line each. Call Origin's `get` with an entry id for its full text and sources, or `timeline` with a session id to read that session. Entries can be outdated; the user's words in this session come first.

The user's preferences and boundaries:
- ent_5f0c2a9e41b7 Run the full test suite before pushing; never skip CI on both platforms

Project acme:
- ent_8e21b4c0d9f3 (2026-10-20) The API keeps v1 routes until every client has moved to v2

Latest sessions in acme, any agent (source, time, session id):
- codex 2026-10-27 18:02 0199a1b2-7c3d-4e5f-8a6b-9c0d1e2f3a4b: Migrate the billing client to v2; last prompt: run the integration tests again
```

## Set up the hooks

`origin agents connect` adds them, with Origin's MCP server, to every agent installed that takes them: it shows what it would change, and changes it with `--yes`, backing up each file first (see [Connect your agents](./connect-agents.md#connect-them-all-at-once)). Start a new session of each agent afterwards; Codex runs new hooks only once you trust them, with `/hooks`.

To add them by hand, put two hooks in `~/.claude/settings.json` for Claude Code, or in `~/.codex/hooks.json` for Codex with `codex` in place of `claude-code`, next to any hooks you already have:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ]
  }
}
```

`/hooks` in either agent lists them. Keep Origin registered as an MCP server too, so that the agent can `get` what it is handed. The hook takes a fraction of a second; if anything goes wrong, it hands nothing over and the agent carries on.

## Other agents

Agents whose hooks cannot hand anything over, Grok Build, ZCode, and Cursor, ask for a brief themselves: Origin's MCP server has a `brief` tool, and its instructions tell agents to call it with their working directory when they start a task. They get the same brief, and with `about`, the entries that match the task (see [MCP tools](./mcp.md#brief)). No setup is needed beyond [registering Origin](./connect-agents.md). Such a recall is recorded like a hook's; its session is found later, from the recall's id in the agent's log.

## Preview

`origin recall` shows what an agent would be handed in the current directory, and records nothing:

```sh
origin recall                                        # the brief a new session here would get
origin recall --prompt "should we drop the v1 routes?"
origin recall --agent claude-code --cwd ~/code/acme  # as Claude Code would get it, without its own memories
```

## See what was handed over

`origin recalls` lists what agents were handed, newest first; `--all` also lists the recalls that handed nothing over, such as prompts that matched no entry. `origin show` shows one recall: the prompt it answered, once the session is archived, and each item with whether the session went on to use it, that is, whether the agent mentioned its id in a later tool call or reply.

```console
$ origin show rcl_7d2e9a0b1c3f
Recall      rcl_7d2e9a0b1c3f
Time        2026-10-28 10:15, at a prompt
Agent       claude-code, session 4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
Project     acme (/home/dana/code/acme)
Device      laptop
Prompt      should we drop the v1 routes?
            ↳ claude-code:5b2d7e1a-3c4f-4d6e-8f9a-0b1c2d3e4f5a
Tokens      about 96 of 400

Handed over, 1 item used since:
  1. prompt, score 9.84, used  ent_8e21b4c0d9f3
     The API keeps v1 routes until every client has moved to v2
```

The admin UI shows the same on its Recalls page, and marks each recall in its turn on the session's page and on the page of each entry it handed over; a device sends its recalls to its hub when it syncs, so the hub's admin UI shows every device's. A recall keeps only ids, scores, and a hash of the prompt, never text: what an item was is read from your store when you look, so an entry you have forgotten since shows as forgotten.

## How it chooses

- **The project** is the git work tree you are in, or the directory itself outside one. Memory and knowledge of other projects are never handed over. Two checkouts with the same name are told apart by their directories.
- **Your preferences** of other projects are not in a brief, since a memory written in one project rarely says whether it holds elsewhere, but a prompt that matches one brings it. An entry with no project is in every brief, so give an entry no project when it holds everywhere.
- **An agent's own memories** of the project, imported from its memory files, are not handed back to it: it loads them itself. Other agents get them.
- **Matching** looks for the words of your prompt in the first line of each entry, weighing each word by how rarely you use it in your own prompts, so the words you use all the time count for little. It finds entries that use your words, not ones that say the same thing differently.

The rules are described in [Architecture](../architecture.md#recall).

## Limits

- Recall reads this device's store only: entries written on your other devices are not recalled yet. On a relay, hooks hand nothing over, and `brief` is answered by the hub.
- What recall hands over enters the agent's conversation, as anything the agent reads does, and stays in the agent's own session log. Forgetting an entry later keeps it out of every later recall, not out of conversations that already had it.
