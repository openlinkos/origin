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
  /**
   * This plugin's config (`plugins.entries.<id>.config`), validated, SecretRefs resolved at the
   * Gateway's start; a reload registers the plugin before the Gateway resolves them.
   */
  pluginConfig?: unknown;
  logger?: PluginLogger;
  runtime?: {
    /** OpenClaw's version. */
    version?: string;
    state?: { resolveStateDir?: (env?: NodeJS.ProcessEnv) => string };
    /** `current()`: the Gateway's config as it runs now, SecretRefs resolved (its runtime snapshot). */
    config?: { current?: () => unknown };
    events?: {
      /**
       * Calls `listener`, synchronously, each time OpenClaw persists a message to a session's
       * transcript: `{ target: { agentId, sessionId, sessionKey }, sessionKey, agentId, sessionId,
       * message, messageId, messageSeq, runId }`, the message as persisted. Returns what removes it.
       */
      onSessionTranscriptUpdate?: (listener: (update: unknown) => void) => unknown;
    };
  };
  /** This instance of the plugin's lifecycle: `onDispose` runs when OpenClaw unloads or replaces it. */
  lifecycle?: { onDispose?: (dispose: () => void) => unknown };
  /** Resolves a user path, such as `~/…`, as OpenClaw resolves paths in its config. */
  resolvePath?: (input: string) => string;
  on: (hookName: string, handler: HookHandler, opts?: HookOptions) => void;
  /**
   * Registers an agent tool, or a factory OpenClaw calls with each run's tool context, which returns
   * the tool for that run or null to leave it out; a factory's tool is named in `opts.name`, as the
   * manifest's `contracts.tools` lists it. Written out from OpenClaw 2026.10.6's documentation of
   * plugin tools (plugins/building-plugins, plugins/tool-plugins). This plugin registers versioned
   * factories (ToolFactoryV2) only.
   */
  registerTool?: (tool: AgentTool | ToolFactory | ToolFactoryV2, opts?: ToolOptions) => void;
}

/** Options of `api.registerTool`. */
export interface ToolOptions {
  name?: string;
  /** A tool the operator must allow (`tools.allow`) before a model sees it. */
  optional?: boolean;
}

/**
 * A tool's factory: called with the run's tool context, read as `unknown` and checked field by
 * field, since a host may leave any field out (it holds `agentId`, `sessionKey`, `sessionId`, and
 * `messageChannel`, among others, when the run has them).
 */
export type ToolFactory = (ctx: unknown) => AgentTool | null;

/**
 * A versioned factory, `OpenClawPluginToolFactory<2>`: OpenClaw calls `create` with a version 2
 * tool context (ToolContextV2), read as `unknown` and checked field by field.
 */
export interface ToolFactoryV2 {
  contextVersion: 2;
  create: (context: unknown) => AgentTool | null;
}

/**
 * The part of `OpenClawPluginToolContext<2>` the read tools use, besides the run's `agentId`,
 * `sessionKey`, and `messageChannel`: `assertInvocationCurrent`, which the version requires, and,
 * for an admitted session turn whose audience the host can prove, `memoryAudience` with
 * `assertMemoryAudienceCurrent`. Each guard throws once its authority has ended; a tool that holds
 * them across awaited work calls both immediately before it releases data or has an effect.
 */
export interface ToolContextV2 {
  assertInvocationCurrent: () => void;
  memoryAudience?: MemoryAudience;
  assertMemoryAudienceCurrent?: () => void;
}

/**
 * Whose memory a turn may use, as the host resolved it: the owner's own (`owner-private`), or a
 * conversation's, such as one with other people (`conversation`).
 */
export type MemoryAudience =
  | { kind: 'owner-private'; agentId: string }
  | { kind: 'conversation'; agentId: string; sessionKey: string; sessionId: string };

/**
 * An agent tool, as OpenClaw's agent loop runs it: `parameters` is a JSON Schema, and `execute`
 * takes the call's id first. A tool that fails throws: the model gets the error's message as the
 * call's result, marked as an error.
 */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult>;
}

/** What a tool returns: the text the model reads, and `details`, which OpenClaw keeps and grades. */
export interface AgentToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

/** The default export OpenClaw's loader reads. */
export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi) => void;
}
