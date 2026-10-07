import { describe, expect, it } from 'vitest';
import { createMemoryCircleStore } from './memory-store.js';
import type { CircleStore } from './store.js';
import type { CircleRole } from './types.js';
import { addMember, code, must, T0, world } from './controller.test-util.js';

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' } };
const ROLES: readonly CircleRole[] = ['owner', 'manager', 'member', 'observer'];
const NAMES = ['ann', 'bob', 'cat', 'dan'] as const; // ann owner, bob manager, cat member, dan observer
const token = (name: string): string => `tok-${name}`;

async function team(extra: Parameters<typeof world>[0] = {}) {
  const w = world(extra);
  const made = await must(w.controller.create(token('ann'), { name: 'Team' }));
  await addMember(w, made.id, 'bob', 'manager', T0 + 1);
  await addMember(w, made.id, 'cat', 'member', T0 + 2);
  await addMember(w, made.id, 'dan', 'observer', T0 + 3);
  return { w, id: made.id };
}
const roleOf = async (w: ReturnType<typeof world>, id: string, name: string): Promise<CircleRole | undefined> => (await w.store.membershipOf(id, w.id(name)))?.role;
const roster = async (w: ReturnType<typeof world>, id: string): Promise<string[]> => (await w.store.listMembers(id, { limit: 100, cursor: null })).items.map((m) => `${m.userId.slice(-2)}:${m.role}`);

describe('changing a role', () => {
  it('an owner may give anyone else any role, and the answer shows the person as the roster does', async () => {
    for (const target of ['bob', 'cat', 'dan'] as const) {
      for (const role of ROLES) {
        const { w, id } = await team();
        const result = await must(w.controller.changeRole(token('ann'), id, w.id(target), { role }));
        expect(result, `${target} -> ${role}`).toEqual({ userId: w.id(target), username: target, displayName: `DISPLAY ${target.toUpperCase()}`, role, joinedAt: T0 + ['bob', 'cat', 'dan'].indexOf(target) + 1 });
        expect(await roleOf(w, id, target)).toBe(role);
        expect(Object.isFrozen(result)).toBe(true);
      }
    }
  });

  it('a manager only moves members and observers between those two roles', async () => {
    const { w, id } = await team();
    expect((await must(w.controller.changeRole(token('bob'), id, w.id('cat'), { role: 'observer' }))).role).toBe('observer');
    expect((await must(w.controller.changeRole(token('bob'), id, w.id('dan'), { role: 'member' }))).role).toBe('member');
    expect((await must(w.controller.changeRole(token('bob'), id, w.id('cat'), { role: 'observer' }))).role).toBe('observer'); // no change is fine
    for (const role of ['manager', 'owner'] as const) {
      for (const target of ['cat', 'dan']) expect(await w.controller.changeRole(token('bob'), id, w.id(target), { role }), `${target} -> ${role}`).toEqual(FORBIDDEN);
    }
    for (const role of ROLES) expect(await w.controller.changeRole(token('bob'), id, w.id('ann'), { role }), `owner -> ${role}`).toEqual(FORBIDDEN);
    expect(await roleOf(w, id, 'ann')).toBe('owner');
    const second = await w.store.changeRole(id, w.id('dan'), 'manager'); // another manager, put there by the store
    expect(second.ok).toBe(true);
    for (const role of ROLES) expect(await w.controller.changeRole(token('bob'), id, w.id('dan'), { role }), `manager -> ${role}`).toEqual(FORBIDDEN);
  });

  it('members and observers cannot change a role, and permission comes before the input is looked at', async () => {
    const { w, id } = await team();
    for (const name of ['cat', 'dan']) {
      expect(await w.controller.changeRole(token(name), id, w.id('bob'), { role: 'observer' })).toEqual(FORBIDDEN);
      expect(await w.controller.changeRole(token(name), id, 'nobody', { garbage: 1 })).toEqual(FORBIDDEN);
      expect(await w.controller.changeRole(token(name), id, w.id(name), undefined)).toEqual(FORBIDDEN);
    }
    expect(await roster(w, id)).toEqual(['01:owner', '02:manager', '03:member', '04:observer']);
  });

  it('nobody changes their own role, upward or downward, not even an owner or a manager', async () => {
    const { w, id } = await team();
    for (const name of NAMES) {
      for (const role of ROLES) {
        const result = await w.controller.changeRole(token(name), id, w.id(name), { role });
        expect(result.ok, `${name} -> ${role}`).toBe(false);
        expect((result as { error: { code: string } }).error.code).toBe('FORBIDDEN');
      }
    }
    const own = (await w.controller.changeRole(token('ann'), id, w.id('ann'), { role: 'member' })) as { error: { message: string } };
    expect(own.error.message).toBe('nobody changes their own role: ask another owner');
    expect(await roster(w, id)).toEqual(['01:owner', '02:manager', '03:member', '04:observer']);
  });

  it('a stranger gets the answer for a circle that does not exist', async () => {
    const { w, id } = await team();
    const missing = await w.controller.changeRole(token('ann'), 'c0000000000000000', w.id('bob'), { role: 'member' });
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } });
    expect(await w.controller.changeRole(token('eve'), id, w.id('bob'), { role: 'member' })).toEqual(missing);
    expect(await w.controller.changeRole(token('eve'), id, w.id('bob'), { garbage: 1 })).toEqual(missing);
  });

  it('someone who is not in the circle, a made-up id and a non-text id are "no such member", and non-text ids never reach the store', async () => {
    const base = createMemoryCircleStore();
    const asked: unknown[] = [];
    const store: CircleStore = { ...base, membershipOf: async (...a) => (asked.push(a[1]), base.membershipOf(...a)), changeRole: async (...a) => (asked.push(a[1]), base.changeRole(...a)) };
    const { w, id } = await team({ store });
    const missing = { ok: false, error: { code: 'NOT_FOUND', message: 'no such member' } };
    expect(await w.controller.changeRole(token('ann'), id, w.id('eve'), { role: 'member' })).toEqual(missing);
    expect(await w.controller.changeRole(token('ann'), id, 'u0000000000000099', { role: 'member' })).toEqual(missing);
    asked.length = 0;
    for (const bad of [5, null, undefined, '', {}, ['x']]) expect(await w.controller.changeRole(token('ann'), id, bad, { role: 'member' }), String(bad)).toEqual(missing);
    expect(asked.filter((id) => id !== w.id('ann'))).toEqual([]); // only the caller's own place was looked up
  });

  it('bad input is INVALID_INPUT naming the field, and any other field is refused by name', async () => {
    const { w, id } = await team();
    expect(await w.controller.changeRole(token('ann'), id, w.id('cat'), {})).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'role' } });
    expect(await w.controller.changeRole(token('ann'), id, w.id('cat'), { role: 'admin' })).toMatchObject({ error: { field: 'role' } });
    expect(await w.controller.changeRole(token('ann'), id, w.id('cat'), { role: 5 })).toMatchObject({ error: { field: 'role' } });
    for (const field of ['userId', 'circleId', 'joinedAt', 'name']) expect(await w.controller.changeRole(token('ann'), id, w.id('cat'), { role: 'observer', [field]: 'x' })).toMatchObject({ error: { field } });
    for (const bad of [null, undefined, 'owner', []]) expect(await w.controller.changeRole(token('ann'), id, w.id('cat'), bad)).toMatchObject({ error: { field: 'body' } });
    expect(await roleOf(w, id, 'cat')).toBe('member');
  });

  it('the input is looked at before the person, and the person before the table', async () => {
    const { w, id } = await team();
    expect(await w.controller.changeRole(token('ann'), id, w.id('eve'), { role: 'nonsense' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await w.controller.changeRole(token('bob'), id, w.id('eve'), { role: 'owner' })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such member' } });
  });

  it('needs a session', async () => {
    const { w, id } = await team();
    expect(await w.controller.changeRole('nonsense', id, w.id('cat'), { role: 'member' })).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });

  it('is read afresh each time: a manager who has been demoted loses the power at once, and a member who has been promoted gains it', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('bob'), id, w.id('cat'), { role: 'observer' }));
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'member' }));
    expect(await w.controller.changeRole(token('bob'), id, w.id('cat'), { role: 'member' })).toEqual(FORBIDDEN);
    await must(w.controller.changeRole(token('ann'), id, w.id('cat'), { role: 'manager' }));
    expect((await must(w.controller.changeRole(token('cat'), id, w.id('dan'), { role: 'member' }))).role).toBe('member');
  });

  it('an owner can make another person an owner, and then that person can demote the first', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'owner' }));
    expect((await must(w.controller.changeRole(token('bob'), id, w.id('ann'), { role: 'observer' }))).role).toBe('observer');
    expect(await roleOf(w, id, 'bob')).toBe('owner');
    expect(await code(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'member' }))).toBe('FORBIDDEN'); // no longer an owner
  });

  it('two owners demoting each other at the same moment: one succeeds, the other is told the circle must keep an owner, and one owner remains', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'owner' }));
    const results = await Promise.all([w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'member' }), w.controller.changeRole(token('bob'), id, w.id('ann'), { role: 'member' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok) as { error: { code: string; message: string } };
    expect(refused.error).toEqual({ code: 'LAST_OWNER', message: 'a circle must keep an owner: make someone else an owner first, or delete the circle' });
    expect((await roster(w, id)).filter((r) => r.endsWith('owner'))).toHaveLength(1);
  });

  it('a failing store is STORAGE_ERROR with a fixed message', async () => {
    const base = createMemoryCircleStore();
    const broken = (pick: string) => new Proxy(base, { get: (target, key) => (key === pick ? async () => { throw new Error('secret path'); } : (target as never)[key]) });
    for (const method of ['membershipOf', 'changeRole']) {
      const ok = world({ store: base });
      const made = await must(ok.controller.create(token('ann'), { name: 'x' }));
      await addMember(ok, made.id, 'bob', 'member');
      const w = world({ store: broken(method) });
      expect(await w.controller.changeRole(token('ann'), made.id, w.id('bob'), { role: 'member' }), method).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
    }
  });
});

describe('removing someone', () => {
  it('an owner removes anyone else; the person loses the circle at once and a place is freed', async () => {
    const { w, id } = await team({ limits: { maxCirclesPerUser: 1 } });
    for (const name of ['bob', 'cat', 'dan']) {
      expect(await must(w.controller.removeMember(token('ann'), id, w.id(name)))).toBe(true);
      expect(await code(w.controller.get(token(name), id))).toBe('NOT_FOUND');
      expect(await w.store.membershipOf(id, w.id(name))).toBeUndefined();
      await must(w.controller.create(token(name), { name: `${name}'s own` })); // their place is free again
    }
    expect(await roster(w, id)).toEqual(['01:owner']);
  });

  it('a manager removes members and observers, and nobody else', async () => {
    const { w, id } = await team();
    expect(await w.controller.removeMember(token('bob'), id, w.id('ann'))).toEqual(FORBIDDEN);
    await w.store.changeRole(id, w.id('dan'), 'manager');
    expect(await w.controller.removeMember(token('bob'), id, w.id('dan'))).toEqual(FORBIDDEN);
    expect(await must(w.controller.removeMember(token('bob'), id, w.id('cat')))).toBe(true);
    expect(await roster(w, id)).toEqual(['01:owner', '02:manager', '04:manager']);
    await w.store.changeRole(id, w.id('dan'), 'observer');
    expect(await must(w.controller.removeMember(token('bob'), id, w.id('dan')))).toBe(true);
  });

  it('members and observers cannot remove anyone, and a made-up id does not change that answer', async () => {
    const { w, id } = await team();
    for (const name of ['cat', 'dan']) {
      expect(await w.controller.removeMember(token(name), id, w.id('bob'))).toEqual(FORBIDDEN);
      expect(await w.controller.removeMember(token(name), id, 'u0000000000000099')).toEqual(FORBIDDEN);
      expect(await w.controller.removeMember(token(name), id, undefined)).toEqual(FORBIDDEN);
    }
    expect(await roster(w, id)).toHaveLength(4);
  });

  it('nobody removes themselves: that is leaving', async () => {
    const { w, id } = await team();
    for (const name of ['ann', 'bob']) {
      const result = (await w.controller.removeMember(token(name), id, w.id(name))) as { ok: boolean; error: { code: string; message: string } };
      expect(result.ok).toBe(false);
      expect(result.error).toEqual({ code: 'FORBIDDEN', message: 'to leave a circle, leave it; nobody removes themselves' });
    }
    expect(await roster(w, id)).toHaveLength(4);
  });

  it('a stranger is not told the circle exists; someone not in it, a made-up id and a non-text id are "no such member"', async () => {
    const { w, id } = await team();
    const missing = { ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } };
    expect(await w.controller.removeMember(token('eve'), id, w.id('bob'))).toEqual(missing);
    expect(await w.controller.removeMember(token('ann'), 'c0000000000000000', w.id('bob'))).toEqual(missing);
    const noMember = { ok: false, error: { code: 'NOT_FOUND', message: 'no such member' } };
    for (const target of [w.id('eve'), 'u0000000000000099', 5, null, undefined, '', {}]) expect(await w.controller.removeMember(token('ann'), id, target), String(target)).toEqual(noMember);
  });

  it('non-text ids never reach the store when removing', async () => {
    const base = createMemoryCircleStore();
    const asked: unknown[] = [];
    const store: CircleStore = { ...base, membershipOf: async (...a) => (asked.push(a[1]), base.membershipOf(...a)), removeMember: async (...a) => (asked.push(a[1]), base.removeMember(...a)) };
    const { w, id } = await team({ store });
    asked.length = 0;
    for (const bad of [5, null, undefined, '', {}, ['x']]) await w.controller.removeMember(token('ann'), id, bad);
    expect(asked.filter((who) => who !== w.id('ann'))).toEqual([]);
  });

  it('two owners removing the same person at the same moment: one removes them, the other is told there is no such member', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'owner' }));
    const results = await Promise.all([w.controller.removeMember(token('ann'), id, w.id('cat')), w.controller.removeMember(token('bob'), id, w.id('cat'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such member' } });
  });

  it('the last owner cannot be removed even by a race: two owners removing each other leave one', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'owner' }));
    const results = await Promise.all([w.controller.removeMember(token('ann'), id, w.id('bob')), w.controller.removeMember(token('bob'), id, w.id('ann'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((results.find((r) => !r.ok) as { error: unknown }).error).toEqual({ code: 'LAST_OWNER', message: 'a circle must keep an owner: make someone else an owner first, or delete the circle' });
    expect((await roster(w, id)).filter((r) => r.endsWith('owner'))).toHaveLength(1);
  });

  it('three owners removing the next one in a ring at the same moment always leave an owner', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'owner' }));
    await must(w.controller.changeRole(token('ann'), id, w.id('cat'), { role: 'owner' }));
    await Promise.all([w.controller.removeMember(token('ann'), id, w.id('bob')), w.controller.removeMember(token('bob'), id, w.id('cat')), w.controller.removeMember(token('cat'), id, w.id('ann'))]);
    expect((await roster(w, id)).filter((r) => r.endsWith('owner')).length).toBeGreaterThanOrEqual(1);
  });

  it('is read afresh each time: a demoted manager can no longer remove anyone', async () => {
    const { w, id } = await team();
    await must(w.controller.changeRole(token('ann'), id, w.id('bob'), { role: 'member' }));
    expect(await w.controller.removeMember(token('bob'), id, w.id('cat'))).toEqual(FORBIDDEN);
  });

  it('removing someone does not touch invitations or other circles', async () => {
    const { w, id } = await team();
    const other = await must(w.controller.create(token('bob'), { name: 'Other' }));
    await addMember(w, other.id, 'cat', 'member');
    await must(w.controller.invite(token('ann'), id, { username: 'cat', role: 'member' }));
    await must(w.controller.removeMember(token('ann'), id, w.id('cat')));
    expect((await must(w.controller.myInvitations(token('cat')))).items).toHaveLength(1);
    expect(await w.store.membershipOf(other.id, w.id('cat'))).toBeDefined();
  });

  it('needs a session, and a failing store is a fixed STORAGE_ERROR', async () => {
    const { w, id } = await team();
    expect(await w.controller.removeMember('nonsense', id, w.id('cat'))).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    const base = createMemoryCircleStore();
    const broken = new Proxy(base, { get: (target, key) => (key === 'removeMember' ? async () => { throw new Error('secret path'); } : (target as never)[key]) });
    const ok = world({ store: base });
    const made = await must(ok.controller.create(token('ann'), { name: 'x' }));
    const failing = world({ store: broken });
    expect(await failing.controller.removeMember(token('ann'), made.id, failing.id('bob'))).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such member' } });
    await addMember(ok, made.id, 'bob', 'member');
    expect(await failing.controller.removeMember(token('ann'), made.id, failing.id('bob'))).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
  });
});
