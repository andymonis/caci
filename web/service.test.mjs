import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../src/service/service.ts';
import { createApiClient } from './api-client.js';
import { fakePage, fill, visibleScreens, waitFor } from './fake-page.test-util.mjs';
import { mount } from './mount.js';
import { createSession } from './session.js';

// The web app's own code against the real service: real SQLite files, real HTTP, nothing mocked except
// that the page is a stand-in (the hand check in a real browser is recorded in STATE.md).

const PW = 'correct horse 7 staple';
const dirs = [];
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = (dataDir, extra = {}) => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, ...extra });
async function start(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'caci-web-e2e-'));
  dirs.push(dir);
  const service = await startService(config(dir, extra));
  running.push(service);
  return service;
}

let client = 0;
/** What a browser does for this page: same address, a cookie jar, the Origin header it would send, and its own address. */
function browserFetch(port) {
  let cookie;
  const address = `198.51.100.${(client++ % 250) + 1}`;
  return async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method,
      headers: { ...init.headers, ...(cookie ? { cookie } : {}), origin: `http://127.0.0.1:${port}`, 'x-forwarded-for': address },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
    return res;
  };
}
const sessionFor = (port) => createSession({ api: createApiClient({ fetchFn: browserFetch(port) }) });

describe('the page\'s own logic against the real service', () => {
  it('starts signed out, registers (and is signed in by it), reloads still signed in, signs out, and signs in again', async () => {
    const { port } = await start();
    const first = sessionFor(port);
    await first.start();
    expect(first.getState()).toMatchObject({ screen: 'signed-out', user: null });

    expect(await first.register({ username: 'Ann', displayName: 'Ann A', email: '', password: PW })).toEqual({ ok: true });
    expect(first.getState()).toMatchObject({ screen: 'signed-in', user: { username: 'ann', displayName: 'Ann A' } });
    expect(Object.keys(first.getState().user).sort()).toEqual(['displayName', 'id', 'username']);

    // "reload": the same browser (same cookie jar), a new session object
    const jarFetch = browserFetch(port);
    const reloadable = createSession({ api: createApiClient({ fetchFn: jarFetch }) });
    expect(await reloadable.signIn({ username: 'ann', password: PW })).toEqual({ ok: true });
    const reloaded = createSession({ api: createApiClient({ fetchFn: jarFetch }) });
    await reloaded.start();
    expect(reloaded.getState()).toMatchObject({ screen: 'signed-in', user: { username: 'ann' } });

    expect(await reloaded.signOut()).toEqual({ ok: true });
    expect(reloaded.getState().screen).toBe('signed-out');
    const afterwards = createSession({ api: createApiClient({ fetchFn: jarFetch }) });
    await afterwards.start();
    expect(afterwards.getState().screen).toBe('signed-out'); // the old session no longer works
    expect(await afterwards.signOut()).toEqual({ ok: true }); // signing out twice is fine
  });

  it('tells a person what went wrong in the service\'s own words: a wrong password, a taken name, a weak password, and an unknown account', async () => {
    const { port } = await start();
    const s = sessionFor(port);
    await s.register({ username: 'ann', displayName: 'Ann', password: PW });
    const other = sessionFor(port);
    const wrong = await other.signIn({ username: 'ann', password: 'definitely not it' });
    expect(wrong).toMatchObject({ ok: false, kind: 'credentials' });
    expect(wrong.message.length).toBeGreaterThan(5);
    expect(await other.signIn({ username: 'nobody-here', password: 'definitely not it' })).toEqual(wrong); // the same words for an unknown name
    const taken = await sessionFor(port).register({ username: 'ANN', displayName: 'Another', password: PW });
    expect(taken).toMatchObject({ ok: false, kind: 'taken', errors: { username: expect.any(String) } });
    const weak = await sessionFor(port).register({ username: 'bob', displayName: 'Bob', password: 'password1234' }); // long enough, but on the service's list
    expect(weak).toMatchObject({ ok: false, kind: 'invalid', errors: { password: expect.any(String) } });
    expect(JSON.stringify(weak)).not.toContain('password1234');
  });

  it('closed registration is reported as closed', async () => {
    const { port } = await start({ allowRegistration: false });
    expect(await sessionFor(port).register({ username: 'ann', displayName: 'Ann', password: PW })).toMatchObject({ ok: false, kind: 'closed', message: 'Registration is closed on this service.' });
  });

  it('being held back after too many wrong passwords shows the wait', async () => {
    const { port } = await start();
    await sessionFor(port).register({ username: 'ann', displayName: 'Ann', password: PW });
    const jar = browserFetch(port); // one address, so the per-address and per-name counts both add up
    const attacker = createSession({ api: createApiClient({ fetchFn: jar }) });
    let last;
    for (let i = 0; i < 8; i++) last = await attacker.signIn({ username: 'ann', password: `wrong password ${i}` });
    expect(last).toMatchObject({ ok: false, kind: 'throttled' });
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.message).toMatch(/^Too many tries\. Wait \d+ seconds? and try again\.$/);
  });

  it('a display name made of markup is stored and returned as the text it is, and shown only as text', async () => {
    const { port } = await start();
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const s = sessionFor(port);
    expect(await s.register({ username: 'ann', displayName: hostile, password: PW })).toEqual({ ok: true });
    expect(s.getState().user.displayName).toBe(hostile);
    const page = fakePage();
    mount(page.document, browserFetch(port));
    await waitFor(() => visibleScreens(page)[0] === 'signed-out');
    fill(page, 'signin', { username: 'ann', password: PW });
    page.el('signin-form').fire('submit');
    await waitFor(() => visibleScreens(page)[0] === 'signed-in');
    expect(page.el('user-display-name').textContent).toBe(hostile);
    expect(page.ids).toEqual(fakePage().ids);
  });

  it('the whole page, run against the real service: create an account, land on the holding page, sign out, sign in', async () => {
    const { port } = await start();
    const jar = browserFetch(port);
    const page = fakePage();
    mount(page.document, jar);
    await waitFor(() => visibleScreens(page)[0] === 'signed-out');
    page.el('show-register').fire('click');
    fill(page, 'register', { username: 'Ann', displayName: 'Ann A', email: 'ann@example.com', password: PW });
    page.el('register-form').fire('submit');
    await waitFor(() => visibleScreens(page)[0] === 'signed-in');
    expect(page.el('user-display-name').textContent).toBe('Ann A');
    expect(page.el('user-username').textContent).toBe('ann');
    page.el('signout').fire('click');
    await waitFor(() => visibleScreens(page)[0] === 'signed-out');
    fill(page, 'signin', { username: 'ann', password: PW });
    page.el('signin-form').fire('submit');
    await waitFor(() => visibleScreens(page)[0] === 'signed-in');
  });
});
