// Test support: a child process that uses join links and requests. Not part of the package.
// usage: node --import ../../sqlite/ts-loader.mjs join-child.mjs <path> <mode> ...args
//   join <hash> <user>            joins by a link that needs no approval
//   ask <hash> <request> <user>   asks to join by a link that needs approval
//   approve <circle> <request>    approves a waiting request
//   hang <circle> <hash> <user>   takes the write lock, joins and counts the use without committing, then waits to be killed
import process from 'node:process';
import { createSqliteCircleStore } from './index.ts';

const [path, mode, ...args] = process.argv.slice(2);
const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50 };
const REQUESTS = { maxPendingPerCircle: 20, ttlMs: 10_000_000 };
const NOW = 1000;
const store = createSqliteCircleStore({ path, busyTimeoutMs: 60_000 });
const say = (value) => process.stdout.write(JSON.stringify(value) + '\n');

if (mode === 'join') {
  const [hash, user] = args;
  const r = await store.joinWithLink(hash, user, NOW, LIMITS);
  say(r.ok ? (r.value.joined ? 'joined' : 'member') : r.error.code);
  store.close();
} else if (mode === 'ask') {
  const [hash, request, user] = args;
  const r = await store.requestJoin(hash, request, user, NOW, REQUESTS);
  say(r.ok ? r.value.state : r.error.code);
  store.close();
} else if (mode === 'approve') {
  const [circle, request] = args;
  const r = await store.approveJoinRequest(request, circle, NOW + 1, LIMITS);
  say(r.ok ? 'approved' : r.error.code);
  store.close();
} else {
  const [circle, hash, user] = args;
  const { openDb } = await import('../../sqlite/db.ts');
  const db = openDb({ path });
  db.begin();
  db.run("INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)", circle, user);
  db.run('UPDATE circle_join_links SET uses = uses + 1 WHERE token_hash = ?', hash);
  process.stdout.write('ready\n');
  await new Promise(() => {});
}
