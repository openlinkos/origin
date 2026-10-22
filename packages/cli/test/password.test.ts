import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readNewPassword } from '../src/password.js';

/** Standard input piped in, as from a script. */
function piped(text: string): PassThrough & { isTTY?: boolean } {
  const input = new PassThrough();
  input.end(text);
  return input;
}

/**
 * A terminal that types each answer once its prompt has appeared, and records everything written to
 * it.
 */
function terminal(answers: Record<string, string>) {
  const input: PassThrough & { isTTY?: boolean } = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString('utf8');
    for (const [prompt, answer] of Object.entries(answers)) {
      if (shown.endsWith(prompt)) setImmediate(() => input.write(`${answer}\r`));
    }
  });
  return { io: { input, output }, shown: () => shown };
}

describe('origin admin password', () => {
  it('reads one line from a pipe', async () => {
    const io = {
      input: piped('correct-horse-battery\r\nsecond line\n'),
      output: new PassThrough(),
    };
    await expect(readNewPassword(io)).resolves.toBe('correct-horse-battery');
  });

  it('refuses an empty pipe or a password that is too short', async () => {
    await expect(readNewPassword({ input: piped(''), output: new PassThrough() })).rejects.toThrow(
      /No password on standard input/,
    );
    await expect(
      readNewPassword({ input: piped('hunter2\n'), output: new PassThrough() }),
    ).rejects.toThrow(/at least 10 characters/);
  });

  it('asks twice on a terminal without echoing what is typed', async () => {
    const t = terminal({
      'New admin password: ': 'typed-on-a-terminal',
      'Repeat it: ': 'typed-on-a-terminal',
    });
    await expect(readNewPassword(t.io)).resolves.toBe('typed-on-a-terminal');
    expect(t.shown()).toContain('New admin password: ');
    expect(t.shown()).toContain('Repeat it: ');
    expect(t.shown()).not.toContain('typed');
  });

  it('refuses answers that do not match, or are too short, on a terminal', async () => {
    const mismatch = terminal({
      'New admin password: ': 'first-answer-here',
      'Repeat it: ': 'second-answer-here',
    });
    await expect(readNewPassword(mismatch.io)).rejects.toThrow(/do not match/);
    const short = terminal({ 'New admin password: ': 'short' });
    await expect(readNewPassword(short.io)).rejects.toThrow(/at least 10 characters/);
    expect(short.shown()).not.toContain('Repeat it');
  });
});
