import { OriginError } from '@openlinkos/origin-core';
import type { HubConfig } from './config.js';

/**
 * Check a hub connection before using it: the hub answers, accepts the token, and the token belongs
 * to this device. A hub token is bound to the device it is named after (see
 * docs/architecture.md#access), so a store whose name differs from the token's could not send or
 * receive anything; this fails early, with what to do about it. `renamable` says whether the store
 * may still take another name (it has not written entries or tombstones yet).
 */
export async function checkHub(
  hub: HubConfig,
  opts: { renamable: boolean; fetch?: typeof fetch },
): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${hub.url}/v1/device`, {
      headers: { Authorization: `Bearer ${hub.token}` },
    });
  } catch (err) {
    throw new OriginError(`Cannot reach the hub at ${hub.url}: ${(err as Error).message}`);
  }
  if (res.status === 401) throw new OriginError(`The hub at ${hub.url} rejected the token.`);
  if (!res.ok) throw new OriginError(`The hub at ${hub.url} answered ${res.status}.`);
  let device: unknown;
  try {
    device = ((await res.json()) as { device?: unknown }).device;
  } catch {
    device = undefined;
  }
  if (typeof device !== 'string') {
    throw new OriginError(`The hub at ${hub.url} did not say which device the token belongs to.`);
  }
  if (device === hub.device) return;
  const ownToken = `create a token for ${hub.device} on the hub (origin token create ${hub.device}) and connect with it`;
  throw new OriginError(
    opts.renamable
      ? `This token belongs to device "${device}", but this store is named "${hub.device}"; a hub token works only for the device it is named after. If this machine is ${device}, connect it under that name: origin hub connect ${hub.url} --token <token> --device ${device}. Otherwise, ${ownToken}.`
      : `This token belongs to device "${device}", but this store is named "${hub.device}" and keeps that name, because it has written entries or tombstones under it; a hub token works only for the device it is named after. To connect this store, ${ownToken}.`,
  );
}
