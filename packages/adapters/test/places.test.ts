import { describe, expect, it } from 'vitest';
import { allAdapters, createLinesAdapter, parseEventLine } from '../src/index.js';

const place =
  '{"v":1,"type":"place","session":"s1","project":"demo-app","root":null,"signal":"git"}';
const parent =
  '{"v":1,"type":"parent","session":"s1","parent":"p1","via":"subagent","signal":"parent_id"}';

describe('places.jsonl', () => {
  it('is parsed by every built-in adapter through core, with no events', () => {
    for (const adapter of allAdapters()) {
      const parsed = adapter.parseLine(place, {
        absPath: 'places.jsonl',
        relPath: 'places.jsonl',
        lineNo: 1,
        fileMtimeMs: 0,
      });
      expect(parsed.events).toEqual([]);
      expect(parsed.places?.[0]).toMatchObject({ sessionId: 's1', project: 'demo-app' });
      expect(
        adapter.parseLine(parent, {
          absPath: 'places.jsonl',
          relPath: 'nested/places.jsonl',
          lineNo: 2,
          fileMtimeMs: 0,
        }).events,
      ).toEqual([]);
    }
  });

  it('is parsed by a lines source, and a named project is explicit', () => {
    const lines = createLinesAdapter({ id: 'chat-ops', dir: 'D:\\demo\\empty' });
    const parsed = lines.parseLine(place, {
      absPath: 'places.jsonl',
      relPath: 'places.jsonl',
      lineNo: 1,
      fileMtimeMs: 0,
    });
    expect(parsed.events).toEqual([]);
    const event = parseEventLine(
      '{"id":"m1","session":"s1","time":"2026-11-02T09:30:00Z","role":"user","kind":"message","text":"Ship it","project":"demo-app","cwd":"D:\\\\demo\\\\demo-app"}',
    );
    expect(event.events[0]).toMatchObject({ project: 'demo-app', projectSignal: 'explicit' });
  });
});
