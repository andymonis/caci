// Test support (not published): opens the usage store, begins a write transaction and inserts a big batch inside it by hand,
// prints "ready", then waits to be killed with SIGKILL before it can commit.
import process from 'node:process';
import { setInterval } from 'node:timers';
import { openDb } from '../../sqlite/db.ts';
import { createSqliteUsageStore } from './sqlite-store.ts';

const path = process.argv[2];
createSqliteUsageStore({ path }).close();
const db = openDb({ path });
db.begin();
for (let i = 0; i < 2000; i++) {
  db.run("INSERT INTO usage (at, user_id, capability, scope_kind, scope_id, model, attempt, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, result, latency_ms) VALUES (?, 'u0000000000000001', 'status', 'personal', '', 'killed', 1, 1, 1, 0, 0, 'ok', 1)", 5000 + i);
}
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
