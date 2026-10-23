import { OriginError } from '@openlinkos/origin-core';
import { createHubLink, type ToolName } from '@openlinkos/origin-mcp';
import type { HubConfig } from './config.js';

/** How long a CLI command on a relay waits for the hub's answer. */
const ANSWER_TIMEOUT_MS = 30_000;

/**
 * Call one of the hub's MCP tools for a CLI command on a relay, which has no memory of its own to
 * answer from (see docs/architecture.md#relays). The command acts as `user`, so what it writes on
 * the hub is recorded as `user@<device>`, as on any other device. Throws an OriginError with the
 * hub's message, or saying that the hub cannot be reached.
 */
export async function askHub(
  hub: HubConfig,
  name: ToolName,
  args: Record<string, unknown>,
  opts: { version?: string; fetch?: typeof fetch } = {},
): Promise<unknown> {
  const link = createHubLink({
    url: hub.url,
    token: hub.token,
    device: hub.device,
    agent: () => 'user',
    version: opts.version,
    fetch: opts.fetch,
  });
  try {
    const answer = await link.ask(name, args, ANSWER_TIMEOUT_MS);
    if (!answer.ok) {
      throw new OriginError(
        `This store is a relay: it keeps no memory of its own and asks its hub, but ${answer.reason}. Try again once the hub is reachable.`,
      );
    }
    if ('error' in answer) throw new OriginError(answer.error);
    return answer.value;
  } finally {
    await link.close();
  }
}
