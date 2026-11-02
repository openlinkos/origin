# Consolidate with a headless agent

Agents save what they learn as they go, but much of what matters is never said in so many words: a decision made in passing, a preference shown twice, a fact the project settled on. `origin distill` asks Claude Code, running headless, to read a day or a thread of your work through Origin and propose the entries worth keeping. You review the proposals, and accept or reject each. Origin itself calls no model: the run is an ordinary Claude Code session, and what it proposes waits for you (see [Proposals](../architecture.md#proposals)).

## What it does {#what-it-does}

1. **It picks a scope**: by default the project of the git work tree you are in, over the last 24 hours. `--project` names another project, and `--thread` a thread instead; `--day YYYY-MM-DD` takes one day of your time zone, and `--since` a range up to now, such as `7d`. A thread without a time is read whole. The scope is the same for the same store and options: its sessions, other than those of earlier runs, oldest first, up to 30 listed by id, and the project's pending proposals, up to 20, which the run must not propose again.
2. **It writes the prompt**, in plain English: what the run is for and on whose behalf, the scope, how to read it through Origin's tools (`get` for a session's turns and any id, `timeline` for a turn, `changes` for what reached the store in the last 24 hours, `search` for what entries already say), what to propose (memory: decisions with their reasons; knowledge: stable facts; cognition: your preferences, methods, goals, and boundaries), to cite events by id, never to call `remember`, `correct`, `forget`, or `follow`, to propose at most `--max` entries (10 by default), and to end with one line saying how many it proposed.
3. **It runs Claude Code headless** in the project's directory (that of the project's latest session on this machine, or the current directory), with the prompt on standard input. The run uses this Origin's own MCP server, started with this store, and no other server; it can use Origin's tools only, none of Claude Code's own, and not those that write:

   ```bash
   claude -p --output-format json --mcp-config <file> --strict-mcp-config \
     --allowedTools "mcp__origin__*" \
     --disallowedTools mcp__origin__remember,mcp__origin__correct,mcp__origin__forget,mcp__origin__follow \
     --tools "" --max-turns 40 --session-id <uuid> --name "Origin distill: <scope>"
   ```

   The file holds one server, `origin`: `node <origin's bin.js> mcp`, with `ORIGIN_HOME` set to this store. The session is named `Origin distill: …`, so that later runs leave it out of their scope.
4. **It ingests the run's session** from its transcript, as an agent's hook would (or, if it cannot find the transcript, with a sync of Claude Code's sessions), and on a device connected to a hub syncs with it. Then it lists the proposals that session made, with their ids and the session's. Nothing else is recorded: the run is its session.

## Running it {#running-it}

```bash
origin distill --dry-run                          # print the prompt and the command; run nothing
origin distill                                    # this project, the last 24 hours
origin distill --project demo-app --day 2026-10-20 --max 5
origin distill --thread thr_4c1e9a7b2d30          # a whole thread
```

```console
$ origin distill --max 5
Consolidating project demo-app, the last 24 hours: 4 sessions, at most 5 proposals.
Running Claude Code headless in /home/dana/code/demo-app (session 6a1f0c3e-0000-4000-8000-000000000042) …

Session 6a1f0c3e-0000-4000-8000-000000000042: 17 turns, 2.1min, $0.38.
The agent said: Proposed 2 entries.

It proposed 2 entries:
  prp_1b7e4c0a9d23  knowledge  Releases are tagged only after both CI jobs pass.
  prp_6e2d9a4c1b07  cognition  Prefers one purpose per commit, with no attribution trailers.

Review them: origin show <id>, then origin accept <id> or origin reject <id> --reason <text>; or the Proposals page of origin ui.
```

It needs `claude` on the `PATH`, signed in; `ORIGIN_DISTILL_COMMAND` names another command to run in its place. Only Claude Code can run it for now (`--agent claude-code`, the default). It does not run on a relay, which keeps no sessions to read: run it on the hub, or on a device with a complete store. Origin schedules nothing: you run it, when you choose.

## Cost {#cost}

A run is one Claude Code session, paid for as any other: from your subscription, or your API key. What it costs grows with the scope and with what the agent reads: a quiet day takes a few turns, a busy one many. `--max-turns` caps the turns (40 by default), and `--max` the proposals. When Claude Code reports the cost of the run, the summary shows it. The prompt and what the agent reads go to the model your Claude Code uses, as in any of your sessions; Origin itself sends nothing anywhere.

## Reviewing what it proposed {#reviewing-what-it-proposed}

Proposals wait for you, in the [CLI](./cli.md#reviewing-proposals) and on the Proposals page of the [admin UI](./admin.md):

- `origin proposals` lists those pending; `origin show prp_…` shows one with the events it cites.
- `origin accept prp_… --yes` writes its entry, as you, citing those events and the proposal itself. Correct or forget it later as any entry.
- `origin reject prp_… --reason <text> --yes` forgets the proposal, as a record with your reason; `origin restore` brings it back.

Agents cannot accept or reject. Until you decide, a proposal is not knowledge: briefs, search, and recall do not hand it over, and the next run is told not to propose it again.

## Its session {#its-session}

The run is a Claude Code session like your others, in the project's directory, so your Claude Code settings apply to it: your hooks run, Origin's included, and your `CLAUDE.md` files are read. Its tools are Origin's alone: it reads the archive, and can only propose. You find it in `origin timeline` and in the admin UI, named `Origin distill: …`, and every proposal shows the session that made it.
