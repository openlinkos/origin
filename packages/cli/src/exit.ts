/**
 * End the process with `code` once `streams` (stdout and stderr) have written all they were given.
 * process.exit() alone drops what a pipe has not taken yet: a pipe holds 64 KiB, and Node.js keeps
 * the rest of a write until the reader takes it, so `origin purged <id> --json | jq` would read only
 * the first 64 KiB. A reader that has gone (`| head`) fails the write; the process ends all the same.
 */
export function exitWhenWritten(
  code: number,
  streams: NodeJS.WritableStream[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (c) => process.exit(c),
): void {
  let waiting = streams.length;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    exit(code);
  };
  if (waiting === 0) {
    end();
    return;
  }
  for (const stream of streams) {
    let written = false;
    const done = () => {
      if (written) return;
      written = true;
      waiting -= 1;
      if (waiting === 0) end();
    };
    stream.once('error', done);
    // Writes complete in order: this one's callback runs once everything before it is written.
    stream.write('', done);
  }
}
