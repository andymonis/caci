import { describe, expect, it } from 'vitest';
import { fakePage, fill, settle } from './fake-page.test-util.mjs';
import { mountUser, routeOf } from './user-mount.js';

const USER = { id: 'u0000000000000001', username: 'ann', displayName: 'Ann A' };
const refuse = (status, code, message, extra = {}, headers) => ({ status, body: { error: { code, message, ...extra } }, ...(headers ? { headers } : {}) });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

function service(table = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = table[key] ?? refuse(401, 'UNAUTHENTICATED', 'not signed in');
    const a = await (typeof entry === 'function' ? entry(calls.length) : entry);
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (n) => (a.headers && a.headers[n]) ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fetchFn, calls, keys: () => calls.map((c) => c.key), last: (key) => calls.filter((c) => c.key === key).at(-1) };
}
function address(initial = '') {
  let hash = initial;
  const listeners = [];
  const env = { getHash: () => hash, setHash: (h) => { hash = h; for (const l of listeners) l(); }, onHashChange: (fn) => listeners.push(fn) };
  return { env, get: () => hash, change: (h) => env.setHash(h) };
}
const ME = { 'GET /api/me': { status: 200, body: { user: USER, graphId: 'x' } } };
async function start(table = {}, hash = '', hooks = {}) {
  const page = fakePage('user.html');
  const svc = service(table);
  const addr = address(hash);
  const app = mountUser(page.document, svc.fetchFn, addr.env, hooks);
  await settle();
  return { page, svc, addr, app };
}
const shown = (page) => ['loading', 'unreachable', 'signed-out', 'signed-in'].filter((s) => !page.el(`screen-${s}`).hidden);
const view = (page) => ['home', 'settings'].filter((v) => !page.el(`view-${v}`).hidden);

describe('the route', () => {
  it('is Settings only for exactly #/settings; anything else, hostile or not, is Home', () => {
    expect(routeOf('#/settings')).toBe('settings');
    for (const h of ['', '#/', '#/settings/', '#/Settings', '#/settings?x=1', '#/settings#x', '#/%73ettings', '#/circles', '#/admin', undefined, 5, null, '#/settings/../x']) expect(routeOf(h), String(h)).toBe('home');
  });
});

describe('signing in', () => {
  it('shows the sign-in form to a person with no session, and nothing of the app', async () => {
    const { page } = await start();
    expect(shown(page)).toEqual(['signed-out']);
    expect(page.el('signin-section').hidden).toBe(false);
    expect(page.el('register-section').hidden).toBe(true);
    expect(page.document.title).toBe('CaCi');
  });
  it('a person with a session lands on Home with their name, the title, the focus on the heading and the nav marked', async () => {
    const { page } = await start(ME);
    expect(shown(page)).toEqual(['signed-in']);
    expect(view(page)).toEqual(['home']);
    expect(page.el('user-display-name').textContent).toBe('Ann A');
    expect(page.focused().id).toBe('home-heading');
    expect(page.el('nav-home').getAttribute('aria-current')).toBe('page');
    expect(page.el('nav-settings').getAttribute('aria-current')).toBeNull();
    expect(page.document.title).toBe('CaCi');
  });
  it('signing in goes to Home and empties the form', async () => {
    const { page, svc } = await start({ 'POST /api/login': { status: 200, body: { user: USER, graphId: 'x' } } });
    fill(page, 'signin', { username: ' ANN ', password: 'correct horse 7 staple' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(svc.last('POST /api/login').body).toEqual({ username: 'ann', password: 'correct horse 7 staple' });
    expect(shown(page)).toEqual(['signed-in']);
    expect(page.el('signin-password').value).toBe('');
  });
  it('a wrong password shows one message at the top, empties the password and keeps the username', async () => {
    const { page } = await start({ 'POST /api/login': refuse(401, 'UNAUTHENTICATED', 'invalid username or password') });
    fill(page, 'signin', { username: 'ann', password: 'nope nope nope nope' });
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-error').hidden).toBe(false);
    expect(page.el('signin-error').textContent).toBe('invalid username or password');
    expect(page.el('signin-password').value).toBe('');
    expect(page.el('signin-username').value).toBe('ann');
    expect(page.focused().id).toBe('signin-error');
  });
  it('an empty form shows a problem beside each field and sends nothing', async () => {
    const { page, svc } = await start();
    page.el('signin-form').fire('submit');
    await settle();
    expect(page.el('signin-username-error').hidden).toBe(false);
    expect(page.el('signin-password-error').hidden).toBe(false);
    expect(page.el('signin-username').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('signin-username');
    expect(svc.keys()).toEqual(['GET /api/me']);
  });
  it('creating an account signs the person in; a taken name is shown beside the username', async () => {
    const { page, svc } = await start({ 'POST /api/register': { status: 201, body: { user: USER } }, 'POST /api/login': { status: 200, body: { user: USER, graphId: 'x' } } });
    page.el('show-register').fire('click');
    expect(page.el('register-section').hidden).toBe(false);
    expect(page.focused().id).toBe('register-username');
    fill(page, 'register', { username: 'ann', displayName: 'Ann A', email: '', password: 'correct horse 7 staple' });
    page.el('register-form').fire('submit');
    await settle();
    expect(svc.last('POST /api/register').body).toEqual({ username: 'ann', displayName: 'Ann A', password: 'correct horse 7 staple' });
    expect(shown(page)).toEqual(['signed-in']);
  });
  it('a taken name, and closed registration, read as they do in the back office', async () => {
    const taken = await start({ 'POST /api/register': refuse(409, 'CONFLICT', 'username is taken', { field: 'username' }) });
    taken.page.el('show-register').fire('click');
    fill(taken.page, 'register', { username: 'ann', displayName: 'Ann A', email: '', password: 'correct horse 7 staple' });
    taken.page.el('register-form').fire('submit');
    await settle();
    expect(taken.page.el('register-username-error').textContent).toBe('username is taken');
    const closed = await start({ 'POST /api/register': refuse(403, 'FORBIDDEN', 'closed') });
    closed.page.el('show-register').fire('click');
    fill(closed.page, 'register', { username: 'ann', displayName: 'Ann A', email: '', password: 'correct horse 7 staple' });
    closed.page.el('register-form').fire('submit');
    await settle();
    expect(closed.page.el('signin-section').hidden).toBe(false);
    expect(closed.page.el('register-error').textContent).toBe('Registration is closed on this service.');
  });
  it('the service being unreachable says so and Try again asks again', async () => {
    let n = 0;
    const { page, svc } = await start({ 'GET /api/me': () => (++n === 1 ? new Error('offline') : { status: 200, body: { user: USER, graphId: 'x' } }) });
    expect(shown(page)).toEqual(['unreachable']);
    expect(page.el('unreachable-message').textContent).toContain('Cannot reach');
    page.el('retry').fire('click');
    await settle();
    expect(shown(page)).toEqual(['signed-in']);
    expect(svc.keys().filter((k) => k === 'GET /api/me')).toHaveLength(2);
  });
  it('a hostile name is only text', async () => {
    const evil = '<img src=x onerror=alert(1)><b>Ann</b>';
    const { page } = await start({ 'GET /api/me': { status: 200, body: { user: { ...USER, displayName: evil }, graphId: 'x' } } });
    expect(page.el('user-display-name').textContent).toBe(evil);
    expect(page.el('user-display-name').children).toEqual([]);
  });
});

describe('Settings', () => {
  const settingsStart = (table = {}) => start({ ...ME, ...table }, '#/settings');
  it('is reached at #/settings, with its title, the name filled in, the focus on its heading and the nav marked', async () => {
    const { page } = await settingsStart();
    expect(view(page)).toEqual(['settings']);
    expect(page.document.title).toBe('Settings – CaCi');
    expect(page.focused().id).toBe('settings-heading');
    expect(page.el('profile-displayName').value).toBe('Ann A');
    expect(page.el('nav-settings').getAttribute('aria-current')).toBe('page');
    expect(page.el('admin-link').getAttribute('href')).toBe('/admin');
  });
  it('following the address between Home and Settings moves the focus and the title, and does not ask the service anything', async () => {
    const { page, addr, svc } = await start(ME);
    addr.change('#/settings');
    expect(view(page)).toEqual(['settings']);
    expect(page.focused().id).toBe('settings-heading');
    addr.change('#/');
    expect(view(page)).toEqual(['home']);
    expect(page.document.title).toBe('CaCi');
    expect(svc.keys()).toEqual(['GET /api/me']);
    addr.change('#/settings/../..');
    expect(view(page)).toEqual(['home']);
  });
  it('saving a new name sends only the name, shows Saved, updates the name at the top and empties the email', async () => {
    const { page, svc } = await settingsStart({ 'PATCH /api/me': { status: 200, body: { user: { ...USER, displayName: 'Ann Two' } } } });
    page.el('profile-displayName').value = ' Ann Two ';
    page.el('profile-form').fire('submit');
    await settle();
    expect(svc.last('PATCH /api/me').body).toEqual({ displayName: 'Ann Two' });
    expect(page.el('profile-notice').hidden).toBe(false);
    expect(page.el('profile-notice').textContent).toBe('Saved.');
    expect(page.focused().id).toBe('profile-notice');
    expect(page.el('user-display-name').textContent).toBe('Ann Two');
  });
  it('sending the name unchanged and no email is not a change: a problem, and nothing is sent', async () => {
    const { page, svc } = await settingsStart();
    page.el('profile-form').fire('submit');
    await settle();
    expect(page.el('profile-displayName-error').hidden).toBe(false);
    expect(page.focused().id).toBe('profile-displayName');
    expect(svc.keys().filter((k) => k.startsWith('PATCH'))).toEqual([]);
  });
  it('a new email is sent with it; a bad one is refused beside its field; Remove my email sends null', async () => {
    const { page, svc } = await settingsStart({ 'PATCH /api/me': { status: 200, body: { user: USER } } });
    page.el('profile-email').value = 'nope';
    page.el('profile-form').fire('submit');
    await settle();
    expect(page.el('profile-email-error').hidden).toBe(false);
    expect(page.focused().id).toBe('profile-email');
    page.el('profile-email').value = 'ann@example.test';
    page.el('profile-form').fire('submit');
    await settle();
    expect(svc.last('PATCH /api/me').body).toEqual({ email: 'ann@example.test' });
    expect(page.el('profile-email').value).toBe('');
    page.el('remove-email').fire('click');
    await settle();
    expect(svc.last('PATCH /api/me').body).toEqual({ email: null });
    expect(page.el('profile-notice').textContent).toBe('Your email was removed.');
  });
  it('a refusal from the service is shown beside the field it names, or at the top', async () => {
    const { page } = await settingsStart({ 'PATCH /api/me': refuse(422, 'INVALID_INPUT', 'That email is not allowed', { field: 'email' }) });
    page.el('profile-email').value = 'a@b.co';
    page.el('profile-form').fire('submit');
    await settle();
    expect(page.el('profile-email-error').textContent).toBe('That email is not allowed');
    const other = await settingsStart({ 'PATCH /api/me': refuse(500, 'STORAGE_ERROR', 'secret path /var/db') });
    other.page.el('profile-email').value = 'a@b.co';
    other.page.el('profile-form').fire('submit');
    await settle();
    expect(other.page.el('profile-error').hidden).toBe(false);
    expect(other.page.el('profile-error').textContent).not.toContain('secret');
  });
  it('changing the password sends both, empties both fields, says the other devices were signed out and never shows a password', async () => {
    const { page, svc } = await settingsStart({ 'POST /api/me/password': { status: 200, body: { user: USER } } });
    fill(page, 'password', { currentPassword: 'correct horse 7 staple', newPassword: 'a brand new password 9' });
    page.el('password-form').fire('submit');
    await settle();
    expect(svc.last('POST /api/me/password').body).toEqual({ currentPassword: 'correct horse 7 staple', newPassword: 'a brand new password 9' });
    expect(page.el('password-currentPassword').value).toBe('');
    expect(page.el('password-newPassword').value).toBe('');
    expect(page.el('password-notice').textContent).toBe('Your password was changed. Your other devices were signed out.');
    expect(page.focused().id).toBe('password-notice');
  });
  it('early problems appear beside the fields; a wrong current password is the service\'s words on its field, and the typed passwords stay for another try', async () => {
    const { page, svc } = await settingsStart({ 'POST /api/me/password': refuse(422, 'INVALID_INPUT', 'currentPassword is incorrect', { field: 'currentPassword' }) });
    page.el('password-form').fire('submit');
    await settle();
    expect(page.el('password-currentPassword-error').hidden).toBe(false);
    expect(page.el('password-newPassword-error').hidden).toBe(false);
    expect(svc.keys().filter((k) => k.startsWith('POST /api/me/password'))).toEqual([]);
    fill(page, 'password', { currentPassword: 'wrong wrong wrong', newPassword: 'a brand new password 9' });
    page.el('password-form').fire('submit');
    await settle();
    expect(page.el('password-currentPassword-error').textContent).toBe('currentPassword is incorrect');
    expect(page.el('password-currentPassword').getAttribute('aria-invalid')).toBe('true');
    expect(page.focused().id).toBe('password-currentPassword');
    expect(page.el('password-newPassword').value).toBe('a brand new password 9');
  });
  it('being held back shows the wait', async () => {
    const { page } = await settingsStart({ 'POST /api/me/password': refuse(429, 'THROTTLED', 'Too many tries', {}, { 'retry-after': '30' }) });
    fill(page, 'password', { currentPassword: 'x', newPassword: 'a brand new password 9' });
    page.el('password-form').fire('submit');
    await settle();
    expect(page.el('password-error').textContent).toContain('30 seconds');
  });
  it('controls are disabled while a request is out, and a second submit sends nothing', async () => {
    const g = gate();
    const { page, svc } = await settingsStart({ 'PATCH /api/me': () => g.promise });
    page.el('profile-displayName').value = 'Ann Two';
    page.el('profile-form').fire('submit');
    await settle();
    expect(page.el('profile-submit').disabled).toBe(true);
    expect(page.el('password-submit').disabled).toBe(true);
    expect(page.el('remove-email').disabled).toBe(true);
    page.el('profile-form').fire('submit');
    await settle();
    expect(svc.keys().filter((k) => k.startsWith('PATCH'))).toHaveLength(1);
    g.release({ status: 200, body: { user: USER } });
    await settle();
    expect(page.el('profile-submit').disabled).toBe(false);
  });
  it('signing out goes to sign-in, empties every field and forgets the page', async () => {
    const { page } = await settingsStart({ 'POST /api/logout': { status: 204 } });
    fill(page, 'password', { currentPassword: 'secret secret 1', newPassword: 'another secret 22' });
    page.el('signout').fire('click');
    await settle();
    expect(shown(page)).toEqual(['signed-out']);
    expect(page.el('password-currentPassword').value).toBe('');
    expect(page.el('password-newPassword').value).toBe('');
    expect(page.document.title).toBe('CaCi');
  });
  it('a session that has ended re-checks once and shows sign-in; a service that contradicts itself cannot make a loop', async () => {
    let me = 0;
    const { page, svc } = await settingsStart({ 'GET /api/me': () => (++me, { status: 200, body: { user: USER, graphId: 'x' } }), 'PATCH /api/me': refuse(401, 'UNAUTHENTICATED', 'not signed in') });
    page.el('profile-displayName').value = 'Ann Two';
    page.el('profile-form').fire('submit');
    await settle();
    page.el('profile-form').fire('submit');
    await settle();
    expect(me).toBe(2);
    expect(svc.keys().filter((k) => k === 'GET /api/me')).toHaveLength(2);
  });
  it('calls the hooks when the screen changes and when the person signs out', async () => {
    const seen = [];
    const { page, addr } = await start({ ...ME, 'POST /api/logout': { status: 204 } }, '', { route: (r) => seen.push(r), reset: () => seen.push('reset') });
    addr.change('#/settings');
    page.el('signout').fire('click');
    await settle();
    expect(seen).toEqual(['home', 'settings', 'reset']);
  });
});
