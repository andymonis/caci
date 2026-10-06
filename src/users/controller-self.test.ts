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

describe('getMe', () => {
  it('returns the caller and their graph, from the session alone', async () => {
    const w = world();
    const { user, token } = await signedIn(w, 'ann');
    expect(await w.controller.getMe(token)).toEqual({ ok: true, value: { user, graphId: userGraphId(user.id) } });
  });

  it('says UNAUTHENTICATED for anything that is not a live session', async () => {
    const w = world();
    for (const bad of [undefined, null, 5, '', 'garbage', 'A'.repeat(43)]) expect(await w.controller.getMe(bad)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('updateMe', () => {
  it('changes the display name and the email, and returns the new account', async () => {
    const w = world();
    const { user, token } = await signedIn(w, 'ann', { email: 'old@example.com' });
    w.now.value = T0 + 5000;
    const updated = await must<User>(w.controller.updateMe(token, { displayName: '  Ann Smith ', email: 'new@example.com' }));
    expect(updated).toEqual({ ...user, displayName: 'Ann Smith', email: 'new@example.com', updatedAt: T0 + 5000 });
    expect(await w.users.get(user.id)).toEqual(updated);
  });

  it('changes one field and leaves the other', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann', { email: 'keep@example.com' });
    expect((await must<User>(w.controller.updateMe(token, { displayName: 'Only Name' }))).email).toBe('keep@example.com');
    expect((await must<User>(w.controller.updateMe(token, { email: 'other@example.com' }))).displayName).toBe('Only Name');
  });

  it('removes the email with null', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann', { email: 'a@example.com' });
    const updated = await must<User>(w.controller.updateMe(token, { email: null }));
    expect('email' in updated).toBe(false);
  });

  it('refuses bad values naming the field, and changes nothing', async () => {
    const w = world();
    const { user, token } = await signedIn(w, 'ann');
    expect(await w.controller.updateMe(token, { displayName: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'displayName' } });
    expect(await w.controller.updateMe(token, { email: 'nope' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'email' } });
    expect(await w.controller.updateMe(token, { email: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'email' } });
    expect(await w.users.get(user.id)).toEqual(user);
  });

  it('refuses to change the username, the role or the id: by name, not silently', async () => {
    const w = world();
    const { user, token } = await signedIn(w, 'ann');
    for (const key of ['username', 'role', 'id', 'createdAt', 'passwordHash', 'password']) {
      const r = await w.controller.updateMe(token, { displayName: 'Sneaky', [key]: 'admin' } as never);
      expect(r, key).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: key } });
    }
    expect(await w.users.get(user.id)).toEqual(user); // not even the display name that came with them
  });

  it('refuses an empty change', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect(await w.controller.updateMe(token, {})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('needs a session', async () => {
    const w = world();
    expect(await w.controller.updateMe('A'.repeat(43), { displayName: 'X' })).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('acts only on the caller: two people each change their own account', async () => {
    const w = world();
    const ann = await signedIn(w, 'ann');
    const bob = await signedIn(w, 'bob');
    await must(w.controller.updateMe(ann.token, { displayName: 'Ann Renamed' }));
    expect((await w.users.get(bob.user.id))?.displayName).toBe('Display bob');
    expect((await w.users.get(ann.user.id))?.displayName).toBe('Ann Renamed');
  });
});

describe('changePassword', () => {
  it('needs the current password, applies the policy, and the new one works while the old one does not', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect(await w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX)).toMatchObject({ ok: true });
    expect(await w.controller.login({ username: 'ann', password: NEW_PW }, CTX)).toMatchObject({ ok: true });
    expect(await w.controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('ends every OTHER session and keeps the one it was made with', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    const other = await must<{ token: string }>(w.controller.login({ username: 'ann', password: PW }, CTX));
    const third = await must<{ token: string }>(w.controller.login({ username: 'ann', password: PW }, CTX));
    const bob = await signedIn(w, 'bob');
    await must(w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX));
    expect(await w.controller.resolve(token)).toMatchObject({ ok: true });
    expect(await w.controller.resolve(other.token)).toMatchObject({ ok: false });
    expect(await w.controller.resolve(third.token)).toMatchObject({ ok: false });
    expect(await w.controller.resolve(bob.token)).toMatchObject({ ok: true }); // other people's sessions are not touched
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const w = world();
    const { user, token } = await signedIn(w, 'ann');
    const before = await w.users.credentialOf(user.id);
    expect(await w.controller.changePassword(token, { currentPassword: 'not my password 1', newPassword: NEW_PW }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'currentPassword' } });
    expect(await w.users.credentialOf(user.id)).toEqual(before);
  });

  it('counts wrong current passwords toward the throttle, and then holds even the right one back', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    for (let i = 0; i < 5; i++) await w.controller.changePassword(token, { currentPassword: 'not my password 1', newPassword: NEW_PW }, CTX);
    const held = await w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX);
    expect(held).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
    w.now.value += 1000;
    expect(await w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX)).toMatchObject({ ok: true });
  });

  it('shares the count with login: failures at the login form hold back a password change too', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    for (let i = 0; i < 5; i++) await w.controller.login({ username: 'ann', password: 'bad password 123' }, CTX);
    expect(await w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX)).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
  });

  it('a right password clears the failures, so later mistakes start counting from nothing', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    for (let i = 0; i < 4; i++) await w.controller.changePassword(token, { currentPassword: 'not my password 1', newPassword: NEW_PW }, CTX);
    await must(w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX));
    for (let i = 0; i < 4; i++) expect(await w.controller.changePassword(token, { currentPassword: 'not my password 1', newPassword: PW }, CTX)).toMatchObject({ error: { code: 'INVALID_INPUT' } }); // not THROTTLED
  });

  it.each([
    ['too short', 'short'],
    ['a very common password', 'qwertyuiop12'],
    ['the username', 'annsmith-account'],
    ['not text', 5],
  ])('refuses a new password that is %s, naming newPassword, and changes nothing', async (_name, bad) => {
    const w = world();
    const { user, token } = await signedIn(w, 'annsmith-account');
    const before = await w.users.credentialOf(user.id);
    expect(await w.controller.changePassword(token, { currentPassword: PW, newPassword: bad }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'newPassword' } });
    expect(await w.users.credentialOf(user.id)).toEqual(before);
  });

  it('refuses the same password again', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect(await w.controller.changePassword(token, { currentPassword: PW, newPassword: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'newPassword' } });
  });

  it('refuses a current password that is not text', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect(await w.controller.changePassword(token, { currentPassword: null, newPassword: NEW_PW }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'currentPassword' } });
  });

  it('needs a session', async () => {
    const w = world();
    expect(await w.controller.changePassword(undefined, { currentPassword: PW, newPassword: NEW_PW }, CTX)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('says so if the password changed but the other sessions could not be ended', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    const failing = { ...w.sessions, revokeAllFor: async () => { throw new Error('boom'); } };
    const faulty = world({ reuse: { users: w.users, sessions: failing, graphs: w.graphs } });
    const r = await faulty.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).toMatch(/other sessions could not be ended/);
    expect(JSON.stringify(r)).not.toContain('boom');
  });

  it('never puts either password, or a hash, in any result', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    const outputs = [
      await w.controller.changePassword(token, { currentPassword: 'wrong password 123', newPassword: NEW_PW }, CTX),
      await w.controller.changePassword(token, { currentPassword: PW, newPassword: 'short' }, CTX),
      await w.controller.changePassword(token, { currentPassword: PW, newPassword: NEW_PW }, CTX),
    ];
    for (const out of outputs) {
      const text = JSON.stringify(out);
      for (const secret of [PW, NEW_PW, 'wrong password 123']) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/scrypt|passwordHash/);
    }
  });
});

describe('deleteMe', () => {
  it('needs the password, then removes the account, its sessions and its graph', async () => {
    const w = world();
    await signedIn(w, 'first'); // someone else is the admin
    const { user, token } = await signedIn(w, 'ann');
    const other = await must<{ token: string }>(w.controller.login({ username: 'ann', password: PW }, CTX));
    await must(write(w.graphs, { version: 1, kind: 'mutation', graphId: userGraphId(user.id), ops: [{ op: 'upsertNode', partition: 'item', id: 'note', data: { title: 'mine' } }] }));
    expect(await w.controller.deleteMe(token, { password: PW }, CTX)).toEqual({ ok: true, value: true });
    expect(await w.users.get(user.id)).toBeUndefined();
    expect(await w.users.getByUsername('ann')).toBeUndefined();
    expect(await describeGraph(w.graphs, userGraphId(user.id))).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    expect(await w.sessions.resolve(token, T0)).toBeUndefined(); // the sessions themselves are gone, not just refused
    expect(await w.sessions.resolve(other.token, T0)).toBeUndefined();
    for (const t of [token, other.token]) expect(await w.controller.resolve(t)).toMatchObject({ ok: false });
    expect(await w.controller.login({ username: 'ann', password: PW }, CTX)).toMatchObject({ ok: false });
  });

  it('leaves everyone else, and their graphs, alone', async () => {
    const w = world();
    const first = await signedIn(w, 'first');
    const ann = await signedIn(w, 'ann');
    const bob = await signedIn(w, 'bob');
    await w.controller.deleteMe(ann.token, { password: PW }, CTX);
    expect(await w.controller.resolve(first.token)).toMatchObject({ ok: true });
    expect(await w.controller.resolve(bob.token)).toMatchObject({ ok: true });
    expect(await graphIds(w.graphs)).toEqual([userGraphId(first.user.id), userGraphId(bob.user.id)].sort());
  });

  it('refuses a wrong password, counts it toward the throttle, and deletes nothing', async () => {
    const w = world();
    await signedIn(w, 'first');
    const { user, token } = await signedIn(w, 'ann');
    for (let i = 0; i < 5; i++) expect(await w.controller.deleteMe(token, { password: 'not my password 1' }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'password' } });
    expect(await w.controller.deleteMe(token, { password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
    expect(await w.users.get(user.id)).toBeDefined();
    expect(await describeGraph(w.graphs, userGraphId(user.id))).toMatchObject({ ok: true });
  });

  it('refuses a password that is not text', async () => {
    const w = world();
    const { token } = await signedIn(w, 'ann');
    expect(await w.controller.deleteMe(token, { password: undefined }, CTX)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'password' } });
  });

  it('needs a session', async () => {
    const w = world();
    expect(await w.controller.deleteMe(undefined, { password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('keeps the account, and says so, if the graph cannot be deleted', async () => {
    const inner = createMemoryAdapter();
    const stuck: StorageAdapter = { ...inner, graphs: { ...inner.graphs, drop: async () => { throw new Error('disk error with secret detail'); } } };
    const w = world({ graphs: stuck });
    await signedIn(w, 'first');
    const { user, token } = await signedIn(w, 'ann');
    const r = await w.controller.deleteMe(token, { password: PW }, CTX);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(JSON.stringify(r)).toMatch(/account was kept/);
    expect(JSON.stringify(r)).not.toContain('secret detail');
    expect(await w.users.get(user.id)).toBeDefined(); // not removed
    expect(await w.controller.resolve(token)).toMatchObject({ ok: true }); // still signed in
  });

  it('a missing graph does not stop the account from being deleted', async () => {
    const w = world();
    await signedIn(w, 'first');
    const { user, token } = await signedIn(w, 'ann');
    await w.graphs.graphs.drop(userGraphId(user.id));
    expect(await w.controller.deleteMe(token, { password: PW }, CTX)).toMatchObject({ ok: true });
    expect(await w.users.get(user.id)).toBeUndefined();
  });

  it('the only admin cannot delete themselves, and nothing is touched (the graph is not even dropped)', async () => {
    const w = world();
    const admin = await signedIn(w, 'ann');
    expect(admin.user.role).toBe('admin');
    await must(write(w.graphs, { version: 1, kind: 'mutation', graphId: userGraphId(admin.user.id), ops: [{ op: 'upsertNode', partition: 'item', id: 'note' }] }));
    expect(await w.controller.deleteMe(admin.token, { password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'LAST_ADMIN' } });
    expect(await w.users.get(admin.user.id)).toBeDefined();
    expect(await describeGraph(w.graphs, userGraphId(admin.user.id))).toMatchObject({ ok: true, value: { itemCount: 1 } });
    expect(await w.controller.resolve(admin.token)).toMatchObject({ ok: true });
  });

  it('an admin can delete themselves when another admin exists', async () => {
    const w = world();
    const first = await signedIn(w, 'first');
    const second = await signedIn(w, 'second');
    await must(w.users.update(second.user.id, { role: 'admin', updatedAt: T0 + 1 }));
    expect(await w.controller.deleteMe(first.token, { password: PW }, CTX)).toMatchObject({ ok: true });
    expect(await w.users.get(first.user.id)).toBeUndefined();
  });

  it('if the last admin race is lost after the graph went, the graph is given back and the refusal reported', async () => {
    const w = world();
    const first = await signedIn(w, 'first');
    const second = await signedIn(w, 'second');
    await must(w.users.update(second.user.id, { role: 'admin', updatedAt: T0 + 1 }));
    // between the check and the delete the other admin is demoted
    const racing: UserStore = {
      ...w.users,
      delete: async (id, options) => {
        await w.users.update(second.user.id, { role: 'user', updatedAt: T0 + 2 });
        return w.users.delete(id, options);
      },
    };
    const raced = world({ reuse: { users: racing, sessions: w.sessions, graphs: w.graphs } });
    expect(await raced.controller.deleteMe(first.token, { password: PW }, CTX)).toMatchObject({ ok: false, error: { code: 'LAST_ADMIN' } });
    expect(await w.users.get(first.user.id)).toBeDefined();
    expect(await describeGraph(w.graphs, userGraphId(first.user.id))).toMatchObject({ ok: true }); // an empty graph again
  });

  it('never puts the password in a result', async () => {
    const w = world();
    await signedIn(w, 'first');
    const { token } = await signedIn(w, 'ann');
    for (const out of [await w.controller.deleteMe(token, { password: 'wrong password 123' }, CTX), await w.controller.deleteMe(token, { password: PW }, CTX)]) {
      expect(JSON.stringify(out)).not.toContain('wrong password 123');
      expect(JSON.stringify(out)).not.toContain(PW);
    }
  });
});
