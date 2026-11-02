import { parseArgs } from 'node:util';
import {
  acceptProposal,
  type Database,
  isRelay,
  listProposals,
  listRejectedProposals,
  OriginError,
  type Proposal,
  planForget,
  proposalError,
  proposalState,
  type RejectedProposal,
  rejectProposal,
  storeName,
} from '@openlinkos/origin-core';
import { type ProposalResult, proposalResult } from '@openlinkos/origin-mcp';
import { ARGS } from './args.js';
import { count, oneLine, table } from './format.js';
import { fmtDateTime } from './time.js';

/**
 * `origin proposals`, `origin accept`, and `origin reject` (see docs/architecture.md#proposals): the
 * person reviews what agents proposed. Accepting writes the proposal's entry; rejecting forgets its
 * event with a reason, as a record that `origin restore` lifts. Agents have no way to do either.
 */
export interface ProposalsCtx {
  db: Database;
  /** After a change on a connected device: sync with the hub. */
  afterChange: () => Promise<void>;
  /** Where output goes (the console by default). */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const STATUSES = ['pending', 'accepted', 'rejected', 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];

const io = (ctx: ProposalsCtx) => ({
  out: ctx.out ?? ((line: string) => console.log(line)),
  err: ctx.err ?? ((line: string) => console.error(line)),
});

/** A relay keeps no proposals: they are derived on its hub, where its owner reviews them. */
function refuseRelay(db: Database): void {
  if (isRelay(db)) {
    throw new OriginError(
      'This store is a relay and keeps no proposals of its own: review them on the hub, on the Proposals page of its admin UI. origin show <prp_…> opens one from here.',
    );
  }
}

const projectOf = (p: Proposal) => p.project ?? p.sessionProject ?? '—';

/** `origin proposals`: what agents proposed, newest first; the rejected by id and reason only. */
export function cmdProposals(ctx: ProposalsCtx, args: string[]): number {
  const { out, err } = io(ctx);
  const { values } = parseArgs({ args, options: ARGS.proposals.options });
  const status = values.status as StatusFilter;
  if (!STATUSES.includes(status)) {
    err(`Unknown status "${values.status}"; expected ${STATUSES.join(', ')}.`);
    return 2;
  }
  refuseRelay(ctx.db);
  const limit = Number(values.limit ?? 50) || 50;
  const shown: Proposal[] =
    status === 'rejected'
      ? []
      : listProposals(ctx.db, {
          project: values.project,
          status: status === 'all' ? undefined : status,
          limit,
        });
  const rejected: RejectedProposal[] =
    status === 'rejected' || status === 'all'
      ? listRejectedProposals(ctx.db, { project: values.project, limit })
      : [];
  if (shown.length === 0 && rejected.length === 0) {
    out(status === 'pending' ? 'No proposals wait for review.' : 'No proposals.');
    return 0;
  }
  if (shown.length > 0) {
    out(
      table(
        shown.map((p) => [
          p.id,
          p.status === 'accepted' ? `accepted (${p.entry})` : 'pending',
          p.kind,
          fmtDateTime(p.at),
          projectOf(p),
          oneLine(p.text, 70),
        ]),
        ['proposal', 'status', 'kind', 'proposed', 'project', 'text'],
      ),
    );
  }
  if (rejected.length > 0) {
    if (shown.length > 0) out('');
    out(
      table(
        rejected.map((r) => [
          r.id,
          fmtDateTime(r.rejectedAt),
          r.forget,
          r.author ?? '—',
          oneLine(r.reason ?? '—', 60),
        ]),
        ['rejected proposal', 'rejected', 'forget', 'by', 'reason'],
      ),
    );
  }
  const pending = shown.filter((p) => p.status === 'pending').length;
  out(
    pending > 0
      ? `\n${count(pending, 'proposal')} pending. Review one with origin show <id>, then origin accept <id> or origin reject <id> --reason <text>.`
      : '\nDetails: origin show <id>',
  );
  return 0;
}

/** A proposal as `origin show` prints it: its card, the same on a device and, from its hub, on a relay. */
export function printProposal(p: ProposalResult, out = (line: string) => console.log(line)): void {
  const time = (iso: string | null) => (iso === null ? '—' : fmtDateTime(Date.parse(iso)));
  const status = p.status === 'accepted' ? `accepted, as ${p.accepted_as?.id ?? '—'}` : 'pending';
  out(`Proposal    ${p.id}  ${p.kind}, ${status}`);
  const name = p.session
    ? (p.session.title ?? (p.session.prompt ? `“${p.session.prompt}”` : ''))
    : '';
  out(`Proposed    ${time(p.time)} by ${p.agent}, in session ${p.session?.session ?? '—'}`);
  if (name) out(`            ${oneLine(name, 90)}`);
  out(
    `Project     ${p.project ?? `${p.session?.project ?? '—'} (its session's)`}  confidence ${p.confidence}`,
  );
  if (p.valid_from !== null || p.valid_to !== null) {
    out(`Valid       ${time(p.valid_from)} → ${time(p.valid_to)}`);
  }
  if (p.note) out(`Note        ${oneLine(p.note, 200)}`);
  out(`\n${p.text}\n\nSources:`);
  for (const s of p.sources) {
    out(`  [${fmtDateTime(Date.parse(s.time))}] ${s.role}/${s.kind}  session ${s.session}`);
    out(`      ${oneLine(s.quote ? `“${s.quote}”` : s.text, 200)}`);
    out(`      ↳ ${s.id}`);
  }
  if (p.missing_sources > 0) {
    out(`  … and ${count(p.missing_sources, 'cited event')} this store does not have yet`);
  }
  out(`\nRead from   ${p.event}`);
  if (p.accepted_as) {
    out(`\nAccepted as ${p.accepted_as.id}: origin show ${p.accepted_as.id}`);
  } else {
    out(`\nAccept it: origin accept ${p.id}`);
    out(`Reject it:  origin reject ${p.id} --reason <text>`);
  }
}

/**
 * `origin show prp_…`: a proposal shown, or why it cannot be: the record that rejected it (its
 * reason, never its text), or that it was forgotten.
 */
export function showProposal(db: Database, id: string, out = (line: string) => console.log(line)) {
  const state = proposalState(db, id);
  if (state?.state === 'shown') {
    printProposal(proposalResult(db, id), out);
    return 0;
  }
  if (state?.state === 'rejected') {
    const r = state.rejected;
    out(
      `Proposal ${id} was rejected on ${fmtDateTime(r.rejectedAt)}${r.author ? ` by ${r.author}` : ''} (${r.forget}): ${r.reason ?? '—'}`,
    );
    out(`To review it again: origin restore ${r.forget} --reason <text>`);
    return 1;
  }
  out(proposalError(db, id).message);
  return 1;
}

const ACCEPT_USAGE = 'Usage: origin accept <proposal-id> [--yes]';
const REJECT_USAGE = 'Usage: origin reject <proposal-id> --reason <text> [--yes]';

/** The proposal to act on, shown and pending; throws an OriginError otherwise. */
function pendingProposal(db: Database, id: string): Proposal {
  const state = proposalState(db, id);
  if (state?.state !== 'shown') throw proposalError(db, id);
  return state.proposal;
}

/** `origin accept`: write the proposal's entry, as the user, after showing what it will be. */
export async function cmdAccept(ctx: ProposalsCtx, args: string[]): Promise<number> {
  const { out, err } = io(ctx);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: ARGS.accept.options,
  });
  const id = positionals[0];
  if (!id) {
    err(ACCEPT_USAGE);
    return 2;
  }
  refuseRelay(ctx.db);
  const p = pendingProposal(ctx.db, id);
  if (p.status === 'accepted') {
    out(`${id} was already accepted, as ${p.entry}.`);
    return 0;
  }
  if (!values.yes) {
    out(`This will write a ${p.kind} entry as user@${storeName(ctx.db)}:\n`);
    out(`  ${p.text.replace(/\n/g, '\n  ')}\n`);
    out(
      `citing ${count(p.sources.length, 'event')} it rests on and the proposal itself (${p.eventId}), confidence ${p.confidence}, project ${p.project ?? '—'}.`,
    );
    out(
      '\nYou can correct or forget the entry afterwards as any other. Re-run with --yes to accept.',
    );
    return 1;
  }
  const entry = acceptProposal(ctx.db, id, `user@${storeName(ctx.db)}`);
  out(`Accepted ${id} as ${entry.id}.`);
  out(`To change it: origin correct ${entry.id} <text>`);
  await ctx.afterChange();
  return 0;
}

/** `origin reject`: forget the proposal's event with a reason, after saying what that does. */
export async function cmdReject(ctx: ProposalsCtx, args: string[]): Promise<number> {
  const { out, err } = io(ctx);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: ARGS.reject.options,
  });
  const id = positionals[0];
  const reason = values.reason?.trim();
  if (!id || !reason) {
    err(`${REJECT_USAGE}\nA reason is required: it is kept with the record.`);
    return 2;
  }
  refuseRelay(ctx.db);
  const p = pendingProposal(ctx.db, id);
  if (p.status === 'accepted') {
    throw new OriginError(
      `${id} was accepted, as ${p.entry}: correct or forget that entry instead.`,
    );
  }
  if (!values.yes) {
    const plan = planForget(ctx.db, p.eventId);
    out(
      `This will reject ${id} (${p.kind}: ${oneLine(p.text, 80)}) by forgetting its event, ${p.eventId}, here and on every store it reaches; it hides ${count(plan.events.length, 'event')} and ${count(plan.entries.length, 'entry', 'entries')}.`,
    );
    out(
      '\nThe rejection is kept as a record with your reason; origin restore makes the proposal pending again. Re-run with --yes to confirm.',
    );
    return 1;
  }
  const done = rejectProposal(ctx.db, id, { reason, author: `user@${storeName(ctx.db)}` });
  out(`Rejected ${id} (tombstone ${done.tombstoneId}).`);
  out(`To bring it back: origin restore ${done.tombstoneId} --reason <text>`);
  await ctx.afterChange();
  return 0;
}
