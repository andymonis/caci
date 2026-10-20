import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { circleIdOf, mountUser, routeOf } from './user-mount.js';
import { userHooks } from './user-hooks.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const GONE = 'c0000000000000999';
const circle = (id, name, role = 'member', canCapture = role !== 'observer') => ({ role, scope: { kind: 'circle', circleId: id, circleName: name }, canCapture });
const OWN = { scope: { kind: 'personal' }, canCapture: true };
const gate = () => { let release; const promise = new Promise((r) => (release = r)); return { promise, release }; };

function service(initial) {
  const state = { scopes: initial, scopeCalls: 0, hold: undefined, fail: false };
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push(key);
    let reply = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } };
    if (key === 'GET /api/me') reply = { status: 200, body: { user: USER, graphId: 'x' } };
    else if (key === 'GET /api/capture/mode') reply = { status: 200, body: { mode: 'demo' } };
    else if (key === 'POST /api/logout') reply = { status: 204 };
    else if (key === 'GET /api/brain/scopes') {
      state.scopeCalls += 1;
      const mine = state.hold;
      if (mine) await mine.promise;
      reply = state.fail ? { status: 500, body: { error: { code: 'STORAGE_ERROR', message: 'x' } } } : { status: 200, body: { items: state.scopes } };
    }
    return { status: reply.status, headers: { get: () => null }, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)) };
  };
  return { state, calls, fetchFn };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, go: (h) => env.setHash(h) };
}
async function start(scopes = [OWN, circle(C1, 'Parent care'), circle(C2, 'Club', 'observer')], hash = '') {
  const page = fakePage('user.html');
  const svc = service(scopes);
  const addr = address(hash);
  mountUser(page.document, svc.fetchFn, addr.env, (ctx) => userHooks(page.document, svc.fetchFn, ctx));
  await settle();
  return { page, svc, addr };
}
const links = (page) => page.el('nav-circles').children.map((row) => { const a = row.querySelector('[data-slot="link"]'); return { text: a.textContent, href: a.getAttribute('href'), current: a.getAttribute('aria-current') }; });
const shownViews = (page) => ['home', 'circle', 'settings'].filter((v) => !page.el(`view-${v}`).hidden);

describe('the routes', () => {
  it('a circle address needs the exact id shape; anything else is Home, and Settings stays exact', () => {
    expect(routeOf(`#/circle/${C1}`)).toBe('circle');
    expect(circleIdOf(`#/circle/${C1}`)).toBe(C1);
    for (const h of ['#/circle/', '#/circle', `#/circle/${C1}/`, `#/circle/${C1}?x=1`, `#/circle/${C1}#x`, '#/circle/C0000000000000001', '#/circle/c000', '#/circle/..%2f..', '#/circle/../x', `#/Circle/${C1}`, `#/circles/${C1}`, `#/circle/%63${C1.slice(1)}`, undefined, 5, null]) {
      expect(routeOf(h), String(h)).toBe('home');
      expect(circleIdOf(h), String(h)).toBeUndefined();
    }
    expect(routeOf('#/settings')).toBe('settings');
    expect(routeOf('#/settings/x')).toBe('home');
  });
});

describe('the circle links', () => {
  it('lists each circle the person is in, by name, before Chat and Settings, in the order the service gave, observers included', async () => {
    const { page } = await start();
    expect(links(page)).toEqual([{ text: 'Parent care', href: `#/circle/${C1}`, current: null }, { text: 'Club', href: `#/circle/${C2}`, current: null }]);
    expect(page.el('nav-circles').hidden).toBe(false);
  });
  it('shows no links when the person is in no circle', async () => {
    const { page } = await start([OWN]);
    expect(links(page)).toEqual([]);
    expect(page.el('nav-circles').hidden).toBe(true);
  });
  it('a circle name is only text', async () => {
    const evil = '<img src=x onerror=alert(1)><b>x</b>';
    const { page, addr } = await start([OWN, circle(C1, evil)]);
    expect(links(page)[0].text).toBe(evil);
    expect(page.el('nav-circles').children[0].children.map((c) => c.tagName)).toEqual(['a']);
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(page.el('circle-heading').textContent).toBe(evil);
    expect(page.document.title).toBe(`${evil} – CaCi`);
  });
  it('is read again whenever a screen is shown: a circle joined appears, a circle left disappears', async () => {
    const { page, svc, addr } = await start([OWN]);
    expect(svc.state.scopeCalls).toBe(1);
    svc.state.scopes = [OWN, circle(C1, 'Parent care')];
    addr.go('#/settings');
    await settle();
    expect(svc.state.scopeCalls).toBe(2);
    expect(links(page).map((l) => l.text)).toEqual(['Parent care']);
    svc.state.scopes = [OWN];
    addr.go('#/');
    await settle();
    expect(links(page)).toEqual([]);
    expect(svc.state.scopeCalls).toBe(3);
  });
  it('a failed read keeps what was known, and nothing is polled', async () => {
    const { page, svc, addr } = await start();
    svc.state.fail = true;
    addr.go('#/settings');
    await settle();
    expect(links(page).map((l) => l.text)).toEqual(['Parent care', 'Club']);
    const before = svc.state.scopeCalls;
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.state.scopeCalls).toBe(before);
  });
});

describe('a circle screen', () => {
  it('shows only that screen, with the circle name as its heading and title, the focus on the heading and its link marked', async () => {
    const { page } = await start(undefined, `#/circle/${C1}`);
    expect(shownViews(page)).toEqual(['circle']);
    expect(page.el('circle-heading').textContent).toBe('Parent care');
    expect(page.document.title).toBe('Parent care – CaCi');
    expect(page.focused().id).toBe('circle-heading');
    expect(links(page).map((l) => l.current)).toEqual(['page', null]);
    expect(page.el('nav-home').getAttribute('aria-current')).toBeNull();
    expect(page.el('nav-settings').getAttribute('aria-current')).toBeNull();
    expect(page.el('circle-notice').hidden).toBe(true);
  });
  it('moving between screens moves the title, the marks and the focus', async () => {
    const { page, addr } = await start();
    addr.go(`#/circle/${C2}`);
    await settle();
    expect(page.document.title).toBe('Club – CaCi');
    expect(links(page).map((l) => l.current)).toEqual([null, 'page']);
    addr.go('#/');
    await settle();
    expect(shownViews(page)).toEqual(['home']);
    expect(links(page).map((l) => l.current)).toEqual([null, null]);
    expect(page.document.title).toBe('CaCi');
    expect(page.el('nav-home').getAttribute('aria-current')).toBe('page');
    addr.go('#/settings');
    await settle();
    expect(page.document.title).toBe('Settings – CaCi');
    expect(page.focused().id).toBe('settings-heading');
  });
  it('a circle the person is not in (or has left) gives the one set of words and goes to Home', async () => {
    const { page, addr } = await start(undefined, `#/circle/${GONE}`);
    expect(addr.get()).toBe('#/');
    expect(shownViews(page)).toEqual(['home']);
    expect(page.el('circle-notice').textContent).toBe('No such circle, or you are not in it.');
    expect(page.el('circle-notice').hidden).toBe(false);
    expect(links(page).every((l) => l.current === null)).toBe(true);
    // the words go away at the next ordinary screen
    addr.go('#/settings');
    await settle();
    expect(page.el('circle-notice').hidden).toBe(true);
  });
  it('a circle left while it was shown falls back when the screen is next shown', async () => {
    const { page, svc, addr } = await start(undefined, `#/circle/${C1}`);
    svc.state.scopes = [OWN, circle(C2, 'Club', 'observer')];
    addr.go('#/settings');
    await settle();
    addr.go(`#/circle/${C1}`);
    await settle();
    expect(addr.get()).toBe('#/');
    expect(page.el('circle-notice').textContent).toBe('No such circle, or you are not in it.');
    expect(links(page).map((l) => l.text)).toEqual(['Club']);
  });
  it('a malformed circle address is Home with no notice and no request for it', async () => {
    const { page, svc } = await start(undefined, '#/circle/..%2f..');
    expect(shownViews(page)).toEqual(['home']);
    expect(page.el('circle-notice').hidden).toBe(true);
    expect(svc.calls.filter((c) => c.includes('circle/'))).toEqual([]);
  });
  it('only the latest screen change draws, even if an older answer arrives late', async () => {
    const { page, svc, addr } = await start();
    svc.state.hold = gate();
    const slow = svc.state.hold;
    addr.go(`#/circle/${C1}`);
    await settle();
    svc.state.hold = undefined;
    addr.go(`#/circle/${C2}`);
    await settle();
    expect(page.el('circle-heading').textContent).toBe('Club');
    slow.release();
    await settle();
    expect(page.el('circle-heading').textContent).toBe('Club');
    expect(page.document.title).toBe('Club – CaCi');
    expect(links(page).map((l) => l.current)).toEqual([null, 'page']);
  });
  it('an answer that arrives after signing out draws nothing', async () => {
    const { page, svc, addr } = await start();
    svc.state.hold = gate();
    const slow = svc.state.hold;
    addr.go(`#/circle/${C1}`);
    await settle();
    page.el('signout').fire('click');
    await settle();
    slow.release();
    await settle();
    expect(links(page)).toEqual([]);
    expect(page.el('circle-heading').textContent).toBe('');
  });
  it('signing out forgets the links, the heading and the notice', async () => {
    const { page, addr } = await start(undefined, `#/circle/${GONE}`);
    expect(page.el('circle-notice').hidden).toBe(false);
    addr.go(`#/circle/${C1}`);
    await settle();
    page.el('signout').fire('click');
    await settle();
    expect(links(page)).toEqual([]);
    expect(page.el('nav-circles').hidden).toBe(true);
    expect(page.el('circle-heading').textContent).toBe('');
    expect(page.el('circle-notice').hidden).toBe(true);
    expect(page.el('view-circle').hidden).toBe(true);
  });
});
