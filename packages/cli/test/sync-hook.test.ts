import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter, createCodexAdapter } from '@openlinkos/origin-adapters';
import {
  createToken,
  type Database,
  dbPath,
  initStoreName,
  listEvents,
  makeRelay,
  openDatabase,
  readMirror,
  relayCursor,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeHubConfig } from '../src/hub/config.js';
import { createHubServer } from '../src/hub/server.js';
import { main } from '../src/main.js';
import { main as hook, hookFiles } from '../src/sync-hook.js';

const fixtures = fileURLToPath(new URL('../../adapters/test/fixtures/', import.meta.url));
const SESSION = '0f1e2d3c-4b5a-4697-8877-665544332211';
const OTHER = '9a9a9a9a-0000-4000-8000-000000000009';
const SUB = 'agent-a9';
const CODEX_SESSION = '0199f0a1-7c2e-7d3a-9b4c-5e6f7a8b9c0d';
const CODEX_REL = `sessions/2026/10/20/rollout-2026-10-20T09-00-00-${CODEX_SESSION}.jsonl`;
const ENV = [
  'ORIGIN_HOME',
  'ORIGIN_CLAUDE_PROJECTS',
  'CODEX_HOME',
  'ORIGIN_DEVICE',
  'ORIGIN_HUB_URL',
  'ORIGIN_HUB_TOKEN',
] as const;

let tmp: string;
let home: string;
let projects: string;
let transcript: string;
let other: string;
let subagent: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];
let hubs: Array<{ db: Database; server: http.Server }>;

/** A Claude Code user message of a session. */
const userLine = (session: string, uuid: string, text: string, at: string) =>
  `${JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp: at,
    cwd: 'D:\\demo\\project',
    sessionId: session,
    version: '2.1.303',
    gitBranch: 'master',
  })}\n`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sync-hook-'));
  home = path.join(tmp, 'home');
  projects = path.join(tmp, 'projects');
  fs.cpSync(path.join(fixtures, 'claude-code'), projects, { recursive: true });
  transcript = path.join(projects, 'D--demo-project', `${SESSION}.jsonl`);
  other = path.join(projects, 'D--demo-project', `${OTHER}.jsonl`);
  fs.writeFileSync(
    other,
    userLine(
      OTHER,
      '99999999-0000-4000-8000-000000000001',
      'another session',
      '2026-10-19T04:00:00Z',
    ),
  );
  subagent = path.join(projects, 'D--demo-project', SESSION, 'subagents', `${SUB}.jsonl`);
  fs.mkdirSync(path.dirname(subagent), { recursive: true });
  fs.writeFileSync(
    subagent,
    userLine(
      SESSION,
      '99999999-0000-4000-8000-000000000002',
      'search the logs',
      '2026-10-19T03:43:00Z',
    ),
  );
  fs.cpSync(path.join(fixtures, 'codex'), path.join(tmp, 'codex'), { recursive: true });
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ORIGIN_HOME = home;
  process.env.ORIGIN_CLAUDE_PROJECTS = projects;
  process.env.CODEX_HOME = path.join(tmp, 'codex');
  process.env.ORIGIN_DEVICE = 'laptop';
  hubs = [];
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const h of hubs) {
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
    h.db.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run the hook as an agent does, with its event on standard input. */
const run = (agent: string, event: unknown) =>
  hook(['sync', '--hook', agent], {
    stdin: () => (typeof event === 'string' ? event : JSON.stringify(event)),
  });

const stop = (file: string | null) => ({
  session_id: SESSION,
  transcript_path: file,
  cwd: 'D:\\demo\\project',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'Done.',
});

/** Open the store the hook wrote, read it, and close it again. */
function readStore<T>(read: (db: Database) => T): T {
  const db = openDatabase(dbPath(home));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const sessionsOf = (db: Database) => [...new Set(listEvents(db, {}).map((e) => e.sessionId))];

async function startHub(): Promise<{ db: Database; url: string; token: string; home: string }> {
  const hubHome = path.join(tmp, `hub${hubs.length}`);
  const db = openDatabase(path.join(hubHome, 'origin.db'));
  const token = createToken(db, 'laptop');
  const server = createHubServer({
    db,
    home: hubHome,
    adapters: [createClaudeCodeAdapter({ projectsDir: path.join(tmp, 'unused') })],
    version: 'test',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hubs.push({ db, server });
  return {
    db,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    home: hubHome,
  };
}

describe('origin sync --hook', () => {
  it('ingests the transcript a hook names, and that file only, from its cursor', async () => {
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(readStore(sessionsOf)).toEqual([SESSION]);
    expect(readStore((db) => listEvents(db, {}))).toHaveLength(6);

    // Again: nothing new. Then the next turn's lines, and a partial line that waits.
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(readStore((db) => listEvents(db, {}))).toHaveLength(6);
    fs.appendFileSync(
      transcript,
      `${userLine(SESSION, '99999999-0000-4000-8000-000000000003', 'and the tests', '2026-10-19T03:50:00Z')}{"type":"user"`,
    );
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(readStore((db) => listEvents(db, {}).map((e) => e.text))).toContain('and the tests');
    expect(readStore((db) => listEvents(db, {}))).toHaveLength(7);
    expect(out).toEqual([]);

    // The same file a full sync would mirror: one raw file, holding the transcript's lines.
    const rows = readStore(
      (db) =>
        db.prepare('SELECT path, bytes_ingested FROM raw_file').all() as Array<{
          path: string;
          bytes_ingested: number;
        }>,
    );
    expect(rows).toEqual([
      { path: transcript, bytes_ingested: fs.readFileSync(transcript).lastIndexOf(0x0a) + 1 },
    ]);
  });

  it("ingests a sub-agent's transcript with its session's at SubagentStop", async () => {
    const event = {
      ...stop(transcript),
      hook_event_name: 'SubagentStop',
      agent_id: 'a9',
      agent_type: 'Explore',
      agent_transcript_path: subagent,
    };
    expect(await run('claude-code', event)).toBe(0);
    const texts = readStore((db) => listEvents(db, {}).map((e) => e.text));
    expect(texts).toContain('search the logs');
    expect(texts).toContain('帮我检查一下仓库的状态');
    expect(readStore(sessionsOf)).toEqual([SESSION]);
  });

  it('ingests a Codex rollout, and nothing when Codex names none', async () => {
    const rollout = path.join(tmp, 'codex', CODEX_REL);
    expect(await run('codex', { ...stop(null), session_id: CODEX_SESSION })).toBe(0);
    expect(fs.existsSync(dbPath(home))).toBe(false);
    expect(await run('codex', { ...stop(rollout), session_id: CODEX_SESSION })).toBe(0);
    expect(readStore(sessionsOf)).toEqual([CODEX_SESSION]);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it('does nothing, and says why on standard error only, for input it cannot use', async () => {
    const cases: Array<[string, unknown]> = [
      ['claude-code', ''],
      ['claude-code', '   \n'],
      ['claude-code', '{"transcript_path": '],
      ['claude-code', '[1, 2]'],
      ['claude-code', { hook_event_name: 'Stop' }],
      ['claude-code', stop(path.join(projects, 'D--demo-project', 'missing.jsonl'))],
      ['claude-code', stop(path.join(tmp, 'elsewhere.jsonl'))],
      ['claude-code', stop(path.join(projects, 'D--demo-project'))],
      // Claude Code's transcript, given to the Codex hook: not one of Codex's files.
      ['codex', stop(transcript)],
      ['cursor', stop(transcript)],
      ['nobody', stop(transcript)],
    ];
    for (const [agent, event] of cases) expect(await run(agent, event)).toBe(0);
    expect(await hook(['sync', '--hook'], { stdin: () => '' })).toBe(0);
    expect(await hook(['sync', '--hook', 'claude-code', '--bogus'], { stdin: () => '' })).toBe(0);
    expect(out).toEqual([]);
    expect(err.some((e) => e.includes('not JSON'))).toBe(true);
    expect(err.some((e) => e.includes('no ingest hook for "cursor"'))).toBe(true);
    // Nothing to read, so no store was opened, let alone created.
    expect(fs.existsSync(dbPath(home))).toBe(false);
  });

  it('runs through the whole CLI too, and leaves origin sync as it was', async () => {
    expect(await main(['sync', '--hook', 'nobody'])).toBe(0);
    expect(out).toEqual([]);
    expect(fs.existsSync(dbPath(home))).toBe(false);
    expect(await main(['sync', '--local', '--source', 'claude-code'])).toBe(0);
    expect(readStore(sessionsOf).sort()).toEqual([SESSION, OTHER].sort());
  });

  it('serializes hooks that run at once, and ingests each line once', async () => {
    const event = {
      ...stop(transcript),
      hook_event_name: 'SubagentStop',
      agent_transcript_path: subagent,
    };
    const codes = await Promise.all([
      run('claude-code', stop(transcript)),
      run('claude-code', event),
      run('claude-code', { ...stop(other), session_id: OTHER }),
      run('claude-code', stop(transcript)),
    ]);
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(err).toEqual([]);
    expect(readStore((db) => listEvents(db, {}))).toHaveLength(8);
  });

  it('pushes the new lines to the hub on a connected device', async () => {
    const hub = await startHub();
    writeHubConfig(home, { url: hub.url, token: hub.token });
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(err).toEqual([]);
    expect(listEvents(hub.db, {})).toHaveLength(6);
    expect(sessionsOf(hub.db)).toEqual([SESSION]);
    const mirror = () => {
      const row = hub.db.prepare('SELECT id, path FROM raw_file').get() as {
        id: number;
        path: string;
      };
      return {
        path: row.path,
        content: readMirror(hub.db, hub.home, row.id, 0, Number.MAX_SAFE_INTEGER).toString('utf8'),
      };
    };
    expect(mirror()).toEqual({
      path: `@laptop:${transcript}`,
      content: fs.readFileSync(transcript, 'utf8'),
    });

    // The next turn: only its lines go.
    fs.appendFileSync(
      transcript,
      userLine(SESSION, '99999999-0000-4000-8000-000000000004', 'ship it', '2026-10-19T03:55:00Z'),
    );
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(listEvents(hub.db, {}).map((e) => e.text)).toContain('ship it');
    expect(mirror().content).toBe(fs.readFileSync(transcript, 'utf8'));
    expect(out).toEqual([]);
  });

  it('keeps the lines here when the hub cannot be reached, or does not answer in time', async () => {
    writeHubConfig(home, { url: 'http://127.0.0.1:1', token: 'ogn_unused' });
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(readStore((db) => listEvents(db, {}))).toHaveLength(6);
    expect(err.join('\n')).toMatch(/not sent to the hub yet .*the next sync sends it/);

    // A hub that takes the request and never answers: the hook gives up after 3 seconds.
    const silent = http.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
      writeHubConfig(home, { url, token: 'ogn_unused' });
      fs.appendFileSync(
        transcript,
        userLine(SESSION, '99999999-0000-4000-8000-000000000005', 'later', '2026-10-19T04:10:00Z'),
      );
      err = [];
      const started = Date.now();
      expect(await run('claude-code', stop(transcript))).toBe(0);
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(err.join('\n')).toMatch(/no answer within 3 s/);
      expect(readStore((db) => listEvents(db, {}))).toHaveLength(7);
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
    expect(out).toEqual([]);
  }, 15_000);

  it('sends the lines to the hub straight from the transcript on a relay', async () => {
    const hub = await startHub();
    const relay = openDatabase(dbPath(home));
    initStoreName(relay, 'laptop');
    makeRelay(relay);
    relay.close();
    writeHubConfig(home, { url: hub.url, token: hub.token });

    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(err).toEqual([]);
    expect(listEvents(hub.db, {})).toHaveLength(6);
    expect(sessionsOf(hub.db)).toEqual([SESSION]);
    // The relay keeps its cursor, and no events or mirrors.
    readStore((db) => {
      expect(relayCursor(db, 'claude-code', transcript)).toMatchObject({
        generation: 1,
        bytes: fs.statSync(transcript).size,
      });
      expect(listEvents(db, {})).toEqual([]);
    });
    expect(fs.existsSync(path.join(home, 'raw'))).toBe(false);

    fs.appendFileSync(
      transcript,
      userLine(
        SESSION,
        '99999999-0000-4000-8000-000000000006',
        'from the relay',
        '2026-10-19T04:20:00Z',
      ),
    );
    expect(await run('claude-code', stop(transcript))).toBe(0);
    expect(listEvents(hub.db, {}).map((e) => e.text)).toContain('from the relay');
    expect(out).toEqual([]);
  });
});

describe('hookFiles', () => {
  it("reads a hook's transcript and a sub-agent's, as absolute paths", () => {
    const dir = path.resolve('/agents');
    expect(hookFiles({ transcript_path: path.join(dir, 'a.jsonl') })).toEqual([
      path.join(dir, 'a.jsonl'),
    ]);
    expect(
      hookFiles({
        transcript_path: path.join(dir, 'a.jsonl'),
        agent_transcript_path: path.join(dir, 'a', 'subagents', 'agent-1.jsonl'),
      }),
    ).toEqual([path.join(dir, 'a.jsonl'), path.join(dir, 'a', 'subagents', 'agent-1.jsonl')]);
    expect(hookFiles({ transcript_path: '~/.claude/projects/x/a.jsonl' }, dir)).toEqual([
      path.join(dir, '.claude', 'projects', 'x', 'a.jsonl'),
    ]);
    for (const event of [
      null,
      'a.jsonl',
      [],
      {},
      { transcript_path: null },
      { transcript_path: 3 },
    ]) {
      expect(hookFiles(event)).toEqual([]);
    }
    expect(createCodexAdapter({ home: dir }).locate?.(path.join(dir, 'a.jsonl'))).toBeNull();
  });
});

describe('the hook module', () => {
  it('loads only the core, the adapters, and the hub client, so that it starts fast', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const seen = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1] as string;
        if (spec.startsWith('.'))
          visit(path.join(path.dirname(file), spec.replace(/\.js$/, '.ts')));
        else packages.add(spec);
      }
    };
    visit(path.join(src, 'sync-hook.ts'));
    expect([...packages].filter((p) => p.startsWith('@')).sort()).toEqual([
      '@openlinkos/origin-adapters',
      '@openlinkos/origin-core',
    ]);
    expect([...seen].map((f) => path.relative(src, f).split(path.sep).join('/')).sort()).toEqual([
      'hub/bucket.ts',
      'hub/config.ts',
      'hub/relay.ts',
      'hub/s3.ts',
      'hub/sigv4.ts',
      'hub/sync-http.ts',
      'hub/sync.ts',
      'sources.ts',
      'sync-hook.ts',
    ]);
  });
});
