// Test support: a child process that keeps writing to a database in transactions that must stay consistent
// (every transaction adds one row to `a` and one to `b`, so their counts are equal in any consistent state).
// usage: node --import ./ts-loader.mjs snapshot-child.mjs <path> <count>   (prints "ready" after the first commit)
import process from 'node:process';
import { openDb } from './db.ts';

const [path, count] = process.argv.slice(2);
const db = openDb({ path, busyTimeoutMs: 60_000 });
for (let i = 0; i < Number(count); i++) {
  db.begin();
  db.run('INSERT INTO a (v) VALUES (?)', i);
  db.run('INSERT INTO b (v) VALUES (?)', i);
  db.commit();
  if (i === 0) process.stdout.write('ready\n');
}
db.close();
