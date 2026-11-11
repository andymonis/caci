import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import { USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from '../../users/sqlite/index.js';
import { USERS_MIGRATIONS } from '../../users/sqlite/schema.js';
import type { CircleStore, JoinLinkRecord } from '../store.js';
import { createSqliteCircleStore } from './sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, '..', '..', 'sqlite', 'ts-loader.mjs');
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-joinlinks-'));
  dirs.push(dir);
  return dir;
};
const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };
const LINK_LIMITS = { maxLiveLinksPerCircle: 20 };
const REQUESTS = { maxPendingPerCircle: 20, ttlMs: 10_000_000 };
const pad = (n: number | string): string => String(n).padStart(16, '0');
const cid = (n: number): string => `c${pad(n)}`;
const uid = (n: number): string => `u${pad(n)}`;
const lid = (n: number): string => `j${pad(n)}`;
const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');
const open = (path = join(tmp(), 'users.db')) => {
  const store = createSqliteCircleStore({ path });
  const db = openDb({ path });
  closers.push(() => store.close(), () => db.close());
  return { path, store, db };
};
const record = (n: number, extra: Partial<JoinLinkRecord> = {}): JoinLinkRecord => ({ id: lid(n), circleId: cid(1), tokenHash: hashOf(`token-${n}`), role: 'member', label: `Link ${n}`, createdBy: uid(1), createdAt: 1, expiresAt: 10_000_000, maxUses: 1, approval: false, ...extra });
const count = (db: ReturnType<typeof openDb>, table: string): number => Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0);
const start = async (store: CircleStore): Promise<void> => void (await store.createCircle({ id: cid(1), name: 'Club', createdAt: 1 }, uid(1), LIMITS));

describe('the schema', () => {
  it('is version 9 with both tables, their indexes and the trigger', () => {
    const { db } = open();
    expect(USERS_SCHEMA_VERSION).toBe(9);
    expect(db.pragma('user_version')).toBe(9);
    const names = (type: string): string[] => db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(['circle_join_links', 'circle_join_requests']));
    expect(names('index')).toEqual(expect.arrayContaining(['circle_join_links_by_circle', 'circle_join_requests_by_user']));
    expect(names('trigger')).toContain('circle_join_requests_end_with_user');
  });

  it('a version 8 database is upgraded without touching its users, circles, members, invitations or agent tokens', async () => {
    const path = join(tmp(), 'users.db');
    const old = openDb({ path });
    prepareSchema(old, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 8), foreignCode: 'NOT_A_USERS_DATABASE' });
    old.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, 'user1', 'One', 'admin', 'h', 1, 1)", uid(1));
    old.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'Old', 1, 1)", cid(1));
    old.run("INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 1)", cid(1), uid(1));
    old.run("INSERT INTO circle_invitations (id, circle_id, username, role, invited_by, created_at, expires_at) VALUES (?, ?, 'carol', 'member', ?, 1, 99999999)", `i${pad(1)}`, cid(1), uid(1));
    old.run("INSERT INTO agent_tokens (token_hash, id, user_id, name, scopes, checks, created_at, expires_at) VALUES ('h1', 't1', ?, 'a', '[\"personal\"]', 0, 1, 99999999)", uid(1));
    expect(old.pragma('user_version')).toBe(8);
    old.close();
    const { store, db } = open(path);
    expect(db.pragma('user_version')).toBe(9);
    expect((await store.getCircle(cid(1)))?.name).toBe('Old');
    expect((await store.membershipOf(cid(1), uid(1)))?.role).toBe('owner');
    expect((await store.getInvitation(`i${pad(1)}`))?.username).toBe('carol');
    expect(count(db, 'users')).toBe(1);
    expect(count(db, 'agent_tokens')).toBe(1);
    expect(count(db, 'circle_join_links')).toBe(0);
    expect(count(db, 'circle_join_requests')).toBe(0);
  });

  it('the database itself refuses a link that offers more than member or observer, bad uses, bad hashes, a copy of a hash and a missing circle', async () => {
    const { store, db } = open();
    await start(store);
    const insert = (over: Record<string, string | number> = {}): void => {
      const v = { id: lid(1), circle: cid(1), hash: hashOf('x'), role: 'member', uses: 0, max: 1, approval: 0, ...over };
      db.run('INSERT INTO circle_join_links (id, circle_id, token_hash, role, label, created_by, created_at, expires_at, max_uses, uses, approval) VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?, ?, ?)', v.id, v.circle, v.hash, v.role, 'l', uid(1), v.max, v.uses, v.approval);
    };
    for (const role of ['owner', 'manager', 'admin']) expect(() => insert({ role }), role).toThrow();
    for (const max of [0, 101]) expect(() => insert({ max }), String(max)).toThrow();
    expect(() => insert({ uses: 2, max: 1 })).toThrow();
    expect(() => insert({ uses: -1 })).toThrow();
    expect(() => insert({ approval: 2 })).toThrow();
    for (const hash of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) expect(() => insert({ hash }), hash).toThrow();
    expect(() => insert({ circle: cid(9) })).toThrow();
    expect(() => insert()).not.toThrow();
    expect(() => insert({ id: lid(2) })).toThrow(); // the same hash twice
    expect(() => insert({ id: lid(1), hash: hashOf('y') })).toThrow(); // the same id twice
  });

  it('the database itself keeps one waiting request per person and circle, and refuses roles above observer', async () => {
    const { store, db } = open();
    await start(store);
    const insert = (id: string, user: number, role = 'member'): void => void db.run('INSERT INTO circle_join_requests (id, circle_id, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, 1, 2)', id, cid(1), uid(user), role);
    expect(() => insert('r1', 5, 'owner')).toThrow();
    expect(() => insert('r1', 5, 'manager')).toThrow();
    expect(() => insert('r1', 5)).not.toThrow();
    expect(() => insert('r2', 5)).toThrow();
    expect(() => insert('r3', 6)).not.toThrow();
    expect(() => db.run("INSERT INTO circle_join_requests (id, circle_id, user_id, role, created_at, expires_at) VALUES ('r9', ?, ?, 'member', 1, 2)", cid(9), uid(7))).toThrow();
  });
});

describe('links and requests belong to the circle and to nobody else', () => {
  it('deleting the circle row removes its links and requests and nothing of another circle', async () => {
    const { store, db } = open();
    await start(store);
    await store.createCircle({ id: cid(2), name: 'Other', createdAt: 1 }, uid(1), LIMITS);
    for (const [n, circle] of [[1, 1], [2, 2]] as const) {
      await store.createJoinLink(record(n, { circleId: cid(circle), approval: true, maxUses: 5 }), LINK_LIMITS, 5);
      await store.requestJoin(hashOf(`token-${n}`), `r${pad(n)}`, uid(10 + n), 5, REQUESTS);
    }
    expect([count(db, 'circle_join_links'), count(db, 'circle_join_requests')]).toEqual([2, 2]);
    db.run('DELETE FROM circles WHERE id = ?', cid(1));
    expect([count(db, 'circle_join_links'), count(db, 'circle_join_requests')]).toEqual([1, 1]);
    expect(db.get<{ circle_id: string }>('SELECT circle_id FROM circle_join_requests')?.circle_id).toBe(cid(2));
  });

  it('deleting a user row removes that person\'s waiting requests only, and not the links they made', async () => {
    const { store, db } = open();
    await start(store);
    await store.createJoinLink(record(1, { createdBy: uid(5), approval: true, maxUses: 5 }), LINK_LIMITS, 5);
    await store.requestJoin(hashOf('token-1'), `r${pad(1)}`, uid(5), 5, REQUESTS);
    await store.requestJoin(hashOf('token-1'), `r${pad(2)}`, uid(6), 5, REQUESTS);
    db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, 'five', 'Five', 'user', 'h', 1, 1)", uid(5));
    db.run('DELETE FROM users WHERE id = ?', uid(5));
    expect(db.all<{ user_id: string }>('SELECT user_id FROM circle_join_requests').map((r) => r.user_id)).toEqual([uid(6)]);
    expect(count(db, 'circle_join_links')).toBe(1);
  });

  it('the account-deletion path of the store takes the person\'s requests too', async () => {
    const { store, db } = open();
    await start(store);
    await store.createJoinLink(record(1, { approval: true, maxUses: 5 }), LINK_LIMITS, 5);
    await store.requestJoin(hashOf('token-1'), `r${pad(1)}`, uid(5), 5, REQUESTS);
    await store.removeUser(uid(5), 'five');
    expect(count(db, 'circle_join_requests')).toBe(0);
  });
});

describe('the token never reaches the file', () => {
  it('only the hash is in the database and its log, never the token (as text or as bytes)', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const { store } = open(path);
    await start(store);
    const token = `cjoin_${'Qz'.repeat(21)}x`;
    await store.createJoinLink(record(1, { tokenHash: hashOf(token), approval: true, maxUses: 3 }), LINK_LIMITS, 5);
    await store.requestJoin(hashOf(token), `r${pad(1)}`, uid(5), 5, REQUESTS);
    const files = readdirSync(dir).filter((f) => f.startsWith('users.db'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = readFileSync(join(dir, f));
      expect(bytes.includes(Buffer.from(token)), f).toBe(false);
      expect(bytes.includes(Buffer.from(token.slice(6))), f).toBe(false);
    }
    expect(files.some((f) => readFileSync(join(dir, f)).includes(Buffer.from(hashOf(token))))).toBe(true);
    expect(await store.getJoinLinkByHash(token, 6)).toBeUndefined(); // the token itself finds nothing: only its hash does
    expect(await store.getJoinLinkByHash(hashOf(token), 6)).toBeDefined();
  });
});

describe('a file keeps what it was given', () => {
  it('links, uses and waiting requests survive closing and reopening, and a second store on the file sees them', async () => {
    const path = join(tmp(), 'users.db');
    const first = open(path);
    await start(first.store);
    await first.store.createJoinLink(record(1, { approval: true, maxUses: 3, role: 'observer', label: 'A label' }), LINK_LIMITS, 5);
    await first.store.requestJoin(hashOf('token-1'), `r${pad(1)}`, uid(5), 5, REQUESTS);
    first.store.close();
    const second = open(path);
    const link = await second.store.getJoinLinkByHash(hashOf('token-1'), 6);
    expect(link).toMatchObject({ id: lid(1), role: 'observer', label: 'A label', uses: 1, maxUses: 3, approval: true });
    expect((await second.store.listJoinRequests(cid(1), 6, { limit: 10, cursor: null })).items.map((r) => r.userId)).toEqual([uid(5)]);
    const third = open(path);
    expect((await third.store.approveJoinRequest(`r${pad(1)}`, cid(1), 7, LIMITS)).ok).toBe(true);
    expect((await second.store.membershipOf(cid(1), uid(5)))?.role).toBe('observer');
  });
});

describe('other processes and crashes', () => {
  const run = (path: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', loader, join(here, 'join-child.mjs'), path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += String(c)));
      child.stderr.on('data', (c) => (err += String(c)));
      child.on('close', (code) => resolve({ code, out, err }));
    });
  const said = (r: { code: number | null; out: string; err: string }): string => {
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out.trim()) as string;
  };

  it('four processes joining by a one-use link make exactly one member', async () => {
    const path = join(tmp(), 'users.db');
    const { store } = open(path);
    await start(store);
    await store.createJoinLink(record(1), LINK_LIMITS, 5);
    const results = (await Promise.all([11, 12, 13, 14].map((n) => run(path, ['join', hashOf('token-1'), uid(n)])))).map(said);
    expect(results.filter((r) => r === 'joined')).toHaveLength(1);
    expect(results.filter((r) => r === 'NOT_FOUND')).toHaveLength(3);
    expect((await store.listMembers(cid(1), { limit: 10, cursor: null })).items).toHaveLength(2);
  }, 60_000);

  it('four processes asking by a one-use approval link make exactly one request', async () => {
    const path = join(tmp(), 'users.db');
    const { store } = open(path);
    await start(store);
    await store.createJoinLink(record(1, { approval: true }), LINK_LIMITS, 5);
    const results = (await Promise.all([11, 12, 13, 14].map((n) => run(path, ['ask', hashOf('token-1'), `r${pad(n)}`, uid(n)])))).map(said);
    expect(results.filter((r) => r === 'requested')).toHaveLength(1);
    expect(results.filter((r) => r === 'NOT_FOUND')).toHaveLength(3);
    expect((await store.listJoinRequests(cid(1), 6, { limit: 10, cursor: null })).items).toHaveLength(1);
  }, 60_000);

  it('four processes approving one request add exactly one member', async () => {
    const path = join(tmp(), 'users.db');
    const { store } = open(path);
    await start(store);
    await store.createJoinLink(record(1, { approval: true }), LINK_LIMITS, 5);
    await store.requestJoin(hashOf('token-1'), `r${pad(1)}`, uid(5), 5, REQUESTS);
    const results = (await Promise.all([1, 2, 3, 4].map(() => run(path, ['approve', cid(1), `r${pad(1)}`])))).map(said);
    expect(results.filter((r) => r === 'approved')).toHaveLength(1);
    expect(results.filter((r) => r === 'NOT_FOUND')).toHaveLength(3);
    expect((await store.listMembers(cid(1), { limit: 10, cursor: null })).items).toHaveLength(2);
  }, 60_000);

  it('a process killed inside a join leaves no member and no use counted, and the link still works', async () => {
    const path = join(tmp(), 'users.db');
    const { store } = open(path);
    await start(store);
    await store.createJoinLink(record(1), LINK_LIMITS, 5);
    const child = spawn(process.execPath, ['--import', loader, join(here, 'join-child.mjs'), path, 'hang', cid(1), hashOf('token-1'), uid(9)], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c) => {
        out += String(c);
        if (out.includes('ready')) resolve();
      });
      child.on('error', reject);
      child.on('close', () => reject(new Error('the child ended before it was ready')));
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    expect(await store.membershipOf(cid(1), uid(9))).toBeUndefined();
    expect((await store.getJoinLinkByHash(hashOf('token-1'), 6))?.uses).toBe(0);
    const joined = await store.joinWithLink(hashOf('token-1'), uid(9), 7, LIMITS);
    expect(joined.ok && joined.value.joined).toBe(true);
  }, 30_000);
});
