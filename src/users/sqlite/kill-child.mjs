// Test support: a child process that writes users inside an open transaction and is then killed. Not part of the package.
// usage: node --import ../../sqlite/ts-loader.mjs kill-child.mjs <path> <mode: hang|finish|race> [prefix]
import process from 'node:process';
import { createSqliteUserStore } from './index.ts';

const [path, mode, prefix = 'p'] = process.argv.slice(2);
const store = createSqliteUserStore({ path, busyTimeoutMs: 60_000 });
const rec = (id, username) => ({ id, username, displayName: username, role: 'user', passwordHash: 'scrypt$16$1$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', createdAt: 1 });

if (mode === 'race') {
  // each racer tries 25 distinct names and the shared name "dup"
  const results = [await store.create(rec(`u${prefix}dup0000000000000`.slice(0, 17), 'dup'))];
  for (let i = 0; i < 25; i++) results.push(await store.create(rec(`u${prefix}${String(i).padStart(15, '0')}`.slice(0, 17), `${prefix}-user-${i}`)));
  process.stdout.write(JSON.stringify(results.map((r) => r.ok)) + '\n');
  store.close();
} else {
  await store.create(rec('ucommitted0000000', 'committed'));
  // Take the write lock and write, but never commit: reach into the database the way the store does.
  const { openDb } = await import('../../sqlite/db.ts');
  const db = openDb({ path });
  db.begin();
  for (let i = 0; i < 500; i++) db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, 'x', 'user', 'h', 1, 1)", `upartial${String(i).padStart(8, '0')}`, `partial-${i}`);
  process.stdout.write('ready\n');
  if (mode === 'hang') await new Promise(() => {});
  db.commit();
  db.close();
  store.close();
}
