import fs from 'node:fs';
import path from 'node:path';
import type { EventKind, SourceAdapter } from '../src/index.js';

/** Minimal fake source: one {"id","session","ts","role","text"} object per line. */
export function fakeAdapter(root: string): SourceAdapter {
  return {
    id: 'fake',
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
