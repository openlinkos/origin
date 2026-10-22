import { OriginError } from './errors.js';
import { TOMBSTONE_ID_RE, type TombstoneRecord } from './forgetting.js';
import { NAME_RE } from './tokens.js';

/**
 * Validation of what stores send each other (see docs/architecture.md#personal-hub). Everything that
 * arrives over the network is checked field by field before it reaches the store.
 */

/** Longest id accepted for an entry, event, or tombstone target. */
const MAX_ID = 512;
/** Most ids one tombstone may list, per kind. */
const MAX_EFFECTS = 1_000_000;

export function invalid(what: string): never {
  throw new OriginError(`Invalid ${what}.`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkString(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(what);
  return value;
}

export function checkOptionalString(value: unknown, what: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return checkString(value, what, max);
}

export function checkTime(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(what);
  return value;
}

export function checkStoreName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !NAME_RE.test(value)) invalid(what);
  return value;
}

function checkIds(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EFFECTS) invalid(what);
  return value.map((id) => checkString(id, what, MAX_ID));
}

/** A tombstone as another store sent it, or an OriginError. */
export function parseTombstoneRecord(value: unknown): TombstoneRecord {
  if (!isRecord(value)) invalid('tombstone');
  const id = value.id;
  if (typeof id !== 'string' || !TOMBSTONE_ID_RE.test(id)) invalid('tombstone id');
  return {
    id,
    target: checkString(value.target, `target of ${id}`, MAX_ID),
    reason: checkOptionalString(value.reason, `reason of ${id}`, 2000),
    createdAt: checkTime(value.createdAt, `createdAt of ${id}`),
    origin: checkStoreName(value.origin, `origin of ${id}`),
    entries: checkIds(value.entries, `entries of ${id}`),
    events: checkIds(value.events, `events of ${id}`),
  };
}
