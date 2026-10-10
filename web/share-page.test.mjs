import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const C = 'c0000000000000001';
const U = (n) => `u${String(n).padStart(16, '0')}`;
const ME = U(1);
const USER = { id: ME, username: 'ann', displayName: 'Ann A' };
const circle = (role = 'owner') => ({ id: C, name: 'Team', role, memberCount: 3, createdAt: 1, updatedAt: 1 });
const member = (n, role = 'member', extra = {}) => ({ userId: U(n), username: `user${n}`, displayName: `User ${n}`, role, joinedAt: Date.UTC(2026, 0, n), ...extra });
const pageOf = (items, nextCursor = null) => ({ status: 200, body: { items, nextCursor } });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const grant = (n, ids) => ({ userId: U(n), username: `user${n}`, displayName: `User ${n}`, categories: ids.map((id) => ({ id, name: id.toUpperCase() })), updatedAt: 5 });
const cat = (id, name = id.toUpperCase()) => ({ id, name, itemCount: 1 });

function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)\?/.test(key) ? pageOf([]) : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
    const a = await (typeof entry === 'function' ? entry(calls.length) : entry);
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key) };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, change: (h) => env.setHash(h) };
}
const MEMBERS = [member(1, 'owner'), member(2), member(3, 'observer')];
const base = (extra = {}) => ({
  'GET /api/me': { status: 200, body: { user: USER } },
  [`GET /api/circles/${C}`]: { status: 200, body: { circle: circle() } },
  [`GET /api/circles/${C}/members?limit=50`]: pageOf(MEMBERS),
  [`GET /api/circles/${C}/invitations?limit=50`]: pageOf([]),
  [`GET /api/circles/${C}/members?limit=100`]: pageOf(MEMBERS),
  [`GET /api/circles/${C}/grants?limit=100`]: pageOf([grant(2, ['health', 'travel'])]),
  'GET /api/graph/categories?limit=100': pageOf([cat('health'), cat('pets'), cat('travel')]),
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
const rows = (page) => page.el('share-list').children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);
const rowOf = (page, n) => rows(page).find((r) => r.getAttribute('data-user') === U(n));
const boxes = (row) => [...slot(row, 'choices').children].map((li) => slot(li, 'box'));
const shown = async (table, hash) => {
  const s = await start(table, hash);
  s.page.el('share-load').fire('click');
  await settle();
  return s;
};

describe('before the person asks', () => {
  it('shows the words and a button, and requests nothing', async () => {
    const { page, svc } = await start(base());
    expect(page.el('share-section').hidden).toBe(false);
    expect(page.el('share-load').hidden).toBe(false);
    expect(page.el('share-list').hidden).toBe(true);
    expect(svc.keys().filter((k) => /grants|categories|limit=100/.test(k))).toEqual([]);
  });
});

describe('showing what I share', () => {
  it('lists the other members, not me, with what is shared with each, and moves the focus to the heading', async () => {
    const { page, svc } = await shown(base());
    expect(page.el('share-load').hidden).toBe(true);
    expect(page.focused().id).toBe('share-heading');
    expect(rows(page).map((r) => slot(r, 'name').textContent)).toEqual(['User 2', 'User 3']);
    expect(rows(page).map((r) => slot(r, 'meta').textContent)).toEqual(['Sharing 2 categories: HEALTH, TRAVEL', 'Nothing shared']);
    expect(rows(page).map((r) => slot(r, 'stop').hidden)).toEqual([false, true]);
    expect(rows(page).every((r) => slot(r, 'picker').hidden && slot(r, 'stopAsk').hidden)).toBe(true);
    expect(slot(rows(page)[0], 'change').getAttribute('aria-label')).toBe('Choose what to share with User 2');
    expect(slot(rows(page)[0], 'stop').getAttribute('aria-label')).toBe('Stop sharing with User 2');
    expect(svc.keys().filter((k) => k.startsWith('POST') || k.startsWith('PUT') || k.startsWith('DELETE'))).toEqual([]);
  });

  it('says so when nobody else is in the circle, and shows a failure in the service\'s words', async () => {
    const a = await shown(base({ [`GET /api/circles/${C}/members?limit=100`]: pageOf([member(1, 'owner')]) }));
    expect(a.page.el('share-empty').hidden).toBe(false);
    expect(a.page.el('share-empty').textContent).toBe('There is nobody else in this circle yet.');
    const b = await shown(base({ [`GET /api/circles/${C}/grants?limit=100`]: refuse(500, 'STORAGE_ERROR', 'x') }));
    expect(b.page.el('share-error').hidden).toBe(false);
    expect(b.page.el('share-error').textContent).toBe('Something went wrong on the service. Try again in a moment.');
    expect(b.page.el('share-list').hidden).toBe(true);
  });

  it('a circle that has gone says so in the one set of words', async () => {
    const { page } = await shown(base({ [`GET /api/circles/${C}/members?limit=100`]: refuse(404, 'NOT_FOUND', 'no such circle') }));
    expect(page.el('share-error').textContent).toBe('No such circle, or you are not in it.');
  });

  it('names, categories and messages are only text', async () => {
    const hostile = '<img src=x onerror=1><b>x</b>';
    const { page } = await shown(base({
      [`GET /api/circles/${C}/members?limit=100`]: pageOf([member(1, 'owner'), member(2, 'member', { displayName: hostile })]),
      [`GET /api/circles/${C}/grants?limit=100`]: pageOf([{ userId: U(2), username: 'user2', displayName: hostile, categories: [{ id: 'a', name: hostile }], updatedAt: 5 }]),
    }));
    expect(slot(rows(page)[0], 'name').textContent).toBe(hostile);
    expect(slot(rows(page)[0], 'meta').textContent).toContain(hostile);
    expect(slot(rows(page)[0], 'name').children).toEqual([]);
  });
});

describe('choosing', () => {
  it('opens a picker with my categories, the shared ones ticked, and the focus on the first tick', async () => {
    const { page } = await shown(base());
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    const row = rowOf(page, 2);
    expect(slot(row, 'picker').hidden).toBe(false);
    expect(slot(row, 'change').hidden).toBe(true);
    expect(slot(row, 'stop').hidden).toBe(true);
    expect([...slot(row, 'choices').children].map((li) => slot(li, 'label').textContent)).toEqual(['HEALTH', 'PETS', 'TRAVEL']);
    expect(boxes(row).map((b) => b.checked)).toEqual([true, false, true]);
    expect(page.focused()).toBe(boxes(row)[0]);
    expect(slot(row, 'pickerHelp').textContent).toBe('Tick the categories User 2 may read. The items filed under them come with them.');
    expect(slot(rowOf(page, 3), 'picker').hidden).toBe(true);
  });

  it('ticking changes the choice, sends nothing and keeps the focus on the tick', async () => {
    const { page, svc } = await shown(base());
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    const before = svc.calls.length;
    boxes(rowOf(page, 2))[1].fire('change');
    expect(boxes(rowOf(page, 2)).map((b) => b.checked)).toEqual([true, true, true]);
    expect(page.focused()).toBe(boxes(rowOf(page, 2))[1]);
    boxes(rowOf(page, 2))[0].fire('change');
    expect(boxes(rowOf(page, 2)).map((b) => b.checked)).toEqual([false, true, true]);
    expect(page.focused()).toBe(boxes(rowOf(page, 2))[0]);
    expect(svc.calls).toHaveLength(before);
  });

  it('Save sends the whole ticked set, shows the new state and puts the focus on the notice', async () => {
    const { page, svc } = await shown(base({
      [`PUT /api/circles/${C}/grants/${U(2)}`]: { status: 200, body: { grant: grant(2, ['pets']) } },
    }));
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    for (const i of [0, 1, 2]) boxes(rowOf(page, 2))[i].fire('change');
    slot(rowOf(page, 2), 'save').fire('click');
    await settle();
    const put = svc.calls.find((c) => c.key.startsWith('PUT'));
    expect(put.body).toEqual({ categories: ['pets'] });
    expect(page.el('share-notice').textContent).toBe('Now sharing 1 category with User 2.');
    expect(page.el('share-notice').hidden).toBe(false);
    expect(page.focused().id).toBe('share-notice');
    expect(slot(rowOf(page, 2), 'picker').hidden).toBe(true);
  });

  it('Cancel closes the picker, sends nothing and returns the focus to the button that opened it', async () => {
    const { page, svc } = await shown(base());
    slot(rowOf(page, 3), 'change').fire('click');
    await settle();
    const before = svc.calls.length;
    slot(rowOf(page, 3), 'cancel').fire('click');
    expect(slot(rowOf(page, 3), 'picker').hidden).toBe(true);
    expect(page.focused()).toBe(slot(rowOf(page, 3), 'change'));
    expect(svc.calls).toHaveLength(before);
  });

  it('a refused save keeps the picker and the ticks and shows the service\'s words beside it, with the focus there', async () => {
    const { page } = await shown(base({ [`PUT /api/circles/${C}/grants/${U(2)}`]: refuse(429, 'LIMIT_REACHED', 'at most 200 categories') }));
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    boxes(rowOf(page, 2))[1].fire('change');
    slot(rowOf(page, 2), 'save').fire('click');
    await settle();
    const row = rowOf(page, 2);
    expect(slot(row, 'picker').hidden).toBe(false);
    expect(boxes(row).map((b) => b.checked)).toEqual([true, true, true]);
    expect(slot(row, 'pickerError').hidden).toBe(false);
    expect(slot(row, 'pickerError').textContent).toBe('at most 200 categories');
    expect(page.focused()).toBe(slot(row, 'pickerError'));
    expect(page.el('share-error').hidden).toBe(true);
    expect(slot(rowOf(page, 3), 'pickerError').hidden).toBe(true);
  });

  it('says when you have no categories, and while they load', async () => {
    const { page } = await shown(base({ 'GET /api/graph/categories?limit=100': pageOf([]) }));
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    expect(slot(rowOf(page, 2), 'pickerHelp').textContent).toBe('You have no categories yet: file a note first.');
    expect(page.focused()).toBe(slot(rowOf(page, 2), 'cancel'));
  });

  it('a person who left while the picker was open: the list reloads and the words say why', async () => {
    let first = true;
    const { page } = await shown(base({
      [`GET /api/circles/${C}/members?limit=100`]: () => (first ? ((first = false), pageOf(MEMBERS)) : pageOf([member(1, 'owner'), member(3, 'observer')])),
      [`PUT /api/circles/${C}/grants/${U(2)}`]: refuse(404, 'NOT_FOUND', 'no such member'),
    }));
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    slot(rowOf(page, 2), 'save').fire('click');
    await settle();
    expect(rows(page).map((r) => slot(r, 'name').textContent)).toEqual(['User 3']);
    expect(page.el('share-error').textContent).toBe('That person is no longer in this circle.');
  });

  it('every control is disabled while a request is out', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await shown(base({ [`PUT /api/circles/${C}/grants/${U(2)}`]: () => gate.then(() => ({ status: 200, body: { grant: grant(2, ['health']) } })) }));
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    slot(rowOf(page, 2), 'save').fire('click');
    await settle();
    const row = rowOf(page, 2);
    expect([slot(row, 'save').disabled, slot(row, 'cancel').disabled, ...boxes(row).map((b) => b.disabled), slot(rowOf(page, 3), 'change').disabled]).toEqual([true, true, true, true, true, true]);
    release();
    await settle();
    expect(slot(rowOf(page, 2), 'change').disabled).toBe(false);
  });
});

describe('stopping', () => {
  it('asks first, with the focus on Cancel; Cancel sends nothing and returns the focus', async () => {
    const { page, svc } = await shown(base());
    slot(rowOf(page, 2), 'stop').fire('click');
    const row = rowOf(page, 2);
    expect(slot(row, 'stopAsk').hidden).toBe(false);
    expect(slot(row, 'stopText').textContent).toBe('Stop sharing with User 2? They will no longer be able to read any of your categories.');
    expect(page.focused()).toBe(slot(row, 'stopNo'));
    expect(slot(row, 'stop').hidden).toBe(true);
    slot(row, 'stopNo').fire('click');
    expect(slot(rowOf(page, 2), 'stopAsk').hidden).toBe(true);
    expect(page.focused()).toBe(slot(rowOf(page, 2), 'stop'));
    expect(svc.keys().filter((k) => k.startsWith('DELETE'))).toEqual([]);
  });

  it('confirming withdraws, reloads and puts the focus on the notice', async () => {
    let n = 0;
    const { page, svc } = await shown(base({
      [`DELETE /api/circles/${C}/grants/${U(2)}`]: { status: 204 },
      [`GET /api/circles/${C}/grants?limit=100`]: () => (++n === 1 ? pageOf([grant(2, ['health'])]) : pageOf([])),
    }));
    slot(rowOf(page, 2), 'stop').fire('click');
    slot(rowOf(page, 2), 'stopYes').fire('click');
    await settle();
    expect(svc.keys().filter((k) => k.startsWith('DELETE'))).toEqual([`DELETE /api/circles/${C}/grants/${U(2)}`]);
    expect(page.el('share-notice').textContent).toBe('Stopped sharing with User 2.');
    expect(page.focused().id).toBe('share-notice');
    expect(slot(rowOf(page, 2), 'meta').textContent).toBe('Nothing shared');
  });

  it('a failed withdrawal shows the words at the top and keeps the sharing', async () => {
    const { page } = await shown(base({ [`DELETE /api/circles/${C}/grants/${U(2)}`]: refuse(500, 'STORAGE_ERROR', 'x') }));
    slot(rowOf(page, 2), 'stop').fire('click');
    slot(rowOf(page, 2), 'stopYes').fire('click');
    await settle();
    expect(page.el('share-error').textContent).toBe('Something went wrong on the service. Try again in a moment.');
    expect(page.focused().id).toBe('share-error');
    expect(slot(rowOf(page, 2), 'meta').textContent).toContain('Sharing 2 categories');
  });
});

describe('leaving the screen', () => {
  it('forgets everything, shows the button again on return, and asks nothing until pressed', async () => {
    const { page, svc, addr } = await shown(base());
    expect(rows(page)).toHaveLength(2);
    addr.change('#/circles');
    await settle();
    expect(rows(page)).toHaveLength(0);
    expect(page.el('share-list').hidden).toBe(true);
    addr.change(`#/circles/${C}`);
    await settle();
    expect(page.el('share-load').hidden).toBe(false);
    expect(rows(page)).toHaveLength(0);
    expect(svc.keys().filter((k) => k.includes('/grants?'))).toHaveLength(1);
  });

  it('an answer that arrives after leaving is not drawn', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page, addr } = await start(base({ [`GET /api/circles/${C}/grants?limit=100`]: () => gate.then(() => pageOf([grant(2, ['health'])])) }));
    page.el('share-load').fire('click');
    await settle();
    addr.change('#/circles');
    await settle();
    release();
    await settle();
    expect(rows(page)).toHaveLength(0);
    expect(page.el('share-status').hidden).toBe(true);
  });
});

describe('while things load', () => {
  it('says it is loading, then the list', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await start(base({ [`GET /api/circles/${C}/members?limit=100`]: () => gate.then(() => pageOf(MEMBERS)) }));
    page.el('share-load').fire('click');
    await settle();
    expect(page.el('share-status').hidden).toBe(false);
    expect(page.el('share-status').textContent).toBe('Loading…');
    expect(page.el('share-load').hidden).toBe(true);
    release();
    await settle();
    expect(page.el('share-status').hidden).toBe(true);
  });

  it('says your categories are loading in the picker, and when the list was cut', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await shown(base({ 'GET /api/graph/categories?limit=100': () => gate.then(() => pageOf([cat('a')])) }));
    slot(rowOf(page, 2), 'change').fire('click');
    await settle();
    expect(slot(rowOf(page, 2), 'pickerHelp').textContent).toBe('Loading your categories…');
    release();
    await settle();
    expect(slot(rowOf(page, 2), 'pickerHelp').textContent).toBe('Tick the categories User 2 may read. The items filed under them come with them.');
    let n = 0;
    const cut = await shown(base({ 'GET /api/graph/categories?limit=100': () => pageOf([cat(`k${n++}`)], 'more'), [`GET /api/graph/categories?limit=100&cursor=more`]: () => pageOf([cat(`k${n++}`)], 'more') }));
    slot(rowOf(cut.page, 2), 'change').fire('click');
    await settle();
    expect(slot(rowOf(cut.page, 2), 'pickerHelp').textContent).toContain('Only the first 1,000 of your categories are listed.');
  });

  it('the stop buttons are disabled while a withdrawal is out', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { page } = await shown(base({ [`DELETE /api/circles/${C}/grants/${U(2)}`]: () => gate.then(() => ({ status: 204 })) }));
    slot(rowOf(page, 2), 'stop').fire('click');
    slot(rowOf(page, 2), 'stopYes').fire('click');
    await settle();
    expect(slot(rowOf(page, 2), 'stopYes').disabled).toBe(true);
    release();
    await settle();
  });

  it('opening another circle starts clean', async () => {
    const C2 = 'c0000000000000002';
    const { page, addr } = await shown(base({ [`GET /api/circles/${C2}`]: { status: 200, body: { circle: { ...circle(), id: C2 } } }, [`GET /api/circles/${C2}/members?limit=50`]: pageOf(MEMBERS), [`GET /api/circles/${C2}/invitations?limit=50`]: pageOf([]) }));
    expect(rows(page)).toHaveLength(2);
    addr.change(`#/circles/${C2}`);
    await settle();
    expect(rows(page)).toHaveLength(0);
    expect(page.el('share-load').hidden).toBe(false);
  });
});

