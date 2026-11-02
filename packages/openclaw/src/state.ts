import fs from 'node:fs';
import path from 'node:path';
import { agentDir, sessionFileBase } from './files.js';
import type { Log } from './log.js';

/**
 * What the plugin has handed over of each session: the ids of the lines it delivered, spooled, or
 * left out on purpose, and whether it sent the session's title. `agent_end` gives a session's whole
 * history every turn, so this is how a turn sends only what is new; it is kept on disk, one file per
 * session, so that a restart does not send a session's history again. Losing it costs nothing but
 * duplicates, which Origin ignores.
 */
export interface SessionRecord {
  ids: Set<string>;
  titled: boolean;
}

const TITLED = '#titled';
/** Sessions kept in memory; others are read again from disk when they come back. */
const CACHED_SESSIONS = 500;

export class SessionStore {
  private readonly cache = new Map<string, SessionRecord>();

  constructor(
    private readonly dir: string,
    private readonly log: Log,
  ) {}

  private file(agentId: string, sessionKey: string): string {
    return path.join(this.dir, 'sent', agentDir(agentId), `${sessionFileBase(sessionKey)}.ids`);
  }

  /** The session's record, read from disk the first time it is needed. */
  get(agentId: string, sessionKey: string): SessionRecord {
    const hit = this.cache.get(sessionKey);
    if (hit) {
      // Most recently used last, so that the oldest is evicted first.
      this.cache.delete(sessionKey);
      this.cache.set(sessionKey, hit);
      return hit;
    }
    const record: SessionRecord = { ids: new Set(), titled: false };
    let text = '';
    try {
      text = fs.readFileSync(this.file(agentId, sessionKey), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`could not read what was sent of ${sessionKey}: ${(err as Error).message}`);
      }
    }
    for (const line of text.split('\n')) {
      if (line === TITLED) record.titled = true;
      else if (line.length > 0) record.ids.add(line);
    }
    this.cache.set(sessionKey, record);
    while (this.cache.size > CACHED_SESSIONS) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return record;
  }

  /** Record on disk that `ids` were handed over (and the title, if `titled`). */
  persist(agentId: string, sessionKey: string, ids: readonly string[], titled: boolean): void {
    if (ids.length === 0 && !titled) return;
    const lines = titled ? [...ids, TITLED] : [...ids];
    const file = this.file(agentId, sessionKey);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${lines.join('\n')}\n`);
    } catch (err) {
      this.log.warn(`could not record what was sent of ${sessionKey}: ${(err as Error).message}`);
    }
  }

  /** Drop a session from memory, as when it ends; its file stays. */
  forget(sessionKey: string): void {
    this.cache.delete(sessionKey);
  }
}
