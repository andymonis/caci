import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../../graph_store/adapters/memory/index.js';
import { openDb, type Db } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import { createLoginThrottle, createPasswordHasher, createRegistrationThrottle, createUserController } from '../../users/index.js';
import { createSqliteSessionStore, createSqliteUserStore, USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from '../../users/sqlite/index.js';
import { USERS_MIGRATIONS } from '../../users/sqlite/schema.js';
import { createMemoryCircleStore } from '../memory-store.js';
import type { CircleStore, Invitation } from '../store.js';
import type { CircleRole } from '../types.js';
import { createSqliteCircleStore, type SqliteCircleStore } from './sqlite-store.js';

// R-004 D11 / CR-FR-11: deleting an account takes it out of every circle, in the same transaction,
// whoever deletes it. The database does this itself (a trigger), and it must do exactly what the
// circle store's `removeUser` does: the two are tested against each other.

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-deletion-'));
  dirs.push(dir);
  return dir;
};

const LIMITS = { maxCirclesPerUser: 100, maxMembersPerCircle: 100, maxOpenInvitationsPerCircle: 100 };
const cid = (n: number): string => `c${String(n).padStart(16, '0')}`;
const iid = (n: number): string => `i${String(n).padStart(16, '0')}`;
const uid = (n: number): string => `u${String(n).padStart(16, '0')}`;
const NOW = 1000;
const USER_COLUMNS = '(id, username, display_name, role, password_hash, created_at, updated_at)';
const addUser = (db: Db, n: number, role = 'user'): void => void db.run(`INSERT INTO users ${USER_COLUMNS} VALUES (?, ?, ?, ?, 'h', 1, 1)`, uid(n), `user${n}`, `User ${n}`, role);

/** A file with the user and circle stores on it, and a raw handle (to delete users the way anyone might). */
function open(): { path: string; circles: SqliteCircleStore; db: Db } {
  const path = join(tmp(), 'users.db');
  const circles = createSqliteCircleStore({ path });
  const db = openDb({ path });
  closers.push(() => circles.close(), () => db.close());
  return { path, circles, db };
}

async function join_(store: CircleStore, circle: number, user: number, role: CircleRole, at: number): Promise<void> {
  const id = circle * 1000 + user;
  await store.createInvitation({ id: iid(id), circleId: cid(circle), username: `user${user}`, role, invitedBy: uid(1), createdAt: NOW, expiresAt: 1_000_000 }, LIMITS, NOW);
  const result = await store.acceptInvitation(iid(id), uid(user), `user${user}`, at, LIMITS);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}
const create = async (store: CircleStore, circle: number, owner: number, at = NOW): Promise<void> => {
  const r = await store.createCircle({ id: cid(circle), name: `Circle ${circle}`, createdAt: at }, uid(owner), LIMITS);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
};
const invite = async (store: CircleStore, n: number, circle: number, username: string, invitedBy: number): Promise<void> => void (await store.createInvitation({ id: iid(n), circleId: cid(circle), username, role: 'member', invitedBy: uid(invitedBy), createdAt: NOW, expiresAt: 1_000_000 }, LIMITS, NOW));
const rolesIn = async (store: CircleStore, circle: number): Promise<string[]> => (await store.listMembers(cid(circle), { limit: 100, cursor: null })).items.map((m) => `${m.userId}:${m.role}`);

describe('deleting an account', () => {
  it('the database has the trigger, and it is part of the schema', () => {
    const { db } = open();
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'circles_leave_with_user'")?.name).toBe('circles_leave_with_user');
    expect(USERS_SCHEMA_VERSION).toBe(4);
  });

  it('takes the person out of every circle and removes their invitations, both addressed to them and sent by them, and leaves everything else', async () => {
    const { circles, db } = open();
    for (const n of [1, 2, 3, 4]) addUser(db, n);
    await create(circles, 1, 1);
    await join_(circles, 1, 2, 'member', 2000);
    await create(circles, 2, 3);
    await join_(circles, 2, 2, 'observer', 2000);
    await join_(circles, 2, 4, 'manager', 2000);
    await invite(circles, 1, 1, 'user2', 1); // to them
    await invite(circles, 2, 2, 'carol', 2); // from them
    await invite(circles, 3, 2, 'dave', 3); // neither
    db.run('DELETE FROM users WHERE id = ?', uid(2));
    expect(await rolesIn(circles, 1)).toEqual([`${uid(1)}:owner`]);
    expect(await rolesIn(circles, 2)).toEqual([`${uid(3)}:owner`, `${uid(4)}:manager`]);
    expect(await circles.getInvitation(iid(1))).toBeUndefined();
    expect(await circles.getInvitation(iid(2))).toBeUndefined();
    expect((await circles.getInvitation(iid(3)))?.username).toBe('dave');
    expect(await circles.listCirclesOf(uid(2), { limit: 10, cursor: null })).toEqual({ items: [], nextCursor: null });
  });

  it('hands a circle they solely owned to the longest-standing manager, else member, else observer', async () => {
    const { circles, db } = open();
    for (const n of [1, 2, 3, 4, 5]) addUser(db, n);
    await create(circles, 1, 1);
    for (const [user, role, at] of [[2, 'observer', 2000], [3, 'member', 2001], [4, 'manager', 2005], [5, 'manager', 2006]] as const) await join_(circles, 1, user, role, at);
    await create(circles, 2, 1);
    await join_(circles, 2, 2, 'observer', 2000);
    await join_(circles, 2, 3, 'member', 2001);
    await create(circles, 3, 1);
    await join_(circles, 3, 3, 'observer', 2002);
    await join_(circles, 3, 2, 'observer', 2002); // the same moment: the lower user id
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(await rolesIn(circles, 1)).toEqual([`${uid(2)}:observer`, `${uid(3)}:member`, `${uid(4)}:owner`, `${uid(5)}:manager`]);
    expect(await rolesIn(circles, 2)).toEqual([`${uid(2)}:observer`, `${uid(3)}:owner`]);
    expect(await rolesIn(circles, 3)).toEqual([`${uid(2)}:owner`, `${uid(3)}:observer`]);
  });

  it('a person who is one of several owners is simply removed, with no hand-over', async () => {
    const { circles, db } = open();
    for (const n of [1, 2, 3]) addUser(db, n);
    await create(circles, 1, 1);
    await join_(circles, 1, 2, 'owner', 2000);
    await join_(circles, 1, 3, 'manager', 2000);
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(await rolesIn(circles, 1)).toEqual([`${uid(2)}:owner`, `${uid(3)}:manager`]);
  });

  it('a circle they owned and were alone in no longer exists, and neither do its invitations; others are untouched', async () => {
    const { circles, db } = open();
    for (const n of [1, 2]) addUser(db, n);
    await create(circles, 1, 1);
    await invite(circles, 1, 1, 'carol', 1);
    await create(circles, 2, 2);
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(await circles.getCircle(cid(1))).toBeUndefined();
    expect(await circles.getInvitation(iid(1))).toBeUndefined();
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM circle_members WHERE circle_id = ?", cid(1))?.n).toBe(0);
    expect(await circles.getCircle(cid(2))).toBeDefined();
  });

  it('a circle never ends without an owner, and no membership is left for an account that is gone', async () => {
    const { circles, db } = open();
    for (const n of [1, 2, 3, 4]) addUser(db, n);
    await create(circles, 1, 1);
    await join_(circles, 1, 2, 'observer', 2000);
    await join_(circles, 1, 3, 'member', 2001);
    await join_(circles, 1, 4, 'manager', 2002);
    for (const n of [1, 4, 3]) {
      db.run('DELETE FROM users WHERE id = ?', uid(n));
      const roles = await rolesIn(circles, 1);
      expect(roles.some((r) => r.endsWith(':owner')), roles.join()).toBe(true);
      expect(roles.some((r) => r.startsWith(uid(n)))).toBe(false);
    }
    expect(await rolesIn(circles, 1)).toEqual([`${uid(2)}:owner`]);
    db.run('DELETE FROM users WHERE id = ?', uid(2));
    expect(await circles.getCircle(cid(1))).toBeUndefined();
  });

  it('is part of the delete: a delete that is rolled back, or refused, changes nothing in any circle', async () => {
    const { path, circles, db } = open();
    addUser(db, 1, 'admin');
    addUser(db, 2);
    await create(circles, 1, 2);
    await join_(circles, 1, 1, 'member', 2000);
    await invite(circles, 1, 1, 'user1', 2);
    db.begin();
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM circle_members WHERE user_id = ?', uid(1))?.n).toBe(0); // inside the transaction it is already gone
    db.rollback();
    expect(await rolesIn(circles, 1)).toEqual([`${uid(1)}:member`, `${uid(2)}:owner`]);
    expect(await circles.getInvitation(iid(1))).toBeDefined();
    const users = createSqliteUserStore({ path });
    closers.push(() => users.close());
    const refused = await users.delete(uid(1), { protectLastAdmin: true });
    expect(refused.ok).toBe(false);
    expect(await rolesIn(circles, 1)).toEqual([`${uid(1)}:member`, `${uid(2)}:owner`]);
  });

  it('deleting a user that does not exist, or that has no place in a circle, changes nothing', async () => {
    const { path, circles, db } = open();
    addUser(db, 1);
    await create(circles, 1, 1);
    await invite(circles, 1, 1, 'carol', 1);
    const users = createSqliteUserStore({ path });
    closers.push(() => users.close());
    expect(await users.delete(uid(9))).toEqual({ ok: true, value: false });
    expect(await rolesIn(circles, 1)).toEqual([`${uid(1)}:owner`]);
    expect(await circles.getInvitation(iid(1))).toBeDefined();
    addUser(db, 7);
    db.run('DELETE FROM users WHERE id = ?', uid(7));
    expect(await rolesIn(circles, 1)).toEqual([`${uid(1)}:owner`]);
  });

  it('a user who has no row is never touched by someone else\'s deletion, even with the same circles', async () => {
    const { circles, db } = open();
    addUser(db, 1);
    await create(circles, 1, 1);
    await join_(circles, 1, 8, 'member', 2000); // an account with no user row
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(await rolesIn(circles, 1)).toEqual([`${uid(8)}:owner`]);
  });

  it('a version 3 database (circles but no trigger) is upgraded, keeps its circles, and then behaves the same', async () => {
    const path = join(tmp(), 'users.db');
    const old = openDb({ path });
    prepareSchema(old, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 3), foreignCode: 'NOT_A_USERS_DATABASE' });
    addUser(old, 1);
    addUser(old, 2);
    old.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'Old', 1, 1)", cid(1));
    old.run("INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 1), (?, ?, 'member', 2)", cid(1), uid(1), cid(1), uid(2));
    expect(old.pragma('user_version')).toBe(3);
    old.run('DELETE FROM users WHERE id = ?', uid(2)); // before the upgrade nothing cleans up after a deletion
    expect(old.get<{ n: number }>('SELECT count(*) AS n FROM circle_members')?.n).toBe(2);
    old.close();

    const circles = createSqliteCircleStore({ path }); // opening upgrades it
    closers.push(() => circles.close());
    const db = openDb({ path });
    closers.push(() => db.close());
    expect(db.pragma('user_version')).toBe(USERS_SCHEMA_VERSION);
    expect((await circles.getCircle(cid(1)))?.name).toBe('Old');
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(await rolesIn(circles, 1)).toEqual([`${uid(2)}:owner`]); // the leftover member of the deleted account inherits: the trigger works now
  });
});

describe('the trigger and the store do the same thing', () => {
  // a small deterministic generator
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ROLES: readonly CircleRole[] = ['owner', 'manager', 'member', 'observer'];

  async function snapshot(store: CircleStore, users: number, circles: number, invitations: number): Promise<unknown> {
    const out: Record<string, unknown> = {};
    for (let c = 1; c <= circles; c++) {
      const circle = await store.getCircle(cid(c));
      out[`c${c}`] = circle === undefined ? null : { circle, members: (await store.listMembers(cid(c), { limit: 1000, cursor: null })).items };
    }
    out.invitations = (await Promise.all(Array.from({ length: invitations }, (_, i) => store.getInvitation(iid(i + 1))))).map((i: Invitation | undefined) => i ?? null);
    out.byUser = await Promise.all(Array.from({ length: users }, (_, u) => store.listCirclesOf(uid(u + 1), { limit: 1000, cursor: null })));
    return out;
  }

  it.each(Array.from({ length: 60 }, (_, i) => [i + 1] as const))('random circles, seed %i: removing people one by one gives the same state as the store\'s removeUser', async (seed) => {
    const next = random(seed);
    const USERS = 7;
    const CIRCLES = 6;
    const INVITES = 25;
    const { circles: sqlite, db } = open();
    const memory = createMemoryCircleStore();
    for (let n = 1; n <= USERS; n++) addUser(db, n);

    for (const store of [memory, sqlite]) {
      const again = random(seed * 7919);
      const choose = <T>(items: readonly T[]): T => items[Math.floor(again() * items.length)] as T;
      for (let c = 1; c <= CIRCLES; c++) await store.createCircle({ id: cid(c), name: `Circle ${c}`, createdAt: 1 + c }, uid(1 + Math.floor(again() * USERS)), LIMITS);
      for (let i = 1; i <= INVITES; i++) {
        const circle = 1 + Math.floor(again() * CIRCLES);
        const user = 1 + Math.floor(again() * USERS);
        await store.createInvitation({ id: iid(i), circleId: cid(circle), username: `user${user}`, role: choose(ROLES), invitedBy: uid(1 + Math.floor(again() * USERS)), createdAt: 5, expiresAt: 1_000_000 }, LIMITS, 5);
        if (again() < 0.7) await store.acceptInvitation(iid(i), uid(user), `user${user}`, 10 + Math.floor(again() * 5), LIMITS);
      }
      for (let k = 0; k < 8; k++) await store.changeRole(cid(1 + Math.floor(again() * CIRCLES)), uid(1 + Math.floor(again() * USERS)), choose(ROLES));
    }
    expect(await snapshot(sqlite, USERS, CIRCLES, INVITES)).toEqual(await snapshot(memory, USERS, CIRCLES, INVITES));

    const order = Array.from({ length: USERS }, (_, i) => i + 1).sort(() => next() - 0.5);
    for (const user of order.slice(0, 1 + Math.floor(next() * USERS))) {
      await memory.removeUser(uid(user), `user${user}`);
      db.run('DELETE FROM users WHERE id = ?', uid(user));
      expect(await snapshot(sqlite, USERS, CIRCLES, INVITES), `after removing user ${user}`).toEqual(await snapshot(memory, USERS, CIRCLES, INVITES));
      for (let c = 1; c <= CIRCLES; c++) {
        const members = (await sqlite.listMembers(cid(c), { limit: 100, cursor: null })).items;
        if ((await sqlite.getCircle(cid(c))) !== undefined) expect(members.some((m) => m.role === 'owner'), `circle ${c} has an owner`).toBe(true);
        expect(members.some((m) => m.userId === uid(user))).toBe(false);
      }
    }
  });
});

describe('through the user controller', () => {
  async function setup() {
    const path = join(tmp(), 'users.db');
    const users = createSqliteUserStore({ path });
    const sessions = createSqliteSessionStore({ path });
    const circles = createSqliteCircleStore({ path });
    closers.push(() => users.close(), () => sessions.close(), () => circles.close());
    let n = 0;
    const controller = createUserController({
      users,
      sessions,
      graphAdapter: createMemoryAdapter(),
      hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }),
      loginThrottle: createLoginThrottle(),
      registrationThrottle: createRegistrationThrottle(),
      newUserId: () => uid(++n),
    });
    const PW = 'correct horse 7 staple';
    const person = async (name: string): Promise<{ id: string; token: string }> => {
      const registered = await controller.register({ username: name, displayName: name, password: PW }, { clientKey: name });
      if (!registered.ok) throw new Error(JSON.stringify(registered.error));
      const login = await controller.login({ username: name, password: PW }, { clientKey: name });
      if (!login.ok) throw new Error(JSON.stringify(login.error));
      return { id: registered.value.id, token: login.value.token };
    };
    return { circles, controller, person, PW };
  }

  it('a person deleting their own account leaves every circle, and a circle they solely owned passes on', async () => {
    const { circles, controller, person, PW } = await setup();
    const ann = await person('ann'); // user 1, the admin
    const bob = await person('bob'); // user 2
    const cat = await person('cat'); // user 3
    expect([ann.id, bob.id, cat.id]).toEqual([uid(1), uid(2), uid(3)]);
    await create(circles, 1, 2);
    await join_(circles, 1, 3, 'member', 2000);
    await join_(circles, 1, 1, 'observer', 2001);
    await invite(circles, 1, 1, 'ann', 3); // neither to him nor from him
    await invite(circles, 2, 1, 'zed', 2); // from him
    const result = await controller.deleteMe(bob.token, { password: PW }, { clientKey: 'bob' });
    expect(result.ok).toBe(true);
    expect(await rolesIn(circles, 1)).toEqual([`${uid(1)}:observer`, `${uid(3)}:owner`]);
    expect(await circles.getInvitation(iid(2))).toBeUndefined(); // the one he sent
    expect(await circles.getInvitation(iid(1))).toBeDefined(); // addressed to someone else
  });

  it('an admin deleting someone else\'s account does the same', async () => {
    const { circles, controller, person } = await setup();
    const ann = await person('ann');
    const bob = await person('bob');
    await person('cat');
    await create(circles, 1, 2);
    await create(circles, 2, 3);
    await join_(circles, 2, 2, 'manager', 2000);
    await invite(circles, 1, 2, 'bob', 3);
    const result = await controller.deleteUser(ann.token, bob.id);
    expect(result.ok).toBe(true);
    expect(await circles.getCircle(cid(1))).toBeUndefined(); // he was alone in it
    expect(await rolesIn(circles, 2)).toEqual([`${uid(3)}:owner`]);
    expect(await circles.getInvitation(iid(1))).toBeUndefined();
    expect(await circles.listCirclesOf(uid(2), { limit: 5, cursor: null })).toEqual({ items: [], nextCursor: null });
  });
});
