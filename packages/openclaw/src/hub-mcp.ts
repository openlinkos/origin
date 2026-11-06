/**
 * Calling a tool of the hub's MCP server, `POST <hub>/mcp` (docs/architecture.md#http-interface):
 * one JSON-RPC `tools/call` per request, as the hub serves MCP statelessly, with JSON answers, so no
 * `initialize` comes first and no session is kept. The token goes only in the Authorization header,
 * and no message this returns holds it.
 */

import { asRecord } from './lines.js';

/** How long a tool call waits for the hub, at most. */
export const TOOL_TIMEOUT_MS = 15_000;
/** The MCP version the requests declare; the hub assumes 2025-03-26 without one, and takes both. */
export const PROTOCOL_VERSION = '2025-06-18';

export interface HubToolCall {
  /** The hub's base URL, without a trailing slash. */
  url: string;
  /** The hub token; null while there is none yet, as while the Gateway has not resolved it. */
  token: string | null;
  /** The agent behind the call, sent in X-Origin-Client: the hub records a brief as made for it. */
  client: string;
  /** The hub's name of the tool, such as `brief`. */
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** OpenClaw's signal, which cancels the call. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** The text the hub's tool answered, or why there is none, said in a line for the model. */
export type HubToolAnswer = { ok: true; texts: string[] } | { ok: false; error: string };

let nextId = 1;

/** Call a tool on the hub. Never throws. */
export async function callHubTool(call: HubToolCall): Promise<HubToolAnswer> {
  const { token } = call;
  if (!token) {
    return {
      ok: false,
      error:
        "Origin cannot be read yet: the Gateway has not resolved the hub token's SecretRef; the operator must fix it",
    };
  }
  const answer = await post(call, token);
  // The token never reaches a message: none is built from it, and this makes sure.
  return answer.ok ? answer : { ok: false, error: answer.error.split(token).join('…') };
}

async function post(call: HubToolCall, token: string): Promise<HubToolAnswer> {
  const timeoutMs = call.timeoutMs ?? TOOL_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  const id = nextId++;
  let res: Response;
  let body: string;
  try {
    res = await (call.fetchImpl ?? fetch)(`${call.url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'X-Origin-Client': call.client,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: call.name, arguments: call.args },
      }),
      signal,
    });
    body = await res.text();
  } catch (err) {
    if (timeout.aborted) {
      const within = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} s` : `${timeoutMs} ms`;
      return { ok: false, error: `Origin's hub did not answer within ${within}` };
    }
    if (call.signal?.aborted) return { ok: false, error: 'the call to Origin was cancelled' };
    return { ok: false, error: `Origin's hub at ${call.url} cannot be reached: ${cause(err)}` };
  }
  if (res.status === 401) {
    return {
      ok: false,
      error:
        "Origin's hub refused the plugin's token (401): the operator must give the plugin a valid token",
    };
  }
  const message = jsonRpcMessage(body, id);
  if (!res.ok) {
    const reason = errorText(message) ?? body.slice(0, 200).trim();
    if (res.status === 404) {
      return { ok: false, error: `Origin's hub has no MCP endpoint at ${call.url}/mcp (404)` };
    }
    return {
      ok: false,
      error: `Origin's hub answered ${res.status}${reason ? `: ${reason}` : ''}`,
    };
  }
  if (!message) {
    return { ok: false, error: "Origin's hub gave an answer that is not an MCP result" };
  }
  const refused = errorText(message);
  if (refused) return { ok: false, error: `Origin's hub refused the call: ${refused}` };
  const result = asRecord(message.result);
  if (!result || !Array.isArray(result.content)) {
    return { ok: false, error: "Origin's hub gave an answer that is not an MCP result" };
  }
  const texts = result.content
    .map((c) => asRecord(c))
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c?.text as string);
  if (result.isError === true) {
    return { ok: false, error: texts.join('\n').trim() || 'Origin could not answer' };
  }
  return { ok: true, texts };
}

/** The JSON-RPC message of the answer: the one with the request's id, or an error with none. */
function jsonRpcMessage(body: string, id: number): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const messages = (Array.isArray(parsed) ? parsed : [parsed]).map(asRecord);
  return messages.find((m) => m?.id === id) ?? messages.find((m) => m?.error !== undefined) ?? null;
}

/** What an answer says is wrong: a JSON-RPC error's message, or the hub's own `{ error }`. */
function errorText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const error = message.error;
  const text = typeof error === 'string' ? error : asRecord(error)?.message;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 300) : null;
}

function cause(err: unknown): string {
  const e = err as Error;
  const inner = e?.cause instanceof Error ? ` (${e.cause.message})` : '';
  return `${e?.message ?? String(err)}${inner}`;
}
