import fs from 'node:fs';
import path from 'node:path';
import { OriginError } from '@openlinkos/origin-core';

/** How this device reaches its hub. */
export interface HubConfig {
  /** Base URL of the hub, without a trailing slash. */
  url: string;
  token: string;
  /** This device's name on the hub: the name of its store (see docs/architecture.md#storage). */
  device: string;
}

/** What `<home>/hub.json` holds. The device name is the store's, so it is not saved here. */
export type SavedHub = Omit<HubConfig, 'device'>;

export function hubConfigPath(home: string): string {
  return path.join(home, 'hub.json');
}

/** The hub connection; `ORIGIN_HUB_URL` and `ORIGIN_HUB_TOKEN` override `<home>/hub.json`. */
export function readHubConfig(home: string): SavedHub | null {
  let saved: Partial<SavedHub> = {};
  try {
    saved = JSON.parse(fs.readFileSync(hubConfigPath(home), 'utf8')) as Partial<SavedHub>;
  } catch {
    // not connected
  }
  const url = process.env.ORIGIN_HUB_URL || saved.url;
  const token = process.env.ORIGIN_HUB_TOKEN || saved.token;
  if (!url || !token) return null;
  return { url: normalizeHubUrl(url), token };
}

/** Save the connection with owner-only permissions: the file holds a token. */
export function writeHubConfig(home: string, config: SavedHub): void {
  fs.mkdirSync(home, { recursive: true });
  const saved: SavedHub = { url: config.url, token: config.token };
  fs.writeFileSync(hubConfigPath(home), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
}

export function removeHubConfig(home: string): boolean {
  try {
    fs.rmSync(hubConfigPath(home));
    return true;
  } catch {
    return false;
  }
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
