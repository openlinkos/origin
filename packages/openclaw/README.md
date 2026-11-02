# @openlinkos/origin-openclaw

Part of [Origin](https://origin.openlinkos.com), a local-first, cross-agent personal memory for AI coding agents. This package is a plugin for [OpenClaw](https://docs.openclaw.ai): it writes the sessions of a Gateway's agents to Origin as [event lines](https://origin.openlinkos.com/sources#your-own-sources-event-lines), either to your Origin hub or into a directory that an Origin device on the same host reads.

Install it into OpenClaw (checked against OpenClaw 2026.10.6):

```bash
openclaw plugins install npm:@openlinkos/origin-openclaw --pin --force --accept-capabilities
```

Then configure it under `plugins.entries.origin` in the Gateway's config. The guide covers the options, the hub token, and what then shows in Origin: [Connect OpenClaw](https://origin.openlinkos.com/guide/openclaw).

The plugin uses only Node built-ins and follows Origin's version. Design and source: [github.com/openlinkos/origin](https://github.com/openlinkos/origin).

MIT licensed.
