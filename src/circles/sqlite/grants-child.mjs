// Test support: a child process that keeps replacing one grant. Not part of the package.
// usage: node --import ../../sqlite/ts-loader.mjs grants-child.mjs <path> <circle> <owner> <grantee> <rounds>
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSqliteCircleStore } from './index.ts';

const [path, circle, owner, grantee, rounds] = process.argv.slice(2);
const store = createSqliteCircleStore({ path, busyTimeoutMs: 60_000 });
process.stdout.write('started\n');
const outcomes = [];
for (let i = 0; i < Number(rounds); i++) {
  if (i % 40 === 0) await sleep(5); // let the other process in
  const r = await store.setGrant(circle, owner, grantee, [`round-${i}`], i, { maxCategoriesPerGrant: 200 });
  outcomes.push(r.ok ? 'ok' : r.error.code);
}
process.stdout.write(JSON.stringify(outcomes) + '\n');
store.close();
