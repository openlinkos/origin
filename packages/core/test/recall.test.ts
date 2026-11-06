import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  correct,
  type Database,
  type EntryKind,
  estimateTokens,
  excerptStart,
  forget,
  getRecall,
  importedEntryId,
  listRecalls,
  matchTerms,
  messageExcerpt,
  openDatabase,
  openMemoryDatabase,
  ownRecalls,
  parseReplicaRecall,
  planRecall,
  type RecallInput,
  type RecallRecord,
  rebuildRecall,
  recallPrompt,
  recallScope,
  recallSession,
  recallTerms,
  recallText,
  receiveRecall,
  recordRecall,
  remember,
  type SourceAdapter,
  setStoreName,
  syncSource,
  termWeights,
  usedRefs,
} from '../src/index.js';
import { fakeAdapter } from './helpers.js';

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
  kind?: 'message' | 'tool_use' | 'tool_result';
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

  it('keeps an entry with its own project when it cites another tree', async () => {
    await seed();
    say('claude', {
      id: 'm1',
      session: 'm',
      ts: NOW - DAY,
      role: 'user',
      text: 'Work in the other tree',
      cwd: '/work/other-app/src',
    });
    await sync('claude');
    const pref = note('Keep the release notes short', 'origin', 'cognition', 'claude:m1');
    const fact = note('The archive keeps provenance', 'origin', 'knowledge', 'claude:m1');
    expect(refs(inRepo())).toEqual([`cognition:${pref}`, `project:${fact}`, 'sessions:claude:s1']);
    const other = planRecall(db, {
      ...inRepo(),
      cwd: '/work/other-app/src',
      root: '/work/other-app',
      project: 'other-app',
    });
    expect(other.items.map((i) => i.ref)).not.toContain(pref);
    expect(other.items.map((i) => i.ref)).not.toContain(fact);
    // A hub cannot read the cited directory. The entry still belongs to the project it names.
    const hub = planRecall(db, {
      ...inRepo(),
      cwd: '/work/other-app/src',
      root: null,
      project: 'origin',
      onDisk: false,
    });
    expect(hub.items.map((i) => i.ref)).toContain(pref);
    expect(hub.items.map((i) => i.ref)).toContain(fact);
  });

  it("adds a parent's children on its brief line", async () => {
    const now = Date.now();
    const dir = path.join(logs, 'children');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 's.jsonl'),
      `${[
        JSON.stringify({
          id: 'r1',
          session: 'parent-1',
          ts: now - 2000,
          role: 'user',
          text: 'Start the cache work',
          project: 'demo',
        }),
        JSON.stringify({
          id: 'r2',
          session: 'parent-1',
          ts: now - 1000,
          role: 'user',
          text: 'Keep going on the cache',
          project: 'demo',
        }),
        JSON.stringify({ session: 'parent-1', title: 'Cache the retries' }),
        JSON.stringify({
          id: 'c1',
          session: 'child-1',
          ts: now,
          role: 'user',
          text: 'zebraparentlink step',
          project: 'demo',
          parents: [
            {
              session: 'child-1',
              parent: 'parent-1',
              via: 'workflow',
              signal: 'dwf_run',
              group: 'run-1',
              name: 'Ship',
            },
          ],
        }),
      ].join('\n')}\n`,
    );
    await syncSource({ db, home }, fakeAdapter(dir));
    const text = recallText(
      planRecall(db, { occasion: 'start', project: 'demo', now, onDisk: false }),
      'rcl_000000000001',
    );
    expect(text).toContain('parent-1');
    expect(text).toContain(' · 1 child (Ship)');
    expect(text).not.toContain('child-1');
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

  it('is rebuilt as it was handed over, less what was forgotten since', async () => {
    await seed();
    const pref = note('Approve releases only when the user asks', 'origin');
    const fact = note('Releases publish with provenance', 'origin', 'knowledge', 'claude:s1-2');
    const plan = planRecall(db, inRepo());
    const id = recordRecall(db, plan);
    const recall = getRecall(db, id) as RecallRecord;
    const now = rebuildRecall(db, recall);
    expect(now.text).toBe(recallText(plan, id));
    expect(now.missing).toEqual([]);
    expect(now.lines.get(pref)).toBe(`- ${pref} Approve releases only when the user asks`);
    forget(db, fact, { reason: 'asked to', author: 'test' });
    const after = rebuildRecall(db, recall);
    expect(after.missing).toEqual([fact]);
    expect(after.text).not.toContain(fact);
    expect(after.text).not.toContain('Releases publish');
    expect(after.text).toContain(pref);
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

  it("finds the session of an agent that asked through MCP by the recall's id in its log", async () => {
    await seed();
    const caddy = note('Keep both mirror repositories: the caching one and the Caddy one', null);
    const plan = planRecall(db, inRepo({ occasion: 'request', sessionId: null, now: NOW - DAY }));
    const id = recordRecall(db, plan, { origin: 'desktop' });
    const recall = getRecall(db, id);
    if (!recall) throw new Error('recorded');
    expect(recall).toMatchObject({ origin: 'desktop', sessionId: null, occasion: 'request' });
    expect(recallSession(db, recall)).toBeNull();

    const at = NOW - DAY;
    say('codex', {
      id: 'c1',
      session: 'c',
      ts: at + 1,
      role: 'user',
      kind: 'tool_result',
      text: `{"recall":"${id}"}`,
      cwd: REPO,
    });
    say('codex', {
      id: 'c2',
      session: 'c',
      ts: at + 2,
      role: 'assistant',
      text: `Per ${caddy}, keep both.`,
      cwd: REPO,
    });
    await sync('codex');
    expect(recallSession(db, recall)).toEqual({ source: 'codex', sessionId: 'c' });
    expect(usedRefs(db, recall)).toEqual(new Set([caddy]));
  });
});

describe('recall of past messages', () => {
  /** A day as recall lines write it, in local time. */
  const dayOf = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const prompt = 'How did we rotate the zephyr signing keys last time?';
  const asked = (input: Partial<RecallInput> = {}) =>
    inRepo({ occasion: 'prompt', prompt, ...input });
  const messages = (input: RecallInput) =>
    planRecall(db, input)
      .items.filter((i) => i.layer === 'messages')
      .map((i) => i.ref);

  /** A conversation of Claude's in the repository: the user's prompt and the agent's reply. */
  async function keys(): Promise<void> {
    say('claude', {
      id: 'k1-1',
      session: 'k1',
      ts: NOW - 3 * DAY,
      role: 'user',
      text: 'Rotate the zephyr signing keys before the audit',
      cwd: REPO,
    });
    say('claude', {
      id: 'k1-2',
      session: 'k1',
      ts: NOW - 3 * DAY + 60_000,
      role: 'assistant',
      text: 'Done: the zephyr signing keys were rotated with the vault script.',
      cwd: REPO,
    });
    await sync('claude');
  }

  /** Lines of the helpers' fake source, which can say who wrote what and what a session is. */
  async function fakeLines(lines: object[]): Promise<void> {
    const dir = path.join(logs, 'fake');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'a.jsonl'),
      lines.map((l) => `${JSON.stringify({ project: 'origin', cwd: REPO, ...l })}\n`).join(''),
    );
    await syncSource({ db, home }, fakeAdapter(dir));
  }

  it("hands over another agent's past message in this project, one line with its id", async () => {
    await seed();
    await keys();
    const plan = planRecall(db, asked());
    expect(plan.items.map((i) => `${i.layer}:${i.kind}:${i.ref}`)).toEqual([
      'messages:event:claude:k1-1',
    ]);
    const item = plan.items[0];
    expect(item?.score).toBeGreaterThan(0);
    expect(item?.excerpt).toBe(0);
    expect(item?.line).toBe(
      `- claude:k1-1 (claude, ${dayOf(NOW - 3 * DAY)}, user) Rotate the zephyr signing keys before the audit`,
    );
    const text = recallText(plan, 'rcl_000000000001');
    expect(text).toContain(
      'entries and past messages from the user’s cross-agent memory that match this prompt',
    );
    expect(text).toContain('a message for its full text and the turns around it');
    expect(text).toContain(
      '\n\nPast messages that match this prompt (agent, day, who):\n- claude:k1-1',
    );
    expect(plan.tokens).toBeLessThanOrEqual(600);
    // A brief at the start of a session has none, and says nothing of them.
    const brief = recallText(planRecall(db, inRepo()), 'rcl_000000000002');
    expect(brief).not.toContain('message');
  });

  it('hands them after the entries a prompt matches, and for a task an agent asks about', async () => {
    await seed();
    await keys();
    const entry = note('Zephyr signing keys rotate every quarter', 'origin', 'knowledge');
    const plan = planRecall(db, asked());
    expect(plan.items.map((i) => `${i.layer}:${i.ref}`)).toEqual([
      `prompt:${entry}`,
      'messages:claude:k1-1',
    ]);
    const request = planRecall(db, inRepo({ occasion: 'request', sessionId: null, prompt }));
    expect(request.items.map((i) => i.layer)).toEqual([
      'project',
      'sessions',
      'sessions',
      'messages',
    ]);
    expect(request.budget).toBe(1500);
    expect(recallText(request, 'rcl_000000000001')).toContain(
      'Past messages that match the task (agent, day, who):',
    );
    // No project, no past messages: they are always a project's.
    expect(
      messages(inRepo({ occasion: 'request', prompt, cwd: null, root: null, project: null })),
    ).toEqual([]);
  });

  it('leaves out other projects, another checkout of the same name, and this very session', async () => {
    await seed();
    say('claude', {
      id: 'o1',
      session: 'o',
      ts: NOW - 3 * DAY,
      role: 'user',
      text: 'Rotate the zephyr signing keys of the mirror',
      cwd: '/work/mirrors',
    });
    say('zcode', {
      id: 'x1',
      session: 'x',
      ts: NOW - 3 * DAY,
      role: 'user',
      text: 'Rotate the zephyr signing keys here too',
      cwd: OTHER,
    });
    say('zcode', {
      id: 'x2',
      session: 'x',
      ts: NOW - 3 * DAY + 1,
      role: 'assistant',
      text: 'Done.',
      cwd: OTHER,
    });
    await sync('claude', 'zcode');
    expect(messages(asked())).toEqual([]);
    expect(messages(asked({ cwd: OTHER, root: OTHER }))).toEqual(['zcode:x1']);
    await keys();
    expect(messages(asked())).toEqual(['claude:k1-1']);
    expect(messages(asked({ source: 'claude', sessionId: 'k1' }))).toEqual([]);
  });

  it('leaves out a forgotten message, and what the session was handed since its brief', async () => {
    await seed();
    await keys();
    // Another prompt of the user's, so that k1 stays their conversation once k1-1 is forgotten.
    say('claude', {
      id: 'k1-3',
      session: 'k1',
      ts: NOW - 3 * DAY + 120_000,
      role: 'user',
      text: 'Thanks, that is all for today',
      cwd: REPO,
    });
    await sync('claude');
    const first = planRecall(db, asked());
    expect(first.items.map((i) => i.ref)).toEqual(['claude:k1-1']);
    recordRecall(db, first);
    // The session's other message comes next, then nothing, until the next brief.
    const second = planRecall(db, asked());
    expect(second.items.map((i) => i.ref)).toEqual(['claude:k1-2']);
    recordRecall(db, second);
    expect(planRecall(db, asked()).items).toEqual([]);
    recordRecall(db, planRecall(db, inRepo()));
    expect(messages(asked())).toEqual(['claude:k1-1']);
    forget(db, 'claude:k1-1', { reason: 'asked to', author: 'test' });
    expect(messages(asked({ sessionId: 'later' }))).toEqual(['claude:k1-2']);
  });

  it("leaves out sub-agents, headless runs, and other people's words", async () => {
    await seed();
    const ts = NOW - 3 * DAY;
    await fakeLines([
      // A sub-agent's session, and a headless run.
      {
        id: 'c1',
        session: 'child',
        ts,
        role: 'user',
        text: 'Rotate the zephyr signing keys now',
        kinds: [{ session: 'child', kind: 'child', signal: 'test' }],
      },
      {
        id: 'c2',
        session: 'child',
        ts: ts + 1,
        role: 'assistant',
        text: 'Zephyr signing keys rotated.',
      },
      {
        id: 'h1',
        session: 'run',
        ts,
        role: 'user',
        text: 'Rotate the zephyr signing keys for the nightly job',
        kinds: [{ session: 'run', kind: 'headless', signal: 'test' }],
      },
      {
        id: 'h2',
        session: 'run',
        ts: ts + 1,
        role: 'assistant',
        text: 'Zephyr signing keys rotated.',
      },
      // A meeting: another person's words alone.
      {
        id: 'p1',
        session: 'meeting',
        ts,
        role: 'user',
        text: 'Rotate the zephyr signing keys, please',
        author: 'person',
        speaker: 'Sam',
      },
      {
        id: 'p2',
        session: 'meeting',
        ts: ts + 1,
        role: 'assistant',
        text: 'Zephyr signing keys noted.',
      },
      // The owner's conversation, where someone else asked and the agent answered.
      { id: 'm1', session: 'mixed', ts, role: 'user', text: 'Plan the quarterly audit' },
      {
        id: 'm2',
        session: 'mixed',
        ts: ts + 1,
        role: 'user',
        text: 'Rotate the zephyr signing keys today',
        author: 'person',
        speaker: 'Sam',
      },
      {
        id: 'm3',
        session: 'mixed',
        ts: ts + 2,
        role: 'assistant',
        text: 'Agreed: the zephyr signing keys first.',
      },
    ]);
    expect(messages(asked())).toEqual(['fake:m3']);
  });

  it('hands at most one message of a session, and three in all', async () => {
    await seed();
    for (const s of ['a', 'b', 'c', 'd']) {
      say('claude', {
        id: `${s}1`,
        session: s,
        ts: NOW - 3 * DAY,
        role: 'user',
        text: `Check the release of ${s}`,
        cwd: REPO,
      });
      // Session a has two messages that match, the others one each.
      for (const n of s === 'a' ? [2, 3] : [2]) {
        say('claude', {
          id: `${s}${n}`,
          session: s,
          ts: NOW - 3 * DAY + n,
          role: 'assistant',
          text: 'The zephyr signing keys are rotated.',
          cwd: REPO,
        });
      }
    }
    await sync('claude');
    const got = messages(asked());
    expect(got).toHaveLength(3);
    expect(new Set(got.map((ref) => ref.slice(0, -1))).size).toBe(3);
  });

  it('needs the same evidence as an entry: one word alone does not match', async () => {
    await seed();
    say('claude', {
      id: 'w1',
      session: 'w',
      ts: NOW - 3 * DAY,
      role: 'user',
      text: 'Why is the build called zephyr?',
      cwd: REPO,
    });
    await sync('claude');
    expect(messages(asked())).toEqual([]);
  });

  it('is rebuilt from where its excerpt started, and a forgotten message is missing', async () => {
    await seed();
    const reply = `${'We looked at the build output first. '.repeat(8)}Then the zephyr signing keys were rotated with the vault script.\n\n${'Other notes follow here. '.repeat(30)}`;
    say('claude', {
      id: 'v1',
      session: 'v',
      ts: NOW - 3 * DAY,
      role: 'user',
      text: 'What changed in the release?',
      cwd: REPO,
    });
    say('claude', {
      id: 'v2',
      session: 'v',
      ts: NOW - 3 * DAY + 1,
      role: 'assistant',
      text: reply,
      cwd: REPO,
    });
    await sync('claude');
    const plan = planRecall(db, asked());
    const item = plan.items[0];
    expect(item).toMatchObject({ layer: 'messages', kind: 'event', ref: 'claude:v2' });
    const start = item?.excerpt as number;
    expect(start).toBeGreaterThan(0);
    // About 12 tokens before the word, at the start of a word.
    expect([...reply].slice(start).join('')).toMatch(
      /^We looked at the build output first\. Then the zephyr/,
    );
    expect(item?.line).toMatch(
      /^- claude:v2 \(claude, \d{4}-\d\d-\d\d, assistant\) …We looked at the build output first\. Then the zephyr signing keys .*…$/,
    );
    expect(estimateTokens(item?.line.slice(item.line.indexOf(') ') + 2) ?? '')).toBeLessThanOrEqual(
      60,
    );

    const id = recordRecall(db, plan);
    const recall = getRecall(db, id) as RecallRecord;
    expect(recall.items).toEqual([
      {
        rank: 1,
        layer: 'messages',
        kind: 'event',
        ref: 'claude:v2',
        score: item?.score,
        tokens: item?.tokens,
        excerpt: start,
      },
    ]);
    // Only ids and numbers: the message's text is not in the record.
    expect(JSON.stringify(db.prepare('SELECT * FROM recall_item').all())).not.toContain('zephyr');
    const rebuilt = rebuildRecall(db, recall);
    expect(rebuilt.text).toBe(recallText(plan, id));
    expect(rebuilt.lines.get('claude:v2')).toBe(item?.line);

    // The agent opened it.
    say('codex', {
      id: 'n1',
      session: 'now',
      ts: NOW + 1,
      role: 'assistant',
      kind: 'tool_use',
      text: 'origin get {"id":"claude:v2"}',
      cwd: REPO,
    });
    await sync('codex');
    expect(usedRefs(db, recall)).toEqual(new Set(['claude:v2']));

    forget(db, 'claude:v2', { reason: 'asked to', author: 'test' });
    const after = rebuildRecall(db, recall);
    expect(after.missing).toEqual(['claude:v2']);
    expect(after.text).toBe('');
  });

  it('cuts an excerpt a little before the word it is about, at the start of a word', () => {
    expect(excerptStart('Rotate the keys', 'rotate')).toBe(0);
    expect(excerptStart('Nothing here', 'zephyr')).toBe(0);
    const text = `${'alpha beta gamma '.repeat(10)}zephyr ${'tail '.repeat(100)}`;
    const start = excerptStart(text, 'zephyr');
    expect(start).toBeGreaterThan(0);
    expect(text[start - 1]).toBe(' ');
    expect(start).toBeGreaterThan(text.indexOf('zephyr') - 52);
    const excerpt = messageExcerpt(text, start);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('zephyr');
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(60);
    // As a whole word where it is one, not inside another.
    const words = `zephyrs ${'x '.repeat(60)}zephyr`;
    expect(excerptStart(words, 'zephyr')).toBeGreaterThan(words.indexOf(' zephyr') - 52);
    expect(excerptStart('zephyrs blew', 'zephyr')).toBe(0);
    expect(messageExcerpt('a  b\n\nc', 0)).toBe('a b c');
    // CJK: the lead is counted in tokens, one per letter, and the offset in code points.
    const cjk = `𠀀${'这是一段很长的前文内容'.repeat(3)}签名密钥已经轮换`;
    const at = excerptStart(cjk, '签名');
    expect([...cjk].slice(at).join('')).toMatch(/签名密钥已经轮换$/);
    expect([...cjk].length - at).toBe(12 + 8);
    expect(messageExcerpt(cjk, at)).toBe(`…${[...cjk].slice(at).join('')}`);
  });
});

describe('the scope of a recall', () => {
  it('is the work tree that holds the directory, looked up on disk only where asked', () => {
    const repo = path.join(logs, 'acme');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    expect(recallScope(path.join(repo, 'src'))).toEqual({
      cwd: path.join(repo, 'src'),
      root: repo,
      project: 'acme',
    });
    // A hub cannot see the agent's disk: the directory is the project.
    expect(recallScope('C:\\work\\acme', { onDisk: false })).toEqual({
      cwd: 'C:\\work\\acme',
      root: null,
      project: 'acme',
    });
  });
});

describe('replicating recalls', () => {
  it('sends the recalls a store made, validated, and stores them once on the hub', async () => {
    await seed();
    note('Approve releases only when the user asks', 'origin');
    const id = recordRecall(db, planRecall(db, inRepo()));
    recordRecall(db, planRecall(db, inRepo()), { origin: 'desktop' }); // made for another device
    const own = ownRecalls(db, 0);
    expect(own.map((r) => r.recall.id)).toEqual([id]);
    expect(ownRecalls(db, own[0]?.seq ?? 0)).toEqual([]);

    const sent = JSON.parse(JSON.stringify(own[0]?.recall));
    const hub = openMemoryDatabase();
    try {
      expect(receiveRecall(hub, parseReplicaRecall(sent))).toBe('applied');
      expect(receiveRecall(hub, parseReplicaRecall(sent))).toBe('exists');
      expect(getRecall(hub, id)).toEqual(getRecall(db, id));
      const changed = { ...sent, tokens: sent.tokens + 1 };
      expect(() => receiveRecall(hub, parseReplicaRecall(changed))).toThrow(/different content/);
    } finally {
      hub.close();
    }
    // An item can be a thread of sessions (version 5).
    const thread = {
      ...sent,
      items: [{ ...sent.items[0], kind: 'thread', ref: 'thr_0123456789ab' }],
    };
    expect(parseReplicaRecall(thread).items[0]).toMatchObject({ kind: 'thread' });
    for (const bad of [
      { ...sent, items: [{ ...sent.items[0], kind: 'project' }] },
      { ...sent, id: 'rcl_nothex000000' },
      { ...sent, occasion: 'later' },
      { ...sent, promptHash: 'abc' },
      { ...sent, items: [{ ...sent.items[0], rank: 2 }] },
      { ...sent, items: [{ ...sent.items[0], layer: 'secret' }] },
      { ...sent, origin: 'Not A Name' },
    ]) {
      expect(() => parseReplicaRecall(bad)).toThrow(/Invalid/);
    }
  });

  it('carries where a past message’s excerpt starts, and takes recalls without it', async () => {
    await seed();
    note('Approve releases only when the user asks', 'origin');
    const id = recordRecall(db, planRecall(db, inRepo()));
    const sent = JSON.parse(JSON.stringify(ownRecalls(db, 0)[0]?.recall));
    expect(sent.items[0]).toMatchObject({ kind: 'entry', excerpt: null });
    const message = {
      rank: 2,
      layer: 'messages',
      kind: 'event',
      ref: 'claude:s1-2',
      score: 3.5,
      tokens: 20,
    };
    const withMessage = { ...sent, items: [sent.items[0], { ...message, excerpt: 17 }] };
    const hub = openMemoryDatabase();
    try {
      expect(receiveRecall(hub, parseReplicaRecall(withMessage))).toBe('applied');
      expect(getRecall(hub, id)?.items[1]).toEqual({ ...message, excerpt: 17 });
      expect(receiveRecall(hub, parseReplicaRecall(withMessage))).toBe('exists');
      const moved = { ...sent, items: [sent.items[0], { ...message, excerpt: 18 }] };
      expect(() => receiveRecall(hub, parseReplicaRecall(moved))).toThrow(/different content/);
    } finally {
      hub.close();
    }
    // A device of an earlier version sends no excerpt at all.
    const old = { ...sent, items: sent.items.map(({ excerpt: _, ...i }: { excerpt: null }) => i) };
    expect(parseReplicaRecall(old).items[0]).toMatchObject({ kind: 'entry', excerpt: null });
    expect(parseReplicaRecall({ ...sent, items: [sent.items[0], message] }).items[1]).toMatchObject(
      { kind: 'event', excerpt: null },
    );
    for (const excerpt of [-1, 1.5, '3', 2e6]) {
      const bad = { ...sent, items: [sent.items[0], { ...message, excerpt }] };
      expect(() => parseReplicaRecall(bad)).toThrow(/Invalid/);
    }
    // Only a message has an excerpt.
    const entry = { ...sent, items: [{ ...sent.items[0], excerpt: 3 }] };
    expect(() => parseReplicaRecall(entry)).toThrow(/Invalid/);
  });
});
