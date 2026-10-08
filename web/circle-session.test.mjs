import { describe, expect, it } from 'vitest';
import { checkInvite, createCircleSession } from './circle-session.js';

const C = 'c0000000000000001';
const U = (n) => `u${String(n).padStart(16, '0')}`;
const I = (n) => `i${String(n).padStart(16, '0')}`;
const circle = (role = 'owner', extra = {}) => ({ id: C, name: 'Team', role, memberCount: 2, createdAt: 1, updatedAt: 1, ...extra });
const member = (n, role = 'member') => ({ userId: U(n), username: `user${n}`, displayName: `User ${n}`, role, joinedAt: n });
const inv = (n, role = 'member') => ({ id: I(n), username: `guest${n}`, role, invitedBy: { userId: U(1), displayName: 'User 1' }, createdAt: 1, expiresAt: 2 });
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const page = (items, nextCursor = null) => okv({ items, nextCursor });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function fakeClient(script = {}) {
  const calls = [];
  const client = new Proxy({}, {
    get: (_, name) => (...args) => {
      calls.push({ name, args });
      const entry = script[name];
      const value = typeof entry === 'function' ? entry(...args) : Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
      return Promise.resolve(value).then((v) => v ?? okv({}));
    },
  });
  return { client, calls };
}
const names = (calls) => calls.map((c) => c.name);
const owner = (extra = {}) => fakeClient({ getCircle: okv(circle('owner')), listMembers: page([member(1, 'owner'), member(2)]), listInvitations: page([inv(1)]), ...extra });

describe('checking the invite form early', () => {
  it('trims and lower-cases the name, and offers only the roles allowed', () => {
    expect(checkInvite({ username: '  Bob  ', role: 'member' }, ['member', 'observer'])).toEqual({ ok: true, value: { username: 'bob', role: 'member' } });
    expect(checkInvite({ username: 'bob', role: 'owner' }, ['member', 'observer']).errors.role).toBeTruthy();
    expect(checkInvite({ username: 'bob', role: 'member' }, []).errors.role).toBeTruthy();
    expect(checkInvite({ username: 'bob' }, ['member']).errors.role).toBeTruthy();
    for (const u of ['', '  ', 'ab', 'a'.repeat(33), 'bad name', 'bob!', 'Bób', undefined, 5, null]) expect(checkInvite({ username: u, role: 'member' }, ['member']).errors.username, String(u)).toBeTruthy();
    expect(checkInvite({ username: 'a'.repeat(32), role: 'member' }, ['member']).ok).toBe(true);
    expect(checkInvite({ username: 'abc', role: 'member' }, ['member']).ok).toBe(true);
    expect(checkInvite({ username: 'a.b_c-d', role: 'member' }, ['member']).ok).toBe(true);
    expect(checkInvite(undefined, ['member']).ok).toBe(false);
    expect(checkInvite({ username: '', role: 'x' }, ['member']).errors).toHaveProperty('username');
    expect(checkInvite({ username: '', role: 'x' }, ['member']).errors).toHaveProperty('role');
  });
});

describe('opening a circle', () => {
  it('loads the circle, the roster and, for an owner, the open invitations; rows say who is me and what can be done to them', async () => {
    const { client, calls } = owner();
    const s = createCircleSession({ client });
    expect(s.getState()).toMatchObject({ status: 'idle', circle: null });
    const p = s.open(C, U(1));
    expect(s.getState()).toMatchObject({ status: 'loading', busy: true });
    expect(await p).toEqual({ ok: true });
    const st = s.getState();
    expect(st).toMatchObject({ status: 'loaded', circleId: C, circle: circle('owner'), busy: false, confirm: null });
    expect(st.controls).toEqual({ rename: true, delete: true, invite: true, leave: true });
    expect(st.rolesToOffer).toEqual(['owner', 'manager', 'member', 'observer']);
    expect(st.members.items.map((m) => [m.userId, m.self, m.controls])).toEqual([
      [U(1), true, { changeRole: false, remove: false }],
      [U(2), false, { changeRole: true, remove: true }],
    ]);
    expect(st.invitations).toMatchObject({ visible: true, items: [inv(1)] });
    expect(names(calls)).toEqual(['getCircle', 'listMembers', 'listInvitations']);
    expect(calls[1].args).toEqual([C, { limit: 50 }]);
  });

  it('a member does not load the invitations and has no management controls; a manager only member and observer', async () => {
    const m = fakeClient({ getCircle: okv(circle('member')), listMembers: page([member(1, 'owner'), member(2)]) });
    const s = createCircleSession({ client: m.client });
    await s.open(C, U(2));
    expect(names(m.calls)).toEqual(['getCircle', 'listMembers']);
    expect(s.getState().invitations).toMatchObject({ visible: false, items: [] });
    expect(s.getState().controls).toEqual({ rename: false, delete: false, invite: false, leave: true });
    expect(s.getState().members.items.every((x) => !x.controls.changeRole && !x.controls.remove)).toBe(true);

    const g = fakeClient({ getCircle: okv(circle('manager')), listMembers: page([member(1, 'owner'), member(2, 'manager'), member(3), member(4, 'observer')]), listInvitations: page([]) });
    const t = createCircleSession({ client: g.client });
    await t.open(C, U(2));
    expect(t.getState().rolesToOffer).toEqual(['member', 'observer']);
    expect(t.getState().members.items.map((x) => [x.userId, x.controls.changeRole, x.controls.remove])).toEqual([[U(1), false, false], [U(2), false, false], [U(3), true, true], [U(4), true, true]]);
  });

  it('a circle that cannot be found reads the same whatever the reason, with nothing else loaded', async () => {
    const { client, calls } = fakeClient({ getCircle: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    const s = createCircleSession({ client });
    expect(await s.open(C, U(1))).toMatchObject({ ok: false, kind: 'not-found' });
    expect(s.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.', circle: null });
    expect(names(calls)).toEqual(['getCircle']);
  });

  it('other failures show the service\'s words and keep the page on error', async () => {
    const { client } = fakeClient({ getCircle: bad('server', 'Down.') });
    const s = createCircleSession({ client });
    expect(await s.open(C, U(1))).toMatchObject({ ok: false, kind: 'server' });
    expect(s.getState()).toMatchObject({ status: 'error', message: 'Down.' });
  });

  it('a roster that fails to load is reported while the circle still shows', async () => {
    const { client } = owner({ listMembers: bad('network', 'Offline.') });
    const s = createCircleSession({ client });
    expect(await s.open(C, U(1))).toMatchObject({ ok: true, listProblem: 'Offline.' });
    expect(s.getState()).toMatchObject({ status: 'loaded', members: { items: [], error: 'Offline.' } });
  });

  it('an invitations list that fails is reported while the rest shows', async () => {
    const { client } = owner({ listInvitations: bad('server', 'Down.') });
    const s = createCircleSession({ client });
    expect(await s.open(C, U(1))).toMatchObject({ ok: true, listProblem: 'Down.' });
    expect(s.getState().invitations).toMatchObject({ visible: true, error: 'Down.', items: [] });
    expect(s.getState().members.items).toHaveLength(2);
  });

  it('a bad id never reaches a path (the client says not found) and the screen is gone', async () => {
    const { client } = fakeClient({ getCircle: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    const s = createCircleSession({ client });
    await s.open('../x', U(1));
    expect(s.getState().status).toBe('gone');
  });

  it('show more adds the next page of people; nothing is asked when there is no more', async () => {
    const { client, calls } = owner({ listMembers: [page([member(1, 'owner')], 'p2'), page([member(2)])] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(s.getState().members.nextCursor).toBe('p2');
    await s.moreMembers();
    expect(s.getState().members.items.map((m) => m.userId)).toEqual([U(1), U(2)]);
    expect(calls.filter((c) => c.name === 'listMembers')[1].args).toEqual([C, { limit: 50, cursor: 'p2' }]);
    await s.moreMembers();
    expect(calls.filter((c) => c.name === 'listMembers')).toHaveLength(2);
  });

  it('show more invitations does the same, and a failed one keeps what was shown', async () => {
    const { client, calls } = owner({ listInvitations: [page([inv(1)], 'q2'), page([inv(2)]), bad('server', 'Down.')] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    await s.moreInvitations();
    expect(s.getState().invitations.items.map((i) => i.id)).toEqual([I(1), I(2)]);
    await s.moreInvitations();
    expect(calls.filter((c) => c.name === 'listInvitations')).toHaveLength(2);
    const t = owner({ listInvitations: [page([inv(1)], 'q2'), bad('server', 'Down.')] });
    const u = createCircleSession({ client: t.client });
    await u.open(C, U(1));
    await u.moreInvitations();
    expect(u.getState().invitations).toMatchObject({ error: 'Down.' });
    expect(u.getState().invitations.items).toHaveLength(1);
  });

  it('snapshots are frozen', async () => {
    const { client } = owner();
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    const st = s.getState();
    expect(Object.isFrozen(st) && Object.isFrozen(st.members) && Object.isFrozen(st.members.items) && Object.isFrozen(st.members.items[0]) && Object.isFrozen(st.members.items[0].controls) && Object.isFrozen(st.invitations) && Object.isFrozen(st.invitations.items) && Object.isFrozen(st.rolesToOffer) && Object.isFrozen(st.controls)).toBe(true);
  });
});

describe('rename and describe', () => {
  it('checks early, sends both values (an empty description removes it) and shows the service\'s answer', async () => {
    const { client, calls } = owner({ updateCircle: okv(circle('owner', { name: 'New', updatedAt: 9 })) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.update({ name: '' })).toMatchObject({ ok: false, kind: 'invalid', errors: { name: expect.any(String) } });
    expect(names(calls)).not.toContain('updateCircle');
    expect(await s.update({ name: ' New ', description: '' })).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'updateCircle').args).toEqual([C, { name: 'New', description: null }]);
    expect(s.getState().circle).toMatchObject({ name: 'New', updatedAt: 9 });
    await s.update({ name: 'New', description: ' About ' });
    expect(calls.filter((c) => c.name === 'updateCircle')[1].args[1]).toEqual({ name: 'New', description: 'About' });
  });

  it('a field problem is shown beside its field and nothing changes', async () => {
    const { client } = owner({ updateCircle: bad('invalid', 'Too long.', { field: 'name' }) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.update({ name: 'x' })).toMatchObject({ ok: false, kind: 'invalid', message: 'Too long.', errors: { name: 'Too long.' } });
    expect(s.getState().circle.name).toBe('Team');
  });

  it('a refusal for lack of rights shows the service\'s words and refreshes the whole view (a demotion shows)', async () => {
    const { client, calls } = fakeClient({ getCircle: [okv(circle('manager')), okv(circle('member'))], listMembers: page([member(1, 'owner')]), listInvitations: page([]), updateCircle: bad('forbidden', 'Your role in this circle does not allow that.') });
    const s = createCircleSession({ client });
    await s.open(C, U(2));
    expect(s.getState().controls.rename).toBe(true);
    expect(await s.update({ name: 'New' })).toMatchObject({ ok: false, kind: 'forbidden', message: 'Your role in this circle does not allow that.' });
    expect(s.getState().circle.role).toBe('member');
    expect(s.getState().controls.rename).toBe(false);
    expect(s.getState().invitations).toMatchObject({ visible: false, items: [] });
    expect(names(calls)).toEqual(['getCircle', 'listMembers', 'listInvitations', 'updateCircle', 'getCircle', 'listMembers']);
  });

  it('a circle that has gone while editing becomes "gone"', async () => {
    const { client } = fakeClient({ getCircle: [okv(circle('owner')), bad('not-found', 'x', { what: 'circle' })], listMembers: page([]), listInvitations: page([]), updateCircle: bad('not-found', 'x', { what: 'circle' }) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    await s.update({ name: 'New' });
    expect(s.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.', circle: null });
  });
});

describe('inviting', () => {
  it('checks early; sends the clean name and role; the notice names the username and says nothing about the account; then reloads the invitations', async () => {
    const { client, calls } = owner({ invite: okv({ invited: true }), listInvitations: [page([]), page([inv(1), inv(2)])] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.invite({ username: 'x', role: 'member' })).toMatchObject({ ok: false, kind: 'invalid', errors: { username: expect.any(String) } });
    expect(names(calls)).not.toContain('invite');
    const r = await s.invite({ username: ' Bob ', role: 'manager' });
    expect(r).toEqual({ ok: true, notice: 'Invitation recorded for "bob".' });
    expect(r.notice.toLowerCase()).not.toMatch(/exist|account|found|sent to/);
    expect(calls.find((c) => c.name === 'invite').args).toEqual([C, { username: 'bob', role: 'manager' }]);
    expect(s.getState().invitations.items).toHaveLength(2);
  });

  it('the answer is the same for every name', async () => {
    const { client } = owner({ invite: okv({ invited: true }) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    const a = await s.invite({ username: 'someone', role: 'member' });
    const b = await s.invite({ username: 'nobody', role: 'member' });
    expect({ ...a, notice: '' }).toEqual({ ...b, notice: '' });
  });

  it('a manager cannot choose owner or manager (nothing is sent)', async () => {
    const { client, calls } = fakeClient({ getCircle: okv(circle('manager')), listMembers: page([]), listInvitations: page([]) });
    const s = createCircleSession({ client });
    await s.open(C, U(2));
    expect(await s.invite({ username: 'bob', role: 'owner' })).toMatchObject({ ok: false, errors: { role: expect.any(String) } });
    expect(await s.invite({ username: 'bob', role: 'manager' })).toMatchObject({ ok: false });
    expect(names(calls)).not.toContain('invite');
  });

  it('a member has nothing to offer', async () => {
    const { client, calls } = fakeClient({ getCircle: okv(circle('member')), listMembers: page([]) });
    const s = createCircleSession({ client });
    await s.open(C, U(2));
    expect(await s.invite({ username: 'bob', role: 'member' })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(names(calls)).not.toContain('invite');
  });

  it('the service\'s words show: a limit, a field, a throttle; a refusal for rights refreshes', async () => {
    for (const [error, kind] of [[bad('limit', 'That circle is full.'), 'limit'], [bad('throttled', 'Too many tries. Wait 5 seconds and try again.', { retryAfterSeconds: 5 }), 'throttled']]) {
      const { client } = owner({ invite: error });
      const s = createCircleSession({ client });
      await s.open(C, U(1));
      const r = await s.invite({ username: 'bob', role: 'member' });
      expect(r).toMatchObject({ ok: false, kind, message: error.error.message });
    }
    const f = owner({ invite: bad('invalid', 'Nope.', { field: 'username' }) });
    const s = createCircleSession({ client: f.client });
    await s.open(C, U(1));
    expect(await s.invite({ username: 'bob', role: 'member' })).toMatchObject({ errors: { username: 'Nope.' } });
    const g = owner({ invite: bad('forbidden') });
    const t = createCircleSession({ client: g.client });
    await t.open(C, U(1));
    await t.invite({ username: 'bob', role: 'member' });
    expect(g.calls.filter((c) => c.name === 'getCircle')).toHaveLength(2);
  });

  it('a list that fails to reload after a good invite is reported, the invite still counts', async () => {
    const { client } = owner({ invite: okv({ invited: true }), listInvitations: [page([]), bad('server', 'Down.')] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.invite({ username: 'bob', role: 'member' })).toEqual({ ok: true, notice: 'Invitation recorded for "bob".', listProblem: 'Down.' });
  });
});

describe('withdrawing, changing a role', () => {
  it('withdraw then reload the invitations; a gone invitation says so and reloads too', async () => {
    const { client, calls } = owner({ withdrawInvitation: [okv({}), bad('not-found', 'No such invitation.', { what: 'invitation' }), bad('server', 'Down.')], listInvitations: [page([inv(1)]), page([]), page([]), page([])] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.withdraw(I(1))).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'withdrawInvitation').args).toEqual([C, I(1)]);
    expect(await s.withdraw(I(1))).toMatchObject({ ok: false, kind: 'not-found', what: 'invitation' });
    expect(calls.filter((c) => c.name === 'listInvitations')).toHaveLength(3);
    expect(await s.withdraw(I(1))).toMatchObject({ kind: 'server' });
    expect(calls.filter((c) => c.name === 'listInvitations')).toHaveLength(3); // not reloaded for a server fault
  });

  it('a role change reloads the roster from the start', async () => {
    const { client, calls } = owner({ changeRole: okv(member(2, 'manager')), listMembers: [page([member(1, 'owner'), member(2)]), page([member(1, 'owner'), member(2, 'manager')])] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.changeRole(U(2), 'manager')).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'changeRole').args).toEqual([C, U(2), 'manager']);
    expect(s.getState().members.items[1].role).toBe('manager');
  });

  it('a person who has left: the service\'s words, and the roster and circle reload', async () => {
    const { client, calls } = owner({ changeRole: bad('not-found', 'That person is no longer in this circle.', { what: 'member' }) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.changeRole(U(2), 'observer')).toMatchObject({ ok: false, kind: 'not-found', what: 'member', message: 'That person is no longer in this circle.' });
    expect(names(calls).slice(-2)).toEqual(['listMembers', 'getCircle']);
  });

  it('forbidden refreshes everything; a failed role change after a stale view shows what the service now holds', async () => {
    const { client, calls } = fakeClient({ getCircle: [okv(circle('manager')), okv(circle('observer'))], listMembers: page([member(1, 'owner'), member(2)]), listInvitations: page([]), changeRole: bad('forbidden', 'Your role in this circle does not allow that.') });
    const s = createCircleSession({ client });
    await s.open(C, U(3));
    expect(await s.changeRole(U(2), 'observer')).toMatchObject({ kind: 'forbidden' });
    expect(s.getState().controls.invite).toBe(false);
    expect(s.getState().members.items.every((m) => !m.controls.changeRole)).toBe(true);
    expect(calls.filter((c) => c.name === 'getCircle')).toHaveLength(2);
  });

  it('a roster reload failure after a good change is reported, the change counts', async () => {
    const { client } = owner({ changeRole: okv(member(2, 'manager')), listMembers: [page([member(1, 'owner')]), bad('server', 'Down.')] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    expect(await s.changeRole(U(2), 'manager')).toEqual({ ok: true, listProblem: 'Down.' });
  });
});

describe('the two-step questions', () => {
  it('asking sends nothing and the state says what is asked; cancel closes it', async () => {
    const { client, calls } = owner();
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    const sent = calls.length;
    expect(s.askRemove(U(2))).toBe(true);
    expect(s.getState().confirm).toEqual({ action: 'remove', userId: U(2) });
    expect(s.askLeave()).toBe(true);
    expect(s.getState().confirm).toEqual({ action: 'leave' });
    expect(s.askDelete()).toBe(true);
    expect(s.getState().confirm).toEqual({ action: 'delete' });
    s.cancel();
    expect(s.getState().confirm).toBeNull();
    expect(calls).toHaveLength(sent);
    expect(await s.confirmAction()).toMatchObject({ ok: false, kind: 'nothing-asked' });
    expect(calls).toHaveLength(sent);
    s.cancel();
  });

  it('nothing can be asked before a circle is open or while a request is out', async () => {
    const { client } = owner();
    const s = createCircleSession({ client });
    expect(s.askDelete() || s.askLeave() || s.askRemove(U(2))).toBe(false);
    const gate = deferred();
    const t = createCircleSession({ client: fakeClient({ getCircle: () => gate.promise, listMembers: page([]), listInvitations: page([]) }).client });
    const p = t.open(C, U(1));
    expect(t.askDelete()).toBe(false);
    gate.resolve(okv(circle('owner')));
    await p;
    expect(t.askDelete()).toBe(true);
  });

  it('confirming a removal removes, reloads the roster and the circle, and closes the question', async () => {
    const { client, calls } = owner({ removeMember: okv({}), listMembers: [page([member(1, 'owner'), member(2)]), page([member(1, 'owner')])], getCircle: [okv(circle('owner')), okv(circle('owner', { memberCount: 1 }))] });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askRemove(U(2));
    expect(await s.confirmAction()).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'removeMember').args).toEqual([C, U(2)]);
    expect(s.getState().confirm).toBeNull();
    expect(s.getState().members.items).toHaveLength(1);
    expect(s.getState().circle.memberCount).toBe(1);
  });

  it('a removal that is refused closes the question, shows the words and refreshes', async () => {
    const { client } = owner({ removeMember: bad('forbidden', 'Your role in this circle does not allow that.') });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askRemove(U(2));
    expect(await s.confirmAction()).toMatchObject({ ok: false, kind: 'forbidden' });
    expect(s.getState().confirm).toBeNull();
  });

  it('a removal of someone who has gone says so and reloads', async () => {
    const { client } = owner({ removeMember: bad('not-found', 'That person is no longer in this circle.', { what: 'member' }) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askRemove(U(2));
    expect(await s.confirmAction()).toMatchObject({ ok: false, kind: 'not-found', what: 'member' });
  });

  it('confirming delete deletes and sends the page to the list; the circle is no longer shown', async () => {
    const { client, calls } = owner({ deleteCircle: okv({}) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askDelete();
    expect(await s.confirmAction()).toEqual({ ok: true, goTo: 'list' });
    expect(calls.find((c) => c.name === 'deleteCircle').args).toEqual([C]);
    expect(s.getState()).toMatchObject({ status: 'deleted', circle: null, confirm: null });
    expect(s.getState().members.items).toEqual([]);
  });

  it('confirming leave leaves and sends the page to the list', async () => {
    const { client, calls } = owner({ leaveCircle: okv({}) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askLeave();
    expect(await s.confirmAction()).toEqual({ ok: true, goTo: 'list' });
    expect(calls.find((c) => c.name === 'leaveCircle').args).toEqual([C]);
    expect(s.getState()).toMatchObject({ status: 'left', circle: null });
  });

  it('the only owner is told in the service\'s words and the circle stays', async () => {
    const { client } = owner({ leaveCircle: bad('last-owner', 'Make someone else an owner, or delete the circle.') });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askLeave();
    const r = await s.confirmAction();
    expect(r).toMatchObject({ ok: false, kind: 'last-owner', message: 'Make someone else an owner, or delete the circle.' });
    expect(r.goTo).toBeUndefined();
    expect(s.getState()).toMatchObject({ status: 'loaded', confirm: null });
    expect(s.getState().circle).not.toBeNull();
  });

  it('a delete that is refused for rights refreshes and stays on the circle', async () => {
    const { client } = fakeClient({ getCircle: [okv(circle('owner')), okv(circle('manager'))], listMembers: page([]), listInvitations: page([]), deleteCircle: bad('forbidden', 'Your role in this circle does not allow that.') });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askDelete();
    expect(await s.confirmAction()).toMatchObject({ kind: 'forbidden' });
    expect(s.getState()).toMatchObject({ status: 'loaded', controls: { delete: false } });
  });

  it('a delete or leave of a circle that has gone says so', async () => {
    const { client } = fakeClient({ getCircle: [okv(circle('owner')), bad('not-found', 'x', { what: 'circle' })], listMembers: page([]), listInvitations: page([]), deleteCircle: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    s.askDelete();
    expect(await s.confirmAction()).toMatchObject({ ok: false, kind: 'not-found' });
    expect(s.getState().status).toBe('gone');
  });
});

describe('one request at a time', () => {
  it('a second call while one is out sends nothing', async () => {
    const gate = deferred();
    const { client, calls } = owner({ updateCircle: () => gate.promise });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    const sent = calls.length;
    const first = s.update({ name: 'New' });
    expect(s.getState().busy).toBe(true);
    for (const r of [await s.update({ name: 'Other' }), await s.invite({ username: 'bob', role: 'member' }), await s.withdraw(I(1)), await s.changeRole(U(2), 'member'), await s.refresh(), await s.moreMembers(), await s.moreInvitations(), await s.confirmAction().catch(() => null)]) {
      if (r) expect(r.kind).toBe(r.kind === 'nothing-asked' ? 'nothing-asked' : 'busy');
    }
    expect(calls.length).toBe(sent + 1);
    gate.resolve(okv(circle('owner', { name: 'New' })));
    await first;
    expect(s.getState().busy).toBe(false);
  });

  it('busy is cleared after a failure', async () => {
    const { client } = owner({ updateCircle: bad('server') });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    await s.update({ name: 'New' });
    expect(s.getState().busy).toBe(false);
  });
});

describe('details found by mutation', () => {
  it('questions cannot be asked while a request is out, even with a circle open', async () => {
    const gate = deferred();
    const { client } = owner({ updateCircle: () => gate.promise });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    const p = s.update({ name: 'New' });
    expect(s.askRemove(U(2))).toBe(false);
    expect(s.askLeave()).toBe(false);
    expect(s.askDelete()).toBe(false);
    expect(s.getState().confirm).toBeNull();
    gate.resolve(okv(circle('owner')));
    await p;
  });

  it('cancel with nothing asked tells nobody', async () => {
    const { client } = owner();
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    let n = 0;
    s.subscribe(() => n++);
    s.cancel();
    expect(n).toBe(0);
  });

  it('onSignedOut is not called for good answers', async () => {
    let n = 0;
    const { client } = owner();
    const s = createCircleSession({ client, onSignedOut: () => n++ });
    await s.open(C, U(1));
    expect(n).toBe(0);
  });

  it('a failed refresh of a loaded circle keeps it loaded and shows the words', async () => {
    const { client } = fakeClient({ getCircle: [okv(circle('owner')), bad('server', 'Down.')], listMembers: page([member(1, 'owner')]), listInvitations: page([]) });
    const s = createCircleSession({ client });
    await s.open(C, U(1));
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'loaded', message: 'Down.' });
    expect(s.getState().circle).not.toBeNull();
  });

  it('a demotion found while reloading the circle after a removal hides the invitations', async () => {
    const { client } = fakeClient({ getCircle: [okv(circle('manager')), okv(circle('member'))], listMembers: page([member(1, 'owner'), member(2)]), listInvitations: page([inv(1)]), removeMember: okv({}) });
    const s = createCircleSession({ client });
    await s.open(C, U(3));
    expect(s.getState().invitations.visible).toBe(true);
    s.askRemove(U(2));
    await s.confirmAction();
    expect(s.getState().circle.role).toBe('member');
    expect(s.getState().invitations).toMatchObject({ visible: false, items: [] });
  });

  it('an old request finishing after another circle was opened does not clear the newer request\'s busy mark', async () => {
    const C2 = 'c0000000000000002';
    const a = deferred();
    const b = deferred();
    const { client } = fakeClient({ getCircle: (id) => (id === C ? a.promise : b.promise), listMembers: page([]), listInvitations: page([]) });
    const s = createCircleSession({ client });
    const first = s.open(C, U(1));
    const second = s.open(C2, U(1));
    a.resolve(okv(circle('owner')));
    await first;
    expect(s.getState().busy).toBe(true);
    b.resolve(okv(circle('member', { id: C2 })));
    await second;
    expect(s.getState().busy).toBe(false);
  });
});

describe('signing out and leaving the screen', () => {
  it('a signed-out answer calls onSignedOut; a throwing callback does not matter', async () => {
    let n = 0;
    const { client } = fakeClient({ getCircle: bad('signed-out', 'Your session has ended. Sign in again.') });
    const s = createCircleSession({ client, onSignedOut: () => n++ });
    expect(await s.open(C, U(1))).toMatchObject({ kind: 'signed-out' });
    expect(n).toBe(1);
    const t = createCircleSession({ client, onSignedOut: () => { throw new Error('x'); } });
    expect((await t.open(C, U(1))).kind).toBe('signed-out');
  });

  it('reset forgets everything and drops answers on their way', async () => {
    const gate = deferred();
    const { client } = fakeClient({ getCircle: () => gate.promise, listMembers: page([member(1)]) });
    const s = createCircleSession({ client });
    const p = s.open(C, U(1));
    s.reset();
    expect(s.getState()).toMatchObject({ status: 'idle', circle: null, circleId: null, busy: false });
    gate.resolve(okv(circle('owner')));
    await p;
    expect(s.getState()).toMatchObject({ status: 'idle', circle: null });
    expect(s.getState().members.items).toEqual([]);
  });

  it('opening another circle drops the answers for the first and starts clean', async () => {
    const gate = deferred();
    const C2 = 'c0000000000000002';
    const { client } = fakeClient({ getCircle: (id) => (id === C ? gate.promise : okv(circle('member', { id: C2, name: 'Other' }))), listMembers: page([member(1)]), listInvitations: page([]) });
    const s = createCircleSession({ client });
    const first = s.open(C, U(1));
    const second = s.open(C2, U(1));
    expect(await second).toEqual({ ok: true });
    gate.resolve(okv(circle('owner')));
    await first;
    expect(s.getState()).toMatchObject({ circleId: C2, status: 'loaded', circle: { name: 'Other' }, busy: false });
  });

  it('listeners hear changes, can leave, and a broken one does not matter', async () => {
    const { client } = owner();
    const s = createCircleSession({ client });
    const seen = [];
    const off = s.subscribe((v) => seen.push(v.status));
    s.subscribe(() => { throw new Error('x'); });
    await s.open(C, U(1));
    expect(seen).toContain('loading');
    expect(seen.at(-1)).toBe('loaded');
    const n = seen.length;
    off();
    s.cancel();
    await s.refresh();
    expect(seen).toHaveLength(n);
  });

  it('refresh with nothing open does nothing', async () => {
    const { client, calls } = fakeClient();
    const s = createCircleSession({ client });
    expect((await s.refresh()).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('needs a client', () => {
    expect(() => createCircleSession({})).toThrow(TypeError);
    expect(() => createCircleSession({ client: {} })).toThrow(TypeError);
  });
});
