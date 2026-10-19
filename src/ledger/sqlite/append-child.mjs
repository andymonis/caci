// Test support (not published): appends N entries one batch at a time to the ledger in the file, as a second process.
import process from 'node:process';
import { createSqliteLedgerStore } from './sqlite-store.ts';

const [path, name, count] = process.argv.slice(2);
const store = createSqliteLedgerStore({ path, busyTimeoutMs: 20000 });
for (let i = 0; i < Number(count); i++) {
  const r = await store.append([{ id: `l${name}${String(i).padStart(15, '0')}`, at: 10_000 + i, scope: { kind: 'personal', userId: 'u0000000000000001' }, actor: 'u9', action: 'added', kind: 'item', subject: `s-${name}-${i}`, proposalId: 'p' }]);
  if (!r.ok) {
    process.stderr.write(`${JSON.stringify(r.error)}\n`);
    process.exit(1);
  }
}
store.close();
