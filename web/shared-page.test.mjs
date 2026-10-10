import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const C = 'c0000000000000001';
const U = (n) => `u${String(n).padStart(16, '0')}`;
const ME = U(1);
const OWNER = U(2);
const USER = { id: ME, username: 'bob', displayName: 'Bob B' };
const circle = { id: C, name: 'Team', role: 'member', memberCount: 3, createdAt: 1, updatedAt: 1 };
const pageOf = (items, nextCursor = null) => ({ status: 200, body: { items, nextCursor } });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const person = (n = 2, extra = {}) => ({ userId: U(n), username: `user${n}`, displayName: `User ${n}`, categoryCount: 2, ...extra });
const cat = (id, extra = {}) => ({ id, name: id.toUpperCase(), itemCount: 2, ...extra });
const itm = (id, extra = {}) => ({ id, data: { title: `T ${id}`, summary: `S ${id}` }, ...extra });

const S = `/api/circles/${C}/shared`;
function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push(key);
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)\?/.test(key) ? pageOf([]) : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
    const a = await (typeof entry === 'function' ? entry(calls.length) : entry);
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, change: (h) => env.setHash(h) };
}
const base = (extra = {}) => ({
  'GET /api/me': { status: 200, body: { user: USER } },
  [`GET /api/circles/${C}`]: { status: 200, body: { circle } },
  [`GET /api/circles/${C}/members?limit=50`]: pageOf([]),
  [`GET /api/circles/${C}/invitations?limit=50`]: pageOf([]),
  [`GET ${S}?limit=50`]: pageOf([person()]),
  [`GET ${S}/${OWNER}/categories?limit=50`]: pageOf([cat('health'), cat('travel')]),
  [`GET ${S}/${OWNER}/category?id=health&limit=50`]: { status: 200, body: { category: { id: 'health', name: 'HEALTH' }, items: [itm('i1'), itm('i2')], nextCursor: null } },
  [`GET ${S}/${OWNER}/item?id=i1`]: { status: 200, body: { item: itm('i1'), categories: [{ id: 'health', name: 'HEALTH', weight: 0.9 }] } },
  ...extra,
});
async function start(table, hash = `#/circles/${C}`) {
  const page = fakePage();
  const svc = service(table);
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const press = async (el) => {
  el.fire('click');
  await settle();
};
const shown = async (table, hash) => {
  const s = await start(table, hash);
  await press(s.page.el('shared-load'));
  return s;
};
const rows = (page, id) => page.el(id).children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const inPerson = async (table) => {
  const s = await shown(table);
  await press(slot(rows(s.page, 'shared-people-list')[0], 'open'));
  return s;
};
const inCategory = async (table) => {
  const s = await inPerson(table);
  await press(slot(rows(s.page, 'shared-categories-list')[0], 'open'));
  return s;
};
const inItem = async (table) => {
  const s = await inCategory(table);
  await press(slot(rows(s.page, 'shared-items-list')[0], 'open'));
  return s;
};

describe('before the person asks', () => {
  it('shows the button and requests nothing about sharing', async () => {
    const { page, svc } = await start(base());
    expect(page.el('shared-section').hidden).toBe(false);
    expect(page.el('shared-load').hidden).toBe(false);
    expect(page.el('shared-people').hidden).toBe(true);
    expect(svc.calls.filter((k) => k.includes('/shared'))).toEqual([]);
  });
});

describe('who has shared with me', () => {
  it('lists them with how many categories, and moves the focus to the heading', async () => {
    const { page } = await shown(base());
    expect(page.el('shared-load').hidden).toBe(true);
    expect(page.el('shared-people').hidden).toBe(false);
    const list = rows(page, 'shared-people-list');
    expect(slot(list[0], 'name').textContent).toBe('User 2');
    expect(slot(list[0], 'meta').textContent).toBe('2 categories shared');
    expect(slot(list[0], 'open').getAttribute('aria-label')).toBe('Read what User 2 shares with you, 2 categories shared');
    expect(page.focused().id).toBe('shared-heading');
    expect(page.el('shared-empty').hidden).toBe(true);
  });

  it('says so when nobody has shared, and when loading fails', async () => {
    const a = await shown(base({ [`GET ${S}?limit=50`]: pageOf([]) }));
    expect(a.page.el('shared-empty').hidden).toBe(false);
    expect(a.page.el('shared-empty').textContent).toBe('Nobody has shared anything with you in this circle.');
    expect(a.page.el('shared-people-list').hidden).toBe(true);
    const b = await shown(base({ [`GET ${S}?limit=50`]: refuse(500, 'STORAGE_ERROR', 'x') }));
    expect(b.page.el('shared-error').textContent).toBe('Something went wrong on the service. Try again in a moment.');
    expect(b.page.focused().id).toBe('shared-error');
    const c = await shown(base({ [`GET ${S}?limit=50`]: refuse(404, 'NOT_FOUND', 'no such circle') }));
    expect(c.page.el('shared-error').textContent).toBe('No such circle, or you are not in it.');
  });

  it('shows more, and refreshes', async () => {
    const { page, svc } = await shown(base({ [`GET ${S}?limit=50`]: pageOf([person(2)], 'sNext'), [`GET ${S}?limit=50&cursor=sNext`]: pageOf([person(3)]) }));
    expect(page.el('shared-people-more').hidden).toBe(false);
    await press(page.el('shared-people-more'));
    expect(rows(page, 'shared-people-list').map((r) => slot(r, 'name').textContent)).toEqual(['User 2', 'User 3']);
    expect(page.el('shared-people-more').hidden).toBe(true);
    page.el('shared-error').focus();
    await press(page.el('shared-refresh'));
    expect(svc.calls.filter((k) => k === `GET ${S}?limit=50`)).toHaveLength(2);
    expect(page.focused().id).toBe('shared-heading');
  });

  it('names, categories and messages are only text', async () => {
    const hostile = '<img src=x onerror=1><b>x</b>';
    const { page } = await inItem(base({
      [`GET ${S}?limit=50`]: pageOf([person(2, { displayName: hostile })]),
      [`GET ${S}/${OWNER}/categories?limit=50`]: pageOf([cat('health', { name: hostile })]),
      [`GET ${S}/${OWNER}/category?id=health&limit=50`]: { status: 200, body: { category: { id: 'health', name: hostile }, items: [{ id: 'i1', data: { title: hostile, summary: hostile } }], nextCursor: null } },
      [`GET ${S}/${OWNER}/item?id=i1`]: { status: 200, body: { item: { id: 'i1', data: { title: hostile, note: hostile } }, categories: [{ id: 'health', name: hostile, weight: 1 }] } },
    }));
    expect(page.el('shared-item-heading').textContent).toBe(hostile);
    expect(page.el('shared-owner-heading').textContent).toContain(hostile);
    expect(rows(page, 'shared-item-data').map((r) => slot(r, 'value').textContent)).toEqual([hostile, hostile]);
    expect(page.el('shared-item-heading').children).toEqual([]);
  });
});

describe('one person\'s shared brain', () => {
  it('opens their categories with the read-only words and the focus on the heading, and Back returns', async () => {
    const { page } = await inPerson(base());
    expect(page.el('shared-people').hidden).toBe(true);
    expect(page.el('shared-categories').hidden).toBe(false);
    expect(page.el('shared-owner-heading').textContent).toBe('Shared by User 2');
    expect(page.el('shared-readonly').textContent).toBe('Read-only. You can see only the categories User 2 chose to share with you, and the items filed under them.');
    const list = rows(page, 'shared-categories-list');
    expect(list.map((r) => slot(r, 'name').textContent)).toEqual(['HEALTH', 'TRAVEL']);
    expect(slot(list[0], 'count').textContent).toBe('2 items');
    expect(page.focused().id).toBe('shared-owner-heading');
    await press(page.el('shared-categories-back'));
    expect(page.el('shared-people').hidden).toBe(false);
    expect(page.focused().id).toBe('shared-heading');
  });

  it('a person who has stopped sharing returns to the list, with the words and the focus on them', async () => {
    let n = 0;
    const { page } = await shown(base({
      [`GET ${S}?limit=50`]: () => (++n === 1 ? pageOf([person()]) : pageOf([])),
      [`GET ${S}/${OWNER}/categories?limit=50`]: refuse(404, 'NOT_FOUND', 'no such shared brain'),
    }));
    await press(slot(rows(page, 'shared-people-list')[0], 'open'));
    expect(page.el('shared-people').hidden).toBe(false);
    expect(page.el('shared-message').hidden).toBe(false);
    expect(page.el('shared-message').textContent).toBe('Nothing is shared with you by that person.');
    expect(page.focused().id).toBe('shared-message');
    expect(page.el('shared-empty').hidden).toBe(false);
  });

  it('says when none of the shared categories exist any more', async () => {
    const { page } = await inPerson(base({ [`GET ${S}/${OWNER}/categories?limit=50`]: pageOf([]) }));
    expect(page.el('shared-categories-empty').hidden).toBe(false);
    expect(page.el('shared-categories-empty').textContent).toBe('None of the categories shared with you still exist.');
  });

  it('shows more categories', async () => {
    const { page } = await inPerson(base({ [`GET ${S}/${OWNER}/categories?limit=50`]: pageOf([cat('a')], 'sMore'), [`GET ${S}/${OWNER}/categories?limit=50&cursor=sMore`]: pageOf([cat('b')]) }));
    expect(page.el('shared-categories-more').hidden).toBe(false);
    await press(page.el('shared-categories-more'));
    expect(rows(page, 'shared-categories-list')).toHaveLength(2);
    expect(page.el('shared-categories-more').hidden).toBe(true);
  });
});

describe('a category and an item', () => {
  it('opens the items with the focus on the heading, and Back returns to the categories', async () => {
    const { page } = await inCategory(base());
    expect(page.el('shared-category').hidden).toBe(false);
    expect(page.el('shared-category-heading').textContent).toBe('HEALTH');
    expect(rows(page, 'shared-items-list').map((r) => slot(r, 'title').textContent)).toEqual(['T i1', 'T i2']);
    expect(page.focused().id).toBe('shared-category-heading');
    await press(page.el('shared-category-back'));
    expect(page.el('shared-categories').hidden).toBe(false);
    expect(page.focused().id).toBe('shared-owner-heading');
  });

  it('shows more items, an empty category, and the shortened mark', async () => {
    const a = await inCategory(base({
      [`GET ${S}/${OWNER}/category?id=health&limit=50`]: { status: 200, body: { category: { id: 'health' }, items: [{ ...itm('i1'), dataTruncated: true }], nextCursor: 'sM' } },
      [`GET ${S}/${OWNER}/category?id=health&limit=50&cursor=sM`]: { status: 200, body: { category: { id: 'health' }, items: [itm('i2')], nextCursor: null } },
    }));
    expect(slot(rows(a.page, 'shared-items-list')[0], 'shortened').textContent).toBe('Some of this was shortened because it was long.');
    expect(a.page.el('shared-items-more').hidden).toBe(false);
    await press(a.page.el('shared-items-more'));
    expect(rows(a.page, 'shared-items-list')).toHaveLength(2);
    const b = await inCategory(base({ [`GET ${S}/${OWNER}/category?id=health&limit=50`]: { status: 200, body: { category: { id: 'health' }, items: [], nextCursor: null } } }));
    expect(b.page.el('shared-items-empty').hidden).toBe(false);
  });

  it('opens one item: its data as text, the categories shared with you, the focus on its heading; Back returns', async () => {
    const { page } = await inItem(base());
    expect(page.el('shared-item').hidden).toBe(false);
    expect(page.el('shared-item-heading').textContent).toBe('T i1');
    expect(rows(page, 'shared-item-data').map((r) => [slot(r, 'key').textContent, slot(r, 'value').textContent])).toEqual([['title', 'T i1'], ['summary', 'S i1']]);
    const filed = rows(page, 'shared-item-categories');
    expect(slot(filed[0], 'name').textContent).toBe('HEALTH');
    expect(slot(filed[0], 'weight').textContent).toBe('weight 0.9');
    expect(page.focused().id).toBe('shared-item-heading');
    await press(page.el('shared-item-back'));
    expect(page.el('shared-category').hidden).toBe(false);
    expect(page.focused().id).toBe('shared-category-heading');
  });

  it('a category from an item\'s list opens that category', async () => {
    const { page } = await inItem(base());
    await press(slot(rows(page, 'shared-item-categories')[0], 'open'));
    expect(page.el('shared-category').hidden).toBe(false);
  });

  it('a category or item that is no longer shared reads as not found, with a way back', async () => {
    const words = 'Not found: it may no longer be shared with you.';
    const a = await inCategory(base({ [`GET ${S}/${OWNER}/category?id=health&limit=50`]: refuse(404, 'NOT_FOUND', 'no such category') }));
    expect(a.page.el('shared-category-error').textContent).toBe(words);
    expect(a.page.el('shared-category-error').hidden).toBe(false);
    await press(a.page.el('shared-category-back'));
    expect(a.page.el('shared-categories').hidden).toBe(false);
    const b = await inItem(base({ [`GET ${S}/${OWNER}/item?id=i1`]: refuse(404, 'NOT_FOUND', 'no such item') }));
    expect(b.page.el('shared-item-error').textContent).toBe(words);
    expect(b.page.el('shared-item-data').children).toEqual([]);
    await press(b.page.el('shared-item-back'));
    expect(b.page.el('shared-category').hidden).toBe(false);
  });
});

describe('requests and leaving', () => {
  it('says it is loading, and every control is disabled while a request is out', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await start(base({ [`GET ${S}/${OWNER}/categories?limit=50`]: () => gate.then(() => pageOf([cat('health')])) }));
    await press(page.el('shared-load'));
    page.el('shared-people-list').children[0].querySelector('[data-slot="open"]').fire('click');
    await settle();
    expect(page.el('shared-status').hidden).toBe(false);
    expect(page.el('shared-status').textContent).toBe('Loading…');
    expect(page.el('shared-refresh').disabled).toBe(true);
    release();
    await settle();
    expect(page.el('shared-status').hidden).toBe(true);
    expect(page.el('shared-categories-back').disabled).toBe(false);
    expect(slot(rows(page, 'shared-categories-list')[0], 'open').disabled).toBe(false);
  });

  it('leaving the screen forgets everything and asks nothing until pressed again', async () => {
    const { page, svc, addr } = await inItem(base());
    addr.change('#/circles');
    await settle();
    expect(page.el('shared-people').hidden).toBe(true);
    expect(page.el('shared-item').hidden).toBe(true);
    expect(rows(page, 'shared-item-data')).toHaveLength(0);
    addr.change(`#/circles/${C}`);
    await settle();
    expect(page.el('shared-load').hidden).toBe(false);
    expect(svc.calls.filter((k) => k === `GET ${S}?limit=50`)).toHaveLength(1);
  });

  it('another circle starts clean', async () => {
    const C2 = 'c0000000000000002';
    const { page, addr } = await shown(base({ [`GET /api/circles/${C2}`]: { status: 200, body: { circle: { ...circle, id: C2 } } }, [`GET /api/circles/${C2}/members?limit=50`]: pageOf([]), [`GET /api/circles/${C2}/invitations?limit=50`]: pageOf([]) }));
    addr.change(`#/circles/${C2}`);
    await settle();
    expect(page.el('shared-load').hidden).toBe(false);
    expect(rows(page, 'shared-people-list')).toHaveLength(0);
  });

  it('an answer that arrives after leaving is not drawn', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page, addr } = await start(base({ [`GET ${S}?limit=50`]: () => gate.then(() => pageOf([person()])) }));
    await press(page.el('shared-load'));
    addr.change('#/circles');
    await settle();
    release();
    await settle();
    expect(rows(page, 'shared-people-list')).toHaveLength(0);
  });
});

describe('more edges', () => {
  const visible = (page) => ['shared-people', 'shared-categories', 'shared-category', 'shared-item'].filter((id) => !page.el(id).hidden);
  it('exactly one level is shown at a time', async () => {
    const a = await shown(base());
    expect(visible(a.page)).toEqual(['shared-people']);
    await press(slot(rows(a.page, 'shared-people-list')[0], 'open'));
    expect(visible(a.page)).toEqual(['shared-categories']);
    await press(slot(rows(a.page, 'shared-categories-list')[0], 'open'));
    expect(visible(a.page)).toEqual(['shared-category']);
    await press(slot(rows(a.page, 'shared-items-list')[0], 'open'));
    expect(visible(a.page)).toEqual(['shared-item']);
  });

  it('a failure loading the categories shows the service\'s words there', async () => {
    const { page } = await inPerson(base({ [`GET ${S}/${OWNER}/categories?limit=50`]: refuse(500, 'STORAGE_ERROR', 'x') }));
    expect(page.el('shared-categories-error').hidden).toBe(false);
    expect(page.el('shared-categories-error').textContent).toBe('Something went wrong on the service. Try again in a moment.');
  });

  it('the Back buttons are disabled while a request is out', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const a = await inPerson(base());
    expect(a.page.el('shared-categories-back').disabled).toBe(false);
    let release0;
    const gate0 = new Promise((r) => (release0 = r));
    const z = await shown(base({ [`GET ${S}/${OWNER}/categories?limit=50`]: () => gate0.then(() => pageOf([cat('health')])) }));
    slot(rows(z.page, 'shared-people-list')[0], 'open').fire('click');
    await settle();
    expect(z.page.el('shared-categories-back').disabled).toBe(true);
    release0();
    await settle();
    const b = await inPerson(base({ [`GET ${S}/${OWNER}/category?id=health&limit=50`]: () => gate.then(() => ({ status: 200, body: { category: { id: 'health' }, items: [], nextCursor: null } })) }));
    slot(rows(b.page, 'shared-categories-list')[0], 'open').fire('click');
    await settle();
    expect(b.page.el('shared-category-back').disabled).toBe(true);
    release();
    await settle();
    expect(b.page.el('shared-category-back').disabled).toBe(false);
    let release2;
    const gate2 = new Promise((r) => (release2 = r));
    const c = await inCategory(base({ [`GET ${S}/${OWNER}/item?id=i1`]: () => gate2.then(() => ({ status: 200, body: { item: itm('i1'), categories: [] } })) }));
    slot(rows(c.page, 'shared-items-list')[0], 'open').fire('click');
    await settle();
    expect(c.page.el('shared-item-back').disabled).toBe(true);
    release2();
    await settle();
  });

  it('the shortened mark shows on an item whose data was shortened', async () => {
    const { page } = await inItem(base({ [`GET ${S}/${OWNER}/item?id=i1`]: { status: 200, body: { item: { ...itm('i1'), dataTruncated: true }, categories: [] } } }));
    expect(page.el('shared-item-shortened').hidden).toBe(false);
    expect(page.el('shared-item-shortened').textContent).toBe('Some of this was shortened because it was long.');
  });

  it('a refused double press does not move the focus', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await inPerson(base({ [`GET ${S}/${OWNER}/category?id=health&limit=50`]: () => gate.then(() => ({ status: 200, body: { category: { id: 'health' }, items: [], nextCursor: null } })) }));
    const open = slot(rows(page, 'shared-categories-list')[0], 'open');
    open.fire('click');
    await settle();
    page.el('shared-error').focus();
    slot(rows(page, 'shared-categories-list')[0], 'open').fire('click');
    await settle();
    expect(page.focused().id).toBe('shared-error');
    release();
    await settle();
  });
});

