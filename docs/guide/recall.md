# Recall

When a session starts, and with each prompt you send, Origin can hand your agent what it already knows that matters there: a short brief of your preferences, the project's decisions and facts, and its latest sessions with any of your agents; then the entries your prompt is about, and what you and your agents said about it in the project's earlier sessions. It works through the agent's hooks, calls no model, and records every time it hands something over, so you can see what an agent was given and whether it used it.

Claude Code and Codex get recall through their hooks. Other agents ask for it through Origin's MCP server (see [Other agents](#other-agents)).

## What an agent is handed

- **When a session starts**, a brief: your preferences and boundaries for this project and those that hold everywhere, this project's latest decisions and facts, and its latest conversations of yours with any agent in the last 30 days, where the sessions of one piece of work, a [thread](./concepts.md#threads), take one line together. A sub-agent's session, a headless run, or a session of other people's words alone is none of your conversations, and is left out.
- **With each prompt**, the entries whose first line shares rare enough words with it, at most five; then the past messages of the project's other sessions that share them, your prompts and your agents' replies, at most three, each from a different session. What the session was already handed is left out.

Each item is one line: an id and the start of the entry, or, for a past message, its event id, agent, day, and who wrote it, with an excerpt around the words it shares with the prompt. So a brief stays under about 800 tokens and a prompt's matches under 600. The agent asks Origin's `get` for the rest: an entry's text and sources, a session's turns and the entries written from it, or a message's full text and the turns around it, each with the ids of what is next to it (see [MCP tools](./mcp.md#get)). For example, at the start of a session:

```text
Origin recall rcl_3f9a0c1d2e4b: a brief from the user's cross-agent memory (project acme), one line each. Origin's `get` opens any id here: an entry for its text and sources, a session or thread for its turns or sessions and what was written there. Entries can be outdated; the user's words in this session come first.

The user's preferences and boundaries:
- ent_5f0c2a9e41b7 Run the full test suite before pushing; never skip CI on both platforms

Project acme:
- ent_8e21b4c0d9f3 (2026-10-20) The API keeps v1 routes until every client has moved to v2

Latest sessions in acme, any agent (source, time, session id):
- thr_9d2a6c4e1b07 (3 sessions: claude-code, codex; 2026-10-24 – 2026-10-27): Migrate the billing client to v2; last prompt: run the integration tests again
- claude-code 2026-10-26 11:40 5e8f0a1b-2c3d-4e5f-9a6b-7c8d9e0f1a2b: Fix the flaky upload test
```

And with a prompt, "should we drop the v1 routes?":

```text
Origin recall rcl_6c1e8d2a4f90: entries and past messages from the user's cross-agent memory that match this prompt, one line each. Origin's `get` opens any id here: an entry for its text and sources, a session or thread for its turns or sessions and what was written there, a message for its full text and the turns around it. Entries and messages can be outdated; the user's words in this session come first.

Matching this prompt:
- ent_8e21b4c0d9f3 (knowledge, 2026-10-20) The API keeps v1 routes until every client has moved to v2

Past messages that match this prompt (agent, day, who):
- codex:019a3b7c-2d4e-7f60-8a1b-9c0d1e2f3a4b:o57 (codex, 2026-10-25, assistant) …the access logs of every client: the v1 routes can be dropped once the mobile app ships 4.2, the last client that still calls /v1/orders.
- claude-code:3e7b1c9d-5a2f-4e8b-b0c6-1d9f2a4e7c38 (claude-code, 2026-10-21, user) keep the v1 routes for now, the mobile app still uses them
```

## Set up the hooks

`origin agents connect` adds them, with Origin's MCP server, to every agent installed that takes them: it shows what it would change, and changes it with `--yes`, backing up each file first (see [Connect your agents](./connect-agents.md#connect-them-all-at-once)). Start a new session of each agent afterwards; Codex runs new hooks only once you trust them, with `/hooks`.

It adds the ingest hooks too, which hand nothing over: when a turn ends, a sub-agent stops, or Claude Code has compacted the conversation, they run `origin sync --hook` in the background, which reads the session's new lines into your store, and sends them on to your hub, so that briefs, searches, and other sessions' `changes` have them a moment later (see [Live ingestion](../architecture.md#live-ingestion)).

To add them by hand, put these hooks in `~/.claude/settings.json` for Claude Code, next to any hooks you already have. For Codex, put them in `~/.codex/hooks.json`, with `codex` in place of `claude-code` and without `PostCompact`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "origin recall --hook claude-code", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "origin sync --hook claude-code", "timeout": 60, "async": true }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "origin sync --hook claude-code", "timeout": 60, "async": true }] }
    ],
    "PostCompact": [
      { "hooks": [{ "type": "command", "command": "origin sync --hook claude-code", "timeout": 60, "async": true }] }
    ]
  }
}
```

`/hooks` in either agent lists them. Keep Origin registered as an MCP server too, so that the agent can `get` what it is handed. A recall hook takes a fraction of a second, and the agent waits for it; an ingest hook runs in the background (`"async": true`), so the agent never waits for it. If anything goes wrong, a hook hands nothing over, ingests nothing, and the agent carries on.

## Other agents

Agents whose hooks cannot hand anything over, Grok Build, ZCode, and Cursor, ask for a brief themselves: Origin's MCP server has a `brief` tool, and its instructions tell agents to call it with their working directory when they start a task. They get the same brief, and with `about`, the entries and past messages that match the task (see [MCP tools](./mcp.md#brief)). No setup is needed beyond [registering Origin](./connect-agents.md). Such a recall is recorded like a hook's; its session is found later, from the recall's id in the agent's log.

## Preview

`origin recall` shows what an agent would be handed in the current directory, and records nothing:

```sh
origin recall                                        # the brief a new session here would get
origin recall --prompt "should we drop the v1 routes?"
origin recall --agent claude-code --cwd ~/code/acme  # as Claude Code would get it, without its own memories
```

## See what was handed over

`origin recalls` lists what agents were handed, newest first; `--all` also lists the recalls that handed nothing over, such as prompts that matched nothing. `origin show` shows one recall: the prompt it answered, once the session is archived, and each item with whether the session went on to use it, that is, whether the agent mentioned its id in a later tool call or reply.

```console
$ origin show rcl_7d2e9a0b1c3f
Recall      rcl_7d2e9a0b1c3f
Time        2026-10-28 10:15, at a prompt
Agent       claude-code, session 4f1c9e2a-7b3d-4e8f-9a6b-2c5d8e1f0a3b
Project     acme (/home/dana/code/acme)
Device      laptop
Prompt      should we drop the v1 routes?
            ↳ claude-code:5b2d7e1a-3c4f-4d6e-8f9a-0b1c2d3e4f5a
Tokens      about 162 of 600

Handed over, 1 item used since:
  1. prompt, score 9.84, used  ent_8e21b4c0d9f3
     The API keeps v1 routes until every client has moved to v2
  2. messages, score 7.12  codex:019a3b7c-2d4e-7f60-8a1b-9c0d1e2f3a4b:o57
     codex, 2026-10-25, assistant: …the access logs of every client: the v1 routes can be dropped once the mobile app ships 4.2, the last client that still calls /v1/orders.
```

The admin UI shows the same on its Recalls page, and marks each recall in its turn on the session's page and on the page of each entry it handed over; a device sends its recalls to its hub when it syncs, so the hub's admin UI shows every device's. A recall keeps only ids, scores, and a hash of the prompt, never text (for a past message, where its excerpt starts): what an item was is read from your store when you look, so an entry or a message you have forgotten since shows as forgotten.

## How it chooses

- **The project** is the git work tree you are in, or the directory itself outside one. Memory and knowledge of other projects are never handed over. Two checkouts with the same name are told apart by their directories.
- **Your preferences** of other projects are not in a brief, since a memory written in one project rarely says whether it holds elsewhere, but a prompt that matches one brings it. An entry with no project is in every brief, so give an entry no project when it holds everywhere.
- **An agent's own memories** of the project, imported from its memory files, are not handed back to it: it loads them itself. Other agents get them.
- **Matching** looks for the words of your prompt in the first line of each entry, weighing each word by how rarely you use it in your own prompts, those you wrote yourself rather than an agent, a program, or someone else, so the words you use all the time count for little. It finds entries that use your words, not ones that say the same thing differently.
- **Past messages** are found through the search index by the six rarest words of your prompt, among the newest messages that hold each, and matched the same way, on their first 2,000 characters. They come only from your conversations in this project, other than the session itself: your own prompts and agents' replies, never a sub-agent's session, a headless run, or other people's words.

The rules are described in [Architecture](../architecture.md#recall).

## Limits

- Recall reads this device's store only: entries written and sessions held on your other devices are not recalled yet. On a relay, hooks hand nothing over, and `brief` is answered by the hub.
- What recall hands over enters the agent's conversation, as anything the agent reads does, and stays in the agent's own session log. Forgetting an entry or a message later keeps it out of every later recall, not out of conversations that already had it.
