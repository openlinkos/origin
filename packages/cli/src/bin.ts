#!/usr/bin/env node
/**
 * The `origin` command. Agents' hooks run `origin recall` on every prompt and `origin sync --hook`
 * after every turn, so these load only what they need (core, the adapters, and for the latter the
 * hub client); every other command loads the whole CLI (main.ts).
 */
const args = process.argv.slice(2);
// As isHookCall in sync-hook.ts, which this must not load for other commands.
const hook = args[0] === 'sync' && args.some((a) => a === '--hook' || a.startsWith('--hook='));
const { main } =
  args[0] === 'recall'
    ? await import('./recall.js')
    : hook
      ? await import('./sync-hook.js')
      : await import('./main.js');
main(args).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
