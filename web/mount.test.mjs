import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle, tick, visibleScreens } from './fake-page.test-util.mjs';
import { mount } from './mount.js';

const PW = 'correct horse 7 staple';
const USER = { id: 'u1', username: 'ann', displayName: 'Ann A' };

/** A stand-in service: answers each call by `METHOD path` from a table, and records them. */
function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const empty = { status: 200, body: { items: [], nextCursor: null } };
    const entry = table[key] ?? (/^GET \/api\/(invitations|circles)/.test(key) ? empty : { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } } });
    const a = typeof entry === 'function' ? entry(calls.length) : entry;
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls };
}
describe('the page the way it starts', () => {
  it('shows nothing until the script runs: every screen and form section starts hidden in the HTML', () => {
    const page = fakePage();
    for (const id of ['screen-loading', 'screen-unreachable', 'screen-signed-out', 'screen-signed-in', 'signin-section', 'register-section']) expect(page.el(id).hidden, id).toBe(true);
  });

  it('mounting finds every element it needs in the real page, and fails loudly for one that is missing', () => {
    const page = fakePage();
    expect(() => mount(page.document, service().fetchFn)).not.toThrow();
    const broken = { getElementById: (id) => (id === 'signout' ? null : page.document.getElementById(id)) };
    expect(() => mount(broken, service().fetchFn)).toThrow(/no element "signout"/);
  });

  it('shows loading, then the sign-in form when nobody is signed in', async () => {
    const page = fakePage();
    mount(page.document, service().fetchFn);
    expect(visibleScreens(page)).toEqual(['loading']);
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-out']);
    expect(page.el('signin-section').hidden).toBe(false);
    expect(page.el('register-section').hidden).toBe(true);
  });

  it('shows the holding page, with the name and username as text, when the service says you are signed in', async () => {
    const page = fakePage();
    mount(page.document, service({ 'GET /api/me': { status: 200, body: { user: USER } } }).fetchFn);
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-in']);
    expect(page.el('user-display-name').textContent).toBe('Ann A');
    expect(page.el('user-username').textContent).toBe('ann');
    expect(page.el('signed-in-notice').hidden).toBe(true); // no notice unless there is one
  });

  it('shows that the service cannot be reached, with a way to try again that works', async () => {
    const page = fakePage();
    let up = false;
    const { fetchFn } = service({ 'GET /api/me': () => (up ? { status: 200, body: { user: USER } } : new TypeError('Failed to fetch')) });
    mount(page.document, fetchFn);
    await settle();
    expect(visibleScreens(page)).toEqual(['unreachable']);
    expect(page.el('unreachable-message').textContent).toBe('Cannot reach the service. Check your connection and try again.');
    up = true;
    page.el('retry').fire('click');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-in']);
    expect(page.el('unreachable-message').textContent).toBe('');
  });
});

describe('text from the service is only ever text', () => {
  it('a hostile display name is set as text and nothing else about the page changes', async () => {
    const page = fakePage();
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    mount(page.document, service({ 'GET /api/me': { status: 200, body: { user: { ...USER, displayName: hostile, username: 'x' } } } }).fetchFn);
    await settle();
    expect(page.el('user-display-name').textContent).toBe(hostile);
    expect(page.ids.length).toBe(new Set(page.ids).size);
    expect(page.ids).toEqual(fakePage().ids); // no element was added
    expect('innerHTML' in page.el('user-display-name')).toBe(false); // the stand-in has none, so any use would have thrown or set a stray property
  });

  it('an error message from the service is set as text', async () => {
    const page = fakePage();
    const { fetchFn } = service({ 'POST /api/login': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: '<b onmouseover=alert(1)>wrong</b>' } } } });
    mount(page.document, fetchFn);
    await settle();
    fill(page, 'signin', { username: 'ann', password: 'x' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-error').textContent).toBe('<b onmouseover=alert(1)>wrong</b>');
  });
});

describe('signing in', () => {
  it('sends the form, shows the holding page, and leaves nothing typed on the page', async () => {
    const page = fakePage();
    const { fetchFn, calls } = service({ 'POST /api/login': { status: 200, body: { user: USER } } });
    mount(page.document, fetchFn);
    await settle();
    fill(page, 'signin', { username: ' ANN ', password: PW });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-form').prevented).toBe(true);
    expect(calls.find((c) => c.key === 'POST /api/login').body).toEqual({ username: 'ann', password: PW });
    expect(visibleScreens(page)).toEqual(['signed-in']);
    expect(page.el('signin-password').value).toBe('');
    expect(page.el('signin-username').value).toBe('');
    expect(page.el('user-display-name').textContent).toBe('Ann A');
  });

  it('an empty form is not sent; each missing field shows its message, is marked invalid, and the first gets the focus', async () => {
    const page = fakePage();
    const { fetchFn, calls } = service();
    mount(page.document, fetchFn);
    await settle();
    page.el('signin-form').fire('submit');
    await settle();
    expect(calls.map((c) => c.key)).toEqual(['GET /api/me']);
    expect(page.el('signin-username-error').textContent).toBe('Enter your username.');
    expect(page.el('signin-username-error').hidden).toBe(false);
    expect(page.el('signin-password-error').textContent).toBe('Enter your password.');
    expect(page.el('signin-username').getAttribute('aria-invalid')).toBe('true');
    expect(page.el('signin-password').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('signin-username');
  });

  it('a wrong password shows the one message at the top, empties the password, keeps the username and moves the focus to the message; the next try clears it', async () => {
    const page = fakePage();
    let ok = false;
    const { fetchFn } = service({ 'POST /api/login': () => (ok ? { status: 200, body: { user: USER } } : { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'wrong username or password' } } }) });
    mount(page.document, fetchFn);
    await settle();
    fill(page, 'signin', { username: 'ann', password: 'nope' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-error').textContent).toBe('wrong username or password');
    expect(page.el('signin-error').hidden).toBe(false);
    expect(page.el('signin-password').value).toBe('');
    expect(page.el('signin-username').value).toBe('ann');
    expect(page.focused().id).toBe('signin-error');
    ok = true;
    fill(page, 'signin', { password: PW });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-error').hidden).toBe(true);
    expect(page.el('signin-error').textContent).toBe('');
  });

  it('being held back shows the wait', async () => {
    const page = fakePage();
    const { fetchFn } = service({ 'POST /api/login': { status: 429, headers: { 'retry-after': '42' }, body: { error: { code: 'THROTTLED', message: 'x' } } } });
    mount(page.document, fetchFn);
    await settle();
    fill(page, 'signin', { username: 'ann', password: 'x' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-error').textContent).toBe('Too many tries. Wait 42 seconds and try again.');
  });

  it('controls are disabled while a request is in flight and enabled again after', async () => {
    const page = fakePage();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { fetchFn } = service({ 'POST /api/login': () => ({ status: 401, body: {} }) });
    const slow = async (path, init) => {
      if (path === '/api/login') await gate;
      return fetchFn(path, init);
    };
    mount(page.document, slow);
    await settle();
    fill(page, 'signin', { username: 'ann', password: 'x' });
    page.el('signin-form').fire('submit');
    await tick();
    for (const id of ['signin-submit', 'register-submit', 'show-register', 'signout', 'retry']) expect(page.el(id).disabled, id).toBe(true);
    expect(page.el('signin-form').getAttribute('aria-busy')).toBe('true');
    release();
    await settle();
    for (const id of ['signin-submit', 'register-submit', 'show-register']) expect(page.el(id).disabled, id).toBe(false);
    expect(page.el('signin-form').getAttribute('aria-busy')).toBe('false');
  });
});

describe('messages and marks are cleared when they no longer apply', () => {
  it('a corrected form loses its error messages, its invalid marks and its top message', async () => {
    const page = fakePage();
    let ok = false;
    const { fetchFn } = service({ 'POST /api/login': () => (ok ? { status: 200, body: { user: USER } } : { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'wrong' } } }) });
    mount(page.document, fetchFn);
    await settle();
    page.el('signin-form').fire('submit'); // empty: field errors
    await settle();
    expect(page.el('signin-username').getAttribute('aria-invalid')).toBe('true');
    fill(page, 'signin', { username: 'ann', password: 'wrong' });
    page.el('signin-form').fire('submit'); // now a top message instead
    await settle();
    for (const f of ['username', 'password']) {
      expect(page.el(`signin-${f}-error`).hidden, f).toBe(true);
      expect(page.el(`signin-${f}-error`).textContent, f).toBe('');
      expect(page.el(`signin-${f}`).getAttribute('aria-invalid'), f).toBeNull();
    }
    expect(page.el('signin-error').hidden).toBe(false);
  });

  it('old messages are gone while the next request is on its way', async () => {
    const page = fakePage();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let first = true;
    const { fetchFn } = service({ 'POST /api/login': () => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'wrong' } } }) });
    const slow = async (path, init) => {
      if (path === '/api/login' && !first) await gate;
      if (path === '/api/login') first = false;
      return fetchFn(path, init);
    };
    mount(page.document, slow);
    await settle();
    fill(page, 'signin', { username: 'ann', password: 'x' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-error').hidden).toBe(false);
    fill(page, 'signin', { password: 'y' });
    page.el('signin-form').fire('submit');
    await tick();
    expect(page.el('signin-error').hidden).toBe(true); // while the second request is still out
    release();
    await settle();
  });

  it('switching forms clears the messages of the one left', async () => {
    const page = fakePage();
    mount(page.document, service().fetchFn);
    await settle();
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-username-error').hidden).toBe(false);
    page.el('show-register').fire('click');
    page.el('show-signin').fire('click');
    expect(page.el('signin-username-error').hidden).toBe(true);
    expect(page.el('signin-username').getAttribute('aria-invalid')).toBeNull();
    page.el('register-form').fire('submit');
    await settle();
    expect(page.el('register-username-error').hidden).toBe(false);
    page.el('show-signin').fire('click');
    page.el('show-register').fire('click');
    expect(page.el('register-username-error').hidden).toBe(true);
  });

  it('the password is sent exactly as typed, spaces and all', async () => {
    const page = fakePage();
    const { fetchFn, calls } = service({ 'POST /api/login': { status: 401, body: {} } });
    mount(page.document, fetchFn);
    await settle();
    fill(page, 'signin', { username: 'ann', password: '  pw with spaces  ' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(calls.find((c) => c.key === 'POST /api/login').body.password).toBe('  pw with spaces  ');
  });
});

describe('the entry point', () => {
  it('starts the page with the browser\'s own fetch, called as the browser needs it (on window)', async () => {
    const page = fakePage();
    const seen = [];
    const win = {
      location: { hash: '' },
      addEventListener() {},
      fetch(path, init) {
        if (this !== win) throw new TypeError('Illegal invocation');
        seen.push([init.method, path]);
        return Promise.resolve({ status: 401, headers: { get: () => null }, text: async () => '' });
      },
    };
    globalThis.document = page.document;
    globalThis.window = win;
    try {
      await import('./app.js');
      await settle();
    } finally {
      delete globalThis.document;
      delete globalThis.window;
    }
    expect(seen).toEqual([['GET', '/api/me']]);
    expect(visibleScreens(page)).toEqual(['signed-out']);
  });
});

describe('registering', () => {
  const registerTable = { 'POST /api/register': { status: 201, body: { user: USER } }, 'POST /api/login': { status: 200, body: { user: USER } } };

  it('the toggles switch between the forms, clear old messages and move the focus', async () => {
    const page = fakePage();
    mount(page.document, service().fetchFn);
    await settle();
    page.el('show-register').fire('click');
    expect(page.el('register-section').hidden).toBe(false);
    expect(page.el('signin-section').hidden).toBe(true);
    expect(page.focused().id).toBe('register-username');
    page.el('show-signin').fire('click');
    expect(page.el('signin-section').hidden).toBe(false);
    expect(page.el('register-section').hidden).toBe(true);
    expect(page.focused().id).toBe('signin-username');
  });

  it('creates the account, signs in with the same values and shows the holding page, with nothing left in the fields', async () => {
    const page = fakePage();
    const { fetchFn, calls } = service(registerTable);
    mount(page.document, fetchFn);
    await settle();
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'Ann', displayName: 'Ann A', email: '', password: PW });
    page.el('register-form').fire('submit');
    await settle();
    expect(calls.filter((c) => !c.key.startsWith('GET /api/')).map((c) => [c.key, c.body])).toEqual([
      ['POST /api/register', { username: 'ann', displayName: 'Ann A', password: PW }],
      ['POST /api/login', { username: 'ann', password: PW }],
    ]);
    expect(visibleScreens(page)).toEqual(['signed-in']);
    for (const field of ['username', 'displayName', 'email', 'password']) expect(page.el(`register-${field}`).value, field).toBe('');
  });

  it('shows every early problem at once beside its field, sends nothing, and keeps what was typed (the password too, so it can be fixed)', async () => {
    const page = fakePage();
    const { fetchFn, calls } = service(registerTable);
    mount(page.document, fetchFn);
    await settle();
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'a', displayName: '', email: 'nope', password: 'short' });
    page.el('register-form').fire('submit');
    await settle();
    expect(calls.map((c) => c.key)).toEqual(['GET /api/me']);
    for (const field of ['username', 'displayName', 'email', 'password']) {
      expect(page.el(`register-${field}-error`).hidden, field).toBe(false);
      expect(page.el(`register-${field}-error`).textContent.length, field).toBeGreaterThan(5);
      expect(page.el(`register-${field}`).getAttribute('aria-invalid'), field).toBe('true');
    }
    expect(page.el('register-password').value).toBe('short');
    expect(page.focused().id).toBe('register-username');
  });

  it('a taken username is shown beside the username field with the focus there, and the password is kept', async () => {
    const page = fakePage();
    const { fetchFn } = service({ 'POST /api/register': { status: 409, body: { error: { code: 'CONFLICT', message: 'that username is taken', field: 'username' } } } });
    mount(page.document, fetchFn);
    await settle();
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'ann', displayName: 'Ann', password: PW });
    page.el('register-form').fire('submit');
    await settle();
    expect(page.el('register-username-error').textContent).toBe('that username is taken');
    expect(page.el('register-error').hidden).toBe(true);
    expect(page.focused().id).toBe('register-username');
    expect(page.el('register-password').value).toBe(PW);
  });

  it('closed registration says so and shows the sign-in form', async () => {
    const page = fakePage();
    const { fetchFn } = service({ 'POST /api/register': { status: 403, body: { error: { code: 'FORBIDDEN', message: 'closed' } } } });
    mount(page.document, fetchFn);
    await settle();
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'ann', displayName: 'Ann', password: PW });
    page.el('register-form').fire('submit');
    await settle();
    expect(page.el('register-error').textContent).toBe('Registration is closed on this service.');
    expect(page.el('signin-section').hidden).toBe(false);
    expect(page.el('register-section').hidden).toBe(true);
  });

  it('an account made but not signed in empties the password and shows the sign-in form', async () => {
    const page = fakePage();
    const { fetchFn } = service({ 'POST /api/register': { status: 201, body: { user: USER } }, 'POST /api/login': new TypeError('Failed to fetch') });
    mount(page.document, fetchFn);
    await settle();
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'ann', displayName: 'Ann', password: PW });
    page.el('register-form').fire('submit');
    await settle();
    expect(page.el('register-error').textContent).toContain('Your account was made');
    expect(page.el('register-password').value).toBe('');
    expect(page.el('signin-section').hidden).toBe(false);
    expect(visibleScreens(page)).toEqual(['signed-out']);
  });
});

describe('signing out', () => {
  it('returns to the signed-out screen', async () => {
    const page = fakePage();
    const { fetchFn, calls } = service({ 'GET /api/me': { status: 200, body: { user: USER } }, 'POST /api/logout': { status: 204 } });
    mount(page.document, fetchFn);
    await settle();
    page.el('signout').fire('click');
    await settle();
    expect(calls.map((c) => c.key)).toEqual(['GET /api/me', 'GET /api/invitations?limit=100', 'POST /api/logout']);
    expect(visibleScreens(page)).toEqual(['signed-out']);
    expect(page.el('user-display-name').textContent).toBe('');
    expect(page.el('user-username').textContent).toBe('');
  });

  it('if the service cannot be reached the person stays on the holding page and is told they may still be signed in', async () => {
    const page = fakePage();
    const { fetchFn } = service({ 'GET /api/me': { status: 200, body: { user: USER } }, 'POST /api/logout': new TypeError('Failed to fetch') });
    mount(page.document, fetchFn);
    await settle();
    page.el('signout').fire('click');
    await settle();
    expect(visibleScreens(page)).toEqual(['signed-in']);
    expect(page.el('signed-in-notice').hidden).toBe(false);
    expect(page.el('signed-in-notice').textContent).toContain('You may still be signed in.');
    expect(page.el('unreachable-message').textContent).toBe(''); // the notice belongs to this screen only
  });
});
