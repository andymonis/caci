import { describe, expect, it } from 'vitest';
import { fakePage, settle } from './fake-page.test-util.mjs';
import { userHooks } from './user-hooks.js';
import { joinTokenOf, mountUser, routeOf } from './user-mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const TOKEN = `cjoin_${'Ab1_-'.repeat(8)}Abc`;
const C = 'c0000000000000001';
const PREVIEW = { circle: { name: 'Club' }, role: 'member', createdBy: { displayName: 'Ben B' } };
const CIRCLE = { id: C, name: 'Club', role: 'member', memberCount: 3, createdAt: 1, updatedAt: 2 };
const mine = (n, name = 'Team') => ({ id: `r${String(n).padStart(16, '0')}`, circle: { name }, role: 'member', createdAt: Date.UTC(2026, 0, 2), expiresAt: Date.UTC(2026, 0, 9) });
const refuse = (status, code, message) => ({ status, body: { error: { code, message } } });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

function service(table = {}, { signedIn = true } = {}) {
  const state = { signedIn };
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    let reply;
    if (key === 'GET /api/me') reply = state.signedIn ? { status: 200, body: { user: USER, graphId: 'x' } } : refuse(401, 'UNAUTHENTICATED', 'not signed in');
    else if (key === 'POST /api/login') {
      state.signedIn = true;
      reply = { status: 200, body: { user: USER, graphId: 'x' } };
    } else if (key === 'POST /api/logout') {
      state.signedIn = false;
      reply = { status: 204 };
    } else if (key === 'GET /api/capture/mode') reply = { status: 200, body: { mode: 'demo' } };
    else if (key === 'GET /api/brain/scopes') reply = { status: 200, body: { items: [] } };
    else if (path.startsWith('/api/me/agent-tokens')) reply = refuse(404, 'NOT_FOUND', 'not found');
    else {
      const entry = table[key];
      reply = entry === undefined ? refuse(401, 'UNAUTHENTICATED', 'not signed in') : await (typeof entry === 'function' ? entry() : entry);
    }
    return { status: reply.status, headers: { get: (n) => (reply.headers && reply.headers[n]) ?? null }, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)) };
  };
  return { state, calls, fetchFn, keys: () => calls.map((c) => c.key) };
}
function address(initial = '') {
  let hash = initial;
  const replaced = [];
  const listeners = [];
  const env = {
    getHash: () => hash,
    setHash: (h) => { hash = h; for (const l of listeners) l(); },
    replaceHash: (h) => { replaced.push(h); hash = h; },
    onHashChange: (fn) => listeners.push(fn),
  };
  return { env, get: () => hash, replaced, go: (h) => env.setHash(h) };
}
async function start(table, hash, opts) {
  const page = fakePage('user.html');
  const svc = service(table, opts);
  const addr = address(hash);
  mountUser(page.document, svc.fetchFn, addr.env, (ctx) => userHooks(page.document, svc.fetchFn, ctx));
  await settle();
  return { page, svc, addr };
}
const OK_TABLE = (extra = {}) => ({ 'POST /api/join/preview': { status: 200, body: { preview: PREVIEW } }, 'POST /api/join': { status: 200, body: { result: { state: 'joined', circle: CIRCLE } } }, 'GET /api/join-requests?limit=100': { status: 200, body: { items: [mine(1)], nextCursor: null } }, ...extra });
const text = (page, id) => page.el(id).textContent;
const everything = (page) => page.ids.map((id) => page.el(id).textContent ?? '').join('\n');

describe('the address', () => {
  it('names the join screen only with the exact token shape, or alone once it has been cleaned', () => {
    expect(routeOf(`#/join/${TOKEN}`)).toBe('join');
    expect(joinTokenOf(`#/join/${TOKEN}`)).toBe(TOKEN);
    expect(routeOf('#/join')).toBe('join');
    expect(joinTokenOf('#/join')).toBeUndefined();
    for (const h of ['#/join/', '#/join/abc', `#/join/${TOKEN}/`, `#/join/${TOKEN}?x=1`, `#/join/${TOKEN}#x`, `#/join/${TOKEN} `, `#/join/${TOKEN.slice(0, -1)}`, `#/join/${TOKEN}x`, '#/join/..%2f..', `#/Join/${TOKEN}`, `#/join/cpat_${TOKEN.slice(6)}`, '#/join/', 5, null, undefined]) {
      expect(routeOf(h), String(h)).toBe('home');
      expect(joinTokenOf(h), String(h)).toBeUndefined();
    }
    expect(routeOf('#/join/x')).toBe('home');
  });
});

describe('opening a link when signed in', () => {
  it('takes the token out of the address, previews it by body, and shows what it is for with the warning', async () => {
    const { page, svc, addr } = await start(OK_TABLE(), `#/join/${TOKEN}`);
    expect(addr.replaced).toEqual(['#/join']);
    expect(addr.get()).toBe('#/join');
    expect(svc.calls.find((c) => c.key === 'POST /api/join/preview')?.body).toEqual({ token: TOKEN });
    expect(svc.keys().filter((k) => k === 'POST /api/join/preview')).toHaveLength(1);
    expect(page.el('view-join').hidden).toBe(false);
    expect(['view-home', 'view-circle', 'view-settings'].map((v) => page.el(v).hidden)).toEqual([true, true, true]);
    expect(page.document.title).toBe('Join a circle – CaCi');
    expect(page.focused().id).toBe('join-heading');
    expect(text(page, 'join-preview-text')).toBe('You have been invited to join the circle "Club" as Member. The link was made by Ben B.');
    expect(text(page, 'join-warning')).toContain('everyone in it can see your username and display name');
    expect(page.el('join-preview').hidden).toBe(false);
    expect(page.el('join-result').hidden).toBe(true);
    expect(page.el('join-mine').hidden).toBe(true);
    expect(everything(page)).not.toContain(TOKEN.slice(6));
  });

  it('a screen change that follows the cleaning does not look at the link again', async () => {
    const { page, svc, addr } = await start(OK_TABLE(), `#/join/${TOKEN}`);
    addr.go('#/join');
    await settle();
    expect(svc.keys().filter((k) => k === 'POST /api/join/preview')).toHaveLength(1);
    expect(page.el('join-preview').hidden).toBe(false);
  });

  it('names are only text', async () => {
    const hostile = '<img src=x onerror=1><b>x</b>';
    const { page } = await start(OK_TABLE({ 'POST /api/join/preview': { status: 200, body: { preview: { circle: { name: hostile }, role: 'member', createdBy: { displayName: hostile } } } } }), `#/join/${TOKEN}`);
    expect(text(page, 'join-preview-text')).toBe(`You have been invited to join the circle "${hostile}" as Member. The link was made by ${hostile}.`);
    expect(page.el('join-preview-text').children).toEqual([]);
  });

  it('a link that does not work says so, lists the person\'s own waiting requests and moves the focus to the words', async () => {
    const { page, svc } = await start(OK_TABLE({ 'POST /api/join/preview': refuse(404, 'NOT_FOUND', 'no such join link') }), `#/join/${TOKEN}`);
    expect(text(page, 'join-miss')).toContain('This link does not work');
    expect(page.el('join-miss').hidden).toBe(false);
    expect(page.el('join-preview').hidden).toBe(true);
    expect(page.focused().id).toBe('join-miss');
    expect(svc.keys()).toContain('GET /api/join-requests?limit=100');
    expect(page.el('join-mine').hidden).toBe(false);
    const rows = page.el('join-mine-list').children;
    expect(rows.map((r) => r.querySelector('[data-slot="text"]').textContent)).toEqual(['Team: You asked to join as: Member · asked 2026-01-02 · lapses 2026-01-09']);
    expect(text(page, 'join-mine-note')).toContain('You are not told when one is decided');
  });

  it('join links being off, or a failure, is shown in words', async () => {
    const off = await start(OK_TABLE({ 'POST /api/join/preview': refuse(404, 'NOT_FOUND', 'not found') }), `#/join/${TOKEN}`);
    expect(text(off.page, 'join-error')).toBe('Join links are not switched on in this service.');
    expect(off.page.el('join-preview').hidden).toBe(true);
    expect(off.page.focused().id).toBe('join-error');
    const broken = await start(OK_TABLE({ 'POST /api/join/preview': refuse(500, 'STORAGE_ERROR', 'x') }), `#/join/${TOKEN}`);
    expect(text(broken.page, 'join-error')).toBe('Something went wrong on the service. Try again in a moment.');
  });

  it('with no token (the address already cleaned, or a bad one) it says it needs a link and asks nothing', async () => {
    const a = await start(OK_TABLE(), '#/join');
    expect(text(a.page, 'join-miss')).toBe('This page needs a join link. Open the link you were sent.');
    expect(a.svc.keys().some((k) => k.includes('join'))).toBe(false);
    const b = await start(OK_TABLE(), '#/join/cjoin_short');
    expect(b.page.el('view-home').hidden).toBe(false);
    expect(b.page.el('view-join').hidden).toBe(true);
    expect(b.svc.keys().some((k) => k.includes('join'))).toBe(false);
  });
});

describe('joining', () => {
  const press = async (page) => {
    page.el('join-confirm').fire('click');
    await settle();
  };

  it('joined: says so, offers the circle, moves the focus and forgets the link', async () => {
    const { page, svc } = await start(OK_TABLE(), `#/join/${TOKEN}`);
    await press(page);
    expect(svc.calls.find((c) => c.key === 'POST /api/join')?.body).toEqual({ token: TOKEN });
    expect(text(page, 'join-result-text')).toBe('You are now a member of "Club" as Member.');
    expect(page.el('join-result').hidden).toBe(false);
    expect(page.el('join-open-circle').hidden).toBe(false);
    expect(page.el('join-open-circle').getAttribute('href')).toBe(`#/circle/${C}`);
    expect(page.el('join-preview').hidden).toBe(true);
    expect(page.focused().id).toBe('join-result-text');
    expect(page.el('join-mine').hidden).toBe(true);
    expect(everything(page)).not.toContain(TOKEN.slice(6));
  });

  it('already a member: says nothing was changed and offers the circle', async () => {
    const { page } = await start(OK_TABLE({ 'POST /api/join': { status: 200, body: { result: { state: 'member', circle: { ...CIRCLE, role: 'owner' } } } } }), `#/join/${TOKEN}`);
    await press(page);
    expect(text(page, 'join-result-text')).toBe('You are already in "Club" as Owner. Nothing was changed.');
    expect(page.el('join-open-circle').hidden).toBe(false);
  });

  it('requested and waiting: say it was sent or is waiting with when it lapses, offer no circle, and list the waiting requests', async () => {
    for (const [state, words] of [['requested', 'Your request to join "Club" as Member has been sent. An owner or manager will decide. It lapses on 2026-01-09.'], ['waiting', 'Your request to join "Club" is already waiting for an owner or manager. It lapses on 2026-01-09.']]) {
      const { page, svc } = await start(OK_TABLE({ 'POST /api/join': { status: 200, body: { result: { state, circle: { name: 'Club' }, role: 'member', expiresAt: Date.UTC(2026, 0, 9) } } } }), `#/join/${TOKEN}`);
      await press(page);
      expect(text(page, 'join-result-text'), state).toBe(words);
      expect(page.el('join-open-circle').hidden).toBe(true);
      expect(svc.keys()).toContain('GET /api/join-requests?limit=100');
      expect(page.el('join-mine-list').children).toHaveLength(1);
    }
  });

  it('a link that fails between looking and joining says so, as a miss, with the focus on it', async () => {
    const { page } = await start(OK_TABLE({ 'POST /api/join': refuse(404, 'NOT_FOUND', 'no such join link') }), `#/join/${TOKEN}`);
    await press(page);
    expect(page.el('join-miss').hidden).toBe(false);
    expect(page.el('join-preview').hidden).toBe(true);
    expect(page.focused().id).toBe('join-miss');
  });

  it('a full circle shows the service\'s limit, keeps the preview and lets the person try again', async () => {
    let answer = refuse(429, 'LIMIT_REACHED', 'a circle may have at most 4 people');
    const { page } = await start(OK_TABLE({ 'POST /api/join': () => answer }), `#/join/${TOKEN}`);
    await press(page);
    expect(text(page, 'join-error')).toBe('a circle may have at most 4 people');
    expect(page.focused().id).toBe('join-error');
    expect(page.el('join-preview').hidden).toBe(false);
    expect(page.el('join-confirm').disabled).toBe(false);
    answer = { status: 200, body: { result: { state: 'joined', circle: CIRCLE } } };
    await press(page);
    expect(page.el('join-error').hidden).toBe(true);
    expect(text(page, 'join-result-text')).toContain('You are now a member');
  });

  it('the buttons are disabled and it says Joining while the request is out', async () => {
    const g = gate();
    const { page } = await start(OK_TABLE({ 'POST /api/join': () => g.promise.then(() => ({ status: 200, body: { result: { state: 'joined', circle: CIRCLE } } })) }), `#/join/${TOKEN}`);
    page.el('join-confirm').fire('click');
    await settle();
    expect(text(page, 'join-status')).toBe('Joining…');
    expect(page.el('join-confirm').disabled).toBe(true);
    expect(page.el('join-cancel').disabled).toBe(true);
    expect(page.el('join-preview').hidden).toBe(false); // the preview stays in view while joining
    g.release();
    await settle();
    expect(page.el('join-status').hidden).toBe(true);
  });

  it('says Looking at the link while it asks', async () => {
    const g = gate();
    const { page } = await start(OK_TABLE({ 'POST /api/join/preview': () => g.promise.then(() => ({ status: 200, body: { preview: PREVIEW } })) }), `#/join/${TOKEN}`);
    expect(text(page, 'join-status')).toBe('Looking at the link…');
    g.release();
    await settle();
    expect(page.el('join-status').hidden).toBe(true);
  });

  it('Not now goes home and forgets the link', async () => {
    const { page, addr } = await start(OK_TABLE(), `#/join/${TOKEN}`);
    page.el('join-cancel').fire('click');
    await settle();
    expect(addr.get()).toBe('#/');
    expect(page.el('view-home').hidden).toBe(false);
    expect(page.el('join-preview').hidden).toBe(true);
    addr.go('#/join');
    await settle();
    expect(text(page, 'join-miss')).toBe('This page needs a join link. Open the link you were sent.');
  });
});

describe('the list of the person\'s own waiting requests', () => {
  it('shows a failure in words, and join links off, beside the list and not instead of the answer', async () => {
    const asked = { status: 200, body: { result: { state: 'requested', circle: { name: 'Club' }, role: 'member', expiresAt: Date.UTC(2026, 0, 9) } } };
    const broken = await start(OK_TABLE({ 'POST /api/join': asked, 'GET /api/join-requests?limit=100': refuse(500, 'STORAGE_ERROR', 'x') }), `#/join/${TOKEN}`);
    broken.page.el('join-confirm').fire('click');
    await settle();
    expect(text(broken.page, 'join-result-text')).toContain('has been sent');
    expect(broken.page.el('join-mine').hidden).toBe(false);
    expect(text(broken.page, 'join-mine-error')).toBe('Something went wrong on the service. Try again in a moment.');
    expect(broken.page.el('join-mine-list').hidden).toBe(true);
    const off = await start(OK_TABLE({ 'POST /api/join': asked, 'GET /api/join-requests?limit=100': refuse(404, 'NOT_FOUND', 'not found') }), `#/join/${TOKEN}`);
    off.page.el('join-confirm').fire('click');
    await settle();
    expect(text(off.page, 'join-mine-error')).toBe('Join links are not switched on in this service.');
  });
});

describe('the focus is never stolen', () => {
  it('an answer that arrives after the person has left the screen moves nothing', async () => {
    const g = gate();
    const { page, addr } = await start(OK_TABLE({ 'POST /api/join/preview': () => g.promise.then(() => refuse(404, 'NOT_FOUND', 'no such join link')) }), `#/join/${TOKEN}`);
    addr.go('#/settings');
    await settle();
    expect(page.focused().id).toBe('settings-heading');
    g.release();
    await settle();
    expect(page.focused().id).toBe('settings-heading');
  });

  it('pressing Join when there is nothing to join by moves nothing', async () => {
    const { page } = await start(OK_TABLE({ 'POST /api/join/preview': refuse(404, 'NOT_FOUND', 'no such join link') }), `#/join/${TOKEN}`);
    expect(page.focused().id).toBe('join-miss');
    page.el('join-confirm').fire('click');
    await settle();
    expect(page.focused().id).toBe('join-miss');
  });

  it('a session that has ended moves nothing to the error line', async () => {
    const { page } = await start(OK_TABLE({ 'POST /api/join/preview': refuse(401, 'UNAUTHENTICATED', 'not signed in') }), `#/join/${TOKEN}`);
    expect(page.focused()?.id).not.toBe('join-error');
  });
});

describe('leaving, signing out, and signing in', () => {
  it('leaving the screen forgets the link: coming back to #/join has nothing', async () => {
    const { page, addr, svc } = await start(OK_TABLE(), `#/join/${TOKEN}`);
    addr.go('#/settings');
    await settle();
    expect(page.el('join-preview').hidden).toBe(true);
    addr.go('#/join');
    await settle();
    expect(text(page, 'join-miss')).toContain('needs a join link');
    expect(svc.keys().filter((k) => k === 'POST /api/join/preview')).toHaveLength(1);
  });

  it('signing out forgets it too', async () => {
    const { page } = await start(OK_TABLE(), `#/join/${TOKEN}`);
    page.el('signout').fire('click');
    await settle();
    expect(page.el('screen-signed-out').hidden).toBe(false);
    expect(page.el('join-preview').hidden).toBe(true);
    expect(everything(page)).not.toContain(TOKEN.slice(6));
  });

  it('someone not signed in who opened a link is told why they are asked to sign in, and after signing in the link is used', async () => {
    const { page, svc, addr } = await start(OK_TABLE(), `#/join/${TOKEN}`, { signedIn: false });
    expect(page.el('screen-signed-out').hidden).toBe(false);
    expect(page.el('join-signedout-note').hidden).toBe(false);
    expect(text(page, 'join-signedout-note')).toBe('You were sent a link to join a circle. Sign in, or create an account, to carry on.');
    expect(addr.get()).toBe(`#/join/${TOKEN}`); // kept so it applies after signing in
    expect(svc.keys().some((k) => k.includes('join'))).toBe(false); // nothing is sent while signed out
    page.el('signin-username').value = 'ann';
    page.el('signin-password').value = 'correct horse 7 staple';
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('screen-signed-in').hidden).toBe(false);
    expect(page.el('join-signedout-note').hidden).toBe(true);
    expect(page.el('view-join').hidden).toBe(false);
    expect(text(page, 'join-preview-text')).toContain('"Club"');
    expect(addr.replaced).toEqual(['#/join']);
  });

  it('no note for anyone else who is signed out', async () => {
    for (const hash of ['', '#/join', '#/settings', '#/join/cjoin_short']) {
      const { page } = await start(OK_TABLE(), hash, { signedIn: false });
      expect(page.el('join-signedout-note').hidden, hash).toBe(true);
    }
  });
});
