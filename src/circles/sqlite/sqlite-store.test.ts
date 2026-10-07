import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../../graph_store/adapters/sqlite/index.js';
import { DbError, openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import { createSqliteUserStore, USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from '../../users/sqlite/index.js';
import { USERS_MIGRATIONS } from '../../users/sqlite/schema.js';
import type { CircleStore } from '../store.js';
import { runCircleStoreConformance } from '../testing/index.js';
import { createSqliteCircleStore, type SqliteCircleStore } from './sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, '..', '..', 'sqlite', 'ts-loader.mjs');
const dirs: string[] = [];
const stores: SqliteCircleStore[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-circles-'));
  dirs.push(dir);
  return dir;
};
const openAt = (path: string, busyTimeoutMs?: number): SqliteCircleStore => {
  const store = createSqliteCircleStore(busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };
const cid = (n: number): string => `c${String(n).padStart(16, '0')}`;
const iid = (n: number): string => `i${String(n).padStart(16, '0')}`;
const uid = (n: number): string => `u${String(n).padStart(16, '0')}`;
const circle = (n: number) => ({ id: cid(n), name: `Circle ${n}`, createdAt: 1000 + n });
const invite = (n: number, circleN: number, username: string, role: 'owner' | 'manager' | 'member' | 'observer' = 'member') => ({ id: iid(n), circleId: cid(circleN), username, role, invitedBy: uid(1), createdAt: 1000, expiresAt: 100_000 });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (cause) {
    return cause instanceof DbError ? cause.code : `other: ${String(cause)}`;
  }
  return undefined;
};

// The whole circle store contract: on a private in-memory database per test, and again on a real file per test.
runCircleStoreConformance(() => createSqliteCircleStore(), { describe, it }, { dispose: (store) => (store as SqliteCircleStore).close() });
{
  const homes = new Map<CircleStore, string>();
  describe('on a file', () => {
    runCircleStoreConformance(
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'caci-circles-conf-'));
        const store = createSqliteCircleStore({ path: join(dir, 'users.db') });
        homes.set(store, dir);
        return store;
      },
      { describe, it },
      {
        dispose: (store) => {
          (store as SqliteCircleStore).close();
          const dir = homes.get(store);
          if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
        },
      },
    );
  });
}

describe('the database', () => {
  it('is the user database: the same file, application id and schema version', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    await store.createCircle(circle(1), uid(1), LIMITS);
    const db = openDb({ path });
    expect(db.pragma('application_id')).toBe(USERS_APPLICATION_ID);
    expect(db.pragma('user_version')).toBe(USERS_SCHEMA_VERSION);
    expect(USERS_SCHEMA_VERSION).toBe(4);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)).toEqual(['circle_invitations', 'circle_members', 'circles', 'sessions', 'users']);
    db.close();
  });

  it('shares the file with the user store: both work, and a circle needs no user row', async () => {
    const path = join(tmp(), 'users.db');
    const users = createSqliteUserStore({ path });
    const circles = openAt(path);
    expect((await users.create({ id: uid(1), username: 'ann', displayName: 'Ann', role: 'user', passwordHash: 'h', createdAt: 1 })).ok).toBe(true);
    expect((await circles.createCircle(circle(1), 'someone-with-no-account', LIMITS)).ok).toBe(true);
    expect(await users.count()).toBe(1);
    expect((await circles.getCircle(cid(1)))?.name).toBe('Circle 1');
    users.close();
  });

  it('is added to a version 2 user database without touching its users or sessions', async () => {
    const path = join(tmp(), 'users.db');
    const db = openDb({ path });
    prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 2), foreignCode: 'NOT_A_USERS_DATABASE' });
    db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES ('u0000000000000001', 'ann', 'Ann', 'admin', 'h', 1, 1)");
    db.run("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES ('hash', 'u0000000000000001', 1, 1)");
    expect(db.pragma('user_version')).toBe(2);
    db.close();

    const store = openAt(path); // opening upgrades it
    expect((await store.createCircle(circle(1), uid(1), LIMITS)).ok).toBe(true);
    const after = openDb({ path });
    expect(after.pragma('user_version')).toBe(USERS_SCHEMA_VERSION);
    expect(after.get("SELECT username, role FROM users WHERE id = 'u0000000000000001'")).toEqual({ username: 'ann', role: 'admin' });
    expect(after.get<{ n: number }>('SELECT count(*) AS n FROM sessions')?.n).toBe(1);
    after.close();
  });

  it('refuses the graph database, a foreign file and a newer schema, and leaves them untouched', async () => {
    const dir = tmp();
    const graphPath = join(dir, 'graphs.db');
    const adapter = createSqliteAdapter({ path: graphPath });
    await adapter.graphs.create('g');
    await adapter.close();
    expect(codeOf(() => createSqliteCircleStore({ path: graphPath }))).toBe('NOT_A_USERS_DATABASE');

    const newer = join(dir, 'newer.db');
    const db = openDb({ path: newer });
    prepareSchema(db, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS, foreignCode: 'NOT_A_USERS_DATABASE' });
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(codeOf(() => createSqliteCircleStore({ path: newer }))).toBe('NEWER_SCHEMA');
    const check = openDb({ path: newer });
    expect(check.pragma('user_version')).toBe(99);
    check.close();
  });

  it('is created owner-only (0600) and a clean close leaves one file', async () => {
    const dir = tmp();
    const path = join(dir, 'users.db');
    const store = createSqliteCircleStore({ path });
    await store.createCircle(circle(1), uid(1), LIMITS);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.close();
    expect(readdirSync(dir)).toEqual(['users.db']);
  });

  it('keeps everything across close and reopen', async () => {
    const path = join(tmp(), 'users.db');
    const first = createSqliteCircleStore({ path });
    await first.createCircle({ ...circle(1), description: 'About' }, uid(1), LIMITS);
    await first.createInvitation(invite(1, 1, 'carol', 'manager'), LIMITS, 1000);
    await first.createInvitation(invite(2, 1, 'dave'), LIMITS, 1000);
    await first.acceptInvitation(iid(2), uid(4), 'dave', 2000, LIMITS);
    first.close();
    const second = openAt(path);
    expect((await second.getCircle(cid(1)))?.description).toBe('About');
    expect((await second.getInvitation(iid(1)))?.role).toBe('manager');
    expect(await second.getInvitation(iid(2))).toBeUndefined();
    expect((await second.membershipOf(cid(1), uid(4)))?.joinedAt).toBe(2000);
    expect((await second.listCirclesOf(uid(1), { limit: 5, cursor: null })).items[0]?.memberCount).toBe(2);
  });
});

describe('what the database enforces itself', () => {
  it('deleting a circle removes its members and invitations in the database, not just in the store', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    await store.createCircle(circle(1), uid(1), LIMITS);
    await store.createInvitation(invite(1, 1, 'carol'), LIMITS, 1000);
    const db = openDb({ path });
    db.run('DELETE FROM circles WHERE id = ?', cid(1));
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM circle_members')?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM circle_invitations')?.n).toBe(0);
    db.close();
  });

  it('refuses a role that is not one of the four, a username that is not lower case, and a second invitation for the same name', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    await store.createCircle(circle(1), uid(1), LIMITS);
    const db = openDb({ path });
    const insertMember = (role: string) => () => db.run('INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, ?, 1)', cid(1), uid(2), role);
    expect(() => insertMember('admin')()).toThrow();
    expect(() => insertMember('Owner')()).toThrow();
    const insertInvitation = (id: number, name: string) => () => db.run("INSERT INTO circle_invitations (id, circle_id, username, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, 'member', 'x', 1, 2)", iid(id), cid(1), name);
    expect(() => insertInvitation(1, 'Carol')()).toThrow();
    expect(() => insertInvitation(2, '')()).toThrow();
    insertInvitation(3, 'carol')();
    expect(() => insertInvitation(4, 'carol')()).toThrow();
    db.close();
  });

  it('a membership cannot exist without its circle', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    await store.createCircle(circle(1), uid(1), LIMITS);
    const db = openDb({ path });
    expect(() => db.run("INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES ('cnone', 'u1', 'member', 1)")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('a failing statement inside a transaction is rolled back and the store keeps working', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path);
    await store.createCircle(circle(1), uid(1), LIMITS);
    // a repeated id inside accept's transaction cannot happen, so force a failure with a bad value instead
    const bad = await store.createCircle({ ...circle(2), name: undefined as unknown as string }, uid(1), LIMITS);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.error.code).toBe('STORAGE_ERROR');
    expect(bad.ok ? '' : bad.error.message).toBe('the circle database could not complete the request');
    expect(await store.getCircle(cid(2))).toBeUndefined();
    expect((await store.createCircle(circle(3), uid(1), LIMITS)).ok).toBe(true);
    expect((await store.listCirclesOf(uid(1), { limit: 10, cursor: null })).items.map((s) => s.circle.id)).toEqual([cid(1), cid(3)]);
  });
});

describe('two connections and crashes', () => {
  const run = (args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', loader, join(here, 'kill-child.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += String(c)));
      child.stderr.on('data', (c) => (err += String(c)));
      child.on('close', (code) => resolve({ code, out, err }));
    });

  it('two stores on one file see each other\'s work at once', async () => {
    const path = join(tmp(), 'users.db');
    const a = openAt(path);
    const b = openAt(path);
    await a.createCircle(circle(1), uid(1), LIMITS);
    expect((await b.getCircle(cid(1)))?.name).toBe('Circle 1');
    await b.createInvitation(invite(1, 1, 'carol'), LIMITS, 1000);
    expect((await a.acceptInvitation(iid(1), uid(3), 'carol', 2000, LIMITS)).ok).toBe(true);
    expect((await b.membershipOf(cid(1), uid(3)))?.role).toBe('member');
  });

  it('a process killed with SIGKILL inside a write transaction leaves the file intact, without the partial write', async () => {
    const path = join(tmp(), 'users.db');
    const child = spawn(process.execPath, ['--import', loader, join(here, 'kill-child.mjs'), path, 'hang'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const store = openAt(path);
    expect((await store.listCirclesOf('u0000000000000001', { limit: 100, cursor: null })).items.map((s) => s.circle.id)).toEqual([cid(9)]);
    expect(await store.getCircle('cpartial00000000')).toBeUndefined();
    expect((await store.createCircle(circle(2), uid(1), LIMITS)).ok).toBe(true);
  }, 30_000);

  it('the killed run really did write before it was killed (otherwise the test proves nothing)', async () => {
    const path = join(tmp(), 'users.db');
    const done = await run([path, 'finish']);
    expect(done.code, done.err).toBe(0);
    const store = openAt(path);
    expect(await store.getCircle('cpartial00000000')).toBeDefined();
  }, 30_000);

  it('two processes accepting one invitation at once make one membership', async () => {
    const path = join(tmp(), 'users.db');
    const setup = openAt(path);
    await setup.createCircle({ id: 'c0000000000000001', name: 'Shared', createdAt: 1 }, 'u0000000000000001', LIMITS);
    await setup.createInvitation({ id: 'i0000000000000001', circleId: 'c0000000000000001', username: 'carol', role: 'member', invitedBy: 'u0000000000000001', createdAt: 1, expiresAt: 10_000 }, LIMITS, 1);
    const results = await Promise.all([run([path, 'accept']), run([path, 'accept']), run([path, 'accept']), run([path, 'accept'])]);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const outcomes = results.map((r) => JSON.parse(r.out.trim()) as boolean);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await setup.listMembers('c0000000000000001', { limit: 10, cursor: null })).items).toHaveLength(2);
  }, 60_000);

  it('two processes creating circles and invitations at once lose none', async () => {
    const path = join(tmp(), 'users.db');
    const setup = openAt(path);
    await setup.createCircle({ id: 'c0000000000000001', name: 'Shared', createdAt: 1 }, 'u0000000000000001', LIMITS);
    const [a, b] = await Promise.all([run([path, 'create', 'a']), run([path, 'create', 'b'])]);
    for (const r of [a, b]) expect(r.code, r.err).toBe(0);
    for (const r of [a, b]) expect((JSON.parse(r.out.trim()) as boolean[]).every(Boolean)).toBe(true);
    expect((await setup.listInvitationsOfCircle('c0000000000000001', 1, { limit: 100, cursor: null })).items).toHaveLength(20);
    expect(existsSync(path)).toBe(true);
  }, 60_000);

  it('a lock held past the timeout is a clear storage error, and the store works again afterwards', async () => {
    const path = join(tmp(), 'users.db');
    const store = openAt(path, 100);
    await store.createCircle(circle(1), uid(1), LIMITS);
    const holder = openDb({ path });
    holder.begin();
    const result = await store.createCircle(circle(2), uid(1), LIMITS);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.code).toBe('STORAGE_ERROR');
    holder.rollback();
    holder.close();
    expect((await store.createCircle(circle(2), uid(1), LIMITS)).ok).toBe(true);
    expect(codeOf(() => openDb({ path: join(tmp(), 'missing-dir', 'x.db') }))).toBeDefined();
  });
});
