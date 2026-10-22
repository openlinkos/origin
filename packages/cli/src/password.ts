import readline from 'node:readline';
import { Writable } from 'node:stream';
import { checkAdminPassword, OriginError } from '@openlinkos/origin-core';

export interface PromptIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Where the prompts go. What is typed is never echoed. */
  output: NodeJS.WritableStream;
}

/** Read the first line of a stream that is not a terminal, without its line break. */
async function readFirstLine(input: NodeJS.ReadableStream): Promise<string | null> {
  const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Questions on a terminal with hidden answers: readline writes the prompt, then its output is muted
 * so that the characters typed are not echoed.
 */
function hiddenPrompt(io: PromptIo): { ask(question: string): Promise<string>; close(): void } {
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) io.output.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input: io.input, output: sink, terminal: true });
  let pending: ((err: Error) => void) | null = null;
  const cancel = () => {
    pending?.(new OriginError('Cancelled; nothing was changed.'));
    pending = null;
  };
  rl.on('SIGINT', () => {
    io.output.write('\n');
    cancel();
  });
  rl.on('close', cancel);
  return {
    ask(question) {
      return new Promise((resolve, reject) => {
        pending = reject;
        muted = false;
        rl.question(question, (answer) => {
          pending = null;
          io.output.write('\n');
          resolve(answer);
        });
        muted = true;
      });
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Read a new admin password for `origin admin password`. On a terminal it is asked twice, hidden,
 * and both must match; otherwise the first line of standard input is used, so that scripts can
 * pipe it in. Throws an OriginError when it is missing or unusable.
 */
export async function readNewPassword(
  io: PromptIo = { input: process.stdin, output: process.stderr },
): Promise<string> {
  if (!io.input.isTTY) {
    const line = await readFirstLine(io.input);
    if (line === null || line === '') {
      throw new OriginError(
        'No password on standard input. Pipe it in as one line, run the command in a terminal (with Docker: docker exec -it), or use --generate.',
      );
    }
    checkAdminPassword(line);
    return line;
  }
  const prompt = hiddenPrompt(io);
  try {
    const first = await prompt.ask('New admin password: ');
    checkAdminPassword(first);
    const second = await prompt.ask('Repeat it: ');
    if (second !== first) throw new OriginError('The passwords do not match; nothing was changed.');
    return first;
  } finally {
    prompt.close();
  }
}
