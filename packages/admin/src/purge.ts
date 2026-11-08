import type { PurgeSelector } from '@openlinkos/origin-core';
import { HttpError } from './http.js';

/**
 * The selector of a purge in a URL's query, as the purge preview (`/admin/purge`) and
 * `/admin/api/purge-plan` take it: the words of `origin purge`, one kind per purge.
 *
 * - `event=<id>`, repeated for several events;
 * - `session=<source>:<session-id>`, with `keep-children=1` to keep its child sessions;
 * - `entry=<id>`;
 * - `forgotten=<tmb-id>` or `forgotten=all`;
 * - `recall=<id>`;
 * - `source=<id>`: lines of a source's mirrors, narrowed by `from` (a device or writer), `path`,
 *   `file` (a raw file id) with `lines=<first>-<last>`, `since` and `until` (ISO times or epoch
 *   milliseconds), and `unparsed=1`.
 *
 * Core checks the selector again (planPurge); this only reads it.
 */
const KINDS = ['event', 'session', 'entry', 'forgotten', 'recall', 'source'] as const;

/** Most events one preview names. */
const MAX_EVENTS = 1000;

function bad(message: string): never {
  throw new HttpError(400, message);
}

/** A time: an ISO date or time, or epoch milliseconds. */
function timeParam(value: string, name: string): number {
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(n)) bad(`Invalid ${name}: give an ISO time, such as 2026-11-08T09:00Z.`);
  return n;
}

function positive(value: string, what: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) bad(`Invalid ${what}.`);
  return n;
}

/** The selector named by a query; a 400 when it names none, several, or one badly. */
export function selectorFromQuery(params: URLSearchParams): PurgeSelector {
  const get = (name: string) => (params.get(name) ?? '').trim();
  const named = KINDS.filter((k) => get(k) !== '');
  // A session may name its source apart: `source=<id>&session=<session-id>`.
  const kinds = named.includes('session') ? named.filter((k) => k !== 'source') : named;
  if (kinds.length === 0) {
    bad('Say what to purge: event, session, entry, forgotten, recall, or source.');
  }
  if (kinds.length > 1) bad(`Purge one kind at a time, not ${kinds.join(' and ')}.`);
  switch (kinds[0]) {
    case 'event': {
      const ids = [...new Set(params.getAll('event').map((v) => v.trim()))].filter(Boolean);
      if (ids.length > MAX_EVENTS) bad(`Name at most ${MAX_EVENTS} events at a time.`);
      return { kind: 'event', ids };
    }
    case 'session': {
      const value = get('session');
      const source = get('source');
      let s: Extract<PurgeSelector, { kind: 'session' }>;
      if (source) {
        s = { kind: 'session', source, sessionId: value };
      } else {
        const at = value.indexOf(':');
        if (at <= 0 || at === value.length - 1) {
          bad('Name the session as <source>:<session-id>.');
        }
        s = { kind: 'session', source: value.slice(0, at), sessionId: value.slice(at + 1) };
      }
      if (get('keep-children') === '1') s.keepChildren = true;
      return s;
    }
    case 'entry':
      return { kind: 'entry', id: get('entry') };
    case 'forgotten':
      return { kind: 'forgotten', tombstone: get('forgotten') };
    case 'recall':
      return { kind: 'recall', id: get('recall') };
    default: {
      const s: Extract<PurgeSelector, { kind: 'lines' }> = { kind: 'lines', source: get('source') };
      if (get('from')) s.from = get('from');
      if (get('path')) s.path = params.get('path') ?? '';
      if (get('file')) s.file = positive(get('file'), 'raw file id');
      const lines = get('lines');
      if (lines) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
        if (!m) bad('Give lines as <first>-<last>, such as 12-40.');
        const first = positive(m[1] ?? '', 'first line');
        const last = m[2] === undefined ? first : positive(m[2], 'last line');
        if (last < first) bad('The last line comes before the first.');
        s.lines = { first, last };
      }
      if (get('since')) s.since = timeParam(get('since'), 'since');
      if (get('until')) s.until = timeParam(get('until'), 'until');
      if (get('unparsed') === '1') s.unparsed = true;
      return s;
    }
  }
}

/** The query that names a selector, as selectorFromQuery reads it. */
export function selectorQuery(s: PurgeSelector): string {
  const q = new URLSearchParams();
  switch (s.kind) {
    case 'event':
      for (const id of s.ids) q.append('event', id);
      break;
    case 'session':
      q.set('session', `${s.source}:${s.sessionId}`);
      if (s.keepChildren) q.set('keep-children', '1');
      break;
    case 'entry':
      q.set('entry', s.id);
      break;
    case 'forgotten':
      q.set('forgotten', s.tombstone);
      break;
    case 'recall':
      q.set('recall', s.id);
      break;
    case 'lines':
      q.set('source', s.source);
      if (s.from !== undefined) q.set('from', s.from);
      if (s.path !== undefined) q.set('path', s.path);
      if (s.file !== undefined) q.set('file', String(s.file));
      if (s.lines) q.set('lines', `${s.lines.first}-${s.lines.last}`);
      if (s.since !== undefined) q.set('since', new Date(s.since).toISOString());
      if (s.until !== undefined) q.set('until', new Date(s.until).toISOString());
      if (s.unparsed) q.set('unparsed', '1');
      break;
  }
  return q.toString();
}

/** The preview of a purge: `/admin/purge?<selector>`. */
export const purgeHref = (s: PurgeSelector): string => `/admin/purge?${selectorQuery(s)}`;

/**
 * A selector sent back by the preview's form (as JSON) or by the API: an object, which core checks.
 * A 400 for anything else.
 */
export function selectorFromBody(value: unknown): PurgeSelector {
  let v = value;
  if (typeof v === 'string') {
    if (v.length > 64 * 1024) bad('The selector is too long.');
    try {
      v = JSON.parse(v);
    } catch {
      bad('Invalid selector: preview the purge again.');
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    bad('Missing or invalid selector: preview the purge first, and confirm that preview.');
  }
  return v as PurgeSelector;
}
