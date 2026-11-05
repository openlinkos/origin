import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { grokHome } from '@openlinkos/origin-adapters';
import type { AgentFacts } from '@openlinkos/origin-core';

/**
 * A session's directory as its agent recorded it, read only while reprojecting a session whose
 * `cwd` is gone. Grok's `git_root_dir` and ZCode's `directory`. Missing files and a bad schema
 * are no fact. Never creates a file.
 */
export function agentFacts(source: string, sessionId: string): AgentFacts | null {
  if (source === 'grok') return grokFacts(sessionId);
  if (source === 'zcode') return zcodeFacts(sessionId);
  return null;
}

function grokFacts(sessionId: string): AgentFacts | null {
  const sessions = path.join(grokHome(), 'sessions');
  let groups: string[];
  try {
    groups = fs.readdirSync(sessions);
  } catch {
    return null;
  }
  for (const group of groups) {
    const file = path.join(sessions, group, sessionId, 'summary.json');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as { git_root_dir?: unknown };
      if (typeof parsed.git_root_dir === 'string' && parsed.git_root_dir.length > 0) {
        return { gitRoot: parsed.git_root_dir };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** `ZCODE_HOME`, else `ORIGIN_ZCODE_HOME`, else `~/.zcode`. An empty variable is unset. */
function zcodeDir(): string {
  const env = process.env.ZCODE_HOME || process.env.ORIGIN_ZCODE_HOME;
  return env && env.length > 0 ? env : path.join(os.homedir(), '.zcode');
}

function zcodeFacts(sessionId: string): AgentFacts | null {
  const dbPath = path.join(zcodeDir(), 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId) as
      | { directory?: string | null }
      | undefined;
    if (typeof row?.directory === 'string' && row.directory.length > 0) {
      return { gitRoot: row.directory };
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
