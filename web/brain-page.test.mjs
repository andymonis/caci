import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const cat = (id, extra = {}) => ({ id, name: `Name ${id}`, itemCount: 2, ...extra });
const itm = (id, extra = {}) => ({ id, data: { title: `Title ${id}`, summary: `Summary ${id}` }, ...extra });
const pageOf = (items, nextCursor = null) => ({ status: 200, body: { items, nextCursor } });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};
const P = 'prop-0abc12345-00-abcdef';

function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)/.test(key) ? pageOf([]) : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
    const a = await (typeof entry === 'function' ? entry(calls.length) : entry);
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key) };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, change: (h) => env.setHash(h) };
}
const ME = { 'GET /api/me': { status: 200, body: { user: USER } }, 'GET /api/capture/mode': { status: 200, body: { mode: 'demo' } }, 'GET /api/graph/categories?limit=50': pageOf([cat('c1'), cat('c2', { itemCount: 1 })]) };
async function start(table = {}, hash = '#/brain') {
  const page = fakePage();
  const svc = service({ ...ME, ...table });
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const rows = (page, id) => page.el(id).children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const items = (id, list, extra = {}) => ({ status: 200, body: { category: { id, name: `Name ${id}`, ...extra }, items: list, nextCursor: null } });
const detail = (id, cats = [{ id: 'c1', name: 'Name c1', weight: 0.9 }], extra = {}) => ({ status: 200, body: { item: itm(id), categories: cats, ...extra } });
const visible = (page) => ['categories', 'category', 'item'].find((v) => !page.el(`brain-${v}`).hidden);

describe('the categories', () => {
  it('shows the screen with the focus and the title, and lists each category with its name and count', async () => {
    const { page, svc } = await start();
    expect(page.el('view-brain').hidden).toBe(false);
    expect(page.document.title).toBe('Brain – CaCi');
    expect(page.focused().id).toBe('brain-heading');
    expect(visible(page)).toBe('categories');
    const list = rows(page, 'brain-categories-list');
    expect(list).toHaveLength(2);
    expect(slot(list[0], 'name').textContent).toBe('Name c1');
    expect(slot(list[0], 'count').textContent).toBe('2 items');
    expect(slot(list[1], 'count').textContent).toBe('1 item');
    expect(slot(list[0], 'open').getAttribute('aria-label')).toBe('Open the category Name c1, 2 items');
    expect(page.el('brain-empty').hidden).toBe(true);
    expect(svc.keys()).toContain('GET /api/graph/categories?limit=50');
  });

  it('an empty brain says so, with a way to capture a note', async () => {
    const { page } = await start({ 'GET /api/graph/categories?limit=50': pageOf([]) });
    expect(page.el('brain-empty').hidden).toBe(false);
    expect(page.el('brain-empty').textContent).toContain('Capture a note and approve it');
    expect(page.el('brain-categories-list').hidden).toBe(true);
  });

  it('"Show more" adds the next page', async () => {
    const { page } = await start({ 'GET /api/graph/categories?limit=50': pageOf([cat('c1')], 'abc'), 'GET /api/graph/categories?limit=50&cursor=abc': pageOf([cat('c2')]) });
    expect(page.el('brain-categories-more').hidden).toBe(false);
    page.el('brain-categories-more').fire('click');
    await settle();
    expect(rows(page, 'brain-categories-list')).toHaveLength(2);
    expect(page.el('brain-categories-more').hidden).toBe(true);
  });

  it('a count that was capped says "at least"; a category with no name shows its id', async () => {
    const { page } = await start({ 'GET /api/graph/categories?limit=50': pageOf([cat('big', { itemCount: 9999, itemCountCapped: true }), { id: 'a/b?c', itemCount: 1 }]) });
    const list = rows(page, 'brain-categories-list');
    expect(slot(list[0], 'count').textContent).toBe('at least 9,999 items');
    expect(slot(list[1], 'name').textContent).toBe('a/b?c');
  });

  it('a list that cannot be loaded shows the words as a problem', async () => {
    const { page } = await start({ 'GET /api/graph/categories?limit=50': refuse(500, 'STORAGE_ERROR', 'secret detail') });
    expect(page.el('brain-error').hidden).toBe(false);
    expect(page.el('brain-error').textContent).not.toContain('secret');
  });

  it('Refresh loads again and the loading line shows while a request is out', async () => {
    let n = 0;
    const g = gate();
    const { page } = await start({ 'GET /api/graph/categories?limit=50': () => (++n === 1 ? pageOf([cat('c1')]) : n === 2 ? g.promise : pageOf([cat('c1'), cat('c9')])) });
    expect(rows(page, 'brain-categories-list')).toHaveLength(1);
    page.el('brain-refresh').fire('click');
    await settle();
    expect(page.el('brain-refresh').disabled).toBe(true);
    g.release(pageOf([cat('c1'), cat('c2'), cat('c3')]));
    await settle();
    expect(rows(page, 'brain-categories-list')).toHaveLength(3);
    expect(page.el('brain-refresh').disabled).toBe(false);
  });

  it('the loading line shows before the first answer', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/graph/categories?limit=50': () => g.promise });
    expect(page.el('brain-status').hidden).toBe(false);
    expect(page.el('brain-status').textContent).toBe('Loading…');
    expect(page.el('brain-empty').hidden).toBe(true);
    g.release(pageOf([cat('c1')]));
    await settle();
    expect(page.el('brain-status').hidden).toBe(true);
  });
});

describe('one category', () => {
  const t = (extra = {}) => ({ 'GET /api/graph/category?id=c1&limit=50': items('c1', [itm('i1'), itm('i2', { dataTruncated: true })]), ...extra });

  it('opens with its items (title, summary, shortened mark), takes the focus, and the way back returns to the list', async () => {
    const { page } = await start(t());
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(visible(page)).toBe('category');
    expect(page.el('brain-category-heading').textContent).toBe('Name c1');
    expect(page.focused().id).toBe('brain-category-heading');
    const list = rows(page, 'brain-items-list');
    expect(list.map((r) => slot(r, 'title').textContent)).toEqual(['Title i1', 'Title i2']);
    expect(slot(list[0], 'summary').textContent).toBe('Summary i1');
    expect(slot(list[0], 'shortened').textContent).toBe('');
    expect(slot(list[1], 'shortened').textContent).toBe('Some of this was shortened because it was long.');
    page.el('brain-category-back').fire('click');
    expect(visible(page)).toBe('categories');
    expect(page.focused().id).toBe('brain-heading');
  });

  it('an empty category says so; "show more" adds the next page', async () => {
    const { page } = await start({
      'GET /api/graph/category?id=c1&limit=50': { status: 200, body: { category: { id: 'c1' }, items: [], nextCursor: null } },
      'GET /api/graph/category?id=c2&limit=50': { status: 200, body: { category: { id: 'c2' }, items: [itm('i1')], nextCursor: 'k' } },
      'GET /api/graph/category?id=c2&limit=50&cursor=k': { status: 200, body: { category: { id: 'c2' }, items: [itm('i2')], nextCursor: null } },
    });
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-items-empty').hidden).toBe(false);
    expect(page.el('brain-items-empty').textContent).toBe('There are no items in this category.');
    page.el('brain-category-back').fire('click');
    slot(rows(page, 'brain-categories-list')[1], 'open').fire('click');
    await settle();
    expect(page.el('brain-items-more').hidden).toBe(false);
    page.el('brain-items-more').fire('click');
    await settle();
    expect(rows(page, 'brain-items-list')).toHaveLength(2);
    expect(page.el('brain-items-more').hidden).toBe(true);
  });

  it('a category that is gone says so in one set of words, with a way back', async () => {
    const { page } = await start({ 'GET /api/graph/category?id=c1&limit=50': refuse(404, 'NOT_FOUND', 'no such category') });
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-category-error').hidden).toBe(false);
    expect(page.el('brain-category-error').textContent).toBe('Not found: it may have been removed.');
    expect(rows(page, 'brain-items-list')).toHaveLength(0);
    page.el('brain-category-back').fire('click');
    expect(visible(page)).toBe('categories');
  });

  it('markup in names and titles stays text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { page } = await start({ 'GET /api/graph/categories?limit=50': pageOf([cat('c1', { name: evil })]), [`GET /api/graph/category?id=c1&limit=50`]: items('c1', [{ id: 'i', data: { title: evil, summary: evil } }], { name: evil }) });
    expect(slot(rows(page, 'brain-categories-list')[0], 'name').textContent).toBe(evil);
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-category-heading').textContent).toBe(evil);
    const row = rows(page, 'brain-items-list')[0];
    expect(slot(row, 'title').textContent).toBe(evil);
    expect(slot(row, 'summary').textContent).toBe(evil);
    expect(slot(row, 'title').children).toEqual([]);
  });

  it('an awkward id is sent in the query string, encoded', async () => {
    const odd = 'a/b?c=d&e#f %é😀<b>..';
    const { page, svc } = await start({ 'GET /api/graph/categories?limit=50': pageOf([cat(odd)]), [`GET /api/graph/category?id=${encodeURIComponent(odd)}&limit=50`]: items(odd, [itm('i1')]) });
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(rows(page, 'brain-items-list')).toHaveLength(1);
    expect(svc.keys()).toContain(`GET /api/graph/category?id=${encodeURIComponent(odd)}&limit=50`);
  });
});

describe('one item', () => {
  const t = (extra = {}) => ({ 'GET /api/graph/category?id=c1&limit=50': items('c1', [itm('i1')]), 'GET /api/graph/item?id=i1': detail('i1', [{ id: 'c1', name: 'Name c1', weight: 0.9 }, { id: 'c2', weight: 1 }]), ...extra });
  const openItem = async (page) => {
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    slot(rows(page, 'brain-items-list')[0], 'open').fire('click');
    await settle();
  };

  it('shows its data as text and the categories it is filed under with weights, takes the focus, and the way back returns to the category', async () => {
    const { page } = await start(t());
    await openItem(page);
    expect(visible(page)).toBe('item');
    expect(page.el('brain-item-heading').textContent).toBe('Title i1');
    expect(page.focused().id).toBe('brain-item-heading');
    expect(rows(page, 'brain-item-data').map((r) => `${slot(r, 'key').textContent}=${slot(r, 'value').textContent}`)).toEqual(['title=Title i1', 'summary=Summary i1']);
    const cats = rows(page, 'brain-item-categories');
    expect(cats.map((r) => slot(r, 'name').textContent)).toEqual(['Name c1', 'c2']);
    expect(slot(cats[0], 'weight').textContent).toBe('weight 0.9');
    expect(page.el('brain-item-shortened').hidden).toBe(true);
    expect(page.el('brain-item-more').hidden).toBe(true);
    page.el('brain-item-back').fire('click');
    expect(visible(page)).toBe('category');
    expect(page.focused().id).toBe('brain-category-heading');
  });

  it('says when data was shortened and when more categories exist than are shown', async () => {
    const { page } = await start(t({ 'GET /api/graph/item?id=i1': { status: 200, body: { item: itm('i1', { dataTruncated: true }), categories: [], moreCategories: true } } }));
    await openItem(page);
    expect(page.el('brain-item-shortened').hidden).toBe(false);
    expect(page.el('brain-item-shortened').textContent).toBe('Some of this was shortened because it was long.');
    expect(page.el('brain-item-more').hidden).toBe(false);
    expect(page.el('brain-item-more').textContent).toBe('This item is filed under more categories than are shown here.');
  });

  it('choosing a category from an item opens it', async () => {
    const { page } = await start(t({ 'GET /api/graph/category?id=c2&limit=50': items('c2', [itm('i9')]) }));
    await openItem(page);
    slot(rows(page, 'brain-item-categories')[1], 'open').fire('click');
    await settle();
    expect(visible(page)).toBe('category');
    expect(page.el('brain-category-heading').textContent).toBe('Name c2');
    expect(rows(page, 'brain-items-list')).toHaveLength(1);
  });

  it('an item that is gone says so, with a way back', async () => {
    const { page } = await start(t({ 'GET /api/graph/item?id=i1': refuse(404, 'NOT_FOUND', 'no such item') }));
    await openItem(page);
    expect(page.el('brain-item-error').hidden).toBe(false);
    expect(page.el('brain-item-error').textContent).toBe('Not found: it may have been removed.');
    expect(rows(page, 'brain-item-data')).toHaveLength(0);
    page.el('brain-item-back').fire('click');
    expect(visible(page)).toBe('category');
  });

  it('data of any shape is shown as text', async () => {
    const evil = '<script>x</script>';
    const { page } = await start(t({ 'GET /api/graph/item?id=i1': { status: 200, body: { item: { id: 'i1', data: { title: evil, tags: ['a', 'b'], n: 3 } }, categories: [] } } }));
    await openItem(page);
    expect(rows(page, 'brain-item-data').map((r) => slot(r, 'value').textContent)).toEqual([evil, '["a","b"]', '3']);
    expect(slot(rows(page, 'brain-item-data')[0], 'value').children).toEqual([]);
  });
});

describe('details the first mutation run found', () => {
  it('lists are visible when they have rows, and the other levels are hidden', async () => {
    const { page } = await start({ 'GET /api/graph/category?id=c1&limit=50': items('c1', [itm('i1')]), 'GET /api/graph/item?id=i1': detail('i1') });
    expect(page.el('brain-categories-list').hidden).toBe(false);
    expect(page.el('brain-category').hidden).toBe(true);
    expect(page.el('brain-item').hidden).toBe(true);
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-items-list').hidden).toBe(false);
    expect(page.el('brain-categories').hidden).toBe(true);
    expect(page.el('brain-item').hidden).toBe(true);
    slot(rows(page, 'brain-items-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-item').hidden).toBe(false);
    expect(page.el('brain-categories').hidden).toBe(true);
    expect(page.el('brain-category').hidden).toBe(true);
  });

  it('"Show more" does not bring the loading line back, and its button, the category buttons and Refresh are disabled while it is out', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/graph/categories?limit=50': pageOf([cat('c1')], 'abc'), 'GET /api/graph/categories?limit=50&cursor=abc': () => g.promise });
    page.el('brain-categories-more').fire('click');
    await settle();
    expect(page.el('brain-status').hidden).toBe(true);
    expect(page.el('brain-categories-more').disabled).toBe(true);
    expect(slot(rows(page, 'brain-categories-list')[0], 'open').disabled).toBe(true);
    g.release(pageOf([cat('c2')]));
    await settle();
    expect(page.el('brain-categories-more').disabled).toBe(false);
    expect(slot(rows(page, 'brain-categories-list')[0], 'open').disabled).toBe(false);
  });

  it('while a category\'s items load the "no items" text is hidden; "show more" for items and the item\'s back button are disabled while a request is out', async () => {
    const g = gate();
    const h = gate();
    const { page } = await start({
      'GET /api/graph/category?id=c1&limit=50': () => g.promise,
      'GET /api/graph/category?id=c2&limit=50': { status: 200, body: { category: { id: 'c2' }, items: [itm('i1')], nextCursor: 'k' } },
      'GET /api/graph/category?id=c2&limit=50&cursor=k': () => h.promise,
      'GET /api/graph/item?id=i1': detail('i1'),
    });
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-items-empty').hidden).toBe(true);
    g.release(items('c1', []));
    await settle();
    expect(page.el('brain-items-empty').hidden).toBe(false);
    page.el('brain-category-back').fire('click');
    slot(rows(page, 'brain-categories-list')[1], 'open').fire('click');
    await settle();
    page.el('brain-items-more').fire('click');
    await settle();
    expect(page.el('brain-items-more').disabled).toBe(true);
    h.release({ status: 200, body: { category: { id: 'c2' }, items: [itm('i2')], nextCursor: null } });
    await settle();
    expect(page.el('brain-items-more').hidden).toBe(true);
  });

  it('the item\'s back button is disabled while the item is loading', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/graph/category?id=c1&limit=50': items('c1', [itm('i1')]), 'GET /api/graph/item?id=i1': () => g.promise });
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    slot(rows(page, 'brain-items-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-item-back').disabled).toBe(true);
    g.release(detail('i1'));
    await settle();
    expect(page.el('brain-item-back').disabled).toBe(false);
  });
});

describe('between screens', () => {
  it('leaving and coming back keeps what was shown, without asking again', async () => {
    const { page, addr, svc } = await start();
    addr.change('#/');
    await settle();
    addr.change('#/brain');
    await settle();
    expect(rows(page, 'brain-categories-list')).toHaveLength(2);
    expect(svc.keys().filter((k) => k === 'GET /api/graph/categories?limit=50')).toHaveLength(1);
  });

  it('an approved note makes the next visit reload the categories', async () => {
    let n = 0;
    const { page, addr, svc } = await start({
      'GET /api/graph/categories?limit=50': () => pageOf(++n === 1 ? [cat('c1')] : [cat('c1'), cat('c2')]),
      'POST /api/capture/propose': { status: 201, body: { proposal: { id: P, createdAt: 1, expiresAt: 2, mode: 'demo', text: 't', summary: { newItems: [], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [] }, operations: [] } } },
      [`POST /api/capture/proposals/${P}/approve`]: { status: 200, body: { written: { id: P, applied: 1, summary: { newItems: [], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [] } } } },
    });
    expect(rows(page, 'brain-categories-list')).toHaveLength(1);
    addr.change('#/capture');
    await settle();
    fill(page, 'capture', { note: 'a note' });
    page.el('capture-form').fire('submit');
    await settle();
    page.el('capture-approve').fire('click');
    await settle();
    addr.change('#/brain');
    await settle();
    expect(rows(page, 'brain-categories-list')).toHaveLength(2);
    expect(svc.keys().filter((k) => k === 'GET /api/graph/categories?limit=50')).toHaveLength(2);
  });

  it('signing out forgets the brain, and the next person starts clean', async () => {
    const { page } = await start({ 'POST /api/logout': { status: 204 } });
    page.el('nav-home').fire('click');
    page.el('signout').fire('click');
    await settle();
    expect(rows(page, 'brain-categories-list')).toHaveLength(0);
    expect(page.el('brain-categories').hidden).toBe(false);
  });

  it('controls are disabled while a request is out', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/graph/category?id=c1&limit=50': () => g.promise });
    slot(rows(page, 'brain-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.el('brain-refresh').disabled).toBe(true);
    expect(page.el('brain-category-back').disabled).toBe(true);
    g.release(items('c1', [itm('i1')]));
    await settle();
    expect(page.el('brain-category-back').disabled).toBe(false);
    expect(slot(rows(page, 'brain-items-list')[0], 'open').disabled).toBe(false);
  });

  it('mounting fails loudly if the page lacks an element the Brain screen needs', () => {
    const page = fakePage();
    const broken = { title: '', getElementById: (id) => (id === 'brain-item-back' ? null : page.document.getElementById(id)) };
    expect(() => mount(broken, service().fetchFn)).toThrow(/no element "brain-item-back"/);
  });
});
