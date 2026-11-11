import { describe, expect, it } from 'vitest';
import { addMember, code, must, T0, world } from './controller.test-util.js';
import { createMemoryCircleStore } from './memory-store.js';
import type { CircleStore } from './store.js';

const DAY = 86_400_000;
const ann = 'tok-ann';
const bob = 'tok-bob';
const cat = 'tok-cat';
const dan = 'tok-dan';
const eve = 'tok-eve';
const fay = 'tok-fay';
const gus = 'tok-gus';
const NO_REQUEST = { ok: false, error: { code: 'NOT_FOUND', message: 'no such join request' } };
const NO_CIRCLE = { ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } };

/** A circle owned by ann with bob (manager), cat (member), dan (observer), and an approval link ready. */
async function team(extra: Parameters<typeof world>[0] = {}) {
  const w = world(extra);
  const made = await must(w.controller.create(ann, { name: 'Team' }));
  await addMember(w, made.id, 'bob', 'manager');
  await addMember(w, made.id, 'cat', 'member');
  await addMember(w, made.id, 'dan', 'observer');
  return { w, id: made.id };
}
type W = ReturnType<typeof world>;
const link = (w: W, id: string, input: Record<string, unknown> = {}) => must(w.controller.createJoinLink(ann, id, { label: 'Club', uses: 20, ...input }));
const ask = async (w: W, token: string, who: string) => must(w.controller.join(who, { token }));
const waiting = async (w: W, id: string, as = ann) => (await must(w.controller.joinRequests(as, id, { limit: 100 }))).items;
const members = async (w: W, id: string) => (await must(w.controller.members(ann, id, { limit: 100 }))).items;

describe('listing waiting requests', () => {
  it('owners and managers see who asked by display name only, the role, and when it lapses; nothing else about them', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'member' });
    await ask(w, made.token, eve);
    w.now.value = T0 + 1000;
    await ask(w, made.token, fay);
    for (const as of [ann, bob]) {
      const listed = await waiting(w, id, as);
      expect(listed).toHaveLength(2);
      expect(listed.map((r) => r.person.displayName).sort()).toEqual(['DISPLAY EVE', 'DISPLAY FAY']);
      expect(listed.every((r) => r.role === 'member' && r.expiresAt - r.createdAt === 7 * DAY)).toBe(true);
      expect(listed.map((r) => r.createdAt).sort()).toEqual([T0, T0 + 1000]);
      expect(Object.keys(listed[0] as object).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'person', 'role']);
      expect(Object.keys((listed[0] as { person: object }).person)).toEqual(['displayName']);
    }
    const text = JSON.stringify(await waiting(w, id));
    expect(text).not.toContain(w.id('eve'));
    expect(text).not.toContain('eve@');
    expect(Object.isFrozen((await must(w.controller.joinRequests(ann, id))).items)).toBe(true);
  });

  it('members and observers cannot see them; a stranger, a made-up circle and odd ids get the one no-such-circle', async () => {
    const { w, id } = await team();
    for (const token of [cat, dan]) expect(await code(w.controller.joinRequests(token, id))).toBe('FORBIDDEN');
    for (const circle of [id, 'c0000000000000000', 'nonsense', '', 5, null, undefined]) {
      expect(await w.controller.joinRequests(gus, circle)).toEqual(NO_CIRCLE);
      expect(await w.controller.approveJoin(gus, circle, 'r0000000000000000')).toEqual(NO_CIRCLE);
      expect(await w.controller.declineJoin(gus, circle, 'r0000000000000000')).toEqual(NO_CIRCLE);
    }
  });

  it('a lapsed request is not listed, and a requester who has gone shows no name', async () => {
    const { w, id } = await team({ limits: { joinRequestDays: 1 } });
    const made = await link(w, id);
    await ask(w, made.token, eve);
    w.now.value = T0 + DAY / 2;
    await ask(w, made.token, fay);
    w.forget('eve');
    expect((await waiting(w, id)).map((r) => r.person)).toEqual(expect.arrayContaining([{}, { displayName: 'DISPLAY FAY' }]));
    w.now.value = T0 + DAY + 1;
    expect((await waiting(w, id)).map((r) => r.person.displayName)).toEqual(['DISPLAY FAY']);
    w.now.value = T0 + 2 * DAY;
    expect(await waiting(w, id)).toEqual([]);
  });

  it('is paged, with limits and cursors checked', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    for (const who of [eve, fay, gus, 'tok-hal', 'tok-ivy']) await ask(w, made.token, who);
    const a = await must(w.controller.joinRequests(ann, id, { limit: 2 }));
    const b = await must(w.controller.joinRequests(ann, id, { limit: 2, cursor: a.nextCursor }));
    const c = await must(w.controller.joinRequests(ann, id, { limit: 2, cursor: b.nextCursor }));
    expect([...a.items, ...b.items, ...c.items].map((r) => r.id)).toEqual((await waiting(w, id)).map((r) => r.id));
    expect(c.nextCursor).toBeNull();
    expect(await w.controller.joinRequests(ann, id, { limit: 0 })).toMatchObject({ ok: false, error: { field: 'limit' } });
    expect(await w.controller.joinRequests(ann, id, { cursor: 'garbage' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'cursor' } });
  });

  it('the role is read afresh: a demoted manager cannot list, approve or decline', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    const asked = await ask(w, made.token, eve);
    expect(asked.state).toBe('requested');
    await must(w.controller.changeRole(ann, id, w.id('bob'), { role: 'member' }));
    const request = (await waiting(w, id))[0]?.id;
    expect(await code(w.controller.joinRequests(bob, id))).toBe('FORBIDDEN');
    expect(await code(w.controller.approveJoin(bob, id, request))).toBe('FORBIDDEN');
    expect(await code(w.controller.declineJoin(bob, id, request))).toBe('FORBIDDEN');
    expect(await waiting(w, id)).toHaveLength(1);
  });

  it('a signed-out request is refused as that', async () => {
    const { w, id } = await team();
    expect(await code(w.controller.joinRequests('nonsense', id))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.approveJoin(null, id, 'r1'))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.declineJoin(undefined, id, 'r1'))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.myJoinRequests(5))).toBe('UNAUTHENTICATED');
  });
});

describe('approving', () => {
  it('an owner or a manager makes the person a member at the link\'s role, returns them as the roster shows them, and closes the request', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'observer' });
    await ask(w, made.token, eve);
    w.now.value = T0 + 5000;
    const request = (await waiting(w, id))[0]?.id;
    const person = await must(w.controller.approveJoin(bob, id, request));
    expect(person).toEqual({ userId: w.id('eve'), username: 'eve', displayName: 'DISPLAY EVE', role: 'observer', joinedAt: T0 + 5000 });
    expect(Object.isFrozen(person)).toBe(true);
    expect((await members(w, id)).find((m) => m.userId === w.id('eve'))?.role).toBe('observer');
    expect(await waiting(w, id)).toEqual([]);
    expect(await w.controller.approveJoin(ann, id, request)).toEqual(NO_REQUEST);
    const second = await ask(w, made.token, fay);
    const next = (await waiting(w, id))[0]?.id;
    expect((await must(w.controller.approveJoin(ann, id, next))).userId).toBe(w.id('fay'));
    expect(second.state).toBe('requested');
  });

  it('members and observers cannot approve or decline, even a request that does not exist', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    await ask(w, made.token, eve);
    const request = (await waiting(w, id))[0]?.id;
    for (const token of [cat, dan]) {
      for (const target of [request, 'r0000000000000000']) {
        expect(await code(w.controller.approveJoin(token, id, target))).toBe('FORBIDDEN');
        expect(await code(w.controller.declineJoin(token, id, target))).toBe('FORBIDDEN');
      }
    }
    expect(await waiting(w, id)).toHaveLength(1);
    expect(await w.store.membershipOf(id, w.id('eve'))).toBeUndefined();
  });

  it('anything but a waiting request of this circle is the one not-found answer: made up, another circle\'s, lapsed, odd ids', async () => {
    const { w, id } = await team({ limits: { joinRequestDays: 1 } });
    const other = await must(w.controller.create(eve, { name: 'Other' }));
    const made = await link(w, id);
    const theirs = await must(w.controller.createJoinLink(eve, other.id, { label: 'x' }));
    await ask(w, theirs.token, fay);
    await ask(w, made.token, gus);
    const otherRequest = (await waiting(w, other.id, eve))[0]?.id;
    const mine = (await waiting(w, id))[0]?.id;
    expect(await w.controller.approveJoin(ann, id, otherRequest)).toEqual(NO_REQUEST);
    expect(await w.controller.declineJoin(ann, id, otherRequest)).toEqual(NO_REQUEST);
    for (const odd of ['r0000000000000000', '', 5, null, undefined, {}]) {
      expect(await w.controller.approveJoin(ann, id, odd)).toEqual(NO_REQUEST);
      expect(await w.controller.declineJoin(ann, id, odd)).toEqual(NO_REQUEST);
    }
    expect(await waiting(w, other.id, eve)).toHaveLength(1);
    w.now.value = T0 + DAY + 1;
    expect(await w.controller.approveJoin(ann, id, mine)).toEqual(NO_REQUEST);
    expect(await w.store.membershipOf(id, w.id('gus'))).toBeUndefined();
  });

  it('ids that are not text never reach the store', async () => {
    const real = createMemoryCircleStore();
    const calls: string[] = [];
    const spy: CircleStore = { ...real, approveJoinRequest: async (...a) => (calls.push('approve'), real.approveJoinRequest(...a)), declineJoinRequest: async (...a) => (calls.push('decline'), real.declineJoinRequest(...a)) };
    const { w, id } = await team({ store: spy });
    for (const odd of ['', 5, null, undefined, {}]) {
      await w.controller.approveJoin(ann, id, odd);
      await w.controller.declineJoin(ann, id, odd);
    }
    expect(calls).toEqual([]);
  });

  it('a full circle or a person in the most circles allowed is a limit, the request stays waiting, and it works once there is room', async () => {
    const { w, id } = await team({ limits: { maxMembersPerCircle: 5 } });
    const made = await link(w, id);
    await ask(w, made.token, eve);
    await ask(w, made.token, fay);
    const [first, second] = (await waiting(w, id)).map((r) => r.id);
    await must(w.controller.approveJoin(ann, id, first));
    expect(await code(w.controller.approveJoin(ann, id, second))).toBe('LIMIT_REACHED');
    expect(await waiting(w, id)).toHaveLength(1);
    await must(w.controller.removeMember(ann, id, w.id('dan')));
    expect(await code(w.controller.approveJoin(ann, id, second))).toBeUndefined();

    const small = await team({ limits: { maxCirclesPerUser: 1 } });
    const l2 = await link(small.w, small.id);
    await ask(small.w, l2.token, gus);
    await must(small.w.controller.create(gus, { name: 'Mine' })); // gus is now in a circle of their own
    expect(await code(small.w.controller.approveJoin(ann, small.id, (await waiting(small.w, small.id))[0]?.id))).toBe('LIMIT_REACHED');
    expect(await waiting(small.w, small.id)).toHaveLength(1);
  });

  it('someone who joined another way meanwhile keeps their role, and the request is closed', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'observer' });
    await ask(w, made.token, eve);
    await addMember(w, id, 'eve', 'manager');
    const person = await must(w.controller.approveJoin(ann, id, (await waiting(w, id))[0]?.id));
    expect(person.role).toBe('manager');
    expect(await waiting(w, id)).toEqual([]);
  });

  it('eight approvals of one request at once add exactly one member', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    await ask(w, made.token, eve);
    const request = (await waiting(w, id))[0]?.id;
    const results = await Promise.all([ann, bob, ann, bob, ann, bob, ann, bob].map((t) => w.controller.approveJoin(t, id, request)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'NOT_FOUND')).toHaveLength(7);
    expect((await members(w, id)).filter((m) => m.userId === w.id('eve'))).toHaveLength(1);
  });

  it('a link that has since been revoked does not stop a request already made', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'member' });
    await ask(w, made.token, eve);
    await must(w.controller.revokeJoinLink(ann, id, made.link.id));
    expect((await must(w.controller.approveJoin(ann, id, (await waiting(w, id))[0]?.id))).role).toBe('member');
  });
});

describe('declining', () => {
  it('removes the request, adds nobody, and does not give the use back', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { uses: 1 });
    await ask(w, made.token, eve);
    const request = (await waiting(w, id))[0]?.id;
    expect(await w.controller.declineJoin(bob, id, request)).toEqual({ ok: true, value: true });
    expect(await waiting(w, id)).toEqual([]);
    expect(await w.store.membershipOf(id, w.id('eve'))).toBeUndefined();
    expect(await w.controller.declineJoin(ann, id, request)).toEqual(NO_REQUEST);
    expect(await w.controller.join(fay, { token: made.token })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such join link' } });
  });

  it('the person may ask again with another link after being declined', async () => {
    const { w, id } = await team();
    const first = await link(w, id, { uses: 1 });
    const second = await link(w, id, { uses: 1 });
    await ask(w, first.token, eve);
    await must(w.controller.declineJoin(ann, id, (await waiting(w, id))[0]?.id));
    expect((await ask(w, second.token, eve)).state).toBe('requested');
  });

  it('a lapsed request cannot be declined, and declining and approving at once give one winner', async () => {
    const { w, id } = await team({ limits: { joinRequestDays: 1 } });
    const made = await link(w, id);
    await ask(w, made.token, eve);
    const request = (await waiting(w, id))[0]?.id;
    const [a, d] = await Promise.all([w.controller.approveJoin(ann, id, request), w.controller.declineJoin(bob, id, request)]);
    expect(a.ok !== d.ok).toBe(true);
    expect(a.ok).toBe((await w.store.membershipOf(id, w.id('eve'))) !== undefined);
    const again = await link(w, id);
    await ask(w, again.token, fay);
    const lapsing = (await waiting(w, id))[0]?.id;
    w.now.value = T0 + 2 * DAY;
    expect(await w.controller.declineJoin(ann, id, lapsing)).toEqual(NO_REQUEST);
  });
});

describe("a person's own waiting requests", () => {
  it('lists them across circles with the circle\'s name, the role and the times, and nothing that names the circle by id or anyone else', async () => {
    const { w, id } = await team();
    const other = await must(w.controller.create(ann, { name: 'Second' }));
    const a = await link(w, id, { role: 'member' });
    const b = await must(w.controller.createJoinLink(ann, other.id, { label: 'x', role: 'observer' }));
    await ask(w, a.token, eve);
    await ask(w, b.token, eve);
    await ask(w, a.token, fay);
    const mine = await must(w.controller.myJoinRequests(eve, { limit: 100 }));
    expect(mine.items.map((r) => [r.circle.name, r.role]).sort()).toEqual([['Second', 'observer'], ['Team', 'member']]);
    expect(mine.items.every((r) => r.expiresAt - r.createdAt === 7 * DAY && r.createdAt === T0)).toBe(true);
    expect(Object.keys(mine.items[0] as object).sort()).toEqual(['circle', 'createdAt', 'expiresAt', 'id', 'role']);
    expect(Object.keys((mine.items[0] as { circle: object }).circle)).toEqual(['name']);
    expect(JSON.stringify(mine)).not.toContain(id);
    expect(Object.isFrozen(mine)).toBe(true);
    expect((await must(w.controller.myJoinRequests(fay))).items).toHaveLength(1);
    expect((await must(w.controller.myJoinRequests(gus))).items).toEqual([]);
  });

  it('a request leaves the list when it is approved, declined or lapses, and when the circle goes', async () => {
    let n = 0;
    const { w, id } = await team({ limits: { joinRequestDays: 1 }, more: { newJoinRequestId: () => `r${String(++n).padStart(16, '0')}` } });
    const made = await link(w, id, { uses: 10 });
    for (const who of [eve, fay, gus]) await ask(w, made.token, who); // requests 1, 2 and 3 in that order
    const byPerson = async (token: string) => (await must(w.controller.myJoinRequests(token))).items.length;
    const ids = (await waiting(w, id)).map((r) => r.id);
    await must(w.controller.approveJoin(ann, id, ids[0]));
    await must(w.controller.declineJoin(ann, id, ids[1]));
    expect([await byPerson(eve), await byPerson(fay), await byPerson(gus)]).toEqual([0, 0, 1]);
    w.now.value = T0 + DAY + 1;
    expect(await byPerson(gus)).toBe(0);
    w.now.value = T0 + 2;
    const again = await link(w, id);
    await ask(w, again.token, 'tok-hal');
    await must(w.controller.delete(ann, id));
    expect(await byPerson('tok-hal')).toBe(0);
  });

  it('is paged, with limits and cursors checked', async () => {
    const { w, id } = await team();
    const other = await must(w.controller.create(ann, { name: 'Second' }));
    const third = await must(w.controller.create(ann, { name: 'Third' }));
    for (const circle of [id, other.id, third.id]) await ask(w, (await must(w.controller.createJoinLink(ann, circle, { label: 'x' }))).token, eve);
    const first = await must(w.controller.myJoinRequests(eve, { limit: 2 }));
    const rest = await must(w.controller.myJoinRequests(eve, { limit: 2, cursor: first.nextCursor }));
    expect(first.items).toHaveLength(2);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(await w.controller.myJoinRequests(eve, { limit: 101 })).toMatchObject({ ok: false, error: { field: 'limit' } });
    expect(await w.controller.myJoinRequests(eve, { cursor: 'garbage' })).toMatchObject({ ok: false, error: { field: 'cursor' } });
  });

  it('a person whose account goes loses their requests (the store keeps none of theirs)', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    await ask(w, made.token, eve);
    await w.store.removeUser(w.id('eve'), 'eve');
    expect(await waiting(w, id)).toEqual([]);
  });
});

describe('failures', () => {
  it('a store that breaks is the one fixed storage message, never its own words', async () => {
    const real = createMemoryCircleStore();
    const fail = async (): Promise<never> => {
      throw new Error('SECRET /var/path failure');
    };
    const broken: CircleStore = { ...real, listJoinRequests: fail, listJoinRequestsBy: fail, approveJoinRequest: fail, declineJoinRequest: fail };
    const w = world({ store: broken });
    const made = await must(w.controller.create(ann, { name: 'X' }));
    const fixed = { ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } };
    expect(await w.controller.joinRequests(ann, made.id)).toEqual(fixed);
    expect(await w.controller.approveJoin(ann, made.id, 'r1')).toEqual(fixed);
    expect(await w.controller.declineJoin(ann, made.id, 'r1')).toEqual(fixed);
    expect(await w.controller.myJoinRequests(ann)).toEqual(fixed);
  });

  it('a store that reports a storage error in its own words is replaced by the fixed message', async () => {
    const real = createMemoryCircleStore();
    const own: CircleStore = { ...real, approveJoinRequest: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'database is locked at /var/x.db' } as never }) };
    const w = world({ store: own });
    const made = await must(w.controller.create(ann, { name: 'X' }));
    expect(await w.controller.approveJoin(ann, made.id, 'r1')).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
  });
});
