import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../sqlite/db.js';
import { prepareSchema } from '../../sqlite/prepare.js';
import { USERS_APPLICATION_ID, USERS_SCHEMA_VERSION } from '../../users/sqlite/index.js';
import { USERS_MIGRATIONS } from '../../users/sqlite/schema.js';
import { createMemoryCircleStore } from '../memory-store.js';
import type { CircleStore } from '../store.js';
import type { CircleRole } from '../types.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'caci-grants-'));
  dirs.push(dir);
  return dir;
};
const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };
const GRANT_LIMITS = { maxCategoriesPerGrant: 200 };
const cid = (n: number): string => `c${String(n).padStart(16, '0')}`;
const iid = (n: number | string): string => `i${String(n).padStart(16, '0')}`;
const uid = (n: number): string => `u${String(n).padStart(16, '0')}`;
const open = (path = join(tmp(), 'users.db')) => {
  const store = createSqliteCircleStore({ path });
  const db = openDb({ path });
  closers.push(() => store.close(), () => db.close());
  return { path, store, db };
};
/** A circle owned by user 1 with users 2 and 3 as members. */
async function trio(store: CircleStore, n = 1): Promise<void> {
  await store.createCircle({ id: cid(n), name: `Circle ${n}`, createdAt: 1000 }, uid(1), LIMITS);
  for (const person of [2, 3]) {
    await store.createInvitation({ id: iid(`${n}-${person}`), circleId: cid(n), username: `user${person}`, role: 'member', invitedBy: uid(1), createdAt: 1, expiresAt: 10_000_000 }, LIMITS, 1);
    await store.acceptInvitation(iid(`${n}-${person}`), uid(person), `user${person}`, 2000 + person, LIMITS);
  }
}
const grantRows = (db: ReturnType<typeof openDb>): number => Number(db.get<{ n: number }>('SELECT count(*) AS n FROM circle_grants')?.n ?? 0);

describe('the schema', () => {
  it('is at least version 5, with the table, its index and the trigger', () => {
    const { db } = open();
    expect(USERS_SCHEMA_VERSION).toBe(6);
    expect(db.pragma('user_version')).toBe(6);
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'circle_grants'")?.name).toBe('circle_grants');
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'circle_grants_by_grantee'")?.name).toBe('circle_grants_by_grantee');
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'circle_grants_end_with_member'")?.name).toBe('circle_grants_end_with_member');
  });

  it('a version 4 database is upgraded without touching its users, circles, members or invitations', async () => {
    const path = join(tmp(), 'users.db');
    const old = openDb({ path });
    prepareSchema(old, { applicationId: USERS_APPLICATION_ID, migrations: USERS_MIGRATIONS.slice(0, 4), foreignCode: 'NOT_A_USERS_DATABASE' });
    old.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, 'user1', 'One', 'admin', 'h', 1, 1)", uid(1));
    old.run("INSERT INTO circles (id, name, created_at, updated_at) VALUES (?, 'Old', 1, 1)", cid(1));
    old.run("INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 1)", cid(1), uid(1));
    old.run("INSERT INTO circle_invitations (id, circle_id, username, role, invited_by, created_at, expires_at) VALUES (?, ?, 'carol', 'member', ?, 1, 99999999)", iid(1), cid(1), uid(1));
    expect(old.pragma('user_version')).toBe(4);
    old.close();
    const { store, db } = open(path);
    expect(db.pragma('user_version')).toBe(6);
    expect((await store.getCircle(cid(1)))?.name).toBe('Old');
    expect((await store.membershipOf(cid(1), uid(1)))?.role).toBe('owner');
    expect((await store.getInvitation(iid(1)))?.username).toBe('carol');
    expect(Number(db.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n)).toBe(1);
    expect(grantRows(db)).toBe(0);
  });

  it('the database itself refuses a grant to oneself, an empty set, and something that is not JSON', async () => {
    const { store, db } = open();
    await trio(store);
    const insert = (owner: number, grantee: number, categories: string): void => void db.run('INSERT INTO circle_grants (circle_id, owner_id, grantee_id, categories, updated_at) VALUES (?, ?, ?, ?, 1)', cid(1), uid(owner), uid(grantee), categories);
    expect(() => insert(2, 2, '["a"]')).toThrow();
    expect(() => insert(2, 3, '[]')).toThrow();
    expect(() => insert(2, 3, 'not json')).toThrow();
    expect(() => insert(2, 3, '["a"]')).not.toThrow();
    expect(() => insert(2, 3, '["b"]')).toThrow(); // one row per pair
    expect(() => db.run('INSERT INTO circle_grants (circle_id, owner_id, grantee_id, categories, updated_at) VALUES (?, ?, ?, ?, 1)', cid(9), uid(2), uid(3), '["a"]')).toThrow(); // no such circle
  });
});

describe('a grant never outlives a membership, whoever removes it', () => {
  it('deleting a membership row ends the grants made or held by that person in that circle only', async () => {
    const { store, db } = open();
    await trio(store, 1);
    await trio(store, 2);
    for (const c of [1, 2]) {
      await store.setGrant(cid(c), uid(2), uid(3), ['a'], 1, GRANT_LIMITS);
      await store.setGrant(cid(c), uid(3), uid(2), ['b'], 1, GRANT_LIMITS);
      await store.setGrant(cid(c), uid(1), uid(2), ['c'], 1, GRANT_LIMITS);
    }
    db.run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', cid(1), uid(2));
    expect(await store.getGrant(cid(1), uid(2), uid(3))).toBeUndefined();
    expect(await store.getGrant(cid(1), uid(3), uid(2))).toBeUndefined();
    expect(await store.getGrant(cid(1), uid(1), uid(2))).toBeUndefined();
    expect(grantRows(db)).toBe(3); // circle 2 untouched
  });

  it('deleting the circle (even directly) ends its grants', async () => {
    const { store, db } = open();
    await trio(store, 1);
    await trio(store, 2);
    await store.setGrant(cid(1), uid(2), uid(3), ['a'], 1, GRANT_LIMITS);
    await store.setGrant(cid(2), uid(2), uid(3), ['b'], 1, GRANT_LIMITS);
    db.run('DELETE FROM circles WHERE id = ?', cid(1));
    expect(grantRows(db)).toBe(1);
    expect(await store.deleteCircle(cid(2))).toBe(true);
    expect(grantRows(db)).toBe(0);
  });

  it('deleting an account (the user-row trigger) ends its grants everywhere, including a circle it solely owned', async () => {
    const { store, db } = open();
    for (const n of [1, 2, 3]) db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, 'n', 'user', 'h', 1, 1)", uid(n), `user${n}`);
    await trio(store, 1);
    await trio(store, 2);
    await store.setGrant(cid(1), uid(1), uid(2), ['a'], 1, GRANT_LIMITS);
    await store.setGrant(cid(1), uid(2), uid(1), ['b'], 1, GRANT_LIMITS);
    await store.setGrant(cid(1), uid(2), uid(3), ['stays'], 1, GRANT_LIMITS);
    await store.setGrant(cid(2), uid(3), uid(1), ['c'], 1, GRANT_LIMITS);
    db.run('DELETE FROM users WHERE id = ?', uid(1));
    expect(grantRows(db)).toBe(1);
    expect((await store.getGrant(cid(1), uid(2), uid(3)))?.categories).toEqual(['stays']);
  });

  it('a refused or rolled-back step changes nothing', async () => {
    const { store, db } = open();
    await trio(store);
    await store.setGrant(cid(1), uid(2), uid(3), ['keep'], 1, GRANT_LIMITS);
    expect((await store.setGrant(cid(1), uid(2), uid(3), ['x', ''], 2, GRANT_LIMITS)).ok).toBe(false);
    expect((await store.setGrant(cid(1), uid(2), uid(9), ['x'], 2, GRANT_LIMITS)).ok).toBe(false);
    db.begin();
    db.run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', cid(1), uid(3));
    expect(grantRows(db)).toBe(0); // inside the transaction it is already gone
    db.rollback();
    expect((await store.getGrant(cid(1), uid(2), uid(3)))?.categories).toEqual(['keep']);
  });
});

describe('what the database keeps', () => {
  it('keeps every category id exactly, including a lone surrogate, in code-unit order', async () => {
    const { store } = open();
    await trio(store);
    const ids = ['a', String.fromCharCode(0xd800), '\u{1F600}', 'é', String.fromCharCode(0xff5e), 'Z'];
    const made = await store.setGrant(cid(1), uid(2), uid(3), ids, 1, GRANT_LIMITS);
    const expected = [...ids].sort();
    expect(made.ok && made.value?.categories).toEqual(expected);
    expect((await store.getGrant(cid(1), uid(2), uid(3)))?.categories).toEqual(expected);
  });

  it('survives closing and reopening the file', async () => {
    const { path, store } = open();
    await trio(store);
    await store.setGrant(cid(1), uid(2), uid(3), ['b', 'a'], 77, GRANT_LIMITS);
    store.close();
    const again = createSqliteCircleStore({ path });
    closers.push(() => again.close());
    expect(await again.getGrant(cid(1), uid(2), uid(3))).toEqual({ circleId: cid(1), ownerId: uid(2), granteeId: uid(3), categories: ['a', 'b'], updatedAt: 77 });
  });

  it('two stores on one file see each other\'s grants at once', async () => {
    const path = join(tmp(), 'users.db');
    const a = createSqliteCircleStore({ path });
    const b = createSqliteCircleStore({ path });
    closers.push(() => a.close(), () => b.close());
    await trio(a);
    await a.setGrant(cid(1), uid(2), uid(3), ['a'], 1, GRANT_LIMITS);
    expect((await b.getGrant(cid(1), uid(2), uid(3)))?.categories).toEqual(['a']);
    await b.removeMember(cid(1), uid(3));
    expect(await a.getGrant(cid(1), uid(2), uid(3))).toBeUndefined();
  });
});

describe('another process', () => {
  it('a process replacing a grant over and over while the person leaves: afterwards there is no grant, and later replacements are refused', async () => {
    const path = join(tmp(), 'users.db');
    const { store } = open(path);
    await trio(store);
    const child = spawn(process.execPath, ['--import', loader, join(here, 'grants-child.mjs'), path, cid(1), uid(2), uid(3), '400'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += String(c)));
    await new Promise<void>((resolve) => child.stdout.on('data', () => out.includes('started') && resolve()));
    expect((await store.removeMember(cid(1), uid(3))).ok).toBe(true);
    await new Promise((resolve) => child.on('close', resolve));
    const outcomes = JSON.parse(out.trim().split('\n').at(-1) as string) as string[];
    expect(outcomes).toHaveLength(400);
    // from the moment the person was gone, every replacement was refused: no "ok" ever follows a refusal
    const firstRefusal = outcomes.indexOf('NOT_FOUND');
    if (firstRefusal >= 0) expect(outcomes.slice(firstRefusal).every((o) => o === 'NOT_FOUND')).toBe(true);
    expect(outcomes.every((o) => o === 'ok' || o === 'NOT_FOUND')).toBe(true);
    expect(await store.getGrant(cid(1), uid(2), uid(3))).toBeUndefined();
  }, 60_000);
});

describe('the trigger and the store do the same thing, grants included', () => {
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ROLES: readonly CircleRole[] = ['owner', 'manager', 'member', 'observer'];
  const USERS = 6;
  const CIRCLES = 5;
  const CATEGORIES = ['a', 'b', 'c', 'd', 'e'];

  async function snapshot(store: CircleStore): Promise<unknown> {
    const out: Record<string, unknown> = {};
    for (let c = 1; c <= CIRCLES; c++) {
      out[`members${c}`] = (await store.listMembers(cid(c), { limit: 1000, cursor: null })).items;
      for (let u = 1; u <= USERS; u++) {
        out[`by${c}-${u}`] = (await store.listGrantsBy(cid(c), uid(u), { limit: 1000, cursor: null })).items;
        out[`to${c}-${u}`] = (await store.listGrantsTo(cid(c), uid(u), { limit: 1000, cursor: null })).items;
      }
    }
    return out;
  }

  it.each(Array.from({ length: 50 }, (_, i) => [i + 1] as const))('random circles, grants and removals, seed %i', async (seed) => {
    const { store: sqlite, db } = open();
    const memory = createMemoryCircleStore();
    for (let n = 1; n <= USERS; n++) db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, 'n', 'user', 'h', 1, 1)", uid(n), `user${n}`);
    const history: string[] = [];
    for (const store of [memory, sqlite]) {
      const again = random(seed * 104729);
      const pick = (n: number): number => 1 + Math.floor(again() * n);
      for (let c = 1; c <= CIRCLES; c++) await store.createCircle({ id: cid(c), name: `Circle ${c}`, createdAt: 1 + c }, uid(pick(USERS)), LIMITS);
      for (let i = 1; i <= 20; i++) {
        const circle = pick(CIRCLES);
        const user = pick(USERS);
        await store.createInvitation({ id: iid(i), circleId: cid(circle), username: `user${user}`, role: ROLES[pick(4) - 1] as CircleRole, invitedBy: uid(1), createdAt: 5, expiresAt: 1_000_000 }, LIMITS, 5);
        await store.acceptInvitation(iid(i), uid(user), `user${user}`, 10 + pick(5), LIMITS);
      }
      for (let k = 0; k < 30; k++) {
        const circle = pick(CIRCLES);
        const set = CATEGORIES.filter(() => again() < 0.5);
        await store.setGrant(cid(circle), uid(pick(USERS)), uid(pick(USERS)), set, 100 + k, GRANT_LIMITS);
      }
      for (let k = 0; k < 6; k++) await store.changeRole(cid(pick(CIRCLES)), uid(pick(USERS)), ROLES[pick(4) - 1] as CircleRole);
      history.push('built');
    }
    expect(await snapshot(sqlite)).toEqual(await snapshot(memory));

    const next = random(seed);
    for (let step = 0; step < 6; step++) {
      const kind = Math.floor(next() * 4);
      const circle = 1 + Math.floor(next() * CIRCLES);
      const user = 1 + Math.floor(next() * USERS);
      if (kind === 0) {
        await memory.removeMember(cid(circle), uid(user));
        await sqlite.removeMember(cid(circle), uid(user));
      } else if (kind === 1) {
        await memory.deleteCircle(cid(circle));
        await sqlite.deleteCircle(cid(circle));
      } else if (kind === 2) {
        await memory.removeUser(uid(user), `user${user}`);
        db.run('DELETE FROM users WHERE id = ?', uid(user));
      } else {
        const to = 1 + Math.floor(next() * USERS);
        await memory.setGrant(cid(circle), uid(user), uid(to), ['a', 'c'], 500 + step, GRANT_LIMITS);
        await sqlite.setGrant(cid(circle), uid(user), uid(to), ['a', 'c'], 500 + step, GRANT_LIMITS);
      }
      expect(await snapshot(sqlite), `after step ${step} (kind ${kind}, circle ${circle}, user ${user})`).toEqual(await snapshot(memory));
    }
    // and no grant is ever left between two people who are not both in the circle
    for (let c = 1; c <= CIRCLES; c++) {
      const members = new Set((await sqlite.listMembers(cid(c), { limit: 1000, cursor: null })).items.map((m) => m.userId));
      for (let u = 1; u <= USERS; u++) for (const g of (await sqlite.listGrantsBy(cid(c), uid(u), { limit: 1000, cursor: null })).items) expect(members.has(g.ownerId) && members.has(g.granteeId), `grant ${g.ownerId}->${g.granteeId} in circle ${c}`).toBe(true);
    }
  });
});
