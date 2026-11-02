// A stand-in for `claude -p` in the tests of `origin distill` (ORIGIN_DISTILL_COMMAND). It reads
// the prompt on standard input, records how it was run (FAKE_CLAUDE_RECORD), writes a synthetic
// Claude Code transcript under ORIGIN_CLAUDE_PROJECTS in which it proposed one entry citing
// FAKE_CLAUDE_CITE, and prints the JSON result `claude --output-format json` prints. No model, no
// network: everything it writes is made up here.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = fs.readFileSync(0, 'utf8');
const sessionId = option('--session-id') ?? '00000000-0000-4000-8000-000000000000';
const configFile = option('--mcp-config');

if (process.env.FAKE_CLAUDE_RECORD) {
  fs.writeFileSync(
    process.env.FAKE_CLAUDE_RECORD,
    JSON.stringify({
      args,
      prompt,
      cwd: process.cwd(),
      originHome: process.env.ORIGIN_HOME,
      mcpConfig: configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null,
    }),
  );
}
if (process.env.FAKE_CLAUDE_FAIL) {
  process.stderr.write('fake claude: not signed in\n');
  process.exit(1);
}

const proposal = process.env.FAKE_CLAUDE_PROPOSAL ?? `prp_${randomBytes(6).toString('hex')}`;
const result = {
  proposal,
  kind: 'knowledge',
  text: 'The demo project keeps its fixtures synthetic.',
  confidence: 0.7,
  project: 'project',
  valid_from: null,
  valid_to: null,
  note: 'Read from the session of the day.',
  sources: [{ event_id: process.env.FAKE_CLAUDE_CITE ?? 'claude-code:unknown', quote: null }],
};
const cwd = process.cwd();
const dir = path.join(process.env.ORIGIN_CLAUDE_PROJECTS ?? '.', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
const base = { isSidechain: false, cwd, sessionId, version: '2.1.303', gitBranch: 'master' };
const uuid = (n) => `fa4e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lines = [
  {
    ...base,
    parentUuid: null,
    type: 'user',
    uuid: uuid(1),
    timestamp: at(0),
    message: { role: 'user', content: prompt },
  },
  {
    ...base,
    parentUuid: uuid(1),
    type: 'assistant',
    uuid: uuid(2),
    timestamp: at(1),
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_fake1',
          name: 'mcp__origin__propose',
          input: { text: result.text },
        },
      ],
    },
  },
  {
    ...base,
    parentUuid: uuid(2),
    type: 'user',
    uuid: uuid(3),
    timestamp: at(2),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_fake1',
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      ],
    },
  },
  {
    ...base,
    parentUuid: uuid(3),
    type: 'assistant',
    uuid: uuid(4),
    timestamp: at(3),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Proposed 1 entry.' }] },
  },
];
fs.writeFileSync(
  path.join(dir, `${sessionId}.jsonl`),
  `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4200,
    num_turns: 3,
    result: 'Read the day.\nProposed 1 entry.',
    session_id: sessionId,
    total_cost_usd: 0.0123,
  })}\n`,
);
