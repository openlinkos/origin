/**
 * The part of OpenClaw's plugin API this plugin uses, written out from the types of its plugin SDK
 * (`openclaw/plugin-sdk/plugin-entry`, checked against OpenClaw 2026.10.6, the same in 2026.10.9),
 * so that the package depends on nothing: OpenClaw's loader takes any default export that has a
 * `register(api)` function. Hook payloads are read as `unknown` and checked field by field, since a
 * host may leave any field out.
 */

/** `api.logger`: every method may be missing on an older or a test host. */
export interface PluginLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Options of `api.on`. */
export interface HookOptions {
  priority?: number;
  timeoutMs?: number;
}

/** A hook handler: `(event, ctx)`, sync or async. Return values of observing hooks are ignored. */
export type HookHandler = (event: unknown, ctx: unknown) => unknown;

/** The `api` handed to `register`. */
export interface PluginApi {
  /** The plugin's id, the key of its entry under `plugins.entries` in the Gateway's config. */
  id?: string;
  /** `full` at Gateway startup; other modes (discovery, CLI metadata, setup) expect no hooks. */
  registrationMode?: string;
  /** The Gateway's whole config, as loaded. */
  config?: unknown;
  /** This plugin's config (`plugins.entries.<id>.config`), validated, SecretRefs resolved. */
  pluginConfig?: unknown;
  logger?: PluginLogger;
  runtime?: {
    /** OpenClaw's version. */
    version?: string;
    state?: { resolveStateDir?: (env?: NodeJS.ProcessEnv) => string };
  };
  /** Resolves a user path, such as `~/…`, as OpenClaw resolves paths in its config. */
  resolvePath?: (input: string) => string;
  on: (hookName: string, handler: HookHandler, opts?: HookOptions) => void;
}

/** The default export OpenClaw's loader reads. */
export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi) => void;
}
