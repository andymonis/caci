// Test support (not published): opens the resolution store, begins a write transaction and inserts a big batch inside it by hand,
// prints "ready", then waits to be killed with SIGKILL before it can commit.
import process from 'node:process';
import { setInterval } from 'node:timers';
import { openDb } from '../../sqlite/db.ts';
import { createSqliteResolutionStore } from './sqlite-store.ts';

const path = process.argv[2];
createSqliteResolutionStore({ path }).close();
const db = openDb({ path });
db.begin();
for (let i = 0; i < 1500; i++) {
  db.run("INSERT INTO fact_resolutions (user_id, scope_kind, scope_id, fact_id, verb, at) VALUES ('u0000000000000002', 'personal', '', ?, 'clear', 1)", `killed-${i}`);
}
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
