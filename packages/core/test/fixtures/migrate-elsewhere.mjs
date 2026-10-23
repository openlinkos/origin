// Another process opening the same store: it takes the write lock, says so, and after a while
// either finishes migration 2 of migrations.test.ts as Origin would (its change and its version, in
// one transaction) or dies before committing.
import { DatabaseSync } from 'node:sqlite';

const [file, mode, holdMs] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('BEGIN IMMEDIATE');
db.exec('CREATE TABLE migrated_by (who TEXT NOT NULL)');
db.exec("INSERT INTO migrated_by VALUES ('other process')");
process.send('locked');
setTimeout(() => {
  if (mode === 'crash') process.exit(3);
  db.exec('PRAGMA user_version = 2');
  db.exec('COMMIT');
  db.close();
  process.exit(0);
}, Number(holdMs));
