# @openlinkos/origin-openclaw

Part of [Origin](https://origin.openlinkos.com), a local-first, cross-agent personal memory for AI coding agents. This package is a plugin for [OpenClaw](https://docs.openclaw.ai): it writes the sessions of a Gateway's agents to Origin as [event lines](https://origin.openlinkos.com/sources#your-own-sources-event-lines), either to your Origin hub or into a directory that an Origin device on the same host reads.

Install it into OpenClaw (checked against OpenClaw 2026.10.6):

```bash
openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities
```

Then configure it under `plugins.entries.origin` in the Gateway's config. The guide covers the options, the hub token, and what then shows in Origin: [Connect OpenClaw](https://origin.openlinkos.com/guide/openclaw).

Each user message is recorded with who wrote it, as OpenClaw records it: `author` is `owner`, `person`, `agent`, or `system`, and `speaker` the sender's name on the channel, or the sending agent's. The owner is whoever OpenClaw's own `commands.ownerAllowFrom` names; the plugin has no setting of its own for it. The sender's facts come from `__openclaw`, a field OpenClaw keeps on its messages without declaring it to plugins, and are checked again with each OpenClaw version. No sender id is recorded. Without conversation access, the plugin cannot tell the owner's messages apart, and records every message that arrives as a `person`'s. See [Who wrote each message](https://origin.openlinkos.com/guide/openclaw#who-wrote-each-message).

The plugin uses only Node built-ins and follows Origin's version. Design and source: [github.com/openlinkos/origin](https://github.com/openlinkos/origin).

MIT licensed.
