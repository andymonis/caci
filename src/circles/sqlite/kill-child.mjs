// Test support: a child process that works on circles. Not part of the package.
// usage: node --import ../../sqlite/ts-loader.mjs kill-child.mjs <path> <mode: hang|finish|accept|create> [prefix]
import process from 'node:process';
import { createSqliteCircleStore } from './index.ts';

const [path, mode, prefix = 'p'] = process.argv.slice(2);
const store = createSqliteCircleStore({ path, busyTimeoutMs: 60_000 });
const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };

if (mode === 'accept') {
  // every racer tries to accept the same invitation, as the same person
  const result = await store.acceptInvitation('i0000000000000001', 'u0000000000000003', 'carol', 2000, LIMITS);
  process.stdout.write(JSON.stringify(result.ok) + '\n');
  store.close();
} else if (mode === 'create') {
  // each racer makes 10 circles of its own and 10 invitations into the shared circle
  const results = [];
  for (let i = 0; i < 10; i++) results.push((await store.createCircle({ id: `c${prefix}${String(i).padStart(15, '0')}`.slice(0, 17), name: `${prefix} ${i}`, createdAt: 1 }, `u${prefix}`.padEnd(17, '0'), LIMITS)).ok);
  for (let i = 0; i < 10; i++) results.push((await store.createInvitation({ id: `i${prefix}${String(i).padStart(15, '0')}`.slice(0, 17), circleId: 'c0000000000000001', username: `${prefix}-name-${i}`, role: 'member', invitedBy: 'u0000000000000001', createdAt: 1, expiresAt: 10_000 }, LIMITS, 1)).ok);
  process.stdout.write(JSON.stringify(results) + '\n');
  store.close();
} else {
  await store.createCircle({ id: 'c0000000000000009', name: 'Committed', createdAt: 1 }, 'u0000000000000001', LIMITS);
  // Take the write lock and write, but never commit: reach into the database the way the store does.
  const { openDb } = await import('../../sqlite/db.ts');
  const db = openDb({ path });
  db.begin();
  for (let i = 0; i < 500; i++) db.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'partial', 1, 1)", `cpartial${String(i).padStart(8, '0')}`);
  process.stdout.write('ready\n');
  if (mode === 'hang') await new Promise(() => {});
  db.commit();
  db.close();
  store.close();
}
