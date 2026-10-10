import { describe, expect, it } from 'vitest';
import { createGrantsSession } from './grants-session.js';

const C = 'c0123456789abcdef';
const ME = 'u0000000000000001';
const BOB = 'u0000000000000002';
const CAT = 'u0000000000000003';
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const page = (items, nextCursor = null) => okv({ items, nextCursor });
const member = (userId, name) => ({ userId, username: name, displayName: `Display ${name}`, role: 'member', joinedAt: 1 });
const grant = (userId, ids, name = userId === BOB ? 'bob' : 'cat') => ({ userId, username: name, displayName: `Display ${name}`, categories: ids.map((id) => ({ id, name: `Name ${id}` })), updatedAt: 5 });
const mine = (...ids) => page(ids.map((id) => ({ id, name: `Name ${id}`, itemCount: 1 })));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function fake(script = {}) {
  const calls = [];
  const side = () =>
    new Proxy({}, {
      get: (_, name) => (...args) => {
        calls.push({ name, args });
        const entry = script[name];
        const value = typeof entry === 'function' ? entry(...args) : Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
        return Promise.resolve(value).then((v) => v ?? okv({}));
      },
    });
  return { sharing: side(), circles: side(), notes: side(), calls };
}
const defaults = () => ({
  listMembers: page([member(ME, 'me'), member(BOB, 'bob'), member(CAT, 'cat')]),
  listGrants: page([grant(BOB, ['health', 'travel'])]),
  categories: mine('health', 'travel', 'pets'),
  setGrant: okv({ grant: grant(BOB, ['pets']) }),
  withdrawGrant: okv(true),
});
const opened = async (script = {}, options = {}) => {
  const f = fake({ ...defaults(), ...script });
  const s = createGrantsSession({ sharing: f.sharing, circles: f.circles, notes: f.notes, ...options });
  await s.open(C, ME);
  return { s, ...f };
};
const names = (calls) => calls.map((c) => c.name);
const ids = (list) => list.map((x) => x.id);

describe('the people and what is shared with each', () => {
  it('lists the other members only (not me), each with what is shared, from the roster and the grants', async () => {
    const { s, calls } = await opened();
    expect(s.getState()).toMatchObject({ circleId: C, status: 'loaded', message: null, busy: false });
    expect(s.getState().people.map((p) => [p.userId, p.displayName, ids(p.shared)])).toEqual([[BOB, 'Display bob', ['health', 'travel']], [CAT, 'Display cat', []]]);
    expect(names(calls)).toEqual(['listMembers', 'listGrants']);
    expect(calls[0].args).toEqual([C, { limit: 100 }]);
  });

  it('reads every page of the roster and of the grants', async () => {
    const { s, calls } = await opened({ listMembers: [page([member(ME, 'me'), member(BOB, 'bob')], 'm2'), page([member(CAT, 'cat')])], listGrants: [page([grant(BOB, ['a'])], 'g2'), page([grant(CAT, ['b'])])] });
    expect(s.getState().people.map((p) => ids(p.shared))).toEqual([['a'], ['b']]);
    expect(calls.map((c) => c.args[1].cursor)).toEqual([undefined, 'm2', undefined, 'g2']);
  });

  it('a grant for someone no longer in the roster is not shown', async () => {
    const { s } = await opened({ listGrants: page([grant('u0000000000000009', ['x'], 'ghost'), grant(BOB, ['a'])]) });
    expect(s.getState().people.map((p) => p.userId)).toEqual([BOB, CAT]);
  });

  it('a circle that is gone says so and shows nobody; another failure shows the words', async () => {
    const a = await opened({ listMembers: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    expect(a.s.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.', people: [] });
    const b = await opened({ listGrants: bad('server', 'Something went wrong') });
    expect(b.s.getState()).toMatchObject({ status: 'error', message: 'Something went wrong', people: [] });
    const c = await opened({ listMembers: bad('network', 'Cannot reach') });
    expect(c.s.getState()).toMatchObject({ status: 'error', people: [] });
  });

  it('refresh reloads both lists, closing any picker and question', async () => {
    const { s, calls } = await opened();
    await s.edit(BOB);
    expect(s.getState().editing).not.toBeNull();
    await s.refresh();
    expect(s.getState()).toMatchObject({ editing: null, asking: null, notice: null, problem: null, mine: { status: 'idle' } });
    expect(names(calls).filter((n) => n === 'listMembers')).toHaveLength(2);
  });
});

describe('choosing what to share', () => {
  it('opening a picker loads my categories once and ticks what is shared', async () => {
    const { s, calls } = await opened();
    expect(await s.edit(BOB)).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ editing: { userId: BOB, draft: ['health', 'travel'] }, mine: { status: 'loaded', capped: false, error: null } });
    expect(ids(s.getState().mine.items)).toEqual(['health', 'travel', 'pets']);
    s.cancelEdit();
    await s.edit(CAT);
    expect(names(calls).filter((n) => n === 'categories')).toHaveLength(1);
    expect(s.getState().editing).toMatchObject({ userId: CAT, draft: [] });
  });

  it('reads all pages of my categories up to a cap and says when it was capped', async () => {
    let n = 0;
    const many = await opened({ categories: () => page([{ id: `k${n++}`, itemCount: 1 }], 'more') });
    await many.s.edit(BOB);
    expect(many.s.getState().mine).toMatchObject({ status: 'loaded', capped: true });
    expect(many.s.getState().mine.items).toHaveLength(10);
  });

  it('toggling ticks and unticks, sends nothing, ignores categories that are not mine, and needs an open picker', async () => {
    const { s, calls } = await opened();
    expect(s.toggle('pets')).toBe(false);
    await s.edit(BOB);
    const before = calls.length;
    expect(s.toggle('pets')).toBe(true);
    expect(s.getState().editing.draft).toEqual(['health', 'travel', 'pets']);
    expect(s.toggle('health')).toBe(true);
    expect(s.getState().editing.draft).toEqual(['travel', 'pets']);
    expect(s.toggle('not-mine')).toBe(false);
    expect(calls).toHaveLength(before);
  });

  it('at most 200 categories can be ticked', async () => {
    const all = Array.from({ length: 201 }, (_, i) => ({ id: `k${String(i).padStart(3, '0')}`, itemCount: 1 }));
    const { s } = await opened({ categories: page(all), listGrants: page([]) });
    await s.edit(BOB);
    for (const c of all.slice(0, 200)) expect(s.toggle(c.id)).toBe(true);
    expect(s.toggle('k200')).toBe(false);
    expect(s.getState().problem).toMatch(/at most 200/);
    expect(s.getState().editing.draft).toHaveLength(200);
    expect(s.toggle('k000')).toBe(true);
    expect(s.getState().problem).toBeNull();
  });

  it('cancelling closes the picker and sends nothing', async () => {
    const { s, calls } = await opened();
    await s.edit(BOB);
    const before = calls.length;
    s.toggle('pets');
    expect(s.cancelEdit()).toBe(true);
    expect(s.getState().editing).toBeNull();
    expect(s.cancelEdit()).toBe(false);
    expect(calls).toHaveLength(before);
  });

  it('saving sends the whole ticked set, then reloads and says what happened', async () => {
    const { s, calls } = await opened({ listGrants: [page([grant(BOB, ['health', 'travel'])]), page([grant(BOB, ['pets'])])], setGrant: okv({ grant: grant(BOB, ['pets']) }) });
    await s.edit(BOB);
    s.toggle('health');
    s.toggle('travel');
    s.toggle('pets');
    expect(await s.save()).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'setGrant').args).toEqual([C, BOB, ['pets']]);
    expect(s.getState()).toMatchObject({ editing: null, problem: null, notice: 'Now sharing 1 category with Display bob.' });
    expect(ids(s.getState().people[0].shared)).toEqual(['pets']);
    expect(names(calls).slice(-2)).toEqual(['listMembers', 'listGrants']);
  });

  it('plural, and nothing ticked stops sharing', async () => {
    const a = await opened({ setGrant: okv({ grant: grant(BOB, ['a', 'b']) }) });
    await a.s.edit(BOB);
    await a.s.save();
    expect(a.s.getState().notice).toBe('Now sharing 2 categories with Display bob.');
    const b = await opened({ setGrant: okv({ grant: null }) });
    await b.s.edit(BOB);
    b.s.toggle('health');
    b.s.toggle('travel');
    await b.s.save();
    expect(b.calls.find((c) => c.name === 'setGrant').args[2]).toEqual([]);
    expect(b.s.getState().notice).toBe('Stopped sharing with Display bob.');
  });

  it('a person without a display name is named by username, then by words', async () => {
    const { s } = await opened({ listMembers: page([member(ME, 'me'), { userId: BOB, role: 'member', joinedAt: 1 }]), listGrants: page([]), setGrant: okv({ grant: grant(BOB, ['a']) }) });
    await s.edit(BOB);
    await s.save();
    expect(s.getState().notice).toBe('Now sharing 1 category with that person.');
  });

  it('a refused save keeps the picker and the ticks and shows the service\'s words', async () => {
    const { s } = await opened({ setGrant: bad('limit', 'at most 200 categories') });
    await s.edit(BOB);
    s.toggle('pets');
    expect(await s.save()).toMatchObject({ ok: false, kind: 'limit' });
    expect(s.getState()).toMatchObject({ problem: 'at most 200 categories', editing: { userId: BOB, draft: ['health', 'travel', 'pets'] }, notice: null });
  });

  it('a save the service says is about a category or a person who has gone reloads everything and closes the picker', async () => {
    const category = await opened({ setGrant: bad('invalid', 'every category must be one of your own', { field: 'categories' }) });
    await category.s.edit(BOB);
    await category.s.save();
    expect(category.s.getState()).toMatchObject({ editing: null, problem: 'every category must be one of your own', mine: { status: 'idle' } });
    expect(names(category.calls).filter((n) => n === 'listGrants')).toHaveLength(2);
    const left = await opened({ setGrant: bad('not-found', 'That person is no longer in this circle.', { what: 'member' }), listMembers: [page([member(ME, 'me'), member(BOB, 'bob'), member(CAT, 'cat')]), page([member(ME, 'me'), member(CAT, 'cat')])] });
    await left.s.edit(BOB);
    await left.s.save();
    expect(left.s.getState().people.map((p) => p.userId)).toEqual([CAT]);
    expect(left.s.getState()).toMatchObject({ editing: null, problem: 'That person is no longer in this circle.' });
  });

  it('a circle that went while saving is gone', async () => {
    const { s } = await opened({ setGrant: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    await s.edit(BOB);
    await s.save();
    expect(s.getState()).toMatchObject({ status: 'gone', people: [], editing: null });
  });

  it('opening a picker for someone not in the list sends nothing; a failure to load my categories closes it with the words', async () => {
    const { s, calls } = await opened();
    expect(await s.edit('u0000000000000009')).toMatchObject({ ok: false, kind: 'not-found' });
    expect(names(calls)).toEqual(['listMembers', 'listGrants']);
    const f = await opened({ categories: bad('server', 'Something went wrong') });
    await f.s.edit(BOB);
    expect(f.s.getState()).toMatchObject({ editing: null, problem: 'Something went wrong', mine: { status: 'error', error: 'Something went wrong' } });
  });

  it('saving with no picker open sends nothing', async () => {
    const { s, calls } = await opened();
    expect(await s.save()).toMatchObject({ ok: false });
    expect(names(calls)).not.toContain('setGrant');
  });
});

describe('stopping', () => {
  it('asks first; nothing is sent until it is confirmed, and cancelling sends nothing', async () => {
    const { s, calls } = await opened();
    expect(s.askStop(BOB)).toBe(true);
    expect(s.getState().asking).toBe(BOB);
    expect(s.cancel()).toBe(true);
    expect(s.cancel()).toBe(false);
    expect(names(calls)).not.toContain('withdrawGrant');
    expect(await s.confirmStop()).toMatchObject({ ok: false });
    expect(names(calls)).not.toContain('withdrawGrant');
  });

  it('confirming withdraws, reloads and says so', async () => {
    const { s, calls } = await opened({ listGrants: [page([grant(BOB, ['a'])]), page([])] });
    s.askStop(BOB);
    expect(await s.confirmStop()).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'withdrawGrant').args).toEqual([C, BOB]);
    expect(s.getState()).toMatchObject({ asking: null, notice: 'Stopped sharing with Display bob.' });
    expect(s.getState().people.every((p) => p.shared.length === 0)).toBe(true);
  });

  it('asking closes an open picker, and a picker closes a question', async () => {
    const { s } = await opened();
    await s.edit(BOB);
    s.askStop(BOB);
    expect(s.getState()).toMatchObject({ editing: null, asking: BOB });
    await s.edit(CAT);
    expect(s.getState()).toMatchObject({ editing: { userId: CAT }, asking: null });
  });

  it('asking about someone not in the list is refused', async () => {
    const { s } = await opened();
    expect(s.askStop('u0000000000000009')).toBe(false);
    expect(s.getState().asking).toBeNull();
  });

  it('a failed withdrawal shows the words; a person who has gone, or a circle that has, reloads', async () => {
    const a = await opened({ withdrawGrant: bad('server', 'Something went wrong') });
    a.s.askStop(BOB);
    expect(await a.s.confirmStop()).toMatchObject({ ok: false, kind: 'server' });
    expect(a.s.getState()).toMatchObject({ problem: 'Something went wrong', asking: null });
    const b = await opened({ withdrawGrant: bad('not-found', 'That person is no longer in this circle.', { what: 'member' }) });
    b.s.askStop(BOB);
    await b.s.confirmStop();
    expect(b.s.getState()).toMatchObject({ problem: 'That person is no longer in this circle.', status: 'loaded' });
    expect(names(b.calls).filter((n) => n === 'listMembers')).toHaveLength(2);
    const c = await opened({ withdrawGrant: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    c.s.askStop(BOB);
    await c.s.confirmStop();
    expect(c.s.getState()).toMatchObject({ status: 'gone', people: [] });
  });
});

describe('requests', () => {
  it('one at a time: everything else is refused while one is out, and sends nothing', async () => {
    const d = deferred();
    const f = fake({ ...defaults(), listMembers: () => d.promise });
    const s = createGrantsSession({ sharing: f.sharing, circles: f.circles, notes: f.notes });
    const first = s.open(C, ME);
    expect(await s.refresh()).toMatchObject({ kind: 'busy' });
    expect(await s.edit(BOB)).toMatchObject({ kind: 'busy' });
    expect(await s.save()).toMatchObject({ kind: 'busy' });
    expect(await s.confirmStop()).toMatchObject({ kind: 'busy' });
    expect(s.askStop(BOB)).toBe(false);
    expect(s.toggle('x')).toBe(false);
    d.resolve(page([member(ME, 'me')]));
    await first;
    expect(names(f.calls)).toEqual(['listMembers', 'listGrants']);
  });

  it('an answer for a circle that is no longer open is dropped and is not a sign-out', async () => {
    const d = deferred();
    let signedOut = 0;
    const f = fake({ ...defaults(), listMembers: () => d.promise });
    const s = createGrantsSession({ sharing: f.sharing, circles: f.circles, notes: f.notes, onSignedOut: () => signedOut++ });
    const first = s.open(C, ME);
    s.reset();
    d.resolve(bad('signed-out', 'Your session has ended. Sign in again.'));
    expect(await first).toMatchObject({ kind: 'dropped' });
    expect(signedOut).toBe(0);
    expect(s.getState()).toMatchObject({ circleId: null, status: 'idle', people: [], busy: false });
  });

  it('a late answer does not clear a newer request\'s busy mark', async () => {
    const d = deferred();
    let n = 0;
    const f = fake({ ...defaults(), listMembers: () => (++n === 1 ? d.promise : new Promise(() => {})) });
    const s = createGrantsSession({ sharing: f.sharing, circles: f.circles, notes: f.notes });
    const first = s.open(C, ME);
    void s.open(C, ME);
    d.resolve(page([member(ME, 'me')]));
    await first;
    expect(s.getState().busy).toBe(true);
  });

  it('a signed-out answer is reported once', async () => {
    let signedOut = 0;
    await opened({ listMembers: bad('signed-out', 'Your session has ended. Sign in again.') }, { onSignedOut: () => signedOut++ });
    expect(signedOut).toBe(1);
  });

  it('snapshots are frozen, listeners are told, a broken listener is ignored, unsubscribing works', async () => {
    const f = fake(defaults());
    const s = createGrantsSession({ sharing: f.sharing, circles: f.circles, notes: f.notes });
    const seen = [];
    s.subscribe(() => { throw new Error('bad'); });
    const off = s.subscribe((v) => seen.push(v.status));
    await s.open(C, ME);
    await s.edit(BOB);
    const v = s.getState();
    expect(Object.isFrozen(v) && Object.isFrozen(v.people) && Object.isFrozen(v.people[0]) && Object.isFrozen(v.people[0].shared) && Object.isFrozen(v.editing) && Object.isFrozen(v.editing.draft) && Object.isFrozen(v.mine) && Object.isFrozen(v.mine.items)).toBe(true);
    off();
    const n = seen.length;
    s.reset();
    expect(seen).toHaveLength(n);
    expect(n).toBeGreaterThan(2);
  });

  it('reset forgets everything', async () => {
    const { s } = await opened();
    await s.edit(BOB);
    s.reset();
    expect(s.getState()).toMatchObject({ circleId: null, status: 'idle', people: [], editing: null, asking: null, notice: null, problem: null, mine: { status: 'idle', items: [] } });
  });

  it('needs the three clients', () => {
    expect(() => createGrantsSession({})).toThrow(TypeError);
    const f = fake();
    expect(() => createGrantsSession({ sharing: f.sharing, circles: f.circles })).toThrow(TypeError);
  });
});

describe('more edges', () => {
  it('ticking is refused while a save is out', async () => {
    const d = deferred();
    const { s } = await opened({ setGrant: () => d.promise });
    await s.edit(BOB);
    const saving = s.save();
    expect(s.toggle('pets')).toBe(false);
    expect(s.getState().editing.draft).toEqual(['health', 'travel']);
    d.resolve(okv({ grant: grant(BOB, ['health', 'travel']) }));
    await saving;
  });
});

