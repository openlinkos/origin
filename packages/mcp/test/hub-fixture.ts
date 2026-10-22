import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type Database, initStoreName, openDatabase, syncSource } from '@openlinkos/origin-core';
import { fakeAdapter, line } from '../../core/test/helpers.js';
import { handleMcpHttp } from '../src/index.js';

export const TOKEN = 'ogn_test-token';

export interface TestHub {
  url: string;
  db: Database;
  home: string;
  /** Milliseconds the hub waits before handling each /mcp request (a slow hub). */
  delayMs: number;
  stop(): Promise<void>;
}

/**
 * A minimal hub for tests: one store with a synced fake session, and an HTTP server that checks
 * the bearer token and hands POST /mcp to handleMcpHttp, as the CLI's hub does.
 */
export async function startTestHub(): Promise<TestHub> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hub-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-src-'));
  const db = openDatabase(path.join(home, 'origin.db'));
  initStoreName(db, 'hub');
  fs.writeFileSync(
    path.join(src, 's1.jsonl'),
    line('e1', 's1', 1000, 'user', 'Keep the hub behind TLS and give every device its own token.') +
      line('e2', 's1', 2000, 'assistant', 'Done: one token per device, revocable.'),
  );
  await syncSource({ db, home }, fakeAdapter(src));

  const hub = { delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    if (hub.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, hub.delayMs));
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res
        .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'invalid token' }));
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    // As the CLI's hub does: `<agent>@<device>` for a device's agent, else `<agent>@<token>`.
    const client = req.headers['x-origin-client'];
    const device = req.headers['x-origin-device'];
    await handleMcpHttp(req, res, body, {
      db,
      home,
      author: `${typeof client === 'string' ? client : 'mcp'}@${typeof device === 'string' ? device : 'test'}`,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    home,
    get delayMs() {
      return hub.delayMs;
    },
    set delayMs(ms: number) {
      hub.delayMs = ms;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
    },
  };
}

export type ToolCallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary tool JSON
export function parse(r: unknown): { isError: boolean; text: string; json: any } {
  const result = r as ToolCallResult;
  const text = result.content[0]?.text ?? '';
  const isError = result.isError === true;
  return { isError, text, json: isError ? null : JSON.parse(text) };
}
