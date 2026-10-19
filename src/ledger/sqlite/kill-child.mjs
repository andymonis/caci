// Test support (not published): opens the ledger store, begins a write transaction and appends a big batch inside it by hand,
// prints "ready", then waits to be killed with SIGKILL before it can commit.
import process from 'node:process';
import { setInterval } from 'node:timers';
import { openDb } from '../../sqlite/db.ts';
import { createSqliteLedgerStore } from './sqlite-store.ts';

const path = process.argv[2];
createSqliteLedgerStore({ path }).close();
const db = openDb({ path });
db.begin();
for (let i = 0; i < 2000; i++) {
  db.run(
    "INSERT INTO ledger (id, at, scope_kind, scope_id, actor, action, kind, subject, proposal_id) VALUES (?, ?, 'personal', 'u0000000000000001', 'u9', 'added', 'item', '\"s\"', 'p')",
    `lkill${String(i).padStart(11, '0')}`,
    5000 + i,
  );
}
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
