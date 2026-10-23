/**
 * A session's events grouped into turns, for its page. A turn starts at a prompt the user typed (a
 * prompt of `sessionPrompts` in core, which applies the rule of provisional names) and holds every
 * event until the next one. In a turn, tool calls are paired with their results, command echoes and
 * injected context become notes, and the last reply of the agent is told apart from the work that
 * led to it. Pure functions over the events of one page.
 */
import type { EventRow, SessionPrompt, TurnStart } from '@openlinkos/origin-core';

/** A command echo, its output, a notice, injected context, or a system event: shown small. */
export interface Note {
  kind: 'command' | 'output' | 'notice' | 'context' | 'system';
  /** One short line. */
  label: string;
  /** The whole text, when the label does not say it all; null otherwise. */
  detail: string | null;
}

export type ToolStatus = 'ok' | 'error' | 'pending';

export interface ToolRun {
  name: string;
  /** The argument that says what the call was about: a path, a command, a pattern, a URL, … */
  argument: string;
  /** The input as recorded, after the tool's name. */
  input: string;
  call: EventRow | null;
  result: EventRow | null;
  status: ToolStatus;
}

export type TurnItem =
  | { type: 'message'; event: EventRow; subAgent: boolean }
  | { type: 'tool'; tool: ToolRun; subAgent: boolean }
  | { type: 'note'; event: EventRow; note: Note; subAgent: boolean };

export interface ToolSummary {
  calls: number;
  ok: number;
  error: number;
  pending: number;
  /** Calls per tool name, most used first. */
  byName: Array<{ name: string; count: number }>;
  /** Messages of the agent among the work. */
  messages: number;
}

export interface Turn {
  /** 1 for the first prompt; 0 for what came before it. */
  number: number;
  /** The event the turn starts at: a prompt, or a command (see `command`). */
  prompt: EventRow | null;
  /** For a turn that starts at a command the agent acted on, the command and its arguments. */
  command: string | null;
  /** The first and last event of the turn on this page. */
  startedAt: number;
  endedAt: number;
  /** Notes between the prompt and the work, such as the caveat and output of a command. */
  lead: TurnItem[];
  /** Everything between the lead and the reply, in order. */
  work: TurnItem[];
  /** The agent's last message, after which it called no tool; null if there is none. */
  reply: EventRow | null;
  /** Notes after the reply. */
  trail: TurnItem[];
  tools: ToolSummary;
  events: number;
}

const meta = (e: EventRow): Record<string, unknown> => e.meta ?? {};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Whether an event belongs to a sub-agent's thread (Claude Code's sidechains). */
export function isSubAgent(e: EventRow): boolean {
  return meta(e).sidechain === true;
}

/** Terminal colours in command output. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

function element(text: string, name: string): string | null {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<${n}(?:\\s[^<>]*)?>([\\s\\S]*?)</${n}>`).exec(text);
  return m ? (m[1] ?? '').trim() : null;
}

function firstLine(text: string, max = 140): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The detail of a note: its whole text, unless the label already shows all of it. */
function detailOf(label: string, text: string): string | null {
  const t = text.trim();
  return t === '' || t === label ? null : t.length > 8000 ? `${t.slice(0, 8000)}…` : t;
}

/**
 * What a user message that is not a prompt, a `meta` event, or a system event says, as a note:
 * Claude Code's command echoes (`<command-name>`) and their output (`<local-command-stdout>`),
 * notices such as `[Request interrupted by user]`, and context agents inject (named by the element
 * it starts with, such as `system-reminder` or Codex's `environment_context`).
 */
export function noteOf(e: EventRow): Note {
  const text = e.text.replace(ANSI, '');
  if (e.kind === 'system' || e.role === 'system') {
    const label = firstLine(text);
    return { kind: 'system', label, detail: detailOf(label, text) };
  }
  const command = element(text, 'command-name');
  if (command !== null) {
    const args = element(text, 'command-args') ?? '';
    const label = firstLine(`${command}${args ? ` ${args}` : ''}`);
    return { kind: 'command', label, detail: null };
  }
  const stdout = element(text, 'local-command-stdout') ?? element(text, 'local-command-stderr');
  if (stdout !== null) {
    const label = firstLine(stdout) || '—';
    return { kind: 'output', label, detail: detailOf(label, stdout) };
  }
  const trimmed = text.trim();
  if (/^\[[^\]\n]{1,200}\]$/.test(trimmed)) return { kind: 'notice', label: trimmed, detail: null };
  const tag = /^\s*<([A-Za-z][\w.:-]*)/.exec(text)?.[1];
  const inner = tag ? element(text, tag) : null;
  const label = tag ? (inner ? `${tag}: ${firstLine(inner, 100)}` : tag) : firstLine(text);
  return { kind: 'context', label, detail: detailOf(label, text) };
}

// ---------------------------------------------------------------------------------------------
// Tools

/** The name of the tool an event calls: from its meta, or the first word of its text. */
export function toolName(e: EventRow): string {
  return str(meta(e).toolName) ?? (e.text.split(/\s/, 1)[0] || 'tool');
}

/** The input of a call, as recorded after the tool's name. */
export function toolInput(e: EventRow, name = toolName(e)): string {
  return e.text.startsWith(`${name} `) ? e.text.slice(name.length + 1) : e.text;
}

/** Keys whose value says what a call was about, in order of preference. */
const KEY_ARGUMENTS = [
  'file_path',
  'filePath',
  'notebook_path',
  'command',
  'cmd',
  'pattern',
  'query',
  'url',
  'uri',
  'path',
  'paths',
  'skill',
  'description',
  'prompt',
  'subject',
  'title',
  'name',
];

const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'powershell.exe',
  'cmd',
  'cmd.exe',
]);

function oneLine(text: string, max = 160): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A command given as a list of words, without the shell that runs it. */
function commandWords(words: unknown[]): string | null {
  const w = words.filter((x): x is string => typeof x === 'string');
  if (w.length === 0) return null;
  if (SHELLS.has((w[0] ?? '').toLowerCase()) && /^-(l?c|Command)$/i.test(w[1] ?? '')) {
    return w.slice(2).join(' ');
  }
  return w.join(' ');
}

function valueText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (Array.isArray(v)) return commandWords(v);
  return null;
}

/** A path relative to the session's working directory, when it is inside it. */
function relative(value: string, cwd: string | null): string {
  if (!cwd) return value;
  const base = cwd.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) {
    if (value.startsWith(base + sep)) return value.slice(base.length + 1);
  }
  return value;
}

/**
 * The argument that says what a call was about: the file it reads or edits, the command it runs,
 * the pattern or query it searches for, the URL it fetches (the first of KEY_ARGUMENTS present in
 * its JSON input, also when the input was cut short), the files a patch touches, or the first line
 * of a plain-text input; else a short preview of the input.
 */
export function toolArgument(input: string, cwd: string | null = null): string {
  const text = input.trim();
  if (text === '') return '';
  const patch = [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) =>
    relative((m[1] ?? '').trim(), cwd),
  );
  if (patch.length > 0) {
    return oneLine(patch.length === 1 ? (patch[0] ?? '') : `${patch[0]} +${patch.length - 1}`);
  }
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const key of KEY_ARGUMENTS) {
          const v = valueText(obj[key]);
          if (v !== null) return oneLine(relative(v, cwd));
        }
        for (const v of Object.values(obj)) {
          if (typeof v === 'string' && v.trim() !== '' && v.length <= 200) return oneLine(v);
        }
        return oneLine(text, 80);
      }
    } catch {
      // cut short: look for the first key argument in the text itself
      for (const key of KEY_ARGUMENTS) {
        const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
        if (!m) continue;
        let v = m[1] ?? '';
        try {
          v = JSON.parse(`"${v}"`) as string;
        } catch {
          // an escape cut in half: keep it as it is
        }
        if (v.trim() !== '') return oneLine(relative(v, cwd));
      }
      return oneLine(text, 80);
    }
  }
  return oneLine(text.split('\n')[0] ?? '');
}

/** A call's outcome, from its result: an error flag (Claude Code) or a status other than done. */
export function resultStatus(result: EventRow | null): ToolStatus {
  if (!result) return 'pending';
  const m = meta(result);
  if (m.isError === true) return 'error';
  const status = str(m.status)?.toLowerCase();
  if (!status || status === 'completed' || status === 'success' || status === 'ok') return 'ok';
  if (status === 'pending' || status === 'in_progress' || status === 'running') return 'pending';
  return 'error';
}

/** The id that pairs a call with its result. */
function callKey(e: EventRow): string | null {
  return str(meta(e).callId) ?? str(meta(e).toolUseId);
}

// ---------------------------------------------------------------------------------------------
// Turns

function summarize(items: TurnItem[]): ToolSummary {
  const byName = new Map<string, number>();
  const s: ToolSummary = { calls: 0, ok: 0, error: 0, pending: 0, byName: [], messages: 0 };
  for (const item of items) {
    if (item.type === 'message') {
      if (item.event.role === 'assistant') s.messages++;
      continue;
    }
    if (item.type !== 'tool') continue;
    s.calls++;
    s[item.tool.status]++;
    byName.set(item.tool.name, (byName.get(item.tool.name) ?? 0) + 1);
  }
  s.byName = [...byName]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return s;
}

/** Split a turn's items into the notes after the prompt, the work, the reply, and later notes. */
function shape(
  number: number,
  start: { prompt: EventRow | null; command: string | null },
  items: TurnItem[],
  all: EventRow[],
): Turn {
  let lead = 0;
  while (lead < items.length && items[lead]?.type === 'note') lead++;
  let reply = -1;
  for (let i = items.length - 1; i >= lead; i--) {
    const item = items[i];
    if (!item || item.type === 'tool') break;
    if (item.type === 'message' && item.event.role === 'assistant' && !item.subAgent) {
      reply = i;
      break;
    }
  }
  const work = items.slice(lead, reply < 0 ? items.length : reply);
  const first = all[0];
  const last = all.at(-1);
  const replyItem = reply < 0 ? undefined : items[reply];
  return {
    number,
    prompt: start.prompt,
    command: start.command,
    startedAt: first?.ts ?? 0,
    endedAt: last?.ts ?? 0,
    lead: items.slice(0, lead),
    work,
    reply: replyItem?.type === 'message' ? replyItem.event : null,
    trail: reply < 0 ? [] : items.slice(reply + 1),
    tools: summarize(work),
    events: all.length,
  };
}

/**
 * Group the events of one page into turns. `starts` are where the turns on the page start (see
 * sessionTurnStarts: prompts, and commands the agent acted on) and `firstNumber` the number of the
 * first of them; events before the first start belong to turn `firstNumber - 1` (0, what came before
 * the first prompt, on the first page). Calls are paired with their results by their call id, or,
 * without one, with the first call before them that has none and no result yet.
 */
export function groupTurns(
  events: EventRow[],
  starts: ReadonlyArray<Pick<TurnStart, 'id'> & Partial<Pick<TurnStart, 'command' | 'prompt'>>>,
  firstNumber: number,
): Turn[] {
  const numbers = new Map(
    starts.map((p, i) => [
      p.id,
      { number: firstNumber + i, command: p.command ? (p.prompt ?? null) : null },
    ]),
  );
  const turns: Turn[] = [];
  let number = firstNumber - 1;
  let start: { prompt: EventRow | null; command: string | null } = { prompt: null, command: null };
  let items: TurnItem[] = [];
  let all: EventRow[] = [];
  const byKey = new Map<string, ToolRun>();
  let unkeyed: ToolRun[] = [];
  const close = () => {
    if (all.length > 0) turns.push(shape(number, start, items, all));
  };
  for (const e of events) {
    const n = numbers.get(e.id);
    if (n !== undefined) {
      close();
      number = n.number;
      start = { prompt: e, command: n.command };
      items = [];
      all = [e];
      continue;
    }
    all.push(e);
    const subAgent = isSubAgent(e);
    if (e.kind === 'tool_use') {
      const name = toolName(e);
      const input = toolInput(e, name);
      const tool: ToolRun = {
        name,
        argument: toolArgument(input, e.cwd),
        input,
        call: e,
        result: null,
        status: 'pending',
      };
      const key = callKey(e);
      if (key !== null) byKey.set(key, tool);
      else unkeyed.push(tool);
      items.push({ type: 'tool', tool, subAgent });
    } else if (e.kind === 'tool_result') {
      const key = callKey(e);
      let tool = key !== null ? byKey.get(key) : unkeyed.shift();
      if (tool && tool.result !== null) tool = undefined;
      if (key !== null) byKey.delete(key);
      if (tool) {
        tool.result = e;
        tool.status = resultStatus(e);
      } else {
        // A result whose call is not on this page.
        items.push({
          type: 'tool',
          tool: {
            name: '?',
            argument: '',
            input: '',
            call: null,
            result: e,
            status: resultStatus(e),
          },
          subAgent,
        });
      }
    } else if (e.kind === 'message' && (e.role === 'assistant' || subAgent)) {
      items.push({ type: 'message', event: e, subAgent });
    } else {
      items.push({ type: 'note', event: e, note: noteOf(e), subAgent });
    }
    if (unkeyed.length > 50) unkeyed = unkeyed.slice(-50);
  }
  close();
  return turns;
}

// ---------------------------------------------------------------------------------------------
// The day index

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a time, in the server's time zone (as the pages show times). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface SessionDay {
  day: string;
  /** The number of the day's first turn. */
  turn: number;
  turns: number;
}

/** The days of a session's turns, in order, each with its first turn and how many start on it. */
export function dayIndex(prompts: ReadonlyArray<Pick<SessionPrompt, 'ts'>>): SessionDay[] {
  const days: SessionDay[] = [];
  prompts.forEach((p, i) => {
    const day = dayKey(p.ts);
    const last = days.at(-1);
    if (last && last.day === day) last.turns++;
    else days.push({ day, turn: i + 1, turns: 1 });
  });
  return days;
}
