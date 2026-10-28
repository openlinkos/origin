#!/usr/bin/env node
/**
 * The `origin` command. Agents' hooks run `origin recall` on every prompt, so it loads only what it
 * needs (core and the adapters); every other command loads the whole CLI (main.ts).
 */
const args = process.argv.slice(2);
const { main } = args[0] === 'recall' ? await import('./recall.js') : await import('./main.js');
main(args).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
