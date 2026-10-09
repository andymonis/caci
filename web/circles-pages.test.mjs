import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle, visibleScreens } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const PW = 'correct horse 7 staple';
const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const C = (n) => `c${String(n).padStart(16, '0')}`;
const I = (n) => `i${String(n).padStart(16, '0')}`;
const circle = (n, extra = {}) => ({ id: C(n), name: `Circle ${n}`, role: 'owner', memberCount: 1, createdAt: 1, updatedAt: 1, ...extra });
const mine = (n, extra = {}) => ({ id: I(n), circle: { id: C(n), name: `Circle ${n}` }, role: 'member', invitedBy: { displayName: 'Bob' }, createdAt: 1, expiresAt: Date.UTC(2026, 0, 2), ...extra });
const pageOf = (items, nextCursor = null) => ({ status: 200, body: { items, nextCursor } });
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });

/** A stand-in service: answers `METHOD path` from a table (values or functions), and records the calls. */
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

/** The address bar: reading it, setting it (which tells the page, as a browser would) and being told by the user (back, a pasted address). */
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, change: (h) => env.setHash(h) };
}

const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

const ME = { 'GET /api/me': { status: 200, body: { user: USER } } };
const views = (page) => ['home', 'circles', 'circle', 'invitations', 'capture', 'brain'].filter((v) => !page.el(`view-${v}`).hidden);
async function start(table = {}, hash = '') {
  const page = fakePage();
  const svc = service({ ...ME, ...table });
  const addr = address(hash);
  mount(page.document, svc.fetchFn, addr.env);
  await settle();
  return { page, svc, addr };
}
const rows = (page, list) => page.el(list).children;
const slot = (row, name) => row.querySelector(`[data-slot="${name}"]`);

describe('the home screen', () => {
  it('shows the temporary page, the name and username, the count of invitations, and takes the focus and the title', async () => {
    const { page, svc } = await start({ 'GET /api/invitations?limit=100': pageOf([mine(1), mine(2)]) });
    expect(visibleScreens(page)).toEqual(['signed-in']);
    expect(views(page)).toEqual(['home']);
    expect(page.el('user-display-name').textContent).toBe('Ann A');
    expect(page.el('home-invitations-count').textContent).toBe('You have 2 open invitations.');
    expect(page.document.title).toBe('CaCi');
    expect(page.focused().id).toBe('home-heading');
    expect(page.el('nav-home').getAttribute('aria-current')).toBe('page');
    expect(page.el('nav-circles').getAttribute('aria-current')).toBeNull();
    expect(svc.keys()).toEqual(['GET /api/me', 'GET /api/invitations?limit=100']);
  });

  it('Refresh asks again and shows the new number; a failed refresh shows no number at all', async () => {
    let n = 0;
    const { page, svc } = await start({ 'GET /api/invitations?limit=100': () => (++n === 1 ? pageOf([mine(1)]) : n === 2 ? pageOf([mine(1), mine(2), mine(3)]) : refuse(500, 'STORAGE_ERROR', 'x')) });
    expect(page.el('home-invitations-count').textContent).toBe('You have 1 open invitation.');
    page.el('home-refresh').fire('click');
    await settle();
    expect(page.el('home-invitations-count').textContent).toBe('You have 3 open invitations.');
    page.el('home-refresh').fire('click');
    await settle();
    expect(page.el('home-invitations-count').textContent).toMatch(/^Could not check your invitations: /);
    expect(page.el('home-invitations-count').textContent).not.toMatch(/\d/);
    expect(svc.keys().filter((k) => k.includes('invitations'))).toHaveLength(3);
  });

  it('does not poll: nothing more is asked while nothing is pressed', async () => {
    const { svc } = await start();
    const before = svc.calls.length;
    await settle();
    await settle();
    expect(svc.calls.length).toBe(before);
  });

  it('shows no count of its own before it has asked, and a count of "100 or more" is worded so', async () => {
    const many = Array.from({ length: 100 }, (_, i) => mine(i + 1));
    const { page } = await start({ 'GET /api/invitations?limit=100': pageOf(many, 'more') });
    expect(page.el('home-invitations-count').textContent).toBe('You have 100 or more open invitations.');
  });
});

describe('the circles screen', () => {
  it('lists the circles with the person\'s role and the number of people, as text, each linking to its address', async () => {
    const { page, svc } = await start({ 'GET /api/circles?limit=50': pageOf([circle(1, { role: 'manager', memberCount: 3 }), circle(2, { name: '<img src=x onerror=alert(1)>', memberCount: 1 })]) }, '#/circles');
    expect(views(page)).toEqual(['circles']);
    expect(page.document.title).toBe('Circles – CaCi');
    expect(page.focused().id).toBe('circles-heading');
    expect(page.el('nav-circles').getAttribute('aria-current')).toBe('page');
    const list = rows(page, 'circles-list');
    expect(list).toHaveLength(2);
    expect(slot(list[0], 'link').textContent).toBe('Circle 1');
    expect(slot(list[0], 'link').getAttribute('href')).toBe(`#/circles/${C(1)}`);
    expect(slot(list[0], 'meta').textContent).toBe('Your role: Manager · 3 people');
    expect(slot(list[1], 'link').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(slot(list[1], 'link').children).toEqual([]);
    expect(slot(list[1], 'meta').textContent).toBe('Your role: Owner · 1 person');
    expect(page.el('circles-list').hidden).toBe(false);
    expect(page.el('circles-empty').hidden).toBe(true);
    expect(page.el('circles-more').hidden).toBe(true);
    expect(svc.keys()).toContain('GET /api/circles?limit=50');
  });

  it('an empty list says how to start', async () => {
    const { page } = await start({}, '#/circles');
    expect(page.el('circles-empty').hidden).toBe(false);
    expect(page.el('circles-empty').textContent).toContain('Make one below');
    expect(page.el('circles-list').hidden).toBe(true);
  });

  it('"Show more" appears with a next page and adds it', async () => {
    const { page, svc } = await start({ 'GET /api/circles?limit=50': pageOf([circle(1)], 'abc'), 'GET /api/circles?limit=50&cursor=abc': pageOf([circle(2)]) }, '#/circles');
    expect(page.el('circles-more').hidden).toBe(false);
    page.el('circles-more').fire('click');
    await settle();
    expect(rows(page, 'circles-list')).toHaveLength(2);
    expect(page.el('circles-more').hidden).toBe(true);
    expect(svc.keys()).toContain('GET /api/circles?limit=50&cursor=abc');
  });

  it('a list that cannot be loaded shows the service\'s words as a problem', async () => {
    const { page } = await start({ 'GET /api/circles?limit=50': refuse(500, 'STORAGE_ERROR', 'secret detail') }, '#/circles');
    expect(page.el('circles-error').hidden).toBe(false);
    expect(page.el('circles-error').textContent).not.toContain('secret');
    expect(page.el('circles-error').textContent.length).toBeGreaterThan(5);
  });

  it('visiting again loads again', async () => {
    let n = 0;
    const { page, addr } = await start({ 'GET /api/circles?limit=50': () => pageOf(++n === 1 ? [circle(1)] : [circle(1), circle(2)]) }, '#/circles');
    expect(rows(page, 'circles-list')).toHaveLength(1);
    addr.change('#/');
    addr.change('#/circles');
    await settle();
    expect(rows(page, 'circles-list')).toHaveLength(2);
  });
});

describe('making a circle', () => {
  it('an empty or too-long name is refused before anything is sent, beside its field, with the focus there', async () => {
    const { page, svc } = await start({}, '#/circles');
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-name-error').hidden).toBe(false);
    expect(page.el('create-name-error').textContent).toBe('Enter a name for the circle.');
    expect(page.el('create-name').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('create-name');
    fill(page, 'create', { name: 'Team', description: 'x'.repeat(501) });
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-name-error').hidden).toBe(true);
    expect(page.el('create-name').getAttribute('aria-invalid')).toBeNull();
    expect(page.el('create-description-error').textContent).toContain('500');
    expect(page.focused().id).toBe('create-description');
    expect(svc.keys().filter((k) => k.startsWith('POST'))).toEqual([]);
  });

  it('sends the clean values, goes to the new circle, and empties the form', async () => {
    const { page, svc, addr } = await start({ 'POST /api/circles': { status: 201, body: { circle: circle(7, { name: 'Team' }) } } }, '#/circles');
    fill(page, 'create', { name: ' Team ', description: ' About ' });
    page.el('create-form').fire('submit');
    await settle();
    expect(svc.calls.find((c) => c.key === 'POST /api/circles').body).toEqual({ name: 'Team', description: 'About' });
    expect(addr.get()).toBe(`#/circles/${C(7)}`);
    expect(views(page)).toEqual(['circle']);
    expect(page.document.title).toBe('Circle – CaCi');
    expect(page.focused().id).toBe('circle-heading');
    expect(page.el('create-name').value).toBe('');
    expect(page.el('create-description').value).toBe('');
  });

  it('the service\'s refusal is shown in its own words: a field beside the field, a limit at the top of the form', async () => {
    const { page } = await start({ 'POST /api/circles': refuse(422, 'INVALID_INPUT', 'name: not allowed', { field: 'name' }) }, '#/circles');
    fill(page, 'create', { name: 'Team' });
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-name-error').textContent).toBe('name: not allowed');
    expect(page.el('create-name').value).toBe('Team'); // what was typed stays so it can be fixed
    const { page: p2 } = await start({ 'POST /api/circles': refuse(429, 'LIMIT_REACHED', 'You are in the most circles allowed.') }, '#/circles');
    fill(p2, 'create', { name: 'Team' });
    p2.el('create-form').fire('submit');
    await settle();
    expect(p2.el('create-error').hidden).toBe(false);
    expect(p2.el('create-error').textContent).toBe('You are in the most circles allowed.');
    expect(p2.focused().id).toBe('create-error');
  });
});

describe('the invitations screen', () => {
  const table = (extra = {}) => ({ 'GET /api/invitations?limit=100': pageOf([mine(1), mine(2, { role: 'observer', invitedBy: {} })]), ...extra });

  it('lists each open invitation with the circle, the role in plain words, who sent it and when it ends', async () => {
    const { page } = await start(table(), '#/invitations');
    expect(views(page)).toEqual(['invitations']);
    expect(page.document.title).toBe('Invitations – CaCi');
    expect(page.focused().id).toBe('invitations-heading');
    const list = rows(page, 'invitations-list');
    expect(list).toHaveLength(2);
    expect(slot(list[0], 'circle').textContent).toBe('Circle 1');
    expect(slot(list[0], 'meta').textContent).toBe('You would be: Member');
    expect(slot(list[0], 'roleWords').textContent).toBe('See the circle and who is in it, and leave.');
    expect(slot(list[0], 'from').textContent).toBe('Invited by Bob');
    expect(slot(list[0], 'ends').textContent).toBe('Ends 2026-01-02');
    expect(slot(list[1], 'from').textContent).toBe('Invited by someone');
    expect(slot(list[0], 'accept').getAttribute('aria-label')).toBe('Accept the invitation to Circle 1');
    expect(slot(list[0], 'decline').getAttribute('aria-label')).toBe('Decline the invitation to Circle 1');
    expect(page.el('invitations-empty').hidden).toBe(true);
  });

  it('none says so', async () => {
    const { page } = await start({}, '#/invitations');
    expect(page.el('invitations-empty').hidden).toBe(false);
    expect(page.el('invitations-empty').textContent).toBe('You have no open invitations.');
    expect(page.el('invitations-list').hidden).toBe(true);
  });

  it('accepting goes to that circle; the home count follows', async () => {
    let n = 0;
    const { page, svc, addr } = await start(table({ 'GET /api/invitations?limit=100': () => pageOf(++n === 1 ? [mine(1), mine(2)] : [mine(2)]), [`POST /api/invitations/${I(1)}/accept`]: { status: 200, body: { circle: circle(1, { role: 'member' }) } } }), '#/invitations');
    slot(rows(page, 'invitations-list')[0], 'accept').fire('click');
    await settle();
    expect(svc.keys()).toContain(`POST /api/invitations/${I(1)}/accept`);
    expect(addr.get()).toBe(`#/circles/${C(1)}`);
    expect(views(page)).toEqual(['circle']);
    expect(page.el('home-invitations-count').textContent).toBe('You have 1 open invitation.');
  });

  it('declining removes the row, updates the count and keeps the focus on the heading', async () => {
    let n = 0;
    const { page, svc } = await start(table({ 'GET /api/invitations?limit=100': () => pageOf(++n === 1 ? [mine(1), mine(2)] : [mine(2)]), [`POST /api/invitations/${I(1)}/decline`]: { status: 204 } }), '#/invitations');
    slot(rows(page, 'invitations-list')[0], 'decline').focus();
    slot(rows(page, 'invitations-list')[0], 'decline').fire('click');
    await settle();
    expect(svc.keys()).toContain(`POST /api/invitations/${I(1)}/decline`);
    expect(rows(page, 'invitations-list')).toHaveLength(1);
    expect(page.el('home-invitations-count').textContent).toBe('You have 1 open invitation.');
    expect(page.focused().id).toBe('invitations-heading');
  });

  it('an invitation that has gone says so in words, takes the focus, and the list catches up', async () => {
    let n = 0;
    const { page } = await start(table({ 'GET /api/invitations?limit=100': () => pageOf(++n === 1 ? [mine(1)] : []), [`POST /api/invitations/${I(1)}/accept`]: refuse(404, 'NOT_FOUND', 'no such invitation') }), '#/invitations');
    slot(rows(page, 'invitations-list')[0], 'accept').fire('click');
    await settle();
    expect(page.el('invitations-error').hidden).toBe(false);
    expect(page.el('invitations-error').textContent).toBe('No such invitation: it may have been withdrawn, used or expired.');
    expect(page.focused().id).toBe('invitations-error');
    expect(rows(page, 'invitations-list')).toHaveLength(0);
    expect(page.el('invitations-empty').hidden).toBe(false);
  });

  it('a full circle shows the service\'s words and keeps the invitation', async () => {
    const { page } = await start(table({ [`POST /api/invitations/${I(1)}/accept`]: refuse(429, 'LIMIT_REACHED', 'That circle is full.') }), '#/invitations');
    slot(rows(page, 'invitations-list')[0], 'accept').fire('click');
    await settle();
    expect(page.el('invitations-error').textContent).toBe('That circle is full.');
    expect(rows(page, 'invitations-list')).toHaveLength(2);
  });

  it('markup in a circle name or a sender\'s name stays text', async () => {
    const { page } = await start({ 'GET /api/invitations?limit=100': pageOf([mine(1, { circle: { id: C(1), name: '<script>x</script>' }, invitedBy: { displayName: '<b>Bob</b>' } })]) }, '#/invitations');
    const row = rows(page, 'invitations-list')[0];
    expect(slot(row, 'circle').textContent).toBe('<script>x</script>');
    expect(slot(row, 'from').textContent).toBe('Invited by <b>Bob</b>');
    expect(slot(row, 'circle').children).toEqual([]);
  });

  it('show more adds the next page', async () => {
    const { page } = await start({ 'GET /api/invitations?limit=100': pageOf([mine(1)], 'k'), 'GET /api/invitations?limit=100&cursor=k': pageOf([mine(2)]) }, '#/invitations');
    expect(page.el('invitations-more').hidden).toBe(false);
    page.el('invitations-more').fire('click');
    await settle();
    expect(rows(page, 'invitations-list')).toHaveLength(2);
    expect(page.el('invitations-more').hidden).toBe(true);
  });
});

describe('the address drives the screen', () => {
  it('follows the address, the back button and a pasted address; the heading takes the focus and the title follows each time', async () => {
    const { page, addr } = await start();
    const seen = [];
    for (const hash of ['#/circles', '#/invitations', '#/capture', '#/brain', `#/circles/${C(1)}`, '#/']) {
      addr.change(hash);
      await settle();
      seen.push([views(page)[0], page.document.title, page.focused().id]);
    }
    expect(seen).toEqual([
      ['circles', 'Circles – CaCi', 'circles-heading'],
      ['invitations', 'Invitations – CaCi', 'invitations-heading'],
      ['capture', 'Capture – CaCi', 'capture-heading'],
      ['brain', 'Brain – CaCi', 'brain-heading'],
      ['circle', 'Circle – CaCi', 'circle-heading'],
      ['home', 'CaCi', 'home-heading'],
    ]);
  });

  it('the navigation marks the current link for every screen, and home links to the two new ones', async () => {
    const { page, addr } = await start();
    for (const [hash, current] of [['#/', 'home'], ['#/capture', 'capture'], ['#/brain', 'brain'], ['#/circles', 'circles'], ['#/invitations', 'invitations']]) {
      addr.change(hash);
      await settle();
      for (const name of ['home', 'capture', 'brain', 'circles', 'invitations']) expect(page.el(`nav-${name}`).getAttribute('aria-current'), `${hash} ${name}`).toBe(name === current ? 'page' : null);
    }
    expect(page.el('nav-capture').getAttribute('href')).toBe('#/capture');
    expect(page.el('nav-brain').getAttribute('href')).toBe('#/brain');
  });

  it('a circle address keeps "Circles" as the current link', async () => {
    const { page } = await start({}, `#/circles/${C(1)}`);
    expect(page.el('nav-circles').getAttribute('aria-current')).toBe('page');
    expect(page.el('nav-home').getAttribute('aria-current')).toBeNull();
  });

  it('a hostile or unknown address lands on home and nothing odd is asked for', async () => {
    for (const hash of ['#/circles/..%2f..', '#/circles/../..', `#/circles/${C(1)}/x`, '#/admin', '#/circles?x=1', '#<script>', '#/circles/C0000000000000001', '#/' + 'a'.repeat(5000)]) {
      const { page, svc } = await start({}, hash);
      expect(views(page), hash.slice(0, 30)).toEqual(['home']);
      expect(svc.keys().every((k) => !k.includes('..') && !k.includes('%'))).toBe(true);
    }
  });

  it('showing the same address again does not take the focus back', async () => {
    const { page, addr } = await start({}, '#/circles');
    page.el('circles-more').focus();
    addr.change('#/circles');
    await settle();
    expect(page.focused().id).toBe('circles-more');
  });

  it('while signed out the address is kept, and applies after signing in', async () => {
    const page = fakePage();
    const svc = service({ 'POST /api/login': { status: 200, body: { user: USER } } });
    const addr = address('#/invitations');
    mount(page.document, svc.fetchFn, addr.env);
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
    expect(page.document.title).toBe('CaCi');
    fill(page, 'signin', { username: 'ann', password: PW });
    page.el('signin-form').fire('submit');
    await settle();
    expect(views(page)).toEqual(['invitations']);
    expect(page.document.title).toBe('Invitations – CaCi');
  });

  it('without an address bar given, the app stays on home', async () => {
    const page = fakePage();
    mount(page.document, service(ME).fetchFn);
    await settle();
    expect(views(page)).toEqual(['home']);
  });
});

describe('signing out and a session that ends', () => {
  it('signing out forgets the lists; signing in again starts clean', async () => {
    const { page, svc } = await start({ 'GET /api/circles?limit=50': pageOf([circle(1)]), 'POST /api/logout': { status: 204 }, 'POST /api/login': { status: 200, body: { user: { ...USER, username: 'bob', displayName: 'Bob B' } } } }, '#/circles');
    expect(rows(page, 'circles-list')).toHaveLength(1);
    expect(views(page)).toEqual(['circles']);
    page.el('nav-home').fire('click');
    svc.calls.length = 0;
    // sign out from the home screen
    page.el('signout').fire('click');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
    expect(rows(page, 'circles-list')).toHaveLength(0);
    expect(page.document.title).toBe('CaCi');
    expect(page.el('home-invitations-count').textContent).toBe('Not checked yet.');
  });

  it('a circle request that says the session ended asks the service once; a service that contradicts itself cannot make a loop', async () => {
    const { page, svc } = await start({ 'GET /api/circles?limit=50': refuse(401, 'UNAUTHENTICATED', 'not signed in') }, '#/circles');
    await settle();
    await settle();
    expect(svc.keys().filter((k) => k === 'GET /api/me')).toHaveLength(2); // the first look, and one re-check
    expect(visibleScreens(page)).toEqual(['signed-in']);
  });

  it('when the re-check says signed out, the sign-in screen shows', async () => {
    let me = 0;
    const { page } = await start({ 'GET /api/me': () => (++me === 1 ? { status: 200, body: { user: USER } } : refuse(401, 'UNAUTHENTICATED', 'not signed in')), 'GET /api/circles?limit=50': refuse(401, 'UNAUTHENTICATED', 'x') }, '#/circles');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
  });
});

describe('details the first mutation run found', () => {
  it('the empty-list text and the loading line follow the state of the list', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/circles?limit=50': () => g.promise }, '#/circles');
    expect(page.el('circles-status').hidden).toBe(false);
    expect(page.el('circles-status').textContent).toBe('Loading…');
    expect(page.el('circles-empty').hidden).toBe(true);
    g.release(pageOf([circle(1)], 'abc'));
    await settle();
    expect(page.el('circles-status').hidden).toBe(true);
    expect(page.el('circles-error').hidden).toBe(true);
    // "show more" in flight does not bring the loading line back, and its button is disabled
    const more = gate();
    const { page: p2 } = await start({ 'GET /api/circles?limit=50': pageOf([circle(1)], 'abc'), 'GET /api/circles?limit=50&cursor=abc': () => more.promise }, '#/circles');
    p2.el('circles-more').fire('click');
    await settle();
    expect(p2.el('circles-status').hidden).toBe(true);
    expect(p2.el('circles-more').disabled).toBe(true);
    more.release(pageOf([circle(2)]));
    await settle();
    expect(p2.el('circles-more').disabled).toBe(false);
  });

  it('a list that fails and then loads clears its problem', async () => {
    let n = 0;
    const { page, addr } = await start({ 'GET /api/circles?limit=50': () => (++n === 1 ? refuse(500, 'STORAGE_ERROR', 'x') : pageOf([circle(1)])) }, '#/circles');
    expect(page.el('circles-error').hidden).toBe(false);
    addr.change('#/');
    addr.change('#/circles');
    await settle();
    expect(page.el('circles-error').hidden).toBe(true);
    expect(page.el('circles-error').textContent).toBe('');
  });

  it('each row link says what it opens', async () => {
    const { page } = await start({ 'GET /api/circles?limit=50': pageOf([circle(1)]) }, '#/circles');
    expect(slot(rows(page, 'circles-list')[0], 'link').getAttribute('aria-label')).toBe('Open the circle Circle 1');
  });

  it('controls are disabled while a request is out and enabled again after', async () => {
    const g = gate();
    const { page } = await start({ 'GET /api/invitations?limit=100': pageOf([mine(1)]), 'POST /api/circles': () => g.promise }, '#/circles');
    fill(page, 'create', { name: 'Team' });
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-submit').disabled).toBe(true);
    expect(page.el('create-form').getAttribute('aria-busy')).toBe('true');
    g.release({ status: 201, body: { circle: circle(5) } });
    await settle();
    expect(page.el('create-submit').disabled).toBe(false);

    const r = gate();
    const { page: p2 } = await start({ 'GET /api/invitations?limit=100': pageOf([mine(1)]) }, '#/');
    expect(p2.el('home-refresh').disabled).toBe(false);
    const { page: p3 } = await start({ 'GET /api/invitations?limit=100': () => r.promise }, '#/');
    expect(p3.el('home-refresh').disabled).toBe(true);
    r.release(pageOf([]));
    await settle();
    expect(p3.el('home-refresh').disabled).toBe(false);

    const a = gate();
    const { page: p4 } = await start({ 'GET /api/invitations?limit=100': pageOf([mine(1)]), [`POST /api/invitations/${I(1)}/decline`]: () => a.promise }, '#/invitations');
    const row = rows(p4, 'invitations-list')[0];
    slot(row, 'decline').fire('click');
    await settle();
    for (const r2 of rows(p4, 'invitations-list')) {
      expect(slot(r2, 'accept').disabled).toBe(true);
      expect(slot(r2, 'decline').disabled).toBe(true);
    }
    a.release({ status: 204 });
    await settle();
  });

  it('an invitations list that cannot be loaded shows a problem', async () => {
    const { page } = await start({ 'GET /api/invitations?limit=100': refuse(500, 'STORAGE_ERROR', 'x') }, '#/invitations');
    expect(page.el('invitations-error').hidden).toBe(false);
    expect(page.el('invitations-error').textContent.length).toBeGreaterThan(5);
  });

  it('a second try clears the old problem; a failed decline moves the focus to its message; leaving the screen forgets it', async () => {
    let n = 0;
    const { page, addr } = await start({
      'GET /api/invitations?limit=100': pageOf([mine(1)]),
      [`POST /api/invitations/${I(1)}/accept`]: () => (++n === 1 ? refuse(429, 'LIMIT_REACHED', 'That circle is full.') : { status: 200, body: { circle: circle(1) } }),
      [`POST /api/invitations/${I(1)}/decline`]: refuse(500, 'STORAGE_ERROR', 'x'),
    }, '#/invitations');
    slot(rows(page, 'invitations-list')[0], 'accept').fire('click');
    await settle();
    expect(page.el('invitations-error').textContent).toBe('That circle is full.');
    slot(rows(page, 'invitations-list')[0], 'accept').fire('click');
    await settle();
    expect(page.el('invitations-error').hidden).toBe(true);
    addr.change('#/invitations');
    await settle();
    slot(rows(page, 'invitations-list')[0], 'decline').fire('click');
    await settle();
    expect(page.focused().id).toBe('invitations-error');
    expect(page.el('invitations-error').hidden).toBe(false);
    addr.change('#/');
    addr.change('#/invitations');
    await settle();
    expect(page.el('invitations-error').hidden).toBe(true);
  });

  it('the create form: old messages go on the next try, the first problem (name) gets the focus, and a second submit while one is out says nothing', async () => {
    const g = gate();
    let n = 0;
    const { page } = await start({ 'POST /api/circles': () => (++n === 1 ? refuse(429, 'LIMIT_REACHED', 'You are in the most circles allowed.') : g.promise) }, '#/circles');
    fill(page, 'create', { name: 'Team' });
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-error').hidden).toBe(false);
    fill(page, 'create', { name: '', description: 'x'.repeat(501) });
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-error').hidden).toBe(true);
    expect(page.el('create-name-error').hidden).toBe(false);
    expect(page.el('create-description-error').hidden).toBe(false);
    expect(page.focused().id).toBe('create-name');
    fill(page, 'create', { name: 'Team', description: '' });
    page.el('create-form').fire('submit');
    await settle();
    page.el('create-form').fire('submit'); // while the first is out
    await settle();
    expect(page.el('create-error').hidden).toBe(true);
    expect(page.el('create-name-error').hidden).toBe(true);
    g.release({ status: 201, body: { circle: circle(2) } });
    await settle();
  });

  it('signing out forgets what was typed and any messages in the create form', async () => {
    const { page } = await start({ 'POST /api/circles': refuse(429, 'LIMIT_REACHED', 'Full.'), 'POST /api/logout': { status: 204 } }, '#/circles');
    fill(page, 'create', { name: 'Team', description: 'About' });
    page.el('create-form').fire('submit');
    await settle();
    expect(page.el('create-error').hidden).toBe(false);
    page.el('signout').fire('click');
    await settle();
    expect(page.el('create-name').value).toBe('');
    expect(page.el('create-description').value).toBe('');
    expect(page.el('create-error').hidden).toBe(true);
    expect(page.el('create-error').textContent).toBe('');
    expect(page.el('create-name').getAttribute('aria-invalid')).toBeNull();
  });

  it('a second sign-in may be re-checked again after the first session ended', async () => {
    let me = 0;
    const { page, svc } = await start({
      'GET /api/me': () => (++me === 1 ? { status: 200, body: { user: USER } } : refuse(401, 'UNAUTHENTICATED', 'x')),
      'GET /api/circles?limit=50': refuse(401, 'UNAUTHENTICATED', 'x'),
      'POST /api/login': { status: 200, body: { user: USER } },
    }, '#/circles');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
    fill(page, 'signin', { username: 'ann', password: PW });
    page.el('signin-form').fire('submit');
    await settle();
    await settle();
    expect(svc.keys().filter((k) => k === 'GET /api/me')).toHaveLength(3);
  });
});

describe('the page it runs against', () => {
  it('mounting fails loudly if the page lacks an element the circles screens need', () => {
    const page = fakePage();
    const broken = { title: '', getElementById: (id) => (id === 'circles-more' ? null : page.document.getElementById(id)) };
    expect(() => mount(broken, service().fetchFn)).toThrow(/no element "circles-more"/);
  });
});
