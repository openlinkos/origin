import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comparePath, type Database, openDatabase, syncSource } from '@openlinkos/origin-core';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAdapter } from '../../core/test/helpers.js';
import { briefIn, followHere } from '../src/local.js';

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(home: string): Database {
  fs.mkdirSync(home, { recursive: true });
  return openDatabase(path.join(home, 'origin.db'));
}

describe('project roots and the device they were learned on', () => {
  it("briefs a deleted work tree from this device's own roots", () => {
    const home = tempDir('origin-review2-brief-');
    const db = open(home);
    const gone = 'D:/work/feature-wt';
    try {
      db.prepare(
        `INSERT INTO project_root (device, path, project, root, signal, seen_at)
         VALUES ('', ?, 'demo-app', ?, 'git', 1)`,
      ).run(comparePath(gone), comparePath('D:/work/demo-app'));
      const text = briefIn(db, { cwd: gone }, 'grok@laptop', 'D:/work/demo-app').text;
      expect(text).toContain('project demo-app');
      expect(text).not.toContain('feature-wt');
    } finally {
      db.close();
    }
  });

  it('follows a session on the hub against the device that learned the root', async () => {
    const base = tempDir('origin-review2-follow-');
    const home = path.join(base, 'home');
    const logs = path.join(base, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, 's.jsonl'),
      `${JSON.stringify({
        id: 'e1',
        session: 'main-1',
        ts: 1_000,
        role: 'user',
        text: 'The main checkout',
        project: 'demo-app',
        cwd: 'D:/work/demo-app',
      })}\n`,
    );
    const db = open(home);
    try {
      await syncSource({ db, home }, fakeAdapter(logs));
      const gone = 'D:/work/feature-wt';
      db.prepare(
        `INSERT INTO project_root (device, path, project, root, signal, seen_at)
         VALUES ('laptop', ?, 'demo-app', ?, 'git', 1)`,
      ).run(comparePath(gone), comparePath('D:/work/demo-app'));
      const followed = followHere(db, { id: 'fake:main-1', cwd: gone }, null, 'laptop');
      expect(followed.follows).toBe('fake:main-1');
    } finally {
      db.close();
    }
  });
});
