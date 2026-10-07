import { describe, expect, it } from 'vitest';
import { addMember, code, must, T0, world } from './controller.test-util.js';

const DAY = 86_400_000;
const ann = 'tok-ann';
const bob = 'tok-bob';
const cat = 'tok-cat';
const dan = 'tok-dan';
const eve = 'tok-eve';
const INVITED = { ok: true, value: { invited: true } };

/** A circle owned by ann with bob (manager), cat (member), dan (observer). */
async function team(extra: Parameters<typeof world>[0] = {}) {
  const w = world(extra);
  const made = await must(w.controller.create(ann, { name: 'Team' }));
  await addMember(w, made.id, 'bob', 'manager');
  await addMember(w, made.id, 'cat', 'member');
  await addMember(w, made.id, 'dan', 'observer');
  return { w, id: made.id };
}
const open = async (w: ReturnType<typeof world>, id: string) => (await must(w.controller.invitations(ann, id, { limit: 100 }))).items;

describe('inviting', () => {
  it('an owner may invite anyone to any role, and the name is stored in lower case with the time it ends', async () => {
    const { w, id } = await team();
    for (const role of ['owner', 'manager', 'member', 'observer']) expect(await w.controller.invite(ann, id, { username: `Zed-${role}`, role })).toEqual(INVITED);
    const listed = await open(w, id);
    expect(listed.map((i) => [i.username, i.role]).sort()).toEqual([['zed-manager', 'manager'], ['zed-member', 'member'], ['zed-observer', 'observer'], ['zed-owner', 'owner']]);
    expect(listed.every((i) => i.createdAt === T0 && i.expiresAt === T0 + 7 * DAY)).toBe(true);
    expect(listed.every((i) => i.invitedBy.userId === w.id('ann') && i.invitedBy.displayName === 'DISPLAY ANN')).toBe(true);
    expect(Object.isFrozen(((await w.controller.invite(ann, id, { username: 'zed-more', role: 'member' })) as { value: object }).value)).toBe(true);
  });

  it('a manager may invite members and observers, but not owners or managers', async () => {
    const { w, id } = await team();
    expect(await w.controller.invite(bob, id, { username: 'newbie', role: 'member' })).toEqual(INVITED);
    expect(await w.controller.invite(bob, id, { username: 'watcher', role: 'observer' })).toEqual(INVITED);
    for (const role of ['owner', 'manager']) expect(await w.controller.invite(bob, id, { username: 'boss', role })).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'your role in this circle does not allow that' } });
    expect((await open(w, id)).map((i) => i.username).sort()).toEqual(['newbie', 'watcher']);
  });

  it('members and observers cannot invite anyone, and permission is decided before the input is looked at', async () => {
    const { w, id } = await team();
    for (const token of [cat, dan]) {
      expect(await code(w.controller.invite(token, id, { username: 'newbie', role: 'member' }))).toBe('FORBIDDEN');
      expect(await code(w.controller.invite(token, id, { garbage: true }))).toBe('FORBIDDEN');
      expect(await code(w.controller.invite(token, id, undefined))).toBe('FORBIDDEN');
    }
    expect(await open(w, id)).toEqual([]);
  });

  it('a stranger gets the answer for a circle that does not exist', async () => {
    const { w, id } = await team();
    const missing = await w.controller.invite(ann, 'c0000000000000000', { username: 'x', role: 'member' });
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } });
    expect(await w.controller.invite(eve, id, { username: 'x', role: 'member' })).toEqual(missing);
    expect(await w.controller.invite(eve, id, { garbage: 1 })).toEqual(missing);
  });

  it('the answer is the same whether the account exists, is unknown, is already in, is the inviter, or was invited before; nobody is looked up', async () => {
    const { w, id } = await team();
    w.lookups.length = 0;
    const answers = await Promise.all([
      w.controller.invite(ann, id, { username: 'eve', role: 'member' }), // an account that exists
      w.controller.invite(ann, id, { username: 'no-such-person', role: 'member' }),
      w.controller.invite(ann, id, { username: 'cat', role: 'member' }), // already in
      w.controller.invite(ann, id, { username: 'ann', role: 'member' }), // herself
      w.controller.invite(ann, id, { username: 'eve', role: 'member' }), // again
      w.controller.invite(ann, id, { username: 'EVE', role: 'observer' }),
    ]);
    for (const a of answers) expect(a).toEqual(INVITED);
    expect(w.lookups).toEqual([]);
    // and what the inviter can list afterwards does not say which names are real
    const names = (await open(w, id)).map((i) => i.username).sort();
    expect(names).toEqual(['ann', 'cat', 'eve', 'no-such-person']);
  });

  it('a repeat for the same name takes the new role and keeps one invitation', async () => {
    const { w, id } = await team();
    await w.controller.invite(ann, id, { username: 'eve', role: 'member' });
    const first = (await open(w, id))[0];
    w.now.value = T0 + 5000;
    await w.controller.invite(ann, id, { username: 'Eve', role: 'manager' });
    const after = await open(w, id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first?.id, role: 'manager', createdAt: T0, expiresAt: T0 + 5000 + 7 * DAY });
  });

  it('bad input is INVALID_INPUT naming the field, and any other field is refused by name', async () => {
    const { w, id } = await team();
    expect(await w.controller.invite(ann, id, { role: 'member' })).toMatchObject({ error: { code: 'INVALID_INPUT', field: 'username' } });
    expect(await w.controller.invite(ann, id, { username: 'x', role: 'member' })).toMatchObject({ error: { field: 'username' } });
    expect(await w.controller.invite(ann, id, { username: 'has space', role: 'member' })).toMatchObject({ error: { field: 'username' } });
    expect(await w.controller.invite(ann, id, { username: 'okname' })).toMatchObject({ error: { field: 'role' } });
    expect(await w.controller.invite(ann, id, { username: 'okname', role: 'admin' })).toMatchObject({ error: { field: 'role' } });
    for (const field of ['email', 'circleId', 'invitedBy', 'expiresAt', 'id']) expect(await w.controller.invite(ann, id, { username: 'okname', role: 'member', [field]: 'x' })).toMatchObject({ error: { field } });
    for (const bad of [null, undefined, 'x', 5, []]) expect(await w.controller.invite(ann, id, bad)).toMatchObject({ error: { field: 'body' } });
    expect(await open(w, id)).toEqual([]);
  });

  it('needs a session', async () => {
    const { w, id } = await team();
    expect(await w.controller.invite('nonsense', id, { username: 'okname', role: 'member' })).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    expect(await open(w, id)).toEqual([]);
  });

  it('a circle holds only so many open invitations (a repeat does not use another place), and the cap is settable', async () => {
    const { w, id } = await team({ limits: { maxOpenInvitationsPerCircle: 3 } });
    for (const name of ['aaa', 'bbb', 'ccc']) await must(w.controller.invite(ann, id, { username: name, role: 'member' }));
    expect(await code(w.controller.invite(ann, id, { username: 'ddd', role: 'member' }))).toBe('LIMIT_REACHED');
    expect(await w.controller.invite(ann, id, { username: 'AAA', role: 'observer' })).toEqual(INVITED);
    w.now.value = T0 + 8 * DAY; // all three have expired
    expect(await w.controller.invite(ann, id, { username: 'ddd', role: 'member' })).toEqual(INVITED);
    const dflt = await team({ limits: { invitationsPerHour: 1000 } }); // only the circle's own cap is under test
    for (let i = 0; i < 50; i++) await must(dflt.w.controller.invite(ann, dflt.id, { username: `person${i}`.padEnd(5, 'x'), role: 'member' }));
    expect(await code(dflt.w.controller.invite(ann, dflt.id, { username: 'one-too-many', role: 'member' }))).toBe('LIMIT_REACHED');
  });

  it('one person may send only so many an hour; refusals for other reasons do not use the allowance', async () => {
    const { w, id } = await team({ limits: { invitationsPerHour: 2 } });
    await w.controller.invite(cat, id, { username: 'aaa', role: 'member' }); // forbidden: does not count
    await w.controller.invite(ann, id, { garbage: 1 }); // invalid: does not count
    await must(w.controller.invite(ann, id, { username: 'aaa', role: 'member' }));
    await must(w.controller.invite(ann, id, { username: 'bbb', role: 'member' }));
    const refused = await w.controller.invite(ann, id, { username: 'ccc', role: 'member' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
    expect((refused as { error: { retryAfterMs: number } }).error.retryAfterMs).toBe(3_600_000);
    await must(w.controller.invite(bob, id, { username: 'ccc', role: 'member' })); // someone else is not affected
    w.now.value = T0 + 1_800_000;
    expect((await w.controller.invite(ann, id, { username: 'ccc', role: 'member' }))).toMatchObject({ error: { code: 'THROTTLED', retryAfterMs: 1_800_000 } });
    w.now.value = T0 + 3_600_000;
    expect(await w.controller.invite(ann, id, { username: 'ccc', role: 'member' })).toEqual(INVITED);
  });

  it('they last as many days as set', async () => {
    const { w, id } = await team({ limits: { invitationDays: 2 } });
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    expect((await open(w, id))[0]?.expiresAt).toBe(T0 + 2 * DAY);
  });

  it('draws another invitation id if the first is taken, and gives up after three tries', async () => {
    let n = 0;
    const ids = ['i0000000000000001', 'i0000000000000001', 'i0000000000000002'];
    const { w, id } = await team({ newInvitationId: () => ids[n++] as string });
    await must(w.controller.invite(ann, id, { username: 'aaa', role: 'member' }));
    await must(w.controller.invite(ann, id, { username: 'bbb', role: 'member' }));
    expect((await open(w, id)).map((i) => i.id).sort()).toEqual(['i0000000000000001', 'i0000000000000002']);
    let drawn = 0;
    const stuck = await team({ newInvitationId: () => (drawn++, 'i0000000000000009') });
    await must(stuck.w.controller.invite(ann, stuck.id, { username: 'aaa', role: 'member' }));
    drawn = 0;
    expect(await code(stuck.w.controller.invite(ann, stuck.id, { username: 'bbb', role: 'member' }))).toBe('STORAGE_ERROR');
    expect(drawn).toBe(3);
  });
});

describe('the circle\'s open invitations', () => {
  it('owners and managers see them, by id, and page through them; members and observers are forbidden; strangers are not told', async () => {
    const { w, id } = await team();
    for (const name of ['aaa', 'bbb', 'ccc', 'ddd', 'eee']) await must(w.controller.invite(name === 'ccc' ? bob : ann, id, { username: name, role: 'member' }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: { readonly items: readonly { id: string; username: string }[]; nextCursor: string | null } = await must(w.controller.invitations(bob, id, { limit: 2, cursor }));
      seen.push(...page.items.map((i) => i.username));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.sort()).toEqual(['aaa', 'bbb', 'ccc', 'ddd', 'eee']);
    expect(await code(w.controller.invitations(cat, id))).toBe('FORBIDDEN');
    expect(await code(w.controller.invitations(dan, id))).toBe('FORBIDDEN');
    expect(await code(w.controller.invitations(eve, id))).toBe('NOT_FOUND');
    expect(await w.controller.invitations(ann, id, { limit: 0 })).toMatchObject({ error: { field: 'limit' } });
    expect(await w.controller.invitations(ann, id, { cursor: 'bad' })).toMatchObject({ error: { field: 'cursor' } });
  });

  it('shows who sent each one, and leaves out expired ones and other circles\' ones', async () => {
    const { w, id } = await team();
    const other = await must(w.controller.create(bob, { name: 'Other' }));
    await must(w.controller.invite(bob, id, { username: 'aaa', role: 'member' }));
    await must(w.controller.invite(bob, other.id, { username: 'zzz', role: 'member' }));
    const listed = await open(w, id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.invitedBy).toEqual({ userId: w.id('bob'), displayName: 'DISPLAY BOB' });
    w.now.value = T0 + 7 * DAY;
    expect(await open(w, id)).toEqual([]);
    expect(JSON.stringify(listed)).not.toMatch(/email|example\.com|password|hash/);
  });
});

describe('withdrawing an invitation', () => {
  it('an owner withdraws any; a manager only those for members and observers; it can no longer be accepted', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'aaa', role: 'owner' }));
    await must(w.controller.invite(ann, id, { username: 'bbb', role: 'manager' }));
    await must(w.controller.invite(ann, id, { username: 'ccc', role: 'member' }));
    await must(w.controller.invite(ann, id, { username: 'ddd', role: 'observer' }));
    const byName = Object.fromEntries((await open(w, id)).map((i) => [i.username, i.id]));
    expect(await code(w.controller.revokeInvitation(bob, id, byName.aaa))).toBe('FORBIDDEN');
    expect(await code(w.controller.revokeInvitation(bob, id, byName.bbb))).toBe('FORBIDDEN');
    expect(await open(w, id)).toHaveLength(4);
    expect(await must(w.controller.revokeInvitation(bob, id, byName.ccc))).toBe(true);
    expect(await must(w.controller.revokeInvitation(bob, id, byName.ddd))).toBe(true);
    expect(await must(w.controller.revokeInvitation(ann, id, byName.aaa))).toBe(true);
    expect(await must(w.controller.revokeInvitation(ann, id, byName.bbb))).toBe(true);
    expect(await open(w, id)).toEqual([]);
  });

  it('members and observers cannot, a stranger is not told the circle exists, and a made-up, other-circle, repeated or non-text id is the same "no such invitation"', async () => {
    const { w, id } = await team();
    const other = await must(w.controller.create(ann, { name: 'Other' }));
    await must(w.controller.invite(ann, id, { username: 'aaa', role: 'member' }));
    await must(w.controller.invite(ann, other.id, { username: 'bbb', role: 'member' }));
    const [mine] = await open(w, id);
    const [theirs] = await must(w.controller.invitations(ann, other.id)).then((p) => p.items);
    expect(await code(w.controller.revokeInvitation(cat, id, mine?.id))).toBe('FORBIDDEN');
    expect(await code(w.controller.revokeInvitation(cat, id, 'i0000000000000000'))).toBe('FORBIDDEN'); // before anything about the invitation is looked at
    expect(await code(w.controller.revokeInvitation(eve, id, mine?.id))).toBe('NOT_FOUND');
    const missing = await w.controller.revokeInvitation(ann, id, 'i0000000000000000');
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such invitation' } });
    expect(await w.controller.revokeInvitation(ann, id, theirs?.id)).toEqual(missing); // another circle's: untouched
    await must(w.controller.invite(ann, other.id, { username: 'ccc', role: 'owner' }));
    const ownerOne = (await must(w.controller.invitations(ann, other.id))).items.find((i) => i.role === 'owner');
    expect(await w.controller.revokeInvitation(bob, id, ownerOne?.id)).toEqual(missing); // not FORBIDDEN: what another circle holds is not hinted at
    for (const bad of [5, null, undefined, '', {}]) expect(await w.controller.revokeInvitation(ann, id, bad)).toEqual(missing);
    expect(await must(w.controller.revokeInvitation(ann, id, mine?.id))).toBe(true);
    expect(await w.controller.revokeInvitation(ann, id, mine?.id)).toEqual(missing);
    expect(await must(w.controller.invitations(ann, other.id)).then((p) => p.items)).toHaveLength(2); // bbb and the owner one: untouched
  });

  it('an expired invitation is "no such invitation"', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'aaa', role: 'member' }));
    const [i] = await open(w, id);
    w.now.value = T0 + 8 * DAY;
    expect(await code(w.controller.revokeInvitation(ann, id, i?.id))).toBe('NOT_FOUND');
  });
});

describe('my invitations', () => {
  it('shows the open invitations addressed to me, with the circle\'s name, the role, who sent it and when it ends, and nothing about anyone else', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'Eve', role: 'manager' }));
    await must(w.controller.invite(ann, id, { username: 'someone-else', role: 'member' }));
    const mine = await must(w.controller.myInvitations(eve));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toEqual({ id: mine.items[0]?.id, circle: { id, name: 'Team' }, role: 'manager', invitedBy: { displayName: 'DISPLAY ANN' }, createdAt: T0, expiresAt: T0 + 7 * DAY });
    expect(JSON.stringify(mine)).not.toContain(w.id('ann'));
    expect(Object.isFrozen(mine.items[0])).toBe(true);
    expect(await must(w.controller.myInvitations(ann))).toEqual({ items: [], nextCursor: null });
  });

  it('pages, hides expired ones and ones for circles that have gone, and refuses bad limits and cursors', async () => {
    const { w, id } = await team();
    const circles = [id];
    for (let i = 0; i < 3; i++) circles.push((await must(w.controller.create(bob, { name: `b${i}` }))).id);
    for (const c of circles) await must(w.controller.invite(c === id ? ann : bob, c, { username: 'eve', role: 'member' }));
    const names: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: { readonly items: readonly { circle: { name: string } }[]; nextCursor: string | null } = await must(w.controller.myInvitations(eve, { limit: 2, cursor }));
      names.push(...page.items.map((i) => i.circle.name));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(names.sort()).toEqual(['Team', 'b0', 'b1', 'b2']);
    await must(w.controller.delete(bob, circles[1] as string));
    expect((await must(w.controller.myInvitations(eve))).items).toHaveLength(3);
    w.now.value = T0 + 7 * DAY;
    expect((await must(w.controller.myInvitations(eve))).items).toEqual([]);
    expect(await w.controller.myInvitations(eve, { limit: 101 })).toMatchObject({ error: { field: 'limit' } });
    expect(await w.controller.myInvitations(eve, { cursor: 'x' })).toMatchObject({ error: { field: 'cursor' } });
  });

  it('an invitation to a name is seen by the account with that name, whichever case it was written in', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'EVE', role: 'observer' }));
    expect((await must(w.controller.myInvitations(eve))).items).toHaveLength(1);
  });

  it('needs a session', async () => {
    expect(await world().controller.myInvitations('nonsense')).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });
});

describe('accepting', () => {
  it('joins with the offered role at the time of accepting, shows the circle, and uses the invitation up', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'manager' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    w.now.value = T0 + 12345;
    const joined = await must(w.controller.accept(eve, i?.id));
    expect(joined).toMatchObject({ id, name: 'Team', role: 'manager', memberCount: 5 });
    expect(await w.store.membershipOf(id, w.id('eve'))).toEqual({ circleId: id, userId: w.id('eve'), role: 'manager', joinedAt: T0 + 12345 });
    expect(await code(w.controller.accept(eve, i?.id))).toBe('NOT_FOUND');
    expect((await must(w.controller.myInvitations(eve))).items).toEqual([]);
    expect(await open(w, id)).toEqual([]);
  });

  it('only the named account can: anyone else, a made-up id, a non-text id, an expired one and one for a circle that has gone are all the same "no such invitation"', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const other = await must(w.controller.create(ann, { name: 'Gone' }));
    await must(w.controller.invite(ann, other.id, { username: 'eve', role: 'member' }));
    const [first, second] = [...(await must(w.controller.myInvitations(eve))).items].sort((a, b) => (a.circle.name < b.circle.name ? 1 : -1));
    const missing = await w.controller.accept(eve, 'i0000000000000000');
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'no such invitation' } });
    for (const token of [bob, cat, dan, ann]) expect(await w.controller.accept(token, first?.id)).toEqual(missing);
    for (const bad of [5, null, undefined, '', {}, ['x']]) expect(await w.controller.accept(eve, bad)).toEqual(missing);
    expect(await w.store.membershipOf(id, w.id('bob'))).toMatchObject({ role: 'manager' }); // nothing happened to bob's place
    await must(w.controller.delete(ann, other.id));
    expect(await w.controller.accept(eve, second?.id)).toEqual(missing);
    w.now.value = T0 + 7 * DAY;
    expect(await w.controller.accept(eve, first?.id)).toEqual(missing);
  });

  it('a stranger cannot spend someone else\'s invitation by trying it', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    await w.controller.accept(bob, i?.id);
    await w.controller.decline(cat, i?.id);
    expect((await must(w.controller.myInvitations(eve))).items).toHaveLength(1);
    expect((await w.controller.accept(eve, i?.id)).ok).toBe(true);
  });

  it('a full circle refuses with LIMIT_REACHED and the invitation stays open for later', async () => {
    const { w, id } = await team({ limits: { maxMembersPerCircle: 4 } });
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    expect(await code(w.controller.accept(eve, i?.id))).toBe('LIMIT_REACHED');
    expect((await must(w.controller.myInvitations(eve))).items).toHaveLength(1);
    await must(w.controller.leave(dan, id));
    expect((await w.controller.accept(eve, i?.id)).ok).toBe(true);
  });

  it('a person in the most circles allowed is refused, and the invitation stays', async () => {
    const { w, id } = await team({ limits: { maxCirclesPerUser: 1 } });
    await must(w.controller.create(eve, { name: 'Evens' }));
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    expect(await code(w.controller.accept(eve, i?.id))).toBe('LIMIT_REACHED');
    expect((await must(w.controller.myInvitations(eve))).items).toHaveLength(1);
  });

  it('someone already in the circle keeps their role', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'cat', role: 'owner' }));
    const [i] = (await must(w.controller.myInvitations(cat))).items;
    expect(await must(w.controller.accept(cat, i?.id))).toMatchObject({ role: 'member' });
    expect((await must(w.controller.myInvitations(cat))).items).toEqual([]);
  });

  it('eight accepts of one invitation at the same moment make one membership', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    const results = await Promise.all(Array.from({ length: 8 }, () => w.controller.accept(eve, i?.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await must(w.controller.members(ann, id, { limit: 100 }))).items).toHaveLength(5);
  });

  it('needs a session', async () => {
    const { w } = await team();
    expect(await w.controller.accept('nonsense', 'i0000000000000001')).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });
});

describe('declining', () => {
  it('ends the invitation for good, and only for the one it is addressed to', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    expect(await code(w.controller.decline(bob, i?.id))).toBe('NOT_FOUND');
    expect(await code(w.controller.decline(eve, 'i0000000000000000'))).toBe('NOT_FOUND');
    for (const bad of [5, null, undefined, '']) expect(await code(w.controller.decline(eve, bad))).toBe('NOT_FOUND');
    expect(await must(w.controller.decline(eve, i?.id))).toBe(true);
    expect(await code(w.controller.decline(eve, i?.id))).toBe('NOT_FOUND');
    expect(await code(w.controller.accept(eve, i?.id))).toBe('NOT_FOUND');
    expect(await w.store.membershipOf(id, w.id('eve'))).toBeUndefined();
    expect(await open(w, id)).toEqual([]);
  });

  it('cannot undo a joining: an accepted invitation is gone', async () => {
    const { w, id } = await team();
    await must(w.controller.invite(ann, id, { username: 'eve', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations(eve))).items;
    await must(w.controller.accept(eve, i?.id));
    expect(await code(w.controller.decline(eve, i?.id))).toBe('NOT_FOUND');
    expect(await w.store.membershipOf(id, w.id('eve'))).toBeDefined();
  });

  it('needs a session', async () => {
    expect(await world().controller.decline('nonsense', 'i0000000000000001')).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
  });
});

describe('the defaults', () => {
  it('thirty invitations an hour, and the thirty-first is refused', async () => {
    const { w, id } = await team({ limits: { maxOpenInvitationsPerCircle: 100 } });
    for (let i = 0; i < 30; i++) await must(w.controller.invite(ann, id, { username: `person-${i}`, role: 'member' }));
    expect(await code(w.controller.invite(ann, id, { username: 'person-30', role: 'member' }))).toBe('THROTTLED');
  });

  it('fifty people to a circle: the fifty-first accept is refused', async () => {
    const names = Array.from({ length: 52 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const w = world({ people: names, limits: { maxCirclesPerUser: 100, invitationsPerHour: 1000 } });
    const made = await must(w.controller.create('tok-p00', { name: 'Big' }));
    for (const name of names.slice(1, 50)) await addMember(w, made.id, name, 'member');
    expect((await must(w.controller.members('tok-p00', made.id, { limit: 100 }))).items).toHaveLength(50);
    await must(w.controller.invite('tok-p00', made.id, { username: 'p50', role: 'member' }));
    const [i] = (await must(w.controller.myInvitations('tok-p50'))).items;
    expect(await code(w.controller.accept('tok-p50', i?.id))).toBe('LIMIT_REACHED');
    await must(w.controller.leave('tok-p49', made.id));
    expect((await w.controller.accept('tok-p50', i?.id)).ok).toBe(true);
  });

  it('an id that is not text never reaches the store when accepting, declining or withdrawing', async () => {
    const { createMemoryCircleStore } = await import('./memory-store.js');
    const base = createMemoryCircleStore();
    let asked = 0;
    const store = { ...base, acceptInvitation: async (...a: Parameters<typeof base.acceptInvitation>) => (asked++, base.acceptInvitation(...a)), declineInvitation: async (...a: Parameters<typeof base.declineInvitation>) => (asked++, base.declineInvitation(...a)), getInvitation: async (id: string) => (asked++, base.getInvitation(id)) };
    const w = world({ store });
    const made = await must(w.controller.create(ann, { name: 'x' }));
    for (const bad of [5, null, undefined, '', {}, ['x']]) {
      await w.controller.accept(ann, bad);
      await w.controller.decline(ann, bad);
      await w.controller.revokeInvitation(ann, made.id, bad);
    }
    expect(asked).toBe(0);
  });
});

describe('a circle forming, start to finish', () => {
  it('create, invite, accept, invite on, accept, and everyone sees the same people', async () => {
    const w = world();
    const circle = await must(w.controller.create(ann, { name: 'Neighbours' }));
    await must(w.controller.invite(ann, circle.id, { username: 'bob', role: 'manager' }));
    const [forBob] = (await must(w.controller.myInvitations(bob))).items;
    await must(w.controller.accept(bob, forBob?.id));
    await must(w.controller.invite(bob, circle.id, { username: 'cat', role: 'member' }));
    const [forCat] = (await must(w.controller.myInvitations(cat))).items;
    expect(forCat?.invitedBy.displayName).toBe('DISPLAY BOB');
    await must(w.controller.accept(cat, forCat?.id));
    for (const token of [ann, bob, cat]) {
      const roster = await must(w.controller.members(token, circle.id));
      expect(roster.items.map((m) => [m.username, m.role])).toEqual([['ann', 'owner'], ['bob', 'manager'], ['cat', 'member']]);
    }
    expect((await must(w.controller.list(cat))).items.map((c) => [c.name, c.role])).toEqual([['Neighbours', 'member']]);
  });
});

describe('failures', () => {
  it('a failing store is STORAGE_ERROR with a fixed message for every invitation method', async () => {
    const { createMemoryCircleStore } = await import('./memory-store.js');
    const base = createMemoryCircleStore();
    const broken = (pick: string) => new Proxy(base, { get: (target, key) => (key === pick ? async () => { throw new Error('secret path /var/db/users.db'); } : (target as never)[key]) });
    const calls: Array<[string, (c: ReturnType<typeof world>['controller'], id: string) => Promise<unknown>]> = [
      ['createInvitation', (c, id) => c.invite(ann, id, { username: 'okname', role: 'member' })],
      ['listInvitationsOfCircle', (c, id) => c.invitations(ann, id)],
      ['getInvitation', (c, id) => c.revokeInvitation(ann, id, 'i0000000000000001')],
      ['listInvitationsFor', (c) => c.myInvitations(ann)],
      ['acceptInvitation', (c) => c.accept(ann, 'i0000000000000001')],
      ['declineInvitation', (c) => c.decline(ann, 'i0000000000000001')],
    ];
    for (const [method, call] of calls) {
      const ok = world({ store: base });
      const made = await must(ok.controller.create(ann, { name: 'x' }));
      const w = world({ store: broken(method) });
      const result = (await call(w.controller, made.id)) as { ok: boolean; error?: unknown };
      expect(result.ok, method).toBe(false);
      expect(result.error, method).toEqual({ code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' });
    }
  });

  it('nonsense settings are refused with a TypeError', async () => {
    const { createCircleController } = await import('./controller.js');
    const { createMemoryCircleStore } = await import('./memory-store.js');
    const users = { resolve: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: '' } }) as never };
    for (const key of ['maxMembersPerCircle', 'maxOpenInvitationsPerCircle', 'invitationsPerHour', 'invitationDays'] as const) {
      for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => createCircleController({ users, directory: { get: async () => undefined }, store: createMemoryCircleStore(), limits: { [key]: bad } })).toThrow(TypeError);
    }
  });
});
