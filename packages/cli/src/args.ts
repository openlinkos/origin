import { parseArgs } from 'node:util';
import { DIGEST_LIMIT_MAX, digestDay, UPLOAD_CONCURRENCY } from '@openlinkos/origin-core';
import { BUCKET_OPTIONS } from './hub/bucket.js';
import { UI_PORT } from './ui.js';

/**
 * The arguments of every command that opens the store, checked before it is opened: opening a store
 * upgrades an older one, which must never be a side effect of asking for help or of a typo. Each
 * command parses its arguments with the same options, from this table.
 */

type Option = { type: 'string' | 'boolean'; default?: string | boolean };

export interface ArgSpec {
  options: Readonly<Record<string, Option>>;
  /** The fewest and the most positional arguments; none when absent. */
  positionals?: readonly [number, number];
  /** Options that must be given, not blank, each with what to say when it is not. */
  required?: Readonly<Record<string, string>>;
  /** What is wrong with the values given, or null: a check that needs no store. */
  check?: (values: Readonly<Record<string, unknown>>) => string | null;
  usage: string;
}

/** `--day` and `--limit` of `origin digest`, as the digest reads them. */
function digestValues(values: Readonly<Record<string, unknown>>): string | null {
  if (typeof values.day === 'string') {
    try {
      digestDay(values.day);
    } catch (err) {
      return (err as Error).message;
    }
  }
  const limit = values.limit;
  if (
    typeof limit === 'string' &&
    !(/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= DIGEST_LIMIT_MAX)
  ) {
    return `--limit must be a whole number from 1 to ${DIGEST_LIMIT_MAX}.`;
  }
  return null;
}

/** A command made of subcommands, such as `origin token create <name>`. */
export interface SubcommandSpec {
  sub: Readonly<Record<string, ArgSpec>>;
  usage: string;
}

const MANY = Number.POSITIVE_INFINITY;
const SYNC = {
  options: {
    source: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
  },
  usage: 'Usage: origin sync [--source <id>] [--verbose] [--local]',
} as const;

export const ARGS = {
  sync: SYNC,
  push: { ...SYNC, usage: 'Usage: origin push [--source <id>] [--verbose] [--local]' },
  status: { options: {}, usage: 'Usage: origin status' },
  timeline: {
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      source: { type: 'string' },
      project: { type: 'string' },
      session: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean', default: false },
      children: { type: 'boolean', default: false },
    },
    usage:
      'Usage: origin timeline [--since 7d] [--until <t>] [--source <id>] [--project <name>] [--limit 50] [--children] | --session <id> [--all]',
  },
  digest: {
    options: {
      day: { type: 'string' },
      project: { type: 'string' },
      source: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    check: digestValues,
    usage:
      'Usage: origin digest [--day YYYY-MM-DD] [--project <name>] [--source <id>] [--limit 50] [--json]',
  },
  search: {
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      source: { type: 'string' },
      project: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean', default: false },
      recent: { type: 'boolean', default: false },
    },
    positionals: [1, MANY],
    usage:
      'Usage: origin search <query> [--since <t>] [--source <id>] [--project <name>] [--all] [--recent] [--limit 20]',
  },
  show: {
    options: { source: { type: 'string' } },
    positionals: [1, 1],
    usage: 'Usage: origin show <id> [--source <id>]',
  },
  entries: {
    options: {
      kind: { type: 'string' },
      project: { type: 'string' },
      history: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
    usage: 'Usage: origin entries [--kind <kind>] [--project <name>] [--history] [--limit 50]',
  },
  recalls: {
    options: {
      since: { type: 'string' },
      agent: { type: 'string' },
      session: { type: 'string' },
      all: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
    usage:
      'Usage: origin recalls [--since <t>] [--agent <id>] [--session <id>] [--all] [--limit 50]',
  },
  correct: {
    options: { kind: { type: 'string' }, confidence: { type: 'string' } },
    positionals: [2, MANY],
    usage: 'Usage: origin correct <entry-id> <text> [--kind <kind>] [--confidence <0-1>]',
  },
  forget: {
    options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false } },
    positionals: [1, 1],
    required: { reason: 'A reason is required: it is kept with the record.' },
    usage: 'Usage: origin forget <id> --reason <text> [--yes]',
  },
  forgotten: {
    options: { limit: { type: 'string' } },
    usage: 'Usage: origin forgotten [--limit 50]',
  },
  restore: {
    options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false } },
    positionals: [1, 1],
    required: { reason: 'A reason is required: it is kept with the record.' },
    usage: 'Usage: origin restore <tombstone-id> --reason <text> [--yes]',
  },
  proposals: {
    options: {
      project: { type: 'string' },
      status: { type: 'string', default: 'pending' },
      limit: { type: 'string' },
    },
    usage:
      'Usage: origin proposals [--project <name>] [--status pending|accepted|rejected|all] [--limit 50]',
  },
  accept: {
    options: { yes: { type: 'boolean', default: false } },
    positionals: [1, 1],
    usage: 'Usage: origin accept <proposal-id> [--yes]',
  },
  reject: {
    options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false } },
    positionals: [1, 1],
    required: { reason: 'A reason is required: it is kept with the record.' },
    usage: 'Usage: origin reject <proposal-id> --reason <text> [--yes]',
  },
  distill: {
    options: {
      project: { type: 'string' },
      thread: { type: 'string' },
      day: { type: 'string' },
      since: { type: 'string' },
      agent: { type: 'string', default: 'claude-code' },
      max: { type: 'string' },
      'max-turns': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    usage:
      'Usage: origin distill [--project <name> | --thread <thr_…>] [--day <YYYY-MM-DD> | --since <t>] [--max 10] [--dry-run]',
  },
  projects: { options: {}, usage: 'Usage: origin projects' },
  sessions: {
    sub: {
      reproject: {
        options: { 'dry-run': { type: 'boolean', default: false } },
        usage: 'Usage: origin sessions reproject [--dry-run]',
      },
      parents: {
        options: {
          'dry-run': { type: 'boolean', default: false },
          'zcode-db': { type: 'string' },
          'grok-home': { type: 'string' },
        },
        usage: 'Usage: origin sessions parents [--dry-run] [--zcode-db <file>] [--grok-home <dir>]',
      },
      repair: {
        options: { 'dry-run': { type: 'boolean', default: false } },
        usage: 'Usage: origin sessions repair [--dry-run]',
      },
    },
    usage:
      'Usage: origin sessions reproject [--dry-run] | parents [--dry-run] [--zcode-db <file>] [--grok-home <dir>] | repair [--dry-run]',
  },
  backup: { options: {}, positionals: [1, 1], usage: 'Usage: origin backup <dir>' },
  mcp: { options: {}, usage: 'Usage: origin mcp' },
  ui: {
    options: {
      port: { type: 'string', default: String(UI_PORT) },
      'no-open': { type: 'boolean', default: false },
    },
    usage: `Usage: origin ui [--port ${UI_PORT}] [--no-open]`,
  },
  serve: {
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '7077' },
      admin: { type: 'boolean' },
      'admin-listen': { type: 'string' },
      'public-url': { type: 'string' },
      ...BUCKET_OPTIONS,
    },
    usage:
      'Usage: origin serve [--host 127.0.0.1] [--port 7077] [--admin | --admin-listen <host:port>] [--public-url <url>] [--raw-s3-endpoint <url> --raw-s3-bucket <name> [--raw-s3-prefix <p>]]',
  },
  token: {
    sub: {
      create: {
        options: {
          agent: { type: 'boolean', default: false },
          readonly: { type: 'boolean', default: false },
        },
        positionals: [1, 1],
        usage: 'Usage: origin token create <name> [--agent [--readonly]]',
      },
      list: { options: {}, usage: 'Usage: origin token list' },
      revoke: { options: {}, positionals: [1, 1], usage: 'Usage: origin token revoke <name>' },
    },
    usage: 'Usage: origin token create <name> [--agent [--readonly]] | list | revoke <name>',
  },
  admin: {
    sub: {
      password: {
        options: { generate: { type: 'boolean', default: false } },
        usage: 'Usage: origin admin password [--generate]',
      },
      sessions: {
        options: { 'revoke-all': { type: 'boolean', default: false } },
        usage: 'Usage: origin admin sessions [--revoke-all]',
      },
      audit: {
        options: { limit: { type: 'string' } },
        usage: 'Usage: origin admin audit [--limit 50]',
      },
      username: {
        options: {},
        positionals: [0, 1],
        usage: 'Usage: origin admin username [<name>]',
      },
    },
    usage:
      'Usage: origin admin password [--generate] | username [<name>] | sessions [--revoke-all] | audit [--limit 50]',
  },
  hub: {
    sub: {
      connect: {
        options: {
          token: { type: 'string' },
          device: { type: 'string' },
          relay: { type: 'boolean', default: false },
        },
        positionals: [1, 1],
        usage: 'Usage: origin hub connect <url> [--token <token>] [--device <name>] [--relay]',
      },
      status: { options: {}, usage: 'Usage: origin hub status' },
      disconnect: { options: {}, usage: 'Usage: origin hub disconnect' },
    },
    usage:
      'Usage: origin hub connect <url> [--token <token>] [--device <name>] [--relay] | status | disconnect',
  },
  raw: {
    sub: {
      upload: {
        options: {
          remove: { type: 'boolean', default: false },
          concurrency: { type: 'string', default: String(UPLOAD_CONCURRENCY) },
          ...BUCKET_OPTIONS,
        },
        usage:
          'Usage: origin raw upload [--remove] [--concurrency 8] [--raw-s3-endpoint <url> --raw-s3-bucket <name> …]',
      },
    },
    usage:
      'Usage: origin raw upload [--remove] [--concurrency 8] [--raw-s3-endpoint <url> --raw-s3-bucket <name> …]',
  },
} as const satisfies Record<string, ArgSpec | SubcommandSpec>;

export type StoreCommand = keyof typeof ARGS;

/** Whether `command` is one of the commands that open the store. */
export function isStoreCommand(command: string): command is StoreCommand {
  return Object.hasOwn(ARGS, command);
}

/** What the arguments of a command ask for: to run it, its usage, or a usage error. */
export type ArgCheck = { kind: 'run' } | { kind: 'help' } | { kind: 'error'; message: string };

const isHelp = (a: string) => a === '--help' || a === '-h';

/**
 * Check a command's arguments without running it, as it will parse them: `--help` or `-h`
 * anywhere (before `--`) asks for its usage, as does `help` in place of a subcommand.
 */
export function checkArgs(command: StoreCommand, args: readonly string[]): ArgCheck {
  const end = args.indexOf('--');
  if ((end < 0 ? args : args.slice(0, end)).some(isHelp)) return { kind: 'help' };
  const spec: ArgSpec | SubcommandSpec = ARGS[command];
  if ('sub' in spec) {
    const [name, ...rest] = args;
    if (name === 'help') return { kind: 'help' };
    const sub = name !== undefined && Object.hasOwn(spec.sub, name) ? spec.sub[name] : undefined;
    if (!sub) {
      const what = name === undefined ? `Missing a subcommand` : `Unknown subcommand "${name}"`;
      return { kind: 'error', message: `origin ${command}: ${what}.\n${spec.usage}` };
    }
    return checkSpec(`${command} ${name}`, sub, rest);
  }
  return checkSpec(command, spec, args);
}

function checkSpec(label: string, spec: ArgSpec, args: readonly string[]): ArgCheck {
  const fail = (what: string): ArgCheck => ({
    kind: 'error',
    message: `origin ${label}: ${what}\n${spec.usage}`,
  });
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: spec.options,
      allowPositionals: spec.positionals !== undefined,
      strict: true,
    });
  } catch (err) {
    return fail((err as Error).message);
  }
  const [min, max] = spec.positionals ?? [0, 0];
  const given = parsed.positionals.filter((p) => p.trim().length > 0).length;
  if (given < min) return fail(min === 1 ? 'An argument is missing.' : 'Arguments are missing.');
  if (parsed.positionals.length > max) return fail('Too many arguments.');
  for (const [name, message] of Object.entries(spec.required ?? {})) {
    const v = parsed.values[name];
    if (typeof v !== 'string' || v.trim().length === 0) return fail(message);
  }
  const problem = spec.check?.(parsed.values);
  if (problem) return fail(problem);
  return { kind: 'run' };
}
