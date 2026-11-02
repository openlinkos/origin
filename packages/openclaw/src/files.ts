import { createHash } from 'node:crypto';

/**
 * Where a session's lines go: `<agent>/<yyyy>/<mm>/<session>.jsonl`, the same relative path in a
 * directory and on a hub. Each line goes to the file of its own month (UTC), so that a session that
 * lasts for months, as an agent's main session can, is kept in one file a month, and a line sent
 * again goes to the file it went to before. Every part follows the rule of the hub's
 * `/v1/sources/<name>/lines` endpoint, which is also safe for file systems everywhere: letters,
 * digits, `.`, `_`, and `-`, starting with a letter or digit, ending with one or with `_` or `-`,
 * and never a name Windows keeps for devices.
 */

const SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const PATH_MAX = 200;
const SLUG_MAX = 80;
const AGENT_MAX = 64;

/** The first `n` hex digits of the SHA-256 of `s`. */
export function shortHash(s: string, n: number): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, n);
}

/** `s` with every run of characters a path part may not hold turned into `-`, cut to `max`. */
function slug(s: string, max: number): string {
  return s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, max)
    .replace(/[^A-Za-z0-9_-]+$/, '');
}

/** A path part made from `s`: its slug, or `fallback` if nothing is left, never a device name. */
function part(s: string, max: number, fallback: string): string {
  const p = slug(s, max) || fallback;
  return DEVICE_NAME_RE.test(p) ? `${fallback}-${p}` : p;
}

/**
 * The file name of a session: its key made file-safe, plus a hash of the key itself, so that two
 * keys that read alike once made safe (or differ only in case, which some file systems ignore)
 * never share a file. `agent:main:telegram:direct:42` gives `agent-main-telegram-direct-42-<hash>`.
 */
export function sessionFileBase(sessionKey: string): string {
  return part(`${slug(sessionKey, SLUG_MAX)}-${shortHash(sessionKey, 10)}`, SLUG_MAX + 11, 's');
}

/** The directory of an agent's files. */
export function agentDir(agentId: string): string {
  return part(agentId, AGENT_MAX, 'agent');
}

/** The relative path of the file a line of `sessionKey` at `timeMs` goes to. */
export function linesPath(agentId: string, sessionKey: string, timeMs: number): string {
  const d = new Date(Number.isFinite(timeMs) ? timeMs : 0);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${agentDir(agentId)}/${yyyy}/${mm}/${sessionFileBase(sessionKey)}.jsonl`;
}

/** Whether `p` is a path the hub takes for a file of event lines (and safe in a directory). */
export function isSafeLinesPath(p: string): boolean {
  return (
    p.length <= PATH_MAX &&
    p.endsWith('.jsonl') &&
    p.split('/').every((seg) => SEGMENT_RE.test(seg) && !DEVICE_NAME_RE.test(seg))
  );
}
