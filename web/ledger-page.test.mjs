import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { LEDGER_EMPTY, LEDGER_NOTICE } from './ledger-view.js';
import { mount } from './mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const C1 = 'c0123456789abcdef';
const IN1 = { kind: 'circle', circleId: C1, circleName: '<b>Parent</b>' };
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};
const AT = Date.UTC(2026, 9, 14, 9, 30);
const entry = (n, extra = {}) => ({ id: `l${n}`, at: AT - n * 60000, action: 'added', kind: 'item', subject: `n${n}`, title: `Note ${n}`, by: { username: 'ann', displayName: 'Ann A' }, ...extra });
const ledger = (items, nextCursor = null, scope) => ({ status: 200, body: { items, nextCursor, ...(scope ? { scope } : {}) } });
const PERSONAL = 'GET /api/ledger?scope=personal&limit=50';
const SCOPES = { 'GET /api/brain/scopes': { status: 200, body: { items: [{ scope: { kind: 'personal' }, canCapture: true }, { scope: IN1, role: 'member', canCapture: true }] } } };

function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push(key);
    const entryFor = table[key] ?? (/^GET \/api\/(invitations|circles)/.test(key) ? { status: 200, body: { items: [], nextCursor: null } } : refuse(401, 'UNAUTHENTICATED', 'not signed in'));
    const a = await (typeof entryFor === 'function' ? entryFor(calls.length) : entryFor);
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, change: (h) => env.setHash(h) };
}
const ME = { 'GET /api/me': { status: 200, body: { user: USER } }, 'GET /api/brain/scopes': SCOPES['GET /api/brain/scopes'] };
async function start(table = {}, hash = '#/ledger') {
  const page = fakePage();
  const svc = service({ ...ME, ...table });
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const rows = (page) => page.el('ledger-list').children.map((r) => r.querySelector('[data-slot="text"]').textContent);
const ledgerCalls = (svc) => svc.calls.filter((k) => k.includes('/api/ledger'));

describe('the change-log screen', () => {
  it('is reached at #/ledger with its title, the focus on its heading and its navigation link current', async () => {
    const { page } = await start({ [PERSONAL]: ledger([]) });
    expect(page.el('view-ledger').hidden).toBe(false);
    expect(page.document.title).toBe('Change log – CaCi');
    expect(page.focused().id).toBe('ledger-heading');
    expect(page.el('nav-ledger').getAttribute('aria-current')).toBe('page');
    expect(page.el('nav-home').getAttribute('aria-current')).toBeNull();
  });

  it('states that it is a review log kept for a limited time, not a record of every version', async () => {
    const { page } = await start({ [PERSONAL]: ledger([]) });
    expect(page.el('ledger-notice').textContent).toBe(LEDGER_NOTICE);
    expect(LEDGER_NOTICE).toContain('review log');
    expect(LEDGER_NOTICE).toContain('limited time');
    expect(LEDGER_NOTICE).toContain('not a full record');
  });

  it('requests nothing until the screen is opened; opening asks for the circles and the own log', async () => {
    const { page, svc, addr } = await start({ [PERSONAL]: ledger([entry(1)]) }, '#/');
    expect(ledgerCalls(svc)).toEqual([]);
    expect(svc.calls).not.toContain('GET /api/brain/scopes');
    addr.change('#/ledger');
    await settle();
    expect(ledgerCalls(svc)).toEqual([PERSONAL]);
    expect(page.el('ledger-list').hidden).toBe(false);
  });

  it('shows each entry on one line, the removed text included, newest first as the service gave them', async () => {
    const { page } = await start({
      [PERSONAL]: ledger([
        entry(1, { action: 'removed', title: 'Mum: 2 x Tablet A a day', summary: 'with food' }),
        entry(2, { action: 'added', title: 'Mum: 1 x Tablet A a day' }),
        entry(3, { action: 'removed', kind: 'category', subject: 'old-meds', title: 'Old meds', by: undefined }),
        entry(4, { title: undefined, subject: 'raw-id' }),
      ]),
    });
    expect(rows(page)).toEqual([
      '2026-10-14 09:29 UTC · Ann A · removed note · "Mum: 2 x Tablet A a day" — with food',
      '2026-10-14 09:28 UTC · Ann A · added note · "Mum: 1 x Tablet A a day"',
      '2026-10-14 09:27 UTC · someone who has since left · removed category · "Old meds"',
      '2026-10-14 09:26 UTC · Ann A · added note · "raw-id"',
    ]);
    expect(page.el('ledger-empty').hidden).toBe(true);
  });

  it('an empty log says so', async () => {
    const { page } = await start({ [PERSONAL]: ledger([]) });
    expect(page.el('ledger-empty').hidden).toBe(false);
    expect(page.el('ledger-empty').textContent).toBe(LEDGER_EMPTY);
    expect(page.el('ledger-list').hidden).toBe(true);
    expect(page.el('ledger-more').hidden).toBe(true);
  });

  it('names, titles and removed text are only text', async () => {
    const evil = '<img src=x onerror=alert(1)><script>x</script>';
    const { page } = await start({ [PERSONAL]: ledger([entry(1, { title: evil, summary: evil, by: { username: 'x', displayName: evil } })]) });
    const row = page.el('ledger-list').children[0];
    expect(row.children.length).toBe(1);
    expect(row.querySelector('[data-slot="text"]').children.length).toBe(0);
    expect(rows(page)[0]).toContain(evil);
  });

  it('"Show more" adds the next page and goes when there is none', async () => {
    const { page, svc } = await start({ [PERSONAL]: ledger([entry(1)], 'abc'), 'GET /api/ledger?scope=personal&limit=50&cursor=abc': ledger([entry(2)]) });
    expect(page.el('ledger-more').hidden).toBe(false);
    page.el('ledger-more').fire('click');
    await settle();
    expect(rows(page)).toHaveLength(2);
    expect(page.el('ledger-more').hidden).toBe(true);
    expect(ledgerCalls(svc)).toHaveLength(2);
  });

  it('offers the own notes and each circle, and choosing a circle shows its log with the circle named', async () => {
    const { page, svc } = await start({ [PERSONAL]: ledger([entry(1)]), [`GET /api/ledger?scope=circle:${C1}&limit=50`]: ledger([entry(7, { title: 'Bins' })], null, IN1) });
    expect(page.el('ledger-scope').children.map((o) => [o.value, o.textContent])).toEqual([['personal', 'My own notes'], [`circle:${C1}`, '<b>Parent</b>']]);
    expect(page.el('ledger-scope-hint').textContent).toBe('Showing the changes to your own notes.');
    page.el('ledger-scope').value = `circle:${C1}`;
    page.el('ledger-scope').fire('change');
    await settle();
    expect(ledgerCalls(svc)).toContain(`GET /api/ledger?scope=circle:${C1}&limit=50`);
    expect(rows(page)).toEqual(['2026-10-14 09:23 UTC · Ann A · added note · "Bins"']);
    expect(page.el('ledger-scope-hint').textContent).toBe('Showing the changes to the circle "<b>Parent</b>", made by its members.');
  });

  it('a circle that has gone says so with the one set of words and a way back to the own notes', async () => {
    const { page } = await start({ [PERSONAL]: ledger([entry(1)]), [`GET /api/ledger?scope=circle:${C1}&limit=50`]: refuse(404, 'NOT_FOUND', 'no such circle') });
    page.el('ledger-scope').value = `circle:${C1}`;
    page.el('ledger-scope').fire('change');
    await settle();
    expect(page.el('ledger-gone').hidden).toBe(false);
    expect(page.el('ledger-gone-hint').textContent).toBe('No such circle, or you are not in it. You can go back to your own notes.');
    expect(page.el('ledger-list').hidden).toBe(true);
    page.el('ledger-refresh').focus();
    expect(page.focused().id).toBe('ledger-refresh');
    page.el('ledger-gone-back').fire('click');
    await settle();
    expect(page.el('ledger-gone').hidden).toBe(true);
    expect(rows(page)).toHaveLength(1);
    expect(page.focused().id).toBe('ledger-heading');
  });

  it('a failed load shows the words as a problem and keeps the entries already shown', async () => {
    let n = 0;
    const { page } = await start({ [PERSONAL]: () => (++n === 1 ? ledger([entry(1)]) : refuse(500, 'STORAGE_ERROR', 'secret detail')) });
    page.el('ledger-refresh').fire('click');
    await settle();
    expect(page.el('ledger-error').hidden).toBe(false);
    expect(page.el('ledger-error').textContent).not.toContain('secret');
    expect(rows(page)).toHaveLength(1);
  });

  it('a first load that fails shows a problem and no entries', async () => {
    const { page } = await start({ [PERSONAL]: refuse(500, 'STORAGE_ERROR', 'secret detail') });
    expect(page.el('ledger-error').hidden).toBe(false);
    expect(page.el('ledger-list').hidden).toBe(true);
    expect(page.el('ledger-empty').hidden).toBe(true);
  });

  it('controls are disabled and a loading line shows while a request is out; Refresh loads again', async () => {
    let n = 0;
    const g = gate();
    const { page, svc } = await start({ [PERSONAL]: () => (++n === 1 ? ledger([entry(1)]) : n === 2 ? g.promise : ledger([entry(1), entry(2)])) });
    page.el('ledger-refresh').fire('click');
    await settle();
    expect(page.el('ledger-refresh').disabled).toBe(true);
    expect(page.el('ledger-scope').disabled).toBe(true);
    page.el('ledger-refresh').fire('click');
    await settle();
    expect(ledgerCalls(svc)).toHaveLength(2);
    g.release(ledger([entry(1), entry(2)]));
    await settle();
    expect(page.el('ledger-refresh').disabled).toBe(false);
    expect(page.el('ledger-scope').disabled).toBe(false);
    expect(rows(page)).toHaveLength(2);
    expect(page.el('ledger-status').hidden).toBe(true);
  });

  it('shows the loading line before the first entries arrive', async () => {
    const g = gate();
    const page = fakePage();
    const svc = service({ ...ME, [PERSONAL]: () => g.promise });
    mount(page.document, svc.fetchFn, address('#/ledger').env);
    await settle();
    expect(page.el('ledger-status').hidden).toBe(false);
    expect(page.el('ledger-status').textContent).toBe('Loading…');
    expect(page.el('ledger-empty').hidden).toBe(true);
    g.release(ledger([]));
    await settle();
    expect(page.el('ledger-status').hidden).toBe(true);
  });

  it('leaving the screen forgets the entries; coming back asks again', async () => {
    const { page, svc, addr } = await start({ [PERSONAL]: ledger([entry(1)]) });
    addr.change('#/');
    await settle();
    expect(page.el('ledger-list').children).toEqual([]);
    addr.change('#/ledger');
    await settle();
    expect(ledgerCalls(svc)).toHaveLength(2);
    expect(rows(page)).toHaveLength(1);
  });

  it('a chosen circle that is no longer on the list falls back to the own notes with a note', async () => {
    let listed = 0;
    const own = { scope: { kind: 'personal' }, canCapture: true };
    const { page, addr } = await start({
      'GET /api/brain/scopes': () => ({ status: 200, body: { items: ++listed === 1 ? [own, { scope: IN1, role: 'member', canCapture: true }] : [own] } }),
      [PERSONAL]: ledger([entry(1)]),
      [`GET /api/ledger?scope=circle:${C1}&limit=50`]: ledger([entry(7)], null, IN1),
    });
    page.el('ledger-scope').value = `circle:${C1}`;
    page.el('ledger-scope').fire('change');
    await settle();
    page.el('ledger-refresh').fire('click');
    await settle();
    expect(page.el('ledger-scope').value).toBe('personal');
    expect(page.el('ledger-gone').hidden).toBe(false);
    expect(page.el('ledger-gone-hint').textContent).toBe('No such circle, or you are not in it. Showing your own notes instead.');
    expect(page.el('ledger-gone-back').hidden).toBe(true); // already showing the own notes: no button to press
    page.el('ledger-scope').fire('change');
    await settle();
    expect(page.el('ledger-gone').hidden).toBe(true); // choosing again clears the note
    expect(addr.get()).toBe('#/ledger');
  });

  it('a session that has ended is told so', async () => {
    const { page } = await start({ [PERSONAL]: refuse(401, 'UNAUTHENTICATED', 'not signed in') });
    expect(page.el('ledger-error').textContent).toContain('session has ended');
  });

  it('the "Show more" button is hidden while the next page is on its way', async () => {
    const g = gate();
    const { page } = await start({ [PERSONAL]: ledger([entry(1)], 'abc'), 'GET /api/ledger?scope=personal&limit=50&cursor=abc': () => g.promise });
    page.el('ledger-more').fire('click');
    await settle();
    expect(page.el('ledger-more').hidden).toBe(true);
    expect(rows(page)).toHaveLength(1);
    g.release(ledger([entry(2)]));
    await settle();
    expect(rows(page)).toHaveLength(2);
  });

  it('leaving the screen while the circles are still loading asks for no log, and forgets the circle that was chosen', async () => {
    const g = gate();
    let n = 0;
    const { page, svc, addr } = await start({
      'GET /api/brain/scopes': () => (++n === 2 ? g.promise.then(() => SCOPES['GET /api/brain/scopes']) : SCOPES['GET /api/brain/scopes']),
      [PERSONAL]: ledger([entry(1)]),
      [`GET /api/ledger?scope=circle:${C1}&limit=50`]: ledger([entry(7)], null, IN1),
    });
    page.el('ledger-scope').value = `circle:${C1}`;
    page.el('ledger-scope').fire('change');
    await settle();
    addr.change('#/');
    await settle();
    addr.change('#/ledger');
    await settle();
    addr.change('#/');
    await settle();
    const before = ledgerCalls(svc).length;
    g.release();
    await settle();
    expect(ledgerCalls(svc)).toHaveLength(before);
    addr.change('#/ledger');
    await settle();
    expect(page.el('ledger-scope').value).toBe('personal');
    expect(ledgerCalls(svc).at(-1)).toBe(PERSONAL);
  });

  it('signing out forgets the entries', async () => {
    const { page } = await start({ [PERSONAL]: ledger([entry(1)]), 'POST /api/logout': { status: 204 } });
    page.el('nav-home').fire('click');
    page.el('signout').fire('click');
    await settle();
    expect(page.el('ledger-list').children).toEqual([]);
  });
});
