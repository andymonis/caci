import { describe, expect, it } from 'vitest';
import { checkCircle, createCirclesSession } from './circles-session.js';

const C = (n) => `c${String(n).padStart(16, '0')}`;
const I = (n) => `i${String(n).padStart(16, '0')}`;
const circle = (n, extra = {}) => ({ id: C(n), name: `Circle ${n}`, role: 'owner', memberCount: 1, createdAt: 1, updatedAt: 1, ...extra });
const inv = (n) => ({ id: I(n), circle: { id: C(n), name: `Circle ${n}` }, role: 'member', invitedBy: { displayName: 'Bob' }, createdAt: 1, expiresAt: 2 });
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const page = (items, nextCursor = null) => okv({ items, nextCursor });

/** A client whose calls are scripted by name; each script entry is a value or a function; calls are recorded. */
function fakeClient(script = {}) {
  const calls = [];
  const gates = [];
  const client = new Proxy({}, {
    get: (_, name) => (...args) => {
      calls.push({ name, args });
      const entry = script[name];
      const value = typeof entry === 'function' ? entry(...args) : Array.isArray(entry) ? entry.shift() : entry;
      return Promise.resolve(value).then((v) => v ?? okv({}));
    },
    has: () => true,
  });
  return { client, calls, gates };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe('early checks on the create form', () => {
  it('trims, requires a name of 1 to 80 characters, and a description of up to 500', () => {
    expect(checkCircle({ name: '  Team  ', description: '  About  ' })).toEqual({ ok: true, value: { name: 'Team', description: 'About' } });
    expect(checkCircle({ name: 'Team', description: '   ' })).toEqual({ ok: true, value: { name: 'Team' } });
    expect(checkCircle({ name: 'Team' }).value).toEqual({ name: 'Team' });
    expect(checkCircle({ name: '   ' }).errors.name).toBeTruthy();
    expect(checkCircle({}).errors.name).toBeTruthy();
    expect(checkCircle(undefined).errors.name).toBeTruthy();
    expect(checkCircle({ name: 5 }).errors.name).toBeTruthy();
    expect(checkCircle({ name: 'a'.repeat(80) }).ok).toBe(true);
    expect(checkCircle({ name: 'a'.repeat(81) }).errors.name).toContain('80');
    expect(checkCircle({ name: '😀'.repeat(80) }).ok).toBe(true);
    expect(checkCircle({ name: '😀'.repeat(81) }).ok).toBe(false);
    expect(checkCircle({ name: 'a\u0007b' }).errors.name).toBeTruthy();
    expect(checkCircle({ name: 'a b' }).errors.name).toBeTruthy();
    expect(checkCircle({ name: 'Team', description: 'x'.repeat(500) }).ok).toBe(true);
    expect(checkCircle({ name: 'Team', description: 'x'.repeat(501) }).errors.description).toContain('500');
    expect(checkCircle({ name: 'Team', description: 5 }).errors.description).toBeTruthy();
    expect(checkCircle({ name: '', description: 'x'.repeat(501) }).errors).toHaveProperty('description');
    expect(checkCircle({ name: 'Team', description: 'two\nlines' }).ok).toBe(true);
  });
});

describe('the circle list', () => {
  it('starts empty and idle, loads the first page, and shows more by cursor', async () => {
    const { client, calls } = fakeClient({ listCircles: [page([circle(1), circle(2)], 'abc'), page([circle(3)])] });
    const s = createCirclesSession({ client });
    expect(s.getState().circles).toMatchObject({ status: 'idle', items: [], nextCursor: null });
    expect(await s.loadCircles()).toEqual({ ok: true });
    expect(s.getState().circles).toMatchObject({ status: 'loaded', nextCursor: 'abc', error: null });
    expect(s.getState().circles.items.map((c) => c.id)).toEqual([C(1), C(2)]);
    expect(await s.moreCircles()).toEqual({ ok: true });
    expect(s.getState().circles.items.map((c) => c.id)).toEqual([C(1), C(2), C(3)]);
    expect(s.getState().circles.nextCursor).toBeNull();
    expect(calls.map((c) => c.args[0])).toEqual([{ limit: 50 }, { limit: 50, cursor: 'abc' }]);
    expect(await s.moreCircles()).toEqual({ ok: true });
    expect(calls).toHaveLength(2); // nothing more to ask for
  });

  it('loading again starts from the first page and replaces the list', async () => {
    const { client } = fakeClient({ listCircles: [page([circle(1)], 'x'), page([circle(9)])] });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    await s.loadCircles();
    expect(s.getState().circles.items.map((c) => c.id)).toEqual([C(9)]);
    expect(s.getState().circles.nextCursor).toBeNull();
  });

  it('a failed load shows the words and no list; a failed "more" keeps what was shown', async () => {
    const { client } = fakeClient({ listCircles: [page([circle(1)], 'x'), bad('server', 'Down.'), bad('network', 'Offline.')] });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    expect(await s.moreCircles()).toMatchObject({ ok: false, kind: 'server', message: 'Down.' });
    expect(s.getState().circles).toMatchObject({ status: 'loaded', error: 'Down.', nextCursor: 'x' });
    expect(s.getState().circles.items).toHaveLength(1);
    expect(await s.loadCircles()).toMatchObject({ ok: false, kind: 'network' });
    expect(s.getState().circles).toMatchObject({ status: 'error', error: 'Offline.', items: [], nextCursor: null });
  });

  it('snapshots are frozen and independent of later changes', async () => {
    const { client } = fakeClient({ listCircles: [page([circle(1)]), page([circle(2)])] });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    const before = s.getState();
    expect(Object.isFrozen(before) && Object.isFrozen(before.circles) && Object.isFrozen(before.circles.items) && Object.isFrozen(before.invitations) && Object.isFrozen(before.busy)).toBe(true);
    await s.loadCircles();
    expect(before.circles.items.map((c) => c.id)).toEqual([C(1)]);
  });
});

describe('creating a circle', () => {
  it('checks early and sends nothing when the form is wrong', async () => {
    const { client, calls } = fakeClient();
    const s = createCirclesSession({ client });
    const r = await s.createCircle({ name: '' });
    expect(r).toMatchObject({ ok: false, kind: 'invalid', errors: { name: expect.any(String) } });
    expect(calls).toHaveLength(0);
  });

  it('sends the trimmed values, returns the circle and marks the list out of date', async () => {
    const { client, calls } = fakeClient({ createCircle: okv(circle(5)), listCircles: page([circle(5)]) });
    const s = createCirclesSession({ client });
    expect(s.getState().circles.stale).toBe(false);
    const r = await s.createCircle({ name: ' Team ', description: ' hi ' });
    expect(r).toEqual({ ok: true, circle: circle(5) });
    expect(calls[0].args[0]).toEqual({ name: 'Team', description: 'hi' });
    expect(s.getState().circles.stale).toBe(true);
    await s.loadCircles();
    expect(s.getState().circles.stale).toBe(false);
  });

  it('the service\'s refusal is shown in its words, beside its field when it names one; a failure leaves the list as it was', async () => {
    const { client } = fakeClient({ createCircle: [bad('invalid', 'Name is taken.', { field: 'name' }), bad('limit', 'At most 20 circles.')], listCircles: page([circle(1)]) });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    expect(await s.createCircle({ name: 'Team' })).toMatchObject({ ok: false, kind: 'invalid', message: 'Name is taken.', errors: { name: 'Name is taken.' } });
    const limit = await s.createCircle({ name: 'Team' });
    expect(limit).toMatchObject({ ok: false, kind: 'limit', message: 'At most 20 circles.' });
    expect(limit.errors).toBeUndefined();
    expect(s.getState().circles.stale).toBe(false);
    expect(s.getState().circles.items).toHaveLength(1);
  });
});

describe('leaving a circle', () => {
  it('leaves, then reloads the list', async () => {
    const { client, calls } = fakeClient({ listCircles: [page([circle(1), circle(2)]), page([circle(2)])], leaveCircle: okv({}) });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    expect(await s.leaveCircle(C(1))).toEqual({ ok: true });
    expect(calls.map((c) => c.name)).toEqual(['listCircles', 'leaveCircle', 'listCircles']);
    expect(calls[1].args).toEqual([C(1)]);
    expect(s.getState().circles.items.map((c) => c.id)).toEqual([C(2)]);
  });

  it('the only owner is told in the service\'s words and the list is not reloaded', async () => {
    const { client, calls } = fakeClient({ leaveCircle: bad('last-owner', 'Make someone else an owner, or delete the circle.') });
    const s = createCirclesSession({ client });
    expect(await s.leaveCircle(C(1))).toMatchObject({ ok: false, kind: 'last-owner', message: 'Make someone else an owner, or delete the circle.' });
    expect(calls.map((c) => c.name)).toEqual(['leaveCircle']);
  });

  it('a circle that has gone is "no such circle" and the list is reloaded so it disappears', async () => {
    const { client, calls } = fakeClient({ listCircles: [page([circle(1)]), page([])], leaveCircle: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    const r = await s.leaveCircle(C(1));
    expect(r).toMatchObject({ ok: false, kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });
    expect(s.getState().circles.items).toEqual([]);
    expect(calls.map((c) => c.name)).toEqual(['listCircles', 'leaveCircle', 'listCircles']);
  });

  it('other failures (server, network) do not reload', async () => {
    for (const kind of ['server', 'network', 'throttled', 'forbidden-ish']) {
      const { client, calls } = fakeClient({ leaveCircle: bad(kind) });
      const s = createCirclesSession({ client });
      expect((await s.leaveCircle(C(1))).kind).toBe(kind);
      expect(calls).toHaveLength(1);
    }
  });

  it('a reload that fails after a good leave is reported but the leave still counts', async () => {
    const { client } = fakeClient({ leaveCircle: okv({}), listCircles: bad('server', 'Down.') });
    const s = createCirclesSession({ client });
    expect(await s.leaveCircle(C(1))).toEqual({ ok: true, listProblem: 'Down.' });
  });
});

describe('invitations and the count', () => {
  it('the count is the number the last answer gave, "at least" when there is more', async () => {
    const { client, calls } = fakeClient({ myInvitations: [page([inv(1), inv(2)]), page([inv(1), inv(2), inv(3)], 'more'), page([])] });
    const s = createCirclesSession({ client });
    expect(s.getState().invitations).toMatchObject({ count: null, status: 'idle' });
    await s.loadInvitations();
    expect(s.getState().invitations).toMatchObject({ count: 2, atLeast: false, status: 'loaded' });
    await s.refreshCount();
    expect(s.getState().invitations).toMatchObject({ count: 3, atLeast: true });
    await s.refreshCount();
    expect(s.getState().invitations).toMatchObject({ count: 0, atLeast: false, items: [] });
    expect(calls[0].args[0]).toEqual({ limit: 100 });
  });

  it('a failed refresh shows no number at all, not the old one', async () => {
    const { client } = fakeClient({ myInvitations: [page([inv(1)]), bad('server', 'Down.'), page([inv(1)])] });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    expect(s.getState().invitations.count).toBe(1);
    expect(await s.refreshCount()).toMatchObject({ ok: false, kind: 'server', message: 'Down.' });
    expect(s.getState().invitations).toMatchObject({ count: null, atLeast: false, status: 'error', error: 'Down.', items: [], nextCursor: null });
    await s.refreshCount();
    expect(s.getState().invitations).toMatchObject({ count: 1, error: null });
  });

  it('more invitations appends, and the count follows what is held', async () => {
    const { client, calls } = fakeClient({ myInvitations: [page([inv(1)], 'p2'), page([inv(2)])] });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    await s.moreInvitations();
    expect(s.getState().invitations).toMatchObject({ count: 2, atLeast: false, nextCursor: null });
    expect(calls[1].args[0]).toEqual({ limit: 100, cursor: 'p2' });
    await s.moreInvitations();
    expect(calls).toHaveLength(2);
  });

  it('a failed "more" shows no number and keeps what was loaded', async () => {
    const { client } = fakeClient({ myInvitations: [page([inv(1)], 'p2'), bad('network', 'Offline.')] });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    await s.moreInvitations();
    expect(s.getState().invitations).toMatchObject({ count: null, error: 'Offline.' });
    expect(s.getState().invitations.items).toHaveLength(1);
  });

  it('accepting returns the circle, marks the list out of date, and reloads the invitations and count', async () => {
    const { client, calls } = fakeClient({ myInvitations: [page([inv(1), inv(2)]), page([inv(2)])], acceptInvitation: okv(circle(1, { role: 'member' })) });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    const r = await s.acceptInvitation(I(1));
    expect(r).toEqual({ ok: true, circle: circle(1, { role: 'member' }) });
    expect(s.getState().circles.stale).toBe(true);
    expect(s.getState().invitations).toMatchObject({ count: 1 });
    expect(calls.map((c) => c.name)).toEqual(['myInvitations', 'acceptInvitation', 'myInvitations']);
    expect(calls[1].args).toEqual([I(1)]);
  });

  it('the circle is in the list after accepting and loading the list', async () => {
    const { client } = fakeClient({ myInvitations: [page([inv(1)]), page([])], acceptInvitation: okv(circle(1)), listCircles: page([circle(1)]) });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    await s.acceptInvitation(I(1));
    await s.loadCircles();
    expect(s.getState().circles.items.map((c) => c.id)).toEqual([C(1)]);
  });

  it('an invitation that has gone is "no such invitation" and the list reloads; a full circle keeps it and reloads too', async () => {
    const { client, calls } = fakeClient({ myInvitations: [page([inv(1)]), page([]), page([inv(2)]), page([inv(2)])], acceptInvitation: [bad('not-found', 'No such invitation.', { what: 'invitation' }), bad('limit', 'That circle is full.')] });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    expect(await s.acceptInvitation(I(1))).toMatchObject({ ok: false, kind: 'not-found', what: 'invitation', message: 'No such invitation.' });
    expect(s.getState().invitations.count).toBe(0);
    expect(s.getState().circles.stale).toBe(false);
    await s.loadInvitations();
    expect(await s.acceptInvitation(I(2))).toMatchObject({ ok: false, kind: 'limit', message: 'That circle is full.' });
    expect(s.getState().invitations.count).toBe(1);
    expect(calls.filter((c) => c.name === 'myInvitations')).toHaveLength(4);
  });

  it('other accept failures do not reload', async () => {
    const { client, calls } = fakeClient({ acceptInvitation: bad('server') });
    const s = createCirclesSession({ client });
    expect((await s.acceptInvitation(I(1))).kind).toBe('server');
    expect(calls).toHaveLength(1);
  });

  it('declining removes the row and the count follows; a gone invitation is the same', async () => {
    const { client, calls } = fakeClient({ myInvitations: [page([inv(1), inv(2)]), page([inv(2)]), page([])], declineInvitation: [okv({}), bad('not-found', 'No such invitation.', { what: 'invitation' })] });
    const s = createCirclesSession({ client });
    await s.loadInvitations();
    expect(await s.declineInvitation(I(1))).toEqual({ ok: true });
    expect(s.getState().invitations.items.map((i) => i.id)).toEqual([I(2)]);
    expect(await s.declineInvitation(I(2))).toMatchObject({ ok: false, kind: 'not-found', what: 'invitation' });
    expect(s.getState().invitations.count).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(['myInvitations', 'declineInvitation', 'myInvitations', 'declineInvitation', 'myInvitations']);
  });

  it('a decline that fails otherwise does not reload; a failed reload after a good decline is reported', async () => {
    const a = fakeClient({ declineInvitation: bad('network') });
    expect((await createCirclesSession({ client: a.client }).declineInvitation(I(1))).kind).toBe('network');
    expect(a.calls).toHaveLength(1);
    const b = fakeClient({ declineInvitation: okv({}), myInvitations: bad('server', 'Down.') });
    const s = createCirclesSession({ client: b.client });
    expect(await s.declineInvitation(I(1))).toEqual({ ok: true, listProblem: 'Down.' });
    expect(s.getState().invitations.count).toBeNull();
  });

  it('a failed reload after accept is reported with the circle', async () => {
    const { client } = fakeClient({ acceptInvitation: okv(circle(1)), myInvitations: bad('server', 'Down.') });
    const s = createCirclesSession({ client });
    expect(await s.acceptInvitation(I(1))).toEqual({ ok: true, circle: circle(1), listProblem: 'Down.' });
  });
});

describe('one request at a time in each area', () => {
  it('a second call in the same area sends nothing; the other area is free; busy shows in the state', async () => {
    const gate = deferred();
    const { client, calls } = fakeClient({ listCircles: () => gate.promise, myInvitations: page([]) });
    const s = createCirclesSession({ client });
    const first = s.loadCircles();
    expect(s.getState().busy).toEqual({ circles: true, invitations: false });
    expect(await s.loadCircles()).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.moreCircles()).toMatchObject({ kind: 'busy' });
    expect(await s.createCircle({ name: 'Team' })).toMatchObject({ kind: 'busy' });
    expect(await s.leaveCircle(C(1))).toMatchObject({ kind: 'busy' });
    expect(await s.loadInvitations()).toEqual({ ok: true });
    gate.resolve(page([circle(1)]));
    expect(await first).toEqual({ ok: true });
    expect(s.getState().busy).toEqual({ circles: false, invitations: false });
    expect(calls.filter((c) => c.name === 'listCircles')).toHaveLength(1);
  });

  it('invitations: every action is refused while one is out', async () => {
    const gate = deferred();
    const { client, calls } = fakeClient({ myInvitations: () => gate.promise });
    const s = createCirclesSession({ client });
    const first = s.loadInvitations();
    for (const r of [await s.refreshCount(), await s.moreInvitations(), await s.acceptInvitation(I(1)), await s.declineInvitation(I(1))]) expect(r.kind).toBe('busy');
    gate.resolve(page([]));
    await first;
    expect(calls).toHaveLength(1);
  });

  it('busy is cleared after a failure and after a client that throws', async () => {
    const { client } = fakeClient({ listCircles: [bad('server')] });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    expect(s.getState().busy.circles).toBe(false);
    const boom = { listCircles: () => Promise.reject(new Error('boom')), myInvitations: () => Promise.resolve(page([])) };
    const t = createCirclesSession({ client: boom });
    await expect(t.loadCircles()).rejects.toThrow('boom');
    expect(t.getState().busy.circles).toBe(false);
  });
});

describe('signing out', () => {
  it('a signed-out answer calls onSignedOut', async () => {
    let n = 0;
    const { client } = fakeClient({ listCircles: bad('signed-out', 'Your session has ended. Sign in again.') });
    const s = createCirclesSession({ client, onSignedOut: () => n++ });
    expect(await s.loadCircles()).toMatchObject({ kind: 'signed-out' });
    expect(n).toBe(1);
  });

  it('a throwing onSignedOut does not matter', async () => {
    const { client } = fakeClient({ listCircles: bad('signed-out') });
    const s = createCirclesSession({ client, onSignedOut: () => { throw new Error('x'); } });
    expect((await s.loadCircles()).kind).toBe('signed-out');
  });

  it('reset forgets everything, and an answer that arrives afterwards is dropped', async () => {
    const gate = deferred();
    const { client } = fakeClient({ listCircles: [page([circle(1)]), () => gate.promise], myInvitations: page([inv(1)]) });
    const s = createCirclesSession({ client });
    await s.loadCircles();
    await s.loadInvitations();
    const late = s.loadCircles();
    s.reset();
    expect(s.getState()).toMatchObject({ circles: { status: 'idle', items: [], stale: false }, invitations: { status: 'idle', count: null, items: [] }, busy: { circles: false, invitations: false } });
    gate.resolve(page([circle(7)]));
    expect(await late).toMatchObject({ ok: false, kind: 'signed-out' });
    expect(s.getState().circles).toMatchObject({ status: 'idle', items: [] });
    expect(s.getState().busy.circles).toBe(false);
  });

  it('an old request finishing after a reset does not clear the busy mark of a newer one', async () => {
    const a = deferred();
    const b = deferred();
    const queue = [a, b];
    const { client } = fakeClient({ listCircles: () => queue.shift().promise });
    const s = createCirclesSession({ client });
    const old = s.loadCircles();
    s.reset();
    const fresh = s.loadCircles();
    expect(s.getState().busy.circles).toBe(true);
    a.resolve(page([circle(1)]));
    expect(await old).toMatchObject({ kind: 'signed-out' });
    expect(s.getState().busy.circles).toBe(true);
    expect(await s.loadCircles()).toMatchObject({ kind: 'busy' });
    b.resolve(page([circle(2)]));
    await fresh;
    expect(s.getState().circles.items.map((c) => c.id)).toEqual([C(2)]);
    expect(s.getState().busy.circles).toBe(false);
  });

  it('after a reset a new load works', async () => {
    const { client } = fakeClient({ listCircles: page([circle(1)]) });
    const s = createCirclesSession({ client });
    s.reset();
    expect(await s.loadCircles()).toEqual({ ok: true });
  });
});

describe('listeners', () => {
  it('hear every change, can leave, and a broken one does not matter', async () => {
    const { client } = fakeClient({ listCircles: page([circle(1)]) });
    const s = createCirclesSession({ client });
    const seen = [];
    const off = s.subscribe((v) => seen.push(v.busy.circles));
    s.subscribe(() => { throw new Error('x'); });
    await s.loadCircles();
    expect(seen).toEqual([true, false]);
    off();
    await s.loadCircles();
    expect(seen).toHaveLength(2);
  });
});

describe('construction', () => {
  it('needs a client', () => {
    expect(() => createCirclesSession({})).toThrow(TypeError);
    expect(() => createCirclesSession({ client: {} })).toThrow(TypeError);
  });
});
