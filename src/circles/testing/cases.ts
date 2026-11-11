import assert from 'node:assert/strict';
import type { CirclesError } from '../errors.js';
import type { Result } from '../result.js';
import type { CircleStore, Invitation, InvitationRecord, JoinLinkRecord, JoinRequest, Membership } from '../store.js';
import type { CircleRole } from '../types.js';
import type { CircleStoreCase } from './types.js';

const pad = (n: number | string): string => String(n).padStart(16, '0');
const cid = (n: number | string): string => `c${pad(n)}`;
const iid = (n: number | string): string => `i${pad(n)}`;
const uid = (n: number | string): string => `u${pad(n)}`;
const NOW = 1_000_000;
const DAY = 86_400_000;
const LIMITS = { maxCirclesPerUser: 20, maxMembersPerCircle: 50, maxOpenInvitationsPerCircle: 50 };

const circleRecord = (n: number | string, extra: { description?: string; createdAt?: number } = {}) => ({ id: cid(n), name: `Circle ${n}`, createdAt: NOW + (typeof n === 'number' ? n : 0), ...extra });
const invitation = (n: number | string, circle: number | string, username: string, role: CircleRole = 'member', extra: Partial<InvitationRecord> = {}): InvitationRecord => ({ id: iid(n), circleId: cid(circle), username, role, invitedBy: uid(1), createdAt: NOW, expiresAt: NOW + 7 * DAY, ...extra });

const must = <T>(result: Result<T, CirclesError>): T => {
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.value;
};
const code = <T>(result: Result<T, CirclesError>): string | undefined => (result.ok ? undefined : result.error.code);

/** A circle owned by user 1, with `others` more members of the given roles (users 2, 3, ...), joined in order. */
async function circleWith(store: CircleStore, n: number | string, others: readonly CircleRole[] = []): Promise<void> {
  must(await store.createCircle(circleRecord(n), uid(1), LIMITS));
  for (const [index, role] of others.entries()) {
    const person = index + 2;
    must(await store.createInvitation(invitation(`${n}-${person}`, n, `user${person}`, role), LIMITS, NOW));
    must(await store.acceptInvitation(iid(`${n}-${person}`), uid(person), `user${person}`, NOW + person, LIMITS));
  }
}
const roleOf = async (store: CircleStore, circle: number | string, user: number): Promise<CircleRole | undefined> => (await store.membershipOf(cid(circle), uid(user)))?.role;
const rolesOf = async (store: CircleStore, circle: number | string): Promise<string[]> => (await allPages((p) => store.listMembers(cid(circle), p))).map((m) => `${m.userId}:${m.role}`);

async function allPages<T>(fetch: (page: { limit: number; cursor: string | null }) => Promise<{ items: readonly T[]; nextCursor: string | null }>, limit = 3): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await fetch({ limit, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error('paging did not finish: the cursor never ended');
}
const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

export function circleStoreCases(): readonly CircleStoreCase[] {
  return [
    // ---- circles
    {
      name: 'create then get round-trips every field, and makes the creator the owner',
      run: async (store) => {
        const created = must(await store.createCircle(circleRecord(1, { description: 'About us' }), uid(1), LIMITS));
        assert.deepEqual(created, { id: cid(1), name: 'Circle 1', description: 'About us', createdAt: NOW + 1, updatedAt: NOW + 1 });
        assert.deepEqual(await store.getCircle(cid(1)), created);
        assert.deepEqual(await store.membershipOf(cid(1), uid(1)), { circleId: cid(1), userId: uid(1), role: 'owner', joinedAt: NOW + 1 });
      },
    },
    {
      name: 'a circle without a description has no description key at all',
      run: async (store) => {
        const created = must(await store.createCircle(circleRecord(1), uid(1), LIMITS));
        assert.equal('description' in created, false);
        assert.equal('description' in ((await store.getCircle(cid(1))) as object), false);
      },
    },
    {
      name: 'a missing circle or membership is undefined, not an error',
      run: async (store) => {
        assert.equal(await store.getCircle(cid(9)), undefined);
        assert.equal(await store.membershipOf(cid(9), uid(1)), undefined);
        await circleWith(store, 1);
        assert.equal(await store.membershipOf(cid(1), uid(2)), undefined);
      },
    },
    {
      name: 'a circle id that exists is CONFLICT and changes nothing',
      run: async (store) => {
        must(await store.createCircle(circleRecord(1, { description: 'first' }), uid(1), LIMITS));
        assert.equal(code(await store.createCircle({ ...circleRecord(1), name: 'Other' }, uid(2), LIMITS)), 'CONFLICT');
        assert.equal((await store.getCircle(cid(1)))?.name, 'Circle 1');
        assert.equal(await store.membershipOf(cid(1), uid(2)), undefined);
      },
    },
    {
      name: 'a person may be in at most the allowed number of circles: exactly that many are made, then LIMIT_REACHED, and others are not affected',
      run: async (store) => {
        const limits = { ...LIMITS, maxCirclesPerUser: 3 };
        for (let n = 1; n <= 3; n++) must(await store.createCircle(circleRecord(n), uid(1), limits));
        assert.equal(code(await store.createCircle(circleRecord(4), uid(1), limits)), 'LIMIT_REACHED');
        assert.equal(await store.getCircle(cid(4)), undefined);
        must(await store.createCircle(circleRecord(4), uid(2), limits));
      },
    },
    {
      name: 'joining a circle counts toward the circle cap of the person, and giving one up frees a place',
      run: async (store) => {
        const limits = { ...LIMITS, maxCirclesPerUser: 2 };
        must(await store.createCircle(circleRecord(1), uid(1), limits));
        must(await store.createCircle(circleRecord(2), uid(2), limits));
        must(await store.createCircle(circleRecord(3), uid(2), limits));
        must(await store.createInvitation(invitation(1, 1, 'user2'), limits, NOW));
        assert.equal(code(await store.acceptInvitation(iid(1), uid(2), 'user2', NOW, limits)), 'LIMIT_REACHED');
        assert.ok(await store.getInvitation(iid(1)), 'the invitation stays open');
        assert.equal(await store.deleteCircle(cid(3)), true); // frees one of their two places
        must(await store.acceptInvitation(iid(1), uid(2), 'user2', NOW, limits));
      },
    },
    {
      name: 'update changes only what it is given, null removes the description, and the id and creation time never change',
      run: async (store) => {
        must(await store.createCircle(circleRecord(1, { description: 'old' }), uid(1), LIMITS));
        assert.deepEqual(must(await store.updateCircle(cid(1), { name: 'New', updatedAt: NOW + 50 })), { id: cid(1), name: 'New', description: 'old', createdAt: NOW + 1, updatedAt: NOW + 50 });
        assert.equal((must(await store.updateCircle(cid(1), { description: 'newer', updatedAt: NOW + 60 }))).name, 'New');
        const cleared = must(await store.updateCircle(cid(1), { description: null, updatedAt: NOW + 70 }));
        assert.equal('description' in cleared, false);
        assert.deepEqual(await store.getCircle(cid(1)), cleared);
        assert.equal(code(await store.updateCircle(cid(9), { name: 'x', updatedAt: NOW })), 'NOT_FOUND');
      },
    },
    {
      name: 'deleting a circle removes its members and invitations, leaves other circles alone, and is idempotent',
      run: async (store) => {
        await circleWith(store, 1, ['member']);
        await circleWith(store, 2);
        must(await store.createInvitation(invitation('a', 1, 'carol'), LIMITS, NOW));
        assert.equal(await store.deleteCircle(cid(1)), true);
        assert.equal(await store.deleteCircle(cid(1)), false);
        assert.equal(await store.getCircle(cid(1)), undefined);
        assert.equal(await store.membershipOf(cid(1), uid(2)), undefined);
        assert.equal(await store.getInvitation(iid('a')), undefined);
        assert.deepEqual((await store.listMembers(cid(1), { limit: 10, cursor: null })).items, []);
        assert.ok(await store.getCircle(cid(2)));
        assert.equal(await roleOf(store, 2, 1), 'owner');
      },
    },

    // ---- listing
    {
      name: 'a person\'s circles come by circle id with their own role and the member count, and page without gaps or repeats',
      run: async (store) => {
        for (let n = 1; n <= 7; n++) await circleWith(store, n, n % 2 === 0 ? ['manager'] : []);
        must(await store.createInvitation(invitation('x', 3, 'user9', 'observer'), LIMITS, NOW));
        must(await store.acceptInvitation(iid('x'), uid(9), 'user9', NOW + 9, LIMITS));
        const mine = await allPages((p) => store.listCirclesOf(uid(1), p), 3);
        assert.deepEqual(mine.map((s) => s.circle.id), [1, 2, 3, 4, 5, 6, 7].map(cid));
        assert.deepEqual(mine.map((s) => s.memberCount), [1, 2, 2, 2, 1, 2, 1]);
        assert.ok(mine.every((s) => s.role === 'owner'));
        const theirs = await allPages((p) => store.listCirclesOf(uid(2), p));
        assert.deepEqual(theirs.map((s) => [s.circle.id, s.role]), [[cid(2), 'manager'], [cid(4), 'manager'], [cid(6), 'manager']]);
        assert.deepEqual((await allPages((p) => store.listCirclesOf(uid(9), p))).map((s) => [s.circle.id, s.role, s.joinedAt]), [[cid(3), 'observer', NOW + 9]]);
        assert.deepEqual((await store.listCirclesOf(uid(77), { limit: 5, cursor: null })), { items: [], nextCursor: null });
      },
    },
    {
      name: 'every circle that exists is listed by id, in pages without gaps or repeats, and a deleted one is gone',
      run: async (store) => {
        assert.deepEqual(await store.listCircleIds({ limit: 5, cursor: null }), { items: [], nextCursor: null });
        await circleWith(store, 3);
        await circleWith(store, 1);
        must(await store.createCircle({ id: cid(2), name: 'Other owner', createdAt: NOW }, uid(5), LIMITS));
        await circleWith(store, 4);
        assert.deepEqual(await allPages((p) => store.listCircleIds(p), 2), [1, 2, 3, 4].map(cid));
        assert.equal((await store.listCircleIds({ limit: 4, cursor: null })).nextCursor, null);
        assert.notEqual((await store.listCircleIds({ limit: 3, cursor: null })).nextCursor, null);
        await store.deleteCircle(cid(3));
        assert.deepEqual(await allPages((p) => store.listCircleIds(p), 2), [1, 2, 4].map(cid));
        for (const limit of [0, -1, 1.5, Number.NaN]) assert.ok((await thrown(() => store.listCircleIds({ limit, cursor: null }))) instanceof RangeError, `limit ${limit}`);
        assert.ok((await thrown(() => store.listCircleIds({ limit: 5, cursor: 'not-a-cursor' }))) instanceof RangeError);
      },
    },
    {
      name: 'a page that exactly fills the limit has no next cursor, and a page with more has one',
      run: async (store) => {
        for (let n = 1; n <= 4; n++) await circleWith(store, n);
        const exact = await store.listCirclesOf(uid(1), { limit: 4, cursor: null });
        assert.equal(exact.items.length, 4);
        assert.equal(exact.nextCursor, null);
        const more = await store.listCirclesOf(uid(1), { limit: 3, cursor: null });
        assert.equal(more.items.length, 3);
        assert.notEqual(more.nextCursor, null);
      },
    },
    {
      name: 'paging is stable when circles are added or removed while walking it',
      run: async (store) => {
        for (const n of [2, 4, 6, 8]) await circleWith(store, n);
        const first = await store.listCirclesOf(uid(1), { limit: 2, cursor: null });
        assert.deepEqual(first.items.map((s) => s.circle.id), [cid(2), cid(4)]);
        await circleWith(store, 3);
        await circleWith(store, 7);
        await store.deleteCircle(cid(2));
        const rest: string[] = [];
        let cursor = first.nextCursor;
        while (cursor !== null) {
          const page = await store.listCirclesOf(uid(1), { limit: 2, cursor });
          rest.push(...page.items.map((s) => s.circle.id));
          cursor = page.nextCursor;
        }
        assert.deepEqual(rest, [cid(6), cid(7), cid(8)]);
      },
    },
    {
      name: 'a limit that is not a positive whole number, or a cursor this store did not give, is a RangeError',
      run: async (store) => {
        await circleWith(store, 1);
        for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          assert.ok((await thrown(() => store.listCirclesOf(uid(1), { limit, cursor: null }))) instanceof RangeError, `limit ${limit}`);
          assert.ok((await thrown(() => store.listMembers(cid(1), { limit, cursor: null }))) instanceof RangeError);
          assert.ok((await thrown(() => store.listInvitationsFor('x', NOW, { limit, cursor: null }))) instanceof RangeError);
        }
        for (const cursor of ['nonsense', '', 'k!!!', 'kAAAA=', ' kYQ', 'kYR']) {
          assert.ok((await thrown(() => store.listCirclesOf(uid(1), { limit: 5, cursor }))) instanceof RangeError, `cursor ${JSON.stringify(cursor)}`);
          assert.ok((await thrown(() => store.listMembers(cid(1), { limit: 5, cursor }))) instanceof RangeError);
          assert.ok((await thrown(() => store.listInvitationsOfCircle(cid(1), NOW, { limit: 5, cursor }))) instanceof RangeError);
        }
      },
    },
    {
      name: 'members come by user id with their role and join time, and page',
      run: async (store) => {
        await circleWith(store, 1, ['manager', 'member', 'observer', 'member']);
        const all = await allPages((p) => store.listMembers(cid(1), p), 2);
        assert.deepEqual(all.map((m) => [m.userId, m.role]), [[uid(1), 'owner'], [uid(2), 'manager'], [uid(3), 'member'], [uid(4), 'observer'], [uid(5), 'member']]);
        assert.deepEqual(all.map((m) => m.joinedAt), [NOW + 1, NOW + 2, NOW + 3, NOW + 4, NOW + 5]);
        assert.deepEqual(await store.listMembers(cid(9), { limit: 5, cursor: null }), { items: [], nextCursor: null });
      },
    },

    {
      name: 'members are listed by user id whatever order they joined in',
      run: async (store) => {
        await circleWith(store, 1);
        for (const n of [9, 3, 5]) {
          must(await store.createInvitation(invitation(`o${n}`, 1, `user${n}`), LIMITS, NOW));
          must(await store.acceptInvitation(iid(`o${n}`), uid(n), `user${n}`, NOW + 10 - n, LIMITS));
        }
        assert.deepEqual((await allPages((p) => store.listMembers(cid(1), p), 2)).map((m) => m.userId), [uid(1), uid(3), uid(5), uid(9)]);
      },
    },

    // ---- roles and removal
    {
      name: 'changing a role changes only that membership and keeps when they joined',
      run: async (store) => {
        await circleWith(store, 1, ['member', 'member']);
        const changed = must(await store.changeRole(cid(1), uid(2), 'manager'));
        assert.deepEqual(changed, { circleId: cid(1), userId: uid(2), role: 'manager', joinedAt: NOW + 2 });
        assert.deepEqual(await rolesOf(store, 1), [`${uid(1)}:owner`, `${uid(2)}:manager`, `${uid(3)}:member`]);
        assert.equal(code(await store.changeRole(cid(1), uid(9), 'member')), 'NOT_FOUND');
        assert.equal(code(await store.changeRole(cid(9), uid(1), 'member')), 'NOT_FOUND');
      },
    },
    {
      name: 'the only owner cannot be demoted, but can once there are two owners',
      run: async (store) => {
        await circleWith(store, 1, ['member']);
        assert.equal(code(await store.changeRole(cid(1), uid(1), 'manager')), 'LAST_OWNER');
        assert.equal(await roleOf(store, 1, 1), 'owner');
        must(await store.changeRole(cid(1), uid(2), 'owner'));
        must(await store.changeRole(cid(1), uid(1), 'member'));
        assert.equal(code(await store.changeRole(cid(1), uid(2), 'observer')), 'LAST_OWNER');
        assert.equal(await roleOf(store, 1, 1), 'member');
      },
    },
    {
      name: 'making the only owner an owner again is allowed and changes nothing',
      run: async (store) => {
        await circleWith(store, 1);
        assert.equal(must(await store.changeRole(cid(1), uid(1), 'owner')).role, 'owner');
      },
    },
    {
      name: 'two owners demoting each other at the same moment: exactly one succeeds and one owner remains',
      run: async (store) => {
        await circleWith(store, 1, ['owner']);
        const results = await Promise.all([store.changeRole(cid(1), uid(1), 'member'), store.changeRole(cid(1), uid(2), 'member')]);
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.deepEqual(results.filter((r) => !r.ok).map(code), ['LAST_OWNER']);
        const roles = await rolesOf(store, 1);
        assert.equal(roles.filter((r) => r.endsWith(':owner')).length, 1);
      },
    },
    {
      name: 'removing a member removes only them; removing a non-member is false and not an error',
      run: async (store) => {
        await circleWith(store, 1, ['member', 'observer']);
        assert.equal(must(await store.removeMember(cid(1), uid(2))), true);
        assert.equal(must(await store.removeMember(cid(1), uid(2))), false);
        assert.equal(must(await store.removeMember(cid(1), uid(9))), false);
        assert.equal(must(await store.removeMember(cid(9), uid(1))), false);
        assert.deepEqual(await rolesOf(store, 1), [`${uid(1)}:owner`, `${uid(3)}:observer`]);
      },
    },
    {
      name: 'the only owner cannot be removed, but a second owner can be, and then the first is the only one again',
      run: async (store) => {
        await circleWith(store, 1, ['owner', 'member']);
        assert.equal(must(await store.removeMember(cid(1), uid(2))), true);
        assert.equal(code(await store.removeMember(cid(1), uid(1))), 'LAST_OWNER');
        assert.deepEqual(await rolesOf(store, 1), [`${uid(1)}:owner`, `${uid(3)}:member`]);
      },
    },
    {
      name: 'two owners removing each other at the same moment: exactly one succeeds and one owner remains',
      run: async (store) => {
        await circleWith(store, 1, ['owner']);
        const results = await Promise.all([store.removeMember(cid(1), uid(1)), store.removeMember(cid(1), uid(2))]);
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.deepEqual(results.filter((r) => !r.ok).map(code), ['LAST_OWNER']);
        assert.equal((await rolesOf(store, 1)).length, 1);
      },
    },
    {
      name: 'eight owners removing the next one at the same moment always leave an owner',
      run: async (store) => {
        await circleWith(store, 1, ['owner', 'owner', 'owner', 'owner', 'owner', 'owner', 'owner']);
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.removeMember(cid(1), uid(i + 1))));
        assert.ok(results.filter((r) => r.ok && r.value).length <= 7);
        assert.ok((await rolesOf(store, 1)).filter((r) => r.endsWith(':owner')).length >= 1);
      },
    },

    // ---- invitations
    {
      name: 'an invitation round-trips, with the username lower-cased by the store',
      run: async (store) => {
        await circleWith(store, 1);
        const made = must(await store.createInvitation(invitation(1, 1, 'Carol', 'observer'), LIMITS, NOW));
        assert.deepEqual(made, { ...invitation(1, 1, 'carol', 'observer') });
        assert.deepEqual(await store.getInvitation(iid(1)), made);
        assert.equal(await store.getInvitation(iid(2)), undefined);
        assert.equal(code(await store.createInvitation(invitation(2, 9, 'carol'), LIMITS, NOW)), 'NOT_FOUND');
      },
    },
    {
      name: 'a repeat invitation for the same circle and name (any case) keeps the first id and creation time and takes the new role, inviter and expiry',
      run: async (store) => {
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'carol', 'member', { createdAt: NOW, expiresAt: NOW + DAY }), LIMITS, NOW));
        const again = must(await store.createInvitation(invitation(2, 1, 'CAROL', 'manager', { invitedBy: uid(5), createdAt: NOW + 10, expiresAt: NOW + 3 * DAY }), LIMITS, NOW + 10));
        assert.deepEqual(again, { id: iid(1), circleId: cid(1), username: 'carol', role: 'manager', invitedBy: uid(5), createdAt: NOW, expiresAt: NOW + 3 * DAY });
        assert.equal(await store.getInvitation(iid(2)), undefined);
        assert.equal((await store.listInvitationsOfCircle(cid(1), NOW, { limit: 10, cursor: null })).items.length, 1);
      },
    },
    {
      name: 'an invitation id that is already used by another invitation is CONFLICT and changes nothing',
      run: async (store) => {
        await circleWith(store, 1);
        await circleWith(store, 2);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        assert.equal(code(await store.createInvitation(invitation(1, 2, 'dave'), LIMITS, NOW)), 'CONFLICT');
        assert.equal((await store.getInvitation(iid(1)))?.circleId, cid(1));
        assert.equal((await store.listInvitationsOfCircle(cid(2), NOW, { limit: 5, cursor: null })).items.length, 0);
      },
    },
    {
      name: 'the same name may be invited to different circles',

      run: async (store) => {
        await circleWith(store, 1);
        await circleWith(store, 2);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        must(await store.createInvitation(invitation(2, 2, 'carol'), LIMITS, NOW));
        assert.deepEqual((await allPages((p) => store.listInvitationsFor('Carol', NOW, p))).map((i) => i.id), [iid(1), iid(2)]);
      },
    },
    {
      name: 'a circle holds at most the allowed open invitations; a repeat does not use another place; expired ones do not count',
      run: async (store) => {
        const limits = { ...LIMITS, maxOpenInvitationsPerCircle: 3 };
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'a1', 'member', { expiresAt: NOW + 100 }), limits, NOW));
        must(await store.createInvitation(invitation(2, 1, 'a2'), limits, NOW));
        must(await store.createInvitation(invitation(3, 1, 'a3'), limits, NOW));
        assert.equal(code(await store.createInvitation(invitation(4, 1, 'a4'), limits, NOW)), 'LIMIT_REACHED');
        must(await store.createInvitation(invitation(5, 1, 'a2', 'observer'), limits, NOW)); // a repeat
        must(await store.createInvitation(invitation(6, 1, 'a4'), limits, NOW + 100)); // the first one expired
        assert.equal(code(await store.createInvitation(invitation(7, 1, 'a5'), limits, NOW + 100)), 'LIMIT_REACHED');
        await circleWith(store, 2);
        must(await store.createInvitation(invitation(8, 2, 'a1'), limits, NOW)); // another circle has its own count
      },
    },
    {
      name: 'listings show only open invitations, by id, for a circle and for a name, and page',
      run: async (store) => {
        await circleWith(store, 1);
        await circleWith(store, 2);
        for (let n = 1; n <= 5; n++) must(await store.createInvitation(invitation(n, 1, `p${n}`, 'member', { expiresAt: n === 3 ? NOW + 10 : NOW + DAY }), LIMITS, NOW));
        must(await store.createInvitation(invitation(6, 2, 'p1'), LIMITS, NOW));
        const ofCircle = await allPages((p) => store.listInvitationsOfCircle(cid(1), NOW + 10, p), 2);
        assert.deepEqual(ofCircle.map((i) => i.id), [iid(1), iid(2), iid(4), iid(5)]);
        const forName = await allPages((p) => store.listInvitationsFor('P1', NOW, p), 1);
        assert.deepEqual(forName.map((i) => i.id), [iid(1), iid(6)]);
        assert.deepEqual(await store.listInvitationsFor('nobody', NOW, { limit: 5, cursor: null }), { items: [], nextCursor: null });
        assert.deepEqual(await store.listInvitationsOfCircle(cid(9), NOW, { limit: 5, cursor: null }), { items: [], nextCursor: null });
      },
    },
    {
      name: 'an invitation is open until its expiry time and not at it',
      run: async (store) => {
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'carol', 'member', { expiresAt: NOW + 50 }), LIMITS, NOW));
        assert.equal((await store.listInvitationsFor('carol', NOW + 49, { limit: 5, cursor: null })).items.length, 1);
        assert.equal((await store.listInvitationsFor('carol', NOW + 50, { limit: 5, cursor: null })).items.length, 0);
        assert.equal((await store.listInvitationsOfCircle(cid(1), NOW + 49, { limit: 5, cursor: null })).items.length, 1);
        assert.equal((await store.listInvitationsOfCircle(cid(1), NOW + 50, { limit: 5, cursor: null })).items.length, 0);
        assert.equal(code(await store.acceptInvitation(iid(1), uid(3), 'carol', NOW + 50, LIMITS)), 'NOT_FOUND');
        assert.equal(await store.membershipOf(cid(1), uid(3)), undefined);
        assert.equal(await store.getInvitation(iid(1)), undefined, 'an expired invitation is removed when it is met');
      },
    },
    {
      name: 'accepting adds the membership with the offered role and the time of acceptance, and closes the invitation',
      run: async (store) => {
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'carol', 'manager'), LIMITS, NOW));
        const joined = must(await store.acceptInvitation(iid(1), uid(3), 'Carol', NOW + 77, LIMITS));
        assert.deepEqual(joined, { circleId: cid(1), userId: uid(3), role: 'manager', joinedAt: NOW + 77 });
        assert.deepEqual(await store.membershipOf(cid(1), uid(3)), joined);
        assert.equal(await store.getInvitation(iid(1)), undefined);
        assert.equal(code(await store.acceptInvitation(iid(1), uid(3), 'carol', NOW + 78, LIMITS)), 'NOT_FOUND');
      },
    },
    {
      name: 'a missing invitation, one addressed to someone else, and one for a circle that has gone are all the same NOT_FOUND, and the first two change nothing',
      run: async (store) => {
        await circleWith(store, 1);
        await circleWith(store, 2);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        must(await store.createInvitation(invitation(2, 2, 'dave'), LIMITS, NOW));
        const missing = await store.acceptInvitation(iid(9), uid(3), 'carol', NOW, LIMITS);
        const wrong = await store.acceptInvitation(iid(1), uid(4), 'dave', NOW, LIMITS);
        await store.deleteCircle(cid(2));
        const gone = await store.acceptInvitation(iid(2), uid(4), 'dave', NOW, LIMITS);
        for (const r of [missing, wrong, gone]) assert.deepEqual(r, missing);
        assert.equal(code(missing), 'NOT_FOUND');
        assert.ok(await store.getInvitation(iid(1)), 'a wrong person cannot spend it');
        assert.equal(await store.membershipOf(cid(1), uid(4)), undefined);
      },
    },
    {
      name: 'a full circle refuses an accept with LIMIT_REACHED and the invitation stays open',
      run: async (store) => {
        const limits = { ...LIMITS, maxMembersPerCircle: 2 };
        await circleWith(store, 1, ['member']);
        must(await store.createInvitation(invitation(1, 1, 'carol'), limits, NOW));
        assert.equal(code(await store.acceptInvitation(iid(1), uid(3), 'carol', NOW, limits)), 'LIMIT_REACHED');
        assert.ok(await store.getInvitation(iid(1)));
        must(await store.removeMember(cid(1), uid(2)));
        must(await store.acceptInvitation(iid(1), uid(3), 'carol', NOW, limits));
      },
    },
    {
      name: 'someone already in the circle who accepts keeps their role, and the invitation is closed',
      run: async (store) => {
        await circleWith(store, 1, ['manager']);
        must(await store.createInvitation(invitation(1, 1, 'user2', 'observer'), LIMITS, NOW));
        const kept = must(await store.acceptInvitation(iid(1), uid(2), 'user2', NOW + 500, LIMITS));
        assert.deepEqual(kept, { circleId: cid(1), userId: uid(2), role: 'manager', joinedAt: NOW + 2 });
        assert.equal(await store.getInvitation(iid(1)), undefined);
      },
    },
    {
      name: 'eight people accepting one invitation at the same moment: one membership, one success',
      run: async (store) => {
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        const results = await Promise.all(Array.from({ length: 8 }, () => store.acceptInvitation(iid(1), uid(3), 'carol', NOW + 1, LIMITS)));
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.equal((await rolesOf(store, 1)).length, 2);
      },
    },
    {
      name: 'five invitations accepted at the same moment for the last place: exactly one succeeds and the rest stay open',
      run: async (store) => {
        const limits = { ...LIMITS, maxMembersPerCircle: 2 };
        await circleWith(store, 1);
        for (let n = 1; n <= 5; n++) must(await store.createInvitation(invitation(n, 1, `p${n}`), limits, NOW));
        const results = await Promise.all([1, 2, 3, 4, 5].map((n) => store.acceptInvitation(iid(n), uid(10 + n), `p${n}`, NOW + 1, limits)));
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.deepEqual([...new Set(results.filter((r) => !r.ok).map(code))], ['LIMIT_REACHED']);
        assert.equal((await rolesOf(store, 1)).length, 2);
        assert.equal((await store.listInvitationsOfCircle(cid(1), NOW, { limit: 10, cursor: null })).items.length, 4);
      },
    },
    {
      name: 'a person accepting into more circles than allowed at the same moment gets exactly the allowed number',
      run: async (store) => {
        const limits = { ...LIMITS, maxCirclesPerUser: 3 };
        for (let n = 1; n <= 6; n++) {
          must(await store.createCircle(circleRecord(n), uid(100 + n), limits));
          must(await store.createInvitation(invitation(n, n, 'carol'), limits, NOW));
        }
        const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => store.acceptInvitation(iid(n), uid(3), 'carol', NOW + 1, limits)));
        assert.equal(results.filter((r) => r.ok).length, 3);
        assert.equal((await allPages((p) => store.listCirclesOf(uid(3), p))).length, 3);
      },
    },
    {
      name: 'declining closes only an open invitation addressed to that name; revoking only one of that circle',
      run: async (store) => {
        await circleWith(store, 1);
        await circleWith(store, 2);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        assert.equal(await store.declineInvitation(iid(1), 'dave', NOW), false);
        assert.ok(await store.getInvitation(iid(1)));
        assert.equal(await store.revokeInvitation(iid(1), cid(2), NOW), false);
        assert.ok(await store.getInvitation(iid(1)));
        assert.equal(await store.declineInvitation(iid(1), 'CAROL', NOW), true);
        assert.equal(await store.getInvitation(iid(1)), undefined);
        assert.equal(await store.declineInvitation(iid(1), 'carol', NOW), false);
        must(await store.createInvitation(invitation(2, 1, 'erin'), LIMITS, NOW));
        assert.equal(await store.revokeInvitation(iid(2), cid(1), NOW), true);
        assert.equal(await store.revokeInvitation(iid(2), cid(1), NOW), false);
        assert.equal(await store.getInvitation(iid(2)), undefined);
      },
    },
    {
      name: 'declining or revoking an expired invitation reports that there was none, and removes it',
      run: async (store) => {
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'carol', 'member', { expiresAt: NOW + 5 }), LIMITS, NOW));
        must(await store.createInvitation(invitation(2, 1, 'dave', 'member', { expiresAt: NOW + 5 }), LIMITS, NOW));
        assert.equal(await store.declineInvitation(iid(1), 'carol', NOW + 5), false);
        assert.equal(await store.revokeInvitation(iid(2), cid(1), NOW + 5), false);
        assert.equal(await store.getInvitation(iid(1)), undefined);
        assert.equal(await store.getInvitation(iid(2)), undefined);
      },
    },
    {
      name: 'purging removes exactly the expired invitations and says how many',
      run: async (store) => {
        await circleWith(store, 1);
        must(await store.createInvitation(invitation(1, 1, 'a', 'member', { expiresAt: NOW + 5 }), LIMITS, NOW));
        must(await store.createInvitation(invitation(2, 1, 'b', 'member', { expiresAt: NOW + 6 }), LIMITS, NOW));
        must(await store.createInvitation(invitation(3, 1, 'c', 'member', { expiresAt: NOW + DAY }), LIMITS, NOW));
        assert.equal(await store.purgeExpired(NOW + 6), 2);
        assert.equal(await store.purgeExpired(NOW + 6), 0);
        assert.deepEqual((await allPages((p) => store.listInvitationsOfCircle(cid(1), NOW, p))).map((i) => i.id), [iid(3)]);
      },
    },

    // ---- a person goes
    {
      name: 'removing a person takes them out of every circle and leaves everyone else as they were',
      run: async (store) => {
        await circleWith(store, 1, ['member', 'member']);
        await circleWith(store, 2, ['owner']);
        const outcome = await store.removeUser(uid(2), 'user2');
        assert.deepEqual(outcome, { left: 2, handedOver: [], dissolved: [], invitationsRemoved: 0 });
        assert.deepEqual(await rolesOf(store, 1), [`${uid(1)}:owner`, `${uid(3)}:member`]);
        assert.deepEqual(await rolesOf(store, 2), [`${uid(1)}:owner`]);
        assert.deepEqual(await store.removeUser(uid(2), 'user2'), { left: 0, handedOver: [], dissolved: [], invitationsRemoved: 0 });
        assert.deepEqual(await store.removeUser(uid(99), 'nobody'), { left: 0, handedOver: [], dissolved: [], invitationsRemoved: 0 });
      },
    },
    {
      name: 'a circle the person solely owned goes to its longest-standing manager, else member, else observer',
      run: async (store) => {
        await circleWith(store, 1, ['observer', 'member', 'manager', 'manager']); // users 2 observer, 3 member, 4 manager (joined first), 5 manager
        await circleWith(store, 2, ['observer', 'member', 'observer']); // no manager: the member
        await circleWith(store, 3, ['observer', 'observer']); // only observers: the earlier one
        const outcome = await store.removeUser(uid(1), 'user1');
        assert.deepEqual(outcome, { left: 3, handedOver: [cid(1), cid(2), cid(3)], dissolved: [], invitationsRemoved: 0 });
        assert.equal(await roleOf(store, 1, 4), 'owner');
        assert.equal(await roleOf(store, 1, 5), 'manager');
        assert.equal(await roleOf(store, 2, 3), 'owner');
        assert.equal(await roleOf(store, 3, 2), 'owner');
        for (const n of [1, 2, 3]) assert.equal(await store.membershipOf(cid(n), uid(1)), undefined);
      },
    },
    {
      name: 'ties in the hand-over go to the earlier join and then the lower user id',
      run: async (store) => {
        const join = async (circle: number, user: number, at: number): Promise<void> => {
          must(await store.createInvitation(invitation(`${circle}-${user}`, circle, `user${user}`, 'member'), LIMITS, NOW));
          must(await store.acceptInvitation(iid(`${circle}-${user}`), uid(user), `user${user}`, NOW + at, LIMITS));
        };
        must(await store.createCircle(circleRecord(1), uid(1), LIMITS));
        await join(1, 5, 40); // earlier, but a higher id
        await join(1, 3, 50);
        must(await store.createCircle(circleRecord(2), uid(1), LIMITS));
        await join(2, 5, 50); // the same moment: the lower id
        await join(2, 3, 50);
        await join(2, 4, 60);
        await store.removeUser(uid(1), 'user1');
        assert.equal(await roleOf(store, 1, 5), 'owner');
        assert.equal(await roleOf(store, 1, 3), 'member');
        assert.equal(await roleOf(store, 2, 3), 'owner');
        assert.equal(await roleOf(store, 2, 5), 'member');
      },
    },
    {
      name: 'a person who is one of several owners is simply removed, with no hand-over',
      run: async (store) => {
        await circleWith(store, 1, ['owner', 'manager']);
        const outcome = await store.removeUser(uid(1), 'user1');
        assert.deepEqual(outcome, { left: 1, handedOver: [], dissolved: [], invitationsRemoved: 0 });
        assert.deepEqual(await rolesOf(store, 1), [`${uid(2)}:owner`, `${uid(3)}:manager`]);
      },
    },
    {
      name: 'a circle the person solely owned and was alone in is removed, with its invitations',
      run: async (store) => {
        await circleWith(store, 1);
        await circleWith(store, 2, ['member']);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        const outcome = await store.removeUser(uid(1), 'user1');
        assert.deepEqual(outcome.dissolved, [cid(1)]);
        assert.deepEqual(outcome.handedOver, [cid(2)]);
        assert.equal(await store.getCircle(cid(1)), undefined);
        assert.equal(await store.getInvitation(iid(1)), undefined);
        assert.ok(await store.getCircle(cid(2)));
      },
    },
    {
      name: 'removing a person also removes the invitations addressed to their name and those they sent, and no others',
      run: async (store) => {
        await circleWith(store, 1, ['member']);
        await circleWith(store, 2);
        must(await store.createInvitation(invitation(1, 2, 'user2', 'member', { invitedBy: uid(1) }), LIMITS, NOW)); // to them
        must(await store.createInvitation(invitation(2, 1, 'carol', 'member', { invitedBy: uid(2) }), LIMITS, NOW)); // from them
        must(await store.createInvitation(invitation(3, 1, 'dave', 'member', { invitedBy: uid(1) }), LIMITS, NOW)); // neither
        const outcome = await store.removeUser(uid(2), 'User2');
        assert.equal(outcome.invitationsRemoved, 2);
        assert.equal(await store.getInvitation(iid(1)), undefined);
        assert.equal(await store.getInvitation(iid(2)), undefined);
        assert.ok(await store.getInvitation(iid(3)));
      },
    },
    {
      name: 'no circle is ever left without an owner by removing people one after another',
      run: async (store) => {
        await circleWith(store, 1, ['observer', 'member', 'manager']);
        for (let user = 1; user <= 3; user++) {
          await store.removeUser(uid(user), `user${user}`);
          const roles = await rolesOf(store, 1);
          assert.ok(roles.some((r) => r.endsWith(':owner')), `after removing user ${user}: ${roles.join(', ')}`);
        }
        assert.deepEqual(await rolesOf(store, 1), [`${uid(4)}:owner`]);
        await store.removeUser(uid(4), 'user4');
        assert.equal(await store.getCircle(cid(1)), undefined);
      },
    },

    // ---- general
    {
      name: 'what a store returns is a copy: changing it changes nothing inside, and the record given in is not kept',
      run: async (store) => {
        const record = { ...circleRecord(1, { description: 'd' }) };
        const circle = must(await store.createCircle(record, uid(1), LIMITS));
        (record as { name: string }).name = 'changed after';
        (circle as { name: string }).name = 'changed after';
        assert.equal((await store.getCircle(cid(1)))?.name, 'Circle 1');
        const membership = (await store.membershipOf(cid(1), uid(1))) as Membership;
        (membership as { role: string }).role = 'observer';
        assert.equal(await roleOf(store, 1, 1), 'owner');
        const inviteRecord = invitation(1, 1, 'carol');
        const made = must(await store.createInvitation(inviteRecord, LIMITS, NOW));
        (inviteRecord as { role: string }).role = 'owner';
        (made as { role: string }).role = 'owner';
        const stored = (await store.getInvitation(iid(1))) as Invitation;
        assert.equal(stored.role, 'member');
        (stored as { username: string }).username = 'zzz';
        assert.equal((await store.getInvitation(iid(1)))?.username, 'carol');
        const page = await store.listCirclesOf(uid(1), { limit: 5, cursor: null });
        (page.items[0] as { role: string }).role = 'observer';
        assert.equal((await store.listCirclesOf(uid(1), { limit: 5, cursor: null })).items[0]?.role, 'owner');
      },
    },
    {
      name: 'ids and names are opaque text: odd characters round-trip unchanged',
      run: async (store) => {
        const odd = { id: cid('odd'), name: 'Ünïcode 😀 <b>"quoted"</b> \\ / ?x=1&y=2', description: 'line one\nline two', createdAt: NOW };
        must(await store.createCircle(odd, uid(1), LIMITS));
        assert.deepEqual(await store.getCircle(cid('odd')), { ...odd, updatedAt: NOW });
      },
    },
    {
      name: 'two stores share nothing',
      run: async (store, makeAnother) => {
        const other = await makeAnother();
        await circleWith(store, 1, ['member']);
        must(await store.createInvitation(invitation(1, 1, 'carol'), LIMITS, NOW));
        assert.equal(await other.getCircle(cid(1)), undefined);
        assert.equal(await other.membershipOf(cid(1), uid(2)), undefined);
        assert.equal(await other.getInvitation(iid(1)), undefined);
        assert.deepEqual(await other.listCirclesOf(uid(1), { limit: 5, cursor: null }), { items: [], nextCursor: null });
        await circleWith(other, 1);
        assert.deepEqual(await rolesOf(other, 1), [`${uid(1)}:owner`]);
        assert.equal((await rolesOf(store, 1)).length, 2);
      },
    },
    ...grantCases(),
    ...joinLinkCases(),
    ...joinRequestCases(),
  ];
}

// ---- grants (R-008)

const GRANT_LIMITS = { maxCategoriesPerGrant: 200 };
const SORTED = (ids: readonly string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** A circle owned by user 1 with users 2 and 3 as members. */
const trio = (store: CircleStore, n: number | string = 1): Promise<void> => circleWith(store, n, ['member', 'member']);
const grantOf = (store: CircleStore, circle: number | string, owner: number, grantee: number) => store.getGrant(cid(circle), uid(owner), uid(grantee));
const give = async (store: CircleStore, circle: number | string, owner: number, grantee: number, categories: readonly string[], now = NOW) => must(await store.setGrant(cid(circle), uid(owner), uid(grantee), categories, now, GRANT_LIMITS));

function grantCases(): readonly CircleStoreCase[] {
  const G = (name: string, run: CircleStoreCase['run']): CircleStoreCase => ({ name: `grants: ${name}`, group: 'grants', run });
  return [
    G('a grant round-trips, with its categories in plain code-unit order and its time', async (store) => {
      await trio(store);
      const made = await give(store, 1, 2, 3, ['zebra', 'apple', 'Mango'], NOW + 5);
      assert.deepEqual(made, { circleId: cid(1), ownerId: uid(2), granteeId: uid(3), categories: ['Mango', 'apple', 'zebra'], updatedAt: NOW + 5 });
      assert.deepEqual(await grantOf(store, 1, 2, 3), made);
    }),
    G('setting a grant replaces the whole set, it does not merge', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a', 'b', 'c'], NOW + 1);
      const second = await give(store, 1, 2, 3, ['c', 'd'], NOW + 2);
      assert.deepEqual(second?.categories, ['c', 'd']);
      assert.equal(second?.updatedAt, NOW + 2);
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['c', 'd']);
    }),
    G('an empty set is a withdrawal: no grant remains and the answer is ok with nothing', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a']);
      const r = await store.setGrant(cid(1), uid(2), uid(3), [], NOW, GRANT_LIMITS);
      assert.deepEqual(r, { ok: true, value: undefined });
      assert.equal(await grantOf(store, 1, 2, 3), undefined);
      assert.deepEqual((await allPages((p) => store.listGrantsBy(cid(1), uid(2), p))).length, 0);
    }),
    G('duplicates are collapsed', async (store) => {
      await trio(store);
      assert.deepEqual((await give(store, 1, 2, 3, ['a', 'b', 'a', 'a']))?.categories, ['a', 'b']);
    }),
    G('a grant is one direction: sharing with someone does not share back, and each pair is its own grant', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a']);
      assert.equal(await grantOf(store, 1, 3, 2), undefined);
      await give(store, 1, 3, 2, ['b']);
      await give(store, 1, 2, 1, ['c']);
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['a']);
      assert.deepEqual((await grantOf(store, 1, 3, 2))?.categories, ['b']);
      assert.deepEqual((await grantOf(store, 1, 2, 1))?.categories, ['c']);
    }),
    G('both people must be current members of the circle, and the circle must exist', async (store) => {
      await trio(store);
      assert.equal(code(await store.setGrant(cid(1), uid(9), uid(3), ['a'], NOW, GRANT_LIMITS)), 'NOT_FOUND');
      assert.equal(code(await store.setGrant(cid(1), uid(2), uid(9), ['a'], NOW, GRANT_LIMITS)), 'NOT_FOUND');
      assert.equal(code(await store.setGrant(cid(9), uid(2), uid(3), ['a'], NOW, GRANT_LIMITS)), 'NOT_FOUND');
      assert.equal(code(await store.setGrant(cid(1), uid(9), uid(3), [], NOW, GRANT_LIMITS)), 'NOT_FOUND'); // even a withdrawal
      assert.equal((await allPages((p) => store.listGrantsBy(cid(1), uid(2), p))).length, 0);
    }),
    G('a grant to oneself is refused, naming granteeId', async (store) => {
      await trio(store);
      const r = await store.setGrant(cid(1), uid(2), uid(2), ['a'], NOW, GRANT_LIMITS);
      assert.equal(code(r), 'INVALID_INPUT');
      assert.equal(r.ok ? undefined : r.error.field, 'granteeId');
      assert.equal(await grantOf(store, 1, 2, 2), undefined);
    }),
    G('a category is an id of 1 to 256 characters: empty, longer, or not text is refused naming categories, and nothing changes', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['keep']);
      for (const bad of [[''], ['x'.repeat(257)], ['ok', ''], [5 as unknown as string], [null as unknown as string]]) {
        const r = await store.setGrant(cid(1), uid(2), uid(3), bad, NOW, GRANT_LIMITS);
        assert.equal(code(r), 'INVALID_INPUT', JSON.stringify(bad).slice(0, 30));
        assert.equal(r.ok ? undefined : r.error.field, 'categories');
      }
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['keep']);
      assert.equal((await give(store, 1, 2, 3, ['x'.repeat(256)]))?.categories[0]?.length, 256);
      assert.equal((await give(store, 1, 2, 3, ['😀'.repeat(256)]))?.categories[0]?.length, 512); // 256 characters, counted as characters
      assert.equal(code(await store.setGrant(cid(1), uid(2), uid(3), ['😀'.repeat(257)], NOW, GRANT_LIMITS)), 'INVALID_INPUT');
    }),
    G('category ids are opaque: spaces, capitals, markup, slashes, emoji and CJK round-trip unchanged', async (store) => {
      await trio(store);
      const ids = ['a/b?c=d&e#f %é😀<b>..', ' spaces ', 'Capitals', '日本語', '..', 'x'.repeat(256)];
      const made = await give(store, 1, 2, 3, ids);
      assert.deepEqual(made?.categories, SORTED(ids));
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, SORTED(ids));
    }),
    G('the store does not look at any graph: a category it has never heard of is accepted', async (store) => {
      await trio(store);
      assert.deepEqual((await give(store, 1, 2, 3, ['no-such-category-anywhere']))?.categories, ['no-such-category-anywhere']);
    }),
    G('at most the limit: exactly the limit is accepted, one more is LIMIT_REACHED and changes nothing, and collapsed duplicates do not count', async (store) => {
      await trio(store);
      const ids = Array.from({ length: 200 }, (_, i) => `cat-${String(i).padStart(3, '0')}`);
      assert.equal((await give(store, 1, 2, 3, ids))?.categories.length, 200);
      assert.equal((await give(store, 1, 2, 3, [...ids, ...ids]))?.categories.length, 200);
      const r = await store.setGrant(cid(1), uid(2), uid(3), [...ids, 'one-more'], NOW, GRANT_LIMITS);
      assert.equal(code(r), 'LIMIT_REACHED');
      assert.equal((await grantOf(store, 1, 2, 3))?.categories.length, 200);
      assert.equal(code(await store.setGrant(cid(1), uid(2), uid(3), ids, NOW, { maxCategoriesPerGrant: 199 })), 'LIMIT_REACHED');
    }),
    G('copies in and out: changing what was passed or returned changes nothing stored', async (store) => {
      await trio(store);
      const input = ['a', 'b'];
      const made = await give(store, 1, 2, 3, input);
      input.push('c');
      (made?.categories as string[]).push('z');
      const read = await grantOf(store, 1, 2, 3);
      (read?.categories as string[]).push('y');
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['a', 'b']);
    }),
    G('what I share lists one grant per grantee by grantee id, in pages, stable and without other circles, owners or grantees', async (store) => {
      await circleWith(store, 1, ['member', 'member', 'member', 'member']);
      await circleWith(store, 2, ['member']);
      for (const g of [5, 3, 4, 2]) await give(store, 1, 1, g, [`for-${g}`]);
      await give(store, 1, 2, 3, ['not-mine']);
      await give(store, 2, 1, 2, ['other-circle']);
      const mine = await allPages((p) => store.listGrantsBy(cid(1), uid(1), p), 2);
      assert.deepEqual(mine.map((g) => g.granteeId), [uid(2), uid(3), uid(4), uid(5)]);
      assert.deepEqual(mine.map((g) => g.categories[0]), ['for-2', 'for-3', 'for-4', 'for-5']);
      const first = await store.listGrantsBy(cid(1), uid(1), { limit: 2, cursor: null });
      assert.equal(first.items.length, 2);
      assert.notEqual(first.nextCursor, null);
      const exact = await store.listGrantsBy(cid(1), uid(1), { limit: 4, cursor: null });
      assert.equal(exact.nextCursor, null);
      assert.deepEqual((await store.listGrantsBy(cid(9), uid(1), { limit: 5, cursor: null })).items, []);
    }),
    G('what is shared with me lists one grant per owner by owner id', async (store) => {
      await circleWith(store, 1, ['member', 'member', 'member']);
      for (const o of [4, 2, 3]) await give(store, 1, o, 1, [`from-${o}`]);
      await give(store, 1, 1, 2, ['mine-to-2']);
      const toMe = await allPages((p) => store.listGrantsTo(cid(1), uid(1), p), 2);
      assert.deepEqual(toMe.map((g) => g.ownerId), [uid(2), uid(3), uid(4)]);
      assert.deepEqual(toMe.map((g) => g.categories[0]), ['from-2', 'from-3', 'from-4']);
      assert.equal((await allPages((p) => store.listGrantsTo(cid(1), uid(2), p))).length, 1);
    }),
    G('a listing refuses a limit that is not a positive whole number and a cursor it did not give', async (store) => {
      await trio(store);
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        assert.ok((await thrown(() => store.listGrantsBy(cid(1), uid(2), { limit, cursor: null }))) instanceof RangeError, `by ${limit}`);
        assert.ok((await thrown(() => store.listGrantsTo(cid(1), uid(2), { limit, cursor: null }))) instanceof RangeError, `to ${limit}`);
      }
      assert.ok((await thrown(() => store.listGrantsBy(cid(1), uid(2), { limit: 5, cursor: 'not-a-cursor' }))) instanceof RangeError);
      assert.ok((await thrown(() => store.listGrantsTo(cid(1), uid(2), { limit: 5, cursor: 'not-a-cursor' }))) instanceof RangeError);
    }),
    G('withdrawing removes one grant and says whether there was one', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a']);
      await give(store, 1, 2, 1, ['b']);
      assert.equal(await store.withdrawGrant(cid(1), uid(2), uid(3)), true);
      assert.equal(await store.withdrawGrant(cid(1), uid(2), uid(3)), false);
      assert.equal(await grantOf(store, 1, 2, 3), undefined);
      assert.deepEqual((await grantOf(store, 1, 2, 1))?.categories, ['b']);
      assert.equal(await store.withdrawGrant(cid(9), uid(2), uid(3)), false);
    }),
    G('leaving a circle ends every grant the person made or held there, and only there', async (store) => {
      await trio(store, 1);
      await trio(store, 2);
      for (const c of [1, 2]) {
        await give(store, c, 2, 3, ['x']);
        await give(store, c, 3, 2, ['y']);
        await give(store, c, 1, 2, ['z']);
      }
      assert.deepEqual(must(await store.removeMember(cid(1), uid(2))), true);
      assert.equal(await grantOf(store, 1, 2, 3), undefined);
      assert.equal(await grantOf(store, 1, 3, 2), undefined);
      assert.equal(await grantOf(store, 1, 1, 2), undefined);
      assert.equal((await allPages((p) => store.listGrantsBy(cid(1), uid(2), p))).length, 0);
      assert.equal((await allPages((p) => store.listGrantsTo(cid(1), uid(2), p))).length, 0);
      for (const [o, g] of [[2, 3], [3, 2], [1, 2]]) assert.ok(await grantOf(store, 2, o as number, g as number), `circle 2 grant ${o}->${g} stays`);
    }),
    G('other people\'s grants in the same circle stay when someone leaves', async (store) => {
      await circleWith(store, 1, ['member', 'member', 'member']);
      await give(store, 1, 2, 3, ['a']);
      await give(store, 1, 3, 4, ['b']);
      must(await store.removeMember(cid(1), uid(4)));
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['a']);
      assert.equal(await grantOf(store, 1, 3, 4), undefined);
    }),
    G('someone who leaves and is invited back has no grants: nothing is resurrected', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a']);
      await give(store, 1, 3, 2, ['b']);
      must(await store.removeMember(cid(1), uid(2)));
      must(await store.createInvitation(invitation('back', 1, 'user2'), LIMITS, NOW));
      must(await store.acceptInvitation(iid('back'), uid(2), 'user2', NOW + 9, LIMITS));
      assert.equal(await grantOf(store, 1, 2, 3), undefined);
      assert.equal(await grantOf(store, 1, 3, 2), undefined);
    }),
    G('a refused removal (the only owner) leaves the grants alone', async (store) => {
      await trio(store);
      await give(store, 1, 1, 2, ['a']);
      await give(store, 1, 2, 1, ['b']);
      assert.equal(code(await store.removeMember(cid(1), uid(1))), 'LAST_OWNER');
      assert.deepEqual((await grantOf(store, 1, 1, 2))?.categories, ['a']);
      assert.deepEqual((await grantOf(store, 1, 2, 1))?.categories, ['b']);
    }),
    G('a role change keeps every grant: roles carry no access', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a']);
      must(await store.changeRole(cid(1), uid(2), 'observer'));
      must(await store.changeRole(cid(1), uid(3), 'manager'));
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['a']);
      assert.equal(await grantOf(store, 1, 3, 2), undefined);
    }),
    G('deleting the circle ends every grant in it, and a new circle starts with none', async (store) => {
      await trio(store, 1);
      await trio(store, 2);
      await give(store, 1, 2, 3, ['a']);
      await give(store, 2, 2, 3, ['b']);
      assert.equal(await store.deleteCircle(cid(1)), true);
      assert.equal(await grantOf(store, 1, 2, 3), undefined);
      assert.equal((await allPages((p) => store.listGrantsBy(cid(1), uid(2), p))).length, 0);
      assert.deepEqual((await grantOf(store, 2, 2, 3))?.categories, ['b']);
    }),
    G('removing a person (an account gone) ends their grants in every circle, including one they solely owned and one that is dissolved', async (store) => {
      await trio(store, 1); // user 1 owns; user 2 and 3 are members
      await circleWith(store, 2); // user 1 alone: dissolved
      await trio(store, 3);
      await give(store, 1, 1, 2, ['a']);
      await give(store, 1, 2, 1, ['b']);
      await give(store, 1, 2, 3, ['stays']);
      await give(store, 3, 1, 3, ['c']);
      await give(store, 3, 3, 1, ['d']);
      const out = await store.removeUser(uid(1), 'user1');
      assert.ok(out.handedOver.includes(cid(1)) && out.dissolved.includes(cid(2)));
      for (const c of [1, 3]) for (const [o, g] of [[1, 2], [2, 1], [1, 3], [3, 1]]) assert.equal(await grantOf(store, c, o as number, g as number), undefined, `circle ${c} ${o}->${g}`);
      assert.deepEqual((await grantOf(store, 1, 2, 3))?.categories, ['stays']);
    }),
    G('a person removed twice changes nothing more', async (store) => {
      await trio(store);
      await give(store, 1, 2, 3, ['a']);
      await store.removeUser(uid(9), 'user9');
      await store.removeUser(uid(3), 'user3');
      await store.removeUser(uid(3), 'user3');
      assert.equal(await grantOf(store, 1, 2, 3), undefined);
    }),
    G('simultaneous replacements of one grant leave exactly one of them, never a mixture', async (store) => {
      await trio(store);
      const sets = Array.from({ length: 8 }, (_, i) => [`s${i}-a`, `s${i}-b`]);
      await Promise.all(sets.map((set, i) => store.setGrant(cid(1), uid(2), uid(3), set, NOW + i, GRANT_LIMITS)));
      const kept = (await grantOf(store, 1, 2, 3))?.categories ?? [];
      assert.ok(sets.some((set) => JSON.stringify(set) === JSON.stringify(kept)), `kept ${JSON.stringify(kept)}`);
    }),
    G('a grant racing with the person leaving: afterwards there is no grant, whichever happened first', async (store) => {
      for (let round = 0; round < 6; round++) {
        const c = 10 + round;
        await trio(store, c);
        await Promise.all([store.setGrant(cid(c), uid(2), uid(3), ['a'], NOW, GRANT_LIMITS), store.removeMember(cid(c), uid(3))]);
        assert.equal(await grantOf(store, c, 2, 3), undefined, `round ${round}`);
        assert.equal((await allPages((p) => store.listGrantsTo(cid(c), uid(3), p))).length, 0);
      }
    }),
    G('a grant racing with the circle being deleted leaves nothing behind', async (store) => {
      for (let round = 0; round < 6; round++) {
        const c = 30 + round;
        await trio(store, c);
        await Promise.all([store.setGrant(cid(c), uid(2), uid(3), ['a'], NOW, GRANT_LIMITS), store.deleteCircle(cid(c))]);
        assert.equal(await grantOf(store, c, 2, 3), undefined, `round ${round}`);
      }
    }),
    G('two stores share no grants', async (store, makeAnother) => {
      const other = await makeAnother();
      await trio(store);
      await trio(other);
      await give(store, 1, 2, 3, ['a']);
      assert.equal(await grantOf(other, 1, 2, 3), undefined);
    }),
  ];
}

// ---- join links (R-023)

const hashOf = (n: number | string): string => String(n).padStart(64, '0').replace(/[^0-9a-f]/g, 'a').slice(-64);
const lid = (n: number | string): string => `j${pad(n)}`;
const JOIN_LIMITS = { maxLiveLinksPerCircle: 20 };
const joinRecord = (n: number | string, circle: number | string = 1, extra: Partial<JoinLinkRecord> = {}): JoinLinkRecord => ({ id: lid(n), circleId: cid(circle), tokenHash: hashOf(n), role: 'member', label: `Link ${n}`, createdBy: uid(1), createdAt: NOW, expiresAt: NOW + 7 * DAY, maxUses: 1, approval: false, ...extra });
const makeLink = async (store: CircleStore, n: number | string, circle: number | string = 1, extra: Partial<JoinLinkRecord> = {}, now = NOW) => must(await store.createJoinLink(joinRecord(n, circle, extra), JOIN_LIMITS, now));
const joinBy = (store: CircleStore, n: number | string, user: number, now = NOW + 10, limits: { maxCirclesPerUser: number; maxMembersPerCircle: number } = LIMITS) => store.joinWithLink(hashOf(n), uid(user), now, limits);
const linksOf = (store: CircleStore, circle: number | string = 1, now = NOW + 10) => allPages((p) => store.listJoinLinks(cid(circle), now, p));
const usesOf = async (store: CircleStore, n: number | string, circle: number | string = 1): Promise<number | undefined> => (await linksOf(store, circle)).find((l) => l.id === lid(n))?.uses;
const MISS = 'no such join link';

function joinLinkCases(): readonly CircleStoreCase[] {
  const J = (name: string, run: CircleStoreCase['run']): CircleStoreCase => ({ name: `join links: ${name}`, group: 'joinlinks', run });
  return [
    J('a link round-trips every field with no uses yet, and never carries its hash', async (store) => {
      await circleWith(store, 1);
      const made = await makeLink(store, 1, 1, { role: 'observer', label: 'For the club', maxUses: 5, approval: true, createdAt: NOW + 3, expiresAt: NOW + 50 });
      const expected = { id: lid(1), circleId: cid(1), role: 'observer', label: 'For the club', createdBy: uid(1), createdAt: NOW + 3, expiresAt: NOW + 50, maxUses: 5, uses: 0, approval: true };
      assert.deepEqual(made, expected);
      assert.deepEqual(await store.getJoinLinkByHash(hashOf(1), NOW + 4), expected);
      assert.deepEqual(await linksOf(store), [expected]);
      for (const shown of [made, await store.getJoinLinkByHash(hashOf(1), NOW + 4), ...(await linksOf(store))]) assert.equal(JSON.stringify(shown).includes(hashOf(1)), false);
      assert.equal('tokenHash' in (made as object), false);
    }),
    J('a link for a missing circle is not found, and a link may offer only member or observer', async (store) => {
      assert.equal(code(await store.createJoinLink(joinRecord(1, 9), JOIN_LIMITS, NOW)), 'NOT_FOUND');
      await circleWith(store, 1);
      for (const role of ['owner', 'manager', 'admin', '', 'OBSERVER'] as const) {
        const refused = await store.createJoinLink(joinRecord(2, 1, { role: role as 'member' }), JOIN_LIMITS, NOW);
        assert.equal(code(refused), 'INVALID_INPUT', role);
        assert.equal((refused as { error: { field?: string } }).error.field, 'role');
      }
      assert.deepEqual(await linksOf(store), []);
      assert.equal((await makeLink(store, 3, 1, { role: 'member' })).role, 'member');
      assert.equal((await makeLink(store, 4, 1, { role: 'observer' })).role, 'observer');
    }),
    J('the number of uses must be a whole number from 1 to 100', async (store) => {
      await circleWith(store, 1);
      for (const maxUses of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const refused = await store.createJoinLink(joinRecord(1, 1, { maxUses }), JOIN_LIMITS, NOW);
        assert.equal(code(refused), 'INVALID_INPUT', String(maxUses));
        assert.equal((refused as { error: { field?: string } }).error.field, 'uses');
      }
      assert.equal((await makeLink(store, 2, 1, { maxUses: 1 })).maxUses, 1);
      assert.equal((await makeLink(store, 3, 1, { maxUses: 100 })).maxUses, 100);
    }),
    J('a hash must be 64 lower-case hex characters, and an id or hash cannot be used twice', async (store) => {
      await circleWith(store, 1);
      for (const tokenHash of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) assert.equal(code(await store.createJoinLink(joinRecord(1, 1, { tokenHash }), JOIN_LIMITS, NOW)), 'INVALID_INPUT', tokenHash);
      await makeLink(store, 1);
      assert.equal(code(await store.createJoinLink(joinRecord(1, 1, { tokenHash: hashOf(2) }), JOIN_LIMITS, NOW)), 'CONFLICT');
      assert.equal(code(await store.createJoinLink({ ...joinRecord(2), tokenHash: hashOf(1) }, JOIN_LIMITS, NOW)), 'CONFLICT');
      await circleWith(store, 2);
      assert.equal(code(await store.createJoinLink({ ...joinRecord(3, 2), tokenHash: hashOf(1) }, JOIN_LIMITS, NOW)), 'CONFLICT');
      assert.equal((await linksOf(store)).length, 1);
    }),
    J('a link is live while now is before its expiry, and a miss is the same whatever the reason', async (store) => {
      await circleWith(store, 1, ['member', 'member']);
      await makeLink(store, 1, 1, { expiresAt: NOW + 100 });
      assert.notEqual(await store.getJoinLinkByHash(hashOf(1), NOW + 99), undefined);
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW + 100), undefined);
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW + 5000), undefined);
      assert.equal(await store.getJoinLinkByHash(hashOf('nobody'), NOW), undefined);
      assert.equal(await store.getJoinLinkByHash('', NOW), undefined);
      assert.deepEqual(await linksOf(store, 1, NOW + 100), []);
    }),
    J('every kind of miss when joining is the same not-found answer', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await makeLink(store, 1, 1, { expiresAt: NOW + 100 }); // expires
      await makeLink(store, 2, 1); // revoked below
      await makeLink(store, 3, 1); // used up below
      await makeLink(store, 4, 2); // circle deleted below
      assert.equal(await store.revokeJoinLink(lid(2), cid(1), NOW), true);
      must(await joinBy(store, 3, 20, NOW + 1));
      await store.deleteCircle(cid(2));
      const answers = [await joinBy(store, 'unknown', 21, NOW + 200), await joinBy(store, 1, 21, NOW + 200), await joinBy(store, 2, 21, NOW + 200), await joinBy(store, 3, 21, NOW + 200), await joinBy(store, 4, 21, NOW + 200)];
      for (const a of answers) {
        assert.equal(code(a), 'NOT_FOUND');
        assert.deepEqual(a, answers[0]);
      }
      assert.equal((answers[0] as { error: { message: string } }).error.message, MISS);
      assert.equal(await store.membershipOf(cid(1), uid(21)), undefined);
    }),
    J('listing shows only live links of that circle, by id, in pages, never another circle\'s', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      for (const n of [5, 3, 9, 1, 7]) await makeLink(store, n);
      await makeLink(store, 20, 2);
      await makeLink(store, 21, 1, { expiresAt: NOW + 5 });
      assert.deepEqual((await linksOf(store)).map((l) => l.id), [1, 3, 5, 7, 9].map(lid));
      assert.deepEqual((await linksOf(store, 2)).map((l) => l.id), [lid(20)]);
      assert.deepEqual(await linksOf(store, 9), []);
      const first = await store.listJoinLinks(cid(1), NOW + 10, { limit: 5, cursor: null });
      assert.equal(first.nextCursor, null);
      assert.equal(first.items.length, 5);
    }),
    J('revoking removes a live link of that circle only, and says whether there was one', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await makeLink(store, 1);
      await makeLink(store, 2, 2);
      assert.equal(await store.revokeJoinLink(lid(1), cid(2), NOW), false);
      assert.notEqual(await store.getJoinLinkByHash(hashOf(1), NOW), undefined);
      assert.equal(await store.revokeJoinLink(lid(1), cid(1), NOW), true);
      assert.equal(await store.revokeJoinLink(lid(1), cid(1), NOW), false);
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW), undefined);
      assert.equal(code(await joinBy(store, 1, 5)), 'NOT_FOUND');
      assert.notEqual(await store.getJoinLinkByHash(hashOf(2), NOW), undefined);
      await makeLink(store, 3, 1, { expiresAt: NOW + 5 });
      assert.equal(await store.revokeJoinLink(lid(3), cid(1), NOW + 5), false);
    }),
    J('the circle may have only so many live links, and dead ones never count and are cleared', async (store) => {
      await circleWith(store, 1);
      const two = { maxLiveLinksPerCircle: 2 };
      must(await store.createJoinLink(joinRecord(1, 1, { expiresAt: NOW + 50 }), two, NOW));
      must(await store.createJoinLink(joinRecord(2), two, NOW));
      assert.equal(code(await store.createJoinLink(joinRecord(3), two, NOW)), 'LIMIT_REACHED');
      assert.equal((await linksOf(store)).length, 2);
      must(await store.createJoinLink(joinRecord(3), two, NOW + 60)); // link 1 has expired and does not count
      assert.deepEqual((await linksOf(store, 1, NOW + 60)).map((l) => l.id), [lid(2), lid(3)]);
      must(await joinBy(store, 2, 7, NOW + 61)); // link 2 is used up and does not count either
      must(await store.createJoinLink(joinRecord(4), two, NOW + 62));
      assert.deepEqual((await linksOf(store, 1, NOW + 62)).map((l) => l.id), [lid(3), lid(4)]);
      await circleWith(store, 2);
      must(await store.createJoinLink(joinRecord(5, 2), two, NOW)); // another circle has its own count
    }),
    J('joining adds a member at the link\'s role at that time, and counts one use', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { role: 'observer', maxUses: 3 });
      const outcome = must(await joinBy(store, 1, 5, NOW + 77));
      assert.equal(outcome.joined, true);
      assert.deepEqual(outcome.membership, { circleId: cid(1), userId: uid(5), role: 'observer', joinedAt: NOW + 77 });
      assert.deepEqual(await store.membershipOf(cid(1), uid(5)), outcome.membership);
      assert.equal(await usesOf(store, 1), 1);
      await makeLink(store, 2, 1, { role: 'member' });
      assert.equal(must(await joinBy(store, 2, 6)).membership.role, 'member');
    }),
    J('a link that needs approval adds nobody and counts nothing when used to join directly', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { approval: true, maxUses: 2 });
      const refused = await joinBy(store, 1, 5);
      assert.equal(code(refused), 'CONFLICT');
      assert.equal(await store.membershipOf(cid(1), uid(5)), undefined);
      assert.equal(await usesOf(store, 1), 0);
    }),
    J('someone already in keeps their role and costs no use, even through an observer link', async (store) => {
      await circleWith(store, 1, ['manager']);
      await makeLink(store, 1, 1, { role: 'observer' });
      for (const user of [1, 2]) {
        const outcome = must(await joinBy(store, 1, user));
        assert.equal(outcome.joined, false);
      }
      assert.equal(await roleOf(store, 1, 1), 'owner');
      assert.equal(await roleOf(store, 1, 2), 'manager');
      assert.equal(await usesOf(store, 1), 0);
      assert.equal(must(await joinBy(store, 1, 5)).joined, true); // the one use is still there
    }),
    J('a one-use link makes one member; the next person gets the same miss as for a made-up link', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1);
      must(await joinBy(store, 1, 5));
      const second = await joinBy(store, 1, 6);
      assert.equal(code(second), 'NOT_FOUND');
      assert.deepEqual(second, await joinBy(store, 'unknown', 6));
      assert.equal(await store.membershipOf(cid(1), uid(6)), undefined);
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW + 10), undefined);
    }),
    J('a link with several uses allows exactly that many different people', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { maxUses: 3 });
      for (const user of [5, 6, 7]) must(await joinBy(store, 1, user));
      assert.equal(code(await joinBy(store, 1, 8)), 'NOT_FOUND');
      assert.equal((await rolesOf(store, 1)).length, 4);
    }),
    J('a link is not usable at its expiry time, and is at the moment before', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { expiresAt: NOW + 100, maxUses: 2 });
      must(await joinBy(store, 1, 5, NOW + 99));
      assert.equal(code(await joinBy(store, 1, 6, NOW + 100)), 'NOT_FOUND');
    }),
    J('a full circle or a person in the most circles allowed is a limit, and no use is consumed', async (store) => {
      await circleWith(store, 1, ['member']);
      await makeLink(store, 1, 1, { maxUses: 2 });
      const tight = { maxCirclesPerUser: 20, maxMembersPerCircle: 2 };
      assert.equal(code(await joinBy(store, 1, 5, NOW + 10, tight)), 'LIMIT_REACHED');
      assert.equal(await store.membershipOf(cid(1), uid(5)), undefined);
      assert.equal(await usesOf(store, 1), 0);
      assert.equal(must(await joinBy(store, 1, 2, NOW + 10, tight)).joined, false); // already in a full circle: fine
      assert.equal(await usesOf(store, 1), 0);
      await circleWith(store, 2);
      await circleWith(store, 3);
      await store.createJoinLink(joinRecord(9, 3), JOIN_LIMITS, NOW);
      const crowded = { maxCirclesPerUser: 1, maxMembersPerCircle: 50 };
      assert.equal(code(await joinBy(store, 9, 1, NOW + 10, { maxCirclesPerUser: 2, maxMembersPerCircle: 50 })), undefined); // user 1 is in circles 1, 2, 3 already
      await makeLink(store, 10, 1, { maxUses: 1 });
      assert.equal(code(await joinBy(store, 10, 7, NOW + 10, crowded)), undefined); // user 7 has no circle yet, so one is fine
      await circleWith(store, 4);
      await makeLink(store, 11, 4);
      assert.equal(code(await joinBy(store, 11, 7, NOW + 10, crowded)), 'LIMIT_REACHED');
      assert.equal(await usesOf(store, 11, 4), 0);
      assert.equal(await store.membershipOf(cid(4), uid(7)), undefined);
    }),
    J('eight people joining at once by a one-use link make exactly one member', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1);
      const results = await Promise.all([10, 11, 12, 13, 14, 15, 16, 17].map((user) => joinBy(store, 1, user)));
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal(results.filter((r) => code(r) === 'NOT_FOUND').length, 7);
      assert.equal((await rolesOf(store, 1)).length, 2);
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW + 10), undefined);
    }),
    J('eight people at once by a three-use link make exactly three members', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { maxUses: 3 });
      const results = await Promise.all([10, 11, 12, 13, 14, 15, 16, 17].map((user) => joinBy(store, 1, user)));
      assert.equal(results.filter((r) => r.ok).length, 3);
      assert.equal((await rolesOf(store, 1)).length, 4);
    }),
    J('the same person joining six times at once is one member and one use', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { maxUses: 5 });
      const results = await Promise.all([0, 1, 2, 3, 4, 5].map(() => joinBy(store, 1, 5)));
      assert.equal(results.filter((r) => r.ok && r.value.joined).length, 1);
      assert.equal(results.filter((r) => r.ok).length, 6);
      assert.equal(await usesOf(store, 1), 1);
    }),
    J('five people at once for the last place of a circle fill it once, and only that join is counted', async (store) => {
      await circleWith(store, 1, ['member']);
      await makeLink(store, 1, 1, { maxUses: 10 });
      const results = await Promise.all([10, 11, 12, 13, 14].map((user) => joinBy(store, 1, user, NOW + 10, { maxCirclesPerUser: 20, maxMembersPerCircle: 3 })));
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal(results.filter((r) => code(r) === 'LIMIT_REACHED').length, 4);
      assert.equal((await rolesOf(store, 1)).length, 3);
      assert.equal(await usesOf(store, 1), 1);
    }),
    J('deleting the circle removes its links, and the link then misses', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await makeLink(store, 1, 1, { maxUses: 5 });
      await makeLink(store, 2, 2);
      await store.deleteCircle(cid(1));
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW), undefined);
      assert.deepEqual(await linksOf(store, 1), []);
      assert.equal(code(await joinBy(store, 1, 5)), 'NOT_FOUND');
      assert.notEqual(await store.getJoinLinkByHash(hashOf(2), NOW), undefined);
      await circleWith(store, 1); // the same id again is a new circle with no links
      assert.deepEqual(await linksOf(store, 1), []);
      assert.equal(await store.getJoinLinkByHash(hashOf(1), NOW), undefined);
    }),
    J('the creator leaving, being removed or their account going does not revoke their links', async (store) => {
      await circleWith(store, 1, ['manager', 'owner']);
      await makeLink(store, 1, 1, { createdBy: uid(2), maxUses: 5 });
      must(await store.removeMember(cid(1), uid(2)));
      assert.equal(must(await joinBy(store, 1, 5)).joined, true);
      await makeLink(store, 2, 1, { createdBy: uid(3), maxUses: 5 });
      await store.removeUser(uid(3), 'user3');
      assert.equal(must(await joinBy(store, 2, 6)).joined, true);
      assert.equal((await linksOf(store)).length, 2);
    }),
    J('what the store gives back is a copy, and changing it changes nothing', async (store) => {
      await circleWith(store, 1);
      const made = await makeLink(store, 1, 1, { maxUses: 2 });
      (made as { label: string }).label = 'changed';
      (made as { uses: number }).uses = 99;
      const found = (await store.getJoinLinkByHash(hashOf(1), NOW)) as { label: string; uses: number };
      assert.equal(found.label, 'Link 1');
      assert.equal(found.uses, 0);
      found.uses = 50;
      const listed = await linksOf(store);
      (listed[0] as { uses: number }).uses = 70;
      assert.equal(await usesOf(store, 1), 0);
      const joined = must(await joinBy(store, 1, 5));
      (joined.membership as { role: string }).role = 'owner';
      assert.equal(await roleOf(store, 1, 5), 'member');
    }),
    J('two stores share no join links', async (store, makeAnother) => {
      const other = await makeAnother();
      await circleWith(store, 1);
      await circleWith(other, 1);
      await makeLink(store, 1);
      assert.equal(await other.getJoinLinkByHash(hashOf(1), NOW), undefined);
      assert.equal(code(await joinBy(other, 1, 5)), 'NOT_FOUND');
    }),
  ];
}

// ---- join requests (R-023 D13)

const rid = (n: number | string): string => `r${pad(n)}`;
const REQ_LIMITS = { maxPendingPerCircle: 20, ttlMs: 7 * DAY };
const approvalLink = (store: CircleStore, n: number | string, circle: number | string = 1, extra: Partial<JoinLinkRecord> = {}) => makeLink(store, n, circle, { approval: true, ...extra });
const ask = (store: CircleStore, link: number | string, user: number, request: number | string = `${link}-${user}`, now = NOW + 10, limits: { maxPendingPerCircle: number; ttlMs: number } = REQ_LIMITS) => store.requestJoin(hashOf(link), rid(request), uid(user), now, limits);
const pending = (store: CircleStore, circle: number | string = 1, now = NOW + 10) => allPages((p) => store.listJoinRequests(cid(circle), now, p));
const approve = (store: CircleStore, request: number | string, circle: number | string = 1, now = NOW + 20, limits: { maxCirclesPerUser: number; maxMembersPerCircle: number } = LIMITS) => store.approveJoinRequest(rid(request), cid(circle), now, limits);
const asked = <T extends { state: string }>(result: Result<T, CirclesError>): T => must(result);

function joinRequestCases(): readonly CircleStoreCase[] {
  const R = (name: string, run: CircleStoreCase['run']): CircleStoreCase => ({ name: `join requests: ${name}`, group: 'joinrequests', run });
  return [
    R('asking makes one waiting request at the link\'s role, counts the use, and adds nobody', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { role: 'observer', maxUses: 3 });
      const outcome = asked(await ask(store, 1, 5, 'x', NOW + 10));
      assert.equal(outcome.state, 'requested');
      const expected: JoinRequest = { id: rid('x'), circleId: cid(1), userId: uid(5), role: 'observer', createdAt: NOW + 10, expiresAt: NOW + 10 + 7 * DAY };
      assert.deepEqual((outcome as { request: JoinRequest }).request, expected);
      assert.equal(await store.membershipOf(cid(1), uid(5)), undefined);
      assert.deepEqual(await pending(store), [expected]);
      assert.equal(await usesOf(store, 1), 1);
    }),
    R('a link that needs no approval cannot be used to ask, and counts nothing', async (store) => {
      await circleWith(store, 1);
      await makeLink(store, 1, 1, { approval: false });
      assert.equal(code(await ask(store, 1, 5)), 'CONFLICT');
      assert.deepEqual(await pending(store), []);
      assert.equal(await usesOf(store, 1), 0);
    }),
    R('every kind of miss when asking is the same not-found answer', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await approvalLink(store, 1, 1, { expiresAt: NOW + 100 });
      await approvalLink(store, 2);
      await approvalLink(store, 3);
      await approvalLink(store, 4, 2);
      assert.equal(await store.revokeJoinLink(lid(2), cid(1), NOW), true);
      must(await ask(store, 3, 20, 'used', NOW + 1));
      await store.deleteCircle(cid(2));
      const answers = [await ask(store, 'unknown', 21, 'a', NOW + 200), await ask(store, 1, 21, 'b', NOW + 200), await ask(store, 2, 21, 'c', NOW + 200), await ask(store, 3, 21, 'd', NOW + 200), await ask(store, 4, 21, 'e', NOW + 200)];
      for (const a of answers) {
        assert.equal(code(a), 'NOT_FOUND');
        assert.deepEqual(a, answers[0]);
      }
      assert.equal((answers[0] as { error: { message: string } }).error.message, MISS);
      assert.deepEqual((await pending(store, 1, NOW + 200)).map((r) => r.id), [rid('used')]); // only the one real request exists
    }),
    R('someone already in the circle is told so: no request and no use', async (store) => {
      await circleWith(store, 1, ['observer']);
      await approvalLink(store, 1, 1, { maxUses: 2 });
      for (const user of [1, 2]) {
        const outcome = asked(await ask(store, 1, user));
        assert.equal(outcome.state, 'member');
      }
      assert.equal(await roleOf(store, 1, 2), 'observer');
      assert.deepEqual(await pending(store), []);
      assert.equal(await usesOf(store, 1), 0);
    }),
    R('asking again while waiting gives the same request back and counts nothing, nor extends the wait', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 2 });
      const first = asked(await ask(store, 1, 5, 'first', NOW + 10)) as { request: JoinRequest };
      const again = asked(await ask(store, 1, 5, 'second', NOW + 5000));
      assert.equal(again.state, 'waiting');
      assert.deepEqual((again as { request: JoinRequest }).request, first.request);
      assert.equal((await pending(store, 1, NOW + 5000)).length, 1);
      assert.equal(await usesOf(store, 1, 1), 1);
    }),
    R('the use is counted when asking: a one-use link serves one person, the next gets the miss', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1);
      must(await ask(store, 1, 5));
      const second = await ask(store, 1, 6);
      assert.equal(code(second), 'NOT_FOUND');
      assert.deepEqual(second, await ask(store, 'unknown', 6));
      assert.equal((await pending(store)).length, 1);
    }),
    R('a circle holds only so many waiting requests; lapsed ones do not count and are cleared; no use is spent on a refusal', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 10 });
      const two = { maxPendingPerCircle: 2, ttlMs: 100 };
      must(await ask(store, 1, 5, 'a', NOW + 10, two));
      must(await ask(store, 1, 6, 'b', NOW + 50, two));
      assert.equal(code(await ask(store, 1, 7, 'c', NOW + 60, two)), 'LIMIT_REACHED');
      assert.equal(await usesOf(store, 1), 2);
      must(await ask(store, 1, 7, 'c', NOW + 115, two)); // request a has lapsed (10 + 100)
      assert.deepEqual((await pending(store, 1, NOW + 115)).map((r) => r.id), [rid('b'), rid('c')]);
      await circleWith(store, 2);
      await approvalLink(store, 2, 2, { maxUses: 10 });
      must(await ask(store, 2, 5, 'd', NOW + 10, two)); // another circle has its own count
    }),
    R('a request waits while now is before its expiry and then lapses: it is not listed, cannot be approved, and the person may ask again', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 3 });
      const short = { maxPendingPerCircle: 20, ttlMs: 100 };
      must(await ask(store, 1, 5, 'a', NOW + 10, short));
      assert.equal((await pending(store, 1, NOW + 109)).length, 1);
      assert.equal((await pending(store, 1, NOW + 110)).length, 0);
      assert.equal((await store.listJoinRequestsBy(uid(5), NOW + 110, { limit: 5, cursor: null })).items.length, 0);
      const late = await approve(store, 'a', 1, NOW + 110);
      assert.equal(code(late), 'NOT_FOUND');
      assert.equal(await store.membershipOf(cid(1), uid(5)), undefined);
      const again = asked(await ask(store, 1, 5, 'b', NOW + 120, short));
      assert.equal(again.state, 'requested');
      assert.equal(await usesOf(store, 1), 2);
    }),
    R('a circle\'s waiting requests are listed by id in pages, and a person\'s own across circles', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await approvalLink(store, 1, 1, { maxUses: 10 });
      await approvalLink(store, 2, 2, { maxUses: 10 });
      for (const [n, user] of [[5, 15], [3, 16], [9, 17], [1, 18], [7, 19]] as const) must(await ask(store, 1, user, n));
      must(await ask(store, 2, 15, 4));
      assert.deepEqual((await pending(store)).map((r) => r.id), [1, 3, 5, 7, 9].map(rid));
      assert.deepEqual((await pending(store, 2)).map((r) => r.id), [rid(4)]);
      assert.deepEqual(await pending(store, 9), []);
      assert.deepEqual((await allPages((p) => store.listJoinRequestsBy(uid(15), NOW + 10, p))).map((r) => r.id), [rid(4), rid(5)]);
      assert.deepEqual(await allPages((p) => store.listJoinRequestsBy(uid(99), NOW + 10, p)), []);
    }),
    R('approving adds the member at the request\'s role at that time, closes the request, and spends no further use', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { role: 'observer', maxUses: 2 });
      must(await ask(store, 1, 5, 'a'));
      const membership = must(await approve(store, 'a', 1, NOW + 33));
      assert.deepEqual(membership, { circleId: cid(1), userId: uid(5), role: 'observer', joinedAt: NOW + 33 });
      assert.deepEqual(await store.membershipOf(cid(1), uid(5)), membership);
      assert.deepEqual(await pending(store), []);
      assert.equal(await usesOf(store, 1), 1);
      assert.equal(code(await approve(store, 'a')), 'NOT_FOUND');
    }),
    R('only the request\'s own circle can approve or decline it, and the answer is the one not-found', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await approvalLink(store, 1);
      must(await ask(store, 1, 5, 'a'));
      const wrong = await approve(store, 'a', 2);
      assert.equal(code(wrong), 'NOT_FOUND');
      assert.deepEqual(wrong, await approve(store, 'nothing', 1));
      assert.equal((wrong as { error: { message: string } }).error.message, 'no such join request');
      assert.equal(await store.declineJoinRequest(rid('a'), cid(2), NOW + 20), false);
      assert.equal((await pending(store)).length, 1);
      assert.equal(await store.membershipOf(cid(2), uid(5)), undefined);
    }),
    R('a full circle or a person in the most circles allowed leaves the request waiting, then it can be approved', async (store) => {
      await circleWith(store, 1, ['member']);
      await approvalLink(store, 1, 1, { maxUses: 3 });
      must(await ask(store, 1, 5, 'a'));
      const tight = { maxCirclesPerUser: 20, maxMembersPerCircle: 2 };
      assert.equal(code(await approve(store, 'a', 1, NOW + 20, tight)), 'LIMIT_REACHED');
      assert.equal(await store.membershipOf(cid(1), uid(5)), undefined);
      assert.equal((await pending(store)).length, 1);
      assert.equal(must(await approve(store, 'a', 1, NOW + 21)).userId, uid(5));
      await circleWith(store, 2);
      await circleWith(store, 3);
      await approvalLink(store, 7, 3);
      must(await ask(store, 7, 2, 'b'));
      const crowded = { maxCirclesPerUser: 2, maxMembersPerCircle: 50 };
      assert.equal(code(await approve(store, 'b', 3, NOW + 20, crowded)), undefined); // user 2 is in circle 1 and 3 is their second
      await circleWith(store, 4);
      await approvalLink(store, 8, 4);
      must(await ask(store, 8, 2, 'c'));
      assert.equal(code(await approve(store, 'c', 4, NOW + 20, crowded)), 'LIMIT_REACHED');
      assert.equal((await pending(store, 4)).length, 1);
    }),
    R('someone who has joined another way meanwhile keeps their role, and the request is closed', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1);
      must(await ask(store, 1, 5, 'a'));
      must(await store.createInvitation(invitation(7, 1, 'user5', 'manager'), LIMITS, NOW));
      must(await store.acceptInvitation(iid(7), uid(5), 'user5', NOW + 11, LIMITS));
      const result = must(await approve(store, 'a'));
      assert.equal(result.role, 'manager');
      assert.equal(await roleOf(store, 1, 5), 'manager');
      assert.deepEqual(await pending(store), []);
    }),
    R('declining removes a waiting request, says whether there was one, and does not give the use back', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 2 });
      must(await ask(store, 1, 5, 'a', NOW + 10, { maxPendingPerCircle: 20, ttlMs: 100 }));
      assert.equal(await store.declineJoinRequest(rid('a'), cid(1), NOW + 20), true);
      assert.equal(await store.declineJoinRequest(rid('a'), cid(1), NOW + 20), false);
      assert.deepEqual(await pending(store), []);
      assert.equal(await store.membershipOf(cid(1), uid(5)), undefined);
      assert.equal(await usesOf(store, 1), 1);
      must(await ask(store, 1, 6, 'b', NOW + 10, { maxPendingPerCircle: 20, ttlMs: 100 }));
      assert.equal(await store.declineJoinRequest(rid('b'), cid(1), NOW + 110), false); // lapsed
    }),
    R('eight approvals of one request at once add exactly one member', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1);
      must(await ask(store, 1, 5, 'a'));
      const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => approve(store, 'a')));
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal(results.filter((r) => code(r) === 'NOT_FOUND').length, 7);
      assert.equal((await rolesOf(store, 1)).length, 2);
    }),
    R('approving and declining at once give one winner', async (store) => {
      for (let round = 0; round < 6; round++) {
        const c = 10 + round;
        await circleWith(store, c);
        await approvalLink(store, c, c);
        must(await ask(store, c, 5, `r${c}`));
        const [a, d] = await Promise.all([approve(store, `r${c}`, c), store.declineJoinRequest(rid(`r${c}`), cid(c), NOW + 20)]);
        const added = (await store.membershipOf(cid(c), uid(5))) !== undefined;
        assert.equal(a.ok, added, `round ${round}`);
        assert.equal(a.ok !== d, true, `round ${round}`);
      }
    }),
    R('the same person asking six times at once makes one request and counts one use', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 5 });
      const results = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => ask(store, 1, 5, `a${n}`)));
      assert.equal(results.filter((r) => r.ok && r.value.state === 'requested').length, 1);
      assert.equal(results.filter((r) => r.ok && r.value.state === 'waiting').length, 5);
      assert.equal((await pending(store)).length, 1);
      assert.equal(await usesOf(store, 1), 1);
    }),
    R('eight people asking at once on a one-use link make exactly one request', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1);
      const results = await Promise.all([10, 11, 12, 13, 14, 15, 16, 17].map((user) => ask(store, 1, user)));
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal(results.filter((r) => code(r) === 'NOT_FOUND').length, 7);
      assert.equal((await pending(store)).length, 1);
    }),
    R('a request id cannot be used twice', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 3 });
      must(await ask(store, 1, 5, 'dup'));
      assert.equal(code(await ask(store, 1, 6, 'dup')), 'CONFLICT');
      assert.equal(await usesOf(store, 1), 1);
      assert.equal((await pending(store)).length, 1);
    }),
    R('revoking the link leaves the requests already made, at their role', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { role: 'observer', maxUses: 3 });
      must(await ask(store, 1, 5, 'a'));
      assert.equal(await store.revokeJoinLink(lid(1), cid(1), NOW), true);
      assert.equal((await pending(store)).length, 1);
      assert.equal(must(await approve(store, 'a')).role, 'observer');
    }),
    R('deleting the circle removes its requests, and a person\'s account going removes theirs only', async (store) => {
      await circleWith(store, 1);
      await circleWith(store, 2);
      await approvalLink(store, 1, 1, { maxUses: 5 });
      await approvalLink(store, 2, 2, { maxUses: 5 });
      must(await ask(store, 1, 5, 'a'));
      must(await ask(store, 1, 6, 'b'));
      must(await ask(store, 2, 5, 'c'));
      await store.removeUser(uid(5), 'user5');
      assert.deepEqual((await pending(store, 1)).map((r) => r.id), [rid('b')]);
      assert.deepEqual(await pending(store, 2), []);
      assert.deepEqual(await allPages((p) => store.listJoinRequestsBy(uid(5), NOW + 10, p)), []);
      await store.deleteCircle(cid(1));
      assert.deepEqual(await pending(store, 1), []);
      assert.deepEqual(await allPages((p) => store.listJoinRequestsBy(uid(6), NOW + 10, p)), []);
      await circleWith(store, 1); // the same id again is a new circle: nothing of the old one comes back
      assert.deepEqual(await pending(store, 1), []);
      assert.deepEqual(await allPages((p) => store.listJoinRequestsBy(uid(6), NOW + 10, p)), []);
      assert.equal(code(await approve(store, 'b')), 'NOT_FOUND');
      assert.equal(await store.membershipOf(cid(1), uid(6)), undefined);
    }),
    R('what the store gives back is a copy, and changing it changes nothing', async (store) => {
      await circleWith(store, 1);
      await approvalLink(store, 1, 1, { maxUses: 3 });
      const made = asked(await ask(store, 1, 5, 'a')) as { request: { role: string } };
      made.request.role = 'owner';
      const listed = await pending(store);
      (listed[0] as { role: string }).role = 'owner';
      const waitingAgain = asked(await ask(store, 1, 5, 'b')) as { request: { role: string } };
      waitingAgain.request.role = 'owner';
      assert.equal(must(await approve(store, 'a')).role, 'member');
    }),
    R('two stores share no requests', async (store, makeAnother) => {
      const other = await makeAnother();
      await circleWith(store, 1);
      await circleWith(other, 1);
      await approvalLink(store, 1);
      await approvalLink(other, 1);
      must(await ask(store, 1, 5, 'a'));
      assert.deepEqual(await pending(other), []);
      assert.equal(code(await approve(other, 'a')), 'NOT_FOUND');
    }),
  ];
}
