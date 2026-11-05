import fs from 'node:fs';
import path from 'node:path';
import {
  type Author,
  type Database,
  type EventKind,
  parsePlaceLine,
  readMirror,
  type SessionKind,
  type SourceAdapter,
} from '../src/index.js';

/**
 * Minimal fake source: one {"id","session","ts","role","text"} object per line, with optional
 * `kind`, `title`, `project`, `cwd`, `branch` (its git branch), and `parent`. Another `id` makes it
 * a second agent. Its files are the `.jsonl` files directly in `root`, which `locate` finds too.
 * Who wrote an input: `author`, `signal`, and `speaker` on a line, as an adapter that reads them
 * says; without them, ingestion decides by kind and text. A line with `kinds`, a list of
 * `{ session, kind, signal }`, says which sessions are children or headless runs. A line with
 * `parents`, a list of `{ session, parent, via, signal, group, name, source }`, names a parent.
 * `places.jsonl` is parsed as place lines. A line with
 * `learnt` yields its event only once the adapter has learnt to read it (`learnt: true`), as a
 * newer adapter does with a line an older one skipped.
 */
export function fakeAdapter(
  root: string,
  id = 'fake',
  opts: { learnt?: boolean } = {},
): SourceAdapter {
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
    locate(absPath) {
      const rel = path.relative(root, absPath);
      if (rel.includes(path.sep) || rel.startsWith('..') || !rel.endsWith('.jsonl')) return null;
      return { absPath: path.join(root, rel), relPath: rel };
    },
    parseLine(line, ctx) {
      if (ctx?.generated && ctx.relPath === 'places.jsonl') {
        return parsePlaceLine(line);
      }
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
        author?: Author;
        signal?: string;
        speaker?: string;
        kinds?: Array<{ session: string; kind: SessionKind; signal: string }>;
        parents?: Array<{
          session: string;
          parent: string;
          via?: 'subagent' | 'workflow';
          signal?: string;
          group?: string;
          name?: string;
          source?: string;
        }>;
        learnt?: boolean;
      };
      if (o.title) return { events: [], sessionTitle: o.title, sessionId: o.session };
      const sessionKinds = o.kinds?.map((k) => ({
        sessionId: k.session,
        kind: k.kind,
        signal: k.signal,
      }));
      const sessionParents = o.parents?.map((p) => ({
        sessionId: p.session,
        parentSessionId: p.parent,
        parentSource: p.source,
        via: p.via ?? 'subagent',
        signal: p.signal ?? 'parent_id',
        runGroup: p.group,
        runName: p.name,
        fromAgent: true as const,
      }));
      if (!o.id || (o.learnt && !opts.learnt)) return { events: [], sessionKinds, sessionParents };
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
            ...(o.author ? { author: o.author, authorSignal: o.signal ?? 'fake' } : {}),
            ...(o.speaker ? { speaker: o.speaker } : {}),
          },
        ],
        sessionKinds,
        sessionParents,
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
