import { DEVICE_CODE_GRANT, ORIGIN_CLIENT_ID, OriginError } from '@openlinkos/origin-core';

/**
 * `origin hub connect <url>` without `--token`: the device authorization grant (RFC 8628). The
 * device asks the hub for a code, prints where its owner approves it, in the hub's admin UI, and
 * polls until the owner has; it then gets its device token, under its store's name, without a
 * token being copied anywhere (see docs/architecture.md#using-a-hub-from-a-device).
 */
export interface DeviceFlowOptions {
  /** What the owner reads: where to approve, and the code. */
  log: (text: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function form(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  };
}

async function errorOf(res: Response): Promise<{ error?: string; error_description?: string }> {
  try {
    return (await res.json()) as { error?: string; error_description?: string };
  } catch {
    return {};
  }
}

/** Connect `device` to the hub at `hubUrl` by its owner's approval in the browser; its token. */
export async function connectByBrowser(
  hubUrl: string,
  device: string,
  o: DeviceFlowOptions,
): Promise<string> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? sleepFor;
  const now = o.now ?? Date.now;
  let res: Response;
  try {
    res = await doFetch(
      `${hubUrl}/oauth/device`,
      form({ client_id: ORIGIN_CLIENT_ID, device_name: device }),
    );
  } catch (err) {
    throw new OriginError(`Cannot reach the hub at ${hubUrl}: ${(err as Error).message}`);
  }
  if (res.status === 404) {
    throw new OriginError(
      `The hub at ${hubUrl} does not let devices connect by browser: its admin UI is off, on a listener of its own, or the hub runs an earlier version. Create a token for this device on the hub (origin token create ${device}) and connect with it: origin hub connect ${hubUrl} --token <token>`,
    );
  }
  if (!res.ok) {
    const e = await errorOf(res);
    throw new OriginError(
      `The hub at ${hubUrl} refused to connect ${device}: ${e.error_description ?? e.error ?? res.status}`,
    );
  }
  const d = (await res.json()) as DeviceAuthorization;
  const minutes = Math.max(1, Math.round(d.expires_in / 60));
  o.log(
    [
      `To connect ${device} to ${hubUrl}, open this link, sign in, and approve it:`,
      '',
      `    ${d.verification_uri_complete ?? d.verification_uri}`,
      '',
      `or open ${d.verification_uri} and enter the code ${d.user_code}. It expires in ${minutes} minutes.`,
      'Waiting for approval…',
    ].join('\n'),
  );
  const deadline = now() + d.expires_in * 1000;
  let interval = Math.max(1, d.interval ?? 5) * 1000;
  for (;;) {
    await sleep(interval);
    if (now() >= deadline) {
      throw new OriginError(
        'The code expired before it was approved; run origin hub connect again.',
      );
    }
    let poll: Response;
    try {
      poll = await doFetch(
        `${hubUrl}/oauth/token`,
        form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: d.device_code,
          client_id: ORIGIN_CLIENT_ID,
        }),
      );
    } catch {
      continue; // The hub may be restarting; ask again until the code expires.
    }
    if (poll.ok) {
      const t = (await poll.json()) as { access_token?: unknown };
      if (typeof t.access_token !== 'string') {
        throw new OriginError(`The hub at ${hubUrl} sent no token.`);
      }
      return t.access_token;
    }
    const e = await errorOf(poll);
    if (e.error === 'authorization_pending') continue;
    if (e.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (e.error === 'access_denied') {
      throw new OriginError(`Connecting ${device} was denied on the hub.`);
    }
    if (e.error === 'expired_token') {
      throw new OriginError(
        'The code expired before it was approved; run origin hub connect again.',
      );
    }
    throw new OriginError(
      `The hub at ${hubUrl} refused to connect ${device}: ${e.error_description ?? e.error ?? poll.status}`,
    );
  }
}
