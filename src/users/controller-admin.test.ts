import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { describeGraph, write, type StorageAdapter } from '../graph_store/index.js';
import { CTX, graphIds, must, PW, reg, T0, world, type World } from './controller.test-util.js';
import { userGraphId } from './ids.js';
import type { UserStore } from './store.js';
import type { User } from './types.js';

const NEW_PW = 'a different long passphrase 9';

async function signedIn(w: World, name: string, extra: object = {}): Promise<{ user: User; token: string }> {
  const user = await must<User>(reg(w.controller, name, extra));
  const { token } = await must<{ token: string }>(w.controller.login({ username: name, password: PW }, CTX));
  return { user, token };
}
/** admin = the first account; then two ordinary users. */
async function team(w: World) {
  return { admin: await signedIn(w, 'admin1'), ann: await signedIn(w, 'ann'), bob: await signedIn(w, 'bob') };
}

describe('listUsers', () => {
  it('lists everyone by username, a page at a time, for an admin', async () => {
    const w = world();
    const { admin } = await team(w);
    const first = await must<{ items: readonly User[]; nextCursor: string | null }>(w.controller.listUsers(admin.token, { limit: 2 }));
    expect(first.items.map((u) => u.username)).toEqual(['admin1', 'ann']);
    expect(first.nextCursor).not.toBeNull();
    const rest = await must<{ items: readonly User[]; nextCursor: string | null }>(w.controller.listUsers(admin.token, { limit: 2, cursor: first.nextCursor }));
    expect(rest.items.map((u) => u.username)).toEqual(['bob']);
    expect(rest.nextCursor).toBeNull();
  });

  it('defaults to a page of 50, and refuses limits outside 1 to 200 and bad cursors', async () => {
    const w = world();
    const { admin } = await team(w);
    expect((await must<{ items: readonly User[] }>(w.controller.listUsers(admin.token))).items).toHaveLength(3);
    for (const limit of [0, 201, 1.5, -1, '5', null, Number.NaN]) expect(await w.controller.listUsers(admin.token, { limit }), String(limit)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'limit' } });
    for (const cursor of [5, {}, ['x']]) expect(await w.controller.listUsers(admin.token, { cursor }), String(cursor)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'cursor' } });
    expect(await w.controller.listUsers(admin.token, { cursor: 'not a cursor' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'cursor' } });
  });

  it('a page is 50 by default: twelve people all come back at once', async () => {
    const w = world();
    const admin = await signedIn(w, 'admin1');
    for (let i = 0; i < 11; i++) await must(reg(w.controller, `person${String(i).padStart(2, '0')}`, {}, { clientKey: `client-${i}` }));
    const page = await must<{ items: readonly User[]; nextCursor: string | null }>(w.controller.listUsers(admin.token));
    expect(page.items).toHaveLength(12);
    expect(page.nextCursor).toBeNull();
  });

  it('is FORBIDDEN for an ordinary user, and UNAUTHENTICATED with no session', async () => {
    const w = world();
    const { ann } = await team(w);
    expect(await w.controller.listUsers(ann.token)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.controller.listUsers(undefined)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await w.controller.listUsers('A'.repeat(43))).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('never shows a hash or a token', async () => {
    const w = world();
    const { admin } = await team(w);
    const text = JSON.stringify(await w.controller.listUsers(admin.token));
    expect(text).not.toMatch(/scrypt|passwordHash|hash|token/i);
    expect(text).not.toContain(admin.token);
    expect(text).not.toContain(PW);
  });
});

describe('getUser', () => {
  it('an admin reads anyone; a user reads themselves', async () => {
    const w = world();
    const { admin, ann, bob } = await team(w);
    expect(await must<User>(w.controller.getUser(admin.token, bob.user.id))).toEqual(bob.user);
    expect(await must<User>(w.controller.getUser(ann.token, ann.user.id))).toEqual(ann.user);
    expect(await must<User>(w.controller.getUser(admin.token, admin.user.id))).toEqual(admin.user);
  });

  it('refuses a user asking about anyone else, the same way whether or not that account exists', async () => {
    const w = world();
    const { ann, bob } = await team(w);
    const real = await w.controller.getUser(ann.token, bob.user.id);
    const missing = await w.controller.getUser(ann.token, 'u9999999999999999');
    const nonsense = await w.controller.getUser(ann.token, 'not-an-id');
    expect(real).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'you may not do that' } });
    expect(missing).toEqual(real);
    expect(nonsense).toEqual(real);
    expect(await w.controller.getUser(ann.token, undefined)).toEqual(real);
  });

  it('says NOT_FOUND to an admin for a missing or malformed id', async () => {
    const w = world();
    const { admin } = await team(w);
    for (const id of ['u9999999999999999', 'nope', '', 5, null, undefined]) expect(await w.controller.getUser(admin.token, id), String(id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('never shows a hash', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    expect(JSON.stringify(await w.controller.getUser(admin.token, ann.user.id))).not.toMatch(/scrypt|passwordHash/);
  });
});

describe('updateUser', () => {
  it('an admin edits anyone\'s display name, email and role', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    w.now.value = T0 + 9000;
    const updated = await must<User>(w.controller.updateUser(admin.token, ann.user.id, { displayName: 'Ann Admin', email: 'ann@example.com', role: 'admin' }));
    expect(updated).toEqual({ ...ann.user, displayName: 'Ann Admin', email: 'ann@example.com', role: 'admin', updatedAt: T0 + 9000 });
    expect((await must<User>(w.controller.updateUser(admin.token, ann.user.id, { email: null }))).email).toBeUndefined();
  });

  it('a role change takes effect at once: the promoted user may now use admin functions on their existing session', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    expect(await w.controller.listUsers(ann.token)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'admin' }));
    expect(await w.controller.listUsers(ann.token)).toMatchObject({ ok: true });
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'user' }));
    expect(await w.controller.listUsers(ann.token)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('a user may edit their own display name and email', async () => {
    const w = world();
    const { ann } = await team(w);
    expect((await must<User>(w.controller.updateUser(ann.token, ann.user.id, { displayName: 'Ann New', email: 'a@example.com' }))).displayName).toBe('Ann New');
  });

  it('a user may never change a role, not even their own, and then NOTHING is changed (not the display name that came with it)', async () => {
    const w = world();
    const { ann } = await team(w);
    const r = await w.controller.updateUser(ann.token, ann.user.id, { displayName: 'Sneaky', role: 'admin' });
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.users.get(ann.user.id)).toEqual(ann.user);
    expect(await w.controller.updateUser(ann.token, ann.user.id, { role: 'user' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); // even to what it already is
  });

  it('a user may not edit anyone else, and learns nothing about whether they exist', async () => {
    const w = world();
    const { ann, bob } = await team(w);
    const real = await w.controller.updateUser(ann.token, bob.user.id, { displayName: 'Hacked' });
    expect(real).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.controller.updateUser(ann.token, 'u9999999999999999', { displayName: 'x' })).toEqual(real);
    expect(await w.users.get(bob.user.id)).toEqual(bob.user);
  });

  it('refuses a bad role, bad values and unknown keys, naming the field, and changes nothing', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    for (const [input, field] of [
      [{ role: 'root' }, 'role'],
      [{ role: 'ADMIN' }, 'role'],
      [{ role: 5 }, 'role'],
      [{ displayName: '' }, 'displayName'],
      [{ email: 'nope' }, 'email'],
      [{ username: 'newname' }, 'username'],
      [{ id: 'u1' }, 'id'],
      [{ password: 'x' }, 'password'],
      [{ passwordHash: 'x' }, 'passwordHash'],
    ] as const) {
      expect(await w.controller.updateUser(admin.token, ann.user.id, input as never), JSON.stringify(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field } });
    }
    expect(await w.controller.updateUser(admin.token, ann.user.id, {})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await w.users.get(ann.user.id)).toEqual(ann.user);
  });

  it('says NOT_FOUND to an admin for someone who does not exist', async () => {
    const w = world();
    const { admin } = await team(w);
    expect(await w.controller.updateUser(admin.token, 'u9999999999999999', { displayName: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await w.controller.updateUser(admin.token, 'garbage', { displayName: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('the last admin cannot be demoted, even by themselves, and the first admin can once there is another', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    expect(await w.controller.updateUser(admin.token, admin.user.id, { role: 'user' })).toMatchObject({ ok: false, error: { code: 'LAST_ADMIN' } });
    expect((await w.users.get(admin.user.id))?.role).toBe('admin');
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'admin' }));
    expect(await w.controller.updateUser(admin.token, admin.user.id, { role: 'user' })).toMatchObject({ ok: true });
    expect(await w.controller.updateUser(ann.token, ann.user.id, { role: 'user' })).toMatchObject({ ok: false, error: { code: 'LAST_ADMIN' } }); // and now ann is the last
  });

  it('of two admins demoting each other at the same moment, exactly one stays an admin', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'admin' }));
    const results = await Promise.all([w.controller.updateUser(admin.token, ann.user.id, { role: 'user' }), w.controller.updateUser(ann.token, admin.user.id, { role: 'user' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'LAST_ADMIN')).toHaveLength(1);
    const all = await w.users.list({ limit: 10, cursor: null });
    expect(all.items.filter((u) => u.role === 'admin')).toHaveLength(1);
  });
});

describe('resetPassword', () => {
  it('sets a new password that works, the old one stops, and all of that user\'s sessions end', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    const second = await must<{ token: string }>(w.controller.login({ username: 'ann', password: PW }, CTX));
    expect(await w.controller.resetPassword(admin.token, ann.user.id, { newPassword: NEW_PW })).toMatchObject({ ok: true });
    for (const t of [ann.token, second.token]) expect(await w.controller.resolve(t)).toMatchObject({ ok: false });
    expect(await w.controller.login({ username: 'ann', password: NEW_PW }, CTX)).toMatchObject({ ok: true });
    expect(await w.controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: false });
    expect(await w.controller.resolve(admin.token)).toMatchObject({ ok: true }); // the admin's own session is not touched
  });

  it('does not touch anyone else\'s sessions', async () => {
    const w = world();
    const { admin, ann, bob } = await team(w);
    await must(w.controller.resetPassword(admin.token, ann.user.id, { newPassword: NEW_PW }));
    expect(await w.controller.resolve(bob.token)).toMatchObject({ ok: true });
  });

  it('an admin resetting their own password keeps the session they are using, and ends their others', async () => {
    const w = world();
    const { admin } = await team(w);
    const other = await must<{ token: string }>(w.controller.login({ username: 'admin1', password: PW }, CTX));
    await must(w.controller.resetPassword(admin.token, admin.user.id, { newPassword: NEW_PW }));
    expect(await w.controller.resolve(admin.token)).toMatchObject({ ok: true });
    expect(await w.controller.resolve(other.token)).toMatchObject({ ok: false });
  });

  it('applies the password policy to the new password, naming newPassword, and changes nothing', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    const before = await w.users.credentialOf(ann.user.id);
    for (const bad of ['short', 'qwertyuiop12', 'ann', 5, undefined]) {
      expect(await w.controller.resetPassword(admin.token, ann.user.id, { newPassword: bad }), String(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'newPassword' } });
    }
    expect(await w.users.credentialOf(ann.user.id)).toEqual(before);
    expect(await w.controller.resolve(ann.token)).toMatchObject({ ok: true });
  });

  it('refuses a new password equal to that person\'s username', async () => {
    const w = world();
    const admin = await signedIn(w, 'admin1');
    const target = await signedIn(w, 'annsmith-account');
    expect(await w.controller.resetPassword(admin.token, target.user.id, { newPassword: 'annsmith-account' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'newPassword' } });
  });

  it('is admin only, and an ordinary user cannot even use it on themselves', async () => {
    const w = world();
    const { ann, bob } = await team(w);
    expect(await w.controller.resetPassword(ann.token, bob.user.id, { newPassword: NEW_PW })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.controller.resetPassword(ann.token, ann.user.id, { newPassword: NEW_PW })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: true });
  });

  it('says NOT_FOUND to an admin for someone who does not exist', async () => {
    const w = world();
    const { admin } = await team(w);
    expect(await w.controller.resetPassword(admin.token, 'u9999999999999999', { newPassword: NEW_PW })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('says so if the password changed but the sessions could not be ended', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    const failing = { ...w.sessions, revokeAllFor: async () => { throw new Error('boom'); } };
    const faulty = world({ reuse: { users: w.users, sessions: failing, graphs: w.graphs } });
    const r = await faulty.controller.resetPassword(admin.token, ann.user.id, { newPassword: NEW_PW });
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).toMatch(/sessions could not be ended/);
    expect(JSON.stringify(r)).not.toContain('boom');
  });

  it('never shows the old password, the new one or a hash', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    for (const out of [await w.controller.resetPassword(admin.token, ann.user.id, { newPassword: 'short' }), await w.controller.resetPassword(admin.token, ann.user.id, { newPassword: NEW_PW })]) {
      const text = JSON.stringify(out);
      for (const secret of [PW, NEW_PW, 'short']) expect(text.includes(secret) && secret !== 'short').toBe(false);
      expect(text).not.toMatch(/scrypt|passwordHash/);
    }
  });
});

describe('deleteUser', () => {
  it('an admin deletes someone else: graph, account and sessions go; everyone else stays', async () => {
    const w = world();
    const { admin, ann, bob } = await team(w);
    await must(write(w.graphs, { version: 1, kind: 'mutation', graphId: userGraphId(ann.user.id), ops: [{ op: 'upsertNode', partition: 'item', id: 'note' }] }));
    expect(await w.controller.deleteUser(admin.token, ann.user.id)).toEqual({ ok: true, value: true });
    expect(await w.users.get(ann.user.id)).toBeUndefined();
    expect(await describeGraph(w.graphs, userGraphId(ann.user.id))).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    expect(await w.sessions.resolve(ann.token, T0)).toBeUndefined();
    expect(await w.controller.resolve(bob.token)).toMatchObject({ ok: true });
    expect(await graphIds(w.graphs)).toEqual([userGraphId(admin.user.id), userGraphId(bob.user.id)].sort());
  });

  it('keeps the account, and says so, if the graph cannot be deleted', async () => {
    const inner = createMemoryAdapter();
    const stuck: StorageAdapter = { ...inner, graphs: { ...inner.graphs, drop: async () => { throw new Error('disk error with secret detail'); } } };
    const w = world({ graphs: stuck });
    const { admin, ann } = await team(w);
    const r = await w.controller.deleteUser(admin.token, ann.user.id);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).toMatch(/account was kept/);
    expect(JSON.stringify(r)).not.toContain('secret detail');
    expect(await w.users.get(ann.user.id)).toBeDefined();
    expect(await w.controller.resolve(ann.token)).toMatchObject({ ok: true });
  });

  it('is admin only; a user cannot delete anyone, themselves included, and learns nothing about who exists', async () => {
    const w = world();
    const { ann, bob } = await team(w);
    const real = await w.controller.deleteUser(ann.token, bob.user.id);
    expect(real).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.controller.deleteUser(ann.token, 'u9999999999999999')).toEqual(real);
    expect(await w.controller.deleteUser(ann.token, ann.user.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await w.users.count()).toBe(3);
  });

  it('an admin cannot delete their own account this way: deleteMe asks for the password', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'admin' }));
    expect(await w.controller.deleteUser(admin.token, admin.user.id)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'userId' } });
    expect(await w.users.get(admin.user.id)).toBeDefined();
  });

  it('says NOT_FOUND to an admin for someone who does not exist', async () => {
    const w = world();
    const { admin } = await team(w);
    for (const id of ['u9999999999999999', 'nope', undefined]) expect(await w.controller.deleteUser(admin.token, id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('of two admins deleting each other at the same moment, exactly one admin remains, with a graph, and no orphan', async () => {
    const w = world();
    const { admin, ann } = await team(w);
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'admin' }));
    const results = await Promise.all([w.controller.deleteUser(admin.token, ann.user.id), w.controller.deleteUser(ann.token, admin.user.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'LAST_ADMIN')).toHaveLength(1);
    const all = (await w.users.list({ limit: 10, cursor: null })).items;
    const admins = all.filter((u) => u.role === 'admin');
    expect(admins).toHaveLength(1);
    expect(await describeGraph(w.graphs, userGraphId((admins[0] as User).id))).toMatchObject({ ok: true }); // the survivor still has a graph
    const graphsLeft = await graphIds(w.graphs);
    expect(graphsLeft).toEqual(all.map((u) => userGraphId(u.id)).sort()); // every graph belongs to a user and every user has one
  });

  it('of eight admins all deleting the next one at the same moment, at least one admin always remains, with a graph, and no account is left without one', async () => {
    const w = world();
    const first = await signedIn(w, 'admin1');
    const crowd = [first];
    for (let i = 0; i < 7; i++) {
      const member = await signedIn(w, `crowd${i}`);
      await must(w.controller.updateUser(first.token, member.user.id, { role: 'admin' }));
      crowd.push(member);
    }
    const results = await Promise.all(crowd.map((member, i) => w.controller.deleteUser(member.token, (crowd[(i + 1) % crowd.length] as { user: User }).user.id)));
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(7); // never all eight
    const left = (await w.users.list({ limit: 50, cursor: null })).items;
    expect(left.filter((u) => u.role === 'admin').length).toBeGreaterThanOrEqual(1);
    expect(await graphIds(w.graphs)).toEqual(left.map((u) => userGraphId(u.id)).sort());
    expect(results.some((r) => !r.ok && r.error.code === 'LAST_ADMIN')).toBe(true); // the guard really was what stopped the last one
  });

  it('a demoted admin loses the power to delete at once, on the session they already have', async () => {
    const w = world();
    const { admin, ann, bob } = await team(w);
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'admin' }));
    await must(w.controller.updateUser(admin.token, ann.user.id, { role: 'user' }));
    expect(await w.controller.deleteUser(ann.token, bob.user.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('admins and the stores', () => {
  it('a store failing is STORAGE_ERROR with a fixed message', async () => {
    const w = world();
    const { admin } = await team(w);
    const broken: UserStore = { ...w.users, list: async () => { throw new Error('secret failure detail'); } };
    const faulty = world({ reuse: { users: broken, sessions: w.sessions, graphs: w.graphs } });
    const r = await faulty.controller.listUsers(admin.token);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});
