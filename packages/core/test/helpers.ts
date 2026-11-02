import fs from 'node:fs';
import path from 'node:path';
import { type Database, type EventKind, readMirror, type SourceAdapter } from '../src/index.js';

/**
 * Minimal fake source: one {"id","session","ts","role","text"} object per line, with optional
 * `kind`, `title`, `project`, `cwd`, `branch` (its git branch), and `parent`. Another `id` makes it
 * a second agent.
 */
export function fakeAdapter(root: string, id = 'fake'): SourceAdapter {
  return {
    id,
    displayName: 'Fake',
    version: () => '0.0.1',
    async discover() {
      return fs
        .readdirSync(root)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ absPath: path.join(root, f), relPath: f }));
    },
    parseLine(line) {
      const o = JSON.parse(line) as {
        id: string;
        session: string;
        ts: number;
        role: 'user' | 'assistant';
        text: string;
        kind?: EventKind;
        title?: string;
        project?: string;
        cwd?: string;
        branch?: string;
        /** The id of the event it follows, as Claude Code's `parentUuid`. */
        parent?: string;
      };
      if (o.title) return { events: [], sessionTitle: o.title, sessionId: o.session };
      return {
        events: [
          {
            id: o.id,
            sessionId: o.session,
            ts: o.ts,
            role: o.role,
            kind: o.kind ?? 'message',
            text: o.text,
            project: o.project ?? 'demo',
            cwd: o.cwd ?? null,
            gitBranch: o.branch ?? null,
            parentId: o.parent ?? null,
          },
        ],
      };
    },
  };
}

export const line = (
  id: string,
  session: string,
  ts: number,
  role: 'user' | 'assistant',
  text: string,
  kind?: EventKind,
) => `${JSON.stringify({ id, session, ts, role, text, kind })}
`;

/** The whole content of a raw file's mirror, decompressed (see mirror.ts). */
export function mirrorText(db: Database, home: string, rawFileId: number): string {
  return readMirror(db, home, rawFileId, 0, Number.MAX_SAFE_INTEGER).toString('utf8');
}

/** What applying a tombstone did: entries and events newly hidden, and what came back. */
export const applied = (entries: number, events: number, restored = { entries: 0, events: 0 }) => ({
  entries,
  events,
  restored,
});
