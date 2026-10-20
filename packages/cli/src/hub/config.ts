import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NAME_RE, OriginError } from '@openlinkos/origin-core';

/** How this device reaches its hub. */
export interface HubConfig {
  /** Base URL of the hub, without a trailing slash. */
  url: string;
  token: string;
  /** This device's name on the hub. */
  device: string;
}

export function hubConfigPath(home: string): string {
  return path.join(home, 'hub.json');
}

/** The hub connection; `ORIGIN_HUB_URL`, `ORIGIN_HUB_TOKEN`, and `ORIGIN_DEVICE` override `<home>/hub.json`. */
export function readHubConfig(home: string): HubConfig | null {
  let saved: Partial<HubConfig> = {};
  try {
    saved = JSON.parse(fs.readFileSync(hubConfigPath(home), 'utf8')) as Partial<HubConfig>;
  } catch {
    // not connected
  }
  const url = process.env.ORIGIN_HUB_URL || saved.url;
  const token = process.env.ORIGIN_HUB_TOKEN || saved.token;
  if (!url || !token) return null;
  return {
    url: normalizeHubUrl(url),
    token,
    device: checkDeviceName(process.env.ORIGIN_DEVICE || saved.device || defaultDeviceName()),
  };
}

/** Save the connection with owner-only permissions: the file holds a token. */
export function writeHubConfig(home: string, config: HubConfig): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(hubConfigPath(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function removeHubConfig(home: string): boolean {
  try {
    fs.rmSync(hubConfigPath(home));
    return true;
  } catch {
    return false;
  }
}

/** The host name, lowercased and reduced to the characters a device name allows. */
export function defaultDeviceName(): string {
  const name = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  return name || 'device';
}

export function checkDeviceName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new OriginError(
      `Invalid device name "${name}": use lowercase letters, digits, ".", "_" and "-".`,
    );
  }
  return name;
}

export function normalizeHubUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginError(`Invalid hub URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginError(`The hub URL must start with http:// or https://: ${input}`);
  }
  return url.toString().replace(/\/+$/, '');
}
