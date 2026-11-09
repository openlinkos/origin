import {
  continuationLine,
  type Database,
  isSkippedLine,
  type SourceAdapter,
  type SourceFile,
  transaction,
} from '@openlinkos/origin-core';
import { expect } from 'vitest';

/** The id of the purge in these tests. */
export const PURGE = 'prg_0123456789ab';

/**
 * The line a purge leaves in place of `last`, the last line `file` wrote, checked: the purge's
 * marker, as long as the line, which every parse skips.
 */
export function purgedInPlaceOf(adapter: SourceAdapter, file: SourceFile, last: string): string {
  const marker = continuationLine(adapter, last, file.relPath, PURGE);
  if (marker === null) throw new Error(`no continuation for a line of ${file.relPath}`);
  expect(Buffer.byteLength(marker)).toBe(Buffer.byteLength(last));
  expect(isSkippedLine(marker)).toBe(true);
  expect(JSON.parse(marker)).toMatchObject({ origin_purged: PURGE });
  return marker;
}

/** All the lines a generated source writes after `last`. */
export function linesAfter(file: SourceFile, last: string | null): string[] {
  if (!file.generated) throw new Error(`${file.relPath} is not generated`);
  return file.generated.next(last, 1 << 20);
}

/** Record a purge that removed `removed` (kind, scope, id), as a purge records it. */
export function addPurge(
  db: Database,
  removed: Array<['event' | 'entry' | 'session' | 'recall' | 'file', string, string]>,
): void {
  transaction(
    db,
    () => {
      db.prepare(
        `INSERT INTO purge (id, at, origin, author, channel, reason, selector, counts)
         VALUES (?, 1000, 'laptop', 'user@laptop', 'cli', 'pasted a secret', '{}', '{}')`,
      ).run(PURGE);
      const add = db.prepare('INSERT INTO purged (kind, scope, id, purge_id) VALUES (?, ?, ?, ?)');
      for (const [kind, scope, id] of removed) add.run(kind, scope, id, PURGE);
    },
    { immediate: true },
  );
}
