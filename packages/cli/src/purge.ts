import { parseArgs } from 'node:util';
import {
  completePurges,
  type Database,
  getPurge,
  isRelay,
  listPurges,
  listTokens,
  OriginError,
  PURGE_ID_RE,
  type PurgeAdapters,
  type PurgeCounts,
  type PurgeDetail,
  type PurgePlan,
  type PurgeRecord,
  type PurgeSelector,
  parseTime,
  pendingPurgeMirrors,
  planPurge,
  purge,
  storeName,
} from '@openlinkos/origin-core';
import { count, oneLine, table } from './format.js';
import type { HubConfig } from './hub/config.js';
import { fmtDateTime } from './time.js';

/**
 * `origin purge` and `origin purged` (see docs/architecture.md#purging): deleting for good what
 * forgetting only hides, which only the owner does, after a preview, with a reason, and with a
 * record that is never deleted. A purge made here stays here: a hub keeps its copy, and its own
 * purges come down to this store as it syncs.
 */
export interface PurgeCtx {
  db: Database;
  home: string;
  /** The adapters of this store's sources: a purge parses the mirrors that may hold what it takes. */
  adapters: PurgeAdapters;
  /** The hub this store syncs to (or, on a relay, its hub), or null. */
  hub: () => HubConfig | null;
  /** Where output goes (the console by default). */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The options of `origin purge`, as args.ts checks them before the store is opened. */
export const PURGE_OPTIONS = {
  reason: { type: 'string' },
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false },
  digest: { type: 'string' },
  'keep-children': { type: 'boolean', default: false },
  source: { type: 'string' },
  from: { type: 'string' },
  path: { type: 'string' },
  file: { type: 'string' },
  lines: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  unparsed: { type: 'boolean', default: false },
} as const;

export const PURGE_USAGE = `Usage: origin purge <selector> --reason <text> [--yes] [--json] [--digest <d>] | --resume
Selectors: event <id>… | session <source>:<session-id> [--keep-children] | entry <id>
         | forgotten <tombstone-id>|all | recall <id>
         | lines --source <id> [--from <device>] [--path <p>] [--file <raw-file-id> [--lines a-b]]
                 [--since <t>] [--until <t>] [--unparsed]`;

export const PURGED_USAGE = 'Usage: origin purged [<purge-id>] [--limit 50] [--json]';

type PurgeValues = {
  [K in keyof typeof PURGE_OPTIONS]?: (typeof PURGE_OPTIONS)[K]['type'] extends 'boolean'
    ? boolean
    : string;
};

/** The options that only the `lines` selector takes. */
const LINE_OPTIONS = ['source', 'from', 'path', 'file', 'lines', 'since', 'until', 'unparsed'];

/** The one argument a selector takes, or an error naming how to write it. */
function single(rest: readonly string[], form: string): string {
  if (rest.length !== 1 || !rest[0]?.trim()) {
    throw new OriginError(`Name one: origin purge ${form}`);
  }
  return rest[0];
}

/**
 * What `origin purge` is asked to purge, from its arguments: a selector, checked as far as it can
 * be without the store. Throws an OriginError that says what is wrong.
 */
export function purgeSelector(
  positionals: readonly string[],
  values: PurgeValues,
  now = Date.now(),
): PurgeSelector {
  const [kind, ...rest] = positionals;
  const stray = LINE_OPTIONS.find((o) => {
    const v = values[o as keyof PurgeValues];
    return v !== undefined && v !== false;
  });
  if (kind !== 'lines' && stray) {
    throw new OriginError(`--${stray} goes with the lines selector: origin purge lines --source …`);
  }
  if (kind !== 'session' && values['keep-children']) {
    throw new OriginError('--keep-children goes with the session selector.');
  }
  switch (kind) {
    case 'event':
      if (rest.length === 0 || rest.some((id) => !id.trim())) {
        throw new OriginError('Name at least one event: origin purge event <id>…');
      }
      return { kind: 'event', ids: rest };
    case 'session': {
      const ref = single(rest, 'session <source>:<session-id>');
      const at = ref.indexOf(':');
      if (at <= 0 || at === ref.length - 1) {
        throw new OriginError(
          `Name the session with its source: origin purge session <source>:<session-id>, not "${ref}".`,
        );
      }
      return {
        kind: 'session',
        source: ref.slice(0, at),
        sessionId: ref.slice(at + 1),
        ...(values['keep-children'] ? { keepChildren: true } : {}),
      };
    }
    case 'entry':
      return { kind: 'entry', id: single(rest, 'entry <id>') };
    case 'forgotten':
      return { kind: 'forgotten', tombstone: single(rest, 'forgotten <tombstone-id>|all') };
    case 'recall':
      return { kind: 'recall', id: single(rest, 'recall <id>') };
    case 'lines':
      return linesSelector(rest, values, now);
    case undefined:
      throw new OriginError('Say what to purge.');
    default:
      throw new OriginError(`Unknown selector "${kind}".`);
  }
}

function linesSelector(
  rest: readonly string[],
  values: PurgeValues,
  now: number,
): Extract<PurgeSelector, { kind: 'lines' }> {
  if (rest.length > 0) {
    throw new OriginError(`The lines selector takes options only, not "${rest.join(' ')}".`);
  }
  const source = values.source?.trim();
  if (!source) throw new OriginError('Name the source whose lines to purge: --source <id>.');
  const s: Extract<PurgeSelector, { kind: 'lines' }> = { kind: 'lines', source };
  if (values.from !== undefined) s.from = values.from;
  if (values.path !== undefined) s.path = values.path;
  if (values.file !== undefined) {
    if (!/^[1-9]\d*$/.test(values.file)) {
      throw new OriginError(`--file takes a raw file id, a whole number, not "${values.file}".`);
    }
    s.file = Number(values.file);
  }
  if (values.lines !== undefined) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(values.lines.trim());
    const first = Number(m?.[1]);
    const last = Number(m?.[2] ?? m?.[1]);
    if (!m || first < 1 || last < first) {
      throw new OriginError(
        `--lines takes a line or a range, such as 7 or 3-12, not "${values.lines}".`,
      );
    }
    if (s.file === undefined) {
      throw new OriginError('A range of lines needs the raw file it is in: --file <raw-file-id>.');
    }
    s.lines = { first, last };
  }
  const time = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    try {
      return parseTime(v, now);
    } catch {
      throw new OriginError(`--${name} takes a time such as 7d, 24h, or 2026-11-01, not "${v}".`);
    }
  };
  const since = time(values.since, 'since');
  const until = time(values.until, 'until');
  if (since !== undefined) s.since = since;
  if (until !== undefined) s.until = until;
  if (values.unparsed) {
    if (s.file === undefined && s.from === undefined) {
      throw new OriginError(
        'Unparsed lines are purged only of one raw file (--file) or of what one device or writer sent (--from).',
      );
    }
    s.unparsed = true;
  }
  return s;
}

/** What is wrong with the arguments of `origin purge`, checked before the store is opened. */
export function purgeArgsProblem(
  values: Readonly<Record<string, unknown>>,
  positionals: readonly string[],
): string | null {
  const v = values as PurgeValues;
  if (v.resume) {
    if (positionals.length > 0 || v.reason !== undefined || v.yes || v.digest !== undefined) {
      return '--resume takes no selector, reason, or confirmation: it finishes the purges already made.';
    }
    return null;
  }
  try {
    purgeSelector(positionals, v);
  } catch (err) {
    return (err as Error).message;
  }
  if (typeof v.reason !== 'string' || v.reason.trim().length === 0) {
    return 'A reason is required: it is kept with the record.';
  }
  return null;
}

const io = (ctx: PurgeCtx) => ({
  out: ctx.out ?? ((line: string) => console.log(line)),
  err: ctx.err ?? ((line: string) => console.error(line)),
});

/** How many ids of each kind the preview and a record list before "and N more". */
const SHOWN = 50;

/** Up to SHOWN of `items`, each indented, then how many more there are. */
function listed(out: (line: string) => void, title: string, items: string[]): void {
  if (items.length === 0) return;
  out(`\n${title} (${items.length}):`);
  for (const item of items.slice(0, SHOWN)) out(`  ${item}`);
  if (items.length > SHOWN) out(`  … and ${items.length - SHOWN} more`);
}

/** Line ranges `[first, count]` as `3-12, 15`. */
export function rangesText(ranges: Array<[number, number]>): string {
  return ranges
    .map(([first, n]) => (n === 1 ? `${first}` : `${first}-${first + n - 1}`))
    .join(', ');
}

/** What a purge's counts say, in one line. */
export function countsText(c: PurgeCounts): string {
  const parts = [
    `${count(c.events, 'event')}${c.closure > 0 ? ` (${c.closure} sharing a raw line)` : ''}`,
    `${count(c.entries, 'entry version', 'entry versions')}${c.chains > 0 ? ` in ${count(c.chains, 'chain')}` : ''}`,
    count(c.sessions, 'session'),
    count(c.recalls, 'recall'),
  ];
  if (c.recallItems > 0) parts.push(count(c.recallItems, 'recall item'));
  if (c.proposals > 0) parts.push(count(c.proposals, 'proposal'));
  const mirrors = `${count(c.lines, 'line')} blanked in ${count(c.mirrors, 'mirror')}${c.files > 0 ? `, ${count(c.files, 'file')} blocked` : ''}`;
  return `${parts.join(', ')}; ${mirrors}`;
}

/** A selector in a few words, as the record keeps it (a newer store's selector by its kind). */
export function selectorText(s: PurgeSelector): string {
  switch (s.kind) {
    case 'event':
      return s.ids.length === 1 ? `event ${s.ids[0]}` : `${s.ids.length} events`;
    case 'session':
      return `session ${s.source}:${s.sessionId}${s.keepChildren ? ' (not its children)' : ''}`;
    case 'entry':
      return `entry ${s.id}`;
    case 'forgotten':
      return s.tombstone === 'all' ? 'everything forgotten' : `forgotten by ${s.tombstone}`;
    case 'recall':
      return `recall ${s.id}`;
    case 'lines': {
      const parts = [`lines of ${s.source}`];
      if (s.from !== undefined) parts.push(`from ${s.from}`);
      if (s.path !== undefined) parts.push(`in ${s.path}`);
      if (s.file !== undefined) parts.push(`raw file ${s.file}`);
      if (s.lines) parts.push(`lines ${s.lines.first}-${s.lines.last}`);
      if (s.since !== undefined) parts.push(`since ${fmtDateTime(s.since)}`);
      if (s.until !== undefined) parts.push(`until ${fmtDateTime(s.until)}`);
      if (s.unparsed) parts.push('unparsed');
      return parts.join(' ');
    }
    default:
      return String((s as { kind: unknown }).kind);
  }
}

/**
 * The page of a hub's admin UI that previews the same purge there: `/admin/purge?` with the selector
 * as query parameters (`event` once per id, `session=<source>:<id>`, `entry`, `forgotten`,
 * `recall`, or `lines=<source>` with `from`, `path`, `since`, `until`, and `unparsed`). Lines of
 * this store's files are named as the hub knows them: sent by this device, at this path. Null when
 * the link would be too long to use.
 */
export function hubPurgeLink(
  hub: HubConfig,
  selector: PurgeSelector,
  plan: PurgePlan | null,
): string | null {
  const q = new URLSearchParams();
  switch (selector.kind) {
    case 'event':
      for (const id of selector.ids) q.append('event', id);
      break;
    case 'session':
      q.set('session', `${selector.source}:${selector.sessionId}`);
      if (selector.keepChildren) q.set('keep-children', '1');
      break;
    case 'entry':
      q.set('entry', selector.id);
      break;
    case 'forgotten':
      q.set('forgotten', selector.tombstone);
      break;
    case 'recall':
      q.set('recall', selector.id);
      break;
    case 'lines': {
      q.set('lines', selector.source);
      q.set('from', selector.from ?? hub.device);
      const file =
        selector.file === undefined
          ? undefined
          : plan?.files.find((f) => f.rawFileId === selector.file)?.path;
      const path = file ?? selector.path;
      if (path !== undefined) q.set('path', path);
      if (selector.since !== undefined) q.set('since', new Date(selector.since).toISOString());
      if (selector.until !== undefined) q.set('until', new Date(selector.until).toISOString());
      if (selector.unparsed) q.set('unparsed', '1');
      break;
    }
  }
  const link = `${hub.url.replace(/\/+$/, '')}/admin/purge?${q}`;
  return link.length > 8000 ? null : link;
}

/** What a device connected to a hub says about a purge made on it. */
function hubNote(
  out: (line: string) => void,
  hub: HubConfig,
  selector: PurgeSelector,
  plan: PurgePlan | null,
): void {
  const link = hubPurgeLink(hub, selector, plan);
  out(
    `\nThis store syncs to the hub at ${hub.url}, which keeps its copy of what it already has: a purge here does not reach it. Purge it on the hub too, in its admin UI; a purge made there reaches this device at its next sync${link ? `:\n  ${link}` : '.'}`,
  );
}

/** The preview of a purge: what it deletes, by id and count, never text. */
function printPlan(out: (line: string) => void, plan: PurgePlan, store: string): void {
  const c = plan.counts;
  out(`This purge deletes for good, from this store (${store}): ${countsText(c)}.`);
  listed(out, 'Events', plan.events);
  listed(out, 'Events added because they share a raw line with what was selected', plan.closure);
  listed(out, 'Entry versions (whole chains)', plan.entries);
  listed(
    out,
    'Sessions',
    plan.sessions.map((s) => `${s.source}:${s.sessionId}`),
  );
  listed(out, 'Recalls', plan.recalls);
  listed(
    out,
    'Items removed from recalls that stay',
    plan.recallItems.map((i) => `${i.recall} #${i.rank}`),
  );
  listed(out, 'Proposals', plan.proposals);
  listed(out, 'Forgets that stay, covering less', plan.tombstones);
  listed(
    out,
    'Mirror lines blanked',
    plan.files.map((f) => {
      const flags = [
        f.blocked ? 'blocked: its later lines are stored blank' : '',
        f.continued ? 'its last line says where the stream goes on' : '',
      ]
        .filter(Boolean)
        .join('; ');
      return `${f.path} (${f.source}, raw file ${f.rawFileId}${f.generation > 1 ? `, generation ${f.generation}` : ''}): lines ${rangesText(f.lines)}${flags ? ` (${flags})` : ''}`;
    }),
  );
  out(`\nDigest: ${plan.digest}`);
  for (const w of plan.warnings) out(`\nWarning: ${w.message}`);
  out('\nA purge does not reach:');
  for (const limit of plan.limits) out(`  - ${limit}`);
}

function emptyPlan(p: PurgePlan): boolean {
  return (
    p.events.length + p.entries.length + p.sessions.length + p.recalls.length === 0 &&
    p.recallItems.length === 0 &&
    p.files.length === 0
  );
}

/**
 * `origin purge`: preview what a selector deletes, or with `--yes`, delete it for good, with the
 * reason and a record; `--resume` blanks the purged lines a purge left in the mirrors.
 */
export function cmdPurge(ctx: PurgeCtx, args: string[]): number {
  const { out, err } = io(ctx);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: PURGE_OPTIONS,
  });
  const problem = purgeArgsProblem(values, positionals);
  if (problem) {
    err(`${problem}\n${PURGE_USAGE}`);
    return 2;
  }
  if (isRelay(ctx.db)) {
    const hub = ctx.hub();
    throw new OriginError(
      `This store is a relay and keeps nothing to purge: purge on your hub, in its admin UI${hub ? ` (${hub.url.replace(/\/+$/, '')}/admin/purge)` : ''}.`,
    );
  }
  if (values.resume) return resume(ctx, values.json === true);
  const selector = purgeSelector(positionals, values);
  const reason = (values.reason ?? '').trim();
  const hub = ctx.hub();
  if (!values.yes) {
    const plan = planPurge(ctx.db, ctx.home, ctx.adapters, selector);
    if (values.json) {
      out(JSON.stringify(plan, null, 2));
      return 1;
    }
    if (emptyPlan(plan)) {
      out('Nothing to purge: the selector takes nothing this store holds.');
      if (hub) hubNote(out, hub, selector, plan);
      return 0;
    }
    printPlan(out, plan, storeName(ctx.db));
    out(
      plan.refusals.length > 0
        ? '\nIt cannot be applied as it is (see the warning above).'
        : `\nThis cannot be undone. The purge is kept as a record with its reason, ids, and counts, never what it deletes. Re-run with --yes to purge, and with --digest ${plan.digest} to purge only if it still deletes exactly this.`,
    );
    if (hub) hubNote(out, hub, selector, plan);
    return 1;
  }
  const r = purge(ctx.db, ctx.home, ctx.adapters, selector, {
    reason,
    author: `user@${storeName(ctx.db)}`,
    channel: 'cli',
    actor: 'cli',
    digest: values.digest,
    log: err,
  });
  if (values.json) {
    out(
      JSON.stringify(
        { id: r.id, record: r.record, pending: r.pending, mirrors: r.mirrors, plan: r.plan },
        null,
        2,
      ),
    );
    return 0;
  }
  out(`Purged ${r.id}: ${countsText(r.record.counts)}.`);
  if (r.pending > 0) {
    out(
      `${count(r.pending, 'mirror')} still ${r.pending === 1 ? 'holds' : 'hold'} purged lines; origin purge --resume, and the next sync, blank them.`,
    );
  }
  out(`The record: origin purged ${r.id}`);
  if (hub) hubNote(out, hub, selector, r.plan);
  else if (listTokens(ctx.db).some((t) => t.kind === 'device' && t.revokedAt === null)) {
    out('The devices that sync with this hub apply this purge at their next sync.');
  }
  return 0;
}

/** `origin purge --resume`: blank the lines purges left in the mirrors, as far as it can. */
function resume(ctx: PurgeCtx, json: boolean): number {
  const { out, err } = io(ctx);
  const before = pendingPurgeMirrors(ctx.db).length;
  if (before === 0) {
    if (json) out(JSON.stringify({ done: 0, frames: 0, lines: 0, failed: [], pending: 0 }));
    else out('No purge has lines left to blank.');
    return 0;
  }
  const r = completePurges(ctx.db, ctx.home, ctx.adapters, json ? {} : { log: err });
  if (json) {
    out(JSON.stringify(r, null, 2));
    return r.pending > 0 ? 1 : 0;
  }
  out(`Blanked ${count(r.lines, 'purged line')} in ${count(r.done, 'mirror')}.`);
  if (r.pending > 0) {
    out(
      `${count(r.pending, 'mirror')} still ${r.pending === 1 ? 'holds' : 'hold'} purged lines; origin status lists them, with why.`,
    );
    return 1;
  }
  return 0;
}

/** `origin purged`: this store's purges, newest first, or one of them, by id and count. */
export function cmdPurged(ctx: PurgeCtx, args: string[]): number {
  const { out } = io(ctx);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { limit: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  if (isRelay(ctx.db)) {
    throw new OriginError(
      "This store is a relay and keeps no purges of its own; see the purges in the hub's admin UI.",
    );
  }
  const id = positionals[0];
  if (id !== undefined) return showPurge(ctx, id, values.json === true);
  const rows = listPurges(ctx.db, { limit: Number(values.limit ?? 50) || 50 });
  const pending = new Map<string, number>();
  for (const m of pendingPurgeMirrors(ctx.db)) {
    for (const p of m.purges) pending.set(p, (pending.get(p) ?? 0) + 1);
  }
  if (values.json) {
    out(
      JSON.stringify(
        rows.map((r) => ({ ...r, pendingMirrors: pending.get(r.id) ?? 0 })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (rows.length === 0) {
    out('Nothing has been purged.');
    return 0;
  }
  out(
    table(
      rows.map((r: PurgeRecord) => [
        r.id,
        fmtDateTime(r.at),
        `${r.origin} (${r.author})`,
        r.channel === 'hub' ? `hub, ${fmtDateTime(r.receivedAt)}` : r.channel,
        oneLine(selectorText(r.selector), 48),
        `${r.counts.events} / ${r.counts.entries} / ${r.counts.sessions} / ${r.counts.lines}`,
        String(pending.get(r.id) ?? 0),
        oneLine(r.reason, 60),
      ]),
      [
        'purge',
        'time',
        'made on',
        'through',
        'selected',
        'events / entries / sessions / lines',
        'pending mirrors',
        'reason',
      ],
    ),
  );
  out('\nOne purge, with every id it removed: origin purged <purge-id>');
  return 0;
}

function showPurge(ctx: PurgeCtx, id: string, json: boolean): number {
  const { out } = io(ctx);
  if (!PURGE_ID_RE.test(id)) throw new OriginError(`Not a purge id: ${id}`);
  const p: PurgeDetail | null = getPurge(ctx.db, id);
  if (!p) throw new OriginError(`Unknown purge ${id}.`);
  if (json) {
    out(JSON.stringify(p, null, 2));
    return 0;
  }
  out(`Purge ${p.id}`);
  out(`Made:      ${fmtDateTime(p.at)} on ${p.origin} by ${p.author} (${p.channel})`);
  if (p.receivedAt !== null) out(`Received:  ${fmtDateTime(p.receivedAt)} from the hub`);
  out(`Reason:    ${p.reason}`);
  out(`Selected:  ${selectorText(p.selector)}`);
  out(`Removed:   ${countsText(p.counts)}`);
  if (p.touched.tombstones.length > 0) {
    out(`Forgets that stay, covering less: ${p.touched.tombstones.join(', ')}`);
  }
  if (p.touched.recalls.length > 0) {
    out(`Recalls that list fewer items: ${p.touched.recalls.join(', ')}`);
  }
  listed(out, 'Events', p.removed.events);
  listed(out, 'Entry versions', p.removed.entries);
  listed(
    out,
    'Sessions',
    p.removed.sessions.map((s) => `${s.source}:${s.sessionId}`),
  );
  listed(out, 'Recalls', p.removed.recalls);
  listed(
    out,
    'Files blocked: their later lines are stored blank',
    p.removed.files.map((f) => `${f.path} (${f.source})`),
  );
  listed(
    out,
    'Mirror lines blanked',
    p.mirrors.map(
      (m) =>
        `${m.path} (${m.source}, raw file ${m.rawFileId}): lines ${rangesText(m.lines)}${m.pending ? ` (still to blank${m.error ? `: ${m.error}` : ''})` : ''}`,
    ),
  );
  return 0;
}
