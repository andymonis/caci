import assert from 'node:assert/strict';
import type { CirclesError } from '../errors.js';
import type { Result } from '../result.js';
import type { CircleStore, Invitation, InvitationRecord, Membership } from '../store.js';
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
  ];
}
