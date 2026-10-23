import { parseArgs } from 'node:util';
import {
  type Database,
  forget,
  isRelay,
  listTokens,
  listTombstones,
  OriginError,
  planForget,
  planRestore,
  restore,
  storeName,
} from '@openlinkos/origin-core';
import type { GetResult } from '@openlinkos/origin-mcp';
import { count, oneLine, table } from './format.js';
import type { HubConfig } from './hub/config.js';
import { askHub } from './hub/remote.js';
import { fmtDateTime } from './time.js';

/**
 * `origin forget`, `origin forgotten`, and `origin restore` (see docs/architecture.md#forgetting):
 * forgetting and restoring are records, each with a reason; only the owner restores.
 */
export interface ForgettingCtx {
  db: Database;
  /** The hub this device is connected to, or null. */
  hub: () => HubConfig | null;
  /** On a relay, its hub (or an error saying it has none). */
  relayHub: () => HubConfig;
  /** After a change on a connected device: sync with the hub. */
  afterChange: () => Promise<void>;
  /** Where output goes (the console by default). */
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Ask the hub's MCP endpoint (tests). */
  ask?: typeof askHub;
}

const FORGET_USAGE = 'Usage: origin forget <id> --reason <text> [--yes]';
const RESTORE_USAGE = 'Usage: origin restore <tombstone-id> --reason <text> [--yes]';

const io = (ctx: ForgettingCtx) => ({
  out: ctx.out ?? ((line: string) => console.log(line)),
  err: ctx.err ?? ((line: string) => console.error(line)),
});

const items = (p: { entries: string[]; events: string[] }) =>
  `${count(p.entries.length, 'entry', 'entries')} and ${count(p.events.length, 'event')}`;

/** The reason a forget or a restore needs, trimmed, or null. */
function reasonOf(values: { reason?: string }): string | null {
  const reason = values.reason?.trim();
  return reason ? reason : null;
}

export async function cmdForget(ctx: ForgettingCtx, args: string[]): Promise<number> {
  const { out, err } = io(ctx);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false } },
  });
  const id = positionals[0];
  const reason = reasonOf(values);
  if (!id || !reason) {
    err(`${FORGET_USAGE}\nA reason is required: it is kept with the record.`);
    return 2;
  }
  if (isRelay(ctx.db)) return forgetOnHub(ctx, id, { reason, yes: values.yes });
  const plan = planForget(ctx.db, id);
  if (plan.entries.length === 0 && plan.events.length === 0) {
    out(`${id} has already been forgotten.`);
    return 0;
  }
  if (!values.yes) {
    out(`This will hide ${items(plan)}, here and on every store it reaches:`);
    for (const e of [...plan.entries, ...plan.events]) out(`  ${e}`);
    out(
      '\nThe forget is kept as a record with its reason; you can restore it later with origin restore. Re-run with --yes to confirm.',
    );
    return 1;
  }
  const done = forget(ctx.db, id, { reason, author: `user@${storeName(ctx.db)}` });
  out(`Forgot ${items(plan)} (tombstone ${done.tombstoneId}).`);
  out(`To bring it back: origin restore ${done.tombstoneId} --reason <text>`);
  await ctx.afterChange();
  return 0;
}

/**
 * `origin forget` on a relay: done on the hub, whose answer names what was forgotten. The relay
 * cannot list the effects beforehand, so the confirmation says what the rules will hide.
 */
async function forgetOnHub(
  ctx: ForgettingCtx,
  id: string,
  values: { reason: string; yes: boolean },
): Promise<number> {
  const { out } = io(ctx);
  const ask = ctx.ask ?? askHub;
  const hub = ctx.relayHub();
  if (!values.yes) {
    const r = (await ask(hub, 'get', { id })) as GetResult;
    const what =
      'entry' in r
        ? `the entry ${id}, every version of it, and the events they cite`
        : `the event ${id} and every entry that cites it`;
    out(
      `On the hub, this will hide ${what}, on every store.\n\nThe forget is kept as a record with its reason; it can be restored later in the hub's admin UI. Re-run with --yes to confirm.`,
    );
    return 1;
  }
  const r = (await ask(hub, 'forget', { id, reason: values.reason })) as {
    tombstone: string | null;
    forgotten_entries: string[];
    excluded_events: number;
  };
  if (r.tombstone === null) {
    out(`${id} has already been forgotten.`);
    return 0;
  }
  out(
    `Forgot ${count(r.forgotten_entries.length, 'entry', 'entries')} and ${count(r.excluded_events, 'event')} on the hub (tombstone ${r.tombstone}).`,
  );
  return 0;
}

/** Forgets and restores of this store, newest first: ids, reasons, and counts, never the text. */
export function cmdForgotten(ctx: ForgettingCtx, args: string[]): number {
  const { out } = io(ctx);
  const { values } = parseArgs({ args, options: { limit: { type: 'string' } } });
  if (isRelay(ctx.db)) {
    throw new OriginError(
      "This store is a relay and keeps no forgets of its own; see the Forgotten page of the hub's admin UI.",
    );
  }
  const rows = listTombstones(ctx.db, { limit: Number(values.limit ?? 50) || 50 });
  if (rows.length === 0) {
    out('Nothing has been forgotten.');
    return 0;
  }
  out(
    table(
      rows.map((t) => [
        t.id,
        t.kind,
        fmtDateTime(t.createdAt),
        t.target,
        t.kind === 'restore'
          ? ''
          : t.inEffect
            ? 'in effect'
            : `restored (${t.restoredBy.join(', ')})`,
        t.kind === 'restore' ? '' : `${t.entries} / ${t.events}`,
        `${t.origin}${t.author ? ` (${t.author})` : ''}`,
        oneLine(t.reason ?? '—', 60),
      ]),
      ['tombstone', 'kind', 'time', 'target', 'status', 'entries / events', 'made on', 'reason'],
    ),
  );
  return 0;
}

/**
 * `origin restore`: lift a forget of this store, with a reason; on a connected device, the restore
 * then goes to the hub, which passes it on. Only the owner restores: agents have no such tool.
 */
export async function cmdRestore(ctx: ForgettingCtx, args: string[]): Promise<number> {
  const { out, err } = io(ctx);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false } },
  });
  const id = positionals[0];
  const reason = reasonOf(values);
  if (!id || !reason) {
    err(`${RESTORE_USAGE}\nA reason is required: it is kept with the record.`);
    return 2;
  }
  if (isRelay(ctx.db)) {
    throw new OriginError(
      'This store is a relay and keeps no forgets of its own; restore on the hub, from the Forgotten page of its admin UI.',
    );
  }
  const plan = planRestore(ctx.db, id);
  if (!values.yes) {
    out(`Restoring ${id} brings back ${items(plan)} here:`);
    for (const e of [...plan.entries, ...plan.events]) out(`  ${e}`);
    out(
      '\nWhat another forget still covers stays hidden. The restore is kept as a record with its reason and reaches every store; to hide it again, forget it again. Re-run with --yes to confirm.',
    );
    return 1;
  }
  // On a hub's own store, forgets whose coverage changes are logged again for its devices.
  const serves = ctx.hub() === null && listTokens(ctx.db).length > 0;
  const done = restore(ctx.db, id, { reason, author: `user@${storeName(ctx.db)}` }, Date.now(), {
    growthOrigin: serves ? storeName(ctx.db) : undefined,
  });
  out(`Restored ${id}: brought back ${items(done)} (restore ${done.tombstoneId}).`);
  await ctx.afterChange();
  return 0;
}
