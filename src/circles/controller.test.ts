import { describe, expect, it } from 'vitest';
import { createCircleController } from './controller.js';
import { createMemoryCircleStore } from './memory-store.js';
import type { CircleStore } from './store.js';
import { addMember, code, must, T0, world } from './controller.test-util.js';

const ann = 'tok-ann';
const bob = 'tok-bob';
const cat = 'tok-cat';

describe('creating a circle', () => {
  it('makes the caller its owner, with the name and description given', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: '  Book club ', description: 'Every second Tuesday' }));
    expect(made).toEqual({ id: made.id, name: 'Book club', description: 'Every second Tuesday', createdAt: T0, updatedAt: T0, role: 'owner', memberCount: 1 });
    expect(made.id).toMatch(/^c[a-z0-9]{16}$/);
    expect(await w.store.membershipOf(made.id, w.id('ann'))).toMatchObject({ role: 'owner', joinedAt: T0 });
    expect(Object.isFrozen(made)).toBe(true);
  });

  it('a circle without a description has no description key', async () => {
    const made = await must(world().controller.create(ann, { name: 'Plain' }));
    expect('description' in made).toBe(false);
  });

  it('an id, an owner or any other field in the input is refused by name, and nothing is made', async () => {
    const w = world();
    for (const field of ['id', 'owner', 'role', 'members', 'createdAt', 'userId']) {
      const result = await w.controller.create(ann, { name: 'x', [field]: 'y' });
      expect(result.ok ? 'ok' : result.error, field).toMatchObject({ code: 'INVALID_INPUT', field });
    }
    expect((await must(w.controller.list(ann))).items).toEqual([]);
  });

  it('bad names and descriptions are INVALID_INPUT naming the field', async () => {
    const w = world();
    expect(await w.controller.create(ann, { name: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'name' } });
    expect(await w.controller.create(ann, { name: 'x'.repeat(81) })).toMatchObject({ error: { field: 'name' } });
    expect(await w.controller.create(ann, { name: 'x', description: 5 })).toMatchObject({ error: { field: 'description' } });
    for (const input of [null, undefined, 'x', 5, []]) expect(await w.controller.create(ann, input)).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'body' } });
  });

  it('is refused without a session, and the circle store is never touched', async () => {
    const w = world();
    const first = await w.controller.create('nonsense', { name: 'x' });
    expect(first).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    for (const token of [undefined, null, '', 5, {}, 'tok-nobody']) expect(await w.controller.create(token, { name: 'x' })).toEqual(first);
    expect(await w.store.listCirclesOf(w.id('ann'), { limit: 5, cursor: null })).toEqual({ items: [], nextCursor: null });
  });

  it('a person may be in at most 20 circles, and the limit can be set', async () => {
    const w = world({ limits: { maxCirclesPerUser: 3 } });
    for (let i = 0; i < 3; i++) await must(w.controller.create(ann, { name: `c${i}` }));
    expect(await w.controller.create(ann, { name: 'one too many' })).toMatchObject({ ok: false, error: { code: 'LIMIT_REACHED' } });
    await must(w.controller.create(bob, { name: 'someone else is not affected' }));
    const dflt = world();
    for (let i = 0; i < 20; i++) await must(dflt.controller.create(ann, { name: `c${i}` }));
    expect(await code(dflt.controller.create(ann, { name: 'twenty-first' }))).toBe('LIMIT_REACHED');
  });

  it('a circle joined through an invitation counts toward the limit too', async () => {
    const w = world({ limits: { maxCirclesPerUser: 2 } });
    const a = await must(w.controller.create(ann, { name: 'a' }));
    await must(w.controller.create(bob, { name: 'b1' }));
    await addMember(w, a.id, 'bob', 'member');
    expect(await code(w.controller.create(bob, { name: 'b2' }))).toBe('LIMIT_REACHED');
  });

  it('draws a new id if the one it made is taken, and gives up after three tries', async () => {
    let n = 0;
    const ids = ['c0000000000000001', 'c0000000000000001', 'c0000000000000002'];
    const w = world({ newCircleId: () => ids[n++] as string });
    const first = await must(w.controller.create(ann, { name: 'first' }));
    const second = await must(w.controller.create(bob, { name: 'second' }));
    expect([first.id, second.id]).toEqual(['c0000000000000001', 'c0000000000000002']);
    let drawn = 0;
    const stuck = world({ newCircleId: () => (drawn++, 'c0000000000000009') });
    await must(stuck.controller.create(ann, { name: 'x' }));
    drawn = 0;
    expect(await code(stuck.controller.create(bob, { name: 'y' }))).toBe('STORAGE_ERROR');
    expect(drawn).toBe(3);
  });
});

describe('seeing circles', () => {
  it('a member sees a circle with their own role and the number of people', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    await addMember(w, made.id, 'bob', 'manager');
    await addMember(w, made.id, 'cat', 'observer');
    expect(await must(w.controller.get(ann, made.id))).toMatchObject({ id: made.id, name: 'Team', role: 'owner', memberCount: 3 });
    expect(await must(w.controller.get(bob, made.id))).toMatchObject({ role: 'manager', memberCount: 3 });
    expect(await must(w.controller.get(cat, made.id))).toMatchObject({ role: 'observer' });
  });

  it('a stranger, a made-up id, a malformed id and a non-text id all get exactly the same answer', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Private' }));
    const missing = await w.controller.get(ann, 'c0000000000000000');
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } });
    for (const id of [made.id, 'nonsense', '', 'c', made.id.toUpperCase(), ` ${made.id}`, 5, null, undefined, {}, ['x']]) {
      const answer = await w.controller.get(bob, id);
      expect(answer, String(id)).toEqual(missing);
    }
    expect((await w.controller.get(ann, made.id)).ok).toBe(true);
  });

  it('an id that is not text is turned away before the store is asked anything', async () => {
    const base = createMemoryCircleStore();
    let asked = 0;
    const store: CircleStore = { ...base, membershipOf: async (...args) => (asked++, base.membershipOf(...args)) };
    const w = world({ store });
    for (const id of [5, null, undefined, {}, ['x'], '', true]) await w.controller.get(ann, id);
    expect(asked).toBe(0);
    await w.controller.get(ann, 'c0000000000000001');
    expect(asked).toBe(1);
  });

  it('the answer for a stranger is the same for every method that takes a circle', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Private' }));
    const calls = [
      () => w.controller.get(bob, made.id),
      () => w.controller.update(bob, made.id, { name: 'x' }),
      () => w.controller.delete(bob, made.id),
      () => w.controller.members(bob, made.id),
      () => w.controller.leave(bob, made.id),
    ];
    const answers = await Promise.all(calls.map((c) => c()));
    for (const a of answers) expect(a).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } });
    expect((await w.store.getCircle(made.id))?.name).toBe('Private');
  });

  it('lists only my circles, by id, a page at a time, with my role in each', async () => {
    const w = world({ limits: { maxCirclesPerUser: 100 } });
    const mine: string[] = [];
    for (let i = 0; i < 7; i++) mine.push((await must(w.controller.create(ann, { name: `a${i}` }))).id);
    const his = await must(w.controller.create(bob, { name: 'bob own' }));
    await addMember(w, mine[2] as string, 'bob', 'observer');
    const all: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: { readonly items: readonly { id: string }[]; nextCursor: string | null } = await must(w.controller.list(ann, { limit: 3, cursor }));
      all.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(all).toEqual([...mine].sort());
    expect(all).not.toContain(his.id);
    const bobs = await must(w.controller.list(bob));
    expect(bobs.items.map((c) => [c.id, c.role]).sort()).toEqual([[his.id, 'owner'], [mine[2], 'observer']].sort());
    expect(await must(w.controller.list(cat))).toEqual({ items: [], nextCursor: null });
  });

  it('a page is 50 by default and 100 at most; bad limits and cursors are INVALID_INPUT naming the field', async () => {
    const w = world({ limits: { maxCirclesPerUser: 100 } });
    for (let i = 0; i < 55; i++) await must(w.controller.create(ann, { name: `c${i}` }));
    const first = await must(w.controller.list(ann));
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect((await must(w.controller.list(ann, { cursor: first.nextCursor }))).items).toHaveLength(5);
    expect((await must(w.controller.list(ann, { limit: 100 }))).items).toHaveLength(55);
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(await w.controller.list(ann, { limit }), String(limit)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'limit' } });
    for (const cursor of ['nonsense', 'kYR', ' kYQ']) expect(await w.controller.list(ann, { cursor }), cursor).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'cursor' } });
    expect(await w.controller.list(ann, { cursor: 5 as never })).toMatchObject({ error: { field: 'cursor' } });
  });
});

describe('editing a circle', () => {
  it('owners and managers rename it and change its description; the time changes, the creation time does not', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Old', description: 'old text' }));
    await addMember(w, made.id, 'bob', 'manager');
    w.now.value = T0 + 5000;
    expect(await must(w.controller.update(ann, made.id, { name: 'New' }))).toMatchObject({ name: 'New', description: 'old text', createdAt: T0, updatedAt: T0 + 5000, role: 'owner', memberCount: 2 });
    expect(await must(w.controller.update(bob, made.id, { description: 'by the manager' }))).toMatchObject({ name: 'New', description: 'by the manager', role: 'manager' });
    const cleared = await must(w.controller.update(ann, made.id, { description: null }));
    expect('description' in cleared).toBe(false);
  });

  it('members and observers are FORBIDDEN, even for a valid change, and nothing changes', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Keep' }));
    await addMember(w, made.id, 'bob', 'member');
    await addMember(w, made.id, 'cat', 'observer');
    for (const token of [bob, cat]) expect(await w.controller.update(token, made.id, { name: 'Changed' })).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' } });
    expect((await w.store.getCircle(made.id))?.name).toBe('Keep');
  });

  it('permission is decided before the input is looked at: a member sending nonsense is FORBIDDEN, an owner sending nonsense is INVALID_INPUT', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'x' }));
    await addMember(w, made.id, 'bob', 'member');
    expect(await code(w.controller.update(bob, made.id, { bogus: 1 }))).toBe('FORBIDDEN');
    expect(await w.controller.update(ann, made.id, { bogus: 1 })).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'bogus' } });
    expect(await w.controller.update(ann, made.id, {})).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'body' } });
    expect(await w.controller.update(ann, made.id, { name: '' })).toMatchObject({ error: { field: 'name' } });
    expect(await w.controller.update(ann, made.id, { id: 'c0000000000000009', name: 'x' })).toMatchObject({ error: { field: 'id' } });
  });

  it('the role is read on every request: a demoted manager loses the power at once', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'x' }));
    await addMember(w, made.id, 'bob', 'manager');
    await must(w.controller.update(bob, made.id, { name: 'ok' }));
    await w.store.changeRole(made.id, w.id('bob'), 'observer');
    expect(await code(w.controller.update(bob, made.id, { name: 'still?' }))).toBe('FORBIDDEN');
  });
});

describe('deleting a circle', () => {
  it('only an owner can, and it takes the members and invitations with it', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Gone' }));
    await addMember(w, made.id, 'bob', 'manager');
    await addMember(w, made.id, 'cat', 'member');
    await w.store.createInvitation({ id: 'i9999999999999999', circleId: made.id, username: 'dan', role: 'member', invitedBy: w.id('ann'), createdAt: T0, expiresAt: T0 + 1e9 }, { maxOpenInvitationsPerCircle: 10 }, T0);
    for (const token of [bob, cat]) expect(await code(w.controller.delete(token, made.id))).toBe('FORBIDDEN');
    expect(await w.store.getCircle(made.id)).toBeDefined();
    expect(await must(w.controller.delete(ann, made.id))).toBe(true);
    expect(await w.store.getCircle(made.id)).toBeUndefined();
    expect(await w.store.getInvitation('i9999999999999999')).toBeUndefined();
    for (const token of [ann, bob, cat]) expect(await code(w.controller.get(token, made.id))).toBe('NOT_FOUND');
    expect((await must(w.controller.list(bob))).items).toEqual([]);
  });

  it('a second owner can delete it too, and deleting twice is NOT_FOUND the second time', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'x' }));
    await addMember(w, made.id, 'bob', 'owner');
    expect(await must(w.controller.delete(bob, made.id))).toBe(true);
    expect(await code(w.controller.delete(ann, made.id))).toBe('NOT_FOUND');
  });

  it('other circles are untouched', async () => {
    const w = world();
    const one = await must(w.controller.create(ann, { name: 'one' }));
    const two = await must(w.controller.create(ann, { name: 'two' }));
    await must(w.controller.delete(ann, one.id));
    expect((await must(w.controller.list(ann))).items.map((c) => c.id)).toEqual([two.id]);
  });
});

describe('the roster', () => {
  it('shows who is in the circle by user id with a username, a display name, a role and when they joined, and nothing private', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    await addMember(w, made.id, 'cat', 'observer', T0 + 20);
    await addMember(w, made.id, 'bob', 'manager', T0 + 10);
    const roster = await must(w.controller.members(cat, made.id));
    expect(roster.items).toEqual([
      { userId: w.id('ann'), username: 'ann', displayName: 'DISPLAY ANN', role: 'owner', joinedAt: T0 },
      { userId: w.id('bob'), username: 'bob', displayName: 'DISPLAY BOB', role: 'manager', joinedAt: T0 + 10 },
      { userId: w.id('cat'), username: 'cat', displayName: 'DISPLAY CAT', role: 'observer', joinedAt: T0 + 20 },
    ]);
    expect(roster.nextCursor).toBeNull();
    const text = JSON.stringify(roster);
    for (const secret of ['email', 'example.com', 'password', 'hash', 'graphId', 'user-u', 'token']) expect(text).not.toContain(secret);
  });

  it('pages, and refuses bad limits and cursors by name', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    for (const name of ['bob', 'cat', 'dan', 'eve']) await addMember(w, made.id, name, 'member');
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: { readonly items: readonly { username?: string }[]; nextCursor: string | null } = await must(w.controller.members(ann, made.id, { limit: 2, cursor }));
      seen.push(...page.items.map((m) => m.username as string));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['ann', 'bob', 'cat', 'dan', 'eve']);
    expect(await w.controller.members(ann, made.id, { limit: 0 })).toMatchObject({ error: { field: 'limit' } });
    expect(await w.controller.members(ann, made.id, { cursor: 'bad' })).toMatchObject({ error: { field: 'cursor' } });
  });

  it('every role can see it; a stranger cannot', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    for (const [name, role] of [['bob', 'manager'], ['cat', 'member'], ['dan', 'observer']] as const) await addMember(w, made.id, name, role);
    for (const token of [ann, bob, cat, 'tok-dan']) expect((await must(w.controller.members(token, made.id))).items).toHaveLength(4);
    expect(await code(w.controller.members('tok-eve', made.id))).toBe('NOT_FOUND');
  });

  it('a member whose account the directory no longer knows is still listed, by id, without names', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    await addMember(w, made.id, 'bob', 'member');
    const bobId = w.id('bob');
    w.forget('bob');
    const roster = await must(w.controller.members(ann, made.id));
    expect(roster.items[1]).toEqual({ userId: bobId, role: 'member', joinedAt: T0 + 1 });
  });
});

describe('leaving', () => {
  it('anyone may leave, and then the circle is gone for them', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    for (const [name, role] of [['bob', 'manager'], ['cat', 'member'], ['dan', 'observer']] as const) await addMember(w, made.id, name, role);
    for (const token of [bob, cat, 'tok-dan']) {
      expect(await must(w.controller.leave(token, made.id))).toBe(true);
      expect(await code(w.controller.get(token, made.id))).toBe('NOT_FOUND');
      expect(await code(w.controller.leave(token, made.id))).toBe('NOT_FOUND');
    }
    expect((await must(w.controller.members(ann, made.id))).items).toHaveLength(1);
  });

  it('the only owner cannot, and is told how to; with a second owner they can', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'Team' }));
    await addMember(w, made.id, 'bob', 'member');
    const refused = await w.controller.leave(ann, made.id);
    expect(refused).toEqual({ ok: false, error: { code: 'LAST_OWNER', message: 'you are the only owner: make someone else an owner, or delete the circle' } });
    expect(await w.store.membershipOf(made.id, w.id('ann'))).toBeDefined();
    await w.store.changeRole(made.id, w.id('bob'), 'owner');
    expect(await must(w.controller.leave(ann, made.id))).toBe(true);
    expect(await w.store.membershipOf(made.id, w.id('ann'))).toBeUndefined();
  });

  it('leaving frees a place toward the 20 circles', async () => {
    const w = world({ limits: { maxCirclesPerUser: 1 } });
    const made = await must(w.controller.create(ann, { name: 'x' }));
    await addMember(w, made.id, 'bob', 'member');
    expect(await code(w.controller.create(bob, { name: 'y' }))).toBe('LIMIT_REACHED');
    await must(w.controller.leave(bob, made.id));
    await must(w.controller.create(bob, { name: 'y' }));
  });
});

describe('sessions and failures', () => {
  it('every method needs a session and gives the same answer for every kind of bad one, without touching the store', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'x' }));
    const bad = await w.controller.get('tok-nobody', made.id);
    expect(bad).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    for (const token of ['', undefined, 5, 'garbage']) {
      expect(await w.controller.create(token, { name: 'x' })).toEqual(bad);
      expect(await w.controller.get(token, made.id)).toEqual(bad);
      expect(await w.controller.list(token)).toEqual(bad);
      expect(await w.controller.update(token, made.id, { name: 'y' })).toEqual(bad);
      expect(await w.controller.delete(token, made.id)).toEqual(bad);
      expect(await w.controller.members(token, made.id)).toEqual(bad);
      expect(await w.controller.leave(token, made.id)).toEqual(bad);
    }
    expect((await w.store.getCircle(made.id))?.name).toBe('x');
  });

  it('a person whose account has gone loses access at once', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'x' }));
    await addMember(w, made.id, 'bob', 'member');
    w.forget('bob');
    expect(await code(w.controller.get(bob, made.id))).toBe('UNAUTHENTICATED');
  });

  it('only the user id of the session is used: nothing else about the person reaches the store', async () => {
    const w = world();
    const made = await must(w.controller.create(ann, { name: 'x' }));
    expect(await w.store.membershipOf(made.id, w.id('ann'))).toEqual({ circleId: made.id, userId: w.id('ann'), role: 'owner', joinedAt: T0 });
  });

  it('a failing store is STORAGE_ERROR with a fixed message that never repeats what it said', async () => {
    const base = createMemoryCircleStore();
    const broken = (pick: string): CircleStore => new Proxy(base, { get: (target, key) => (key === pick ? async () => { throw new Error('secret path /var/db/users.db'); } : (target as never)[key]) });
    const calls: Array<[string, (c: ReturnType<typeof world>['controller'], id: string) => Promise<unknown>]> = [
      ['membershipOf', (c, id) => c.get(ann, id)],
      ['listCirclesOf', (c) => c.list(ann)],
      ['createCircle', (c) => c.create(ann, { name: 'y' })],
      ['updateCircle', (c, id) => c.update(ann, id, { name: 'y' })],
      ['deleteCircle', (c, id) => c.delete(ann, id)],
      ['listMembers', (c, id) => c.members(ann, id)],
      ['removeMember', (c, id) => c.leave(ann, id)],
    ];
    for (const [method, call] of calls) {
      const ok = world({ store: base });
      const made = await must(ok.controller.create(ann, { name: 'x' }));
      const w = world({ store: broken(method) });
      const result = (await call(w.controller, made.id)) as { ok: boolean; error?: { code: string; message: string } };
      expect(result.ok, method).toBe(false);
      expect(result.error, method).toEqual({ code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' });
    }
  });

  it('a store that reports a storage error in its own words is still answered with the fixed message', async () => {
    const base = createMemoryCircleStore();
    const store: CircleStore = { ...base, createCircle: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'database is locked at /var/db/users.db' } }) };
    const w = world({ store });
    expect(await w.controller.create(ann, { name: 'x' })).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
  });

  it('a session check that throws, or fails in its own way, is STORAGE_ERROR, and says nothing of why', async () => {
    const store = createMemoryCircleStore();
    const throwing = createCircleController({ users: { resolve: async () => { throw new Error('secret'); } }, directory: { get: async () => undefined }, store });
    expect(await throwing.get(ann, 'c0000000000000001')).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
    const failing = createCircleController({ users: { resolve: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'secret' } }) as never }, directory: { get: async () => undefined }, store });
    expect(await failing.list(ann)).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
  });

  it('is built from a user controller, a directory and a store, and nonsense settings are refused with a TypeError', () => {
    const store = createMemoryCircleStore();
    const users = { resolve: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: '' } }) as never };
    const directory = { get: async () => undefined };
    expect(() => createCircleController({ users, directory, store })).not.toThrow();
    expect(() => createCircleController({ directory, store } as never)).toThrow(TypeError);
    expect(() => createCircleController({ users, store } as never)).toThrow(TypeError);
    expect(() => createCircleController({ users, directory } as never)).toThrow(TypeError);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => createCircleController({ users, directory, store, limits: { maxCirclesPerUser: bad } })).toThrow(TypeError);
  });

  it('two people creating circles at the same moment each get their own, and none is shared', async () => {
    const w = world();
    const made = await Promise.all(['ann', 'bob', 'cat', 'dan'].map((name) => must(w.controller.create(`tok-${name}`, { name: `${name}'s` }))));
    expect(new Set(made.map((c) => c.id)).size).toBe(4);
    for (const [index, name] of ['ann', 'bob', 'cat', 'dan'].entries()) expect((await must(w.controller.list(`tok-${name}`))).items.map((c) => c.id)).toEqual([made[index]?.id]);
  });
});
