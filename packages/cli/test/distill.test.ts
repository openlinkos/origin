import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeAdapter } from '@openlinkos/origin-adapters';
import {
  type Database,
  dbPath,
  initStoreName,
  listProposals,
  listSessions,
  openDatabase,
  syncSource,
  threadIdOf,
} from '@openlinkos/origin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import {
  agentCommand,
  claudeArgs,
  DENIED_TOOLS,
  DISTILL_HEADER,
  distillPrompt,
  distillScope,
  findOnPath,
  lastJson,
  mcpConfig,
  spawnSpec,
} from '../src/distill.js';
import { main } from '../src/main.js';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('../../adapters/test/fixtures/', import.meta.url));
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const ENV = [
  'ORIGIN_HOME',
  'ORIGIN_CLAUDE_PROJECTS',
  'ORIGIN_DEVICE',
  'ORIGIN_HUB_URL',
  'ORIGIN_DISTILL_COMMAND',
  'FAKE_CLAUDE_RECORD',
  'FAKE_CLAUDE_CITE',
  'FAKE_CLAUDE_FAIL',
  'PATH',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-distill-'));
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the scope of a run', () => {
  let db: Database;
  let logs: string;

  beforeEach(async () => {
    logs = path.join(tmp, 'logs');
    fs.mkdirSync(logs);
    const write = (file: string, lines: Array<Record<string, unknown>>) =>
      fs.writeFileSync(
        path.join(logs, file),
        `${lines.map((l) => JSON.stringify({ role: 'user', ...l })).join('\n')}\n`,
      );
    write('old.jsonl', [{ id: 'o1', session: 'old', ts: NOW - 72 * HOUR, text: 'Old work.' }]);
    write('a.jsonl', [
      { id: 'a1', session: 'a', ts: NOW - 5 * HOUR, text: 'Pick SQLite for the store.' },
      { id: 'a2', session: 'a', ts: NOW - 4 * HOUR, role: 'assistant', text: 'Done.' },
    ]);
    write('b.jsonl', [
      { id: 'b1', session: 'b', ts: NOW - 2 * HOUR, text: 'Add a cache.', branch: 'feat-cache' },
    ]);
    write('c.jsonl', [
      {
        id: 'c1',
        session: 'c',
        ts: NOW - 60 * HOUR,
        text: 'Cache, first try.',
        branch: 'feat-cache',
      },
    ]);
    write('run.jsonl', [
      {
        id: 'r1',
        session: 'run',
        ts: NOW - HOUR,
        text: `${DISTILL_HEADER} consolidate the user's memory of project demo.`,
      },
    ]);
    write('x.jsonl', [
      { id: 'x1', session: 'x', ts: NOW - HOUR, text: 'Elsewhere.', project: 'other' },
    ]);
    write('p.jsonl', [
      {
        id: 'p1',
        session: 'a',
        ts: NOW - 3 * HOUR,
        kind: 'tool_result',
        text: JSON.stringify(
          {
            proposal: 'prp_0000000000d1',
            kind: 'memory',
            text: 'Chose SQLite for the store.',
            confidence: 0.8,
            project: 'demo',
            valid_from: null,
            valid_to: null,
            note: null,
            sources: [{ event_id: 'fake:a1', quote: null }],
          },
          null,
          2,
        ),
      },
    ]);
    db = openDatabase(path.join(tmp, 'home', 'origin.db'));
    await syncSource({ db, home: path.join(tmp, 'home') }, fakeAdapter(logs));
  });
  afterEach(() => db.close());

  it('is the last 24 hours of the project by default, without earlier runs', () => {
    const scope = distillScope(db, { project: 'demo' }, { now: NOW, cwd: tmp });
    expect(scope).toMatchObject({
      project: 'demo',
      thread: null,
      from: NOW - 24 * HOUR,
      until: NOW,
      label: 'the last 24 hours',
      recent: true,
      moreSessions: 0,
      morePending: 0,
      cwd: tmp,
    });
    expect(scope.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(scope.pending.map((p) => p.id)).toEqual(['prp_0000000000d1']);
    // The same store, options, and time give the same scope.
    expect(distillScope(db, { project: 'demo' }, { now: NOW, cwd: tmp })).toEqual(scope);
  });

  it('takes the project of the work tree it runs in, a time range, or a thread', () => {
    const work = path.join(tmp, 'demo');
    fs.mkdirSync(path.join(work, '.git'), { recursive: true });
    fs.mkdirSync(path.join(work, 'src'));
    expect(distillScope(db, {}, { now: NOW, cwd: path.join(work, 'src') }).project).toBe('demo');

    const week = distillScope(db, { project: 'demo', since: '7d' }, { now: NOW, cwd: tmp });
    expect(week.sessions.map((s) => s.sessionId)).toEqual(['old', 'c', 'a', 'b']);
    expect(week.recent).toBe(false);

    const thread = threadIdOf('fake', 'c');
    const whole = distillScope(db, { thread }, { now: NOW, cwd: tmp });
    expect(whole).toMatchObject({
      project: 'demo',
      thread: { id: thread },
      from: null,
      label: 'the whole thread',
    });
    expect(whole.sessions.map((s) => s.sessionId)).toEqual(['c', 'b']);

    expect(() =>
      distillScope(db, { day: '2026-10-20', since: '7d' }, { now: NOW, cwd: tmp }),
    ).toThrow(/not both/);
    expect(() => distillScope(db, { day: '20 October' }, { now: NOW, cwd: tmp })).toThrow(
      /Not a day/,
    );
    expect(() => distillScope(db, { thread: 'thr_000000000000' }, { now: NOW, cwd: tmp })).toThrow(
      /Unknown thread/,
    );
  });

  it('is a local day with --day', () => {
    const day = new Date(NOW - 72 * HOUR);
    const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const scope = distillScope(db, { project: 'demo', day: name }, { now: NOW, cwd: tmp });
    expect(scope.label).toBe(`the day of ${name}`);
    expect(scope.from).toBe(new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime());
    expect(scope.until - (scope.from as number)).toBe(24 * HOUR - 1);
    expect(scope.sessions.map((s) => s.sessionId)).toContain('old');
  });

  it('becomes a prompt that says what to read, what to propose, and what is pending', () => {
    const scope = distillScope(db, { project: 'demo' }, { now: NOW, cwd: tmp });
    const prompt = distillPrompt(scope, { max: 4 });
    expect(
      prompt.startsWith(
        `${DISTILL_HEADER} consolidate the user's memory of project demo, the last 24 hours.`,
      ),
    ).toBe(true);
    for (const part of [
      "You are running headless, on behalf of the user, as Origin's consolidation task.",
      '- fake a: ',
      '- fake b: ',
      '`changes` (`project`: "demo", no cursor)',
      '`search` the entries',
      'Call `propose` for each, citing the events it rests on by id',
      'Never call `remember`, `correct`, `forget`, or `follow`',
      'Propose at most 4 entries.',
      '- prp_0000000000d1 (memory): Chose SQLite for the store.',
      'end with one line that says how many entries you proposed',
    ]) {
      expect(prompt).toContain(part);
    }
    expect(prompt).not.toContain('fake run');
    const empty = distillScope(db, { project: 'nothing' }, { now: NOW, cwd: tmp });
    expect(distillPrompt(empty, { max: 1 })).toContain('Propose nothing, and say so');
    expect(distillPrompt(empty, { max: 1 })).toContain('Propose at most 1 entry.');
  });
});

describe('the command of a run', () => {
  it('runs claude headless with this Origin alone, its tools only, and none that write', () => {
    const args = claudeArgs({
      configFile: '/tmp/x/mcp.json',
      maxTurns: 12,
      sessionId: '11111111-2222-4333-8444-555555555555',
      name: 'Origin distill: demo, the last 24 hours',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--mcp-config',
      '/tmp/x/mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__origin__*',
      '--disallowedTools',
      'mcp__origin__remember,mcp__origin__correct,mcp__origin__forget,mcp__origin__follow',
      '--tools',
      '',
      '--max-turns',
      '12',
      '--session-id',
      '11111111-2222-4333-8444-555555555555',
      '--name',
      'Origin distill: demo, the last 24 hours',
    ]);
    expect(DENIED_TOOLS).not.toContain('mcp__origin__propose');
    const config = mcpConfig({
      home: tmp,
      bin: '/opt/origin/dist/bin.js',
      node: '/usr/bin/node',
      env: {
        ORIGIN_DEVICE: 'laptop',
        ORIGIN_DISTILL_COMMAND: 'x',
        ORIGIN_HUB_TOKEN: 'ogn_secret',
        ORIGIN_RAW_S3_SECRET_ACCESS_KEY: 'secret',
        HOME: '/home/u',
        ORIGIN_HOME: 'elsewhere',
      },
    });
    expect(config).toEqual({
      mcpServers: {
        origin: {
          type: 'stdio',
          command: '/usr/bin/node',
          args: ['/opt/origin/dist/bin.js', 'mcp'],
          env: { ORIGIN_DEVICE: 'laptop', ORIGIN_HOME: path.resolve(tmp) },
        },
      },
    });
  });

  it('finds claude on the PATH, or the command ORIGIN_DISTILL_COMMAND names', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    fs.writeFileSync(path.join(bin, name), '');
    expect(findOnPath('claude', { PATH: bin, PATHEXT: '.EXE;.CMD' })).toBe(path.join(bin, name));
    expect(agentCommand({ PATH: path.join(tmp, 'none') })).toBeNull();
    expect(agentCommand({ ORIGIN_DISTILL_COMMAND: FAKE })).toEqual({
      file: process.execPath,
      prefix: [FAKE],
      batch: false,
    });
    // A Windows batch file, such as npm's shim, runs through cmd.exe, its arguments quoted.
    const spec = spawnSpec({ file: 'C:\\npm\\claude.cmd', prefix: [], batch: true }, [
      '--tools',
      '',
      '--name',
      'Origin distill: a, b',
    ]);
    expect(spec.verbatim).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spec.args[3]).toBe(
      '"C:\\npm\\claude.cmd ^"--tools^" ^"^" ^"--name^" ^"Origin^ distill:^ a^,^ b^""',
    );
  });

  it('reads the result claude prints, even after other output', () => {
    expect(lastJson('{"session_id":"s","num_turns":3}')).toEqual({ session_id: 's', num_turns: 3 });
    expect(lastJson('warming up\n{"session_id":"s"}\n')).toEqual({ session_id: 's' });
    expect(lastJson('nothing')).toBeNull();
  });
});

describe('origin distill', () => {
  let home: string;
  let projects: string;
  let record: string;
  let out: string[];
  let err: string[];
  /** The fixture session's user message, which the fake agent cites. */
  const CITED = 'claude-code:22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    home = path.join(tmp, 'home');
    projects = path.join(tmp, 'projects');
    record = path.join(tmp, 'record.json');
    fs.cpSync(path.join(fixtures, 'claude-code'), projects, { recursive: true });
    const db = openDatabase(dbPath(home));
    initStoreName(db, 'laptop');
    await syncSource({ db, home }, createClaudeCodeAdapter({ projectsDir: projects }));
    db.close();
    for (const k of ENV) if (k !== 'PATH') delete process.env[k];
    process.env.ORIGIN_HOME = home;
    process.env.ORIGIN_CLAUDE_PROJECTS = projects;
    process.env.ORIGIN_DISTILL_COMMAND = FAKE;
    process.env.FAKE_CLAUDE_RECORD = record;
    process.env.FAKE_CLAUDE_CITE = CITED;
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      err.push(args.join(' '));
    });
  });

  const recorded = () =>
    JSON.parse(fs.readFileSync(record, 'utf8')) as {
      args: string[];
      prompt: string;
      originHome: string;
      mcpConfig: { mcpServers: { origin: { args: string[]; env: Record<string, string> } } };
    };

  it('runs the agent on the scope, ingests its session, and lists what it proposed', async () => {
    expect(
      await main(['distill', '--project', 'project', '--since', '2026-10-01', '--max', '3']),
    ).toBe(0);
    const run = recorded();
    expect(
      run.prompt.startsWith(`${DISTILL_HEADER} consolidate the user's memory of project project`),
    ).toBe(true);
    expect(run.prompt).toContain('0f1e2d3c-4b5a-4697-8877-665544332211');
    expect(run.prompt).toContain('Propose at most 3 entries.');
    expect(run.args.slice(0, 6)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--mcp-config',
      expect.any(String),
      '--strict-mcp-config',
    ]);
    expect(run.args).toContain('--max-turns');
    expect(run.args[run.args.indexOf('--max-turns') + 1]).toBe('40');
    const session = run.args[run.args.indexOf('--session-id') + 1] as string;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    // This Origin, with this store, and no other server.
    expect(run.mcpConfig.mcpServers.origin.args.at(-1)).toBe('mcp');
    expect(run.mcpConfig.mcpServers.origin.env.ORIGIN_HOME).toBe(path.resolve(home));
    expect(run.originHome).toBe(path.resolve(home));
    // The config file was removed once the run ended.
    expect(fs.existsSync(run.args[4] as string)).toBe(false);

    const db = openDatabase(dbPath(home));
    const proposals = listProposals(db, { session: { source: 'claude-code', sessionId: session } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'knowledge', sources: [{ eventId: CITED }] });
    // A later run leaves this one's session out of its scope, though it is in the project.
    const project = path.basename(process.cwd());
    expect(listSessions(db, { project, limit: 1000 }).map((s) => s.sessionId)).toContain(session);
    const again = distillScope(
      db,
      { project, since: '2026-10-01' },
      { now: Date.now(), cwd: process.cwd() },
    );
    expect(again.sessions.map((s) => s.sessionId)).not.toContain(session);
    db.close();

    const said = out.join('\n');
    expect(said).toContain(`Session ${session}: 3 turns, 4.2s, $0.01.`);
    expect(said).toContain('The agent said: Proposed 1 entry.');
    expect(said).toContain('It proposed 1 entry:');
    expect(said).toContain(proposals[0]?.id);
  });

  it('prints the prompt and the command with --dry-run, and runs nothing', async () => {
    expect(await main(['distill', '--project', 'project', '--dry-run'])).toBe(0);
    const said = out.join('\n');
    expect(said).toContain('Prompt (on standard input):');
    expect(said).toContain(
      `${DISTILL_HEADER} consolidate the user's memory of project project, the last 24 hours.`,
    );
    expect(said).toContain(
      'claude -p --output-format json --mcp-config "<mcp config>" --strict-mcp-config',
    );
    expect(said).toContain('--allowedTools "mcp__origin__*"');
    expect(said).toContain('"ORIGIN_HOME"');
    expect(said).toContain('Nothing was run (--dry-run).');
    expect(fs.existsSync(record)).toBe(false);
  });

  it('refuses other agents, and says so when claude cannot be found or fails', async () => {
    expect(await main(['distill', '--agent', 'codex'])).toBe(1);
    expect(err.join('\n')).toContain('runs claude-code for now, not codex');

    delete process.env.ORIGIN_DISTILL_COMMAND;
    process.env.PATH = path.join(tmp, 'nowhere');
    expect(await main(['distill', '--project', 'project'])).toBe(1);
    expect(err.join('\n')).toContain('Claude Code (claude) is not on the PATH');
    process.env.PATH = saved.PATH;

    process.env.ORIGIN_DISTILL_COMMAND = FAKE;
    process.env.FAKE_CLAUDE_FAIL = '1';
    err.length = 0;
    expect(await main(['distill', '--project', 'project'])).toBe(1);
    expect(err.join('\n')).toContain('without a result');
    expect(err.join('\n')).toContain('fake claude: not signed in');
    expect(await main(['distill', '--max', '0'])).toBe(1);
  });
});
