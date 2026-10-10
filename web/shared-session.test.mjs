import { describe, expect, it } from 'vitest';
import { createSharedSession } from './shared-session.js';

const C = 'c0123456789abcdef';
const U = 'u0123456789abcdef';
const cat = (id, extra = {}) => ({ id, name: `Name ${id}`, itemCount: 2, ...extra });
const itm = (id, extra = {}) => ({ id, data: { title: `T ${id}` }, ...extra });
const person = (userId = U, extra = {}) => ({ userId, username: 'ann', displayName: 'Ann A', categoryCount: 2, ...extra });
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const page = (items, nextCursor = null) => okv({ items, nextCursor });
const items = (category, list, nextCursor = null) => okv({ category, items: list, nextCursor });
const detail = (id, cats = [{ id: 'c1', name: 'Name c1', weight: 0.9 }]) => okv({ item: itm(id), categories: cats });
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
const opened = async (script = {}, options = {}) => {
  const f = fakeClient({ sharedWithMe: page([person()]), sharedCategories: page([cat('c1'), cat('c2')]), sharedCategoryItems: items({ id: 'c1', name: 'Name c1' }, [itm('i1'), itm('i2')]), sharedItem: detail('i1'), ...script });
  const s = createSharedSession({ client: f.client, ...options });
  await s.open(C);
  return { s, ...f };
};

describe('who has shared with me', () => {
  it('starts idle; opening loads the first page of people, in the circle asked for', async () => {
    const { client, calls } = fakeClient({ sharedWithMe: page([person()], 'p2') });
    const s = createSharedSession({ client });
    expect(s.getState()).toMatchObject({ circleId: null, status: 'idle', view: 'people', busy: false });
    const pending = s.open(C);
    expect(s.getState()).toMatchObject({ circleId: C, status: 'loading', busy: true });
    expect(await pending).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ status: 'loaded', message: null, view: 'people', people: { status: 'loaded', nextCursor: 'p2' }, busy: false });
    expect(calls[0]).toEqual({ name: 'sharedWithMe', args: [C, { limit: 50 }] });
  });

  it('shows more by cursor and asks nothing when there is no more', async () => {
    const { s, calls } = await opened({ sharedWithMe: [page([person('u1111111111111111')], 'p2'), page([person('u2222222222222222')])] });
    await s.morePeople();
    expect(s.getState().people.items.map((p) => p.userId)).toEqual(['u1111111111111111', 'u2222222222222222']);
    expect(calls[1].args).toEqual([C, { limit: 50, cursor: 'p2' }]);
    await s.morePeople();
    expect(calls).toHaveLength(2);
  });

  it('a failed first load shows the service\'s words and nothing; a failed "more" keeps what was shown', async () => {
    const first = await opened({ sharedWithMe: bad('server', 'Something went wrong') });
    expect(first.s.getState()).toMatchObject({ status: 'error', message: 'Something went wrong', people: { items: [], error: 'Something went wrong' } });
    const more = await opened({ sharedWithMe: [page([person()], 'p2'), bad('network', 'Cannot reach')] });
    expect(await more.s.morePeople()).toMatchObject({ ok: false, kind: 'network' });
    expect(more.s.getState()).toMatchObject({ status: 'loaded', people: { items: [{ userId: U }], error: 'Cannot reach' } });
  });

  it('a circle that is gone says so in the one set of words and shows nothing', async () => {
    const { s } = await opened({ sharedWithMe: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    expect(s.getState()).toMatchObject({ status: 'gone', message: 'No such circle, or you are not in it.', people: { items: [] } });
  });

  it('an answer for an earlier circle is dropped when another is opened', async () => {
    const d = deferred();
    let n = 0;
    const f = fakeClient({ sharedWithMe: () => (++n === 1 ? d.promise : page([])) });
    const t = createSharedSession({ client: f.client });
    const first = t.open(C);
    await t.open('c9999999999999999');
    d.resolve(page([person()]));
    expect(await first).toMatchObject({ kind: 'dropped' });
    expect(t.getState()).toMatchObject({ circleId: 'c9999999999999999', status: 'loaded', busy: false, people: { items: [] } });
  });

  it('refresh reloads the list and goes back to it', async () => {
    const { s, calls } = await opened();
    await s.selectPerson(U);
    expect(s.getState().view).toBe('categories');
    await s.refresh();
    expect(s.getState()).toMatchObject({ view: 'people', owner: null });
    expect(names(calls)).toEqual(['sharedWithMe', 'sharedCategories', 'sharedWithMe']);
  });
});

describe('one person\'s shared brain', () => {
  it('selecting a person loads their categories, with the name from the list', async () => {
    const { s, calls } = await opened({ sharedCategories: page([cat('c1'), cat('c2')], 'p2') });
    expect(await s.selectPerson(U)).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ view: 'categories', owner: { userId: U, username: 'ann', displayName: 'Ann A' }, categories: { status: 'loaded', nextCursor: 'p2' } });
    expect(calls[1]).toEqual({ name: 'sharedCategories', args: [C, U, { limit: 50 }] });
    await s.moreCategories();
    expect(calls[2].args[2]).toEqual({ limit: 50, cursor: 'p2' });
  });

  it('a person that is no longer sharing goes back to the list with the words, and the list is reloaded', async () => {
    const { s, calls } = await opened({ sharedWithMe: [page([person()]), page([])], sharedCategories: bad('not-found', 'Nothing is shared with you by that person.', { what: 'brain' }) });
    expect(await s.selectPerson(U)).toMatchObject({ ok: false, kind: 'not-found' });
    expect(s.getState()).toMatchObject({ view: 'people', owner: null, message: 'Nothing is shared with you by that person.', people: { items: [] } });
    expect(names(calls)).toEqual(['sharedWithMe', 'sharedCategories', 'sharedWithMe']);
  });

  it('a circle that vanished while choosing a person is reported as gone', async () => {
    const { s } = await opened({ sharedCategories: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    await s.selectPerson(U);
    expect(s.getState()).toMatchObject({ status: 'gone', owner: null });
  });

  it('a failure other than not-found keeps the person and shows the words', async () => {
    const { s } = await opened({ sharedCategories: bad('server', 'Something went wrong') });
    await s.selectPerson(U);
    expect(s.getState()).toMatchObject({ view: 'categories', categories: { status: 'error', error: 'Something went wrong', items: [] } });
  });

  it('opens a category (its first page, the name from the list) and shows more', async () => {
    const { s, calls } = await opened({ sharedCategoryItems: [items({ id: 'c1' }, [itm('i1')], 'q2'), items({ id: 'c1' }, [itm('i2')])] });
    await s.selectPerson(U);
    expect(await s.selectCategory('c1')).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ view: 'category', category: { id: 'c1', name: 'Name c1', status: 'loaded', nextCursor: 'q2' } });
    expect(calls[2]).toEqual({ name: 'sharedCategoryItems', args: [C, U, 'c1', { limit: 50 }] });
    await s.moreItems();
    expect(s.getState().category.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(calls[3].args[3]).toEqual({ limit: 50, cursor: 'q2' });
    await s.moreItems();
    expect(calls).toHaveLength(4);
  });

  it('a category or item that is no longer shared is gone, with a way back, and the people are reloaded', async () => {
    const gone = bad('not-found', 'Not found: it may no longer be shared with you.', { what: 'category' });
    const a = await opened({ sharedCategoryItems: gone, sharedWithMe: [page([person()]), page([])] });
    await a.s.selectPerson(U);
    expect(await a.s.selectCategory('c1')).toMatchObject({ ok: false, kind: 'not-found' });
    expect(a.s.getState()).toMatchObject({ view: 'category', category: { id: 'c1', status: 'gone', error: 'Not found: it may no longer be shared with you.', items: [] }, people: { items: [] } });
    expect(a.s.back()).toBe(true);
    expect(a.s.getState().view).toBe('categories');
    const b = await opened({ sharedItem: bad('not-found', 'Not found: it may no longer be shared with you.', { what: 'item' }), sharedWithMe: [page([person()]), page([])] });
    await b.s.selectPerson(U);
    await b.s.selectItem('i1');
    expect(b.s.getState()).toMatchObject({ view: 'item', item: { id: 'i1', status: 'gone' }, people: { items: [] } });
  });

  it('opens an item with its shared categories', async () => {
    const { s, calls } = await opened();
    await s.selectPerson(U);
    expect(await s.selectItem('i1')).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ view: 'item', item: { id: 'i1', status: 'loaded', detail: { item: { id: 'i1' }, categories: [{ id: 'c1', weight: 0.9 }] } } });
    expect(calls.at(-1)).toEqual({ name: 'sharedItem', args: [C, U, 'i1'] });
  });

  it('an item failure other than not-found shows the words', async () => {
    const { s } = await opened({ sharedItem: bad('server', 'Something went wrong') });
    await s.selectPerson(U);
    await s.selectItem('i1');
    expect(s.getState().item).toMatchObject({ status: 'error', error: 'Something went wrong' });
  });

  it('choosing a category or item before a person sends nothing', async () => {
    const { s, calls } = await opened();
    expect(await s.selectCategory('c1')).toMatchObject({ ok: false, kind: 'not-found' });
    expect(await s.selectItem('i1')).toMatchObject({ ok: false, kind: 'not-found' });
    expect(await s.moreCategories()).toEqual({ ok: true });
    expect(await s.moreItems()).toEqual({ ok: true });
    expect(names(calls)).toEqual(['sharedWithMe']);
  });

  it('back goes item, category, categories, people, one step at a time and sends nothing', async () => {
    const { s, calls } = await opened();
    await s.selectPerson(U);
    await s.selectCategory('c1');
    await s.selectItem('i1');
    const before = calls.length;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(s.getState().view);
      s.back();
    }
    expect(seen).toEqual(['item', 'category', 'categories', 'people']);
    expect(s.back()).toBe(false);
    expect(calls).toHaveLength(before);
    expect(s.getState().categories.items).toEqual([]);
  });

  it('opening an item leaves the category list it came from', async () => {
    const { s } = await opened();
    await s.selectPerson(U);
    await s.selectCategory('c1');
    await s.selectItem('i1');
    s.back();
    expect(s.getState()).toMatchObject({ view: 'category', category: { id: 'c1', status: 'loaded' } });
  });

  it('a person chosen from the list is looked up by id; one not in the list still works with no names', async () => {
    const { s } = await opened();
    await s.selectPerson('u9999999999999999');
    expect(s.getState().owner).toEqual({ userId: 'u9999999999999999' });
  });
});

describe('requests', () => {
  it('one at a time: a second call while one is out is refused and sends nothing', async () => {
    const d = deferred();
    const { client, calls } = fakeClient({ sharedWithMe: () => d.promise });
    const s = createSharedSession({ client });
    const first = s.open(C);
    expect(await s.morePeople()).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.selectPerson(U)).toMatchObject({ kind: 'busy' });
    expect(await s.selectCategory('x')).toMatchObject({ kind: 'busy' });
    expect(await s.selectItem('x')).toMatchObject({ kind: 'busy' });
    expect(await s.refresh()).toMatchObject({ kind: 'busy' });
    expect(s.back()).toBe(false);
    d.resolve(page([person()]));
    await first;
    expect(calls).toHaveLength(1);
    expect(s.getState().busy).toBe(false);
  });

  it('an answer after reset is dropped, is not a sign-out, and does not clear a newer request\'s busy mark', async () => {
    const d = deferred();
    let signedOut = 0;
    const { client } = fakeClient({ sharedWithMe: () => d.promise });
    const s = createSharedSession({ client, onSignedOut: () => signedOut++ });
    const first = s.open(C);
    s.reset();
    expect(s.getState()).toMatchObject({ circleId: null, status: 'idle', busy: false });
    d.resolve(bad('signed-out', 'Your session has ended. Sign in again.'));
    expect(await first).toMatchObject({ kind: 'dropped' });
    expect(signedOut).toBe(0);
    expect(s.getState()).toMatchObject({ status: 'idle', people: { items: [] } });
  });

  it('a signed-out answer is reported once', async () => {
    let signedOut = 0;
    const { s } = await opened({ sharedWithMe: bad('signed-out', 'Your session has ended. Sign in again.') }, { onSignedOut: () => signedOut++ });
    expect(signedOut).toBe(1);
    expect(s.getState().busy).toBe(false);
  });

  it('a throwing onSignedOut or listener does not matter, and unsubscribing works', async () => {
    const f = fakeClient({ sharedWithMe: bad('signed-out', 'x') });
    const s = createSharedSession({ client: f.client, onSignedOut: () => { throw new Error('boom'); } });
    const seen = [];
    s.subscribe(() => { throw new Error('bad listener'); });
    const off = s.subscribe((v) => seen.push(v.status));
    await s.open(C);
    off();
    const count = seen.length;
    s.reset();
    expect(seen).toHaveLength(count);
    expect(count).toBeGreaterThan(1);
  });

  it('snapshots are frozen all the way down', async () => {
    const { s } = await opened();
    await s.selectPerson(U);
    await s.selectCategory('c1');
    const v = s.getState();
    expect(Object.isFrozen(v) && Object.isFrozen(v.people) && Object.isFrozen(v.people.items) && Object.isFrozen(v.owner) && Object.isFrozen(v.categories.items) && Object.isFrozen(v.category) && Object.isFrozen(v.category.items)).toBe(true);
  });

  it('reset forgets everything, including the selection', async () => {
    const { s } = await opened();
    await s.selectPerson(U);
    await s.selectCategory('c1');
    await s.selectItem('i1');
    s.reset();
    expect(s.getState()).toMatchObject({ circleId: null, status: 'idle', view: 'people', owner: null, category: null, item: null, people: { items: [] }, categories: { items: [] } });
  });

  it('needs a sharing client', () => {
    expect(() => createSharedSession({})).toThrow(TypeError);
    expect(() => createSharedSession({ client: {} })).toThrow(TypeError);
  });
});

describe('more edges', () => {
  it('back is refused while a request is out', async () => {
    const d = deferred();
    let n = 0;
    const { s } = await opened({ sharedCategoryItems: () => (++n === 1 ? d.promise : null) });
    await s.selectPerson(U);
    const pending = s.selectCategory('c1');
    expect(s.back()).toBe(false);
    expect(s.getState().view).toBe('category');
    d.resolve(items({ id: 'c1' }, []));
    await pending;
    expect(s.back()).toBe(true);
  });

  it('a circle that is gone empties everything that was shown', async () => {
    const { s } = await opened({ sharedItem: bad('not-found', 'No such circle, or you are not in it.', { what: 'circle' }) });
    await s.selectPerson(U);
    await s.selectCategory('c1');
    await s.selectItem('i1');
    expect(s.getState()).toMatchObject({ status: 'gone', owner: null, category: null, item: null, people: { items: [] }, categories: { items: [] } });
  });

  it('choosing another person drops the category and item that were open', async () => {
    const { s } = await opened();
    await s.selectPerson(U);
    await s.selectCategory('c1');
    await s.selectItem('i1');
    await s.selectPerson('u2222222222222222');
    expect(s.getState()).toMatchObject({ view: 'categories', category: null, item: null, owner: { userId: 'u2222222222222222' } });
    await s.selectCategory('c1');
    await s.selectItem('i1');
    await s.selectCategory('c2');
    expect(s.getState()).toMatchObject({ view: 'category', item: null, category: { id: 'c2' } });
  });

  it('a late answer does not clear a newer request\'s busy mark', async () => {
    const d = deferred();
    let n = 0;
    const f = fakeClient({ sharedWithMe: () => (++n === 1 ? d.promise : new Promise(() => {})) });
    const s = createSharedSession({ client: f.client });
    const first = s.open(C);
    s.reset();
    void s.open(C);
    d.resolve(page([person()]));
    await first;
    expect(s.getState().busy).toBe(true);
  });

  it('a refresh that fails shows no people', async () => {
    let n = 0;
    const { s } = await opened({ sharedWithMe: () => (++n === 1 ? page([person()]) : bad('server', 'Something went wrong')) });
    n = 1;
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'error', people: { items: [], error: 'Something went wrong' } });
  });
});
