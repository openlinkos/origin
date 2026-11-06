import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Database, openDatabase } from '@openlinkos/origin-core';
import { createOriginServer, WRITE_TOOLS } from '@openlinkos/origin-mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The plugin for OpenClaw depends on no workspace package, so it copies the schemas of the MCP
// tools it forwards to the hub; this keeps the copy the same as what Origin's MCP server publishes.
import { ORIGIN_TOOLS } from '../../openclaw/src/tools.js';

interface Schema {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}

let home: string;
let db: Database;
let published: Map<string, Schema>;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-openclaw-tools-'));
  db = openDatabase(path.join(home, 'origin.db'));
  const server = createOriginServer({ db, home, device: 'test', syncIntervalMs: 0 });
  const client = new Client({ name: 'schema-check', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.mcp.connect(serverSide)]);
  const { tools } = await client.listTools();
  published = new Map(tools.map((t) => [t.name, t.inputSchema as Schema]));
  await client.close();
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A property as the plugin should declare it: as published, less the bound zod adds to integers. */
function expected(property: Record<string, unknown>): Record<string, unknown> {
  const { maximum, ...rest } = property;
  return maximum === Number.MAX_SAFE_INTEGER ? rest : property;
}

describe("the OpenClaw plugin's read tools", () => {
  it('forward read tools of the MCP server, under origin_ names', () => {
    expect(ORIGIN_TOOLS.map((t) => [t.name, t.mcp])).toEqual([
      ['origin_brief', 'brief'],
      ['origin_search', 'search'],
      ['origin_get', 'get'],
      ['origin_timeline', 'timeline'],
      ['origin_digest', 'digest'],
    ]);
    for (const t of ORIGIN_TOOLS) {
      expect(published.has(t.mcp), t.mcp).toBe(true);
      expect(WRITE_TOOLS).not.toContain(t.mcp);
    }
  });

  it.each(ORIGIN_TOOLS.map((t) => [t.name, t] as const))(
    '%s takes the parameters of its MCP tool, with the same schemas',
    (_name, tool) => {
      const mcp = published.get(tool.mcp) as Schema;
      const properties = { ...mcp.properties };
      if (tool.mcp === 'brief') {
        // No working directory: the plugin briefs on the agent's project, which it describes.
        delete properties.cwd;
        expect(Object.keys(tool.parameters.properties)).toEqual(Object.keys(properties));
        expect(tool.parameters.properties.about).toEqual(expected(properties.about ?? {}));
        expect(tool.parameters.properties.project).toEqual({
          type: 'string',
          description: expect.stringContaining('default'),
        });
      } else {
        expect(Object.keys(tool.parameters.properties)).toEqual(Object.keys(properties));
        for (const [key, property] of Object.entries(properties)) {
          expect(tool.parameters.properties[key], `${tool.name}.${key}`).toEqual(
            expected(property),
          );
        }
      }
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.required ?? []).toEqual(mcp.required ?? []);
    },
  );
});
