import { describe, expect, it } from 'vitest';
import { createBrainSession } from './brain-session.js';

const cat = (id, extra = {}) => ({ id, name: `Name ${id}`, itemCount: 2, ...extra });
const itm = (id, extra = {}) => ({ id, data: { title: `T ${id}`, summary: `S ${id}` }, ...extra });
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const page = (items, nextCursor = null) => okv({ items, nextCursor });
const items = (category, list, nextCursor = null) => okv({ category, items: list, nextCursor });
const detail = (id, cats = [{ id: 'c1', name: 'Name c1', weight: 0.9 }], extra = {}) => okv({ item: itm(id), categories: cats, ...extra });
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
const loaded = async (script = {}, options = {}) => {
  const f = fakeClient({ categories: page([cat('c1'), cat('c2')]), categoryItems: items({ id: 'c1' }, [itm('i1'), itm('i2')]), item: detail('i1'), ...script });
  const s = createBrainSession({ client: f.client, ...options });
  await s.load();
  return { s, ...f };
};

describe('the categories', () => {
  it('start idle and needing a load; loading shows the first page', async () => {
    const { client, calls } = fakeClient({ categories: page([cat('c1'), cat('c2')], 'p2') });
    const s = createBrainSession({ client });
    expect(s.getState()).toMatchObject({ view: 'categories', needsLoad: true, categories: { status: 'idle', items: [], nextCursor: null }, category: null, item: null, busy: false });
    expect(await s.load()).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ view: 'categories', needsLoad: false, categories: { status: 'loaded', nextCursor: 'p2', error: null } });
    expect(s.getState().categories.items.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(calls[0].args[0]).toEqual({ limit: 50 });
  });

  it('shows more by cursor, nothing is asked when there is no more, and loading again starts from the first page', async () => {
    const { s, calls } = await loaded({ categories: [page([cat('c1')], 'p2'), page([cat('c2')]), page([cat('c9')])] });
    await s.moreCategories();
    expect(s.getState().categories.items.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(s.getState().categories.nextCursor).toBeNull();
    expect(calls[1].args[0]).toEqual({ limit: 50, cursor: 'p2' });
    await s.moreCategories();
    expect(calls).toHaveLength(2);
    await s.load();
    expect(s.getState().categories.items.map((c) => c.id)).toEqual(['c9']);
  });

  it('keeps the count marks as the service gave them', async () => {
    const { s } = await loaded({ categories: page([cat('c1', { itemCount: 9999, itemCountCapped: true }), { id: 'c2', itemCount: 0 }]) });
    expect(s.getState().categories.items[0]).toMatchObject({ itemCount: 9999, itemCountCapped: true });
    expect(s.getState().categories.items[1].name).toBeUndefined();
  });

  it('a failed load shows the words and an empty list; a failed "more" keeps what was shown', async () => {
    const a = fakeClient({ categories: bad('server', 'Down.') });
    const s = createBrainSession({ client: a.client });
    expect(await s.load()).toMatchObject({ ok: false, kind: 'server', message: 'Down.' });
    expect(s.getState().categories).toMatchObject({ status: 'error', error: 'Down.', items: [], nextCursor: null });
    const { s: t } = await loaded({ categories: [page([cat('c1')], 'p2'), bad('network', 'Offline.')] });
    await t.moreCategories();
    expect(t.getState().categories).toMatchObject({ status: 'loaded', error: 'Offline.', nextCursor: 'p2' });
    expect(t.getState().categories.items).toHaveLength(1);
  });

  it('marking it out of date makes the next visit reload, and loading clears the mark', async () => {
    const { s } = await loaded();
    expect(s.getState().needsLoad).toBe(false);
    s.markStale();
    expect(s.getState().needsLoad).toBe(true);
    await s.load();
    expect(s.getState().needsLoad).toBe(false);
  });

  it('an empty brain is loaded and empty', async () => {
    const { s } = await loaded({ categories: page([]) });
    expect(s.getState().categories).toMatchObject({ status: 'loaded', items: [] });
    expect(s.getState().needsLoad).toBe(false);
  });
});

describe('one category', () => {
  it('opens with its name from the list, loads its first page, and shows more', async () => {
    const { s, calls } = await loaded({ categoryItems: [items({ id: 'c1', name: 'Name c1' }, [itm('i1')], 'q2'), items({ id: 'c1', name: 'Name c1' }, [itm('i2')])] });
    const p = s.selectCategory('c1');
    expect(s.getState()).toMatchObject({ view: 'category', category: { id: 'c1', name: 'Name c1', status: 'loading', items: [] }, busy: true });
    expect(await p).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ view: 'category', category: { id: 'c1', status: 'loaded', nextCursor: 'q2', error: null } });
    expect(calls.find((c) => c.name === 'categoryItems').args).toEqual(['c1', { limit: 50 }]);
    await s.moreItems();
    expect(s.getState().category.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(calls.filter((c) => c.name === 'categoryItems')[1].args).toEqual(['c1', { limit: 50, cursor: 'q2' }]);
    await s.moreItems();
    expect(calls.filter((c) => c.name === 'categoryItems')).toHaveLength(2);
  });

  it('takes the name from the service when the list did not have it', async () => {
    const { s } = await loaded({ categoryItems: items({ id: 'zz', name: 'From service' }, [itm('i1')]) });
    await s.selectCategory('zz');
    expect(s.getState().category.name).toBe('From service');
  });

  it('keeps the shortened mark on an item', async () => {
    const { s } = await loaded({ categoryItems: items({ id: 'c1' }, [itm('i1', { dataTruncated: true }), itm('i2')]) });
    await s.selectCategory('c1');
    expect(s.getState().category.items[0].dataTruncated).toBe(true);
    expect(s.getState().category.items[1].dataTruncated).toBeUndefined();
  });

  it('a category that is gone says so, in one set of words, with a way back', async () => {
    const { s } = await loaded({ categoryItems: bad('not-found', 'Not found: it may have been removed.', { what: 'category' }) });
    expect(await s.selectCategory('gone')).toMatchObject({ ok: false, kind: 'not-found', message: 'Not found: it may have been removed.' });
    expect(s.getState()).toMatchObject({ view: 'category', category: { id: 'gone', status: 'gone', error: 'Not found: it may have been removed.', items: [] } });
    expect(s.back()).toBe(true);
    expect(s.getState().view).toBe('categories');
  });

  it('other failures show the words; a failed "more" keeps the items', async () => {
    const { s } = await loaded({ categoryItems: [bad('server', 'Down.'), items({ id: 'c1' }, [itm('i1')], 'q2'), bad('network', 'Offline.')] });
    await s.selectCategory('c1');
    expect(s.getState().category).toMatchObject({ status: 'error', error: 'Down.', items: [] });
    await s.selectCategory('c1');
    await s.moreItems();
    expect(s.getState().category).toMatchObject({ status: 'loaded', error: 'Offline.', nextCursor: 'q2' });
    expect(s.getState().category.items).toHaveLength(1);
  });

  it('opening another category replaces the first, and an awkward id is passed as it is', async () => {
    const odd = 'a/b?c=d&e#f %é😀<b>..';
    const { s, calls } = await loaded({ categoryItems: (id) => items({ id }, [itm('i1')]) });
    await s.selectCategory('c1');
    await s.selectCategory(odd);
    expect(s.getState().category).toMatchObject({ id: odd, status: 'loaded' });
    expect(calls.filter((c) => c.name === 'categoryItems').map((c) => c.args[0])).toEqual(['c1', odd]);
  });
});

describe('one item', () => {
  it('opens with its data and the categories it is filed under, and back returns to the list it came from', async () => {
    const { s, calls } = await loaded({ item: detail('i1', [{ id: 'c1', name: 'Name c1', weight: 0.9 }, { id: 'c2', weight: 1 }], { moreCategories: true }) });
    await s.selectCategory('c1');
    const p = s.selectItem('i1');
    expect(s.getState()).toMatchObject({ view: 'item', item: { id: 'i1', status: 'loading', detail: null }, busy: true });
    expect(await p).toEqual({ ok: true });
    expect(s.getState().item).toMatchObject({ status: 'loaded', error: null });
    expect(s.getState().item.detail.categories.map((c) => c.weight)).toEqual([0.9, 1]);
    expect(s.getState().item.detail.moreCategories).toBe(true);
    expect(calls.find((c) => c.name === 'item').args).toEqual(['i1']);
    expect(s.back()).toBe(true);
    expect(s.getState()).toMatchObject({ view: 'category', item: null, category: { id: 'c1', status: 'loaded' } });
    expect(s.back()).toBe(true);
    expect(s.getState().view).toBe('categories');
    expect(s.back()).toBe(false);
  });

  it('an item that is gone says so, in one set of words', async () => {
    const { s } = await loaded({ item: bad('not-found', 'Not found: it may have been removed.', { what: 'item' }) });
    await s.selectItem('x');
    expect(s.getState().item).toMatchObject({ id: 'x', status: 'gone', error: 'Not found: it may have been removed.', detail: null });
  });

  it('other failures show the words', async () => {
    const { s } = await loaded({ item: bad('server', 'Down.') });
    expect(await s.selectItem('x')).toMatchObject({ ok: false, kind: 'server' });
    expect(s.getState().item).toMatchObject({ status: 'error', error: 'Down.' });
  });

  it('choosing a category from an item\'s list leaves the item', async () => {
    const { s } = await loaded();
    await s.selectItem('i1');
    await s.selectCategory('c2');
    expect(s.getState()).toMatchObject({ view: 'category', item: null, category: { id: 'c2' } });
  });
});

describe('details found by mutation', () => {
  it('loading again goes back to the categories, leaving any open category or item', async () => {
    const { s } = await loaded();
    await s.selectCategory('c1');
    await s.selectItem('i1');
    await s.load();
    expect(s.getState()).toMatchObject({ view: 'categories', category: null, item: null });
  });

  it('keeps the name from the list when the service gives none, and tells listeners about each step', async () => {
    const { s } = await loaded({ categoryItems: items({ id: 'c1' }, [itm('i1')]) });
    const seen = [];
    s.subscribe((v) => seen.push(`${v.view}:${v.item?.status ?? v.category?.status ?? '-'}`));
    await s.selectCategory('c1');
    expect(s.getState().category.name).toBe('Name c1');
    await s.selectItem('i1');
    expect(seen).toContain('item:loading');
    seen.length = 0;
    s.back();
    s.back();
    expect(seen).toEqual(['category:loaded', 'categories:-']);
  });
});

describe('back', () => {
  it('sends nothing, and is refused while a request is out', async () => {
    const g = deferred();
    const { s, calls } = await loaded({ categoryItems: () => g.promise });
    const p = s.selectCategory('c1');
    const sent = calls.length;
    expect(s.back()).toBe(false);
    g.resolve(items({ id: 'c1' }, []));
    await p;
    expect(s.back()).toBe(true);
    expect(calls).toHaveLength(sent);
  });
});

describe('one request at a time', () => {
  it('every action is refused while one is out, and nothing is sent', async () => {
    const g = deferred();
    const f = fakeClient({ categories: () => g.promise, categoryItems: items({ id: 'c1' }, []), item: detail('i1') });
    const s = createBrainSession({ client: f.client });
    const first = s.load();
    for (const r of [await s.load(), await s.moreCategories(), await s.selectCategory('c1'), await s.selectItem('i1'), await s.moreItems()]) expect(r.kind).toBe('busy');
    g.resolve(page([cat('c1')]));
    await first;
    expect(names(f.calls)).toEqual(['categories']);
    expect(s.getState().busy).toBe(false);
  });

  it('busy is cleared after a failure', async () => {
    const { s } = await loaded({ item: bad('server') });
    await s.selectItem('x');
    expect(s.getState().busy).toBe(false);
  });
});

describe('signing out and leaving the screen', () => {
  it('a signed-out answer calls onSignedOut; a throwing callback does not matter', async () => {
    let n = 0;
    const f = fakeClient({ categories: bad('signed-out', 'Your session has ended. Sign in again.') });
    const s = createBrainSession({ client: f.client, onSignedOut: () => n++ });
    expect(await s.load()).toMatchObject({ kind: 'signed-out' });
    expect(n).toBe(1);
    const t = createBrainSession({ client: f.client, onSignedOut: () => { throw new Error('x'); } });
    expect((await t.load()).kind).toBe('signed-out');
  });

  it('reset forgets everything, and an answer that arrives afterwards is dropped quietly', async () => {
    const g = deferred();
    let n = 0;
    const f = fakeClient({ categories: [page([cat('c1')]), () => g.promise] });
    const s = createBrainSession({ client: f.client, onSignedOut: () => n++ });
    await s.load();
    const late = s.load();
    s.reset();
    expect(s.getState()).toMatchObject({ view: 'categories', needsLoad: true, categories: { status: 'idle', items: [] }, category: null, item: null, busy: false });
    g.resolve(page([cat('c9')]));
    expect(await late).toMatchObject({ ok: false, kind: 'dropped' });
    expect(s.getState().categories.items).toEqual([]);
    expect(n).toBe(0);
  });

  it('a late answer for a category or an item after a reset is dropped too', async () => {
    const g = deferred();
    const h = deferred();
    const { s } = await loaded({ categoryItems: () => g.promise, item: () => h.promise });
    const a = s.selectCategory('c1');
    s.reset();
    g.resolve(items({ id: 'c1' }, [itm('i1')]));
    expect((await a).kind).toBe('dropped');
    expect(s.getState().category).toBeNull();
    const b = s.selectItem('i1');
    s.reset();
    h.resolve(detail('i1'));
    expect((await b).kind).toBe('dropped');
    expect(s.getState().item).toBeNull();
  });

  it('an old request finishing after a reset does not clear the busy mark of a newer one', async () => {
    const a = deferred();
    const b = deferred();
    const queue = [a, b];
    const f = fakeClient({ categories: () => queue.shift().promise });
    const s = createBrainSession({ client: f.client });
    const old = s.load();
    s.reset();
    const fresh = s.load();
    a.resolve(page([cat('c1')]));
    await old;
    expect(s.getState().busy).toBe(true);
    b.resolve(page([cat('c2')]));
    await fresh;
    expect(s.getState()).toMatchObject({ busy: false });
    expect(s.getState().categories.items.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('listeners and construction', () => {
  it('listeners hear changes, can leave, and a broken one does not matter', async () => {
    const f = fakeClient({ categories: page([cat('c1')]) });
    const s = createBrainSession({ client: f.client });
    const seen = [];
    const off = s.subscribe((v) => seen.push(v.busy));
    s.subscribe(() => { throw new Error('x'); });
    await s.load();
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
    const n = seen.length;
    off();
    await s.load();
    expect(seen).toHaveLength(n);
  });

  it('snapshots are frozen and independent of later changes', async () => {
    const { s } = await loaded({ categories: [page([cat('c1')]), page([cat('c2')])] });
    const before = s.getState();
    expect(Object.isFrozen(before) && Object.isFrozen(before.categories) && Object.isFrozen(before.categories.items)).toBe(true);
    await s.load();
    expect(before.categories.items.map((c) => c.id)).toEqual(['c1']);
    await s.selectCategory('c1');
    expect(Object.isFrozen(s.getState().category) && Object.isFrozen(s.getState().category.items)).toBe(true);
    await s.selectItem('i1');
    expect(Object.isFrozen(s.getState().item)).toBe(true);
  });

  it('needs a client', () => {
    expect(() => createBrainSession({})).toThrow(TypeError);
    expect(() => createBrainSession({ client: {} })).toThrow(TypeError);
  });
});
