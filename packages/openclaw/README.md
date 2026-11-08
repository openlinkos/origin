# @openlinkos/origin-openclaw

Part of [Origin](https://origin.openlinkos.com), a local-first, cross-agent personal memory for AI coding agents. This package is a plugin for [OpenClaw](https://docs.openclaw.ai): it writes the sessions of a Gateway's agents to Origin as [event lines](https://origin.openlinkos.com/sources#your-own-sources-event-lines), either to your Origin hub or into a directory that an Origin device on the same host reads.

Install it into OpenClaw (checked against OpenClaw 2026.10.6):

```bash
openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities
```

Then configure it under `plugins.entries.origin` in the Gateway's config. The guide covers the options, the hub token, and what then shows in Origin: [Connect OpenClaw](https://origin.openlinkos.com/guide/openclaw).

Each user message is recorded with who wrote it, as OpenClaw records it: `author` is `owner`, `person`, `agent`, or `system`, and `speaker` the sender's name on the channel, or the sending agent's. The owner is whoever OpenClaw's own `commands.ownerAllowFrom` names; the plugin has no setting of its own for it. The sender's facts come from `__openclaw`, a field OpenClaw keeps on its messages without declaring it to plugins, and are checked again with each OpenClaw version. OpenClaw 2026.10.6 keeps them on the copy of a message it persists, not on the copy `agent_end` gives, so the plugin reads them from OpenClaw's transcript updates and pairs each with its message by the session and a hash of the text; a message it cannot pair is recorded as a `person`'s. No sender id is recorded. Without conversation access, the plugin cannot tell the owner's messages apart, and records every message that arrives as a `person`'s. See [Who wrote each message](https://origin.openlinkos.com/guide/openclaw#who-wrote-each-message).

Nothing is redacted: messages, tool calls, and tool results are sent as they were, secrets included. Set `includeTools` to `false` to send no tool calls or results.

With a hub, the plugin also gives the agents it records Origin's read tools: `origin_brief`, `origin_search`, `origin_get`, `origin_timeline`, and `origin_digest`, only in the turns its owner starts: by default (`tools: "owner-turns"`), in any turn whose sender OpenClaw (2026.10.6 or later) names and takes for its owner, in a direct chat, a group, a channel, or a thread, never in a turn someone else starts, nor in cron, heartbeat, or `openclaw agent` runs, nor for a batch of several people's messages. In a shared channel, an answer is posted where its members read it, and other people's messages in its history can steer a turn the owner starts: set `tools` to `"owner-private"` to offer the tools only in the turns OpenClaw resolves as its owner's private memory audience, or to `"off"` for none. Each forwards to the tool of the same name on the hub's MCP endpoint, `/mcp`, with the hub token the plugin delivers with, so the token stays a SecretRef the Gateway resolves rather than a header in OpenClaw's MCP settings. `origin_brief` briefs an agent on the project its sessions are filed under, its agent id by default. See [Read Origin from your agents](https://origin.openlinkos.com/guide/openclaw#read-origin-from-your-agents).

The plugin uses only Node built-ins and follows Origin's version. Design and source: [github.com/openlinkos/origin](https://github.com/openlinkos/origin).

MIT licensed.
