import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  correct,
  type Database,
  type EntryKind,
  forget,
  getRecall,
  importedEntryId,
  listRecalls,
  matchTerms,
  openDatabase,
  planRecall,
  type RecallInput,
  recallPrompt,
  recallTerms,
  recallText,
  recordRecall,
  remember,
  type SourceAdapter,
  setStoreName,
  syncSource,
  termWeights,
  usedRefs,
} from '../src/index.js';

let home: string;
let logs: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-logs-'));
  db = openDatabase(path.join(home, 'origin.db'));
  setStoreName(db, 'laptop');
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(logs, { recursive: true, force: true });
});

/** Two checkouts with the same name, and a home directory above both. */
const REPO = '/work/acme/origin';
const OTHER = '/work/old/origin';
const HOME = '/home/dana';

/** A line of a session: a message in a working directory. */
interface Message {
  id: string;
  session: string;
  ts: number;
  role: 'user' | 'assistant';
  text: string;
  cwd: string;
  kind?: 'message' | 'tool_use';
}

/** A line of a memory stream: a version of an agent's memory file of a working directory. */
interface MemoryVersion {
  memory: true;
  id: string;
  at: number;
  text: string;
  kind: EntryKind;
  cwd: string;
}

const base = (cwd: string) => cwd.split('/').at(-1) as string;

/** An agent whose sessions are `<id>/*.jsonl` and whose memory streams are `<id>/memory/*.jsonl`. */
function agent(id: string): SourceAdapter {
  const dir = path.join(logs, id);
  return {
    id,
    displayName: id,
    version: () => '1.0.0',
    async discover() {
      const files = (sub: string) =>
        fs.existsSync(path.join(dir, sub))
          ? fs
              .readdirSync(path.join(dir, sub))
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => ({
                absPath: path.join(dir, sub, f),
                relPath: sub ? `${sub}/${f}` : f,
              }))
          : [];
      return [...files(''), ...files('memory')];
    },
    parseLine(line) {
      const o = JSON.parse(line) as Message | MemoryVersion;
      if ('memory' in o) {
        return {
          events: [
            {
              id: o.id,
              sessionId: `memory/${base(o.cwd)}`,
              ts: o.at,
              project: base(o.cwd),
              cwd: o.cwd,
              role: 'assistant',
              kind: 'memory',
              text: o.text,
            },
          ],
          memory: {
            eventId: o.id,
            previous: null,
            at: o.at,
            entry: { kind: o.kind, text: o.text, confidence: 0.9, project: base(o.cwd) },
          },
        };
      }
      return {
        events: [
          {
            id: o.id,
            sessionId: o.session,
            ts: o.ts,
            project: base(o.cwd),
            cwd: o.cwd,
            role: o.role,
            kind: o.kind ?? 'message',
            text: o.text,
          },
        ],
      };
    },
  };
}

function say(source: string, m: Message): void {
  fs.mkdirSync(path.join(logs, source), { recursive: true });
  fs.appendFileSync(path.join(logs, source, `${m.session}.jsonl`), `${JSON.stringify(m)}\n`);
}

function memo(source: string, m: Omit<MemoryVersion, 'memory'>): string {
  fs.mkdirSync(path.join(logs, source, 'memory'), { recursive: true });
  const file = path.join(logs, source, 'memory', `${base(m.cwd)}-${m.id}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ memory: true, ...m })}\n`);
  return importedEntryId(`${source}:${m.id}`);
}

async function sync(...sources: string[]): Promise<void> {
  for (const s of sources) await syncSource({ db, home }, agent(s));
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 12);

function note(
  text: string,
  project: string | null,
  kind: EntryKind = 'cognition',
  cites = 'claude:s1-1',
): string {
  return remember(
    db,
    {
      kind,
      text,
      confidence: 0.9,
      author: 'test',
      project,
      sources: [{ eventId: cites }],
    },
    NOW - 10 * DAY,
  ).id;
}

/** A session in the repository, so that entries have an event to cite. */
async function seed(): Promise<void> {
  say('claude', {
    id: 's1-1',
    session: 's1',
    ts: NOW - 2 * DAY,
    role: 'user',
    text: 'Set up the release workflow for the packages',
    cwd: REPO,
  });
  say('claude', {
    id: 's1-2',
    session: 's1',
    ts: NOW - 2 * DAY + 60_000,
    role: 'assistant',
    text: 'The workflow publishes with provenance.',
    cwd: REPO,
  });
  await sync('claude');
}

const inRepo = (input: Partial<RecallInput> = {}): RecallInput => ({
  occasion: 'start',
  source: 'codex',
  sessionId: 'now',
  cwd: `${REPO}/packages/core`,
  root: REPO,
  project: 'origin',
  now: NOW,
  ...input,
});

const refs = (input: RecallInput) => planRecall(db, input).items.map((i) => `${i.layer}:${i.ref}`);

describe('recall terms', () => {
  it('splits words, keeps dotted names whole as well, and drops stop words', () => {
    const terms = recallTerms('Deploy THE site to linkos.io with v0.3.0, by CI');
    expect(terms).toEqual(
      expect.arrayContaining(['deploy', 'site', 'linkos.io', 'linkos', 'io', 'v0.3.0', 'ci']),
    );
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('by');
  });

  it('segments CJK text into words and leaves out the topicless ones', () => {
    const terms = recallTerms('我们需要同步召回记录');
    expect(terms).toContain('同步');
    expect(terms).not.toContain('我们');
    expect(terms).not.toContain('需要');
  });
});

describe('matching a prompt', () => {
  const docs = [
    'Keep both mirror repositories maintained: the caching one and the Caddy one',
    'Releases are approved in the npm environment, only when asked',
    'The user prefers short answers',
  ];
  const background = [
    'please fix the tests',
    'what does the user think',
    'run the tests again',
    'the user asked for a fix',
  ];
  const weights = termWeights([...background, ...docs]);

  it('matches on terms the user rarely says, and not on what they say all the time', () => {
    const m = matchTerms('should we archive the Caddy mirror repositories?', docs, weights);
    expect(m.map((x) => x.index)).toEqual([0]);
    expect(m[0]?.terms.sort()).toEqual(['caddy', 'mirror', 'repositories']);
    expect(matchTerms('the user asked for the tests', docs, weights)).toEqual([]);
  });

  it('needs more than one term of evidence', () => {
    expect(matchTerms('caddy', docs, weights)).toEqual([]);
  });

  it('leaves out the terms it is told to ignore', () => {
    expect(matchTerms('caddy mirror', docs, weights).map((m) => m.index)).toEqual([0]);
    expect(matchTerms('caddy mirror', docs, weights, ['mirror'])).toEqual([]);
  });
});

describe('a brief', () => {
  it("hands this project's cognition, memory, and knowledge, and nothing of other projects", async () => {
    await seed();
    const pref = note('Approve releases only when the user asks', 'origin');
    const global = note('The user writes in Chinese', null);
    const elsewhere = note('Mirror sites keep both variants', 'mirrors');
    const fact = note('Releases publish with provenance', 'origin', 'knowledge');
    const theirs = note('The mirror relay runs on port 8080', 'mirrors', 'knowledge');
    expect(refs(inRepo())).toEqual([
      `cognition:${pref}`,
      `cognition:${global}`,
      `project:${fact}`,
      'sessions:claude:s1',
    ]);
    const text = recallText(planRecall(db, inRepo()), 'rcl_000000000001');
    expect(text).toContain('Origin recall rcl_000000000001');
    expect(text).toContain(`- ${pref} Approve releases only when the user asks`);
    expect(text).toContain('Latest sessions in origin');
    expect(text).not.toContain(elsewhere);
    expect(text).not.toContain(theirs);
  });

  it('tells two checkouts of the same name apart by their directories', async () => {
    await seed();
    const ours = memo('zcode', {
      id: 'm1',
      at: NOW - 3 * DAY,
      text: 'Docs live in docs/',
      kind: 'knowledge',
      cwd: REPO,
    });
    const old = memo('zcode', {
      id: 'm2',
      at: NOW - 3 * DAY,
      text: 'This repository holds only notes',
      kind: 'knowledge',
      cwd: OTHER,
    });
    say('zcode', { id: 'z1', session: 'z', ts: NOW - DAY, role: 'user', text: 'Hi', cwd: OTHER });
    say('zcode', {
      id: 'z2',
      session: 'z',
      ts: NOW - DAY,
      role: 'assistant',
      text: 'Hi',
      cwd: OTHER,
    });
    await sync('zcode');
    expect(refs(inRepo())).toEqual([`project:${ours}`, 'sessions:claude:s1']);
    expect(refs(inRepo({ cwd: OTHER, root: OTHER }))).toEqual([
      `project:${old}`,
      'sessions:zcode:z',
    ]);
    // Without a work tree, only the very directory is the project: not what is below a home.
    expect(refs(inRepo({ cwd: HOME, root: null, project: 'dana' }))).toEqual([]);
  });

  it('does not hand an agent its own memories of this project, which it loads itself', async () => {
    await seed();
    const own = memo('claude', {
      id: 'm1',
      at: NOW - DAY,
      text: 'Run the linter before committing',
      kind: 'cognition',
      cwd: REPO,
    });
    await sync('claude');
    expect(refs(inRepo({ source: 'codex' }))).toContain(`cognition:${own}`);
    expect(refs(inRepo({ source: 'claude', sessionId: 'other' }))).not.toContain(
      `cognition:${own}`,
    );
  });

  it('leaves out ended, superseded, and forgotten entries, and this very session', async () => {
    await seed();
    const ended = remember(
      db,
      {
        kind: 'knowledge',
        text: 'The hub runs version 0.2',
        confidence: 0.9,
        author: 'test',
        project: 'origin',
        sources: [{ eventId: 'claude:s1-1' }],
        validTo: NOW - DAY,
      },
      NOW - 10 * DAY,
    ).id;
    const old = note('Tag releases by hand', 'origin');
    const fixed = correct(db, old, { text: 'Tag releases from CI', author: 'test' }, NOW - 5 * DAY);
    // Forgetting it hides the event it cites too, so it cites one no other entry does.
    const gone = note('A secret preference', 'origin', 'cognition', 'claude:s1-2');
    forget(db, gone, { reason: 'asked to', author: 'test' });
    const got = refs(inRepo({ source: 'claude', sessionId: 's1' }));
    expect(got).toEqual([`cognition:${fixed.id}`]);
    expect(got.join(' ')).not.toContain(ended);
  });

  it('keeps within its budget, header and headings included', async () => {
    await seed();
    for (let i = 0; i < 5; i++) note(`Preference number ${i} ${'detail '.repeat(30)}`, 'origin');
    const plan = planRecall(db, inRepo({ budget: 200 }));
    expect(plan.tokens).toBeLessThanOrEqual(200);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.length).toBeLessThan(5);
    expect(planRecall(db, inRepo({ budget: 10 })).items).toEqual([]);
  });
});

describe('recall with a prompt', () => {
  it('hands the matching entries once per brief, and records each recall', async () => {
    await seed();
    // Cognition of another project: never in this brief, but handed when a prompt matches it.
    const caddy = note(
      'Keep both mirror repositories: the caching one and the Caddy one',
      'mirrors',
    );
    note('The user prefers short answers', null);
    const prompt = 'Should we archive one of the Caddy mirror repositories?';
    const first = planRecall(db, inRepo({ occasion: 'prompt', prompt }));
    expect(first.items.map((i) => i.ref)).toEqual([caddy]);
    expect(first.items[0]?.score).toBeGreaterThan(0);
    const id = recordRecall(db, first);

    // Already handed to this session: not again, until its next brief.
    const again = planRecall(db, inRepo({ occasion: 'prompt', prompt }));
    expect(again.items).toEqual([]);
    recordRecall(db, again);
    recordRecall(db, planRecall(db, inRepo()));
    expect(planRecall(db, inRepo({ occasion: 'prompt', prompt })).items).toHaveLength(1);
    // Another session has its own.
    expect(
      planRecall(db, inRepo({ occasion: 'prompt', prompt, sessionId: 'later' })).items,
    ).toHaveLength(1);

    expect(getRecall(db, id)).toMatchObject({
      id,
      origin: 'laptop',
      source: 'codex',
      sessionId: 'now',
      occasion: 'prompt',
      project: 'origin',
      cwd: `${REPO}/packages/core`,
      items: [{ rank: 1, layer: 'prompt', kind: 'entry', ref: caddy }],
    });
    // Only ids and a hash are kept, never the prompt.
    const row = JSON.stringify(db.prepare('SELECT * FROM recall WHERE id = ?').get(id));
    expect(row).not.toContain('Caddy');
    // Recalls that handed nothing are listed on request.
    expect(listRecalls(db).map((r) => r.occasion)).toEqual(['start', 'prompt']);
    expect(listRecalls(db, { includeEmpty: true })).toHaveLength(3);
  });

  it('keeps its records append-only', async () => {
    await seed();
    const id = recordRecall(db, planRecall(db, inRepo()));
    expect(() => db.prepare('DELETE FROM recall WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE recall_item SET score = 1').run()).toThrow(/append-only/);
  });

  it('finds the prompt in the archive and the items the session went on to use', async () => {
    await seed();
    const caddy = note('Keep both mirror repositories: the caching one and the Caddy one', null);
    const prompt = 'Should we archive one of the Caddy mirror repositories?';
    const plan = planRecall(
      db,
      inRepo({ occasion: 'prompt', prompt, source: 'claude', sessionId: 's2', now: NOW - DAY }),
    );
    const id = recordRecall(db, plan);
    const recall = getRecall(db, id);
    if (!recall) throw new Error('recorded');
    expect(recallPrompt(db, recall)).toBeNull();
    expect(usedRefs(db, recall)).toEqual(new Set());

    say('claude', {
      id: 's2-1',
      session: 's2',
      ts: NOW - DAY + 1,
      role: 'user',
      text: prompt,
      cwd: REPO,
    });
    say('claude', {
      id: 's2-2',
      session: 's2',
      ts: NOW - DAY + 2,
      role: 'assistant',
      kind: 'tool_use',
      text: `origin get {"id":"${caddy}"}`,
      cwd: REPO,
    });
    await sync('claude');
    expect(recallPrompt(db, recall)?.id).toBe('claude:s2-1');
    expect(usedRefs(db, recall)).toEqual(new Set([caddy]));

    // A forgotten prompt is no longer found.
    forget(db, 'claude:s2-1', { reason: 'asked to', author: 'test' });
    expect(recallPrompt(db, recall)).toBeNull();
  });
});
