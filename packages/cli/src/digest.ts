import { parseArgs } from 'node:util';
import { type Database, DIGEST_LIMIT, localTimeZone } from '@openlinkos/origin-core';
import { type DigestResult, digestOf } from '@openlinkos/origin-mcp';
import { ARGS } from './args.js';
import { count, oneLine, table } from './format.js';

/**
 * `origin digest` (see docs/architecture.md#daily-digest): one day of this store, or on a relay of
 * its hub, in this machine's time zone. `--json` prints what the MCP tool `digest` returns. Its
 * arguments are checked before the store is opened (see ARGS in args.ts).
 */

export interface DigestCtx {
  db: Database;
  /** On a relay, the hub's answer to the MCP tool `digest`; null to read this store. */
  hub: ((args: Record<string, unknown>) => Promise<unknown>) | null;
}

export async function cmdDigest(ctx: DigestCtx, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: ARGS.digest.options });
  const asked = {
    day: values.day,
    time_zone: localTimeZone(),
    project: values.project,
    source: values.source,
    limit: values.limit ? Number(values.limit) : DIGEST_LIMIT,
  };
  const d = ctx.hub ? ((await ctx.hub(asked)) as DigestResult) : digestOf(ctx.db, asked);
  if (values.json) {
    console.log(JSON.stringify(d, null, 2));
    return 0;
  }
  printDigest(d);
  return 0;
}

/** The time of day of an ISO 8601 time, as the digest's zone has it. */
const hhmm = (iso: string) => iso.slice(11, 16);

function printDigest(d: DigestResult): void {
  const t = d.totals;
  console.log(`Digest of ${d.day} (${d.time_zone})`);
  if (t.sessions === 0 && d.entries.length === 0 && d.proposals.length === 0) {
    if (d.forgets.length === 0) {
      console.log('Nothing happened in this store that day. Run origin sync first, or try --day.');
      return;
    }
  } else {
    const kids = t.children > 0 ? ` · ${count(t.children, 'child session')}` : '';
    console.log(
      `${count(t.sessions, 'session')} · ${count(t.events, 'event')} · ${count(t.prompts, 'prompt')} · ${count(t.projects, 'project')} · ${count(t.agents, 'agent')}${kids}`,
    );
  }

  if (d.projects.length > 0) {
    console.log('\nProjects');
    console.log(
      table(
        d.projects.map((p) => [
          `  ${p.project ?? '—'}`,
          count(p.sessions, 'session'),
          count(p.events, 'event'),
          count(p.prompts, 'prompt'),
        ]),
      ),
    );
  }

  if (d.sessions.length > 0) {
    console.log('\nSessions, most recent first (counts include child sessions)');
    for (const s of d.sessions) {
      // A session without a title is named by its first prompt, in quotes: the user's words.
      const name = s.title ?? (s.prompt ? `“${s.prompt}”` : '');
      console.log(
        `  ${hhmm(s.first)}–${hhmm(s.last)}  ${s.source.padEnd(11)} ${(s.project ?? '—').padEnd(24)} ${String(s.events).padStart(5)} events  ${oneLine(name, 60)}`,
      );
      const kids =
        s.children > 0
          ? `  · ${count(s.children, 'child', 'children')}${
              s.workflows.length > 0 ? ` (${s.workflows.join(', ')})` : ''
            }`
          : '';
      console.log(`           ↳ ${s.id}${s.thread ? `  thread ${s.thread}` : ''}${kids}`);
      const all = s.prompts.length + s.more_prompts;
      for (const [i, p] of s.prompts.entries()) {
        const head = i === 0 ? `prompts (${all}):` : '';
        console.log(`             ${head.padEnd(14)} ${hhmm(p.time)}  “${oneLine(p.text, 100)}”`);
      }
      if (s.more_prompts > 0) console.log(`             ${''.padEnd(14)} … ${s.more_prompts} more`);
      const tools = Object.entries(s.tools);
      if (s.tool_calls > 0) {
        const named = tools.map(([name, n]) => `${name} ${n}`).join(' · ');
        console.log(`             ${`tools (${s.tool_calls}):`.padEnd(14)} ${oneLine(named, 120)}`);
      }
      if (s.files.length > 0) {
        const more = s.more_files > 0 ? ` · … ${s.more_files} more` : '';
        console.log(
          `             ${`files (${s.files.length + s.more_files}):`.padEnd(14)} ${oneLine(s.files.join(' · '), 120)}${more}`,
        );
      }
    }
    if (d.more_sessions > 0) {
      console.log(
        `  … ${count(d.more_sessions, 'more session')}: narrow with --project or --source, or raise --limit`,
      );
    }
  }

  if (d.entries.length > 0) {
    console.log(`\nEntries written (${d.entries.length + d.more_entries})`);
    for (const e of d.entries) {
      const tags = [
        e.kind,
        e.project,
        e.author,
        e.supersedes ? `corrects ${e.supersedes}` : null,
        e.imported ? 'imported' : null,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`  [${hhmm(e.created)}] ${tags}\n      ${oneLine(e.text, 160)}\n      ↳ ${e.id}`);
    }
  }

  if (d.proposals.length > 0) {
    console.log(`\nProposals (${d.proposals.length + d.more_proposals})`);
    for (const p of d.proposals) {
      console.log(
        `  [${hhmm(p.time)}] ${p.kind}, ${p.status}${p.project ? `, ${p.project}` : ''}\n      ${oneLine(p.text, 160)}\n      ↳ ${p.id}`,
      );
    }
  }

  if (d.forgets.length > 0) {
    console.log(`\nForgets and restores, by id (${d.forgets.length + d.more_forgets})`);
    for (const f of d.forgets) {
      console.log(`  [${hhmm(f.at)}] ${f.kind.padEnd(7)} ${f.id} → ${f.target_kind} ${f.target}`);
    }
  }
  console.log('\nOpen any id: origin show <id>');
}
